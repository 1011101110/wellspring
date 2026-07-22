/**
 * DevotionalEngine — wires B1-B4 together (EPIC B, issue #19).
 *
 * Given bands + preferences:
 *   1. Builds `instructions` via `buildInstructions` (B4, instructionsBuilder.ts).
 *   2. Runs the Gloo Responses tool-calling loop (B1/B2, GlooResponsesClient)
 *      with `get_bible_verse` wired to a REAL YouVersionClient executor (B3).
 *   3. Parses the final `output_text` as JSON and Zod-validates it against
 *      `DevotionalOutputSchema` (packages/shared-contracts) — including the
 *      anti-hallucination check that every `verses[].fetchedText` is
 *      byte-identical to what YouVersionClient actually returned for that
 *      usfm/versionId (docs/04_DATA_PRIVACY_SECURITY.md §5.4).
 *   4. On validation failure: exactly ONE repair round-trip — re-send the
 *      full conversation plus a corrective user item with the Zod error
 *      summary and the invalid JSON, asking for corrected JSON only
 *      (docs/03_API_INTEGRATION_SPEC.md §2.5).
 *   5. On a second failure: fall back to the band-keyed fixture from
 *      fixtures/snapshots/ (docs/02_ARCHITECTURE.md §2.4/§4, Foundation §5).
 *      The join link must never be dead, so this path always returns a
 *      valid DevotionalOutput.
 *
 * Contract: docs/00_FOUNDATION.md §4, §5, §6; docs/02_ARCHITECTURE.md §2.1/§4;
 * docs/03_API_INTEGRATION_SPEC.md §2.5; docs/04_DATA_PRIVACY_SECURITY.md §5.4.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DevotionalOutputSchema,
  GetBibleVerseArgsSchema,
  GET_BIBLE_VERSE_TOOL_NAME,
  fallbackKey,
  nearestFallbackKey,
  parseFallbackKey,
  type BandInput,
  type DevotionalOutput,
  type SlotType,
  type Tradition,
} from '@kairos/shared-contracts';
import {
  GlooResponsesClient,
  type CreateResponseRequest,
  type GlooResponse,
  type ToolFunctionDef,
} from './gloo/glooResponsesClient.js';
import {
  NO_SIGNALS_OBSERVED,
  buildInstructions,
  resolveTargetFormat,
  type DurationPreference,
  type SignalProvenance,
} from './gloo/instructionsBuilder.js';
import { YouVersionClient } from './youversion/youVersionClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** fixtures/snapshots lives at the repo root: apps/api/src/services -> ../../../../fixtures/snapshots */
const FIXTURES_DIR = path.resolve(__dirname, '../../../../fixtures/snapshots');

const DEFAULT_MODEL = 'gloo-anthropic-claude-sonnet-4.6';

/**
 * Word-count-driven token budget per format — API spec §2.1 (starting
 * point: "400 (micro/short) -> 1800 (extended)"). Raised well above the
 * devotionalBody word target alone because the FULL structured
 * DevotionalOutput JSON also has to fit in the same budget: theme,
 * verses[] (usfm/versionId/fetchedText/attribution, and fetchedText can
 * itself be a multi-sentence passage), cardSummary, prayer,
 * journalingPrompt/actionStep, plus JSON syntax/field-name token overhead.
 * Live-verified 2026-07-02: the original spec numbers truncated
 * `devotionalBody` mid-sentence on a micro-format distress-checkin
 * generation, corrupting the JSON structure (later fields absorbed the cut
 * -off prose) even though the request still "succeeded" as valid JSON with
 * all required keys present — a truncation bug, not a hallucination, and
 * one the Zod schema alone cannot catch since every field was still a
 * non-empty string.
 */
const MAX_OUTPUT_TOKENS: Record<DevotionalOutput['format'], number> = {
  micro: 1200,
  short: 1800,
  standard: 2800,
  extended: 4000,
};

const TEMPERATURE = 0.7;

// --- get_bible_verse tool definition (Foundation §4.4, verbatim schema) -----

const GET_BIBLE_VERSE_TOOL: ToolFunctionDef = {
  type: 'function',
  function: {
    name: GET_BIBLE_VERSE_TOOL_NAME,
    description:
      "Fetch authoritative, licensed Bible text from YouVersion for a specific reference. Use this whenever you reference Scripture so the verse text is exact and correctly attributed — never quote Scripture from memory.",
    parameters: {
      type: 'object',
      properties: {
        usfm: { type: 'string', description: "USFM reference, e.g. 'JHN.3.16' or 'MAT.11.28-MAT.11.30'." },
        versionId: { type: 'integer', description: 'YouVersion numeric version id, e.g. 111 (NIV).' },
        reason: {
          type: 'string',
          description:
            "Optional. One short clause on why this passage fits the user's state. Internal rationale; NOT sent to YouVersion.",
        },
      },
      required: ['usfm', 'versionId'],
    },
  },
};

