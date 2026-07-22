/**
 * The devotional archive, detail, and replay audio (L5 #241, L6 #242).
 *
 * Every response is parsed through the shared contract rather than cast,
 * for the reason `api/preferences.ts` states: a drift between client and
 * server shows up here as a parse failure on the first request instead of
 * as an `undefined` several components later.
 */
import {
  DevotionalAudioResponseSchema,
  DevotionalDetailResponseSchema,
  DevotionalListResponseSchema,
  DEVOTIONAL_AUDIO_UNAVAILABLE_CODE,
  type DevotionalAudioResponseData,
  type DevotionalDetail,
  type DevotionalListResponse,
} from '@kairos/shared-contracts';
import { ApiError, apiFetch } from './client';
import { pageQuery } from '../lib/history';

/** Matches the server's default page size; small enough that the first paint is quick. */
export const HISTORY_PAGE_SIZE = 20;

function parseList(payload: unknown): DevotionalListResponse {
  const result = DevotionalListResponseSchema.safeParse(payload);
  if (!result.success) {
    throw new ApiError(200, 'Wellspring sent your devotionals in a shape this app does not understand.');
  }
  return result.data;
}

export async function getDevotionals(cursor: string | null = null): Promise<DevotionalListResponse> {
  return parseList(await apiFetch<unknown>(`/v1/devotionals${pageQuery(HISTORY_PAGE_SIZE, cursor)}`));
}

export async function getDevotional(id: string): Promise<DevotionalDetail> {
  const payload = await apiFetch<unknown>(`/v1/devotionals/${encodeURIComponent(id)}`);
  const result = DevotionalDetailResponseSchema.safeParse(payload);
  if (!result.success) {
    throw new ApiError(200, 'Wellspring sent this devotional in a shape this app does not understand.');
  }
  return result.data.data;
}

/**
 * `null` means **the audio is genuinely gone**, not that something failed.
 *
 * The route answers `404 AUDIO_UNAVAILABLE` when the object was never
 * synthesized or has been purged by retention (#82), and marks it
 * `retryable: false` because every path into it is terminal. Folding that
 * into the same `throw` as a network blip would put a "try again" in front
 * of a file that is never coming back — the dead-player failure #241 asks
 * us to avoid. So it is returned as a value the caller must handle, and
 * the caller renders "no longer available" rather than a broken player.
 *
 * A real failure (network, 500, expired session) still throws.
 */
export async function getDevotionalAudio(id: string): Promise<DevotionalAudioResponseData | null> {
  try {
    const payload = await apiFetch<unknown>(`/v1/devotionals/${encodeURIComponent(id)}/audio`);
    const result = DevotionalAudioResponseSchema.safeParse(payload);
    if (!result.success) {
      throw new ApiError(200, 'Wellspring sent an audio link this app could not read.');
    }
    return result.data.data;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    // `code` is the precise signal and is preferred when present. The
    // status fallback covers a 404 whose envelope did not survive a proxy
    // — on this route every 404 is terminal (purged audio, or an id this
    // user cannot read), and both render as "not available" rather than
    // as a retry the user would be right to expect something from.
    if (err.code === undefined || err.code === DEVOTIONAL_AUDIO_UNAVAILABLE_CODE) return null;
    throw err;
  }
}

/**
 * Search (L6, #242) — **not yet merged**, and this function is written to
 * survive that.
 *
 * `GET /v1/devotionals/search?q=` is in review at the time of writing. It
 * returns the same `DevotionalCard` shape the archive list returns, so the
 * UI is built against that shape and nothing about the result rendering
 * depends on the endpoint existing.
 *
 * A 404 is returned as `null` — "this deployment has no search" — rather
 * than thrown, so the caller can hide the search control entirely instead
 * of showing a box that errors on every keystroke. That is docs/05 P7
 * applied to a feature flag: if search is not there, the *control* is not
 * there either. It is not rendered-and-broken, and it is not rendered-and-
 * disabled.
 *
 * Note the 404 ambiguity this accepts: a genuine "no results" from a
 * deployed endpoint would be a 200 with an empty array, so a 404 here can
 * only mean the route is absent. If the merged endpoint ever 404s for a
 * query, this degrades to hiding search — conservative, and visible.
 */
export async function searchDevotionals(query: string): Promise<DevotionalListResponse | null> {
  try {
    const payload = await apiFetch<unknown>(
      `/v1/devotionals/search?q=${encodeURIComponent(query)}`,
    );
    return parseList(payload);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export { DEVOTIONAL_AUDIO_UNAVAILABLE_CODE };
