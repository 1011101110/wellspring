/**
 * P8 (#327): the server-composed `rhythm` object — pure summary over the
 * stored row, closed-shape (§9) on the wire.
 */
import { describe, expect, it } from 'vitest';
import { RhythmSchema } from '@kairos/shared-contracts';
import { composeRhythm, type RhythmSummaryRow } from '../../../src/services/rhythm/rhythmSummary.js';

function row(overrides: Partial<RhythmSummaryRow> = {}): RhythmSummaryRow {
  return {
    active_days: [1, 2, 3, 4, 5],
    min_per_week: 2,
    adaptive_enabled: true,
    adaptive_days_per_week: null,
    adaptive_reason: null,
    ...overrides,
  };
}

describe('composeRhythm', () => {
  it('fixed user: full stated day set, fixed_by_user, whatever engine state was left behind', () => {
    expect(
      composeRhythm(row({ adaptive_enabled: false, adaptive_days_per_week: 3, adaptive_reason: 'easing_back' })),
    ).toEqual({ mode: 'fixed', daysPerWeek: 5, minPerWeek: 2, reason: 'fixed_by_user' });
  });

  it('adaptive with a stored decision: echoes the engine state', () => {
    expect(composeRhythm(row({ adaptive_days_per_week: 3, adaptive_reason: 'easing_back' }))).toEqual({
      mode: 'adaptive',
      daysPerWeek: 3,
      minPerWeek: 2,
      reason: 'easing_back',
    });
  });

  it('never adapted: full schedule, no_data (nothing adaptive to caption yet)', () => {
    expect(composeRhythm(row())).toEqual({
      mode: 'adaptive',
      daysPerWeek: 5,
      minPerWeek: 2,
      reason: 'no_data',
    });
  });

  it('clamps stored state above a freshly shrunk day set — at_ceiling, the user’s hand wins', () => {
    expect(
      composeRhythm(row({ active_days: [1, 2], adaptive_days_per_week: 4, adaptive_reason: 'hold' })),
    ).toEqual({ mode: 'adaptive', daysPerWeek: 2, minPerWeek: 2, reason: 'at_ceiling' });
  });

  it('clamps stored state below a freshly raised floor — at_floor', () => {
    expect(
      composeRhythm(row({ min_per_week: 4, adaptive_days_per_week: 2, adaptive_reason: 'easing_back' })),
    ).toEqual({ mode: 'adaptive', daysPerWeek: 4, minPerWeek: 4, reason: 'at_floor' });
  });

  it('floor never exceeds the day-set ceiling (3 active days, min 5 → floor 3)', () => {
    expect(
      composeRhythm(row({ active_days: [1, 2, 3], min_per_week: 5, adaptive_days_per_week: 1 })),
    ).toEqual({ mode: 'adaptive', daysPerWeek: 3, minPerWeek: 5, reason: 'at_floor' });
  });

  it('de-duplicates the day set before counting the ceiling', () => {
    expect(composeRhythm(row({ active_days: [1, 1, 2, 2] })).daysPerWeek).toBe(2);
  });

  it('degrades a stale fixed_by_user under adaptive mode to no_data rather than captioning it', () => {
    expect(
      composeRhythm(row({ adaptive_days_per_week: 5, adaptive_reason: 'fixed_by_user' })).reason,
    ).toBe('no_data');
  });

  it('degrades an out-of-band stored reason to no_data instead of failing the GET', () => {
    expect(composeRhythm(row({ adaptive_days_per_week: 4, adaptive_reason: 'banana' })).reason).toBe(
      'no_data',
    );
  });

  it('every composition parses against the strict wire schema (closed shape, §9)', () => {
    const rows = [
      row(),
      row({ adaptive_enabled: false }),
      row({ adaptive_days_per_week: 3, adaptive_reason: 'welcoming_back' }),
      row({ active_days: [0], min_per_week: 7, adaptive_days_per_week: 6 }),
    ];
    for (const r of rows) {
      const parsed = RhythmSchema.safeParse(composeRhythm(r));
      expect(parsed.success).toBe(true);
    }
  });
});
