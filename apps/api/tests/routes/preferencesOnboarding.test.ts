/**
 * Issue #225: server-authoritative onboarding completion and consent, over
 * `GET`/`PUT /v1/preferences`.
 *
 * The acceptance criterion these exist to prove is a *round trip*, not a
 * status code: a value written through the API by one surface has to be
 * visible to the other surface's next read. Per #193's standard of proof,
 * "the route called the repository" is not evidence — `users.timezone` was
 * threaded through every layer correctly for months and still produced a
 * 3:30am devotional. So the users repository here is a small **stateful
 * fake** that actually stores what it is told, rather than a `vi.fn()`
 * returning a canned row: a route that accepted `onboardingCompleted` and
 * then wrote nothing would pass a mock-assertion test and fail these.
 *
 * DB-free, same harness shape as `preferencesCadence.test.ts` — no
 * kairos-test-pg container needed.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerUserScopedRoutes } from '../../src/routes/userScoped.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository, UserRow } from '../../src/db/repositories/usersRepository.js';
import type { PreferencesRow } from '../../src/db/repositories/preferencesRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const FIREBASE_UID = 'firebase-uid-1';

const BASE_PREFERENCES_ROW: PreferencesRow = {
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
  health_enabled: true,
  communication_enabled: true,
  notify_on_skip: true,
  examen_enabled: false,
  sabbath_day: 0,
  sabbath_enabled: false,
  sabbath_session: false,
  liturgical_seasons_enabled: false,
  updated_at: new Date('2026-07-18T00:00:00Z'),
};

/**
 * Stateful stand-ins for the two repositories this route touches.
 *
 * `users.markOnboarded` reproduces the real query's first-write-wins
 * semantics (`WHERE onboarded_at IS NULL`) rather than just recording the
 * call, because "a second call must not move the timestamp" is a behavior
 * these tests assert, and a mock cannot exhibit it.
 *
 * `preferences.update` reproduces COALESCE: `undefined` leaves the stored
 * column alone. That is what makes "a PUT of one field does not clobber the
 * others" a real assertion here.
 */
function buildFakeRepositories(initialOnboardedAt: Date | null) {
  const userRow = {
    id: USER_ID,
    firebase_uid: FIREBASE_UID,
    email: null,
    tradition: 'general',
    translation_id: 3034,
    timezone: 'UTC',
    timezone_source: 'default',
    onboarded_at: initialOnboardedAt,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  } as unknown as UserRow;

  const preferencesRow: PreferencesRow = { ...BASE_PREFERENCES_ROW };

  const markOnboarded = vi.fn(async () => {
    if (userRow.onboarded_at !== null) return null;
    userRow.onboarded_at = new Date('2026-07-18T12:00:00Z');
    return userRow;
  });

  const update = vi.fn(async (_userId: string, updates: Record<string, unknown>) => {
    for (const [column, value] of Object.entries(updates)) {
      if (value !== undefined) {
        (preferencesRow as unknown as Record<string, unknown>)[column] = value;
      }
    }
    return preferencesRow;
  });

  const users = {
    findOrCreateByFirebaseUid: vi.fn().mockResolvedValue(userRow),
    findById: vi.fn(async () => userRow),
    adoptTimezone: vi.fn().mockResolvedValue(null),
    markOnboarded,
  } as unknown as UsersRepository;

  return {
    userRow,
    markOnboarded,
    update,
    repositories: {
      users,
      preferences: {
        ensureExists: vi.fn(async () => preferencesRow),
        update,
      },
    } as unknown as Repositories,
  };
}

