/**
 * K1 (#187): the device time zone riding along on `PUT /v1/preferences`.
 *
 * This is the "educated guess" half of the fix — the zone a user has
 * BEFORE they connect any calendar, and the only zone they ever get if
 * they never connect one. `users.timezone` defaults to `'UTC'`, and the
 * first real connected user got a devotional gap at 07:30 UTC, which is
 * 3:30am where they actually live.
 *
 * DB-free: `registerAuth` is wired to `FakeTokenVerifier` plus a faked
 * `UsersRepository`, so this exercises the route's own concerns
 * (validation, which source it writes, best-effort behavior) without
 * needing the kairos-test-pg container.
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
  active_days: [0, 1, 2, 3, 4, 5, 6],
  cadence: 'daily',
  duration_preference: 'short',
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

function fakeUsers(overrides: Partial<UsersRepository> = {}): UsersRepository {
  return {
    findOrCreateByFirebaseUid: vi.fn().mockResolvedValue({ id: USER_ID }),
    adoptTimezone: vi.fn().mockResolvedValue({ timezone: 'America/New_York' }),
    // The preferences routes read the user row for `onboarded_at` since
    // #225 (docs/03 §8.1). Irrelevant to time zones, but the route calls
    // it, so the fake has to answer.
    findById: vi.fn().mockResolvedValue({ id: USER_ID, onboarded_at: null }),
    markOnboarded: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as UsersRepository;
}

async function buildTestApp(users: UsersRepository): Promise<{
  app: FastifyInstance;
  token: string;
}> {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  registerAuth(app, verifier, users);
  registerUserScopedRoutes(app, {
    repositories: {
      users,
      preferences: {
        ensureExists: vi.fn().mockResolvedValue(PREFERENCES_ROW),
        update: vi.fn().mockResolvedValue(PREFERENCES_ROW),
      },
    } as unknown as Repositories,
    audioStorage: {} as AudioStorage,
  });
  return { app, token: await verifier.mint(FIREBASE_UID) };
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

describe('PUT /v1/preferences — device time zone (#187)', () => {
  it('persists the device zone as a `device`-sourced value', async () => {
    const users = fakeUsers();
    const { app, token } = await buildTestApp(users);

    const response = await putPreferences(app, token, { timezone: 'America/New_York' });

    expect(response.statusCode).toBe(200);
    // `device`, the lowest non-default rank — so this can never overwrite
    // a calendar-derived zone or a zone the user picked by hand. The
    // precedence itself is enforced in adoptTimezone, not here.
    expect(users.adoptTimezone).toHaveBeenCalledWith(USER_ID, 'America/New_York', 'device');
    await app.close();
  });

  it('rejects a zone that is not a real IANA identifier instead of storing it', async () => {
    // A junk zone doesn't fail loudly downstream — luxon returns an
    // *invalid* DateTime rather than throwing — so it silently reschedules
    // someone's devotional. `TimeZone.current.identifier` can't produce
    // one, so a 400 here means a genuinely broken client and should be
    // loud.
    const users = fakeUsers();
    const { app, token } = await buildTestApp(users);

    for (const bogus of ['Mars/Olympus_Mons', 'Not A Zone', '+05:00', '']) {
      const response = await putPreferences(app, token, { timezone: bogus });
      expect(response.statusCode).toBe(400);
    }

    expect(users.adoptTimezone).not.toHaveBeenCalled();
    await app.close();
  });

  it('leaves the zone untouched when the request omits it', async () => {
    // Every pre-#187 client sends no `timezone` at all; nothing about
    // their preferences sync may change.
    const users = fakeUsers();
    const { app, token } = await buildTestApp(users);

    const response = await putPreferences(app, token, { cadence: 'daily' });

    expect(response.statusCode).toBe(200);
    expect(users.adoptTimezone).not.toHaveBeenCalled();
    await app.close();
  });

  it('still saves the preferences when the time zone write fails', async () => {
    // Best-effort side work: a user saving their devotional window must
    // not get an error because a side-car field failed to write. The next
    // sync (or the daily run's calendar refresh) tries again.
    const users = fakeUsers({
      adoptTimezone: vi.fn().mockRejectedValue(new Error('connection terminated')),
    });
    const { app, token } = await buildTestApp(users);

    const response = await putPreferences(app, token, {
      timezone: 'Europe/Berlin',
      cadence: 'weekdays',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    await app.close();
  });

  it('reports success even when the write is outranked by an explicit choice', async () => {
    // adoptTimezone returns null when a `user`-sourced zone already owns
    // the field. That is the normal, correct outcome for anyone who has
    // set their zone by hand — not an error, and invisible to the client.
    const users = fakeUsers({ adoptTimezone: vi.fn().mockResolvedValue(null) });
    const { app, token } = await buildTestApp(users);

    const response = await putPreferences(app, token, { timezone: 'America/Los_Angeles' });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
