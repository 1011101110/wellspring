/**
 * Journal repository (N9, #268) against a real migrated Postgres.
 *
 * The two things that must be true of a kept, user-owned content table are
 * both properties of the database, so they are checked there, not asserted
 * about the code: (1) a user only ever sees and deletes their OWN entries
 * (Foundation §10), and (2) account deletion takes the entries with it via
 * the FK cascade (Privacy §account-deletion).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { asVerifiedUserId, createRepositories, type Repositories } from '../../src/db/repositories/index.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

beforeAll(async () => {
  await pool.query('SELECT 1 FROM journal_entries LIMIT 1');
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE calendar_events, sessions, devotionals, daily_bands, preferences, connections, journal_entries, users RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
});

async function makeUser(local: string) {
  const row = await repos.users.createUser({
    firebaseUid: `firebase-${local}`,
    email: `${local}@example.com`,
  });
  return asVerifiedUserId(row.id);
}

describe('JournalRepository (#268)', () => {
  it('keeps what the user writes and returns it newest-first', async () => {
    const user = await makeUser('writer');
    await repos.journal.create(user, 'carrying my mother’s health');
    await repos.journal.create(user, 'a hard conversation tomorrow');

    const { entries, hasMore } = await repos.journal.list(user, 20);
    expect(entries.map((e) => e.text)).toEqual([
      'a hard conversation tomorrow',
      'carrying my mother’s health',
    ]);
    expect(hasMore).toBe(false);
  });

  it('paginates with a created_at cursor and reports hasMore honestly', async () => {
    const user = await makeUser('prolific');
    for (let i = 0; i < 5; i += 1) {
      await repos.journal.create(user, `entry ${i}`);
      // Nudge created_at apart so ordering is deterministic. (Same DB, so
      // a tiny explicit offset rather than relying on clock resolution.)
      await pool.query(
        `UPDATE journal_entries SET created_at = now() + ($1 || ' seconds')::interval
         WHERE text = $2`,
        [i, `entry ${i}`],
      );
    }

    const firstPage = await repos.journal.list(user, 2);
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await repos.journal.list(user, 2, firstPage.entries[1]!.created_at);
    expect(secondPage.entries).toHaveLength(2);
    // No overlap between pages.
    const firstIds = new Set(firstPage.entries.map((e) => e.id));
    expect(secondPage.entries.every((e) => !firstIds.has(e.id))).toBe(true);
  });

  it('never returns, or lets a user delete, another user’s entry', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const aliceEntry = await repos.journal.create(alice, 'alice’s private words');
    await repos.journal.create(bob, 'bob’s words');

    // Bob's list is only Bob's.
    const bobList = await repos.journal.list(bob, 20);
    expect(bobList.entries.map((e) => e.text)).toEqual(['bob’s words']);

    // Bob cannot delete Alice's entry even with its exact id.
    const deleted = await repos.journal.deleteOne(bob, aliceEntry.id);
    expect(deleted).toBe(false);
    const aliceList = await repos.journal.list(alice, 20);
    expect(aliceList.entries).toHaveLength(1);
  });

  it('deletes one of the user’s own entries and reports it', async () => {
    const user = await makeUser('deleter');
    const keep = await repos.journal.create(user, 'keep this');
    const drop = await repos.journal.create(user, 'drop this');

    expect(await repos.journal.deleteOne(user, drop.id)).toBe(true);
    // Deleting again is a no-op that reports false, not an error.
    expect(await repos.journal.deleteOne(user, drop.id)).toBe(false);

    const remaining = await repos.journal.list(user, 20);
    expect(remaining.entries.map((e) => e.id)).toEqual([keep.id]);
  });

  it('is taken with the user on account deletion (FK cascade)', async () => {
    // The whole reason the entries can be "kept": there is still exactly
    // one path that removes them wholesale, and it is account deletion.
    const user = await makeUser('leaving');
    await repos.journal.create(user, 'something to be forgotten with me');

    await repos.users.hardDelete(user);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM journal_entries');
    expect(rows[0].n).toBe(0);
  });
});
