/**
 * BusynessAnalyzer — free/busy blocks -> `busyness` band + ranked candidate
 * gaps (EPIC C, issue #23).
 *
 * Pure logic, no external dependency (no network, no DB, no clock reads
 * beyond what's passed in). Timezone/DST-aware via `luxon` `DateTime` —
 * never hand-rolled offset math (docs/07_TEST_PLAN.md §1 "Backend unit
 * detail").
 *
 * Contract: docs/00_FOUNDATION.md §5 (`busyness` band enum: light/moderate/
 * heavy); docs/02_ARCHITECTURE.md §2.1 ("BusynessAnalyzer: free/busy blocks
 * in the user's window -> busyness band + ranked candidate gaps
 * (longest-gap-first, avoiding first/last 30 min of day, buffer >=10 min
 * around meetings)"); docs/03_API_INTEGRATION_SPEC.md §4.1 (freebusy.query
 * feeds this; blocks are processed in memory, never persisted).
 *
 * ## Inputs
 *
 * - `window`: the user's workday window, as timezone-aware ISO instants
 *   plus the IANA zone they're anchored to (e.g. a 07:00-21:00 local window
 *   on a given calendar day). The window bounds MUST already carry an
 *   offset/zone — this module does no "local wall time" interpretation of
 *   naive strings.
 * - `busyBlocks`: raw freebusy blocks for that same window. Each block is
 *   `{ start, end }` (timezone-aware) or `{ start, end, allDay: true }`.
 *   All-day blocks are a special case (see below) — they never contribute
 *   busy minutes and are excluded from the packing/gap-finding math, since
 *   Google Calendar represents "all day" events as calendar-transparent by
 *   default and they do not represent a real scheduling collision inside a
 *   specific hour of the day.
 *
 * ## Busyness band thresholds
 *
 * Foundation §5 specifies the derivation *inputs* (meeting count, busy
 * minutes, gap availability) but not exact thresholds — none are pinned
 * elsewhere in docs/. This module picks a documented, single-sourced
 * default (`DEFAULT_BUSYNESS_THRESHOLDS`) based on fraction of the window
 * consumed by real (non-all-day) busy time:
 *
 *   - `light`:    busyFraction <  0.25
 *   - `moderate`: busyFraction >= 0.25 and < 0.60
 *   - `heavy`:    busyFraction >= 0.60
 *
 * Thresholds are injectable (`BusynessThresholds`) so this can be tuned
 * without touching the packing logic. Flagged for confirmation against a
 * real usage sample post-MVP.
 *
 * ## Gap-finding rules (Architecture §2.1, verbatim)
 *
 * - Longest-gap-first ranking.
 * - Exclude the first and last 30 minutes of the window (a gap must start
 *   at or after `windowStart + 30min` and end at or before
 *   `windowEnd - 30min`).
 * - Require a >=10-minute buffer around existing (non-all-day) meetings —
 *   i.e. a gap's usable region shrinks by 10 minutes on each side that
 *   touches a real meeting (not on a side that touches the window edge,
 *   which is already governed by the 30-minute edge rule above).
 */

import { DateTime } from 'luxon';

export type BusynessBand = 'light' | 'moderate' | 'heavy';

/** A single free/busy block as returned by a calendar freebusy query. */
export interface BusyBlock {
  /** Timezone-aware ISO 8601 instant, e.g. "2026-03-08T09:00:00-05:00". */
  start: string;
  /** Timezone-aware ISO 8601 instant. Must be > start (all-day excepted). */
  end: string;
  /**
   * All-day events (Google Calendar "transparent" whole-day blocks) are
   * calendar-visible but not a real scheduling collision at any specific
   * hour. They are excluded from busy-minute totals and from gap-blocking
   * entirely — Architecture §2.1 / Foundation §5 define busyness from
   * *meeting* count and busy *minutes*, not all-day markers.
   */
  allDay?: boolean;
}

/** The user's workday window for a given calendar day, timezone-aware. */
export interface BusyWindow {
  /** Timezone-aware ISO 8601 instant marking the start of the workday window. */
  start: string;
  /** Timezone-aware ISO 8601 instant marking the end of the workday window. */
  end: string;
  /**
   * IANA timezone the window is anchored to (e.g. "America/New_York").
   * Used to interpret the window/blocks with real calendar (DST-aware)
   * semantics, not fixed-offset arithmetic.
   */
  timeZone: string;
}

export interface CandidateGap {
  /** ISO 8601 instant, in `window.timeZone`. */
  start: string;
  /** ISO 8601 instant, in `window.timeZone`. */
  end: string;
  durationMinutes: number;
}

