import { RecoverySchema, SleepQualitySchema, BusynessSchema } from './bands.js';
import type { Recovery, SleepQuality, Busyness } from './bands.js';

/**
 * Fallback-map key — Foundation §5: `{recovery}_{sleepQuality}_{busyness}`
 * (e.g. `low_poor_heavy`). Used to look up band-keyed fixture devotionals
 * when the Gloo tool loop + one repair round-trip both fail (Test Plan §1
 * DevotionalEngine case), and to name the five canonical demo fixtures.
 */
export function fallbackKey(
  recovery: Recovery,
  sleepQuality: SleepQuality,
  busyness: Busyness,
): string {
  return `${recovery}_${sleepQuality}_${busyness}`;
}

/** All 27 valid fallback keys (3 recovery x 3 sleepQuality x 3 busyness). */
export function allFallbackKeys(): string[] {
  const keys: string[] = [];
  for (const recovery of RecoverySchema.options) {
    for (const sleepQuality of SleepQualitySchema.options) {
      for (const busyness of BusynessSchema.options) {
        keys.push(fallbackKey(recovery, sleepQuality, busyness));
      }
    }
  }
  return keys;
}

/** Parses a fallback key back into its component bands; throws if malformed. */
export function parseFallbackKey(key: string): {
  recovery: Recovery;
  sleepQuality: SleepQuality;
  busyness: Busyness;
} {
  const parts = key.split('_');
  if (parts.length !== 3) {
    throw new Error(
      `Malformed fallback key: "${key}" (expected "{recovery}_{sleepQuality}_{busyness}")`,
    );
  }
  const [recoveryRaw, sleepQualityRaw, busynessRaw] = parts;
  const recovery = RecoverySchema.parse(recoveryRaw);
  const sleepQuality = SleepQualitySchema.parse(sleepQualityRaw);
  const busyness = BusynessSchema.parse(busynessRaw);
  return { recovery, sleepQuality, busyness };
}

type FallbackBands = { recovery: Recovery; sleepQuality: SleepQuality; busyness: Busyness };

function axisIndex<T extends string>(options: readonly T[], value: T): number {
  return options.indexOf(value);
}

/**
 * Manhattan distance between two band combos across the three fallback axes.
 * Each axis is a 3-value ordinal scale (e.g. low/moderate/high), so a
 * per-axis difference is 0, 1, or 2 and the total ranges 0-6.
 */
export function fallbackKeyDistance(a: FallbackBands, b: FallbackBands): number {
  return (
    Math.abs(
      axisIndex(RecoverySchema.options, a.recovery) - axisIndex(RecoverySchema.options, b.recovery),
    ) +
    Math.abs(
      axisIndex(SleepQualitySchema.options, a.sleepQuality) -
        axisIndex(SleepQualitySchema.options, b.sleepQuality),
    ) +
    Math.abs(
      axisIndex(BusynessSchema.options, a.busyness) - axisIndex(BusynessSchema.options, b.busyness),
    )
  );
}

/**
 * Nearest-neighbor fallback key (issue #78): picks whichever of
 * `candidateKeys` has the smallest `fallbackKeyDistance` to `target` — an
 * exact match (distance 0) wins if present among the candidates, and
 * degrading one axis at a time toward the middle value is exactly what
 * shrinks this distance, so this generalizes the "degrade toward
 * moderate/fair" heuristic to whatever fixture files actually exist on
 * disk rather than hardcoding a fixed degrade order. Ties break by
 * ascending key string, so the result is deterministic regardless of
 * `candidateKeys` ordering (e.g. filesystem readdir order).
 *
 * Throws if `candidateKeys` is empty — callers must guarantee at least
 * `moderate_fair_moderate` (Foundation §5's documented terminal default)
 * is always among the candidates.
 */
export function nearestFallbackKey(target: FallbackBands, candidateKeys: string[]): string {
  if (candidateKeys.length === 0) {
    throw new Error('nearestFallbackKey: no candidate keys provided');
  }
  let best: { key: string; distance: number } | null = null;
  for (const key of candidateKeys) {
    const distance = fallbackKeyDistance(target, parseFallbackKey(key));
    if (best === null || distance < best.distance || (distance === best.distance && key < best.key)) {
      best = { key, distance };
    }
  }
  return best!.key;
}
