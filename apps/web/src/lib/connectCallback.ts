/**
 * The OAuth return path (#195 work item 4).
 *
 * iOS returns from Google through a custom scheme (`kairos://`), which a
 * browser cannot use. The API's connect callback sends web clients to
 * `${WEB_APP_BASE_URL}/connect/callback?status=success|error` instead, and
 * this module is the reader of that query string.
 *
 * It is a pure function over the raw search string, and separate from the
 * component that renders it, for one reason: this is the step where the
 * user has just left our origin and come back, so it is the step where a
 * mistake is least recoverable and hardest to reproduce by hand. A wrong
 * branch here either strands a user who *did* connect on a "try again"
 * screen, or — worse — tells a user who did not connect that they did.
 *
 * `unknown` is a real third case, not a fold into `error`. A callback that
 * arrives with no `status` at all is most likely a bookmark, a refresh, or
 * a callback shape that changed on the server; none of those are "your
 * calendar failed to connect", and claiming so would be a lie the user has
 * no way to check. It sends them back to the connect step to see the
 * actual state instead.
 */
export type ConnectCallbackResult =
  | { status: 'success' }
  | { status: 'error'; message: string }
  | { status: 'unknown'; message: string };

/**
 * Error `reason`s we recognize get real copy. Anything else gets the
 * generic line rather than being interpolated into the page — the value
 * arrives from a redirect and is not ours to trust or to echo.
 */
const ERROR_COPY: Record<string, string> = {
  access_denied: "You didn't finish granting access to Google Calendar.",
  invalid_state: 'That connection link expired. Please start the connection again.',
  server_error: "Google couldn't complete the connection just now.",
};

const GENERIC_ERROR = "We couldn't connect your calendar. You can try again, or skip for now.";

export function parseConnectCallback(search: string): ConnectCallbackResult {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return { status: 'unknown', message: 'We could not read the response from Google.' };
  }

  const status = params.get('status');
  if (status === 'success') return { status: 'success' };
  if (status === 'error') {
    const reason = params.get('reason') ?? params.get('error') ?? '';
    return { status: 'error', message: ERROR_COPY[reason] ?? GENERIC_ERROR };
  }
  return {
    status: 'unknown',
    message: 'We could not tell whether your calendar connected. Here is where things stand.',
  };
}

/**
 * The callback lands on a full page load, so the in-memory onboarding step
 * is gone by the time we can read the result. `sessionStorage` carries it
 * across that one navigation and is cleared on read.
 *
 * This is ephemeral *navigation* state — "you just came back from Google"
 * — and deliberately not preference or connection state, which stays
 * server-authoritative (see `lib/preferences.ts`). Whether the calendar is
 * actually connected is answered by the server, never by this key.
 */
const FLASH_KEY = 'kairos.connectCallback';

/** The path the API returns a web client to after the Google handoff. */
export const CONNECT_CALLBACK_PATH = '/connect/callback';

/**
 * Consumes `/connect/callback?status=…` **synchronously, before React
 * renders**, and rewrites the URL to `/`.
 *
 * This deliberately does not live in a component effect, which is where
 * it started and where it was wrong twice over:
 *
 *  1. **Effects can run more than once.** React 18 StrictMode invokes them
 *     twice in development, and the first pass had already called
 *     `replaceState` — so the second pass re-read a search string that was
 *     now empty, parsed it as `unknown`, and overwrote the `success` it
 *     had just stored. The user had connected their calendar and was told
 *     we could not tell.
 *  2. **Child effects run before parent effects.** The old version
 *     dispatched a synthetic `popstate` to tell the shell to re-read the
 *     path, but that fired before the shell's own listener was attached,
 *     so the callback screen stayed on screen and the flow never resumed.
 *
 * Both failures are ordering problems, and both disappear if the URL is
 * read exactly once, at a point where there is no ordering to get wrong.
 * By the time any component mounts, the status is in `sessionStorage` and
 * the address bar says `/`.
 *
 * `replaceState`, not a push, so Back cannot return the user to a spent
 * callback URL — revisiting it would carry no status and would read as a
 * failure.
 */
export function consumeConnectCallbackFromUrl(): void {
  if (window.location.pathname !== CONNECT_CALLBACK_PATH) return;
  stashConnectResult(parseConnectCallback(window.location.search), window.sessionStorage);
  window.history.replaceState(null, '', '/');
}

export function stashConnectResult(
  result: ConnectCallbackResult,
  storage: Pick<Storage, 'setItem'>,
): void {
  try {
    storage.setItem(FLASH_KEY, JSON.stringify(result));
  } catch {
    // Private browsing / storage disabled. The user still lands on the
    // connect step and can see the real state; only the banner is lost.
  }
}

export function takeConnectResult(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
): ConnectCallbackResult | null {
  let raw: string | null;
  try {
    raw = storage.getItem(FLASH_KEY);
    storage.removeItem(FLASH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'status' in parsed &&
      (parsed.status === 'success' || parsed.status === 'error' || parsed.status === 'unknown')
    ) {
      return parsed as ConnectCallbackResult;
    }
  } catch {
    // Corrupt value — treat as no flash rather than throwing on load.
  }
  return null;
}
