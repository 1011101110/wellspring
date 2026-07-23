import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from '../../src/app.js';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
} from '../../src/db/repositories/index.js';
import { SessionService } from '../../src/services/session/sessionService.js';
import { LocalFileAudioStorage } from '../../src/services/audio/audioStorage.js';

/**
 * Integration tests for the P1/P2 feedback vertical (#320/#321): the
 * `session_feedback` upsert semantics, `POST /session/:token/feedback`,
 * and the completion page's form-vs-thanked states. Same local-Postgres
 * convention as session.integration.test.ts (kairos-test-pg, port 5433,
 * migrations already applied) — does NOT start a new container.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE session_feedback, calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
}

let audioRootDir: string;

beforeAll(async () => {
  await pool.query('SELECT 1 FROM session_feedback LIMIT 1');
  audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-feedback-audio-'));
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
  await rm(audioRootDir, { recursive: true, force: true });
});

function minimalDevotional(
  overrides: Partial<Parameters<Repositories['devotionals']['create']>[1]> = {},
) {
  return {
    date: '2026-07-23',
    format: 'short' as const,
    theme: 'Rest for the weary',
    verses: [
      {
        usfm: 'MAT.11.28',
        versionId: 3034,
        reference: 'Matthew 11:28',
        fetchedText: 'Come to me, all you who are weary and burdened, and I will give you rest.',
        attribution: 'Berean Standard Bible',
      },
    ],
    devotionalBody: 'A short devotional body about rest.',
    cardSummary: 'Rest for the weary.',
    prayer: 'Lord, grant me rest.',
    ...overrides,
  };
}

function buildTestApp(now: () => Date = () => new Date()) {
  const audioStorage = new LocalFileAudioStorage({
    rootDir: audioRootDir,
    signingSecret: 'a'.repeat(32),
    now,
  });
  const sessionService = new SessionService({
    sessions: repos.sessions,
    devotionals: repos.devotionals,
    audioStorage,
    now,
    sessionFeedback: repos.sessionFeedback,
  });
  return buildApp({ sessionService, audioStorage });
}

/** A user + devotional + JOINED session (the #320 gate) ready for feedback. */
async function seedJoinedSession(suffix: string, expiresAt = new Date(Date.now() + 3600_000)) {
  const user = await repos.users.createUser({
    firebaseUid: `fb-feedback-${suffix}`,
    email: `feedback-${suffix}@example.com`,
  });
  const userId = asVerifiedUserId(user.id);
  const devo = await repos.devotionals.create(userId, minimalDevotional());
  const session = await repos.sessions.create(userId, { devotionalId: devo.id, expiresAt });
  await repos.sessions.markJoined(userId, session.token);
  return { userId, devo, session };
}

