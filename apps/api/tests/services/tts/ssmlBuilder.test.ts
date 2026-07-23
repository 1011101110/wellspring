import { describe, expect, it } from 'vitest';
import { LANGUAGE_TAGS, type DevotionalOutput } from '@kairos/shared-contracts';
import {
  SECTION_BREAK_MS,
  STILLNESS_MS,
  VERSE_BREAK_MS,
  buildDevotionalSsml,
  buildDevotionalSsmlSegments,
  escapeSsml,
  shortSpokenAttribution,
} from '../../../src/services/tts/ssmlBuilder.js';

const baseDevotional: DevotionalOutput = {
  format: 'short',
  theme: 'gratitude',
  verses: [
    {
      usfm: 'PHP.4.6-7',
      versionId: 3034,
      reference: 'Philippians 4:6-7',
      fetchedText: 'Do not be anxious about anything.',
      attribution: 'Berean Standard Bible (BSB). Public domain.',
    },
  ],
  devotionalBody: 'Today has been steady. God meets us in the ordinary.',
  cardSummary: 'Gratitude on an ordinary day.',
  prayer: 'Father, thank You for this day. Amen.',
};

describe('escapeSsml', () => {
  it('escapes all five XML special characters', () => {
    expect(escapeSsml(`A & B < C > D " E ' F`)).toBe('A &amp; B &lt; C &gt; D &quot; E &apos; F');
  });

  it('leaves plain text untouched', () => {
    expect(escapeSsml('Do not be anxious about anything.')).toBe(
      'Do not be anxious about anything.',
    );
  });
});

describe('shortSpokenAttribution', () => {
  it('strips a trailing sentence after the first period', () => {
    expect(shortSpokenAttribution('Berean Standard Bible (BSB). Public domain.')).toBe(
      'Berean Standard Bible (BSB)',
    );
  });

  it('strips a trailing em-dash clause', () => {
    expect(
      shortSpokenAttribution('New International Version (NIV) — Biblica, all rights reserved.'),
    ).toBe('New International Version (NIV)');
  });

  it('falls back to the whole string when there is no separator', () => {
    expect(shortSpokenAttribution('American Standard Version')).toBe('American Standard Version');
  });
});

