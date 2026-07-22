/**
 * Integration tests for POST /v1/devotional/generate-now (the "I could use
 * a moment now" distress check-in front door, docs/14 §5.8, issue #77).
 * Real Fastify app (`buildApp`) + real (test) Postgres, same
 * kairos-test-pg bootstrap pattern as contract.integration.test.ts, but
 * with a FAKE GenerateNowOrchestrator (this route's own concerns —
 * auth/validation/wiring/response-shape/error-mapping — don't need a real
 * Gloo/YouVersion/TTS round trip; that's what
 * generateNowOrchestrator.test.ts already covers).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { GenerateNowOrchestrator } from '../../src/services/orchestrator/generateNowOrchestrator.js';

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
let appWithOrchestrator: FastifyInstance;
let appWithoutOrchestrator: FastifyInstance;
let orchestrator: GenerateNowOrchestrator;

function fakeOrchestrator(impl: () => Promise<unknown>): GenerateNowOrchestrator {
  return { generateNow: vi.fn().mockImplementation(impl) } as unknown as GenerateNowOrchestrator;
}

const SUCCESS_RESULT = {
  sessionUrl: 'http://localhost:8080/session/tok-distress',
  sessionToken: 'tok-distress',
  devotionalId: 'devo-distress',
  devotional: { format: 'micro', theme: 'Rest', cardSummary: 'A brief word of comfort.' },
  source: 'gloo',
  audio: { status: 'uploaded', objectKey: 'devotionals/devo-distress.mp3' },
};

beforeAll(async () => {
  await pool.query('SELECT 1 FROM users LIMIT 1');
  audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-distress-audio-'));
  verifier = await FakeTokenVerifier.create();
  const audioStorage = new LocalFileAudioStorage({
    rootDir: audioRootDir,
    signingSecret: 'a'.repeat(32),
  });

  orchestrator = fakeOrchestrator(() => Promise.resolve(SUCCESS_RESULT));

  appWithOrchestrator = buildApp({
    tokenVerifier: verifier,
    repositories: repos,
    audioStorage,
    generateNowOrchestrator: orchestrator,
  });

  appWithoutOrchestrator = buildApp({
    tokenVerifier: verifier,
    repositories: repos,
    audioStorage,
  });
});

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
});

afterAll(async () => {
  await appWithOrchestrator.close();
  await appWithoutOrchestrator.close();
  await pool.end();
  await rm(audioRootDir, { recursive: true, force: true });
});

async function setupUser(suffix: string): Promise<{ userId: string; token: string }> {
  const firebaseUid = `distress-${suffix}`;
  const user = await repos.users.createUser({
    firebaseUid,
    email: `${suffix}@example.com`,
  });
  const userId = asVerifiedUserId(user.id);
  const token = await verifier.mint(firebaseUid);
  return { userId, token };
}

describe('POST /v1/devotional/generate-now (distress check-in, issue #77)', () => {
  it('401s with no Authorization header', async () => {
    const res = await appWithOrchestrator.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('501s when generateNowOrchestrator is not wired', async () => {
    const fx = await setupUser('not-configured');
    const res = await appWithoutOrchestrator.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_CONFIGURED');
  });

  it('calls generateNow with distressSignalOverride=true, skipIdempotencyCheck=true, skipCalendar=true for an empty body', async () => {
    const fx = await setupUser('empty-body');
    const res = await appWithOrchestrator.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({
      userId: fx.userId,
      distressSignalOverride: true,
      skipIdempotencyCheck: true,
      skipCalendar: true,
    });
  });

  it('honors an explicit distressSignal:true in the body', async () => {
    const fx = await setupUser('explicit-true');
    const res = await appWithOrchestrator.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { distressSignal: true },
    });

    expect(res.statusCode).toBe(200);
    expect(orchestrator.generateNow).toHaveBeenCalledWith(
      expect.objectContaining({ distressSignalOverride: true }),
    );
  });

  it('an explicit distressSignal:false in the body is respected — only an absent field defaults to true', async () => {
    const fx = await setupUser('explicit-false');
    const res = await appWithOrchestrator.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { distressSignal: false },
    });

    expect(res.statusCode).toBe(200);
    expect(orchestrator.generateNow).toHaveBeenCalledWith(
      expect.objectContaining({ distressSignalOverride: false }),
    );
  });

  it('returns sessionUrl, devotionalId, and the session-summary data shape on success', async () => {
    const fx = await setupUser('success-shape');
    const res = await appWithOrchestrator.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionUrl).toBe(SUCCESS_RESULT.sessionUrl);
    expect(body.devotionalId).toBe(SUCCESS_RESULT.devotionalId);
    expect(body.data.sessionToken).toBe(SUCCESS_RESULT.sessionToken);
    expect(body.data.source).toBe(SUCCESS_RESULT.source);
    expect(body.data.audio).toEqual(SUCCESS_RESULT.audio);
    expect(body.data.devotional).toEqual(SUCCESS_RESULT.devotional);
  });

  it('400s on a malformed body (distressSignal not a boolean)', async () => {
    const fx = await setupUser('bad-body');
    const res = await appWithOrchestrator.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: { distressSignal: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('502s and does not leak the raw error when the orchestrator throws', async () => {
    const fx = await setupUser('upstream-error');
    const failingOrchestrator = fakeOrchestrator(() => Promise.reject(new Error('gloo is down')));
    const audioStorage = new LocalFileAudioStorage({ rootDir: audioRootDir, signingSecret: 'a'.repeat(32) });
    const failingApp = buildApp({
      tokenVerifier: verifier,
      repositories: repos,
      audioStorage,
      generateNowOrchestrator: failingOrchestrator,
    });

    const res = await failingApp.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: { authorization: `Bearer ${fx.token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(body)).not.toContain('gloo is down');

    await failingApp.close();
  });
});
