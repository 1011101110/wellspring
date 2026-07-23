/**
 * P8 (#327): the server-composed `rhythm` object on `GET`/`PUT
 * /v1/preferences`, and the round-trip the "keep my schedule fixed"
 * toggle rides.
 *
 * Same DB-free harness shape as preferencesAdaptive.test.ts. The
 * "survives reload / next evaluation returns fixed_by_user" acceptance is
 * proven end-to-end-minus-Postgres: the PUT's written updates are checked
 * (what the DB would store), the response is re-composed from the stored
 * row (what a reload GET serves), and the REAL `decideCadence` is run
 * over the written state (what P5's next evaluation decides).
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PreferencesResponseSchema } from '@kairos/shared-contracts';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerUserScopedRoutes } from '../../src/routes/userScoped.js';
import { decideCadence } from '../../src/services/rhythm/cadencePolicy.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository } from '../../src/db/repositories/usersRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const FIREBASE_UID = 'firebase-uid-1';

function preferencesRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID,
    window_start_local: '07:00:00',
    window_end_local: '09:00:00',
    active_days: [1, 2, 3, 4, 5],
    cadence: 'weekdays',
    duration_preference: null,
    voice: 'en-US-Chirp3-HD-Kore',
    stillness: 'off',
    lectio: false,
    calendar_enabled: true,
    health_enabled: false,
    communication_enabled: false,
    notify_on_skip: true,
    examen_enabled: false,
    sabbath_day: 0,
    sabbath_enabled: false,
    sabbath_session: false,
    liturgical_seasons_enabled: false,
    min_per_week: 2,
    adaptive_enabled: true,
    adaptive_days_per_week: 3,
    adaptive_reason: 'easing_back',
    adaptive_decided_at: new Date('2026-07-20T06:00:00Z'),
    preferred_time_local: null,
    updated_at: new Date('2026-07-18T00:00:00Z'),
    ...overrides,
  };
}

async function buildTestApp(row: Record<string, unknown> = preferencesRow()) {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const users = {
    findOrCreateByFirebaseUid: vi.fn().mockResolvedValue({ id: USER_ID }),
    adoptTimezone: vi.fn().mockResolvedValue(null),
    findById: vi
      .fn()
      .mockResolvedValue({ id: USER_ID, onboarded_at: null, timezone: 'UTC', language: 'en', translation_id: 3034 }),
    markOnboarded: vi.fn().mockResolvedValue(null),
  } as unknown as UsersRepository;
  // PUT returns the row as the DB would store it: client-writable fields
  // from the request merged over the stored row.
  const update = vi.fn().mockImplementation((_uid: string, updates: Record<string, unknown>) => {
    const applied = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
    return Promise.resolve({ ...row, ...applied });
  });
  registerAuth(app, verifier, users);
  registerUserScopedRoutes(app, {
    repositories: {
      users,
      preferences: { ensureExists: vi.fn().mockResolvedValue(row), update },
    } as unknown as Repositories,
    audioStorage: {} as AudioStorage,
  });
  return { app, token: await verifier.mint(FIREBASE_UID), update };
}

async function getPreferences(app: FastifyInstance, token: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/preferences',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /v1/preferences — server-composed rhythm (#327)', () => {
  it('serves the engine state as the strict rhythm object', async () => {
    const { app, token } = await buildTestApp();
    const response = await getPreferences(app, token);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { rhythm: unknown } };
    expect(body.data.rhythm).toEqual({
      mode: 'adaptive',
      daysPerWeek: 3,
      minPerWeek: 2,
      reason: 'easing_back',
    });
  });

  it('the whole payload parses against the shared response schema (what the web client runs)', async () => {
    const { app, token } = await buildTestApp();
    const response = await getPreferences(app, token);
    const parsed = PreferencesResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
  });

  it('§9 structural: the rhythm object carries exactly the four schedule fields — nothing attendance-shaped', async () => {
    const { app, token } = await buildTestApp();
    const response = await getPreferences(app, token);
    const rhythm = (response.json() as { data: { rhythm: Record<string, unknown> } }).data.rhythm;
    expect(Object.keys(rhythm).sort()).toEqual(['daysPerWeek', 'minPerWeek', 'mode', 'reason']);
  });

  it('a fixed-schedule user reads mode=fixed / fixed_by_user with their full stated day set', async () => {
    const { app, token } = await buildTestApp(preferencesRow({ adaptive_enabled: false }));
    const response = await getPreferences(app, token);
    const body = response.json() as { data: { rhythm: unknown } };
    expect(body.data.rhythm).toEqual({
      mode: 'fixed',
      daysPerWeek: 5,
      minPerWeek: 2,
      reason: 'fixed_by_user',
    });
  });
});

describe('PUT /v1/preferences — the "keep my schedule fixed" round trip (#327)', () => {
  it('adaptiveEnabled:false is written, echoed as a fixed rhythm, and P5\'s next evaluation returns fixed_by_user', async () => {
    const { app, token, update } = await buildTestApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { adaptiveEnabled: false },
    });
    expect(response.statusCode).toBe(200);

    // 1. What the DB stores.
    const written = update.mock.calls[0]![1] as Record<string, unknown>;
    expect(written.adaptive_enabled).toBe(false);

    // 2. What the toggle re-renders from — the SAME response, already fixed.
    const body = response.json() as {
      data: { adaptiveEnabled: boolean; rhythm: { mode: string; reason: string } };
    };
    expect(body.data.adaptiveEnabled).toBe(false);
    expect(body.data.rhythm.mode).toBe('fixed');
    expect(body.data.rhythm.reason).toBe('fixed_by_user');

    // 3. What P5 decides next, over the stored state: the engine is
    //    bypassed before any signal is read.
    const decision = decideCadence(
      {
        scheduledCount: 9,
        engagedScore: 0,
        consecutiveUnjoined: 9,
        lastJoinedAt: null,
        reengagedSinceBackoff: false,
      },
      {
        activeDays: [1, 2, 3, 4, 5],
        minPerWeek: 2,
        adaptiveEnabled: false,
        adaptiveDaysPerWeek: 3,
        adaptiveDecidedAt: new Date('2026-07-20T06:00:00Z'),
      },
      { now: new Date('2026-07-23T12:00:00Z') },
    );
    expect(decision.reason).toBe('fixed_by_user');
    expect(decision.effectiveDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('minPerWeek round-trips into the echoed rhythm object', async () => {
    const { app, token } = await buildTestApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { minPerWeek: 4 },
    });
    const body = response.json() as { data: { rhythm: { minPerWeek: number; daysPerWeek: number; reason: string } } };
    expect(body.data.rhythm.minPerWeek).toBe(4);
    // Raising the floor above the stored 3-day state clamps the summary up
    // to it, mirroring decideCadence's immediate at_floor clamp.
    expect(body.data.rhythm.daysPerWeek).toBe(4);
    expect(body.data.rhythm.reason).toBe('at_floor');
  });
});
