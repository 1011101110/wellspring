/**
 * P4 (#323): the SQL half of the attendance read model, against a real
 * Postgres (kairos-test-pg container, same runbook as
 * repositories.test.ts).
 *
 * The pure suite (tests/services/rhythm/attendanceSignals.test.ts) owns
 * the decay math; THIS file owns the claims only the database can prove
 * — that the three §9 exclusion classes are enforced by the query's own
 * structure, each with a mutation check:
 *
 *  - slot filter: an EXAMEN devotional WITH a calendar event still never
 *    enters (flip `d.slot_type = 'standard'` and the first test fails);
 *  - calendar join: a standard devotional WITHOUT an event row —
 *    generate-now and distress both pass `skipCalendar`/force it off —
 *    never enters (make the JOIN a LEFT JOIN and the distress test
 *    fails);
 *  - window: only events that already ENDED, inside the trailing 28
 *    days, boundary inclusive.
 *
 * Feedback is a stubbed `FeedbackSignalSource` here on purpose: the
 * concrete reader has its own suite
 * (sessionFeedbackSignalSource.integration.test.ts) because it needs
 * #320's migration, and this file must not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
  type VerifiedUserId,
} from '../../src/db/repositories/index.js';
import {
  loadAttendanceSignals,
  type AttendanceSignalsDeps,
} from '../../src/services/rhythm/attendanceSignals.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

const NOW = new Date('2026-07-23T12:00:00Z');
const MS_PER_DAY = 86_400_000;

/** No-feedback stub — the concrete #320-backed source has its own suite. */
const NO_FEEDBACK: AttendanceSignalsDeps['feedback'] = {
  devotionalIdsWithFeedback: async () => new Set<string>(),
};

const deps: AttendanceSignalsDeps = { sessions: repos.sessions, feedback: NO_FEEDBACK };

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
}

beforeAll(async () => {
  await pool.query('SELECT 1 FROM users LIMIT 1');
});

