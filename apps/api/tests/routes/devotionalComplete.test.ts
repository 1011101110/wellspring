/**
 * #3 — `POST /v1/devotionals/:id/complete`, the authenticated "Amen" the web +
 * iOS dashboard readers post to. Focused on the ROUTE wiring that was missing
 * entirely before this (the readers only flipped a local flag): auth is
 * enforced, the param is validated, the SessionService is called with the
 * authed user id, and its result maps to the right status. The completion +
 * highlight LOGIC is covered separately in
 * services/session/sessionCompleteByDevotional.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerUserScopedRoutes } from '../../src/routes/userScoped.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository, UserRow } from '../../src/db/repositories/usersRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';
import type { SessionService } from '../../src/services/session/sessionService.js';

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const FIREBASE_UID = 'firebase-devotional-complete';
const DEVO_ID = '00000000-0000-4000-8000-000000000001';
const COMPLETED_AT = new Date('2026-07-24T12:00:00Z');

async function buildTestApp(completeImpl: SessionService['completeByDevotionalId']) {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const userRow = { id: USER_ID, firebase_uid: FIREBASE_UID } as unknown as UserRow;

  const repositories = {
    users: {
      findOrCreateByFirebaseUid: vi.fn(async () => userRow),
      findById: vi.fn(async () => userRow),
    } as unknown as UsersRepository,
    devotionals: {},
  } as unknown as Repositories;

  const completeByDevotionalId = vi.fn(completeImpl);
  const sessionService = { completeByDevotionalId } as unknown as SessionService;

  registerAuth(app, verifier, repositories.users);
  registerUserScopedRoutes(app, {
    repositories,
    audioStorage: {} as AudioStorage,
    sessionService,
  });

  return { app, token: await verifier.mint(FIREBASE_UID), completeByDevotionalId };
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

describe('POST /v1/devotionals/:id/complete (#3)', () => {
  it('200s with the completion instant and calls the service with the authed user + devotional id', async () => {
    const { app, token, completeByDevotionalId } = await buildTestApp(async () => ({
      kind: 'ok',
      completedAt: COMPLETED_AT,
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/devotionals/${DEVO_ID}/complete`,
      headers: authed(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, completedAt: COMPLETED_AT.toISOString() });
    expect(completeByDevotionalId).toHaveBeenCalledWith(USER_ID, DEVO_ID);
    await app.close();
  });

  it('404s (never 403) when the user has no session for the devotional', async () => {
    const { app, token } = await buildTestApp(async () => ({ kind: 'not_found' }));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/devotionals/${DEVO_ID}/complete`,
      headers: authed(token),
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('401s without a bearer token — the route is behind requireAuth (#80 default-deny)', async () => {
    const { app, completeByDevotionalId } = await buildTestApp(async () => ({
      kind: 'ok',
      completedAt: COMPLETED_AT,
    }));

    const res = await app.inject({ method: 'POST', url: `/v1/devotionals/${DEVO_ID}/complete` });

    expect(res.statusCode).toBe(401);
    // Never reaches the service when unauthenticated.
    expect(completeByDevotionalId).not.toHaveBeenCalled();
    await app.close();
  });

  it('404s on a non-UUID id without touching the service (a malformed id is indistinguishable from a missing one — docs/04 §5.4)', async () => {
    const { app, token, completeByDevotionalId } = await buildTestApp(async () => ({
      kind: 'ok',
      completedAt: COMPLETED_AT,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/devotionals/not-a-uuid/complete',
      headers: authed(token),
    });

    expect(res.statusCode).toBe(404);
    expect(completeByDevotionalId).not.toHaveBeenCalled();
    await app.close();
  });
});
