/**
 * Stage timeline math — Q2 (#332) `sectionAt`/tab mapping and Q3 (#333)
 * `captionAt` caption interpolation. Pure functions, exhaustively
 * unit-tested off-DOM (tests/services/stage/stageTimeline.test.ts).
 *
 * ⚠️ DUAL-RUNTIME CONSTRAINT: these exact functions are embedded into the
 * Stage page's client script via `Function.prototype.toString()`
 * (stageClient.ts) so that the tested code IS the shipped code — no
 * hand-maintained JS copy to drift. That imposes rules on this file:
 *   - plain `function` declarations only (tsc preserves their names);
 *   - no imports referenced inside function BODIES — a body may only call
 *     the other functions in this file (they are embedded together under
 *     the same names) and browser/ES built-ins;
 *   - no TS runtime features (enums, namespaces, parameter properties);
 *     type annotations are fine (erased);
 *   - browser-compatible syntax only (also mind that regexes are parsed,
 *     not just executed — avoid lookbehind for older Safari).
 *
 * Caption approach (story #333): no word timestamps exist (TTS `<mark>`
 * timepoints were killed — unconfirmed on Chirp3-HD), so within a
 * manifest row we interpolate proportionally by character count. This is
 * knowingly approximate; the chip shows a line, not a karaoke word
 * highlight, and ±1–2s of drift within a section is invisible on camera.
 */
import type { TimingManifestEntry } from '@kairos/shared-contracts';

/** The Stage page's tab surfaces. QUESTIONS never has a timeline segment (Q1) — it activates at audio end (DOM wiring, not this module). */
export type StageTab = 'scripture' | 'reflection' | 'prayer';

export interface StageCaption {
  section: TimingManifestEntry['section'];
  lineIndex: number;
  line: string;
}

/** Longest caption line the chip renders — ≤ ~90 chars keeps it inside two rows at 1280×720 serif sizing (story #333). */
const MAX_CAPTION_LINE_CHARS = 90;

/**
 * The manifest row active at time `t`: the last row whose `startSec` ≤ t.
 * Rows are contiguous (Q1 invariant: each `startSec` equals the previous
 * `endSec`), so t ∈ [startSec, endSec) selects exactly one row with no
 * dead zones at boundaries; t before the first row clamps to the first
 * row, t at/after the final `endSec` clamps to the last row. Null only
 * for an empty/missing manifest.
 */
export function sectionAt(
  manifest: TimingManifestEntry[],
  t: number,
): TimingManifestEntry | null {
  if (!manifest || manifest.length === 0) return null;
  let active = manifest[0] as TimingManifestEntry;
  for (let i = 1; i < manifest.length; i += 1) {
    const row = manifest[i] as TimingManifestEntry;
    if (t >= row.startSec) {
      active = row;
    } else {
      break;
    }
  }
  return active;
}

/**
 * The tab to highlight at time `t` (Q2 #332 tab mapping): greeting and
 * scripture (and the closing recap, labeled scripture) → SCRIPTURE;
 * reflection → REFLECTION; prayer → PRAYER. A stillness row inherits the
 * tab of the nearest preceding non-stillness row, so interleaved
 * stillness stays on SCRIPTURE and trailing stillness stays on PRAYER.
 */
export function tabAt(manifest: TimingManifestEntry[], t: number): StageTab | null {
  if (!manifest || manifest.length === 0) return null;
  let index = 0;
  for (let i = 1; i < manifest.length; i += 1) {
    if (t >= (manifest[i] as TimingManifestEntry).startSec) {
      index = i;
    } else {
      break;
    }
  }
  while (index >= 0 && (manifest[index] as TimingManifestEntry).section === 'stillness') {
    index -= 1;
  }
  // A manifest that opens with stillness has no preceding section; the
  // opening surface of the page is SCRIPTURE, so rest there.
  if (index < 0) return 'scripture';
  const section = (manifest[index] as TimingManifestEntry).section;
  if (section === 'reflection') return 'reflection';
  if (section === 'prayer') return 'prayer';
  return 'scripture';
}

/**
 * Splits a row's spoken text into caption lines: sentence-ish splits
 * first, then word-boundary splits for any sentence longer than
 * MAX_CAPTION_LINE_CHARS. Deliberately regex-conservative (no lookbehind
 * — it would be a PARSE error on older Safari, killing the whole script).
 */
export function splitCaptionLines(text: string): string[] {
  const MAX = 90; // keep literal in sync with MAX_CAPTION_LINE_CHARS — bodies cannot reference module constants (toString embedding)
  if (!text) return [];
  const sentences = text.match(/[^.!?…]+[.!?…]*/g) || [text];
  const lines: string[] = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = (sentences[i] as string).trim();
    if (!sentence) continue;
    if (sentence.length <= MAX) {
      lines.push(sentence);
      continue;
    }
    const words = sentence.split(/\s+/);
    let current = '';
    for (let j = 0; j < words.length; j += 1) {
      const word = words[j] as string;
      const candidate = current ? current + ' ' + word : word;
      if (candidate.length > MAX && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * The caption line active at time `t` (Q3 #333), or null when the chip
 * should be hidden: empty manifest, or a stillness row (empty `text` —
 * the chip fades out rather than showing an empty box).
 *
 * Interpolation: progress within the row `p = (t − startSec) / (endSec −
 * startSec)`, active line = the line containing character offset
 * `p × totalChars` (cumulative char counts per line). Monotonic in `t`
 * within a row by construction.
 */
export function captionAt(manifest: TimingManifestEntry[], t: number): StageCaption | null {
  const row = sectionAt(manifest, t);
  if (!row || !row.text) return null;
  const lines = splitCaptionLines(row.text);
  if (lines.length === 0) return null;

  const span = row.endSec - row.startSec;
  let p = span > 0 ? (t - row.startSec) / span : 0;
  if (p < 0) p = 0;
  if (p > 1) p = 1;

  let totalChars = 0;
  for (let i = 0; i < lines.length; i += 1) {
    totalChars += (lines[i] as string).length;
  }
  const target = p * totalChars;

  let cumulative = 0;
  for (let i = 0; i < lines.length; i += 1) {
    cumulative += (lines[i] as string).length;
    if (target < cumulative) {
      return { section: row.section, lineIndex: i, line: lines[i] as string };
    }
  }
  // p === 1 (t at the row's very end, only reachable on the final row —
  // earlier boundaries already belong to the next row via sectionAt).
  const last = lines.length - 1;
  return { section: row.section, lineIndex: last, line: lines[last] as string };
}

export { MAX_CAPTION_LINE_CHARS };
