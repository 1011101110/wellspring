/**
 * Concrete `FeedbackSignalSource` over P1's `session_feedback` table
 * (#320, migration lands in that story's PR — merged ahead of this one).
 *
 * Presence only, on purpose: the signal is "this person told us
 * SOMETHING about this devotional", which counts as engagement even
 * without Amen. What they said (contentHelpful/topicMore/lengthFeel/
 * timeFeel/note) is P7's business (#326, feedback → generation params)
 * and never reaches the attendance read model — the narrower the seam,
 * the less there is to audit under §9.
 *
 * A note on the repository rule (db/repositories/index.ts): this class
 * holds SQL against `session_feedback` outside that bundle because the
 * canonical `sessionFeedbackRepository` is being authored in #320's
 * parallel PR — creating the same file here would guarantee a merge
 * conflict. Folding this one SELECT into that repository once both are
 * on main is a mechanical follow-up.
 */
import type { Queryable, VerifiedUserId } from '../../db/repositories/types.js';
import type { FeedbackSignalSource } from './attendanceSignals.js';

export class SessionFeedbackSignalSource implements FeedbackSignalSource {
  constructor(private readonly db: Queryable) {}

  /**
   * Which of `devotionalIds` have a feedback row from this user. Keyed on
   * `(user_id, devotional_id)` — #320's durable key, chosen there exactly
   * so feedback outlives the sessions purge and can keep feeding this
   * window after the session row is gone.
   */
  async devotionalIdsWithFeedback(
    userId: VerifiedUserId,
    devotionalIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (devotionalIds.length === 0) return new Set();
    const result = await this.db.query<{ devotional_id: string }>(
      `SELECT DISTINCT devotional_id FROM session_feedback
        WHERE user_id = $1 AND devotional_id = ANY($2::uuid[])`,
      [userId, [...devotionalIds]],
    );
    return new Set(result.rows.map((r) => r.devotional_id));
  }
}
