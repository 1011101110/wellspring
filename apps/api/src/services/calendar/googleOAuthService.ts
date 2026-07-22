/**
 * Google OAuth2 authorization-code flow for Calendar access.
 *
 * Generates the authorization URL (with `access_type=offline` and
 * `prompt=consent` to always obtain a refresh token) and exchanges an
 * authorization code for tokens. The access token is discarded after
 * exchange — only the refresh token is stored (encrypted via KmsService).
 *
 * Scopes granted (least-privilege, docs/03 §4):
 *   calendar.freebusy — gap-finding without event content
 *   calendar.events   — inserting/moving/deleting Wellspring-owned events only
 */

import { OAuth2Client } from 'google-auth-library';

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
];

export interface GoogleOAuthServiceDeps {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  scopes: string[];
}

export class GoogleOAuthService {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(deps: GoogleOAuthServiceDeps) {
    this.clientId = deps.clientId;
    this.clientSecret = deps.clientSecret;
    this.redirectUri = deps.redirectUri;
  }

  private buildClient(): OAuth2Client {
    return new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri);
  }

  /**
   * Returns the Google authorization URL the user must visit to grant
   * Wellspring calendar access.
   *
   * The `state` parameter is an opaque random token backed by the
   * `oauth_states` table (see routes/connect.ts) — this prevents CSRF and
   * ties the callback back to the initiating session.
   */
  getAuthorizationUrl(params: { state: string; scopes?: string[] }): string {
    const client = this.buildClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // always returns a refresh token, even on re-auth
      scope: params.scopes ?? DEFAULT_SCOPES,
      state: params.state,
    });
  }

  /**
   * Exchanges an OAuth2 authorization code for access + refresh tokens.
   *
   * Throws if Google does not return a refresh token (this happens when the
   * user has already authorized and the code was obtained without
   * `prompt=consent` — should not occur given `getAuthorizationUrl` always
   * sets it, but defensive check is essential since without a refresh token
   * we cannot do anything useful).
   */
  async exchangeCode(code: string): Promise<ExchangedTokens> {
    const client = this.buildClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      throw new Error(
        'Google OAuth: no refresh_token in exchange response — user may need to revoke and re-authorize',
      );
    }
    if (!tokens.access_token) {
      throw new Error('Google OAuth: no access_token in exchange response');
    }

    const scopes =
      typeof tokens.scope === 'string' ? tokens.scope.split(' ').filter(Boolean) : DEFAULT_SCOPES;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: typeof tokens.expiry_date === 'number' ? tokens.expiry_date : Date.now() + 3_600_000,
      scopes,
    };
  }

  /**
   * Revokes a token (refresh or access) with Google — `POST
   * https://oauth2.googleapis.com/revoke` invalidates it AND, for a
   * refresh token, every access token that was ever minted from it
   * (docs/04_DATA_PRIVACY_SECURITY.md §2: account deletion / disconnect
   * "revokes Google tokens", not just deletes our own copy of them).
   *
   * Throws on failure (network error, non-2xx from Google) — callers that
   * must not let a revoke failure block another operation (e.g. account
   * deletion, which must proceed even if Google's endpoint is down or the
   * token was already invalidated) are responsible for catching and
   * logging, not this method.
   */
  async revokeToken(token: string): Promise<void> {
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Google token revoke failed: HTTP ${response.status} — ${text}`);
    }
  }
}

/**
 * Constructs a GoogleOAuthService from environment variables.
 *
 * Required env vars:
 *   GOOGLE_OAUTH_CLIENT_ID     — OAuth2 client id from GCP Console
 *   GOOGLE_OAUTH_CLIENT_SECRET — OAuth2 client secret
 *   PUBLIC_BASE_URL            — e.g. https://<your-api-host>.run.app
 *                                (used to construct the redirect URI /v1/connect/google/callback)
 *
 * Throws at construction time if any required var is missing — fail-closed.
 */
export function buildGoogleOAuthServiceFromEnv(): GoogleOAuthService {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;

  if (!clientId) throw new Error('GOOGLE_OAUTH_CLIENT_ID is not set');
  if (!clientSecret) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET is not set');
  if (!publicBaseUrl) throw new Error('PUBLIC_BASE_URL is not set');

  const redirectUri = `${publicBaseUrl.replace(/\/$/, '')}/v1/connect/google/callback`;

  return new GoogleOAuthService({ clientId, clientSecret, redirectUri });
}
