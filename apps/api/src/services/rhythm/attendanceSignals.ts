/**
 * P4: the attendance signal read model (Epic P #312, issue #323) — the
 * substrate the cadence policy engine (cadencePolicy.ts, P5 #324) reads.
 *
 * ## §9-safety is the shape, not a filter
 *
 * `AttendanceSignals` is the ONLY type this module exports for consumers,
 * and every field is a single aggregate: a count, a score, a run length,
 * one timestamp, one boolean. No per-day arrays, no date lists, no
 * attended/missed calendar — if a client could tally it into a streak,
 * the type would be wrong (#282's "single value, not a history array"
 * rule; Foundation §9). The per-event rows this is computed from
 * (`ScheduledAttendanceRow`) exist only between the repository and
 * `computeAttendanceSignals`, and nothing under `/v1` returns any of
 * these fields — the consumers are P5 in-process and P8's
 * server-composed copy. tests/services/rhythm/attendanceSignals.test.ts
 * pins the exported shape closed.
 *
 * ## What counts, and what never does
 *
 * The denominator is calendar-scheduled, standard-slot devotionals whose
 * event window has ended — a standing invitation the user could have
 * kept. Generate-now, examen, and distress sessions are excluded BY
 * CONSTRUCTION in `SessionsRepository.listScheduledAttendance` (slot
 * filter + INNER JOIN on `calendar_events`, which those paths never
 * insert): a devotional the user never asked to attend must not count
 * against them. Joins, by contrast, count from ANYWHERE — see
 * `latestJoinedAt` — because engagement may only ever work in the user's
 * favor.
 */
import type {
  ScheduledAttendanceRow,
  SessionsRepository,
} from '../../db/repositories/sessionsRepository.js';
import type { VerifiedUserId } from '../../db/repositories/types.js';

/**
 * The exported read-model shape — aggregates only (see module doc).
 * Adding a field here means re-arguing §9-safety; the closed-schema test
 * will fail until you do.
 */
export interface AttendanceSignals {
  /** Standard-slot devotionals with a finished calendar event in the trailing window. */
  scheduledCount: number;
  /**
   * 0..1 time-decayed engagement over the scheduled denominator (weighted
   * average, half-life {@link ENGAGEMENT_HALF_LIFE_DAYS} days). A smoothed
   * recent-engagement trend, not a precise ratio — see the retention note
   * on `listScheduledAttendance`. `1` when `scheduledCount` is 0: absence
   * of invitations is our doing, not theirs, and no-data must never read
   * as disengagement (the engine treats it as "no change" regardless).
   */
  engagedScore: number;
  /** Trailing run of scheduled-but-never-engaged invitations, most recent first. */
  consecutiveUnjoined: number;
  /** Most recent join across ALL sessions (scheduled or not) in the window, or null. */
  lastJoinedAt: Date | null;
  /** Any join strictly after the newest `easing_back` decision (P5 stores decisions). */
  reengagedSinceBackoff: boolean;
}

/**
 * Half-life of an event's weight in `engagedScore` (~9 days per the epic):
 * weight = 0.5^(ageDays / 9), so day-0 counts 1.0, day-9 counts 0.5,
 * day-28 (the window edge) ~0.116.
 */
export const ENGAGEMENT_HALF_LIFE_DAYS = 9;

/** Trailing window the signals summarize (epic: trailing-28-day engagement). */
export const DEFAULT_WINDOW_DAYS = 28;

/**
 * The narrow seam to P1's `session_feedback` table (#320, built in
 * parallel): "which of these devotionals has a feedback row?" — presence
 * only, never content. A feedback row counts as engagement even without
 * Amen (someone who told us the topic landed showed up, whatever buttons
 * they did or didn't tap). Kept as an interface so this module compiles
 * and tests without #320's migration; the concrete reader lives in
 * sessionFeedbackSignalSource.ts.
 */
