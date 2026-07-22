/**
 * `active_days` defaults to all seven days — and does so WITHOUT touching
 * anyone's stored choice (N3, issue #262, migration 1722100000000).
 *
 * Runs against the real migrated Postgres rather than asserting anything
 * about the migration file, because the two facts that matter here are
 * both properties of the database and not of the TypeScript:
 *
 *   1. what a brand-new row actually gets, and
 *   2. that an existing row is untouched.
 *
 * A test that read the migration source would agree with the migration
 * source. The whole point of #202's lesson — and of the second assertion
 * below — is that a default change is one `UPDATE` away from silently
 * rewriting real users' schedules, and the only witness that it didn't is
 * a row that existed before the migration ran and still says what it said.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { asVerifiedUserId, createRepositories, type Repositories } from '../../src/db/repositories/index.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

const ALL_SEVEN = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS_ONLY = [1, 2, 3, 4, 5];

beforeAll(async () => {
  await pool.query('SELECT 1 FROM preferences LIMIT 1');
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
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

describe('active_days default (#262)', () => {
  it('gives a brand-new user all seven days, Sunday included', async () => {
    const user = await makeUser('newcomer');
    // `ensureExists` names only `user_id`, so this exercises the column
    // default itself — the one path where it is ever consulted.
    const row = await repos.preferences.ensureExists(user);
    expect([...row.active_days].sort((a, b) => a - b)).toEqual(ALL_SEVEN);
  });

  /**
   * Re-runs THIS migration over already-seeded rows.
   *
   * The first version of these tests seeded a user and asserted their days
   * survived — and a mutation check that added the destructive
   * `UPDATE preferences SET active_days = ...` to the migration **passed
   * anyway**. The reason is the whole point: CI runs `migrate up` before
   * `npm test`, against an empty database. A backfill in the migration
   * touches zero rows, and every row the test then creates is created
   * afterwards. The test could not have failed no matter what the
   * migration did.
   *
   * That is exactly the shape this epic keeps finding (#253): an
   * assertion that looks like it guards something and structurally
   * cannot. So the migration is now actually replayed — `down` then
   * `up` — with the user's row already in the table, which is the only
   * arrangement in which "does this migration preserve existing data?"
   * is a question the database can answer.
   *
   * It shells out to the SAME `npm run migrate` command CI and production
   * use, rather than calling node-pg-migrate's programmatic API. That is
   * deliberate: the programmatic entry point's option shape and default
   * export are version-sensitive (an earlier draft here died on `default
   * is not a function`), and the entire value of this test is being
   * faithful to the migration path that actually runs. The CLI is that
   * path. `down 1` reverts only this migration — an `alterColumn` default
   * change that does not touch rows — then `up` re-applies it.
   */
  const API_DIR = fileURLToPath(new URL('../../', import.meta.url));
  function migrate(...args: string[]): void {
    execFileSync('npm', ['run', 'migrate', '--', ...args], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL },
      stdio: 'pipe',
    });
  }
  function replayMigration(): void {
    migrate('down', '1');
    migrate('up');
  }

  it('leaves an existing Mon–Fri user exactly as they were, across a real replay', async () => {
    // The user this migration must not disturb: someone holding weekdays
    // because that WAS the default. They did not ask for Sunday
    // devotionals, and starting to generate them would be a behaviour
    // change nobody consented to (#202). #188's cadence control is how a
    // user changes this, deliberately.
    const user = await makeUser('established');
    await repos.preferences.ensureExists(user);
    await pool.query(`UPDATE preferences SET active_days = $2 WHERE user_id = $1`, [
      user,
      WEEKDAYS_ONLY,
    ]);

    // Replay the migration WITH the row present — the arrangement CI's
    // empty-database ordering can never produce on its own.
    replayMigration();

    const afterMigration = await repos.preferences.get(user);
    expect(
      [...afterMigration!.active_days].sort((a, b) => a - b),
      'the migration must not rewrite a user’s chosen days',
    ).toEqual(WEEKDAYS_ONLY);

    // And `ensureExists` is the other realistic disturbance: it fires on
    // every signup path and its ON CONFLICT branch must not reset days.
    const after = await repos.preferences.ensureExists(user);
    expect([...after.active_days].sort((a, b) => a - b)).toEqual(WEEKDAYS_ONLY);

    const reread = await repos.preferences.get(user);
    expect([...reread!.active_days].sort((a, b) => a - b)).toEqual(WEEKDAYS_ONLY);
  });

  it('does not disturb a deliberately unusual schedule either', async () => {
    // Sunday-only is the case that would be most insulting to overwrite,
    // and it is also the one a naive "backfill everyone to all seven"
    // migration would destroy while looking correct on a default row.
    const user = await makeUser('sabbath-only');
    await repos.preferences.ensureExists(user);
    await pool.query(`UPDATE preferences SET active_days = $2 WHERE user_id = $1`, [user, [0]]);

    replayMigration();

    const after = await repos.preferences.get(user);
    expect([...after!.active_days]).toEqual([0]);
  });
});
