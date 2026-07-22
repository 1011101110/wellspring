import { z } from 'zod';
import { DevotionalFormatSchema } from './bands.js';

/**
 * A verse fetched via the canonical `get_bible_verse` tool. `fetchedText`
 * must be the exact YouVersion response text — never model-generated
 * (Foundation §4.3, §9: "Exact Scripture text always comes from YouVersion").
 */
export const VerseSchema = z.object({
  usfm: z.string().min(1, 'usfm reference is required'),
  versionId: z.number().int().positive(),
  /** Human-readable reference (e.g. "Matthew 11:28-30") — YouVersion's passage response supplies this alongside the text (docs/14 §5.1). Spoken before/after the verse and rendered as the heading on both surfaces so the listener learns *where* the passage lives. */
  reference: z.string().min(1, 'reference is required'),
  fetchedText: z.string().min(1, 'fetchedText must not be empty'),
  attribution: z.string().min(1, 'attribution must not be empty'),
});
export type Verse = z.infer<typeof VerseSchema>;

/**
 * DevotionalOutput — Gloo structured output. Foundation §6.
 * cardSummary hard cap is 300 chars (soft target <=280); word-count
 * targets per format are enforced by the theological-QA rubric
 * (Test Plan §4), not by this schema, since counting words on partial/
 * in-progress model output would produce false negatives here.
 */
export const DevotionalOutputSchema = z.object({
  format: DevotionalFormatSchema,
  theme: z.string().min(1),
  verses: z.array(VerseSchema).min(1, 'at least one verse is required'),
  devotionalBody: z.string().min(1),
  cardSummary: z.string().min(1).max(300, 'cardSummary must be <=300 chars (hard limit)'),
  prayer: z.string().min(1),
  // .nullish() (not .optional()) — the canonical example in Foundation §6
  // shows Gloo emitting explicit `null` for the fields that don't apply to
  // a given format; treating that as a validation failure burns a repair
  // round-trip for a value that was never actually wrong (docs/14 §3.8 /
  // issue #90).
  journalingPrompt: z.string().min(1).nullish(),
  actionStep: z.string().min(1).nullish(),
});
export type DevotionalOutput = z.infer<typeof DevotionalOutputSchema>;

/** Soft target for cardSummary — Foundation §6 says "<=280 chars (hard 300)". */
export const CARD_SUMMARY_SOFT_LIMIT = 280;
export const CARD_SUMMARY_HARD_LIMIT = 300;

/** Word-count targets per format, spoken-minute equivalents — Foundation §6. */
export const DEVOTIONAL_BODY_WORD_TARGETS: Record<
  z.infer<typeof DevotionalFormatSchema>,
  { min: number; max: number }
> = {
  micro: { min: 100, max: 200 },
  short: { min: 250, max: 400 },
  standard: { min: 500, max: 750 },
  extended: { min: 900, max: 1300 },
};

/**
 * `journalingPrompt` is extended-only and `actionStep` is standard+extended
 * only per Foundation §6. This refinement is intentionally lenient (it does
 * not forbid extra fields on other formats) because Gloo output shape is
 * still evolving pre-first-live-call; it only enforces the documented
 * *requirement* direction, not exclusivity.
 */
export function validateDevotionalOutput(input: unknown) {
  return DevotionalOutputSchema.safeParse(input);
}
