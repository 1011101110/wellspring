import { describe, expect, it } from 'vitest';
import {
  ALL_SIGNALS_OBSERVED,
  CALENDAR_ONLY_SIGNALS_OBSERVED,
  NO_SIGNALS_OBSERVED,
  buildInstructions,
  resolveTargetFormat,
  type BuildInstructionsParams,
} from '../../../src/services/gloo/instructionsBuilder.js';
import type { BandInput, DevotionalFormat, Tradition } from '@kairos/shared-contracts';
import { TraditionSchema } from '@kairos/shared-contracts';

const TRADITIONS: Tradition[] = [...TraditionSchema.options];

function bands(overrides: Partial<BandInput>): BandInput {
  return {
    recovery: 'moderate',
    sleepQuality: 'fair',
    activity: 'moderate',
    busyness: 'moderate',
    communicationLoad: null,
    distressSignal: false,
    ...overrides,
  };
}

/** Representative grid of band combinations, one per format-heuristic branch (Foundation §5),
 *  plus a couple of edge/tie-break cases. */
const BAND_CASES: Array<{ name: string; bands: BandInput; expectedFormat: DevotionalFormat }> = [
  {
    name: 'low recovery + heavy busyness -> short (micro/short heuristic)',
    bands: bands({ recovery: 'low', busyness: 'heavy' }),
    expectedFormat: 'short',
  },
  {
    name: 'light busyness + high recovery -> extended',
    bands: bands({ recovery: 'high', busyness: 'light' }),
    expectedFormat: 'extended',
  },
  {
    name: 'distressSignal true -> always micro, even with light busyness + high recovery',
    bands: bands({ recovery: 'high', busyness: 'light', distressSignal: true }),
    expectedFormat: 'micro',
  },
  {
    name: 'distressSignal true -> always micro, even with low recovery + heavy busyness',
    bands: bands({ recovery: 'low', busyness: 'heavy', distressSignal: true }),
    expectedFormat: 'micro',
  },
  {
    name: 'default: moderate everything -> standard',
    bands: bands({}),
    expectedFormat: 'standard',
  },
  {
    name: 'default: high recovery but moderate busyness -> standard (extended requires light busyness too)',
    bands: bands({ recovery: 'high', busyness: 'moderate' }),
    expectedFormat: 'standard',
  },
  {
    // #212: an open calendar earns `extended` on its own. `moderate` recovery
    // is both a real reading and the neutral default for a user with no health
    // data at all — which is every web user, since a browser cannot read
    // HealthKit. Requiring `high` here capped them below the "15-minute
    // invitation" the PRD promises, contradicting the calendar-first pivot.
    name: '#212: light busyness with neutral (calendar-only) recovery -> extended, no health data required',
    bands: bands({ recovery: 'moderate', busyness: 'light' }),
    expectedFormat: 'extended',
  },
  {
    // The boundary that must survive: health is still respected when we
    // actually have it. Knowing someone is depleted is a reason to be gentler
    // even on a wide-open day — that is care, not a capability gate.
    name: '#212: light busyness but measured LOW recovery -> standard, not extended',
    bands: bands({ recovery: 'low', busyness: 'light' }),
    expectedFormat: 'standard',
  },
  {
    name: 'default: low recovery but moderate busyness -> standard (short requires heavy busyness too)',
    bands: bands({ recovery: 'low', busyness: 'moderate' }),
    expectedFormat: 'standard',
  },
];

const TRANSLATION = 'BSB';

describe('resolveTargetFormat', () => {
  for (const testCase of BAND_CASES) {
    it(`${testCase.name}`, () => {
      expect(resolveTargetFormat(testCase.bands)).toBe(testCase.expectedFormat);
    });
  }

  it('distressSignal overrides an explicit user durationPreference', () => {
    const distressBands = bands({ distressSignal: true, recovery: 'high', busyness: 'light' });
    expect(resolveTargetFormat(distressBands, 'extended')).toBe('micro');
  });

  it('an explicit durationPreference overrides the non-distress heuristics', () => {
    const lowHeavy = bands({ recovery: 'low', busyness: 'heavy' });
    expect(resolveTargetFormat(lowHeavy, 'extended')).toBe('extended');
  });

  it('null/undefined durationPreference falls through to the heuristic ("auto")', () => {
    const lightHigh = bands({ recovery: 'high', busyness: 'light' });
    expect(resolveTargetFormat(lightHigh, null)).toBe('extended');
    expect(resolveTargetFormat(lightHigh, undefined)).toBe('extended');
  });

  // ── slotType='examen' (issue #77) ──────────────────────────────
  it('slotType=examen -> micro when busyness is not heavy', () => {
    expect(resolveTargetFormat(bands({ busyness: 'moderate' }), undefined, 'examen')).toBe('micro');
    expect(resolveTargetFormat(bands({ busyness: 'light' }), undefined, 'examen')).toBe('micro');
  });

  it('slotType=examen -> short when busyness is heavy', () => {
    expect(resolveTargetFormat(bands({ busyness: 'heavy' }), undefined, 'examen')).toBe('short');
  });

  it('slotType=examen bypasses an explicit durationPreference — the examen length is not user-pinnable', () => {
    expect(resolveTargetFormat(bands({ busyness: 'moderate' }), 'extended', 'examen')).toBe('micro');
  });

  it('distressSignal still wins over slotType=examen (safety floor is not overridable)', () => {
    expect(resolveTargetFormat(bands({ distressSignal: true, busyness: 'heavy' }), undefined, 'examen')).toBe(
      'micro',
    );
  });
});

