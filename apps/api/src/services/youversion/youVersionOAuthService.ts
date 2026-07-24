/**
 * YouVersion OAuth2 authorization-code + PKCE flow for account connection
 * (U2, kairos-devotional#355 / epic #353).
 *
 * This is the account-login half of the YouVersion integration and is
 * entirely separate from `youVersionClient.ts`, which is the passage-fetch
 * API keyed by an app key (`X-YVP-App-Key`). This service speaks the OAuth
 * endpoints on `api.youversion.com/auth` and never touches the passage API,
 * and vice-versa.
 *
 * YouVersion's sign-in flow is NON-STANDARD (LIVE-VERIFIED against
 * api.youversion.com, 2026-07-24 — this supersedes the partially-wrong public
 * docs). It is NOT a plain OAuth code flow — the authorize step does not hand
 * us a `code`; after consent it redirects to our callback with ONLY `state`,
 * and a SECOND server call resolves that state into a `code`. All three API
 * calls are on the SAME host, `https://api.youversion.com`
 * (`login.youversion.com` is only where the user visually signs in, not an
 * API host).
 *
 *   1. Authorize  GET  https://api.youversion.com/auth/authorize
 *                      ?response_type=code&client_id=&redirect_uri=&scope=
 *                      &state=&nonce=&code_challenge=&code_challenge_method=S256
 *        The user signs in and consents, then YouVersion redirects to our
 *        redirect_uri with ONLY `state` (plus `error` on denial). The doc's
 *        `yvp_id`/`user_name`/`user_email`/`profile_picture` params do NOT
 *        arrive (live-verified 2026-07-24).
 *   2. Resolve    GET  https://api.youversion.com/auth/callback?state=
 *        With STATE ONLY (live-verified 2026-07-24), YouVersion responds 302
 *        with Location: {our redirect_uri}?code=&scope=&state=. We read the
 *        `code` from the Location header WITHOUT following the redirect (it
 *        points back at our own callback and would loop). See
 *        `resolveAuthorizationCode`.
 *   3. Token      POST https://api.youversion.com/auth/token (server-to-server)
 *                      grant_type=authorization_code, code, code_verifier,
 *                      redirect_uri, client_id[, client_secret]
 *        Returns `access_token` AND `id_token` (both JWTs), plus refresh_token,
 *        expires_in, scope.
 *
 * Identity comes from the `id_token` JWT (live-verified 2026-07-24): there is
 * NO `/auth/me`, and the step-1 redirect carries no user info. The token
 * response's `id_token` (fall back to `access_token`) decodes to claims `sub`
 * (= the user's yvp id), `name`, `email`, `profile_picture`, `client_id`,
 * `iss=https://api.youversion.com/auth/token`. So `youversion_user_id` =
 * `sub` (or a `yvp_id` claim if present), `display_name` = `name`. We decode
 * the payload WITHOUT verifying the signature (`decodeJwtPayload`); JWKS
 * signature verification (https://api.youversion.com/.well-known/jwks.json) is
 * a hardening follow-up — the token reached us over TLS directly from the
 * token endpoint.
 *
 * PKCE (S256): the flow mints a random `code_verifier`, sends only its SHA-256
 * challenge to the authorize endpoint, and replays the verifier server-side at
 * token exchange — the verifier NEVER travels through the browser. Generated
 * with `node:crypto` (`randomBytes`/`createHash`), the same primitive
 * `routes/connect.ts` already uses to mint opaque state tokens.
 *
 * SCOPE: `YOUVERSION_DEFAULT_SCOPES` requests `highlights` alongside
 * `openid profile email` — live-verified 2026-07-24 that `/auth/authorize`
 * accepts the `highlights` scope and that WITHOUT it `/v1/highlights` returns
 * 403 "User has not granted highlights permissions."
 *
 * ⚠️ Follow-up: no token-REVOKE endpoint is documented. Disconnect deletes our
 * stored tokens (best-effort revoke wired only once an endpoint is confirmed).
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * The OAuth scope requested at authorize time.
 *
 * Live-verified 2026-07-24: `/auth/authorize` accepts `highlights`, and a
 * token minted WITHOUT it gets 403 "User has not granted highlights
 * permissions." from `/v1/highlights`. So we request `highlights` alongside
 * the OIDC identity scopes. Whether a highlights-granted token actually
 * returns 200 from `/v1/highlights` is the coordinator's live retest after
 * deploy — not asserted here.
 */
export const YOUVERSION_DEFAULT_SCOPES = 'openid profile email highlights';

const AUTHORIZE_URL = 'https://api.youversion.com/auth/authorize';
const RESOLVE_URL = 'https://api.youversion.com/auth/callback';
const TOKEN_URL = 'https://api.youversion.com/auth/token';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Refresh a token this many milliseconds BEFORE it actually expires, so a
 * call that is about to be made against a token expiring in a few seconds
 * refreshes first rather than racing the clock (same expiry-buffer idea the
 * Google calendar client uses).
 */
