/**
 * O2 (kairos-devotional #314, Epic O #311): `users.language` +
 * `users.translation_id` get a write path over `PUT /v1/preferences`,
 * governed by the cross-field rule that keeps the pair coherent — a
 * language write snaps the translation to that language's default, and an
 * out-of-catalog pair is a 400.
 *
 * Same harness shape and same standard of proof as
 * `preferencesOnboarding.test.ts`: the users repository is a stateful
 * fake whose `updateProfile` reproduces the real COALESCE semantics, and
 * every acceptance assertion reads the *stored row*, not just the status
 * code — a route that validated perfectly and wrote nothing would pass a
 * status-code test and fail these (#193's "the route called the
 * repository is not evidence"). The 400 path is mutation-checked the same
 * way: it asserts the stored pair is untouched, so deleting the
 * `isVersionInLanguage` guard fails the test twice (the 400 becomes a
 * 200, and the bogus id lands in the row).
 *
 * DB-free — the migration/default behavior (`existing rows read back
 * language='en'`) is covered at the repository layer in
 * tests/db/repositories.test.ts against real Postgres.
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
 * Stateful users fake. `updateProfile` reproduces the real method's
 * COALESCE-per-column semantics (`undefined` leaves the stored value
 * alone) because "a translationId-only write must not disturb the stored
 * language" is a behavior these tests assert, and a call-recording mock
 * cannot exhibit it.
 */
function buildFakeRepositories(initial: { language: string; translationId: number }) {
  const userRow = {
    id: USER_ID,
    firebase_uid: FIREBASE_UID,
    email: null,
    tradition: 'general',
    translation_id: initial.translationId,
    language: initial.language,
    timezone: 'UTC',
    timezone_source: 'default',
    onboarded_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  } as unknown as UserRow;

  const preferencesRow: PreferencesRow = { ...BASE_PREFERENCES_ROW };

  const updateProfile = vi.fn(
    async (_userId: string, updates: { language?: string; translation_id?: number }) => {
      if (updates.language !== undefined) (userRow as { language: string }).language = updates.language;
      if (updates.translation_id !== undefined) userRow.translation_id = updates.translation_id;
      return userRow;
    },
  );

  const users = {
    findOrCreateByFirebaseUid: vi.fn().mockResolvedValue(userRow),
    findById: vi.fn(async () => userRow),
    adoptTimezone: vi.fn().mockResolvedValue(null),
    markOnboarded: vi.fn().mockResolvedValue(null),
    updateProfile,
  } as unknown as UsersRepository;

  return {
    userRow,
    updateProfile,
    repositories: {
      users,
      preferences: {
        ensureExists: vi.fn(async () => preferencesRow),
        update: vi.fn(async (_userId: string, updates: Record<string, unknown>) => {
          for (const [column, value] of Object.entries(updates)) {
            if (value !== undefined) {
              (preferencesRow as unknown as Record<string, unknown>)[column] = value;
            }
          }
          return preferencesRow;
        }),
      },
    } as unknown as Repositories,
  };
}

async function buildTestApp(initial = { language: 'en', translationId: 3034 }) {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const fakes = buildFakeRepositories(initial);

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

describe('language CHANGES snap the translation (#314 cross-field rule)', () => {
  it('PUT {"language":"es"} stores es AND snaps translation_id to the es default — the acceptance round trip', async () => {
    const { app, token, userRow } = await buildTestApp();

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { language: 'es' },
    });

    expect(put.statusCode).toBe(200);
    expect(put.json().data.language).toBe('es');
    expect(put.json().data.translationId).toBe(3365); // spaPdDpt, the pinned es default
    // The stored row, not just the echo — a route that computed the snap
    // for the response but never wrote it would pass the two lines above.
    expect((userRow as { language: string }).language).toBe('es');
    expect(userRow.translation_id).toBe(3365);

    const get = await app.inject({ method: 'GET', url: '/v1/preferences', headers: authed(token) });
    expect(get.json().data).toMatchObject({ language: 'es', translationId: 3365 });

    await app.close();
  });

  it('re-asserting the stored language does NOT snap — a full-object PUT must not clobber an alternate translation', async () => {
    // The normal web-form pattern (and what O5 ships) PUTs the whole
    // preferences object on every save, `language` included and unchanged.
    // Stored: en + WEBUS 206, an explicit alternate. If language
    // *presence* snapped (rather than language *change*), this ordinary
    // save would silently reset 206 → 3034 — so this test is the mutation
    // check on the `languageChanged` guard: delete it and the assertion
    // below catches the clobber.
    const { app, token, userRow } = await buildTestApp({ language: 'en', translationId: 206 });

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { language: 'en', voice: 'warm' },
    });

    expect(put.statusCode).toBe(200);
    expect(userRow.translation_id).toBe(206); // still WEBUS, not snapped to BSB
    expect(put.json().data).toMatchObject({ language: 'en', translationId: 206 });

    // ...and the same request shape with a genuinely NEW language still
    // snaps, so the guard distinguishes change from re-assertion rather
    // than disabling the snap outright.
    const changed = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { language: 'es', voice: 'warm' },
    });
    expect(changed.statusCode).toBe(200);
    expect(userRow.translation_id).toBe(3365);
    await app.close();
  });

  it('an explicit in-catalog translationId alongside the language is honored, not snapped over', async () => {
    // 147 (Reina-Valera Antigua) is the verified es alternate — a user who
    // deliberately picks the archaic wording keeps it.
    const { app, token, userRow } = await buildTestApp();

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { language: 'es', translationId: 147 },
    });

    expect(put.statusCode).toBe(200);
    expect(userRow.translation_id).toBe(147);
    expect(put.json().data).toMatchObject({ language: 'es', translationId: 147 });
    await app.close();
  });

  it('rejects a translationId outside the chosen language with 400 and stores NOTHING — the mutation check', async () => {
    // 206 is WEBUS, an en Bible. If the isVersionInLanguage guard were
    // deleted, this request would 200 and the assertions on the stored row
    // below would catch the bogus write — the test fails without the
    // guard, which is what makes the 400 assertion evidence rather than
    // an anchored fixture.
    const { app, token, userRow, updateProfile } = await buildTestApp();

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { language: 'es', translationId: 206 },
    });

    expect(put.statusCode).toBe(400);
    expect(updateProfile).not.toHaveBeenCalled();
    expect((userRow as { language: string }).language).toBe('en');
    expect(userRow.translation_id).toBe(3034);
    await app.close();
  });
});

