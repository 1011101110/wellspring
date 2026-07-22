import { z } from 'zod';

/**
 * Derived signal bands — canonical enum spellings.
 * Source of truth: docs/00_FOUNDATION.md §5. Exact strings; do not add
 * values here without updating that file first.
 */

export const RecoverySchema = z.enum(['low', 'moderate', 'high']);
export type Recovery = z.infer<typeof RecoverySchema>;

export const SleepQualitySchema = z.enum(['poor', 'fair', 'good']);
export type SleepQuality = z.infer<typeof SleepQualitySchema>;

export const ActivitySchema = z.enum(['sedentary', 'moderate', 'active']);
export type Activity = z.infer<typeof ActivitySchema>;

export const BusynessSchema = z.enum(['light', 'moderate', 'heavy']);
export type Busyness = z.infer<typeof BusynessSchema>;

/**
 * communicationLoad is a stretch signal: null when not connected.
 * Foundation §5 lists `null` as one of its "values" — modeled here as
 * .nullable() over the three real bands rather than a fourth literal.
 */
export const CommunicationLoadSchema = z.enum(['light', 'moderate', 'heavy']).nullable();
export type CommunicationLoad = z.infer<typeof CommunicationLoadSchema>;

/** Coarse time-of-day bucket — the only timing signal sent to Gloo (Foundation §8). */
export const TimeOfDayBucketSchema = z.enum([
  'early_morning',
  'midday',
  'early_afternoon',
  'late_afternoon',
  'evening',
]);
export type TimeOfDayBucket = z.infer<typeof TimeOfDayBucketSchema>;

/**
 * Tradition enum — Foundation §7. "Contemplative" is a tone, never a tradition value.
 *
 * `anglican` and `orthodox` added by issue #192 (K6): Anglican/Episcopal users were
 * landing in `mainline`, which missed the Book of Common Prayer frame entirely, and
 * Orthodox users had no representation at all (`general` is a poor fit given a distinct
 * liturgical calendar and a Septuagint-based Old Testament canon).
 *
 * This enum is now explicitly CAPPED at six values (#192's accepted recommendation).
 * Finer denominational variation is carried by the existing practice flags —
 * `lectio`, `liturgical_seasons_enabled`, `stillness`, `sabbath_*` — not by growing
 * this list: every added value multiplies the #47 theological-QA surface (each needs
 * its own rubric row reviewed by someone who knows the tradition), and a long
 * denominational picker is both onboarding friction and an identity question many
 * users would rather not answer to an app.
 */
export const TraditionSchema = z.enum([
  'evangelical',
  'catholic',
  'mainline',
  'anglican',
  'orthodox',
  'general',
]);
export type Tradition = z.infer<typeof TraditionSchema>;

/** DevotionalOutput format — Foundation §6 / §5 format heuristics. */
export const DevotionalFormatSchema = z.enum(['micro', 'short', 'standard', 'extended']);
export type DevotionalFormat = z.infer<typeof DevotionalFormatSchema>;

/**
 * A devotional's slot — `standard` is the ordinary morning-window
 * devotional; `examen` is the evening reflection (docs/14 §5.3, issue
 * #77). Distinct from `cadence` (day-of-week recurrence): `slotType`
 * identifies what KIND of devotional a row is, so a user can have one
 * `standard` and one `examen` devotional on the same date without either
 * being mistaken as a duplicate of the other.
 */
export const SlotTypeSchema = z.enum(['standard', 'examen']);
export type SlotType = z.infer<typeof SlotTypeSchema>;

/**
 * The full band bundle used to key fallback content and to build the
 * (privacy-safe) signal payload sent to Gloo. `distressSignal` is a manual
 * check-in flag, not a HealthKit-derived band — Foundation §5 format
 * heuristics: distressSignal=true always forces micro + comfort.
 */
export const BandInputSchema = z.object({
  recovery: RecoverySchema,
  sleepQuality: SleepQualitySchema,
  activity: ActivitySchema,
  busyness: BusynessSchema,
  communicationLoad: CommunicationLoadSchema.default(null),
  distressSignal: z.boolean().default(false),
});
export type BandInput = z.infer<typeof BandInputSchema>;
