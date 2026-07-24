/**
 * YouVersionHighlightsClient — the user-scoped `/v1/highlights` surface
 * (U3/U4, kairos-devotional#356/#357 / epic #353).
 *
 * This is the THIRD, separate YouVersion client in this directory, and the
 * separation is deliberate:
 *   - `youVersionClient.ts`     passage fetch, keyed by the app key
 *                               (`X-YVP-App-Key`) — no user identity.
 *   - `youVersionOAuthService.ts` the account-login (OAuth2 + PKCE) half.
 *   - THIS file                 read/write a specific user's highlights, keyed
 *                               by that user's OAuth **Bearer** access token.
 *
 * Live-verified ground truth (epic #353, 2026-07-24): every `/v1/highlights`
 * call needs BOTH headers — `Authorization: Bearer <user access token>` AND
 * `X-YVP-App-Key: <app key>`. Bearer alone returns 401 "Failed to resolve API
 * Key"; the app key identifies the app, the Bearer identifies + authorizes the
 * person.
 *
 * LIVE-VERIFIED shapes (2026-07-24 — these supersede the old public-doc
 * guesses):
 *
 *  1. WRITE — `POST /v1/highlights` body is
 *     `{ request_id: <uuid v4>, highlight: { bible_id, passage_id, color } }`.
 *     `color` is a REQUIRED 6-hex-char string (no `#`), e.g. `b4795a`.
 *     `bible_id`/`passage_id` are our `versionId`/`usfm`. `request_id` is a
 *     fresh uuid per write — the provider's idempotent-retry key. Response 201
 *     `{ bible_id, passage_id, color }`.
 *  2. READ — `GET /v1/highlights?bible_id=<int>&passage_id=<usfm>`, BOTH query
 *     params REQUIRED. Response `{ data: [{ bible_id, passage_id, color }] }`.
 *     There is NO "list all highlights" endpoint — the only read is this
 *     per-passage lookup, so the client exposes `getHighlight` returning a
 *     boolean "is this passage highlighted?" (200 with non-empty data → true,
 *     204/empty → false).
 *  3. DELETE — `DELETE /v1/highlights/{passage_id}?bible_id=<int>` (unused by
 *     U3/U4 but kept for future disconnect cleanup).
 *
 * Best-effort by contract: NONE of these methods throw for a transport error,
 * a timeout, or a non-2xx status. They return a small discriminated result
 * (`{ ok, status }`) so the bridge can (a) treat any failure as a silent
 * no-op that never breaks Amen (fail-open, epic #353 / rhythm #325 doctrine)
 * and (b) special-case a 401 to refresh the token once and retry. Programmer
 * misuse (an empty bearer) is the only throw.
 */

import { randomUUID } from 'node:crypto';

const YOUVERSION_BASE_URL = 'https://api.youversion.com';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Default highlight color — the Wellspring design-system terracotta, as the
 * REQUIRED 6-hex-char `color` the API takes (live-verified 2026-07-24). The
 * mark a devotional leaves in the user's Bible feels of-a-piece with the app.
 */
export const HIGHLIGHT_DEFAULT_COLOR = 'b4795a';

/** Minimal fetch-like contract so tests inject a fake without touching the network. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * A highlighted passage in the identifier space our verses already use. The
 * READ surface is a per-passage boolean (`getHighlight`), so this type now
 * describes a candidate passage the bridge/orchestrator asks about, not a row
 * from a (nonexistent) list endpoint.
 */
export interface NormalizedHighlight {
  /** USFM passage reference, e.g. "JHN.3.16" — the API's `passage_id`. */
  passageId: string;
  /** Numeric bible version id — the API's `bible_id` (our `versionId`). */
  bibleId: number;
}

/** Result of a highlights call — never throws; the bridge branches on `ok`/`status`. */
export type HighlightsResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

export interface YouVersionHighlightsClientOptions {
  /** App key sent as `X-YVP-App-Key` alongside the user's Bearer on every call. */
  appKey: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

export interface CreateHighlightInput {
  bearer: string;
  bibleId: number;
  passageId: string;
  /** REQUIRED 6-hex-char color (live-verified 2026-07-24), e.g. `b4795a`. */
  color: string;
}

export interface GetHighlightInput {
  bearer: string;
  /** BOTH query params are REQUIRED by `GET /v1/highlights` (live-verified). */
  bibleId: number;
  passageId: string;
}

export interface DeleteHighlightInput {
  bearer: string;
  bibleId: number;
  passageId: string;
}

export class YouVersionHighlightsClient {
  private readonly appKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options: YouVersionHighlightsClientOptions) {
    this.appKey = options.appKey;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = options.baseUrl ?? YOUVERSION_BASE_URL;
  }

