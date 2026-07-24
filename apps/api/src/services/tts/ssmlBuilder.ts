/**
 * SSML builder for the TTS devotional script — API spec §6 / Foundation §6.
 *
 * Section order (per §6): greeting → verse(s) (each followed by a longer
 * pause + spoken short-form attribution) → body → prayer, with a shorter
 * pause between the other sections. `journalingPrompt` / `actionStep` are
 * text-only surfaces (session page / calendar description), not part of
 * the TTS script per the spec's section list, so they are intentionally
 * excluded here.
 *
 * Language (Epic O #311 / story O4 #316): the fixed connective lines this
 * file speaks around the generated content come from the per-language
 * table in spokenPhrases.ts, selected by the `language` parameter
 * (default `'en'`, which is byte-identical to the pre-#316 output). All
 * break timings are language-independent — stillness/lectio durations do
 * not change when the words around them do.
 */

import type {
  DevotionalOutput,
  LanguageTag,
  LiveResponse,
  StageSection,
  Stillness,
} from '@kairos/shared-contracts';
import { SPOKEN_PHRASES, type SpokenPhrases } from './spokenPhrases.js';

/**
 * One labeled SSML segment (Q1 #331). `ssml` is a complete `<speak>`
 * document (what gets sent to Cloud TTS); `text` is the plain spoken text
 * of the same segment BEFORE `escapeSsml` — the Stage page's caption
 * source. Stillness segments carry `text: ''` (the hand-off/re-entry
 * lines are spoken but the Stage caption chip fades out during stillness
 * rather than captioning the silence — story #333).
 */
export interface LabeledSsmlSegment {
  section: StageSection;
  ssml: string;
  text: string;
}

/** Between-section pause — API spec §6: "<break time="1200ms"/> between sections". */
export const SECTION_BREAK_MS = 1200;

/**
 * The response-lead-in breath (EPIC V #360 / V4 #365): a short still pause
 * pre-synthesized so the live grounded response (Path A) has a held beat in
 * front of it with ZERO live timing dependency — the orb has already shifted
 * to stillness; this is the inhale before the answer. 1.5s per the story.
 */
export const OPEN_MOMENT_LEAD_IN_MS = 1500;
/** Pause after each verse reading (before the spoken attribution) — API spec §6: "longer <break time="2s"/> after the verse reading". */
export const VERSE_BREAK_MS = 2000;

/**
 * Stillness (docs/14 §5.2): brief / full genuine encoded silence, spoken
 * after the verse section and again after the prayer.
 */
export const STILLNESS_MS: Record<Exclude<Stillness, 'off'>, number> = {
  brief: 15_000,
  full: 45_000,
};

/**
 * Google Cloud TTS caps a single SSML `<break>` at 10s — undocumented in
 * this repo's own specs, but the ceiling below which every provider we've
 * tested is safe. Stillness durations above that are expressed as
 * multiple chained `<break>` tags summing to the target, rather than one
 * out-of-range tag that the API would reject or silently clamp.
 */
const MAX_BREAK_MS = 10_000;

/** Escapes text for safe inclusion inside SSML markup (XML special chars). */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds a short spoken-form attribution line from the full attribution
 * string (which may include a copyright/publisher tail meant for display,
 * not speech). We speak the reference-ish lead clause only, falling back to
 * the whole string if it doesn't contain an obvious separator.
 *
 * Foundation §4.3 / API spec §3.3: attribution must be spoken in short form,
 * e.g. "Berean Standard Bible" rather than the full public-domain notice.
 */
export function shortSpokenAttribution(attribution: string): string {
  // Attribution strings observed in fixtures look like:
  //   "Berean Standard Bible (BSB). Public domain."
  //   "Berean Standard Bible (BSB) — <copyright...>"
  const dashSplit = attribution.split(/\s+[—-]\s+/)[0];
  const sentenceSplit = dashSplit?.split(/\.\s+/)[0];
  const short = (sentenceSplit ?? attribution).trim().replace(/\.$/, '');
  return short.length > 0 ? short : attribution;
}

