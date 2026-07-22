/**
 * DevotionalEngine tests (EPIC B, issue #19).
 *
 * Uses REAL GlooResponsesClient and YouVersionClient instances (not hand-
 * rolled fakes of the engine's dependencies) with injected `fetchImpl`
 * mocks — this exercises the actual tool-loop wiring end-to-end, just
 * against fake HTTP instead of the live network. Live-network coverage
 * against real Gloo + YouVersion credentials lives in
 * devotionalEngine.live.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { allFallbackKeys, parseFallbackKey, type BandInput } from '@kairos/shared-contracts';
import { GlooResponsesClient, type GlooResponse } from '../../src/services/gloo/glooResponsesClient.js';
import { YouVersionClient, type FetchLike as YvFetchLike } from '../../src/services/youversion/youVersionClient.js';
import type { FetchLike as GlooFetchLike } from '../../src/services/gloo/glooTokenManager.js';
import {
  DevotionalEngine,
  DevotionalEngineFixtureError,
  detectLikelyTruncation,
  findFetchedTextMismatches,
  loadFixtureDevotional,
  type DevotionalEngineLogger,
} from '../../src/services/devotionalEngine.js';

const FIXTURES_DIR = new URL('../../../../fixtures/snapshots', import.meta.url).pathname;

const LOW_POOR_HEAVY: BandInput = {
  recovery: 'low',
  sleepQuality: 'poor',
  activity: 'sedentary',
  busyness: 'heavy',
  communicationLoad: 'moderate',
  distressSignal: false,
};

function glooJsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Minimal MAT-11 (30 verses) index so YouVersionClient's local validation passes. */
function fakeIndex() {
  return {
    books: [
      {
        id: 'MAT',
        chapters: [{ id: '11', verses: Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1) })) }],
      },
    ],
  };
}

function fakeBibleDetail(id: number) {
  return { id, abbreviation: 'BSB', title: 'Berean Standard Bible', copyright: 'Public domain.' };
}

/**
 * Routes YouVersion calls: index -> fakeIndex, bible detail -> fakeBibleDetail,
 * passage -> given text. YouVersionClient parses `res.text()` (not `res.json()`)
 * internally, so every route must return a matching JSON string via `text()`.
 */
function youVersionFetch(passageText: string): YvFetchLike {
  function jsonRoute(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  return (vi.fn(async (url: string) => {
    const path = url.replace('https://api.youversion.com', '');
    if (path.includes('/index')) {
      return jsonRoute(fakeIndex());
    }
    if (/^\/v1\/bibles\/\d+$/.test(path)) {
      return jsonRoute(fakeBibleDetail(3034));
    }
    if (path.includes('/passages/')) {
      return jsonRoute({ id: 'MAT.11.28-30', content: passageText, reference: 'Matthew 11:28-30' });
    }
    throw new Error(`Unexpected YouVersion path in test: ${path}`);
  }) as unknown) as YvFetchLike;
}

const EXACT_TEXT =
  'Come to Me, all you who labor and are heavy-laden, and I will give you rest. Take My yoke upon you and learn from Me, for I am gentle and humble in heart, and you will find rest for your souls. For My yoke is easy and My burden is light.';

function validDevotionalJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 'micro',
    theme: 'rest',
    verses: [
      {
        usfm: 'MAT.11.28-30',
        versionId: 3034,
        reference: 'Matthew 11:28-30',
        fetchedText: EXACT_TEXT,
        attribution: 'Berean Standard Bible (BSB) — Public domain.',
      },
    ],
    devotionalBody: 'A short devotional body about rest for the weary.',
    cardSummary: 'Come to Me, weary one.',
    prayer: 'Jesus, give me rest today. Amen.',
    ...overrides,
  });
}

function functionCallTurn(callId: string): GlooResponse {
  return {
    id: 'resp_1',
    object: 'response',
    model: 'test-model',
    output: [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: callId,
        name: 'get_bible_verse',
        arguments: JSON.stringify({ usfm: 'MAT.11.28-MAT.11.30', versionId: 3034, reason: 'rest for the weary' }),
      },
    ],
  };
}

