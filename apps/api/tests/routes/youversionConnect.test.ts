/**
 * Unit tests for the YouVersion account-connection OAuth routes (U2,
 * kairos-devotional#355).
 *
 * Fakes only — no live YouVersion (that is owner-gated, U1). The step-2
 * code-resolution (/auth/callback) and step-3 token (/auth/token) HTTP
 * endpoints are faked via an injected `fetchImpl`; the real
 * `YouVersionOAuthService` is used so the authorize-URL / PKCE / resolve /
 * exchange behavior under test is the production code, not a stub of it.
 *
 * YouVersion's flow is NON-STANDARD: the authorize redirect carries the
 * signed-in identity ({ yvp_id, user_name, … }), NOT a code. A second server
 * call (/auth/callback) resolves that into a code via a 302 Location header,
 * then /auth/token exchanges the code for tokens.
 *
 * Covers:
 *   - connect returns an api.youversion.com authorize URL carrying state +
 *     code_challenge (mutation-check: the URL MUST include code_challenge, so
 *     removing it from getAuthorizationUrl fails this test)
 *   - connect stores the state + PKCE verifier server-side keyed to the user
 *   - callback resolves the code (reads it off the 302 Location without
 *     following), exchanges it, and validates the returned state matches
 *   - callback rejects missing / unknown / expired / replayed state
 *   - tokens persist ENCRYPTED (stored ciphertext != plaintext; the encrypt
 *     call is asserted invoked)
 *   - identity (yvp_id + user_name) is captured from the redirect, no profile fetch
 *   - a null refresh token is stored as null, not thrown
 *   - disconnect deletes the row
 *   - the not-configured 503 path (no OAuth service / no KMS)
 */

import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  registerYouVersionConnectRoutes,
  type YouVersionConnectRoutesDeps,
} from '../../src/routes/youversionConnect.js';
import {
  YouVersionOAuthService,
  type FetchLike,
} from '../../src/services/youversion/youVersionOAuthService.js';
import type { GoogleKmsService } from '../../src/services/calendar/googleKmsService.js';
import type { YouVersionConnectionsRepository } from '../../src/db/repositories/youversionConnectionsRepository.js';
import type { UsersRepository } from '../../src/db/repositories/usersRepository.js';
import type { OAuthStatesRepository } from '../../src/db/repositories/oauthStatesRepository.js';
import type { AuthContext } from '../../src/auth/middleware.js';
import { asVerifiedUserId } from '../../src/db/repositories/types.js';

const FAKE_USER_ID = asVerifiedUserId('00000000-0000-0000-0000-000000000001');
const WEB_BASE = 'https://app.kairos.test';

const REDIRECT_URI = 'https://api.kairos.test/v1/youversion/oauth/callback';

/**
 * Small header bag matching the FetchLike contract's
 * `headers.get(name): string | null`.
 */
function headers(map: Record<string, string> = {}) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/**
 * A fake fetch answering the step-2 resolve (/auth/callback) and step-3 token
 * (/auth/token) endpoints. Overridable per-test.
 *
 * `resolve.location` (default: a Location echoing the state back with a code)
 * lets a test forge a mismatched/absent code or state.
 */