export interface BusynessThresholds {
  /** busyFraction below this -> 'light'. */
  lightMax: number;
  /** busyFraction below this (and >= lightMax) -> 'moderate'; >= this -> 'heavy'. */
  moderateMax: number;
}

export const DEFAULT_BUSYNESS_THRESHOLDS: BusynessThresholds = {
  lightMax: 0.25,
  moderateMax: 0.6,
};

/** Architecture §2.1: exclude first/last 30 min of window from gap candidates. */
export const WINDOW_EDGE_BUFFER_MINUTES = 30;
/** Architecture §2.1: >=10-minute buffer required around existing meetings. */
export const MEETING_BUFFER_MINUTES = 10;

export interface BusynessAnalysis {
  busyness: BusynessBand;
  /** Total minutes covered by non-all-day busy blocks, clipped to the window. */
  busyMinutes: number;
  /** Length of the window in minutes. */
  windowMinutes: number;
  /** busyMinutes / windowMinutes, in [0, 1]. */
  busyFraction: number;
  /** Count of non-all-day meetings that overlap the window (post-merge). */
  meetingCount: number;
  /** Whether any all-day block overlapped the window (informational only). */
  hasAllDayEvent: boolean;
  /** Ranked candidate gaps, longest first; ties broken by earlier start. */
  gaps: CandidateGap[];
}

class BusynessAnalyzerError extends Error {}

/** Matches a trailing `Z` or a numeric UTC offset (`+05:00`, `-0800`, etc). */
const ISO_OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

function parseInstant(iso: string, timeZone: string, label: string): DateTime {
  // docs/14 §3.8 / issue #90: luxon's `setZone: true` silently interprets an
  // offset-less ("naive") ISO string in the process's own default zone
  // (UTC on Cloud Run) rather than erroring — a naive timestamp from an
  // upstream calendar provider would then be silently misinterpreted
  // instead of rejected.
  if (!ISO_OFFSET_RE.test(iso)) {
    throw new BusynessAnalyzerError(
      `BusynessAnalyzer: ${label} "${iso}" has no UTC offset/zone designator — naive timestamps are rejected, not interpreted in the process timezone`,
    );
  }
  const dt = DateTime.fromISO(iso, { setZone: true }).setZone(timeZone);
  if (!dt.isValid) {
    throw new BusynessAnalyzerError(
      `BusynessAnalyzer: invalid ${label} "${iso}": ${dt.invalidReason} ${dt.invalidExplanation ?? ''}`.trim(),
    );
  }
  return dt;
}

interface Interval {
  start: DateTime;
  end: DateTime;
}

/** Merge overlapping/adjacent intervals (sorted by start) into disjoint blocks. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.toMillis() - b.start.toMillis());
  const first = sorted[0];
  if (!first) return [];
  const merged: Interval[] = [{ start: first.start, end: first.end }];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (!current || !last) continue;
    if (current.start.toMillis() <= last.end.toMillis()) {
      if (current.end.toMillis() > last.end.toMillis()) {
        last.end = current.end;
      }
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

/**
 * Analyze a set of free/busy blocks against a workday window and return
 * the busyness band plus ranked candidate gaps.
 */
export function analyzeBusyness(
  window: BusyWindow,
  busyBlocks: BusyBlock[],
  thresholds: BusynessThresholds = DEFAULT_BUSYNESS_THRESHOLDS,
): BusynessAnalysis {
  const windowStart = parseInstant(window.start, window.timeZone, 'window.start');
  const windowEnd = parseInstant(window.end, window.timeZone, 'window.end');
  if (windowEnd.toMillis() <= windowStart.toMillis()) {
    throw new BusynessAnalyzerError('BusynessAnalyzer: window.end must be after window.start');
  }

  let hasAllDayEvent = false;

  // Parse, clip to window, and split real (non-all-day) blocks from all-day.
  const realIntervals: Interval[] = [];
  for (const block of busyBlocks) {
    const blockStart = parseInstant(block.start, window.timeZone, 'busyBlock.start');
    const blockEnd = parseInstant(block.end, window.timeZone, 'busyBlock.end');
    if (blockEnd.toMillis() <= blockStart.toMillis()) {
      // Degenerate/zero-duration block: ignore rather than throw — a
      // freebusy provider quirk should not crash the whole analysis.
      continue;
    }

    if (block.allDay) {
      // All-day events never count as busy minutes and never block gaps;
      // they only surface via `hasAllDayEvent` for informational display.
      if (blockEnd.toMillis() > windowStart.toMillis() && blockStart.toMillis() < windowEnd.toMillis()) {
        hasAllDayEvent = true;
      }
      continue;
    }

    // Clip to window (handles events that start before / end after it).
    const clippedStart = blockStart.toMillis() > windowStart.toMillis() ? blockStart : windowStart;
    const clippedEnd = blockEnd.toMillis() < windowEnd.toMillis() ? blockEnd : windowEnd;
    if (clippedEnd.toMillis() <= clippedStart.toMillis()) {
      // Entirely outside the window.
      continue;
    }
    realIntervals.push({ start: clippedStart, end: clippedEnd });
  }

  const mergedMeetings = mergeIntervals(realIntervals);

  const windowMinutes = windowEnd.diff(windowStart, 'minutes').minutes;
  const busyMinutes = mergedMeetings.reduce(
    (sum, iv) => sum + iv.end.diff(iv.start, 'minutes').minutes,
    0,
  );
  const busyFraction = windowMinutes > 0 ? busyMinutes / windowMinutes : 0;

  const busyness = deriveBand(busyFraction, thresholds);

  const gaps = findCandidateGaps(windowStart, windowEnd, mergedMeetings);

  return {
    busyness,
    busyMinutes: round2(busyMinutes),
    windowMinutes: round2(windowMinutes),
    busyFraction: round4(busyFraction),
    meetingCount: mergedMeetings.length,
    hasAllDayEvent,
    gaps,
  };
}

