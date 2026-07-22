import { describe, it, expect } from 'vitest';
import {
  fallbackKey,
  allFallbackKeys,
  parseFallbackKey,
  fallbackKeyDistance,
  nearestFallbackKey,
  RecoverySchema,
  SleepQualitySchema,
  BusynessSchema,
} from '../src/index.js';

describe('fallbackKey', () => {
  it('builds the documented example from Foundation §5', () => {
    expect(fallbackKey('low', 'poor', 'heavy')).toBe('low_poor_heavy');
  });

  it('builds keys for the other four canonical demo scenarios', () => {
    expect(fallbackKey('high', 'good', 'light')).toBe('high_good_light');
    expect(fallbackKey('moderate', 'poor', 'heavy')).toBe('moderate_poor_heavy');
    expect(fallbackKey('moderate', 'fair', 'moderate')).toBe('moderate_fair_moderate');
  });

  it('produces exactly 27 unique keys across the full band grid', () => {
    const keys = allFallbackKeys();
    expect(keys).toHaveLength(27);
    expect(new Set(keys).size).toBe(27);
  });

  it('every generated key round-trips through parseFallbackKey', () => {
    for (const key of allFallbackKeys()) {
      const { recovery, sleepQuality, busyness } = parseFallbackKey(key);
      expect(fallbackKey(recovery, sleepQuality, busyness)).toBe(key);
    }
  });

  it('every generated key uses only canonical enum members', () => {
    for (const key of allFallbackKeys()) {
      const [recovery, sleepQuality, busyness] = key.split('_');
      expect(RecoverySchema.safeParse(recovery).success).toBe(true);
      expect(SleepQualitySchema.safeParse(sleepQuality).success).toBe(true);
      expect(BusynessSchema.safeParse(busyness).success).toBe(true);
    }
  });

  it('parseFallbackKey throws on a malformed key (wrong segment count)', () => {
    expect(() => parseFallbackKey('low_poor')).toThrow();
    expect(() => parseFallbackKey('low_poor_heavy_extra')).toThrow();
  });

  it('parseFallbackKey throws on a key with an invalid band value', () => {
    expect(() => parseFallbackKey('extreme_poor_heavy')).toThrow();
    expect(() => parseFallbackKey('low_terrible_heavy')).toThrow();
    expect(() => parseFallbackKey('low_poor_slammed')).toThrow();
  });
});

describe('fallbackKeyDistance (issue #78)', () => {
  it('is zero for identical bands', () => {
    const bands = parseFallbackKey('moderate_fair_moderate');
    expect(fallbackKeyDistance(bands, bands)).toBe(0);
  });

  it('is symmetric', () => {
    const a = parseFallbackKey('low_poor_heavy');
    const b = parseFallbackKey('high_good_light');
    expect(fallbackKeyDistance(a, b)).toBe(fallbackKeyDistance(b, a));
  });

  it('sums per-axis ordinal distance across all three axes', () => {
    // low_poor_heavy vs high_good_light: every axis is maximally apart (2).
    const a = parseFallbackKey('low_poor_heavy');
    const b = parseFallbackKey('high_good_light');
    expect(fallbackKeyDistance(a, b)).toBe(6);
  });

  it('is 1 for a single one-step axis difference', () => {
    const a = parseFallbackKey('moderate_fair_moderate');
    const b = parseFallbackKey('high_fair_moderate');
    expect(fallbackKeyDistance(a, b)).toBe(1);
  });
});

describe('nearestFallbackKey (issue #78)', () => {
  const CANONICAL_FIVE = [
    'low_poor_heavy',
    'moderate_poor_heavy',
    'moderate_fair_moderate',
    'high_good_light',
  ];

  it('returns the exact key when it is among the candidates', () => {
    expect(nearestFallbackKey(parseFallbackKey('moderate_poor_heavy'), CANONICAL_FIVE)).toBe(
      'moderate_poor_heavy',
    );
  });

  it('picks the closer of two candidates by ordinal distance, not just any match', () => {
    // moderate_good_light: distance 1 to high_good_light (recovery only),
    // distance 2 to moderate_fair_moderate (sleepQuality + busyness).
    const target = { recovery: 'moderate' as const, sleepQuality: 'good' as const, busyness: 'light' as const };
    expect(nearestFallbackKey(target, CANONICAL_FIVE)).toBe('high_good_light');
  });

  it('falls back to moderate_fair_moderate as the guaranteed terminal default when nothing else is closer', () => {
    const target = { recovery: 'high' as const, sleepQuality: 'poor' as const, busyness: 'moderate' as const };
    expect(nearestFallbackKey(target, CANONICAL_FIVE)).toBe('moderate_fair_moderate');
  });

  it('breaks ties deterministically by ascending key string', () => {
    // Both candidates are distance 1 from moderate_fair_moderate itself.
    const target = parseFallbackKey('moderate_fair_moderate');
    expect(nearestFallbackKey(target, ['high_fair_moderate', 'low_fair_moderate'])).toBe(
      'high_fair_moderate',
    );
  });

  it('throws for an empty candidate list', () => {
    expect(() => nearestFallbackKey(parseFallbackKey('moderate_fair_moderate'), [])).toThrow();
  });

  it('resolves every one of the 27 band keys to some candidate among the canonical five', () => {
    for (const key of allFallbackKeys()) {
      const resolved = nearestFallbackKey(parseFallbackKey(key), CANONICAL_FIVE);
      expect(CANONICAL_FIVE).toContain(resolved);
    }
  });
});
