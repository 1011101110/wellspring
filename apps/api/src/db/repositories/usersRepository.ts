import {
  TIMEZONE_SOURCE_RANK,
  type LanguageTag,
  type Tradition,
  type TimezoneSource,
} from '@kairos/shared-contracts';
import type { Queryable, VerifiedUserId } from './types.js';

export interface UserRow {
  id: string;
  firebase_uid: string;
  /**
   * Nullable (migration 1720100000000, docs/14 §2.12 / issue #69): some
   * verified Firebase ID tokens (e.g. Sign in with Apple's "Hide My
   * Email" in certain relay configurations) carry no `email` claim at
   * all. Rather than fabricate a placeholder, the provisioning path
   * stores `null` — callers must not assume this is always populated.
   */
  email: string | null;
  tradition: Tradition;
  translation_id: number;
  /**
   * Devotional content language (migration 1722300000000, Epic O #311 /
   * story #314): a BCP-47 primary subtag, default `'en'`. Kept consistent
   * with `translation_id` by the preferences route's cross-field rule
   * (a language write snaps the translation to that language's default;
   * an out-of-catalog pair is a 400) — writers must go through that door,
   * not call `updateProfile` with an unvalidated pair.
   */
  language: LanguageTag;
  timezone: string;
  /**
   * Which writer last set `timezone` (migration 1721400000000, issue
   * #187). Ordered `user` > `calendar` > `device` > `default`; see
   * `TimezoneSourceSchema` in shared-contracts. Never write this column
   * directly — go through `adoptTimezone`, which is where the precedence
   * check lives.
   */
  timezone_source: TimezoneSource;
  /**
   * When this user finished onboarding, or `null` if they never have
   * (migration 1721800000000, issue #225). Server-side truth for a fact
   * that used to live only in one device's `UserDefaults`, which made
   * "onboard on web, open iOS" show onboarding a second time.
   *
   * Write only through `markOnboarded` — it is first-write-wins, and that
   * property is what keeps the timestamp meaning "when they finished"
   * rather than "when they last opened the app".
   */
  onboarded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserInput {
  firebaseUid: string;
  /** Optional — see `UserRow.email` doc. */
  email?: string | null;
  tradition?: Tradition;
  translationId?: number;
  timezone?: string;
}

/**
 * `users` is the one table not scoped by `WHERE user_id = $1` (it IS the
 * identity table) — instead every read/write here is scoped by
 * `firebase_uid` (the verified-token identity) or by the row's own `id`
 * once the caller already holds a VerifiedUserId for it. There is no
 * "get all users" or "get by email" method — email must never be used
 * as a lookup key from request-supplied input (Foundation §8/§10).
 */
export class UsersRepository {
  constructor(private readonly db: Queryable) {}

