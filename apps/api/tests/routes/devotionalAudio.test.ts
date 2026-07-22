/**
 * `GET /v1/devotionals/:id/audio` — devotional REPLAY (EPIC L, issues
 * #236/#241).
 *
 * What these tests exist to prove, per #193's standard of proof ("assert
 * behavior, not that it looks fine"):
 *
 *  1. **Replay actually works after the session link is dead.** The bug
 *     this route fixes is not a signed-URL expiry — `getSignedUrl` was
 *     always called at render time — it is that the ONLY caller of it,
 *     `/session/:token`, 404s once `sessions.expires_at` (event-end +
 *     48h) passes. So the central test drives a *seven-day-old*
 *     devotional through a real `LocalFileAudioStorage` on a
 *     time-travelling clock, and verifies the returned token against
 *     that storage — a URL string that merely "looks like a URL" would
 *     pass a shallow assertion and fail a real player.
 *
 *  2. **A non-owner gets nothing.** The devotionals repository here is a
 *     stateful fake that reproduces the real query's `WHERE user_id = $1
 *     AND id = $2` scoping, so "the route forgot to pass the userId"
 *     is a failure this test can actually catch — a `vi.fn()` returning
 *     a canned row could not. Foundation §10 / docs/04 §5.4: 404, never
 *     403, and identical to a nonexistent id.
 *
 *  3. **Replay is a pure read.** Reopening Tuesday's devotional on
 *     Friday must not record a join or a completion (issues #84/#86/#93)
 *     — otherwise the dashboard silently inflates PRD §8's join-rate
 *     metric and re-fires Gloo engagement summaries.
 *
 *  4. **Purged audio fails cleanly**, never as a 500 or a dead player.
 *
 * DB-free — no kairos-test-pg container needed; same harness shape as
 * preferencesOnboarding.test.ts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerDevotionalAudioRoutes } from '../../src/routes/devotionalAudio.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository, UserRow } from '../../src/db/repositories/usersRepository.js';
import type { DevotionalRow } from '../../src/db/repositories/devotionalsRepository.js';
import {
  LocalFileAudioStorage,
  audioObjectKey,
  type AudioStorage,
} from '../../src/services/audio/audioStorage.js';

const OWNER_ID = '00000000-0000-0000-0000-0000000000a1';
const OWNER_UID = 'firebase-uid-owner';
const STRANGER_ID = '00000000-0000-0000-0000-0000000000b2';
const STRANGER_UID = 'firebase-uid-stranger';

const DEVOTIONAL_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The instant the devotional (and its now-dead session link) was created,
 * and the instant the user taps it in the dashboard seven days later.
 * Seven days is chosen deliberately: it is past `SESSION_EXPIRY_MS`
 * (event-end + 48h, generateNowOrchestrator.ts) so the join link is gone,
 * but inside the 14-day audio retention window (purgeJobs.ts
 * `DEVOTIONAL_AUDIO_RETENTION_DAYS`) so the MP3 is genuinely still there.
 * That gap is exactly the window replay has to serve.
 */
const GENERATED_AT = new Date('2026-07-12T07:30:00Z');
const REPLAYED_AT = new Date('2026-07-19T09:15:00Z');

function buildDevotionalRow(overrides: Partial<DevotionalRow> = {}): DevotionalRow {
  return {
    id: DEVOTIONAL_ID,
    user_id: OWNER_ID,
    date: '2026-07-12',
    format: 'short',
    theme: 'Rest',
    verses: [],
    devotional_body: 'body',
    card_summary: 'summary',
    prayer: 'prayer',
    journaling_prompt: null,
    action_step: null,
    audio_object: audioObjectKey(DEVOTIONAL_ID),
    status: 'delivered',
    is_fixture_fallback: false,
    slot_type: 'standard',
    meetbot_played_at: null,
    created_at: GENERATED_AT,
    updated_at: GENERATED_AT,
    ...overrides,
  } as DevotionalRow;
}

