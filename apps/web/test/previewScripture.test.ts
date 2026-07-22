/**
 * The one verse literal in the client, pinned to the passage it was copied
 * from (N2, #261).
 *
 * `previewVerse` in `src/preview/fixtures.ts` is Scripture typed into a
 * source file. Everything else in that file is invented — themes, card
 * summaries, meeting URLs — and that is fine. Scripture is not: docs/14
 * §5.10 makes the byte-exact YouVersion rule a theological position, not a
 * licensing convenience, and the way that rule stops being true is not a
 * dramatic decision. It is someone adjusting a fixture's wording to fit a
 * layout, or typing a familiar verse from memory because it was faster
 * than looking it up.
 *
 * So this reads `fixtures/snapshots/low_poor_heavy.json` — a real
 * generated devotional whose verses were fetched from YouVersion and are
 * already validated against `DevotionalOutputSchema` by
 * `packages/shared-contracts/tests/fixtures.test.ts` — and compares every
 * field byte for byte. Test Plan §3.1 rule 1: the fixture derives from the
 * real producer, and here the comparison is the derivation.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VerseSchema, type Verse } from '@kairos/shared-contracts';
import { previewVerse } from '../src/preview/fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.resolve(__dirname, '../../../fixtures/snapshots/low_poor_heavy.json');

function snapshotVerses(): Verse[] {
  const parsed = JSON.parse(readFileSync(SNAPSHOT, 'utf-8')) as {
    devotionalOutput: { verses: unknown[] };
  };
  return parsed.devotionalOutput.verses.map((v) => VerseSchema.parse(v));
}

describe('the preview’s Scripture is real Scripture the system has', () => {
  it('matches a verse from a generated devotional byte for byte', () => {
    // `toContainEqual`, not an index: the point is that this exact object
    // exists in the snapshot, not that it happens to be first there.
    expect(snapshotVerses()).toContainEqual(previewVerse);
  });

  it('carries the attribution the passage was fetched with', () => {
    // Foundation §4.3 — attribution travels with the text. A fixture with
    // an empty or invented attribution would render a `<cite>` that
    // credits nothing, which is worse than no citation because it looks
    // like one.
    const source = snapshotVerses().find((v) => v.usfm === previewVerse.usfm);
    expect(source).toBeDefined();
    expect(previewVerse.attribution).toBe(source!.attribution);
    expect(previewVerse.attribution).not.toBe('');
  });
});
