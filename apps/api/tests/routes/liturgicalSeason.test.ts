/**
 * N10 (#269): `GET /v1/liturgical-season`.
 *
 * DB-free, same harness shape as `preferencesCadence.test.ts` — no
 * kairos-test-pg container needed.
 *
 * ## What these tests are anchored to (Test Plan §3.1)
 *
 * The load-bearing claim of this route is not "it returns a season". It is
 * **"it returns a season exactly when the season is in the prompt"**. So
 * the expectations below are not hand-written season strings paired with
 * hand-written tradition rules; they are derived from the two real
 * producers:
 *
 *  - the season itself, from `getLiturgicalSeason` (rule 1: the fixture
 *    derives from the producer, so a change to the computus cannot leave
 *    this file quietly asserting last year's boundaries), and
 *  - whether it applies at all, from `buildInstructions` — the actual
 *    generation prompt. `promptMentionsSeason` below greps the string the
 *    model receives. That is rule 4, assert behaviour not participation:
 *    the test does not check that a flag was passed anywhere, it checks
 *    that the words reaching the model and the words reaching the
 *    dashboard agree about whether this user has a season.
 *
 * The bug this shape exists to catch is the one #269's own description
 * invites: read "the backend computes the season", surface it
 * unconditionally, and ship a dashboard announcing Lent to users whose
 * devotionals have never mentioned Lent.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerUserScopedRoutes } from '../../src/routes/userScoped.js';
import { getLiturgicalSeason } from '../../src/services/gloo/liturgicalCalendar.js';
import {
  ALL_SIGNALS_OBSERVED,
  buildInstructions,
} from '../../src/services/gloo/instructionsBuilder.js';
import {
  LiturgicalSeasonResponseSchema,
  TraditionSchema,
  type Tradition,
} from '@kairos/shared-contracts';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository } from '../../src/db/repositories/usersRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const FIREBASE_UID = 'firebase-uid-1';

/** Every tradition, from the contract enum — so a seventh cannot be added without landing here. */
const TRADITIONS: readonly Tradition[] = TraditionSchema.options;

async function buildTestApp(user: {
  tradition?: Tradition;
  liturgicalSeasonsEnabled?: boolean;
  /** `undefined` models a user with no preferences row at all. */
  hasPreferencesRow?: boolean;
}): Promise<{ app: FastifyInstance; token: string }> {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const users = {
    findOrCreateByFirebaseUid: vi.fn().mockResolvedValue({ id: USER_ID }),
    adoptTimezone: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(
      user.tradition === undefined
        ? null
        : { id: USER_ID, tradition: user.tradition, onboarded_at: null },
    ),
  } as unknown as UsersRepository;

  registerAuth(app, verifier, users);
  registerUserScopedRoutes(app, {
    repositories: {
      users,
      preferences: {
        get: vi
          .fn()
          .mockResolvedValue(
            user.hasPreferencesRow === false
              ? null
              : { liturgical_seasons_enabled: user.liturgicalSeasonsEnabled ?? false },
          ),
      },
    } as unknown as Repositories,
    audioStorage: {} as AudioStorage,
  });
  return { app, token: await verifier.mint(FIREBASE_UID) };
}