/**
 * Stateful stand-ins. `devotionals.getById` reproduces the real SQL's
 * user scoping rather than recording the call — see this file's header
 * for why that distinction is the whole point of test #2. `sessions` is
 * present only so test #3 can assert its mutating methods are never
 * reached.
 */
function buildFakeRepositories(rows: DevotionalRow[]) {
  const userRows: Record<string, UserRow> = {
    [OWNER_UID]: { id: OWNER_ID, firebase_uid: OWNER_UID } as unknown as UserRow,
    [STRANGER_UID]: { id: STRANGER_ID, firebase_uid: STRANGER_UID } as unknown as UserRow,
  };

  const getById = vi.fn(async (userId: string, devotionalId: string) => {
    // WHERE user_id = $1 AND id = $2 — both predicates, as in
    // DevotionalsRepository.getById.
    return rows.find((r) => r.user_id === userId && r.id === devotionalId) ?? null;
  });

  const markJoined = vi.fn(async () => null);
  const markCompleted = vi.fn(async () => null);

  const users = {
    findOrCreateByFirebaseUid: vi.fn(async (firebaseUid: string) => userRows[firebaseUid]),
    findById: vi.fn(async (id: string) => Object.values(userRows).find((u) => u.id === id) ?? null),
    adoptTimezone: vi.fn().mockResolvedValue(null),
  } as unknown as UsersRepository;

  return {
    getById,
    markJoined,
    markCompleted,
    repositories: {
      users,
      devotionals: { getById },
      sessions: { markJoined, markCompleted },
    } as unknown as Repositories,
  };
}

const tempDirs: string[] = [];

async function buildAudioStorage(now: () => Date, options: { writeFile?: boolean } = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'kairos-replay-'));
  tempDirs.push(rootDir);
  const storage = new LocalFileAudioStorage({
    rootDir,
    // Fake, self-describing test value feeding LocalFileAudioStorage in a
    // temp dir — no live signing key exists behind it. Flagged by gitleaks'
    // generic-api-key heuristic on the \`signingSecret:\` assignment shape;
    // allowlisted inline rather than loosening the scanner itself, matching
    // how the fake Svix webhook secret is handled in inboundInvite.test.ts.
    signingSecret: 'test-signing-secret-at-least-16-chars', // gitleaks:allow
    baseUrl: 'http://localhost:8080',
    now,
  });
  if (options.writeFile !== false) {
    // Write through the storage's own upload path so the object key
    // layout under test is the real one, not a hand-built path.
    await storage.upload(DEVOTIONAL_ID, Buffer.from('fake-mp3-bytes'));
  }
  return storage;
}

