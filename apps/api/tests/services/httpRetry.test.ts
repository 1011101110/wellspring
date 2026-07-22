import { describe, expect, it, vi } from 'vitest';
import { computeBackoffMs, parseRetryAfterMs, withRetry } from '../../src/services/httpRetry.js';

describe('parseRetryAfterMs', () => {
  it('parses integer-seconds form', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('parses HTTP-date form relative to now', () => {
    const now = Date.parse('2026-07-02T00:00:00Z');
    const future = new Date(now + 10_000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBe(10_000);
  });

  it('clamps a past HTTP-date to 0 rather than a negative delay', () => {
    const now = Date.parse('2026-07-02T00:00:00Z');
    const past = new Date(now - 10_000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  it('returns undefined for missing/unparseable values', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date-or-number')).toBeUndefined();
  });
});

describe('computeBackoffMs', () => {
  it('is bounded by min(maxDelayMs, base * 2^attempt) and never negative', () => {
    const random = () => 0.999999;
    expect(computeBackoffMs(0, 100, 4000, random)).toBeLessThanOrEqual(100);
    expect(computeBackoffMs(3, 100, 4000, random)).toBeLessThanOrEqual(800);
    expect(computeBackoffMs(10, 100, 4000, random)).toBeLessThanOrEqual(4000); // capped
  });

  it('is deterministic given a fixed random source', () => {
    const random = () => 0.5;
    expect(computeBackoffMs(1, 100, 4000, random)).toBe(100); // floor(0.5 * 200)
  });
});

describe('withRetry', () => {
  it('returns immediately on a done:true first attempt with no sleep', async () => {
    const sleep = vi.fn(async () => {});
    const attemptFn = vi.fn(async () => ({ done: true, value: 'ok' }));
    const result = await withRetry(attemptFn, { sleep });
    expect(result).toBe('ok');
    expect(attemptFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries up to maxRetries times then returns the last value', async () => {
    const sleep = vi.fn(async () => {});
    const attemptFn = vi.fn(async () => ({ done: false, value: 'still-failing' }));
    const result = await withRetry(attemptFn, { maxRetries: 2, sleep, random: () => 0 });
    expect(result).toBe('still-failing');
    expect(attemptFn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('succeeds on a later attempt without exhausting retries', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const attemptFn = vi.fn(async () => {
      calls += 1;
      return calls < 2 ? { done: false, value: 'retry-me' } : { done: true, value: 'success' };
    });
    const result = await withRetry(attemptFn, { maxRetries: 2, sleep, random: () => 0 });
    expect(result).toBe('success');
    expect(attemptFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('honors retryAfterMs over the computed backoff', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const attemptFn = vi.fn(async () => {
      calls += 1;
      return calls < 2
        ? { done: false, value: 'rate-limited', retryAfterMs: 9999 }
        : { done: true, value: 'ok' };
    });
    await withRetry(attemptFn, { maxRetries: 2, sleep, random: () => 0 });
    expect(sleep).toHaveBeenCalledWith(9999);
  });

  it('does not call attemptFn more than maxRetries+1 times when maxRetries is 0', async () => {
    const sleep = vi.fn(async () => {});
    const attemptFn = vi.fn(async () => ({ done: false, value: 'nope' }));
    const result = await withRetry(attemptFn, { maxRetries: 0, sleep });
    expect(result).toBe('nope');
    expect(attemptFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
