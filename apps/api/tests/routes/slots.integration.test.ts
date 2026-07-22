/**
 * Integration test for POST /v1/slots (issue #74, docs/03 §8.1). Registers
 * `registerSlotsRoutes` directly on a standalone Fastify instance (NOT
 * `buildApp`, since this route is deliberately unwired from app.ts in
 * Phase 1 of this issue) — same auth middleware/FakeTokenVerifier
 * convention as the rest of the authenticated route test suite, against
 * real (test) Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
} from '../../src/db/repositories/index.js';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerSlotsRoutes } from '../../src/routes/slots.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE candidate_slots, calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
}

let verifier: FakeTokenVerifier;
let app: FastifyInstance;

beforeAll(async () => {
  await pool.query('SELECT 1 FROM users LIMIT 1');
  verifier = await FakeTokenVerifier.create();
  app = Fastify();
  registerAuth(app, verifier, repos.users);
  registerSlotsRoutes(app, { candidateSlots: repos.candidateSlots });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function makeUserAndToken(localPart: string) {
  const row = await repos.users.createUser({
    firebaseUid: `firebase-${localPart}`,
    email: `${localPart}@example.com`,
  });
  const token = await verifier.mint(`firebase-${localPart}`);
  return { userId: row.id, token };
}

describe('POST /v1/slots', () => {
  it('401s without a bearer token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/slots',
      payload: { date: '2026-07-02', slots: [] },
    });
    expect(response.statusCode).toBe(401);
  });

  it('stores candidate slots scoped to the authenticated user and returns a count', async () => {
    const { token } = await makeUserAndToken('slotuser');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/slots',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        date: '2026-07-02',
        slots: [
          { startIso: '2026-07-02T13:00:00.000Z', endIso: '2026-07-02T14:00:00.000Z' },
          { startIso: '2026-07-02T15:00:00.000Z', endIso: '2026-07-02T16:30:00.000Z' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ date: '2026-07-02', count: 2 });
  });

  it('rejects a slot where endIso is not after startIso (400)', async () => {
    const { token } = await makeUserAndToken('badslot');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/slots',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        date: '2026-07-02',
        slots: [{ startIso: '2026-07-02T14:00:00.000Z', endIso: '2026-07-02T13:00:00.000Z' }],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('never leaks another user’s candidate slots — each user only ever sees/stores their own', async () => {
    const userA = await makeUserAndToken('slotsA');
    const userB = await makeUserAndToken('slotsB');

    await app.inject({
      method: 'POST',
      url: '/v1/slots',
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { date: '2026-07-02', slots: [{ startIso: '2026-07-02T13:00:00.000Z', endIso: '2026-07-02T14:00:00.000Z' }] },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/slots',
      headers: { authorization: `Bearer ${userB.token}` },
      payload: { date: '2026-07-02', slots: [] },
    });

    const rowsA = await repos.candidateSlots.getForDate(asVerifiedUserId(userA.userId), '2026-07-02');
    const rowsB = await repos.candidateSlots.getForDate(asVerifiedUserId(userB.userId), '2026-07-02');
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(0);
  });

  it('a re-upload for the same date replaces the prior slots (not additive)', async () => {
    const { token, userId } = await makeUserAndToken('replaceuser');

    await app.inject({
      method: 'POST',
      url: '/v1/slots',
      headers: { authorization: `Bearer ${token}` },
      payload: { date: '2026-07-02', slots: [{ startIso: '2026-07-02T13:00:00.000Z', endIso: '2026-07-02T14:00:00.000Z' }] },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/slots',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        date: '2026-07-02',
        slots: [
          { startIso: '2026-07-02T09:00:00.000Z', endIso: '2026-07-02T10:00:00.000Z' },
          { startIso: '2026-07-02T18:00:00.000Z', endIso: '2026-07-02T19:00:00.000Z' },
        ],
      },
    });

    expect(second.json().data.count).toBe(2);
    const rows = await repos.candidateSlots.getForDate(asVerifiedUserId(userId), '2026-07-02');
    expect(rows).toHaveLength(2);
  });
});