/** The parsed `data` of a real request through the real route. */
async function readSeason(user: Parameters<typeof buildTestApp>[0]) {
  const { app, token } = await buildTestApp(user);
  const response = await app.inject({
    method: 'GET',
    url: '/v1/liturgical-season',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  // Parsed through the shared contract rather than read as `any`: a route
  // that drifted from the schema fails here rather than several components
  // later in the client (Test Plan §3.1 rule 3 — validate against the
  // schema, not a literal key list).
  const parsed = LiturgicalSeasonResponseSchema.safeParse(response.json());
  expect(parsed.success, JSON.stringify(parsed.success === false ? parsed.error.issues : [])).toBe(
    true,
  );
  await app.close();
  return parsed.success ? parsed.data.data : null;
}

/**
 * Does the *actual generation prompt* for this user mention the season?
 *
 * Built by calling `buildInstructions` — the real producer — and looking
 * for the real season line. Nothing here restates the forced-tradition
 * rule; if that rule changes, this function's answer changes with it and
 * the tests below follow.
 */
function promptMentionsSeason(tradition: Tradition, liturgicalSeasonsEnabled: boolean): boolean {
  const date = new Date().toISOString().slice(0, 10);
  const instructions = buildInstructions({
    tradition,
    translation: 'Berean Standard Bible (BSB)',
    bands: {
      recovery: 'moderate',
      sleepQuality: 'fair',
      busyness: 'moderate',
      activity: 'moderate',
      communicationLoad: 'moderate',
      distressSignal: false,
    },
    signalProvenance: ALL_SIGNALS_OBSERVED,
    date,
    liturgicalSeasonsEnabled,
  });
  // The season lines are the only place any of these five words appear in
  // the instructions; `Advent`/`Lent` etc. are not used elsewhere.
  return /Advent|Christmastide|Lent|Eastertide|Ordinary Time/.test(instructions);
}

describe('GET /v1/liturgical-season (N10, #269)', () => {
  it('reports the same season the computus does', async () => {
    const data = await readSeason({ tradition: 'catholic' });
    // Derived from the producer, never a literal: today's season is
    // whatever `getLiturgicalSeason` says today's season is.
    expect(data?.season).toBe(getLiturgicalSeason(new Date().toISOString().slice(0, 10)).season);
  });

  it.each(TRADITIONS)(
    'for %s, surfaces a season if and only if the generation prompt has one (opt-in off)',
    async (tradition) => {
      const data = await readSeason({ tradition, liturgicalSeasonsEnabled: false });
      const inPrompt = promptMentionsSeason(tradition, false);
      expect(data?.season !== null).toBe(inPrompt);
    },
  );

  it.each(TRADITIONS)(
    'for %s, surfaces a season if and only if the generation prompt has one (opt-in on)',
    async (tradition) => {
      const data = await readSeason({ tradition, liturgicalSeasonsEnabled: true });
      const inPrompt = promptMentionsSeason(tradition, true);
      expect(data?.season !== null).toBe(inPrompt);
    },
  );

  it('says nothing to an evangelical user who has not opted in', async () => {
    // The concrete case behind the rule above, pinned separately so the
    // failure message names the product bug rather than a table row: the
    // dashboard must not tell this user it is Lent, because their
    // devotional does not know it is Lent.
    const data = await readSeason({ tradition: 'evangelical', liturgicalSeasonsEnabled: false });
    expect(data?.season).toBeNull();
  });

  it('speaks to an evangelical user once they opt in', async () => {
    const data = await readSeason({ tradition: 'evangelical', liturgicalSeasonsEnabled: true });
    expect(data?.season).not.toBeNull();
  });

  it('treats a missing preferences row as not opted in', async () => {
    // `general` is the default tradition, so a brand-new user with no
    // preferences row must get `null` rather than a crash or a season.
    const data = await readSeason({ tradition: 'general', hasPreferencesRow: false });
    expect(data?.season).toBeNull();
  });

  it('treats a missing user row as the default tradition, not as a liturgical one', async () => {
    const data = await readSeason({ hasPreferencesRow: false });
    expect(data?.season).toBeNull();
  });

  it('never sends a week number', async () => {
    // Foundation §9: no counts on this surface. The week exists on the
    // server and is deliberately not carried — see api/liturgy.ts. A
    // strict parse is the assertion: an extra key fails it.
    const { app, token } = await buildTestApp({ tradition: 'catholic' });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/liturgical-season',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = response.json() as { data: Record<string, unknown> };
    expect(Object.keys(body.data)).toEqual(['season']);
    await app.close();
  });

  it('requires authentication', async () => {
    const { app } = await buildTestApp({ tradition: 'catholic' });
    const response = await app.inject({ method: 'GET', url: '/v1/liturgical-season' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
