/**
 * The upcoming schedule and — the harder half — its empty state
 * (L4, issue #240).
 *
 * ## The empty list is the common case, not the failure case
 *
 * A default user has `activeDays: [1,2,3,4,5]`. On Saturday morning their
 * upcoming list is genuinely, correctly empty, and will be for two days.
 * If that renders as a blank box or a shrug, the product looks broken every
 * weekend to every user who has not changed a setting (#188, #240).
 *
 * So the empty state answers the question the emptiness raises: *when,
 * then?* That answer is computable on the client and only on the client —
 * the API deliberately does not send a reason string, because a reason
 * computed server-side would be a second copy of the schedule logic, free
 * to drift from the one in `activeDays` (see the route comment in
 * `userScoped.ts`). The client already holds `activeDays` from
 * `/v1/preferences`, so it computes the sentence from the same data the
 * scheduler uses.
 */
import type { UpcomingCalendarEvent } from '@kairos/shared-contracts';
import { weekdayInZone } from './datetime';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * The next day-of-week Wellspring is scheduled to run, starting from
 * *tomorrow*.
 *
 * Tomorrow rather than today because this is only ever called when the
 * upcoming list is empty — which means nothing further is booked today, so
 * naming today would be telling the user to wait for a session that is not
 * coming.
 *
 * Returns `null` when `activeDays` is empty. That is a state the API
 * rejects on write since #188 ("never generate again, silently") but a
 * legacy row can still hold it, and inventing a day for it would be a
 * confident lie about a schedule that will never fire.
 */
export function nextActiveWeekday(
  activeDays: readonly number[],
  now: Date,
  zone: string,
): string | null {
  const days = new Set(activeDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (days.size === 0) return null;

  const today = weekdayInZone(now, zone);
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const candidate = (today + ahead) % 7;
    if (days.has(candidate)) {
      // "next Monday" is ambiguous in English and "Monday" is not, so the
      // bare day name is used for anything inside the coming week.
      return DAY_NAMES[candidate] ?? null;
    }
  }
  return null;
}

/**
 * Whether Wellspring is in a position to book anything at all.
 *
 * A required parameter, not an optional flag defaulting to "connected",
 * for the reason `SignalProvenance` is required in the instructions
 * builder (#196): a neutral default that gets narrated as an observation
 * is exactly how a product ends up making confident false statements. A
 * caller that has not established connection state must say `unknown` and
 * get the sentence that admits it.
 *
 * `unknown` is a real state and not a rounding of `disconnected` — the
 * connection card is its own independently-failing fetch (`CardState`), so
 * on any given render the honest answer may be that we have not been told
 * yet. Rounding it to either certainty is the #245 mistake in miniature.
 */
export type SchedulingCapability = 'connected' | 'disconnected' | 'unknown';

/**
 * The sentence shown in place of an empty upcoming list.
 *
 * Deliberately declarative. Not "No upcoming devotionals" (an absence
 * presented as a result), and not "Nothing scheduled — check your
 * settings?" (an absence presented as the user's mistake). Wellspring books
 * the next one; saying so is both true and the entire reassurance the
 * empty state needs to provide.
 *
 * ## Why `capability` exists (N1, issue #260)
 *
 * This function used to be a pure function of `activeDays`, which meant a
 * user with no calendar connected — the entire first-run population — was
 * told *"Your next devotional is Thursday."* Nothing was scheduled and
 * nothing would be. Three of these cards rendered directly above the
 * connection card reading "No calendar connected", so the dashboard
 * contradicted itself on one screen.
 *
 * `activeDays` describes which days a devotional *may* be booked on. It
 * has never described whether one *will* be. Turning the first into the
 * second is the #193/#213 class of bug: a specific, confident claim
 * derived from data that cannot support it.
 */
export function emptyUpcomingMessage(
  activeDays: readonly number[],
  now: Date,
  zone: string,
  capability: SchedulingCapability,
): string {
  if (capability === 'disconnected') {
    // Names the mechanism and the one thing that starts it, and promises
    // no day — because without a calendar there is no gap to book into and
    // no day is coming.
    return 'Wellspring books devotionals into the open moments on your calendar. Connecting one is what starts that.';
  }

  if (capability === 'unknown') {
    // The half of the sentence we can still stand behind. Saying less is
    // the correct response to knowing less.
    return 'Nothing more is booked today.';
  }

  const day = nextActiveWeekday(activeDays, now, zone);
  if (!day) {
    // The #188 legacy-row case. Points at the fix without asserting a
    // schedule that does not exist.
    return 'No days are turned on for devotionals right now. You can choose them in settings.';
  }
  // "books your next one on ${day}", not "your next devotional IS ${day}".
  // Wellspring writes and books each devotional the morning of, into an open
  // moment on that day — so before then, that day's slot genuinely does
  // not exist yet, and the calendar correctly shows nothing on it. A user
  // reported the old copy ("your next devotional is Monday") reading as a
  // firm booking while Monday's calendar sat empty; this says what is
  // actually true — the day it happens — so the two surfaces agree.
  return `Nothing more is booked today. Wellspring books your next one on ${day}.`;
}

/** Soonest first. The API already orders by `gap_start_at`; this makes the list's contract local. */
export function sortByStart(
  events: readonly UpcomingCalendarEvent[],
): readonly UpcomingCalendarEvent[] {
  return [...events].sort(
    (a, b) => new Date(a.gapStartAt).getTime() - new Date(b.gapStartAt).getTime(),
  );
}

/**
 * How a row mentions rescheduling, or `null` to stay silent.
 *
 * #240 asks for `rescheduleCount` to be surfaced — "an event Wellspring has
 * moved three times is something the user is entitled to see it admit".
 * Rendered as a phrase rather than a numeral for counts above one, because
 * this dashboard renders no numbers (§5.10) and because "moved a few
 * times" is the honest granularity: the precise count is not a thing the
 * user can act on, the fact of the moving is.
 */
export function rescheduleNote(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count === 1) return 'Wellspring moved this once to fit your calendar.';
  return 'Wellspring has moved this a few times to fit your calendar.';
}
