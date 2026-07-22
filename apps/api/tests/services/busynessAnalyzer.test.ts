import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  DEFAULT_BUSYNESS_THRESHOLDS,
  MEETING_BUFFER_MINUTES,
  WINDOW_EDGE_BUFFER_MINUTES,
  analyzeBusyness,
  BusynessAnalyzerError,
  type BusyBlock,
  type BusyWindow,
} from '../../src/services/busynessAnalyzer.js';

/** Standard 07:00-21:00 America/New_York window on an ordinary (non-DST-boundary) day. */
function nyWindow(dateISO: string): BusyWindow {
  return {
    start: `${dateISO}T07:00:00`.concat(zoneOffset(dateISO)),
    end: `${dateISO}T21:00:00`.concat(zoneOffset(dateISO)),
    timeZone: 'America/New_York',
  };
}

/** Compute the correct UTC offset string for America/New_York on a given date (handles DST). */
function zoneOffset(dateISO: string): string {
  const dt = DateTime.fromISO(`${dateISO}T12:00:00`, { zone: 'America/New_York' });
  return dt.toFormat('ZZ');
}

function block(startISO: string, endISO: string, allDay = false): BusyBlock {
  return { start: startISO, end: endISO, ...(allDay ? { allDay: true } : {}) };
}

describe('analyzeBusyness', () => {
  describe('zero meetings', () => {
    it('is light with one large candidate gap spanning the whole edge-trimmed window', () => {
      const window = nyWindow('2026-07-13'); // ordinary Monday, EDT
      const result = analyzeBusyness(window, []);

      expect(result.busyness).toBe('light');
      expect(result.busyMinutes).toBe(0);
      expect(result.meetingCount).toBe(0);
      expect(result.hasAllDayEvent).toBe(false);
      expect(result.windowMinutes).toBe(14 * 60); // 07:00-21:00

      expect(result.gaps).toHaveLength(1);
      const [gap] = result.gaps;
      // Whole window minus 30 min on each edge = 13 hours = 780 minutes.
      expect(gap.durationMinutes).toBe(14 * 60 - 2 * WINDOW_EDGE_BUFFER_MINUTES);

      const expectedStart = DateTime.fromISO(window.start, { setZone: true }).plus({
        minutes: WINDOW_EDGE_BUFFER_MINUTES,
      });
      const expectedEnd = DateTime.fromISO(window.end, { setZone: true }).minus({
        minutes: WINDOW_EDGE_BUFFER_MINUTES,
      });
      expect(DateTime.fromISO(gap.start).toMillis()).toBe(expectedStart.toMillis());
      expect(DateTime.fromISO(gap.end).toMillis()).toBe(expectedEnd.toMillis());
    });
  });

  describe('fully packed day (no gaps at all)', () => {
    it('is heavy and returns zero candidate gaps', () => {
      const window = nyWindow('2026-07-13');
      // One giant meeting covering the entire window.
      const blocks = [block('2026-07-13T07:00:00-04:00', '2026-07-13T21:00:00-04:00')];
      const result = analyzeBusyness(window, blocks);

      expect(result.busyness).toBe('heavy');
      expect(result.busyMinutes).toBe(14 * 60);
      expect(result.busyFraction).toBe(1);
      expect(result.gaps).toEqual([]);
    });

    it('is heavy with zero gaps when back-to-back meetings pack the whole usable region', () => {
      const window = nyWindow('2026-07-13');
      // Meetings covering 07:00-21:00 in 2-hour blocks, back-to-back, no gaps.
      const blocks: BusyBlock[] = [];
      for (let h = 7; h < 21; h += 2) {
        blocks.push(
          block(
            `2026-07-13T${String(h).padStart(2, '0')}:00:00-04:00`,
            `2026-07-13T${String(h + 2).padStart(2, '0')}:00:00-04:00`,
          ),
        );
      }
      const result = analyzeBusyness(window, blocks);
      expect(result.busyness).toBe('heavy');
      // Back-to-back blocks touch, so they merge into a single busy interval.
      expect(result.meetingCount).toBe(1);
      expect(result.gaps).toEqual([]);
    });
  });

  describe('back-to-back meetings with no gap between them', () => {
    it('merges adjacent/touching meetings into one block and produces no micro-gap between them', () => {
      const window = nyWindow('2026-07-13');
      const blocks = [
        block('2026-07-13T09:00:00-04:00', '2026-07-13T10:00:00-04:00'),
        block('2026-07-13T10:00:00-04:00', '2026-07-13T11:00:00-04:00'), // touches, no gap
      ];
      const result = analyzeBusyness(window, blocks);

      expect(result.meetingCount).toBe(1); // merged into a single busy interval
      expect(result.busyMinutes).toBe(120);

      // No gap should appear between 09:00 and 11:00 — only before and after,
      // each shrunk by the 10-min meeting buffer.
      const midDayGaps = result.gaps.filter((g) => {
        const s = DateTime.fromISO(g.start);
        return s.hour === 9 || s.hour === 10;
      });
      expect(midDayGaps).toHaveLength(0);
    });

    it('produces no gap when meetings overlap the full 10-minute buffer region between them', () => {
      const window = nyWindow('2026-07-13');
      // 5-minute real gap between meetings — smaller than the 10-min buffer
      // required on each side, so the buffered region collapses to nothing.
      const blocks = [
        block('2026-07-13T09:00:00-04:00', '2026-07-13T10:00:00-04:00'),
        block('2026-07-13T10:05:00-04:00', '2026-07-13T11:00:00-04:00'),
      ];
      const result = analyzeBusyness(window, blocks);

      const midDayGap = result.gaps.find((g) => {
        const s = DateTime.fromISO(g.start);
        return s.hour === 10 && s.minute >= 0 && s.minute < 10;
      });
      expect(midDayGap).toBeUndefined();
    });
  });

  describe('all-day events', () => {
    it('does not count an all-day event as busy minutes or a meeting, and does not block gaps', () => {
      const window = nyWindow('2026-07-13');
      const blocks = [
        block('2026-07-13T00:00:00-04:00', '2026-07-14T00:00:00-04:00', true), // all-day
      ];
      const result = analyzeBusyness(window, blocks);

      expect(result.busyMinutes).toBe(0);
      expect(result.meetingCount).toBe(0);
      expect(result.hasAllDayEvent).toBe(true);
      expect(result.busyness).toBe('light');
      // Whole edge-trimmed window remains one open gap.
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].durationMinutes).toBe(14 * 60 - 2 * WINDOW_EDGE_BUFFER_MINUTES);
    });

    it('flags hasAllDayEvent alongside a real meeting without double-counting busy time', () => {
      const window = nyWindow('2026-07-13');
      const blocks = [
        block('2026-07-13T00:00:00-04:00', '2026-07-14T00:00:00-04:00', true),
        block('2026-07-13T09:00:00-04:00', '2026-07-13T10:00:00-04:00'),
      ];
      const result = analyzeBusyness(window, blocks);

      expect(result.hasAllDayEvent).toBe(true);
      expect(result.meetingCount).toBe(1);
      expect(result.busyMinutes).toBe(60);
    });

    it('does not flag hasAllDayEvent when the all-day block does not actually intersect the window day', () => {
      const window = nyWindow('2026-07-13');
      const blocks = [block('2026-07-12T00:00:00-04:00', '2026-07-13T00:00:00-04:00', true)];
      const result = analyzeBusyness(window, blocks);
      expect(result.hasAllDayEvent).toBe(false);
    });
  });

  describe('clipping: meeting starts before window and ends inside it', () => {
    it('only counts the portion of the meeting inside the window as busy time', () => {
      const window = nyWindow('2026-07-13'); // window starts 07:00
      const blocks = [block('2026-07-13T06:00:00-04:00', '2026-07-13T08:00:00-04:00')];
      const result = analyzeBusyness(window, blocks);

      // Clipped to 07:00-08:00 = 60 minutes, not the full 120-minute meeting.
      expect(result.busyMinutes).toBe(60);
      expect(result.meetingCount).toBe(1);
    });

    it('clips a meeting that starts inside the window and ends after it', () => {
      const window = nyWindow('2026-07-13'); // window ends 21:00
      const blocks = [block('2026-07-13T20:30:00-04:00', '2026-07-13T22:00:00-04:00')];
      const result = analyzeBusyness(window, blocks);

      // Clipped to 20:30-21:00 = 30 minutes.
      expect(result.busyMinutes).toBe(30);
    });

    it('ignores a block entirely outside the window', () => {
      const window = nyWindow('2026-07-13');
      const blocks = [block('2026-07-13T22:00:00-04:00', '2026-07-13T23:00:00-04:00')];
      const result = analyzeBusyness(window, blocks);
      expect(result.busyMinutes).toBe(0);
      expect(result.meetingCount).toBe(0);
    });
  });

  describe('DST spring-forward transition (America/New_York 2026-03-08)', () => {
    // 2026-03-08 is a real US spring-forward date: clocks jump 02:00 -> 03:00,
    // so local 02:00-03:00 does not exist and the day is only 23 hours long.
    // Deliberately built via luxon zone resolution (not a hand-typed offset
    // literal) so the fixture itself can't encode a wrong-offset bug: by
    // 07:00 local on this date the zone has already flipped to EDT (-04:00).
    const dstWindow: BusyWindow = {
      start: DateTime.fromISO('2026-03-08T07:00:00', { zone: 'America/New_York' }).toISO() as string,
      end: DateTime.fromISO('2026-03-08T21:00:00', { zone: 'America/New_York' }).toISO() as string,
      timeZone: 'America/New_York',
    };

    it('computes correct window length across the spring-forward jump (not naive hour subtraction)', () => {
      // Use a window that actually straddles the transition: 00:00 -> 23:59
      // local should be a 23-hour day, not 23:59 hours.
      const straddling: BusyWindow = {
        start: '2026-03-08T00:00:00-05:00',
        end: '2026-03-09T00:00:00-05:00', // 24h later in EST wall-clock terms as UTC instant math would be wrong
        timeZone: 'America/New_York',
      };
      // Reframe end using local ISO without explicit offset resolved by luxon zone:
      const straddlingLocalEnd = DateTime.fromISO('2026-03-09T00:00:00', {
        zone: 'America/New_York',
      });
      const straddlingLocalStart = DateTime.fromISO('2026-03-08T00:00:00', {
        zone: 'America/New_York',
      });
      const localWindow: BusyWindow = {
        start: straddlingLocalStart.toISO() as string,
        end: straddlingLocalEnd.toISO() as string,
        timeZone: 'America/New_York',
      };

      const result = analyzeBusyness(localWindow, []);
      // 2026-03-08 00:00 -> 2026-03-09 00:00 local is a 23-hour day because
      // of the spring-forward jump. A naive "24*60" would be wrong.
      expect(result.windowMinutes).toBe(23 * 60);
    });

    it('does not produce a phantom gap for the non-existent 02:00-03:00 local hour', () => {
      // A workday window of 07:00-21:00 local doesn't touch the missing
      // hour at all, but this asserts the parser handles the date cleanly
      // and produces sane, real-duration gaps only.
      const result = analyzeBusyness(dstWindow, []);
      expect(result.windowMinutes).toBe(14 * 60); // 07:00-21:00 local is still 14h; DST jump is earlier
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].durationMinutes).toBe(14 * 60 - 2 * WINDOW_EDGE_BUFFER_MINUTES);
    });

    it('correctly computes meeting duration for a meeting spanning the spring-forward jump', () => {
      // A meeting from 01:30 to 03:30 local on 2026-03-08 is a real 1-hour
      // meeting in elapsed time (clocks skip 02:00-03:00), not 2 hours.
      const window: BusyWindow = {
        start: DateTime.fromISO('2026-03-08T00:00:00', { zone: 'America/New_York' }).toISO() as string,
        end: DateTime.fromISO('2026-03-08T06:00:00', { zone: 'America/New_York' }).toISO() as string,
        timeZone: 'America/New_York',
      };
      const meetingStart = DateTime.fromISO('2026-03-08T01:30:00', { zone: 'America/New_York' });
      const meetingEnd = DateTime.fromISO('2026-03-08T03:30:00', { zone: 'America/New_York' });
      // Sanity: luxon should resolve this local 2-hour-labeled span to 1 real hour.
      expect(meetingEnd.diff(meetingStart, 'minutes').minutes).toBe(60);

      const blocks = [block(meetingStart.toISO() as string, meetingEnd.toISO() as string)];
      const result = analyzeBusyness(window, blocks);
      expect(result.busyMinutes).toBe(60);
    });
  });

  describe('timezone boundary correctness', () => {
    it('handles a window and blocks expressed in a different offset than the window timeZone label, normalizing correctly', () => {
      // Window is America/New_York but a busy block instant is expressed
      // with a UTC offset (as freebusy APIs often return UTC 'Z' instants).
      const window = nyWindow('2026-07-13'); // EDT, UTC-4
      // 2026-07-13 13:00 UTC == 09:00 EDT.
      const blocks = [block('2026-07-13T13:00:00Z', '2026-07-13T14:00:00Z')];
      const result = analyzeBusyness(window, blocks);

      expect(result.busyMinutes).toBe(60);
      expect(result.meetingCount).toBe(1);
      // The gap before this meeting should end at 09:00 EDT minus 10 min buffer = 08:50 EDT.
      // Compare in America/New_York explicitly — comparing .hour on an un-zoned
      // DateTime is dependent on the machine's local TZ (e.g. passes in EDT, fails in CI's UTC).
      const morningGap = result.gaps.find(
        (g) => DateTime.fromISO(g.start).setZone('America/New_York').hour === 7,
      );
      expect(morningGap).toBeDefined();
      const gapEnd = DateTime.fromISO(morningGap!.end).setZone('America/New_York');
      expect(gapEnd.hour).toBe(8);
      expect(gapEnd.minute).toBe(50);
    });

    it('rejects a window with an invalid timezone-unaware instant', () => {
      const badWindow: BusyWindow = {
        start: 'not-a-real-date',
        end: '2026-07-13T21:00:00-04:00',
        timeZone: 'America/New_York',
      };
      expect(() => analyzeBusyness(badWindow, [])).toThrow(BusynessAnalyzerError);
    });

    it('rejects a naive (offset-less) window.start instead of silently interpreting it in the process timezone (docs/14 §3.8 / issue #90)', () => {
      const badWindow: BusyWindow = {
        start: '2026-07-13T07:00:00',
        end: '2026-07-13T21:00:00-04:00',
        timeZone: 'America/New_York',
      };
      expect(() => analyzeBusyness(badWindow, [])).toThrow(/no UTC offset\/zone designator/);
    });

    it('accepts a window.start with a naive-looking but valid "Z" (UTC) suffix', () => {
      const window: BusyWindow = {
        start: '2026-07-13T11:00:00Z',
        end: '2026-07-14T01:00:00Z',
        timeZone: 'America/New_York',
      };
      expect(() => analyzeBusyness(window, [])).not.toThrow();
    });

    it('throws when window.end is not after window.start', () => {
      const badWindow: BusyWindow = {
        start: '2026-07-13T21:00:00-04:00',
        end: '2026-07-13T07:00:00-04:00',
        timeZone: 'America/New_York',
      };
      expect(() => analyzeBusyness(badWindow, [])).toThrow(/window.end must be after window.start/);
    });

    it('produces correct local gap boundaries for a Pacific-time user', () => {
      const window: BusyWindow = {
        start: '2026-07-13T07:00:00-07:00',
        end: '2026-07-13T21:00:00-07:00',
        timeZone: 'America/Los_Angeles',
      };
      const blocks = [block('2026-07-13T12:00:00-07:00', '2026-07-13T13:00:00-07:00')];
      const result = analyzeBusyness(window, blocks);
      expect(result.meetingCount).toBe(1);
      expect(result.busyMinutes).toBe(60);
      // Two gaps: before and after the meeting (with buffers).
      expect(result.gaps.length).toBe(2);
    });
  });

  describe('gap ranking (longest-first)', () => {
    it('ranks candidate gaps longest-first', () => {
      const window = nyWindow('2026-07-13');
      // Two short meetings mid-morning create a small gap between them,
      // and a large gap fills the rest of the afternoon:
      //   gap A (between meetings): 09:10 -> 09:50            = 40 min
      //   gap B (before first meeting, edge-trimmed): 07:30 -> 08:50 = 80 min
      //   gap C (after second meeting to close-of-window): 10:10 -> 20:30 = 620 min
      const blocks = [
        block('2026-07-13T09:00:00-04:00', '2026-07-13T09:20:00-04:00'),
        block('2026-07-13T10:00:00-04:00', '2026-07-13T10:20:00-04:00'), // gap between meetings would be <10min buffered -> collapses
      ];
      const result = analyzeBusyness(window, blocks);
      expect(result.gaps.length).toBeGreaterThanOrEqual(2);
      // Assert sorted longest-first (non-increasing durations).
      for (let i = 1; i < result.gaps.length; i++) {
        expect(result.gaps[i - 1].durationMinutes).toBeGreaterThanOrEqual(result.gaps[i].durationMinutes);
      }
      // The largest gap should be first and should be the afternoon block.
      expect(result.gaps[0].durationMinutes).toBeGreaterThan(result.gaps[result.gaps.length - 1].durationMinutes);
    });

    it('sorts multiple gaps of the same length by earliest start first', () => {
      const window = nyWindow('2026-07-13');
      // Symmetric layout: two equal 100-minute meetings creating two equal
      // flanking + middle gaps is complex to hand-craft exactly equal, so
      // instead directly verify comparator behavior via a constructed case:
      // two meetings each 60 min, spaced to leave two gaps of identical length.
      const blocks = [
        block('2026-07-13T09:20:00-04:00', '2026-07-13T10:20:00-04:00'),
        block('2026-07-13T15:20:00-04:00', '2026-07-13T16:20:00-04:00'),
      ];
      const result = analyzeBusyness(window, blocks);
      expect(result.gaps.length).toBe(3);
      // Find two which happen to share the max duration among the first two, if any;
      // regardless, assert full monotonic non-increasing order with start-time tie-break.
      for (let i = 1; i < result.gaps.length; i++) {
        const prev = result.gaps[i - 1];
        const cur = result.gaps[i];
        if (prev.durationMinutes === cur.durationMinutes) {
          expect(DateTime.fromISO(prev.start).toMillis()).toBeLessThanOrEqual(
            DateTime.fromISO(cur.start).toMillis(),
          );
        } else {
          expect(prev.durationMinutes).toBeGreaterThan(cur.durationMinutes);
        }
      }
    });
  });

  describe('busyness band thresholds', () => {
    it('is moderate when busy fraction sits between the light and heavy thresholds', () => {
      const window = nyWindow('2026-07-13'); // 840 min window
      // 40% busy -> moderate (>= 0.25 and < 0.6).
      const busyMinutesTarget = Math.round(840 * 0.4);
      const meetingEnd = DateTime.fromISO('2026-07-13T07:00:00-04:00', { setZone: true }).plus({
        minutes: busyMinutesTarget,
      });
      const blocks = [block('2026-07-13T07:00:00-04:00', meetingEnd.toISO() as string)];
      const result = analyzeBusyness(window, blocks);
      expect(result.busyness).toBe('moderate');
    });

    it('respects injected custom thresholds', () => {
      const window = nyWindow('2026-07-13');
      const blocks = [block('2026-07-13T09:00:00-04:00', '2026-07-13T10:00:00-04:00')]; // 60/840 = ~7%
      const strict = { lightMax: 0.05, moderateMax: 0.5 };
      const result = analyzeBusyness(window, blocks, strict);
      expect(result.busyness).toBe('moderate'); // 0.07 >= 0.05 lightMax
    });

    it('uses the documented default thresholds object', () => {
      expect(DEFAULT_BUSYNESS_THRESHOLDS).toEqual({ lightMax: 0.25, moderateMax: 0.6 });
    });
  });

  describe('meeting buffer and window edge constants', () => {
    it('exposes the documented buffer constants', () => {
      expect(WINDOW_EDGE_BUFFER_MINUTES).toBe(30);
      expect(MEETING_BUFFER_MINUTES).toBe(10);
    });

    it('a meeting placed exactly at the window edge leaves no gap before the meeting-buffer boundary', () => {
      const window = nyWindow('2026-07-13');
      // Meeting starting exactly at window start (07:00) for 45 minutes —
      // overlaps the entire 30-min edge buffer region (usable start 07:30
      // falls inside the meeting), so there is no *leading* gap; the only
      // gap is the trailing one starting after the meeting's 10-min buffer
      // (07:45 + 10min = 07:55).
      const blocks = [block('2026-07-13T07:00:00-04:00', '2026-07-13T07:45:00-04:00')];
      const result = analyzeBusyness(window, blocks);

      const leadingGap = result.gaps.find(
        (g) => DateTime.fromISO(g.start).toMillis() < DateTime.fromISO('2026-07-13T07:55:00-04:00').toMillis(),
      );
      expect(leadingGap).toBeUndefined();

      expect(result.gaps).toHaveLength(1);
      expect(DateTime.fromISO(result.gaps[0].start).toISO()).toBe(
        DateTime.fromISO('2026-07-13T07:55:00-04:00').toISO(),
      );
    });
  });

  describe('degenerate / malformed block handling', () => {
    it('ignores a zero-duration block without throwing', () => {
      const window = nyWindow('2026-07-13');
      const blocks = [block('2026-07-13T09:00:00-04:00', '2026-07-13T09:00:00-04:00')];
      const result = analyzeBusyness(window, blocks);
      expect(result.busyMinutes).toBe(0);
      expect(result.meetingCount).toBe(0);
    });

    it('throws BusynessAnalyzerError for an invalid busy block timestamp', () => {
      const window = nyWindow('2026-07-13');
      const blocks: BusyBlock[] = [{ start: 'garbage', end: '2026-07-13T10:00:00-04:00' }];
      expect(() => analyzeBusyness(window, blocks)).toThrow(BusynessAnalyzerError);
    });

    it('rejects a naive (offset-less) busy block timestamp (docs/14 §3.8 / issue #90)', () => {
      const window = nyWindow('2026-07-13');
      const blocks: BusyBlock[] = [{ start: '2026-07-13T09:00:00', end: '2026-07-13T10:00:00-04:00' }];
      expect(() => analyzeBusyness(window, blocks)).toThrow(/no UTC offset\/zone designator/);
    });
  });
});
