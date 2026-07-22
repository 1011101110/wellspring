/**
 * Starting the Google Calendar OAuth handoff.
 *
 * `GET /v1/connect/google` answers either a 302 to Google or, for API
 * clients, a JSON `{ authUrl }`. We ask for JSON (`Accept:
 * application/json`) and navigate ourselves rather than letting the
 * browser follow a redirect, because the request has to carry an
 * `Authorization` header — a plain `<a href>` or `window.location` to
 * that endpoint cannot, and would arrive unauthenticated.
 *
 * `client=web` is what tells the API to send the callback back to an
 * HTTPS return path (`${WEB_APP_BASE_URL}/connect/callback`) instead of
 * the `kairos://` custom scheme iOS uses — #195 work item 4, and the one
 * backend change web genuinely requires. That per-client switch is being
 * added in `apps/api/src/routes/connect.ts` separately; until it lands,
 * the parameter is simply ignored by the server and the callback still
 * targets the mobile scheme.
 */
import { apiFetch } from './client';

interface ConnectStartResponse {
  ok?: boolean;
  authUrl?: unknown;
}

/**
 * Returns the URL to send the browser to. Deliberately does not navigate:
 * the caller decides when to leave the page, and a function that
 * unconditionally destroys the document is not something a test can
 * exercise.
 */
export async function getGoogleConnectUrl(): Promise<string> {
  const payload = await apiFetch<ConnectStartResponse>('/v1/connect/google?client=web');
  const url = payload.authUrl;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Wellspring did not return a Google connection link.');
  }
  return url;
}