beforeEach(async () => {
  await truncateAll();
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

function isoDateDaysAgo(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * One devotional, `daysAgo` days before NOW, in the exact arrangement
 * each production path leaves behind:
 *  - `scheduled: true` → a calendar_events row (the daily run's insert);
 *  - `scheduled: false` → none (generate-now's `skipCalendar: true`,
 *    examen's, and the distress override's paths all skip step 6).
 * The gap is a 15-minute window ending `daysAgo` days ago.
 */
async function makeDevotional(
  userId: VerifiedUserId,
  daysAgo: number,
  opts: { slotType?: 'standard' | 'examen'; scheduled?: boolean; joined?: boolean } = {},
): Promise<string> {
  const { slotType = 'standard', scheduled = true, joined = false } = opts;
  const devo = await repos.devotionals.create(userId, {
    date: isoDateDaysAgo(daysAgo),
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
    slotType,
  });
  const gapEnd = new Date(NOW.getTime() - daysAgo * MS_PER_DAY);
  if (scheduled) {
    await repos.calendarEvents.create(userId, {
      devotionalId: devo.id,
      providerEventId: `gcal-${devo.id}`,
      gapSource: 'found_gap',
      gapStartAt: new Date(gapEnd.getTime() - 15 * 60_000),
      gapEndAt: gapEnd,
    });
  }
  const session = await repos.sessions.create(userId, {
    devotionalId: devo.id,
    expiresAt: new Date(gapEnd.getTime() + 48 * 3600_000),
  });
  if (joined) {
    // markJoined stamps now(); these tests need the join at the event's
    // own moment, so the timestamp is set directly.
    await pool.query(`UPDATE sessions SET joined_at = $2 WHERE token = $1`, [
      session.token,
      new Date(gapEnd.getTime() - 10 * 60_000),
    ]);
  }
  return devo.id;
}

function load(userId: VerifiedUserId, lastBackoffAt: Date | null = null) {
  return loadAttendanceSignals(deps, userId, { now: NOW, lastBackoffAt });
}

describe('loadAttendanceSignals — exclusion classes are structural (§9 / #323)', () => {
  it('an examen devotional never enters the denominator, even with a calendar event forced in', async () => {
    const userId = await makeUser('examen');
    await makeDevotional(userId, 2, { slotType: 'standard', joined: false });
    // Production examen passes skipCalendar, so this event row is a
    // deliberately hostile arrangement: it exists purely so that ONLY
    // the slot_type filter stands between it and the denominator —
    // mutation check on `d.slot_type = 'standard'`.
    await makeDevotional(userId, 1, { slotType: 'examen', scheduled: true, joined: false });

    const signals = await load(userId);
    expect(signals.scheduledCount).toBe(1);
    expect(signals.consecutiveUnjoined).toBe(1);
  });

  it('a distress/generate-now session (no calendar insert) never increments consecutiveUnjoined', async () => {
    const userId = await makeUser('distress');
    // Three scheduled-and-missed mornings…
    await makeDevotional(userId, 6, { joined: false });
    await makeDevotional(userId, 4, { joined: false });
    await makeDevotional(userId, 2, { joined: false });
    // …and a distress check-in yesterday, unjoined (the arrangement
    // `distressSignalOverride` + skipped calendar step leaves behind).
    // If the calendar join stops being the gate, this row lands at the
    // HEAD of the trailing run and the count reads 4.
    await makeDevotional(userId, 1, { scheduled: false, joined: false });

    const signals = await load(userId);
    expect(signals.scheduledCount).toBe(3);
    expect(signals.consecutiveUnjoined).toBe(3);
  });

  it('a joined generate-now session counts FOR the user (reengagement) while staying out of the denominator', async () => {
    const userId = await makeUser('gen-now');
    await makeDevotional(userId, 3, { joined: false });
    await makeDevotional(userId, 1, { scheduled: false, joined: true });

    const backoffAt = new Date(NOW.getTime() - 2 * MS_PER_DAY);
    const signals = await load(userId, backoffAt);
    // Not in the denominator…
    expect(signals.scheduledCount).toBe(1);
    // …but its join still surfaces as renewed engagement.
    expect(signals.lastJoinedAt).not.toBeNull();
    expect(signals.reengagedSinceBackoff).toBe(true);
  });
});

describe('loadAttendanceSignals — window and join semantics', () => {
  it('includes an event ending exactly on the 28-day boundary and excludes one just beyond it', async () => {
    const userId = await makeUser('window');
    await makeDevotional(userId, 28, { joined: true }); // gap_end == windowStart, inclusive
    await makeDevotional(userId, 28.01, { joined: true }); // ~14 minutes older — out

    const signals = await load(userId);
    expect(signals.scheduledCount).toBe(1);
  });

  it('an event still in the future is not yet an invitation to have missed', async () => {
    const userId = await makeUser('future');
    await makeDevotional(userId, -1, { joined: false }); // booked for tomorrow
    await makeDevotional(userId, 1, { joined: true });

    const signals = await load(userId);
    expect(signals.scheduledCount).toBe(1);
    expect(signals.consecutiveUnjoined).toBe(0);
  });

  it('any joined session among several for one devotional marks the invitation met', async () => {
    const userId = await makeUser('multi-session');
    const devoId = await makeDevotional(userId, 1, { joined: false });
    // A second session for the same devotional (e.g. re-minted link), joined.
    const second = await repos.sessions.create(userId, {
      devotionalId: devoId,
      expiresAt: new Date(NOW.getTime() + 48 * 3600_000),
    });
    await pool.query(`UPDATE sessions SET joined_at = $2 WHERE token = $1`, [
      second.token,
      new Date(NOW.getTime() - MS_PER_DAY),
    ]);

    const signals = await load(userId);
    expect(signals.scheduledCount).toBe(1);
    expect(signals.consecutiveUnjoined).toBe(0);
    expect(signals.engagedScore).toBe(1);
  });

  it('is scoped to the user — a neighbor’s attendance never bleeds in (Foundation §10)', async () => {
    const userA = await makeUser('scope-a');
    const userB = await makeUser('scope-b');
    await makeDevotional(userA, 1, { joined: false });
    await makeDevotional(userB, 1, { joined: true });

    const signalsA = await load(userA);
    expect(signalsA.scheduledCount).toBe(1);
    expect(signalsA.consecutiveUnjoined).toBe(1);
    expect(signalsA.lastJoinedAt).toBeNull();
  });

  it('a user with nothing scheduled reads as neutral no-data, never as lapsed', async () => {
    const userId = await makeUser('empty');
    const signals = await load(userId);
    expect(signals).toEqual({
      scheduledCount: 0,
      engagedScore: 1,
      consecutiveUnjoined: 0,
      lastJoinedAt: null,
      reengagedSinceBackoff: false,
    });
  });
});

describe('preferences adaptive columns (migration 1722500000000)', () => {
  it('defaults: min_per_week 2, adaptive on, engine state NULL (never adapted)', async () => {
    const userId = await makeUser('prefs-defaults');
    const row = await repos.preferences.ensureExists(userId);
    expect(row.min_per_week).toBe(2);
    expect(row.adaptive_enabled).toBe(true);
    expect(row.adaptive_days_per_week).toBeNull();
    expect(row.adaptive_reason).toBeNull();
    expect(row.adaptive_decided_at).toBeNull();
  });

  it('update() writes the user-owned pair and leaves engine state untouched', async () => {
    const userId = await makeUser('prefs-update');
    await repos.preferences.ensureExists(userId);
    await repos.preferences.updateAdaptiveState(userId, {
      daysPerWeek: 3,
      reason: 'easing_back',
      decidedAt: new Date('2026-07-20T06:00:00Z'),
    });

    const updated = await repos.preferences.update(userId, {
      min_per_week: 4,
      adaptive_enabled: false,
    });
    expect(updated?.min_per_week).toBe(4);
    expect(updated?.adaptive_enabled).toBe(false);
    // The client-facing update path cannot have touched the ladder.
    expect(updated?.adaptive_days_per_week).toBe(3);
    expect(updated?.adaptive_reason).toBe('easing_back');
    expect(updated?.adaptive_decided_at).toEqual(new Date('2026-07-20T06:00:00Z'));
  });

  it('the DB CHECKs reject an out-of-range floor and an unknown reason code', async () => {
    const userId = await makeUser('prefs-checks');
    await repos.preferences.ensureExists(userId);
    await expect(repos.preferences.update(userId, { min_per_week: 9 })).rejects.toThrow(
      /min_per_week/,
    );
    await expect(
      repos.preferences.updateAdaptiveState(userId, {
        daysPerWeek: 3,
        reason: 'not_a_reason',
        decidedAt: NOW,
      }),
    ).rejects.toThrow(/adaptive_reason/);
  });
});