async function feedbackRowsFor(userId: string) {
  const result = await pool.query(
    `SELECT * FROM session_feedback WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return result.rows;
}

describe('SessionFeedbackRepository (#320)', () => {
  it('round-trips every column through upsert', async () => {
    const { userId, devo, session } = await seedJoinedSession('repo-1');

    const row = await repos.sessionFeedback.upsert(userId, {
      sessionToken: session.token,
      devotionalId: devo.id,
      contentHelpful: true,
      topicMore: false,
      lengthFeel: 'shorter',
      timeFeel: 'later',
      note: 'a quiet thank you',
    });

    // Mutation check: assert the STORED values, straight from the DB, not
    // merely that the call returned.
    const stored = await repos.sessionFeedback.findBySessionToken(userId, session.token);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(row.id);
    expect(stored!.devotional_id).toBe(devo.id);
    expect(stored!.content_helpful).toBe(true);
    expect(stored!.topic_more).toBe(false);
    expect(stored!.length_feel).toBe('shorter');
    expect(stored!.time_feel).toBe('later');
    expect(stored!.note).toBe('a quiet thank you');
  });

  it('COALESCEs per column: a re-submit with FEWER answers never erases earlier ones, while re-answered questions win', async () => {
    const { userId, devo, session } = await seedJoinedSession('repo-2');

    await repos.sessionFeedback.upsert(userId, {
      sessionToken: session.token,
      devotionalId: devo.id,
      contentHelpful: true,
      lengthFeel: 'right',
      note: 'first note',
    });
    // Second submit answers a NEW question, REVISES one, and omits the rest.
    await repos.sessionFeedback.upsert(userId, {
      sessionToken: session.token,
      devotionalId: devo.id,
      topicMore: true,
      lengthFeel: 'longer',
    });

    const rows = await feedbackRowsFor(userId);
    expect(rows).toHaveLength(1); // upsert, never a second row
    // Were the upsert to clobber columns with the second submit's NULLs,
    // these three assertions are the ones that fail (#320's mutation check).
    expect(rows[0].content_helpful).toBe(true);
    expect(rows[0].note).toBe('first note');
    expect(rows[0].topic_more).toBe(true);
    expect(rows[0].length_feel).toBe('longer'); // last write wins per question
  });

  it('RETENTION (#320\'s open risk): purging the session row keeps the feedback, nulls only session_token, and preserves the durable user/devotional keys', async () => {
    const { userId, devo, session } = await seedJoinedSession(
      'repo-3',
      new Date(Date.now() - 1000), // already expired, so the purge below catches it
    );
    await repos.sessionFeedback.upsert(userId, {
      sessionToken: session.token,
      devotionalId: devo.id,
      contentHelpful: true,
    });

    // The retention sweep purgeJobs.ts runs daily: everything expired > 7d
    // ago. Cutoff in the future = this session is certainly swept.
    const purged = await repos.sessions.purgeExpiredBefore(new Date(Date.now() + 3600_000));
    expect(purged).toBe(1);

    // The feedback row OUTLIVES the session — the policy engine's 28-day
    // window (#323/#324) reads it by user_id + devotional_id long after
    // the 9-day session lifetime.
    const rows = await feedbackRowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_token).toBeNull();
    expect(rows[0].user_id).toBe(userId);
    expect(rows[0].devotional_id).toBe(devo.id);
    expect(rows[0].content_helpful).toBe(true);
  });

  it('account deletion cascades feedback away (Privacy §2 hard-delete)', async () => {
    const { userId, devo, session } = await seedJoinedSession('repo-4');
    await repos.sessionFeedback.upsert(userId, {
      sessionToken: session.token,
      devotionalId: devo.id,
      topicMore: true,
    });

    await repos.users.hardDelete(userId);

    expect(await feedbackRowsFor(userId)).toHaveLength(0);
  });
});

describe('POST /session/:token/feedback (#320)', () => {
  let app: ReturnType<typeof buildTestApp>;

  afterEach(async () => {
    await app?.close();
  });

  it('a genuine zero-JS form POST (urlencoded, string booleans) 303s to the completion page and persists every answer', async () => {
    app = buildTestApp();
    const { userId, devo, session } = await seedJoinedSession('route-1');

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
      },
      payload:
        'contentHelpful=true&topicMore=false&lengthFeel=right&timeFeel=earlier&note=' +
        encodeURIComponent('thank you for meeting me here'),
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/session/${session.token}/complete`);

    const rows = await feedbackRowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].content_helpful).toBe(true);
    expect(rows[0].topic_more).toBe(false);
    expect(rows[0].length_feel).toBe('right');
    expect(rows[0].time_feel).toBe('earlier');
    expect(rows[0].note).toBe('thank you for meeting me here');
    expect(rows[0].devotional_id).toBe(devo.id);
  });

  it('a JSON caller gets { ok: true } and the same persistence', async () => {
    app = buildTestApp();
    const { userId, session } = await seedJoinedSession('route-2');

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { accept: 'application/json' },
      payload: { contentHelpful: false, timeFeel: 'later' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const rows = await feedbackRowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].content_helpful).toBe(false);
    expect(rows[0].time_feel).toBe('later');
    expect(rows[0].topic_more).toBeNull(); // unanswered stays unanswered
  });

  it('a partial urlencoded submit (untouched radios absent, empty note field) stores exactly the answered question', async () => {
    app = buildTestApp();
    const { userId, session } = await seedJoinedSession('route-3');

    // A real browser posts `note=` for an untouched text field.
    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'lengthFeel=shorter&note=',
    });
    expect(res.statusCode).toBe(303);

    const rows = await feedbackRowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].length_feel).toBe('shorter');
    expect(rows[0].note).toBeNull(); // empty string dropped, never stored as ''
    expect(rows[0].content_helpful).toBeNull();
  });

  it('a wholly-empty submit is accepted (Send with nothing chosen) and still counts as "submitted"', async () => {
    app = buildTestApp();
    const { userId, session } = await seedJoinedSession('route-4');

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'note=',
    });
    expect(res.statusCode).toBe(303);

    // A row exists (so the page moves to the thanked state) with no answers.
    const rows = await feedbackRowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].content_helpful).toBeNull();
    expect(rows[0].note).toBeNull();
  });

  it('a re-submit upserts: no duplicate row, earlier answers preserved, re-answered ones updated', async () => {
    app = buildTestApp();
    const { userId, session } = await seedJoinedSession('route-5');

    const first = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'contentHelpful=true&note=' + encodeURIComponent('keep this'),
    });
    expect(first.statusCode).toBe(303);

    const second = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'contentHelpful=false&timeFeel=right',
    });
    expect(second.statusCode).toBe(303);

    const rows = await feedbackRowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].content_helpful).toBe(false); // revised answer wins
    expect(rows[0].note).toBe('keep this'); // omitted answer NOT erased
    expect(rows[0].time_feel).toBe('right'); // new answer lands
  });

  it('unknown, expired, and non-UUID tokens all return the byte-identical 404 "gone" page (enumeration-safe)', async () => {
    const fixedNow = new Date('2026-07-23T12:00:00.000Z');
    app = buildTestApp(() => fixedNow);
    const { session } = await seedJoinedSession(
      'route-6',
      new Date(fixedNow.getTime() - 3600_000), // expired an hour before "now"
    );

    const post = (token: string) =>
      app.inject({
        method: 'POST',
        url: `/session/${token}/feedback`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'contentHelpful=true',
      });

    const expiredRes = await post(session.token);
    const unknownRes = await post('00000000-0000-4000-8000-000000000000');
    const nonUuidRes = await post('not-a-uuid');

    for (const res of [expiredRes, unknownRes, nonUuidRes]) {
      expect(res.statusCode).toBe(404);
    }
    expect(expiredRes.body).toBe(unknownRes.body);
    expect(nonUuidRes.body).toBe(unknownRes.body);
    expect(expiredRes.headers['content-type']).toBe(unknownRes.headers['content-type']);

    // And nothing was stored for the expired-but-real session.
    const stored = await pool.query(`SELECT * FROM session_feedback`);
    expect(stored.rows).toHaveLength(0);
  });

  it('a joined-but-NOT-completed session is accepted (feedback without tapping Amen)', async () => {
    app = buildTestApp();
    const { userId, session } = await seedJoinedSession('route-7');
    expect(session.completed_at).toBeNull();

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { accept: 'application/json' },
      payload: { topicMore: true },
    });

    expect(res.statusCode).toBe(200);
    expect(await feedbackRowsFor(userId)).toHaveLength(1);
  });

  it('a never-joined session gets the documented 409 envelope and stores nothing', async () => {
    app = buildTestApp();
    const user = await repos.users.createUser({
      firebaseUid: 'fb-feedback-route-8',
      email: 'feedback-route-8@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    // Deliberately NO markJoined.

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { accept: 'application/json' },
      payload: { contentHelpful: true },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SESSION_NOT_JOINED');
    expect(await feedbackRowsFor(userId)).toHaveLength(0);
  });

  it('rejects a >500-char note with a 400 and stores nothing', async () => {
    app = buildTestApp();
    const { userId, session } = await seedJoinedSession('route-9');

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'note=' + encodeURIComponent('x'.repeat(501)),
    });

    expect(res.statusCode).toBe(400);
    expect(await feedbackRowsFor(userId)).toHaveLength(0);
  });

  it('rejects unknown fields (strict contract) with a 400 and stores nothing', async () => {
    app = buildTestApp();
    const { userId, session } = await seedJoinedSession('route-10');

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { accept: 'application/json' },
      payload: { contentHelpful: true, streakCount: 9 },
    });

    expect(res.statusCode).toBe(400);
    expect(await feedbackRowsFor(userId)).toHaveLength(0);
  });

  it('a __proto__ key in the body is rejected like any unknown field, never written as a property (remote-property-injection guard)', async () => {
    app = buildTestApp();
    const { userId, session } = await seedJoinedSession('route-11');

    // JSON.parse creates an own "__proto__" property; the normalizer must
    // treat it as an unknown key for the strict schema to 400, not loop
    // over it as a write target (the CodeQL js/remote-property-injection
    // sink this pins down).
    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      payload: '{"contentHelpful": true, "__proto__": {"polluted": true}}',
    });

    expect(res.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(await feedbackRowsFor(userId)).toHaveLength(0);
  });
});

