/**
 * GlooTokenManager — OAuth2 client-credentials token cache for Gloo AI.
 *
 * Exact flow pinned in docs/00_FOUNDATION.md §4.1 / docs/03_API_INTEGRATION_SPEC.md §1:
 *   POST https://platform.ai.gloo.com/oauth2/token
 *   Authorization: Basic base64(`${GLOO_CLIENT_ID}:${GLOO_CLIENT_SECRET}`)
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=client_credentials&scope=api/access
 *
 * Rules (Foundation §4.1, API spec §1):
 *  - `access_token` cached in memory only, refreshed at T-60s before expiry.
 *  - NEVER persisted to disk, DB, or logs.
 *  - No refresh tokens exist — re-request the grant on expiry.
 *  - Single-flight: concurrent callers while a fetch is in-flight await the
 *    same promise rather than firing duplicate token requests.
 *  - Failure -> AUTH_FAILED (caller's responsibility to map/retry per §9 of
 *    the API spec; this class just throws `GlooAuthError`).
 *
 * Outbound-call hardening (docs/14_IMPROVEMENT_REVIEW.md §2.2 / issue #73):
 *  - Every token request carries `AbortSignal.timeout(10_000)` (10s budget).
 *  - Bounded retry (max 2 retries, exponential backoff + jitter via
 *    `httpRetry.ts`) on 429/5xx HTTP responses and on network-level
 *    failures (fetch throwing); honors a `Retry-After` header when present.
 *    Non-retryable HTTP failures (4xx other than 429, malformed body) fail
 *    on the first attempt.
 */

import { parseRetryAfterMs, withRetry, type RetryDecision } from '../httpRetry.js';

const GLOO_TOKEN_URL = 'https://platform.ai.gloo.com/oauth2/token';
const REFRESH_SKEW_MS = 60_000;
const TOKEN_TIMEOUT_MS = 10_000;

/** Injectable clock so tests never sleep real seconds. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Minimal fetch-like contract so tests can inject a fake without touching the network. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Aborts the request when the signal fires — every outbound call passes `AbortSignal.timeout(...)` (docs/14 §2.2). */
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class GlooAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GlooAuthError';
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.access_token === 'string' && typeof v.expires_in === 'number';
}

export interface GlooTokenManagerOptions {
  clientId: string;
  clientSecret: string;
  /** Defaults to global fetch. Inject in tests to avoid real network calls. */
  fetchImpl?: FetchLike;
  /** Defaults to Date.now(). Inject in tests to control expiry math without sleeping. */
  clock?: Clock;
  tokenUrl?: string;
  /** Injectable retry sleep (tests only) — see httpRetry.ts. Defaults to a real setTimeout-based sleep. */
  retrySleep?: (ms: number) => Promise<void>;
  /** Injectable retry jitter RNG (tests only) — see httpRetry.ts. Defaults to Math.random. */
  retryRandom?: () => number;
}

export class GlooTokenManager {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly tokenUrl: string;
  private readonly retrySleep?: (ms: number) => Promise<void>;
  private readonly retryRandom?: () => number;

  /** In-memory cache only — never written to disk/DB/logs. */
  private cachedToken: string | undefined;
  private expiresAtMs: number | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(options: GlooTokenManagerOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new GlooAuthError('GlooTokenManager requires clientId and clientSecret');
    }
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.clock = options.clock ?? systemClock;
    this.tokenUrl = options.tokenUrl ?? GLOO_TOKEN_URL;
    this.retrySleep = options.retrySleep;
    this.retryRandom = options.retryRandom;
  }

  /**
   * Returns a valid access token, using the in-memory cache when it is not
   * within `REFRESH_SKEW_MS` of expiry. Single-flights concurrent refreshes.
   */
  async getToken(): Promise<string> {
    if (
      this.cachedToken &&
      this.expiresAtMs !== undefined &&
      this.clock.now() < this.expiresAtMs - REFRESH_SKEW_MS
    ) {
      return this.cachedToken;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchToken().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Force-drop the cached token (e.g. after an upstream 401 using a stale token). */
  invalidate(): void {
    this.cachedToken = undefined;
    this.expiresAtMs = undefined;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    type Attempt = { ok: true; token: string; expiresIn: number } | { ok: false; error: GlooAuthError };

    const result = await withRetry<Attempt>(
      async (): Promise<RetryDecision<Attempt>> => {
        let res: Awaited<ReturnType<FetchLike>>;
        try {
          res = await this.fetchImpl(this.tokenUrl, {
            method: 'POST',
            headers: {
              Authorization: `Basic ${basic}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials&scope=api/access',
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
          });
        } catch (err) {
          // Network-level failure (including our own timeout abort) — retryable.
          return {
            done: false,
            value: { ok: false, error: new GlooAuthError(`Gloo token request failed: ${(err as Error).message}`) },
          };
        }

        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          const error = new GlooAuthError(
            `Gloo token exchange failed with HTTP ${res.status}${bodyText ? `: ${bodyText}` : ''}`,
            res.status,
          );
          const retryable = res.status === 429 || res.status >= 500;
          if (!retryable) {
            return { done: true, value: { ok: false, error } };
          }
          const retryAfterMs = parseRetryAfterMs(res.headers?.get('retry-after'), this.clock.now());
          return { done: false, value: { ok: false, error }, retryAfterMs };
        }

        const body: unknown = await res.json();
        if (!isTokenResponse(body)) {
          return {
            done: true,
            value: { ok: false, error: new GlooAuthError('Gloo token response missing access_token/expires_in') },
          };
        }
        return { done: true, value: { ok: true, token: body.access_token, expiresIn: body.expires_in } };
      },
      { sleep: this.retrySleep, random: this.retryRandom },
    );

    if (!result.ok) {
      throw result.error;
    }

    this.cachedToken = result.token;
    this.expiresAtMs = this.clock.now() + result.expiresIn * 1000;
    return this.cachedToken;
  }
}
