/**
 * SSML + spokenPhrases coverage for the Open Moment (EPIC V #360 / V4 #365).
 */
import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_TAGS,
  type LanguageTag,
  type DevotionalOutput,
  type LiveResponse,
} from '@kairos/shared-contracts';
import {
  buildDevotionalSsmlSegments,
  buildLiveResponseSsmlSegments,
  buildOpenMomentAuxSsmlSegments,
} from '../../../src/services/tts/ssmlBuilder.js';
import { SPOKEN_PHRASES } from '../../../src/services/tts/spokenPhrases.js';

const DEVOTIONAL: DevotionalOutput = {
  format: 'standard',
  theme: 'rest',
  verses: [
    {
      usfm: 'MAT.11.28',
      versionId: 3034,
      reference: 'Matthew 11:28',
      fetchedText: 'Come to Me, all you who labor and are heavy-laden, and I will give you rest.',
      attribution: 'Berean Standard Bible (BSB). Public domain.',
    },
  ],
  devotionalBody: 'A reflection on rest for the weary, ending in a question.',
  cardSummary: 'Rest for the weary.',
  prayer: 'Jesus, give me rest today. Amen.',
};

describe('buildDevotionalSsmlSegments — open moment invitation (mutation-checked)', () => {
  it('emits an open_moment invitation segment BEFORE the prayer when enabled', () => {
    const segments = buildDevotionalSsmlSegments(DEVOTIONAL, 4500, 'off', false, 'en', true);
    const openMomentIdx = segments.findIndex((s) => s.section === 'open_moment');
    const prayerIdx = segments.findIndex((s) => s.section === 'prayer');
    expect(openMomentIdx).toBeGreaterThanOrEqual(0);
    expect(prayerIdx).toBeGreaterThan(openMomentIdx); // resume point is the prayer
    expect(segments[openMomentIdx]?.text).toBe(SPOKEN_PHRASES.en.openMomentInvitation);
  });

  it('MUTATION CHECK: emits NO open_moment segment when the flag is off (default)', () => {
    const off = buildDevotionalSsmlSegments(DEVOTIONAL, 4500, 'off', false, 'en');
    expect(off.some((s) => s.section === 'open_moment')).toBe(false);
    // ...and enabling it is the ONLY difference (byte-identical otherwise).
    const on = buildDevotionalSsmlSegments(DEVOTIONAL, 4500, 'off', false, 'en', true);
    expect(on.length).toBe(off.length + 1);
    expect(on.filter((s) => s.section !== 'open_moment')).toEqual(off);
  });
});

describe('spokenPhrases open-moment table (per-language, O4 pattern)', () => {
  it('every language has a confidently-phrased invitation + silence-close', () => {
    for (const tag of LANGUAGE_TAGS) {
      const phrases = SPOKEN_PHRASES[tag as LanguageTag];
      expect(phrases.openMomentInvitation, `invitation for ${tag}`).toBeTruthy();
      expect(phrases.openMomentSilenceClose, `close for ${tag}`).toBeTruthy();
    }
  });

  it("the EN baseline is the epic's final copy, verbatim", () => {
    expect(SPOKEN_PHRASES.en.openMomentInvitation).toBe(
      "If you'd like, speak what you're carrying. Or simply sit with it — I'll wait with you either way.",
    );
    expect(SPOKEN_PHRASES.en.openMomentSilenceClose).toBe(
      "That's yours to hold. Let's close together.",
    );
  });

  it('MUTATION CHECK: non-English invitations are actually localized (not the English string)', () => {
    for (const tag of ['es', 'fr', 'de', 'pt', 'zh'] as const) {
      expect(SPOKEN_PHRASES[tag].openMomentInvitation).not.toBe(
        SPOKEN_PHRASES.en.openMomentInvitation,
      );
    }
  });
});

describe('buildLiveResponseSsmlSegments (V2 live response)', () => {
  const RESPONSE: LiveResponse = {
    acknowledgment: 'I hear the weight you carried in.',
    verse: {
      usfm: 'MAT.11.28',
      versionId: 3034,
      reference: 'Matthew 11:28',
      fetchedText: 'Come to Me, all you who labor and are heavy-laden, and I will give you rest.',
      attribution: 'Berean Standard Bible (BSB). Public domain.',
    },
    framing: 'Let that be the last word before we pray.',
  };

  it('produces exactly the three liturgy parts in order, carrying the exact verse bytes', () => {
    const segments = buildLiveResponseSsmlSegments(RESPONSE, 'en');
    expect(segments.map((s) => s.part)).toEqual(['acknowledgment', 'verse', 'framing']);
    expect(segments[1]?.text).toContain(RESPONSE.verse.fetchedText);
    expect(segments[0]?.text).toBe(RESPONSE.acknowledgment);
    expect(segments[2]?.text).toBe(RESPONSE.framing);
    // Every segment is a complete <speak> document.
    for (const s of segments) expect(s.ssml.startsWith('<speak>')).toBe(true);
  });
});

describe('buildOpenMomentAuxSsmlSegments (pre-synth, Path B has zero live dependency)', () => {
  it('always returns a lead-in breath, and a silence-close for a phrased language', () => {
    const aux = buildOpenMomentAuxSsmlSegments('en');
    expect(aux.leadIn.text).toBe('');
    expect(aux.leadIn.ssml).toContain('break');
    expect(aux.silenceClose?.text).toBe(SPOKEN_PHRASES.en.openMomentSilenceClose);
  });
});
