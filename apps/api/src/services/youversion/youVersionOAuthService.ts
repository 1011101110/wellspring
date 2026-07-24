/**
 * YouVersion OAuth2 authorization-code + PKCE flow for account connection
 * (U2, kairos-devotional#355 / epic #353).
 *
 * This is the account-login half of the YouVersion integration and is
 * entirely separate from `youVersionClient.ts`, which is the passage-fetch
 * API keyed by an app key (`X-YVP-App-Key`). This service speaks the OAuth
 * endpoints on `login.youversion.com` / `api.youversion.com/auth` and never
 * touches the passage API, and vice-versa.
 *
 * Endpoints (SDK-verified 2026-07-24 — youversion/platform-sdk-swift
 * URLBuilder + developers.youversion.com/sign-in-apis):
 *   Authorize     GET  https://login.youversion.com/auth/authorize
 *                      ?response_type=code&client_id=&redirect_uri=&scope=
 *                      &state=&nonce=&code_challenge=&code_challenge_method=S256
 *   Token         POST https://login.youversion.com/auth/token   (server-to-server)
 *                      grant_type=authorization_code, code, code_verifier,
 *                      redirect_uri, client_id[, client_secret]
 *   Profile       GET  https://api.youversion.com/auth/me        (Bearer access token)
 *
 * PKCE (S256): the flow mints a random `code_verifier`, sends only its SHA-256
 * challenge to the authorize endpoint, and replays the verifier server-side at
 * token exchange — the verifier NEVER travels through the browser. Generated
 * with `node:crypto` (`randomBytes`/`createHash`), the same primitive
 * `routes/connect.ts` already uses to mint opaque state tokens.
 *
 * ⚠️ MUST-CONFIRM (owner pass, U1 — kairos-devotional#354):
 *   - The exact highlights SCOPE string is UNKNOWN. `YOUVERSION_DEFAULT_SCOPES`
 *     below defaults to the ONLY documented example (`openid profile email`);
 *     U1 appends the real highlights scope as a one-line change.
 *   - Whether the token endpoint returns a REFRESH TOKEN is UNCONFIRMED.
 *     `exchangeCode`/`refreshTokens` treat a missing refresh token as a
 *     supported (non-fatal) state, unlike the Google service which throws.
 *   - No token-REVOKE endpoint is documented. Disconnect deletes our stored
 *     tokens (best-effort revoke wired only once an endpoint is confirmed).
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * The OAuth scope requested at authorize time.
 *
 * ⚠️ MUST-CONFIRM (U1): the exact scope that grants highlight read/write is
 * not documented anywhere we can verify. This defaults to the single scope
 * example the sign-in docs show (`openid profile email`) so the flow is
 * well-formed and the app deploys; U1's owner pass replaces/extends this one
 * constant with the real highlights scope once confirmed. Kept as a single
 * exported constant precisely so that is a one-line change with one clear
 * place to make it.
 */
export const YOUVERSION_DEFAULT_SCOPES = 'openid profile email';

const AUTHORIZE_URL = 'https://login.youversion.com/auth/authorize';
const TOKEN_URL = 'https://login.youversion.com/auth/token';
const PROFILE_URL = 'https://api.youversion.com/auth/me';

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
  },
) => Promise<{
  ok: boolean;
  status: number;
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
  /** NULL when YouVersion issues no refresh token (⚠️ must-confirm U1) — handled, not thrown. */
  refreshToken: string | null;
  /** Epoch ms when the access token expires, or null if the provider reported no `expires_in`. */
  expiresAt: number | null;
  /** The raw space-joined `scope` string the token response echoed, or the requested scope if absent. */
  scopes: string;
}

export interface YouVersionProfile {
  /** Provider-side account id — §9-safe identity, never activity. */
  id: string | null;
  /** Human-facing name for "Connected as …", if the profile carries one. */
  displayName: string | null;
}

/** base64url-encode without padding — RFC 7636 PKCE / RFC 4648 §5. */
function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
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
   * Exchanges an authorization code + PKCE verifier for tokens
   * (server-to-server; the verifier proves this is the same client that
   * started the flow). Unlike the Google service, a MISSING refresh token is
   * NOT an error — YouVersion's refresh-token behavior is unconfirmed
   * (⚠️ must-confirm U1), so a null refresh token is returned and stored as
   * SQL NULL rather than throwing.
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
   * NOTE (⚠️ must-confirm U1): reachable only once we know YouVersion issues
   * refresh tokens at all. Callers must guard on a non-null stored refresh
   * token before calling this.
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
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    if (!data.access_token) {
      throw new Error('YouVersion token exchange: no access_token in response');
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt:
        typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : null,
      scopes: data.scope ?? YOUVERSION_DEFAULT_SCOPES,
    };
  }

  /**
   * Fetches the connected account's profile (Bearer access token). Returns
   * §9-safe identity only (id + display name); this service never reads
   * highlights or any activity. A profile fetch failure is surfaced to the
   * caller, which treats it as best-effort (a connect still succeeds without
   * a display name).
   */
  async fetchProfile(accessToken: string): Promise<YouVersionProfile> {
    const response = await this.fetchImpl(PROFILE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`YouVersion profile fetch failed: HTTP ${response.status} — ${text}`);
    }

    const data = (await response.json()) as {
      id?: string | number;
      user_id?: string | number;
      sub?: string | number;
      name?: string;
      display_name?: string;
      first_name?: string;
      last_name?: string;
    };

    const id = data.id ?? data.user_id ?? data.sub;
    const displayName =
      data.display_name ??
      data.name ??
      [data.first_name, data.last_name].filter(Boolean).join(' ') ??
      null;

    return {
      id: id != null ? String(id) : null,
      displayName: displayName && displayName.length > 0 ? displayName : null,
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