  private headers(bearer: string): Record<string, string> {
    return {
      'X-YVP-App-Key': this.appKey,
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
    };
  }

  /**
   * Creates a highlight for one passage. Body is the live-verified wrapper
   * `{ request_id: <uuid v4>, highlight: { bible_id, passage_id, color } }` —
   * `request_id` is a fresh uuid per write (the provider's idempotent-retry
   * key) and `color` is a required 6-hex string. Never throws for a
   * network/HTTP failure — returns `{ ok: false, status }` so the bridge treats
   * it as a best-effort no-op.
   */
  async createHighlight(input: CreateHighlightInput): Promise<HighlightsResult<void>> {
    if (!input.bearer) throw new Error('createHighlight requires a Bearer access token');
    const body = {
      request_id: randomUUID(),
      highlight: {
        bible_id: input.bibleId,
        passage_id: input.passageId,
        color: input.color,
      },
    };

    return this.send(`${this.baseUrl}/v1/highlights`, input.bearer, {
      method: 'POST',
      body: JSON.stringify(body),
      contentTypeJson: true,
      parse: () => undefined,
    });
  }

  /**
   * Checks whether ONE passage is highlighted for the user.
   * `GET /v1/highlights?bible_id=&passage_id=` (BOTH params required,
   * live-verified). Returns `true` when the `{ data: [...] }` envelope carries
   * a highlight for that passage, `false` on a 204/empty body. There is NO
   * list-all endpoint, so this per-passage lookup is the whole read surface. A
   * malformed body degrades to `false` (fail-quiet).
   */
  async getHighlight(input: GetHighlightInput): Promise<HighlightsResult<boolean>> {
    if (!input.bearer) throw new Error('getHighlight requires a Bearer access token');
    const params = new URLSearchParams({
      bible_id: String(input.bibleId),
      passage_id: input.passageId,
    });
    const url = `${this.baseUrl}/v1/highlights?${params.toString()}`;

    return this.send(url, input.bearer, {
      method: 'GET',
      parse: (body) => {
        const envelope = body as { data?: unknown[] } | unknown[] | undefined;
        const items = Array.isArray(envelope)
          ? envelope
          : Array.isArray(envelope?.data)
            ? envelope.data
            : [];
        return items.length > 0;
      },
    });
  }

  /**
   * Deletes a highlight — `DELETE /v1/highlights/{passage_id}?bible_id=`
   * (⚠️ must-confirm U1). Not on the U3/U4 hot path; provided for future
   * disconnect-time cleanup. Best-effort like the others.
   */
  async deleteHighlight(input: DeleteHighlightInput): Promise<HighlightsResult<void>> {
    if (!input.bearer) throw new Error('deleteHighlight requires a Bearer access token');
    const params = new URLSearchParams({ bible_id: String(input.bibleId) });
    const url = `${this.baseUrl}/v1/highlights/${encodeURIComponent(input.passageId)}?${params.toString()}`;
    return this.send(url, input.bearer, { method: 'DELETE', parse: () => undefined });
  }

  /**
   * The one outbound-call shell: sets both auth headers, a 10s abort budget,
   * and turns any transport error, timeout, or non-2xx status into a
   * `{ ok: false, status }` result instead of a throw. `status` is preserved
   * (0 for a transport error) so the bridge can special-case a real 401.
   */
  private async send<T>(
    url: string,
    bearer: string,
    opts: {
      method: string;
      body?: string;
      contentTypeJson?: boolean;
      parse: (body: unknown) => T;
    },
  ): Promise<HighlightsResult<T>> {
    const headers = this.headers(bearer);
    if (opts.contentTypeJson) headers['Content-Type'] = 'application/json';

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      return { ok: false, status: response.status, error: `HTTP ${response.status} — ${text}` };
    }

    let parsedBody: unknown;
    const rawText = await response.text().catch(() => '');
    try {
      parsedBody = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      parsedBody = undefined;
    }
    return { ok: true, status: response.status, data: opts.parse(parsedBody) };
  }
}
