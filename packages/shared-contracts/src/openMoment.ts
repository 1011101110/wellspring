import { z } from 'zod';
import { VerseSchema } from './devotional.js';
import { LanguageTagSchema } from './language.js';
import { TraditionSchema } from './bands.js';

/**
 * The Open Moment (EPIC V, kairos-devotional #360 / feature #361) — the
 * bounded listening window after the devotional's question, in which the
 * listener may answer aloud and receive ONE grounded response, or keep
 * silence and receive a warm close.
 *
 * This file is the wire + storage contract for that beat, shared between
 * apps/api (the V2 response engine + route, the V4 generation flag) and the
 * V3 Stage page. Source of truth for the groundedness rules these schemas
 * enforce is the epic's "Groundedness architecture" section — read it
 * before changing anything here.
 */

/**
 * The structured, validated shape the model MUST produce before a single
 * word is spoken (epic §2: "Nothing is spoken until validated"). The
 * response is a fixed liturgy — acknowledgment → verse → framing — never a
 * chat turn (epic §3):
 *
 *  - `acknowledgment`: ONE short sentence that honors what was shared
 *    WITHOUT analyzing, advising, or echoing the listener's words back
 *    (it inherits the prayerIntention doctrine — instructionsBuilder.ts).
 *    Capped at 180 chars so the liturgy stays a beat, not a monologue.
 *  - `verse`: the SAME `VerseSchema` the devotional pipeline uses — its
 *    `fetchedText`/`reference` are overwritten server-side from the exact
 *    `get_bible_verse` YouVersion bytes BEFORE validation
 *    (`applyAuthoritativeFetchedText`), so the model can only CHOOSE
 *    Scripture, never write it (epic §1).
 *  - `framing`: ONE short prayerful sentence leading into the close.
 *    Capped at 240 chars.
 *
 * `.strict()` so a model that invents extra fields fails validation and
 * routes to silence, rather than smuggling unvalidated content to TTS.
 */
export const LIVE_ACKNOWLEDGMENT_MAX_LENGTH = 180;
export const LIVE_FRAMING_MAX_LENGTH = 240;

export const LiveResponseSchema = z
  .object({
    acknowledgment: z
      .string()
      .min(1, 'acknowledgment must not be empty')
      .max(
        LIVE_ACKNOWLEDGMENT_MAX_LENGTH,
        `acknowledgment must be <=${LIVE_ACKNOWLEDGMENT_MAX_LENGTH} chars`,
      ),
    verse: VerseSchema,
    framing: z
      .string()
      .min(1, 'framing must not be empty')
      .max(LIVE_FRAMING_MAX_LENGTH, `framing must be <=${LIVE_FRAMING_MAX_LENGTH} chars`),
  })
  .strict();
export type LiveResponse = z.infer<typeof LiveResponseSchema>;

/**
 * Verse display fields returned to the Stage page — the provenance shown
 * on camera as the response lands (epic §1: "Reference + translation
 * render on the Stage as the response lands"). A subset of `VerseSchema`:
 * the Stage never needs `usfm`/`versionId` (internal identifiers), only
 * what is read and shown.
 */
export const LiveVerseDisplaySchema = z.object({
  reference: z.string().min(1),
  fetchedText: z.string().min(1),
  attribution: z.string().min(1),
});
export type LiveVerseDisplay = z.infer<typeof LiveVerseDisplaySchema>;

/**
 * Best-effort per-part spoken durations (seconds), for the Stage page to
 * pace the orb/caption against `audio.currentTime`. All default to 0 when
 * duration measurement is unavailable (ffmpeg absent) — the page degrades
 * to "play the whole clip", never errors.
 */
export const LiveResponseDurationsSchema = z.object({
  acknowledgmentSec: z.number().min(0),
  verseSec: z.number().min(0),
  framingSec: z.number().min(0),
  totalSec: z.number().min(0),
});
export type LiveResponseDurations = z.infer<typeof LiveResponseDurationsSchema>;

/**
 * The response envelope returned by `POST /v1/stage/:token/respond`.
 *
 * Exactly two outcomes (feature #361's two graceful exits):
 *  - `response`: a validated grounded response was synthesized. Carries
 *    the signed `audioUrl`, the verse display fields, and durations.
 *  - `silence`: the honored-silence path — an empty/garbled transcript, a
 *    distress-free validation failure, or any engine error. The Stage
 *    renders the warm silence-close (pre-synthesized in V4); NOTHING
 *    unvalidated is ever spoken (epic §2/§6).
 *
 * A `distressFlagged` response is still `outcome: 'response'` — the 988
 * variant is a grounded response, not a silence.
 */
