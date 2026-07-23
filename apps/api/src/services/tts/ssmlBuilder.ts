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

import type { DevotionalOutput, LanguageTag, Stillness } from '@kairos/shared-contracts';
import { SPOKEN_PHRASES, type SpokenPhrases } from './spokenPhrases.js';

/** Between-section pause — API spec §6: "<break time="1200ms"/> between sections". */
export const SECTION_BREAK_MS = 1200;
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

/**
 * Builds the closing reference recap spoken after the prayer, e.g. "That
 * was Matthew 11:28-30 — it'll be here when you want to come back."
 * Joins multiple verse references with the language's "and" when a
 * devotional cites more than one passage.
 */
function spokenReferenceRecap(devotional: DevotionalOutput, phrases: SpokenPhrases): string {
  const references = devotional.verses.map((v) => v.reference);
  // devotional.verses is schema-guaranteed non-empty (VerseSchema `.min(1)`).
  const last = references[references.length - 1] as string;
  const joined =
    references.length === 1
      ? last
      : `${references.slice(0, -1).join(phrases.referenceListSeparator)}${phrases.referenceFinalJoiner}${last}`;
  return phrases.referenceRecap(escapeSsml(joined));
}

/**
 * Builds the full SSML `<speak>` document for a devotional's spoken script.
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
 * MP3 segments. This returns one SSML `<speak>` document per top-level
 * section (greeting, each verse+attribution, stillness, body, prayer) when
 * the full document would be too large, else a single-element array with
 * the whole thing — callers synthesize each element and concatenate the
 * resulting audio buffers.
 *
 * docs/14 §3.4: the between-section `<break>` only existed inside the
 * single-`<speak>` path (`buildDevotionalSsml`) — segments concatenated as
 * separate synthesis calls lost their inter-section pauses entirely, since
 * a `<break>` tag has no effect once it's stranded outside every segment's
 * own `<speak>`. Fix: every non-final segment ends with a trailing
 * `SECTION_BREAK_MS` break inside its own `<speak>`, so the pause survives
 * MP3 concatenation. The exception is body sub-chunks produced purely by
 * byte-limit splitting (not a real section boundary) — only the last one
 * gets the trailing break, so a long body doesn't gain artificial pauses
 * mid-paragraph.
 */
export function buildDevotionalSsmlSegments(
  devotional: DevotionalOutput,
  maxBytes = 4500,
  stillness: Stillness = 'off',
  lectio = false,
  language: LanguageTag = 'en',
): string[] {
  const full = buildDevotionalSsml(devotional, stillness, lectio, language);
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) {
    return [full];
  }

  if (lectio) {
    return buildLectioSsmlSegments(devotional, maxBytes, stillness, language);
  }

  const phrases = SPOKEN_PHRASES[language];
  const segments: string[] = [];
  segments.push(
    `<speak><p>${phrases.greeting(escapeSsml(devotional.theme))}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
  );

  for (const verse of devotional.verses) {
    segments.push(
      `<speak><p>${spokenReferenceLeadIn(verse.reference, phrases)}</p><p>${escapeSsml(verse.fetchedText)}</p>${breakTag(VERSE_BREAK_MS)}<p>${escapeSsml(
        shortSpokenAttribution(verse.attribution),
      )}.</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
    );
  }

  if (stillness !== 'off') {
    segments.push(
      `<speak>${stillnessParts(stillness, phrases)}${breakTag(SECTION_BREAK_MS)}</speak>`,
    );
  }

  // The body itself may still exceed the limit for `extended` scripts;
  // split on paragraph/sentence boundaries as a further fallback.
  const bodySegments = splitTextToFit(devotional.devotionalBody, maxBytes - 50);
  bodySegments.forEach((chunk, i) => {
    const isLast = i === bodySegments.length - 1;
    segments.push(
      `<speak><p>${escapeSsml(chunk)}</p>${isLast ? breakTag(SECTION_BREAK_MS) : ''}</speak>`,
    );
  });

  segments.push(
    `<speak><p>${escapeSsml(devotional.prayer)}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
  );

  if (stillness !== 'off') {
    segments.push(
      `<speak>${stillnessParts(stillness, phrases)}${breakTag(SECTION_BREAK_MS)}</speak>`,
    );
  }

  segments.push(`<speak><p>${spokenReferenceRecap(devotional, phrases)}</p></speak>`);

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
): string[] {
  const phrases = SPOKEN_PHRASES[language];
  const segments: string[] = [];
  segments.push(
    `<speak><p>${phrases.greeting(escapeSsml(devotional.theme))}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
  );

  const verse = devotional.verses[0];
  if (verse) {
    segments.push(
      `<speak><p>${spokenReferenceLeadIn(verse.reference, phrases)}</p><p>${prosodyRate(
        0.95,
        verse.fetchedText,
      )}</p>${chainedBreaks(LECTIO_MEDITATIO_MS)}<p>${phrases.lectioOnceMore}</p><p>${prosodyRate(
        0.85,
        verse.fetchedText,
      )}</p>${breakTag(VERSE_BREAK_MS)}<p>${escapeSsml(
        shortSpokenAttribution(verse.attribution),
      )}.</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
    );
  }

  if (devotional.journalingPrompt) {
    // The question is expected to be a single short sentence
    // (instructionsBuilder's LECTIO_STRUCTURE_INSTRUCTION), but split it the
    // same way the non-lectio path splits devotionalBody, for correctness
    // rather than assuming the model always honors that instruction.
    const questionChunks = splitTextToFit(devotional.journalingPrompt, maxBytes - 50);
    questionChunks.forEach((chunk, i) => {
      const isLast = i === questionChunks.length - 1;
      segments.push(
        `<speak><p>${escapeSsml(chunk)}</p>${isLast ? breakTag(SECTION_BREAK_MS) : ''}</speak>`,
      );
    });
  }

  if (stillness !== 'off') {
    segments.push(
      `<speak>${stillnessParts(stillness, phrases)}${breakTag(SECTION_BREAK_MS)}</speak>`,
    );
  }

  segments.push(
    `<speak><p>${escapeSsml(devotional.prayer)}</p>${breakTag(SECTION_BREAK_MS)}</speak>`,
  );

  if (stillness !== 'off') {
    segments.push(
      `<speak>${stillnessParts(stillness, phrases)}${breakTag(SECTION_BREAK_MS)}</speak>`,
    );
  }

  segments.push(`<speak><p>${spokenReferenceRecap(devotional, phrases)}</p></speak>`);

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