describe('buildInstructions — tradition x band grid', () => {
  const grid: BuildInstructionsParams[] = [];
  for (const tradition of TRADITIONS) {
    for (const testCase of BAND_CASES) {
      grid.push({ tradition, translation: TRANSLATION, bands: testCase.bands, signalProvenance: ALL_SIGNALS_OBSERVED });
    }
  }

  it('covers all traditions and all representative band cases', () => {
    expect(grid.length).toBe(TRADITIONS.length * BAND_CASES.length);
  });

  for (const params of grid) {
    const label = `${params.tradition} / recovery=${params.bands.recovery} sleepQuality=${params.bands.sleepQuality} busyness=${params.bands.busyness} distress=${params.bands.distressSignal}`;

    describe(label, () => {
      const instructions = buildInstructions(params);
      const expectedFormat = resolveTargetFormat(params.bands, params.durationPreference);

      it('always includes the full theological safety spec verbatim (Foundation §9)', () => {
        expect(instructions).toContain('No medical diagnosis, treatment claims, or inference of health/spiritual condition.');
        expect(instructions).toContain(
          'No prosperity framing; no shame/guilt framing ("your metrics prove you failed").',
        );
        expect(instructions).toContain("No proof-texting that inverts a passage's meaning.");
        expect(instructions).toContain(
          'Bands are framed as "where your body is today," never as verdict. Tone: companionship, not correction.',
        );
        expect(instructions).toContain(
          'Distress lowers volume: extreme signals trigger gentleness and a resource pointer, never alarm.',
        );
        expect(instructions).toContain('Exact Scripture text always comes from YouVersion via get_bible_verse.');
      });

      it('never omits the "never quote Scripture from memory, use get_bible_verse" instruction', () => {
        expect(instructions).toMatch(/never quote scripture from memory/i);
        expect(instructions).toMatch(/get_bible_verse/);
      });

      it('selects the correct target format per the Foundation §5 heuristic', () => {
        expect(instructions).toContain(`Target format: ${expectedFormat}`);
      });

      it('includes tradition framing for the requested tradition and no other tradition\'s framing', () => {
        expect(instructions).toContain(`Tradition: ${params.tradition}`);
        const otherTraditions = TRADITIONS.filter((t) => t !== params.tradition);
        for (const other of otherTraditions) {
          expect(instructions).not.toContain(`Tradition: ${other}.`);
        }
      });

      if (params.bands.distressSignal) {
        it('adds the distress gentle-comfort clause when distressSignal is true', () => {
          expect(instructions.toLowerCase()).toContain('distress');
          expect(instructions).toMatch(/gentle-comfort|gentle, non-alarming|resource pointer/i);
        });
      }
    });
  }
});

describe('buildInstructions — snapshot per tradition (default band case)', () => {
  for (const tradition of TRADITIONS) {
    it(`matches snapshot for tradition=${tradition}`, () => {
      const instructions = buildInstructions({
        tradition,
        translation: TRANSLATION,
        bands: bands({}),
        signalProvenance: ALL_SIGNALS_OBSERVED,
      });
      expect(instructions).toMatchSnapshot();
    });
  }
});

describe('buildInstructions — snapshot per representative band case (general tradition)', () => {
  for (const testCase of BAND_CASES) {
    it(`matches snapshot for ${testCase.name}`, () => {
      const instructions = buildInstructions({
        tradition: 'general',
        translation: TRANSLATION,
        bands: testCase.bands,
        signalProvenance: ALL_SIGNALS_OBSERVED,
      });
      expect(instructions).toMatchSnapshot();
    });
  }
});