function messageTurn(text: string): GlooResponse {
  return {
    id: 'resp_2',
    object: 'response',
    model: 'test-model',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function buildEngine(
  glooFetch: GlooFetchLike,
  yvFetch: YvFetchLike = youVersionFetch(EXACT_TEXT),
  logger?: DevotionalEngineLogger,
) {
  const glooResponsesClient = new GlooResponsesClient({
    getAccessToken: async () => 'test-token',
    fetchImpl: glooFetch,
  });
  const youVersionClient = new YouVersionClient({ apiKey: 'test-key', fetchImpl: yvFetch });
  return new DevotionalEngine({ glooResponsesClient, youVersionClient, fixturesDir: FIXTURES_DIR, logger });
}

function spyLogger(): DevotionalEngineLogger & { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { error: vi.fn(), info: vi.fn() };
}

describe('DevotionalEngine.generate — happy path', () => {
  it('runs the tool loop against a real YouVersionClient executor and returns source=gloo on first valid response', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('gloo');
    expect(result.devotional.verses[0]?.fetchedText).toBe(EXACT_TEXT);
    expect(result.toolCallsExecuted).toBe(1);
    expect(glooFetch).toHaveBeenCalledTimes(2);
  });

  it('sends tool_choice=required, the get_bible_verse tool, and a response_format json_schema on the first request', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    await engine.generate({ bands: LOW_POOR_HEAVY, tradition: 'general', translation: 'BSB', preferredVersionId: 3034 });

    const [, init] = (glooFetch.mock.calls[0] as [string, { body: string }]);
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toBe('required');
    expect(body.tools[0].function.name).toBe('get_bible_verse');
    expect(body.response_format.type).toBe('json_schema');
    expect(typeof body.instructions).toBe('string');
    expect(body.instructions).toContain('Never quote Scripture from memory');
  });

  it('threads date + liturgicalSeasonsEnabled through to buildInstructions (docs/14 §5.7, issue #95)', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    // 2026-12-06 is the 2nd week of Advent 2026.
    await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
      date: '2026-12-06',
      liturgicalSeasonsEnabled: true,
    });

    const [, init] = glooFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.instructions).toContain('2nd week of Advent');
  });

  it('omits the liturgical-season line when date is provided but liturgicalSeasonsEnabled is false (general tradition)', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
      date: '2026-12-06',
    });

    const [, init] = glooFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.instructions).not.toMatch(/week of Advent/);
  });

  it('threads prayerIntention through to buildInstructions as deliberate disclosure (docs/14 §5.5, issue #93)', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
      prayerIntention: 'a hard week at work',
    });

    const [, init] = glooFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.instructions).toContain(
      'Yesterday, this user shared one thing they\'re carrying: "a hard week at work".',
    );
  });

  it('omits the prayer-intention line when prayerIntention is not provided', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    await engine.generate({ bands: LOW_POOR_HEAVY, tradition: 'general', translation: 'BSB', preferredVersionId: 3034 });

    const [, init] = glooFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.instructions).not.toMatch(/carrying/i);
  });
});