describe('buildDevotionalSsml', () => {
  it('produces a well-formed single <speak> root', () => {
    const ssml = buildDevotionalSsml(baseDevotional);
    expect(ssml.startsWith('<speak>')).toBe(true);
    expect(ssml.endsWith('</speak>')).toBe(true);
    // exactly one top-level speak pair
    expect(ssml.match(/<speak>/g)).toHaveLength(1);
    expect(ssml.match(/<\/speak>/g)).toHaveLength(1);
  });

  it('includes the section break duration between sections', () => {
    const ssml = buildDevotionalSsml(baseDevotional);
    expect(ssml).toContain(`<break time="${SECTION_BREAK_MS}ms"/>`);
  });

  it('includes the longer verse break after the verse reading', () => {
    const ssml = buildDevotionalSsml(baseDevotional);
    expect(ssml).toContain(`<break time="${VERSE_BREAK_MS}ms"/>`);
  });

  it('includes the verse text, a spoken short-form attribution, the body, and the prayer', () => {
    const ssml = buildDevotionalSsml(baseDevotional);
    expect(ssml).toContain('Do not be anxious about anything.');
    expect(ssml).toContain('Berean Standard Bible (BSB)');
    expect(ssml).not.toContain('Public domain'); // long-form tail must not be spoken
    expect(ssml).toContain('Today has been steady.');
    expect(ssml).toContain('Father, thank You for this day.');
  });

  it('orders verse break before the spoken attribution', () => {
    const ssml = buildDevotionalSsml(baseDevotional);
    const breakIdx = ssml.indexOf(`<break time="${VERSE_BREAK_MS}ms"/>`);
    const attributionIdx = ssml.indexOf('Berean Standard Bible');
    expect(breakIdx).toBeGreaterThan(-1);
    expect(attributionIdx).toBeGreaterThan(breakIdx);
  });

  it('escapes verse text and body containing special characters', () => {
    const withAmpersand: DevotionalOutput = {
      ...baseDevotional,
      devotionalBody: 'Faith & hope go together.',
    };
    const ssml = buildDevotionalSsml(withAmpersand);
    expect(ssml).toContain('Faith &amp; hope go together.');
    expect(ssml).not.toContain('Faith & hope');
  });

  it('speaks the reference before the verse and recaps it at the close (docs/14 §5.1)', () => {
    const ssml = buildDevotionalSsml(baseDevotional);
    const referenceIdx = ssml.indexOf('From Philippians 4:6-7.');
    const verseIdx = ssml.indexOf('Do not be anxious about anything.');
    expect(referenceIdx).toBeGreaterThan(-1);
    expect(verseIdx).toBeGreaterThan(referenceIdx);
    expect(ssml).toContain(
      "That was Philippians 4:6-7 — it'll be here when you want to come back.",
    );
  });

  it('joins multiple verse references with "and" in the closing recap', () => {
    const twoVerses: DevotionalOutput = {
      ...baseDevotional,
      verses: [
        baseDevotional.verses[0]!,
        {
          usfm: 'JHN.3.16',
          versionId: 3034,
          reference: 'John 3:16',
          fetchedText: 'For God so loved the world.',
          attribution: 'Berean Standard Bible (BSB). Public domain.',
        },
      ],
    };
    const ssml = buildDevotionalSsml(twoVerses);
    expect(ssml).toContain('From Philippians 4:6-7.');
    expect(ssml).toContain('From John 3:16.');
    expect(ssml).toContain(
      "That was Philippians 4:6-7 and John 3:16 — it'll be here when you want to come back.",
    );
  });

  it('handles multiple verses, each with its own break + attribution', () => {
    const twoVerses: DevotionalOutput = {
      ...baseDevotional,
      verses: [
        baseDevotional.verses[0]!,
        {
          usfm: 'JHN.3.16',
          versionId: 3034,
          reference: 'John 3:16',
          fetchedText: 'For God so loved the world.',
          attribution: 'Berean Standard Bible (BSB). Public domain.',
        },
      ],
    };
    const ssml = buildDevotionalSsml(twoVerses);
    expect(ssml.match(new RegExp(`<break time="${VERSE_BREAK_MS}ms"/>`, 'g'))).toHaveLength(2);
    expect(ssml).toContain('For God so loved the world.');
  });
});

/** Sums every `<break time="Xms"/>` tag's duration found in an SSML string. */
function sumBreakMs(ssml: string): number {
  const matches = [...ssml.matchAll(/<break time="(\d+)ms"\/>/g)];
  return matches.reduce((total, m) => total + Number(m[1]), 0);
}

