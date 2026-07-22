/**
 * Issue #205 — the 3:30am devotional.
 *
 * Every assertion here is on the **resolved instant bounds**, never on "the
 * timezone string was forwarded somewhere". That distinction is the entire
 * reason the bug survived months of review: `users.timezone` *was* threaded
 * into `getFreeBusyBlocks`/`analyzeBusyness`, which made the zone look handled
 * while the window bounds were still built with `setUTCHours`. A test that
 * checks plumbing would have passed against the broken code.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSchedulingWindow,
  localCalendarDate,
} from '../../../src/services/calendar/schedulingWindow.js';

const DEFAULTS = { windowStartLocal: '07:00:00', windowEndLocal: '09:00:00' };

describe('resolveSchedulingWindow — the window is built in the user\'s zone (#205)', () => {
  it('gives a New York user a 07:00-09:00 EASTERN window, not 07:00-09:00 UTC', () => {
    const w = resolveSchedulingWindow({
      date: '2026-07-19',
      ...DEFAULTS,
      timeZone: 'America/New_York',
    });

    // July => EDT (UTC-4). 07:00 local == 11:00Z.
    expect(w.timeMin).toBe('2026-07-19T11:00:00.000Z');
    expect(w.timeMax).toBe('2026-07-19T13:00:00.000Z');

    // The regression itself, stated directly: the old code produced 07:00Z,
    // which is 03:00 Eastern — the observed 3:30am devotional.
    expect(w.timeMin).not.toBe('2026-07-19T07:00:00.000Z');
  });

  it('is unaffected for a UTC user — regression guard for the existing fleet', () => {
    const w = resolveSchedulingWindow({ date: '2026-07-19', ...DEFAULTS, timeZone: 'UTC' });
    // Byte-identical to what the pre-#205 setUTCHours code produced.
    expect(w.timeMin).toBe('2026-07-19T07:00:00.000Z');
    expect(w.timeMax).toBe('2026-07-19T09:00:00.000Z');
    expect(w.zoneFallback).toBe(false);
    expect(w.degenerate).toBe(false);
  });

  it('handles a NON-HOUR offset zone (Asia/Kolkata, +05:30)', () => {
    const w = resolveSchedulingWindow({ date: '2026-07-19', ...DEFAULTS, timeZone: 'Asia/Kolkata' });
    // 07:00 IST == 01:30Z. Any implementation rounding to whole hours fails here.
    expect(w.timeMin).toBe('2026-07-19T01:30:00.000Z');
    expect(w.timeMax).toBe('2026-07-19T03:30:00.000Z');
  });

  it('handles a SOUTHERN-HEMISPHERE zone where the window falls on the previous UTC day', () => {
    // Sydney in July is AEST (+10), no DST. 07:00 local on the 19th is 21:00Z
    // on the *18th* — the window legitimately straddles the UTC date boundary.
    const w = resolveSchedulingWindow({
      date: '2026-07-19',
      ...DEFAULTS,
      timeZone: 'Australia/Sydney',
    });
    expect(w.timeMin).toBe('2026-07-18T21:00:00.000Z');
    expect(w.timeMax).toBe('2026-07-18T23:00:00.000Z');
  });

  it('applies southern-hemisphere DST in the opposite season to the north', () => {
    // January: Sydney is on AEDT (+11), so 07:00 local == 20:00Z the day
    // before. A northern-only test suite would pass with the correction's
    // sign reversed; this is the case that catches it.
    const w = resolveSchedulingWindow({
      date: '2026-01-19',
      ...DEFAULTS,
      timeZone: 'Australia/Sydney',
    });
    expect(w.timeMin).toBe('2026-01-18T20:00:00.000Z');
    expect(w.timeMax).toBe('2026-01-18T22:00:00.000Z');
  });

  it('honours a non-default window to the minute', () => {
    const w = resolveSchedulingWindow({
      date: '2026-07-19',
      windowStartLocal: '06:45:00',
      windowEndLocal: '08:15:00',
      timeZone: 'America/New_York',
    });
    expect(w.timeMin).toBe('2026-07-19T10:45:00.000Z');
    expect(w.timeMax).toBe('2026-07-19T12:15:00.000Z');
  });
});

describe('resolveSchedulingWindow — DST transitions (#205 acceptance)', () => {
  /**
   * The headline point of these four tests: the offset applied is the one in
   * force ON THAT DATE, not a fixed offset for the zone. A naive
   * "subtract 5 hours for New York" fix passes every non-transition test above
   * and fails here.
   */

  it('SPRING FORWARD (America/New_York, 2026-03-08): normal window uses the post-transition offset', () => {
    const w = resolveSchedulingWindow({
      date: '2026-03-08',
      ...DEFAULTS,
      timeZone: 'America/New_York',
    });
    // After the 02:00->03:00 jump the zone is EDT (-4), so 07:00 local == 11:00Z.
    // The day BEFORE, 07:00 local was EST (-5) == 12:00Z.
    expect(w.timeMin).toBe('2026-03-08T11:00:00.000Z');
    expect(w.timeMax).toBe('2026-03-08T13:00:00.000Z');
    expect(w.degenerate).toBe(false);

    const dayBefore = resolveSchedulingWindow({
      date: '2026-03-07',
      ...DEFAULTS,
      timeZone: 'America/New_York',
    });
    expect(dayBefore.timeMin).toBe('2026-03-07T12:00:00.000Z');
  });

  it('SPRING FORWARD: a window inside the nonexistent hour collapses and is flagged degenerate', () => {
    // 02:00-03:00 local simply did not happen on this date. Luxon shifts the
    // nonexistent 02:00 forward to 03:00, which is exactly where the window
    // ends — a zero-length window. We flag it so callers skip freeBusy rather
    // than querying an empty range.
    const w = resolveSchedulingWindow({
      date: '2026-03-08',
      windowStartLocal: '02:00:00',
      windowEndLocal: '03:00:00',
      timeZone: 'America/New_York',
    });
    expect(w.degenerate).toBe(true);
    expect(w.timeMin).toBe(w.timeMax);
  });

  it('SPRING FORWARD: bounds never invert, even when only the START is nonexistent', () => {
    // The nastiest case, and the reason `degenerate` exists at all: 02:30 does
    // not exist and shifts forward to 03:30 (07:30Z), while 03:00 exists and
    // stays at 07:00Z. Raw luxon output would be timeMin 07:30Z > timeMax
    // 07:00Z — an inverted range, which is a hard 400 from Google's freeBusy.
    const w = resolveSchedulingWindow({
      date: '2026-03-08',
      windowStartLocal: '02:30:00',
      windowEndLocal: '03:00:00',
      timeZone: 'America/New_York',
    });
    expect(w.degenerate).toBe(true);
    expect(new Date(w.timeMax).getTime()).toBeGreaterThanOrEqual(new Date(w.timeMin).getTime());
  });

  it('FALL BACK (America/New_York, 2026-11-01): the window covers the repeated hour, and is 3h of real time', () => {
    // 01:00-02:00 local happens twice. A 00:30-02:30 window therefore spans
    // three real hours. Luxon resolves the ambiguous 00:30 to the FIRST
    // (earlier-offset, EDT -4) occurrence, which is the documented choice:
    // it can only lengthen the window, never silently shrink it.
    const w = resolveSchedulingWindow({
      date: '2026-11-01',
      windowStartLocal: '00:30:00',
      windowEndLocal: '02:30:00',
      timeZone: 'America/New_York',
    });
    expect(w.timeMin).toBe('2026-11-01T04:30:00.000Z'); // EDT (-4)
    expect(w.timeMax).toBe('2026-11-01T07:30:00.000Z'); // EST (-5)
    expect(w.degenerate).toBe(false);

    const elapsedHours =
      (new Date(w.timeMax).getTime() - new Date(w.timeMin).getTime()) / 3_600_000;
    expect(elapsedHours).toBe(3); // two wall-clock hours, three real ones
  });

  it('FALL BACK: an ordinary 07:00-09:00 morning is still exactly two real hours', () => {
    // The transition is over by 07:00, so the common case must be untouched.
    const w = resolveSchedulingWindow({
      date: '2026-11-01',
      ...DEFAULTS,
      timeZone: 'America/New_York',
    });
    expect(w.timeMin).toBe('2026-11-01T12:00:00.000Z'); // EST (-5)
    expect(w.timeMax).toBe('2026-11-01T14:00:00.000Z');
  });

  it('SOUTHERN-HEMISPHERE transitions run the opposite way (Australia/Sydney 2026)', () => {
    // Sydney springs forward on 2026-10-04 and falls back on 2026-04-05 —
    // inverted relative to the US. 07:00 local resolves against +11 (AEDT)
    // after the October jump and +10 (AEST) after the April one.
    const springForward = resolveSchedulingWindow({
      date: '2026-10-04',
      ...DEFAULTS,
      timeZone: 'Australia/Sydney',
    });
    expect(springForward.timeMin).toBe('2026-10-03T20:00:00.000Z'); // +11

    const fallBack = resolveSchedulingWindow({
      date: '2026-04-05',
      ...DEFAULTS,
      timeZone: 'Australia/Sydney',
    });
    expect(fallBack.timeMin).toBe('2026-04-04T21:00:00.000Z'); // +10
  });
});

