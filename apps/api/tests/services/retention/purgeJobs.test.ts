/**
 * Retention & purge job tests (EPIC F, issue #44). Time-travel style:
 * insert rows with a backdated `created_at`/`date` via direct SQL (the
 * repository layer always defaults to `now()`, so backdating requires
 * an explicit UPDATE after insert — matching how a real row would age
 * into the retention window over time), run the purge function, and
 * assert exactly the right rows are gone and nothing else.
 *
 * Reuses kairos-test-pg (A5 convention, port 5433).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
} from '../../../src/db/repositories/index.js';
import { LocalFileAudioStorage } from '../../../src/services/audio/audioStorage.js';
import type { GoogleKmsService } from '../../../src/services/calendar/googleKmsService.js';
import type { GoogleOAuthService } from '../../../src/services/calendar/googleOAuthService.js';
import {
  DAILY_BANDS_RETENTION_DAYS,
  DEVOTIONAL_AUDIO_RETENTION_DAYS,
  PRAYER_INTENTIONS_RETENTION_DAYS,
  SESSION_RETENTION_DAYS_AFTER_EXPIRY,
  hardDeleteAccount,
  purgeDevotionalAudio,
  purgeExpiredSessionRows,
  purgePrayerIntentions,
  runAllPurgeJobs,
} from '../../../src/services/retention/purgeJobs.js';

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
  audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-purge-audio-'));
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

async function makeUser(local: string) {
  const row = await repos.users.createUser({
    firebaseUid: `purge-${local}`,
    email: `${local}@example.com`,
  });
  return asVerifiedUserId(row.id);
}

async function backdateDevotional(id: string, createdAt: Date) {
  await pool.query('UPDATE devotionals SET created_at = $2 WHERE id = $1', [id, createdAt]);
}

async function backdatePrayerIntention(id: string, createdAt: Date) {
  await pool.query('UPDATE prayer_intentions SET created_at = $2 WHERE id = $1', [id, createdAt]);
}

const NOW = new Date('2026-07-02T12:00:00.000Z');
function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * DailyBandsRepository.purgeOlderThan compares the `date` column (a
 * DATE, not a timestamp) against `CURRENT_DATE - days` in Postgres — so
 * time-travel for bands means writing a `date` N days before the DB
 * server's *actual* current date, not backdating `created_at` (which
 * that query never reads). ISO YYYY-MM-DD string, matching the column type.
 */
function dateStringDaysBeforeToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe('daily_bands purge (90 days)', () => {
  it('deletes only rows older than 90 days for that user, keeps newer rows and other users rows', async () => {
    const userA = await makeUser('bands-a');
    const userB = await makeUser('bands-b');

    const oldDate = dateStringDaysBeforeToday(DAILY_BANDS_RETENTION_DAYS + 5);
    const old = await repos.dailyBands.upsertForDate(userA, { date: oldDate, recovery: 'low' });

    // Just inside the retention window (89 days back) — must survive; only strictly-older-than-90 is purged.
    const boundaryDate = dateStringDaysBeforeToday(DAILY_BANDS_RETENTION_DAYS - 1);
    const boundary = await repos.dailyBands.upsertForDate(userA, {
      date: boundaryDate,
      recovery: 'moderate',
    });

    const recentDate = dateStringDaysBeforeToday(10);
    const recent = await repos.dailyBands.upsertForDate(userA, {
      date: recentDate,
      recovery: 'high',
    });

    const otherUserOld = await repos.dailyBands.upsertForDate(userB, {
      date: oldDate,
      recovery: 'low',
    });

    const deletedA = await repos.dailyBands.purgeOlderThan(userA, DAILY_BANDS_RETENTION_DAYS);
    expect(deletedA).toBe(1);

    const remainingA = await repos.dailyBands.listRecent(userA, 100);
    expect(remainingA.map((r) => r.id).sort()).toEqual([boundary.id, recent.id].sort());
    expect(remainingA.find((r) => r.id === old.id)).toBeUndefined();

    // User B's old row is untouched by a purge scoped to user A.
    const remainingB = await repos.dailyBands.listRecent(userB, 100);
    expect(remainingB.map((r) => r.id)).toEqual([otherUserOld.id]);
  });
});

