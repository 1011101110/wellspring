/**
 * The ONE place `${publicBaseUrl}/session/${token}` and
 * `${publicBaseUrl}/stage/${token}` are spelled out (#343).
 *
 * Before this module the session-URL template was inlined in four places
 * (all three delivery providers plus the orchestrator) and the stage-URL
 * template in one more (routes/internal.ts voice-agent dispatch) — five
 * independent chances for the path shape or the trailing-slash handling
 * to drift. `hostedSessionProvider.ts` even carried a comment pointing at
 * its own inline copy. These URLs are capability credentials (the token IS
 * the authorization — docs/04), so a drifted copy is not a cosmetic bug:
 * it mints links that 404 or, worse, leak into logs in an unexpected
 * shape that the redaction regex in app.ts no longer matches.
 *
 * Both helpers normalize trailing slashes off the base themselves, so a
 * caller holding a raw `PUBLIC_BASE_URL` (which humans set, sometimes with
 * a trailing `/`) and a caller holding an already-trimmed base produce the
 * same URL. Idempotent by construction — double-trimming costs nothing.
 * Every session/stage URL construction now routes through here — the
 * orchestrator's last inline build was adopted after #342/#343 both landed.
 */

/** Trailing-slash-safe base — the same `/\/+$/` trim every call site used. */
function normalizeBaseUrl(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/\/+$/, '');
}

/** The public session page URL — `GET /session/:token` (EPIC D #31). */
export function sessionUrlFor(publicBaseUrl: string, sessionToken: string): string {
  return `${normalizeBaseUrl(publicBaseUrl)}/session/${sessionToken}`;
}

/**
 * The Stage page URL — `GET /stage/:token` (Q2 #332). Same session
 * capability token as `sessionUrlFor` (the Stage is a read-only view over
 * the same session row); only the surface differs.
 */
export function stageUrlFor(publicBaseUrl: string, sessionToken: string): string {
  return `${normalizeBaseUrl(publicBaseUrl)}/stage/${sessionToken}`;
}
