/**
 * Contract-test layer between iOS and backend (issue #83). Proves that a
 * live route's ACTUAL JSON response validates against the shared Zod
 * schemas in `packages/shared-contracts/src/api/*.ts` via `Schema.parse()`
 * — not just individual field-value assertions (that's what
 * authzProbes.integration.test.ts already does). This is the layer whose
 * absence let iOS POST to a route the backend never built (issue #72).
 *
 * Same test-app-bootstrap pattern as authzProbes.integration.test.ts —
 * real Fastify app (`buildApp`), real (test) Postgres, kairos-test-pg
 * container (port 5433).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
import {
  BandsUploadResponseSchema,
  BandsUploadResponseDataSchema,
  PreferencesResponseSchema,
  AccountDeletionResponseSchema,
  ErrorEnvelopeSchema,
  LedgerTodayResponseSchema,
  MonthlyRecapResponseSchema,
} from '@kairos/shared-contracts';

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
  audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-contract-audio-'));
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

interface UserFixture {
  userId: string;
  token: string;
}

async function setupUser(suffix: string): Promise<UserFixture> {
  const firebaseUid = `contract-${suffix}`;
  const user = await repos.users.createUser({
    firebaseUid,
    email: `${suffix}@example.com`,
  });
  const userId = asVerifiedUserId(user.id);
  await repos.preferences.ensureExists(userId);
  const token = await verifier.mint(firebaseUid);
  return { userId, token };
}

const FIXTURES_DIR = new URL(
  '../../../../packages/shared-contracts/fixtures/api',
  import.meta.url,
).pathname;

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
}

describe('Contract tests — live route responses validate against shared Zod schemas (issue #83)', () => {
  it('POST /v1/bands — full payload response validates BandsUploadResponseSchema', async () => {
    const fx = await setupUser('bands-post-full');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: {
        date: '2026-07-10',
        recovery: 'moderate',
        sleepQuality: 'good',
        activity: 'active',
        busyness: 'light',
        communicationLoad: 'heavy',
        distressSignal: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(() => BandsUploadResponseSchema.parse(res.json())).not.toThrow();
  });

  it('POST /v1/bands — withheld-categories payload (issue #70) still validates BandsUploadResponseSchema (nullable fields)', async () => {
    const fx = await setupUser('bands-post-withheld');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { date: '2026-07-11', distressSignal: false },
    });
    expect(res.statusCode).toBe(200);
    expect(() => BandsUploadResponseSchema.parse(res.json())).not.toThrow();
  });

  it('GET /v1/bands/:date — per-item response validates BandsUploadResponseSchema', async () => {
    const fx = await setupUser('bands-get-date');
    await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { date: '2026-07-12', recovery: 'low' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/bands/2026-07-12',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(() => BandsUploadResponseSchema.parse(res.json())).not.toThrow();
  });

  it('GET /v1/bands — every list element validates BandsUploadResponseDataSchema', async () => {
    const fx = await setupUser('bands-get-list');
    await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { date: '2026-07-13', recovery: 'high' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { date: '2026-07-14', busyness: 'heavy' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(() => BandsUploadResponseDataSchema.parse(item)).not.toThrow();
    }
  });

  it('PUT /v1/preferences — full field-set response validates PreferencesResponseSchema', async () => {
    const fx = await setupUser('prefs-put-full');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${fx.token}` },
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
    expect(() => PreferencesResponseSchema.parse(res.json())).not.toThrow();
  });

  it('GET /v1/preferences — response after PUT validates PreferencesResponseSchema', async () => {
    const fx = await setupUser('prefs-get-after-put');
    await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { voice: 'voice-contract-test' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(() => PreferencesResponseSchema.parse(res.json())).not.toThrow();
  });

  it('DELETE /v1/account — response validates AccountDeletionResponseSchema (dedicated user, destructive)', async () => {
    const fx = await setupUser('account-delete-contract');
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(() => AccountDeletionResponseSchema.parse(res.json())).not.toThrow();
  });

  it('GET /v1/ledger/today — no upload today returns null data, still validates LedgerTodayResponseSchema (issue #85)', async () => {
    const fx = await setupUser('ledger-today-empty');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ledger/today',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeNull();
    expect(body.prayerIntention).toBeNull();
    expect(() => LedgerTodayResponseSchema.parse(body)).not.toThrow();
  });

  it('GET /v1/ledger/today — after POST /v1/bands for today, returns the same row and validates LedgerTodayResponseSchema (issue #85)', async () => {
    const fx = await setupUser('ledger-today-populated');
    const today = new Date().toISOString().slice(0, 10);
    await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { date: today, recovery: 'high', sleepQuality: 'good', activity: 'active' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ledger/today',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.date).toBe(today);
    expect(body.data.recovery).toBe('high');
    expect(body.prayerIntention).toBeNull();
    expect(() => LedgerTodayResponseSchema.parse(body)).not.toThrow();
  });

  it('GET /v1/ledger/today — shows a prayer intention recorded today (issue #93 data-ledger requirement)', async () => {
    const fx = await setupUser('ledger-today-prayer');
    const today = new Date().toISOString().slice(0, 10);
    const verifiedUserId = asVerifiedUserId(fx.userId);
    const devo = await repos.devotionals.create(verifiedUserId, {
      date: today,
      format: 'short',
      theme: 'rest',
      verses: [
        {
          usfm: 'MAT.11.28',
          versionId: 3034,
          fetchedText: 'Come to me, all you who are weary and burdened, and I will give you rest.',
          attribution: 'Berean Standard Bible',
        },
      ],
      devotionalBody: 'body',
      cardSummary: 'summary',
      prayer: 'prayer',
    });
    await repos.prayerIntentions.record(verifiedUserId, devo.id, 'carrying a lot today');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/ledger/today',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prayerIntention.text).toBe('carrying a lot today');
    expect(typeof body.prayerIntention.createdAt).toBe('string');
    expect(() => LedgerTodayResponseSchema.parse(body)).not.toThrow();
  });

  it('GET /v1/recap/:year/:month — no data this month returns the zero-session narrative and validates MonthlyRecapResponseSchema (issue #96)', async () => {
    const fx = await setupUser('recap-empty');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/recap/2026/6',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.sessionsCount).toBe(0);
    expect(body.data.recurringPassages).toEqual([]);
    expect(body.data.heavyWeek).toBeNull();
    expect(body.data.narrative).toMatch(/didn't sit with Scripture/);
    expect(() => MonthlyRecapResponseSchema.parse(body)).not.toThrow();
  });

  it('GET /v1/recap/:year/:month — weaves joined sessions, recurring passages, and a heavy week into the narrative (issue #96)', async () => {
    const fx = await setupUser('recap-populated');
    const userId = asVerifiedUserId(fx.userId);

    // Two devotionals in June 2026 sharing the same chapter -> a recurring passage.
    const devo1 = await repos.devotionals.create(userId, {
      date: '2026-06-08',
      format: 'short',
      theme: 'rest',
      verses: [
        {
          usfm: 'MAT.11.28',
          versionId: 3034,
          fetchedText: 'Come to me, all you who are weary and burdened, and I will give you rest.',
          attribution: 'Berean Standard Bible',
          reference: 'Matthew 11:28-30',
        },
      ],
      devotionalBody: 'body',
      cardSummary: 'summary',
      prayer: 'prayer',
    });
    const devo2 = await repos.devotionals.create(userId, {
      date: '2026-06-14',
      format: 'short',
      theme: 'rest',
      verses: [
        {
          usfm: 'MAT.11.29',
          versionId: 3034,
          fetchedText: 'Take my yoke upon you and learn from me.',
          attribution: 'Berean Standard Bible',
          reference: 'Matthew 11:29',
        },
      ],
      devotionalBody: 'body',
      cardSummary: 'summary',
      prayer: 'prayer',
    });

    // Sessions joined within June 2026 (backdated joined_at via direct SQL) -> "sat with Scripture 2 times".
    const session1 = await repos.sessions.create(userId, {
      devotionalId: devo1.id,
      expiresAt: new Date('2026-06-10T00:00:00.000Z'),
    });
    await pool.query('UPDATE sessions SET joined_at = $2 WHERE token = $1', [
      session1.token,
      new Date('2026-06-08T12:00:00.000Z'),
    ]);
    const session2 = await repos.sessions.create(userId, {
      devotionalId: devo2.id,
      expiresAt: new Date('2026-06-16T00:00:00.000Z'),
    });
    await pool.query('UPDATE sessions SET joined_at = $2 WHERE token = $1', [
      session2.token,
      new Date('2026-06-14T12:00:00.000Z'),
    ]);

    // A heavy signal in the week ending the 14th (days 8-14).
    await repos.dailyBands.upsertForDate(userId, {
      date: '2026-06-13',
      recovery: 'low',
      sleepQuality: 'poor',
      distressSignal: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/recap/2026/6',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.sessionsCount).toBe(2);
    expect(body.data.recurringPassages).toEqual(['Matthew 11']);
    expect(body.data.heavyWeek).toEqual({ label: 'the week of the 14th' });
    expect(body.data.narrative).toContain('sat with Scripture 2 times');
    expect(body.data.narrative).toContain('Matthew 11');
    expect(body.data.narrative).toContain('the week of the 14th');
    expect(() => MonthlyRecapResponseSchema.parse(body)).not.toThrow();
  });

  it('GET /v1/recap/:year/:month — malformed year/month path params -> 404 (never confirms/denies existence)', async () => {
    const fx = await setupUser('recap-invalid-params');
    const badMonth = await app.inject({
      method: 'GET',
      url: '/v1/recap/2026/13',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(badMonth.statusCode).toBe(404);

    const badYear = await app.inject({
      method: 'GET',
      url: '/v1/recap/26/6',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(badYear.statusCode).toBe(404);
  });

  it('fixture: recap.month.json .response and .responseEmpty both validate MonthlyRecapResponseSchema (anchor for iOS recap client tests)', () => {
    const fixture = loadFixture('recap.month.json') as { response: unknown; responseEmpty: unknown };
    expect(() => MonthlyRecapResponseSchema.parse(fixture.response)).not.toThrow();
    expect(() => MonthlyRecapResponseSchema.parse(fixture.responseEmpty)).not.toThrow();
  });

  it('POST /v1/bands — invalid enum + missing date -> 400 body validates ErrorEnvelopeSchema', async () => {
    const fx = await setupUser('bands-post-invalid');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { recovery: 'not-a-real-enum-value' },
    });
    expect(res.statusCode).toBe(400);
    expect(() => ErrorEnvelopeSchema.parse(res.json())).not.toThrow();
  });

  it('fixture: bands.upload.json .response validates BandsUploadResponseSchema (anchor for iOS BandUploadClientTests)', async () => {
    const fixture = loadFixture('bands.upload.json') as { response: unknown };
    expect(() => BandsUploadResponseSchema.parse(fixture.response)).not.toThrow();
  });

  it('fixture: account.delete.json .response validates AccountDeletionResponseSchema (anchor for iOS AccountDeletionClientTests)', async () => {
    const fixture = loadFixture('account.delete.json') as { response: unknown };
    expect(() => AccountDeletionResponseSchema.parse(fixture.response)).not.toThrow();
  });

  it('fixture: ledger.today.json .response and .responseEmpty both validate LedgerTodayResponseSchema (anchor for iOS DataLedger, issue #85)', async () => {
    const fixture = loadFixture('ledger.today.json') as { response: unknown; responseEmpty: unknown };
    expect(() => LedgerTodayResponseSchema.parse(fixture.response)).not.toThrow();
    expect(() => LedgerTodayResponseSchema.parse(fixture.responseEmpty)).not.toThrow();
  });
});