describe('buildInstructions — purity', () => {
  it('is deterministic: identical inputs produce a byte-identical string', () => {
    const params: BuildInstructionsParams = {
      tradition: 'catholic',
      translation: 'ASV',
      bands: bands({ recovery: 'low', busyness: 'heavy' }),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      durationPreference: undefined,
    };
    const a = buildInstructions(params);
    const b = buildInstructions(params);
    expect(a).toBe(b);
  });

  it('respects an explicit durationPreference override in the rendered "Target format" line', () => {
    const instructions = buildInstructions({
      tradition: 'evangelical',
      translation: 'BSB',
      bands: bands({ recovery: 'low', busyness: 'heavy' }),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      durationPreference: 'extended',
    });
    expect(instructions).toContain('Target format: extended');
  });
});

describe('buildInstructions — tradition framing (Foundation §7, issue #192)', () => {
  function framingFor(tradition: Tradition): string {
    return buildInstructions({ tradition, translation: TRANSLATION, bands: bands({}), signalProvenance: ALL_SIGNALS_OBSERVED });
  }

  it('every tradition emits its own named framing line — none falls through to a default', () => {
    // The failure #192 calls out as worse than not offering the tradition at
    // all: a chosen tradition silently producing generic content. A
    // `Record<Tradition, string>` makes the omission a compile error, and this
    // makes it a test failure too, including for values added later.
    for (const tradition of TRADITIONS) {
      expect(framingFor(tradition)).toContain(`Tradition: ${tradition}`);
    }
  });

  it('no tradition leaks another tradition\'s framing line', () => {
    for (const tradition of TRADITIONS) {
      const instructions = framingFor(tradition);
      for (const other of TRADITIONS) {
        if (other === tradition) continue;
        expect(instructions).not.toContain(`Tradition: ${other}`);
      }
    }
  });

  it('every tradition\'s framing says what to lean into AND what to avoid', () => {
    // The shape the catholic branch established. A framing that only says
    // "lean into X" without boundaries is what produces a tradition-flavored
    // veneer over generically-evangelical content.
    for (const tradition of TRADITIONS) {
      expect(framingFor(tradition)).toMatch(/\bAvoid\b|\bavoid\b|\bDo not\b|\bdecline/);
    }
  });

  it('anglican framing names the Book of Common Prayer, the daily office, and the via media', () => {
    // #192: the BCP frame is "arguably the single most distinctive thing about
    // praying in that tradition" — its absence was the whole reason `mainline`
    // was an inadequate home for these users.
    const instructions = framingFor('anglican');
    expect(instructions).toContain('Book of Common Prayer');
    expect(instructions).toContain('Morning and Evening Prayer');
    expect(instructions).toContain('collects');
    expect(instructions).toContain('via media');
    // Both inheritances held together — not resolved into either.
    expect(instructions).toContain('catholic inheritance');
    expect(instructions).toContain('reformed inheritance');
    // Sacramental, but not Roman: must not import Catholic magisterial framing.
    expect(instructions).toContain('Roman magisterial authority');
  });

  it('orthodox framing names theosis, the Jesus Prayer, the Fathers, and icons', () => {
    const instructions = framingFor('orthodox');
    expect(instructions).toContain('theosis');
    expect(instructions).toContain('Jesus Prayer');
    expect(instructions).toContain('hesychast');
    expect(instructions).toContain('Church Fathers');
    expect(instructions).toContain('icons');
    expect(instructions).toContain('Theotokos');
  });

  it('orthodox framing refuses to assume a Western canon or versification', () => {
    // #192: "different canon/Scripture conventions". The Orthodox Old Testament
    // follows the Septuagint, so both its contents and some Psalm numbering
    // differ from the Western Bibles this app otherwise fetches from.
    const instructions = framingFor('orthodox');
    expect(instructions).toContain('Septuagint');
    expect(instructions).toMatch(/Psalm numbering/);
    expect(instructions).toContain('do not assert that any Western canon');
  });

  it('neither new tradition is framed in evangelical or Roman-Catholic terms', () => {
    // The specific misrepresentation #192 names: generically-evangelical
    // content under an Orthodox heading.
    for (const tradition of ['anglican', 'orthodox'] as const) {
      const instructions = framingFor(tradition);
      expect(instructions).toContain('avoid revivalist or altar-call idiom');
      expect(instructions).not.toContain('personal-relationship-with-Jesus');
    }
    // Orthodox specifically must not be handed Western-scholastic atonement
    // mechanics or papal authority as assumed background.
    const orthodox = framingFor('orthodox');
    expect(orthodox).toContain('avoid presuming papal authority');
    expect(orthodox).toContain('Avoid Western-scholastic framings');
  });

  it('the new traditions still carry the full safety spec and Scripture-sourcing rule', () => {
    // Tradition framing is additive; it must never displace the §9 guardrails.
    for (const tradition of ['anglican', 'orthodox'] as const) {
      const instructions = framingFor(tradition);
      expect(instructions).toContain('Theological safety guardrails (non-negotiable):');
      expect(instructions).toContain('Never quote Scripture from memory.');
    }
  });
});

