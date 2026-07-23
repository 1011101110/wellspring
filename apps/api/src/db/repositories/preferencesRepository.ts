import type { DevotionalFormat } from '@kairos/shared-contracts';
import type { Queryable, VerifiedUserId } from './types.js';

export interface PreferencesRow {
  user_id: string;
  window_start_local: string;
  window_end_local: string;
  active_days: number[];
  cadence: string;
  /**
   * NULL means "auto" — let the band heuristic pick the length (issue #202,
   * migration 1721500000000). The `devotional_format` enum has no `auto`
   * member, so nullability is how that choice is represented.
   */
  duration_preference: DevotionalFormat | null;
  voice: string;
  stillness: string;
  lectio: boolean;
  calendar_enabled: boolean;
  health_enabled: boolean;
  communication_enabled: boolean;
  notify_on_skip: boolean;
  examen_enabled: boolean;
  sabbath_day: number;
  sabbath_enabled: boolean;
  sabbath_session: boolean;
  liturgical_seasons_enabled: boolean;
  /**
   * Adaptive rhythm (Epic P #312 / P5 #324, migration 1722500000000).
   * `min_per_week`/`adaptive_enabled` are user-owned; the three
   * `adaptive_*` columns are the cadence engine's own state and are
   * server-written only — see `updateAdaptiveState` below and the
   * migration comment for the ownership split.
   */
  min_per_week: number;
  adaptive_enabled: boolean;
  /** NULL = never adapted; the policy treats that as the ceiling (`|active_days|`). */
  adaptive_days_per_week: number | null;
  /** Last decision's reason code — the `CadenceReason` union (cadencePolicy.ts), CHECK-constrained in the DB. */
  adaptive_reason: string | null;
  /** When the adaptive state last CHANGED (steps/clamps only, never holds) — the one-step-per-week limiter's clock. */
  adaptive_decided_at: Date | null;
  updated_at: Date;
}

/**
 * The client-writable field set. The `adaptive_*` state columns are
 * excluded at the type level, not just by convention: `update` below is
 * the path `PUT /v1/preferences` reaches, and a request body must never
 * be able to move the engine's ladder position or reset its rate
 * limiter. `updateAdaptiveState` is the state columns' only door.
 */
export type PreferencesUpdate = Partial<
  Omit<
    PreferencesRow,
    'user_id' | 'updated_at' | 'adaptive_days_per_week' | 'adaptive_reason' | 'adaptive_decided_at'
  >
>;

/**
 * One daily-run row per user: the K2 day gate (`active_days`) plus every
 * input the P5 cadence engine reads (P6, issue #325). Snake_case, exactly
 * the column names — the route maps this onto `CadencePolicyPrefs`
 * (cadencePolicy.ts) at the call site.
 */
export interface DailyRunCadenceRow {
  user_id: string;
  active_days: number[];
  min_per_week: number;
  adaptive_enabled: boolean;
  adaptive_days_per_week: number | null;
  adaptive_reason: string | null;
  adaptive_decided_at: Date | null;
}

/**
 * 1:1 with users (primary key IS user_id). Every method still takes
 * `userId: VerifiedUserId` and scopes `WHERE user_id = $1` for
 * consistency with every other repository, even though the PK makes the
 * scoping doubly enforced here.
 */
export class PreferencesRepository {
  constructor(private readonly db: Queryable) {}

