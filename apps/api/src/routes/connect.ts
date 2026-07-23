/**
 * OAuth2 connection routes for Google Calendar (issue #22, docs/03 §8.1).
 *
 * Flow:
 *   1. GET /v1/connect/google (auth-required)
 *      → 302 to Google's authorization screen (or JSON { authUrl } for API clients)
 *   2. GET /v1/connect/google/callback (NO auth — this is a Google redirect)
 *      → exchange code → encrypt refresh token → upsert connection → redirect
 *   3. DELETE /v1/connect/google (auth-required)
 *      → revoke the refresh token with Google, then mark connection as 'revoked'
 *   4. GET /v1/connections (auth-required)
 *      → list connections for the current user (never returns tokens)
 *
 * State parameter: an opaque random token (32 bytes, hex) backed by
 * `oauth_states` — NOT a self-contained JWT. Original design used a signed
 * JWT carrying { userId, nonce } directly in the URL, verified statelessly.
 * Live testing against Google's production consent screen showed that value
 * arriving back at our callback truncated to just its recognizable JWT
 * header prefix, while Google's own intermediate consent-continue redirect
 * carried the full value intact — the truncation happens specifically on
 * the final hop back to us, outside anything we can inspect. An opaque
 * token sidesteps that regardless of root cause and is the more
 * conventional OAuth `state` design besides. See
 * migrations/1720300000000_oauth-states.ts.
 *
 * Privacy: the callback only receives an authorization code from Google;
 * the refresh token is encrypted immediately via KmsService before touching
 * the database. No token ever appears in logs or responses.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { isValidIanaTimeZone } from '@kairos/shared-contracts';
import { requireAuth } from '../auth/middleware.js';
import type { ConnectionsRepository } from '../db/repositories/connectionsRepository.js';
import type { UsersRepository } from '../db/repositories/usersRepository.js';
import type { OAuthStatesRepository } from '../db/repositories/oauthStatesRepository.js';
import type { PreferencesRepository } from '../db/repositories/preferencesRepository.js';
import type { GoogleOAuthService } from '../services/calendar/googleOAuthService.js';
import type { GoogleKmsService } from '../services/calendar/googleKmsService.js';
import { revokeGoogleConnection } from '../services/calendar/revokeGoogleConnection.js';

export interface ConnectRoutesDeps {
  oauthService: GoogleOAuthService;
  kmsService: GoogleKmsService;
  connections: ConnectionsRepository;
  users: UsersRepository;
  oauthStates: OAuthStatesRepository;
  /**
   * Preferences store, used to turn calendar reading ON when a user
   * completes the OAuth grant (#299).
   *
   * `calendar_enabled` is the Foundation §8 consent gate that
   * `calendarFreeBusy` reads: a connected user whose flag is `false` gets a
   * `consent_disabled` grid and no free/busy read. `users.timezone`
   * defaults to UTC and `calendar_enabled` defaults similarly out of step
   * with a fresh connect — so a user could approve the Google grant and
   * still see "reading is turned off", with no way in the web UI to turn it
   * back on. Consenting to the OAuth grant *is* the consent to read, so
   * this records it as one.
   *
   * Optional and best-effort by design, mirroring `getCalendarTimeZone`
   * below: a failure here must never fail a connect the user has already
   * approved, and a deploy wiring calendar routes without it still works.
   */
  preferences?: Pick<PreferencesRepository, 'update'>;
  /**
   * Custom URL scheme the iOS app registers (`CFBundleURLTypes`) and
   * passes as `ASWebAuthenticationSession`'s `callbackURLScheme` (issue
   * #124). The final post-processing redirect targets this scheme —
   * `${baseUrl}/connect-success`/`/connect-error` were plain HTTPS paths
   * with no page ever implemented behind them (they 404'd), which also
   * gave `ASWebAuthenticationSession` nothing to detect as a completion
   * signal. Defaults to `kairos`, the scheme actually registered in
   * `apps/ios/Wellspring/Info.plist`.
   */
  mobileCallbackScheme?: string;
  /**
   * Origin of the web app (#195), e.g. `https://app.kairos.example`. The
   * post-OAuth redirect for browser-originated flows targets
   * `${webAppBaseUrl}/connect/callback` instead of the `kairos://` custom
   * scheme, which a browser cannot resolve — the user would land on a dead
   * scheme and see a failure even though the connection succeeded.
   *
   * Wired from `process.env.WEB_APP_BASE_URL` in index.ts rather than read
   * from the environment inside the handler, so tests can inject it.
   *
   * Validated at registration: must parse as an `https://` URL. Anything
   * else (unset, http, garbage) is dropped with a warning and every client
   * falls back to the mobile scheme. This single configured value IS the
   * redirect allowlist — deliberately not a `returnTo` query parameter,
   * which would be an open redirect.
   */
  webAppBaseUrl?: string;
  /**
   * Resolves the IANA time zone of the just-connected calendar, given that
   * connection's refresh token. Wired to
   * `GoogleCalendarClient.getCalendarTimeZone` in index.ts.
   *
   * Why here: `users.timezone` defaults to UTC and nothing ever set it, so
   * every user's "07:00–09:00 local" window was anchored to UTC and gap
   * selection picked the wrong hour of day. Connect time is the natural
   * moment to learn it — it is the first instant we have any calendar
   * access at all, and it costs one request the user is already waiting on.
   *
   * Optional so tests (and any deploy without calendar deps) skip it
   * entirely; a failure here must never fail the connect.
   */
  getCalendarTimeZone?: (refreshToken: string) => Promise<string | undefined>;
}

