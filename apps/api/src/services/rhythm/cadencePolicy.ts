/**
 * P5: cadence policy engine v1 (Epic P #312, issue #324) — the pure,
 * deterministic, bounded rules engine that turns P4's attendance signals
 * into "which of the user's active days get a devotional this week".
 * Explicitly NOT ML (epic decision #1): every decision is a pure function
 * with a reason code, replayable in a test and explainable in a settings
 * sentence.
 *
 * ## Invariants (property-tested in cadencePolicy.test.ts)
 *
 *  - `floor ≤ daysPerWeek ≤ ceiling` always, where floor =
 *    `min_per_week` clamped to the day set and ceiling = `|active_days|`.
 *    The user's stated preference is a ceiling the engine adapts UNDER,
 *    never overrides.
 *  - |Δ| ≤ 1 per decision (except boundary clamps after the user edits
 *    `active_days`/`min_per_week` — honoring their edit immediately beats
 *    gradualism, because the bound moved, not the engine's opinion).
 *  - ≥7 days between engine-initiated steps (`adaptive_decided_at` is
 *    the limiter's clock — see `updateAdaptiveState`).
 *  - `adaptive_enabled = false` bypasses everything, before any signal is
 *    read.
 *  - Distress can never surface here: the distress path inserts no
 *    calendar event, so it is outside P4's denominator by construction,
 *    and this function receives nothing that could distinguish a
 *    distress-heavy week from an ordinary one.
 *
 * ## Reason-code truth table (the engine ↔ copy API; prose is P8's job)
 *
 *  | condition                                              | days       | reason           |
 *  |--------------------------------------------------------|------------|------------------|
 *  | adaptive_enabled = false                               | ceiling    | `fixed_by_user`  |
 *  | stored state above ceiling (user shrank active_days)   | ceiling    | `at_ceiling`     |
 *  | stored state below floor (user raised min_per_week)    | floor      | `at_floor`       |
 *  | no scheduled history in window                         | current    | `no_data`        |
 *  | back-off pressure, already at floor                    | floor      | `at_floor`       |
 *  | back-off pressure, step allowed                        | current − 1| `easing_back`    |
 *  | back-off pressure, stepped <7 days ago                 | current    | `hold`           |
 *  | re-engaged after back-off, already at ceiling          | ceiling    | `at_ceiling`     |
 *  | re-engaged after back-off, step allowed                | current + 1| `welcoming_back` |
 *  | re-engaged after back-off, stepped <7 days ago         | current    | `hold`           |
 *  | otherwise                                              | current    | `hold`           |
 *
 * ("back-off pressure" = `consecutiveUnjoined ≥ 3` AND not re-engaged —
 * see the precedence note in the code: a re-engaged user is never
 * reduced further, whatever the trailing scheduled run says.)
 */
import type { AttendanceSignals } from './attendanceSignals.js';

/**
 * Reason codes, CHECK-constrained in the DB (migration 1722500000000).
 * Enums only — no decision anywhere carries a count of missed sessions;
 * §9-safe prose over these codes lives in P8 (#327).
 */
export type CadenceReason =
  | 'fixed_by_user'
  | 'easing_back'
  | 'welcoming_back'
  | 'hold'
  | 'at_floor'
  | 'at_ceiling'
  | 'no_data';

/** Consecutive unjoined scheduled invitations before the engine eases back (epic: "3+"). */
export const BACKOFF_UNJOINED_THRESHOLD = 3;

/** Minimum days between engine-initiated steps — "max one step per calendar week", enforced as ≥7 days since the last state change. */
export const MIN_DAYS_BETWEEN_STEPS = 7;

/**
 * The preference slice the policy reads — field-for-field from the
 * `preferences` row (camelCased), all time arriving as data.
 */
export interface CadencePolicyPrefs {
  /** The user's stated day set (0=Sunday..6=Saturday) — the ceiling AND the pool effective days are drawn from. */
  activeDays: readonly number[];
  /** The floor (1..7); clamped to `|active_days|` when their day set is smaller. */
  minPerWeek: number;
  /** false = "keep my schedule fixed": engine fully bypassed. */
  adaptiveEnabled: boolean;
  /** Engine state: current effective days/week, or null if never adapted (treated as ceiling). */
  adaptiveDaysPerWeek: number | null;
  /** When the engine state last changed — the one-step-per-week limiter's clock. Null = never. */
  adaptiveDecidedAt: Date | null;
}

