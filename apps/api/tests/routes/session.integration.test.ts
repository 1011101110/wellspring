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
import { LoggingGlooSummaryService } from '../../src/services/gloo/glooSummaryService.js';

/**
 * Integration test for the join-link surface (EPIC D, issues #31/#33).
 * Reuses the local Postgres container from A5 (kairos-test-pg,
 * port 5433) — same connection convention as
 * tests/db/repositories.test.ts. Does NOT start a new container.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
}

let audioRootDir: string;

beforeAll(async () => {
  await pool.query('SELECT 1 FROM users LIMIT 1');
  audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-session-audio-'));
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
    date: '2026-07-02',
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

function buildTestApp(
  now: () => Date = () => new Date(),
  opts: { withGlooDeps?: boolean; withPrayerIntentions?: boolean } = {},
) {
  const audioStorage = new LocalFileAudioStorage({
    rootDir: audioRootDir,
    signingSecret: 'a'.repeat(32),
    now,
  });
  const glooSummaryService = new LoggingGlooSummaryService();
  const sessionService = new SessionService({
    sessions: repos.sessions,
    devotionals: repos.devotionals,
    audioStorage,
    now,
    ...(opts.withGlooDeps
      ? {
          dailyBands: repos.dailyBands,
          glooSummaryService,
          glooEngagementSummaries: repos.glooEngagementSummaries,
        }
      : {}),
    ...(opts.withPrayerIntentions ? { prayerIntentions: repos.prayerIntentions } : {}),
  });
  const app = buildApp({ sessionService, audioStorage });
  return { app, audioStorage, glooSummaryService };
}

describe('GET /session/:token', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app'];

  afterEach(async () => {
    await app?.close();
  });

  it('renders verse text, attribution, and transcript, correctly HTML-escaped', async () => {
    ({ app } = await buildTestApp());

    const user = await repos.users.createUser({
      firebaseUid: 'fb-session-1',
      email: 'a@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(
      userId,
      minimalDevotional({
        theme: `<script>alert('xss')</script> Rest & "peace"`,
        devotionalBody: `Body with <b>HTML</b> & 'quotes' and "double quotes".`,
        prayer: `Lord's <em>prayer</em>`,
        verses: [
          {
            usfm: 'MAT.11.28',
            versionId: 3034,
            reference: 'Matthew 11:28',
            fetchedText: `<img src=x onerror=alert(1)> Come to me & rest.`,
            attribution: `Berean Standard Bible <BSB> & "Sons"`,
          },
        ],
      }),
    );
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await app.inject({ method: 'GET', url: `/session/${session.token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');

    const body = res.body;

    // Content is present.
    expect(body).toContain('Come to me &amp; rest.');
    expect(body).toContain('Berean Standard Bible &lt;BSB&gt; &amp; &quot;Sons&quot;');
    expect(body).toContain('Body with &lt;b&gt;HTML&lt;/b&gt; &amp; &#39;quotes&#39;');
    expect(body).toContain('Lord&#39;s &lt;em&gt;prayer&lt;/em&gt;');

    // Never raw/unescaped — this is the anti-injection assertion.
    expect(body).not.toContain("<script>alert('xss')</script>");
    expect(body).not.toContain('<img src=x onerror=alert(1)>');
    expect(body).not.toContain('<b>HTML</b>');
    expect(body).not.toContain('<em>prayer</em>');
  });

  it('shows the AUDIO_UNAVAILABLE transcript-first state when there is no audio object', async () => {
    ({ app } = await buildTestApp());

    const user = await repos.users.createUser({
      firebaseUid: 'fb-session-2',
      email: 'b@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await app.inject({ method: 'GET', url: `/session/${session.token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<audio');
    expect(res.body).toContain('The audio is resting today');
    expect(res.body).toContain('A short devotional body about rest.');
  });

  it('serves a working <audio> element with a signed URL when audio exists', async () => {
    const { app: localApp, audioStorage } = await buildTestApp();
    app = localApp;

    const user = await repos.users.createUser({
      firebaseUid: 'fb-session-3',
      email: 'c@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    await audioStorage.upload(devo.id, Buffer.from('fake mp3 bytes'));
    await repos.devotionals.setAudioObject(userId, devo.id, `devotionals/${devo.id}.mp3`);
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await app.inject({ method: 'GET', url: `/session/${session.token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<audio controls');
    expect(res.body).toMatch(/<source src="[^"]+" type="audio\/mpeg" \/>/);
  });

  it('END-TO-END (issue #68 §1.2 regression): the audio URL rendered on the session page is a REAL, fetchable link, not a dead one', async () => {
    // Before this fix, no route served /audio/:token at all — the <audio>
    // element's src was a 404 in every environment. This test extracts the
    // exact URL the page renders and GETs it, proving the full wire-through
    // rather than asserting on the URL string alone (the pre-fix test gap).
    const { app: localApp, audioStorage } = await buildTestApp();
    app = localApp;

    const user = await repos.users.createUser({
      firebaseUid: 'fb-session-e2e',
      email: 'e2e@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const realAudioBytes = Buffer.from('this is the real synthesized mp3 payload');
    await audioStorage.upload(devo.id, realAudioBytes);
    await repos.devotionals.setAudioObject(userId, devo.id, `devotionals/${devo.id}.mp3`);
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const pageRes = await app.inject({ method: 'GET', url: `/session/${session.token}` });
    expect(pageRes.statusCode).toBe(200);

    const srcMatch = pageRes.body.match(/<source src="([^"]+)" type="audio\/mpeg" \/>/);
    expect(srcMatch).not.toBeNull();
    const audioUrl = new URL(srcMatch![1]!);

    const audioRes = await app.inject({ method: 'GET', url: audioUrl.pathname + audioUrl.search });

    expect(audioRes.statusCode).toBe(200);
    expect(audioRes.headers['content-type']).toBe('audio/mpeg');
    expect(Buffer.from(audioRes.rawPayload).equals(realAudioBytes)).toBe(true);
  });

  it('returns 404 for a nonexistent token', async () => {
    ({ app } = await buildTestApp());

    const res = await app.inject({
      method: 'GET',
      url: '/session/00000000-0000-4000-8000-000000000000',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns the IDENTICAL 404 body for an expired token as for a nonexistent token (enumeration-safe)', async () => {
    const fixedNow = new Date('2026-07-02T12:00:00.000Z');
    ({ app } = await buildTestApp(() => fixedNow));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-session-4',
      email: 'd@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    // Expired one hour before "now".
    const expiredSession = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(fixedNow.getTime() - 3600_000),
    });

    const expiredRes = await app.inject({ method: 'GET', url: `/session/${expiredSession.token}` });
    const unknownRes = await app.inject({
      method: 'GET',
      url: '/session/00000000-0000-4000-8000-000000000000',
    });

    expect(expiredRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(expiredRes.body).toBe(unknownRes.body);
    expect(expiredRes.headers['content-type']).toBe(unknownRes.headers['content-type']);
  });

  it('REGRESSION (issue #72 / docs/14 §2.9): a non-UUID token returns a 404 byte-identical to a UUID-shaped unknown token, never a 500', async () => {
    // Before this fix, `GET /session/abc` reached
    // `sessionsRepository.findByToken('abc')`'s `WHERE token = $1`
    // against a `uuid` column — Postgres threw a cast error (22P02) and,
    // with no global error handler, Fastify's default serialized that
    // raw pg message into a 500. A 500 is trivially distinguishable from
    // this route's normal 404, which breaks the enumeration-safety
    // contract (docs/04 §5.4) on top of leaking internals (§2.9's other
    // half). This asserts the two cases are now not just both 404, but
    // byte-for-byte the SAME response.
    ({ app } = await buildTestApp());

    const nonUuidRes = await app.inject({ method: 'GET', url: '/session/abc' });
    const unknownUuidRes = await app.inject({
      method: 'GET',
      url: '/session/00000000-0000-4000-8000-000000000000',
    });

    expect(nonUuidRes.statusCode).toBe(404);
    expect(nonUuidRes.statusCode).not.toBe(500);
    expect(nonUuidRes.body).toBe(unknownUuidRes.body);
    expect(nonUuidRes.headers['content-type']).toBe(unknownUuidRes.headers['content-type']);
  });

  it('a non-UUID token also 404s on the /complete route, never a 500', async () => {
    ({ app } = await buildTestApp());

    const res = await app.inject({ method: 'POST', url: '/session/not-a-uuid/complete' });

    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(500);
  });

  it('records joined_at on the first view (issue #84: join-rate metrics)', async () => {
    ({ app } = await buildTestApp());

    const user = await repos.users.createUser({
      firebaseUid: 'fb-session-join-1',
      email: 'join1@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(session.joined_at).toBeNull();

    const res = await app.inject({ method: 'GET', url: `/session/${session.token}` });
    expect(res.statusCode).toBe(200);

    const after = await repos.sessions.findByToken(session.token);
    expect(after?.joined_at).not.toBeNull();
  });

  it('does not move joined_at on a second view (first join time is sticky)', async () => {
    ({ app } = await buildTestApp());

    const user = await repos.users.createUser({
      firebaseUid: 'fb-session-join-2',
      email: 'join2@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    await app.inject({ method: 'GET', url: `/session/${session.token}` });
    const afterFirst = await repos.sessions.findByToken(session.token);
    expect(afterFirst?.joined_at).not.toBeNull();

    await app.inject({ method: 'GET', url: `/session/${session.token}` });
    const afterSecond = await repos.sessions.findByToken(session.token);
    expect(afterSecond?.joined_at?.getTime()).toBe(afterFirst?.joined_at?.getTime());
  });

  it('never records joined_at for an expired token (404 path)', async () => {
    const fixedNow = new Date('2026-07-02T12:00:00.000Z');
    ({ app } = await buildTestApp(() => fixedNow));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-session-join-3',
      email: 'join3@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(fixedNow.getTime() - 3600_000),
    });

    const res = await app.inject({ method: 'GET', url: `/session/${session.token}` });
    expect(res.statusCode).toBe(404);

    const after = await repos.sessions.findByToken(session.token);
    expect(after?.joined_at).toBeNull();
  });
});

describe('POST /session/:token/complete', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app'];

  afterEach(async () => {
    await app?.close();
  });

  it('marks completed_at on first submit and is idempotent on a second (double-submit)', async () => {
    ({ app } = await buildTestApp());

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-1',
      email: 'e@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    expect(session.completed_at).toBeNull();

    const firstRes = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
    });
    expect(firstRes.statusCode).toBe(200);
    const firstBody = firstRes.json();
    expect(firstBody.ok).toBe(true);
    expect(typeof firstBody.completedAt).toBe('string');

    const afterFirst = await repos.sessions.findByToken(session.token);
    expect(afterFirst?.completed_at).not.toBeNull();

    // Double-submit: completed_at must not change.
    const secondRes = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
    });
    expect(secondRes.statusCode).toBe(200);
    const secondBody = secondRes.json();
    expect(secondBody.completedAt).toBe(firstBody.completedAt);

    const afterSecond = await repos.sessions.findByToken(session.token);
    expect(afterSecond?.completed_at?.getTime()).toBe(afterFirst?.completed_at?.getTime());

    // The session page now shows the quiet "Completed" badge, not the form.
    const pageRes = await app.inject({ method: 'GET', url: `/session/${session.token}` });
    expect(pageRes.body).toContain('Completed');
    expect(pageRes.body).not.toContain(`action="/session/${session.token}/complete"`);
  });

  it('returns 404 (not a 500) when completing a nonexistent token', async () => {
    ({ app } = await buildTestApp());

    const res = await app.inject({
      method: 'POST',
      url: '/session/00000000-0000-4000-8000-000000000000/complete',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when completing an expired token', async () => {
    const fixedNow = new Date('2026-07-02T12:00:00.000Z');
    ({ app } = await buildTestApp(() => fixedNow));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-2',
      email: 'f@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(fixedNow.getTime() - 1000),
    });

    const res = await app.inject({ method: 'POST', url: `/session/${session.token}/complete` });
    expect(res.statusCode).toBe(404);
  });

  it('sends and persists an F8 Gloo engagement summary on first completion, using the day\'s bands when present', async () => {
    let glooSummaryService: LoggingGlooSummaryService;
    ({ app, glooSummaryService } = buildTestApp(() => new Date(), { withGlooDeps: true }));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-gloo-1',
      email: 'gloo1@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    await repos.dailyBands.upsertForDate(userId, {
      date: devo.date,
      recovery: 'low',
      sleepQuality: 'poor',
      activity: 'sedentary',
      busyness: 'heavy',
      communicationLoad: null,
    });
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      payload: { durationListenedSec: 291 },
    });
    expect(res.statusCode).toBe(200);

    // Fire-and-forget: give the un-awaited summary helper a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(glooSummaryService.sent).toHaveLength(1);
    expect(glooSummaryService.sent[0]).toEqual({
      date: devo.date,
      bands: {
        recovery: 'low',
        sleepQuality: 'poor',
        activity: 'sedentary',
        busyness: 'heavy',
        communicationLoad: null,
      },
      format: 'short',
      theme: 'Rest for the weary',
      passage_usfm: 'MAT.11.28',
      versionId: 3034,
      completed: true,
      durationListenedSec: 291,
    });

    const afterSession = await repos.sessions.findByToken(session.token);
    expect(afterSession?.duration_listened_sec).toBe(291);

    const persisted = await pool.query(
      `SELECT * FROM gloo_engagement_summaries WHERE user_id = $1`,
      [userId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0].payload.durationListenedSec).toBe(291);
  });

  it('does not re-fire the Gloo summary on a double-submit', async () => {
    let glooSummaryService: LoggingGlooSummaryService;
    ({ app, glooSummaryService } = buildTestApp(() => new Date(), { withGlooDeps: true }));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-gloo-2',
      email: 'gloo2@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    await app.inject({ method: 'POST', url: `/session/${session.token}/complete` });
    await app.inject({ method: 'POST', url: `/session/${session.token}/complete` });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(glooSummaryService.sent).toHaveLength(1);
  });

  // ──────────────────────────────────────────────────────────────
  // Prayer intentions — deliberate disclosure (docs/14 §5.5, issue #93)
  // ──────────────────────────────────────────────────────────────

  it('a genuine application/x-www-form-urlencoded POST (the real zero-JS <form> submission) records the prayer intention', async () => {
    ({ app } = await buildTestApp(() => new Date(), { withPrayerIntentions: true }));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-prayer-1',
      email: 'prayer1@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'prayerIntention=' + encodeURIComponent('a hard week, carrying a lot'),
    });
    // #297: a real (zero-JS) form submission now 303-redirects to the friendly
    // confirmation page instead of dumping raw JSON on the user.
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/session/${session.token}/complete`);

    // Recording is fire-and-forget (mirrors sendGlooSummary()) — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await repos.prayerIntentions.getForDate(userId, devo.date);
    expect(stored?.text).toBe('a hard week, carrying a lot');
  });

  it('does not record a prayer intention when the field is blank/omitted', async () => {
    ({ app } = await buildTestApp(() => new Date(), { withPrayerIntentions: true }));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-prayer-2',
      email: 'prayer2@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'prayerIntention=',
    });
    expect(res.statusCode).toBe(303);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await repos.prayerIntentions.getForDate(userId, devo.date);
    expect(stored).toBeNull();
  });

  it('does not record a prayer intention when the prayerIntentions dep is absent (existing callers unaffected)', async () => {
    ({ app } = await buildTestApp());

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-prayer-3',
      email: 'prayer3@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'prayerIntention=' + encodeURIComponent('should not be stored'),
    });
    expect(res.statusCode).toBe(303);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await pool.query('SELECT * FROM prayer_intentions WHERE user_id = $1', [userId]);
    expect(stored.rows).toHaveLength(0);
  });

  it('does not re-record (or error) on a double-submit of the same prayer intention (unique constraint idempotency)', async () => {
    ({ app } = await buildTestApp(() => new Date(), { withPrayerIntentions: true }));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-prayer-4',
      email: 'prayer4@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const firstRes = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'prayerIntention=' + encodeURIComponent('first submission'),
    });
    expect(firstRes.statusCode).toBe(303);

    const secondRes = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'prayerIntention=' + encodeURIComponent('retried submission'),
    });
    expect(secondRes.statusCode).toBe(303);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await pool.query('SELECT * FROM prayer_intentions WHERE user_id = $1', [userId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].text).toBe('first submission');
  });

  it('rejects (silently ignores, does not 500) a prayer intention longer than 500 characters', async () => {
    ({ app } = await buildTestApp(() => new Date(), { withPrayerIntentions: true }));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-prayer-5',
      email: 'prayer5@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const tooLong = 'x'.repeat(501);
    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'prayerIntention=' + encodeURIComponent(tooLong),
    });
    expect(res.statusCode).toBe(303);

    const stored = await repos.prayerIntentions.getForDate(userId, devo.date);
    expect(stored).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────
  // #297 — a browser must never land on raw JSON after "Amen"
  // ──────────────────────────────────────────────────────────────

  it('a browser form submission redirects (303) to a friendly HTML confirmation page, never raw JSON', async () => {
    ({ app } = await buildTestApp(() => new Date(), { withPrayerIntentions: true }));

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-297-1',
      email: 'amen1@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    // Exactly what a real zero-JS <form> POST from a browser sends.
    const postRes = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
      },
      payload: 'prayerIntention=' + encodeURIComponent('carrying a lot today'),
    });

    // Not the old raw-JSON 200.
    expect(postRes.statusCode).toBe(303);
    expect(postRes.headers.location).toBe(`/session/${session.token}/complete`);
    expect(postRes.body).not.toContain('"ok":true');

    // Following the redirect lands on a calm, human confirmation page.
    const confirmRes = await app.inject({
      method: 'GET',
      url: postRes.headers.location as string,
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.headers['content-type']).toContain('text/html');
    expect(confirmRes.body).toContain('Completed');
    expect(confirmRes.body).toContain('thank you for being here');
    // Never a JSON blob.
    expect(confirmRes.body).not.toContain('"ok":true');

    // The completion side effect still happened.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await repos.prayerIntentions.getForDate(userId, devo.date);
    expect(stored?.text).toBe('carrying a lot today');
  });

  it('a programmatic JSON client still gets the machine-readable { ok, completedAt } body', async () => {
    ({ app } = await buildTestApp());

    const user = await repos.users.createUser({
      firebaseUid: 'fb-complete-297-2',
      email: 'amen2@example.com',
    });
    const userId = asVerifiedUserId(user.id);
    const devo = await repos.devotionals.create(userId, minimalDevotional());
    const session = await repos.sessions.create(userId, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    // A fetch-style JSON client (Content-Type + Accept application/json).
    const res = await app.inject({
      method: 'POST',
      url: `/session/${session.token}/complete`,
      headers: { accept: 'application/json' },
      payload: { durationListenedSec: 120 },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.completedAt).toBe('string');
  });

  it('GET /session/:token/complete returns the enumeration-safe 404 page for an unknown token', async () => {
    ({ app } = await buildTestApp());

    const res = await app.inject({
      method: 'GET',
      url: '/session/00000000-0000-4000-8000-000000000000/complete',
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).not.toContain('thank you for being here');
  });
});