describe('resolveSchedulingWindow — degraded inputs never silently mislead', () => {
  it('falls back to UTC (flagged) for an unsupported zone rather than the SERVER\'s local zone', () => {
    // Resolving against the host zone would make behavior depend on where the
    // container happens to run — a host-dependent restatement of this very bug.
    const w = resolveSchedulingWindow({
      date: '2026-07-19',
      ...DEFAULTS,
      timeZone: 'Not/AZone',
    });
    expect(w.zoneFallback).toBe(true);
    expect(w.timeZone).toBe('UTC');
    expect(w.timeMin).toBe('2026-07-19T07:00:00.000Z');
  });

  it('falls back to the schema defaults for a malformed time, not to hour 0', () => {
    // `Number('') === 0`, so naive parsing turns junk into midnight — a silent
    // 7-hour shift rather than a visible failure.
    const w = resolveSchedulingWindow({
      date: '2026-07-19',
      windowStartLocal: 'garbage',
      windowEndLocal: '',
      timeZone: 'UTC',
    });
    expect(w.timeMin).toBe('2026-07-19T07:00:00.000Z');
    expect(w.timeMax).toBe('2026-07-19T09:00:00.000Z');
  });

  it('accepts HH:MM as well as HH:MM:SS', () => {
    const w = resolveSchedulingWindow({
      date: '2026-07-19',
      windowStartLocal: '07:00',
      windowEndLocal: '09:00',
      timeZone: 'America/New_York',
    });
    expect(w.timeMin).toBe('2026-07-19T11:00:00.000Z');
  });

  it('throws on a malformed date instead of emitting an invalid instant', () => {
    // luxon's `.toISO()` returns null for an invalid DateTime, which would
    // type-launder into a bogus string downstream. Fail loudly instead; the
    // caller already treats calendar errors as non-blocking.
    expect(() =>
      resolveSchedulingWindow({ date: 'not-a-date', ...DEFAULTS, timeZone: 'UTC' }),
    ).toThrow(/Cannot resolve scheduling window/);
  });
});