function deriveBand(busyFraction: number, thresholds: BusynessThresholds): BusynessBand {
  if (busyFraction < thresholds.lightMax) return 'light';
  if (busyFraction < thresholds.moderateMax) return 'moderate';
  return 'heavy';
}

/**
 * Build the ranked candidate-gap list.
 *
 * Algorithm: shrink the window by the 30-minute edge buffer, then walk the
 * merged, in-window meetings left to right, applying a 10-minute buffer to
 * each side of a gap that touches a real meeting (not to a side that
 * touches the (already-shrunk) window edge). Any resulting gap with
 * positive duration is a candidate; the list is sorted longest-first with
 * ties broken by earlier start (stable, deterministic).
 */
function findCandidateGaps(
  windowStart: DateTime,
  windowEnd: DateTime,
  meetings: Interval[],
): CandidateGap[] {
  const usableStart = windowStart.plus({ minutes: WINDOW_EDGE_BUFFER_MINUTES });
  const usableEnd = windowEnd.minus({ minutes: WINDOW_EDGE_BUFFER_MINUTES });

  if (usableEnd.toMillis() <= usableStart.toMillis()) {
    // Window too short for the edge buffers to leave any usable region.
    return [];
  }

  const gaps: CandidateGap[] = [];
  let cursor = usableStart;

  for (const meeting of meetings) {
    // A meeting entirely outside the usable region doesn't split it.
    if (meeting.end.toMillis() <= usableStart.toMillis() || meeting.start.toMillis() >= usableEnd.toMillis()) {
      continue;
    }

    // The gap ends 10 min before this meeting starts (buffer), clamped to
    // the usable region — unless the meeting starts before `cursor`
    // (overlapping/back-to-back run), in which case there's no gap here.
    const meetingBufferStart = meeting.start.minus({ minutes: MEETING_BUFFER_MINUTES });
    const gapEnd = clampDT(meetingBufferStart, usableStart, usableEnd);
    pushGapIfPositive(gaps, cursor, gapEnd);

    // Next cursor starts 10 min after this meeting ends (buffer), clamped.
    const meetingBufferEnd = meeting.end.plus({ minutes: MEETING_BUFFER_MINUTES });
    const nextCursor = clampDT(meetingBufferEnd, usableStart, usableEnd);
    if (nextCursor.toMillis() > cursor.toMillis()) {
      cursor = nextCursor;
    }
  }

  // Trailing gap after the last meeting (or the whole usable region if
  // there were no in-window meetings at all).
  pushGapIfPositive(gaps, cursor, usableEnd);

  gaps.sort((a, b) => {
    if (b.durationMinutes !== a.durationMinutes) return b.durationMinutes - a.durationMinutes;
    return DateTime.fromISO(a.start).toMillis() - DateTime.fromISO(b.start).toMillis();
  });

  return gaps;
}

function clampDT(dt: DateTime, min: DateTime, max: DateTime): DateTime {
  if (dt.toMillis() < min.toMillis()) return min;
  if (dt.toMillis() > max.toMillis()) return max;
  return dt;
}

function pushGapIfPositive(gaps: CandidateGap[], start: DateTime, end: DateTime): void {
  const durationMinutes = end.diff(start, 'minutes').minutes;
  if (durationMinutes > 0) {
    gaps.push({
      start: start.toISO() as string,
      end: end.toISO() as string,
      durationMinutes: round2(durationMinutes),
    });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export { BusynessAnalyzerError };