/** State token lifetime — long enough for a slow user, short enough to limit CSRF window. */
const STATE_TTL_SEC = 600; // 10 minutes

/**
 * Which client started the flow, so the callback knows where to send the
 * user back to (#195). `ios` is the default and preserves the original
 * behavior for any caller that omits `?client=`.
 */
type ConnectClient = 'ios' | 'web';

/** `?client=` → client. Anything unrecognized is treated as iOS, never rejected. */
function parseClient(raw: unknown): ConnectClient {
  return raw === 'web' ? 'web' : 'ios';
}

/**
 * Reads the client back out of a state token.
 *
 * IMPORTANT — this prefix is a ROUTING HINT, NEVER A SECURITY CLAIM. It
 * selects a redirect target and nothing else. The userId comes exclusively
 * from the server-stored `oauth_states` row via `oauthStates.consume(state)`;
 * no identity, authorization, or trust decision reads this prefix.
 *
 * Tamper properties: `consume()` looks up the WHOLE state string, prefix
 * included, so the prefix is covered by the same single-use lookup as the
 * random part. Alter one character of it and the row simply isn't found —
 * the request dies on the invalid-state 400 before any redirect is built.
 * An attacker therefore cannot re-point someone else's in-flight connect at
 * a different return target: doing so invalidates the token instead. The
 * only state values that reach a redirect are ones we minted ourselves.
 */
function clientFromState(state: string | undefined): ConnectClient {
  return state?.startsWith('web.') ? 'web' : 'ios';
}

/**
 * Validates `WEB_APP_BASE_URL` once, at route registration.
 *
 * Fail-closed: only a well-formed `https://` origin is accepted. Unset,
 * `http://`, or unparseable all return undefined, which makes every client
 * fall back to the mobile scheme — we never redirect to a malformed target
 * or interpolate `undefined` into a URL.
 */
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

