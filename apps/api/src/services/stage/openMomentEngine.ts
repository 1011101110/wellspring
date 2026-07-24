/**
 * OpenMomentEngine — the V2 live-response engine (EPIC V #360 / #363).
 *
 * Given the listener's spoken transcript and the devotional's stored
 * open-moment context, runs a SINGLE bounded Gloo tool-loop turn and puts
 * the result through the FULL anti-hallucination gauntlet BEFORE a single
 * word is eligible for TTS. This is the epic's whole thesis, built literally:
 *
 *   transcript
 *     → distress pre-check (heuristics BEFORE the Gloo turn — epic §4)
 *     → buildOpenMomentInstructions (liturgy + safety + tradition + language,
 *       reused verbatim from instructionsBuilder.ts)
 *     → GlooResponsesClient.runToolLoop with the SHARED get_bible_verse tool
 *       + executor (the model can only CHOOSE Scripture, never write it)
 *     → JSON.parse → applyAuthoritativeFetchedText (overwrite echo with
 *       YouVersion's exact bytes) → LiveResponseSchema (Zod, strict)
 *       → truncation guard → findFetchedTextMismatches
 *     → ONE repair round-trip on failure, else `{ outcome: 'silence' }`.
 *
 * NOTHING is synthesized here — the engine returns a VALIDATED `LiveResponse`
 * (or silence); TTS happens downstream (StageResponseService), so the "never
 * spoken until validated" rule (epic §2) is structural: an invalid turn can
 * only produce `silence`, which has no audio.
 *
 * The anti-hallucination VALIDATION (applyAuthoritativeFetchedText,
 * findFetchedTextMismatches) is imported from devotionalEngine.ts and the
 * get_bible_verse FETCH is imported from getBibleVerseTool.ts — neither is
 * forked here (epic §1: "do not fork the anti-hallucination logic").
 *
 * SEAM FOR V5 (#366): the verbatim-echo guard (n-gram check that the response
 * never quotes the listener's words back) is V5's. `postValidateHook` is the
 * hook point — it runs AFTER the full gauntlet on an otherwise-valid
 * response and may veto it to silence. It is NOT implemented here.
 */

import {
  DEFAULT_LANGUAGE,
  LiveResponseSchema,
  type LanguageTag,
  type LiveResponse,
  type OpenMomentContext,
} from '@kairos/shared-contracts';
import { GlooResponsesClient, type CreateResponseRequest } from '../gloo/glooResponsesClient.js';
import {
  GET_BIBLE_VERSE_TOOL,
  executeGetBibleVerse,
  type FetchedVerse,
  type GenerationToolContext,
} from '../gloo/getBibleVerseTool.js';
import { applyAuthoritativeFetchedText, findFetchedTextMismatches } from '../devotionalEngine.js';
import { buildOpenMomentInstructions } from '../gloo/instructionsBuilder.js';
import { detectSpokenDistress } from './distressHeuristics.js';
import type { YouVersionClient } from '../youversion/youVersionClient.js';

const DEFAULT_MODEL = 'gloo-anthropic-claude-sonnet-4.6';

/**
 * LOW temperature (epic: "Temperature low"). The liturgy is deliberately
 * un-creative — a fixed grammar with three slots — so a low temperature both
 * steadies the acknowledgment/framing tone and makes the format-following
 * (short single sentences, one tool call) more reliable under the tight
 * live latency budget.
 */
const TEMPERATURE = 0.3;

/**
 * The full LiveResponse — acknowledgment + one verse + framing — is small;
 * `fetchedText` can be a sentence or two, plus JSON overhead. 900 is
 * comfortably above observed usage while staying small enough to keep the
 * single turn inside the ≤15s answer→response budget (feature #361).
 */
const MAX_OUTPUT_TOKENS = 900;

