/**
 * "Your rhythm" copy + control bounds (P8 #327, epic #312) — the ONE
 * place the reason-code → prose mapping lives, kept out of the component
 * so it is testable in node-env vitest like every other lib module.
 *
 * ## Copy guardrails (Foundation §9, #271 ruling, #282 precedent)
 *
 * Grace may notice; it may never charge. Concretely, and pinned by the
 * automated string assertions in test/rhythm.test.ts across EVERY reason
 * code:
 *
 *  - No number that counts the user's *practice* — no "you attended",
 *    "you missed", no dates, no streaks, no comparisons to a past self.
 *    The only digits permitted in a rendered line are the schedule
 *    numbers we interpolate (days per week — the same class of number as
 *    the day circles).
 *  - No verdicts. `easing_back` is the template: acknowledgement +
 *    reassurance, then stop.
 *  - `no_data` renders NOTHING (null) — an engine with nothing to say
 *    does not get a placeholder sentence (#244 policy).
 */
import type { Rhythm, RhythmReason } from '@kairos/shared-contracts';

/** "1 morning" / "3 mornings" — the schedule fact, the one number the copy may carry. */
function mornings(n: number): string {
  return n === 1 ? '1 morning' : `${n} mornings`;
}

/**
 * The reason-code → grace-copy map. Exhaustive over `RhythmReason` (the
 * `Record` keying is the lockstep guard, same as TRADITION_LABELS): a
 * code added to the shared contract will not type-check here until it is
 * given copy — or an explicit `null`. Functions rather than templates so
 * the schedule number lands pre-pluralized.
 */
const STATUS_LINES: Readonly<Record<RhythmReason, ((rhythm: Rhythm) => string) | null>> =
  Object.freeze({
    hold: (r) => `Your rhythm is steady — ${mornings(r.daysPerWeek)} a week.`,
    at_ceiling: (r) => `Your rhythm is steady — ${mornings(r.daysPerWeek)} a week.`,
    easing_back: (r) =>
      `Wellspring noticed life might be full right now, and has gently eased back to ${mornings(r.daysPerWeek)} a week. There's no catching up to do — this pace is yours.`,
    at_floor: (r) =>
      `Wellspring noticed life might be full right now, and has gently eased back to ${mornings(r.daysPerWeek)} a week. There's no catching up to do — this pace is yours.`,
    welcoming_back: () =>
      `It's good to have you back. Wellspring is slowly adding mornings again as you're ready.`,
    fixed_by_user: () => `Your schedule is fixed — Wellspring won't adjust it.`,
    // Nothing adaptive to say yet — render nothing rather than a
    // placeholder (#244). The card's controls still show; only the
    // status sentence is absent.
    no_data: null,
  });

/**
 * The card's status sentence for a rhythm, or `null` for "say nothing".
 * Defensive on the reason: the response schema already narrows it, but an
 * unknown code (older client, newer server) must disappear, not crash or
 * placeholder — same fall-back posture as `fromServer`'s enum handling.
 */
export function rhythmStatusLine(rhythm: Rhythm): string | null {
  const line = STATUS_LINES[rhythm.reason];
  return line ? line(rhythm) : null;
}

/** Every reason code, exported for the §9 copy sweep in test/rhythm.test.ts. */
export const RHYTHM_REASONS: readonly RhythmReason[] = Object.freeze(
  Object.keys(STATUS_LINES),
) as readonly RhythmReason[];

/**
 * Upper bound for the "never fewer than" control: 1..7, and never more
 * than the user's active-days count in effect (#327 acceptance) — a
 * floor above the ceiling would be a control that promises days the
 * schedule cannot contain.
 */
export function minPerWeekMax(activeDaysCount: number): number {
  return Math.min(7, Math.max(1, Math.trunc(activeDaysCount)));
}

/** The selectable values, 1..`minPerWeekMax` — driving the control from this list is what makes out-of-range unrepresentable. */
export function minPerWeekOptions(activeDaysCount: number): number[] {
  return Array.from({ length: minPerWeekMax(activeDaysCount) }, (_, i) => i + 1);
}

/** Clamp a stored `minPerWeek` into the control's range (a user can narrow `activeDays` after setting a larger floor). */
export function clampMinPerWeek(value: number, activeDaysCount: number): number {
  return Math.min(Math.max(1, Math.trunc(value)), minPerWeekMax(activeDaysCount));
}

/** Option label — "1 day a week" / "3 days a week": words around the one permitted schedule number. */
export function minPerWeekLabel(n: number): string {
  return n === 1 ? '1 day a week' : `${n} days a week`;
}
