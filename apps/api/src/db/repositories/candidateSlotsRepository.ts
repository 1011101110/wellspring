import type { Queryable, VerifiedUserId } from './types.js';

export interface CandidateSlotRow {
  id: string;
  user_id: string;
  date: string; // YYYY-MM-DD
  start_at: Date;
  end_at: Date;
  created_at: Date;
}

export interface CandidateSlotInput {
  startAt: Date;
  endAt: Date;
}

/**
 * Backs `POST /v1/slots` (docs/03 §8.1) and feeds `BusynessAnalyzer` via
 * `loadTodaysBusyness` (services/busyness/loadTodaysBusyness.ts). Every
 * method takes `userId: VerifiedUserId` and scopes `WHERE user_id = $1`,
 * matching every other per-user repository (Foundation §10).
 */
export class CandidateSlotsRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Replaces the full set of candidate slots for a user+date in one
   * transaction-free delete-then-insert (single caller per date in
   * practice — the iOS client re-derives and re-uploads the whole day's
   * EventKit snapshot rather than incrementally patching, so there is no
   * meaningful "merge" semantics to preserve; a stale slot from a prior
   * upload has no scheduling value once superseded).
   */
  async replaceForDate(
    userId: VerifiedUserId,
    date: string,
    slots: CandidateSlotInput[],
  ): Promise<CandidateSlotRow[]> {
    await this.db.query(`DELETE FROM candidate_slots WHERE user_id = $1 AND date = $2`, [
      userId,
      date,
    ]);

    if (slots.length === 0) {
      return [];
    }

    // Multi-row VALUES insert — bounded by MAX_SLOTS_PER_UPLOAD
    // (shared-contracts), so the parameter count here is always safely
    // under Postgres's per-statement parameter limit.
    const values: string[] = [];
    const params: unknown[] = [userId, date];
    slots.forEach((slot, i) => {
      const startParam = params.length + 1;
      const endParam = params.length + 2;
      values.push(`($1, $2, $${startParam}, $${endParam})`);
      params.push(slot.startAt, slot.endAt);
      void i;
    });

    const result = await this.db.query<CandidateSlotRow>(
      `INSERT INTO candidate_slots (user_id, date, start_at, end_at)
       VALUES ${values.join(', ')}
       RETURNING *`,
      params,
    );
    return result.rows;
  }

  async getForDate(userId: VerifiedUserId, date: string): Promise<CandidateSlotRow[]> {
    const result = await this.db.query<CandidateSlotRow>(
      `SELECT * FROM candidate_slots WHERE user_id = $1 AND date = $2 ORDER BY start_at ASC`,
      [userId, date],
    );
    return result.rows;
  }
}