describe('buildInstructions — slotType=examen (issue #77)', () => {
  it('includes the examen structure instruction and omits the ordinary "Choose ONE... Bible reference" line', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({ busyness: 'moderate' }),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      slotType: 'examen',
    });
    expect(instructions).toContain('This is an EVENING EXAMEN, not an expository devotional.');
    expect(instructions).not.toContain(
      'Choose ONE (or a short connected pair of) specific Bible reference(s) that fits these signals.',
    );
  });

  it('the ordinary standard-slot instructions include the "Choose ONE... Bible reference" line and omit the examen structure', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({ busyness: 'moderate' }),
      signalProvenance: ALL_SIGNALS_OBSERVED,
    });
    expect(instructions).toContain(
      'Choose ONE (or a short connected pair of) specific Bible reference(s) that fits these signals.',
    );
    expect(instructions).not.toContain('This is an EVENING EXAMEN');
  });

  it('resolves target format via the examen heuristic in the rendered "Target format" line', () => {
    const heavy = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({ busyness: 'heavy' }),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      slotType: 'examen',
    });
    expect(heavy).toContain('Target format: short');

    const light = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({ busyness: 'light' }),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      slotType: 'examen',
    });
    expect(light).toContain('Target format: micro');
  });

  it('an explicit durationPreference is ignored during an examen — the format line still reflects the examen heuristic', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({ busyness: 'moderate' }),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      durationPreference: 'extended',
      slotType: 'examen',
    });
    expect(instructions).toContain('Target format: micro');
  });

  it('distressSignal still adds the 988 resource clause and wins the format even during an examen', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({ distressSignal: true, busyness: 'heavy' }),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      slotType: 'examen',
    });
    expect(instructions).toContain('Target format: micro');
    expect(instructions).toMatch(/988/);
    expect(instructions).toContain('This is an EVENING EXAMEN');
  });

  it('still includes the full theological safety spec verbatim during an examen', () => {
    const instructions = buildInstructions({
      tradition: 'catholic',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      slotType: 'examen',
    });
    expect(instructions).toContain('Exact Scripture text always comes from YouVersion via get_bible_verse.');
  });

  it('matches snapshot for the examen slot (general tradition, default bands)', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      slotType: 'examen',
    });
    expect(instructions).toMatchSnapshot();
  });
});

describe('buildInstructions — lectio (issue #92)', () => {
  it('includes the lectio structure instruction and omits the ordinary "Choose ONE... Bible reference" line', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      lectio: true,
    });
    expect(instructions).toContain('This is LECTIO DIVINA, not an expository devotional.');
    expect(instructions).not.toContain(
      'Choose ONE (or a short connected pair of) specific Bible reference(s) that fits these signals.',
    );
  });

  it('the ordinary (non-lectio) instructions include the "Choose ONE... Bible reference" line and omit the lectio structure', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
    });
    expect(instructions).toContain(
      'Choose ONE (or a short connected pair of) specific Bible reference(s) that fits these signals.',
    );
    expect(instructions).not.toContain('This is LECTIO DIVINA');
  });

  it('instructs a single passage only, never a pair', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      lectio: true,
    });
    expect(instructions).toMatch(/exactly ONE specific Bible reference/);
    expect(instructions).toMatch(/never a pair/);
  });

  it('asks for a short devotionalBody and exactly one meditative journalingPrompt question', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      lectio: true,
    });
    expect(instructions).toMatch(/devotionalBody.*short|short.*devotionalBody/i);
    expect(instructions).toMatch(/exactly one short, open, meditative journalingPrompt/i);
  });

  it('slotType=examen takes priority over lectio when both are somehow set', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      slotType: 'examen',
      lectio: true,
    });
    expect(instructions).toContain('This is an EVENING EXAMEN');
    expect(instructions).not.toContain('This is LECTIO DIVINA');
  });

  it('still includes the full theological safety spec verbatim in lectio mode', () => {
    const instructions = buildInstructions({
      tradition: 'catholic',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      lectio: true,
    });
    expect(instructions).toContain('Exact Scripture text always comes from YouVersion via get_bible_verse.');
  });

  it('matches snapshot for lectio mode (general tradition, default bands)', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      lectio: true,
    });
    expect(instructions).toMatchSnapshot();
  });
});