describe('localCalendarDate — the gap\'s date in the USER\'s zone (#205, rescheduleWatcher)', () => {
  it('returns the previous UTC date for a Sydney morning gap', () => {
    // 07:00 Sydney on 2026-01-15 is 20:00Z on 2026-01-14. The watcher used
    // `toISOString().slice(0, 10)` here and rebuilt the window for the wrong
    // local day entirely.
    const instant = new Date('2026-01-14T20:00:00.000Z');
    expect(localCalendarDate(instant, 'Australia/Sydney')).toBe('2026-01-15');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-01-14'); // the old, wrong answer
  });

  it('returns the next UTC date for a late-evening New York gap', () => {
    // 20:00 New York on 2026-07-19 is 00:00Z on the 20th.
    expect(localCalendarDate(new Date('2026-07-20T00:00:00.000Z'), 'America/New_York')).toBe(
      '2026-07-19',
    );
  });

  it('is identity for a UTC user', () => {
    expect(localCalendarDate(new Date('2026-07-19T07:00:00.000Z'), 'UTC')).toBe('2026-07-19');
  });

  it('falls back to the UTC date for an unsupported zone', () => {
    expect(localCalendarDate(new Date('2026-07-19T07:00:00.000Z'), 'Not/AZone')).toBe('2026-07-19');
  });
});
