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
  applyAuthoritativeFetchedText,
  clampCardSummary,
  detectLikelyTruncation,
  findFetchedTextMismatches,
  licenseFallbackCandidates,
  loadFixtureDevotional,
  type DevotionalEngineLogger,
} from '../../src/services/devotionalEngine.js';
import { CARD_SUMMARY_HARD_LIMIT, LANGUAGE_CATALOG } from '@kairos/shared-contracts';

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

describe('DevotionalEngine.generate — fetchedText is authoritative from the tool result (issue #295)', () => {
  it('overrides a paraphrased fetchedText with the exact tool text and succeeds on the FIRST attempt (no repair)', async () => {
    const paraphrased = JSON.parse(validDevotionalJson());
    paraphrased.verses[0].fetchedText = 'Come unto me, all ye that labour, and I will give you rest.'; // NOT the exact tool text

    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(JSON.stringify(paraphrased))));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    // No repair round-trip needed: the engine substitutes the real YouVersion
    // text by construction, so validation passes on attempt one.
    expect(result.source).toBe('gloo');
    expect(glooFetch).toHaveBeenCalledTimes(2);
    expect(result.devotional.verses[0]?.fetchedText).toBe(EXACT_TEXT);
  });

  it('overrides an EMPTY fetchedText with the exact tool text and succeeds on the FIRST attempt (no repair, no Zod failure)', async () => {
    const emptyText = JSON.parse(validDevotionalJson());
    emptyText.verses[0].fetchedText = ''; // the observed "fetchedText must not be empty" failure mode

    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(JSON.stringify(emptyText))));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('gloo');
    expect(glooFetch).toHaveBeenCalledTimes(2);
    expect(result.devotional.verses[0]?.fetchedText).toBe(EXACT_TEXT);
  });

  it('overrides a wrong reference with the exact tool reference while keeping the correct text', async () => {
    const wrongRef = JSON.parse(validDevotionalJson());
    wrongRef.verses[0].reference = 'Matthew 11:1'; // NOT the reference the tool returned

    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(JSON.stringify(wrongRef))));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
    });

    expect(result.source).toBe('gloo');
    expect(glooFetch).toHaveBeenCalledTimes(2);
    expect(result.devotional.verses[0]?.reference).toBe('Matthew 11:28-30');
    expect(result.devotional.verses[0]?.fetchedText).toBe(EXACT_TEXT);
  });
});