async function buildTestApp(opts: {
  rows: DevotionalRow[];
  audioStorage: AudioStorage;
}) {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const fakes = buildFakeRepositories(opts.rows);

  registerAuth(app, verifier, fakes.repositories.users);
  registerDevotionalAudioRoutes(app, {
    repositories: fakes.repositories,
    audioStorage: opts.audioStorage,
  });

  return {
    app,
    ownerToken: await verifier.mint(OWNER_UID),
    strangerToken: await verifier.mint(STRANGER_UID),
    ...fakes,
  };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Recovers the signed token from `${baseUrl}/audio/<token>` so it can be verified against the storage that minted it. */
function tokenFromUrl(url: string): string {
  const last = url.split('/').pop() ?? '';
  return decodeURIComponent(last);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('replaying a devotional whose session link has long expired (#241)', () => {
  it('mints a fresh, currently-valid audio URL seven days after generation', async () => {
    // The clock is the subject of this test. `now` starts at generation
    // time so the "original" URL is minted under the same conditions the
    // session page would have, then jumps seven days — past
    // SESSION_EXPIRY_MS, so `/session/:token` would 404 — and the
    // authenticated route is asked for audio.
    let now = GENERATED_AT;
    const audioStorage = await buildAudioStorage(() => now);
    const { app, ownerToken } = await buildTestApp({
      rows: [buildDevotionalRow()],
      audioStorage,
    });

    const originalUrl = (await audioStorage.getSignedUrl(DEVOTIONAL_ID)).url;

    now = REPLAYED_AT;

    // Precondition, asserted rather than assumed: the URL from generation
    // day is genuinely dead by now. Without this, "the replay URL works"
    // could be true simply because nothing ever expires.
    expect(audioStorage.verifyToken(tokenFromUrl(originalUrl))).toMatchObject({
      valid: false,
      reason: 'expired',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
      headers: authed(ownerToken),
    });

    expect(res.statusCode).toBe(200);
    const { url, expiresAt } = res.json().data;

    // Fresh, not the baked-in one from generation day.
    expect(url).not.toBe(originalUrl);

    // And fresh in the sense that matters: the storage that issued it
    // accepts it right now, scoped to this devotional's object. A route
    // that returned a stale or wrongly-scoped token fails here, where a
    // `expect(url).toContain('/audio/')` would not.
    expect(audioStorage.verifyToken(tokenFromUrl(url), audioObjectKey(DEVOTIONAL_ID))).toMatchObject(
      { valid: true },
    );

    // Short-lived, per API spec §6's 15-minute default — replay must not
    // hand out a long-lived URL just because the content is old.
    const ttlMs = new Date(expiresAt).getTime() - REPLAYED_AT.getTime();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000);

    await app.close();
  });

  it('mints a different URL on every call rather than reusing one', async () => {
    // Two replays inside the same 15-minute window: still two distinct
    // tokens. This pins "minted per request" as opposed to "minted once
    // and memoized somewhere", which would quietly reintroduce a stored
    // signed URL (API spec §6: "never stored").
    const now = REPLAYED_AT;
    const audioStorage = await buildAudioStorage(() => now);
    const { app, ownerToken } = await buildTestApp({
      rows: [buildDevotionalRow()],
      audioStorage,
    });

    const first = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
      headers: authed(ownerToken),
    });
    const second = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
      headers: authed(ownerToken),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.url).not.toBe(first.json().data.url);

    await app.close();
  });

  it('does not record a join or a completion — replay is a pure read', async () => {
    // Issues #84/#86/#93: the session page records `joined_at` and, on
    // POST, fires the Gloo engagement summary and stores a prayer
    // intention. Serving replay through that surface would have counted
    // every re-listen as a fresh join against PRD §8's 60%-join-rate
    // metric and re-sent engagement summaries for a devotional completed
    // days ago.
    const now = REPLAYED_AT;
    const audioStorage = await buildAudioStorage(() => now);
    const { app, ownerToken, markJoined, markCompleted } = await buildTestApp({
      rows: [buildDevotionalRow()],
      audioStorage,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
      headers: authed(ownerToken),
    });

    expect(res.statusCode).toBe(200);
    expect(markJoined).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('replay authorization (#241, Foundation §10 IDOR)', () => {
  it("refuses to mint audio for another user's devotional", async () => {
    // The devotional exists and its MP3 is on disk; the only thing
    // standing between the stranger and it is the route's owner scoping.
    const now = REPLAYED_AT;
    const audioStorage = await buildAudioStorage(() => now);
    const { app, strangerToken, getById } = await buildTestApp({
      rows: [buildDevotionalRow()],
      audioStorage,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
      headers: authed(strangerToken),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    // No URL of any kind in the body — not an expired one, not a
    // wrong-object one. Nothing playable escapes.
    expect(res.body).not.toContain('/audio/');

    // And the lookup really was scoped to the caller: if the route ever
    // passed a devotional-only lookup (or the wrong userId), this
    // assertion is what fails rather than the status code, which would
    // still be 404 for other reasons.
    expect(getById).toHaveBeenCalledWith(STRANGER_ID, DEVOTIONAL_ID);

    await app.close();
  });

  it('answers identically for a nonexistent devotional — no existence oracle', async () => {
    // docs/04 §5.4: another user's resource must be indistinguishable
    // from one that never existed. Same status, same body.
    const now = REPLAYED_AT;
    const audioStorage = await buildAudioStorage(() => now);
    const { app, strangerToken } = await buildTestApp({
      rows: [buildDevotionalRow()],
      audioStorage,
    });

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
      headers: authed(strangerToken),
    });
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/22222222-2222-4222-8222-222222222222/audio`,
      headers: authed(strangerToken),
    });

    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(missing.body).toBe(foreign.body);

    await app.close();
  });

  it('requires authentication at all', async () => {
    const now = REPLAYED_AT;
    const audioStorage = await buildAudioStorage(() => now);
    const { app } = await buildTestApp({ rows: [buildDevotionalRow()], audioStorage });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('404s a malformed id instead of letting it reach a uuid column', async () => {
    // docs/14 §2.9 / issue #72 — a pg cast error would surface as a 500,
    // leaking Postgres internals and distinguishing itself from the
    // normal 404.
    const now = REPLAYED_AT;
    const audioStorage = await buildAudioStorage(() => now);
    const { app, ownerToken, getById } = await buildTestApp({
      rows: [buildDevotionalRow()],
      audioStorage,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/devotionals/not-a-uuid/audio',
      headers: authed(ownerToken),
    });

    expect(res.statusCode).toBe(404);
    expect(getById).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('replay against purged audio (#82 retention)', () => {
  it('reports AUDIO_UNAVAILABLE when the purge job has nulled audio_object', async () => {
    // Devotional text is kept until account deletion; its audio only 14
    // days. Past that, the row is still listed on the dashboard and this
    // must be a calm, typed answer the client can render as
    // transcript-only.
    const now = REPLAYED_AT;
    const audioStorage = await buildAudioStorage(() => now);
    const { app, ownerToken } = await buildTestApp({
      rows: [buildDevotionalRow({ audio_object: null })],
      audioStorage,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
      headers: authed(ownerToken),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('AUDIO_UNAVAILABLE');
    expect(res.json().error.retryable).toBe(false);
    await app.close();
  });

  it('reports AUDIO_UNAVAILABLE when the object is gone but the column still points at it', async () => {
    // The real skew issue #82 called out: the GCS bucket's own 14-day
    // lifecycle rule (docs/06 §1.4) can delete the object before the
    // purge job nulls the column. Minting a signed URL here would
    // succeed and then 404 inside the <audio> element — a dead player,
    // which is the failure mode #241 exists to prevent.
    const now = REPLAYED_AT;
    const audioStorage = await buildAudioStorage(() => now, { writeFile: false });
    const { app, ownerToken } = await buildTestApp({
      rows: [buildDevotionalRow()],
      audioStorage,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
      headers: authed(ownerToken),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('AUDIO_UNAVAILABLE');
    await app.close();
  });

  it('degrades to AUDIO_UNAVAILABLE rather than 500 when storage itself fails', async () => {
    // Foundation §4.5. A credentials/bucket failure must not become a
    // 500 (which would also risk echoing bucket names — docs/14 §2.9).
    const failing = {
      exists: vi.fn(async () => true),
      getSignedUrl: vi.fn(async () => {
        throw new Error('signing failed for bucket kairos-audio-secret');
      }),
      upload: vi.fn(),
      delete: vi.fn(),
    } as unknown as AudioStorage;

    const { app, ownerToken } = await buildTestApp({
      rows: [buildDevotionalRow()],
      audioStorage: failing,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/devotionals/${DEVOTIONAL_ID}/audio`,
      headers: authed(ownerToken),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('AUDIO_UNAVAILABLE');
    expect(res.body).not.toContain('kairos-audio-secret');
    await app.close();
  });
});