describe('the full zero-JS loop (#321): complete → form → feedback → thanked', () => {
  let app: ReturnType<typeof buildTestApp>;

  afterEach(async () => {
    await app?.close();
  });

  it('walks the whole browser flow with nothing but forms and redirects', async () => {
    app = buildTestApp();
    const user = await repos.users.createUser({
      firebaseUid: 'fb-feedback-loop-1',
      email: 'feedback-loop-1@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    // 1. Open the session page (this is what sets joined_at — the gate).
    const pageRes = await app.inject({ method: 'GET', url: `/session/${session.token}` });
    expect(pageRes.statusCode).toBe(200);

    // 2. Tap "Amen — mark complete" (zero-JS form POST) → 303.
    const completeRes = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
      },
      payload: 'prayerIntention=',
    });
    expect(completeRes.statusCode).toBe(303);

    // 3. Land on the completion page: confirmation + the feedback form.
    const formPage = await app.inject({
      method: 'GET',
      url: completeRes.headers.location as string,
    });
    expect(formPage.statusCode).toBe(200);
    expect(formPage.body).toContain('thank you for being here');
    expect(formPage.body).toContain(`action="/session/${session.token}/feedback"`);
    expect(formPage.body).toContain('Did this meet you today?');

    // 4. Answer two questions and Send (zero-JS form POST) → 303 back.
    const feedbackRes = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/feedback`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
      },
      payload: 'contentHelpful=true&lengthFeel=right&note=',
    });
    expect(feedbackRes.statusCode).toBe(303);
    expect(feedbackRes.headers.location).toBe(`/session/${session.token}/complete`);

    // 5. The same URL now shows the thanked state — and no form (never
    //    nag twice), on this and every future revisit.
    for (let visit = 0; visit < 2; visit += 1) {
      const thankedPage = await app.inject({
        method: 'GET',
        url: `/session/${session.token}/complete`,
      });
      expect(thankedPage.statusCode).toBe(200);
      expect(thankedPage.body).toContain('Thank you &mdash; this shapes what comes next.');
      expect(thankedPage.body).not.toContain('<form');
      expect(thankedPage.body).not.toContain('Did this meet you today?');
    }

    // And the answers really landed (mutation check on the loop, not just 3xx).
    const rows = await feedbackRowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].content_helpful).toBe(true);
    expect(rows[0].length_feel).toBe('right');
  });

  it('GET /session/:token/complete still 404s enumeration-safely for an unknown token', async () => {
    app = buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/session/00000000-0000-4000-8000-000000000000/complete',
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('Did this meet you today?');
    expect(res.body).not.toContain('thank you for being here');
  });
});
