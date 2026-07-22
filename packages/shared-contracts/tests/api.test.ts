import { describe, it, expect } from 'vitest';
import {
  AccountDeletionResponseSchema,
  activeDaysForCadence,
  BandsUploadRequestSchema,
  cadenceForActiveDays,
  ErrorEnvelopeSchema,
  GENERIC_INTERNAL_ERROR_MESSAGE,
  IsoDateParamSchema,
  isValidIsoDate,
  isValidUuid,
  PreferencesUpdateRequestSchema,
  UuidParamSchema,
} from '../src/index.js';

describe('api/params', () => {
  it('UuidParamSchema accepts a well-formed UUID and rejects garbage', () => {
    expect(UuidParamSchema.safeParse('00000000-0000-4000-8000-000000000000').success).toBe(true);
    expect(UuidParamSchema.safeParse('abc').success).toBe(false);
    expect(UuidParamSchema.safeParse('').success).toBe(false);
    expect(UuidParamSchema.safeParse('00000000-0000-4000-8000-00000000000').success).toBe(false); // one char short
  });

  it('isValidUuid mirrors the schema for a bare boolean check', () => {
    expect(isValidUuid('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(isValidUuid('not-a-uuid')).toBe(false);
  });

  it('IsoDateParamSchema accepts YYYY-MM-DD and rejects other shapes', () => {
    expect(IsoDateParamSchema.safeParse('2026-07-02').success).toBe(true);
    expect(IsoDateParamSchema.safeParse('2026/07/02').success).toBe(false);
    expect(IsoDateParamSchema.safeParse('26-07-02').success).toBe(false);
    expect(IsoDateParamSchema.safeParse('abc').success).toBe(false);
  });

  it('isValidIsoDate rejects a calendar-invalid date that still matches the shape regex', () => {
    expect(isValidIsoDate('2026-02-30')).toBe(false); // February has no 30th
    expect(isValidIsoDate('2026-13-01')).toBe(false); // month 13
    expect(isValidIsoDate('2026-07-02')).toBe(true);
  });
});

describe('api/bands — BandsUploadRequestSchema', () => {
  it('accepts a full five-band payload', () => {
    const result = BandsUploadRequestSchema.safeParse({
      date: '2026-07-02',
      recovery: 'low',
      sleepQuality: 'poor',
      activity: 'sedentary',
      busyness: 'heavy',
      communicationLoad: 'moderate',
      distressSignal: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the three health bands omitted entirely (issue #70 consent/no-data path)', () => {
    const result = BandsUploadRequestSchema.safeParse({
      date: '2026-07-02',
      busyness: 'light',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recovery).toBeUndefined();
      expect(result.data.sleepQuality).toBeUndefined();
      expect(result.data.activity).toBeUndefined();
      expect(result.data.distressSignal).toBe(false); // default
    }
  });

  it('accepts date-only payload (every band omitted)', () => {
    const result = BandsUploadRequestSchema.safeParse({ date: '2026-07-02' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing date', () => {
    const result = BandsUploadRequestSchema.safeParse({ recovery: 'low' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed date', () => {
    const result = BandsUploadRequestSchema.safeParse({ date: '07/02/2026' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid enum value even when the field is optional', () => {
    const result = BandsUploadRequestSchema.safeParse({
      date: '2026-07-02',
      recovery: 'extreme',
    });
    expect(result.success).toBe(false);
  });
});

describe('api/preferences — PreferencesUpdateRequestSchema', () => {
  it('accepts a partial update with only some fields', () => {
    const result = PreferencesUpdateRequestSchema.safeParse({ voice: 'en-US-Chirp3-HD-Kore' });
    expect(result.success).toBe(true);
  });

  it('accepts the full documented field set', () => {
    const result = PreferencesUpdateRequestSchema.safeParse({
      windowStartLocal: '07:00',
      windowEndLocal: '09:00:00',
      activeDays: [1, 2, 3, 4, 5],
      cadence: 'weekdays',
      durationPreference: 'short',
      voice: 'en-US-Chirp3-HD-Kore',
      calendarEnabled: true,
      healthEnabled: false,
      communicationEnabled: false,
      notifyOnSkip: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects free text into the cadence enum column (docs/14 §2.9 regression)', () => {
    const result = PreferencesUpdateRequestSchema.safeParse({ cadence: 'whenever I feel like it' });
    expect(result.success).toBe(false);
  });

  it('rejects free text into the durationPreference enum column', () => {
    const result = PreferencesUpdateRequestSchema.safeParse({ durationPreference: 'infinite' });
    expect(result.success).toBe(false);
  });

  it('accepts an explicit null durationPreference as "auto" (issue #202)', () => {
    // `auto` is offered by the picker but has no enum member; null is how it
    // is carried (migration 1721500000000). Distinct from omitting the field,
    // which means "leave the stored value alone".
    const explicitAuto = PreferencesUpdateRequestSchema.safeParse({ durationPreference: null });
    expect(explicitAuto.success).toBe(true);
    expect(explicitAuto.data?.durationPreference).toBeNull();

    const omitted = PreferencesUpdateRequestSchema.safeParse({});
    expect(omitted.success).toBe(true);
    expect(omitted.data?.durationPreference).toBeUndefined();
  });

  it('rejects an out-of-range activeDays value', () => {
    const result = PreferencesUpdateRequestSchema.safeParse({ activeDays: [0, 7] });
    expect(result.success).toBe(false);
  });

  it('rejects an empty activeDays (K2, #188)', () => {
    // Inert while `active_days` was dead config; since #188 it is the
    // daily run's gate, so `[]` means "never generate a devotional again,
    // silently". Distinct from omitting the field, which still means
    // "leave the stored value alone".
    expect(PreferencesUpdateRequestSchema.safeParse({ activeDays: [] }).success).toBe(false);
    expect(PreferencesUpdateRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe('cadence <-> activeDays derivation (K2, #188)', () => {
  it('names each day set with the cadence it corresponds to', () => {
    expect(cadenceForActiveDays([0, 1, 2, 3, 4, 5, 6])).toBe('daily');
    expect(cadenceForActiveDays([1, 2, 3, 4, 5])).toBe('weekdays');
    expect(cadenceForActiveDays([0, 6])).toBe('custom');
    expect(cadenceForActiveDays([3])).toBe('custom');
  });

  it('is insensitive to order and duplicates', () => {
    // `active_days` is a plain `smallint[]` with no uniqueness or ordering
    // guarantee, so the label must not depend on how the array was stored.
    expect(cadenceForActiveDays([5, 1, 3, 2, 4])).toBe('weekdays');
    expect(cadenceForActiveDays([1, 1, 2, 3, 4, 5])).toBe('weekdays');
  });

  it('expands the presets, and expands `custom` to nothing', () => {
    expect(activeDaysForCadence('daily')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(activeDaysForCadence('weekdays')).toEqual([1, 2, 3, 4, 5]);
    // "The days I picked" — there is no set to expand to, so a
    // cadence-only write of `custom` must leave the stored days alone.
    expect(activeDaysForCadence('custom')).toBeUndefined();
  });

  it('round-trips: expanding a preset and re-deriving returns the same label', () => {
    // This is the property that makes a contradictory stored pair
    // unrepresentable — without it, the write path could produce a row
    // whose own two columns disagree, which is exactly the state every
    // pre-#188 row shipped in.
    for (const cadence of ['daily', 'weekdays'] as const) {
      expect(cadenceForActiveDays(activeDaysForCadence(cadence)!)).toBe(cadence);
    }
  });

  it('rejects a malformed time string', () => {
    const result = PreferencesUpdateRequestSchema.safeParse({ windowStartLocal: '25:00' });
    expect(result.success).toBe(false);
  });

  it('silently strips an unknown/smuggled field rather than failing the whole request', () => {
    const result = PreferencesUpdateRequestSchema.safeParse({
      voice: 'ok-voice',
      userId: 'attacker-controlled',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).userId).toBeUndefined();
      expect(result.data.voice).toBe('ok-voice');
    }
  });

  it('empty object is valid (no-op update)', () => {
    expect(PreferencesUpdateRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe('api/account — AccountDeletionResponseSchema', () => {
  it('accepts the minimal ok envelope', () => {
    expect(AccountDeletionResponseSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it('rejects ok:false', () => {
    expect(AccountDeletionResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });
});

describe('api/errorEnvelope', () => {
  it('accepts a well-formed error envelope', () => {
    const result = ErrorEnvelopeSchema.safeParse({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: GENERIC_INTERNAL_ERROR_MESSAGE, retryable: false },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing error.message', () => {
    const result = ErrorEnvelopeSchema.safeParse({
      ok: false,
      error: { code: 'INTERNAL_ERROR', retryable: false },
    });
    expect(result.success).toBe(false);
  });
});
