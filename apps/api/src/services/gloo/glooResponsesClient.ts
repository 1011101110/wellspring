/**
 * GlooResponsesClient — Gloo Responses API v1 (OpenAI-compatible), with the
 * `get_bible_verse` tool-calling loop.
 *
 * Contract: docs/00_FOUNDATION.md §4.2 / §4.4, docs/03_API_INTEGRATION_SPEC.md §2.
 *
 *   POST https://platform.ai.gloo.com/ai/v1/responses
 *
 * Loop (Foundation §4.2, API spec §2.2):
 *   1. Send `input[]` (+ `tools`, `tool_choice`, `response_format`, ...).
 *   2. If the model's `output[]` contains a `function_call` item, execute
 *      the named tool via the injected executor, then re-send the FULL
 *      `input[]` plus the original `function_call` item plus a
 *      `function_call_output` item carrying the same `call_id`.
 *   3. Repeat until `output[]` contains a `message` item (final) or the
 *      per-call cap (4) is hit.
 *
 * The tool executor is injectable so this client is unit-testable without a
 * real YouVersion call — real wiring happens in the B5 stage.
 *
 * Outbound-call hardening (docs/14_IMPROVEMENT_REVIEW.md §2.2 / issue #73):
 *  - Every request carries `AbortSignal.timeout(60_000)` (60s/turn budget).
 *  - Bounded retry (max 2 retries, exponential backoff + jitter): 429 and
 *    network-level failures get the full 2 retries; a 5xx gets exactly ONE
 *    retry (a hung/degraded model backend is less likely to self-heal than
 *    a rate limit, so we fail faster rather than burning the full budget).
 *    Retry-After is honored when present. Non-retryable 4xx (other than
 *    401, see below) fail on the first attempt.
 *  - 401 handling: if `invalidateToken` was supplied, a 401 triggers
 *    exactly one token invalidate + re-mint + retry via GlooTokenManager's
 *    `invalidate()` hook (wired in index.ts's composition root — this
 *    closed docs/14 §2.2's "invalidate() has zero callers" finding). The
 *    re-mint attempt does not consume the 429/5xx retry budget above.
 */

import { parseRetryAfterMs, withRetry, type RetryDecision } from '../httpRetry.js';
import type { FetchLike } from './glooTokenManager.js';

const GLOO_RESPONSES_URL = 'https://platform.ai.gloo.com/ai/v1/responses';
const RESPONSES_TIMEOUT_MS = 60_000;

/** Cap on tool round-trips per generation — API spec §2.2. */
export const MAX_TOOL_CALLS = 4;

// --- Typed `input[]` items -------------------------------------------------

export interface MessageInputItem {
  role: 'user' | 'system' | 'assistant';
  content: string;
}

export interface FunctionCallItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface FunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type InputItem = MessageInputItem | FunctionCallItem | FunctionCallOutputItem;

// --- Typed `output[]` items (what Gloo sends back) --------------------------

export interface FunctionCallOutputEntry {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface OutputTextContent {
  type: 'output_text';
  text: string;
}

export interface MessageOutputEntry {
  type: 'message';
  role: 'assistant';
  content: OutputTextContent[];
}

export type OutputEntry = FunctionCallOutputEntry | MessageOutputEntry;

export interface GlooResponse {
  id: string;
  object: string;
  model: string;
  output: OutputEntry[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// --- Tool schema (nested Chat-Completions function shape, Foundation §4.4) --

export interface ToolFunctionDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface JsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface CreateResponseRequest {
  model: string;
  input: InputItem[];
  instructions?: string;
  tools?: ToolFunctionDef[];
  tool_choice?: 'auto' | 'required' | 'none';
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  response_format?: JsonSchemaResponseFormat;
}

/**
 * Injectable tool executor. Given a tool name and its parsed JSON arguments,
 * returns the tool-envelope JSON string to send back as
 * `function_call_output.output` (Foundation §4.5). Kept generic (not
 * get_bible_verse-specific) so future tools can share the same loop.
 */
export type ToolExecutor = (name: string, argsJson: string) => Promise<string>;

export class GlooResponsesError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GlooResponsesError';
  }
}

export class GlooToolCallLimitError extends Error {
  constructor(readonly callsMade: number) {
    super(`Gloo tool-call loop exceeded the cap of ${MAX_TOOL_CALLS} calls (made ${callsMade})`);
    this.name = 'GlooToolCallLimitError';
  }
}

export interface GlooResponsesClientOptions {
  getAccessToken: () => Promise<string>;
  fetchImpl?: FetchLike;
  responsesUrl?: string;
  maxToolCalls?: number;
  /**
   * Called on a 401 (once) before invalidating the cached token and
   * retrying — wire `GlooTokenManager.invalidate.bind(tokenManager)` here
   * (docs/14 §2.2's "wire invalidate() into the Gloo 401 path"). Omitted in
   * tests/contexts with no token cache to invalidate.
   */
  invalidateToken?: () => void;
  /** Injectable retry sleep (tests only) — see httpRetry.ts. Defaults to a real setTimeout-based sleep. */
  retrySleep?: (ms: number) => Promise<void>;
  /** Injectable retry jitter RNG (tests only) — see httpRetry.ts. Defaults to Math.random. */
  retryRandom?: () => number;
}

export interface CreateResponseResult {
  /** The final `message` response from Gloo (after the tool loop completes). */
  finalResponse: GlooResponse;
  /** Concatenated `output_text` from the final message, if present. */
  finalText: string | undefined;
  /** Every raw response Gloo returned across the loop, in order (for debugging/audit). */
  turns: GlooResponse[];
  /** Number of function_call round-trips executed. */
  toolCallsExecuted: number;
}

export class GlooResponsesClient {
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: FetchLike;
  private readonly responsesUrl: string;
  private readonly maxToolCalls: number;
  private readonly invalidateToken?: () => void;
  private readonly retrySleep?: (ms: number) => Promise<void>;
  private readonly retryRandom?: () => number;