const breakTag = (ms: number) => `<break time="${ms}ms"/>`;

/** Wraps escaped text in a `<prosody rate="...">` tag — used only by lectio's two-pass verse reading. */
const prosodyRate = (rate: number, text: string) =>
  `<prosody rate="${rate}">${escapeSsml(text)}</prosody>`;

/**
 * Lectio divina's fixed meditatio silence (docs/14 §5.4, issue #92): the
 * gap between the first, measured-pace verse reading and the second,
 * slower one. Unlike `STILLNESS_MS`, this is not user-configurable — the
 * issue specifies this exact 20s duration as part of the lectio format
 * itself, distinct from the separately-configurable `stillness` preference
 * (which still governs the meditatio->oratio and post-prayer gaps below).
 */
const LECTIO_MEDITATIO_MS = 20_000;

/** Chains multiple `<break>` tags (each ≤ `MAX_BREAK_MS`) summing to `totalMs`. */
function chainedBreaks(totalMs: number): string {
  const tags: string[] = [];
  let remaining = totalMs;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_BREAK_MS);
    tags.push(breakTag(chunk));
    remaining -= chunk;
  }
  return tags.join('');
}

/**
 * The stillness hand-off + genuine encoded silence + gentle re-entry
 * (docs/14 §5.2), spoken once after the verse section and again after the
 * prayer. Returns '' when `stillness` is `off`, so callers can splice this
 * in unconditionally.
 */
function stillnessParts(stillness: Stillness, phrases: SpokenPhrases): string {
  if (stillness === 'off') return '';
  return `<p>${phrases.stillnessHandOff}</p>${chainedBreaks(STILLNESS_MS[stillness])}<p>${phrases.stillnessReturn}</p>`;
}

/**
 * Builds the spoken lead-in for a verse, e.g. "From Matthew 11:28-30." —
 * spoken before the verse text so the listener learns where the passage
 * lives (docs/14 §5.1: "Formation depends on the Word having an address").
 */
function spokenReferenceLeadIn(reference: string, phrases: SpokenPhrases): string {
  return phrases.verseLeadIn(escapeSsml(reference));
}

/** Joins a devotional's verse references with the language's separators, e.g. "Matthew 11:28-30 and John 3:16" — plain text, unescaped. */
function joinedReferences(devotional: DevotionalOutput, phrases: SpokenPhrases): string {
  const references = devotional.verses.map((v) => v.reference);
  // devotional.verses is schema-guaranteed non-empty (VerseSchema `.min(1)`).
  const last = references[references.length - 1] as string;
  return references.length === 1
    ? last
    : `${references.slice(0, -1).join(phrases.referenceListSeparator)}${phrases.referenceFinalJoiner}${last}`;
}

/**
 * Builds the closing reference recap spoken after the prayer, e.g. "That
 * was Matthew 11:28-30 — it'll be here when you want to come back."
 * Joins multiple verse references with the language's "and" when a
 * devotional cites more than one passage.
 */
function spokenReferenceRecap(devotional: DevotionalOutput, phrases: SpokenPhrases): string {
  return phrases.referenceRecap(escapeSsml(joinedReferences(devotional, phrases)));
}

/**
 * Builds the full SSML `<speak>` document for a devotional's spoken script.
 *
 * TEST-ONLY (S1 #342): no production caller. TtsService synthesizes
 * exclusively through `buildDevotionalSsmlSegments` since Q1 (#331)
 * removed the single-document fast path. Kept — deliberately, not as an
 * oversight — because the test suite uses this single-document build as
 * the readable specification of the script structure AND as the oracle
 * the segments function is compared against (ssmlBuilder.test.ts joins
 * the segment bodies and asserts equivalence to this output). Do not wire
 * it back into production; change `buildDevotionalSsmlSegments` instead,
 * and keep this in lockstep so the equivalence test stays meaningful.
 *
 * Structure: greeting → break → [spoken reference → verse text → 2s break →
 * spoken attribution → break] for each verse → stillness (if enabled) →
 * devotionalBody → break → prayer → break → stillness (if enabled) →
 * spoken reference recap.
 */
