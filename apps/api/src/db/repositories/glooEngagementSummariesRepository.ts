import type { GlooEngagementSummary } from '@kairos/shared-contracts';
import type { Queryable, VerifiedUserId } from './types.js';

export interface GlooEngagementSummaryRow {
  id: string;
  user_id: string;
  devotional_id: string;
  session_token: string;
  payload: GlooEngagementSummary;
  created_at: Date;
}

export interface RecordGlooEngagementSummaryInput {
  devotionalId: string;
  sessionToken: string;
  payload: GlooEngagementSummary;
}

/**
 * The "persisted locally" half of docs/03_API_INTEGRATION_SPEC.md §7's
 * stubbed Gloo transport — Cloud Run has no durable local disk, so "locally"
 * means our own Postgres. Rows are the record of every fire-and-forget
 * send, kept until the real Gloo ingestion surface (issue #21) exists.
 */
export class GlooEngagementSummariesRepository {
  constructor(private readonly db: Queryable) {}

  async record(
    userId: VerifiedUserId,
    input: RecordGlooEngagementSummaryInput,
  ): Promise<GlooEngagementSummaryRow> {
    const result = await this.db.query<GlooEngagementSummaryRow>(
      `INSERT INTO gloo_engagement_summaries (user_id, devotional_id, session_token, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`,
      [userId, input.devotionalId, input.sessionToken, JSON.stringify(input.payload)],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('record: insert returned no row');
    }
    return row;
  }
}
