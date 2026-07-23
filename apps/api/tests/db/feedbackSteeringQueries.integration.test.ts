/**
 * P7 (#326): the three storage seams the feedback-steering loader stands
 * on, against a REAL Postgres (kairos-test-pg / CI service container):
 *
 *  - `SessionFeedbackRepository.listRecentForSteering` — trailing window,
 *    newest first, theme joined, user-scoped;
 *  - `DevotionalsRepository.listRecentThemes` — standard slot only,
 *    newest first;
 *  - `PreferencesRepository.updatePreferredTimeLocal` — the server-owned
 *    write path for migration 1722600000000's column, unreachable from
 *    the client `update`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
  type VerifiedUserId,
} from '../../src/db/repositories/index.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

const NOW = new Date('2026-07-23T12:00:00Z');
const MS_PER_DAY = 86_400_000;

async function makeUser(localPart: string): Promise<VerifiedUserId> {
  const row = await repos.users.createUser({
    firebaseUid: `firebase-${localPart}`,
    email: `${localPart}@example.com`,
  });
  return asVerifiedUserId(row.id);
}

async function makeDevotional(
  userId: VerifiedUserId,
  date: string,
  theme: string,
  slotType: 'standard' | 'examen' = 'standard',
): Promise<string> {
  const devo = await repos.devotionals.create(userId, {
    date,
    format: 'short',
    theme,
    verses: [
      {
        usfm: 'MAT.11.28',
        versionId: 3034,
        fetchedText: 'Come to me, all you who are weary.',
        attribution: 'Berean Standard Bible',
      },
    ],
    devotionalBody: 'Body.',
    cardSummary: 'Summary.',
    prayer: 'Prayer.',
    isFixtureFallback: false,
    status: 'ready',
    slotType,
  });
  return devo.id;
}

async function seedFeedback(
  userId: VerifiedUserId,
  devotionalId: string,
  createdAt: Date,
  answers: { topicMore?: boolean; lengthFeel?: 'shorter' | 'right' | 'longer' } = {},
): Promise<void> {
  // `session_feedback.session_token` is a real FK onto `sessions`, so the
  // seed goes through the same shape production does: session first.
  const session = await repos.sessions.create(userId, {
    devotionalId,
    expiresAt: new Date(NOW.getTime() + MS_PER_DAY),
  });
  await repos.sessionFeedback.upsert(userId, {
    sessionToken: session.token,
    devotionalId,
    topicMore: answers.topicMore ?? null,
    lengthFeel: answers.lengthFeel ?? null,
  });
  // created_at defaults to now(); pin it so the trailing-window predicate
  // is actually exercised rather than everything being "just now".
  await pool.query(`UPDATE session_feedback SET created_at = $2 WHERE session_token = $1`, [
    session.token,
    createdAt,
  ]);
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE session_feedback, candidate_slots, calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe('SessionFeedbackRepository.listRecentForSteering', () => {
  it('returns the trailing window newest-first with the devotional theme joined, and scopes by user', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const recent = await makeDevotional(alice, '2026-07-22', 'Hope in waiting');
    const old = await makeDevotional(alice, '2026-06-01', 'Old theme');
    const bobsDevo = await makeDevotional(bob, '2026-07-22', 'Bob theme');

    await seedFeedback(alice, recent, new Date(NOW.getTime() - 1 * MS_PER_DAY), {
      topicMore: true,
    });
    await seedFeedback(alice, old, new Date(NOW.getTime() - 40 * MS_PER_DAY), {
      topicMore: true,
    });
    await seedFeedback(bob, bobsDevo, new Date(NOW.getTime() - 1 * MS_PER_DAY), {
      topicMore: true,
    });

    const since = new Date(NOW.getTime() - 14 * MS_PER_DAY);
    const rows = await repos.sessionFeedback.listRecentForSteering(alice, since);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.topic_more).toBe(true);
    expect(rows[0]!.devotional_theme).toBe('Hope in waiting');
  });

  it('keeps a feedback row whose devotional is gone (theme null), newest first', async () => {
    const alice = await makeUser('alice');
    const d1 = await makeDevotional(alice, '2026-07-21', 'Kept');
    const d2 = await makeDevotional(alice, '2026-07-22', 'Purged');
    await seedFeedback(alice, d1, new Date(NOW.getTime() - 2 * MS_PER_DAY), {
      lengthFeel: 'shorter',
    });
    await seedFeedback(alice, d2, new Date(NOW.getTime() - 1 * MS_PER_DAY), {
      lengthFeel: 'shorter',
    });
    // The FK is ON DELETE SET NULL (#320): purge the devotional, the
    // feedback signal outlives it.
    await pool.query(`DELETE FROM devotionals WHERE id = $1`, [d2]);

    const rows = await repos.sessionFeedback.listRecentForSteering(
      alice,
      new Date(NOW.getTime() - 14 * MS_PER_DAY),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.devotional_theme).toBeNull();
    expect(rows[0]!.length_feel).toBe('shorter');
    expect(rows[1]!.devotional_theme).toBe('Kept');
  });
});

describe('DevotionalsRepository.listRecentThemes', () => {
  it('returns standard-slot themes newest first, capped, exam slots excluded', async () => {
    const alice = await makeUser('alice');
    await makeDevotional(alice, '2026-07-20', 'A');
    await makeDevotional(alice, '2026-07-21', 'B');
    await makeDevotional(alice, '2026-07-22', 'C');
    await makeDevotional(alice, '2026-07-22', 'Evening examen', 'examen');

    expect(await repos.devotionals.listRecentThemes(alice, 2)).toEqual(['C', 'B']);
    expect(await repos.devotionals.listRecentThemes(alice, 10)).toEqual(['C', 'B', 'A']);
  });
});

describe('PreferencesRepository.updatePreferredTimeLocal', () => {
  it('writes the server-owned column; the client update path cannot name it', async () => {
    const alice = await makeUser('alice');
    await repos.preferences.ensureExists(alice);

    await repos.preferences.updatePreferredTimeLocal(alice, '12:30:00');
    let row = await repos.preferences.get(alice);
    expect(row?.preferred_time_local).toBe('12:30:00');

    // A client-path update touching other fields leaves it alone.
    await repos.preferences.update(alice, { voice: 'calm' });
    row = await repos.preferences.get(alice);
    expect(row?.preferred_time_local).toBe('12:30:00');
    expect(row?.voice).toBe('calm');
  });

  it('defaults NULL — deploy day biases nobody', async () => {
    const alice = await makeUser('alice');
    const row = await repos.preferences.ensureExists(alice);
    expect(row.preferred_time_local).toBeNull();
  });
});