describe('buildInstructions — liturgical seasons (docs/14 §5.7, issue #95)', () => {
  // 2026-12-06 is the 2nd week of Advent 2026 (Advent 1 = 2026-11-29).
  const ADVENT_DATE = '2026-12-06';

  it('omits the season line entirely when no date is provided, regardless of tradition', () => {
    for (const tradition of TraditionSchema.options) {
      const instructions = buildInstructions({ tradition, translation: TRANSLATION, bands: bands({}), signalProvenance: ALL_SIGNALS_OBSERVED });
      expect(instructions).not.toMatch(/week of Advent|Christmastide|week of Lent|week of Eastertide|Ordinary Time/);
    }
  });

  it('catholic, mainline, and anglican traditions always include the season line when a date is provided', () => {
    // anglican added by #192: the BCP is organized around exactly these
    // seasons, on exactly the Western computus liturgicalCalendar.ts uses.
    for (const tradition of ['catholic', 'mainline', 'anglican'] as const) {
      const instructions = buildInstructions({
        tradition,
        translation: TRANSLATION,
        bands: bands({}),
        signalProvenance: ALL_SIGNALS_OBSERVED,
        date: ADVENT_DATE,
      });
      expect(instructions).toContain('2nd week of Advent');
    }
  });

  it('evangelical, general, and orthodox traditions omit the season line by default, even with a date provided', () => {
    // orthodox is in this opt-in group rather than the forced-on group on
    // purpose (#192): the computed season is Gregorian, and most Orthodox
    // churches reckon Pascha on the Julian calendar, so forcing it on would
    // confidently assert the wrong season. See FORCED_LITURGICAL_SEASON_TRADITIONS.
    for (const tradition of ['evangelical', 'general', 'orthodox'] as const) {
      const instructions = buildInstructions({
        tradition,
        translation: TRANSLATION,
        bands: bands({}),
        signalProvenance: ALL_SIGNALS_OBSERVED,
        date: ADVENT_DATE,
      });
      expect(instructions).not.toMatch(/week of Advent/);
    }
  });

  it('an orthodox user who opts in gets the season line qualified as Western-reckoned, never as their own calendar', () => {
    const instructions = buildInstructions({
      tradition: 'orthodox',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      date: ADVENT_DATE,
      liturgicalSeasonsEnabled: true,
    });
    expect(instructions).toContain('2nd week of Advent');
    expect(instructions).toContain('computed on the Western (Gregorian) calendar');
    expect(instructions).toContain('Orthodox reckoning of Great Lent and Pascha usually differs');
  });

  it('the Western-calendar caveat is scoped to orthodox and appears for no other tradition', () => {
    for (const tradition of TraditionSchema.options) {
      if (tradition === 'orthodox') continue;
      const instructions = buildInstructions({
        tradition,
        translation: TRANSLATION,
        bands: bands({}),
        signalProvenance: ALL_SIGNALS_OBSERVED,
        date: ADVENT_DATE,
        liturgicalSeasonsEnabled: true,
      });
      expect(instructions).not.toContain('computed on the Western (Gregorian) calendar');
    }
  });

  it('evangelical and general traditions include the season line once liturgicalSeasonsEnabled is true', () => {
    for (const tradition of ['evangelical', 'general'] as const) {
      const instructions = buildInstructions({
        tradition,
        translation: TRANSLATION,
        bands: bands({}),
        signalProvenance: ALL_SIGNALS_OBSERVED,
        date: ADVENT_DATE,
        liturgicalSeasonsEnabled: true,
      });
      expect(instructions).toContain('2nd week of Advent');
    }
  });

  it('renders the correct season for the given date (Christmastide)', () => {
    const instructions = buildInstructions({
      tradition: 'catholic',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      date: '2026-12-25',
    });
    expect(instructions).toContain('Christmastide');
  });

  it('is deterministic for a fixed date: identical inputs produce an identical string', () => {
    const params: BuildInstructionsParams = {
      tradition: 'catholic',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      date: ADVENT_DATE,
    };
    expect(buildInstructions(params)).toBe(buildInstructions(params));
  });
});

describe('buildInstructions — prayerIntention deliberate disclosure (docs/14 §5.5, issue #93)', () => {
  it('omits the prayer-intention line entirely when not provided', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
    });
    expect(instructions).not.toMatch(/carrying/i);
  });

  it('weaves in the exact submitted text as deliberate disclosure when provided', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      prayerIntention: 'a hard conversation with my sister',
    });
    expect(instructions).toContain(
      'Yesterday, this user shared one thing they\'re carrying: "a hard conversation with my sister".',
    );
  });

  it('frames it as remembering/praying with them, never as a problem to fix or a metric to react to', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      prayerIntention: 'job interview nerves',
    });
    expect(instructions).toMatch(/remembering with them and praying with them/);
    expect(instructions).toMatch(/not analyzing, advising, or "solving" it/);
    expect(instructions).toMatch(/[Nn]ever present it back as a problem to fix or a metric to react to/);
  });

  it('is deterministic: identical prayerIntention text produces a byte-identical string', () => {
    const params: BuildInstructionsParams = {
      tradition: 'evangelical',
      translation: TRANSLATION,
      bands: bands({ recovery: 'low', busyness: 'heavy' }),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      prayerIntention: 'grieving a friend',
    };
    expect(buildInstructions(params)).toBe(buildInstructions(params));
  });

  it('still includes the full theological safety spec verbatim alongside a prayer intention', () => {
    const instructions = buildInstructions({
      tradition: 'catholic',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      prayerIntention: 'financial stress',
    });
    expect(instructions).toContain('Exact Scripture text always comes from YouVersion via get_bible_verse.');
  });
});

