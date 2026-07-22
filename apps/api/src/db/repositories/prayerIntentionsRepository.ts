import type { Queryable, VerifiedUserId } from './types.js';

export interface PrayerIntentionRow {
  id: string;
  user_id: string;
  devotional_id: string;
  text: string;
  created_at: Date;
}

/**
 * Backs issue #93 (docs/14 §5.5): the one-line "anything you're carrying?"
 * response captured on session completion, recorded against that day's
 * devotional and injected into the NEXT generation's instructions as
 * deliberate disclosure. Every method takes `userId: VerifiedUserId` and
 * scopes `WHERE user_id = $1`, matching every other per-user repository
 * (Foundation §10).
 */
export class PrayerIntentionsRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Records the intention for a given devotional. Idempotent by design
   * (`prayer_intentions_user_devotional_unique`): a retried/duplicate
   * completion POST for the same devotional does nothing further rather
   * than erroring or creating a second row — matching
   * `sessionService.completeSession()`'s "genuine first completion only"
   * guard, which is the sole caller.
   */
  async record(
    userId: VerifiedUserId,
    devotionalId: string,
    text: string,
  ): Promise<PrayerIntentionRow | null> {
    const result = await this.db.query<PrayerIntentionRow>(
      `INSERT INTO prayer_intentions (user_id, devotional_id, text)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, devotional_id) DO NOTHING
       RETURNING *`,
      [userId, devotionalId, text],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The intention recorded against the user's devotional for `date`
   * (YYYY-MM-DD), joined via `devotionals` since `prayer_intentions` itself
   * carries no date column — `generateNowOrchestrator` uses this to fetch
   * YESTERDAY's intention (relative to the date being generated) to weave
   * into today's instructions.
   */
  async getForDate(userId: VerifiedUserId, date: string): Promise<PrayerIntentionRow | null> {
    const result = await this.db.query<PrayerIntentionRow>(
      `SELECT pi.* FROM prayer_intentions pi
       JOIN devotionals d ON d.id = pi.devotional_id
       WHERE pi.user_id = $1 AND d.date = $2
       LIMIT 1`,
      [userId, date],
    );
    return result.rows[0] ?? null;
  }

  /** Retention purge (docs/14 §5.5: 14-day retention) — see purgeJobs.ts. */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db.query(`DELETE FROM prayer_intentions WHERE created_at < $1`, [cutoff]);
    return result.rowCount ?? 0;
  }
}