/** A field is considered truncated only above this length AND with no terminal punctuation. */
const TRUNCATION_MIN_LENGTH = 24;
const TERMINAL_PUNCTUATION_RE = /[.!?…:"'”’)]$/;

// --- LiveResponse JSON Schema (hand-authored mirror of LiveResponseSchema) ---
//
// Mirrors packages/shared-contracts/src/openMoment.ts. If that Zod schema
// changes, this must change in the same PR — the contract round-trip test
// guards the Zod side; this schema is what Gloo's structured-output mode
// enforces at generation time.
const LIVE_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    acknowledgment: {
      type: 'string',
      description:
        "ONE short sentence honoring what was shared — never analyzing, advising, or echoing the listener's words back. <=180 chars.",
    },
    verse: {
      type: 'object',
      properties: {
        usfm: { type: 'string' },
        versionId: { type: 'integer' },
        reference: {
          type: 'string',
          description:
            'Must be the EXACT "reference" returned by get_bible_verse for this usfm/versionId — never paraphrased.',
        },
        fetchedText: {
          type: 'string',
          description:
            'Must be the EXACT text returned by get_bible_verse for this usfm/versionId — never paraphrased.',
        },
        attribution: { type: 'string' },
      },
      required: ['usfm', 'versionId', 'reference', 'fetchedText', 'attribution'],
    },
    framing: {
      type: 'string',
      description:
        'ONE short, prayerful sentence handing the moment into the closing prayer. <=240 chars.',
    },
  },
  required: ['acknowledgment', 'verse', 'framing'],
};

export interface OpenMomentEngineLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: OpenMomentEngineLogger = {
  error: (msg, meta) => console.error(`[OpenMomentEngine] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[OpenMomentEngine] ${msg}`, meta ?? ''),
};

/**
 * V5 seam (#366): runs AFTER the full validation gauntlet on an otherwise-
 * valid response. Return `true` to VETO the response to silence (e.g. the
 * verbatim-echo n-gram guard). Default: never vetoes.
 */
export type PostValidateHook = (response: LiveResponse, transcript: string) => boolean;

export interface OpenMomentEngineDeps {
  glooResponsesClient: GlooResponsesClient;
  youVersionClient: YouVersionClient;
  model?: string;
  logger?: OpenMomentEngineLogger;
  /** V5 verbatim-echo guard hook point — see PostValidateHook. */
  postValidateHook?: PostValidateHook;
}

export type OpenMomentEngineResult =
  | { outcome: 'silence'; distressFlagged: boolean }
  | { outcome: 'response'; response: LiveResponse; distressFlagged: boolean };

export class OpenMomentEngine {
  private readonly glooResponsesClient: GlooResponsesClient;
  private readonly youVersionClient: YouVersionClient;
  private readonly model: string;
  private readonly logger: OpenMomentEngineLogger;
  private readonly postValidateHook: PostValidateHook;

  constructor(deps: OpenMomentEngineDeps) {
    this.glooResponsesClient = deps.glooResponsesClient;
    this.youVersionClient = deps.youVersionClient;
    this.model = deps.model ?? DEFAULT_MODEL;
    this.logger = deps.logger ?? consoleLogger;
    this.postValidateHook = deps.postValidateHook ?? (() => false);
  }

