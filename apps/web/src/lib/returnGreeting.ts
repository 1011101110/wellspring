/**
 * The return greeting — grace that notices without counting (N13, #282;
 * ruling #271, Foundation §9).
 *
 * ## The boundary this file lives on
 *
 * Foundation §9 now permits Wellspring to *notice* a return and forbids it
 * from *quantifying* one. This function is where that line is drawn in
 * code: it may look at how long it has been to decide **whether** to
 * speak, but what it returns is a human acknowledgement with **no number,
 * no date, and no comparison to a past self**. Noticing you were away is
 * grace; telling you it was seventeen days is accounting.
 *
 * ## Why it is not part of `deriveTodayState`
 *
 * `todayCard.ts` is deliberately blind to history so a streak is
 * *uncomputable* there — a guard worth keeping. This is a separate,
 * sanctioned feature, so it lives in its own function with its own single
 * input (the most recent devotional's date) rather than widening that
 * one. The greeting cannot become a streak because the only thing it can
 * return is a fixed sentence.
 *
 * ## The output carries no count — enforced by test, not just intent
 *
 * `returnGreeting.test.ts` asserts the string contains no digit across
 * every gap length. The failure mode this guards is a fluent, kind
 * sentence that nonetheless counts ("it's been 2 weeks") — which reads as
 * warmth and is exactly the accounting §9 refuses. If the copy ever gains
 * a number, the build breaks.
 */
import { dateKeyInZone, type DateKey } from './datetime';

/**
 * How long an absence must be before Wellspring says anything.
 *
 * Ten days (owner's call, #282). Long enough that a greeting means
 * something rather than firing after a normal weekend; short enough that a
 * returning user is met rather than ignored. A daily or twice-weekly user
 * never crosses it, so they never see the greeting — which is correct: you
 * do not welcome back someone who never left.
 */
export const RETURN_GAP_DAYS = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The greeting to show, or `null` for silence.
 *
 * `mostRecentDevotionalDate` is the `date` of the newest devotional in the
 * archive (a calendar day, `'2026-07-19'`, not an instant — the #209
 * distinction), or `null` for a user who has none. A user with none is a
 * first-run user, who gets the welcome banner instead, so this returns
 * `null` for them and the two never both render.
 *
 * The gap is measured in whole calendar days in the profile zone, the same
 * zone the archive dates are shown in, so "today" here and "today" on the
 * cards agree.
 */
export function returnGreeting(
  mostRecentDevotionalDate: DateKey | null,
  now: Date,
  zone: string,
): string | null {
  if (!mostRecentDevotionalDate) return null;

  const today = dateKeyInZone(now, zone);
  // Parse both as UTC midnight and diff — a whole-days calculation that
  // does not care about DST because both endpoints are date keys, not
  // instants.
  const last = Date.parse(`${mostRecentDevotionalDate}T00:00:00Z`);
  const nowMidnight = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(last) || Number.isNaN(nowMidnight)) return null;

  const daysAway = Math.round((nowMidnight - last) / MS_PER_DAY);
  if (daysAway <= RETURN_GAP_DAYS) return null;

  // Notices, and offers — never remarks on the length. A standing
  // invitation rather than a one-time pop, so it reads as an open door and
  // not an event: it stays until the person makes a devotional, at which
  // point the most-recent date becomes today and this falls silent on its
  // own.
  return 'It’s been a little while. There’s room for a devotional whenever you want one.';
}