export interface FeedbackSignalSource {
  devotionalIdsWithFeedback(
    userId: VerifiedUserId,
    devotionalIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

export interface AttendanceSignalsOptions {
  /** Injected clock (internal.ts's injectable-clock precedent) — decay ages and the window anchor both derive from it. */
  now: Date;
  /** Trailing window length; defaults to {@link DEFAULT_WINDOW_DAYS}. */
  windowDays?: number;
  /**
   * `adaptive_decided_at` of the newest `easing_back` decision, or null if
   * the user was never backed off. Passed in rather than re-read here:
   * the caller (#325's evaluation loop) already holds the preferences
   * row, and P5 owns what "a back-off decision" is.
   */
  lastBackoffAt: Date | null;
}

const MS_PER_DAY = 86_400_000;

/** An invitation was met if ANY of join/Amen/feedback happened — engagement only ever counts for the user. */
function engaged(row: ScheduledAttendanceRow, feedbackIds: ReadonlySet<string>): boolean {
  return (
    row.joined_at !== null || row.completed_at !== null || feedbackIds.has(row.devotional_id)
  );
}

/**
 * Pure reduction of per-event rows to the aggregate signals — same
 * (rows, feedbackIds, options) in, same output out, replayable in tests
 * with no clock singleton or database.
 */
export function computeAttendanceSignals(
  rows: readonly ScheduledAttendanceRow[],
  feedbackIds: ReadonlySet<string>,
  latestJoin: Date | null,
  options: AttendanceSignalsOptions,
): AttendanceSignals {
  const { now, lastBackoffAt } = options;

  // Newest first — the trailing-run count below depends on this order, so
  // it is (re)established here rather than trusted from the query.
  const sorted = [...rows].sort((a, b) => b.scheduled_at.getTime() - a.scheduled_at.getTime());

  let weightSum = 0;
  let engagedWeightSum = 0;
  let consecutiveUnjoined = 0;
  let runBroken = false;

  for (const row of sorted) {
    // Clamped at 0: a clock-skewed "future" scheduled_at must not mint a
    // weight above 1 and let one event dominate the average.
    const ageDays = Math.max(0, (now.getTime() - row.scheduled_at.getTime()) / MS_PER_DAY);
    const weight = 0.5 ** (ageDays / ENGAGEMENT_HALF_LIFE_DAYS);
    const isEngaged = engaged(row, feedbackIds);

    weightSum += weight;
    if (isEngaged) engagedWeightSum += weight;

    if (!runBroken) {
      if (isEngaged) runBroken = true;
      else consecutiveUnjoined += 1;
    }
  }

  return {
    scheduledCount: sorted.length,
    // Neutral 1 on an empty denominator — documented on the interface:
    // no invitations means no evidence, and no evidence must never read
    // as disengagement.
    engagedScore: weightSum === 0 ? 1 : engagedWeightSum / weightSum,
    consecutiveUnjoined,
    lastJoinedAt: latestJoin,
    // Strictly after: a join at the exact instant of the back-off decision
    // is the join that PRECEDED it (the decision was made in its light),
    // not renewed engagement since.
    reengagedSinceBackoff:
      lastBackoffAt !== null && latestJoin !== null && latestJoin.getTime() > lastBackoffAt.getTime(),
  };
}

export interface AttendanceSignalsDeps {
  sessions: SessionsRepository;
  feedback: FeedbackSignalSource;
}

/**
 * Loads and reduces one user's trailing-window attendance. Three narrow,
 * indexed queries per user (scheduled rows, feedback presence, latest
 * join) — cheap inside the daily fan-out loop at the current user count.
 * (#323 asked for one round trip; the split is deliberate: the feedback
 * read stays behind `FeedbackSignalSource` so this module doesn't couple
 * to #320's table, and the latest-join read spans ALL sessions, not the
 * scheduled denominator — see `latestJoinedAt`.)
 */
export async function loadAttendanceSignals(
  deps: AttendanceSignalsDeps,
  userId: VerifiedUserId,
  options: AttendanceSignalsOptions,
): Promise<AttendanceSignals> {
  const { now, windowDays = DEFAULT_WINDOW_DAYS } = options;
  const windowStart = new Date(now.getTime() - windowDays * MS_PER_DAY);

  const rows = await deps.sessions.listScheduledAttendance(userId, windowStart, now);
  const feedbackIds =
    rows.length === 0
      ? new Set<string>()
      : await deps.feedback.devotionalIdsWithFeedback(
          userId,
          rows.map((r) => r.devotional_id),
        );
  const latestJoin = await deps.sessions.latestJoinedAt(userId, windowStart);

  return computeAttendanceSignals(rows, feedbackIds, latestJoin, options);
}