  async createUser(input: CreateUserInput): Promise<UserRow> {
    const result = await this.db.query<UserRow>(
      `INSERT INTO users (firebase_uid, email, tradition, translation_id, timezone)
       VALUES ($1, $2, COALESCE($3::tradition, 'general'), COALESCE($4::integer, 3034), COALESCE($5::text, 'UTC'))
       RETURNING *`,
      [
        input.firebaseUid,
        input.email ?? null,
        input.tradition ?? null,
        input.translationId ?? null,
        input.timezone ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('createUser: insert returned no row');
    return row;
  }

  /** Identity lookup — the one place a Firebase UID is trusted as a query key. */
  async findByFirebaseUid(firebaseUid: string): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE firebase_uid = $1`,
      [firebaseUid],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Resolves the `users.id` for a verified Firebase UID, provisioning a
   * new row on first sight (issue #69, docs/14 §1.7). This is the ONLY
   * place `firebase_uid` is turned into a `users.id` for the auth
   * middleware's `VerifiedUserId` — every other repository method takes
   * that already-resolved id, never the raw Firebase UID.
   *
   * Concurrency: two near-simultaneous first requests from the same new
   * user (e.g. two app-launch calls racing) could both miss on the
   * initial `findByFirebaseUid` and both attempt to INSERT; the unique
   * constraint on `firebase_uid` (migration 1720000000000) makes the
   * loser's INSERT fail with pg `23505`, which is caught here and
   * resolved by re-reading the row the winner created — so this method
   * always returns a single consistent row per Firebase UID even under a
   * race, never a duplicate.
   */
  async findOrCreateByFirebaseUid(firebaseUid: string, email?: string | null): Promise<UserRow> {
    const existing = await this.findByFirebaseUid(firebaseUid);
    if (existing) return existing;

    try {
      return await this.createUser({ firebaseUid, email: email ?? null });
    } catch (err) {
      const pgCode = (err as { code?: string } | undefined)?.code;
      if (pgCode === '23505') {
        // Lost the create race — the winner's row now exists; read it.
        const winner = await this.findByFirebaseUid(firebaseUid);
        if (winner) return winner;
      }
      throw err;
    }
  }

  /** Self-lookup by an already-verified userId — still scoped, just to a single row by primary key. */
  async findById(userId: VerifiedUserId): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * `timezone` is deliberately NOT updatable here (issue #187) — it used
   * to be, and that is precisely the hole this split closes. Every zone
   * write has to answer "does this source outrank what's stored?", so
   * routing all of them through `adoptTimezone` below makes the
   * precedence rule unbypassable rather than something each new call site
   * has to remember.
   */
  async updateProfile(
    userId: VerifiedUserId,
    updates: Partial<Pick<UserRow, 'tradition' | 'translation_id' | 'language'>>,
  ): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      `UPDATE users
       SET tradition = COALESCE($2::tradition, tradition),
           translation_id = COALESCE($3::integer, translation_id),
           language = COALESCE($4::text, language),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [userId, updates.tradition ?? null, updates.translation_id ?? null, updates.language ?? null],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Records that this user finished onboarding, once (issue #225).
   *
   * **First write wins, and there is deliberately no un-mark.** Two
   * properties fall out of that, both load-bearing:
   *
   *  1. The stored instant keeps meaning "when they finished". A client
   *     re-asserting completion on every sign-in (which iOS does, because
   *     its local latch pushes up whenever the server has no timestamp —
   *     see `OnboardingCompletionStore`) must not walk the value forward
   *     to today on every launch; the `WHERE onboarded_at IS NULL` clause
   *     is what prevents that. It also keeps a fleet of launches from
   *     bumping `updated_at` on rows that have nothing to say, the same
   *     concern `adoptTimezone` handles with its `IS DISTINCT FROM`.
   *  2. No client can reset it. Onboarding completion is monotonic by
   *     nature — a person who has done onboarding cannot subsequently
   *     un-do it — so the repository refuses to represent the transition
   *     rather than trusting every present and future caller not to
   *     request it. A user who genuinely wants to start over deletes
   *     their account (`hardDelete`), which is visible and deliberate.
   *
   * Idempotent: safe to call on every sign-in. Returns the row when this
   * call is the one that set the timestamp, and `null` when it was already
   * set. Callers that need the effective value regardless (the
   * preferences route does) should `findById` rather than read this
   * return, since `null` here is the *normal* steady-state answer and
   * means "already onboarded", not "failed".
   */
  async markOnboarded(userId: VerifiedUserId): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      `UPDATE users
          SET onboarded_at = now(),
              updated_at = now()
        WHERE id = $1
          AND onboarded_at IS NULL
        RETURNING *`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Writes `timezone`/`timezone_source` only if `source` outranks (or
   * equals) the source already stored — K1 (#187), migration
   * 1721400000000.
   *
   * The comparison is IN the UPDATE's WHERE clause, not a read-then-write
   * in TypeScript, so it is atomic. That matters here more than it looks:
   * the daily run (calendar) and a preferences sync from a just-woken
   * phone (device) genuinely can land on the same user within
   * milliseconds of each other, and a read-modify-write would let the
   * lower-ranked one win by finishing second. The `CASE` ladder is built
   * from `TIMEZONE_SOURCE_RANK` rather than hand-written so the SQL and
   * the application can never disagree about the ordering.
   *
   * Returns the updated row, or `null` when nothing was written. `null`
   * deliberately conflates two harmless cases — "outranked" and "already
   * exactly this value/source" — because no caller needs to act
   * differently: both mean the stored value stands. (The second case is
   * why the WHERE also checks `IS DISTINCT FROM`: it keeps a daily run
   * over a fleet of unchanged users from bumping `updated_at` on every
   * row, every day.)
   *
   * Callers must validate `timezone` with `isValidIanaTimeZone` first.
   * This method does not, because it cannot fail usefully — a repository
   * throwing on a bad zone would just move the decision to a worse place;
   * the doors (route schema, calendar refresh) reject junk before it gets
   * this far.
   */
  async adoptTimezone(
    userId: VerifiedUserId,
    timezone: string,
    source: TimezoneSource,
  ): Promise<UserRow | null> {
    const storedRank = Object.entries(TIMEZONE_SOURCE_RANK)
      .map(([name, rank]) => `WHEN '${name}' THEN ${rank}`)
      .join(' ');

    const result = await this.db.query<UserRow>(
      `UPDATE users
          SET timezone = $2::text,
              timezone_source = $3::text,
              updated_at = now()
        WHERE id = $1
          AND $4::int >= (CASE timezone_source ${storedRank} ELSE 0 END)
          AND (timezone IS DISTINCT FROM $2::text OR timezone_source IS DISTINCT FROM $3::text)
        RETURNING *`,
      [userId, timezone, source, TIMEZONE_SOURCE_RANK[source]],
    );
    return result.rows[0] ?? null;
  }

  /** Hard delete per Privacy §account-deletion — cascades to every other table via FK ON DELETE CASCADE. */
  async hardDelete(userId: VerifiedUserId): Promise<void> {
    await this.db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }

  /**
   * Returns all users who have an active Google Calendar connection — used
   * by Cloud Scheduler's daily batch to build the per-user generate-now
   * queue (issue #22 C1, docs/03 §8.3).
   *
   * `timezone` is included alongside `id`/`email` (docs/14 §5.6, issue #94)
   * so the daily-run loop can resolve "is today this user's sabbath_day"
   * in their own local time rather than the server's — still a narrow,
   * task-scoped projection (Foundation §8), not a general "get all users"
   * method.
   */
  async listWithActiveGoogleCalendar(): Promise<Array<{ id: string; email: string | null; timezone: string }>> {
    const result = await this.db.query<{ id: string; email: string | null; timezone: string }>(
      `SELECT u.id, u.email, u.timezone
       FROM users u
       JOIN connections c ON c.user_id = u.id
       WHERE c.provider = 'google_calendar'
         AND c.status = 'active'`,
    );
    return result.rows;
  }

  /**
   * Ids of users whose time zone nobody has ever set (`timezone_source =
   * 'default'`, i.e. still on the `'UTC'` column default) but who DO have
   * an active Google Calendar connection — the exact population
   * `POST /internal/backfill-timezones` can actually fix (issue #187).
   *
   * The calendar join is not incidental: a connected calendar is the only
   * zone signal that exists server-side. Users with no calendar and no
   * device sync yet are unreachable from the backend by construction, and
   * are covered instead by the device zone riding along on their next
   * preferences sync — which is why #187 asks for both halves and not
   * just this one.
   *
   * Ids only, same "minimum data for the task" narrowing as
   * `listWithActiveGoogleCalendar` above.
   */
  async listAwaitingCalendarTimezone(): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN connections c ON c.user_id = u.id
        WHERE u.timezone_source = 'default'
          AND c.provider = 'google_calendar'
          AND c.status = 'active'`,
    );
    return result.rows.map((row) => row.id);
  }

  /**
   * Returns every user's id — the `listAllUserIds` lister `runAllPurgeJobs`
   * (purgeJobs.ts) needs to sweep `daily_bands` across all users (issue
   * #82). Ids only, same "minimum data for the task" narrowing as
   * `listWithActiveGoogleCalendar` — this is not a general "get all users"
   * method and must not be reused for anything that needs email or other
   * PII.
   */
  async listAllIds(): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(`SELECT id FROM users`);
    return result.rows.map((row) => row.id);
  }
}
