/**
 * P7 (#326): candidate-gap choice. The no-preference branch must be
 * byte-identical to the pre-#326 rule (top-ranked gap, floor-checked);
 * the preference branch orders by proximity to the preferred instant.
 */
import { describe, expect, it } from 'vitest';
import type { CandidateGap } from '../../../src/services/busynessAnalyzer.js';
import {
  resolvePreferredInstant,
  selectGap,
} from '../../../src/services/calendar/gapSelection.js';

function gap(start: string, end: string, durationMinutes: number): CandidateGap {
  return { start, end, durationMinutes };
}

// Analyzer order: longest first, ties earlier first.
const MORNING = gap('2026-07-24T09:30:00Z', '2026-07-24T09:50:00Z', 20);
const AFTERNOON = gap('2026-07-24T15:10:00Z', '2026-07-24T16:30:00Z', 80);
const RANKED = [AFTERNOON, MORNING];

describe('selectGap — no preferred time (pre-#326 behavior, verbatim)', () => {
  it('takes the top-ranked gap', () => {
    expect(selectGap(RANKED, 0, null)).toBe(AFTERNOON);
  });

  it('rejects when the top-ranked gap misses the floor (longest-first ⇒ all miss)', () => {
    expect(selectGap([MORNING], 25, null)).toBeUndefined();
    expect(selectGap([], 0, null)).toBeUndefined();
  });
});

describe('selectGap — preferred time set', () => {
  it('picks the gap containing the preferred instant even when a longer gap exists', () => {
    const preferred = new Date('2026-07-24T09:40:00Z');
    expect(selectGap(RANKED, 0, preferred)).toBe(MORNING);
  });

  it('picks the nearest edge when the instant falls between gaps', () => {
    // 11:00Z is 70 min after the morning gap ends, 250 min before the afternoon starts.
    expect(selectGap(RANKED, 0, new Date('2026-07-24T11:00:00Z'))).toBe(MORNING);
    // 14:00Z is nearer the afternoon gap.
    expect(selectGap(RANKED, 0, new Date('2026-07-24T14:00:00Z'))).toBe(AFTERNOON);
  });

  it('still enforces the required-minutes floor — a too-short nearest gap yields to a qualifying one', () => {
    const preferred = new Date('2026-07-24T09:40:00Z');
    expect(selectGap(RANKED, 25, preferred)).toBe(AFTERNOON);
    expect(selectGap([MORNING], 25, preferred)).toBeUndefined();
  });

  it('breaks a distance tie toward the earlier gap', () => {
    const a = gap('2026-07-24T10:00:00Z', '2026-07-24T10:20:00Z', 20);
    const b = gap('2026-07-24T11:40:00Z', '2026-07-24T12:00:00Z', 20);
    // 11:00Z is exactly 40 min from both edges.
    expect(selectGap([a, b], 0, new Date('2026-07-24T11:00:00Z'))).toBe(a);
    expect(selectGap([b, a], 0, new Date('2026-07-24T11:00:00Z'))).toBe(a);
  });
});

describe('resolvePreferredInstant', () => {
  it('resolves a wall-clock time on a date in a zone to the concrete instant', () => {
    const instant = resolvePreferredInstant('2026-07-24', '07:30:00', 'America/New_York');
    expect(instant?.toISOString()).toBe('2026-07-24T11:30:00.000Z');
  });

  it('returns null for an unknown zone or malformed time', () => {
    expect(resolvePreferredInstant('2026-07-24', '07:30:00', 'Not/AZone')).toBeNull();
    expect(resolvePreferredInstant('2026-07-24', 'nonsense', 'UTC')).toBeNull();
  });
});
