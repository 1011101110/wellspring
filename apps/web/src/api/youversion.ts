/**
 * Starting and ending a YouVersion account connection (U5, kairos-devotional#358).
 *
 * Mirrors `api/connect.ts` (the Google Calendar handoff): the connect endpoint
 * answers a JSON `{ authUrl }` for API clients, and we navigate ourselves
 * rather than following a redirect, because the request must carry an
 * `Authorization` header a plain `<a href>` or `window.location` cannot.
 *
 * The two shapes that differ from calendar:
 *
 *  - **Connect is a `POST`**, not a `GET` — it mints a PKCE verifier + state
 *    server-side before answering, so it is not a safe/idempotent read.
 *  - **The not-configured path is a real response.** Until U1 provisions the
 *    OAuth secret (staging today), the API answers `POST /v1/youversion/connect`
 *    with `503 UNAVAILABLE "YouVersion connection not configured"`. That is not
 *    an error to put in front of the user as a failure — it is "coming soon".
 *    This module lets the `503` propagate as an `ApiError` with `status: 503`
 *    so the caller can render the row disabled with a quiet note rather than a
 *    crash.
 */
import { apiFetch } from './client';

interface ConnectStartResponse {
  ok?: boolean;
  authUrl?: unknown;
}

/**
 * Returns the URL to send the browser to for the YouVersion handoff.
 * Deliberately does not navigate — the caller decides when to leave the page,
 * and a function that unconditionally destroys the document cannot be tested.
 *
 * Throws the underlying `ApiError` on `503` (not configured) so the caller can
 * distinguish "coming soon" from a genuine failure.
 */
export async function getYouVersionConnectUrl(): Promise<string> {
  // Any `ApiError` from `apiFetch` propagates unchanged — the 503 (not
  // configured yet) most of all, which the caller turns into a quiet "coming
  // soon" rather than an error.
  const payload = await apiFetch<ConnectStartResponse>('/v1/youversion/connect', {
    method: 'POST',
  });
  const url = payload.authUrl;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Wellspring did not return a YouVersion connection link.');
  }
  return url;
}

/**
 * Drops the stored YouVersion tokens (`DELETE /v1/youversion/connection`).
 * The caller re-reads `GET /v1/preferences` afterwards to pick up the new
 * `youversionConnection` status — the connection fact stays
 * server-authoritative, never a local guess (the #213 lesson the calendar
 * disconnect learned).
 */
export async function disconnectYouVersion(): Promise<void> {
  await apiFetch<unknown>('/v1/youversion/connection', { method: 'DELETE' });
}
