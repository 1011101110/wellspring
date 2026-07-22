/**
 * "Where am I today?" — the dashboard's first card (L7, issue #243).
 *
 * ## No streaks, and why that is a property of this file
 *
 * docs/14 §5.10 and Foundation §9 forbid streaks, badges, counts and
 * percentages on this surface. That is easy to honor in copy and easy to
 * lose in a refactor, so the constraint is enforced here by *what this
 * module can see*: `TodayState` is derived from today's devotional and
 * today's event and nothing else. There is no history array in scope, no
 * completion tally, no "days since". A future contributor who wants to
 * render "🔥 12-day streak" cannot get the number from this function
 * without first widening its inputs, which is a visible act rather than an
 * accident.
 *
 * The card states what *is*. It never states what was missed: there is no
 * `missed` variant below, and the absence of a devotional yesterday is not
 * an input. A user coming back after a skipped week sees exactly what a
 * user who came back yesterday sees — which is the point, and is the
 * constraint that feels wrong to write.
 *
 * ## Contract gap: this is not built from `/v1/ledger/today`
 *
 * #243 says "Today card from `GET /v1/ledger/today`". That endpoint
 * returns the day's `daily_bands` row plus a prayer intention — body
 * signals, not devotional state. It carries no devotional id, theme,
 * status or scheduled time, so the card #243 describes ("scheduled at X /
 * ready / completed, the theme when it exists") cannot be built from it.
 *
 * It is composed instead from two endpoints that do carry those facts:
 * the first page of `GET /v1/devotionals` (whose cards include `date`,
 * `theme` and `completedAt`) and `GET /v1/calendar-events/upcoming`
 * (which carries `gapStartAt` for today's booking). Both are already
 * fetched for other cards, so this costs no extra request.
 *
 * Note also that the ledger's band data is deliberately *not* surfaced
 * here even though it is available: bands are phrases, never numbers
 * (docs/05 P5), and a number on this card would need a formation
 * argument rather than an engagement one (#243).
 */
import type { DevotionalCard, UpcomingCalendarEvent } from '@kairos/shared-contracts';
import { dateKeyInZone } from './datetime';

/**
 * What is true about today, in the order the card prefers to say it.
 *
 * There is exactly one next action per state — #243 asks for "the single
 * next action", and a card offering three is a card that has not decided
 * what the user should do.
 */
export type TodayState =
  /** Today's devotional exists and the session was completed. */
  | { kind: 'completed'; devotional: DevotionalCard }
  /** Today's devotional exists and is waiting to be opened. */
  | { kind: 'ready'; devotional: DevotionalCard }
  /** Nothing generated yet, but Wellspring has booked a time today. */
  | { kind: 'scheduled'; event: UpcomingCalendarEvent }
  /** Nothing today. The next action is the "+" — never an apology. */
  | { kind: 'open' };

/**
 * Today's devotional, if there is one.
 *
 * Matches on the `date` column in the user's zone rather than on
 * `createdAt`: a devotional generated at 11pm for the next morning belongs
 * to the day it is *for*. Exported for the test, which is the only reason
 * it is not inlined.
 */
export function findTodaysDevotional(
  devotionals: readonly DevotionalCard[],
  todayKey: string,
): DevotionalCard | null {
  return devotionals.find((d) => d.date === todayKey) ?? null;
}

/** The soonest event that falls on today, in the user's zone. */
export function findTodaysEvent(
  events: readonly UpcomingCalendarEvent[],
  todayKey: string,
  zone: string,
): UpcomingCalendarEvent | null {
  return events.find((e) => dateKeyInZone(new Date(e.gapStartAt), zone) === todayKey) ?? null;
}

export function deriveTodayState(input: {
  devotionals: readonly DevotionalCard[];
  events: readonly UpcomingCalendarEvent[];
  now: Date;
  zone: string;
}): TodayState {
  const todayKey = dateKeyInZone(input.now, input.zone);
  const devotional = findTodaysDevotional(input.devotionals, todayKey);

  if (devotional) {
    // `completedAt` is the session's completion instant, not a score. It
    // picks a sentence and is never counted.
    return devotional.completedAt
      ? { kind: 'completed', devotional }
      : { kind: 'ready', devotional };
  }

  const event = findTodaysEvent(input.events, todayKey, input.zone);
  if (event) return { kind: 'scheduled', event };

  return { kind: 'open' };
}

/**
 * The card's headline for each state.
 *
 * Reviewed against #243's copy rule: no state mentions absence, lateness,
 * or a missed session. `open` is phrased as availability ("whenever you
 * want one") rather than as a gap to be filled — the difference between an
 * invitation and a reprimand, which is the entire distinction Foundation
 * §9 draws.
 */
export const TODAY_HEADLINES: Record<TodayState['kind'], string> = {
  completed: 'You sat with today’s devotional.',
  ready: 'Today’s devotional is ready.',
  scheduled: 'Wellspring has found a moment for you today.',
  open: 'There’s room for a devotional whenever you want one.',
};
