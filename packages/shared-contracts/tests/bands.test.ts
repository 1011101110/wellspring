import { describe, it, expect } from 'vitest';
import {
  RecoverySchema,
  SleepQualitySchema,
  ActivitySchema,
  BusynessSchema,
  CommunicationLoadSchema,
  TimeOfDayBucketSchema,
  TraditionSchema,
  DevotionalFormatSchema,
  BandInputSchema,
} from '../src/index.js';

describe('band enums', () => {
  it('accepts every canonical recovery value', () => {
    for (const v of ['low', 'moderate', 'high']) {
      expect(RecoverySchema.safeParse(v).success).toBe(true);
    }
  });

  it('rejects a value not in the canonical spelling', () => {
    expect(RecoverySchema.safeParse('Low').success).toBe(false);
    expect(RecoverySchema.safeParse('med').success).toBe(false);
    expect(RecoverySchema.safeParse('').success).toBe(false);
  });

  it('accepts every canonical sleepQuality value', () => {
    for (const v of ['poor', 'fair', 'good']) {
      expect(SleepQualitySchema.safeParse(v).success).toBe(true);
    }
  });

  it('accepts every canonical activity value', () => {
    for (const v of ['sedentary', 'moderate', 'active']) {
      expect(ActivitySchema.safeParse(v).success).toBe(true);
    }
  });

  it('accepts every canonical busyness value', () => {
    for (const v of ['light', 'moderate', 'heavy']) {
      expect(BusynessSchema.safeParse(v).success).toBe(true);
    }
  });

  it('communicationLoad accepts the three bands and null, rejects other falsy/garbage', () => {
    for (const v of ['light', 'moderate', 'heavy', null]) {
      expect(CommunicationLoadSchema.safeParse(v).success).toBe(true);
    }
    expect(CommunicationLoadSchema.safeParse(undefined).success).toBe(false);
    expect(CommunicationLoadSchema.safeParse('none').success).toBe(false);
  });

  it('accepts every canonical time-of-day bucket', () => {
    for (const v of ['early_morning', 'midday', 'early_afternoon', 'late_afternoon', 'evening']) {
      expect(TimeOfDayBucketSchema.safeParse(v).success).toBe(true);
    }
    expect(TimeOfDayBucketSchema.safeParse('night').success).toBe(false);
  });

  it('accepts every canonical tradition and rejects "contemplative" (a tone, not a tradition)', () => {
    // `anglican`/`orthodox` added by issue #192; Foundation §7 is the source of truth.
    for (const v of ['evangelical', 'catholic', 'mainline', 'anglican', 'orthodox', 'general']) {
      expect(TraditionSchema.safeParse(v).success).toBe(true);
    }
    expect(TraditionSchema.safeParse('contemplative').success).toBe(false);
  });

  it('caps the tradition enum at exactly the six Foundation §7 values', () => {
    // #192 capped this enum deliberately: each value costs a live theological-QA
    // column (#47) and a row in the onboarding picker. Growing it should require
    // editing this assertion — i.e. be a decision, not a drive-by.
    expect([...TraditionSchema.options].sort()).toEqual(
      ['anglican', 'catholic', 'evangelical', 'general', 'mainline', 'orthodox'],
    );
  });

  it('accepts every canonical devotional format', () => {
    for (const v of ['micro', 'short', 'standard', 'extended']) {
      expect(DevotionalFormatSchema.safeParse(v).success).toBe(true);
    }
    expect(DevotionalFormatSchema.safeParse('long').success).toBe(false);
  });
});

describe('BandInputSchema', () => {
  it('parses a full valid band bundle', () => {
    const result = BandInputSchema.safeParse({
      recovery: 'low',
      sleepQuality: 'poor',
      activity: 'sedentary',
      busyness: 'heavy',
      communicationLoad: 'heavy',
      distressSignal: false,
    });
    expect(result.success).toBe(true);
  });

  it('defaults communicationLoad to null and distressSignal to false when omitted', () => {
    const result = BandInputSchema.parse({
      recovery: 'moderate',
      sleepQuality: 'fair',
      activity: 'moderate',
      busyness: 'moderate',
    });
    expect(result.communicationLoad).toBeNull();
    expect(result.distressSignal).toBe(false);
  });

  it('rejects a bundle missing a required band', () => {
    const result = BandInputSchema.safeParse({
      recovery: 'low',
      sleepQuality: 'poor',
      // activity missing
      busyness: 'heavy',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bundle with an invalid enum value', () => {
    const result = BandInputSchema.safeParse({
      recovery: 'extreme',
      sleepQuality: 'poor',
      activity: 'sedentary',
      busyness: 'heavy',
    });
    expect(result.success).toBe(false);
  });
});