  /** Row is created with defaults by ensureExists (called at signup); get returns null if somehow missing. */
  async ensureExists(userId: VerifiedUserId): Promise<PreferencesRow> {
    const result = await this.db.query<PreferencesRow>(
      `INSERT INTO preferences (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING *`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('ensureExists: insert returned no row');
    return row;
  }

  async get(userId: VerifiedUserId): Promise<PreferencesRow | null> {
    const result = await this.db.query<PreferencesRow>(
      `SELECT * FROM preferences WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async update(userId: VerifiedUserId, updates: PreferencesUpdate): Promise<PreferencesRow | null> {
    const result = await this.db.query<PreferencesRow>(
      `UPDATE preferences SET
         window_start_local = COALESCE($2::time, window_start_local),
         window_end_local = COALESCE($3::time, window_end_local),
         active_days = COALESCE($4::smallint[], active_days),
         cadence = COALESCE($5::text, cadence),
         -- Not COALESCE, unlike every other column here: since #202 a NULL
         -- duration_preference is a meaningful value ("auto" — let the band
         -- heuristic choose), not an absent one, so COALESCE's "NULL means
         -- leave it alone" would make auto unreachable once any other value
         -- had been stored. $19 carries presence explicitly: undefined in
         -- the update object means "don't touch", an explicit null means
         -- "set to auto".
         duration_preference = CASE
           WHEN $19::boolean THEN $6::devotional_format
           ELSE duration_preference
         END,
         voice = COALESCE($7::text, voice),
         stillness = COALESCE($8::text, stillness),
         lectio = COALESCE($9::boolean, lectio),
         calendar_enabled = COALESCE($10::boolean, calendar_enabled),
         health_enabled = COALESCE($11::boolean, health_enabled),
         communication_enabled = COALESCE($12::boolean, communication_enabled),
         notify_on_skip = COALESCE($13::boolean, notify_on_skip),
         examen_enabled = COALESCE($14::boolean, examen_enabled),
         sabbath_day = COALESCE($15::smallint, sabbath_day),
         sabbath_enabled = COALESCE($16::boolean, sabbath_enabled),
         sabbath_session = COALESCE($17::boolean, sabbath_session),
         liturgical_seasons_enabled = COALESCE($18::boolean, liturgical_seasons_enabled),
         min_per_week = COALESCE($20::smallint, min_per_week),
         adaptive_enabled = COALESCE($21::boolean, adaptive_enabled),
         updated_at = now()
       WHERE user_id = $1
       RETURNING *`,
      [
        userId,
        updates.window_start_local ?? null,
        updates.window_end_local ?? null,
        updates.active_days ?? null,
        updates.cadence ?? null,
        updates.duration_preference ?? null,
        updates.voice ?? null,
        updates.stillness ?? null,
        updates.lectio ?? null,
        updates.calendar_enabled ?? null,
        updates.health_enabled ?? null,
        updates.communication_enabled ?? null,
        updates.notify_on_skip ?? null,
        updates.examen_enabled ?? null,
        updates.sabbath_day ?? null,
        updates.sabbath_enabled ?? null,
        updates.sabbath_session ?? null,
        updates.liturgical_seasons_enabled ?? null,
        // $19 — see the duration_preference CASE above. Presence, not value.
        updates.duration_preference !== undefined,
        updates.min_per_week ?? null,
        updates.adaptive_enabled ?? null,
      ],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The ONLY write path for the cadence engine's state columns (P5 #324) —
   * `update` above cannot name them (excluded from `PreferencesUpdate` at
   * the type level), so a client body can never reach them.
   *
   * Call this only when the decision CHANGED the state (a step or a
   * clamp), never on a hold. `adaptive_decided_at` is doing double duty as
   * (a) the one-step-per-week rate limiter's clock and (b) P4's definition
   * of "since back-off" (`reengagedSinceBackoff` compares joins against
   * the newest `easing_back` decision) — recording a no-op hold would push
   * that timestamp forward every day and hold the rate-limit window shut
   * forever, freezing a backed-off user below their ceiling. Idempotent in
   * the sense #324 requires: same decision inputs produce the same state,
   * and the caller skipping unchanged writes is what makes re-runs no-ops.
   */
  async updateAdaptiveState(
    userId: VerifiedUserId,
    state: { daysPerWeek: number; reason: string; decidedAt: Date },
  ): Promise<void> {
    await this.db.query(
      `UPDATE preferences SET
         adaptive_days_per_week = $2,
         adaptive_reason = $3,
         adaptive_decided_at = $4,
         updated_at = now()
       WHERE user_id = $1`,
      [userId, state.daysPerWeek, state.reason, state.decidedAt],
    );
  }

  /** Users opted into the evening examen cadence (issue #77) — fan-out target for /internal/trigger-examen-run, mirroring UsersRepository.listWithActiveGoogleCalendar's shape. */
  async listWithExamenEnabled(): Promise<Array<{ user_id: string }>> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM preferences WHERE examen_enabled = true`,
    );
    return result.rows;
  }

  /**
   * Every user's `active_days` (K2, issue #188) plus the adaptive-rhythm
   * slice (P6, issue #325) — the fan-out gate for
   * `/internal/trigger-daily-run`.
   *
   * Deliberately unfiltered, and deliberately not `WHERE $today = ANY(active_days)`:
   * "is today one of this user's active days" is a question about the
   * user's **local** weekday, and `users.timezone` lives on a different
   * table. Two users queried in the same run can be on different calendar
   * days at the same instant, so there is no single `$today` to filter by
   * here (this is the #205 defect class: a UTC-derived weekday reads as
   * correct and silently isn't). The day-of-week resolution therefore
   * happens per user, in the route, against that user's zone — exactly
   * the reason `listWithSabbathEnabled` above also returns raw values
   * rather than pre-filtering by day.
   *
   * One query for the whole batch rather than a `get()` per user in the
   * loop, same as the sabbath lookup. #325 widens the SELECT with the
   * cadence-engine columns (`CadencePolicyPrefs`' inputs plus the stored
   * decision) rather than adding a second per-user read inside the daily
   * loop — the engine consumes them in the same place the day gate
   * already lives.
   */
  async listActiveDays(): Promise<DailyRunCadenceRow[]> {
    const result = await this.db.query<DailyRunCadenceRow>(
      `SELECT user_id, active_days, min_per_week, adaptive_enabled,
              adaptive_days_per_week, adaptive_reason, adaptive_decided_at
         FROM preferences`,
    );
    return result.rows;
  }

  /**
   * Users opted into sabbath awareness (docs/14 §5.6, issue #94), keyed by
   * `user_id` so the daily-run loop can look up each candidate user's
   * sabbath row directly rather than filtering by day here — "is today
   * this user's sabbath_day" depends on their timezone, which lives on
   * `users`, not `preferences`.
   */
  async listWithSabbathEnabled(): Promise<Array<{ user_id: string; sabbath_day: number; sabbath_session: boolean }>> {
    const result = await this.db.query<{ user_id: string; sabbath_day: number; sabbath_session: boolean }>(
      `SELECT user_id, sabbath_day, sabbath_session FROM preferences WHERE sabbath_enabled = true`,
    );
    return result.rows;
  }
}
