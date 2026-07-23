/**
 * Q2 (#332) sectionAt/tabAt + Q3 (#333) captionAt — pure-function tests,
 * off-DOM. These functions are ALSO the shipped client code (embedded via
 * toString(), see stageClient.ts), so this suite is the page's caption
 * logic coverage, not a parallel copy's.
 */
import { describe, expect, it } from 'vitest';
import type { TimingManifest } from '@kairos/shared-contracts';
import {
  captionAt,
  sectionAt,
  splitCaptionLines,
  tabAt,
} from '../../../src/services/stage/stageTimeline.js';
import { buildStageClientJs } from '../../../src/services/stage/stageClient.js';

/** A realistic coalesced manifest: greeting → scripture → stillness → reflection → prayer → stillness → recap(scripture). */
const MANIFEST: TimingManifest = [
  { section: 'greeting', startSec: 0, endSec: 2, text: 'A moment of gratitude.' },
  {
    section: 'scripture',
    startSec: 2,
    endSec: 10,
    text: 'From Philippians 4:6-7. Do not be anxious about anything. Berean Standard Bible (BSB).',
  },
  { section: 'stillness', startSec: 10, endSec: 25, text: '' },
  {
    section: 'reflection',
    startSec: 25,
    endSec: 55,
    text: 'Today has been steady. God meets us in the ordinary. Gratitude is a door that opens from the inside.',
  },
  { section: 'prayer', startSec: 55, endSec: 70, text: 'Father, thank You for this day. Amen.' },
  { section: 'stillness', startSec: 70, endSec: 85, text: '' },
  {
    section: 'scripture',
    startSec: 85,
    endSec: 90,
    text: "That was Philippians 4:6-7 — it'll be here when you want to come back.",
  },
];

describe('sectionAt', () => {
  it('returns null for an empty or missing manifest', () => {
    expect(sectionAt([], 5)).toBeNull();
    expect(sectionAt(undefined as unknown as TimingManifest, 5)).toBeNull();
  });

  it('selects the row whose [startSec, endSec) window contains t', () => {
    expect(sectionAt(MANIFEST, 0)!.section).toBe('greeting');
    expect(sectionAt(MANIFEST, 1.999)!.section).toBe('greeting');
    expect(sectionAt(MANIFEST, 5)!.section).toBe('scripture');
    expect(sectionAt(MANIFEST, 30)!.section).toBe('reflection');
    expect(sectionAt(MANIFEST, 60)!.section).toBe('prayer');
  });

  it('has no dead zones at boundaries — the shared boundary belongs to the NEXT row', () => {
    expect(sectionAt(MANIFEST, 2)).toBe(MANIFEST[1]);
    expect(sectionAt(MANIFEST, 10)).toBe(MANIFEST[2]);
    expect(sectionAt(MANIFEST, 85)).toBe(MANIFEST[6]);
  });

  it('clamps: t before 0 → first row, t at/after the final endSec → last row', () => {
    expect(sectionAt(MANIFEST, -3)).toBe(MANIFEST[0]);
    expect(sectionAt(MANIFEST, 90)).toBe(MANIFEST[6]);
    expect(sectionAt(MANIFEST, 9999)).toBe(MANIFEST[6]);
  });
});

describe('tabAt (Q2 tab mapping)', () => {
  it('maps greeting+scripture → scripture, reflection → reflection, prayer → prayer', () => {
    expect(tabAt(MANIFEST, 1)).toBe('scripture');
    expect(tabAt(MANIFEST, 5)).toBe('scripture');
    expect(tabAt(MANIFEST, 30)).toBe('reflection');
    expect(tabAt(MANIFEST, 60)).toBe('prayer');
  });

  it('a stillness row inherits the nearest preceding non-stillness tab (interleaved → scripture, trailing → prayer)', () => {
    expect(tabAt(MANIFEST, 15)).toBe('scripture'); // stillness after the verse
    expect(tabAt(MANIFEST, 75)).toBe('prayer'); // stillness after the prayer
  });

  it('the closing recap (labeled scripture) returns the page to the scripture tab', () => {
    expect(tabAt(MANIFEST, 87)).toBe('scripture');
  });

  it('returns null for an empty manifest and scripture for a leading-stillness edge case', () => {
    expect(tabAt([], 3)).toBeNull();
    expect(
      tabAt([{ section: 'stillness', startSec: 0, endSec: 10, text: '' }], 3),
    ).toBe('scripture');
  });
});

describe('splitCaptionLines', () => {
  it('returns [] for empty text (stillness rows)', () => {
    expect(splitCaptionLines('')).toEqual([]);
  });

  it('splits on sentence boundaries, keeping the terminal punctuation', () => {
    expect(splitCaptionLines('Today has been steady. God meets us in the ordinary.')).toEqual([
      'Today has been steady.',
      'God meets us in the ordinary.',
    ]);
  });

  it('keeps every line at or under 90 characters, word-splitting run-on sentences', () => {
    const runOn = 'grace '.repeat(40).trim(); // 239 chars, no sentence enders
    const lines = splitCaptionLines(runOn);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(90);
    }
    expect(lines.join(' ')).toBe(runOn);
  });

  it('treats text with no sentence enders as a single unit before length splitting', () => {
    expect(splitCaptionLines('a short line with no period')).toEqual([
      'a short line with no period',
    ]);
  });
});

