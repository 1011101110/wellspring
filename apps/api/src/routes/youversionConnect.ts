/**
 * YouVersion account connection routes (U2, kairos-devotional#355) — the
 * OAuth2 authorization-code + PKCE flow that connects a user's YouVersion
 * account so U3/U4/U5 can read/write highlights.
 *
 * Mirrors the Google Calendar connect flow (routes/connect.ts) file-for-file
 * in shape, adapted for PKCE and YouVersion's token model:
 *
 *   1. POST /v1/youversion/connect            (auth-required)
 *      → mint PKCE verifier+challenge + opaque state, store state+verifier
 *        server-side keyed to the user, return the authorize URL.
 *   2. GET  /v1/youversion/oauth/callback     (NO auth — provider redirect)
 *      → YouVersion redirects here with the signed-in identity (yvp_id,
 *        user_name, …), NOT a code. Validate state, resolve the identity into
 *        a code (a 2nd server call — YouVersion's non-standard flow), exchange
 *        code+verifier for tokens, encrypt, upsert, redirect to the web
 *        settings page (single-origin redirect base).
 *   3. DELETE /v1/youversion/connection       (auth-required)
 *      → delete stored tokens (best-effort revoke once an endpoint exists).
 *
 * Registered from `registerUserScopedRoutes` (the journal.ts extraction
 * pattern) so it inherits that scope's helmet, rate limit, and the #80
 * default-deny audit — the callback is added to `allowedPublicV1Routes` in
 * app.ts, exactly like the Google callback.
 *
 * NOT-CONFIGURED PATH: when the OAuth service or KMS is unconfigured (no
 * `YOUVERSION_OAUTH_CLIENT_ID` yet — true in staging until U1 provisions the
 * secret), the routes still register but the connect/callback endpoints return
 * a clear 503 rather than 404, so the app deploys fine pre-U1 and the missing
 * capability is a real, testable response.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { requireAuth } from '../auth/middleware.js';
import type { VerifiedUserId } from '../db/repositories/types.js';
import type { YouVersionConnectionsRepository } from '../db/repositories/youversionConnectionsRepository.js';
import type { UsersRepository } from '../db/repositories/usersRepository.js';
import type { OAuthStatesRepository } from '../db/repositories/oauthStatesRepository.js';
import type { GoogleKmsService } from '../services/calendar/googleKmsService.js';
import type { YouVersionOAuthService } from '../services/youversion/youVersionOAuthService.js';

export interface YouVersionConnectRoutesDeps {
  /**
   * Undefined when `YOUVERSION_OAUTH_CLIENT_ID` is not configured — the
   * routes register anyway and the connect/callback endpoints 503. See the
   * module doc.
   */
  oauthService?: YouVersionOAuthService;
  /**
   * The (provider-agnostic) Cloud KMS service used to encrypt tokens at rest.
   * Optional for the same reason as `oauthService`: a deploy without KMS
   * configured cannot store tokens, so the connect path 503s rather than
   * writing plaintext.
   */
  kmsService?: GoogleKmsService;
  connections: YouVersionConnectionsRepository;
  users: UsersRepository;
  oauthStates: OAuthStatesRepository;
  /**
   * Single web origin the callback returns to (the #15 split — reuse
   * `webAppBaseUrl` from index.ts). Validated here; only a well-formed
   * `https://` origin is accepted, else the callback returns JSON rather than
   * redirecting to a malformed target.
   */
  webAppBaseUrl?: string;
  /**
   * Override the requested scope. Defaults to the service's
   * `YOUVERSION_DEFAULT_SCOPES` (⚠️ must-confirm U1 — see the service).
   */
  scopes?: string;
}

/** State token lifetime — same 10-minute CSRF window as the Google flow. */
const STATE_TTL_SEC = 600;

function validateWebAppBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  return raw.replace(/\/+$/, '');
}

function badRequest(reply: FastifyReply, message = 'Bad request') {
  return reply.status(400).send({
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message, retryable: false },
  });
}

function internalError(reply: FastifyReply, message = 'Internal error') {
  return reply.status(500).send({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message, retryable: true },
  });
}

function notConfigured(reply: FastifyReply) {
  return reply.status(503).send({
    ok: false,
    error: {
      code: 'UNAVAILABLE',
      message: 'YouVersion connection not configured',
      retryable: false,
    },
  });
}

