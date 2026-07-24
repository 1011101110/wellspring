/**
 * The canonical `get_bible_verse` tool — its definition, its
 * YouVersion-backed executor, and the per-language LICENSE_UNAVAILABLE
 * fallback chain — extracted so EVERY Gloo tool-loop that fetches Scripture
 * (the devotional engine AND the Open Moment live-response engine, EPIC V
 * #360) runs byte-identical fetch + fallback logic. Forking this would be
 * exactly the anti-hallucination divergence the epic forbids.
 *
 * The anti-hallucination VALIDATION (applyAuthoritativeFetchedText,
 * findFetchedTextMismatches) still lives in devotionalEngine.ts and is
 * imported by both engines; this module owns only the FETCH side (the tool
 * schema + executor that records the authoritative bytes).
 */

import {
  GetBibleVerseArgsSchema,
  GET_BIBLE_VERSE_TOOL_NAME,
  LANGUAGE_CATALOG,
  type LanguageTag,
} from '@kairos/shared-contracts';
import type { ToolFunctionDef } from './glooResponsesClient.js';
import type { YouVersionClient } from '../youversion/youVersionClient.js';

// --- get_bible_verse tool definition (Foundation §4.4, verbatim schema) -----

export const GET_BIBLE_VERSE_TOOL: ToolFunctionDef = {
  type: 'function',
  function: {
    name: GET_BIBLE_VERSE_TOOL_NAME,
    description:
      'Fetch authoritative, licensed Bible text from YouVersion for a specific reference. Use this whenever you reference Scripture so the verse text is exact and correctly attributed — never quote Scripture from memory.',
    parameters: {
      type: 'object',
      properties: {
        usfm: {
          type: 'string',
          description: "USFM reference, e.g. 'JHN.3.16' or 'MAT.11.28-MAT.11.30'.",
        },
        versionId: {
          type: 'integer',
          description: 'YouVersion numeric version id, e.g. 111 (NIV).',
        },
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

/** What get_bible_verse actually returned for a given usfm/versionId this generation — the anti-hallucination ground truth. */
export interface FetchedVerse {
  text: string;
  reference: string;
}

/**
 * Per-generation state the tool executor needs (O3 #315): which language's
 * `LICENSE_UNAVAILABLE` fallback chain to walk, the anti-hallucination
 * ground-truth map, and the versionIds already proven unlicensed this
 * generation. Built fresh per generation — never shared across generations,
 * since licensing can change server-side and a stale negative would silently
 * skip a now-valid version forever.
 */
export interface GenerationToolContext {
  language: LanguageTag;
  fetchedTexts: Map<string, FetchedVerse>;
  unlicensedVersionIds: Set<number>;
}

/** Minimal logger surface — a Pino/console/test-spy all satisfy it. */
export interface GetBibleVerseLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * The ordered versionIds to try after `failedVersionId` came back
 * `LICENSE_UNAVAILABLE`: the language's default first, then the catalog's
 * pinned `fallbackVersionIds`, minus the id that just failed and any id
 * already proven unlicensed earlier in this generation. Same language ONLY
 * (O1/#313, DEC-K12): an exhausted chain returns `[]` and the caller
 * degrades rather than ever splicing a verse from another language.
 */
export function licenseFallbackCandidates(
  language: LanguageTag,
  failedVersionId: number,
  alreadyUnlicensed: ReadonlySet<number>,
): number[] {
  const entry = LANGUAGE_CATALOG[language];
  const chain = [entry.defaultVersionId, ...entry.fallbackVersionIds];
  const seen = new Set<number>();
  const candidates: number[] = [];
  for (const versionId of chain) {
    if (versionId === failedVersionId || alreadyUnlicensed.has(versionId) || seen.has(versionId))
      continue;
    seen.add(versionId);
    candidates.push(versionId);
  }
  return candidates;
}

/**
 * Executes one `get_bible_verse` tool call against a real YouVersionClient,
 * recording every successful fetch (keyed by `usfm::versionId`, and also by
 * the normalized usfm YouVersion echoes back) into `context.fetchedTexts` so
 * the anti-hallucination check downstream can verify the model's final
 * output against what was actually fetched. On `LICENSE_UNAVAILABLE` it walks
 * the same-language fallback chain (O3 #315). Returns the tool-envelope JSON
 * string to send back as `function_call_output.output`.
 *
 * `source` labels the synthetic error envelopes' `meta.source` — defaults to
 * the historical `'devotional-engine'` so the devotional path stays
 * byte-identical; the Open Moment engine passes its own label.
 */
export async function executeGetBibleVerse(
  youVersionClient: YouVersionClient,
  name: string,
  argsJson: string,
  context: GenerationToolContext,
  logger: GetBibleVerseLogger,
  source = 'devotional-engine',
): Promise<string> {
  const { fetchedTexts } = context;
  if (name !== GET_BIBLE_VERSE_TOOL_NAME) {
    return JSON.stringify({
      ok: false,
      error: { code: 'INVALID_ARGUMENT', message: `Unknown tool "${name}"`, retryable: false },
      meta: { source, fetched_at: new Date().toISOString() },
    });
  }

  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'Malformed JSON arguments for get_bible_verse',
        retryable: false,
      },
      meta: { source, fetched_at: new Date().toISOString() },
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
      meta: { source, fetched_at: new Date().toISOString() },
    });
  }

  const envelope = await youVersionClient.getVerse(parsedArgs.data.usfm, parsedArgs.data.versionId);
  if (envelope.ok) {
    const fetched: FetchedVerse = { text: envelope.data.text, reference: envelope.data.reference };
    fetchedTexts.set(`${parsedArgs.data.usfm}::${parsedArgs.data.versionId}`, fetched);
    fetchedTexts.set(`${envelope.data.usfm}::${envelope.data.versionId}`, fetched);
    return JSON.stringify(envelope);
  }

  if (envelope.error.code === 'LICENSE_UNAVAILABLE') {
    context.unlicensedVersionIds.add(parsedArgs.data.versionId);
    const candidates = licenseFallbackCandidates(
      context.language,
      parsedArgs.data.versionId,
      context.unlicensedVersionIds,
    );
    for (const candidateVersionId of candidates) {
      const retried = await youVersionClient.getVerse(parsedArgs.data.usfm, candidateVersionId);
      if (retried.ok) {
        logger.info('LICENSE_UNAVAILABLE — substituted a same-language fallback version', {
          language: context.language,
          requestedVersionId: parsedArgs.data.versionId,
          servedVersionId: candidateVersionId,
          usfm: parsedArgs.data.usfm,
        });
        const fetched: FetchedVerse = {
          text: retried.data.text,
          reference: retried.data.reference,
        };
        fetchedTexts.set(`${parsedArgs.data.usfm}::${candidateVersionId}`, fetched);
        fetchedTexts.set(`${retried.data.usfm}::${retried.data.versionId}`, fetched);
        return JSON.stringify({
          ...retried,
          meta: {
            ...retried.meta,
            version_fallback: {
              requested_version_id: parsedArgs.data.versionId,
              served_version_id: candidateVersionId,
              reason: 'LICENSE_UNAVAILABLE',
            },
          },
        });
      }
      if (retried.error.code === 'LICENSE_UNAVAILABLE') {
        context.unlicensedVersionIds.add(candidateVersionId);
        continue;
      }
      return JSON.stringify(retried);
    }
    logger.error(
      'LICENSE_UNAVAILABLE — fallback chain exhausted for language, no cross-language retry (DEC-K12)',
      {
        language: context.language,
        requestedVersionId: parsedArgs.data.versionId,
        usfm: parsedArgs.data.usfm,
        candidatesTried: candidates,
      },
    );
  }

  return JSON.stringify(envelope);
}
