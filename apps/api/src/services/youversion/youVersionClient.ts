/**
 * YouVersionClient — YouVersion Platform API: passage fetch + reference
 * validation, wrapped in the canonical tool-result envelope.
 *
 * Contract: docs/00_FOUNDATION.md §4.3 / §4.5, docs/03_API_INTEGRATION_SPEC.md §3.
 *
 *   Base https://api.youversion.com (dev: api-dev.youversion.com)
 *   Auth: X-YVP-App-Key: ${YOUVERSION_API_KEY} — app key, NOT Bearer.
 *
 * Endpoints used:
 *   GET /v1/bibles/{bible_id}/passages/{passage_id}
 *       ?format=text&include_headings=false&include_notes=false
 *   GET /v1/bibles/{bible_id}/index        — reference validation, cached per version/process
 *   GET /v1/bibles/{bible_id}               — bible detail (id/abbreviation/title/copyright),
 *       used to (a) build the spoken/displayed attribution string, since the passage
 *       response itself carries NO copyright field (live-verified 2026-07-02), and
 *       (b) disambiguate BIBLE_NOT_FOUND from LICENSE_UNAVAILABLE (see below).
 *   GET /v1/bibles?language_ranges[]=en    — catalog sanity check / NO_BIBLES_AVAILABLE
 *
 * Live-verified quirks (2026-07-02, real app key, BSB 3034 / ASV 12 / WEBUS 206):
 *   - Multi-verse USFM ranges must be same-chapter short form "MAT.11.28-30".
 *     The doc-example long form "MAT.11.28-MAT.11.30" 404s
 *     ({"message":"Bible passage MAT.11.28-MAT.11.30 for version 3034 not found"}).
 *     `normalizeUsfmRange` below rewrites the long form to the short form before
 *     calling YouVersion so callers (and the Gloo tool schema, which documents the
 *     long form) keep working.
 *   - GET /v1/bibles/{id}/passages/{ref} returns 403 {"message":"Access denied for
 *     {id}"} BOTH for a bible id that plain doesn't exist on our key's catalog in a
 *     coarse sense AND for one that exists in the global catalog but isn't licensed
 *     to our app key (e.g. NIV 111) — the passages endpoint alone cannot distinguish
 *     BIBLE_NOT_FOUND from LICENSE_UNAVAILABLE. GET /v1/bibles/{id} (bible detail)
 *     DOES distinguish them: 404 = genuinely unknown id -> BIBLE_NOT_FOUND; 200 = the
 *     id is real but not on this key -> LICENSE_UNAVAILABLE. So on a 403 from the
 *     passages call we make one extra GET /v1/bibles/{id} call to disambiguate.
 *   - GET /v1/bibles/{id}/index returns 200 even for bibles NOT licensed to the key
 *     (e.g. 111/NIV), so index is not useful for the not-found/unlicensed split.
 *   - Non-numeric bible_id path segment -> 422 (FastAPI-style validation error body).
 *   - Bad/invalid app key -> 401 with an Apigee-style fault body.
 *
 * Outbound-call hardening (docs/14_IMPROVEMENT_REVIEW.md §2.2, §2.11 / issue #73):
 *   - Every request carries `AbortSignal.timeout(10_000)` (10s budget).
 *   - Bounded retry (max 2 retries, exponential backoff + jitter, honoring
 *     Retry-After) on 429/5xx/network-level failures. Non-retryable 4xx
 *     (400/401/403/404/422 etc.) fail on the first attempt.
 *   - HTTP 400 maps to INVALID_ARGUMENT (non-retryable) rather than falling
 *     through to the generic UPSTREAM_UNAVAILABLE catch-all.
 *   - `getVerse` never throws for a transport-level failure (a hung
 *     connection, DNS failure, etc.) — it catches it and returns a
 *     retryable UPSTREAM_UNAVAILABLE envelope, so a transient network blip
 *     can't escape the tool loop as an uncaught exception.
 *   - `bibleDetailCache`/`indexCache` delete their entry on a rejected
 *     promise so a transient failure doesn't permanently poison the
 *     per-process cache for that bible id (previously: a rejected promise
 *     stayed cached forever, misclassifying every subsequent call for that
 *     id until process restart).
 */

