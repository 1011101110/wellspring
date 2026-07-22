/**
 * Authz probe suite (EPIC F, issue #42). Proves that user A's
 * authenticated request can NEVER read/modify user B's devotionals,
 * preferences, sessions, daily_bands, calendar_events — over real HTTP,
 * through the real Fastify app (`buildApp`), against real (test)
 * Postgres. Every probe asserts **404**, never 403 — Foundation §10 /
 * docs/04_DATA_PRIVACY_SECURITY.md §5.4: a resource owned by someone
 * else must be indistinguishable from a resource that never existed
 * (don't leak existence).
 *
 * Reuses the kairos-test-pg container (A5 convention, port 5433) — same
 * as tests/db/repositories.test.ts and tests/routes/session.integration.
 * test.ts. Does not start a new container.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
} from '../../src/db/repositories/index.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { LocalFileAudioStorage } from '../../src/services/audio/audioStorage.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
}

let audioRootDir: string;
let verifier: FakeTokenVerifier;
let app: FastifyInstance;

beforeAll(async () => {
  await pool.query('SELECT 1 FROM users LIMIT 1');
  audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-authz-probe-audio-'));
  verifier = await FakeTokenVerifier.create();
  const audioStorage = new LocalFileAudioStorage({
    rootDir: audioRootDir,
    signingSecret: 'a'.repeat(32),
  });
  app = buildApp({
    tokenVerifier: verifier,
    repositories: repos,
    audioStorage,
  });
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await rm(audioRootDir, { recursive: true, force: true });
});

function minimalDevotional(date = '2026-07-02') {
  return {
    date,
    format: 'short' as const,
    theme: 'Rest for the weary',
    verses: [
      {
        usfm: 'MAT.11.28',
        versionId: 3034,
        fetchedText: 'Come to me, all you who are weary and burdened, and I will give you rest.',
        attribution: 'Berean Standard Bible',
      },
    ],
    devotionalBody: 'A short devotional body about rest.',
    cardSummary: 'Rest for the weary.',
    prayer: 'Lord, grant me rest.',
  };
}

interface Fixture {
  userAId: string;
  userBId: string;
  tokenA: string;
  tokenB: string;
  devoA: Awaited<ReturnType<Repositories['devotionals']['create']>>;
  sessionA: Awaited<ReturnType<Repositories['sessions']['create']>>;
}

async function setupTwoUsers(suffix: string): Promise<Fixture> {
  // Realistic (non-UUID) Firebase-style uids — the fake token's `sub`
  // claim below is minted from THESE, not from the resulting users.id
  // (issue #69's regression shape: pre-fix, every test in this suite
  // minted `sub = users.id` directly, which masked the fact that
  // production tokens carry a Firebase UID the middleware never resolved
  // to a users.id at all).
  const firebaseUidA = `authz-a-${suffix}`;
  const firebaseUidB = `authz-b-${suffix}`;
  const userA = await repos.users.createUser({
    firebaseUid: firebaseUidA,
    email: `a-${suffix}@example.com`,
  });
  const userB = await repos.users.createUser({
    firebaseUid: firebaseUidB,
    email: `b-${suffix}@example.com`,
  });
  const userAId = asVerifiedUserId(userA.id);
  const userBId = asVerifiedUserId(userB.id);

  await repos.preferences.ensureExists(userAId);
  await repos.preferences.ensureExists(userBId);
  await repos.preferences.update(userAId, { voice: 'voice-a' });
  await repos.preferences.update(userBId, { voice: 'voice-b' });

  await repos.dailyBands.upsertForDate(userAId, { date: '2026-07-01', recovery: 'low' });
  await repos.dailyBands.upsertForDate(userBId, { date: '2026-07-01', recovery: 'high' });

  const devoA = await repos.devotionals.create(userAId, minimalDevotional());
  await repos.devotionals.create(userBId, minimalDevotional());

  const sessionA = await repos.sessions.create(userAId, {
    devotionalId: devoA.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });

  await repos.calendarEvents.create(userAId, {
    devotionalId: null,
    providerEventId: 'evt-a',
    gapSource: 'found_gap',
    gapStartAt: new Date(),
    gapEndAt: new Date(Date.now() + 1800_000),
  });

  // Mint from the FIREBASE UID, not the users.id — the auth middleware
  // (issue #69) resolves firebase_uid -> users.id itself; a token whose
  // `sub` claim is already a users.id would provision an unrelated new
  // row rather than authenticating as userA/userB.
  const tokenA = await verifier.mint(firebaseUidA);
  const tokenB = await verifier.mint(firebaseUidB);

  return { userAId, userBId, tokenA, tokenB, devoA, sessionA };
}

describe('Authz probes — user B can never read or modify user A data (404, never 403)', () => {
  it('GET /v1/devotionals/:id — B given A id -> 404', async () => {
    const fx = await setupTwoUsers('devo-get');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${fx.devoA.id}`,
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403);
  });

  it('GET /v1/devotionals — B list never includes A rows', async () => {
    const fx = await setupTwoUsers('devo-list');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/devotionals',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.some((d: { id: string }) => d.id === fx.devoA.id)).toBe(false);
  });

  it('GET /v1/preferences — B sees only B preferences, not A', async () => {
    const fx = await setupTwoUsers('prefs-get');
    const resB = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(resB.statusCode).toBe(200);
    expect(resB.json().data.voice).toBe('voice-b');
    expect(resB.json().data.userId).toBe(fx.userBId);
  });

  it('PUT /v1/preferences — B cannot mutate A preferences (no userId in body is honored)', async () => {
    const fx = await setupTwoUsers('prefs-put');
    // Attempt to smuggle A's userId via the body — must be ignored; the
    // route only ever writes to request.auth.userId (B's verified id).
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: { voice: 'voice-b-updated', userId: fx.userAId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.userId).toBe(fx.userBId);

    const prefsA = await repos.preferences.get(asVerifiedUserId(fx.userAId));
    expect(prefsA?.voice).toBe('voice-a'); // untouched
  });

  it('GET /v1/bands/:date — B given a date where only A has a row -> 404', async () => {
    const fx = await setupTwoUsers('bands-get');
    // Both A and B have a 2026-07-01 row (from setup); use a date only A has.
    await repos.dailyBands.upsertForDate(asVerifiedUserId(fx.userAId), {
      date: '2026-06-15',
      recovery: 'moderate',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/bands/2026-06-15',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/bands — B list never includes A rows even for the same date', async () => {
    const fx = await setupTwoUsers('bands-list');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].recovery).toBe('high'); // B's own row
  });

  // --- POST /v1/bands (issue #72 / docs/14 §1.5) ------------------------
  it('POST /v1/bands — uploads all five bands, upserts, and is scoped to the caller only', async () => {
    const fx = await setupTwoUsers('bands-post-full');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: {
        date: '2026-07-05',
        recovery: 'moderate',
        sleepQuality: 'good',
        activity: 'active',
        busyness: 'light',
        communicationLoad: 'heavy',
        distressSignal: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.recovery).toBe('moderate');
    expect(body.data.distressSignal).toBe(true);

    // A never sees B's freshly uploaded row.
    const aBands = await repos.dailyBands.getForDate(asVerifiedUserId(fx.userAId), '2026-07-05');
    expect(aBands).toBeNull();
  });

  it('POST /v1/bands — omitting the three health bands stores NULL, not a fabricated value (issue #70 consent path)', async () => {
    const fx = await setupTwoUsers('bands-post-omit');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: { date: '2026-07-06', busyness: 'heavy' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.recovery).toBeNull();
    expect(body.data.sleepQuality).toBeNull();
    expect(body.data.activity).toBeNull();
    expect(body.data.busyness).toBe('heavy');
    expect(body.data.distressSignal).toBe(false); // default
  });

  it('POST /v1/bands — second upload for the same date upserts (does not duplicate)', async () => {
    const fx = await setupTwoUsers('bands-post-upsert');
    await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: { date: '2026-07-07', recovery: 'low' },
    });
    const secondRes = await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: { date: '2026-07-07', recovery: 'high' },
    });
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.json().data.recovery).toBe('high');

    const stored = await repos.dailyBands.getForDate(asVerifiedUserId(fx.userBId), '2026-07-07');
    expect(stored?.recovery).toBe('high');
  });

  it('POST /v1/bands — rejects a missing date with 400, never touches the DB', async () => {
    const fx = await setupTwoUsers('bands-post-invalid-date');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: { recovery: 'low' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });

  it('POST /v1/bands — rejects an invalid enum value with 400 (never free text into a band column)', async () => {
    const fx = await setupTwoUsers('bands-post-invalid-enum');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: { date: '2026-07-08', recovery: 'extremely low energy today' },
    });
    expect(res.statusCode).toBe(400);
  });

  // --- PUT /v1/preferences full field set (issue #72 / docs/14 §3.5) ----
  it('PUT /v1/preferences — accepts and persists the full documented field set', async () => {
    const fx = await setupTwoUsers('prefs-put-full');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: {
        windowStartLocal: '06:30',
        windowEndLocal: '08:00',
        activeDays: [0, 3, 6],
        cadence: 'custom',
        durationPreference: 'extended',
        voice: 'en-US-Chirp3-HD-Kore',
        calendarEnabled: true,
        healthEnabled: true,
        communicationEnabled: false,
        notifyOnSkip: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.windowStartLocal).toBe('06:30:00');
    expect(data.windowEndLocal).toBe('08:00:00');
    expect(data.activeDays).toEqual([0, 3, 6]);
    expect(data.cadence).toBe('custom');
    expect(data.durationPreference).toBe('extended');
    expect(data.calendarEnabled).toBe(true);
    expect(data.healthEnabled).toBe(true);
    expect(data.communicationEnabled).toBe(false);
    expect(data.notifyOnSkip).toBe(false);
  });

  it('PUT /v1/preferences — rejects free text into the cadence enum column with 400 (docs/14 §2.9 regression)', async () => {
    const fx = await setupTwoUsers('prefs-put-badcadence');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: { cadence: 'whenever the mood strikes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);

    // B's preferences (set to 'voice-b' in setupTwoUsers) are untouched by the rejected request.
    const stillB = await repos.preferences.get(asVerifiedUserId(fx.userBId));
    expect(stillB?.cadence).toBe('daily'); // untouched default, never the rejected free text
  });

  it('PUT /v1/preferences — silently ignores an unknown/smuggled field rather than 400ing (still cannot affect which row is written)', async () => {
    const fx = await setupTwoUsers('prefs-put-unknown-field');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${fx.tokenB}` },
      payload: { voice: 'voice-b-ok', someUnknownField: 'sneaky', userId: fx.userAId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.voice).toBe('voice-b-ok');
    // Still scoped to B regardless of the smuggled userId in the body.
    expect(res.json().data.userId).toBe(fx.userBId);
  });

  // --- Param validation (issue #72 / docs/14 §2.9) -----------------------
  it('GET /v1/devotionals/:id — non-UUID id -> 404 (same as a well-formed-but-unknown id, never a 500)', async () => {
    const fx = await setupTwoUsers('param-devo-nonuuid');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/devotionals/not-a-uuid-at-all',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(500);
  });

  it('GET /v1/bands/:date — malformed date -> 404, never a 500', async () => {
    const fx = await setupTwoUsers('param-bands-baddate');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/bands/not-a-date',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(500);
  });

  it('GET /v1/sessions/:token — non-UUID token -> 404, never a 500', async () => {
    const fx = await setupTwoUsers('param-sessions-nonuuid');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/sessions/abc',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(500);
  });

  it('GET /v1/sessions/:token — non-UUID token -> IDENTICAL 404 body as a well-formed-but-unknown token', async () => {
    const fx = await setupTwoUsers('param-sessions-identical');
    const malformedRes = await app.inject({
      method: 'GET',
      url: '/v1/sessions/abc',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    const unknownRes = await app.inject({
      method: 'GET',
      url: '/v1/sessions/00000000-0000-4000-8000-000000000000',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(malformedRes.statusCode).toBe(unknownRes.statusCode);
    expect(malformedRes.body).toBe(unknownRes.body);
  });

  it('GET /v1/sessions/:token — B given A session token -> 404', async () => {
    const fx = await setupTwoUsers('sessions-get');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${fx.sessionA.token}`,
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/sessions — B list never includes A sessions', async () => {
    const fx = await setupTwoUsers('sessions-list');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.some((s: { token: string }) => s.token === fx.sessionA.token)).toBe(false);
  });

  it('GET /v1/calendar-events — B list never includes A events', async () => {
    const fx = await setupTwoUsers('cal-list');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/calendar-events',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });

  it('GET /v1/calendar-events/upcoming — B list never includes A events', async () => {
    // L4 (#240). Probed separately from `/v1/calendar-events` above
    // because it is a different query with a different risk: it JOINS
    // devotional content (theme, card summary) onto the event, so a
    // scoping mistake here would leak another user's words, not just the
    // existence of a booking.
    const fx = await setupTwoUsers('cal-upcoming');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/calendar-events/upcoming',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });

  it('DELETE /v1/account — B deleting their own account never touches A data', async () => {
    const fx = await setupTwoUsers('account-delete');
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: { authorization: `Bearer ${fx.tokenB}` },
    });
    expect(res.statusCode).toBe(200);

    // B is gone.
    expect(await repos.users.findById(asVerifiedUserId(fx.userBId))).toBeNull();
    // A is untouched.
    const stillA = await repos.users.findById(asVerifiedUserId(fx.userAId));
    expect(stillA).not.toBeNull();
    const devoA = await repos.devotionals.getById(asVerifiedUserId(fx.userAId), fx.devoA.id);
    expect(devoA).not.toBeNull();
  });

  it('missing/garbage token on every user-scoped route -> 401, not a DB hit', async () => {
    const routes = [
      { method: 'GET' as const, url: '/v1/preferences' },
      { method: 'GET' as const, url: '/v1/devotionals' },
      { method: 'GET' as const, url: '/v1/bands' },
      { method: 'GET' as const, url: '/v1/sessions' },
      { method: 'GET' as const, url: '/v1/calendar-events' },
      // L4 (#240) — new route, same default-deny expectation as the rest.
      { method: 'GET' as const, url: '/v1/calendar-events/upcoming' },
      { method: 'DELETE' as const, url: '/v1/account' },
    ];
    for (const route of routes) {
      const res = await app.inject({ method: route.method, url: route.url });
      expect(res.statusCode, `${route.method} ${route.url} without auth`).toBe(401);

      const garbage = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: 'Bearer not-a-real-jwt' },
      });
      expect(garbage.statusCode, `${route.method} ${route.url} with garbage token`).toBe(401);
    }
  });
});