export function buildDevotionalSsml(
  devotional: DevotionalOutput,
  stillness: Stillness = 'off',
  lectio = false,
  language: LanguageTag = 'en',
): string {
  if (lectio) return buildLectioSsml(devotional, stillness, language);

  const phrases = SPOKEN_PHRASES[language];
  const parts: string[] = [];

  parts.push(`<p>${phrases.greeting(escapeSsml(devotional.theme))}</p>`);
  parts.push(breakTag(SECTION_BREAK_MS));

  for (const verse of devotional.verses) {
    parts.push(`<p>${spokenReferenceLeadIn(verse.reference, phrases)}</p>`);
    parts.push(`<p>${escapeSsml(verse.fetchedText)}</p>`);
    parts.push(breakTag(VERSE_BREAK_MS));
    parts.push(`<p>${escapeSsml(shortSpokenAttribution(verse.attribution))}.</p>`);
    parts.push(breakTag(SECTION_BREAK_MS));
  }

  parts.push(stillnessParts(stillness, phrases));

  parts.push(`<p>${escapeSsml(devotional.devotionalBody)}</p>`);
  parts.push(breakTag(SECTION_BREAK_MS));

  parts.push(`<p>${escapeSsml(devotional.prayer)}</p>`);
  parts.push(breakTag(SECTION_BREAK_MS));

  parts.push(stillnessParts(stillness, phrases));

  parts.push(`<p>${spokenReferenceRecap(devotional, phrases)}</p>`);

  return `<speak>${parts.join('')}</speak>`;
}

/**
 * TEST-ONLY, like `buildDevotionalSsml` above (S1 #342): reached only via
 * that function's lectio branch — production lectio synthesis goes through
 * `buildLectioSsmlSegments`.
 *
 * Lectio divina structure (docs/14 §5.4, issue #92) — the historic
 * lectio/meditatio/oratio/contemplatio pattern: read the passage; silence;
 * read it again slower; one question; prayer; silence. Structure: greeting
 * -> break -> spoken reference -> verse at rate=0.95 -> 20s silence -> "Once
 * more, slower." -> the SAME verse at rate=0.85 -> break -> attribution ->
 * break -> (if present) the model's one journalingPrompt question -> break
 * -> stillness (user's own preference, reused for the meditatio->oratio
 * gap) -> prayer -> break -> stillness -> spoken reference recap.
 *
 * `devotionalBody` is deliberately never spoken here: the issue's own SSML
 * sketch never mentions it, and the format's whole point ("the passage does
 * the work") is most faithfully honored by omitting commentary entirely
 * rather than shrinking it to a token amount. It may still exist in the
 * schema for the session-page transcript, just very short (per
 * instructionsBuilder's LECTIO_STRUCTURE_INSTRUCTION).
 *
 * Only `devotional.verses[0]` is spoken — lectio is a single-passage format
 * by design (the model is instructed to choose exactly one reference), so
 * any additional verse the model might still return is not part of the
 * spoken flow.
 */