describe('buildInstructions — theme (Epic I / I4, #64)', () => {
  it('includes a theme-focus line when a theme is provided', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      theme: 'this week: perseverance',
    });
    expect(instructions).toContain('Center this devotional on the theme that was chosen for it: "this week: perseverance"');
  });

  it('omits the theme line entirely when no theme is provided', () => {
    const instructions = buildInstructions({ tradition: 'general', translation: TRANSLATION, bands: bands({}), signalProvenance: ALL_SIGNALS_OBSERVED });
    expect(instructions).not.toContain('Center this devotional on the theme');
  });
});

describe('buildInstructions — inviteContext (Epic I / I2, #62)', () => {
  it('weaves the user\'s invite words in with elevated, non-fixing care', () => {
    const instructions = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      inviteContext: 'Rough stretch with my team lately.',
    });
    expect(instructions).toContain('in their own words, on the invitation they sent Wellspring');
    expect(instructions).toContain('Rough stretch with my team lately.');
    // Elevated-safety framing is present, not just the raw text.
    expect(instructions).toMatch(/non-shaming, non-fixing/);
  });

  it('omits the invite-context line entirely when none is provided', () => {
    const instructions = buildInstructions({ tradition: 'general', translation: TRANSLATION, bands: bands({}), signalProvenance: ALL_SIGNALS_OBSERVED });
    expect(instructions).not.toContain('on the invitation they sent Wellspring');
  });
});

/**
 * Signal provenance (issue #196 / K10) — the honesty guarantee.
 *
 * Background, because these assertions look pedantic without it: a real
 * generated devotional opened with "There is a particular kind of tiredness ...
 * moderate demands, scattered energy" for a user who had never granted
 * HealthKit at all. Nothing had been observed; the model was reading
 * NEUTRAL_DEFAULT_BANDS (`moderate`/`fair`/`moderate`) presented to it under
 * the heading "Today's signals for this user" and, reasonably, treated it as
 * knowledge. The bands themselves cannot carry the distinction — a defaulted
 * `moderate` and a measured `moderate` are the same string — so the whole
 * guarantee rests on `signalProvenance` reaching this builder and changing
 * what it emits. These tests are the tripwire for that.
 */
