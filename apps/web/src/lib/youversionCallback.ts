/**
 * The YouVersion OAuth return path (U5, kairos-devotional#358).
 *
 * The API's YouVersion callback (`GET /v1/youversion/oauth/callback`) sends a
 * web client back to `${WEB_APP_BASE_URL}/settings?youversion=success|error`
 * (with `&reason=…` on failure) — see `apps/api/src/routes/youversionConnect.ts`,
 * `settingsRedirect`. This module is the reader of that query string.
 *
 * It mirrors `connectCallback.ts` (the Google Calendar return) deliberately:
 * the shape of the problem is identical — the user has just left our origin
 * and come back, so a wrong branch here either strands someone who *did*
 * connect on a "try again" note or tells someone who did not that they did.
 * The differences are only the query key (`youversion`, not `status`) and the
 * landing surface (Settings, not the onboarding calendar step).
 *
 * `parseYouVersionCallback` returns `null` when there is no `youversion`
 * parameter at all — a bookmark, a refresh, or an ordinary visit to Settings.
 * That is not "your account failed to connect"; it is "there is nothing to
 * report", and it renders no banner.
 */

/** The one-shot flash, held across the single callback navigation. */
export type YouVersionCallbackResult =
  | { status: 'success' }
  | { status: 'error'; message: string };

/** The query key the API redirect carries (`?youversion=success|error`). */
export const YOUVERSION_CALLBACK_PARAM = 'youversion';

/**
 * Error `reason`s we recognize get real copy. Anything else gets the generic
 * line rather than being interpolated into the page — the value arrives from
 * a redirect and is not ours to trust or to echo (the same rule the calendar
 * callback holds).
 */
const ERROR_COPY: Record<string, string> = {
  denied: "You didn't finish connecting your YouVersion account.",
};

const GENERIC_ERROR =
  "We couldn't connect your YouVersion account. You can try again whenever you're ready.";

/**
 * Reads `?youversion=success|error[&reason=…]` into a flash, or `null` when
 * no `youversion` parameter is present. Pure over the raw search string so it
 * is testable without a browser, and separate from the component that renders
 * the result, for the same reason `parseConnectCallback` is.
 */
export function parseYouVersionCallback(search: string): YouVersionCallbackResult | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return null;
  }

  const status = params.get(YOUVERSION_CALLBACK_PARAM);
  if (status === 'success') return { status: 'success' };
  if (status === 'error') {
    const reason = params.get('reason') ?? '';
    return { status: 'error', message: ERROR_COPY[reason] ?? GENERIC_ERROR };
  }
  // No `youversion` key, or an unrecognized value: nothing to report. A
  // missing key is the common case (an ordinary Settings visit), and an
  // unrecognized value is never upgraded to "error" — that would be a claim
  // we cannot support and the user cannot check.
  return null;
}

/**
 * The `sessionStorage` key the flash lives under for the one navigation
 * between the callback URL and the rendered Settings page. Ephemeral
 * *navigation* state, deliberately not connection state — whether the account
 * is actually connected is answered by `GET /v1/preferences`
 * (`youversionConnection`), never by this key.
 */
const FLASH_KEY = 'kairos.youversionCallback';

/**
 * Consumes `?youversion=…` **synchronously, before React renders**, and
 * rewrites the URL to `/`. Same ordering discipline as
 * `consumeConnectCallbackFromUrl`: read the URL exactly once, at a point where
 * there is no effect-ordering to get wrong, so a StrictMode double-invoke or a
 * child-before-parent effect cannot downgrade a stored success. By the time
 * any component mounts, the result is in `sessionStorage` and the address bar
 * says `/`.
 */
export function consumeYouVersionCallbackFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(YOUVERSION_CALLBACK_PARAM)) return;
  const result = parseYouVersionCallback(window.location.search);
  if (result) stashYouVersionResult(result, window.sessionStorage);
  // `replaceState`, not a push, so Back cannot return to a spent callback URL.
  window.history.replaceState(null, '', '/');
}

export function stashYouVersionResult(
  result: YouVersionCallbackResult,
  storage: Pick<Storage, 'setItem'>,
): void {
  try {
    storage.setItem(FLASH_KEY, JSON.stringify(result));
  } catch {
    // Private browsing / storage disabled. The user still lands on Settings
    // and can see the real connection state; only the banner is lost.
  }
}

/**
 * Reads the flash **without** clearing it. This is what the shell uses to
 * decide whether to land on Settings after the callback: it must be
 * idempotent, because the load path can run more than once (a StrictMode
 * double-subscribe, an auth token refresh) and a clearing read here would let
 * the second run route to the dashboard while the first sent the user to
 * Settings. The clearing read is `takeYouVersionResult`, done exactly once by
 * the component that shows the banner.
 */
export function peekYouVersionResult(
  storage: Pick<Storage, 'getItem'>,
): YouVersionCallbackResult | null {
  let raw: string | null;
  try {
    raw = storage.getItem(FLASH_KEY);
  } catch {
    return null;
  }
  return decode(raw);
}

export function takeYouVersionResult(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
): YouVersionCallbackResult | null {
  let raw: string | null;
  try {
    raw = storage.getItem(FLASH_KEY);
    storage.removeItem(FLASH_KEY);
  } catch {
    return null;
  }
  return decode(raw);
}

function decode(raw: string | null): YouVersionCallbackResult | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'status' in parsed &&
      (parsed.status === 'success' || parsed.status === 'error')
    ) {
      return parsed as YouVersionCallbackResult;
    }
  } catch {
    // Corrupt value — treat as no flash rather than throwing on load.
  }
  return null;
}