  constructor(options: GlooResponsesClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.responsesUrl = options.responsesUrl ?? GLOO_RESPONSES_URL;
    this.maxToolCalls = options.maxToolCalls ?? MAX_TOOL_CALLS;
    this.invalidateToken = options.invalidateToken;
    this.retrySleep = options.retrySleep;
    this.retryRandom = options.retryRandom;
  }

  /**
   * Single POST to /ai/v1/responses — no tool-loop logic. Exposed for
   * direct/manual use and testing. Applies:
   *  - `AbortSignal.timeout(60_000)` per request.
   *  - Exactly one 401 -> invalidate-and-re-mint-token -> retry (before any
   *    of the 429/5xx/network retry budget below is spent).
   *  - Bounded retry (429/network: 2 retries; 5xx: 1 retry), honoring
   *    Retry-After.
   */
  async createResponse(request: CreateResponseRequest): Promise<GlooResponse> {
    return this.createResponseWithReauth(request, /* allowReauth */ true);
  }

  private async createResponseWithReauth(
    request: CreateResponseRequest,
    allowReauth: boolean,
  ): Promise<GlooResponse> {
    type Attempt = { ok: true; body: GlooResponse } | { ok: false; error: GlooResponsesError; is401: boolean };

    const result = await withRetry<Attempt>(
      async (attempt): Promise<RetryDecision<Attempt>> => {
        const token = await this.getAccessToken();
        let res: Awaited<ReturnType<FetchLike>>;
        try {
          res = await this.fetchImpl(this.responsesUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(RESPONSES_TIMEOUT_MS),
          });
        } catch (err) {
          const error = new GlooResponsesError(`Gloo responses request failed: ${(err as Error).message}`);
          return { done: false, value: { ok: false, error, is401: false } };
        }

        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          const error = new GlooResponsesError(
            `Gloo responses call failed with HTTP ${res.status}${bodyText ? `: ${bodyText}` : ''}`,
            res.status,
          );
          if (res.status === 401) {
            return { done: true, value: { ok: false, error, is401: true } };
          }
          // 429/network: full retry budget. 5xx: exactly one retry (attempt 0 -> 1 only).
          const retryable = res.status === 429 || (res.status >= 500 && attempt < 1);
          if (!retryable) {
            return { done: true, value: { ok: false, error, is401: false } };
          }
          const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers?.get('retry-after')) : undefined;
          return { done: false, value: { ok: false, error, is401: false }, retryAfterMs };
        }

        const body = (await res.json()) as GlooResponse;
        if (!Array.isArray(body.output)) {
          return {
            done: true,
            value: { ok: false, error: new GlooResponsesError('Gloo response missing output[] array'), is401: false },
          };
        }
        return { done: true, value: { ok: true, body } };
      },
      { sleep: this.retrySleep, random: this.retryRandom, maxRetries: 2 },
    );

    if (result.ok) {
      return result.body;
    }

    if (result.is401 && allowReauth && this.invalidateToken) {
      this.invalidateToken();
      return this.createResponseWithReauth(request, /* allowReauth */ false);
    }

    throw result.error;
  }

  /**
   * Runs the full two-turn (or more, up to the cap) tool-calling loop:
   * send -> if function_call(s) present, execute via `toolExecutor` and
   * re-send full history + function_call + function_call_output -> repeat
   * until a `message` item is returned or the cap is hit.
   */
  async runToolLoop(
    initialRequest: CreateResponseRequest,
    toolExecutor: ToolExecutor,
  ): Promise<CreateResponseResult> {
    const input: InputItem[] = [...initialRequest.input];
    const turns: GlooResponse[] = [];
    let toolCallsExecuted = 0;

    for (let turnIndex = 0; ; turnIndex += 1) {
      // API spec §2.1: tool_choice is "required" on turn 1 only (a
      // devotional must fetch Scripture at least once) — "auto" after, so
      // the model can actually emit its final `message` once it has what it
      // needs instead of being forced to keep calling tools until the cap
      // (live-verified 2026-07-02: sending "required" on every turn starves
      // the loop into GlooToolCallLimitError because the model is never
      // permitted to stop calling the tool).
      const turnRequest =
        turnIndex === 0 || initialRequest.tool_choice !== 'required'
          ? { ...initialRequest, input }
          : { ...initialRequest, input, tool_choice: 'auto' as const };
      const response = await this.createResponse(turnRequest);
      turns.push(response);

      const functionCalls = response.output.filter(
        (item): item is FunctionCallOutputEntry => item.type === 'function_call',
      );

      if (functionCalls.length === 0) {
        const message = response.output.find(
          (item): item is MessageOutputEntry => item.type === 'message',
        );
        const finalText = message?.content
          .filter((c): c is OutputTextContent => c.type === 'output_text')
          .map((c) => c.text)
          .join('');
        return { finalResponse: response, finalText, turns, toolCallsExecuted };
      }

      for (const call of functionCalls) {
        if (toolCallsExecuted >= this.maxToolCalls) {
          throw new GlooToolCallLimitError(toolCallsExecuted);
        }
        toolCallsExecuted += 1;

        const output = await toolExecutor(call.name, call.arguments);

        // Re-send full history + the original function_call + its output,
        // exactly per Foundation §4.2 / API spec §2.2.
        input.push({
          type: 'function_call',
          id: call.id,
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments,
        });
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        });
      }
    }
  }
}
