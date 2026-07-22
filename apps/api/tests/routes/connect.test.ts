/**
 * Unit tests for the Google Calendar OAuth connect routes (issue #22).
 *
 * Tests:
 *   - Opaque state token is created and passed to oauthService.getAuthorizationUrl
 *   - Callback consumes the state token, exchanges code, stores encrypted token
 *   - Callback rejects missing/unknown/expired/already-consumed state
 *   - Callback handles user-denied (error query param)
 *   - DELETE /v1/connect/google revokes the connection
 *   - GET /v1/connections lists connections (never tokens)
 *   - Per-client return target (#195): state prefix routes the callback to the
 *     web app or the iOS scheme, WEB_APP_BASE_URL is validated, and a tampered
 *     prefix cannot reach a redirect
 */

import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerConnectRoutes, type ConnectRoutesDeps } from '../../src/routes/connect.js';
import type { GoogleOAuthService } from '../../src/services/calendar/googleOAuthService.js';
import type { GoogleKmsService } from '../../src/services/calendar/googleKmsService.js';
import type { ConnectionsRepository } from '../../src/db/repositories/connectionsRepository.js';
import type { UsersRepository } from '../../src/db/repositories/usersRepository.js';
import type { OAuthStatesRepository } from '../../src/db/repositories/oauthStatesRepository.js';
import type { AuthContext } from '../../src/auth/middleware.js';
import { asVerifiedUserId } from '../../src/db/repositories/types.js';

const FAKE_USER_ID = asVerifiedUserId('00000000-0000-0000-0000-000000000001');

function fakeOAuthService(overrides: Partial<GoogleOAuthService> = {}): GoogleOAuthService {
  return {
    getAuthorizationUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?fake=1'),
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: 'access-123',
      refreshToken: 'refresh-abc',
      expiryDate: Date.now() + 3_600_000,
      scopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
    }),
    revokeToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GoogleOAuthService;
}

function fakeKmsService(overrides: Partial<GoogleKmsService> = {}): GoogleKmsService {
  return {
    encryptToken: vi.fn().mockResolvedValue({
      ciphertext: Buffer.from('encrypted'),
      keyVersion: 'projects/test/keyRings/k/cryptoKeys/k/cryptoKeyVersions/1',
    }),
    decryptToken: vi.fn().mockResolvedValue('refresh-abc'),
    ...overrides,
  } as unknown as GoogleKmsService;
}

function fakeConnections(overrides: Partial<ConnectionsRepository> = {}): ConnectionsRepository {
  return {
    upsert: vi.fn().mockResolvedValue({}),
    revoke: vi.fn().mockResolvedValue(undefined),
    listForUser: vi.fn().mockResolvedValue([
      {
        provider: 'google_calendar',
        status: 'active',
        connected_at: new Date('2026-07-01T00:00:00Z'),
        scopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
      },
    ]),
    findByProvider: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as ConnectionsRepository;
}

function fakeUsers(overrides: Partial<UsersRepository> = {}): UsersRepository {
  return {
    findById: vi.fn().mockResolvedValue({
      id: FAKE_USER_ID,
      email: 'user@test.com',
    }),
    findOrCreateByFirebaseUid: vi.fn().mockResolvedValue({ id: FAKE_USER_ID }),
    ...overrides,
  } as unknown as UsersRepository;
}

/**
 * In-memory stand-in for OAuthStatesRepository. Mirrors the real single-use,
 * expiry-checked `consume` semantics (migrations/1720300000000_oauth-states.ts)
 * without touching Postgres.
 */
class FakeOAuthStatesRepository {
  private rows = new Map<
    string,
    { userId: string; nonce: string; expiresAt: Date; consumedAt: Date | null }
  >();

  create = vi.fn(async (token: string, userId: string, nonce: string, expiresAt: Date) => {
    this.rows.set(token, { userId, nonce, expiresAt, consumedAt: null });
  });

  consume = vi.fn(async (token: string) => {
    const row = this.rows.get(token);
    if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    row.consumedAt = new Date();
    return { userId: row.userId };
  });

  /** Test helper: pre-populate a row as if `create` had already run. */
  seed(token: string, userId: string, opts: { expiresAt?: Date; consumed?: boolean } = {}): void {
    this.rows.set(token, {
      userId,
      nonce: 'test-nonce',
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 600_000),
      consumedAt: opts.consumed ? new Date() : null,
    });
  }
}

