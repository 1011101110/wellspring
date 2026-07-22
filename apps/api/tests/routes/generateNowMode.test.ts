/**
 * L2 (#238): the dashboard "+" mode of `POST /v1/devotional/generate-now`,
 * its second-press behavior, and its per-user rate limit.
 *
 * ## What these tests are trying to prove
 *
 * Per #193's standard of proof, "the route passed the flag" is not
 * evidence. The three claims #238 makes are all about what does or does
 * NOT happen to the orchestrator, so that is what is asserted:
 *
 *  - "+" does not get distress framing → the orchestrator is inspected for
 *    what it was actually asked to do, and specifically that
 *    `distressSignalOverride` is not set — the flag that forces
 *    `bands.distressSignal = true` and with it the elevated-care/`micro`
 *    shape. (This is the one place a call-argument assertion IS the
 *    behavior: the orchestrator is a real, separately-tested unit, and
 *    the seam between the two is exactly what this story changed.)
 *  - Second press same day → a success carrying the EXISTING session,
 *    and the orchestrator asked to run the idempotency guard rather than
 *    skip it.
 *  - Rate limit → the second call in a burst **does not reach the
 *    orchestrator at all** (`toHaveBeenCalledTimes(1)`), not merely that
 *    it received a 429. A limiter that 429s the client after doing the
 *    paid work would satisfy the status code and completely fail the
 *    purpose (#238: "each press is a paid Gloo + TTS call").
 *
 * Built on the real `buildApp` rather than a bare Fastify instance,
 * because the rate limiter lives on the `/v1` scope that only `buildApp`
 * constructs — a test that registered the routes directly would be
 * testing a topology that does not exist in production. Still DB-free:
 * the repositories are fakes, so no kairos-test-pg container is needed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository, UserRow } from '../../src/db/repositories/usersRepository.js';
import type { DevotionalRow } from '../../src/db/repositories/devotionalsRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';
import {
  AlreadyExistsError,
  type GenerateNowOrchestrator,
  type GenerateNowParams,
} from '../../src/services/orchestrator/generateNowOrchestrator.js';

const USER_ID = '00000000-0000-0000-0000-000000000042';
const FIREBASE_UID = 'firebase-generate-now';
const EXISTING_DEVOTIONAL_ID = '11111111-1111-4111-8111-111111111111';

const SUCCESS_RESULT = {
  sessionUrl: 'http://localhost:8080/session/tok-fresh',
  sessionToken: 'tok-fresh',
  devotionalId: '22222222-2222-4222-8222-222222222222',
  devotional: { format: 'standard', theme: 'Steadfastness', cardSummary: 'A word for today.' },
  source: 'gloo',
  audio: { status: 'uploaded', objectKey: 'devotionals/fresh.mp3' },
};

/** The row `getById` returns for the already-exists path — only the card fields matter here. */
const EXISTING_ROW = {
  id: EXISTING_DEVOTIONAL_ID,
  format: 'extended',
  theme: 'Yesterday-was-today',
  card_summary: 'The devotional you already have.',
} as unknown as DevotionalRow;

interface Harness {
  app: FastifyInstance;
  token: string;
  generateNow: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
}