describe('DevotionalEngine.generate — fault injection: repair round-trip', () => {
  it('fires exactly one repair round-trip on invalid JSON, then succeeds', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      // Turn 2: model returns invalid JSON (malformed).
      .mockResolvedValueOnce(glooJsonRes(messageTurn('{not valid json')))
      // Repair turn: model returns valid JSON this time.
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('gloo_repaired');
    expect(glooFetch).toHaveBeenCalledTimes(3);

    // The repair request must include the corrective user message with the
    // invalid JSON + a problem summary (API spec §2.5).
    const [, repairInit] = glooFetch.mock.calls[2] as [string, { body: string }];
    const repairBody = JSON.parse(repairInit.body);
    const lastItem = repairBody.input[repairBody.input.length - 1];
    expect(lastItem.role).toBe('user');
    expect(lastItem.content).toContain('did not pass validation');
    expect(lastItem.content).toContain('not valid json');

    // Full history (function_call + function_call_output pair) must be replayed.
    const hasFunctionCall = repairBody.input.some((item: { type?: string }) => item.type === 'function_call');
    const hasFunctionCallOutput = repairBody.input.some((item: { type?: string }) => item.type === 'function_call_output');
    expect(hasFunctionCall).toBe(true);
    expect(hasFunctionCallOutput).toBe(true);

    // docs/14 §3.8 / issue #90: the repair request uses tool_choice='auto',
    // not 'required' — forcing another tool call here would fight the
    // "return ONLY corrected JSON" instruction.
    expect(repairBody.tool_choice).toBe('auto');
  });

  it('fires the repair round-trip on a schema violation (missing required field), then succeeds', async () => {
    const missingPrayer = JSON.parse(validDevotionalJson());
    delete missingPrayer.prayer;

    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(JSON.stringify(missingPrayer))))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('gloo_repaired');
    expect(glooFetch).toHaveBeenCalledTimes(3);
  });

  it('fires the repair round-trip when fetchedText is paraphrased instead of exact (anti-hallucination), then succeeds', async () => {
    const paraphrased = JSON.parse(validDevotionalJson());
    paraphrased.verses[0].fetchedText = 'Come unto me, all ye that labour, and I will give you rest.'; // NOT the exact tool text

    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(JSON.stringify(paraphrased))))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('gloo_repaired');
    const [, repairInit] = glooFetch.mock.calls[2] as [string, { body: string }];
    const repairBody = JSON.parse(repairInit.body);
    const lastItem = repairBody.input[repairBody.input.length - 1];
    expect(lastItem.content).toContain('Anti-hallucination check failed');
  });

  it('fires the repair round-trip when devotionalBody was truncated mid-sentence by max_output_tokens, then succeeds', async () => {
    // Live-verified 2026-07-02: a micro-format distress-checkin generation
    // truncated devotionalBody mid-clause while still producing syntactically
    // valid, schema-passing JSON (later fields absorbed the cut-off prose).
    const truncated = JSON.parse(validDevotionalJson());
    truncated.devotionalBody = 'Your body kept score last night, and today the calendar left no room for';

    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(JSON.stringify(truncated))))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('gloo_repaired');
    const [, repairInit] = glooFetch.mock.calls[2] as [string, { body: string }];
    const repairBody = JSON.parse(repairInit.body);
    const lastItem = repairBody.input[repairBody.input.length - 1];
    expect(lastItem.content).toContain('truncated');
  });
});

