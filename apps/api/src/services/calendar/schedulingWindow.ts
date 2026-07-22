import { DateTime } from 'luxon';

/**
 * Zone-aware construction of the daily scheduling window (issue #205).
 *
 * ## Why this module exists
 *
 * `preferences.window_start_local` / `window_end_local` are **local wall-clock
 * times** (Postgres `time`, e.g. `07:00:00`). Until #205 both callers built the
 * freeBusy window with `new Date(date + 'T00:00:00Z')` followed by
 * `setUTCHours(h, m)`, which interprets that wall clock as **UTC**. Every user
 * on earth was therefore searched at 07:00–09:00 UTC — 03:00–05:00 in New York,
 * which is the 3:30am devotional observed on 2026-07-18.
 *
 * The defect survived review for months because `users.timezone` *is* passed to
 * `getFreeBusyBlocks({ timeZone })` and `analyzeBusyness`. That zone changes how
 * returned busy blocks are *interpreted*; it never touched the window *bounds*.
 * "The value is passed to a function" read like proof and was not (docs/16 §2b,
 * issue #193). The bounds are now resolved here, in one place, and returned as
 * concrete instants so tests can assert them directly rather than asserting that
 * a timezone string was forwarded somewhere.
 *
 * ## DST policy (deliberate — see #205 acceptance)
 *
 * Local wall-clock times are not a total function of instants. Twice a year:
 *
 * - **Spring forward**: 02:00–03:00 local does not exist. Luxon does *not*
 *   return an invalid DateTime here; it shifts the request forward by the size
 *   of the gap (`02:30` America/New_York on 2026-03-08 resolves to 03:30 local
 *   = 07:30Z). We **accept** that: the clock skipped the requested minute, so
 *   the honest reading of "start my window at 02:30" is "start at the first
 *   real instant at or after it".
 *
 *   The hazard this creates is subtle and is why `degenerate` exists. A skipped
 *   *start* shifts forward while an unskipped *end* does not, so bounds can
 *   **invert**: `02:30`→07:30Z but `03:00`→07:00Z. An inverted window is not
 *   merely useless, it is a hard 400 from Google's freeBusy API. We therefore
 *   clamp `timeMax` up to `timeMin` (a zero-length window) and set
 *   `degenerate: true` so callers can skip the API call entirely rather than
 *   fail the whole devotional.
 *
 * - **Fall back**: 01:00–02:00 local happens twice. Luxon resolves ambiguous
 *   times to the **first** (earlier-offset) occurrence, and we accept that too.
 *   Taking the earlier start can only make the window longer in real elapsed
 *   time, never shorter, so the user gets *more* candidate gap space inside
 *   what they would still recognise as their morning. Silently preferring the
 *   later occurrence would be the option that can shrink a window to nothing.
 *
 * Both policies are exercised on real transition dates by
 * `tests/services/calendar/schedulingWindow.test.ts`, in both hemispheres —
 * southern-hemisphere DST runs opposite to the north, so a northern-only test
 * would pass with the sign of the correction reversed.
 */

/** Fallbacks match the `preferences` table defaults (migration `1720000000000_init-schema`). */
const DEFAULT_WINDOW_START = { hour: 7, minute: 0 };
const DEFAULT_WINDOW_END = { hour: 9, minute: 0 };

export interface ResolveSchedulingWindowParams {
  /** Calendar date the window sits on, `YYYY-MM-DD`, interpreted **in `timeZone`** — not in UTC. */
  date: string;
  /** `preferences.window_start_local` — `HH:MM` or `HH:MM:SS` local wall clock. */
  windowStartLocal: string;
  /** `preferences.window_end_local` — `HH:MM` or `HH:MM:SS` local wall clock. */
  windowEndLocal: string;
  /** IANA zone from `users.timezone` (#187). Unsupported values fall back to UTC. */
  timeZone: string;
}

export interface ResolvedSchedulingWindow {
  /** Absolute instant, ISO-8601 UTC — safe to hand to freeBusy as `timeMin`. */
  timeMin: string;
  /** Absolute instant, ISO-8601 UTC — always `>= timeMin`. */
  timeMax: string;
  /** The zone actually used: `params.timeZone`, or `'UTC'` if it was unsupported. */
  timeZone: string;
  /**
   * True when the requested wall-clock window collapsed to (or inverted into)
   * zero length — only reachable across a spring-forward gap. Callers should
   * skip the freeBusy call: there is no window to search.
   */
  degenerate: boolean;
  /** True when `params.timeZone` was not a supported IANA zone and UTC was substituted. */
  zoneFallback: boolean;
}

