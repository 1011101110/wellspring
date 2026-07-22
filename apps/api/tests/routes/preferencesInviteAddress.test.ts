/**
 * L3 (#239): the user's invite routing address on `GET /v1/preferences`.
 *
 * The two claims worth proving, and neither is "the field is in the
 * response":
 *
 *  1. **The address the API hands out is the address the inbound parser
 *     accepts.** #239's requirement is that they are minted by the same
 *     helper "so the two can never disagree". A test asserting a
 *     hard-coded `u_<id>@<domain>` string would pass equally well against
 *     a second, hand-rolled copy of the scheme in the route — which is
 *     precisely the failure mode. So the assertion feeds the served
 *     address back through `parseInviteRoutingAddress` (the function
 *     `routes/inboundInvite.ts` actually routes with) and requires it to
 *     resolve to this user. That is a round trip, not a string compare.
 *  2. **Absence, not breakage, when the domain is unset** — asserted as
 *     the key being genuinely missing from the JSON, since `''` and
 *     `u_<id>@undefined` are both address-shaped things a client would
 *     render into a copy button.
 *
 * DB-free, same fake-repository harness shape as
 * `preferencesOnboarding.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerUserScopedRoutes } from '../../src/routes/userScoped.js';
import { parseInviteRoutingAddress } from '../../src/services/invite/inviteRoutingAddress.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository, UserRow } from '../../src/db/repositories/usersRepository.js';
import type { PreferencesRow } from '../../src/db/repositories/preferencesRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';

const USER_ID = '3f2a7c1e-9b4d-4e88-9a1f-0c5d6e7f8a9b';
const FIREBASE_UID = 'firebase-invite-address';
const DOMAIN = 'lexirdro.resend.app';

const PREFERENCES_ROW: PreferencesRow = {
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

async function buildTestApp(inviteEmailDomain: string | undefined) {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();

  const userRow = {
    id: USER_ID,
    firebase_uid: FIREBASE_UID,
    onboarded_at: null,
  } as unknown as UserRow;

  const preferencesRow: PreferencesRow = { ...PREFERENCES_ROW };
  const repositories = {
    users: {
      findOrCreateByFirebaseUid: vi.fn(async () => userRow),
      findById: vi.fn(async () => userRow),
      adoptTimezone: vi.fn(),
      markOnboarded: vi.fn(),
    } as unknown as UsersRepository,
    preferences: {
      ensureExists: vi.fn(async () => preferencesRow),
      update: vi.fn(async () => preferencesRow),
    },
  } as unknown as Repositories;

  registerAuth(app, verifier, repositories.users);
  registerUserScopedRoutes(app, {
    repositories,
    audioStorage: {} as AudioStorage,
    inviteEmailDomain,
  });

  return { app, token: await verifier.mint(FIREBASE_UID) };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('invite routing address on GET /v1/preferences (#239)', () => {
  it('serves an address the inbound parser routes back to this same user', async () => {
    // The round trip #239 actually asks for: mint -> serve -> parse. If
    // the route ever grew its own copy of the `u_<id>@<domain>` scheme,
    // this is the assertion that would catch the two definitions drifting
    // — a literal string comparison would not.
    const { app, token } = await buildTestApp(DOMAIN);

    const res = await app.inject({ method: 'GET', url: '/v1/preferences', headers: authed(token) });
    expect(res.statusCode).toBe(200);

    const address: string = res.json().data.inviteAddress;
    expect(address).toBeTypeOf('string');
    expect(parseInviteRoutingAddress(address, DOMAIN)).toBe(USER_ID);

    await app.close();
  });

  it('omits the field entirely when INVITE_EMAIL_DOMAIN is unset', async () => {
    // #239: "Card absent (not broken) when INVITE_EMAIL_DOMAIN unset."
    // Asserted on the raw JSON keys, because `undefined` and a missing
    // key are indistinguishable through `.toBeUndefined()` — and the
    // failure this guards against is a client rendering a copy button for
    // an empty or malformed address.
    const { app, token } = await buildTestApp(undefined);

    const res = await app.inject({ method: 'GET', url: '/v1/preferences', headers: authed(token) });
    expect(res.statusCode).toBe(200);

    const data = res.json().data;
    expect(Object.keys(data)).not.toContain('inviteAddress');
    // Belt and braces: nothing address-shaped anywhere in the payload.
    expect(JSON.stringify(data)).not.toContain('u_');

    await app.close();
  });

  it('re-renders against the current domain rather than a cached one', async () => {
    // #239 "Watch for": the card must re-render correctly if the domain
    // env changes. Two apps, two domains, one user — the address must
    // follow the configuration, which it can only do if it is derived per
    // request rather than computed once.
    const first = await buildTestApp('old.example.com');
    const second = await buildTestApp('new.example.com');

    const a = await first.app.inject({ method: 'GET', url: '/v1/preferences', headers: authed(first.token) });
    const b = await second.app.inject({ method: 'GET', url: '/v1/preferences', headers: authed(second.token) });

    expect(a.json().data.inviteAddress).toBe(`u_${USER_ID}@old.example.com`);
    expect(b.json().data.inviteAddress).toBe(`u_${USER_ID}@new.example.com`);

    await first.app.close();
    await second.app.close();
  });

  it('returns the address on PUT as well, so both responses apply identically', async () => {
    // Same reasoning #225 records for `onboardedAt`: a client applies
    // whichever response it last received. A field present on GET and
    // missing on PUT would make the invite card flicker away whenever the
    // user saved a preference.
    const { app, token } = await buildTestApp(DOMAIN);

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/preferences',
      headers: authed(token),
      payload: { lectio: true },
    });

    expect(res.statusCode).toBe(200);
    expect(parseInviteRoutingAddress(res.json().data.inviteAddress, DOMAIN)).toBe(USER_ID);

    await app.close();
  });
});