describe('devotional audio purge (14 days)', () => {
  it('deletes the audio file + nulls audio_object for devotionals older than 14 days; leaves text and newer audio intact', async () => {
    const audioStorage = new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
    const userA = await makeUser('audio-a');

    // Old devotional with audio -> should be purged.
    const oldDevo = await repos.devotionals.create(
      userA,
      minimalDevotional({ theme: 'old with audio' }),
    );
    await backdateDevotional(oldDevo.id, daysBefore(NOW, DEVOTIONAL_AUDIO_RETENTION_DAYS + 1));
    await audioStorage.upload(oldDevo.id, Buffer.from('old mp3 bytes'));
    await repos.devotionals.setAudioObject(userA, oldDevo.id, `devotionals/${oldDevo.id}.mp3`);

    // Old devotional with NO audio -> nothing to purge (findWithAudioOlderThan excludes it).
    const oldNoAudio = await repos.devotionals.create(
      userA,
      minimalDevotional({ theme: 'old no audio' }),
    );
    await backdateDevotional(oldNoAudio.id, daysBefore(NOW, DEVOTIONAL_AUDIO_RETENTION_DAYS + 1));

    // Recent devotional with audio -> must survive.
    const recentDevo = await repos.devotionals.create(
      userA,
      minimalDevotional({ theme: 'recent with audio' }),
    );
    await backdateDevotional(recentDevo.id, daysBefore(NOW, 5));
    await audioStorage.upload(recentDevo.id, Buffer.from('recent mp3 bytes'));
    await repos.devotionals.setAudioObject(
      userA,
      recentDevo.id,
      `devotionals/${recentDevo.id}.mp3`,
    );

    const purgedCount = await purgeDevotionalAudio(repos.devotionals, audioStorage, NOW);
    expect(purgedCount).toBe(1);

    // Old devotional: audio file gone, DB reference nulled, TEXT still present (Privacy §2: text kept until account deletion).
    expect(await audioStorage.exists(oldDevo.id)).toBe(false);
    const oldRow = await repos.devotionals.getById(userA, oldDevo.id);
    expect(oldRow?.audio_object).toBeNull();
    expect(oldRow?.devotional_body).toBe('A short devotional body about rest.');
    expect(oldRow?.theme).toBe('old with audio');

    // Recent devotional untouched.
    expect(await audioStorage.exists(recentDevo.id)).toBe(true);
    const recentRow = await repos.devotionals.getById(userA, recentDevo.id);
    expect(recentRow?.audio_object).toBe(`devotionals/${recentDevo.id}.mp3`);

    // Idempotent: running again purges nothing further.
    const secondRun = await purgeDevotionalAudio(repos.devotionals, audioStorage, NOW);
    expect(secondRun).toBe(0);
  });
});

describe('session purge (7 days after expiry)', () => {
  it('deletes sessions whose expiry is more than 7 days in the past; keeps recently-expired and active sessions', async () => {
    const userA = await makeUser('sess-a');
    const devo = await repos.devotionals.create(userA, minimalDevotional());

    const longExpired = await repos.sessions.create(userA, {
      devotionalId: devo.id,
      expiresAt: daysBefore(NOW, SESSION_RETENTION_DAYS_AFTER_EXPIRY + 3),
    });
    const recentlyExpired = await repos.sessions.create(userA, {
      devotionalId: devo.id,
      expiresAt: daysBefore(NOW, 2),
    });
    const active = await repos.sessions.create(userA, {
      devotionalId: devo.id,
      expiresAt: new Date(NOW.getTime() + 3600_000),
    });

    const deletedCount = await purgeExpiredSessionRows(repos.sessions, NOW);
    expect(deletedCount).toBe(1);

    expect(await repos.sessions.findByToken(longExpired.token)).toBeNull();
    expect(await repos.sessions.findByToken(recentlyExpired.token)).not.toBeNull();
    expect(await repos.sessions.findByToken(active.token)).not.toBeNull();
  });
});

describe('prayer_intentions purge (14 days)', () => {
  it('deletes only intentions older than 14 days, keeps newer ones', async () => {
    const userA = await makeUser('intent-a');
    const oldDevo = await repos.devotionals.create(userA, minimalDevotional({ theme: 'old' }));
    const recentDevo = await repos.devotionals.create(userA, minimalDevotional({ theme: 'recent' }));

    const old = await repos.prayerIntentions.record(userA, oldDevo.id, 'a long week at work');
    await backdatePrayerIntention(old!.id, daysBefore(NOW, PRAYER_INTENTIONS_RETENTION_DAYS + 1));

    const recent = await repos.prayerIntentions.record(userA, recentDevo.id, 'grateful for rest');
    await backdatePrayerIntention(recent!.id, daysBefore(NOW, 2));

    const deletedCount = await purgePrayerIntentions(repos.prayerIntentions, NOW);
    expect(deletedCount).toBe(1);

    const oldRow = await pool.query('SELECT * FROM prayer_intentions WHERE id = $1', [old!.id]);
    expect(oldRow.rows).toHaveLength(0);
    const recentRow = await pool.query('SELECT * FROM prayer_intentions WHERE id = $1', [recent!.id]);
    expect(recentRow.rows).toHaveLength(1);
  });

  it('is idempotent (ON CONFLICT DO NOTHING) — a second record() for the same user+devotional returns null and does not overwrite the first text', async () => {
    const userA = await makeUser('intent-idempotent');
    const devo = await repos.devotionals.create(userA, minimalDevotional());

    const first = await repos.prayerIntentions.record(userA, devo.id, 'first submission');
    expect(first?.text).toBe('first submission');

    const second = await repos.prayerIntentions.record(userA, devo.id, 'retried submission');
    expect(second).toBeNull();

    const stored = await repos.prayerIntentions.getForDate(userA, devo.date);
    expect(stored?.text).toBe('first submission');
  });
});

