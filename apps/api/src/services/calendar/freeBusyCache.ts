/**
 * Short-lived in-process cache for `GET /v1/calendar/freebusy` (M1, #255).
 *
 * ## Why cache at all
 *
 * #255 M1 asks for the endpoint to be "range-limited, consent-gated,
 * cached", and the access pattern earns it: a day/week/month toggle
 * re-requests heavily overlapping ranges as the user flips between views
 * and steps back and forth through them. Each miss is a live Google
 * round-trip on the user's request path, and Google meters requests at 600
 * per user per minute (see `FREEBUSY_MAX_RANGE_DAYS` for sources). Toggling
 * is exactly the behaviour that turns one glance at a calendar into a dozen
 * identical upstream calls.
 *
 * ## Why this is only ever a latency optimization
 *
 * Cloud Run runs multiple instances and this map lives in one of them. Two
 * requests from the same user land wherever the load balancer sends them,
 * so a hit is luck and a miss is normal. Nothing may depend on a hit:
 * correctness comes from the read-through path, and this layer only ever
 * removes work. That is a deliberate ceiling on the design, not a
 * shortcoming to fix later with a shared cache — a Redis or Postgres cache
 * would make busy blocks *durable*, and Foundation §8 forbids persisting
 * them at all. The only cache this feature is permitted to have is one that
 * dies with the process, so in-process is not a compromise, it is the whole
 * available design space.
 *
 * ## Revocation safety — the structural argument
 *
 * The stated hazard is a user who disconnects and keeps seeing cached busy
 * times. This cache cannot produce that outcome, and not because of its
 * TTL:
 *
 *   **The consent and connection gates run BEFORE the cache is consulted.**
 *
 * The route resolves `calendar_enabled` and the `google_calendar`
 * connection row from the database on every single request, and returns
 * `consent_disabled` / `not_connected` without ever reaching this module.
 * A revoked user's entry may well still be sitting in the map — it is
 * simply unreachable, because the only code path that reads it is one they
 * can no longer traverse. The entry then expires on its own and is never
 * served to anyone (keys are per-user, so no one else can reach it either).
 *
 * That ordering is what makes an invalidation hook in
 * `revokeGoogleConnection` unnecessary rather than merely omitted. It is
 * also the more robust arrangement: a hook has to be remembered at every
 * future revocation site and races a request already in flight, whereas
 * gate-before-cache is inherited automatically by any caller and is
 * evaluated inside the request that would serve the stale data. This is the
 * same reasoning #217 applied when it chose fire-time gating over
 * dequeue-on-revoke (`meetBotConsentGate.ts`).
 *
 * The TTL therefore covers a different risk entirely: staleness of the
 * user's *own* calendar. A meeting accepted a moment ago should appear
 * quickly. 60 seconds keeps a toggle session coherent while keeping the
 * calendar visibly live.
 */

/** How long an entry may be served. See the module doc: bounds staleness, not revocation. */
export const FREEBUSY_CACHE_TTL_MS = 60_000;

/**
 * Hard ceiling on retained entries.
 *
 * Unbounded, this map is a memory leak keyed by user-controlled input:
 * `from`/`to` are free-form instants, so a client stepping through a
 * calendar mints a fresh key every time and nothing would ever evict them.
 * On eviction the oldest insertion goes first (`Map` preserves insertion
 * order), which for this access pattern is a reasonable LRU approximation —
 * and being wrong about which entry to drop costs one extra upstream call,
 * never a wrong answer.
 */
export const FREEBUSY_CACHE_MAX_ENTRIES = 500;

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

export interface FreeBusyCacheKey {
  userId: string;
  timeMin: string;
  timeMax: string;
}

export class FreeBusyCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? FREEBUSY_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? FREEBUSY_CACHE_MAX_ENTRIES;
    // Injected clock so TTL expiry is tested by advancing a number rather
    // than by sleeping — a real timer would make the suite slow and flaky
    // for no added evidence.
    this.now = options.now ?? Date.now;
  }

  /**
   * `userId` leads the key so one user's entries can never be served to
   * another even if the range strings collide — which they routinely will,
   * since every client asking for "this week" computes the same bounds.
   * The separator is a character that cannot occur in a UUID or an ISO
   * instant, so two different keys cannot serialize to the same string.
   */
  private static serialize(key: FreeBusyCacheKey): string {
    return `${key.userId}|${key.timeMin}|${key.timeMax}`;
  }

  get(key: FreeBusyCacheKey): T | undefined {
    const serialized = FreeBusyCache.serialize(key);
    const entry = this.entries.get(serialized);
    if (!entry) return undefined;

    if (entry.expiresAtMs <= this.now()) {
      // Drop on read rather than leaving it to the size cap: an expired
      // entry is dead weight, and deleting it here means a re-set moves the
      // key to the back of the insertion order where the eviction policy
      // expects fresh entries to be.
      this.entries.delete(serialized);
      return undefined;
    }

    return entry.value;
  }

  set(key: FreeBusyCacheKey, value: T): void {
    const serialized = FreeBusyCache.serialize(key);
    // Delete-then-set so an overwrite refreshes insertion order too.
    this.entries.delete(serialized);
    this.entries.set(serialized, { value, expiresAtMs: this.now() + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Drops every entry for one user.
   *
   * Not required for revocation safety — the gates make a revoked user's
   * entries unreachable regardless (see the module doc). Exposed because
   * "prove the cache can be emptied" is a cheap property for a test to
   * assert directly, and because a future caller that needs to force a cold
   * read should not have to reach into the map.
   */
  invalidateUser(userId: string): void {
    const prefix = `${userId}|`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Entry count, for tests and for any future size metric. */
  get size(): number {
    return this.entries.size;
  }
}