function fakeFetch(
  overrides: {
    resolve?: { status?: number; location?: string | null };
    token?: { status?: number; body?: unknown };
  } = {},
): FetchLike {
  return vi.fn(async (input: string) => {
    // Step 2: /auth/callback resolves identity → 302 with a code in Location.
    // (Checked before /auth/token because both live under /auth/.)
    if (input.includes('/auth/callback')) {
      const status = overrides.resolve?.status ?? 302;
      // Default Location: our redirect_uri with a code and the SAME state the
      // caller sent (parsed off the input query so state-match holds).
      let location: string | null;
      if ('location' in (overrides.resolve ?? {})) {
        location = overrides.resolve!.location ?? null;
      } else {
        const inState = new URL(input).searchParams.get('state') ?? '';
        location = `${REDIRECT_URI}?code=resolved-code&scope=openid+profile+email&state=${inState}`;
      }
      return {
        ok: status < 400,
        status,
        headers: headers(location ? { location } : {}),
        json: async () => ({}),
        text: async () => '',
      };
    }
    if (input.includes('/auth/token')) {
      const status = overrides.token?.status ?? 200;
      const body = overrides.token?.body ?? {
        access_token: 'yv-access-token',
        refresh_token: 'yv-refresh-token',
        expires_in: 3600,
        scope: 'openid profile email',
      };
      return {
        ok: status < 400,
        status,
        headers: headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }
    throw new Error(`unexpected fetch to ${input}`);
  }) as unknown as FetchLike;
}

function realOAuthService(fetchImpl: FetchLike): YouVersionOAuthService {
  return new YouVersionOAuthService({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    redirectUri: REDIRECT_URI,
    fetchImpl,
  });
}

function fakeKms(overrides: Partial<GoogleKmsService> = {}): GoogleKmsService {
  return {
    // Ciphertext is deterministically derived from the plaintext so a test can
    // assert the STORED bytes are the encrypted form, never the plaintext.
    encryptToken: vi.fn(async (plaintext: string) => ({
      ciphertext: Buffer.from(`enc:${plaintext}`),
      keyVersion: 'projects/test/cryptoKeyVersions/1',
    })),
    decryptToken: vi.fn(async (ct: Buffer) => ct.toString().replace(/^enc:/, '')),
    ...overrides,
  } as unknown as GoogleKmsService;
}

function fakeConnections(overrides: Partial<YouVersionConnectionsRepository> = {}): YouVersionConnectionsRepository {
  return {
    upsert: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as YouVersionConnectionsRepository;
}

function fakeUsers(overrides: Partial<UsersRepository> = {}): UsersRepository {
  return {
    findById: vi.fn().mockResolvedValue({ id: FAKE_USER_ID, email: 'user@test.com' }),
    ...overrides,
  } as unknown as UsersRepository;
}

/** In-memory OAuth-states store mirroring the real single-use, verifier-carrying semantics. */
class FakeOAuthStatesRepository {
  private rows = new Map<
    string,
    { userId: string; nonce: string; codeVerifier: string | null; expiresAt: Date; consumedAt: Date | null }
  >();

  create = vi.fn(async (token: string, userId: string, nonce: string, expiresAt: Date, codeVerifier?: string) => {
    this.rows.set(token, { userId, nonce, codeVerifier: codeVerifier ?? null, expiresAt, consumedAt: null });
  });

  consume = vi.fn(async (token: string) => {
    const row = this.rows.get(token);
    if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) return null;
    row.consumedAt = new Date();
    return { userId: row.userId, codeVerifier: row.codeVerifier };
  });

  seed(
    token: string,
    userId: string,
    opts: { expiresAt?: Date; consumed?: boolean; codeVerifier?: string | null } = {},
  ): void {
    this.rows.set(token, {
      userId,
      nonce: 'test-nonce',
      codeVerifier: opts.codeVerifier === undefined ? 'test-verifier' : opts.codeVerifier,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 600_000),
      consumedAt: opts.consumed ? new Date() : null,
    });
  }
}

function buildTestApp(deps: Partial<YouVersionConnectRoutesDeps> = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest('auth', undefined);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      userId: FAKE_USER_ID,
      firebaseUid: 'firebase-uid-abc',
      email: 'user@test.com',
    } as AuthContext;
  });

  registerYouVersionConnectRoutes(app, {
    oauthService: realOAuthService(fakeFetch()),
    kmsService: fakeKms(),
    connections: fakeConnections(),
    users: fakeUsers(),
    oauthStates: new FakeOAuthStatesRepository() as unknown as OAuthStatesRepository,
    webAppBaseUrl: WEB_BASE,
    ...deps,
  });
  return app;
}

// ---------------------------------------------------------------------------
// POST /v1/youversion/connect
// ---------------------------------------------------------------------------

