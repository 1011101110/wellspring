/**
 * P8 (#327): the `Rhythm` contract is CLOSED — the structural §9 test.
 *
 * The threat this pins against is not malice but drift: an
 * innocently-added field (an attendance count, a "since" date, a per-day
 * array) is exactly how a client gets the raw material to compute a
 * streak (epic #312 risk list). `.strict()` plus these tests make that a
 * CI failure instead of a review catch.
 */
import { describe, expect, it } from 'vitest';
import { RhythmReasonSchema, RhythmSchema, PreferencesResponseDataSchema } from '../src/index.js';

const VALID = { mode: 'adaptive', daysPerWeek: 3, minPerWeek: 2, reason: 'easing_back' };

describe('RhythmSchema (closed shape, §9)', () => {
  it('accepts exactly the four schedule fields', () => {
    expect(RhythmSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    ['attendedCount', 4],
    ['missedCount', 2],
    ['attendanceRatio', 0.5],
    ['lastMissedAt', '2026-07-20'],
    ['history', [true, false, true]],
    ['streak', 3],
  ])('rejects an attendance-ish extra field: %s', (key, value) => {
    expect(RhythmSchema.safeParse({ ...VALID, [key]: value }).success).toBe(false);
  });

  it('rejects a missing field — partial rhythm objects are not a thing', () => {
    const { reason: _reason, ...withoutReason } = VALID;
    expect(RhythmSchema.safeParse(withoutReason).success).toBe(false);
  });

  it('rejects out-of-range schedule numbers and unknown reasons', () => {
    expect(RhythmSchema.safeParse({ ...VALID, daysPerWeek: 0 }).success).toBe(false);
    expect(RhythmSchema.safeParse({ ...VALID, daysPerWeek: 8 }).success).toBe(false);
    expect(RhythmSchema.safeParse({ ...VALID, minPerWeek: 0 }).success).toBe(false);
    expect(RhythmSchema.safeParse({ ...VALID, reason: 'you_missed_some' }).success).toBe(false);
  });

  it('carries every P5 reason code', () => {
    expect([...RhythmReasonSchema.options].sort()).toEqual(
      [
        'at_ceiling',
        'at_floor',
        'easing_back',
        'fixed_by_user',
        'hold',
        'no_data',
        'welcoming_back',
      ].sort(),
    );
  });
});

describe('PreferencesResponseDataSchema.rhythm', () => {
  // A hand-built full response row, like `serverRow()` in the web
  // workspace's apps/web/test/preferences.test.ts. The two fixtures live
  // in different packages with no shared value, so they CAN drift: a new
  // *required* field breaks both (this one at parse time, that one at
  // type-check), but an *optional* field can land in one and be forgotten
  // by the other with no failure anywhere. When touching either, check
  // the other — and when they disagree about what a plausible row looks
  // like, trust the schema, not either fixture.
  const BASE = {
    userId: 'u1',
    windowStartLocal: '09:00:00',
    windowEndLocal: '17:00:00',
    activeDays: [1, 2, 3],
    cadence: 'custom',
    durationPreference: null,
    voice: 'warm',
    stillness: 'off',
    lectio: false,
    calendarEnabled: true,
    healthEnabled: true,
    communicationEnabled: true,
    notifyOnSkip: true,
    examenEnabled: false,
    sabbathDay: 0,
    sabbathEnabled: false,
    sabbathSession: false,
    liturgicalSeasonsEnabled: false,
    minPerWeek: 2,
    adaptiveEnabled: true,
    onboardedAt: null,
    timezone: 'UTC',
    language: 'en',
    translationId: 3034,
    updatedAt: '2026-07-23T12:00:00Z',
  };

  it('is optional (an older server omitting it must not fail the whole preferences parse — #244)', () => {
    expect(PreferencesResponseDataSchema.safeParse(BASE).success).toBe(true);
  });

  it('when present, the closed shape is enforced inside the payload too', () => {
    expect(PreferencesResponseDataSchema.safeParse({ ...BASE, rhythm: VALID }).success).toBe(true);
    expect(
      PreferencesResponseDataSchema.safeParse({ ...BASE, rhythm: { ...VALID, streak: 3 } }).success,
    ).toBe(false);
  });
});