function fakeOAuthStates(): FakeOAuthStatesRepository {
  return new FakeOAuthStatesRepository();
}

/** Build a test app with fake auth already set (simulates a verified Firebase token). */
function buildTestApp(deps: Partial<ConnectRoutesDeps> = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // Inject a fake auth context on every request (simulates the real onRequest hook)
  app.decorateRequest('auth', undefined);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      userId: FAKE_USER_ID,
      firebaseUid: 'firebase-uid-abc',
      email: 'user@test.com',
    } as AuthContext;
  });

  registerConnectRoutes(app, {
    oauthService: fakeOAuthService(),
    kmsService: fakeKmsService(),
    connections: fakeConnections(),
    users: fakeUsers(),
    oauthStates: fakeOAuthStates() as unknown as OAuthStatesRepository,
    ...deps,
  });

  return app;
}

// ---------------------------------------------------------------------------
// GET /v1/connect/google
// ---------------------------------------------------------------------------

describe('GET /v1/connect/google', () => {
  it('redirects to Google authorization URL', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/connect/google' });
    expect([301, 302]).toContain(res.statusCode);
    expect(res.headers.location).toContain('accounts.google.com');
    await app.close();
  });

  it('returns JSON authUrl when Accept: application/json', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/connect/google',
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; authUrl: string }>();
    expect(body.ok).toBe(true);
    expect(body.authUrl).toContain('accounts.google.com');
    await app.close();
  });

  it('creates an opaque state token and passes it to oauthService.getAuthorizationUrl', async () => {
    const oauthService = fakeOAuthService();
    const oauthStates = fakeOAuthStates();
    const app = buildTestApp({
      oauthService,
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
    });

    await app.inject({
      method: 'GET',
      url: '/v1/connect/google',
      headers: { accept: 'application/json' },
    });

    expect(oauthService.getAuthorizationUrl).toHaveBeenCalledOnce();
    const { state } = (oauthService.getAuthorizationUrl as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { state: string };

    // Opaque random token — 32 bytes hex — not a structured/self-contained
    // value. Prefixed with the originating client (#195); `ios` is the
    // default when `?client=` is absent, preserving the original behavior.
    expect(state).toMatch(/^ios\.[0-9a-f]{64}$/);
    expect(oauthStates.create).toHaveBeenCalledWith(
      state,
      FAKE_USER_ID,
      expect.any(String),
      expect.any(Date),
    );

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/connect/google/callback
// ---------------------------------------------------------------------------

describe('GET /v1/connect/google/callback', () => {
  it('redirects to the mobile callback scheme (kairos://connect-callback?status=success) and stores connection on happy path (issue #124)', async () => {
    const connections = fakeConnections();
    const kmsService = fakeKmsService();
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('valid-token', FAKE_USER_ID);
    const app = buildTestApp({
      connections,
      kmsService,
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=auth-code-xyz&state=valid-token`,
    });

    expect([301, 302]).toContain(res.statusCode);
    expect(res.headers.location).toBe('kairos://connect-callback?status=success');

    // KMS encrypt was called
    expect(kmsService.encryptToken).toHaveBeenCalledWith('refresh-abc');

    // Connection was upserted with encrypted token, never plaintext
    expect(connections.upsert).toHaveBeenCalledOnce();
    const upsertCall = (connections.upsert as ReturnType<typeof vi.fn>).mock.calls[0];
    const [calledUserId, input] = upsertCall as [string, { encryptedRefreshToken: Buffer }];
    expect(calledUserId).toBe(FAKE_USER_ID);
    expect(input.encryptedRefreshToken).toEqual(Buffer.from('encrypted'));

    await app.close();
  });

  it('adopts the connected calendar time zone onto the user (fixes UTC-anchored gap selection)', async () => {
    const users = fakeUsers({
      findById: vi.fn().mockResolvedValue({
        id: FAKE_USER_ID,
        email: 'user@test.com',
        timezone: 'UTC',
      }),
      adoptTimezone: vi.fn().mockResolvedValue({ timezone: 'America/New_York' }),
    } as Partial<UsersRepository>);
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('valid-token', FAKE_USER_ID);
    const getCalendarTimeZone = vi.fn().mockResolvedValue('America/New_York');

    const app = buildTestApp({
      users,
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
      getCalendarTimeZone,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=auth-code-xyz&state=valid-token`,
    });

    expect([301, 302]).toContain(res.statusCode);
    // Resolved using the plaintext refresh token from the exchange...
    expect(getCalendarTimeZone).toHaveBeenCalledWith('refresh-abc');
    // ...and persisted onto the user as a `calendar`-sourced zone (issue
    // #187) — via adoptTimezone, so the write is subject to precedence
    // and cannot clobber a zone the user set by hand.
    expect(users.adoptTimezone).toHaveBeenCalledWith(
      FAKE_USER_ID,
      'America/New_York',
      'calendar',
    );

    await app.close();
  });

  /**
   * Issue #187: a bad zone doesn't fail loudly downstream — luxon returns
   * an *invalid* DateTime rather than throwing — so it has to be refused
   * at the door, not stored and discovered later as a devotional at a
   * nonsense hour.
   */
  it('refuses a calendar zone that is not a real IANA identifier', async () => {
    const users = fakeUsers({
      findById: vi.fn().mockResolvedValue({ id: FAKE_USER_ID, email: 'user@test.com', timezone: 'UTC' }),
      adoptTimezone: vi.fn().mockResolvedValue(null),
    } as Partial<UsersRepository>);
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('valid-token', FAKE_USER_ID);

    const app = buildTestApp({
      users,
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
      getCalendarTimeZone: vi.fn().mockResolvedValue('Mars/Olympus_Mons'),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=auth-code-xyz&state=valid-token`,
    });

    // The connect itself still succeeds — the zone is best-effort side work.
    expect([301, 302]).toContain(res.statusCode);
    expect(users.adoptTimezone).not.toHaveBeenCalled();
    await app.close();
  });

  it('completes the connect even when the time zone write is outranked (adoptTimezone returns null)', async () => {
    const users = fakeUsers({
      findById: vi.fn().mockResolvedValue({ id: FAKE_USER_ID, email: 'user@test.com', timezone: 'Europe/Berlin' }),
      // null = an explicit user choice already owns the field, or the
      // stored value is already identical.
      adoptTimezone: vi.fn().mockResolvedValue(null),
    } as Partial<UsersRepository>);
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('valid-token', FAKE_USER_ID);

    const app = buildTestApp({
      users,
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
      getCalendarTimeZone: vi.fn().mockResolvedValue('America/New_York'),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=auth-code-xyz&state=valid-token`,
    });

    expect([301, 302]).toContain(res.statusCode);
    await app.close();
  });

  it('still completes the connect when the time-zone lookup fails (best-effort, never fatal)', async () => {
    const connections = fakeConnections();
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('valid-token', FAKE_USER_ID);

    const app = buildTestApp({
      connections,
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
      getCalendarTimeZone: vi.fn().mockRejectedValue(new Error('calendar API down')),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=auth-code-xyz&state=valid-token`,
    });

    // The connection the user consented to is still stored and the flow completes.
    expect([301, 302]).toContain(res.statusCode);
    expect(res.headers.location).toBe('kairos://connect-callback?status=success');
    expect(connections.upsert).toHaveBeenCalledOnce();

    await app.close();
  });

  it('returns JSON on Accept: application/json', async () => {
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('valid-token', FAKE_USER_ID);
    const app = buildTestApp({ oauthStates: oauthStates as unknown as OAuthStatesRepository });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=code&state=valid-token`,
      headers: { accept: 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    await app.close();
  });

  it('redirects to the mobile callback scheme (kairos://connect-callback?status=error) when the error query param is set (user denied, issue #124)', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/connect/google/callback?error=access_denied&state=irrelevant',
    });
    expect([301, 302]).toContain(res.statusCode);
    expect(res.headers.location).toBe('kairos://connect-callback?status=error&reason=denied');
    await app.close();
  });

  it('400s when state parameter is missing', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/connect/google/callback?code=xyz',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s when state token is unknown', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=xyz&state=never-issued-token`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s when state token is expired', async () => {
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('expired-token', FAKE_USER_ID, { expiresAt: new Date(Date.now() - 1000) });
    const app = buildTestApp({ oauthStates: oauthStates as unknown as OAuthStatesRepository });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=xyz&state=expired-token`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s when state token has already been consumed (replay)', async () => {
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('used-token', FAKE_USER_ID, { consumed: true });
    const app = buildTestApp({ oauthStates: oauthStates as unknown as OAuthStatesRepository });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=xyz&state=used-token`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s when code is missing but state is valid', async () => {
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('valid-token', FAKE_USER_ID);
    const app = buildTestApp({ oauthStates: oauthStates as unknown as OAuthStatesRepository });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?state=valid-token`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s when user does not exist', async () => {
    const users = fakeUsers({ findById: vi.fn().mockResolvedValue(null) });
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('valid-token', FAKE_USER_ID);
    const app = buildTestApp({
      users,
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=xyz&state=valid-token`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('500s when OAuth code exchange fails', async () => {
    const oauthService = fakeOAuthService({
      exchangeCode: vi.fn().mockRejectedValue(new Error('Google token endpoint unavailable')),
    });
    const oauthStates = fakeOAuthStates();
    oauthStates.seed('valid-token', FAKE_USER_ID);
    const app = buildTestApp({
      oauthService,
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/connect/google/callback?code=bad-code&state=valid-token`,
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/connect/google
// ---------------------------------------------------------------------------

describe('DELETE /v1/connect/google', () => {
  it('revokes the token with Google, decrypts via KMS, then marks the connection revoked (issue #81)', async () => {
    const connections = fakeConnections({
      findByProvider: vi.fn().mockResolvedValue({
        provider: 'google_calendar',
        status: 'active',
        encrypted_refresh_token: Buffer.from('ciphertext'),
      }),
    });
    const kmsService = fakeKmsService();
    const oauthService = fakeOAuthService({ revokeToken: vi.fn().mockResolvedValue(undefined) });
    const app = buildTestApp({ connections, kmsService, oauthService });

    const res = await app.inject({ method: 'DELETE', url: '/v1/connect/google' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    expect(kmsService.decryptToken).toHaveBeenCalledWith(Buffer.from('ciphertext'));
    expect(oauthService.revokeToken).toHaveBeenCalledWith('refresh-abc');
    expect(connections.revoke).toHaveBeenCalledWith(FAKE_USER_ID, 'google_calendar');
    await app.close();
  });

  it('still marks the connection revoked locally even if the Google revoke call fails', async () => {
    const connections = fakeConnections({
      findByProvider: vi.fn().mockResolvedValue({
        provider: 'google_calendar',
        status: 'active',
        encrypted_refresh_token: Buffer.from('ciphertext'),
      }),
    });
    const oauthService = fakeOAuthService({
      revokeToken: vi.fn().mockRejectedValue(new Error('Google is down')),
    });
    const app = buildTestApp({ connections, oauthService });

    const res = await app.inject({ method: 'DELETE', url: '/v1/connect/google' });
    expect(res.statusCode).toBe(200);
    expect(connections.revoke).toHaveBeenCalledWith(FAKE_USER_ID, 'google_calendar');
    await app.close();
  });

  it('is a no-op (no Google call, no local revoke) when there is no active connection', async () => {
    const connections = fakeConnections(); // findByProvider defaults to null
    const oauthService = fakeOAuthService();
    const app = buildTestApp({ connections, oauthService });

    const res = await app.inject({ method: 'DELETE', url: '/v1/connect/google' });
    expect(res.statusCode).toBe(200);
    expect(oauthService.revokeToken).not.toHaveBeenCalled();
    expect(connections.revoke).not.toHaveBeenCalled();
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/connections
// ---------------------------------------------------------------------------

describe('GET /v1/connections', () => {
  it('returns connections list without tokens', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/connections' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      ok: boolean;
      connections: Array<{ provider: string; status: string }>;
    }>();
    expect(body.ok).toBe(true);
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]!.provider).toBe('google_calendar');
    expect(body.connections[0]!.status).toBe('active');

    // Must not expose encrypted token or any key material
    const conn = body.connections[0] as Record<string, unknown>;
    expect(conn['encrypted_refresh_token']).toBeUndefined();
    expect(conn['kms_key_version']).toBeUndefined();
    expect(conn['encryptedRefreshToken']).toBeUndefined();
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Per-client OAuth return target (#195)
//
// A browser cannot follow `kairos://`, so a web-originated connect has to come
// back to the web app. The originating client is carried as a prefix on the
// state token (`web.<hex>` / `ios.<hex>`), read back at the callback purely to
// pick a redirect target.
//
// The security line these tests defend: the prefix is a ROUTING HINT, NEVER A
// SECURITY CLAIM. It never contributes to identity, and because `consume()`
// matches the whole state string, a tampered prefix cannot reach a redirect at
// all — it fails the lookup and 400s like any other bad state.
// ---------------------------------------------------------------------------

const WEB_BASE = 'https://app.kairos.test';

describe('OAuth return target per client (#195)', () => {
  describe('state minting', () => {
    it('prefixes the state with `web.` when ?client=web', async () => {
      const oauthService = fakeOAuthService();
      const app = buildTestApp({ oauthService, webAppBaseUrl: WEB_BASE });

      await app.inject({
        method: 'GET',
        url: '/v1/connect/google?client=web',
        headers: { accept: 'application/json' },
      });

      const { state } = (oauthService.getAuthorizationUrl as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as { state: string };
      expect(state).toMatch(/^web\.[0-9a-f]{64}$/);
      await app.close();
    });

    it('prefixes the state with `ios.` for ?client=ios, an unknown client, and an absent one', async () => {
      for (const query of ['?client=ios', '?client=android', '?client=', '']) {
        const oauthService = fakeOAuthService();
        const app = buildTestApp({ oauthService, webAppBaseUrl: WEB_BASE });

        await app.inject({
          method: 'GET',
          url: `/v1/connect/google${query}`,
          headers: { accept: 'application/json' },
        });

        const { state } = (oauthService.getAuthorizationUrl as ReturnType<typeof vi.fn>).mock
          .calls[0][0] as { state: string };
        expect(state, `client query: "${query}"`).toMatch(/^ios\.[0-9a-f]{64}$/);
        await app.close();
      }
    });
  });

  describe('success redirect', () => {
    it('sends a web-originated flow to the configured HTTPS URL', async () => {
      const oauthStates = fakeOAuthStates();
      oauthStates.seed('web.abc123', FAKE_USER_ID);
      const app = buildTestApp({
        oauthStates: oauthStates as unknown as OAuthStatesRepository,
        webAppBaseUrl: WEB_BASE,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?code=auth-code&state=web.abc123',
      });

      expect([301, 302]).toContain(res.statusCode);
      expect(res.headers.location).toBe('https://app.kairos.test/connect/callback?status=success');
      await app.close();
    });

    it('leaves an iOS-originated flow on the mobile scheme even when a web base is configured', async () => {
      const oauthStates = fakeOAuthStates();
      oauthStates.seed('ios.abc123', FAKE_USER_ID);
      const app = buildTestApp({
        oauthStates: oauthStates as unknown as OAuthStatesRepository,
        webAppBaseUrl: WEB_BASE,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?code=auth-code&state=ios.abc123',
      });

      expect(res.headers.location).toBe('kairos://connect-callback?status=success');
      await app.close();
    });

    it('treats an unprefixed state as iOS (pre-#195 tokens still in flight)', async () => {
      const oauthStates = fakeOAuthStates();
      oauthStates.seed('legacy-token', FAKE_USER_ID);
      const app = buildTestApp({
        oauthStates: oauthStates as unknown as OAuthStatesRepository,
        webAppBaseUrl: WEB_BASE,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?code=auth-code&state=legacy-token',
      });

      expect(res.headers.location).toBe('kairos://connect-callback?status=success');
      await app.close();
    });
  });

  describe('WEB_APP_BASE_URL validation', () => {
    it('falls back to the mobile scheme when unset — never redirects to "undefined"', async () => {
      const oauthStates = fakeOAuthStates();
      oauthStates.seed('web.abc123', FAKE_USER_ID);
      const app = buildTestApp({
        oauthStates: oauthStates as unknown as OAuthStatesRepository,
        // webAppBaseUrl deliberately omitted
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?code=auth-code&state=web.abc123',
      });

      expect([301, 302]).toContain(res.statusCode);
      expect(res.headers.location).toBe('kairos://connect-callback?status=success');
      expect(res.headers.location).not.toContain('undefined');
      await app.close();
    });

    it('rejects a non-https base and falls back to the mobile scheme', async () => {
      for (const bad of [
        'http://app.kairos.test',
        'ftp://app.kairos.test',
        'javascript:alert(1)',
        'app.kairos.test',
        'not a url',
        '',
      ]) {
        const oauthStates = fakeOAuthStates();
        oauthStates.seed('web.abc123', FAKE_USER_ID);
        const app = buildTestApp({
          oauthStates: oauthStates as unknown as OAuthStatesRepository,
          webAppBaseUrl: bad,
        });

        const res = await app.inject({
          method: 'GET',
          url: '/v1/connect/google/callback?code=auth-code&state=web.abc123',
        });

        expect(res.headers.location, `base: "${bad}"`).toBe(
          'kairos://connect-callback?status=success',
        );
        await app.close();
      }
    });

    it('normalizes a trailing slash rather than emitting a double slash', async () => {
      const oauthStates = fakeOAuthStates();
      oauthStates.seed('web.abc123', FAKE_USER_ID);
      const app = buildTestApp({
        oauthStates: oauthStates as unknown as OAuthStatesRepository,
        webAppBaseUrl: 'https://app.kairos.test/',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?code=auth-code&state=web.abc123',
      });

      expect(res.headers.location).toBe('https://app.kairos.test/connect/callback?status=success');
      await app.close();
    });

    it('ignores a returnTo query parameter — the configured URL is the whole allowlist', async () => {
      const oauthStates = fakeOAuthStates();
      oauthStates.seed('web.abc123', FAKE_USER_ID);
      const app = buildTestApp({
        oauthStates: oauthStates as unknown as OAuthStatesRepository,
        webAppBaseUrl: WEB_BASE,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?code=auth-code&state=web.abc123&returnTo=https%3A%2F%2Fevil.test',
      });

      expect(res.headers.location).toBe('https://app.kairos.test/connect/callback?status=success');
      expect(res.headers.location).not.toContain('evil.test');
      await app.close();
    });
  });

  describe('tampered prefix', () => {
    it('never reaches a redirect — consume() matches the whole state, so a forged prefix 400s', async () => {
      const oauthStates = fakeOAuthStates();
      // A real iOS flow is in progress.
      oauthStates.seed('ios.abc123', FAKE_USER_ID);
      const app = buildTestApp({
        oauthStates: oauthStates as unknown as OAuthStatesRepository,
        webAppBaseUrl: WEB_BASE,
      });

      // Attacker flips the prefix to re-point the return target at the web app.
      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?code=auth-code&state=web.abc123',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_ARGUMENT');
      // No redirect of any kind was issued.
      expect(res.headers.location).toBeUndefined();
      // The genuine token was not consumed as a side effect.
      expect(await oauthStates.consume('ios.abc123')).toEqual({ userId: FAKE_USER_ID });
      await app.close();
    });

    it('rejects a prefix added to an unprefixed token just the same', async () => {
      const oauthStates = fakeOAuthStates();
      oauthStates.seed('abc123', FAKE_USER_ID);
      const app = buildTestApp({
        oauthStates: oauthStates as unknown as OAuthStatesRepository,
        webAppBaseUrl: WEB_BASE,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?code=auth-code&state=web.abc123',
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
      await app.close();
    });
  });

  describe('denied redirect', () => {
    it('returns a web user to the web app', async () => {
      const app = buildTestApp({ webAppBaseUrl: WEB_BASE });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?error=access_denied&state=web.abc123',
      });

      expect([301, 302]).toContain(res.statusCode);
      expect(res.headers.location).toBe(
        'https://app.kairos.test/connect/callback?status=error&reason=denied',
      );
      await app.close();
    });

    it('returns an iOS user to the mobile scheme', async () => {
      const app = buildTestApp({ webAppBaseUrl: WEB_BASE });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?error=access_denied&state=ios.abc123',
      });

      expect(res.headers.location).toBe('kairos://connect-callback?status=error&reason=denied');
      await app.close();
    });

    it('falls back to the mobile scheme for a web denial when no valid base is configured', async () => {
      const app = buildTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/v1/connect/google/callback?error=access_denied&state=web.abc123',
      });

      expect(res.headers.location).toBe('kairos://connect-callback?status=error&reason=denied');
      expect(res.headers.location).not.toContain('undefined');
      await app.close();
    });
  });
});