describe('buildInstructions — signal provenance (issue #196)', () => {
  const NEUTRAL_DEFAULTS = bands({
    recovery: 'moderate',
    sleepQuality: 'fair',
    activity: 'moderate',
    busyness: 'moderate',
  });

  function build(signalProvenance: typeof ALL_SIGNALS_OBSERVED, bandInput = NEUTRAL_DEFAULTS): string {
    return buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bandInput,
      signalProvenance,
    });
  }

  it('produces DIFFERENT instructions for identical band values depending on provenance', () => {
    // The core assertion. Same bands, byte-for-byte; the only difference is
    // whether they were measured. If these ever converge, the model has lost
    // its only way to tell an observation from a fallback.
    expect(build(ALL_SIGNALS_OBSERVED)).not.toBe(build(NO_SIGNALS_OBSERVED));
    expect(build(ALL_SIGNALS_OBSERVED)).not.toBe(build(CALENDAR_ONLY_SIGNALS_OBSERVED));
    expect(build(NO_SIGNALS_OBSERVED)).not.toBe(build(CALENDAR_ONLY_SIGNALS_OBSERVED));
  });

  it('adds no provenance caveat at all when every signal is a real observation', () => {
    const instructions = build(ALL_SIGNALS_OBSERVED);
    expect(instructions).not.toContain('NOT OBSERVED');
    expect(instructions).not.toContain('SIGNAL PROVENANCE');
  });

  it('marks each unobserved band inline, next to the value it qualifies', () => {
    const instructions = build(NO_SIGNALS_OBSERVED);
    // Inline rather than only in a trailing paragraph: the marker must not be
    // readable apart from the number it disclaims.
    expect(instructions).toContain('- recovery: moderate [NOT OBSERVED');
    expect(instructions).toContain('- sleepQuality: fair [NOT OBSERVED');
    expect(instructions).toContain('- activity: moderate [NOT OBSERVED');
  });

  it('instructs the model not to narrate a default as insight', () => {
    const instructions = build(NO_SIGNALS_OBSERVED);
    expect(instructions).toContain('SIGNAL PROVENANCE (non-negotiable)');
    expect(instructions).toMatch(/they are neutral placeholder values/);
    // Aimed squarely at the observed failure: an opening that characterizes
    // the listener's tiredness out of a hardcoded constant.
    expect(instructions).toMatch(/tiredness/);
    expect(instructions).toMatch(/Write as though those signals were simply absent/);
  });

  it('keeps calendar-derived busyness REAL when only health is missing (the Maya case)', () => {
    const instructions = build(CALENDAR_ONLY_SIGNALS_OBSERVED);
    // Health disclaimed...
    expect(instructions).toContain('- recovery: moderate [NOT OBSERVED');
    expect(instructions).toContain('- sleepQuality: fair [NOT OBSERVED');
    expect(instructions).toContain('- activity: moderate [NOT OBSERVED');
    // ...but busyness is not. A calendar-connected user has a genuine
    // busyness band, and suppressing it would trade one dishonesty for a
    // different failure: flattening a complete user into a generic one
    // (PRD §2, "a user who connects only a calendar is a complete user").
    expect(instructions).toContain('- busyness: moderate\n');
    expect(instructions).toContain('Only these signals are real observations you may reflect: busyness');
  });

  it('tells the model it knows nothing about the day when NO signal is observed', () => {
    const instructions = build(NO_SIGNALS_OBSERVED);
    expect(instructions).toContain('No signal here is a real observation');
    expect(instructions).not.toContain('Only these signals are real observations');
  });

  it('names exactly the unobserved signals, and only those', () => {
    const onlySleepMissing = build({
      recovery: true,
      sleepQuality: false,
      activity: true,
      busyness: true,
    });
    expect(onlySleepMissing).toContain('- recovery: moderate\n');
    expect(onlySleepMissing).toContain('- sleepQuality: fair [NOT OBSERVED');
    expect(onlySleepMissing).toContain('no data for them: sleepQuality.');
    expect(onlySleepMissing).toContain(
      'Only these signals are real observations you may reflect: recovery, activity, busyness',
    );
  });

  it('marks a defaulted band even when its value is not the neutral default value', () => {
    // Guards against anyone "simplifying" this by comparing bands to
    // NEUTRAL_DEFAULT_BANDS instead of tracking provenance: value equality is
    // not provenance, in either direction. A genuinely-measured `moderate`
    // recovery is a real observation, and this builder must be able to say so.
    const measuredNeutral = build(ALL_SIGNALS_OBSERVED, NEUTRAL_DEFAULTS);
    expect(measuredNeutral).toContain('- recovery: moderate\n');
    expect(measuredNeutral).not.toContain('NOT OBSERVED');
  });

  it('does not disclaim communicationLoad or distressSignal — both self-describe absence', () => {
    const instructions = build(NO_SIGNALS_OBSERVED);
    // `null` communicationLoad already renders "not connected", and
    // distressSignal `false` means "not flagged", never "unmeasured".
    expect(instructions).toContain('- communicationLoad: not connected\n');
    expect(instructions).toContain('- distressSignal: false');
    expect(instructions).not.toContain('- communicationLoad: not connected [NOT OBSERVED');
    expect(instructions).not.toContain('- distressSignal: false [NOT OBSERVED');
  });

  it('is still deterministic: provenance does not introduce ordering or randomness', () => {
    const provenance = { recovery: false, sleepQuality: true, activity: false, busyness: true };
    expect(build(provenance)).toBe(build(provenance));
  });

  it('EXAMEN no longer instructs the model to narrate recovery unconditionally', () => {
    // The examen's "honest review" movement used to read "using the
    // busyness/recovery signals below", which told the model to speak about
    // recovery whether or not recovery had ever been measured — an honest
    // review sourced from a hardcoded constant.
    const examen = buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: NEUTRAL_DEFAULTS,
      signalProvenance: CALENDAR_ONLY_SIGNALS_OBSERVED,
      slotType: 'examen',
    });
    expect(examen).not.toContain('using the busyness/recovery signals below');
    expect(examen).toContain('never on one marked NOT OBSERVED');
  });
});

