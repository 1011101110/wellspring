/**
 * The authenticated `/v1` fetch seam.
 *
 * Every call carries a fresh Firebase ID token as `Authorization: Bearer`
 * — the same auth the iOS clients use (`HTTPPreferencesClient`,
 * `HTTPBandUploadClient`), against the same `requireAuth` middleware, so
 * the same Google account resolves to the same `users.id` on both
 * surfaces (`findOrCreateByFirebaseUid`). That identity mapping is what
 * makes cross-surface parity possible at all; nothing here needs to send
 * a user id, and per Foundation §10 the server would not trust one.
 */
import { apiBaseUrl } from '../config';
import { auth } from '../firebase';

export class ApiError extends Error {
  readonly status: number;
  /**
   * The error envelope's machine-readable `code`, when the response
   * carried one (`{ ok: false, error: { code, ... } }`).
   *
   * Added for L5's replay path (#241): `GET /v1/devotionals/:id/audio`
   * answers `404 AUDIO_UNAVAILABLE` for a purged or never-synthesized
   * recording, which is a *terminal, expected* state the UI renders as
   * "no longer available" — not a failure to retry. Status alone cannot
   * express that, since the same route 404s for an unknown id too.
   *
   * `undefined` whenever the body was absent, unparseable, or carried no
   * code, so a caller must treat it as a hint and never as a guarantee.
   */
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Best-effort read of the error envelope's `code`.
 *
 * Deliberately swallows everything: this runs on a path that is already
 * failing, and a body that is empty, HTML (a proxy error page), or invalid
 * JSON must not turn a clean `ApiError` into an unhandled parse throw. The
 * user-facing message never comes from here — see `describeStatus`.
 */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = (body as { error: unknown }).error;
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code: unknown }).code;
        if (typeof code === 'string') return code;
      }
    }
  } catch {
    // No readable envelope. The status is still authoritative.
  }
  return undefined;
}

/**
 * Copy for the states a user can actually be in. Deliberately does not
 * echo the server's error body: the envelope's messages are written for
 * developers, and a 500's text is not something to put in front of
 * someone mid-onboarding.
 */
function describeStatus(status: number): string {
  if (status === 401 || status === 403) return 'Your session expired. Please sign in again.';
  if (status === 400) return 'Wellspring could not accept those settings. Please check them and retry.';
  if (status === 404) return 'We could not find your settings.';
  if (status >= 500) return 'Wellspring is having trouble right now. Your settings were not saved.';
  return 'Something went wrong. Please try again.';
}

async function idToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, 'Your session expired. Please sign in again.');
  // `getIdToken()` refreshes when the cached token is close to expiry, so
  // a long-lived tab does not start 401ing partway through onboarding.
  return user.getIdToken();
}

export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; accept?: string } = {},
): Promise<T> {
  const token = await idToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: init.accept ?? 'application/json',
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, 'We could not reach Wellspring. Check your connection and try again.');
  }

  if (!response.ok) {
    throw new ApiError(response.status, describeStatus(response.status), await errorCode(response));
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, 'Wellspring sent a response we could not read.');
  }
}
