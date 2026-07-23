/**
 * P8 (#327): the "Your rhythm" copy map and control bounds.
 *
 * The §9 sweep here is the story's automated copy test: for EVERY reason
 * code, the rendered line contains no digits except the interpolated
 * schedule numbers, and none of the attendance vocabulary Foundation §9
 * forbids surfacing (grace may notice; it may never charge).
 */
import { describe, expect, it } from 'vitest';
import type { Rhythm, RhythmReason } from '@kairos/shared-contracts';
import {
  RHYTHM_REASONS,
  clampMinPerWeek,
  minPerWeekLabel,
  minPerWeekMax,
  minPerWeekOptions,
  rhythmStatusLine,
} from '../src/lib/rhythm';

function rhythm(reason: RhythmReason, overrides: Partial<Rhythm> = {}): Rhythm {
  return { mode: reason === 'fixed_by_user' ? 'fixed' : 'adaptive', daysPerWeek: 3, minPerWeek: 2, reason, ...overrides };
}

describe('rhythmStatusLine — the reason-code → grace-copy map', () => {
  it('steady codes state the schedule fact', () => {
    expect(rhythmStatusLine(rhythm('hold'))).toBe('Your rhythm is steady — 3 mornings a week.');
    expect(rhythmStatusLine(rhythm('at_ceiling'))).toBe('Your rhythm is steady — 3 mornings a week.');
  });

  it('easing codes acknowledge, reassure, and stop — the #327 template verbatim', () => {
    const line =
      'Wellspring noticed life might be full right now, and has gently eased back to 3 mornings a week. There’s no catching up to do — this pace is yours.';
    // Normalize typographic vs ASCII punctuation before comparing substance.
    const normalize = (s: string) => s.replace(/[‘’]/g, "'").replace(/—/g, '—');
    expect(normalize(rhythmStatusLine(rhythm('easing_back'))!)).toBe(normalize(line));
    expect(normalize(rhythmStatusLine(rhythm('at_floor'))!)).toBe(normalize(line));
  });

  it('welcoming_back adds mornings without counting anything', () => {
    expect(rhythmStatusLine(rhythm('welcoming_back'))).toBe(
      "It's good to have you back. Wellspring is slowly adding mornings again as you're ready.",
    );
  });

  it('fixed_by_user names the user\'s own decision', () => {
    expect(rhythmStatusLine(rhythm('fixed_by_user'))).toBe(
      "Your schedule is fixed — Wellspring won't adjust it.",
    );
  });

  it('no_data renders nothing — no placeholder sentence (#244)', () => {
    expect(rhythmStatusLine(rhythm('no_data'))).toBeNull();
  });

  it('an unknown reason code renders nothing rather than crashing (older client, newer server)', () => {
    expect(rhythmStatusLine(rhythm('brand_new_code' as RhythmReason))).toBeNull();
  });

  it('pluralizes the single-morning schedule', () => {
    expect(rhythmStatusLine(rhythm('hold', { daysPerWeek: 1 }))).toBe(
      'Your rhythm is steady — 1 morning a week.',
    );
  });

  it('§9 sweep: every reason code — no digits but the schedule numbers, no attendance vocabulary', () => {
    // Practice-accounting vocabulary that must never appear (#271, #282):
    // verdicts, tallies, dates, comparisons to a past self.
    const forbidden = [
      /missed/i,
      /attend/i,
      /streak/i,
      /skipped/i,
      /\bsince\b/i,
      /in a row/i,
      /last week/i,
      /you (were|used to|haven't|didn't)/i,
      /behind/i,
    ];
    expect(RHYTHM_REASONS.length).toBeGreaterThanOrEqual(7);
    for (const reason of RHYTHM_REASONS) {
      const r = rhythm(reason, { daysPerWeek: 3, minPerWeek: 2 });
      const line = rhythmStatusLine(r);
      if (line === null) continue;
      for (const pattern of forbidden) {
        expect(line).not.toMatch(pattern);
      }
      const digits = line.match(/\d+/g) ?? [];
      for (const digit of digits) {
        // The only numbers grace may speak are the schedule's own.
        expect([String(r.daysPerWeek), String(r.minPerWeek)]).toContain(digit);
      }
    }
  });
});

describe('minPerWeek control bounds (#327: clamps 1–7, never exceeds active days)', () => {
  it('caps at the active-days count in effect', () => {
    expect(minPerWeekMax(3)).toBe(3);
    expect(minPerWeekOptions(3)).toEqual([1, 2, 3]);
  });

  it('never exceeds 7 and never collapses below 1', () => {
    expect(minPerWeekMax(9)).toBe(7);
    expect(minPerWeekMax(0)).toBe(1);
    expect(minPerWeekOptions(9)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(minPerWeekOptions(0)).toEqual([1]);
  });

  it('clamps a stored floor that outgrew a narrowed day set', () => {
    expect(clampMinPerWeek(6, 3)).toBe(3);
    expect(clampMinPerWeek(0, 5)).toBe(1);
    expect(clampMinPerWeek(4, 5)).toBe(4);
  });

  it('labels carry the number in words-around-a-schedule-number form', () => {
    expect(minPerWeekLabel(1)).toBe('1 day a week');
    expect(minPerWeekLabel(3)).toBe('3 days a week');
  });
});