describe('buildDevotionalSsml — stillness (docs/14 §5.2)', () => {
  it('adds no stillness content when stillness is off (default)', () => {
    const ssml = buildDevotionalSsml(baseDevotional);
    expect(ssml).not.toContain("Let's sit with this");
    expect(ssml).not.toContain('still here');
  });

  it('adds no stillness content when stillness is explicitly off', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'off');
    expect(ssml).not.toContain("Let's sit with this");
  });

  it('speaks the hand-off and re-entry twice (after the verse, again after the prayer) for brief stillness', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'brief');
    expect(ssml.match(/Let's sit with this — I'll keep the time\./g)).toHaveLength(2);
    expect(ssml.match(/still here\./g)).toHaveLength(2);
  });

  it('encodes exactly STILLNESS_MS.brief of silence per stillness block via chained breaks ≤10s each', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'brief');
    const [handoffBlock] = ssml.split("Let's sit with this").slice(1);
    const blockSsml = handoffBlock!.split('still here.')[0]!;
    const tags = [...blockSsml.matchAll(/<break time="(\d+)ms"\/>/g)];
    expect(tags.every((t) => Number(t[1]) <= 10_000)).toBe(true);
    expect(tags.reduce((sum, t) => sum + Number(t[1]), 0)).toBe(STILLNESS_MS.brief);
  });

  it('encodes exactly STILLNESS_MS.full of silence, split across multiple chained breaks', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'full');
    const [handoffBlock] = ssml.split("Let's sit with this").slice(1);
    const blockSsml = handoffBlock!.split('still here.')[0]!;
    const tags = [...blockSsml.matchAll(/<break time="(\d+)ms"\/>/g)];
    expect(tags.length).toBeGreaterThan(1);
    expect(tags.every((t) => Number(t[1]) <= 10_000)).toBe(true);
    expect(tags.reduce((sum, t) => sum + Number(t[1]), 0)).toBe(STILLNESS_MS.full);
  });

  it('places the stillness block after the verse section and before the body', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'brief');
    const attributionIdx = ssml.indexOf('Berean Standard Bible');
    const handoffIdx = ssml.indexOf("Let's sit with this");
    const bodyIdx = ssml.indexOf('Today has been steady.');
    expect(attributionIdx).toBeLessThan(handoffIdx);
    expect(handoffIdx).toBeLessThan(bodyIdx);
  });

  it('places the second stillness block after the prayer and before the reference recap', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'brief');
    const prayerIdx = ssml.indexOf('Father, thank You for this day.');
    const secondHandoffIdx = ssml.lastIndexOf("Let's sit with this");
    const recapIdx = ssml.indexOf('That was Philippians');
    expect(prayerIdx).toBeLessThan(secondHandoffIdx);
    expect(secondHandoffIdx).toBeLessThan(recapIdx);
  });
});

describe('buildDevotionalSsml — lectio (docs/14 §5.4 / issue #92)', () => {
  it('is unaffected by lectio=false (default) — same output as omitting the parameter', () => {
    expect(buildDevotionalSsml(baseDevotional, 'off', false)).toBe(
      buildDevotionalSsml(baseDevotional),
    );
  });

  it('speaks the verse twice, at rate=0.95 then rate=0.85, and never speaks devotionalBody', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'off', true);
    expect(ssml).toContain('<prosody rate="0.95">Do not be anxious about anything.</prosody>');
    expect(ssml).toContain('<prosody rate="0.85">Do not be anxious about anything.</prosody>');
    expect(ssml).not.toContain('Today has been steady.');
  });

  it('orders the first (faster) reading before the second (slower) reading, with a spoken transition between them', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'off', true);
    const firstIdx = ssml.indexOf('<prosody rate="0.95">');
    const secondIdx = ssml.indexOf('<prosody rate="0.85">');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(ssml).toContain('Once more, slower.');
  });

  it('encodes exactly 20s of silence between the two readings, via chained breaks ≤10s each', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'off', true);
    const between = ssml.split('<prosody rate="0.95">')[1]!.split('<prosody rate="0.85">')[0]!;
    const tags = [...between.matchAll(/<break time="(\d+)ms"\/>/g)];
    expect(tags.every((t) => Number(t[1]) <= 10_000)).toBe(true);
    expect(tags.reduce((sum, t) => sum + Number(t[1]), 0)).toBe(20_000);
  });

  it('speaks the journalingPrompt question when present, and adds no such line when absent', () => {
    const withoutQuestion = buildDevotionalSsml(baseDevotional, 'off', true);
    const withQuestion: DevotionalOutput = {
      ...baseDevotional,
      journalingPrompt: 'Where did you notice this today?',
    };
    const ssml = buildDevotionalSsml(withQuestion, 'off', true);
    expect(ssml).toContain('Where did you notice this today?');
    expect(withoutQuestion).not.toContain('Where did you notice this today?');
  });

  it('reuses the user stillness preference for the meditatio->oratio and post-prayer gaps', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'brief', true);
    expect(ssml.match(/Let's sit with this — I'll keep the time\./g)).toHaveLength(2);
  });

  it('only speaks the first verse — lectio is a single-passage format — but still recaps every reference at the close', () => {
    const twoVerses: DevotionalOutput = {
      ...baseDevotional,
      verses: [
        baseDevotional.verses[0]!,
        {
          usfm: 'JHN.3.16',
          versionId: 3034,
          reference: 'John 3:16',
          fetchedText: 'For God so loved the world.',
          attribution: 'Berean Standard Bible (BSB). Public domain.',
        },
      ],
    };
    const ssml = buildDevotionalSsml(twoVerses, 'off', true);
    expect(ssml).toContain('Do not be anxious about anything.');
    expect(ssml).not.toContain('For God so loved the world.');
    expect(ssml).toContain(
      "That was Philippians 4:6-7 and John 3:16 — it'll be here when you want to come back.",
    );
  });
});

