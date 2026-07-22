/**
 * Shared outbound-call hardening: bounded retry with exponential backoff +
 * jitter, honoring `Retry-After`, shared by GlooTokenManager, GlooResponsesClient,
 * and YouVersionClient (docs/14_IMPROVEMENT_REVIEW.md §2.2, §2.11 / issue #73).
 *
 * Design:
 *   - `withRetry` wraps a single-attempt async function that returns a
 *     `RetryDecision` telling the caller whether the just-completed attempt
 *     should be retried. This keeps HTTP-status interpretation (which codes
 *     are retryable, how many times) with each client, while the actual
 *     "wait, then try again" mechanics — and their fake-timer testability —
 *     live in one place.
 *   - Max 2 RETRIES (so up to 3 total attempts), exponential backoff
 *     (base * 2^attempt) with full jitter, capped, honoring a server-supplied
 *     `Retry-After` (seconds or HTTP-date) when present in preference to the
 *     computed backoff.
 *   - `sleep`/`random` are injectable so tests never wait on a real clock —
 *     pair with vitest fake timers (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`).
 */

export interface RetryDecision<T> {
  /** true = attempt succeeded (or failed in a non-retryable way) and `value` is the result to return. */
  done: boolean;
  value: T;
  /** Only meaningful when `done` is false: how long the caller asked us to wait, if it told us (Retry-After). */
  retryAfterMs?: number;
}

export interface WithRetryOptions {
  /** Max number of RETRIES after the first attempt (default 2, i.e. up to 3 total attempts). */
  maxRetries?: number;
  /** Base backoff in ms before jitter/exponent (default 200ms). */
  baseDelayMs?: number;
  /** Upper bound on computed backoff, pre-Retry-After-override (default 4000ms). */
  maxDelayMs?: number;
  /** Injectable for tests — defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0,1) for deterministic jitter in tests. Defaults to Math.random. */
  random?: () => number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 4000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter exponential backoff: random value in [0, min(maxDelayMs, base * 2^attempt)]. */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * cap);
}

/**
 * Parses a `Retry-After` header value: either an integer number of seconds,
 * or an HTTP-date. Returns milliseconds to wait, or undefined if unparseable.
 * `nowMs` is injectable so date-form headers are testable without a real clock.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const deltaMs = dateMs - nowMs;
    return deltaMs > 0 ? deltaMs : 0;
  }
  return undefined;
}

/**
 * Runs `attemptFn` up to `1 + maxRetries` times. `attemptFn` receives the
 * zero-based attempt index and must return a `RetryDecision`: `done: true`
 * short-circuits immediately (success or a non-retryable failure); `done:
 * false` triggers a backoff sleep (honoring `retryAfterMs` if given) and
 * another attempt, unless retries are exhausted, in which case the last
 * decision's `value` is returned as-is (caller's responsibility to make that
 * a sensible terminal value, e.g. the last error response).
 */
export async function withRetry<T>(
  attemptFn: (attempt: number) => Promise<RetryDecision<T>>,
  options: WithRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastValue: T | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const decision = await attemptFn(attempt);
    if (decision.done || attempt === maxRetries) {
      return decision.value;
    }
    lastValue = decision.value;
    const backoff = decision.retryAfterMs ?? computeBackoffMs(attempt, baseDelayMs, maxDelayMs, random);
    await sleep(backoff);
  }
  // Unreachable (the loop always returns on the final iteration), but keeps
  // TypeScript happy without a non-null assertion.
  return lastValue as T;
}
