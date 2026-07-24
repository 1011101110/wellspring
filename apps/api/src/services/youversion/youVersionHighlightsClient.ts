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
 * Live-verified ground truth (epic #353, 2026-07-24): `GET /v1/highlights`
 * with ONLY our `X-YVP-App-Key` and no Bearer returns 401 "Missing or invalid
 * Bearer token" — the endpoint exists and requires the user's OAuth token. So
 * every call here sends BOTH headers: the app key (identifies the app) and the
 * user's Bearer (identifies + authorizes the person).
 *
 * ======================================================================
 * ⚠️ MUST-CONFIRM SCHEMA ASSUMPTIONS (owner pass, U1 — #354)
 * These are built against the SDK's URLBuilder paths + the VOTD probe, but the
 * exact request/response bodies are NOT publicly documented. Each is isolated
 * to one spot so U1 pins it as a one-line change:
 *
 *  1. WRITE body shape — `POST /v1/highlights` with a JSON body of
 *     `{ bible_id, passage_id, color? }`. `bible_id`/`passage_id` are our
 *     `versionId`/`usfm` (same identifier space — VOTD returned
 *     passage_id "1CO.10.13", plain USFM). `color` is a guess (see COLOR).
 *  2. WRITE idempotency — whether a repeat POST upserts or duplicates is
 *     UNKNOWN. We do not rely on it either way: the bridge guards with its own
 *     `yv_highlight_written_at` stamp before ever calling create.
 *  3. READ list shape — `GET /v1/highlights?bible_id=&page_size=` returns a
 *     paginated envelope `{ data: [...] }` (assumed to mirror `/v1/bibles`,
 *     which the passage client already treats as `{ data }`). Each item is
 *     assumed to carry `passage_id` / `bible_id` (+ an optional created
 *     timestamp). `normalizeHighlight` is the ONE place that reads those field
 *     names, tolerant of the common alternates.
 *  4. READ scope — whether `GET /v1/highlights` returns the user's ENTIRE
 *     highlight set or only highlights our app created is a CRITICAL U1
 *     finding (#357). This client does not assume either way; the honesty of
 *     the copy that consumes the result is handled in the bridge/instructions.
 *  5. DELETE — `DELETE /v1/highlights/{passage_id}?bible_id=` (unused by U3/U4
 *     but included for completeness / future disconnect cleanup).
 *  6. COLOR — the warm default `HIGHLIGHT_DEFAULT_COLOR` ("ffd27f", a soft
 *     amber matching the design system's terracotta family) is a guess for
 *     whatever `color` format the API takes (hex? name?). If the API rejects
 *     or ignores it, the mark still lands; U1 pins the real format/value.
 * ======================================================================
 *
 * Best-effort by contract: NONE of these methods throw for a transport error,
 * a timeout, or a non-2xx status. They return a small discriminated result
 * (`{ ok, status }`) so the bridge can (a) treat any failure as a silent
 * no-op that never breaks Amen (fail-open, epic #353 / rhythm #325 doctrine)
 * and (b) special-case a 401 to refresh the token once and retry. Programmer
 * misuse (an empty bearer) is the only throw.
 */

const YOUVERSION_BASE_URL = 'https://api.youversion.com';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Warm default highlight color (⚠️ must-confirm U1 — see the header). A soft
 * amber in the Wellspring design-system's terracotta family, chosen so the
 * mark a devotional leaves in the user's Bible feels of-a-piece with the app
 * rather than a jarring primary. Sent only when the write path opts to color;
 * an API that ignores/rejects it still records the highlight.
 */
export const HIGHLIGHT_DEFAULT_COLOR = 'ffd27f';

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

/** A single highlight, normalized to the identifier space our verses already use. */
export interface NormalizedHighlight {
  /** USFM passage reference, e.g. "JHN.3.16" — the API's `passage_id`. */
  passageId: string;
  /** Numeric bible version id — the API's `bible_id` (our `versionId`). */
  bibleId: number;
  /** Creation time if the API reports one; omitted otherwise (§9: never a count, just recency ordering). */
  createdAt?: string;
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
  /** Optional highlight color (⚠️ must-confirm U1). Omitted -> no color field sent. */
  color?: string;
}

export interface ListHighlightsInput {
  bearer: string;
  /** Narrow the list to one version when set (the API's `bible_id` query param). */
  bibleId?: number;
  /** Page size cap — mirrors the passage client's `page_size` usage. */
  pageSize?: number;
}

export interface DeleteHighlightInput {
  bearer: string;
  bibleId: number;
  passageId: string;
}

/**
 * Reads the assumed `{ passage_id, bible_id, created_at }` shape (⚠️
 * must-confirm U1) tolerantly: this is the ONE place field names are read, so
 * pinning the real names is a single-spot edit. An item missing a usable
 * passage id or bible id is dropped (returns null) rather than surfaced as a
 * malformed highlight — a best-effort personalization signal must never
 * fabricate a reference.
 */
export function normalizeHighlight(raw: unknown): NormalizedHighlight | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const passageId = obj.passage_id ?? obj.passageId ?? obj.usfm;
  const bibleIdRaw = obj.bible_id ?? obj.bibleId ?? obj.version_id ?? obj.versionId;
  const createdAt = obj.created_at ?? obj.createdAt ?? obj.updated_at;

  if (typeof passageId !== 'string' || passageId.trim().length === 0) return null;
  const bibleId =
    typeof bibleIdRaw === 'number'
      ? bibleIdRaw
      : typeof bibleIdRaw === 'string' && bibleIdRaw.trim().length > 0
        ? Number(bibleIdRaw)
        : NaN;
  if (!Number.isInteger(bibleId) || bibleId <= 0) return null;

  return {
    passageId,
    bibleId,
    ...(typeof createdAt === 'string' && createdAt.length > 0 ? { createdAt } : {}),
  };
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
   * Creates (or upserts — ⚠️ must-confirm U1) a highlight for one passage.
   * Body shape `{ bible_id, passage_id, color? }` (⚠️ must-confirm U1). Never
   * throws for a network/HTTP failure — returns `{ ok: false, status }` so the
   * bridge treats it as a best-effort no-op.
   */
  async createHighlight(input: CreateHighlightInput): Promise<HighlightsResult<void>> {
    if (!input.bearer) throw new Error('createHighlight requires a Bearer access token');
    const body: Record<string, unknown> = {
      bible_id: input.bibleId,
      passage_id: input.passageId,
    };
    if (input.color) body.color = input.color;

    return this.send(`${this.baseUrl}/v1/highlights`, input.bearer, {
      method: 'POST',
      body: JSON.stringify(body),
      contentTypeJson: true,
      parse: () => undefined,
    });
  }

  /**
   * Lists the user's highlights (⚠️ must-confirm U1 on both the envelope shape
   * and whether the set is all-user or app-scoped). Normalizes to
   * `NormalizedHighlight[]`; a malformed/empty envelope yields an empty list
   * rather than an error, so the read signal degrades to "no highlights" — the
   * fail-quiet posture the personalization path wants.
   */
  async listHighlights(input: ListHighlightsInput): Promise<HighlightsResult<NormalizedHighlight[]>> {
    if (!input.bearer) throw new Error('listHighlights requires a Bearer access token');
    const params = new URLSearchParams();
    if (input.bibleId !== undefined) params.set('bible_id', String(input.bibleId));
    params.set('page_size', String(input.pageSize ?? 100));
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
        return items
          .map((item) => normalizeHighlight(item))
          .filter((h): h is NormalizedHighlight => h !== null);
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