// --- DevotionalOutput JSON Schema (hand-authored mirror of DevotionalOutputSchema) --
//
// Zod is not converted programmatically (no zod-to-json-schema dependency in
// this package); this schema is a deliberate, commented mirror of
// packages/shared-contracts/src/devotional.ts. If that file's shape changes,
// this must change in the same PR — enforced by the "schema mirrors Zod"
// unit test below.

const DEVOTIONAL_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    format: { type: 'string', enum: ['micro', 'short', 'standard', 'extended'] },
    theme: { type: 'string' },
    verses: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          usfm: { type: 'string' },
          versionId: { type: 'integer' },
          reference: {
            type: 'string',
            description: 'Must be the EXACT "reference" field returned by the get_bible_verse tool call for this usfm/versionId (e.g. "Matthew 11:28-30") — never paraphrased or re-derived from the usfm.',
          },
          fetchedText: {
            type: 'string',
            description: 'Must be the EXACT text returned by the get_bible_verse tool call for this usfm/versionId — never paraphrased.',
          },
          attribution: { type: 'string' },
        },
        required: ['usfm', 'versionId', 'reference', 'fetchedText', 'attribution'],
      },
    },
    devotionalBody: { type: 'string' },
    cardSummary: { type: 'string', maxLength: 300 },
    prayer: { type: 'string' },
    journalingPrompt: { type: 'string' },
    actionStep: { type: 'string' },
  },
  required: ['format', 'theme', 'verses', 'devotionalBody', 'cardSummary', 'prayer'],
};

// --- Public types -------------------------------------------------------------

/**
 * Minimal logger surface the engine depends on (docs/14_IMPROVEMENT_REVIEW.md
 * §3.7 / issue #73: "the engine swallows every failure silently ... inject a
 * logger"). Deliberately small and structural so a Fastify/Pino logger
 * (`app.log`), a plain console wrapper, or a test spy all satisfy it without
 * an adapter.
 */
export interface DevotionalEngineLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

/** Used when no logger is injected — keeps the engine usable standalone (scripts, REPLs) without requiring a caller to wire one up. */
const consoleLogger: DevotionalEngineLogger = {
  error: (msg, meta) => console.error(`[DevotionalEngine] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[DevotionalEngine] ${msg}`, meta ?? ''),
};

export interface DevotionalEngineDeps {
  glooResponsesClient: GlooResponsesClient;
  youVersionClient: YouVersionClient;
  /** Override the fixtures directory (tests only). Defaults to fixtures/snapshots at repo root. */
  fixturesDir?: string;
  model?: string;
  /** Defaults to a console-based logger — see `DevotionalEngineLogger`. */
  logger?: DevotionalEngineLogger;
  /**
   * `PROVIDERS=fixture` kill switch (docs/06 §6, docs/14 §4.4 / issue #91):
   * when true, `generate()` returns the band-keyed fixture immediately and
   * never calls `glooResponsesClient`/`youVersionClient` — the same
   * fixture-fallback path already used on a live-generation failure, just
   * taken unconditionally. Defaults to false (normal live behavior).
   */
  forceFixture?: boolean;
}

export interface GenerateDevotionalParams {
  bands: BandInput;
  /**
   * Which entries in `bands` are real observations rather than
   * `NEUTRAL_DEFAULT_BANDS` placeholders (issue #196 / K10) — see
   * `SignalProvenance`.
   *
   * Optional here, unlike on `BuildInstructionsParams` where it is required.
   * The asymmetry is deliberate. `buildInstructions` is where the claim of
   * knowledge is actually made, so that layer forces every caller to state
   * provenance explicitly. This layer is a pass-through, and its default is
   * chosen to fail SAFE: a caller that says nothing gets
   * `NO_SIGNALS_OBSERVED`, so the worst outcome of forgetting is a devotional
   * that under-claims (less personalized) rather than one that invents an
   * observation. Under-personalizing is a disappointment; narrating a
   * hardcoded fallback as insight is a broken promise.
   */
  signalProvenance?: SignalProvenance;
  tradition: Tradition;
  /** Preferred translation label for prose framing, e.g. "BSB". */
  translation: string;
  /** Default YouVersion versionId the model should prefer when calling get_bible_verse. */
  preferredVersionId: number;
  durationPreference?: DurationPreference;
  /** Defaults to 'standard'. 'examen' is the evening reflection (docs/14 §5.3, issue #77). */
  slotType?: SlotType;
  /** Lectio divina mode (docs/14 §5.4, issue #92): shrinks devotionalBody and asks for exactly one meditative question, a single passage. Defaults to false. */
  lectio?: boolean;
  /** ISO date (YYYY-MM-DD) being generated for — threaded through to buildInstructions for the liturgical-season line (docs/14 §5.7, issue #95). */
  date?: string;
  /** Liturgical-season awareness opt-in (docs/14 §5.7, issue #95) — see BuildInstructionsParams for the tradition-gating rule. Defaults to false. */
  liturgicalSeasonsEnabled?: boolean;
  /** The prior day's prayer intention text (docs/14 §5.5, issue #93) — passed straight through to buildInstructions; see BuildInstructionsParams for the framing rule. */
  prayerIntention?: string;
  /** Optional thematic focus (Epic I / I4, #64) — e.g. a team organizer's chosen theme. Passed straight through to buildInstructions; see BuildInstructionsParams. */
  theme?: string;
  /** The user's own words from an event they invited Wellspring to (Epic I / I2, #62) — deliberate disclosure, elevated safety. Passed straight through to buildInstructions; see BuildInstructionsParams. */
  inviteContext?: string;
}