import type { BibleVerseData, ToolErrorCode } from '@kairos/shared-contracts';
import { parseRetryAfterMs, withRetry, type RetryDecision } from '../httpRetry.js';

const YOUVERSION_BASE_URL = 'https://api.youversion.com';
const YOUVERSION_TIMEOUT_MS = 10_000;

/** Minimal fetch-like contract so tests can inject a fake without touching the network. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    /** Aborts the request when the signal fires — every outbound call passes `AbortSignal.timeout(...)` (docs/14 §2.2). */
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

// --- Canonical tool-result envelope (Foundation §4.5) -----------------------
//
// Error codes and the BibleVerseData `data` shape are imported from
// @kairos/shared-contracts (packages/shared-contracts/src/toolEnvelope.ts) —
// the single source of truth also used by Zod validation elsewhere. The
// codes this client can actually produce are a subset of the full canonical
// list (AUDIO_UNAVAILABLE is TTS-only and never returned here).

export type { BibleVerseData };

/** Error codes this client can produce (excludes AUDIO_UNAVAILABLE, which is TTS-only). */
export const YOUVERSION_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'AUTH_FAILED',
  'LICENSE_UNAVAILABLE',
  'NO_BIBLES_AVAILABLE',
  'BIBLE_NOT_FOUND',
  'PASSAGE_NOT_FOUND',
  'REFERENCE_OUT_OF_RANGE',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
] as const satisfies readonly ToolErrorCode[];

export type YouVersionErrorCode = (typeof YOUVERSION_ERROR_CODES)[number];

export interface ToolEnvelopeMeta {
  source: string;
  fetched_at: string;
}

export interface ToolSuccess<T> {
  ok: true;
  data: T;
  meta: ToolEnvelopeMeta;
}

export interface ToolFailure {
  ok: false;
  error: {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
  };
  meta: ToolEnvelopeMeta;
}

export type ToolEnvelope<T> = ToolSuccess<T> | ToolFailure;

const RETRYABLE_CODES: ReadonlySet<ToolErrorCode> = new Set(['RATE_LIMITED', 'UPSTREAM_UNAVAILABLE']);

function isRetryable(code: ToolErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

function meta(extra?: Record<string, unknown>): ToolEnvelopeMeta {
  return { source: 'youversion', fetched_at: new Date().toISOString(), ...extra };
}

function failure(code: ToolErrorCode, message: string, extraMeta?: Record<string, unknown>): ToolFailure {
  return { ok: false, error: { code, message, retryable: isRetryable(code) }, meta: meta(extraMeta) };
}

/** Thrown for programmer-error / transport-level failures that are not a mapped tool result. */
export class YouVersionClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'YouVersionClientError';
  }
}

// --- USFM reference handling -------------------------------------------------

const USFM_REF_RE = /^([1-3]?[A-Z]{2,4})\.(\d+)\.(\d+)$/;
const USFM_RANGE_LONG_RE = /^([1-3]?[A-Z]{2,4})\.(\d+)\.(\d+)-\1\.(\d+)\.(\d+)$/;
const USFM_RANGE_SHORT_RE = /^([1-3]?[A-Z]{2,4})\.(\d+)\.(\d+)-(\d+)$/;

/**
 * Rewrites the long-form "BOOK.CH.V1-BOOK.CH.V2" USFM range (documented in
 * Foundation §4.4 / the get_bible_verse tool schema) into the short form
 * "BOOK.CH.V1-V2" that YouVersion's live API actually accepts, when the range
 * is within a single chapter. Cross-chapter ranges and already-short refs
 * pass through unchanged; single-verse refs pass through unchanged.
 */
