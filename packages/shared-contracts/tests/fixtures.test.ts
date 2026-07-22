import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DevotionalOutputSchema,
  BandInputSchema,
  DEVOTIONAL_BODY_WORD_TARGETS,
  CARD_SUMMARY_HARD_LIMIT,
  fallbackKey,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../../../fixtures/snapshots');

const EXPECTED_KEYS = [
  'low_poor_heavy',
  'high_good_light',
  'moderate_poor_heavy',
  'moderate_fair_moderate',
  'distress_checkin',
];

function loadFixture(key: string) {
  const file = path.join(fixturesDir, `${key}.json`);
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

describe('canonical demo fixtures (Test Plan §3)', () => {
  it('all five expected fixture files exist and nothing extra is present', () => {
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual(EXPECTED_KEYS.map((k) => `${k}.json`).sort());
  });

  for (const key of EXPECTED_KEYS) {
    describe(key, () => {
      const fixture = loadFixture(key);

      it('has a fixtureKey matching the filename', () => {
        expect(fixture.fixtureKey).toBe(key);
      });

      it('bands parse against BandInputSchema', () => {
        const result = BandInputSchema.safeParse(fixture.bands);
        expect(result.success).toBe(true);
      });

      it('devotionalOutput parses against DevotionalOutputSchema', () => {
        const result = DevotionalOutputSchema.safeParse(fixture.devotionalOutput);
        expect(
          result.success,
          JSON.stringify(result.success === false ? result.error.issues : []),
        ).toBe(true);
      });

      it('cardSummary respects the hard 300-char limit', () => {
        expect(fixture.devotionalOutput.cardSummary.length).toBeLessThanOrEqual(
          CARD_SUMMARY_HARD_LIMIT,
        );
      });

      it('devotionalBody word count is within the format target band (allowing +/-15% for hand-written demo prose)', () => {
        const target =
          DEVOTIONAL_BODY_WORD_TARGETS[
            fixture.devotionalOutput.format as keyof typeof DEVOTIONAL_BODY_WORD_TARGETS
          ];
        const count = wordCount(fixture.devotionalOutput.devotionalBody);
        const min = Math.floor(target.min * 0.85);
        const max = Math.ceil(target.max * 1.15);
        expect(
          count,
          `${key}: devotionalBody has ${count} words, expected ${min}-${max} for format ${fixture.devotionalOutput.format}`,
        ).toBeGreaterThanOrEqual(min);
        expect(count).toBeLessThanOrEqual(max);
      });

      it('every verse has non-empty fetchedText and attribution (never model-memory Scripture)', () => {
        for (const verse of fixture.devotionalOutput.verses) {
          expect(verse.fetchedText.length).toBeGreaterThan(0);
          expect(verse.attribution.length).toBeGreaterThan(0);
        }
      });

      it('verses[].fetchedText matches the tool-envelope text byte-for-byte (Test Plan §4 anti-hallucination check)', () => {
        for (const verse of fixture.devotionalOutput.verses) {
          const matchingCall = fixture.toolCalls.find(
            (tc: { envelope: { data?: { usfm: string; versionId: number; text: string } } }) =>
              tc.envelope.data?.usfm === verse.usfm &&
              tc.envelope.data?.versionId === verse.versionId,
          );
          expect(matchingCall, `no matching tool call for verse ${verse.usfm}`).toBeTruthy();
          expect(verse.fetchedText).toBe(matchingCall.envelope.data.text);
        }
      });

      it('every toolCalls[].envelope is ok:true with source youversion', () => {
        for (const tc of fixture.toolCalls) {
          expect(tc.envelope.ok).toBe(true);
          expect(tc.envelope.meta.source).toBe('youversion');
        }
      });
    });
  }

  it('distress_checkin has distressSignal=true and forces format=micro, theme=comfort (Foundation §5 heuristic)', () => {
    const fixture = loadFixture('distress_checkin');
    expect(fixture.bands.distressSignal).toBe(true);
    expect(fixture.devotionalOutput.format).toBe('micro');
    expect(fixture.devotionalOutput.theme).toBe('comfort');
  });

  it('low_poor_heavy and moderate_poor_heavy (both heavy busyness) both resolve to micro/short formats', () => {
    const low = loadFixture('low_poor_heavy');
    const moderate = loadFixture('moderate_poor_heavy');
    expect(['micro', 'short']).toContain(low.devotionalOutput.format);
    expect(['micro', 'short']).toContain(moderate.devotionalOutput.format);
  });

  it('high_good_light resolves to extended format (recovery=high + busyness=light heuristic)', () => {
    const fixture = loadFixture('high_good_light');
    expect(fixture.devotionalOutput.format).toBe('extended');
  });

  it('fixture filenames match the fallbackKey computed from their own bands', () => {
    for (const key of EXPECTED_KEYS) {
      const fixture = loadFixture(key);
      if (fixture.bands.distressSignal) continue; // distress_checkin is keyed by scenario, not bands
      const computed = fallbackKey(
        fixture.bands.recovery,
        fixture.bands.sleepQuality,
        fixture.bands.busyness,
      );
      expect(computed).toBe(key);
    }
  });

  it('theological safety: no fixture devotionalBody contains diagnostic, prosperity, or shame language', () => {
    const bannedPhrases = [
      'you have anxiety',
      'you are depressed',
      'diagnos',
      'god wants you rich',
      'your metrics prove',
      'you failed',
      'your fault',
    ];
    for (const key of EXPECTED_KEYS) {
      const fixture = loadFixture(key);
      const body = fixture.devotionalOutput.devotionalBody.toLowerCase();
      for (const phrase of bannedPhrases) {
        expect(
          body.includes(phrase),
          `${key} devotionalBody unexpectedly contains "${phrase}"`,
        ).toBe(false);
      }
    }
  });
});
