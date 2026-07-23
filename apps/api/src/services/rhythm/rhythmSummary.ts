/**
 * P8 (#327): composes the `rhythm` object served on `GET`/`PUT
 * /v1/preferences` — the transparency half of the adaptive engine
 * (epic #312: "a settings surface that says, in words, what the rhythm
 * currently is and why"; the words themselves live in the web client's
 * reason-code → copy map, never here).
 *
 * ## What this is, and is not
 *
 * A pure summary over the STORED preferences row — the engine's last
 * persisted decision plus the user's own bounds. It deliberately reads no
 * attendance signals and runs no policy: the signals are §9-guarded
 * server-side aggregates (attendanceSignals.ts), and re-deriving a fresh
 * decision on every GET would let a preferences fetch move the ladder.
 * What the card shows is what the daily run last decided, which is also
 * the state the next run will start from.
 *
 * ## Bounds mirror `decideCadence`'s immediate clamps
 *
 * The stored `adaptive_days_per_week` can sit outside the user's CURRENT
 * bounds when they just edited `active_days`/`min_per_week` and no daily
 * run has re-evaluated yet. `decideCadence` clamps immediately in that
 * case (`at_ceiling`/`at_floor` — "their hand, not ours"), so this
 * summary applies the same clamp with the same reason codes: the card
 * must describe the schedule the engine would actually run, not a stale
 * intermediate the user's own edit already overruled.
 *
 * §9 (structural): the return type is the shared `Rhythm` contract, whose
 * schema is `.strict()` — aggregates only, no attendance vocabulary, no
 * per-day history. See `RhythmSchema` in shared-contracts.
 */
import { RhythmReasonSchema, type Rhythm, type RhythmReason } from '@kairos/shared-contracts';
import type { PreferencesRow } from '../../db/repositories/preferencesRepository.js';
import type { CadenceReason } from './cadencePolicy.js';

/**
 * Compile-time lockstep between the wire enum (shared-contracts) and the
 * engine's `CadenceReason` union (cadencePolicy.ts): each must be
 * assignable to the other, so adding a code to either without the other
 * fails `tsc` here rather than surfacing as a card that cannot render.
 */
type ReasonEnumsAligned = [
  CadenceReason extends RhythmReason ? true : never,
  RhythmReason extends CadenceReason ? true : never,
];
const _reasonEnumsAligned: ReasonEnumsAligned = [true, true];
void _reasonEnumsAligned;

/** The slice of the preferences row the summary reads — everything the daily run's policy also reads, minus the clock. */
export type RhythmSummaryRow = Pick<
  PreferencesRow,
  'active_days' | 'min_per_week' | 'adaptive_enabled' | 'adaptive_days_per_week' | 'adaptive_reason'
>;

/**
 * Pure (row in, `Rhythm` out) — same replayability standard as
 * `decideCadence`, and tested to the same closed-shape bar
 * (tests/services/rhythm/rhythmSummary.test.ts).
 */
export function composeRhythm(row: RhythmSummaryRow): Rhythm {
  // Same normalization as decideCadence: de-duplicated day set, and a
  // floor never above the ceiling. Math.max(1, …) guards a legacy or
  // corrupt row (the contract requires ≥1 active day) so the wire schema's
  // `min(1)` can never be violated by a summary of bad storage.
  const ceiling = Math.max(1, new Set(row.active_days).size);
  const floor = Math.min(Math.max(1, row.min_per_week), ceiling);
  const minPerWeek = Math.min(Math.max(1, row.min_per_week), 7);

  // The opt-out beats everything, exactly as in the policy: fixed users
  // run their full stated day set whatever state the engine left behind.
  if (!row.adaptive_enabled) {
    return { mode: 'fixed', daysPerWeek: ceiling, minPerWeek, reason: 'fixed_by_user' };
  }

  const raw = row.adaptive_days_per_week ?? ceiling;
  if (raw > ceiling) {
    return { mode: 'adaptive', daysPerWeek: ceiling, minPerWeek, reason: 'at_ceiling' };
  }
  if (raw < floor) {
    return { mode: 'adaptive', daysPerWeek: floor, minPerWeek, reason: 'at_floor' };
  }

  // The stored reason survived a CHECK constraint (migration
  // 1722500000000), but like `stillness` on the read path it is re-parsed
  // rather than trusted: an out-of-band value degrades to `no_data`
  // (which renders no adaptive sentence) instead of failing the whole
  // preferences GET or feeding the copy map a code it cannot render.
  const parsed = RhythmReasonSchema.safeParse(row.adaptive_reason).data ?? 'no_data';
  // A stored `fixed_by_user` under `adaptive_enabled = true` is a relic of
  // a toggle-off-then-on round trip (the daily run only persists on state
  // *changes*, so re-enabling does not immediately overwrite it). Serving
  // it would caption an adaptive schedule "your schedule is fixed" — a
  // confidently wrong sentence, which #193 ranks below silence — so it
  // degrades to `no_data` (no adaptive sentence) until the next real
  // decision writes a truthful code.
  const reason = parsed === 'fixed_by_user' ? 'no_data' : parsed;
  return { mode: 'adaptive', daysPerWeek: raw, minPerWeek, reason };
}