function buildLectioSsml(
  devotional: DevotionalOutput,
  stillness: Stillness,
  language: LanguageTag,
): string {
  const phrases = SPOKEN_PHRASES[language];
  const parts: string[] = [];

  parts.push(`<p>${phrases.greeting(escapeSsml(devotional.theme))}</p>`);
  parts.push(breakTag(SECTION_BREAK_MS));

  const verse = devotional.verses[0];
  if (verse) {
    parts.push(`<p>${spokenReferenceLeadIn(verse.reference, phrases)}</p>`);
    parts.push(`<p>${prosodyRate(0.95, verse.fetchedText)}</p>`);
    parts.push(chainedBreaks(LECTIO_MEDITATIO_MS));
    parts.push(`<p>${phrases.lectioOnceMore}</p>`);
    parts.push(`<p>${prosodyRate(0.85, verse.fetchedText)}</p>`);
    parts.push(breakTag(VERSE_BREAK_MS));
    parts.push(`<p>${escapeSsml(shortSpokenAttribution(verse.attribution))}.</p>`);
    parts.push(breakTag(SECTION_BREAK_MS));
  }

  if (devotional.journalingPrompt) {
    parts.push(`<p>${escapeSsml(devotional.journalingPrompt)}</p>`);
    parts.push(breakTag(SECTION_BREAK_MS));
  }

  parts.push(stillnessParts(stillness, phrases));

  parts.push(`<p>${escapeSsml(devotional.prayer)}</p>`);
  parts.push(breakTag(SECTION_BREAK_MS));

  parts.push(stillnessParts(stillness, phrases));

  parts.push(`<p>${spokenReferenceRecap(devotional, phrases)}</p>`);

  return `<speak>${parts.join('')}</speak>`;
}

/**
 * Google Cloud TTS enforces a per-request input-byte limit (5000 bytes for
 * SSML as of the current API). `extended` devotionals can exceed this, so
 * the spec (§6) calls for splitting on section boundaries and concatenating
 * MP3 segments. This returns one labeled SSML `<speak>` document per
 * top-level section (greeting, each verse+attribution, stillness, body,
 * prayer, recap) — callers synthesize each element and concatenate the
 * resulting audio buffers.
 *
 * Q1 (#331): this function now ALWAYS splits into per-section segments and
 * labels each with its `StageSection` + plain spoken `text`. The old
 * fits-under-maxBytes fast path (one `<speak>` for the whole script) is
 * gone: the Stage timing manifest needs per-section MP3 durations, which
 * only exist when each section is its own synthesis call. The audible
 * result is designed to be equivalent — see the §3.4 note below on how
 * inter-section pauses survive concatenation — at the cost of a few more
 * (billed-per-character, so cost-neutral) TTS requests per devotional.
 *
 * docs/14 §3.4: a `<break>` tag has no effect once it's stranded outside
 * every segment's own `<speak>`, so every non-final segment ends with a
 * trailing `SECTION_BREAK_MS` break inside its own `<speak>` and the pause
 * survives MP3 concatenation. The exception is body sub-chunks produced
 * purely by byte-limit splitting (not a real section boundary) — only the
 * last one gets the trailing break, so a long body doesn't gain artificial
 * pauses mid-paragraph.
 */
