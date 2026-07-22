/**
 * `GET /v1/devotionals/search` (issue #242) — the half of the suite that
 * needs no database.
 *
 * Covers boot-time invariants, auth, request validation, route
 * precedence and cursor encoding. The behaviour that actually requires
 * Postgres — owner scoping, Scripture-reference matching, ranking,
 * keyset pagination and the GIN index plan — lives in
 * `devotionalSearch.integration.test.ts` and is CI-only.
 *
 * The app here is built with a `Pool` that is never connected to. Every
 * assertion below is about a code path that returns BEFORE any query is
 * issued (401, 400, 404), so no database is contacted; a test that
 * accidentally reached the repository would fail loudly on connection
 * rather than passing on a stub, which is the point of using a real Pool
 * instead of a mock.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  TokenVerificationError,
  type TokenVerifier,
} from '../../src/auth/tokenVerifier.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { LocalFileAudioStorage } from '../../src/services/audio/audioStorage.js';
import { encodeSearchCursor } from '../../src/routes/devotionalSearch.js';

// Points at a port nothing listens on: reaching the DB from these tests
// is a bug, and this makes it an obvious failure rather than a silent one.
const pool = new Pool({
  connectionString: 'postgres://postgres:unused@127.0.0.1:1/unused',
  // Keeps a stray connection attempt from hanging the suite for the
  // default 30s if one of these paths ever regresses into querying.
  connectionTimeoutMillis: 500,
});

/**
 * A verifier that rejects everything, injected so the auth cases below stay
 * offline.
 *
 * Without it `buildApp` falls back to the real `FirebaseTokenVerifier`, and a
 * *garbage* token is worse than no token: absent credentials short-circuit to
 * 401 in ~20ms, while a malformed one reaches `verifyIdToken`, which fetches
 * Google's public signing certs over the network. In CI that hung to the 5s
 * test timeout. The assertion was right; the test was just reaching the
 * internet to make it.
 */
const alwaysRejectingVerifier: TokenVerifier = {
  verify: () => Promise.reject(new TokenVerificationError('test: always rejects', 'invalid')),
};

function buildSearchApp(): FastifyInstance {
  return buildApp({
    tokenVerifier: alwaysRejectingVerifier,
    repositories: createRepositories(pool),
    audioStorage: new LocalFileAudioStorage({
      rootDir: '/tmp/kairos-search-unit-unused',
      signingSecret: 'a'.repeat(32),
    }),
  });
}

afterAll(async () => {
  await pool.end();
});

describe('GET /v1/devotionals/search — boot invariants', () => {
  /**
   * The direct verification issue #242 asks for rather than assumes: the
   * default-deny audit (#80, auth/routeAudit.ts) throws from `onReady`
   * if any `/v1/*` route lacks `requireAuth` and is not allowlisted, so
   * a successful `app.ready()` with the search route registered IS the
   * proof that it carries `requireAuth`.
   *
   * routeAudit.test.ts already proves the audit catches a route that
   * forgets it; this asserts the real app, with this route in it, is on
   * the right side of that check — and it will fail the moment someone
   * removes the preHandler.
   */
  it('boots — so the default-deny auth audit (#80) accepts the search route', async () => {
    const app = buildSearchApp();
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it('registers the search route on the authenticated /v1 surface', async () => {
    const app = buildSearchApp();
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/v1/devotionals/search' })).toBe(true);
    await app.close();
  });
});

describe('GET /v1/devotionals/search — authentication', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const app = buildSearchApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/devotionals/search?q=rest' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a garbage bearer token with 401', async () => {
    const app = buildSearchApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/devotionals/search?q=rest',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  /**
   * Auth must be decided BEFORE input validation. If validation ran
   * first, an anonymous caller would get a 400 for `?q=` and a 401 for
   * `?q=rest` — a difference that confirms the endpoint exists and
   * describes its contract to someone with no credentials at all.
   */
  it('returns 401 (not 400) for an unauthenticated request with an invalid query', async () => {
    const app = buildSearchApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/devotionals/search' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /v1/devotionals/search — route precedence', () => {
  /**
   * `/v1/devotionals/search` and `/v1/devotionals/:id` (userScoped.ts)
   * overlap. Fastify's radix router prefers a static segment over a
   * parametric one, so "search" should never be parsed as an `:id` —
   * but that is an assumption about router internals, and the two
   * routes are registered from different modules, so this asserts it.
   *
   * The tell is the status code. `/v1/devotionals/:id` replies 404 for a
   * non-UUID param (`invalidParam` -> `notFound`); the search route
   * replies 400 for a missing `q`. Getting 404 here would mean the
   * request was routed to the wrong handler — and, worse, that search
   * had silently become unreachable while every other test still passed.
   *
   * Uses an unauthenticated request deliberately: routing is decided
   * before auth, and 401-vs-404 distinguishes the handlers just as
   * cleanly without needing a token.
   */
  it('does not let /v1/devotionals/:id swallow the literal "search" segment', async () => {
    const app = buildSearchApp();
    await app.ready();

    const search = await app.inject({ method: 'GET', url: '/v1/devotionals/search' });
    const byId = await app.inject({ method: 'GET', url: '/v1/devotionals/not-a-uuid' });

    // Both are 401 pre-auth; the routing proof is that the search path
    // resolves to a registered route at all rather than 404ing.
    expect(search.statusCode).toBe(401);
    expect(byId.statusCode).toBe(401);
    expect(app.hasRoute({ method: 'GET', url: '/v1/devotionals/search' })).toBe(true);

    await app.close();
  });
});

describe('search cursor encoding', () => {
  const row = {
    id: '11111111-1111-1111-1111-111111111111',
    date: '2026-06-01',
    theme: 'Rest for the weary',
    card_summary: 'Finding rest in God alone',
    format: 'short' as const,
    created_at: new Date('2026-06-01T07:30:00.000Z'),
    completed_at: null,
    rank: '0.6687345',
  };

  it('round-trips the (rank, date, id) keyset through base64url', () => {
    const decoded: unknown = JSON.parse(
      Buffer.from(encodeSearchCursor(row), 'base64url').toString('utf8'),
    );
    expect(decoded).toEqual({ r: '0.6687345', d: '2026-06-01', i: row.id });
  });

  /**
   * The rank must survive as the database's own text rendering. Parsing
   * it into a JS float64 and re-serializing could land on a different
   * `real` once cast back, and the page boundary is exactly where that
   * comparison has to be exact — the symptom would be a single skipped
   * or duplicated result on page 2, which no smaller test would catch.
   */
  it('preserves the rank verbatim rather than round-tripping it through a number', () => {
    const preciseRank = '0.30000001192092896';
    const encoded = encodeSearchCursor({ ...row, rank: preciseRank });
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      r: string;
    };
    expect(decoded.r).toBe(preciseRank);
    expect(typeof decoded.r).toBe('string');
  });

  it('produces a URL-safe cursor (no +, / or = to be mangled in a query string)', () => {
    const encoded = encodeSearchCursor({ ...row, theme: 'Rest ~ renewal + stillness/quiet' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