describe('captionAt (Q3 caption interpolation)', () => {
  it('returns null for an empty manifest, and null (chip hidden) during stillness rows', () => {
    expect(captionAt([], 5)).toBeNull();
    expect(captionAt(MANIFEST, 15)).toBeNull(); // interleaved stillness
    expect(captionAt(MANIFEST, 75)).toBeNull(); // trailing stillness
  });

  it('t = startSec gives the first line; t = endSec − ε gives the last line', () => {
    const start = captionAt(MANIFEST, 25)!;
    expect(start.lineIndex).toBe(0);
    expect(start.line).toBe('Today has been steady.');
    expect(start.section).toBe('reflection');

    const end = captionAt(MANIFEST, 55 - 1e-9)!;
    const lines = splitCaptionLines(MANIFEST[3]!.text);
    expect(end.lineIndex).toBe(lines.length - 1);
    expect(end.line).toBe('Gratitude is a door that opens from the inside.');
  });

  it('a single-line section shows that line for its whole duration', () => {
    expect(captionAt(MANIFEST, 0)!.line).toBe('A moment of gratitude.');
    expect(captionAt(MANIFEST, 1.999)!.line).toBe('A moment of gratitude.');
  });

  it('advances through lines monotonically as t increases (no back-tracking)', () => {
    let previousKey = -1;
    for (let t = 0; t <= 90; t += 0.25) {
      const caption = captionAt(MANIFEST, t);
      if (!caption) continue; // stillness gaps reset nothing — index key below is row-scoped
      const rowIndex = MANIFEST.findIndex((r) => r === sectionAt(MANIFEST, t));
      const key = rowIndex * 1000 + caption.lineIndex;
      expect(key).toBeGreaterThanOrEqual(previousKey);
      previousKey = key;
    }
  });

  it('mutation check: perturbing a section\'s character distribution moves the line boundary', () => {
    // Same total duration, same line COUNT, different char distribution:
    // if interpolation ignored cumulative char offsets (e.g. divided time
    // equally among lines), both manifests would flip lines at the same t.
    const balanced: TimingManifest = [
      { section: 'reflection', startSec: 0, endSec: 10, text: 'Aaaa aaaa aaaa. Bbbb bbbb bbbb.' },
    ];
    const skewed: TimingManifest = [
      {
        section: 'reflection',
        startSec: 0,
        endSec: 10,
        text: 'Aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa. Bbbb.',
      },
    ];
    // At 60% through: balanced is already on line 1; skewed (long first
    // line) is still on line 0.
    expect(captionAt(balanced, 6)!.lineIndex).toBe(1);
    expect(captionAt(skewed, 6)!.lineIndex).toBe(0);
    // Both reach the last line by the end.
    expect(captionAt(skewed, 9.999)!.lineIndex).toBe(1);
  });

  it('coalesced rows interpolate over the combined text (body chunks merged by Q1)', () => {
    const row = MANIFEST[3]!;
    const lines = splitCaptionLines(row.text);
    const seen = new Set<number>();
    for (let t = row.startSec; t < row.endSec; t += 0.1) {
      seen.add(captionAt(MANIFEST, t)!.lineIndex);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(lines.map((_, i) => i));
  });

  it('clamps t past the final endSec to the final row\'s last line', () => {
    const caption = captionAt(MANIFEST, 500)!;
    expect(caption.section).toBe('scripture');
    expect(caption.line).toBe("That was Philippians 4:6-7 — it'll be here when you want to come back.");
  });
});

describe('stage client script embedding (stageClient.ts)', () => {
  it('embeds the tested functions by name and stays framework-free', () => {
    const js = buildStageClientJs();
    for (const name of ['splitCaptionLines', 'sectionAt', 'tabAt', 'captionAt']) {
      expect(js).toContain(`function ${name}(`);
    }
    expect(js).toContain('stage-data');
    expect(js).toContain('getUserMedia');
    expect(js).toContain('pointerdown'); // autoplay retry on first pointer event
    expect(js).not.toContain('import ');
    expect(js).not.toContain('require(');
  });

  it('the embedded functions actually evaluate and agree with the module (no toString drift)', () => {
    const js = buildStageClientJs();
    const prefix = js.slice(0, js.indexOf('(function () {'));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const evaluate = new Function(
      `${prefix}; return { sectionAt: sectionAt, tabAt: tabAt, captionAt: captionAt, splitCaptionLines: splitCaptionLines };`,
    )() as {
      sectionAt: typeof sectionAt;
      tabAt: typeof tabAt;
      captionAt: typeof captionAt;
      splitCaptionLines: typeof splitCaptionLines;
    };

    for (let t = 0; t <= 92; t += 1.7) {
      expect(evaluate.sectionAt(MANIFEST, t)).toEqual(sectionAt(MANIFEST, t));
      expect(evaluate.tabAt(MANIFEST, t)).toEqual(tabAt(MANIFEST, t));
      expect(evaluate.captionAt(MANIFEST, t)).toEqual(captionAt(MANIFEST, t));
    }
    expect(evaluate.splitCaptionLines(MANIFEST[3]!.text)).toEqual(
      splitCaptionLines(MANIFEST[3]!.text),
    );
  });
});