export interface CadenceDecision {
  daysPerWeek: number;
  /** First `daysPerWeek` of the user's active days in week order — deterministic and boring on purpose. */
  effectiveDays: number[];
  reason: CadenceReason;
}

const MS_PER_DAY = 86_400_000;

/**
 * De-duplicated, ascending week order (0=Sunday first — the same
 * ordering migration 1722100000000's include-Sunday default writes and
 * `normalizeDays` in shared-contracts produces). "Which days survive
 * when N < |active_days|" must have one boring answer, and this is it.
 */
function normalizeDays(days: readonly number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * The decision function. Pure: no I/O, no clock reads — `clock.now` is
 * injected precisely so the same (signals, prefs, now) triple replays to
 * the same decision in a test or a P8 explanation.
 *
 * `clock` is a third parameter rather than a field smuggled into
 * `signals` (whose shape is §9-pinned closed) or `prefs` (which mirrors
 * the preferences row): the one-step-per-week limiter needs "days since
 * last decision", and that subtraction is decision logic, so its inputs
 * must all be arguments.
 */
export function decideCadence(
  signals: AttendanceSignals,
  prefs: CadencePolicyPrefs,
  clock: { now: Date },
): CadenceDecision {
  const days = normalizeDays(prefs.activeDays);
  const ceiling = days.length;

  // Rule 1 — the opt-out beats everything, before any signal is read:
  // "keep my schedule fixed" means exactly the stated days, always.
  if (!prefs.adaptiveEnabled) {
    return { daysPerWeek: ceiling, effectiveDays: days, reason: 'fixed_by_user' };
  }

  // Rule 2 — bounds. Floor is min_per_week, but never above the ceiling:
  // a user with 3 active days and min_per_week 5 gets 3 (their day set
  // is the outer bound on everything). Math.max(1, …) only guards a
  // nonsense stored value; the DB CHECK keeps min_per_week in 1..7.
  const floor = Math.min(Math.max(1, prefs.minPerWeek), ceiling);
  const raw = prefs.adaptiveDaysPerWeek ?? ceiling;

  // Immediate clamps — the user's EDIT moved a bound, and honoring it now
  // beats gradualism (acceptance: "edits active_days below current
  // adaptive level → immediate clamp, at_ceiling"). Exempt from the
  // 7-day limiter for the same reason: this is their hand, not ours.
  if (raw > ceiling) {
    return { daysPerWeek: ceiling, effectiveDays: days, reason: 'at_ceiling' };
  }
  if (raw < floor) {
    return { daysPerWeek: floor, effectiveDays: days.slice(0, floor), reason: 'at_floor' };
  }

  const current = raw;
  const pick = (n: number, reason: CadenceReason): CadenceDecision => ({
    daysPerWeek: n,
    effectiveDays: days.slice(0, n),
    reason,
  });

  // Rule 3 — no data, no change. Zero scheduled invitations in the window
  // means the absence is OUR doing (no calendar connected, brand-new
  // user, a paused stretch), never theirs; a new user holds at the
  // ceiling (`raw` defaulted to it above) and gets their full stated
  // schedule.
  if (signals.scheduledCount === 0) {
    return pick(current, 'no_data');
  }

  const canStep =
    prefs.adaptiveDecidedAt === null ||
    clock.now.getTime() - prefs.adaptiveDecidedAt.getTime() >= MIN_DAYS_BETWEEN_STEPS * MS_PER_DAY;

  // Precedence: re-engagement is checked BEFORE back-off pressure, so a
  // user with a fresh join can never be eased back in the same breath.
  // The trailing unjoined run counts only scheduled invitations, so
  // someone leaning on generate-now during a backed-off stretch can show
  // 3+ unjoined AND a recent join — and a join may only ever count FOR
  // them (the epic's exemption clause, same grace as distress).
  if (signals.reengagedSinceBackoff) {
    if (current >= ceiling) return pick(ceiling, 'at_ceiling');
    if (!canStep) return pick(current, 'hold');
    return pick(current + 1, 'welcoming_back');
  }

  // Rule 4 — back-off: 3+ consecutive unjoined scheduled invitations,
  // one step down, never below the floor, at most one step per week.
  if (signals.consecutiveUnjoined >= BACKOFF_UNJOINED_THRESHOLD) {
    if (current <= floor) return pick(floor, 'at_floor');
    if (!canStep) return pick(current, 'hold');
    return pick(current - 1, 'easing_back');
  }

  return pick(current, 'hold');
}