describe('runAllPurgeJobs — composes all four sweeps', () => {
  it('runs bands + audio + session + prayer-intention purges together and reports counts', async () => {
    const audioStorage = new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
    const userA = await makeUser('all-a');

    const oldBandDate = dateStringDaysBeforeToday(DAILY_BANDS_RETENTION_DAYS + 1);
    await repos.dailyBands.upsertForDate(userA, { date: oldBandDate, recovery: 'low' });

    const devo = await repos.devotionals.create(userA, minimalDevotional());
    await backdateDevotional(devo.id, daysBefore(NOW, DEVOTIONAL_AUDIO_RETENTION_DAYS + 1));
    await audioStorage.upload(devo.id, Buffer.from('bytes'));
    await repos.devotionals.setAudioObject(userA, devo.id, `devotionals/${devo.id}.mp3`);

    const oldSession = await repos.sessions.create(userA, {
      devotionalId: devo.id,
      expiresAt: daysBefore(NOW, SESSION_RETENTION_DAYS_AFTER_EXPIRY + 1),
    });

    const oldIntention = await repos.prayerIntentions.record(userA, devo.id, 'carrying something heavy');
    await backdatePrayerIntention(oldIntention!.id, daysBefore(NOW, PRAYER_INTENTIONS_RETENTION_DAYS + 1));

    const result = await runAllPurgeJobs(
      {
        dailyBands: repos.dailyBands,
        devotionals: repos.devotionals,
        sessions: repos.sessions,
        users: repos.users,
        audioStorage,
        prayerIntentions: repos.prayerIntentions,
        now: () => NOW,
      },
      async () => [userA],
    );

    expect(result.dailyBandsDeleted).toBe(1);
    expect(result.devotionalAudioPurged).toBe(1);
    expect(result.sessionsDeleted).toBe(1);
    expect(result.prayerIntentionsDeleted).toBe(1);

    expect(await repos.dailyBands.getForDate(userA, oldBandDate)).toBeNull();
    expect(await repos.sessions.findByToken(oldSession.token)).toBeNull();
    const devoRow = await repos.devotionals.getById(userA, devo.id);
    expect(devoRow?.audio_object).toBeNull();
    const intentionRow = await pool.query('SELECT * FROM prayer_intentions WHERE id = $1', [
      oldIntention!.id,
    ]);
    expect(intentionRow.rows).toHaveLength(0);
  });
});

