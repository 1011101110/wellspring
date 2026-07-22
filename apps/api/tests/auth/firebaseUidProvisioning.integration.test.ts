/**
 * Issue #69 / docs/14 §1.7 — the exact regression this issue describes:
 * `auth/middleware.ts` used to pass the raw Firebase UID straight through
 * as the `users.id` UUID scoping key. Every EXISTING test minted fake
 * tokens whose `sub` claim WAS a seeded `users.id` — which meant no test
 * ever exercised what a real Firebase ID token's `sub` actually looks
 * like (a Firebase UID: a ~20–28 char alphanumeric string, NOT a UUID),
 * and so no test ever caught that a real token would 500 every `/v1/*`
 * route with a pg `invalid input syntax for type uuid` error.
 *
 * This suite mints tokens with a `sub` in exactly that non-UUID shape
 * and proves the full fixed path end-to-end over real HTTP against real
 * (test) Postgres:
 *   1. First request with a brand-new Firebase UID -> 200 (not 500) and
 *      provisions a `users` row.
 *   2. Second request with the SAME Firebase UID -> reuses that same
 *      row (does not create a duplicate; `users.id` is identical across
 *      both requests).
 *   3. A different Firebase UID's requests can never read/see the first
 *      user's data (cross-user scoping still holds through the
 *      provisioning path, not just through pre-seeded fixture rows).
 *
 * Reuses the kairos-test-pg container (A5 convention, port 5433) — same
 * as every other DB-backed suite.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
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

describe('Firebase UID -> users.id provisioning (issue #69)', () => {
  let app: FastifyInstance;
  let verifier: FakeTokenVerifier;
  let audioRootDir: string;

  beforeAll(async () => {
    await pool.query('SELECT 1 FROM users LIMIT 1');
    audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-uid-provisioning-audio-'));
    verifier = await FakeTokenVerifier.create();
    const audioStorage = new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
    app = buildApp({ tokenVerifier: verifier, repositories: repos, audioStorage });
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(audioRootDir, { recursive: true, force: true });
  });

  it('a realistic non-UUID Firebase uid provisions on first request, is reused on the second, and cross-user scoping holds', async () => {
    // Realistic Firebase-style uid — 20 chars, mixed-case alphanumeric
    // with digits, NOT remotely UUID-shaped (no hyphens, wrong length,
    // wrong character distribution). This is the exact shape that would
    // have thrown pg 22P02 pre-fix when passed directly as a uuid.
    const firebaseUidA = 'x7GkPq2mR4YbZ81vNc3W';
    const firebaseUidB = 'q9Ht4Ln0Ws6Xd23YbMp7';

    const tokenA = await verifier.mint(firebaseUidA, { email: 'user-a@example.com' });

    // --- First request: provisions the row, must NOT 500 -------------
    const firstRes = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    // No preferences row exists yet, but GET now returns the documented
    // column defaults instead of 404ing (docs/14 §3.5 / issue #89) — 200
    // still proves auth succeeded and the request was correctly scoped; a
    // 500 here is exactly the pre-fix bug (uuid cast failure).
    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.statusCode).not.toBe(500);

    const provisioned = await repos.users.findByFirebaseUid(firebaseUidA);
    expect(provisioned).not.toBeNull();
    expect(provisioned!.firebase_uid).toBe(firebaseUidA);
    expect(provisioned!.email).toBe('user-a@example.com');
    // The provisioned id IS a real UUID (the users.id primary key) —
    // structurally different from the Firebase uid that produced it.
    expect(provisioned!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(provisioned!.id).not.toBe(firebaseUidA);

    // --- Second request, same uid: reuses the SAME row, no duplicate -
    const putRes = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { voice: 'voice-a-second-request' },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().data.userId).toBe(provisioned!.id);

    const afterSecond = await repos.users.findByFirebaseUid(firebaseUidA);
    expect(afterSecond!.id).toBe(provisioned!.id); // same row, not a new one

    const countResult = await pool.query('SELECT count(*)::int AS n FROM users WHERE firebase_uid = $1', [
      firebaseUidA,
    ]);
    expect(countResult.rows[0].n).toBe(1); // exactly one row ever created for this uid

    // --- Cross-user scoping: a second, different Firebase uid can never
    // see the first user's data, even through the auto-provisioning path.
    const tokenB = await verifier.mint(firebaseUidB, { email: 'user-b@example.com' });
    const bPrefsRes = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const provisionedB = await repos.users.findByFirebaseUid(firebaseUidB);
    expect(provisionedB).not.toBeNull();
    expect(provisionedB!.id).not.toBe(provisioned!.id);

    // B has no preferences row yet (freshly provisioned) — GET returns the
    // documented column defaults (docs/14 §3.5 / issue #89), never a 404,
    // and never A's row.
    expect(bPrefsRes.statusCode).toBe(200);
    expect(bPrefsRes.json().data.userId).toBe(provisionedB!.id);
    expect(bPrefsRes.json().data.voice).toBe('en-US-Chirp3-HD-Achernar');

    const bBandsRes = await app.inject({
      method: 'GET',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(bBandsRes.statusCode).toBe(200);
    expect(bBandsRes.json().data).toEqual([]); // never sees anything from A

    // Uploading bands as B, then confirming A cannot see B's row (and vice
    // versa) — exercises the full POST /v1/bands + provisioning path
    // together for both users.
    const uploadB = await app.inject({
      method: 'POST',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { date: '2026-07-02', recovery: 'high', sleepQuality: 'good', activity: 'active', busyness: 'light' },
    });
    expect(uploadB.statusCode).toBe(200);

    const aBandsAfter = await app.inject({
      method: 'GET',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(aBandsAfter.statusCode).toBe(200);
    expect(aBandsAfter.json().data).toEqual([]); // A still sees nothing — B's upload never leaked across
  });

  it('two concurrent first-time requests for the same new Firebase uid still resolve to exactly one users row', async () => {
    const firebaseUid = 'racing-uid-9pQr2Wm5Ln';
    const token = await verifier.mint(firebaseUid);

    const [resA, resB] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/bands', headers: { authorization: `Bearer ${token}` } }),
      app.inject({ method: 'GET', url: '/v1/bands', headers: { authorization: `Bearer ${token}` } }),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    const countResult = await pool.query('SELECT count(*)::int AS n FROM users WHERE firebase_uid = $1', [
      firebaseUid,
    ]);
    expect(countResult.rows[0].n).toBe(1);
  });
});