export const OpenMomentOutcomeSchema = z.enum(['response', 'silence']);
export type OpenMomentOutcome = z.infer<typeof OpenMomentOutcomeSchema>;

export const OpenMomentResponseEnvelopeSchema = z
  .object({
    outcome: OpenMomentOutcomeSchema,
    /** Present only when outcome === 'response'. */
    audioUrl: z.string().url().optional(),
    verse: LiveVerseDisplaySchema.optional(),
    durations: LiveResponseDurationsSchema.optional(),
    /**
     * Whether the distress heuristics flagged the spoken transcript and
     * the 988 comfort variant was served (epic §4). Surfaced so the Stage
     * can render the resource line on screen, and so ops can see the rate
     * WITHOUT ever logging the transcript.
     */
    distressFlagged: z.boolean().optional(),
  })
  .strict();
export type OpenMomentResponseEnvelope = z.infer<typeof OpenMomentResponseEnvelopeSchema>;

/**
 * Request body for `POST /v1/stage/:token/respond`.
 *
 * The TEXT path (V2): the caller supplies a `transcript` string (the
 * voice-agent's server-side STT result, or the standalone browser's STT).
 * The audio-blob + server-STT path is V1's decision and is NOT built here
 * — see the route's STT seam comment. An empty/whitespace transcript is a
 * VALID request that resolves to the silence outcome (choosing not to
 * speak is an honored path, not an error — feature #361 Path B).
 */
export const OPEN_MOMENT_TRANSCRIPT_MAX_LENGTH = 2000;

export const OpenMomentRequestBodySchema = z
  .object({
    transcript: z.string().max(OPEN_MOMENT_TRANSCRIPT_MAX_LENGTH),
  })
  .strict();
export type OpenMomentRequestBody = z.infer<typeof OpenMomentRequestBodySchema>;

/**
 * The generation-time context the V2 response engine needs, captured on the
 * devotional row when V4 generates with the open moment enabled, and read
 * back at respond time.
 *
 * WHY IT IS PERSISTED WITH THE DEVOTIONAL and not re-resolved from
 * preferences at respond time: it must be byte-identical to what the
 * devotional was generated with (same voice, same language, same
 * translation the listener has been hearing for ten minutes) — re-reading
 * a preference the user changed mid-session would make the answer speak in
 * a different voice than the devotional that asked the question. Storing it
 * once, at generation, makes that impossible by construction. A `null`
 * column means the open moment is NOT enabled for this devotional (the gate
 * the respond route checks) — fixtures and distress check-ins always store
 * `null` (they have no live engine / must never be prompted to perform).
 */
export const OpenMomentContextSchema = z
  .object({
    language: LanguageTagSchema,
    tradition: TraditionSchema,
    /** Human-readable translation label for the model's prose framing, e.g. "BSB". */
    translation: z.string().min(1),
    /** Default YouVersion versionId the model should prefer for get_bible_verse. */
    preferredVersionId: z.number().int().positive(),
    /** The catalog-validated voice name the devotional was synthesized with (#202). */
    voiceName: z.string().min(1),
  })
  .strict();
export type OpenMomentContext = z.infer<typeof OpenMomentContextSchema>;

/**
 * What is persisted on the session row after the ONE allowed response, so a
 * second POST returns the first result instead of re-running the engine
 * (idempotency, V2 #363). Deliberately does NOT include the transcript
 * (epic §5: transcript is never persisted) — only the outcome, the distress
 * flag, and, on a response, the synthetic audio id (re-signed to a fresh
 * URL on each read — signed URLs are never stored), the verse display
 * fields, and the durations.
 */
export const OpenMomentStoredResponseSchema = z
  .object({
    outcome: OpenMomentOutcomeSchema,
    distressFlagged: z.boolean(),
    /** Synthetic audio-storage id for the response clip (re-signed on read). Absent on silence. */
    audioId: z.string().min(1).optional(),
    verse: LiveVerseDisplaySchema.optional(),
    durations: LiveResponseDurationsSchema.optional(),
  })
  .strict();
export type OpenMomentStoredResponse = z.infer<typeof OpenMomentStoredResponseSchema>;