describe('DevotionalEngine.generate — fault injection: fixture fallback', () => {
  it('falls back to the band-keyed fixture after BOTH the initial attempt and the repair attempt fail', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn('{not valid json')))
      // Repair also comes back invalid.
      .mockResolvedValueOnce(glooJsonRes(messageTurn('{still not valid')));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('fixture');
    expect(glooFetch).toHaveBeenCalledTimes(3);
    // The fixture must itself be a fully valid, non-dead devotional.
    expect(result.devotional.verses.length).toBeGreaterThan(0);
    expect(result.devotional.devotionalBody.length).toBeGreaterThan(0);
    expect(result.devotional.format).toBe('micro');
  });

  it('falls back to the fixture immediately when the first Gloo call throws (e.g. tool-call cap / transport error)', async () => {
    const glooFetch = vi.fn().mockRejectedValue(new Error('network down'));
    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);

    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('fixture');
    expect(result.devotional.format).toBe('micro');
  });

  it('logs the real error when the first attempt throws, instead of swallowing it silently (docs/14 §3.7, issue #73)', async () => {
    const logger = spyLogger();
    const glooFetch = vi.fn().mockRejectedValue(new Error('network down'));
    const engine = buildEngine(glooFetch as unknown as GlooFetchLike, undefined, logger);

    await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.error.mock.calls[0];
    expect(message).toMatch(/first gloo attempt threw/i);
    // GlooResponsesClient wraps the raw transport error with its own context
    // ("Gloo responses request failed: ...") — assert the real cause is
    // still present in what we log, not an exact string match on its wrapping.
    expect(meta?.error).toMatch(/network down/);
    expect(meta?.fallbackKey).toBe('low_poor_heavy');
  });

  it('logs the repair failure reason when both attempts fail validation, instead of swallowing it silently', async () => {
    const logger = spyLogger();
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn('{not valid json')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn('{still not valid')));
    const engine = buildEngine(glooFetch as unknown as GlooFetchLike, undefined, logger);

    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('fixture');
    // One info log for "attempting repair" + one error log for "repair also failed".
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/attempting one repair/i), expect.anything());
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/repair round-trip still failed validation/i),
      expect.objectContaining({ fallbackKey: 'low_poor_heavy' }),
    );
  });

  it('logs a success summary (source, toolCalls, usage) on a clean first-attempt generation — not just on failure', async () => {
    const logger = spyLogger();
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));
    const engine = buildEngine(glooFetch as unknown as GlooFetchLike, undefined, logger);

    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('gloo');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/devotional generated/i),
      expect.objectContaining({ source: 'gloo', toolCallsExecuted: 1 }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs gloo_input_tokens/gloo_output_tokens (docs/14 §3.7 cost-story field names) from the final turn\'s usage', async () => {
    const logger = spyLogger();
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));
    const engine = buildEngine(glooFetch as unknown as GlooFetchLike, undefined, logger);

    await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/devotional generated/i),
      expect.objectContaining({
        gloo_input_tokens: 1,
        gloo_output_tokens: 1,
        gloo_total_tokens: 2,
      }),
    );
  });

  it('the fixture-fallback devotional never has a "dead" verse — fetchedText and attribution are always populated', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn('nope')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn('still nope')));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('fixture');
    for (const verse of result.devotional.verses) {
      expect(verse.fetchedText.length).toBeGreaterThan(0);
      expect(verse.attribution.length).toBeGreaterThan(0);
    }
    // cardSummary / prayer must be present too (join link renders a real page, never blank).
    expect(result.devotional.cardSummary.length).toBeGreaterThan(0);
    expect(result.devotional.prayer.length).toBeGreaterThan(0);
  });

  it('falls back correctly for a distress checkin (special-cased fixture key)', async () => {
    const glooFetch = vi.fn().mockRejectedValue(new Error('down'));
    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);

    const result = await engine.generate({
      bands: { ...LOW_POOR_HEAVY, distressSignal: true },
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('fixture');
    expect(result.devotional.format).toBe('micro');
    expect(result.devotional.theme).toBe('comfort');
  });
});

describe('DevotionalEngine.generate — forceFixture kill switch (PROVIDERS=fixture, issue #91)', () => {
  it('returns the band-keyed fixture and never calls Gloo or YouVersion at all', async () => {
    const glooFetch = vi.fn(() => {
      throw new Error('forceFixture must never call Gloo');
    });
    const yvFetch: YvFetchLike = (vi.fn(() => {
      throw new Error('forceFixture must never call YouVersion');
    }) as unknown) as YvFetchLike;

    const glooResponsesClient = new GlooResponsesClient({
      getAccessToken: async () => 'test-token',
      fetchImpl: glooFetch as unknown as GlooFetchLike,
    });
    const youVersionClient = new YouVersionClient({ apiKey: 'test-key', fetchImpl: yvFetch });
    const engine = new DevotionalEngine({
      glooResponsesClient,
      youVersionClient,
      fixturesDir: FIXTURES_DIR,
      forceFixture: true,
    });

    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('fixture');
    expect(result.devotional.format).toBe('micro');
    expect(glooFetch).not.toHaveBeenCalled();
    expect(yvFetch).not.toHaveBeenCalled();
  });

  it('logs that the kill switch is active', async () => {
    const logger = spyLogger();
    const glooResponsesClient = new GlooResponsesClient({
      getAccessToken: async () => 'test-token',
      fetchImpl: (() => {
        throw new Error('forceFixture must never call Gloo');
      }) as unknown as GlooFetchLike,
    });
    const youVersionClient = new YouVersionClient({
      apiKey: 'test-key',
      fetchImpl: (() => {
        throw new Error('forceFixture must never call YouVersion');
      }) as unknown as YvFetchLike,
    });
    const engine = new DevotionalEngine({
      glooResponsesClient,
      youVersionClient,
      fixturesDir: FIXTURES_DIR,
      forceFixture: true,
      logger,
    });

    await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/kill switch active/i),
      expect.objectContaining({ fallbackKey: 'low_poor_heavy' }),
    );
  });
});

