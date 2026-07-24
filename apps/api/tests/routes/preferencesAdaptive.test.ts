/**
 * P5 (#324): `min_per_week` / `adaptive_enabled` on `PUT /v1/preferences`,
 * and — the §9-relevant half — that the engine's state columns can NOT be
 * written from a request body.
 *
 * Same DB-free harness shape as `preferencesCadence.test.ts`, and the
 * same standard of proof: assertions are on what reaches
 * `PreferencesRepository.update` (what would actually be written), not on
 * the 200.
 *
 * A note on "strict schema": the acceptance criterion says the route
 * rejects client writes to `adaptive_days_per_week`/`adaptive_reason`.
 * This codebase's contract deliberately STRIPS unknown keys instead of
 * 400ing (see the non-`.strict()` rationale on
 * `PreferencesUpdateRequestSchema` — a client sending a newer payload
 * must not break), so "rejects" here means the stronger structural
 * claim these tests pin: the fields never reach the repository, from any
 * spelling, and the repository's client path (`PreferencesUpdate`)
 * cannot even name them at the type level.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerUserScopedRoutes } from '../../src/routes/userScoped.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository } from '../../src/db/repositories/usersRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const FIREBASE_UID = 'firebase-uid-1';

const PREFERENCES_ROW = {
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
  yv_write_highlights: false,
  yv_read_highlights: false,
  min_per_week: 2,
  adaptive_enabled: true,
  adaptive_days_per_week: 3,
  adaptive_reason: 'easing_back',
  adaptive_decided_at: new Date('2026-07-20T06:00:00Z'),
  updated_at: new Date('2026-07-18T00:00:00Z'),
};

async function buildTestApp(): Promise<{
  app: FastifyInstance;
  token: string;
  update: ReturnType<typeof vi.fn>;
  yvGet: ReturnType<typeof vi.fn>;
}> {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const users = {
    findOrCreateByFirebaseUid: vi.fn().mockResolvedValue({ id: USER_ID }),
    adoptTimezone: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue({ id: USER_ID, onboarded_at: null }),
    markOnboarded: vi.fn().mockResolvedValue(null),
  } as unknown as UsersRepository;
  const update = vi.fn().mockResolvedValue(PREFERENCES_ROW);
  const yvGet = vi.fn().mockResolvedValue(null);

  registerAuth(app, verifier, users);
  registerUserScopedRoutes(app, {
    repositories: {
      users,
      preferences: { ensureExists: vi.fn().mockResolvedValue(PREFERENCES_ROW), update },
      youversionConnections: { get: yvGet },
    } as unknown as Repositories,
    audioStorage: {} as AudioStorage,
  });
  return { app, token: await verifier.mint(FIREBASE_UID), update, yvGet };
}

async function putPreferences(
  app: FastifyInstance,
  token: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'PUT',
    url: '/v1/preferences',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

/** The `updates` object the route handed the repository. */
function writtenUpdates(update: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(update).toHaveBeenCalledTimes(1);
  return update.mock.calls[0]![1] as Record<string, unknown>;
}

