import type { LengthFeel, TimeFeel } from '@kairos/shared-contracts';
import type { Queryable, VerifiedUserId } from './types.js';

export interface SessionFeedbackRow {
  id: string;
  /** Null once the session row has been purged (ON DELETE SET NULL) — the feedback outlives it; see 1722400000000_session-feedback.ts. */
  session_token: string | null;
  user_id: string;
  devotional_id: string | null;
  content_helpful: boolean | null;
  topic_more: boolean | null;
  length_feel: LengthFeel | null;
  time_feel: TimeFeel | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertSessionFeedbackInput {
  sessionToken: string;
  devotionalId: string;
  contentHelpful?: boolean | null;
  topicMore?: boolean | null;
  lengthFeel?: LengthFeel | null;
  timeFeel?: TimeFeel | null;
  note?: string | null;
}

/**
 * Backs the post-Amen feedback moment (EPIC P #312, story #320). One row
 * per session (`session_feedback_session_token_unique`); re-submits
 * upsert. Every method takes `userId: VerifiedUserId` and scopes by it,
 * matching every other per-user repository (Foundation §10) — the public
 * route derives the userId from the session row the token resolves to,
 * exactly like the prayer-intentions flow.
 *
 * Reads are SERVER-SIDE ONLY: the cadence policy engine (#323/#324) is
 * the consumer. No authenticated client GET exposes these rows (#320
 * acceptance criteria; Foundation §9 — nothing a client could turn into
 * a tally or streak).
 */
export class SessionFeedbackRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Insert-or-update keyed on the session token. Per-column COALESCE with
   * EXCLUDED first: a re-submit's answered questions win (last write wins
   * per question), but a re-submit that OMITS a question must not null
   * out an earlier answer (#320: "a re-submit with fewer answers must not
   * erase") — COALESCE(EXCLUDED.col, existing.col) is exactly that rule.
   * A consequence worth naming: an answer can be revised but never
   * retracted back to unanswered; for a ≤10-second optional form that is
   * the right trade against a retry silently erasing real signal.
   */
  async upsert(userId: VerifiedUserId, input: UpsertSessionFeedbackInput): Promise<SessionFeedbackRow> {
    const result = await this.db.query<SessionFeedbackRow>(
      `INSERT INTO session_feedback
         (session_token, user_id, devotional_id, content_helpful, topic_more, length_feel, time_feel, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (session_token) DO UPDATE SET
         content_helpful = COALESCE(EXCLUDED.content_helpful, session_feedback.content_helpful),
         topic_more = COALESCE(EXCLUDED.topic_more, session_feedback.topic_more),
         length_feel = COALESCE(EXCLUDED.length_feel, session_feedback.length_feel),
         time_feel = COALESCE(EXCLUDED.time_feel, session_feedback.time_feel),
         note = COALESCE(EXCLUDED.note, session_feedback.note),
         updated_at = now()
       WHERE session_feedback.user_id = $2
       RETURNING *`,
      [
        input.sessionToken,
        userId,
        input.devotionalId,
        input.contentHelpful ?? null,
        input.topicMore ?? null,
        input.lengthFeel ?? null,
        input.timeFeel ?? null,
        input.note ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('upsert: no row returned');
    return row;
  }

  /** Whether feedback exists for this session — drives the complete page's form-vs-thanked state (P2 #321: once submitted, never re-asked). */
  async findBySessionToken(userId: VerifiedUserId, sessionToken: string): Promise<SessionFeedbackRow | null> {
    const result = await this.db.query<SessionFeedbackRow>(
      `SELECT * FROM session_feedback WHERE user_id = $1 AND session_token = $2`,
      [userId, sessionToken],
    );
    return result.rows[0] ?? null;
  }
}