describe('loadFixtureDevotional', () => {
  it('loads and validates the low_poor_heavy fixture', () => {
    const devotional = loadFixtureDevotional(FIXTURES_DIR, LOW_POOR_HEAVY);
    expect(devotional.format).toBe('micro');
    expect(devotional.theme).toBe('rest');
  });

  it('falls back to the nearest available fixture for a band combination with no dedicated fixture file (issue #78)', () => {
    // moderate/good/light has no fixture file of its own; nearest by
    // Manhattan distance across the three axes is high_good_light
    // (distance 1: only recovery differs, moderate->high) rather than
    // moderate_fair_moderate (distance 2) or any other candidate.
    const devotional = loadFixtureDevotional(FIXTURES_DIR, {
      recovery: 'moderate',
      sleepQuality: 'good',
      activity: 'active',
      busyness: 'light',
      communicationLoad: null,
      distressSignal: false,
    });
    expect(devotional.format).toBe('extended');
  });

  it('issue #78 regression: a devotional loads for every one of the 27 band-key combinations, plus distress', () => {
    // Before this fix, `loadFixtureDevotional` threw DevotionalEngineFixtureError
    // for any of the 22/27 band combos without a dedicated fixture file — a
    // Gloo outage on one of those combos meant a dead join link, not a
    // devotional. This is the full-coverage guarantee the issue asked for.
    for (const key of allFallbackKeys()) {
      const { recovery, sleepQuality, busyness } = parseFallbackKey(key);
      const bands: BandInput = {
        recovery,
        sleepQuality,
        activity: 'moderate',
        busyness,
        communicationLoad: null,
        distressSignal: false,
      };
      expect(
        () => loadFixtureDevotional(FIXTURES_DIR, bands),
        `expected a devotional to load for band key "${key}"`,
      ).not.toThrow();
    }

    expect(() =>
      loadFixtureDevotional(FIXTURES_DIR, { ...LOW_POOR_HEAVY, distressSignal: true }),
    ).not.toThrow();
  });

  it('still throws DevotionalEngineFixtureError when the fixtures directory has no usable files (deployment/config error)', () => {
    expect(() => loadFixtureDevotional('/nonexistent/fixtures/dir', LOW_POOR_HEAVY)).toThrow(
      DevotionalEngineFixtureError,
    );
  });
});

