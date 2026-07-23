/**
 * P4 (#323) × P1 (#320): the concrete `FeedbackSignalSource` over the
 * `session_feedback` table.
 *
 * ⚠️ REQUIRES #320's migration. This suite inserts into
 * `session_feedback`, which is created by P1's PR (merged ahead of this
 * one — see the PR body's merge-order note). On a database migrated
 * before that lands, `beforeAll` fails fast on the existence probe with
 * a clear message rather than each test failing obscurely.
 *
 * Kept separate from attendanceSignals.integration.test.ts precisely so
 * that suite stays runnable against the pre-#320 schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
  type VerifiedUserId,
} from '../../src/db/repositories/index.js';
import { SessionFeedbackSignalSource } from '../../src/services/rhythm/sessionFeedbackSignalSource.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);
const source = new SessionFeedbackSignalSource(pool);

beforeAll(async () => {
  // Fail fast and legibly if #320's migration hasn't been applied here.
  await pool.query('SELECT 1 FROM session_feedback LIMIT 1');
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE session_feedback, calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
});

async function makeUser(emailLocalPart: string): Promise<VerifiedUserId> {
  const row = await repos.users.createUser({
    firebaseUid: `firebase-${emailLocalPart}`,
    email: `${emailLocalPart}@example.com`,
  });
  return asVerifiedUserId(row.id);
}

async function makeDevotional(userId: VerifiedUserId, date: string): Promise<string> {
  const devo = await repos.devotionals.create(userId, {
    date,
    format: 'short',
    theme: 'rest',
    verses: [
      {
        usfm: 'MAT.11.28',
        versionId: 3034,
        fetchedText: 'Come to me, all you who are weary...',
        attribution: 'Berean Standard Bible',
      },
    ],
    devotionalBody: 'A short devotional body about rest.',
    cardSummary: 'Rest for the weary.',
    prayer: 'Lord, grant me rest.',
  });
  return devo.id;
}

/**
 * Inserts through the durable key #320 settled on (`user_id` +
 * `devotional_id`; `session_id` nullable so feedback outlives the
 * sessions purge) — only the columns this source reads plus one answer,
 * since presence is the entire signal here.
 */
async function giveFeedback(userId: VerifiedUserId, devotionalId: string): Promise<void> {
  await pool.query(
    `INSERT INTO session_feedback (user_id, devotional_id, content_helpful) VALUES ($1, $2, true)`,
    [userId, devotionalId],
  );
}

describe('SessionFeedbackSignalSource', () => {
  it('returns exactly the devotionals this user gave feedback on', async () => {
    const userId = await makeUser('fb');
    const withFeedback = await makeDevotional(userId, '2026-07-20');
    const without = await makeDevotional(userId, '2026-07-21');
    await giveFeedback(userId, withFeedback);

    const ids = await source.devotionalIdsWithFeedback(userId, [withFeedback, without]);
    expect(ids).toEqual(new Set([withFeedback]));
  });

  it('never returns another user’s feedback (Foundation §10 scoping)', async () => {
    const userA = await makeUser('fb-a');
    const userB = await makeUser('fb-b');
    const devoB = await makeDevotional(userB, '2026-07-20');
    await giveFeedback(userB, devoB);

    // Even when handed the exact devotional id, user A's scope is empty.
    const ids = await source.devotionalIdsWithFeedback(userA, [devoB]);
    expect(ids.size).toBe(0);
  });

  it('answers an empty id list without touching the database', async () => {
    const userId = await makeUser('fb-empty');
    const ids = await source.devotionalIdsWithFeedback(userId, []);
    expect(ids.size).toBe(0);
  });
});
