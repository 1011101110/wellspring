/**
 * OpenMomentEngine tests (EPIC V #360 / V2 #363).
 *
 * Same idiom as devotionalEngine.test.ts: REAL GlooResponsesClient +
 * YouVersionClient with injected `fetchImpl` mocks, so the actual tool-loop
 * + the full anti-hallucination gauntlet run end-to-end against fake HTTP.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpenMomentContext } from '@kairos/shared-contracts';
import {
  GlooResponsesClient,
  type GlooResponse,
} from '../../../src/services/gloo/glooResponsesClient.js';
import {
  YouVersionClient,
  type FetchLike as YvFetchLike,
} from '../../../src/services/youversion/youVersionClient.js';
import type { FetchLike as GlooFetchLike } from '../../../src/services/gloo/glooTokenManager.js';
import {
  OpenMomentEngine,
  type OpenMomentEngineLogger,
} from '../../../src/services/stage/openMomentEngine.js';

const CONTEXT: OpenMomentContext = {
  language: 'en',
  tradition: 'general',
  translation: 'BSB',
  preferredVersionId: 3034,
  voiceName: 'en-US-Chirp3-HD-Achernar',
};

const EXACT_TEXT = 'Come to Me, all you who labor and are heavy-laden, and I will give you rest.';

function jsonRoute(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function youVersionFetch(passageText = EXACT_TEXT): YvFetchLike {
  return vi.fn(async (url: string) => {
    const path = url.replace('https://api.youversion.com', '');
    if (path.includes('/index')) {
      return jsonRoute({
        books: [
          {
            id: 'MAT',
            chapters: [
              { id: '11', verses: Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1) })) },
            ],
          },
        ],
      });
    }
    if (/^\/v1\/bibles\/\d+$/.test(path)) {
      return jsonRoute({
        id: 3034,
        abbreviation: 'BSB',
        title: 'Berean Standard Bible',
        copyright: 'Public domain.',
      });
    }
    if (path.includes('/passages/')) {
      return jsonRoute({ id: 'MAT.11.28', content: passageText, reference: 'Matthew 11:28' });
    }
    throw new Error(`Unexpected YouVersion path in test: ${path}`);
  }) as unknown as YvFetchLike;
}

function glooJsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function functionCallTurn(callId: string): GlooResponse {
  return {
    id: 'resp_1',
    object: 'response',
    model: 'test-model',
    output: [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: callId,
        name: 'get_bible_verse',
        arguments: JSON.stringify({
          usfm: 'MAT.11.28',
          versionId: 3034,
          reason: 'rest for the weary',
        }),
      },
    ],
  };
}

function messageTurn(text: string): GlooResponse {
  return {
    id: 'resp_2',
    object: 'response',
    model: 'test-model',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function liveResponseJson(
  overrides: Record<string, unknown> = {},
  verseOverrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    acknowledgment: 'I hear the weight you carried in.',
    verse: {
      usfm: 'MAT.11.28',
      versionId: 3034,
      reference: 'Matthew 11:28',
      fetchedText: EXACT_TEXT,
      attribution: 'Berean Standard Bible (BSB). Public domain.',
      ...verseOverrides,
    },
    framing: 'Let that be the last word before we pray.',
    ...overrides,
  });
}

function buildEngine(
  glooFetch: GlooFetchLike,
  yvFetch: YvFetchLike = youVersionFetch(),
  logger?: OpenMomentEngineLogger,
) {
  const glooResponsesClient = new GlooResponsesClient({
    getAccessToken: async () => 'test-token',
    fetchImpl: glooFetch,
  });
  const youVersionClient = new YouVersionClient({ apiKey: 'test-key', fetchImpl: yvFetch });
  return new OpenMomentEngine({ glooResponsesClient, youVersionClient, logger });
}

function spyLogger(): OpenMomentEngineLogger & {
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  return { error: vi.fn(), info: vi.fn() };
}

describe('OpenMomentEngine.respond — happy path', () => {
  it('runs a single bounded turn and returns a validated grounded response', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(liveResponseJson())));

    const result = await buildEngine(glooFetch as unknown as GlooFetchLike).respond(
      "I'm anxious about a hard conversation with my dad.",
      CONTEXT,
    );

    expect(result.outcome).toBe('response');
    if (result.outcome !== 'response') throw new Error('expected response');
    expect(result.response.verse.fetchedText).toBe(EXACT_TEXT);
    expect(result.response.verse.reference).toBe('Matthew 11:28');
    expect(result.distressFlagged).toBe(false);
  });

  it('sends tool_choice=required, the get_bible_verse tool, a LiveResponse json_schema, and low temperature', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(liveResponseJson())));

    await buildEngine(glooFetch as unknown as GlooFetchLike).respond('a heavy day', CONTEXT);

    const [, init] = glooFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toBe('required');
    expect(body.tools[0].function.name).toBe('get_bible_verse');
    expect(body.response_format.json_schema.name).toBe('live_response');
    expect(body.temperature).toBeLessThanOrEqual(0.3);
    expect(body.instructions).toContain('Never quote Scripture from memory');
  });
});

describe('OpenMomentEngine.respond — anti-hallucination (mutation-checked)', () => {
  it('OVERWRITES a paraphrased fetchedText with the exact YouVersion bytes (server-authoritative)', async () => {
    // The model paraphrases the verse — the engine must substitute the exact
    // recorded YouVersion bytes BEFORE validation, so the response still passes
    // AND displays the authoritative text.
    const paraphrased = liveResponseJson(
      {},
      { fetchedText: 'Come to me if you are tired and I will rest you.' },
    );
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(paraphrased)));

    const result = await buildEngine(glooFetch as unknown as GlooFetchLike).respond(
      'weary',
      CONTEXT,
    );

    expect(result.outcome).toBe('response');
    if (result.outcome !== 'response') throw new Error('expected response');
    // MUTATION CHECK: the paraphrase is gone; the exact bytes are what ships.
    expect(result.response.verse.fetchedText).toBe(EXACT_TEXT);
    expect(result.response.verse.fetchedText).not.toContain('tired');
  });

  it('resolves to SILENCE when the model cites a verse it never fetched (fabricated reference)', async () => {
    // The model returns a verse with a usfm it never called get_bible_verse for
    // — nothing authoritative to substitute, so findFetchedTextMismatches flags
    // it. With no tool call at all, both turns fail → silence.
    const fabricated = JSON.stringify({
      acknowledgment: 'I hear you.',
      verse: {
        usfm: 'JHN.3.16',
        versionId: 3034,
        reference: 'John 3:16',
        fetchedText: 'For God so loved the world...',
        attribution: 'BSB',
      },
      framing: 'Rest in that.',
    });
    // No function_call turn — the model just emits a message both times.
    const glooFetch = vi.fn().mockResolvedValue(glooJsonRes(messageTurn(fabricated)));

    const result = await buildEngine(glooFetch as unknown as GlooFetchLike).respond(
      'weary',
      CONTEXT,
    );
    expect(result.outcome).toBe('silence');
  });

  it('resolves to SILENCE on unparseable model output after one repair attempt', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn('not json at all')))
      // repair turn (tool_choice auto) — still garbage
      .mockResolvedValueOnce(glooJsonRes(messageTurn('still not json')));

    const result = await buildEngine(glooFetch as unknown as GlooFetchLike).respond(
      'weary',
      CONTEXT,
    );
    expect(result.outcome).toBe('silence');
  });
});

describe('OpenMomentEngine.respond — silence + distress', () => {
  it('returns silence WITHOUT calling Gloo for an empty transcript (Path B)', async () => {
    const glooFetch = vi.fn();
    const result = await buildEngine(glooFetch as unknown as GlooFetchLike).respond('   ', CONTEXT);
    expect(result.outcome).toBe('silence');
    expect(result.distressFlagged).toBe(false);
    expect(glooFetch).not.toHaveBeenCalled();
  });

  it('flags a spoken distress transcript and forces the 988 comfort instruction (the O3 pattern)', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(liveResponseJson())));

    const result = await buildEngine(glooFetch as unknown as GlooFetchLike).respond(
      "I don't want to be here anymore, I want to die.",
      CONTEXT,
    );

    expect(result.distressFlagged).toBe(true);
    // MUTATION CHECK: the distress branch put the 988 resource + gentle-comfort
    // steer into the instructions the model actually received.
    const [, init] = glooFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.instructions).toContain('988');
    expect(body.instructions).toContain('gentle-comfort');
  });

  it('does NOT add the 988 instruction for an ordinary burden', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(liveResponseJson())));

    await buildEngine(glooFetch as unknown as GlooFetchLike).respond(
      'I am tired and stretched thin.',
      CONTEXT,
    );
    const [, init] = glooFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).instructions).not.toContain('988');
  });
});

describe('OpenMomentEngine.respond — V5 seam', () => {
  it('vetoes an otherwise-valid response to silence via postValidateHook (verbatim-echo guard seam)', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(liveResponseJson())));
    const glooResponsesClient = new GlooResponsesClient({
      getAccessToken: async () => 'test-token',
      fetchImpl: glooFetch as unknown as GlooFetchLike,
    });
    const youVersionClient = new YouVersionClient({ apiKey: 'k', fetchImpl: youVersionFetch() });
    const engine = new OpenMomentEngine({
      glooResponsesClient,
      youVersionClient,
      logger: spyLogger(),
      postValidateHook: () => true, // always veto
    });

    const result = await engine.respond('weary', CONTEXT);
    expect(result.outcome).toBe('silence');
  });
});
