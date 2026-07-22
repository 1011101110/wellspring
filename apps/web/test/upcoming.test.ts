import { describe, expect, it } from 'vitest';
import { emptyUpcomingMessage, nextActiveWeekday, rescheduleNote } from '../src/lib/upcoming';

const CHICAGO = 'America/Chicago';
const WEEKDAYS = [1, 2, 3, 4, 5];

// 2026-07-18 is a Saturday; 2026-07-19 a Sunday; 2026-07-20 a Monday.
const SATURDAY = new Date('2026-07-18T18:00:00Z');
const SUNDAY = new Date('2026-07-19T18:00:00Z');
const WEDNESDAY = new Date('2026-07-22T18:00:00Z');

describe('nextActiveWeekday', () => {
  it('names Monday for a default user on Saturday — the weekend case (#188)', () => {
    expect(nextActiveWeekday(WEEKDAYS, SATURDAY, CHICAGO)).toBe('Monday');
  });

  it('names Monday on Sunday too', () => {
    expect(nextActiveWeekday(WEEKDAYS, SUNDAY, CHICAGO)).toBe('Monday');
  });

  it('starts from tomorrow, never today', () => {
    // On Wednesday, with nothing left booked today, the answer is
    // Thursday — saying "Wednesday" would point at a session that is not
    // coming.
    expect(nextActiveWeekday(WEEKDAYS, WEDNESDAY, CHICAGO)).toBe('Thursday');
  });

  it('wraps around the week for a single-day schedule', () => {
    // Only Wednesdays, asked on a Wednesday: the next one is a week away
    // and is still Wednesday.
    expect(nextActiveWeekday([3], WEDNESDAY, CHICAGO)).toBe('Wednesday');
  });

  it('returns null when no days are active, rather than inventing one', () => {
    expect(nextActiveWeekday([], SATURDAY, CHICAGO)).toBeNull();
  });

  it('ignores out-of-range values instead of throwing', () => {
    expect(nextActiveWeekday([99, 1], SATURDAY, CHICAGO)).toBe('Monday');
  });
});

describe('emptyUpcomingMessage', () => {
  it('explains the emptiness rather than presenting it as a failure', () => {
    const message = emptyUpcomingMessage(WEEKDAYS, SATURDAY, CHICAGO, 'connected');
    expect(message).toContain('Monday');
    // The specific thing #240 rules out: an empty list rendered as an
    // error, an apology, or the user's mistake.
    expect(message).not.toMatch(/error|failed|sorry|couldn|unable|no upcoming/i);
  });

  it('points at settings when the schedule genuinely has no active days', () => {
    const message = emptyUpcomingMessage([], SATURDAY, CHICAGO, 'connected');
    expect(message).toMatch(/settings/i);
    expect(message).not.toMatch(/error|failed/i);
  });

  /*
   * #260. The assertions here are deliberately about what the sentence
   * must NOT contain, because the bug was not a missing feature — it was
   * a present, fluent, wrong sentence. A test asserting only that the
   * disconnected copy "mentions connecting" would pass against a string
   * that also promised Monday.
   *
   * `activeDays` is WEEKDAYS in every disconnected case below, which is
   * the point: the day is derivable and must still not be stated.
   */
  describe('when Wellspring cannot actually book anything', () => {
    it('names no day for a disconnected user, even though activeDays implies one', () => {
      const message = emptyUpcomingMessage(WEEKDAYS, SATURDAY, CHICAGO, 'disconnected');
      for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
        expect(message).not.toContain(day);
      }
      expect(message).not.toMatch(/next devotional is/i);
    });

    it('tells the disconnected user what would start it', () => {
      expect(emptyUpcomingMessage(WEEKDAYS, SATURDAY, CHICAGO, 'disconnected')).toMatch(
        /connect/i,
      );
    });

    it('names no day while the connection state is still unknown', () => {
      // `loading` and `error` on the connection card both land here. The
      // honest sentence is the half we can stand behind.
      const message = emptyUpcomingMessage(WEEKDAYS, SATURDAY, CHICAGO, 'unknown');
      expect(message).not.toContain('Monday');
      expect(message).not.toMatch(/next devotional is/i);
      // ...but it still must not read as breakage.
      expect(message).not.toMatch(/error|failed|sorry|unable/i);
    });

    it('says something in every capability — an empty card is never blank', () => {
      for (const capability of ['connected', 'disconnected', 'unknown'] as const) {
        expect(
          emptyUpcomingMessage(WEEKDAYS, SATURDAY, CHICAGO, capability).trim().length,
        ).toBeGreaterThan(0);
      }
    });
  });
});

describe('rescheduleNote', () => {
  it('stays silent for an event that was never moved', () => {
    expect(rescheduleNote(0)).toBeNull();
  });

  it('admits a single move', () => {
    expect(rescheduleNote(1)).toMatch(/once/);
  });

  it('admits repeated moves without printing a number (§5.10)', () => {
    const note = rescheduleNote(3);
    expect(note).toBeTruthy();
    expect(note).not.toMatch(/\d/);
  });

  it('tolerates a nonsense count', () => {
    expect(rescheduleNote(Number.NaN)).toBeNull();
    expect(rescheduleNote(-2)).toBeNull();
  });
});