export type DevotionalSource = 'gloo' | 'gloo_repaired' | 'fixture';

export interface GenerateDevotionalResult {
  devotional: DevotionalOutput;
  source: DevotionalSource;
  /** Populated only when source is 'gloo' or 'gloo_repaired' — for ops logging. */
  toolCallsExecuted?: number;
}

export class DevotionalEngineFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevotionalEngineFixtureError';
  }
}

/** One executed tool call, recorded in invocation order (see buildToolExecutor). */
interface ToolCallLogEntry {
  name: string;
  argsJson: string;
  output: string;
}

// --- Fixture fallback -----------------------------------------------------------

interface FixtureFile {
  fixtureKey: string;
  devotionalOutput: unknown;
}

/**
 * Every band-keyed (non-distress) fixture file actually present in
 * `fixturesDir` — only 5 of the 27 possible `{recovery}_{sleepQuality}_{busyness}`
 * combos ship as canonical demo fixtures (packages/shared-contracts/tests/fixtures.test.ts),
 * so this is the candidate set `resolveFixtureKey` picks a nearest neighbor
 * from (issue #78). Filenames that aren't valid fallback keys (`distress_checkin.json`,
 * anything else that might live alongside the band-keyed fixtures) are
 * skipped rather than thrown on.
 */
function availableFallbackFixtureKeys(fixturesDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(fixturesDir);
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const candidate = entry.slice(0, -'.json'.length);
    try {
      parseFallbackKey(candidate);
      keys.push(candidate);
    } catch {
      // Not a `{recovery}_{sleepQuality}_{busyness}` filename — e.g. distress_checkin.json.
      continue;
    }
  }
  return keys;
}

/**
 * Resolves which fixture file to load for `bands`: the exact fallback key
 * if that file exists, otherwise the nearest available one by
 * `nearestFallbackKey` (issue #78 — a Gloo outage must not throw for the
 * 22/27 band combos that have no dedicated fixture). `moderate_fair_moderate`
 * is the guaranteed terminal default: it is always present on disk and its
 * distance to any input is bounded, so it always wins when nothing closer exists.
 * Falls through to the exact key (which will then fail to load with a clear
 * "no fixture directory" error) when the directory is unreadable or has no
 * usable fixtures at all — that is a deployment/config error, not something
 * this resolution step should mask.
 */
function resolveFixtureKey(fixturesDir: string, bands: BandInput): string {
  const candidates = availableFallbackFixtureKeys(fixturesDir);
  if (candidates.length === 0) {
    return fallbackKey(bands.recovery, bands.sleepQuality, bands.busyness);
  }
  return nearestFallbackKey(
    { recovery: bands.recovery, sleepQuality: bands.sleepQuality, busyness: bands.busyness },
    candidates,
  );
}

/**
 * Loads the band-keyed fixture from fixtures/snapshots/{recovery}_{sleepQuality}_{busyness}.json
 * (Foundation §5 fallback-map key), degrading to the nearest available
 * fixture when the exact key has no file (issue #78 — see `resolveFixtureKey`).
 * Throws DevotionalEngineFixtureError only if fixturesDir has no usable
 * fixtures at all (a deployment/config error, not a normal runtime path).
 */