export function registerConnectRoutes(app: FastifyInstance, deps: ConnectRoutesDeps): void {
  const { oauthService, kmsService, connections, users, oauthStates } = deps;
  const mobileScheme = deps.mobileCallbackScheme ?? 'kairos';
  const mobileCallbackBase = `${mobileScheme}://connect-callback`;

  const webAppBaseUrl = validateWebAppBaseUrl(deps.webAppBaseUrl);
  if (deps.webAppBaseUrl && !webAppBaseUrl) {
    app.log.warn(
      'connect: WEB_APP_BASE_URL is set but is not a valid https:// URL — ' +
        'web OAuth callbacks will fall back to the mobile scheme',
    );
  }

  /**
   * Where the callback sends the user when the flow ends (success or denied).
   * `web` only wins when a validated HTTPS base exists; otherwise everything
   * degrades to the mobile scheme rather than to a broken URL.
   */
  function returnBaseFor(client: ConnectClient, log: FastifyRequest['log']): string {
    if (client === 'web') {
      if (webAppBaseUrl) return `${webAppBaseUrl}/connect/callback`;
      log.warn(
        'connect: web client finished OAuth but WEB_APP_BASE_URL is unset or invalid — ' +
          'falling back to the mobile scheme',
      );
    }
    return mobileCallbackBase;
  }

  // -------------------------------------------------------------------------
  // GET /v1/connect/google/callback  (NO auth — registered first, outside preHandler)
  // Google redirects here after user grants/denies.
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: { code?: string; state?: string; error?: string };
  }>('/v1/connect/google/callback', async (request, reply) => {
    const { code, state, error } = request.query;

    // User denied the authorization request. Routed per-client too — a web
    // user who clicks Deny must land back in the web app, not on a scheme
    // their browser cannot resolve. No state is consumed on this path (there
    // is nothing to authorize), so the prefix is the only signal available,
    // and it is doing nothing more than picking an error page.
    if (error) {
      const deniedBase = returnBaseFor(clientFromState(state), request.log);
      return reply.redirect(`${deniedBase}?status=error&reason=denied`);
    }

    if (!state) {
      return badRequest(reply, 'Missing state parameter');
    }

    // Atomically claim the state token — rejects unknown, expired, and
    // already-consumed (replayed) tokens identically.
    const claimed = await oauthStates.consume(state);
    if (!claimed) {
      return badRequest(reply, 'Invalid or expired state parameter');
    }
    const userId = claimed.userId;

    if (!code) {
      return badRequest(reply, 'Missing authorization code');
    }

    // Verify the user still exists (defensive — a state token could outlive
    // a deleted account within its 10-minute TTL).
    const user = await users.findById(userId as import('../db/repositories/types.js').VerifiedUserId);
    if (!user) {
      return badRequest(reply, 'User not found');
    }

    // Exchange the authorization code for tokens.
    let refreshToken: string;
    let scopes: string[];
    try {
      const exchanged = await oauthService.exchangeCode(code);
      refreshToken = exchanged.refreshToken;
      scopes = exchanged.scopes;
    } catch (err) {
      request.log.error({ err }, 'Google OAuth code exchange failed');
      return internalError(reply, 'OAuth code exchange failed');
    }

    // Encrypt the refresh token immediately before any DB write.
    let ciphertext: Buffer;
    let keyVersion: string;
    try {
      ({ ciphertext, keyVersion } = await kmsService.encryptToken(refreshToken));
    } catch (err) {
      request.log.error({ err }, 'KMS encrypt failed');
      return internalError(reply, 'Failed to securely store credentials');
    }

    // Upsert the connection row — encrypted token only, never plaintext.
    await connections.upsert(
      userId as import('../db/repositories/types.js').VerifiedUserId,
      {
        provider: 'google_calendar',
        encryptedRefreshToken: ciphertext,
        // MVP: no local AES-GCM layer — iv and auth_tag hold empty buffers.
        encryptionIv: Buffer.alloc(12),
        encryptionAuthTag: Buffer.alloc(16),
        kmsKeyVersion: keyVersion,
        scopes,
      },
    );

    // Turn calendar reading ON (#299). The OAuth grant the user just
    // completed *is* the act of consenting to a free/busy read, but the
    // `calendar_enabled` gate that `calendarFreeBusy` checks is a separate
    // column that a connect never touched — so a user could approve Google
    // and still land on a "reading is turned off" grid with no web switch
    // to flip. Recording the consent here is what keeps the connect and the
    // read in agreement.
    //
    // Best-effort, like the time-zone adoption below: a failure must not
    // fail a connect the user has already approved. The gate is fail-open
    // in the readers (`calendar_enabled ?? true`), so the stored default
    // still permits reading; this only repairs an explicitly-false flag.
    if (deps.preferences) {
      try {
        await deps.preferences.update(
          userId as import('../db/repositories/types.js').VerifiedUserId,
          { calendar_enabled: true },
        );
      } catch (err) {
        request.log.warn(
          { err, userId },
          'connect: could not enable calendar reading after connect — keeping stored value',
        );
      }
    }

    // Learn the user's real time zone from the calendar they just connected
    // and persist it on `users`. Everything downstream that means "their
    // morning" — gap selection, active_days, sabbath_day, the daily run —
    // reads `users.timezone`, which defaults to UTC and was never populated
    // by anything until now.
    //
    // Best-effort by design: wrapped so a failure cannot break a connect the
    // user has already consented to. On failure the stored default stands
    // and the next daily run can try again.
    if (deps.getCalendarTimeZone) {
      try {
        const timezone = await deps.getCalendarTimeZone(refreshToken);
        // `adoptTimezone` (not `updateProfile`) since #187: it enforces
        // the source precedence, so connecting a calendar can no longer
        // silently overwrite a zone the user picked by hand. It also
        // no-ops when the value is already what we'd write, which is why
        // the old `timezone !== user.timezone` guard is gone from here.
        //
        // The validity check is not paranoia about Google so much as
        // about what happens downstream: an unrecognized identifier makes
        // luxon return an *invalid* DateTime rather than throwing, so a
        // bad zone stored here surfaces as a devotional at a nonsense
        // hour, far from this line.
        if (timezone && isValidIanaTimeZone(timezone)) {
          const updated = await users.adoptTimezone(
            userId as import('../db/repositories/types.js').VerifiedUserId,
            timezone,
            'calendar',
          );
          if (updated) {
            request.log.info({ userId, timezone }, 'connect: adopted calendar time zone');
          }
        } else if (timezone) {
          request.log.warn(
            { userId, timezone },
            'connect: calendar reported a non-IANA time zone — keeping stored value',
          );
        }
      } catch (err) {
        request.log.warn(
          { err, userId },
          'connect: could not read calendar time zone — keeping stored value',
        );
      }
    }

    const acceptHeader = request.headers.accept ?? '';
    if (acceptHeader.includes('application/json')) {
      return reply.send({ ok: true, message: 'Google Calendar connected' });
    }
    // `state` survived `consume()` above, so it is a token we minted — the
    // prefix on it is ours, not something a caller supplied.
    const successBase = returnBaseFor(clientFromState(state), request.log);
    return reply.redirect(`${successBase}?status=success`);
  });

  // -------------------------------------------------------------------------
  // GET /v1/connect/google  (auth-required)
  // Initiates the OAuth flow by redirecting to Google's authorization screen.
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { client?: string } }>(
    '/v1/connect/google',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;

      // Opaque random state token binding this auth attempt to the userId —
      // the actual claims live server-side in oauth_states, not in the URL.
      //
      // Prefixed with the originating client (#195) so the callback knows
      // whether to return to the iOS custom scheme or the web app. The whole
      // prefixed string is what gets stored and later consumed, so the prefix
      // inherits the token's single-use, tamper-evident properties — see
      // clientFromState(). It carries no authority of its own.
      const client = parseClient(request.query.client);
      const state = `${client}.${randomBytes(32).toString('hex')}`;
      const nonce = randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + STATE_TTL_SEC * 1000);
      await oauthStates.create(state, userId, nonce, expiresAt);

      const authUrl = oauthService.getAuthorizationUrl({ state });

      const acceptHeader = request.headers.accept ?? '';
      if (acceptHeader.includes('application/json')) {
        return reply.send({ ok: true, authUrl });
      }
      return reply.redirect(authUrl);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/connect/google  (auth-required)
  // Revokes the refresh token with Google (issue #81, docs/04 §2), then
  // marks the connection as revoked locally.
  // -------------------------------------------------------------------------
  app.delete('/v1/connect/google', { preHandler: requireAuth }, async (request, reply) => {
    await revokeGoogleConnection({ connections, kmsService, oauthService }, request.auth!.userId, request.log);
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /v1/connections  (auth-required)
  // Lists connections for the current user — never returns tokens.
  // -------------------------------------------------------------------------
  app.get('/v1/connections', { preHandler: requireAuth }, async (request) => {
    const rows = await connections.listForUser(request.auth!.userId);
    return {
      ok: true,
      connections: rows.map((c) => ({
        provider: c.provider,
        status: c.status,
        connectedAt: c.connected_at,
        scopes: c.scopes,
      })),
    };
  });
}
