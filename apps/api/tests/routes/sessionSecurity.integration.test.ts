/**
 * Rate limiting + security headers on the public session surface (EPIC
 * F, issue #45). Contract: docs/04_DATA_PRIVACY_SECURITY.md §5.3 ("strict
 * CSP, no third-party scripts on the session page") and §5.4 ("rate
 * limiting on public endpoints [session fetch, completion] keyed by
 * token+IP").
 *
 * Reuses kairos-test-pg (A5 convention, port 5433).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from '../../src/app.js';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
} from '../../src/db/repositories/index.js';
import { SessionService } from '../../src/services/session/sessionService.js';
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

beforeAll(async () => {
  await pool.query('SELECT 1 FROM users LIMIT 1');
  audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-session-security-audio-'));
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
  await rm(audioRootDir, { recursive: true, force: true });
});

function minimalDevotional(
  overrides: Partial<Parameters<Repositories['devotionals']['create']>[1]> = {},
) {
  return {
    date: '2026-07-02',
    format: 'short' as const,
    theme: 'Rest for the weary',
    verses: [
      {
        usfm: 'MAT.11.28',
        versionId: 3034,
        reference: 'Matthew 11:28',
        fetchedText: 'Come to me, all you who are weary and burdened, and I will give you rest.',
        attribution: 'Berean Standard Bible',
      },
    ],
    devotionalBody: 'A short devotional body about rest.',
    cardSummary: 'Rest for the weary.',
    prayer: 'Lord, grant me rest.',
    ...overrides,
  };
}

async function buildTestApp(rateLimit: { max: number; timeWindowMs: number }) {
  const audioStorage = new LocalFileAudioStorage({
    rootDir: audioRootDir,
    signingSecret: 'a'.repeat(32),
  });
  const sessionService = new SessionService({
    sessions: repos.sessions,
    devotionals: repos.devotionals,
    audioStorage,
  });
  const app = buildApp({ sessionService, sessionRateLimit: rateLimit });
  return app;
}

async function makeSession() {
  const user = await repos.users.createUser({
    firebaseUid: `fb-security-${Math.random()}`,
    email: 'security@example.com',
  });
  const userId = asVerifiedUserId(user.id);
  const devo = await repos.devotionals.create(userId, minimalDevotional());
  return repos.sessions.create(userId, {
    devotionalId: devo.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
}

describe('Security headers on the session page', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('GET /session/:token has a strict CSP with no third-party script sources', async () => {
    app = await buildTestApp({ max: 1000, timeWindowMs: 60_000 });
    const session = await makeSession();

    const res = await app.inject({ method: 'GET', url: `/session/${session.token}` });

    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No third-party script origin anywhere in the policy string.
    expect(csp).not.toMatch(/script-src[^;]*https?:\/\//);
  });

  it('CSP is present even on the 404 (unknown token) page', async () => {
    app = await buildTestApp({ max: 1000, timeWindowMs: 60_000 });
    const res = await app.inject({
      method: 'GET',
      url: '/session/00000000-0000-4000-8000-000000000000',
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toContain("script-src 'none'");
  });

  it('HSTS header is present on the session page', async () => {
    app = await buildTestApp({ max: 1000, timeWindowMs: 60_000 });
    const session = await makeSession();
    const res = await app.inject({ method: 'GET', url: `/session/${session.token}` });
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('security headers are NOT applied to unrelated routes (e.g. /status)', async () => {
    app = await buildTestApp({ max: 1000, timeWindowMs: 60_000 });
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('Rate limiting on the session surface', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('GET /session/:token returns 429 after exceeding the limit for that token+IP', async () => {
    app = await buildTestApp({ max: 3, timeWindowMs: 60_000 });
    const session = await makeSession();

    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: `/session/${session.token}` });
      results.push(res.statusCode);
    }

    expect(results.slice(0, 3)).toEqual([200, 200, 200]);
    expect(results.slice(3)).toEqual([429, 429]);
  });

  it('429 response still carries the ok:false error envelope', async () => {
    app = await buildTestApp({ max: 1, timeWindowMs: 60_000 });
    const session = await makeSession();

    await app.inject({ method: 'GET', url: `/session/${session.token}` });
    const limited = await app.inject({ method: 'GET', url: `/session/${session.token}` });

    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('POST /session/:token/complete is independently rate-limited', async () => {
    app = await buildTestApp({ max: 2, timeWindowMs: 60_000 });
    const session = await makeSession();

    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: 'POST', url: `/session/${session.token}/complete` });
      results.push(res.statusCode);
    }

    // First two succeed (200, idempotent complete), then 429s.
    expect(results[0]).toBe(200);
    expect(results[1]).toBe(200);
    expect(results.slice(2)).toEqual([429, 429]);
  });

  it('rate limit is keyed by token — a different token gets its own budget even from the same IP', async () => {
    app = await buildTestApp({ max: 1, timeWindowMs: 60_000 });
    const sessionA = await makeSession();
    const sessionB = await makeSession();

    const firstA = await app.inject({ method: 'GET', url: `/session/${sessionA.token}` });
    const secondA = await app.inject({ method: 'GET', url: `/session/${sessionA.token}` });
    const firstB = await app.inject({ method: 'GET', url: `/session/${sessionB.token}` });

    expect(firstA.statusCode).toBe(200);
    expect(secondA.statusCode).toBe(429); // A's budget exhausted
    expect(firstB.statusCode).toBe(200); // B has its own budget despite same IP
  });
});