async function buildHarness(
  opts: {
    /** Replaces the default "generation succeeds" behavior — e.g. to throw AlreadyExistsError. */
    generateNowImpl?: (params: GenerateNowParams) => Promise<unknown>;
    generateNowRateLimit?: { max: number; timeWindowMs: number };
  } = {},
): Promise<Harness> {
  const verifier = await FakeTokenVerifier.create();

  const userRow = {
    id: USER_ID,
    firebase_uid: FIREBASE_UID,
    email: null,
    onboarded_at: null,
  } as unknown as UserRow;

  const generateNow = vi.fn(
    opts.generateNowImpl ?? (() => Promise.resolve(SUCCESS_RESULT)),
  );
  const getById = vi.fn(async () => EXISTING_ROW);

  const repositories = {
    users: {
      findOrCreateByFirebaseUid: vi.fn(async () => userRow),
      findById: vi.fn(async () => userRow),
    } as unknown as UsersRepository,
    devotionals: { getById },
  } as unknown as Repositories;

  const app = buildApp({
    tokenVerifier: verifier,
    repositories,
    audioStorage: {} as AudioStorage,
    generateNowOrchestrator: { generateNow } as unknown as GenerateNowOrchestrator,
    generateNowRateLimit: opts.generateNowRateLimit,
    // Generous scope-level limit so anything these tests observe is
    // attributable to the per-route limiter under test, never to the
    // shared `/v1` one firing first and producing a coincidentally
    // correct 429.
    apiRateLimit: { max: 1000, timeWindowMs: 60_000 },
  });
  await app.ready();

  return { app, token: await verifier.mint(FIREBASE_UID), generateNow, getById };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('POST /v1/devotional/generate-now — mode split (#238)', () => {
  it('does not apply distress framing to a "+" tap', async () => {
    // The core of #238: a routine "+" must not reach the orchestrator
    // carrying the flag that forces `bands.distressSignal = true` (and
    // with it elevated care and the `micro` format).
    const { app, token, generateNow } = await buildHarness();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });

    expect(res.statusCode).toBe(200);
    const params = generateNow.mock.calls[0]![0] as GenerateNowParams;
    expect(params.distressSignalOverride).toBeUndefined();

    await app.close();
  });

  it('skips the calendar for a "+" tap — no meeting booked for the present moment', async () => {
    // #238 requirement 5. The user is already here; a calendar event for
    // right now is noise on their calendar for something they are
    // attending.
    const { app, token, generateNow } = await buildHarness();

    await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });

    const params = generateNow.mock.calls[0]![0] as GenerateNowParams;
    expect(params.skipCalendar).toBe(true);

    await app.close();
  });

  it('lets the same-day idempotency guard run for "+", unlike distress', async () => {
    // The two modes differ here precisely because their intents differ:
    // distress must always produce a fresh session; "+" must find today's.
    const { app, token, generateNow } = await buildHarness();

    await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });
    expect((generateNow.mock.calls[0]![0] as GenerateNowParams).skipIdempotencyCheck).toBe(false);

    await app.close();
  });

  it('leaves the distress path unchanged — including for a body with no mode at all', async () => {
    // Backward compatibility is the reason `mode` defaults to 'distress'.
    // The shipped iOS distress button sends `{}`; if that started meaning
    // "ordinary generation" the moment this deployed, #238 would have
    // broken the one path where being wrong matters most.
    const { app, token, generateNow } = await buildHarness();

    for (const payload of [{}, { distressSignal: true }, { mode: 'distress' }]) {
      generateNow.mockClear();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/devotional/generate-now',
        headers: authed(token),
        payload,
      });
      expect(res.statusCode).toBe(200);

      const params = generateNow.mock.calls[0]![0] as GenerateNowParams;
      expect(params.distressSignalOverride).toBe(true);
      expect(params.skipIdempotencyCheck).toBe(true);
    }

    await app.close();
  });

  it('ignores a distressSignal smuggled into a "now" request', async () => {
    // #238: the distress path must be "unreachable from '+'". If a wire
    // flag could reopen the distress framing inside `now` mode, the mode
    // split would be advisory rather than real.
    const { app, token, generateNow } = await buildHarness();

    await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now', distressSignal: true },
    });

    const params = generateNow.mock.calls[0]![0] as GenerateNowParams;
    expect(params.distressSignalOverride).toBeUndefined();

    await app.close();
  });

  it('400s an unrecognized mode rather than silently choosing one', async () => {
    const { app, token, generateNow } = await buildHarness();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'urgent' },
    });

    expect(res.statusCode).toBe(400);
    // The paid work must not have happened for a request we rejected.
    expect(generateNow).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('POST /v1/devotional/generate-now — second press same day (#238)', () => {
  async function buildAlreadyExistsHarness(): Promise<Harness> {
    return buildHarness({
      generateNowImpl: () =>
        Promise.reject(
          new AlreadyExistsError(
            EXISTING_DEVOTIONAL_ID,
            'tok-existing',
            'http://localhost:8080/session/tok-existing',
          ),
        ),
    });
  }

  it('answers a second "+" press with a success carrying the EXISTING session', async () => {
    // Not a 409 and not a duplicate generation (#238 requirement 2). The
    // user asked for today's devotional and today's devotional exists —
    // so the honest answer is the devotional, shaped like a success, with
    // the flag the client needs to pick its copy.
    const { app, token } = await buildAlreadyExistsHarness();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyExisted).toBe(true);
    // The session the client will actually open — the EXISTING one, not
    // the one a fresh generation would have produced.
    expect(body.sessionUrl).toBe('http://localhost:8080/session/tok-existing');
    expect(body.devotionalId).toBe(EXISTING_DEVOTIONAL_ID);
    expect(body.data.sessionToken).toBe('tok-existing');

    await app.close();
  });

  it('carries the existing devotional\'s theme so the client can render the card it opens', async () => {
    const { app, token, getById } = await buildAlreadyExistsHarness();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });

    expect(res.json().data.devotional).toEqual({
      format: 'extended',
      theme: 'Yesterday-was-today',
      cardSummary: 'The devotional you already have.',
    });
    // Ownership-scoped read: the verified userId, never anything off the
    // error object (Foundation §10).
    expect(getById).toHaveBeenCalledWith(USER_ID, EXISTING_DEVOTIONAL_ID);

    await app.close();
  });

  it('still returns the session when the devotional summary read fails', async () => {
    // Best-effort enrichment: losing the theme must not turn "here is your
    // devotional" into an error, because the session link is the part that
    // actually lets the user in.
    const { app, token, getById } = await buildAlreadyExistsHarness();
    getById.mockRejectedValueOnce(new Error('db is having a moment'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sessionUrl).toBe('http://localhost:8080/session/tok-existing');
    expect(res.json().data.devotional).toBeNull();

    await app.close();
  });

  it('marks a genuinely fresh generation as not-already-existing', async () => {
    // The flag has to distinguish, or the client cannot choose its copy.
    const { app, token } = await buildHarness();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });

    expect(res.json().alreadyExisted).toBe(false);
    expect(res.json().sessionUrl).toBe(SUCCESS_RESULT.sessionUrl);

    await app.close();
  });

  it('still 502s a real orchestrator failure — AlreadyExists is not a blanket catch', async () => {
    const { app, token } = await buildHarness({
      generateNowImpl: () => Promise.reject(new Error('Gloo is down')),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().ok).toBe(false);

    await app.close();
  });
});