describe('POST /v1/youversion/connect', () => {
  it('returns an api.youversion.com authorize URL carrying state and code_challenge (S256)', async () => {
    const oauthStates = new FakeOAuthStatesRepository();
    const app = buildTestApp({ oauthStates: oauthStates as unknown as OAuthStatesRepository });

    const res = await app.inject({ method: 'POST', url: '/v1/youversion/connect' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; authUrl: string }>();
    expect(body.ok).toBe(true);

    const url = new URL(body.authUrl);
    expect(url.origin + url.pathname).toBe('https://api.youversion.com/auth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    // Mutation-check: the flow is not a valid PKCE flow without these. Removing
    // code_challenge / code_challenge_method from getAuthorizationUrl fails here.
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state');
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    // State + PKCE verifier were stored server-side, keyed to the user.
    expect(oauthStates.create).toHaveBeenCalledWith(
      state,
      FAKE_USER_ID,
      expect.any(String),
      expect.any(Date),
      expect.any(String), // the code_verifier
    );
    await app.close();
  });

  it('503s when the OAuth service is not configured (pre-U1)', async () => {
    const app = buildTestApp({ oauthService: undefined });
    const res = await app.inject({ method: 'POST', url: '/v1/youversion/connect' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'YouVersion connection not configured',
    );
    await app.close();
  });

  it('503s when KMS is not configured (cannot store tokens at rest)', async () => {
    const app = buildTestApp({ kmsService: undefined });
    const res = await app.inject({ method: 'POST', url: '/v1/youversion/connect' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/youversion/oauth/callback
// ---------------------------------------------------------------------------

describe('GET /v1/youversion/oauth/callback', () => {
  it('resolves the code, exchanges it, stores ENCRYPTED tokens, and redirects to the web settings page', async () => {
    const oauthStates = new FakeOAuthStatesRepository();
    oauthStates.seed('valid-state', FAKE_USER_ID, { codeVerifier: 'the-verifier' });
    const kmsService = fakeKms();
    const connections = fakeConnections();
    const fetchImpl = fakeFetch();
    const app = buildTestApp({
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
      oauthService: realOAuthService(fetchImpl),
      kmsService,
      connections,
    });

    const res = await app.inject({
      method: 'GET',
      url:
        '/v1/youversion/oauth/callback?state=valid-state&yvp_id=yv-42&user_name=Test+Person' +
        '&user_email=test%40example.com&profile_picture=https%3A%2F%2Fimg.test%2Fp.png',
    });

    expect([301, 302]).toContain(res.statusCode);
    expect(res.headers.location).toBe('https://app.kairos.test/settings?youversion=success');

    // Step 2: the resolve call hit /auth/callback WITHOUT following the
    // redirect (redirect: 'manual'), and step 3 posted the RESOLVED code.
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const resolveCall = calls.find((c) => String(c[0]).includes('/auth/callback'));
    expect(resolveCall).toBeTruthy();
    expect(resolveCall![1]).toMatchObject({ redirect: 'manual' });
    const tokenCall = calls.find((c) => String(c[0]).includes('/auth/token'));
    expect(tokenCall).toBeTruthy();
    expect(String(tokenCall![1]?.body)).toContain('code=resolved-code');

    // Both tokens were encrypted (plaintext passed to KMS), never stored raw.
    expect(kmsService.encryptToken).toHaveBeenCalledWith('yv-access-token');
    expect(kmsService.encryptToken).toHaveBeenCalledWith('yv-refresh-token');

    expect(connections.upsert).toHaveBeenCalledOnce();
    const [calledUserId, input] = (connections.upsert as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      {
        accessTokenEncrypted: Buffer;
        refreshTokenEncrypted: Buffer | null;
        displayName: string | null;
        youVersionUserId: string | null;
      },
    ];
    expect(calledUserId).toBe(FAKE_USER_ID);
    // Stored bytes are the CIPHERTEXT returned by KMS, never the plaintext
    // token itself — the row can never hold a usable token in the clear.
    expect(input.accessTokenEncrypted).toEqual(Buffer.from('enc:yv-access-token'));
    expect(input.accessTokenEncrypted).not.toEqual(Buffer.from('yv-access-token'));
    expect(input.refreshTokenEncrypted).toEqual(Buffer.from('enc:yv-refresh-token'));
    // §9-safe identity captured straight from the authorize redirect (no /auth/me).
    expect(input.displayName).toBe('Test Person');
    expect(input.youVersionUserId).toBe('yv-42');
    await app.close();
  });

  it('stores a null refresh token when the provider issues none rather than throwing', async () => {
    const oauthStates = new FakeOAuthStatesRepository();
    oauthStates.seed('valid-state', FAKE_USER_ID);
    const connections = fakeConnections();
    const app = buildTestApp({
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
      oauthService: realOAuthService(
        fakeFetch({ token: { body: { access_token: 'a-only', expires_in: 3600 } } }),
      ),
      connections,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?state=valid-state&yvp_id=yv-1&user_name=A',
    });

    expect([301, 302]).toContain(res.statusCode);
    const [, input] = (connections.upsert as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { refreshTokenEncrypted: Buffer | null },
    ];
    expect(input.refreshTokenEncrypted).toBeNull();
    await app.close();
  });

  it('fails the resolve step when the returned Location state does not match (forged redirect)', async () => {
    const oauthStates = new FakeOAuthStatesRepository();
    oauthStates.seed('valid-state', FAKE_USER_ID);
    const connections = fakeConnections();
    const app = buildTestApp({
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
      // Resolve returns a code but echoes a DIFFERENT state — must be rejected.
      oauthService: realOAuthService(
        fakeFetch({
          resolve: { status: 302, location: `${REDIRECT_URI}?code=x&state=some-other-state` },
        }),
      ),
      connections,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?state=valid-state&yvp_id=yv-1&user_name=A',
    });

    expect(res.statusCode).toBe(500);
    expect(connections.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it('stores no display name when the redirect omits user_name', async () => {
    const oauthStates = new FakeOAuthStatesRepository();
    oauthStates.seed('valid-state', FAKE_USER_ID);
    const connections = fakeConnections();
    const app = buildTestApp({
      oauthStates: oauthStates as unknown as OAuthStatesRepository,
      oauthService: realOAuthService(fakeFetch()),
      connections,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?state=valid-state&yvp_id=yv-1',
    });

    expect([301, 302]).toContain(res.statusCode);
    expect(connections.upsert).toHaveBeenCalledOnce();
    const [, input] = (connections.upsert as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { displayName: string | null; youVersionUserId: string | null },
    ];
    expect(input.displayName).toBeNull();
    expect(input.youVersionUserId).toBe('yv-1');
    await app.close();
  });

  it('400s on missing state', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/youversion/oauth/callback?yvp_id=yv-1' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s on unknown state (enumeration-safe — same body as expired/replayed)', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?yvp_id=yv-1&state=never-issued',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s on expired state', async () => {
    const oauthStates = new FakeOAuthStatesRepository();
    oauthStates.seed('expired', FAKE_USER_ID, { expiresAt: new Date(Date.now() - 1000) });
    const app = buildTestApp({ oauthStates: oauthStates as unknown as OAuthStatesRepository });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?yvp_id=yv-1&state=expired',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s on replayed (already-consumed) state', async () => {
    const oauthStates = new FakeOAuthStatesRepository();
    oauthStates.seed('used', FAKE_USER_ID, { consumed: true });
    const app = buildTestApp({ oauthStates: oauthStates as unknown as OAuthStatesRepository });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?yvp_id=yv-1&state=used',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s when the state carries no PKCE verifier (minted by a non-PKCE flow)', async () => {
    const oauthStates = new FakeOAuthStatesRepository();
    oauthStates.seed('no-verifier', FAKE_USER_ID, { codeVerifier: null });
    const app = buildTestApp({ oauthStates: oauthStates as unknown as OAuthStatesRepository });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?yvp_id=yv-1&state=no-verifier',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s on missing yvp_id with a valid state (no identity to resolve)', async () => {
    const oauthStates = new FakeOAuthStatesRepository();
    oauthStates.seed('valid-state', FAKE_USER_ID);
    const app = buildTestApp({ oauthStates: oauthStates as unknown as OAuthStatesRepository });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?state=valid-state',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('redirects to the settings error page when the user denies', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?error=access_denied&state=whatever',
    });
    expect([301, 302]).toContain(res.statusCode);
    expect(res.headers.location).toBe('https://app.kairos.test/settings?youversion=error&reason=denied');
    await app.close();
  });

  it('503s when not configured', async () => {
    const app = buildTestApp({ oauthService: undefined });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/youversion/oauth/callback?code=c&state=s',
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/youversion/connection
// ---------------------------------------------------------------------------

describe('DELETE /v1/youversion/connection', () => {
  it('deletes the stored connection for the user', async () => {
    const connections = fakeConnections();
    const app = buildTestApp({ connections });
    const res = await app.inject({ method: 'DELETE', url: '/v1/youversion/connection' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    expect(connections.delete).toHaveBeenCalledWith(FAKE_USER_ID);
    await app.close();
  });

  it('is a no-op success when there is nothing to delete', async () => {
    const connections = fakeConnections({ delete: vi.fn().mockResolvedValue(false) });
    const app = buildTestApp({ connections });
    const res = await app.inject({ method: 'DELETE', url: '/v1/youversion/connection' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