describe('findFetchedTextMismatches', () => {
  it('returns no mismatches when fetchedText exactly matches the tool result', () => {
    const fetchedTexts = new Map([['JHN.3.16::3034', { text: 'For God so loved the world...', reference: 'John 3:16' }]]);
    const devotional = JSON.parse(
      validDevotionalJson({
        verses: [
          {
            usfm: 'JHN.3.16',
            versionId: 3034,
            reference: 'John 3:16',
            fetchedText: 'For God so loved the world...',
            attribution: 'BSB',
          },
        ],
      }),
    );
    expect(findFetchedTextMismatches(devotional, fetchedTexts)).toEqual([]);
  });

  it('flags a paraphrased verse', () => {
    const fetchedTexts = new Map([['JHN.3.16::3034', { text: 'For God so loved the world...', reference: 'John 3:16' }]]);
    const devotional = JSON.parse(
      validDevotionalJson({
        verses: [
          {
            usfm: 'JHN.3.16',
            versionId: 3034,
            reference: 'John 3:16',
            fetchedText: 'For God loved the world so much...',
            attribution: 'BSB',
          },
        ],
      }),
    );
    const mismatches = findFetchedTextMismatches(devotional, fetchedTexts);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('paraphrase');
  });

  it('flags a reference that does not match what get_bible_verse returned (hallucination)', () => {
    const fetchedTexts = new Map([['JHN.3.16::3034', { text: 'For God so loved the world...', reference: 'John 3:16' }]]);
    const devotional = JSON.parse(
      validDevotionalJson({
        verses: [
          {
            usfm: 'JHN.3.16',
            versionId: 3034,
            reference: 'John 3:17',
            fetchedText: 'For God so loved the world...',
            attribution: 'BSB',
          },
        ],
      }),
    );
    const mismatches = findFetchedTextMismatches(devotional, fetchedTexts);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('reference');
  });

  it('flags a verse that was never actually fetched', () => {
    const fetchedTexts = new Map<string, { text: string; reference: string }>();
    const devotional = JSON.parse(
      validDevotionalJson({
        verses: [
          {
            usfm: 'PSA.23.1',
            versionId: 3034,
            reference: 'Psalm 23:1',
            fetchedText: 'The Lord is my shepherd.',
            attribution: 'BSB',
          },
        ],
      }),
    );
    const mismatches = findFetchedTextMismatches(devotional, fetchedTexts);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('never successfully called');
  });

  it('does NOT flag a trailing orphaned smart-quote dropped by the model (live-verified YouVersion content noise)', () => {
    // Live-verified 2026-07-02: GET /v1/bibles/3034/passages/MAT.11.28-30
    // genuinely returns content ending in an unmatched U+201D after the
    // final period. Gloo reliably omits it when reproducing the text.
    const toolText = 'For My yoke is easy and My burden is light.”';
    const modelText = 'For My yoke is easy and My burden is light.';
    const fetchedTexts = new Map([['MAT.11.28-30::3034', { text: toolText, reference: 'Matthew 11:28-30' }]]);
    const devotional = JSON.parse(
      validDevotionalJson({
        verses: [
          {
            usfm: 'MAT.11.28-30',
            versionId: 3034,
            reference: 'Matthew 11:28-30',
            fetchedText: modelText,
            attribution: 'BSB',
          },
        ],
      }),
    );
    expect(findFetchedTextMismatches(devotional, fetchedTexts)).toEqual([]);
  });

  it('still flags a genuine mid-passage paraphrase even when trailing punctuation also differs', () => {
    const toolText = 'For My yoke is easy and My burden is light.”';
    const modelText = 'My yoke is light and easy to bear.'; // real paraphrase, not just quote noise
    const fetchedTexts = new Map([['MAT.11.28-30::3034', { text: toolText, reference: 'Matthew 11:28-30' }]]);
    const devotional = JSON.parse(
      validDevotionalJson({
        verses: [
          {
            usfm: 'MAT.11.28-30',
            versionId: 3034,
            reference: 'Matthew 11:28-30',
            fetchedText: modelText,
            attribution: 'BSB',
          },
        ],
      }),
    );
    const mismatches = findFetchedTextMismatches(devotional, fetchedTexts);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('paraphrase');
  });
});

describe('detectLikelyTruncation', () => {
  it('returns undefined for a devotionalBody/prayer that both end with terminal punctuation', () => {
    const devotional = JSON.parse(validDevotionalJson());
    expect(detectLikelyTruncation(devotional)).toBeUndefined();
  });

  it('flags a devotionalBody cut off mid-sentence (no terminal punctuation, meaningful length)', () => {
    const devotional = JSON.parse(
      validDevotionalJson({
        devotionalBody: 'Your body kept score last night, and today the calendar left no room for',
      }),
    );
    const problem = detectLikelyTruncation(devotional);
    expect(problem).toBeDefined();
    expect(problem).toContain('devotionalBody');
    expect(problem).toContain('truncated');
  });

  it('flags a prayer cut off mid-sentence', () => {
    const devotional = JSON.parse(
      validDevotionalJson({ prayer: 'Jesus, I am running on empty and I need You to' }),
    );
    const problem = detectLikelyTruncation(devotional);
    expect(problem).toBeDefined();
    expect(problem).toContain('prayer');
  });

  it('does not flag a short field even without terminal punctuation (avoids false positives)', () => {
    const devotional = JSON.parse(validDevotionalJson({ prayer: 'Amen' }));
    expect(detectLikelyTruncation(devotional)).toBeUndefined();
  });

  it('accepts fields ending in a closing quote after punctuation', () => {
    const devotional = JSON.parse(
      validDevotionalJson({
        devotionalBody:
          'Jesus said, "Come to me, all who are weary and burdened, and I will give you rest, for my yoke is easy."',
      }),
    );
    expect(detectLikelyTruncation(devotional)).toBeUndefined();
  });
});
