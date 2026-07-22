/**
 * `GET /v1/calendar/freebusy` — M1 of epic M (#255).
 *
 * ## How this suite is anchored (docs/07 §3.1)
 *
 * §3.1 exists because a hand-written fixture agreed with a wrong client and
 * 115 tests passed over a user-visible bug. Two consequences shape this
 * file, and they are the reason it is built the awkward way rather than the
 * convenient way:
 *
 * **1. There is no fake calendar client.** The route is wired to the *real*
 * `GoogleCalendarClient`, and the only thing stubbed is `globalThis.fetch`
 * — the network itself. So the JSON in `googleFreeBusyBody()` is parsed by
 * the actual `getFreeBusyBlocks` implementation, not by a test double that
 * would happily agree with whatever shape I imagined. §3.1's first rule is
 * "fixtures must derive from the real producer": if I nested `busy` wrongly,
 * the real parser returns `[]` and the happy-path assertion fails, which is
 * exactly the feedback a fake client would have suppressed. The shape is
 * additionally cross-checked against the pre-existing
 * `tests/services/calendar/googleCalendarClient.test.ts`, which asserts the
 * same envelope against the same parser.
 *
 * **2. The consent test asserts that no read happened, not that a flag was
 * read.** §3.1's rule 4: "assert behaviour, not participation". Observing
 * that `preferences.get` was called proves nothing — code can read a flag
 * and throw it away. What #201 and Foundation §8 actually promise is that
 * *no free/busy read occurs*, so the assertion is on `fetch` (no HTTP
 * request to Google was made at all) and on `decryptToken` (the credential
 * was never even unwrapped). Those fail if the gate is removed; a
 * participation assertion would not.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerCalendarFreeBusyRoutes } from '../../src/routes/calendarFreeBusy.js';
import { GoogleCalendarClient } from '../../src/services/calendar/googleCalendarClient.js';
import { FreeBusyCache } from '../../src/services/calendar/freeBusyCache.js';
import { FREEBUSY_MAX_RANGE_DAYS, FreeBusyResponseSchema } from '@kairos/shared-contracts';
import type { GoogleKmsService } from '../../src/services/calendar/googleKmsService.js';
import type { UsersRepository, UserRow } from '../../src/db/repositories/usersRepository.js';
import type { PreferencesRepository, PreferencesRow } from '../../src/db/repositories/preferencesRepository.js';
import type { ConnectionsRepository, ConnectionRow } from '../../src/db/repositories/connectionsRepository.js';

// Same mock the existing GoogleCalendarClient suite uses, for the same
// reason: keep the OAuth token endpoint out of the test while leaving every
// line of the client's own logic real.
vi.mock('google-auth-library', async () => {
  class MockOAuth2Client {
    credentials = { expiry_date: Date.now() + 3_600_000 };
    setCredentials = vi.fn();
    getAccessToken = vi.fn().mockResolvedValue({ token: 'fake-calendar-token' });
  }
  return { OAuth2Client: MockOAuth2Client };
});

const USER_ID = '00000000-0000-0000-0000-0000000000cc';
const FIREBASE_UID = 'firebase-freebusy';
const TZ = 'America/New_York';

const FROM = '2026-07-20T00:00:00.000Z';
const TO = '2026-07-21T00:00:00.000Z';

/**
 * The busy windows the fake Google returns. Deliberately a plain pair of
 * instants — `freebusy.query` carries no other field, which is the privacy
 * posture #255 calls "the constraint is the feature".
 */
const BUSY = [
  { start: '2026-07-20T13:00:00Z', end: '2026-07-20T14:00:00Z' },
  { start: '2026-07-20T18:30:00Z', end: '2026-07-20T19:00:00Z' },
];

/**
 * The Google `freebusy.query` response envelope.
 *
 * Not written from memory (§3.1). This is the shape
 * `GoogleCalendarClient.getFreeBusyBlocks` actually destructures —
 * `data.calendars.primary.busy[]` — and the real parser runs against it in
 * every test below, so a wrong guess here surfaces as a failing assertion
 * rather than as a fixture and a bug agreeing with each other.
 */
function googleFreeBusyBody(busy = BUSY) {
  return { kind: 'calendar#freeBusy', calendars: { primary: { busy } } };
}

