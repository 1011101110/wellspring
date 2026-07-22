import { describe, expect, it } from 'vitest';
import {
  computeEasterDate,
  getLiturgicalSeason,
  liturgicalSeasonInstructionLine,
} from '../../../src/services/gloo/liturgicalCalendar.js';

describe('computeEasterDate', () => {
  // Well-known Gregorian Easter dates, cross-checked against public
  // liturgical calendars — a self-check on the computus algorithm itself.
  const KNOWN_EASTER_DATES: Array<[number, string]> = [
    [2000, '2000-04-23'],
    [2023, '2023-04-09'],
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
  ];

  for (const [year, expectedIso] of KNOWN_EASTER_DATES) {
    it(`computes Easter ${year} as ${expectedIso}`, () => {
      const easter = computeEasterDate(year);
      expect(easter.toISOString().slice(0, 10)).toBe(expectedIso);
    });
  }
});

describe('getLiturgicalSeason', () => {
  it('resolves the 1st, 2nd, and 4th weeks of Advent 2026 (Advent 1 = 2026-11-29)', () => {
    expect(getLiturgicalSeason('2026-11-29')).toEqual({ season: 'advent', week: 1 });
    expect(getLiturgicalSeason('2026-12-06')).toEqual({ season: 'advent', week: 2 });
    expect(getLiturgicalSeason('2026-12-24')).toEqual({ season: 'advent', week: 4 });
  });

  it('resolves Christmastide on Christmas Day and on into early January of the next year', () => {
    expect(getLiturgicalSeason('2026-12-25')).toEqual({ season: 'christmastide' });
    expect(getLiturgicalSeason('2026-12-31')).toEqual({ season: 'christmastide' });
    expect(getLiturgicalSeason('2027-01-01')).toEqual({ season: 'christmastide' });
    expect(getLiturgicalSeason('2027-01-05')).toEqual({ season: 'christmastide' });
  });

  it('resolves Ordinary Time after Epiphany (Jan 6) through the day before Ash Wednesday', () => {
    // 2027 Easter = 2027-03-28, so Ash Wednesday = 2027-02-10.
    expect(getLiturgicalSeason('2027-01-06')).toEqual({ season: 'ordinary_time' });
    expect(getLiturgicalSeason('2027-02-09')).toEqual({ season: 'ordinary_time' });
  });

  it('resolves Lent from Ash Wednesday through Holy Saturday (2027: Ash Wed 2027-02-10, Easter 2027-03-28)', () => {
    expect(getLiturgicalSeason('2027-02-10')).toEqual({ season: 'lent', week: 1 });
    expect(getLiturgicalSeason('2027-02-17')).toEqual({ season: 'lent', week: 2 });
    expect(getLiturgicalSeason('2027-03-27')).toEqual({ season: 'lent', week: 6 });
  });

  it('resolves Eastertide from Easter Sunday through Pentecost, inclusive (2027: Easter 2027-03-28, Pentecost 2027-05-16)', () => {
    expect(getLiturgicalSeason('2027-03-28')).toEqual({ season: 'eastertide', week: 1 });
    expect(getLiturgicalSeason('2027-04-04')).toEqual({ season: 'eastertide', week: 2 });
    expect(getLiturgicalSeason('2027-05-16')).toEqual({ season: 'eastertide', week: 7 });
  });

  it('resolves Ordinary Time after Pentecost through the day before the next Advent', () => {
    // 2027 Pentecost = 2027-05-16; Advent 1 of 2027 = 2027-11-28.
    expect(getLiturgicalSeason('2027-05-17')).toEqual({ season: 'ordinary_time' });
    expect(getLiturgicalSeason('2027-11-27')).toEqual({ season: 'ordinary_time' });
    expect(getLiturgicalSeason('2027-11-28')).toEqual({ season: 'advent', week: 1 });
  });

  it('is deterministic: the same date always resolves to the same season', () => {
    expect(getLiturgicalSeason('2026-12-25')).toEqual(getLiturgicalSeason('2026-12-25'));
  });
});

describe('liturgicalSeasonInstructionLine', () => {
  it('renders an ordinal week number for Advent, Lent, and Eastertide', () => {
    expect(liturgicalSeasonInstructionLine({ season: 'advent', week: 3 })).toContain('3rd week of Advent');
    expect(liturgicalSeasonInstructionLine({ season: 'lent', week: 1 })).toContain('1st week of Lent');
    expect(liturgicalSeasonInstructionLine({ season: 'eastertide', week: 2 })).toContain('2nd week of Eastertide');
  });

  it('renders a season-only line for Christmastide and Ordinary Time (no week number)', () => {
    expect(liturgicalSeasonInstructionLine({ season: 'christmastide' })).toContain('Christmastide');
    expect(liturgicalSeasonInstructionLine({ season: 'ordinary_time' })).toContain('Ordinary Time');
  });
});