export const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/** Minimal fetch-like contract so tests inject a fake without touching the network. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    /**
     * `'manual'` so `resolveAuthorizationCode` can READ the redirect's
     * `Location` header rather than follow it (the redirect points back at our
     * own callback and would loop). Omitted elsewhere (default follow).
     */
    redirect?: 'manual' | 'follow';
  },
) => Promise<{
  ok: boolean;
  status: number;
  /** Response headers — `resolveAuthorizationCode` reads `Location` off a 3xx. */
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface YouVersionOAuthServiceDeps {
  clientId: string;
  /** Optional: a public PKCE client may have none. Sent to the token endpoint only when present. */
  clientSecret?: string;
  redirectUri: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
}

/** A generated PKCE pair — the verifier is stored server-side, only the challenge leaves. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface ExchangedTokens {
  accessToken: string;
  /**
   * The OIDC `id_token` JWT — the source of the connected account's identity
   * (`sub`/`name`/…), decoded by the route with `decodeJwtPayload`. Null when
   * the token response omits it (fall back to decoding `accessToken`).
   */
  idToken: string | null;
  /**
   * YouVersion's token endpoint DOES issue a refresh token, so this is
   * normally present. Kept nullable (stored as SQL NULL) so a response that
   * omits it is handled gracefully rather than throwing.
   */
  refreshToken: string | null;
  /** Epoch ms when the access token expires, or null if the provider reported no `expires_in`. */
  expiresAt: number | null;
  /** The raw space-joined `scope` string the token response echoed, or the requested scope if absent. */
  scopes: string;
}

/**
 * Params for `resolveAuthorizationCode`. Live-verified 2026-07-24: the resolve
 * call needs ONLY the `state` — YouVersion's authorize redirect carries no
 * identity fields to replay.
 */
export interface ResolveCodeParams {
  state: string;
}