describe('hardDeleteAccount', () => {
  it('deletes every row across every table for the user AND removes audio files from disk, leaving other users untouched', async () => {
    const audioStorage = new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
    const userA = await makeUser('hard-delete-a');
    const userB = await makeUser('hard-delete-b');

    await repos.preferences.ensureExists(userA);
    await repos.dailyBands.upsertForDate(userA, { date: '2026-07-01', recovery: 'high' });
    const devo = await repos.devotionals.create(userA, minimalDevotional());
    await audioStorage.upload(devo.id, Buffer.from('audio bytes for A'));
    await repos.devotionals.setAudioObject(userA, devo.id, `devotionals/${devo.id}.mp3`);
    await repos.sessions.create(userA, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await repos.connections.upsert(userA, {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('ct'),
      encryptionIv: Buffer.from('iv'),
      encryptionAuthTag: Buffer.from('tag'),
      kmsKeyVersion: 'v1',
      scopes: ['calendar.readonly'],
    });
    await repos.calendarEvents.create(userA, {
      devotionalId: devo.id,
      providerEventId: 'evt-1',
      gapSource: 'found_gap',
      gapStartAt: new Date(),
      gapEndAt: new Date(Date.now() + 1800_000),
    });

    // Untouched control data for user B.
    await repos.preferences.ensureExists(userB);
    const devoB = await repos.devotionals.create(userB, minimalDevotional());
    await audioStorage.upload(devoB.id, Buffer.from('audio bytes for B'));
    await repos.devotionals.setAudioObject(userB, devoB.id, `devotionals/${devoB.id}.mp3`);

    expect(await audioStorage.exists(devo.id)).toBe(true);

    await hardDeleteAccount(
      { devotionals: repos.devotionals, users: repos.users, audioStorage },
      userA,
    );

    // Every row for A is gone.
    expect(await repos.users.findById(userA)).toBeNull();
    expect(await repos.preferences.get(userA)).toBeNull();
    const bandsA = await pool.query('SELECT * FROM daily_bands WHERE user_id = $1', [userA]);
    expect(bandsA.rows).toHaveLength(0);
    const devosA = await pool.query('SELECT * FROM devotionals WHERE user_id = $1', [userA]);
    expect(devosA.rows).toHaveLength(0);
    const sessionsA = await pool.query('SELECT * FROM sessions WHERE user_id = $1', [userA]);
    expect(sessionsA.rows).toHaveLength(0);
    const connectionsA = await pool.query('SELECT * FROM connections WHERE user_id = $1', [userA]);
    expect(connectionsA.rows).toHaveLength(0);
    const calA = await pool.query('SELECT * FROM calendar_events WHERE user_id = $1', [userA]);
    expect(calA.rows).toHaveLength(0);

    // Audio file physically removed from disk.
    expect(await audioStorage.exists(devo.id)).toBe(false);
    await expect(readFile(path.join(audioRootDir, `devotionals/${devo.id}.mp3`))).rejects.toThrow();

    // User B completely untouched.
    expect(await repos.users.findById(userB)).not.toBeNull();
    expect(await repos.devotionals.getById(userB, devoB.id)).not.toBeNull();
    expect(await audioStorage.exists(devoB.id)).toBe(true);
  });

  it('revokes the Google token with Google before deleting, when an oauth dep and an active connection are present (issue #81)', async () => {
    const audioStorage = new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
    const userA = await makeUser('hard-delete-oauth');
    await repos.connections.upsert(userA, {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('ciphertext'),
      encryptionIv: Buffer.from('iv'),
      encryptionAuthTag: Buffer.from('tag'),
      kmsKeyVersion: 'v1',
      scopes: ['calendar.readonly'],
    });

    const kmsService = {
      decryptToken: vi.fn().mockResolvedValue('plaintext-refresh-token'),
    } as unknown as GoogleKmsService;
    const oauthService = {
      revokeToken: vi.fn().mockResolvedValue(undefined),
    } as unknown as GoogleOAuthService;

    await hardDeleteAccount(
      {
        devotionals: repos.devotionals,
        users: repos.users,
        audioStorage,
        oauth: { connections: repos.connections, kmsService, oauthService },
      },
      userA,
    );

    expect(kmsService.decryptToken).toHaveBeenCalledWith(Buffer.from('ciphertext'));
    expect(oauthService.revokeToken).toHaveBeenCalledWith('plaintext-refresh-token');
    expect(await repos.users.findById(userA)).toBeNull();
  });

  it('still deletes the account even when the Google revoke call throws', async () => {
    const audioStorage = new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
    const userA = await makeUser('hard-delete-oauth-fail');
    await repos.connections.upsert(userA, {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('ciphertext'),
      encryptionIv: Buffer.from('iv'),
      encryptionAuthTag: Buffer.from('tag'),
      kmsKeyVersion: 'v1',
      scopes: ['calendar.readonly'],
    });

    const kmsService = {
      decryptToken: vi.fn().mockResolvedValue('plaintext-refresh-token'),
    } as unknown as GoogleKmsService;
    const oauthService = {
      revokeToken: vi.fn().mockRejectedValue(new Error('Google is down')),
    } as unknown as GoogleOAuthService;

    await hardDeleteAccount(
      {
        devotionals: repos.devotionals,
        users: repos.users,
        audioStorage,
        oauth: { connections: repos.connections, kmsService, oauthService },
      },
      userA,
    );

    expect(await repos.users.findById(userA)).toBeNull();
  });

  it('skips the revoke call entirely when no oauth dep is supplied (existing retention-only callers)', async () => {
    const audioStorage = new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
    const userA = await makeUser('hard-delete-no-oauth-dep');
    await repos.connections.upsert(userA, {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('ciphertext'),
      encryptionIv: Buffer.from('iv'),
      encryptionAuthTag: Buffer.from('tag'),
      kmsKeyVersion: 'v1',
      scopes: ['calendar.readonly'],
    });

    await hardDeleteAccount({ devotionals: repos.devotionals, users: repos.users, audioStorage }, userA);

    expect(await repos.users.findById(userA)).toBeNull();
  });
});
