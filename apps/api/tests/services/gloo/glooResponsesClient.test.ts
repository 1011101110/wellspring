import { describe, expect, it, vi } from 'vitest';
import {
  GlooResponsesClient,
  GlooResponsesError,
  GlooToolCallLimitError,
  MAX_TOOL_CALLS,
  type CreateResponseRequest,
  type FunctionCallOutputEntry,
  type GlooResponse,
  type MessageOutputEntry,
} from '../../../src/services/gloo/glooResponsesClient.js';
import type { FetchLike } from '../../../src/services/gloo/glooTokenManager.js';

const GET_BIBLE_VERSE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'get_bible_verse',
    description: 'Fetch authoritative, licensed Bible text from YouVersion.',
    parameters: {
      type: 'object',
      properties: {
        usfm: { type: 'string' },
        versionId: { type: 'integer' },
        reason: { type: 'string' },
      },
      required: ['usfm', 'versionId'],
    },
  },
};

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const functionCallTurn = (callId: string, args: string): GlooResponse => ({
  id: 'resp_1',
  object: 'response',
  model: 'test-model',
  output: [
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: callId,
      name: 'get_bible_verse',
      arguments: args,
    } satisfies FunctionCallOutputEntry,
  ],
});

const finalMessageTurn = (text: string): GlooResponse => ({
  id: 'resp_2',
  object: 'response',
  model: 'test-model',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    } satisfies MessageOutputEntry,
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

const baseRequest: CreateResponseRequest = {
  model: 'test-model',
  input: [{ role: 'user', content: 'Generate a devotional.' }],
  tools: [GET_BIBLE_VERSE_TOOL],
  tool_choice: 'required',
};

describe('GlooResponsesClient.createResponse', () => {
  it('sends Bearer auth + JSON body and returns the parsed response', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(finalMessageTurn('{"ok":true}')));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'test-access-token',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    const res = await client.createResponse(baseRequest);
    expect(res.output[0]?.type).toBe('message');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://platform.ai.gloo.com/ai/v1/responses');
    expect(init?.headers?.Authorization).toBe('Bearer test-access-token');
    expect(init?.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body ?? '{}')).toMatchObject({ model: 'test-model' });
  });

  it('throws GlooResponsesError on non-OK HTTP status', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: 'bad model' }, 404));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    await expect(client.createResponse(baseRequest)).rejects.toBeInstanceOf(GlooResponsesError);
  });

  it('throws GlooResponsesError when output[] is missing/malformed', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ id: 'x', object: 'response', model: 'm' }));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    await expect(client.createResponse(baseRequest)).rejects.toBeInstanceOf(GlooResponsesError);
  });
});

