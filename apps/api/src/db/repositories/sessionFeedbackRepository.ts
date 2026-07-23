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

/**
 * One feedback row as the steering engine reads it (P7 #326): only the
 * columns the rules consume, plus the joined devotional theme. Narrow on
 * purpose — `content_helpful` and `note` are deliberately absent (no v1
 * rule reads them), so the steering seam carries nothing it does not use.
 */
export interface SteeringFeedbackRow {
  created_at: Date;
  topic_more: boolean | null;
  length_feel: LengthFeel | null;
  time_feel: TimeFeel | null;
  /** Theme of the devotional this feedback was about, or null once the devotional is purged (or the FK was nulled). */
  devotional_theme: string | null;
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

  /**
   * The trailing window of this user's feedback, newest first, each row
   * joined with the theme of the devotional it was about (P7 #326 — the
   * steering engine's whole input). LEFT JOIN because feedback outlives
   * both the session AND (via ON DELETE SET NULL / retention) potentially
   * the devotional: a row whose theme is gone still carries
   * length/time signal, so it must not vanish from the window.
   *
   * SERVER-SIDE ONLY, same as every read of this table (#320, §9): the
   * consumer is `FeedbackSteering` in-process; nothing under `/v1`
   * returns these rows. Reads the `(user_id, created_at)` index from
   * migration 1722400000000.
   */
  async listRecentForSteering(
    userId: VerifiedUserId,
    since: Date,
  ): Promise<SteeringFeedbackRow[]> {
    const result = await this.db.query<SteeringFeedbackRow>(
      `SELECT f.created_at, f.topic_more, f.length_feel, f.time_feel, d.theme AS devotional_theme
         FROM session_feedback f
         LEFT JOIN devotionals d ON d.id = f.devotional_id
        WHERE f.user_id = $1 AND f.created_at >= $2
        ORDER BY f.created_at DESC`,
      [userId, since],
    );
    return result.rows;
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