export function normalizeUsfmRange(usfm: string): string {
  const longMatch = usfm.match(USFM_RANGE_LONG_RE);
  if (longMatch) {
    const [, book, ch1, v1, ch2, v2] = longMatch;
    if (ch1 === ch2) {
      return `${book}.${ch1}.${v1}-${v2}`;
    }
    // Cross-chapter range: YouVersion does not support a short form for
    // this case in what we've verified live; leave as-is (will surface as
    // PASSAGE_NOT_FOUND from the API rather than being silently wrong).
    return usfm;
  }
  return usfm;
}

/** Parses a USFM single-verse or single-chapter-range reference into its parts, if it matches a known shape. */
function parseUsfmRef(
  usfm: string,
): { book: string; chapter: number; verseStart: number; verseEnd: number } | undefined {
  const single = usfm.match(USFM_REF_RE);
  if (single && single[1] && single[2] && single[3]) {
    const [, book, ch, v] = single;
    return { book, chapter: Number(ch), verseStart: Number(v), verseEnd: Number(v) };
  }
  const short = usfm.match(USFM_RANGE_SHORT_RE);
  if (short && short[1] && short[2] && short[3] && short[4]) {
    const [, book, ch, v1, v2] = short;
    return { book, chapter: Number(ch), verseStart: Number(v1), verseEnd: Number(v2) };
  }
  const long = usfm.match(USFM_RANGE_LONG_RE);
  if (long && long[1] && long[2] && long[3] && long[4] && long[5]) {
    const [, book, ch1, v1, ch2, v2] = long;
    if (ch1 === ch2) {
      return { book, chapter: Number(ch1), verseStart: Number(v1), verseEnd: Number(v2) };
    }
  }
  return undefined;
}

// --- Index cache (per version per process) -----------------------------------

interface BibleIndexBook {
  id: string;
  chapters: Array<{ id: string; verses: Array<{ id: string }> }>;
}

interface BibleIndex {
  books: BibleIndexBook[];
}

interface BibleDetail {
  id: number;
  abbreviation: string;
  title: string;
  copyright: string | null;
}

export interface YouVersionClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Injectable retry sleep (tests only) — see httpRetry.ts. Defaults to a real setTimeout-based sleep. */
  retrySleep?: (ms: number) => Promise<void>;
  /** Injectable retry jitter RNG (tests only) — see httpRetry.ts. Defaults to Math.random. */
  retryRandom?: () => number;
}

interface RawResponse {
  status: number;
  ok: boolean;
  body: unknown;
  bodyText: string;
}

