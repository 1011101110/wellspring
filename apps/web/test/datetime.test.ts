/**
 * The #205 class of bug, tested with the Sydney/Chicago mirror pair that
 * #240's acceptance names: two zones far enough apart that a UTC-based
 * implementation lands on the wrong calendar day in at least one of them.
 */
import { describe, expect, it } from 'vitest';
import {
  dateKeyInZone,
  formatCalendarDate,
  formatDay,
  formatTimeWithZone,
  formatWeekday,
  resolveZone,
  safeZone,
  weekdayInZone,
} from '../src/lib/datetime';

const CHICAGO = 'America/Chicago';
const SYDNEY = 'Australia/Sydney';
const NEW_YORK = 'America/New_York';

describe('dateKeyInZone', () => {
  it('answers in the given zone, not UTC — the two disagree here', () => {
    // 2026-07-20T01:30:00Z is still the 19th in Chicago and already the
    // 20th in Sydney. A `toISOString().slice(0,10)` would say "20" for
    // both, blanking the Chicago user's today card all evening.
    const instant = new Date('2026-07-20T01:30:00Z');
    expect(dateKeyInZone(instant, CHICAGO)).toBe('2026-07-19');
    expect(dateKeyInZone(instant, SYDNEY)).toBe('2026-07-20');
  });

  it('formats as YYYY-MM-DD so it can be compared to the date column', () => {
    expect(dateKeyInZone(new Date('2026-01-05T12:00:00Z'), CHICAGO)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back rather than throwing on a nonsense zone', () => {
    expect(dateKeyInZone(new Date('2026-07-19T12:00:00Z'), 'Not/AZone')).toBe('2026-07-19');
  });
});

describe('weekdayInZone', () => {
  it('uses the 0=Sunday convention activeDays uses', () => {
    // 2026-07-19 is a Sunday.
    expect(weekdayInZone(new Date('2026-07-19T12:00:00Z'), CHICAGO)).toBe(0);
    expect(weekdayInZone(new Date('2026-07-20T12:00:00Z'), CHICAGO)).toBe(1);
  });

  it('can differ between zones across the date line', () => {
    const instant = new Date('2026-07-20T01:30:00Z');
    expect(weekdayInZone(instant, CHICAGO)).toBe(0); // still Sunday
    expect(weekdayInZone(instant, SYDNEY)).toBe(1); // already Monday
  });
});

describe('formatTimeWithZone', () => {
  it('labels the zone, so the rendered time is a checkable claim', () => {
    const iso = '2026-07-20T14:00:00Z';
    const chicago = formatTimeWithZone(iso, CHICAGO);
    const sydney = formatTimeWithZone(iso, SYDNEY);

    expect(chicago).toBe('9:00 AM CDT');

    // Sydney's short label is ICU-dependent — Node renders "GMT+10" where
    // a browser may say "AEST". Both are legitimate, checkable zone
    // labels, so the assertion is on the property that matters (a label
    // is present and the two zones do not render alike) rather than on a
    // string that would make this test fail in a different runtime.
    expect(sydney).toMatch(/^\d{1,2}:\d{2} (AM|PM) .+$/);
    expect(chicago).not.toBe(sydney);
  });

  it('returns an empty string for an unparseable instant rather than "Invalid Date"', () => {
    expect(formatTimeWithZone('not-a-date', CHICAGO)).toBe('');
  });
});

describe('formatCalendarDate', () => {
  it('renders a date-only value as its own day, in every zone', () => {
    // The regression this exists for: `devotionals.date` is a Postgres
    // `date`. Sent through a zone-converting formatter it becomes UTC
    // midnight, which in any negative-offset zone is the *previous*
    // evening — so the whole archive displayed the day before. Caught by
    // looking at the rendered list, not by the type checker: both this and
    // an instant are `string`.
    expect(formatCalendarDate('2026-07-22')).toBe('Wednesday, July 22');
    expect(formatCalendarDate('2026-01-01')).toBe('Thursday, January 1');
  });

  it('is not affected by the ambient zone, unlike formatDay', () => {
    // formatDay on the same value in Chicago yields the 21st. That
    // difference is the bug, and this asserts the two are genuinely
    // different functions rather than one delegating to the other.
    expect(formatCalendarDate('2026-07-22')).not.toBe(formatDay('2026-07-22', CHICAGO));
  });

  it('tolerates a full timestamp by taking the date part', () => {
    expect(formatCalendarDate('2026-07-22T23:00:00Z')).toBe('Wednesday, July 22');
  });
});

describe('formatWeekday', () => {
  it('names the day in the given zone', () => {
    expect(formatWeekday('2026-07-20T14:00:00Z', CHICAGO)).toBe('Monday');
  });
});

describe('safeZone', () => {
  it('passes real zones through and repairs invalid ones', () => {
    expect(safeZone(CHICAGO)).toBe(CHICAGO);
    expect(safeZone('Mars/Olympus')).toBe('UTC');
  });
});

describe('resolveZone', () => {
  it('uses the browser zone when no profile zone is known (today’s reality)', () => {
    expect(resolveZone(undefined, CHICAGO)).toEqual({
      zone: CHICAGO,
      travelling: false,
      browserZone: CHICAGO,
    });
  });

  it('prefers the profile zone and flags a mismatch when they differ', () => {
    // The behaviour that switches on the day the API exposes the stored
    // zone. Asserted now so the wiring is proven before it is needed.
    expect(resolveZone(SYDNEY, CHICAGO)).toEqual({
      zone: SYDNEY,
      travelling: true,
      browserZone: CHICAGO,
    });
  });

  it('does not claim travel when the two agree', () => {
    expect(resolveZone(CHICAGO, CHICAGO).travelling).toBe(false);
  });

  it('treats a bare UTC profile zone as unknown and renders in the browser zone (#301)', () => {
    // `users.timezone` defaults to UTC; a user who never triggered a save or
    // a completed connect reads it back as UTC. That is not "schedule me in
    // UTC" — it is "the server never learned my zone" — so the browser's is
    // the better answer and there is no travel to claim.
    expect(resolveZone('UTC', NEW_YORK)).toEqual({
      zone: NEW_YORK,
      travelling: false,
      browserZone: NEW_YORK,
    });
  });

  it('leaves a genuine UTC user in UTC (browser is UTC too)', () => {
    expect(resolveZone('UTC', 'UTC')).toEqual({
      zone: 'UTC',
      travelling: false,
      browserZone: 'UTC',
    });
  });

  it('still prefers a real, non-UTC profile zone and still flags travel', () => {
    expect(resolveZone(SYDNEY, NEW_YORK)).toEqual({
      zone: SYDNEY,
      travelling: true,
      browserZone: NEW_YORK,
    });
  });
});
