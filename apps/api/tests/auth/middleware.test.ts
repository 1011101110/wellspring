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

/**
 * Covers issue #14's acceptance criteria end-to-end through the real
 * Fastify app + a real protected route (`GET /v1/preferences`), using
 * `FakeTokenVerifier` so no live Firebase project is required:
 *   - valid token -> 200 (and, per issue #69, a resolved users.id — see
 *     tests/routes/authzProbes.integration.test.ts and
 *     tests/auth/firebaseUidProvisioning.integration.test.ts for the
 *     provisioning-specific assertions)
 *   - missing token -> 401
 *   - expired token -> 401
 *   - malformed token -> 401
 *   - tampered signature -> 401
 *
 * Previously exercised the now-deleted `/v1/_auth-demo/*` smoke routes
 * (docs/14 §2.4 / issue #72: "test-only routes ship to production" —
 * `routes/protectedDemo.ts` is gone). Moved onto a real user-scoped route
 * per that issue's fix instruction ("move its middleware assertions onto
 * real routes"). Needs the DB-backed app shape (issue #69: `requireAuth`
 * routes now provision/resolve a `users` row via `UsersRepository`),
 * reusing the kairos-test-pg container (A5 convention, port 5433) like
 * every other DB-backed suite.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
}

describe('auth middleware (via FakeTokenVerifier, through a real protected route)', () => {
  let app: FastifyInstance;
  let verifier: FakeTokenVerifier;
  let audioRootDir: string;

  beforeAll(async () => {
    await pool.query('SELECT 1 FROM users LIMIT 1');
    audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-middleware-audio-'));
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

  it('valid token -> 200, and the request is scoped to the resolved (not raw-claim) userId', async () => {
    // A realistic, non-UUID Firebase-style uid (issue #69's regression
    // shape) — the middleware must resolve THIS to a users.id, not pass
    // it through as one.
    const firebaseUid = 'x7GkPq2mR4YbZ81vNc3W';
    const token = await verifier.mint(firebaseUid, { email: 'someone@example.com' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: {
        authorization: `Bearer ${token}`,
        // Deliberately try to smuggle a different identity — must be ignored.
        'x-user-id': 'attacker-controlled-id',
      },
    });

    // No preferences row exists yet for a brand-new user, but GET now
    // returns the documented column defaults instead of 404ing (docs/14
    // §3.5 / issue #89) — 200 is the CORRECT outcome here and proves auth
    // succeeded and was scoped: a 401 would mean the token was rejected; a
    // 500 would mean provisioning crashed (the pre-#69 bug, since
    // firebaseUid above is not UUID-shaped).
    expect(res.statusCode).toBe(200);

    const resolved = await repos.users.findByFirebaseUid(firebaseUid);
    expect(resolved).not.toBeNull();
    expect(resolved!.email).toBe('someone@example.com');
  });

  it('a second protected route also resolves to the same provisioned user', async () => {
    const firebaseUid = 'aB3-second_kQpR9zM7Yx';
    const token = await verifier.mint(firebaseUid);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/bands',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);

    const resolved = await repos.users.findByFirebaseUid(firebaseUid);
    expect(resolved).not.toBeNull();
  });

  it('missing token -> 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/preferences' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_FAILED');
  });

  it('empty Authorization header -> 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: '' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('non-Bearer scheme -> 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('expired token -> 401', async () => {
    const token = await verifier.mintExpired('some-firebase-uid');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('malformed token (not a JWT at all) -> 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('malformed token (garbage base64 segments) -> 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: 'Bearer aaaa.bbbb.cccc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('tampered signature -> 401', async () => {
    const token = await verifier.mint('some-firebase-uid');
    const parts = token.split('.');
    // Flip a character in the middle of the signature segment (avoids the
    // last base64url character, which — due to padding bits — can decode
    // to the same byte value for more than one input character).
    const sig = parts[2]!;
    const mid = Math.floor(sig.length / 2);
    const flippedChar = sig[mid] === 'A' ? 'B' : 'A';
    parts[2] = sig.slice(0, mid) + flippedChar + sig.slice(mid + 1);
    const tampered = parts.join('.');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('tampered payload (claims edited, signature now invalid) -> 401', async () => {
    const token = await verifier.mint('some-firebase-uid');
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'someone-else', exp: 9999999999 })).toString(
      'base64url',
    );
    const tampered = `${header}.${forgedPayload}.${signature}`;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('token signed by a different keypair -> 401', async () => {
    const otherVerifier = await FakeTokenVerifier.create();
    const token = await otherVerifier.mint('some-firebase-uid');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('public routes remain unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
  });
});