  /**
   * Produces a validated `LiveResponse`, or `silence`. Never throws for the
   * "provider had a bad day" case — any transport/validation failure resolves
   * to `silence` (the live analog of the devotional's fixture fallback: the
   * quiet is never broken by an unvalidated word).
   */
  async respond(transcript: string, context: OpenMomentContext): Promise<OpenMomentEngineResult> {
    const distressFlagged = detectSpokenDistress(transcript);

    // Empty/whitespace transcript is the honored-silence path (feature #361
    // Path B) — never call the model. Distress is impossible on empty input.
    if (transcript.trim().length === 0) {
      return { outcome: 'silence', distressFlagged: false };
    }

    const language: LanguageTag = context.language ?? DEFAULT_LANGUAGE;
    const instructions = buildOpenMomentInstructions({
      tradition: context.tradition,
      translation: context.translation,
      language,
      distressComfort: distressFlagged,
    });

    const fetchedTexts = new Map<string, FetchedVerse>();
    const toolContext: GenerationToolContext = {
      language,
      fetchedTexts,
      unlicensedVersionIds: new Set<number>(),
    };
    const toolExecutor = (name: string, argsJson: string): Promise<string> =>
      executeGetBibleVerse(
        this.youVersionClient,
        name,
        argsJson,
        toolContext,
        this.logger,
        'open-moment-engine',
      );

    const userContent = `The listener said aloud: "${transcript}"\n\nRespond with ONLY the LiveResponse JSON. Preferred YouVersion versionId for get_bible_verse: ${context.preferredVersionId} (translation: ${context.translation}).`;

    const initialInput: CreateResponseRequest['input'] = [{ role: 'user', content: userContent }];

    let firstText: string | undefined;
    try {
      const firstAttempt = await this.glooResponsesClient.runToolLoop(
        this.buildRequest(instructions, initialInput),
        toolExecutor,
      );
      firstText = firstAttempt.finalText;
    } catch (err) {
      // Transport / tool-loop-cap failure → silence (no live retry loop).
      this.logger.error('Open Moment Gloo turn threw — resolving to silence', {
        error: err instanceof Error ? err.message : String(err),
        distressFlagged,
      });
      return { outcome: 'silence', distressFlagged };
    }

    const firstValidation = this.validate(firstText, fetchedTexts);
    if (firstValidation.ok) {
      return this.finalize(firstValidation.response, transcript, distressFlagged);
    }
    this.logger.info('Open Moment first turn failed validation — one repair attempt', {
      problems: firstValidation.problems,
      distressFlagged,
    });

    // --- ONE repair round-trip (epic §2: one repair attempt max, else silence) --
    // Re-send instructions + the original transcript + the invalid JSON as an
    // assistant turn + a corrective user message quoting the EXACT required
    // verse bytes. tool_choice 'auto' so the model can either fix directly or
    // re-fetch; the shared executor keeps `fetchedTexts` authoritative either
    // way. No further retries after this — the latency budget is sacred.
    const repairInput: CreateResponseRequest['input'] = [
      ...initialInput,
      { role: 'assistant', content: firstValidation.rawText },
      { role: 'user', content: this.repairMessage(firstValidation.problems, fetchedTexts) },
    ];

    let repairText: string | undefined;
    try {
      const repairAttempt = await this.glooResponsesClient.runToolLoop(
        this.buildRequest(instructions, repairInput, 'auto'),
        toolExecutor,
      );
      repairText = repairAttempt.finalText;
    } catch (err) {
      this.logger.error('Open Moment repair turn threw — resolving to silence', {
        error: err instanceof Error ? err.message : String(err),
        distressFlagged,
      });
      return { outcome: 'silence', distressFlagged };
    }

    const repairValidation = this.validate(repairText, fetchedTexts);
    if (repairValidation.ok) {
      return this.finalize(repairValidation.response, transcript, distressFlagged);
    }

    this.logger.error('Open Moment repair still failed validation — resolving to silence', {
      problems: repairValidation.problems,
      distressFlagged,
    });
    return { outcome: 'silence', distressFlagged };
  }

  /** Applies the V5 post-validate hook (verbatim-echo guard seam), then returns response or silence. */
  private finalize(
    response: LiveResponse,
    transcript: string,
    distressFlagged: boolean,
  ): OpenMomentEngineResult {
    if (this.postValidateHook(response, transcript)) {
      this.logger.info('Open Moment response vetoed by postValidateHook — resolving to silence', {
        distressFlagged,
      });
      return { outcome: 'silence', distressFlagged };
    }
    return { outcome: 'response', response, distressFlagged };
  }