export function registerYouVersionConnectRoutes(
  app: FastifyInstance,
  deps: YouVersionConnectRoutesDeps,
): void {
  const { connections, users, oauthStates } = deps;
  const webAppBaseUrl = validateWebAppBaseUrl(deps.webAppBaseUrl);
  if (deps.webAppBaseUrl && !webAppBaseUrl) {
    app.log.warn(
      'youversion: WEB_APP_BASE_URL is set but is not a valid https:// URL — ' +
        'the OAuth callback will return JSON instead of redirecting',
    );
  }

  /** Where the callback sends the browser when the flow ends (success or error). */
  function settingsRedirect(status: 'success' | 'error', reason?: string): string | undefined {
    if (!webAppBaseUrl) return undefined;
    const url = new URL(`${webAppBaseUrl}/settings`);
    url.searchParams.set('youversion', status);
    if (reason) url.searchParams.set('reason', reason);
    return url.toString();
  }

  // -------------------------------------------------------------------------
  // GET /v1/youversion/oauth/callback  (NO auth — YouVersion redirect)
  // Registered first, outside any requireAuth preHandler.
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: {
      yvp_id?: string;
      state?: string;
      user_name?: string;
      user_email?: string;
      profile_picture?: string;
      error?: string;
    };
  }>('/v1/youversion/oauth/callback', async (request, reply) => {
    const { oauthService, kmsService } = deps;
    if (!oauthService || !kmsService) return notConfigured(reply);

    // YouVersion's authorize redirect carries the signed-in user's identity,
    // NOT a `code` (see the service module doc). The `code` is resolved from
    // this identity in a second server call below.
    const {
      yvp_id: yvpId,
      state,
      user_name: userName,
      user_email: userEmail,
      profile_picture: profilePicture,
      error,
    } = request.query;

    // User denied — no state is consumed (nothing to authorize).
    if (error) {
      const denied = settingsRedirect('error', 'denied');
      return denied ? reply.redirect(denied) : reply.send({ ok: false, error: { code: 'DENIED' } });
    }

    if (!state) return badRequest(reply, 'Missing state parameter');

    // Atomically claim the state token — rejects unknown, expired, and
    // already-consumed (replayed) tokens identically. Also returns the PKCE
    // verifier stored alongside it.
    const claimed = await oauthStates.consume(state);
    if (!claimed) return badRequest(reply, 'Invalid or expired state parameter');

    // The authorize redirect must carry the signed-in user's yvp_id — without
    // it there is no identity to resolve into a code.
    if (!yvpId) return badRequest(reply, 'Missing yvp_id from authorization redirect');

    // PKCE is mandatory for this flow — a state row minted by
    // POST /v1/youversion/connect always carries a verifier. Its absence means
    // the token was minted by a non-PKCE flow (e.g. the Google connect), which
    // must not complete a YouVersion exchange.
    if (!claimed.codeVerifier) return badRequest(reply, 'Missing PKCE verifier for state');

    const userId = claimed.userId as VerifiedUserId;

    // Defensive: a state token can outlive a deleted account within its TTL.
    const user = await users.findById(userId);
    if (!user) return badRequest(reply, 'User not found');

    // Step 2: resolve the signed-in identity into an authorization code
    // (YouVersion's non-standard flow — see the service). This reads the code
    // off a 302 Location header without following the redirect.
    let code: string;
    try {
      code = await oauthService.resolveAuthorizationCode({
        state,
        yvpId,
        userName: userName ?? '',
        userEmail: userEmail ?? '',
        profilePicture: profilePicture ?? '',
      });
    } catch (err) {
      request.log.error({ err }, 'YouVersion OAuth code resolution failed');
      return internalError(reply, 'OAuth code resolution failed');
    }

    // Step 3: exchange the authorization code + PKCE verifier for tokens.
    let tokens: Awaited<ReturnType<YouVersionOAuthService['exchangeCode']>>;
    try {
      tokens = await oauthService.exchangeCode({ code, codeVerifier: claimed.codeVerifier });
    } catch (err) {
      request.log.error({ err }, 'YouVersion OAuth code exchange failed');
      return internalError(reply, 'OAuth code exchange failed');
    }

    // §9-safe display identity comes straight from the authorize redirect —
    // there is NO /auth/me profile endpoint. `youversion_user_id` = yvp_id,
    // `display_name` = user_name.
    const youVersionUserId: string | null = yvpId;
    const displayName: string | null = userName && userName.length > 0 ? userName : null;

    // Encrypt both tokens BEFORE any DB write — this layer never persists
    // plaintext (Foundation §10). The refresh token is encrypted only when
    // present (⚠️ must-confirm U1: YouVersion may issue none).
    let accessTokenEncrypted: Buffer;
    let refreshTokenEncrypted: Buffer | null = null;
    let kmsKeyVersion: string;
    try {
      const enc = await kmsService.encryptToken(tokens.accessToken);
      accessTokenEncrypted = enc.ciphertext;
      kmsKeyVersion = enc.keyVersion;
      if (tokens.refreshToken) {
        const encRefresh = await kmsService.encryptToken(tokens.refreshToken);
        refreshTokenEncrypted = encRefresh.ciphertext;
      }
    } catch (err) {
      request.log.error({ err }, 'YouVersion token KMS encrypt failed');
      return internalError(reply, 'Failed to securely store credentials');
    }

    await connections.upsert(userId, {
      accessTokenEncrypted,
      refreshTokenEncrypted,
      kmsKeyVersion,
      tokenExpiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
      youVersionUserId,
      displayName,
      scopes: tokens.scopes,
    });

    const acceptHeader = request.headers.accept ?? '';
    if (acceptHeader.includes('application/json')) {
      return reply.send({ ok: true, message: 'YouVersion connected' });
    }
    const success = settingsRedirect('success');
    return success ? reply.redirect(success) : reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // POST /v1/youversion/connect  (auth-required)
  // Mints PKCE + state and returns the authorize URL.
  // -------------------------------------------------------------------------
  app.post('/v1/youversion/connect', { preHandler: requireAuth }, async (request, reply) => {
    const { oauthService } = deps;
    if (!oauthService || !deps.kmsService) return notConfigured(reply);

    const userId = request.auth!.userId;

    const { verifier, challenge } = oauthService.generatePkcePair();
    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + STATE_TTL_SEC * 1000);
    await oauthStates.create(state, userId, nonce, expiresAt, verifier);

    const authUrl = oauthService.getAuthorizationUrl({
      state,
      codeChallenge: challenge,
      nonce,
      scopes: deps.scopes,
    });

    return reply.send({ ok: true, authUrl });
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/youversion/connection  (auth-required)
  // Drops stored tokens. Best-effort revoke is intentionally NOT attempted:
  // no YouVersion token-revoke endpoint is documented (⚠️ must-confirm U1). We
  // delete our own copy so it can no longer be used, which is what the user
  // asked for; a provider-side revoke is wired only once an endpoint exists.
  // -------------------------------------------------------------------------
  app.delete(
    '/v1/youversion/connection',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply) => {
      await connections.delete(request.auth!.userId);
      return reply.send({ ok: true });
    },
  );
}
