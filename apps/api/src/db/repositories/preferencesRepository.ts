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
  updated_at: Date;
}

export type PreferencesUpdate = Partial<
  Omit<PreferencesRow, 'user_id' | 'updated_at'>
>;

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
      ],
    );
    return result.rows[0] ?? null;
  }

  /** Users opted into the evening examen cadence (issue #77) — fan-out target for /internal/trigger-examen-run, mirroring UsersRepository.listWithActiveGoogleCalendar's shape. */
  async listWithExamenEnabled(): Promise<Array<{ user_id: string }>> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM preferences WHERE examen_enabled = true`,
    );
    return result.rows;
  }

  /**
   * Every user's `active_days` (K2, issue #188) — the fan-out gate for
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
   * loop, same as the sabbath lookup.
   */
  async listActiveDays(): Promise<Array<{ user_id: string; active_days: number[] }>> {
    const result = await this.db.query<{ user_id: string; active_days: number[] }>(
      `SELECT user_id, active_days FROM preferences`,
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