async function buildTestApp(initialOnboardedAt: Date | null = null) {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const fakes = buildFakeRepositories(initialOnboardedAt);

  registerAuth(app, verifier, fakes.repositories.users);
  registerUserScopedRoutes(app, {
    repositories: fakes.repositories,
    audioStorage: {} as AudioStorage,
  });

  return { app, token: await verifier.mint(FIREBASE_UID), ...fakes };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('onboarding completion is server-authoritative (#225)', () => {
  it('reflects a completion written through PUT on the next GET — the cross-surface round trip', async () => {
    // This is acceptance criterion #2 of #225 reduced to one process: the
    // write that "web" would perform, then the read that "iOS" would
    // perform. Both surfaces resolve to the same `users.id` via
    // `findOrCreateByFirebaseUid`, so if the value survives this hop it
    // survives that one.
    const { app, token } = await buildTestApp(null);

    const before = await app.inject({ method: 'GET', url: '/v1/preferences', headers: authed(token) });
    expect(before.json().data.onboardedAt).toBeNull();

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { onboardingCompleted: true },
    });
    expect(put.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/v1/preferences', headers: authed(token) });
    expect(after.statusCode).toBe(200);
    expect(after.json().data.onboardedAt).toBe('2026-07-18T12:00:00.000Z');

    await app.close();
  });

  it('echoes the stored timestamp on the PUT response, not just the later GET', async () => {
    // A client applies whichever response it happens to have (iOS's push
    // and pull both feed the same apply path). PUT and GET returning
    // different shapes would make "server wins" mean two different things
    // depending on which call happened last.
    const { app, token } = await buildTestApp(null);

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { onboardingCompleted: true },
    });

    expect(put.json().data.onboardedAt).toBe('2026-07-18T12:00:00.000Z');
    await app.close();
  });

  it('does not move the recorded instant when completion is re-asserted', async () => {
    // iOS re-asserts its local latch whenever the server has no timestamp,
    // and a client with a stale cache may keep sending it. First-write-wins
    // is what keeps `onboarded_at` meaning "when they finished" instead of
    // decaying into "when they last launched the app".
    const alreadyOnboarded = new Date('2026-03-01T08:30:00Z');
    const { app, token, userRow } = await buildTestApp(alreadyOnboarded);

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { onboardingCompleted: true },
    });

    expect(put.statusCode).toBe(200);
    expect(put.json().data.onboardedAt).toBe('2026-03-01T08:30:00.000Z');
    expect(userRow.onboarded_at).toEqual(alreadyOnboarded);
    await app.close();
  });

  it('leaves onboarding untouched on an ordinary preferences save', async () => {
    // Every routine sync (a voice change, a window change) goes through
    // this same route. None of them are statements about onboarding, so
    // none of them may write it.
    const { app, token, markOnboarded } = await buildTestApp(null);

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { voice: 'warm' },
    });

    expect(put.statusCode).toBe(200);
    expect(markOnboarded).not.toHaveBeenCalled();
    expect(put.json().data.onboardedAt).toBeNull();
    await app.close();
  });

  it('rejects onboardingCompleted: false rather than treating it as a reset', async () => {
    // There is no wire representation of "un-onboard me" — see the field's
    // doc in shared-contracts. A client sending `false` has misunderstood
    // the field, and a 400 tells it so; silently ignoring the value would
    // let that misunderstanding ship.
    const { app, token, markOnboarded } = await buildTestApp(new Date('2026-03-01T08:30:00Z'));

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { onboardingCompleted: false },
    });

    expect(put.statusCode).toBe(400);
    expect(markOnboarded).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('consent flags are writable, not just readable (#225 / #201)', () => {
  it('persists a consent revocation sent through PUT and serves it back', async () => {
    // #201 made these columns real read-time gates; until #225 no client
    // could write them, so the gate could only ever hold the value the
    // migration backfilled. Revoking on one surface has to be visible to
    // the other, or the two clients disagree about a privacy control —
    // which is worse than the control not existing.
    const { app, token } = await buildTestApp(null);

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { healthEnabled: false, calendarEnabled: false, communicationEnabled: false },
    });

    expect(put.statusCode).toBe(200);
    expect(put.json().data).toMatchObject({
      healthEnabled: false,
      calendarEnabled: false,
      communicationEnabled: false,
    });

    const get = await app.inject({ method: 'GET', url: '/v1/preferences', headers: authed(token) });
    expect(get.json().data).toMatchObject({
      healthEnabled: false,
      calendarEnabled: false,
      communicationEnabled: false,
    });

    await app.close();
  });

  it('changes one consent flag without disturbing the others', async () => {
    // iOS maps its four device-local categories onto two of these three
    // columns and never sends the third (`communication_enabled` has no
    // corresponding iOS toggle). A partial write must therefore leave the
    // unsent column exactly as the other surface set it, rather than
    // resetting it to a default.
    const { app, token } = await buildTestApp(null);

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { healthEnabled: false },
    });

    expect(put.json().data).toMatchObject({
      healthEnabled: false,
      calendarEnabled: true,
      communicationEnabled: true,
    });
    await app.close();
  });
});
