import type { Activity, Busyness, CommunicationLoad, Recovery, SleepQuality } from '@kairos/shared-contracts';
import type { Queryable, VerifiedUserId } from './types.js';

export interface DailyBandsRow {
  id: string;
  user_id: string;
  date: string; // YYYY-MM-DD
  recovery: Recovery | null;
  sleep_quality: SleepQuality | null;
  activity: Activity | null;
  busyness: Busyness | null;
  communication_load: CommunicationLoad;
  distress_signal: boolean;
  created_at: Date;
}

export interface UpsertDailyBandsInput {
  date: string;
  recovery?: Recovery | null;
  sleepQuality?: SleepQuality | null;
  activity?: Activity | null;
  busyness?: Busyness | null;
  communicationLoad?: CommunicationLoad;
  distressSignal?: boolean;
}

/**
 * Qualitative bands only, one row per user per day. Every method takes
 * `userId: VerifiedUserId` and scopes `WHERE user_id = $1` — raw
 * HealthKit values are never persisted here at all (Foundation §8), so
 * there is structurally no column to leak even if scoping were somehow
 * bypassed.
 */
export class DailyBandsRepository {
  constructor(private readonly db: Queryable) {}

  async upsertForDate(
    userId: VerifiedUserId,
    input: UpsertDailyBandsInput,
  ): Promise<DailyBandsRow> {
    const result = await this.db.query<DailyBandsRow>(
      `INSERT INTO daily_bands
         (user_id, date, recovery, sleep_quality, activity, busyness, communication_load, distress_signal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::boolean, false))
       ON CONFLICT (user_id, date) DO UPDATE SET
         recovery = EXCLUDED.recovery,
         sleep_quality = EXCLUDED.sleep_quality,
         activity = EXCLUDED.activity,
         busyness = EXCLUDED.busyness,
         communication_load = EXCLUDED.communication_load,
         distress_signal = EXCLUDED.distress_signal
       RETURNING *`,
      [
        userId,
        input.date,
        input.recovery ?? null,
        input.sleepQuality ?? null,
        input.activity ?? null,
        input.busyness ?? null,
        input.communicationLoad ?? null,
        input.distressSignal ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('upsertForDate: insert/update returned no row');
    return row;
  }

  async getForDate(userId: VerifiedUserId, date: string): Promise<DailyBandsRow | null> {
    const result = await this.db.query<DailyBandsRow>(
      `SELECT * FROM daily_bands WHERE user_id = $1 AND date = $2`,
      [userId, date],
    );
    return result.rows[0] ?? null;
  }

  async listRecent(userId: VerifiedUserId, limit = 30): Promise<DailyBandsRow[]> {
    const result = await this.db.query<DailyBandsRow>(
      `SELECT * FROM daily_bands WHERE user_id = $1 ORDER BY date DESC LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  }

  /** Monthly recap support (docs/14 §5.9, issue #96): every daily_bands row in `[startDate, endDate]` (inclusive), oldest first, for heavy-week detection. */
  async listForUserInRange(
    userId: VerifiedUserId,
    startDate: string,
    endDate: string,
  ): Promise<DailyBandsRow[]> {
    const result = await this.db.query<DailyBandsRow>(
      `SELECT * FROM daily_bands WHERE user_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC`,
      [userId, startDate, endDate],
    );
    return result.rows;
  }

  /** Retention: daily_bands rows older than 90 days (Privacy §retention). */
  async purgeOlderThan(userId: VerifiedUserId, days: number): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM daily_bands WHERE user_id = $1 AND date < (CURRENT_DATE - $2::int)`,
      [userId, days],
    );
    return result.rowCount ?? 0;
  }
}