/**
 * Parse `HH:MM[:SS]` into wall-clock components.
 *
 * Returns `null` rather than a partially-parsed value on anything malformed, so
 * a junk preference degrades to the documented default instead of silently
 * becoming hour 0 via `Number('') === 0` / `NaN`.
 */
function parseWallClock(value: string): { hour: number; minute: number } | null {
  const parts = value.split(':');
  if (parts.length < 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  // Hour 24 is legal in Postgres `time` but is not a valid luxon hour; it is
  // also not reachable through the API (shared-contracts rejects it). Excluded
  // here so it degrades to the default rather than producing an invalid
  // DateTime we would then have to interpret.
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Resolve a local wall-clock preference window into absolute UTC instants.
 *
 * This is the single place where a wall-clock preference meets a UTC instant;
 * both `generateNowOrchestrator.runCalendarStep` and
 * `rescheduleWatcher.checkAndRescheduleOne` go through it so the two can never
 * drift back apart (they had independently copied the same `setUTCHours` bug).
 */
export function resolveSchedulingWindow(
  params: ResolveSchedulingWindowParams,
): ResolvedSchedulingWindow {
  const { date, windowStartLocal, windowEndLocal } = params;

  // An unsupported zone must not silently resolve against the *server's* local
  // zone — that would reintroduce a host-dependent version of this very bug.
  // UTC is the same default `users.timezone` carries at signup, so falling back
  // to it is the documented no-signal behavior, not a new one.
  const zoneIsValid = DateTime.local().setZone(params.timeZone).isValid;
  const timeZone = zoneIsValid ? params.timeZone : 'UTC';

  const start = parseWallClock(windowStartLocal) ?? DEFAULT_WINDOW_START;
  const end = parseWallClock(windowEndLocal) ?? DEFAULT_WINDOW_END;

  // Validate the date up front. `DateTime.fromObject` throws its own opaque
  // "Invalid unit value NaN" on malformed components, which gives a caller no
  // idea which input was at fault; and unlike the wall-clock times there is no
  // sensible default to fall back to, since the date IS the request.
  const dateParts = date.split('-').map(Number);
  const [year, month, day] = dateParts;
  if (dateParts.length !== 3 || dateParts.some((n) => !Number.isInteger(n))) {
    throw new Error(`Cannot resolve scheduling window: date="${date}" is not YYYY-MM-DD`);
  }

  const build = (wall: { hour: number; minute: number }): DateTime =>
    DateTime.fromObject(
      { year, month, day, hour: wall.hour, minute: wall.minute, second: 0, millisecond: 0 },
      { zone: timeZone },
    );

  const startDT = build(start);
  let endDT = build(end);

  // Guard the one case luxon reports as invalid rather than coercing: a
  // malformed `date`. Never let an invalid DateTime reach `.toISO()`, which
  // returns null and would type-launder into a bogus string downstream.
  if (!startDT.isValid || !endDT.isValid) {
    throw new Error(
      `Cannot resolve scheduling window for date="${date}" zone="${timeZone}": ${startDT.invalidReason ?? endDT.invalidReason}`,
    );
  }

  // Spring-forward inversion guard — see the DST policy note above.
  let degenerate = false;
  if (endDT <= startDT) {
    degenerate = true;
    endDT = startDT;
  }

  return {
    timeMin: startDT.toUTC().toISO()!,
    timeMax: endDT.toUTC().toISO()!,
    timeZone,
    degenerate,
    zoneFallback: !zoneIsValid,
  };
}

/**
 * The calendar date an instant falls on **in `timeZone`** (`YYYY-MM-DD`).
 *
 * `someDate.toISOString().slice(0, 10)` is the UTC date, which is the wrong day
 * for a large share of users: a Sydney user's 07:00 gap on Jan 15 is 20:00Z on
 * Jan **14**. `rescheduleWatcher` used exactly that to re-derive the window for
 * an existing event, so it rebuilt the window for the previous local day — the
 * same wall-clock-meets-UTC defect class as #205 itself, one layer up.
 */
export function localCalendarDate(instant: Date, timeZone: string): string {
  const dt = DateTime.fromJSDate(instant, { zone: timeZone });
  // Same UTC fallback rationale as resolveSchedulingWindow.
  return (dt.isValid ? dt : DateTime.fromJSDate(instant, { zone: 'UTC' })).toISODate()!;
}