describe('POST /v1/devotional/generate-now — per-user rate limit (#238)', () => {
  it('does not reach the orchestrator on the second call of a burst', async () => {
    // THE assertion #238 asks for. A limiter that returns 429 *after*
    // doing the work would pass a status-code-only test and fail the
    // entire purpose of the story — every press is a paid Gloo completion
    // plus a Cloud TTS synthesis.
    const { app, token, generateNow } = await buildHarness({
      generateNowRateLimit: { max: 1, timeWindowMs: 60_000 },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/devotional/generate-now',
      headers: authed(token),
      payload: { mode: 'now' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('RATE_LIMITED');
    // The money assertion: exactly one generation was paid for.
    expect(generateNow).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('limits per user, not per IP — one user cannot spend another\'s allowance', async () => {
    // Both requests arrive from the same (loopback) address in `inject`,
    // so if the key were `request.ip` the second user would inherit the
    // first user's exhausted budget. Keying on the verified userId is what
    // makes the limit track the thing that actually costs money: whose
    // devotional is being generated.
    const verifier = await FakeTokenVerifier.create();
    const otherUserRow = {
      id: '00000000-0000-0000-0000-000000000043',
      firebase_uid: 'firebase-other',
    } as unknown as UserRow;
    const firstUserRow = { id: USER_ID, firebase_uid: FIREBASE_UID } as unknown as UserRow;

    const generateNow = vi.fn(async () => SUCCESS_RESULT);
    const repositories = {
      users: {
        // Resolve each Firebase UID to its own users row, exactly as the
        // real repository does — otherwise both tokens would collapse to
        // one userId and this test could not tell the two keys apart.
        findOrCreateByFirebaseUid: vi.fn(async (uid: string) =>
          uid === FIREBASE_UID ? firstUserRow : otherUserRow,
        ),
      } as unknown as UsersRepository,
      devotionals: { getById: vi.fn() },
    } as unknown as Repositories;

    const app = buildApp({
      tokenVerifier: verifier,
      repositories,
      audioStorage: {} as AudioStorage,
      generateNowOrchestrator: { generateNow } as unknown as GenerateNowOrchestrator,
      generateNowRateLimit: { max: 1, timeWindowMs: 60_000 },
      apiRateLimit: { max: 1000, timeWindowMs: 60_000 },
    });
    await app.ready();

    const tokenA = await verifier.mint(FIREBASE_UID);
    const tokenB = await verifier.mint('firebase-other');

    const a1 = await app.inject({ method: 'POST', url: '/v1/devotional/generate-now', headers: authed(tokenA), payload: { mode: 'now' } });
    const a2 = await app.inject({ method: 'POST', url: '/v1/devotional/generate-now', headers: authed(tokenA), payload: { mode: 'now' } });
    const b1 = await app.inject({ method: 'POST', url: '/v1/devotional/generate-now', headers: authed(tokenB), payload: { mode: 'now' } });

    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(429);
    // User A exhausting their allowance must not touch user B's.
    expect(b1.statusCode).toBe(200);
    expect(generateNow).toHaveBeenCalledTimes(2);

    await app.close();
  });
});