describe('PUT /v1/preferences — adaptive rhythm preferences (#324)', () => {
  it('writes minPerWeek and adaptiveEnabled through to the repository', async () => {
    const { app, token, update } = await buildTestApp();
    const response = await putPreferences(app, token, { minPerWeek: 4, adaptiveEnabled: false });
    expect(response.statusCode).toBe(200);
    const updates = writtenUpdates(update);
    expect(updates.min_per_week).toBe(4);
    expect(updates.adaptive_enabled).toBe(false);
  });

  it('leaves both columns alone when the body does not mention them', async () => {
    const { app, token, update } = await buildTestApp();
    await putPreferences(app, token, { voice: 'calm' });
    const updates = writtenUpdates(update);
    expect(updates.min_per_week).toBeUndefined();
    expect(updates.adaptive_enabled).toBeUndefined();
  });

  it.each([0, 8, 2.5, 'three'])('rejects minPerWeek %j with a 400', async (bad) => {
    const { app, token, update } = await buildTestApp();
    const response = await putPreferences(app, token, { minPerWeek: bad });
    expect(response.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('echoes minPerWeek and adaptiveEnabled in the response payload', async () => {
    const { app, token } = await buildTestApp();
    const response = await putPreferences(app, token, { minPerWeek: 2 });
    const body = response.json() as { data: Record<string, unknown> };
    expect(body.data.minPerWeek).toBe(2);
    expect(body.data.adaptiveEnabled).toBe(true);
  });

  /**
   * The server-owned state columns. The body below tries every plausible
   * spelling; none may reach the repository. Mutation check: map any of
   * them in the route's `updates` object (or add them to the request
   * schema) and the exact-key assertion fails.
   */
  it('never forwards engine state fields from a client body, in any spelling', async () => {
    const { app, token, update } = await buildTestApp();
    const response = await putPreferences(app, token, {
      minPerWeek: 3,
      adaptiveDaysPerWeek: 1,
      adaptive_days_per_week: 1,
      adaptiveReason: 'welcoming_back',
      adaptive_reason: 'welcoming_back',
      adaptiveDecidedAt: '2020-01-01T00:00:00Z',
      adaptive_decided_at: '2020-01-01T00:00:00Z',
    });
    // Unknown keys are stripped, not 400'd (schema doc) — the request
    // itself succeeds…
    expect(response.statusCode).toBe(200);
    // …but nothing engine-owned was written, or even mentioned.
    const updates = writtenUpdates(update);
    for (const key of Object.keys(updates)) {
      expect(
        ['adaptive_days_per_week', 'adaptive_reason', 'adaptive_decided_at'].includes(key),
        `engine state column ${key} must not be client-writable`,
      ).toBe(false);
    }
    expect(updates.min_per_week).toBe(3);
  });

  /**
   * And the engine state never leaks out through this surface either —
   * P8 (#327) composes §9-safe copy over it; the raw ladder position and
   * reason code stay server-side until then. The fake row above holds
   * real-looking state (`easing_back`, 3 days/week), so a mapper that
   * started echoing it would fail here.
   */
  it('does not expose adaptive engine state in the response', async () => {
    const { app, token } = await buildTestApp();
    const response = await putPreferences(app, token, {});
    const body = response.json() as { data: Record<string, unknown> };
    expect(body.data.adaptiveDaysPerWeek).toBeUndefined();
    expect(body.data.adaptiveReason).toBeUndefined();
    expect(body.data.adaptiveDecidedAt).toBeUndefined();
  });
});

describe('PUT /v1/preferences — YouVersion consent flags (U2, kairos-devotional#355)', () => {
  it('writes both consent flags through to the repository', async () => {
    const { app, token, update } = await buildTestApp();
    const response = await putPreferences(app, token, {
      yvWriteHighlights: true,
      yvReadHighlights: true,
    });
    expect(response.statusCode).toBe(200);
    const updates = writtenUpdates(update);
    expect(updates.yv_write_highlights).toBe(true);
    expect(updates.yv_read_highlights).toBe(true);
  });

  it('is sparse — toggling one flag does not clobber the other (S3 no-clobber)', async () => {
    const { app, token, update } = await buildTestApp();
    await putPreferences(app, token, { yvWriteHighlights: true });
    const updates = writtenUpdates(update);
    // Only the named flag is written; the other is `undefined`, which the
    // repository's COALESCE leaves at its stored value.
    expect(updates.yv_write_highlights).toBe(true);
    expect(updates.yv_read_highlights).toBeUndefined();
  });

  it('leaves both flags alone when the body does not mention them', async () => {
    const { app, token, update } = await buildTestApp();
    await putPreferences(app, token, { voice: 'calm' });
    const updates = writtenUpdates(update);
    expect(updates.yv_write_highlights).toBeUndefined();
    expect(updates.yv_read_highlights).toBeUndefined();
  });
});

describe('GET /v1/preferences — YouVersion connection status (U2/U5, kairos-devotional#355)', () => {
  it('reports { connected: false } when there is no stored connection', async () => {
    const { app, token } = await buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = response.json() as { data: { youversionConnection?: unknown } };
    expect(body.data.youversionConnection).toEqual({ connected: false });
  });

  it('composes the §9-safe status (connected + display name) from the store', async () => {
    const { app, token, yvGet } = await buildTestApp();
    yvGet.mockResolvedValueOnce({ display_name: 'Ada Lovelace' });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/preferences',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = response.json() as {
      data: { youversionConnection?: unknown; yvWriteHighlights?: unknown };
    };
    expect(body.data.youversionConnection).toEqual({ connected: true, displayName: 'Ada Lovelace' });
    // And the consent flags are echoed from the preferences row.
    expect(body.data.yvWriteHighlights).toBe(false);
  });
});