/**
 * KNOWN GAP (issue #196 / K10) — this selection is provenance-blind, and the
 * fixture corpus itself narrates health as observed fact.
 *
 * `resolveFixtureKey` keys on `recovery`/`sleepQuality`/`busyness`, so a user
 * with no health data lands on `moderate_fair_moderate` — whose body opens
 * "Sleep was fine, not great. Energy has been steady, not exceptional." and
 * later says "with its fair sleep and its moderate pace". For a calendar-only
 * user those are assertions about a person Wellspring has measured nothing about:
 * exactly the failure the `SignalProvenance` work in instructionsBuilder.ts
 * fixes for the LLM path, reproduced here in static content.
 *
 * It is NOT fixable by prompt instructions, because no model runs on this
 * path — and this path is the reliability floor (01_PRD §7: a failed
 * generation "still resolves to a fixture devotional (never a dead link)"),
 * so it is precisely what a calendar-only user gets on a bad day. Fixing it
 * properly means provenance-aware fixture selection plus calendar-only
 * fixture bodies, and new devotional bodies need review against the #47
 * theological-QA rubric before shipping — deliberately out of scope here
 * rather than quietly half-done.
 */
export function loadFixtureDevotional(fixturesDir: string, bands: BandInput): DevotionalOutput {
  const key = bands.distressSignal ? 'distress_checkin' : resolveFixtureKey(fixturesDir, bands);
  const filePath = path.join(fixturesDir, `${key}.json`);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    throw new DevotionalEngineFixtureError(`No fixture file found for fallback key "${key}" at ${filePath}`);
  }
  const parsed = JSON.parse(raw) as FixtureFile;
  const result = DevotionalOutputSchema.safeParse(parsed.devotionalOutput);
  if (!result.success) {
    throw new DevotionalEngineFixtureError(
      `Fixture "${key}" failed DevotionalOutputSchema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

// --- Anti-hallucination check ---------------------------------------------------

/**
 * Strips a documented, narrow class of trailing typographic noise that
 * YouVersion's live passage content has been observed to append with no
 * corresponding opener — e.g. an orphaned closing curly quote (U+201D)
 * after the final period (live-verified 2026-07-02 against BSB 3034
 * MAT.11.28-30 — `GET /v1/bibles/3034/passages/MAT.11.28-30` genuinely
 * returns `content` ending in `"...is light.”"` with no matching `"`
 * anywhere in the passage). This is upstream data noise, not part of the
 * verse's actual wording, and Gloo reliably (and reasonably) omits it when
 * reproducing the text — which the strict byte-exact check would otherwise
 * flag as a false-positive "hallucination" on every single generation for
 * an affected passage, permanently starving that passage to the fixture
 * path. Deliberately narrow: only a trailing run of unmatched closing
 * quote/apostrophe characters is stripped — nothing mid-string, nothing
 * that could mask a real paraphrase.
 */
function stripTrailingOrphanedQuoteNoise(text: string): string {
  return text.replace(/[”’"']+$/, '');
}

/**
 * Verifies every verses[].fetchedText is byte-identical to what
 * YouVersionClient actually returned for that usfm/versionId during this
 * generation (docs/04_DATA_PRIVACY_SECURITY.md §5.4: "fetchedText asserted
 * byte-identical to the YouVersion response — anti-hallucination"). If the
 * model paraphrased instead of using the tool's exact text, or cites a
 * reference it never actually fetched, this returns a list of mismatches —
 * treated as a validation failure by the caller (triggers repair/fallback).
 *
 * Exact match is checked first and is the primary rule. Only if that fails
 * does a second, narrow check run: if the two strings are identical once
 * trailing orphaned-quote noise (see stripTrailingOrphanedQuoteNoise) is
 * stripped from BOTH sides, it is accepted as non-hallucinated — this
 * covers the live-verified YouVersion content-noise case above without
 * weakening the check against genuine mid-passage paraphrasing.
 */
/** What get_bible_verse actually returned for a given usfm/versionId this generation — the anti-hallucination ground truth. */
export interface FetchedVerse {
  text: string;
  reference: string;
}

export function findFetchedTextMismatches(
  devotional: DevotionalOutput,
  fetchedTexts: Map<string, FetchedVerse>,
): string[] {
  const problems: string[] = [];
  for (const verse of devotional.verses) {
    const key = `${verse.usfm}::${verse.versionId}`;
    const actual = fetchedTexts.get(key);
    if (actual === undefined) {
      problems.push(
        `verses[] cites ${verse.usfm} (versionId ${verse.versionId}) but get_bible_verse was never successfully called with that exact usfm/versionId in this generation`,
      );
      continue;
    }
    if (
      actual.text !== verse.fetchedText &&
      stripTrailingOrphanedQuoteNoise(actual.text) !== stripTrailingOrphanedQuoteNoise(verse.fetchedText)
    ) {
      problems.push(
        `verses[].fetchedText for ${verse.usfm} (versionId ${verse.versionId}) does not match the exact text returned by get_bible_verse (possible paraphrase/hallucination)`,
      );
    }
    if (actual.reference !== verse.reference) {
      problems.push(
        `verses[].reference for ${verse.usfm} (versionId ${verse.versionId}) does not match the exact reference returned by get_bible_verse (possible hallucination)`,
      );
    }
  }
  return problems;
}

// --- Truncation detection -----------------------------------------------------

/** Sentence-ending punctuation (optionally followed by a closing quote/paren) that a complete prose field should end with. */
const TERMINAL_PUNCTUATION_RE = /[.!?…"'”’)]$/;

/**
 * Heuristically detects a `devotionalBody`/`prayer`/`cardSummary` that was
 * cut off mid-sentence by hitting `max_output_tokens` — a failure mode the
 * Zod schema alone cannot see, since a truncated string is still a
 * non-empty string and the JSON can still happen to close validly if the
 * model scrambles to fit remaining required fields into the last few
 * tokens (live-verified 2026-07-02: exactly this happened on a
 * micro-format distress-checkin generation — `devotionalBody` ended
 * mid-clause and `cardSummary`/`prayer` visibly absorbed fragments of the
 * cut-off prose). Deliberately conservative (only flags a clear absence of
 * terminal punctuation on a field of meaningful length) to avoid false
 * positives on legitimately short/stylized endings.
 *
 * `cardSummary` gets a lower length floor than `devotionalBody`/`prayer`
 * (docs/14 §3.3 / issue #88) — it's a one-line card blurb that is
 * legitimately short by design (`DEVOTIONAL_OUTPUT_JSON_SCHEMA` caps it at
 * 300 chars), so the 40-char floor tuned for full prose fields would miss
 * a truncated summary shorter than that.
 */
export function detectLikelyTruncation(devotional: DevotionalOutput): string | undefined {
  const fieldsToCheck: Array<[name: string, value: string, minLength: number]> = [
    ['devotionalBody', devotional.devotionalBody, 40],
    ['prayer', devotional.prayer, 40],
    ['cardSummary', devotional.cardSummary, 20],
  ];
  for (const [name, value, minLength] of fieldsToCheck) {
    const trimmed = value.trim();
    if (trimmed.length >= minLength && !TERMINAL_PUNCTUATION_RE.test(trimmed)) {
      return `${name} appears to be truncated mid-sentence (does not end with terminal punctuation) — likely hit max_output_tokens before the model finished writing. Last 60 chars: "...${trimmed.slice(-60)}"`;
    }
  }
  return undefined;
}

/**
 * Flattens Gloo's `usage` block into the exact field names docs/14
 * §3.7 / issue #73 specifies for the per-generation structured log line
 * (`{source, toolCalls, gloo_input_tokens, gloo_output_tokens, ...}` — this
 * is the evidence for the hackathon's per-devotional cost story, docs/07
 * §7's "<$0.05" assertion). Kept as a small pure helper (rather than
 * inlining the field names at each call site) so the exact key spelling
 * can't drift between the first-attempt and repair-attempt log calls.
 */
function usageLogFields(usage: GlooResponse['usage']): Record<string, number | undefined> {
  return {
    gloo_input_tokens: usage?.input_tokens,
    gloo_output_tokens: usage?.output_tokens,
    gloo_total_tokens: usage?.total_tokens,
  };
}

// --- Engine -----------------------------------------------------------------

export class DevotionalEngine {
  private readonly glooResponsesClient: GlooResponsesClient;
  private readonly youVersionClient: YouVersionClient;
  private readonly fixturesDir: string;
  private readonly model: string;
  private readonly logger: DevotionalEngineLogger;
  private readonly forceFixture: boolean;

  constructor(deps: DevotionalEngineDeps) {
    this.glooResponsesClient = deps.glooResponsesClient;
    this.youVersionClient = deps.youVersionClient;
    this.fixturesDir = deps.fixturesDir ?? FIXTURES_DIR;
    this.model = deps.model ?? DEFAULT_MODEL;
    this.logger = deps.logger ?? consoleLogger;
    this.forceFixture = deps.forceFixture ?? false;
  }

  /**
   * Wires a real YouVersionClient into the generic ToolExecutor shape the
   * GlooResponsesClient tool loop expects, and records every successful
   * fetch (keyed by `usfm::versionId`) so the anti-hallucination check can
   * verify the model's final output against what was actually fetched.
   * `toolLog`, if provided, additionally records every (name, arguments,
   * output) tuple IN CALL ORDER so a repair round-trip can replay the exact
   * function_call / function_call_output pairs (Foundation §4.2 requires
   * they always travel together in `input[]`) by zipping this log against
   * the call_id/id values on the turns' function_call output items, which
   * are emitted in the same order the executor is invoked.
   */
  private buildToolExecutor(fetchedTexts: Map<string, FetchedVerse>, toolLog?: ToolCallLogEntry[]) {
    return async (name: string, argsJson: string): Promise<string> => {
      const output = await this.executeTool(name, argsJson, fetchedTexts);
      if (toolLog) {
        toolLog.push({ name, argsJson, output });
      }
      return output;
    };
  }

  private async executeTool(name: string, argsJson: string, fetchedTexts: Map<string, FetchedVerse>): Promise<string> {
    if (name !== GET_BIBLE_VERSE_TOOL_NAME) {
      return JSON.stringify({
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: `Unknown tool "${name}"`, retryable: false },
        meta: { source: 'devotional-engine', fetched_at: new Date().toISOString() },
      });
    }

    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return JSON.stringify({
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'Malformed JSON arguments for get_bible_verse', retryable: false },
        meta: { source: 'devotional-engine', fetched_at: new Date().toISOString() },
      });
    }

    const parsedArgs = GetBibleVerseArgsSchema.safeParse(args);
    if (!parsedArgs.success) {
      return JSON.stringify({
        ok: false,
        error: {
          code: 'INVALID_ARGUMENT',
          message: `get_bible_verse arguments failed validation: ${parsedArgs.error.message}`,
          retryable: false,
        },
        meta: { source: 'devotional-engine', fetched_at: new Date().toISOString() },
      });
    }

    const envelope = await this.youVersionClient.getVerse(parsedArgs.data.usfm, parsedArgs.data.versionId);
    if (envelope.ok) {
      // Key by the ORIGINAL requested usfm as well as the normalized one
      // YouVersion echoes back, so the anti-hallucination check matches
      // regardless of which form the model repeats in its final JSON.
      const fetched: FetchedVerse = { text: envelope.data.text, reference: envelope.data.reference };
      fetchedTexts.set(`${parsedArgs.data.usfm}::${parsedArgs.data.versionId}`, fetched);
      fetchedTexts.set(`${envelope.data.usfm}::${envelope.data.versionId}`, fetched);
    }
    return JSON.stringify(envelope);
  }

  private buildRequest(
    instructions: string,
    format: DevotionalOutput['format'],
    input: CreateResponseRequest['input'],
    toolChoice: CreateResponseRequest['tool_choice'] = 'required',
  ): CreateResponseRequest {
    return {
      model: this.model,
      instructions,
      input,
      tools: [GET_BIBLE_VERSE_TOOL],
      tool_choice: toolChoice,
      max_output_tokens: MAX_OUTPUT_TOKENS[format],
      temperature: TEMPERATURE,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'devotional_output', schema: DEVOTIONAL_OUTPUT_JSON_SCHEMA },
      },
    };
  }

  /**
   * Parses `text` as JSON, validates against DevotionalOutputSchema, and
   * cross-checks fetchedText against what YouVersion actually returned.
   * Returns either the validated output or a combined problem description
   * (Zod errors + anti-hallucination mismatches) for use in the repair prompt.
   */
  private validate(
    text: string | undefined,
    fetchedTexts: Map<string, FetchedVerse>,
  ): { ok: true; devotional: DevotionalOutput } | { ok: false; problems: string; rawText: string } {
    if (!text) {
      return { ok: false, problems: 'Model returned no output_text (empty final message).', rawText: '' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, problems: `Output was not valid JSON: ${(err as Error).message}`, rawText: text };
    }

    const result = DevotionalOutputSchema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, problems: `Zod schema validation failed: ${result.error.message}`, rawText: text };
    }

    const truncationProblem = detectLikelyTruncation(result.data);
    if (truncationProblem) {
      return { ok: false, problems: truncationProblem, rawText: text };
    }

    const mismatches = findFetchedTextMismatches(result.data, fetchedTexts);
    if (mismatches.length > 0) {
      return {
        ok: false,
        problems: `Anti-hallucination check failed:\n${mismatches.join('\n')}`,
        rawText: text,
      };
    }

    return { ok: true, devotional: result.data };
  }

  /**
   * Runs the full engine: instructions -> tool loop -> validate -> one
   * repair round-trip on failure -> fixture fallback on second failure.
   * Never throws for the "Gloo/YouVersion had a bad day" case — always
   * resolves to a valid DevotionalOutput (join link never dead). Can still
   * throw DevotionalEngineFixtureError if even the fixture fails to load,
   * which indicates a genuine deployment defect, not a transient failure.
   */
  async generate(params: GenerateDevotionalParams): Promise<GenerateDevotionalResult> {
    const { bands, tradition, translation, preferredVersionId, durationPreference } = params;
    const slotType: SlotType = params.slotType ?? 'standard';
    const lectio = params.lectio ?? false;

    if (this.forceFixture) {
      // PROVIDERS=fixture kill switch (docs/06 §6 / issue #91) — never call
      // Gloo or YouVersion at all, not even the first attempt.
      this.logger.info('PROVIDERS=fixture kill switch active — skipping Gloo/YouVersion', {
        fallbackKey: fallbackKey(bands.recovery, bands.sleepQuality, bands.busyness),
      });
      return { devotional: loadFixtureDevotional(this.fixturesDir, bands), source: 'fixture' };
    }

    const instructions = buildInstructions({
      tradition,
      translation,
      bands,
      // Fail-safe default (issue #196): absent provenance means "we cannot
      // vouch for any of these as observations", never "assume they're all
      // real". See GenerateDevotionalParams.signalProvenance.
      signalProvenance: params.signalProvenance ?? NO_SIGNALS_OBSERVED,
      durationPreference,
      slotType,
      lectio,
      date: params.date,
      liturgicalSeasonsEnabled: params.liturgicalSeasonsEnabled,
      prayerIntention: params.prayerIntention,
      theme: params.theme,
      inviteContext: params.inviteContext,
    });
    const format = resolveTargetFormat(bands, durationPreference, slotType);

    const userContent = `Generate today's devotional. Preferred YouVersion versionId for get_bible_verse calls: ${preferredVersionId} (translation: ${translation}). Respond with ONLY the DevotionalOutput JSON — no prose outside the JSON.`;

    const fetchedTexts = new Map<string, FetchedVerse>();
    const toolLog: ToolCallLogEntry[] = [];
    const toolExecutor = this.buildToolExecutor(fetchedTexts, toolLog);

    const initialInput: CreateResponseRequest['input'] = [{ role: 'user', content: userContent }];
    const initialRequest = this.buildRequest(instructions, format, initialInput);

    let firstAttempt: Awaited<ReturnType<GlooResponsesClient['runToolLoop']>>;
    try {
      firstAttempt = await this.glooResponsesClient.runToolLoop(initialRequest, toolExecutor);
    } catch (err) {
      // Transport/tool-loop-cap failure on the very first attempt: no
      // conversation to repair against, so go straight to fixture fallback.
      this.logger.error('First Gloo attempt threw — falling back to fixture', {
        fallbackKey: fallbackKey(bands.recovery, bands.sleepQuality, bands.busyness),
        distressSignal: bands.distressSignal,
        error: err instanceof Error ? err.message : String(err),
      });
      return { devotional: loadFixtureDevotional(this.fixturesDir, bands), source: 'fixture' };
    }

    const firstValidation = this.validate(firstAttempt.finalText, fetchedTexts);
    if (firstValidation.ok) {
      this.logger.info('Devotional generated', {
        source: 'gloo',
        toolCallsExecuted: firstAttempt.toolCallsExecuted,
        ...usageLogFields(firstAttempt.finalResponse.usage),
      });
      return {
        devotional: firstValidation.devotional,
        source: 'gloo',
        toolCallsExecuted: firstAttempt.toolCallsExecuted,
      };
    }
    this.logger.info('First attempt failed validation — attempting one repair round-trip', {
      problems: firstValidation.problems,
    });

    // --- One repair round-trip (API spec §2.5) ---------------------------
    // Re-send the full turn-1 conversation — the original user message plus
    // every function_call/function_call_output PAIR the tool loop actually
    // executed (Foundation §4.2: they must always travel together) — plus a
    // corrective user item with the Zod/anti-hallucination error summary and
    // the invalid JSON, asking for corrected JSON only. Same response_format;
    // do not touch fetchedText.
    //
    // The exact required fetchedText string(s) are quoted verbatim in the
    // corrective message (not just "don't change it") because live testing
    // (2026-07-02, low_poor_heavy) showed the model will otherwise "clean
    // up" a stray trailing punctuation artifact present in the real
    // YouVersion response (e.g. an unmatched U+201D after the final period)
    // when reproducing the text from its own summary of the tool call,
    // even though the function_call_output containing the byte-exact string
    // is right there in its context. Quoting it directly removes any need
    // for the model to "recall" it correctly.
    const exactTextReminders =
      fetchedTexts.size > 0
        ? `\n\nThe EXACT required fetchedText/reference value(s), copy verbatim (character-for-character, including any punctuation) — do not paraphrase, normalize, or "clean up" any character:\n${[...fetchedTexts.entries()]
            .map(([key, fetched]) => {
              const [usfm, versionId] = key.split('::');
              return `- usfm="${usfm}" versionId=${versionId}: fetchedText="${fetched.text}" reference="${fetched.reference}"`;
            })
            .join('\n')}`
        : '';

    const repairInput: CreateResponseRequest['input'] = [
      ...initialInput,
      ...conversationToolItems(firstAttempt, toolLog),
      {
        role: 'user',
        content: `Your previous response did not pass validation:\n${firstValidation.problems}\n\nInvalid JSON you returned:\n${firstValidation.rawText}\n\nReturn ONLY corrected JSON matching the DevotionalOutput schema. Do not change any verses[].fetchedText value — it must remain EXACTLY the text returned by get_bible_verse, byte-for-byte, with no characters added, removed, or "corrected".${exactTextReminders}\n\nFix only the fields that caused the validation failure.`,
      },
    ];
    // 'auto' (not 'required') — forcing another tool call here would make
    // the model call get_bible_verse again before it can comply with
    // "return ONLY corrected JSON" (docs/14 §3.8 / issue #90).
    const repairRequest = this.buildRequest(instructions, format, repairInput, 'auto');

    let repairAttempt: Awaited<ReturnType<GlooResponsesClient['runToolLoop']>> | undefined;
    try {
      repairAttempt = await this.glooResponsesClient.runToolLoop(repairRequest, toolExecutor);
    } catch (err) {
      this.logger.error('Repair round-trip threw — falling back to fixture', {
        fallbackKey: fallbackKey(bands.recovery, bands.sleepQuality, bands.busyness),
        error: err instanceof Error ? err.message : String(err),
      });
      repairAttempt = undefined;
    }

    if (repairAttempt) {
      const repairValidation = this.validate(repairAttempt.finalText, fetchedTexts);
      if (repairValidation.ok) {
        this.logger.info('Devotional generated (after repair)', {
          source: 'gloo_repaired',
          toolCallsExecuted: firstAttempt.toolCallsExecuted + repairAttempt.toolCallsExecuted,
          ...usageLogFields(repairAttempt.finalResponse.usage),
        });
        return {
          devotional: repairValidation.devotional,
          source: 'gloo_repaired',
          toolCallsExecuted: firstAttempt.toolCallsExecuted + repairAttempt.toolCallsExecuted,
        };
      }
      this.logger.error('Repair round-trip still failed validation — falling back to fixture', {
        fallbackKey: fallbackKey(bands.recovery, bands.sleepQuality, bands.busyness),
        problems: repairValidation.problems,
      });
    }

    // --- Second failure: fixture fallback (Foundation §5, API spec §2.5.3) --
    return { devotional: loadFixtureDevotional(this.fixturesDir, bands), source: 'fixture' };
  }
}

