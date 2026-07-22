/**
 * loadTodaysBusyness — small glue helper wiring `CandidateSlotsRepository`
 * (real `/v1/slots` uploads) into `BusynessAnalyzer` (docs/14
 * §4.1 step 3, issue #74: "Wire BusynessAnalyzer against real slot data").
 *
 * `BusynessAnalyzer.analyzeBusyness` treats its `busyBlocks` input as
 * BUSY time (docs/02_ARCHITECTURE.md §2.1 / busynessAnalyzer.ts: "free/busy
 * blocks ... busyness band + ranked candidate gaps"). `POST /v1/slots`
 * instead uploads FREE candidate windows (docs/00_FOUNDATION.md §8 / API
 * spec §8.1 — EventKit-derived free gaps, no titles/attendees). This
 * module inverts free slots into the complement busy blocks within the
 * user's workday window before handing them to `analyzeBusyness`, so the
 * existing (already-tested) busy-block-based analyzer can be reused
 * unmodified rather than duplicating its packing/threshold logic for a
 * "free slots" input shape.
 */
import { DateTime } from 'luxon';
import {
  analyzeBusyness,
  type BusyBlock,
  type BusynessAnalysis,
  type BusynessThresholds,
  type BusyWindow,
} from '../busynessAnalyzer.js';
import type { CandidateSlotRow, CandidateSlotsRepository, VerifiedUserId } from '../../db/repositories/index.js';

/**
 * Inverts a set of FREE candidate windows (assumed already clipped/sane —
 * e.g. from EventKit) into the complement BUSY blocks inside `window`, so
 * `BusynessAnalyzer.analyzeBusyness` (which expects busy time) can consume
 * them unchanged. Free slots outside `window` are ignored; free slots are
 * sorted and merged before inverting so overlapping/adjacent uploads don't
 * produce spurious zero-length or negative busy gaps.
 */
export function invertFreeSlotsToBusyBlocks(window: BusyWindow, freeSlots: CandidateSlotRow[]): BusyBlock[] {
  const windowStart = DateTime.fromISO(window.start, { setZone: true }).setZone(window.timeZone);
  const windowEnd = DateTime.fromISO(window.end, { setZone: true }).setZone(window.timeZone);

  const clipped = freeSlots
    .map((slot) => ({
      start: DateTime.fromJSDate(slot.start_at).setZone(window.timeZone),
      end: DateTime.fromJSDate(slot.end_at).setZone(window.timeZone),
    }))
    .map((iv) => ({
      start: iv.start.toMillis() < windowStart.toMillis() ? windowStart : iv.start,
      end: iv.end.toMillis() > windowEnd.toMillis() ? windowEnd : iv.end,
    }))
    .filter((iv) => iv.end.toMillis() > iv.start.toMillis())
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const merged: Array<{ start: DateTime; end: DateTime }> = [];
  for (const iv of clipped) {
    const last = merged[merged.length - 1];
    if (last && iv.start.toMillis() <= last.end.toMillis()) {
      if (iv.end.toMillis() > last.end.toMillis()) last.end = iv.end;
    } else {
      merged.push({ ...iv });
    }
  }

  const busyBlocks: BusyBlock[] = [];
  let cursor: DateTime = windowStart;
  for (const free of merged) {
    if (free.start.toMillis() > cursor.toMillis()) {
      busyBlocks.push({ start: cursor.toISO() as string, end: free.start.toISO() as string });
    }
    if (free.end.toMillis() > cursor.toMillis()) {
      cursor = free.end;
    }
  }
  if (cursor.toMillis() < windowEnd.toMillis()) {
    busyBlocks.push({ start: cursor.toISO() as string, end: windowEnd.toISO() as string });
  }

  return busyBlocks;
}

export interface LoadTodaysBusynessParams {
  userId: VerifiedUserId;
  date: string; // YYYY-MM-DD
  window: BusyWindow;
  thresholds?: BusynessThresholds;
}

/**
 * Loads a user's uploaded candidate (FREE) slots for `date`, inverts them
 * to busy blocks, and runs `analyzeBusyness` against the given workday
 * window. When no slots have been uploaded for that date at all, there is
 * zero free-time evidence to invert, so `invertFreeSlotsToBusyBlocks`
 * returns the WHOLE window as one busy block — deliberately conservative:
 * "no calendar signal yet" must never be silently read as "so assume the
 * day is wide open," which is the wrong direction to be wrong in for a
 * product that schedules into people's actual gaps.
 */
export async function loadTodaysBusyness(
  candidateSlots: CandidateSlotsRepository,
  params: LoadTodaysBusynessParams,
): Promise<BusynessAnalysis> {
  const rows = await candidateSlots.getForDate(params.userId, params.date);
  const busyBlocks = invertFreeSlotsToBusyBlocks(params.window, rows);
  return analyzeBusyness(params.window, busyBlocks, params.thresholds);
}