/** base64url-encode without padding — RFC 7636 PKCE / RFC 4648 §5. */
function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Decodes a JWT's payload (middle segment) WITHOUT verifying its signature.
 *
 * Splits on '.', base64url-decodes the payload segment, and JSON-parses it.
 * This is a plain claims read — there is NO signature verification here; JWKS
 * signature verification (https://api.youversion.com/.well-known/jwks.json) is
 * a hardening follow-up. It is safe as-is because the token reached us over
 * TLS directly from `/auth/token`, not through the browser.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length < 2 || !parts[1]) {
    throw new Error('decodeJwtPayload: not a JWT (expected header.payload.signature)');
  }
  const json = Buffer.from(parts[1], 'base64url').toString('utf8');
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('decodeJwtPayload: JWT payload is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export class YouVersionOAuthService {
  private readonly clientId: string;
  private readonly clientSecret: string | undefined;
  private readonly redirectUri: string;
  private readonly fetchImpl: FetchLike;

  constructor(deps: YouVersionOAuthServiceDeps) {
    this.clientId = deps.clientId;
    this.clientSecret = deps.clientSecret;
    this.redirectUri = deps.redirectUri;
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * Generates a PKCE verifier + its S256 challenge. The verifier is 32 random
   * bytes, base64url — comfortably inside RFC 7636's 43–128 character range.
   */
  generatePkcePair(): PkcePair {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
  }

  /**
   * Builds the authorization URL the user visits to grant Wellspring access.
   *
   * `state` is an opaque random token backed server-side by `oauth_states`
   * (CSRF + session binding, same store as the Google flow). `codeChallenge`
   * is the S256 hash of the verifier held server-side. `nonce` is an OIDC
   * replay guard. Removing `code_challenge` here MUST break the flow (a route
   * test mutation-checks exactly this).
   */
  getAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    nonce: string;
    scopes?: string;
  }): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', params.scopes ?? YOUVERSION_DEFAULT_SCOPES);
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /**
   * Resolves the step-1 authorize redirect into an authorization `code`.
   *
   * Live-verified 2026-07-24: YouVersion's authorize redirect carries ONLY
   * `state` (no `code`, no identity). This second call replays that state to
   * `GET api.youversion.com/auth/callback?state=`, and YouVersion answers with
   * a 302 whose `Location` header is `{our redirect_uri}?code=&scope=&state=`.
   *
   * We use `redirect: 'manual'` and read the `code` off the `Location` header
   * WITHOUT following it: the Location points back at our own callback and
   * following it would loop. The `state` echoed in the Location MUST match the
   * input state (defense against a swapped/forged redirect); a mismatch throws.
   */
  async resolveAuthorizationCode(params: ResolveCodeParams): Promise<string> {
    const url = new URL(RESOLVE_URL);
    url.searchParams.set('state', params.state);

    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const location = response.headers.get('location') ?? response.headers.get('Location');
    if (response.status < 300 || response.status >= 400 || !location) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(
        `YouVersion code resolution failed: expected a 3xx redirect with a Location header, ` +
          `got HTTP ${response.status} — ${text}`,
      );
    }

    // The Location is `{our redirect_uri}?code=&scope=&state=`. Parse it
    // relative to the resolve host so a relative Location still parses.
    const redirected = new URL(location, RESOLVE_URL);
    const code = redirected.searchParams.get('code');
    const returnedState = redirected.searchParams.get('state');

    if (returnedState !== params.state) {
      throw new Error('YouVersion code resolution: state mismatch in redirect Location');
    }
    if (!code) {
      throw new Error('YouVersion code resolution: no code in redirect Location');
    }
    return code;
  }

  /**
   * Exchanges an authorization code + PKCE verifier for tokens
   * (server-to-server; the verifier proves this is the same client that
   * started the flow). A MISSING refresh token is tolerated (returned as null,
   * stored as SQL NULL) rather than throwing, though YouVersion normally
   * issues one.
   */
  async exchangeCode(params: { code: string; codeVerifier: string }): Promise<ExchangedTokens> {
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
    };
    if (this.clientSecret) body.client_secret = this.clientSecret;
    return this.postToken(body);
  }

  /**
   * Refresh-token grant. Returns fresh tokens; a rotated refresh token
   * replaces the old one, and a response with no refresh token keeps the
   * caller's existing one (the caller decides — this returns null for
   * "the provider sent none this time").
   *
   * YouVersion issues refresh tokens, so this grant is expected to work;
   * callers must still guard on a non-null stored refresh token before calling
   * it (a connection stored before a token was issued would have none).
   */
  async refreshTokens(refreshToken: string): Promise<ExchangedTokens> {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    };
    if (this.clientSecret) body.client_secret = this.clientSecret;
    return this.postToken(body);
  }

  private async postToken(body: Record<string, string>): Promise<ExchangedTokens> {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`YouVersion token exchange failed: HTTP ${response.status} — ${text}`);
    }

    const data = (await response.json()) as {
      access_token?: string;
      id_token?: string;
      refresh_token?: string;
      /** YouVersion may send this as a number OR a numeric string. */
      expires_in?: number | string;
      scope?: string;
    };

    if (!data.access_token) {
      throw new Error('YouVersion token exchange: no access_token in response');
    }

    // `expires_in` is seconds, and may arrive as a number or a numeric string.
    const expiresInSec =
      typeof data.expires_in === 'number'
        ? data.expires_in
        : typeof data.expires_in === 'string' && data.expires_in.trim() !== ''
          ? Number(data.expires_in)
          : NaN;

    return {
      accessToken: data.access_token,
      idToken: data.id_token ?? null,
      refreshToken: data.refresh_token ?? null,
      expiresAt: Number.isFinite(expiresInSec) ? Date.now() + expiresInSec * 1000 : null,
      scopes: data.scope ?? YOUVERSION_DEFAULT_SCOPES,
    };
  }

}

/**
 * Constructs a YouVersionOAuthService from environment variables, or returns
 * `undefined` when the client id is absent.
 *
 * Deliberately does NOT throw when `YOUVERSION_OAUTH_CLIENT_ID` is missing:
 * these secrets do not exist in staging until U1 provisions them, and the app
 * must boot fine before then. The connect route detects the undefined service
 * and returns a clear 503 ("YouVersion connection not configured"). This is
 * the same fail-closed-by-omission posture as `attendeeClient` in index.ts,
 * NOT the throw-at-boot posture of the Google service (whose absence skips a
 * whole feature's routes) — here the routes must still exist so the 503 is a
 * real, testable response rather than a 404.
 *
 * `PUBLIC_BASE_URL` builds the redirect URI `/v1/youversion/oauth/callback`.
 * When the client id IS set but `PUBLIC_BASE_URL` is not, that is a genuine
 * misconfiguration and this throws — mirroring the Google builder.
 */
export function buildYouVersionOAuthServiceFromEnv(
  fetchImpl?: FetchLike,
): YouVersionOAuthService | undefined {
  const clientId = process.env.YOUVERSION_OAUTH_CLIENT_ID;
  if (!clientId) return undefined;

  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (!publicBaseUrl) throw new Error('PUBLIC_BASE_URL is not set (required for YouVersion OAuth redirect URI)');

  const redirectUri = `${publicBaseUrl.replace(/\/$/, '')}/v1/youversion/oauth/callback`;

  return new YouVersionOAuthService({
    clientId,
    clientSecret: process.env.YOUVERSION_OAUTH_CLIENT_SECRET,
    redirectUri,
    fetchImpl,
  });
}
