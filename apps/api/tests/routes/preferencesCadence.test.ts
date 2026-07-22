/**
 * K2 (#188): `cadence` as a preset over `active_days` on `PUT /v1/preferences`.
 *
 * `active_days` is the single source of truth the daily run reads
 * (`internal.ts`, proven in `internal.test.ts`); `cadence` is a derived
 * label over the same set. These tests pin the reconciliation that makes
 * a contradictory stored pair unrepresentable — the pair that shipped as
 * the *column default* of every row (`cadence: 'daily'` next to
 * `active_days: {1,2,3,4,5}`, migration 1720000000000).
 *
 * Asserts on what reaches `PreferencesRepository.update`, i.e. what would
 * actually be written, rather than on the 200 — a route that accepted the
 * body and then wrote the contradiction anyway would pass a status check.
 *
 * DB-free, same harness shape as `preferencesTimezone.test.ts`: no
 * kairos-test-pg container needed.
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
  updated_at: new Date('2026-07-18T00:00:00Z'),
};

async function buildTestApp(): Promise<{
  app: FastifyInstance;
  token: string;
  update: ReturnType<typeof vi.fn>;
}> {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const users = {
    findOrCreateByFirebaseUid: vi.fn().mockResolvedValue({ id: USER_ID }),
    adoptTimezone: vi.fn().mockResolvedValue(null),
    // Both routes read the user row for `onboarded_at` since #225 — it is
    // part of the preferences payload now (docs/03 §8.1). Irrelevant to
    // cadence, but the route calls it, so the fake has to answer.
    findById: vi.fn().mockResolvedValue({ id: USER_ID, onboarded_at: null }),
    markOnboarded: vi.fn().mockResolvedValue(null),
  } as unknown as UsersRepository;
  const update = vi.fn().mockResolvedValue(PREFERENCES_ROW);

  registerAuth(app, verifier, users);
  registerUserScopedRoutes(app, {
    repositories: {
      users,
      preferences: { ensureExists: vi.fn().mockResolvedValue(PREFERENCES_ROW), update },
    } as unknown as Repositories,
    audioStorage: {} as AudioStorage,
  });
  return { app, token: await verifier.mint(FIREBASE_UID), update };
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

describe('PUT /v1/preferences — cadence as an active_days preset (#188)', () => {
  it('expands cadence "daily" into all seven days', async () => {
    // The preset is what makes cadence more than a label the daily run
    // ignores: picking Daily has to actually change which days generate.
    const { app, token, update } = await buildTestApp();

    const response = await putPreferences(app, token, { cadence: 'daily' });

    expect(response.statusCode).toBe(200);
    const written = writtenUpdates(update);
    expect(written.active_days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(written.cadence).toBe('daily');
    await app.close();
  });

  it('expands cadence "weekdays" into Mon–Fri', async () => {
    const { app, token, update } = await buildTestApp();

    const response = await putPreferences(app, token, { cadence: 'weekdays' });

    expect(response.statusCode).toBe(200);
    const written = writtenUpdates(update);
    expect(written.active_days).toEqual([1, 2, 3, 4, 5]);
    expect(written.cadence).toBe('weekdays');
    await app.close();
  });

  it('leaves the stored days alone for cadence "custom"', async () => {
    // "Custom" means "the days I picked" — it is not a day set of its own,
    // so a cadence-only write of it must not overwrite the user's
    // selection with some invented default. `undefined` hits the
    // repository's COALESCE and leaves the column untouched.
    const { app, token, update } = await buildTestApp();

    const response = await putPreferences(app, token, { cadence: 'custom' });

    expect(response.statusCode).toBe(200);
    const written = writtenUpdates(update);
    expect(written.active_days).toBeUndefined();
    expect(written.cadence).toBe('custom');
    await app.close();
  });

  it('derives the cadence label from activeDays when both are sent', async () => {
    // A client sending Sat/Sun with cadence "daily" is describing two
    // different schedules. The days are the choice; the cadence is only
    // its name, so the name is recomputed rather than stored as sent.
    const { app, token, update } = await buildTestApp();

    const response = await putPreferences(app, token, {
      activeDays: [0, 6],
      cadence: 'daily',
    });

    expect(response.statusCode).toBe(200);
    const written = writtenUpdates(update);
    expect(written.active_days).toEqual([0, 6]);
    expect(written.cadence).toBe('custom');
    await app.close();
  });

  it('corrects the pre-#188 default pair rather than 400ing on it', async () => {
    // `cadence: 'daily'` + `active_days: {1,2,3,4,5}` is the stored default
    // of every row written before #188, so every client faithfully
    // round-tripping a row it read back from us will send exactly this.
    // Rejecting our own legacy would break those clients; correcting it
    // silently is the compatible move.
    const { app, token, update } = await buildTestApp();

    const response = await putPreferences(app, token, {
      activeDays: [1, 2, 3, 4, 5],
      cadence: 'daily',
    });

    expect(response.statusCode).toBe(200);
    expect(writtenUpdates(update).cadence).toBe('weekdays');
    await app.close();
  });

  it('touches neither column when the request mentions neither', async () => {
    // Every pre-#188 client that only syncs, say, its voice must not have
    // its schedule rewritten as a side effect.
    const { app, token, update } = await buildTestApp();

    const response = await putPreferences(app, token, { voice: 'warm' });

    expect(response.statusCode).toBe(200);
    const written = writtenUpdates(update);
    expect(written.active_days).toBeUndefined();
    expect(written.cadence).toBeUndefined();
    await app.close();
  });

  it('rejects an empty activeDays instead of silently switching the user off', async () => {
    // Inert before #188 (nothing read the column); since #188 it means
    // "never generate again". No UI offers it and no user means it by
    // editing their days — a user who wants Wellspring to stop disconnects or
    // deletes their account. A 400 is the loud answer.
    const { app, token, update } = await buildTestApp();

    const response = await putPreferences(app, token, { activeDays: [] });

    expect(response.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
    await app.close();
  });
});