export function buildDevotionalSsmlSegments(
  devotional: DevotionalOutput,
  maxBytes = 4500,
  stillness: Stillness = 'off',
  lectio = false,
  language: LanguageTag = 'en',
  openMomentEnabled = false,
): LabeledSsmlSegment[] {
  if (lectio) {
    // v1 scopes the open moment to the standard/examen QUESTIONS beat; lectio
    // is a distinct contemplative format and gets no invitation (the flag is
    // simply ignored on this path).
    return buildLectioSsmlSegments(devotional, maxBytes, stillness, language);
  }

  const phrases = SPOKEN_PHRASES[language];
  const segments: LabeledSsmlSegment[] = [];
  segments.push({
    section: 'greeting',
    ssml: `<speak><p>${phrases.greeting(escapeSsml(devotional.theme))}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
    text: phrases.greeting(devotional.theme),
  });

  for (const verse of devotional.verses) {
    segments.push({
      section: 'scripture',
      ssml: `<speak><p>${spokenReferenceLeadIn(verse.reference, phrases)}</p><p>${escapeSsml(verse.fetchedText)}</p>${breakTag(VERSE_BREAK_MS)}<p>${escapeSsml(
        shortSpokenAttribution(verse.attribution),
      )}.</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
      text: `${phrases.verseLeadIn(verse.reference)} ${verse.fetchedText} ${shortSpokenAttribution(verse.attribution)}.`,
    });
  }

  if (stillness !== 'off') {
    segments.push({
      section: 'stillness',
      ssml: `<speak>${stillnessParts(stillness, phrases)}${breakTag(SECTION_BREAK_MS)}</speak>`,
      text: '',
    });
  }

  // The body itself may still exceed the limit for `extended` scripts;
  // split on paragraph/sentence boundaries as a further fallback. All
  // chunks are labeled `reflection` — the manifest writer coalesces
  // adjacent same-section segments into one row (#331).
  const bodySegments = splitTextToFit(devotional.devotionalBody, maxBytes - 50);
  bodySegments.forEach((chunk, i) => {
    const isLast = i === bodySegments.length - 1;
    segments.push({
      section: 'reflection',
      ssml: `<speak><p>${escapeSsml(chunk)}</p>${isLast ? breakTag(SECTION_BREAK_MS) : ''}</speak>`,
      text: chunk,
    });
  });

  // The Open Moment invitation (EPIC V #360 / V4 #365) — spoken at the end
  // of the reflection (the QUESTIONS beat) and BEFORE the closing prayer, so
  // the bounded listening window opens right where the devotional's question
  // was just asked and the prayer remains the resume point on both exits
  // (feature #361). Labeled `open_moment`: the V3 Stage page TRIGGERS the
  // window on this manifest marker. Emitted only when enabled AND the
  // language has a confidently-phrased invitation (otherwise the beat falls
  // back to no spoken invitation — spokenPhrases.ts drop rule).
  const invitation = SPOKEN_PHRASES[language].openMomentInvitation;
  if (openMomentEnabled && invitation) {
    segments.push({
      section: 'open_moment',
      ssml: `<speak><p>${escapeSsml(invitation)}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
      text: invitation,
    });
  }

  segments.push({
    section: 'prayer',
    ssml: `<speak><p>${escapeSsml(devotional.prayer)}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
    text: devotional.prayer,
  });

  if (stillness !== 'off') {
    segments.push({
      section: 'stillness',
      ssml: `<speak>${stillnessParts(stillness, phrases)}${breakTag(SECTION_BREAK_MS)}</speak>`,
      text: '',
    });
  }

  // The recap names the passage again — labeled 'scripture' so the Stage
  // page returns to the verse for the closing line (timingManifest.ts).
  segments.push({
    section: 'scripture',
    ssml: `<speak><p>${spokenReferenceRecap(devotional, phrases)}</p></speak>`,
    text: phrases.referenceRecap(joinedReferences(devotional, phrases)),
  });

  return segments;
}

/**
 * Segmented counterpart of `buildLectioSsml`, mirroring the non-lectio
 * segments function's section-boundary splitting (docs/14 §3.4: a `<break>`
 * only survives MP3 concatenation if it's inside the segment's own
 * `<speak>`). `devotionalBody` is shrunk-to-a-token-amount at most in
 * lectio mode (see instructionsBuilder's LECTIO_STRUCTURE_INSTRUCTION), so
 * this path is unlikely to trigger in practice, but is implemented for
 * correctness rather than silently falling through to the non-lectio
 * structure if it ever does.
 */