/**
 * Content language (Epic O #311, story O3 #315) — the ONE non-English line.
 *
 * The design under test: `language` adds exactly one English instruction
 * telling the model to write all user-facing output fields in the target
 * language, while everything else — tradition framing, the §9 safety spec,
 * the distress clause — stays English (epic decision 3: the model follows
 * English instructions to write Spanish output, and keeping the instruction
 * side English is what keeps it reviewable by the docs/17 theological-QA
 * process). `'en'` (and an absent param) must emit NOTHING, so English
 * instructions stay byte-identical to before Epic O existed.
 */
describe('buildInstructions — content language (Epic O #311, O3 #315)', () => {
  function build(overrides: Partial<BuildInstructionsParams> = {}): string {
    return buildInstructions({
      tradition: 'general',
      translation: TRANSLATION,
      bands: bands({}),
      signalProvenance: ALL_SIGNALS_OBSERVED,
      ...overrides,
    });
  }

  it("language='en' is byte-identical to omitting language entirely (issue #315 acceptance: no regression line)", () => {
    expect(build({ language: 'en' })).toBe(build({}));
  });

  it('emits no language directive at all for English', () => {
    expect(build({ language: 'en' })).not.toContain('entirely in');
    expect(build({})).not.toContain('entirely in');
  });

  it('emits the exact Spanish directive for es — mutation check: removing or rewording the line fails this', () => {
    // Asserted as ONE exact string (not toMatch fragments) so a mutant that
    // drops the field list, the language name, or the Scripture-sourcing
    // tail cannot pass. This is the line recorded on the #315 PR.
    expect(build({ language: 'es' })).toContain(
      'Write every user-facing output field (devotionalBody, cardSummary, prayer, journalingPrompt, actionStep, theme) entirely in Spanish. Scripture text still comes only from get_bible_verse in the preferred translation above — never translate or paraphrase Scripture yourself.',
    );
  });

  it('emits the directive with the right English language name for every non-en language', () => {
    const expectedNames = { es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', zh: 'Simplified Chinese' } as const;
    for (const [language, name] of Object.entries(expectedNames)) {
      const instructions = build({ language: language as BuildInstructionsParams['language'] });
      expect(instructions).toContain(`entirely in ${name}.`);
      // The directive names exactly one language — no other name leaks in.
      for (const otherName of Object.values(expectedNames)) {
        if (otherName === name) continue;
        expect(instructions).not.toContain(`entirely in ${otherName}.`);
      }
    }
  });

  it('places the directive immediately after the translation line, where the "preferred translation above" back-reference points', () => {
    const instructions = build({ language: 'fr' });
    const translationIdx = instructions.indexOf(`Preferred Bible translation: ${TRANSLATION}.`);
    const directiveIdx = instructions.indexOf('entirely in French');
    expect(translationIdx).toBeGreaterThanOrEqual(0);
    expect(directiveIdx).toBeGreaterThan(translationIdx);
    // Directly adjacent (one section boundary between them), not somewhere
    // later where "above" could be ambiguous.
    const between = instructions.slice(translationIdx, directiveIdx);
    expect(between).not.toContain("Today's signals");
  });

  it('guardrails, tradition framing, and the safety spec STAY English for a non-English generation (epic #311 decision 3)', () => {
    const instructions = build({ language: 'es', tradition: 'catholic' });
    expect(instructions).toContain('Theological safety guardrails (non-negotiable):');
    expect(instructions).toContain('No medical diagnosis, treatment claims, or inference of health/spiritual condition.');
    expect(instructions).toContain('Never quote Scripture from memory.');
    expect(instructions).toContain('Tradition: catholic.');
  });

  it('distress + non-English: keeps the 988 sentence in English and asks for one same-language framing sentence', () => {
    // 988 is a US, primarily English-language service; machine-translating
    // the resource line would misrepresent what the caller reaches. The
    // decided handling (recorded on the #315 PR): English resource line
    // verbatim + one brief framing sentence in the user's language.
    const instructions = build({ language: 'es', bands: bands({ distressSignal: true }) });
    expect(instructions).toContain('you can call or text 988');
    expect(instructions).toContain('keep the 988 resource sentence itself in English exactly as phrased');
    expect(instructions).toContain('add one brief sentence in Spanish gently framing it');
  });

  it('distress + English: the 988 clause is byte-identical to today — no language note', () => {
    const withEn = build({ language: 'en', bands: bands({ distressSignal: true }) });
    const without = build({ bands: bands({ distressSignal: true }) });
    expect(withEn).toBe(without);
    expect(withEn).not.toContain('keep the 988 resource sentence itself in English');
  });

  it('is deterministic per language: identical inputs produce a byte-identical string', () => {
    expect(build({ language: 'zh' })).toBe(build({ language: 'zh' }));
  });

  it('matches snapshot for es (general tradition, default bands) — the reviewed Spanish-generation prompt', () => {
    expect(build({ language: 'es' })).toMatchSnapshot();
  });
});