interface Harness {
  preferencesRow: Partial<PreferencesRow> | null;
  connectionRow: Partial<ConnectionRow> | null;
  fetchImpl?: typeof globalThis.fetch;
  cache?: FreeBusyCache<Array<{ start: string; end: string }>>;
}

async function buildTestApp(overrides: Partial<Harness> = {}) {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const userRow = { id: USER_ID, firebase_uid: FIREBASE_UID, timezone: TZ } as unknown as UserRow;

  const preferencesRow =
    overrides.preferencesRow === undefined
      ? ({ user_id: USER_ID, calendar_enabled: true } as unknown as PreferencesRow)
      : (overrides.preferencesRow as PreferencesRow | null);

  const connectionRow =
    overrides.connectionRow === undefined
      ? ({
          user_id: USER_ID,
          provider: 'google_calendar',
          status: 'active',
          encrypted_refresh_token: Buffer.from('ciphertext'),
        } as unknown as ConnectionRow)
      : (overrides.connectionRow as ConnectionRow | null);

  const users = {
    findOrCreateByFirebaseUid: vi.fn(async () => userRow),
    findById: vi.fn(async () => userRow),
  } as unknown as UsersRepository;

  const preferencesGet = vi.fn(async () => preferencesRow);
  const findByProvider = vi.fn(async () => connectionRow);
  const decryptToken = vi.fn(async () => 'plaintext-refresh-token');

  const mockFetch = vi.fn(
    overrides.fetchImpl ??
      (async () => ({ ok: true, json: async () => googleFreeBusyBody() }) as unknown as Response),
  );
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

  // The REAL client — only the network beneath it is stubbed.
  const calendarClient = new GoogleCalendarClient({
    getRefreshToken: () => Promise.reject(new Error('use withRefreshToken')),
    clientId: 'fake-client-id',
    clientSecret: 'fake-client-secret',
    redirectUri: 'http://localhost:8080/v1/connect/google/callback',
  });

  registerAuth(app, verifier, users);
  registerCalendarFreeBusyRoutes(app, {
    preferences: { get: preferencesGet } as unknown as Pick<PreferencesRepository, 'get'>,
    connections: { findByProvider } as unknown as Pick<ConnectionsRepository, 'findByProvider'>,
    users,
    kmsService: { decryptToken } as unknown as GoogleKmsService,
    calendarClient,
    ...(overrides.cache ? { cache: overrides.cache } : {}),
  });

  return {
    app,
    token: await verifier.mint(FIREBASE_UID),
    mockFetch,
    decryptToken,
    preferencesGet,
    findByProvider,
  };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

function url(from: string = FROM, to: string = TO) {
  return `/v1/calendar/freebusy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

/** Requests to Google, as opposed to any other fetch the process might make. */
function googleCalls(mockFetch: ReturnType<typeof vi.fn>) {
  return mockFetch.mock.calls.filter((c) => String(c[0]).includes('googleapis.com'));
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('GET /v1/calendar/freebusy — happy path (#255 M1)', () => {
  it('returns the busy blocks the real client parsed out of Google\'s response', async () => {
    const { app, token, mockFetch } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe('ok');
    // The anchoring assertion: these values only appear if the REAL
    // `getFreeBusyBlocks` successfully walked `calendars.primary.busy` in
    // the fixture. A mis-shaped fixture yields `[]` and fails here.
    expect(body.data.busy).toEqual(BUSY);

    // And the request that produced them went to freebusy.query for the
    // primary calendar over the range asked for — not, say, events.list.
    const [callUrl, init] = googleCalls(mockFetch)[0]!;
    expect(callUrl).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.items).toEqual([{ id: 'primary' }]);
    expect(sent.timeMin).toBe(FROM);
    expect(sent.timeMax).toBe(TO);

    await app.close();
  });

  it('validates against the shared FreeBusyResponse contract', async () => {
    // §3.1 rule 3: validate against the schema, not a hand-listed key
    // array — a key list is exactly the assertion someone later "fixes" to
    // match a regression.
    const { app, token } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    expect(FreeBusyResponseSchema.safeParse(res.json()).success).toBe(true);

    await app.close();
  });

  it('resolves the range in the user\'s profile zone, not UTC or the browser\'s', async () => {
    // #205 / #255's timezone section. The zone is echoed so the grid labels
    // its axis with the same zone the server queried in.
    const { app, token, mockFetch } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    expect(res.json().data.range.timeZone).toBe(TZ);
    const sent = JSON.parse((googleCalls(mockFetch)[0]![1] as RequestInit).body as string);
    expect(sent.timeZone).toBe(TZ);

    await app.close();
  });

  it('returns an empty busy list as a genuine "ok" with an empty array', async () => {
    // A genuinely free day is `status: 'ok'` + `busy: []`, and that is the
    // ONLY combination that means "you are free". The degraded states below
    // are structurally incapable of expressing it.
    const { app, token } = await buildTestApp({
      fetchImpl: (async () =>
        ({ ok: true, json: async () => googleFreeBusyBody([]) }) as unknown as Response) as never,
    });

    const res = await app.inject({ method: 'GET', url: url(), headers: authed(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'ok', busy: [] });

    await app.close();
  });

  it('requires authentication', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: url() });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('consent gate — calendar_enabled = false (#201, Foundation §8)', () => {
  it('performs NO free/busy read at all', async () => {
    // The behavioural assertion (§3.1 rule 4). Not "the flag was read" —
    // "no request reached Google".
    const { app, token, mockFetch } = await buildTestApp({
      preferencesRow: { user_id: USER_ID, calendar_enabled: false } as unknown as PreferencesRow,
    });

    const res = await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('consent_disabled');
    expect(googleCalls(mockFetch)).toHaveLength(0);

    await app.close();
  });

  it('never decrypts the refresh token', async () => {
    // Gated ABOVE decryption, as #217 does — a user who withdrew consent
    // should not have their OAuth credential unwrapped in this process's
    // memory, not even to discover we may not use it.
    const { app, token, decryptToken } = await buildTestApp({
      preferencesRow: { user_id: USER_ID, calendar_enabled: false } as unknown as PreferencesRow,
    });

    await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    expect(decryptToken).not.toHaveBeenCalled();

    await app.close();
  });

  it('omits `busy` entirely rather than sending an empty array', async () => {
    // The #253-class guard. An empty array would let a client that ignores
    // `status` render a confident, wrong "you are completely free". There
    // is no array to render.
    const { app, token } = await buildTestApp({
      preferencesRow: { user_id: USER_ID, calendar_enabled: false } as unknown as PreferencesRow,
    });

    const data = (await app.inject({ method: 'GET', url: url(), headers: authed(token) })).json().data;

    expect(data).not.toHaveProperty('busy');
    // Still echoes the range, so a late-landing response is attributable to
    // the request that asked for it.
    expect(data.range).toEqual({ from: FROM, to: TO, timeZone: TZ });

    await app.close();
  });

  it('treats a missing preferences row as consent granted, matching the orchestrator', async () => {
    // `prefsRow?.calendar_enabled ?? true` in generateNowOrchestrator. A
    // user who never touched the toggles has not declined.
    const { app, token, mockFetch } = await buildTestApp({ preferencesRow: null });

    const res = await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    expect(res.json().data.status).toBe('ok');
    expect(googleCalls(mockFetch)).toHaveLength(1);

    await app.close();
  });
});

describe('disconnected calendar — a distinct, non-error state (#255)', () => {
  it('answers 200 not_connected when no connection row exists', async () => {
    const { app, token, mockFetch, decryptToken } = await buildTestApp({ connectionRow: null });

    const res = await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    // Explicitly NOT a 500 — #255 requires the UI be able to render
    // "connect to see your calendar" from a success response.
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('not_connected');
    expect(res.json().data).not.toHaveProperty('busy');
    expect(googleCalls(mockFetch)).toHaveLength(0);
    expect(decryptToken).not.toHaveBeenCalled();

    await app.close();
  });

  it('treats a revoked connection as not connected', async () => {
    const { app, token, mockFetch } = await buildTestApp({
      connectionRow: {
        user_id: USER_ID,
        provider: 'google_calendar',
        status: 'revoked',
        encrypted_refresh_token: Buffer.from('ciphertext'),
      } as unknown as ConnectionRow,
    });

    const res = await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    expect(res.json().data.status).toBe('not_connected');
    expect(googleCalls(mockFetch)).toHaveLength(0);

    await app.close();
  });

  it('fails closed on an unrecognized connection status', async () => {
    // Compared positively against 'active' rather than `!== 'revoked'`, so
    // a status nobody anticipated refuses instead of silently permitting
    // (meetBotConsentGate.ts's `connection_revoked` reasoning).
    const { app, token, mockFetch } = await buildTestApp({
      connectionRow: {
        user_id: USER_ID,
        provider: 'google_calendar',
        status: 'suspended',
        encrypted_refresh_token: Buffer.from('ciphertext'),
      } as unknown as ConnectionRow,
    });

    expect(
      (await app.inject({ method: 'GET', url: url(), headers: authed(token) })).json().data.status,
    ).toBe('not_connected');
    expect(googleCalls(mockFetch)).toHaveLength(0);

    await app.close();
  });

  it('distinguishes not_connected from consent_disabled', async () => {
    // The two have different remedies — OAuth flow vs. a toggle. Merging
    // them would send a revoked user to a switch that changes nothing.
    const disconnected = await buildTestApp({ connectionRow: null });
    const noConsent = await buildTestApp({
      preferencesRow: { user_id: USER_ID, calendar_enabled: false } as unknown as PreferencesRow,
    });

    const a = (
      await disconnected.app.inject({ method: 'GET', url: url(), headers: authed(disconnected.token) })
    ).json().data.status;
    const b = (
      await noConsent.app.inject({ method: 'GET', url: url(), headers: authed(noConsent.token) })
    ).json().data.status;

    expect(a).not.toBe(b);

    await disconnected.app.close();
    await noConsent.app.close();
  });
});

describe('range limit — enforced server-side (#255 constraint 3)', () => {
  it('rejects a year-wide range with a 400 and never calls Google', async () => {
    // "A client asking for a year must fail fast, not melt the quota."
    // Google documents no range cap of its own, so this is the only place
    // it can be caught (see FREEBUSY_MAX_RANGE_DAYS for sources).
    const { app, token, mockFetch } = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: url('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
      headers: authed(token),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ARGUMENT');
    expect(res.json().error.message).toContain(String(FREEBUSY_MAX_RANGE_DAYS));
    expect(googleCalls(mockFetch)).toHaveLength(0);

    await app.close();
  });

  it('accepts a range exactly at the limit and rejects one just past it', async () => {
    // The boundary itself, both sides. A limit tested only far from its
    // edge is a limit whose comparison operator is untested.
    const base = Date.parse('2026-07-01T00:00:00.000Z');
    const day = 86_400_000;

    const atLimit = await buildTestApp();
    const okRes = await atLimit.app.inject({
      method: 'GET',
      url: url(
        new Date(base).toISOString(),
        new Date(base + FREEBUSY_MAX_RANGE_DAYS * day).toISOString(),
      ),
      headers: authed(atLimit.token),
    });
    expect(okRes.statusCode).toBe(200);
    await atLimit.app.close();

    const overLimit = await buildTestApp();
    const badRes = await overLimit.app.inject({
      method: 'GET',
      url: url(
        new Date(base).toISOString(),
        // One millisecond past the ceiling.
        new Date(base + FREEBUSY_MAX_RANGE_DAYS * day + 1).toISOString(),
      ),
      headers: authed(overLimit.token),
    });
    expect(badRes.statusCode).toBe(400);
    await overLimit.app.close();
  });

  it('admits a full six-week month grid, which is what the cap is sized for', async () => {
    // M4's month view spans whole weeks: a 31-day month starting late in
    // the week is 6 rows = 42 days. If this ever fails, the cap was set
    // below the feature it exists to serve.
    const base = Date.parse('2026-07-01T00:00:00.000Z');
    const { app, token } = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: url(new Date(base).toISOString(), new Date(base + 42 * 86_400_000).toISOString()),
      headers: authed(token),
    });

    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('rejects missing, malformed, and inverted ranges without calling Google', async () => {
    const cases: Array<[string, string]> = [
      ['/v1/calendar/freebusy', 'both params absent'],
      [`/v1/calendar/freebusy?from=${FROM}`, 'to absent'],
      ['/v1/calendar/freebusy?from=yesterday&to=tomorrow', 'unparseable'],
      [`/v1/calendar/freebusy?from=${TO}&to=${FROM}`, 'inverted'],
      [`/v1/calendar/freebusy?from=${FROM}&to=${FROM}`, 'zero-width'],
    ];

    for (const [requestUrl, label] of cases) {
      const { app, token, mockFetch } = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: requestUrl, headers: authed(token) });
      expect(res.statusCode, label).toBe(400);
      expect(googleCalls(mockFetch), label).toHaveLength(0);
      await app.close();
    }
  });
});

describe('upstream failure — an error, never an empty calendar', () => {
  it('answers 502 rather than reporting the user as free', async () => {
    // The distinction that matters: `busy: []` here would render a packed
    // day as wide open. "We do not know" is not "you are free".
    const { app, token } = await buildTestApp({
      fetchImpl: (async () =>
        ({ ok: false, status: 503, text: async () => 'backend error' }) as unknown as Response) as never,
    });

    const res = await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    expect(res.statusCode).toBe(502);
    expect(res.json().ok).toBe(false);
    expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
    // Retryable: a 5xx, a 429 against the per-user 600/min quota, and a
    // transient network failure all clear on their own.
    expect(res.json().error.retryable).toBe(true);
    expect(res.json()).not.toHaveProperty('data');

    await app.close();
  });

  it('does not leak Google\'s error text to the client', async () => {
    const { app, token } = await buildTestApp({
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 403,
          text: async () => 'Request had insufficient authentication scopes for user@example.com',
        }) as unknown as Response) as never,
    });

    const message = (await app.inject({ method: 'GET', url: url(), headers: authed(token) })).json()
      .error.message;

    expect(message).not.toContain('example.com');
    expect(message).not.toContain('scopes');

    await app.close();
  });
});

describe('caching — a latency optimization that cannot outlive consent', () => {
  it('serves a repeated identical range without a second Google call', async () => {
    // The day/week/month toggle re-requests overlapping ranges; this is
    // the case that earns the cache.
    const { app, token, mockFetch } = await buildTestApp();

    await app.inject({ method: 'GET', url: url(), headers: authed(token) });
    const second = await app.inject({ method: 'GET', url: url(), headers: authed(token) });

    expect(second.statusCode).toBe(200);
    expect(second.json().data.busy).toEqual(BUSY);
    expect(googleCalls(mockFetch)).toHaveLength(1);

    await app.close();
  });

  it('treats a different range as a different key', async () => {
    const { app, token, mockFetch } = await buildTestApp();

    await app.inject({ method: 'GET', url: url(), headers: authed(token) });
    await app.inject({
      method: 'GET',
      url: url('2026-07-22T00:00:00.000Z', '2026-07-23T00:00:00.000Z'),
      headers: authed(token),
    });

    expect(googleCalls(mockFetch)).toHaveLength(2);

    await app.close();
  });

  it('cannot serve a cached entry after consent is withdrawn', async () => {
    // THE revocation-safety test. The cache is warmed while consent is on,
    // then consent flips off and the same range is requested again. The
    // cached blocks must be unreachable — not because they were evicted,
    // but because the consent gate runs above the cache read and the user
    // can no longer traverse that path.
    const cache = new FreeBusyCache<Array<{ start: string; end: string }>>();
    const warm = await buildTestApp({ cache });

    const first = await warm.app.inject({ method: 'GET', url: url(), headers: authed(warm.token) });
    expect(first.json().data.busy).toEqual(BUSY);
    expect(cache.size).toBe(1);
    await warm.app.close();

    // Same cache instance, same user, same range — consent now off.
    const revoked = await buildTestApp({
      cache,
      preferencesRow: { user_id: USER_ID, calendar_enabled: false } as unknown as PreferencesRow,
    });
    const second = await revoked.app.inject({
      method: 'GET',
      url: url(),
      headers: authed(revoked.token),
    });

    expect(second.json().data.status).toBe('consent_disabled');
    expect(second.json().data).not.toHaveProperty('busy');
    // The entry is still there — and still unserved. That is the point:
    // safety comes from gate ordering, not from eviction.
    expect(cache.size).toBe(1);

    await revoked.app.close();
  });

  it('cannot serve a cached entry after the calendar is disconnected', async () => {
    const cache = new FreeBusyCache<Array<{ start: string; end: string }>>();
    const warm = await buildTestApp({ cache });
    await warm.app.inject({ method: 'GET', url: url(), headers: authed(warm.token) });
    await warm.app.close();

    const disconnected = await buildTestApp({ cache, connectionRow: null });
    const res = await disconnected.app.inject({
      method: 'GET',
      url: url(),
      headers: authed(disconnected.token),
    });

    expect(res.json().data.status).toBe('not_connected');
    expect(res.json().data).not.toHaveProperty('busy');

    await disconnected.app.close();
  });
});
