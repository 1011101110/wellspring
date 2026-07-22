/**
 * Integration test: `POST /v1/slots` data -> `loadTodaysBusyness` ->
 * `BusynessAnalyzer.analyzeBusyness` (issue #74, docs/14 §4.1 step 3).
 * Real Postgres round-trip via CandidateSlotsRepository; regression-shaped
 * against a naive "pass free slots straight to analyzeBusyness" bug
 * (analyzeBusyness expects BUSY blocks, not free ones — passing free slots
 * unmodified would invert the busyness band entirely).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
} from '../../../src/db/repositories/index.js';
import {
  invertFreeSlotsToBusyBlocks,
  loadTodaysBusyness,
} from '../../../src/services/busyness/loadTodaysBusyness.js';
import type { BusyWindow } from '../../../src/services/busynessAnalyzer.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE candidate_slots, calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
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

const WINDOW: BusyWindow = {
  start: '2026-07-02T07:00:00-06:00',
  end: '2026-07-02T21:00:00-06:00',
  timeZone: 'America/Denver',
};

async function makeUser(localPart: string) {
  const row = await repos.users.createUser({
    firebaseUid: `firebase-${localPart}`,
    email: `${localPart}@example.com`,
  });
  return asVerifiedUserId(row.id);
}

describe('loadTodaysBusyness', () => {
  it('treats the whole window as busy (no free-time evidence) when no slots have been uploaded — never fabricates free time', async () => {
    const userId = await makeUser('noslots');

    const analysis = await loadTodaysBusyness(repos.candidateSlots, {
      userId,
      date: '2026-07-02',
      window: WINDOW,
    });

    // No /v1/slots upload yet == no evidence of free time == conservative
    // "assume busy" default, not an invented 'light' band. This matters:
    // a naive inversion bug that defaulted an empty upload to "all free"
    // would silently report 'light' for a user we have zero calendar
    // signal for, which is the wrong direction to be wrong in (it would
    // schedule into what might actually be a packed day).
    expect(analysis.busyness).toBe('heavy');
    expect(analysis.busyMinutes).toBeCloseTo(analysis.windowMinutes, 0);
    expect(analysis.gaps).toHaveLength(0);
  });

  it('derives busyness from real uploaded candidate (FREE) slots via the repository', async () => {
    const userId = await makeUser('withslots');

    // Free slots: 07:00-09:00 and 17:00-21:00 (Denver). The rest of the
    // 07:00-21:00 window (09:00-17:00, 8 hours of 14) is therefore BUSY —
    // busyFraction ~0.57 -> 'moderate' per DEFAULT_BUSYNESS_THRESHOLDS.
    await repos.candidateSlots.replaceForDate(userId, '2026-07-02', [
      { startAt: new Date('2026-07-02T13:00:00.000Z'), endAt: new Date('2026-07-02T15:00:00.000Z') }, // 07:00-09:00 MDT
      { startAt: new Date('2026-07-02T23:00:00.000Z'), endAt: new Date('2026-07-03T03:00:00.000Z') }, // 17:00-21:00 MDT
    ]);

    const analysis = await loadTodaysBusyness(repos.candidateSlots, {
      userId,
      date: '2026-07-02',
      window: WINDOW,
    });

    expect(analysis.busyness).toBe('moderate');
    // 09:00-17:00 is 8 hours = 480 minutes busy.
    expect(analysis.busyMinutes).toBeCloseTo(480, 0);
  });

  it('a second /v1/slots-shaped upload for the same date fully replaces the first (no stale merge)', async () => {
    const userId = await makeUser('replace');

    await repos.candidateSlots.replaceForDate(userId, '2026-07-02', [
      { startAt: new Date('2026-07-02T13:00:00.000Z'), endAt: new Date('2026-07-02T14:00:00.000Z') },
    ]);
    await repos.candidateSlots.replaceForDate(userId, '2026-07-02', [
      { startAt: new Date('2026-07-02T13:00:00.000Z'), endAt: new Date('2026-07-03T03:00:00.000Z') }, // whole window free
    ]);

    const rows = await repos.candidateSlots.getForDate(userId, '2026-07-02');
    expect(rows).toHaveLength(1);

    const analysis = await loadTodaysBusyness(repos.candidateSlots, {
      userId,
      date: '2026-07-02',
      window: WINDOW,
    });
    expect(analysis.busyness).toBe('light');
    expect(analysis.busyMinutes).toBe(0);
  });
});

describe('invertFreeSlotsToBusyBlocks', () => {
  it('produces no busy blocks when a single free slot spans the entire window', () => {
    const blocks = invertFreeSlotsToBusyBlocks(WINDOW, [
      {
        id: '1',
        user_id: 'u1',
        date: '2026-07-02',
        start_at: new Date('2026-07-02T13:00:00.000Z'),
        end_at: new Date('2026-07-03T03:00:00.000Z'),
        created_at: new Date(),
      },
    ]);
    expect(blocks).toHaveLength(0);
  });

  it('produces the full window as one busy block when there are no free slots at all', () => {
    const blocks = invertFreeSlotsToBusyBlocks(WINDOW, []);
    expect(blocks).toHaveLength(1);
  });
});
