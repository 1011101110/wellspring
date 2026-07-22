/**
 * `FreeBusyCache` — the in-process TTL cache behind
 * `GET /v1/calendar/freebusy` (M1, #255).
 *
 * Scope note: **revocation safety is not tested here, and cannot be.** It
 * is a property of the *route's gate ordering* — the consent and connection
 * checks run above the cache read, so a revoked user never reaches this
 * class at all. That property is asserted where it lives, in
 * `tests/routes/calendarFreeBusy.test.ts` ("cannot serve a cached entry
 * after consent is withdrawn"), against the real route. Asserting it here
 * would be asserting it against the wrong object, and would pass whether or
 * not the route actually ordered its gates correctly.
 *
 * What this file covers is the cache's own contract: keying, TTL, and the
 * size bound.
 */
import { describe, expect, it } from 'vitest';
import {
  FreeBusyCache,
  FREEBUSY_CACHE_TTL_MS,
} from '../../../src/services/calendar/freeBusyCache.js';

const BLOCKS = [{ start: '2026-07-20T13:00:00Z', end: '2026-07-20T14:00:00Z' }];

function keyFor(userId = 'user-a', timeMin = '2026-07-20T00:00:00.000Z') {
  return { userId, timeMin, timeMax: '2026-07-21T00:00:00.000Z' };
}

/** A cache with a controllable clock — TTL is tested by advancing a number, never by sleeping. */
function clockedCache(options: { maxEntries?: number } = {}) {
  let nowMs = 1_000_000;
  const cache = new FreeBusyCache<typeof BLOCKS>({ ...options, now: () => nowMs });
  return { cache, advance: (ms: number) => (nowMs += ms) };
}

describe('FreeBusyCache — keying', () => {
  it('returns a stored value for the identical key', () => {
    const { cache } = clockedCache();
    cache.set(keyFor(), BLOCKS);
    expect(cache.get(keyFor())).toEqual(BLOCKS);
  });

  it('misses on an unknown key', () => {
    const { cache } = clockedCache();
    expect(cache.get(keyFor())).toBeUndefined();
  });

  it('never serves one user\'s blocks to another', () => {
    // The assertion that matters most in this file. Every client computing
    // "this week" produces the same range strings, so the range alone is a
    // near-guaranteed collision; only the user id separates them.
    const { cache } = clockedCache();
    cache.set(keyFor('user-a'), BLOCKS);

    expect(cache.get(keyFor('user-b'))).toBeUndefined();
  });

  it('distinguishes ranges within one user', () => {
    const { cache } = clockedCache();
    cache.set(keyFor('user-a', '2026-07-20T00:00:00.000Z'), BLOCKS);

    expect(cache.get(keyFor('user-a', '2026-07-27T00:00:00.000Z'))).toBeUndefined();
  });
});

describe('FreeBusyCache — TTL', () => {
  it('serves an entry up to the moment it expires', () => {
    const { cache, advance } = clockedCache();
    cache.set(keyFor(), BLOCKS);

    advance(FREEBUSY_CACHE_TTL_MS - 1);
    expect(cache.get(keyFor())).toEqual(BLOCKS);
  });

  it('drops an entry at the TTL boundary', () => {
    const { cache, advance } = clockedCache();
    cache.set(keyFor(), BLOCKS);

    advance(FREEBUSY_CACHE_TTL_MS);
    expect(cache.get(keyFor())).toBeUndefined();
  });

  it('evicts the expired entry rather than leaving it in the map', () => {
    // A cache that answers "miss" while still holding the entry is a leak
    // that only shows up under the size cap.
    const { cache, advance } = clockedCache();
    cache.set(keyFor(), BLOCKS);
    advance(FREEBUSY_CACHE_TTL_MS);

    cache.get(keyFor());
    expect(cache.size).toBe(0);
  });

  it('refreshes the TTL when a key is re-set', () => {
    const { cache, advance } = clockedCache();
    cache.set(keyFor(), BLOCKS);
    advance(FREEBUSY_CACHE_TTL_MS - 1);
    cache.set(keyFor(), BLOCKS);

    advance(FREEBUSY_CACHE_TTL_MS - 1);
    expect(cache.get(keyFor())).toEqual(BLOCKS);
  });
});

describe('FreeBusyCache — bounded size', () => {
  it('never exceeds maxEntries', () => {
    // `from`/`to` are user-controlled, so a client stepping through a
    // calendar mints a fresh key on every request. Unbounded, this map is a
    // memory leak keyed by request input.
    const { cache } = clockedCache({ maxEntries: 3 });

    for (let i = 0; i < 50; i++) {
      cache.set(keyFor('user-a', `2026-07-${String((i % 28) + 1).padStart(2, '0')}T0${i % 10}:00:00.000Z`), BLOCKS);
    }

    expect(cache.size).toBeLessThanOrEqual(3);
  });

  it('evicts oldest-first', () => {
    const { cache } = clockedCache({ maxEntries: 2 });
    cache.set(keyFor('user-a', '2026-07-01T00:00:00.000Z'), BLOCKS);
    cache.set(keyFor('user-a', '2026-07-02T00:00:00.000Z'), BLOCKS);
    cache.set(keyFor('user-a', '2026-07-03T00:00:00.000Z'), BLOCKS);

    expect(cache.get(keyFor('user-a', '2026-07-01T00:00:00.000Z'))).toBeUndefined();
    expect(cache.get(keyFor('user-a', '2026-07-03T00:00:00.000Z'))).toEqual(BLOCKS);
  });
});

describe('FreeBusyCache — invalidateUser', () => {
  it('drops every entry for one user and leaves others intact', () => {
    const { cache } = clockedCache();
    cache.set(keyFor('user-a', '2026-07-01T00:00:00.000Z'), BLOCKS);
    cache.set(keyFor('user-a', '2026-07-02T00:00:00.000Z'), BLOCKS);
    cache.set(keyFor('user-b', '2026-07-01T00:00:00.000Z'), BLOCKS);

    cache.invalidateUser('user-a');

    expect(cache.get(keyFor('user-a', '2026-07-01T00:00:00.000Z'))).toBeUndefined();
    expect(cache.get(keyFor('user-a', '2026-07-02T00:00:00.000Z'))).toBeUndefined();
    expect(cache.get(keyFor('user-b', '2026-07-01T00:00:00.000Z'))).toEqual(BLOCKS);
  });

  it('does not drop a user whose id is a prefix of another', () => {
    // `user-a` must not match `user-ab`. The separator in the key is what
    // makes this true; without it this test fails.
    const { cache } = clockedCache();
    cache.set(keyFor('user-a'), BLOCKS);
    cache.set(keyFor('user-ab'), BLOCKS);

    cache.invalidateUser('user-a');

    expect(cache.get(keyFor('user-a'))).toBeUndefined();
    expect(cache.get(keyFor('user-ab'))).toEqual(BLOCKS);
  });
});
