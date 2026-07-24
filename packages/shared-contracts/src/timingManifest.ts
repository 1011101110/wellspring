import { z } from 'zod';

/**
 * Stage timing manifest — Epic Q (kairos-devotional #330), story Q1 (#331).
 *
 * Emitted at TTS synthesis time and stored alongside the devotional MP3
 * (`AudioStorage.uploadManifest`), then inlined into the Stage page
 * (`GET /stage/:token`, Q2 #332), which drives its tab highlighting and
 * live-caption chip purely from `audio.currentTime` against these rows —
 * no `<mark>` timepoints (unconfirmed on Chirp3-HD, killed in the epic),
 * no re-analysis at serve time.
 *
 * Language-agnostic by design (Epic O #311 merged): `text` carries
 * whatever was actually spoken, in whatever language the devotional was
 * generated in.
 */

/**
 * The five section labels a spoken segment can carry. `journalingPrompt`
 * / `actionStep` are intentionally never spoken in the standard format
 * (ssmlBuilder.ts header), so there is no 'questions' section — the Stage
 * page's QUESTIONS tab activates only after the audio ends. Lectio's
 * spoken journaling question is labeled 'reflection' (it plays the role
 * the body plays in the standard format). The closing reference recap is
 * labeled 'scripture' — it names the passage again, and the Stage page
 * returning to the verse for the final line is the intended close.
 */
export const STAGE_SECTIONS = [
  'greeting',
  'scripture',
  'stillness',
  'reflection',
  'prayer',
  // The Open Moment window (EPIC V #360 / V4 #365) — the spoken invitation
  // that ends the QUESTIONS beat, marking the start of the bounded listening
  // window. The V3 Stage page TRIGGERS the window on this marker (opens the
  // mic + shows the breathing orb) and shows NO caption during it — the
  // screen belongs to the question + orb, not a caption chip (#361 step 2).
  // Additive: pre-#360 manifests simply never carry this section, so every
  // existing devotional's manifest is byte-identical.
  'open_moment',
] as const;

export const StageSectionSchema = z.enum(STAGE_SECTIONS);
export type StageSection = z.infer<typeof StageSectionSchema>;

/**
 * One coalesced row of the timing manifest. Invariants (asserted in
 * tests, produced by TtsService.synthesize):
 *   - rows appear in script order; the first `startSec` is 0;
 *   - each row's `startSec` equals the previous row's `endSec`;
 *   - `text` is the plain spoken caption text (pre-`escapeSsml`, never
 *     SSML markup); stillness rows carry `text: ''`;
 *   - adjacent same-section segments (byte-limit body chunks, multiple
 *     verses) are coalesced into one row spanning their combined time.
 */
export const TimingManifestEntrySchema = z.object({
  section: StageSectionSchema,
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  text: z.string(),
});
export type TimingManifestEntry = z.infer<typeof TimingManifestEntrySchema>;

export const TimingManifestSchema = z.array(TimingManifestEntrySchema);
export type TimingManifest = z.infer<typeof TimingManifestSchema>;
