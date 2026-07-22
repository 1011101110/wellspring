import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { asVerifiedUserId, createRepositories, type Repositories } from '../../src/db/repositories/index.js';

/**
 * Integration tests against a real local Postgres (started per the task
 * runbook: `docker run ... -p 5433:5432 postgres:16`, migrations applied
 * via `npm run migrate --workspace=apps/api -- up`). These assert both
 * ordinary CRUD behavior AND — the point of this repository layer per
 * Foundation §10 — that a query scoped to user B never returns user A's
 * rows, for every table in the schema.
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

beforeAll(async () => {
  // Sanity check: fail fast with a clear message if the test DB isn't reachable/migrated.
  await pool.query('SELECT 1 FROM users LIMIT 1');
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
});

async function makeUser(emailLocalPart: string) {
  const row = await repos.users.createUser({
    firebaseUid: `firebase-${emailLocalPart}`,
    email: `${emailLocalPart}@example.com`,
  });
  return asVerifiedUserId(row.id);
}

describe('UsersRepository', () => {
  it('creates and finds a user by firebase_uid and by id', async () => {
    const created = await repos.users.createUser({
      firebaseUid: 'fb-1',
      email: 'a@example.com',
      tradition: 'catholic',
    });
    expect(created.tradition).toBe('catholic');
    expect(created.translation_id).toBe(3034); // BSB default — Foundation §4.3

    const byUid = await repos.users.findByFirebaseUid('fb-1');
    expect(byUid?.id).toBe(created.id);

    const byId = await repos.users.findById(asVerifiedUserId(created.id));
    expect(byId?.email).toBe('a@example.com');
  });

  it('hard delete cascades to every child table (account deletion)', async () => {
    const userA = await makeUser('cascade-a');
    await repos.preferences.ensureExists(userA);
    await repos.dailyBands.upsertForDate(userA, { date: '2026-07-01', recovery: 'high' });
    const devo = await repos.devotionals.create(userA, minimalDevotional('2026-07-01'));
    await repos.sessions.create(userA, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    await repos.users.hardDelete(userA);

    expect(await repos.users.findById(userA)).toBeNull();
    expect(await repos.preferences.get(userA)).toBeNull();
    const bandsResult = await pool.query('SELECT * FROM daily_bands WHERE user_id = $1', [
      userA,
    ]);
    expect(bandsResult.rows).toHaveLength(0);
    const devoResult = await pool.query('SELECT * FROM devotionals WHERE user_id = $1', [userA]);
    expect(devoResult.rows).toHaveLength(0);
  });

  /**
   * K1 (#187). `adoptTimezone` puts the source-precedence comparison in
   * the UPDATE's own WHERE clause so it is atomic — which also means the
   * rule cannot be verified without a real Postgres. The behavioral
   * contract these assert against is the same one
   * `tests/services/calendar/refreshCalendarTimezone.test.ts` pins in
   * pure form; this suite is what proves the SQL agrees with it.
   */
  describe('UsersRepository.adoptTimezone — source precedence', () => {
    it('adopts a zone over the untouched UTC default and records its source', async () => {
      const user = await makeUser('tz-default');
      expect((await repos.users.findById(user))?.timezone).toBe('UTC');

      const updated = await repos.users.adoptTimezone(user, 'America/New_York', 'device');

      expect(updated?.timezone).toBe('America/New_York');
      expect(updated?.timezone_source).toBe('device');
    });

    it('lets the calendar zone replace a device-set one', async () => {
      const user = await makeUser('tz-upgrade');
      await repos.users.adoptTimezone(user, 'America/New_York', 'device');

      const updated = await repos.users.adoptTimezone(user, 'Europe/Berlin', 'calendar');

      expect(updated?.timezone).toBe('Europe/Berlin');
      expect(updated?.timezone_source).toBe('calendar');
    });

    it('refuses to let the device zone overwrite a calendar-derived one', async () => {
      // A device zone flips the moment the user steps off a plane; their
      // 7am devotional should not follow it.
      const user = await makeUser('tz-downgrade');
      await repos.users.adoptTimezone(user, 'Europe/Berlin', 'calendar');

      const updated = await repos.users.adoptTimezone(user, 'Asia/Tokyo', 'device');

      expect(updated).toBeNull();
      expect((await repos.users.findById(user))?.timezone).toBe('Europe/Berlin');
    });

    it('never lets an automatic source overwrite an explicit user choice', async () => {
      // #187: silently clobbering a deliberate setting is worse than the
      // honest-but-wrong UTC this whole story replaces.
      const user = await makeUser('tz-explicit');
      await repos.users.adoptTimezone(user, 'Pacific/Auckland', 'user');

      expect(await repos.users.adoptTimezone(user, 'Europe/Berlin', 'calendar')).toBeNull();
      expect(await repos.users.adoptTimezone(user, 'Asia/Tokyo', 'device')).toBeNull();

      const row = await repos.users.findById(user);
      expect(row?.timezone).toBe('Pacific/Auckland');
      expect(row?.timezone_source).toBe('user');
    });

    it('lets a source move its own value, so a relocation still lands', async () => {
      const user = await makeUser('tz-relocate');
      await repos.users.adoptTimezone(user, 'America/New_York', 'calendar');

      const updated = await repos.users.adoptTimezone(user, 'America/Los_Angeles', 'calendar');

      expect(updated?.timezone).toBe('America/Los_Angeles');
    });

    it('no-ops (returns null) when the stored value and source already match', async () => {
      // Keeps a daily run over an unchanged fleet from bumping
      // `updated_at` on every row, every day.
      const user = await makeUser('tz-noop');
      await repos.users.adoptTimezone(user, 'America/New_York', 'calendar');

      expect(await repos.users.adoptTimezone(user, 'America/New_York', 'calendar')).toBeNull();
    });

    it('listAwaitingCalendarTimezone returns only untouched users with an active calendar', async () => {
      const untouched = await makeUser('tz-await-untouched');
      const alreadySet = await makeUser('tz-await-set');
      const noCalendar = await makeUser('tz-await-nocal');

      for (const userId of [untouched, alreadySet]) {
        await repos.connections.upsert(userId, {
          provider: 'google_calendar',
          encryptedRefreshToken: Buffer.from('ciphertext'),
          encryptionIv: Buffer.alloc(12),
          encryptionAuthTag: Buffer.alloc(16),
          kmsKeyVersion: 'v1',
          scopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
        });
      }
      await repos.users.adoptTimezone(alreadySet, 'Europe/Berlin', 'calendar');

      const awaiting = await repos.users.listAwaitingCalendarTimezone();

      expect(awaiting).toContain(untouched);
      expect(awaiting).not.toContain(alreadySet);
      // No calendar = no server-side zone signal at all; covered by the
      // device zone on their next preferences sync instead.
      expect(awaiting).not.toContain(noCalendar);
    });
  });
});