describe('buildDevotionalSsmlSegments — lectio (issue #92)', () => {
  it('single-segment path (fits under maxBytes) matches buildDevotionalSsml with lectio', () => {
    const segments = buildDevotionalSsmlSegments(baseDevotional, 10_000, 'off', true);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toBe(buildDevotionalSsml(baseDevotional, 'off', true));
  });

  it('splits into per-section segments when forced under a tiny maxBytes, still carrying both prosody readings, the question, stillness, and the recap', () => {
    const withQuestion: DevotionalOutput = {
      ...baseDevotional,
      journalingPrompt: 'Where did you notice this today?',
    };
    const segments = buildDevotionalSsmlSegments(withQuestion, 300, 'brief', true);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      expect(seg.startsWith('<speak>')).toBe(true);
      expect(seg.endsWith('</speak>')).toBe(true);
    }
    expect(segments.some((s) => s.includes('<prosody rate="0.95">'))).toBe(true);
    expect(segments.some((s) => s.includes('<prosody rate="0.85">'))).toBe(true);
    expect(segments.some((s) => s.includes('Where did you notice this today?'))).toBe(true);
    expect(segments.some((s) => s.includes("Let's sit with this"))).toBe(true);
    expect(segments.some((s) => s.includes('That was Philippians'))).toBe(true);
    expect(segments.some((s) => s.includes('Today has been steady'))).toBe(false);
  });
});

describe('buildDevotionalSsmlSegments — §3.4 inter-section break preservation', () => {
  const extended: DevotionalOutput = {
    ...baseDevotional,
    format: 'extended',
    devotionalBody: Array.from(
      { length: 200 },
      (_, i) => `Sentence number ${i} about steady grace today.`,
    ).join(' '),
  };

  it('gives every true section-boundary segment a trailing break inside its own <speak> (greeting, verse, prayer)', () => {
    const segments = buildDevotionalSsmlSegments(extended, 500);
    expect(segments.length).toBeGreaterThan(1);
    const greetingSeg = segments.find((s) => s.includes('A moment of'))!;
    const verseSeg = segments.find((s) => s.includes('Do not be anxious'))!;
    const prayerSeg = segments.find((s) => s.includes('Father, thank You'))!;
    [greetingSeg, verseSeg, prayerSeg].forEach((seg) => {
      expect(seg).toMatch(/<break time="\d+ms"\/><\/speak>$/);
    });
    // final segment (reference recap) has nothing after it, so no trailing break needed
    expect(segments[segments.length - 1]).not.toMatch(/<break/);
  });

  it('does not insert a break between pure byte-limit body sub-chunks', () => {
    const segments = buildDevotionalSsmlSegments(extended, 500);
    const bodySegmentIdx = segments.findIndex((s) => s.includes('Sentence number 0 '));
    const nextBodySegmentIdx = segments.findIndex(
      (s, i) =>
        i > bodySegmentIdx && s.includes('Sentence number') && !s.includes('Sentence number 0 '),
    );
    if (nextBodySegmentIdx > -1 && nextBodySegmentIdx === bodySegmentIdx + 1) {
      expect(segments[bodySegmentIdx]).not.toMatch(/<break/);
    }
  });

  it('includes a stillness segment (with its own trailing break) after the verse and after the prayer when enabled', () => {
    const segments = buildDevotionalSsmlSegments(extended, 500, 'brief');
    const stillnessSegments = segments.filter((s) => s.includes("Let's sit with this"));
    expect(stillnessSegments).toHaveLength(2);
    stillnessSegments.forEach((seg) => {
      expect(sumBreakMs(seg)).toBeGreaterThanOrEqual(STILLNESS_MS.brief);
      expect(seg.endsWith('</speak>')).toBe(true);
      expect(seg).toMatch(/<break time="\d+ms"\/><\/speak>$/);
    });
  });

  it('single-segment path (fits under maxBytes) also carries stillness through', () => {
    const segments = buildDevotionalSsmlSegments(baseDevotional, 10_000, 'brief');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toBe(buildDevotionalSsml(baseDevotional, 'brief'));
  });
});