export class YouVersionClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly retrySleep?: (ms: number) => Promise<void>;
  private readonly retryRandom?: () => number;

  /** Per-process cache: bible_id -> parsed index. Foundation/API-spec §3.1: "cache per version per process". */
  private readonly indexCache = new Map<number, Promise<BibleIndex>>();
  /** Per-process cache: bible_id -> bible detail (for attribution + not-found/license disambiguation). */
  private readonly bibleDetailCache = new Map<number, Promise<BibleDetail | undefined>>();

  constructor(options: YouVersionClientOptions) {
    if (!options.apiKey) {
      throw new YouVersionClientError('YouVersionClient requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.baseUrl = options.baseUrl ?? YOUVERSION_BASE_URL;
    this.retrySleep = options.retrySleep;
    this.retryRandom = options.retryRandom;
  }

  /**
   * GET with `AbortSignal.timeout(10_000)` and bounded retry (max 2 retries,
   * exponential backoff + jitter, honoring Retry-After) on 429/5xx/network
   * failures. Non-retryable 4xx responses (400/401/403/404/422/...) and any
   * successful response resolve immediately without retrying.
   */
  private async request(path: string): Promise<RawResponse> {
    type Attempt = { transportError: true; error: unknown } | { transportError: false; res: RawResponse };

    const result = await withRetry<Attempt>(
      async (): Promise<RetryDecision<Attempt>> => {
        let res: Awaited<ReturnType<FetchLike>>;
        try {
          res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method: 'GET',
            headers: { 'X-YVP-App-Key': this.apiKey },
            signal: AbortSignal.timeout(YOUVERSION_TIMEOUT_MS),
          });
        } catch (err) {
          // Network-level failure (including our own timeout abort) — retryable.
          return { done: false, value: { transportError: true, error: err } };
        }

        const bodyText = await res.text().catch(() => '');
        let body: unknown;
        try {
          body = bodyText ? JSON.parse(bodyText) : undefined;
        } catch {
          body = undefined;
        }
        const raw: RawResponse = { status: res.status, ok: res.ok, body, bodyText };

        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) {
          return { done: true, value: { transportError: false, res: raw } };
        }
        const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers?.get('retry-after')) : undefined;
        return { done: false, value: { transportError: false, res: raw }, retryAfterMs };
      },
      { sleep: this.retrySleep, random: this.retryRandom },
    );

    if (result.transportError) {
      throw new YouVersionClientError(`YouVersion request failed: ${(result.error as Error).message}`);
    }
    return result.res;
  }

  /**
   * Fetches (and caches) the bible detail resource, used for attribution
   * text and 404/403 disambiguation. Returns undefined on 404.
   *
   * Cache-rejection fix (docs/14 §2.11 / issue #73): a transient failure
   * (timeout, 5xx, network blip) must NOT poison this cache forever — the
   * previous version stored the rejected promise itself, so every
   * subsequent call for that bible id got the SAME rejection replayed
   * (silently, since `.catch()` callers just see "unavailable" again)
   * until process restart, misattributing a one-off outage as a permanent
   * BIBLE_NOT_FOUND/LICENSE_UNAVAILABLE. Deleting the entry on rejection
   * lets the next call retry cleanly.
   */
  private async getBibleDetail(bibleId: number): Promise<BibleDetail | undefined> {
    let cached = this.bibleDetailCache.get(bibleId);
    if (!cached) {
      cached = (async () => {
        const res = await this.request(`/v1/bibles/${bibleId}`);
        if (res.status === 404) return undefined;
        if (!res.ok) {
          throw new YouVersionClientError(
            `Unexpected status ${res.status} fetching bible detail for ${bibleId}`,
            res.status,
          );
        }
        return res.body as BibleDetail;
      })();
      cached.catch(() => {
        this.bibleDetailCache.delete(bibleId);
      });
      this.bibleDetailCache.set(bibleId, cached);
    }
    return cached;
  }

  private buildAttribution(detail: BibleDetail | undefined, fallbackVersionId: number): string {
    if (!detail) return `Version ${fallbackVersionId}`;
    const copyright = detail.copyright && detail.copyright.trim().length > 0 ? detail.copyright : undefined;
    return copyright ? `${detail.title} (${detail.abbreviation}) — ${copyright}` : `${detail.title} (${detail.abbreviation})`;
  }

  /**
   * Fetches and caches the book/chapter/verse index for a bible version.
   * GET /v1/bibles/{bible_id}/index — API spec §3.1.
   *
   * Cache-rejection fix (docs/14 §2.11 / issue #73) — see `getBibleDetail`'s
   * doc comment for the full rationale; same fix applied here so a
   * transient index-fetch failure doesn't permanently poison reference
   * validation for that bible id.
   */
  async getIndex(bibleId: number): Promise<BibleIndex> {
    let cached = this.indexCache.get(bibleId);
    if (!cached) {
      cached = (async () => {
        const res = await this.request(`/v1/bibles/${bibleId}/index`);
        if (!res.ok) {
          throw new YouVersionClientError(`Failed to fetch index for bible ${bibleId}: HTTP ${res.status}`, res.status);
        }
        return res.body as BibleIndex;
      })();
      cached.catch(() => {
        this.indexCache.delete(bibleId);
      });
      this.indexCache.set(bibleId, cached);
    }
    return cached;
  }

  /**
   * Validates a USFM reference against the version's index (book exists,
   * chapter exists, verse range within chapter's verse count). Does NOT
   * distinguish bible-not-found/license issues — that only surfaces on the
   * actual passage fetch, since /index 200s even for unlicensed bibles
   * (live-verified quirk, see file header).
   */
  private async validateReference(
    bibleId: number,
    usfm: string,
  ): Promise<{ valid: true } | { valid: false; code: 'INVALID_ARGUMENT' | 'REFERENCE_OUT_OF_RANGE'; message: string }> {
    const parsed = parseUsfmRef(usfm);
    if (!parsed) {
      return { valid: false, code: 'INVALID_ARGUMENT', message: `Malformed USFM reference: "${usfm}"` };
    }

    let index: BibleIndex;
    try {
      index = await this.getIndex(bibleId);
    } catch {
      // If the index itself can't be fetched (e.g. bad bible id), let the
      // passage call surface the precise error — don't block on index failure.
      return { valid: true };
    }

    const book = index.books.find((b) => b.id === parsed.book);
    if (!book) {
      return {
        valid: false,
        code: 'INVALID_ARGUMENT',
        message: `Book "${parsed.book}" not found in this version's index`,
      };
    }
    const chapter = book.chapters.find((c) => c.id === String(parsed.chapter));
    if (!chapter) {
      return {
        valid: false,
        code: 'REFERENCE_OUT_OF_RANGE',
        message: `Chapter ${parsed.chapter} not found in ${parsed.book}`,
      };
    }
    const verseCount = chapter.verses.length;
    if (parsed.verseStart < 1 || parsed.verseEnd > verseCount || parsed.verseStart > parsed.verseEnd) {
      return {
        valid: false,
        code: 'REFERENCE_OUT_OF_RANGE',
        message: `Verse range ${parsed.verseStart}-${parsed.verseEnd} out of range for ${parsed.book} ${parsed.chapter} (has ${verseCount} verses)`,
      };
    }
    return { valid: true };
  }

  /**
   * Fetches passage text for a USFM reference + version id, validating the
   * reference against the version's index first, and returns the canonical
   * tool-result envelope (Foundation §4.5) — never throws. Transport-level
   * failures (docs/14 §2.2 / issue #73: "catch transport errors in getVerse
   * and return retryable UPSTREAM_UNAVAILABLE ... instead of throwing out of
   * the tool loop") are now caught and mapped to a retryable envelope
   * instead of propagating a `YouVersionClientError` — a single Gloo
   * tool-loop turn should never crash on a YouVersion network blip when a
   * clean "try again" envelope is just as informative to the model.
   *
   * GET /v1/bibles/{bible_id}/passages/{passage_id}
   *     ?format=text&include_headings=false&include_notes=false
   */
  async getVerse(usfm: string, versionId: number): Promise<ToolEnvelope<BibleVerseData>> {
    if (!usfm || usfm.trim().length === 0) {
      return failure('INVALID_ARGUMENT', 'usfm reference is required');
    }
    if (!Number.isInteger(versionId) || versionId <= 0) {
      return failure('INVALID_ARGUMENT', `versionId must be a positive integer, got ${versionId}`);
    }

    const normalizedUsfm = normalizeUsfmRange(usfm);

    try {
      const validation = await this.validateReference(versionId, normalizedUsfm);
      if (!validation.valid) {
        return failure(validation.code, validation.message);
      }

      const path = `/v1/bibles/${versionId}/passages/${encodeURIComponent(normalizedUsfm)}?format=text&include_headings=false&include_notes=false`;
      const res = await this.request(path);

      if (res.status === 200) {
        const body = res.body as { id?: string; content?: string; reference?: string } | undefined;
        if (!body || typeof body.content !== 'string' || body.content.trim().length === 0) {
          return failure('PASSAGE_NOT_FOUND', `Passage "${normalizedUsfm}" returned no content for version ${versionId}`);
        }
        const detail = await this.getBibleDetail(versionId).catch(() => undefined);
        return {
          ok: true,
          data: {
            usfm: normalizedUsfm,
            versionId,
            reference: body.reference && body.reference.trim().length > 0 ? body.reference : normalizedUsfm,
            text: body.content,
            attribution: this.buildAttribution(detail, versionId),
          },
          meta: meta(),
        };
      }

      if (res.status === 204) {
        return failure('PASSAGE_NOT_FOUND', `Passage "${normalizedUsfm}" not available (204) for version ${versionId}`);
      }

      if (res.status === 400) {
        return failure('INVALID_ARGUMENT', `YouVersion rejected the request as malformed (HTTP 400) for version ${versionId} / passage "${normalizedUsfm}"`);
      }

      if (res.status === 401) {
        return failure('AUTH_FAILED', 'YouVersion app key rejected (401)');
      }

      if (res.status === 403) {
        // The passages endpoint returns 403 both for a genuinely-unknown bible
        // id AND for a real-but-unlicensed one (live-verified). Disambiguate
        // with GET /v1/bibles/{id}: 404 there -> BIBLE_NOT_FOUND, 200 -> LICENSE_UNAVAILABLE.
        const detail = await this.getBibleDetail(versionId).catch(() => 'error' as const);
        if (detail === undefined) {
          return failure('BIBLE_NOT_FOUND', `Bible version ${versionId} not found`);
        }
        return failure('LICENSE_UNAVAILABLE', `Bible version ${versionId} is not licensed to this app key`);
      }

      if (res.status === 404) {
        return failure('PASSAGE_NOT_FOUND', `Passage "${normalizedUsfm}" not found for version ${versionId}`);
      }

      if (res.status === 422) {
        return failure('INVALID_ARGUMENT', `Malformed request for version ${versionId} / passage "${normalizedUsfm}"`);
      }

      if (res.status === 429) {
        return failure('RATE_LIMITED', 'YouVersion rate limit exceeded');
      }

      if (res.status >= 500) {
        return failure('UPSTREAM_UNAVAILABLE', `YouVersion upstream error (HTTP ${res.status})`);
      }

      return failure('UPSTREAM_UNAVAILABLE', `Unexpected YouVersion response (HTTP ${res.status})`);
    } catch (err) {
      // Transport-level failure (network/timeout) surviving the request()
      // retry budget — never let it escape as an uncaught exception out of
      // the tool loop; a retryable envelope is the honest, actionable shape.
      return failure(
        'UPSTREAM_UNAVAILABLE',
        `YouVersion request failed (transport error): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Startup sanity check / catalog listing — GET /v1/bibles?language_ranges[]=en.
   * Returns NO_BIBLES_AVAILABLE on an empty catalog (204 or empty data array).
   */
  async listBibles(languageRanges: string[] = ['en']): Promise<ToolEnvelope<BibleDetail[]>> {
    const qs = languageRanges.map((lr) => `language_ranges[]=${encodeURIComponent(lr)}`).join('&');
    const res = await this.request(`/v1/bibles?${qs}&page_size=99`);

    if (res.status === 204) {
      return failure('NO_BIBLES_AVAILABLE', 'YouVersion returned no bibles (204)');
    }
    if (res.status === 401) {
      return failure('AUTH_FAILED', 'YouVersion app key rejected (401)');
    }
    if (res.status === 403) {
      return failure('AUTH_FAILED', 'YouVersion app key forbidden (403)');
    }
    if (res.status === 429) {
      return failure('RATE_LIMITED', 'YouVersion rate limit exceeded');
    }
    if (res.status >= 500) {
      return failure('UPSTREAM_UNAVAILABLE', `YouVersion upstream error (HTTP ${res.status})`);
    }
    if (!res.ok) {
      return failure('UPSTREAM_UNAVAILABLE', `Unexpected YouVersion response (HTTP ${res.status})`);
    }

    const body = res.body as { data?: BibleDetail[] } | undefined;
    const data = body?.data ?? [];
    if (data.length === 0) {
      return failure('NO_BIBLES_AVAILABLE', 'YouVersion returned an empty bible catalog');
    }
    return { ok: true, data, meta: meta() };
  }
}