function buildLectioSsmlSegments(
  devotional: DevotionalOutput,
  maxBytes: number,
  stillness: Stillness,
  language: LanguageTag,
): LabeledSsmlSegment[] {
  const phrases = SPOKEN_PHRASES[language];
  const segments: LabeledSsmlSegment[] = [];
  segments.push({
    section: 'greeting',
    ssml: `<speak><p>${phrases.greeting(escapeSsml(devotional.theme))}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
    text: phrases.greeting(devotional.theme),
  });

  const verse = devotional.verses[0];
  if (verse) {
    // One 'scripture' segment carries both readings AND the 20s meditatio
    // silence between them — caption interpolation within it is knowingly
    // approximate (story #333 accepts ±seconds of drift; the chip shows a
    // line, not karaoke).
    segments.push({
      section: 'scripture',
      ssml: `<speak><p>${spokenReferenceLeadIn(verse.reference, phrases)}</p><p>${prosodyRate(
        0.95,
        verse.fetchedText,
      )}</p>${chainedBreaks(LECTIO_MEDITATIO_MS)}<p>${phrases.lectioOnceMore}</p><p>${prosodyRate(
        0.85,
        verse.fetchedText,
      )}</p>${breakTag(VERSE_BREAK_MS)}<p>${escapeSsml(
        shortSpokenAttribution(verse.attribution),
      )}.</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
      text: `${phrases.verseLeadIn(verse.reference)} ${verse.fetchedText} ${phrases.lectioOnceMore} ${verse.fetchedText} ${shortSpokenAttribution(verse.attribution)}.`,
    });
  }

  if (devotional.journalingPrompt) {
    // The question is expected to be a single short sentence
    // (instructionsBuilder's LECTIO_STRUCTURE_INSTRUCTION), but split it the
    // same way the non-lectio path splits devotionalBody, for correctness
    // rather than assuming the model always honors that instruction.
    // Labeled 'reflection': lectio's spoken question plays the role the
    // body plays in the standard format (timingManifest.ts).
    const questionChunks = splitTextToFit(devotional.journalingPrompt, maxBytes - 50);
    questionChunks.forEach((chunk, i) => {
      const isLast = i === questionChunks.length - 1;
      segments.push({
        section: 'reflection',
        ssml: `<speak><p>${escapeSsml(chunk)}</p>${isLast ? breakTag(SECTION_BREAK_MS) : ''}</speak>`,
        text: chunk,
      });
    });
  }

  if (stillness !== 'off') {
    segments.push({
      section: 'stillness',
      ssml: `<speak>${stillnessParts(stillness, phrases)}${breakTag(SECTION_BREAK_MS)}</speak>`,
      text: '',
    });
  }

  segments.push({
    section: 'prayer',
    ssml: `<speak><p>${escapeSsml(devotional.prayer)}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
    text: devotional.prayer,
  });

  if (stillness !== 'off') {
    segments.push({
      section: 'stillness',
      ssml: `<speak>${stillnessParts(stillness, phrases)}${breakTag(SECTION_BREAK_MS)}</speak>`,
      text: '',
    });
  }

  segments.push({
    section: 'scripture',
    ssml: `<speak><p>${spokenReferenceRecap(devotional, phrases)}</p></speak>`,
    text: phrases.referenceRecap(joinedReferences(devotional, phrases)),
  });

  return segments;
}

/**
 * Splits plain text into chunks that fit under `maxBytes` (UTF-8), breaking
 * on sentence boundaries where possible.
 *
 * docs/14 §3.8 / issue #90 — two fixes vs. the original:
 *  1. Size is measured on `escapeSsml(candidate)`, not the raw candidate —
 *     each chunk is escaped before being embedded in a `<speak>` tag by the
 *     caller, and escaping (`&` -> `&amp;`, etc.) only ever grows byte
 *     length, so measuring pre-escape could let an over-budget chunk
 *     through undetected.
 *  2. A single sentence that alone exceeds `maxBytes` (no earlier punctuation
 *     to break on) is now further split on word boundaries instead of being
 *     emitted as one oversized chunk.
 */
function splitTextToFit(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(escapeSsml(text), 'utf8') <= maxBytes) return [text];

  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (Buffer.byteLength(escapeSsml(candidate), 'utf8') > maxBytes && current) {
      flush();
    }
    const fitsAlone = Buffer.byteLength(escapeSsml(sentence), 'utf8') <= maxBytes;
    if (fitsAlone) {
      current = current ? `${current} ${sentence}` : sentence;
    } else {
      // The sentence alone is still over budget — split it on word
      // boundaries so no single chunk exceeds maxBytes.
      flush();
      chunks.push(...splitWordsToFit(sentence, maxBytes));
    }
  }
  flush();
  return chunks;
}

// --- Open Moment live response + pre-synthesized closes (EPIC V #360) --------

/**
 * The three parts of a spoken live response (V2 #363), each its own SSML
 * document so the TTS layer can synthesize + measure them independently and
 * report per-part durations to the Stage page. Deliberately NOT keyed by
 * `StageSection` (these are the live-response beat, not stored-manifest
 * sections): `part` names the liturgy slot instead.
 */
export interface LiveResponseSsmlSegment {
  part: 'acknowledgment' | 'verse' | 'framing';
  ssml: string;
  text: string;
}

/**
 * Builds the spoken script for a validated `LiveResponse` (acknowledgment →
 * verse (with lead-in + attribution) → framing). The verse text is the
 * server-authoritative YouVersion bytes already on the response — this
 * function only wraps it in SSML, never re-fetches or edits it.
 */
export function buildLiveResponseSsmlSegments(
  response: LiveResponse,
  language: LanguageTag = 'en',
): LiveResponseSsmlSegment[] {
  const phrases = SPOKEN_PHRASES[language];
  const verse = response.verse;
  return [
    {
      part: 'acknowledgment',
      ssml: `<speak><p>${escapeSsml(response.acknowledgment)}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
      text: response.acknowledgment,
    },
    {
      part: 'verse',
      ssml: `<speak><p>${spokenReferenceLeadIn(verse.reference, phrases)}</p><p>${escapeSsml(
        verse.fetchedText,
      )}</p>${breakTag(VERSE_BREAK_MS)}<p>${escapeSsml(
        shortSpokenAttribution(verse.attribution),
      )}.</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
      text: `${phrases.verseLeadIn(verse.reference)} ${verse.fetchedText} ${shortSpokenAttribution(verse.attribution)}.`,
    },
    {
      part: 'framing',
      ssml: `<speak><p>${escapeSsml(response.framing)}</p></speak>`,
      text: response.framing,
    },
  ];
}

/**
 * The pre-synthesized auxiliary clips for the Open Moment (V4 #365), so the
 * SILENCE path (feature #361 Path B) and the response lead-in have ZERO live
 * dependency:
 *  - `leadIn`: the 1.5s held breath before a live response (always present).
 *  - `silenceClose`: the warm silence-close (present only when the language
 *    has a confidently-phrased close — spokenPhrases.ts drop rule; omitted
 *    otherwise, in which case Path B falls straight into the closing prayer).
 *
 * These are synthesized + stored separately (V3 stage-playback owns swapping
 * them in); this builder is the single source of their SSML.
 */
export interface OpenMomentAuxSegments {
  leadIn: { ssml: string; text: string };
  silenceClose?: { ssml: string; text: string };
}

export function buildOpenMomentAuxSsmlSegments(
  language: LanguageTag = 'en',
): OpenMomentAuxSegments {
  const close = SPOKEN_PHRASES[language].openMomentSilenceClose;
  return {
    leadIn: { ssml: `<speak>${breakTag(OPEN_MOMENT_LEAD_IN_MS)}</speak>`, text: '' },
    ...(close
      ? {
          silenceClose: {
            ssml: `<speak><p>${escapeSsml(close)}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
            text: close,
          },
        }
      : {}),
  };
}

/** Word-boundary fallback for a single chunk that exceeds `maxBytes` even alone. */
function splitWordsToFit(text: string, maxBytes: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (Buffer.byteLength(escapeSsml(candidate), 'utf8') > maxBytes && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
