/**
 * Candidate-gap choice for the orchestrator's calendar step (P7 #326).
 *
 * Extracted so the selection rule is a pure function the tests can
 * mutation-check, and so the ONE behavioral change #326 makes to slot
 * choice is legible in a single place:
 *
 *  - **No preferred time** (the only state before #326): exactly the old
 *    behavior — take the analyzer's first gap (`analyzeBusyness` ranks
 *    longest-first) and reject it if it is under the required minutes.
 *    Byte-identical by construction, which is what keeps the
 *    zero-feedback regression true for scheduling too.
 *  - **Preferred time set** (`preferences.preferred_time_local`, fed by
 *    trailing `timeFeel` feedback): among gaps meeting the required
 *    minutes, take the one nearest the preferred instant — distance 0
 *    when the instant falls inside the gap, else distance to the nearer
 *    edge. Ties break to the earlier gap, then the longer one:
 *    deterministic and boring, the `decideCadence` standard.
 *
 * The preferred instant is resolved by the caller (it owns the date and
 * the zone the window was resolved in) via `resolvePreferredInstant`.
 */
import { DateTime } from 'luxon';
import type { CandidateGap } from '../busynessAnalyzer.js';

/**
 * `preferred_time_local` (`HH:MM:SS`) on a calendar date in a zone → the
 * concrete instant, or null when the inputs don't resolve (bad zone,
 * malformed time). Same Luxon semantics as `resolveSchedulingWindow`,
 * including its DST posture: a time erased by spring-forward resolves to
 * the first real instant after it.
 */
export function resolvePreferredInstant(
  date: string,
  timeLocal: string,
  timeZone: string,
): Date | null {
  const dt = DateTime.fromISO(`${date}T${timeLocal}`, { zone: timeZone });
  return dt.isValid ? dt.toJSDate() : null;
}

/** Distance in ms from an instant to a gap — 0 inside the gap, else distance to the nearer edge. */
function distanceMs(gap: CandidateGap, instant: Date): number {
  const t = instant.getTime();
  const start = new Date(gap.start).getTime();
  const end = new Date(gap.end).getTime();
  if (t >= start && t <= end) return 0;
  return t < start ? start - t : t - end;
}

/**
 * Pick the gap to book. `gaps` must be the analyzer's ranked list
 * (longest first, ties earlier first) — the no-preference branch leans on
 * that order being exactly what shipped before #326.
 */
export function selectGap(
  gaps: readonly CandidateGap[],
  requiredMinutes: number,
  preferredInstant: Date | null,
): CandidateGap | undefined {
  if (preferredInstant === null) {
    // Pre-#326 behavior, verbatim: only the top-ranked gap is ever
    // considered, and it must clear the floor. (Longest-first means if
    // the first fails the floor, every gap does — checking one is
    // checking all.)
    const bestGap = gaps[0];
    return bestGap && bestGap.durationMinutes >= requiredMinutes ? bestGap : undefined;
  }

  const eligible = gaps.filter((gap) => gap.durationMinutes >= requiredMinutes);
  let best: CandidateGap | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const gap of eligible) {
    const d = distanceMs(gap, preferredInstant);
    if (
      d < bestDistance ||
      (d === bestDistance &&
        best !== undefined &&
        // Instant comparison, not string comparison: around a fall-back
        // transition two ISO strings with different offsets can tie
        // lexically while naming different instants.
        (Date.parse(gap.start) < Date.parse(best.start) ||
          (Date.parse(gap.start) === Date.parse(best.start) &&
            gap.durationMinutes > best.durationMinutes)))
    ) {
      best = gap;
      bestDistance = d;
    }
  }
  return best;
}
