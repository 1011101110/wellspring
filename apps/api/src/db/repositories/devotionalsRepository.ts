import type { DevotionalFormat, SlotType, Verse } from '@kairos/shared-contracts';
import type { Queryable, VerifiedUserId } from './types.js';

export type DevotionalStatus =
  'pending' | 'generating' | 'ready' | 'delivered' | 'failed' | 'fixture';

export interface DevotionalRow {
  id: string;
  user_id: string;
  date: string;
  format: DevotionalFormat;
  theme: string;
  verses: Verse[];
  devotional_body: string;
  card_summary: string;
  prayer: string;
  journaling_prompt: string | null;
  action_step: string | null;
  audio_object: string | null;
  status: DevotionalStatus;
  is_fixture_fallback: boolean;
  slot_type: SlotType;
  /**
   * When a Meet-bot finished speaking this devotional into a meeting, or
   * NULL if that has never happened (#221). The durable half of the
   * play-once guard — see `markMeetBotPlayed` and migration
   * 1721900000000.
   */
  meetbot_played_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * One row of the paginated devotional list (L5, issue #241) — the card
 * fields only. Note what is NOT here: `devotional_body`, `prayer`,
 * `verses`, `action_step`. Those are the bulk of a devotional and they
 * belong to `GET /v1/devotionals/:id`, not to a list of themes.
 *
 * `completed_at` is joined in from the linked `sessions` row and is the
 * one field here that is not a `devotionals` column.
 */
export interface DevotionalCardRow {
  id: string;
  date: string;
  theme: string;
  card_summary: string;
  format: DevotionalFormat;
  created_at: Date;
  completed_at: Date | null;
}

/**
 * The sort key `listCardsForUser` pages by — the exact tuple the route
 * encodes into its opaque `nextCursor` and decodes back out of `?cursor=`.
 * See `listCardsForUser` for why all three components are needed.
 */
export interface DevotionalCardCursor {
  date: string;
  createdAt: Date;
  id: string;
}

/**
 * One search hit (issue #242) — a history card plus the relevance score
 * that ordered it.
 *
 * `extends DevotionalCardRow` rather than restating the fields, because
 * issue #236 requires a search result to render *identically* to a
 * history row. Structural reuse is what makes that true by construction
 * instead of by convention: if L5 adds a field to the card, search
 * either carries it too or fails to compile because the SELECT no longer
 * satisfies the type. Two hand-maintained field lists would instead
 * drift silently and surface as a search result that renders subtly
 * differently from the same devotional in the history list.
 */
export interface DevotionalSearchResultRow extends DevotionalCardRow {
  /**
   * `ts_rank` as Postgres' own text rendering of the `real`, not a JS
   * number. It exists only to be handed back as a pagination cursor, and
   * parsing it into a float64 and re-serializing it would risk landing on
   * a different `real` at the page boundary — which is precisely where a
   * keyset comparison must be exact.
   */
  rank: string;
}

/**
 * The `(rank, date, id)` keyset a search cursor decodes to (issue #242).
 *
 * Deliberately a DIFFERENT tuple from `DevotionalCardCursor` above, and
 * the difference is not an inconsistency: the two endpoints sort by
 * different keys, and a keyset cursor must match its query's ORDER BY
 * term for term or it skips and repeats rows. The history list is
 * ordered by recency (`date, created_at, id`); search is ordered by
 * relevance first (`rank, date, id`), because a search result set sorted
 * by date would not be a search result set. Both are base64url-encoded
 * JSON and both are opaque by contract, so a client round-trips either
 * one the same way and never sees the difference.
 */
export interface DevotionalSearchCursor {
  rank: string;
  date: string;
  id: string;
}

/**
 * The devotional search query (issue #242), exported so the index test
 * can `EXPLAIN` the EXACT string this repository executes.
 *
 * Why a shared constant and not a copy in the test: issue #242's
 * acceptance criterion is that the query uses the GIN index, and the
 * only thing that can prove it is a plan for the query we actually run.
 * A test holding its own hand-copied SELECT drifts the moment this one
 * changes — which already nearly happened once, when the `completed_at`
 * lateral join was added during the L5 reconciliation and the test's
 * private copy went on asserting a healthy plan for a query no longer
 * issued anywhere. A green index test for the wrong SQL is worse than
 * no index test, because it reads like proof.
 *
 * Parameters: $1 user_id, $2 query text, $3 cursor rank, $4 cursor date,
 * $5 cursor id, $6 limit.
 */
export const DEVOTIONAL_SEARCH_SQL = `SELECT d.id, d.date, d.theme, d.card_summary, d.format, d.created_at,
              s.completed_at,
              ts_rank(d.search_vector, plainto_tsquery('english', $2))::text AS rank
         FROM devotionals d
         LEFT JOIN LATERAL (
           SELECT completed_at
             FROM sessions
            WHERE devotional_id = d.id
            ORDER BY completed_at DESC NULLS LAST, created_at DESC
            LIMIT 1
         ) s ON true
        WHERE d.user_id = $1
          AND d.search_vector @@ plainto_tsquery('english', $2)
          AND (
                $3::real IS NULL
                OR (ts_rank(d.search_vector, plainto_tsquery('english', $2)), d.date, d.id)
                     < ($3::real, $4::date, $5::uuid)
              )
        ORDER BY ts_rank(d.search_vector, plainto_tsquery('english', $2)) DESC,
                 d.date DESC, d.id DESC
        LIMIT $6`;

export interface CreateDevotionalInput {
  date: string;
  format: DevotionalFormat;
  theme: string;
  verses: Verse[];
  devotionalBody: string;
  cardSummary: string;
  prayer: string;
  journalingPrompt?: string | null;
  actionStep?: string | null;
  isFixtureFallback?: boolean;
  status?: DevotionalStatus;
  /** Defaults to 'standard' at the DB level (COALESCE below) — pass 'examen' for the evening reflection (issue #77). */
  slotType?: SlotType;
}

/**
 * Every method takes `userId: VerifiedUserId` first and every query is
 * scoped `WHERE user_id = $1` — this is the table `GET /v1/devotionals`
 * (history) and the session/join flow read from, so a scoping bug here
 * is a direct cross-user content leak (Foundation §10 IDOR risk).
 */
export class DevotionalsRepository {
  constructor(private readonly db: Queryable) {}

  async create(userId: VerifiedUserId, input: CreateDevotionalInput): Promise<DevotionalRow> {
    const result = await this.db.query<DevotionalRow>(
      `INSERT INTO devotionals
         (user_id, date, format, theme, verses, devotional_body, card_summary, prayer,
          journaling_prompt, action_step, is_fixture_fallback, status, slot_type)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, COALESCE($11::boolean, false), COALESCE($12::devotional_status, 'pending'), COALESCE($13::text, 'standard'))
       RETURNING *`,
      [
        userId,
        input.date,
        input.format,
        input.theme,
        JSON.stringify(input.verses),
        input.devotionalBody,
        input.cardSummary,
        input.prayer,
        input.journalingPrompt ?? null,
        input.actionStep ?? null,
        input.isFixtureFallback ?? null,
        input.status ?? null,
        input.slotType ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('create: insert returned no row');
    return row;
  }

  async getById(userId: VerifiedUserId, devotionalId: string): Promise<DevotionalRow | null> {
    const result = await this.db.query<DevotionalRow>(
      `SELECT * FROM devotionals WHERE user_id = $1 AND id = $2`,
      [userId, devotionalId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Resolves the owner of a devotional WITHOUT a `user_id` scope — the one
   * deliberate exception to this class's "every query is scoped
   * `WHERE user_id = $1`" rule (see the class docstring), added for #217.
   *
   * Why the exception is safe and necessary here: the sole caller is the
   * Cloud-Tasks-triggered Meet-bot consent gate
   * (services/meetBot/meetBotConsentGate.ts). That caller has a
   * `devotionalId` from a task body and no user identity at all, and it
   * needs the *authoritative* owner in order to decide whether to REFUSE
   * an action. Taking the userId from the task body instead would mean the
   * gate checks consent for whichever user the body names — which is
   * precisely the "userId from the request body" pattern Foundation §10
   * forbids, and here it would let a wrong/stale body point the gate at
   * some other still-connected user and wave the bot through.
   *
   * The projection is `user_id` only: no devotional content ever crosses
   * this boundary (Foundation §8 data minimization), so it cannot become a
   * cross-user content leak the way an unscoped `SELECT *` could.
   *
   * A `null` return means the row is gone. Because `devotionals.user_id`
   * is `ON DELETE CASCADE` from `users` (see `UsersRepository.hardDelete`),
   * a deleted account takes its devotionals with it — so `null` is exactly
   * the signal the gate needs for the account-deletion half of #217, and
   * the gate treats it as a refusal, never as "proceed".
   */
  async findOwnerUserId(devotionalId: string): Promise<string | null> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM devotionals WHERE id = $1`,
      [devotionalId],
    );
    return result.rows[0]?.user_id ?? null;
  }

  /**
   * The durable play-once guard for the Meet-bot audio websocket (#221).
   *
   * Like `findOwnerUserId` above, these two methods are deliberately NOT
   * scoped `WHERE user_id = $1`, and for the same reason: their sole
   * caller (routes/meetBotAudio.ts) is a third-party websocket connection
   * that carries a `devotionalId` and no user identity whatsoever. It has
   * nobody's id to scope by, and scoping by an id supplied on that
   * connection would be exactly the Foundation §10 anti-pattern
   * `findOwnerUserId`'s docstring spells out. Consent for that connection
   * is established separately and authoritatively by
   * `checkMeetBotConsent`, which resolves the owner server-side.
   *
   * Both projections are minimal — a boolean and a row count. No
   * devotional content crosses this boundary (Foundation §8 data
   * minimization), so an id guessed or leaked here reveals only whether
   * some devotional has already been played, never what it says.
   *
   * `hasMeetBotPlayed` returns `false` for a devotional that does not
   * exist. That is not a fail-open: a missing row is refused far earlier
   * by the consent gate (`devotional_not_found`), which runs first, so
   * this method is only ever reached for a devotional that exists and
   * whose owner has just been confirmed to consent.
   */
  async hasMeetBotPlayed(devotionalId: string): Promise<boolean> {
    const result = await this.db.query<{ played: boolean }>(
      `SELECT meetbot_played_at IS NOT NULL AS played FROM devotionals WHERE id = $1`,
      [devotionalId],
    );
    return result.rows[0]?.played ?? false;
  }

  /**
   * Records that a Meet-bot finished speaking this devotional.
   *
   * `WHERE meetbot_played_at IS NULL` makes this write idempotent and
   * preserves the FIRST play's timestamp rather than the latest. That
   * matters for the audit question this column answers — "when did a bot
   * first speak in this person's meeting" — which a last-writer-wins
   * `SET meetbot_played_at = now()` would quietly overwrite if two
   * connections ever raced to the finish line.
   */
  async markMeetBotPlayed(devotionalId: string): Promise<void> {
    await this.db.query(
      `UPDATE devotionals SET meetbot_played_at = now(), updated_at = now()
        WHERE id = $1 AND meetbot_played_at IS NULL`,
      [devotionalId],
    );
  }

  /**
   * `slotType` defaults to 'standard' — the ordinary morning idempotency
   * check. generateNowOrchestrator passes 'examen' explicitly for the
   * evening path so a same-day examen is never mistaken for "already
   * generated today" (issue #77) — before this param existed, a single
   * date-only lookup here meant a second same-day devotional of any kind
   * would be incorrectly skipped as a duplicate.
   */
  async getForDate(
    userId: VerifiedUserId,
    date: string,
    slotType: SlotType = 'standard',
  ): Promise<DevotionalRow | null> {
    const result = await this.db.query<DevotionalRow>(
      `SELECT * FROM devotionals WHERE user_id = $1 AND date = $2 AND slot_type = $3 ORDER BY created_at DESC LIMIT 1`,
      [userId, date, slotType],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The most recent standard-slot devotional themes, newest first (P7
   * #326's anti-rut input): the steering engine checks how many
   * *consecutive* recent devotionals already carry a candidate theme
   * before steering to it again. Standard slot only — the examen is a
   * different practice, and its theme should neither extend nor break a
   * morning-devotional run. `created_at DESC` as the same-date tiebreak,
   * matching `getForDate`'s "latest row wins" convention.
   */
  async listRecentThemes(userId: VerifiedUserId, limit: number): Promise<string[]> {
    const result = await this.db.query<{ theme: string }>(
      `SELECT theme FROM devotionals
       WHERE user_id = $1 AND slot_type = 'standard'
       ORDER BY date DESC, created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((r) => r.theme);
  }

  /** History list — Architecture §API `GET /v1/devotionals`. */
  async listForUser(
    userId: VerifiedUserId,
    opts: { limit?: number; before?: string } = {},
  ): Promise<DevotionalRow[]> {
    const limit = opts.limit ?? 30;
    const result = await this.db.query<DevotionalRow>(
      `SELECT * FROM devotionals
       WHERE user_id = $1 AND ($2::date IS NULL OR date < $2::date)
       ORDER BY date DESC
       LIMIT $3`,
      [userId, opts.before ?? null, limit],
    );
    return result.rows;
  }

  /**
   * Cursor-paginated devotional list, newest first (L5, issue #241).
   *
   * ## Why this exists next to `listForUser` rather than replacing it
   *
   * `listForUser` does `SELECT *`, which includes `devotional_body`,
   * `prayer`, and `verses`. #241: "a year of daily devotionals is ~365
   * rows nobody should fetch at once", and the body is the overwhelming
   * majority of each row's bytes. This method projects only what a list
   * row renders, so the list endpoint's payload no longer scales with the
   * length of the devotionals it is listing. `listForUser` is left intact
   * because other callers (and the `before`/`limit` shape) still use it.
   *
   * ## Why the cursor is (date, created_at, id) and not just `date`
   *
   * `devotionals` is NOT unique on `(user_id, date)` — a user with the
   * examen enabled holds both a `standard` and an `examen` row for the
   * same date (issue #77). A `WHERE date < $cursor` pager would therefore
   * either skip the second same-date row or, with `<=`, repeat the first
   * one forever. The row-value comparison below (`(a, b, c) < (x, y, z)`,
   * Postgres's lexicographic tuple compare) advances past exactly the rows
   * already emitted, because the tuple is unique (`id` is a primary key)
   * and matches the ORDER BY term for term. `id` also breaks the tie in
   * the sub-millisecond case where two rows share a `created_at`.
   *
   * ## Completion state
   *
   * A `LEFT JOIN LATERAL` rather than a plain join: a devotional can have
   * more than one session row, and a plain join would multiply the
   * devotional into several list rows — which would break pagination
   * counting as well as the display. The lateral picks one, preferring a
   * completed session (`completed_at DESC NULLS LAST`), so a devotional
   * the user finished reads as completed even if a later, abandoned
   * session exists for it. `LEFT` so a devotional with no session at all
   * still appears, with `completed_at` null.
   */
  async listCardsForUser(
    userId: VerifiedUserId,
    opts: { limit: number; cursor?: DevotionalCardCursor | null },
  ): Promise<DevotionalCardRow[]> {
    const cursor = opts.cursor ?? null;
    const result = await this.db.query<DevotionalCardRow>(
      `SELECT d.id, d.date, d.theme, d.card_summary, d.format, d.created_at,
              s.completed_at
         FROM devotionals d
         LEFT JOIN LATERAL (
           SELECT completed_at
             FROM sessions
            WHERE devotional_id = d.id
            ORDER BY completed_at DESC NULLS LAST, created_at DESC
            LIMIT 1
         ) s ON true
        WHERE d.user_id = $1
          AND (
            $2::date IS NULL
            OR (d.date, d.created_at, d.id) < ($2::date, $3::timestamptz, $4::uuid)
          )
        ORDER BY d.date DESC, d.created_at DESC, d.id DESC
        LIMIT $5`,
      [userId, cursor?.date ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, opts.limit],
    );
    return result.rows;
  }

  /**
   * Full-text search across the caller's OWN devotionals (issue #242,
   * Epic L #236) — "there was one about rest, a few weeks ago".
   *
   * ## Owner scoping
   *
   * `WHERE user_id = $1` is load-bearing here in a way it is not on a
   * by-id lookup. A search matches on *content*, and the word a person
   * searches for ("rest") is overwhelmingly likely to appear in other
   * users' devotionals too — the same themes recur across the whole
   * table by design. So an unscoped or wrongly-scoped query here does
   * not fail closed the way a bad id lookup does (404, nothing leaked);
   * it fails wide open, returning strangers' devotional summaries that
   * look exactly like the caller's own. `requireAuth` on the route does
   * not help with this at all — it proves *who* is asking, not *whose
   * rows* come back. This is the single riskiest query in this class
   * (Foundation §10), which is why it is covered by a dedicated
   * cross-user test seeded so a single query matches both users' rows.
   *
   * ## Ranking
   *
   * `ts_rank` descending, then `date` descending as the tie-break, per
   * issue #242 ("rank by relevance, tie-break recency"). The field
   * weights that make relevance meaningful live in the generated
   * `search_vector` column, not here — see migration 1722000000000 for
   * why theme and Scripture reference outweigh the body.
   *
   * `id` is the final tie-break. It contributes nothing to relevance and
   * exists only to make the sort a TOTAL order: two devotionals can
   * genuinely share both a rank and a date (the standard and examen
   * slots of the same day, for instance), and without a unique last key
   * their relative order is undefined between queries. That would let
   * keyset pagination skip or repeat a row at the page boundary.
   *
   * ## Pagination
   *
   * Keyset (cursor), not OFFSET. Two reasons: OFFSET makes the database
   * compute and discard every preceding row on each page, and — more
   * importantly here — it silently drops or duplicates rows when the
   * underlying set shifts between requests, which for a devotional
   * history it does daily.
   *
   * The cursor is the previous page's last `(rank, date, id)` triple,
   * applied as a row-value comparison. `rank` crosses the wire as the
   * database's own text representation of the value and is cast back to
   * `real` here rather than being round-tripped through a JS number, so
   * the boundary comparison is done on exactly the value Postgres
   * produced. See `encodeSearchCursor` in routes/devotionalSearch.ts.
   *
   * ## Projection
   *
   * Exactly `DevotionalCardRow` plus `rank` — never `devotional_body` or
   * `prayer`. Issue #236 requires a search result to render identically
   * to a history row, so this returns the identical projection
   * `listCardsForUser` does, including the `completed_at` lateral join,
   * rather than a subset of it.
   *
   * That join is the difference between "not completed" and "we did not
   * ask". Omitting it would leave the client with no completion state
   * for a search result, and the two available readings are both bad:
   * render a "not completed" badge (a false statement about the user's
   * own history — exactly the small lie Epic L's ground rules forbid) or
   * carry a third "unknown" state through the card component purely
   * because one of its two data sources is impoverished. Joining it
   * costs one indexed lateral per row on a page of at most
   * `MAX_LIMIT` rows, bounded by page size rather than by history
   * length, and it runs only on rows the GIN index has already matched.
   *
   * The body is still excluded: shipping it would mean sending kilobytes
   * per row of the user's most personal content to populate a list that
   * never displays it (Foundation §8 data minimization).
   */
  async searchForUser(
    userId: VerifiedUserId,
    query: string,
    opts: { limit?: number; cursor?: DevotionalSearchCursor | null } = {},
  ): Promise<DevotionalSearchResultRow[]> {
    const limit = opts.limit ?? 20;
    const cursor = opts.cursor ?? null;

    // `plainto_tsquery` (not `to_tsquery`) is what makes raw user input
    // safe to interpret as a query at all: it treats the string as plain
    // words and AND-joins them, so punctuation and operator characters
    // (`&`, `|`, `!`, `:*`, unbalanced parens) are data rather than
    // syntax. `to_tsquery` would raise a syntax error on a search for
    // something as ordinary as "rest & renewal" — turning a user's typo
    // into a 500. It also matches issue #242's "no field operators"
    // scope directly.
    //
    // Repeated verbatim in the SELECT and the WHERE rather than joined
    // in as a FROM-clause alias: it is IMMUTABLE, so Postgres folds the
    // two into one evaluation, and keeping the `search_vector @@
    // plainto_tsquery(...)` predicate written plainly in the WHERE is
    // what lets the planner match it to the GIN index. Confirmed by
    // EXPLAIN (issue #242 acceptance): Bitmap Index Scan on
    // devotionals_user_search_vector_idx with BOTH user_id and the @@
    // predicate as Index Cond.
    const result = await this.db.query<DevotionalSearchResultRow>(
      DEVOTIONAL_SEARCH_SQL,
      [userId, query, cursor?.rank ?? null, cursor?.date ?? null, cursor?.id ?? null, limit],
    );
    return result.rows;
  }

  /** Monthly recap support (docs/14 §5.9, issue #96): every devotional in `[startDate, endDate]` (inclusive), oldest first, for recurring-passage detection. */
  async listForUserInRange(
    userId: VerifiedUserId,
    startDate: string,
    endDate: string,
  ): Promise<DevotionalRow[]> {
    const result = await this.db.query<DevotionalRow>(
      `SELECT * FROM devotionals WHERE user_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC`,
      [userId, startDate, endDate],
    );
    return result.rows;
  }

  async updateStatus(
    userId: VerifiedUserId,
    devotionalId: string,
    status: DevotionalStatus,
  ): Promise<DevotionalRow | null> {
    const result = await this.db.query<DevotionalRow>(
      `UPDATE devotionals SET status = $3, updated_at = now()
       WHERE user_id = $1 AND id = $2
       RETURNING *`,
      [userId, devotionalId, status],
    );
    return result.rows[0] ?? null;
  }

  async setAudioObject(
    userId: VerifiedUserId,
    devotionalId: string,
    audioObject: string,
  ): Promise<DevotionalRow | null> {
    const result = await this.db.query<DevotionalRow>(
      `UPDATE devotionals SET audio_object = $3, updated_at = now()
       WHERE user_id = $1 AND id = $2
       RETURNING *`,
      [userId, devotionalId, audioObject],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Retention job support (Privacy §retention: "devotional audio 14
   * days" — reconciled to match the GCS bucket's own 14-day lifecycle
   * rule, docs/06 §1.4; issue #82): finds every devotional across ALL users with a non-null
   * `audio_object` created before `cutoff`. Deliberately unscoped by
   * userId, like `SessionsRepository.purgeExpiredBefore` /
   * `DailyBandsRepository.purgeOlderThan` — a retention sweep is a global
   * job, not a per-user query, so there is no `userId` to scope by here.
   * Only ever called from the purge job (services/retention/*), never
   * from a request handler.
   */
  async findWithAudioOlderThan(
    cutoff: Date,
  ): Promise<Pick<DevotionalRow, 'id' | 'audio_object'>[]> {
    const result = await this.db.query<Pick<DevotionalRow, 'id' | 'audio_object'>>(
      `SELECT id, audio_object FROM devotionals WHERE audio_object IS NOT NULL AND created_at < $1`,
      [cutoff],
    );
    return result.rows;
  }

  /**
   * Nulls the audio_object reference after the underlying file has been
   * deleted from storage (Privacy §retention). Unscoped for the same
   * reason as `findWithAudioOlderThan` — the job already knows the exact
   * devotional id, no userId available/needed at this call site.
   */
  async clearAudioObject(devotionalId: string): Promise<void> {
    await this.db.query(
      `UPDATE devotionals SET audio_object = NULL, updated_at = now() WHERE id = $1`,
      [devotionalId],
    );
  }

  /**
   * Retention job support: every devotional row (any user) with a
   * non-null audio_object, regardless of age — used by account hard-delete
   * to find audio files to remove before/alongside the DB cascade delete
   * (the FK cascade removes the row, but not the file on disk/GCS).
   */
  async listWithAudioForUser(userId: VerifiedUserId): Promise<Pick<DevotionalRow, 'id'>[]> {
    const result = await this.db.query<Pick<DevotionalRow, 'id'>>(
      `SELECT id FROM devotionals WHERE user_id = $1 AND audio_object IS NOT NULL`,
      [userId],
    );
    return result.rows;
  }
}