describe('buildDevotionalSsmlSegments', () => {
  it('returns a single segment when the full SSML fits under maxBytes', () => {
    const segments = buildDevotionalSsmlSegments(baseDevotional, 10_000);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toBe(buildDevotionalSsml(baseDevotional));
  });

  it('splits into multiple <speak> segments when the script exceeds maxBytes', () => {
    const longBody = Array.from(
      { length: 200 },
      (_, i) => `Sentence number ${i} about steady grace today.`,
    ).join(' ');
    const extended: DevotionalOutput = {
      ...baseDevotional,
      format: 'extended',
      devotionalBody: longBody,
    };
    const segments = buildDevotionalSsmlSegments(extended, 500);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      expect(seg.startsWith('<speak>')).toBe(true);
      expect(seg.endsWith('</speak>')).toBe(true);
    }
    // concatenated segments still contain the verse and prayer content
    expect(segments.some((s) => s.includes('Do not be anxious'))).toBe(true);
    expect(segments.some((s) => s.includes('Father, thank You'))).toBe(true);
  });

  it('splits a single long sentence-free body chunk on word boundaries so no segment exceeds maxBytes (docs/14 §3.8 / issue #90)', () => {
    const longBody = 'word '.repeat(2000).trim();
    const extended: DevotionalOutput = {
      ...baseDevotional,
      format: 'extended',
      devotionalBody: longBody,
    };
    const maxBytes = 800;
    const segments = buildDevotionalSsmlSegments(extended, maxBytes);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      expect(Buffer.byteLength(seg, 'utf8')).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('measures the escaped byte length, not the raw text, so escaping cannot push a chunk over budget unnoticed (docs/14 §3.8 / issue #90)', () => {
    // Every "word" here escapes to 5x its raw length ("&" -> "&amp;"), so a
    // pre-escape byte count would drastically under-count this body.
    const longBody = Array.from({ length: 100 }, (_, i) => `Clause ${i} & more & more.`).join(' ');
    const extended: DevotionalOutput = {
      ...baseDevotional,
      format: 'extended',
      devotionalBody: longBody,
    };
    const maxBytes = 300;
    const segments = buildDevotionalSsmlSegments(extended, maxBytes);
    for (const seg of segments) {
      expect(Buffer.byteLength(seg, 'utf8')).toBeLessThanOrEqual(maxBytes);
    }
  });
});

describe('per-language spoken phrases (story O4 #316)', () => {
  // Every fixed English connective line the builder used to hard-code.
  // "Hard-coded English speech must not play inside a Spanish devotional"
  // is asserted as ABSENCE of these — a translation table that existed but
  // was never consulted (the mutation this suite must catch) leaves them in.
  const ENGLISH_PHRASES = [
    'A moment of',
    'From ',
    "Let's sit with this",
    'still here',
    'Once more, slower',
    'That was',
    'when you want to come back',
  ];

  const NON_ENGLISH_TAGS = LANGUAGE_TAGS.filter((tag) => tag !== 'en');

  it('omitting the language argument is byte-identical to en — existing callers unchanged', () => {
    expect(buildDevotionalSsml(baseDevotional, 'brief', false, 'en')).toBe(
      buildDevotionalSsml(baseDevotional, 'brief'),
    );
    expect(buildDevotionalSsml(baseDevotional, 'full', true, 'en')).toBe(
      buildDevotionalSsml(baseDevotional, 'full', true),
    );
  });

  it('es SSML contains no English connective phrase and does contain the Spanish ones', () => {
    const ssml = buildDevotionalSsml(baseDevotional, 'brief', false, 'es');
    for (const phrase of ENGLISH_PHRASES) {
      expect(ssml).not.toContain(phrase);
    }
    expect(ssml).toContain('Un momento de gratitude.');
    expect(ssml).toContain('De Philippians 4:6-7.');
    expect(ssml).toContain('Quedémonos un momento con esto — yo llevo el tiempo.');
    expect(ssml).toContain('…aquí sigo.');
    expect(ssml).toContain('aquí estará cuando quieras volver');
  });

  it('no language ships English connective speech — asserted for all five non-en tags', () => {
    for (const tag of NON_ENGLISH_TAGS) {
      const ssml = buildDevotionalSsml(baseDevotional, 'brief', false, tag);
      for (const phrase of ENGLISH_PHRASES) {
        expect(ssml, `language=${tag} leaked "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it('lectio localizes its cue lines too — "Once more, slower." must not survive in es', () => {
    const ssml = buildDevotionalSsml(
      { ...baseDevotional, journalingPrompt: 'Where did you meet God today?' },
      'brief',
      true,
      'es',
    );
    expect(ssml).not.toContain('Once more, slower.');
    expect(ssml).toContain('Una vez más, más despacio.');
    // Generated CONTENT (the model's own prompt text) is O3's concern, not
    // the phrase table's — it passes through untouched.
    expect(ssml).toContain('Where did you meet God today?');
  });

  it('stillness and lectio timings are unchanged across languages — only the words differ', () => {
    // Acceptance (#316): "Stillness/lectio timings unchanged across
    // languages." Compare the exact <break> tag sequence, which encodes
    // every pause the listener experiences.
    const breaksOf = (ssml: string) => ssml.match(/<break time="\d+ms"\/>/g);
    for (const stillness of ['brief', 'full'] as const) {
      for (const lectio of [false, true]) {
        const en = breaksOf(buildDevotionalSsml(baseDevotional, stillness, lectio, 'en'));
        for (const tag of NON_ENGLISH_TAGS) {
          expect(breaksOf(buildDevotionalSsml(baseDevotional, stillness, lectio, tag))).toEqual(en);
        }
      }
    }
  });

  it('zh joins multiple references with 、and 和 rather than the English comma/and', () => {
    const twoVerses: DevotionalOutput = {
      ...baseDevotional,
      verses: [
        ...baseDevotional.verses,
        {
          usfm: 'JHN.3.16',
          versionId: 43,
          reference: 'John 3:16',
          fetchedText: 'For God so loved the world.',
          attribution: 'Chinese Standard Bible',
        },
      ],
    };
    const ssml = buildDevotionalSsml(twoVerses, 'off', false, 'zh');
    expect(ssml).toContain('Philippians 4:6-7和John 3:16');
    expect(ssml).not.toContain('Philippians 4:6-7 and John 3:16');
  });

  it('the segmented (long-script) path is localized identically to the single-document path', () => {
    // The phrases appear in TWO code paths (buildDevotionalSsml and the
    // per-section segments builder); a fix that only touched one would pass
    // every single-document test and still speak English on extended
    // devotionals.
    const longBody = 'word '.repeat(2000).trim();
    const extended: DevotionalOutput = {
      ...baseDevotional,
      format: 'extended',
      devotionalBody: longBody,
    };
    const joined = buildDevotionalSsmlSegments(extended, 800, 'brief', false, 'es').join('');
    for (const phrase of ENGLISH_PHRASES) {
      expect(joined).not.toContain(phrase);
    }
    expect(joined).toContain('Un momento de gratitude.');
    expect(joined).toContain('Eso fue Philippians 4:6-7 — aquí estará cuando quieras volver.');
  });
});