describe('applyAuthoritativeFetchedText (issue #295)', () => {
  it('replaces an empty fetchedText with the exact tool text for a matching usfm/versionId', () => {
    const fetchedTexts = new Map([['JHN.3.16::3034', { text: 'For God so loved the world...', reference: 'John 3:16' }]]);
    const parsed = {
      verses: [{ usfm: 'JHN.3.16', versionId: 3034, reference: 'wrong', fetchedText: '', attribution: 'x' }],
    };
    applyAuthoritativeFetchedText(parsed, fetchedTexts);
    expect(parsed.verses[0].fetchedText).toBe('For God so loved the world...');
    expect(parsed.verses[0].reference).toBe('John 3:16');
  });

  it('replaces a paraphrased fetchedText with the exact tool text', () => {
    const fetchedTexts = new Map([['JHN.3.16::3034', { text: 'For God so loved the world...', reference: 'John 3:16' }]]);
    const parsed = {
      verses: [{ usfm: 'JHN.3.16', versionId: 3034, reference: 'John 3:16', fetchedText: 'God loved everyone a lot', attribution: 'x' }],
    };
    applyAuthoritativeFetchedText(parsed, fetchedTexts);
    expect(parsed.verses[0].fetchedText).toBe('For God so loved the world...');
  });

  it('leaves a verse untouched when its usfm/versionId was never fetched (so the anti-hallucination check can still catch it)', () => {
    const fetchedTexts = new Map<string, { text: string; reference: string }>();
    const parsed = {
      verses: [{ usfm: 'PSA.23.1', versionId: 3034, reference: 'Psalm 23:1', fetchedText: 'made up', attribution: 'x' }],
    };
    applyAuthoritativeFetchedText(parsed, fetchedTexts);
    expect(parsed.verses[0].fetchedText).toBe('made up');
    // And it is still flagged downstream.
    const mismatches = findFetchedTextMismatches(
      { verses: parsed.verses } as unknown as Parameters<typeof findFetchedTextMismatches>[0],
      fetchedTexts,
    );
    expect(mismatches.length).toBeGreaterThan(0);
  });

  it('is a safe no-op on malformed input (non-object, missing verses, non-array verses)', () => {
    const fetchedTexts = new Map<string, { text: string; reference: string }>();
    expect(() => applyAuthoritativeFetchedText(null, fetchedTexts)).not.toThrow();
    expect(() => applyAuthoritativeFetchedText('not json', fetchedTexts)).not.toThrow();
    expect(() => applyAuthoritativeFetchedText({}, fetchedTexts)).not.toThrow();
    expect(() => applyAuthoritativeFetchedText({ verses: 'nope' }, fetchedTexts)).not.toThrow();
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

  it('accepts a devotionalBody ending in a colon that tees up the spoken Scripture (issue #295)', () => {
    // Live-observed 2026-07-23: the model intentionally ends the body by
    // introducing the verse read aloud next ("...and it sounds like this:").
    // That is a complete lead-in, not a mid-sentence cutoff, and must not be
    // flagged as truncation.
    const devotional = JSON.parse(
      validDevotionalJson({
        devotionalBody:
          'This word comes from the forty-sixth Psalm, and it sounds like this:',
      }),
    );
    expect(detectLikelyTruncation(devotional)).toBeUndefined();
  });
});

describe('clampCardSummary (issue #295)', () => {
  it('leaves a within-limit cardSummary untouched (aside from trimming whitespace)', () => {
    const obj = { cardSummary: '  Come to Me, weary one.  ' };
    clampCardSummary(obj);
    expect(obj.cardSummary).toBe('Come to Me, weary one.');
  });

  it('trims an over-long cardSummary to the hard limit at a word boundary with an ellipsis', () => {
    // Distinct words so a mid-word split would be detectable as a fragment.
    const words = Array.from({ length: 80 }, (_, i) => `alpha${i}`);
    const long = words.join(' '); // ~600 chars, well over 300
    const obj = { cardSummary: long };
    clampCardSummary(obj);
    expect(obj.cardSummary.length).toBeLessThanOrEqual(CARD_SUMMARY_HARD_LIMIT);
    expect(obj.cardSummary.endsWith('…')).toBe(true);
    // Every token before the ellipsis is a whole original word — nothing was
    // split mid-word.
    const kept = obj.cardSummary.slice(0, -1).trim().split(' ');
    expect(kept.every((w) => words.includes(w))).toBe(true);
  });

  it('produces a cardSummary that then passes detectLikelyTruncation (ends in …)', () => {
    const obj = JSON.parse(validDevotionalJson());
    obj.cardSummary = 'x'.repeat(400);
    clampCardSummary(obj);
    expect(obj.cardSummary.length).toBeLessThanOrEqual(CARD_SUMMARY_HARD_LIMIT);
    expect(detectLikelyTruncation(obj)).toBeUndefined();
  });

  it('is a safe no-op on a non-string / missing cardSummary', () => {
    const a: { cardSummary?: unknown } = {};
    clampCardSummary(a);
    expect(a.cardSummary).toBeUndefined();
    const b = { cardSummary: 42 };
    clampCardSummary(b);
    expect(b.cardSummary).toBe(42);
  });
});

// --- Content language (Epic O #311, story O3 #315) ---------------------------

/**
 * Routes YouVersion calls PER VERSION ID — unlike `youVersionFetch` above,
 * which answers every version identically. Needed to exercise the
 * LICENSE_UNAVAILABLE fallback chain: version A must 403 while version B
 * serves text, within one generation. A 403 on the passages endpoint plus a
 * 200 on the bible-detail endpoint is exactly the live-verified signature
 * YouVersionClient disambiguates into LICENSE_UNAVAILABLE (see its header).
 */
function multiVersionYouVersionFetch(
  passageByVersion: Record<number, { status: number; text?: string }>,
): YvFetchLike {
  function jsonRoute(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  }
  return (vi.fn(async (url: string) => {
    const path = url.replace('https://api.youversion.com', '');
    if (/^\/v1\/bibles\/\d+\/index$/.test(path)) {
      return jsonRoute(fakeIndex());
    }
    const passageMatch = path.match(/^\/v1\/bibles\/(\d+)\/passages\//);
    if (passageMatch) {
      const versionId = Number(passageMatch[1]);
      const route = passageByVersion[versionId];
      if (!route) {
        // An unrouted version id means the code under test fetched a version
        // this test never authorized — most importantly, one from ANOTHER
        // language. Surfaced as a transport error (the client maps it to
        // UPSTREAM_UNAVAILABLE); the URL assertions below catch it hard.
        throw new Error(`Unexpected passage fetch for versionId ${versionId} in test: ${path}`);
      }
      if (route.status === 200) {
        return jsonRoute({ id: 'MAT.11.28-30', content: route.text, reference: 'Matthew 11:28-30' });
      }
      return jsonRoute({ message: 'forbidden' }, route.status);
    }
    const detailMatch = path.match(/^\/v1\/bibles\/(\d+)$/);
    if (detailMatch) {
      // Always 200: the id is real, just (per the passage route) unlicensed —
      // the LICENSE_UNAVAILABLE half of the 403 disambiguation, never
      // BIBLE_NOT_FOUND.
      return jsonRoute(fakeBibleDetail(Number(detailMatch[1])));
    }
    throw new Error(`Unexpected YouVersion path in test: ${path}`);
  }) as unknown) as YvFetchLike;
}

/** All passage-fetch versionIds hit during the test, in call order. */
function passageVersionIds(yvFetch: YvFetchLike): number[] {
  return (yvFetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map(([url]) => (url as string).match(/\/v1\/bibles\/(\d+)\/passages\//)?.[1])
    .filter((id): id is string => id !== undefined)
    .map(Number);
}

describe('licenseFallbackCandidates — per-language LICENSE_UNAVAILABLE chain (O3 #315)', () => {
  it('generalizes the documented en chain: BSB 3034 failing yields WEBUS 206 then ASV 12, in order', () => {
    expect(licenseFallbackCandidates('en', 3034, new Set([3034]))).toEqual([206, 12]);
  });

  it("tries the language DEFAULT first when the user's stored alternate fails (es 147 → 3365)", () => {
    // The chain is not only "default's fallbacks": a user may have stored an
    // in-catalog alternate, and the strongest in-language substitute for it
    // is the language default.
    expect(licenseFallbackCandidates('es', 147, new Set([147]))).toEqual([3365]);
  });

  it('es default failing yields the pinned RVES fallback', () => {
    expect(licenseFallbackCandidates('es', 3365, new Set([3365]))).toEqual([147]);
  });

  it('pt has an EMPTY chain by catalog construction — straight to the fixture error path, never another language', () => {
    expect(licenseFallbackCandidates('pt', 3254, new Set([3254]))).toEqual([]);
  });

  it('skips versionIds already proven unlicensed earlier in the generation', () => {
    expect(licenseFallbackCandidates('en', 3034, new Set([3034, 206]))).toEqual([12]);
  });

  it('never proposes a versionId outside the language own catalog, for any language (DEC-K12)', () => {
    for (const tag of Object.keys(LANGUAGE_CATALOG) as Array<keyof typeof LANGUAGE_CATALOG>) {
      const entry = LANGUAGE_CATALOG[tag];
      for (const failed of entry.versionIds) {
        const candidates = licenseFallbackCandidates(tag, failed, new Set([failed]));
        for (const candidate of candidates) {
          expect(entry.versionIds).toContain(candidate);
        }
      }
    }
  });
});

describe('DevotionalEngine — content language (O3 #315)', () => {
  const SPANISH_TEXT =
    'Venid a mí todos los que estáis cansados y agobiados, y yo os haré descansar. ¿No es Él fiel?';

  function spanishDevotionalJson(versionId: number) {
    return validDevotionalJson({
      verses: [
        {
          usfm: 'MAT.11.28-30',
          versionId,
          reference: 'Matthew 11:28-30',
          fetchedText: SPANISH_TEXT,
          attribution: 'Berean Standard Bible (BSB) — Public domain.',
        },
      ],
      devotionalBody: 'Una breve reflexión sobre el descanso que Dios ofrece a los cansados.',
      cardSummary: 'Ven a mí y descansa en Él hoy.',
      prayer: 'Señor, dame descanso hoy. Amén.',
    });
  }

  it("threads language to buildInstructions: language='es' puts the Spanish directive in the Gloo request", async () => {
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
      language: 'es',
    });

    const [, init] = glooFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.instructions).toContain('entirely in Spanish');
  });

  it('omitted language defaults to en: no language directive at all (pre-Epic-O behavior preserved)', async () => {
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(validDevotionalJson())));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike);
    await engine.generate({ bands: LOW_POOR_HEAVY, tradition: 'general', translation: 'BSB', preferredVersionId: 3034 });

    const [, init] = glooFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.instructions).not.toContain('entirely in');
  });

  it('walks the SAME-LANGUAGE fallback chain on LICENSE_UNAVAILABLE and serves the substitute to the model', async () => {
    // es: model asks for the default 3365, which 403s (real id, unlicensed);
    // the executor must retry 147 (the pinned es fallback) and hand the model
    // 147's text — with the substitution surfaced in the envelope meta so the
    // model cites the SERVED id in verses[].
    const yvFetch = multiVersionYouVersionFetch({
      3365: { status: 403 },
      147: { status: 200, text: SPANISH_TEXT },
    });
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(
        glooJsonRes({
          ...functionCallTurn('call_1'),
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'get_bible_verse',
              arguments: JSON.stringify({ usfm: 'MAT.11.28-MAT.11.30', versionId: 3365 }),
            },
          ],
        }),
      )
      .mockResolvedValueOnce(glooJsonRes(messageTurn(spanishDevotionalJson(147))));

    const logger = spyLogger();
    const engine = buildEngine(glooFetch as unknown as GlooFetchLike, yvFetch, logger);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'Palabra de Dios para ti',
      preferredVersionId: 3365,
      language: 'es',
    });

    // The generation SUCCEEDED on the fallback version — no fixture.
    expect(result.source).toBe('gloo');
    expect(result.devotional.verses[0]?.versionId).toBe(147);
    expect(result.devotional.verses[0]?.fetchedText).toBe(SPANISH_TEXT);

    // Chain order: the requested es version, then the es fallback — nothing else.
    expect(passageVersionIds(yvFetch)).toEqual([3365, 147]);

    // The substitution is legible to the model: the function_call_output sent
    // back on the second Gloo turn carries the version_fallback meta.
    const [, secondInit] = glooFetch.mock.calls[1] as [string, { body: string }];
    const secondBody = JSON.parse(secondInit.body);
    const outputItem = (secondBody.input as Array<{ type: string; output?: string }>).find(
      (item) => item.type === 'function_call_output',
    );
    expect(outputItem?.output).toContain('"version_fallback"');
    expect(outputItem?.output).toContain('"served_version_id":147');

    // And legible to ops (#193): the substitution is logged, not silent.
    expect(logger.info).toHaveBeenCalledWith(
      'LICENSE_UNAVAILABLE — substituted a same-language fallback version',
      expect.objectContaining({ language: 'es', requestedVersionId: 3365, servedVersionId: 147 }),
    );
  });

  it('an EXHAUSTED chain degrades to the English fixture — never a cross-language verse (DEC-K12)', async () => {
    // pt: BLT 3254 is the only licensed pt option, so its chain is empty by
    // catalog construction. When it 403s there is nothing in-language to try;
    // the model gets the failure envelope, cannot cite a fetched verse, and
    // the generation lands on the (English, isFixtureFallback-flagged)
    // fixture. What must NOT happen: a fetch for any en/es/... versionId.
    const yvFetch = multiVersionYouVersionFetch({ 3254: { status: 403 } });
    const failedJson = validDevotionalJson({
      verses: [
        {
          usfm: 'MAT.11.28-30',
          versionId: 3254,
          reference: 'Matthew 11:28-30',
          fetchedText: 'texto inventado', // never fetched — anti-hallucination rejects it
          attribution: 'BLT',
        },
      ],
    });
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(
        glooJsonRes({
          ...functionCallTurn('call_1'),
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'get_bible_verse',
              arguments: JSON.stringify({ usfm: 'MAT.11.28-MAT.11.30', versionId: 3254 }),
            },
          ],
        }),
      )
      .mockResolvedValueOnce(glooJsonRes(messageTurn(failedJson)))
      // Repair round-trip returns the same fabrication → second failure → fixture.
      .mockResolvedValueOnce(glooJsonRes(messageTurn(failedJson)));

    const logger = spyLogger();
    const engine = buildEngine(glooFetch as unknown as GlooFetchLike, yvFetch, logger);
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'Bíblia Livre Para Todos',
      preferredVersionId: 3254,
      language: 'pt',
    });

    expect(result.source).toBe('fixture');
    // ONLY the pt version was ever fetched — the chain never crossed languages.
    expect(passageVersionIds(yvFetch)).toEqual([3254]);
    expect(logger.error).toHaveBeenCalledWith(
      'LICENSE_UNAVAILABLE — fallback chain exhausted for language, no cross-language retry (DEC-K12)',
      expect.objectContaining({ language: 'pt', requestedVersionId: 3254 }),
    );
  });

  it('the byte-identical anti-hallucination check holds on accented, non-ASCII fetched text (issue #315 acceptance)', async () => {
    // The versionId-enforcement mechanism is unchanged; this verifies no
    // ASCII/normalization assumption breaks when the fetched text carries
    // accents and inverted punctuation (á/í/¿…?) — the strip-noise regex and
    // exact comparison must treat them as ordinary characters.
    const glooFetch = vi
      .fn()
      .mockResolvedValueOnce(glooJsonRes(functionCallTurn('call_1')))
      .mockResolvedValueOnce(glooJsonRes(messageTurn(spanishDevotionalJson(3034))));

    const engine = buildEngine(glooFetch as unknown as GlooFetchLike, youVersionFetch(SPANISH_TEXT));
    const result = await engine.generate({
      bands: LOW_POOR_HEAVY,
      tradition: 'general',
      translation: 'BSB',
      preferredVersionId: 3034,
      language: 'es',
    });

    expect(result.source).toBe('gloo');
    expect(result.devotional.verses[0]?.fetchedText).toBe(SPANISH_TEXT);
  });
});