function minimalDevotional(date: string) {
  return {
    date,
    format: 'short' as const,
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
  };
}

describe('PreferencesRepository — user scoping', () => {
  it('user B never sees or mutates user A preferences', async () => {
    const userA = await makeUser('prefs-a');
    const userB = await makeUser('prefs-b');

    await repos.preferences.ensureExists(userA);
    await repos.preferences.ensureExists(userB);
    await repos.preferences.update(userA, { voice: 'voice-a', cadence: 'daily' });
    await repos.preferences.update(userB, { voice: 'voice-b', cadence: 'weekdays' });

    const prefsA = await repos.preferences.get(userA);
    const prefsB = await repos.preferences.get(userB);
    expect(prefsA?.voice).toBe('voice-a');
    expect(prefsB?.voice).toBe('voice-b');
    expect(prefsA?.user_id).not.toBe(prefsB?.user_id);
  });
});

describe('DailyBandsRepository — user scoping', () => {
  it('listRecent for user B never returns user A rows even for the same date', async () => {
    const userA = await makeUser('bands-a');
    const userB = await makeUser('bands-b');

    await repos.dailyBands.upsertForDate(userA, {
      date: '2026-07-01',
      recovery: 'low',
      sleepQuality: 'poor',
      busyness: 'heavy',
    });
    await repos.dailyBands.upsertForDate(userB, {
      date: '2026-07-01',
      recovery: 'high',
      sleepQuality: 'good',
      busyness: 'light',
    });

    const bandsA = await repos.dailyBands.listRecent(userA);
    const bandsB = await repos.dailyBands.listRecent(userB);

    expect(bandsA).toHaveLength(1);
    expect(bandsB).toHaveLength(1);
    expect(bandsA[0]?.user_id).toBe(userA);
    expect(bandsA[0]?.recovery).toBe('low');
    expect(bandsB[0]?.user_id).toBe(userB);
    expect(bandsB[0]?.recovery).toBe('high');

    // Cross-user getForDate must return null, not the other user's row.
    const crossRead = await repos.dailyBands.getForDate(userB, '2026-07-01');
    expect(crossRead?.user_id).toBe(userB);
    expect(crossRead?.recovery).toBe('high');
  });

  it('listForUserInRange only returns rows within the inclusive date range for the calling user (issue #96)', async () => {
    const userA = await makeUser('bands-range-a');
    const userB = await makeUser('bands-range-b');

    await repos.dailyBands.upsertForDate(userA, { date: '2026-06-30', recovery: 'high' });
    await repos.dailyBands.upsertForDate(userA, { date: '2026-07-01', recovery: 'low' });
    await repos.dailyBands.upsertForDate(userA, { date: '2026-07-15', recovery: 'moderate' });
    await repos.dailyBands.upsertForDate(userA, { date: '2026-08-01', recovery: 'high' });
    await repos.dailyBands.upsertForDate(userB, { date: '2026-07-15', recovery: 'low' });

    const rangeA = await repos.dailyBands.listForUserInRange(userA, '2026-07-01', '2026-07-31');
    expect(rangeA.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-15']);
    expect(rangeA.every((r) => r.user_id === userA)).toBe(true);
  });
});

describe('DevotionalsRepository — user scoping', () => {
  it('getById returns null for a devotional owned by a different user (IDOR check)', async () => {
    const userA = await makeUser('devo-a');
    const userB = await makeUser('devo-b');

    const devoA = await repos.devotionals.create(userA, minimalDevotional('2026-07-01'));

    // The critical assertion: user B's repository call, scoped to user B,
    // must never return user A's devotional even when given A's exact id.
    const crossRead = await repos.devotionals.getById(userB, devoA.id);
    expect(crossRead).toBeNull();

    const ownRead = await repos.devotionals.getById(userA, devoA.id);
    expect(ownRead?.id).toBe(devoA.id);
  });

  it('listForUser only returns the calling user rows', async () => {
    const userA = await makeUser('devo-list-a');
    const userB = await makeUser('devo-list-b');

    await repos.devotionals.create(userA, minimalDevotional('2026-07-01'));
    await repos.devotionals.create(userA, minimalDevotional('2026-07-02'));
    await repos.devotionals.create(userB, minimalDevotional('2026-07-01'));

    const listA = await repos.devotionals.listForUser(userA);
    const listB = await repos.devotionals.listForUser(userB);

    expect(listA).toHaveLength(2);
    expect(listB).toHaveLength(1);
    expect(listA.every((d) => d.user_id === userA)).toBe(true);
  });

  it('listForUserInRange only returns rows within the inclusive date range for the calling user (issue #96)', async () => {
    const userA = await makeUser('devo-range-a');
    const userB = await makeUser('devo-range-b');

    await repos.devotionals.create(userA, minimalDevotional('2026-06-30'));
    await repos.devotionals.create(userA, minimalDevotional('2026-07-01'));
    await repos.devotionals.create(userA, minimalDevotional('2026-07-15'));
    await repos.devotionals.create(userA, minimalDevotional('2026-08-01'));
    await repos.devotionals.create(userB, minimalDevotional('2026-07-15'));

    const rangeA = await repos.devotionals.listForUserInRange(userA, '2026-07-01', '2026-07-31');
    expect(rangeA.map((d) => d.date)).toEqual(['2026-07-01', '2026-07-15']);
    expect(rangeA.every((d) => d.user_id === userA)).toBe(true);
  });

  it('updateStatus scoped to the wrong user is a no-op', async () => {
    const userA = await makeUser('devo-status-a');
    const userB = await makeUser('devo-status-b');
    const devoA = await repos.devotionals.create(userA, minimalDevotional('2026-07-01'));

    const result = await repos.devotionals.updateStatus(userB, devoA.id, 'ready');
    expect(result).toBeNull();

    const stillPending = await repos.devotionals.getById(userA, devoA.id);
    expect(stillPending?.status).toBe('pending');
  });
});

describe('SessionsRepository — join flow + scoping', () => {
  it('findByToken is unscoped (capability URL) but write methods are user-scoped', async () => {
    const userA = await makeUser('sess-a');
    const userB = await makeUser('sess-b');
    const devoA = await repos.devotionals.create(userA, minimalDevotional('2026-07-01'));

    const session = await repos.sessions.create(userA, {
      devotionalId: devoA.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    // Public join flow: anyone with the token can look it up (by design).
    const found = await repos.sessions.findByToken(session.token);
    expect(found?.user_id).toBe(userA);

    // But user B cannot mark user A's session as joined/completed.
    const joinedByB = await repos.sessions.markJoined(userB, session.token);
    expect(joinedByB).toBeNull();

    const joinedByA = await repos.sessions.markJoined(userA, session.token);
    expect(joinedByA?.joined_at).not.toBeNull();
  });

  it('listForUser never includes another user sessions', async () => {
    const userA = await makeUser('sess-list-a');
    const userB = await makeUser('sess-list-b');
    const devoA = await repos.devotionals.create(userA, minimalDevotional('2026-07-01'));
    const devoB = await repos.devotionals.create(userB, minimalDevotional('2026-07-01'));

    await repos.sessions.create(userA, {
      devotionalId: devoA.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await repos.sessions.create(userB, {
      devotionalId: devoB.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const listA = await repos.sessions.listForUser(userA);
    expect(listA).toHaveLength(1);
    expect(listA[0]?.user_id).toBe(userA);
  });

  it('countJoinedInRange only counts this user\'s joined sessions within the half-open interval (issue #96)', async () => {
    const userA = await makeUser('sess-count-a');
    const userB = await makeUser('sess-count-b');
    const devoA = await repos.devotionals.create(userA, minimalDevotional('2026-07-01'));
    const devoB = await repos.devotionals.create(userB, minimalDevotional('2026-07-01'));

    const inRange = await repos.sessions.create(userA, {
      devotionalId: devoA.id,
      expiresAt: new Date('2026-07-05T00:00:00.000Z'),
    });
    await pool.query('UPDATE sessions SET joined_at = $2 WHERE token = $1', [
      inRange.token,
      new Date('2026-07-01T12:00:00.000Z'),
    ]);

    // Same user, but never joined — must not be counted.
    await repos.sessions.create(userA, {
      devotionalId: devoA.id,
      expiresAt: new Date('2026-07-05T00:00:00.000Z'),
    });

    // Same user, joined but on the exclusive boundary (start of next month) — must not be counted.
    const outOfRange = await repos.sessions.create(userA, {
      devotionalId: devoA.id,
      expiresAt: new Date('2026-08-05T00:00:00.000Z'),
    });
    await pool.query('UPDATE sessions SET joined_at = $2 WHERE token = $1', [
      outOfRange.token,
      new Date('2026-08-01T00:00:00.000Z'),
    ]);

    // Different user, joined in range — must not be counted for user A.
    const otherUser = await repos.sessions.create(userB, {
      devotionalId: devoB.id,
      expiresAt: new Date('2026-07-05T00:00:00.000Z'),
    });
    await pool.query('UPDATE sessions SET joined_at = $2 WHERE token = $1', [
      otherUser.token,
      new Date('2026-07-10T00:00:00.000Z'),
    ]);

    const count = await repos.sessions.countJoinedInRange(
      userA,
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-08-01T00:00:00.000Z'),
    );
    expect(count).toBe(1);
  });
});

describe('ConnectionsRepository — user scoping + no plaintext tokens', () => {
  it('stores only ciphertext and scopes lookups by user', async () => {
    const userA = await makeUser('conn-a');
    const userB = await makeUser('conn-b');

    await repos.connections.upsert(userA, {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('ciphertext-a'),
      encryptionIv: Buffer.from('iv-a'),
      encryptionAuthTag: Buffer.from('tag-a'),
      kmsKeyVersion: 'projects/x/keyRings/y/cryptoKeys/z/cryptoKeyVersions/1',
      scopes: ['calendar.readonly'],
    });

    const connA = await repos.connections.findByProvider(userA, 'google_calendar');
    const connB = await repos.connections.findByProvider(userB, 'google_calendar');

    expect(connA?.encrypted_refresh_token.toString()).toBe('ciphertext-a');
    expect(connB).toBeNull();
  });
});

describe('CalendarEventsRepository — user scoping', () => {
  it('getByProviderEventId does not leak across users even with the same provider_event_id', async () => {
    const userA = await makeUser('cal-a');
    const userB = await makeUser('cal-b');
    const now = new Date();
    const later = new Date(now.getTime() + 1800_000);

    await repos.calendarEvents.create(userA, {
      devotionalId: null,
      providerEventId: 'shared-provider-id',
      gapSource: 'found_gap',
      gapStartAt: now,
      gapEndAt: later,
    });
    await repos.calendarEvents.create(userB, {
      devotionalId: null,
      providerEventId: 'shared-provider-id',
      gapSource: 'micro_gap',
      gapStartAt: now,
      gapEndAt: later,
    });

    const forA = await repos.calendarEvents.getByProviderEventId(userA, 'shared-provider-id');
    const forB = await repos.calendarEvents.getByProviderEventId(userB, 'shared-provider-id');

    expect(forA?.gap_source).toBe('found_gap');
    expect(forB?.gap_source).toBe('micro_gap');
    expect(forA?.user_id).not.toBe(forB?.user_id);
  });

  /**
   * L4 (#240) — `listUpcomingForUser`. These live here rather than beside
   * the route tests because the filter, the ordering, and the join are all
   * SQL: an in-process fake can only restate what the query is *supposed*
   * to do, which is not evidence about what it does. The cross-user case
   * matters especially — this is the first query in the repository layer
   * that joins devotional CONTENT (theme, card summary) onto another
   * table, so a scoping mistake here leaks words, not just ids.
   */
  describe('CalendarEventsRepository.listUpcomingForUser (#240)', () => {
    const NOW = new Date('2026-07-19T12:00:00Z');

    async function makeEvent(
      userId: Awaited<ReturnType<typeof makeUser>>,
      providerEventId: string,
      startIso: string,
      endIso: string,
      devotionalId: string | null = null,
      meetUri: string | null = null,
    ) {
      return repos.calendarEvents.create(userId, {
        devotionalId,
        providerEventId,
        gapSource: 'found_gap',
        gapStartAt: new Date(startIso),
        gapEndAt: new Date(endIso),
        meetUri,
      });
    }

    it('returns only unfinished events, soonest first', async () => {
      const user = await makeUser('upcoming-order');
      // Inserted deliberately out of chronological order, so passing
      // requires the ORDER BY rather than insertion order.
      await makeEvent(user, 'ev-later', '2026-07-26T07:00:00Z', '2026-07-26T07:15:00Z');
      await makeEvent(user, 'ev-past', '2026-07-18T07:00:00Z', '2026-07-18T07:15:00Z');
      await makeEvent(user, 'ev-soon', '2026-07-19T18:00:00Z', '2026-07-19T18:15:00Z');

      const rows = await repos.calendarEvents.listUpcomingForUser(user, NOW, 50);

      expect(rows.map((r) => r.gap_start_at.toISOString())).toEqual([
        '2026-07-19T18:00:00.000Z',
        '2026-07-26T07:00:00.000Z',
      ]);
    });

    it('keeps an in-progress event and drops one that has just finished', async () => {
      // The `gap_end_at > now` boundary, asserted in both directions —
      // this is the deliberate decision recorded on the method, so it is
      // the one most worth pinning.
      const user = await makeUser('upcoming-boundary');
      await makeEvent(user, 'ev-running', '2026-07-19T11:55:00Z', '2026-07-19T12:10:00Z');
      await makeEvent(user, 'ev-just-over', '2026-07-19T11:40:00Z', '2026-07-19T11:55:00Z');

      const rows = await repos.calendarEvents.listUpcomingForUser(user, NOW, 50);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.gap_end_at.toISOString()).toBe('2026-07-19T12:10:00.000Z');
    });

    it('joins the linked devotional theme and summary, and tolerates no link', async () => {
      const user = await makeUser('upcoming-join');
      const devo = await repos.devotionals.create(user, minimalDevotional('2026-07-20'));
      await makeEvent(
        user,
        'ev-joined',
        '2026-07-20T07:00:00Z',
        '2026-07-20T07:15:00Z',
        devo.id,
        'https://meet.google.com/abc-defg-hij',
      );
      await makeEvent(user, 'ev-unlinked', '2026-07-21T07:00:00Z', '2026-07-21T07:15:00Z');

      const rows = await repos.calendarEvents.listUpcomingForUser(user, NOW, 50);

      expect(rows).toHaveLength(2);
      expect(rows[0]!.devotional_id).toBe(devo.id);
      expect(rows[0]!.theme).toBe(devo.theme);
      expect(rows[0]!.card_summary).toBe(devo.card_summary);
      expect(rows[0]!.meet_uri).toBe('https://meet.google.com/abc-defg-hij');
      // LEFT join: an event with no devotional is still a real booking and
      // must not vanish from the schedule.
      expect(rows[1]!.devotional_id).toBeNull();
      expect(rows[1]!.theme).toBeNull();
    });

    it('never returns another user\'s events or another user\'s devotional text', async () => {
      const userA = await makeUser('upcoming-scope-a');
      const userB = await makeUser('upcoming-scope-b');
      const devoA = await repos.devotionals.create(userA, minimalDevotional('2026-07-20'));
      await makeEvent(userA, 'ev-a', '2026-07-20T07:00:00Z', '2026-07-20T07:15:00Z', devoA.id);

      const forB = await repos.calendarEvents.listUpcomingForUser(userB, NOW, 50);

      expect(forB).toHaveLength(0);
    });

    it('honors the limit', async () => {
      const user = await makeUser('upcoming-limit');
      for (let i = 1; i <= 5; i++) {
        await makeEvent(user, `ev-${i}`, `2026-07-2${i}T07:00:00Z`, `2026-07-2${i}T07:15:00Z`);
      }

      const rows = await repos.calendarEvents.listUpcomingForUser(user, NOW, 3);
      expect(rows).toHaveLength(3);
    });
  });
});

/**
 * L5 (#241) — `listCardsForUser`. Here for the same reason as
 * `listUpcomingForUser` above: the keyset comparison is a Postgres row-
 * value expression and the completion state is a LEFT JOIN LATERAL.
 * Neither can be verified anywhere but against a real database, and the
 * same-date case below is precisely the bug a date-only cursor would
 * have.
 */
describe('DevotionalsRepository.listCardsForUser (#241)', () => {
  it('projects card fields only — no body, prayer, or verses', async () => {
    // The payload claim, asserted at its source. Even if the route were
    // changed to spread the row, there would be nothing heavy to spread.
    const user = await makeUser('cards-projection');
    await repos.devotionals.create(user, minimalDevotional('2026-07-01'));

    const [row] = await repos.devotionals.listCardsForUser(user, { limit: 10 });

    expect(Object.keys(row!).sort()).toEqual(
      ['card_summary', 'completed_at', 'created_at', 'date', 'format', 'id', 'theme'].sort(),
    );
  });

  it('pages newest-first without repeating or skipping a row', async () => {
    const user = await makeUser('cards-paging');
    for (const date of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']) {
      await repos.devotionals.create(user, minimalDevotional(date));
    }

    const page1 = await repos.devotionals.listCardsForUser(user, { limit: 2 });
    expect(page1.map((r) => r.date)).toEqual(['2026-07-05', '2026-07-04']);

    const last = page1[page1.length - 1]!;
    const page2 = await repos.devotionals.listCardsForUser(user, {
      limit: 2,
      cursor: { date: last.date, createdAt: last.created_at, id: last.id },
    });
    expect(page2.map((r) => r.date)).toEqual(['2026-07-03', '2026-07-02']);
  });

  it('advances past BOTH devotionals sharing a date', async () => {
    // The reason the cursor is a three-part tuple rather than just the
    // date. A user with the examen enabled holds a `standard` and an
    // `examen` row for the same day (#77); a `WHERE date < cursor` pager
    // would jump over the second one, and a `<=` pager would serve the
    // first one forever.
    const user = await makeUser('cards-same-date');
    await repos.devotionals.create(user, { ...minimalDevotional('2026-07-02'), slotType: 'standard' });
    await repos.devotionals.create(user, { ...minimalDevotional('2026-07-02'), slotType: 'examen' });
    await repos.devotionals.create(user, minimalDevotional('2026-07-01'));

    const seen: string[] = [];
    let cursor = undefined as
      | { date: string; createdAt: Date; id: string }
      | undefined;

    for (let page = 0; page < 5; page++) {
      const rows = await repos.devotionals.listCardsForUser(user, { limit: 1, cursor });
      if (rows.length === 0) break;
      seen.push(rows[0]!.id);
      const last = rows[0]!;
      cursor = { date: last.date, createdAt: last.created_at, id: last.id };
    }

    // All three rows, each exactly once — including both same-date rows.
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('reports completion state from the linked session', async () => {
    const user = await makeUser('cards-completion');
    const done = await repos.devotionals.create(user, minimalDevotional('2026-07-02'));
    const notDone = await repos.devotionals.create(user, minimalDevotional('2026-07-01'));

    const doneSession = await repos.sessions.create(user, {
      devotionalId: done.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await repos.sessions.markCompleted(user, doneSession.token, 300);
    await repos.sessions.create(user, {
      devotionalId: notDone.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const rows = await repos.devotionals.listCardsForUser(user, { limit: 10 });

    expect(rows.find((r) => r.id === done.id)!.completed_at).not.toBeNull();
    expect(rows.find((r) => r.id === notDone.id)!.completed_at).toBeNull();
  });

  it('does not multiply a devotional that has several sessions', async () => {
    // The LEFT JOIN LATERAL's real job: a plain join would emit one list
    // row per session, breaking both the display and the page arithmetic.
    // The completed session is created SECOND, so passing also requires
    // the lateral's `completed_at DESC NULLS LAST` preference rather than
    // simply picking the newest row.
    const user = await makeUser('cards-multi-session');
    const devo = await repos.devotionals.create(user, minimalDevotional('2026-07-01'));
    await repos.sessions.create(user, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const second = await repos.sessions.create(user, {
      devotionalId: devo.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await repos.sessions.markCompleted(user, second.token, 300);

    const rows = await repos.devotionals.listCardsForUser(user, { limit: 10 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.completed_at).not.toBeNull();
  });

  it('never returns another user\'s devotionals', async () => {
    const userA = await makeUser('cards-scope-a');
    const userB = await makeUser('cards-scope-b');
    await repos.devotionals.create(userA, minimalDevotional('2026-07-01'));

    expect(await repos.devotionals.listCardsForUser(userB, { limit: 10 })).toHaveLength(0);
  });
});