/**
 * Reconstructs the exact function_call / function_call_output PAIRS that
 * GlooResponsesClient.runToolLoop executed during `attempt`, so the repair
 * round-trip's `input[]` can replay the full conversation history exactly
 * as Foundation §4.2 requires ("re-send the FULL input[] plus the original
 * function_call item plus a function_call_output item").
 *
 * GlooResponsesClient doesn't expose its internally-accumulated `input[]`,
 * so this re-derives it from two things captured by the engine itself:
 *   - `attempt.turns` (every raw response Gloo returned, in order) — the
 *     `function_call` output items appear here, across all but the last turn.
 *   - `toolLog` (every tool invocation this engine made via buildToolExecutor,
 *     in the SAME order runToolLoop invoked them) — carries the matching
 *     `function_call_output.output` string for each call.
 * Because runToolLoop calls the executor once per function_call entry, in
 * document order, across turns, zipping the flattened function_call entries
 * against `toolLog` by position yields the correct pairing.
 */
function conversationToolItems(
  attempt: Awaited<ReturnType<GlooResponsesClient['runToolLoop']>>,
  toolLog: ToolCallLogEntry[],
): CreateResponseRequest['input'] {
  const items: CreateResponseRequest['input'] = [];
  let logIndex = 0;

  // All turns except the last are function_call turns (the last is the
  // final `message` turn, which produced no tool invocations).
  for (const turn of attempt.turns.slice(0, -1)) {
    for (const entry of turn.output) {
      if (entry.type !== 'function_call') continue;
      const logEntry = toolLog[logIndex];
      logIndex += 1;
      items.push({
        type: 'function_call',
        id: entry.id,
        call_id: entry.call_id,
        name: entry.name,
        arguments: entry.arguments,
      });
      items.push({
        type: 'function_call_output',
        call_id: entry.call_id,
        // Falls back to a synthesized error envelope in the (should-never-
        // happen) case the logs and turns disagree in length, rather than
        // silently dropping the paired output and sending a malformed
        // function_call-with-no-output item to Gloo.
        output:
          logEntry?.output ??
          JSON.stringify({
            ok: false,
            error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Tool output unavailable for repair replay', retryable: true },
            meta: { source: 'devotional-engine', fetched_at: new Date().toISOString() },
          }),
      });
    }
  }
  return items;
}