describe('GlooResponsesClient.createResponse outbound-call hardening (issue #73)', () => {
  it('passes an AbortSignal (60s timeout budget) on every request', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(finalMessageTurn('{"ok":true}')));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    await client.createResponse(baseRequest);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries on 429 (full budget) honoring Retry-After, then succeeds', async () => {
    const sleepCalls: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === 'retry-after' ? '3' : null) },
        json: async () => ({}),
        text: async () => 'rate limited',
      })
      .mockResolvedValueOnce(jsonRes(finalMessageTurn('{"ok":true}')));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
      retrySleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    });
    const res = await client.createResponse(baseRequest);
    expect(res.output[0]?.type).toBe('message');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([3000]);
  });

  it('retries a network failure up to the full budget, then throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
      retrySleep: async () => {},
      retryRandom: () => 0,
    });
    await expect(client.createResponse(baseRequest)).rejects.toBeInstanceOf(GlooResponsesError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('retries a 5xx exactly ONCE (not the full budget), then throws', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => 'unavailable',
    }));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
      retrySleep: async () => {},
      retryRandom: () => 0,
    });
    await expect(client.createResponse(baseRequest)).rejects.toBeInstanceOf(GlooResponsesError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 initial + exactly 1 retry
  });

  it('does not retry a non-retryable 4xx (e.g. 400)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: 'bad request' }, 400));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
      retrySleep: async () => {},
    });
    await expect(client.createResponse(baseRequest)).rejects.toBeInstanceOf(GlooResponsesError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('on 401: invalidates the token, re-mints, and retries exactly once', async () => {
    let mintCount = 0;
    const getAccessToken = vi.fn(async () => {
      mintCount += 1;
      return `tok-${mintCount}`;
    });
    const invalidateToken = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => 'unauthorized',
      })
      .mockResolvedValueOnce(jsonRes(finalMessageTurn('{"ok":true}')));
    const client = new GlooResponsesClient({
      getAccessToken,
      fetchImpl: fetchImpl as unknown as FetchLike,
      invalidateToken,
      retrySleep: async () => {},
    });

    const res = await client.createResponse(baseRequest);
    expect(res.output[0]?.type).toBe('message');
    expect(invalidateToken).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const secondAuthHeader = fetchImpl.mock.calls[1]![1].headers.Authorization;
    expect(secondAuthHeader).toBe('Bearer tok-2');
  });

  it('does not loop forever on a repeated 401 — re-mints once then throws', async () => {
    const invalidateToken = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => 'still unauthorized',
    }));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
      invalidateToken,
      retrySleep: async () => {},
    });

    await expect(client.createResponse(baseRequest)).rejects.toBeInstanceOf(GlooResponsesError);
    expect(invalidateToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // original + exactly one re-mint retry
  });

  it('throws immediately on 401 with no invalidateToken wired (no callers case, backward compat)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => 'unauthorized',
    }));
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    await expect(client.createResponse(baseRequest)).rejects.toBeInstanceOf(GlooResponsesError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('GlooResponsesClient.runToolLoop', () => {
  it('completes the canonical two-turn function_call / function_call_output cycle', async () => {
    const turn1 = functionCallTurn(
      'call_789',
      JSON.stringify({ usfm: 'MAT.11.28-MAT.11.30', versionId: 111, reason: 'rest' }),
    );
    const finalJson = JSON.stringify({
      format: 'short',
      theme: 'rest in him',
      verses: [
        {
          usfm: 'MAT.11.28-MAT.11.30',
          versionId: 111,
          fetchedText: 'Come to me, all you who are weary...',
          attribution: 'NIV',
        },
      ],
      devotionalBody: 'body',
      cardSummary: 'summary',
      prayer: 'prayer',
    });
    const turn2 = finalMessageTurn(finalJson);

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(turn1))
      .mockResolvedValueOnce(jsonRes(turn2));

    const toolExecutor = vi.fn(async (name: string, argsJson: string) => {
      expect(name).toBe('get_bible_verse');
      const args = JSON.parse(argsJson);
      expect(args.usfm).toBe('MAT.11.28-MAT.11.30');
      return JSON.stringify({
        ok: true,
        data: {
          usfm: args.usfm,
          versionId: args.versionId,
          text: 'Come to me, all you who are weary...',
          attribution: 'NIV',
        },
        meta: { source: 'youversion', fetched_at: new Date().toISOString() },
      });
    });

    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    const result = await client.runToolLoop(baseRequest, toolExecutor);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(result.toolCallsExecuted).toBe(1);
    expect(result.finalText).toBe(finalJson);
    expect(JSON.parse(result.finalText ?? '{}').theme).toBe('rest in him');
    expect(result.turns).toHaveLength(2);

    // Verify turn 2's request re-sent full history + function_call + function_call_output,
    // exactly per Foundation §4.2.
    const secondCallInit = fetchImpl.mock.calls[1]![1];
    const secondBody = JSON.parse(secondCallInit.body) as CreateResponseRequest;
    expect(secondBody.input).toHaveLength(3);
    expect(secondBody.input[0]).toMatchObject({ role: 'user' });
    expect(secondBody.input[1]).toMatchObject({
      type: 'function_call',
      call_id: 'call_789',
      name: 'get_bible_verse',
    });
    expect(secondBody.input[2]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_789',
    });
    const toolOutput = JSON.parse((secondBody.input[2] as { output: string }).output);
    expect(toolOutput.ok).toBe(true);
    expect(toolOutput.data.text).toContain('Come to me');
  });

  it('returns immediately when the first turn is already a final message (no tool needed)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(finalMessageTurn('{"format":"micro"}')));
    const toolExecutor = vi.fn();
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    const result = await client.runToolLoop(baseRequest, toolExecutor);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(result.toolCallsExecuted).toBe(0);
    expect(result.finalText).toBe('{"format":"micro"}');
  });

  it('loops through multiple tool calls across turns up to the cap, then throws', async () => {
    // Every turn asks for another tool call — never resolves — to exercise the cap.
    const fetchImpl = vi.fn(async () =>
      jsonRes(functionCallTurn(`call_${Math.random()}`, '{"usfm":"JHN.3.16","versionId":111}')),
    );
    const toolExecutor = vi.fn(async () =>
      JSON.stringify({
        ok: true,
        data: {},
        meta: { source: 'youversion', fetched_at: new Date().toISOString() },
      }),
    );

    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    await expect(client.runToolLoop(baseRequest, toolExecutor)).rejects.toBeInstanceOf(
      GlooToolCallLimitError,
    );
    expect(toolExecutor).toHaveBeenCalledTimes(MAX_TOOL_CALLS);
  });

  it('propagates a tool executor error (e.g. YouVersion failure) instead of swallowing it', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes(functionCallTurn('call_1', '{"usfm":"JHN.3.16","versionId":111}')),
    );
    const toolExecutor = vi.fn(async () => {
      throw new Error('YouVersion unavailable');
    });
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    await expect(client.runToolLoop(baseRequest, toolExecutor)).rejects.toThrow(
      'YouVersion unavailable',
    );
  });

  it('handles multiple function_call items within a single turn', async () => {
    const multiCallTurn: GlooResponse = {
      id: 'resp_multi',
      object: 'response',
      model: 'test-model',
      output: [
        {
          type: 'function_call',
          call_id: 'call_a',
          name: 'get_bible_verse',
          arguments: '{"usfm":"JHN.3.16","versionId":111}',
        },
        {
          type: 'function_call',
          call_id: 'call_b',
          name: 'get_bible_verse',
          arguments: '{"usfm":"PSA.23.1","versionId":111}',
        },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(multiCallTurn))
      .mockResolvedValueOnce(jsonRes(finalMessageTurn('{"done":true}')));

    const toolExecutor = vi.fn(async (_name: string, argsJson: string) => {
      const { usfm } = JSON.parse(argsJson);
      return JSON.stringify({
        ok: true,
        data: { usfm },
        meta: { source: 'youversion', fetched_at: new Date().toISOString() },
      });
    });

    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    const result = await client.runToolLoop(baseRequest, toolExecutor);
    expect(toolExecutor).toHaveBeenCalledTimes(2);
    expect(result.toolCallsExecuted).toBe(2);

    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body) as CreateResponseRequest;
    // user message + 2x(function_call + function_call_output) = 5 items
    expect(secondBody.input).toHaveLength(5);
  });

  it('downgrades tool_choice from "required" to "auto" after turn 1 (API spec §2.1) so the model can finalize instead of looping to the cap', async () => {
    // Live-verified regression (2026-07-02, devotionalEngine.live.test.ts):
    // sending tool_choice:"required" on every turn starved the loop into
    // GlooToolCallLimitError because the model was never permitted to stop
    // calling get_bible_verse and emit its final message.
    const turn1 = functionCallTurn('call_1', '{"usfm":"JHN.3.16","versionId":111}');
    const turn2 = finalMessageTurn('{"done":true}');
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(turn1)).mockResolvedValueOnce(jsonRes(turn2));
    const toolExecutor = vi.fn(async () =>
      JSON.stringify({ ok: true, data: {}, meta: { source: 'youversion', fetched_at: new Date().toISOString() } }),
    );
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    await client.runToolLoop({ ...baseRequest, tool_choice: 'required' }, toolExecutor);

    const firstBody = JSON.parse(fetchImpl.mock.calls[0]![1].body) as CreateResponseRequest;
    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body) as CreateResponseRequest;
    expect(firstBody.tool_choice).toBe('required');
    expect(secondBody.tool_choice).toBe('auto');
  });

  it('leaves tool_choice untouched across turns when the initial request did not request "required"', async () => {
    const turn1 = functionCallTurn('call_1', '{"usfm":"JHN.3.16","versionId":111}');
    const turn2 = finalMessageTurn('{"done":true}');
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(turn1)).mockResolvedValueOnce(jsonRes(turn2));
    const toolExecutor = vi.fn(async () =>
      JSON.stringify({ ok: true, data: {}, meta: { source: 'youversion', fetched_at: new Date().toISOString() } }),
    );
    const client = new GlooResponsesClient({
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    await client.runToolLoop({ ...baseRequest, tool_choice: 'auto' }, toolExecutor);

    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body) as CreateResponseRequest;
    expect(secondBody.tool_choice).toBe('auto');
  });
});