  private buildRequest(
    instructions: string,
    input: CreateResponseRequest['input'],
    toolChoice: CreateResponseRequest['tool_choice'] = 'required',
  ): CreateResponseRequest {
    return {
      model: this.model,
      instructions,
      input,
      tools: [GET_BIBLE_VERSE_TOOL],
      tool_choice: toolChoice,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'live_response', schema: LIVE_RESPONSE_JSON_SCHEMA },
      },
    };
  }

  /**
   * The FULL gauntlet, in order (epic §2): parse → make the verse
   * authoritative from the recorded tool bytes → Zod (strict) → truncation
   * guard → anti-hallucination cross-check. Any failure returns a problem
   * string for the (single) repair prompt.
   */
  private validate(
    text: string | undefined,
    fetchedTexts: Map<string, FetchedVerse>,
  ): { ok: true; response: LiveResponse } | { ok: false; problems: string; rawText: string } {
    if (!text) {
      return {
        ok: false,
        problems: 'Model returned no output_text (empty final message).',
        rawText: '',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        problems: `Output was not valid JSON: ${(err as Error).message}`,
        rawText: text,
      };
    }

    // Same server-authoritative overwrite the devotional uses (#295): the
    // model can neither leave `fetchedText` empty nor paraphrase it — the
    // recorded YouVersion bytes are substituted before any validation runs.
    // applyAuthoritativeFetchedText keys on a `verses[]` array, so wrap the
    // single live verse to reuse it verbatim, then unwrap.
    this.applyAuthoritativeVerse(parsed, fetchedTexts);

    const result = LiveResponseSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        problems: `Zod schema validation failed: ${result.error.message}`,
        rawText: text,
      };
    }

    const truncation = this.detectTruncation(result.data);
    if (truncation) {
      return { ok: false, problems: truncation, rawText: text };
    }

    const mismatches = findFetchedTextMismatches(
      { verses: [result.data.verse] } as unknown as Parameters<typeof findFetchedTextMismatches>[0],
      fetchedTexts,
    );
    if (mismatches.length > 0) {
      return {
        ok: false,
        problems: `Anti-hallucination check failed:\n${mismatches.join('\n')}`,
        rawText: text,
      };
    }

    return { ok: true, response: result.data };
  }

  /**
   * Reuses `applyAuthoritativeFetchedText` (which operates on a `verses[]`
   * array) for the single live verse by temporarily presenting it as a
   * one-element array, then copying the overwritten values back. Keeps the
   * "overwrite from recorded tool bytes" logic identical to the devotional
   * pipeline rather than reimplementing it.
   */
  private applyAuthoritativeVerse(parsed: unknown, fetchedTexts: Map<string, FetchedVerse>): void {
    if (typeof parsed !== 'object' || parsed === null) return;
    const obj = parsed as { verse?: unknown };
    if (typeof obj.verse !== 'object' || obj.verse === null) return;
    const shim = { verses: [obj.verse] };
    applyAuthoritativeFetchedText(shim, fetchedTexts);
  }

  private detectTruncation(response: LiveResponse): string | undefined {
    for (const [name, value] of [
      ['acknowledgment', response.acknowledgment],
      ['framing', response.framing],
    ] as const) {
      const trimmed = value.trim();
      if (trimmed.length >= TRUNCATION_MIN_LENGTH && !TERMINAL_PUNCTUATION_RE.test(trimmed)) {
        return `${name} appears truncated mid-sentence (no terminal punctuation) — likely hit max_output_tokens. Last 60 chars: "...${trimmed.slice(-60)}"`;
      }
    }
    return undefined;
  }

  private repairMessage(problems: string, fetchedTexts: Map<string, FetchedVerse>): string {
    const exactReminders =
      fetchedTexts.size > 0
        ? `\n\nCite ONLY a passage you actually fetched. The EXACT verse bytes, copy character-for-character:\n${[
            ...fetchedTexts.entries(),
          ]
            .map(([key, fetched]) => {
              const [usfm, versionId] = key.split('::');
              return `- usfm="${usfm}" versionId=${versionId}: fetchedText="${fetched.text}" reference="${fetched.reference}"`;
            })
            .join('\n')}`
        : '\n\nYou did not successfully fetch any verse. Call get_bible_verse before citing Scripture.';
    return `Your previous response did not pass validation:\n${problems}\n\nReturn ONLY corrected LiveResponse JSON. Keep the acknowledgment <=180 chars and the framing <=240 chars, each one short sentence. Do not change any fetchedText/reference — it must be exactly what get_bible_verse returned.${exactReminders}`;
  }
}