describe('translationId alone is validated against the STORED language', () => {
  it('accepts an in-catalog switch within the stored language', async () => {
    // en → LSV 2660, from Foundation §4.3's 11-version en catalog. This is
    // the "translation select finally enabled" case O5 will ship: no
    // language change, just a different Bible in the same language.
    const { app, token, userRow } = await buildTestApp();

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { translationId: 2660 },
    });

    expect(put.statusCode).toBe(200);
    expect(userRow.translation_id).toBe(2660);
    expect((userRow as { language: string }).language).toBe('en'); // untouched
    await app.close();
  });

  it('rejects a translationId from another language when no language rides along', async () => {
    // Stored language is en; 3365 is the es default. Accepting it would
    // store a Spanish Bible under an English pipeline — exactly the
    // contradictory pair the rule exists to make unrepresentable.
    const { app, token, userRow } = await buildTestApp();

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { translationId: 3365 },
    });

    expect(put.statusCode).toBe(400);
    expect(userRow.translation_id).toBe(3034);
    await app.close();
  });

  it('validates against a non-default stored language too, not a hard-coded en', async () => {
    // A user already in fr: the en default 3034 must now be the rejected
    // id, and the fr alternate 131 (Ostervald) the accepted one. Catches
    // an implementation that "validates" against DEFAULT_LANGUAGE instead
    // of the stored row.
    const { app, token, userRow } = await buildTestApp({ language: 'fr', translationId: 93 });

    const rejected = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { translationId: 3034 },
    });
    expect(rejected.statusCode).toBe(400);
    expect(userRow.translation_id).toBe(93);

    const accepted = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { translationId: 131 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(userRow.translation_id).toBe(131);
    await app.close();
  });
});

describe('the fields stay inert when absent (#314 acceptance: COALESCE preserved)', () => {
  it('an ordinary preferences save never touches language or translation', async () => {
    const { app, token, updateProfile } = await buildTestApp({ language: 'de', translationId: 51 });

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { voice: 'warm' },
    });

    expect(put.statusCode).toBe(200);
    expect(updateProfile).not.toHaveBeenCalled();
    // ...and the response still echoes the stored pair, so a client can
    // apply any PUT response identically to a GET response.
    expect(put.json().data).toMatchObject({ language: 'de', translationId: 51 });
    await app.close();
  });

  it('rejects a language outside the six rather than storing free text in the column', async () => {
    // The column is unconstrained `text` (deliberately — see the
    // migration), so LanguageTagSchema at the door is the only gate.
    const { app, token, updateProfile } = await buildTestApp();

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { language: 'klingon' },
    });

    expect(put.statusCode).toBe(400);
    expect(updateProfile).not.toHaveBeenCalled();
    await app.close();
  });

  it('a 400 on the language pair leaves the rest of the body unapplied too', async () => {
    // The rule rejects the REQUEST, not the field: a body carrying a valid
    // voice change next to an invalid translation pair must not
    // half-apply, or the client cannot reason about what a 400 means.
    const { app, token, repositories } = await buildTestApp();

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { voice: 'bright', language: 'es', translationId: 206 },
    });

    expect(put.statusCode).toBe(400);
    expect(
      (repositories.preferences as unknown as { update: ReturnType<typeof vi.fn> }).update,
    ).not.toHaveBeenCalled();
    await app.close();
  });
});
