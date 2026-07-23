/**
 * P4 (#323): the attendance signal read model, pure half.
 *
 * Everything here runs `computeAttendanceSignals` on hand-built rows with
 * an injected clock — deterministic given (rows, now), same inputs, same
 * output. The SQL half (slot filter, calendar-event join, window
 * predicate) is proven against a real Postgres in
 * tests/db/attendanceSignals.integration.test.ts; this file owns the
 * decay math, the run counting, and — most load-bearing — the §9
 * closed-schema guarantee on the one exported shape.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledAttendanceRow } from '../../../src/db/repositories/sessionsRepository.js';
import {
  DEFAULT_WINDOW_DAYS,
  ENGAGEMENT_HALF_LIFE_DAYS,
  computeAttendanceSignals,
  loadAttendanceSignals,
  type AttendanceSignals,
} from '../../../src/services/rhythm/attendanceSignals.js';

const NOW = new Date('2026-07-23T12:00:00Z');
const MS_PER_DAY = 86_400_000;

let nextId = 0;
/** A scheduled invitation `daysAgo` days before NOW, optionally engaged. */
function row(
  daysAgo: number,
  opts: { joined?: boolean; completed?: boolean; id?: string } = {},
): ScheduledAttendanceRow {
  const scheduledAt = new Date(NOW.getTime() - daysAgo * MS_PER_DAY);
  return {
    devotional_id: opts.id ?? `devo-${nextId++}`,
    scheduled_at: scheduledAt,
    // Joins/completions happen shortly after the invitation stood; the
    // exact offset is irrelevant to every assertion here.
    joined_at: opts.joined ? new Date(scheduledAt.getTime() + 60_000) : null,
    completed_at: opts.completed ? new Date(scheduledAt.getTime() + 120_000) : null,
  };
}

function compute(
  rows: ScheduledAttendanceRow[],
  opts: {
    feedbackIds?: ReadonlySet<string>;
    latestJoin?: Date | null;
    lastBackoffAt?: Date | null;
  } = {},
): AttendanceSignals {
  return computeAttendanceSignals(rows, opts.feedbackIds ?? new Set(), opts.latestJoin ?? null, {
    now: NOW,
    lastBackoffAt: opts.lastBackoffAt ?? null,
  });
}

describe('AttendanceSignals — §9 structural guarantee', () => {
  /**
   * The load-bearing test of the story: the exported shape has ONLY
   * aggregate fields. If anyone adds a per-day history array, a date
   * list, or an attended/missed calendar to the read model — the exact
   * field shape that makes streaks client-computable (#282) — the key
   * list below stops matching and this fails before review has to catch
   * it. Closed by exact equality, not `toMatchObject`, on purpose.
   */
  it('exports exactly the five aggregate fields and nothing enumerable beyond them', () => {
    const signals = compute([row(1, { joined: true }), row(3), row(5)]);
    expect(Object.keys(signals).sort()).toEqual([
      'consecutiveUnjoined',
      'engagedScore',
      'lastJoinedAt',
      'reengagedSinceBackoff',
      'scheduledCount',
    ]);
  });

  it('never carries an array anywhere in the shape (no history is representable)', () => {
    const signals = compute([row(0, { joined: true }), row(2), row(9, { completed: true })]);
    for (const [key, value] of Object.entries(signals)) {
      expect(Array.isArray(value), `${key} must not be an array`).toBe(false);
      expect(typeof value === 'object' && value !== null && !(value instanceof Date),
        `${key} must be a scalar or Date`).toBe(false);
    }
  });
});

describe('engagedScore — time-decayed engagement', () => {
  it('is 1 when every scheduled invitation was engaged', () => {
    const signals = compute([row(1, { joined: true }), row(8, { joined: true })]);
    expect(signals.engagedScore).toBe(1);
  });

  it('is 0 when none were', () => {
    const signals = compute([row(1), row(8)]);
    expect(signals.engagedScore).toBe(0);
  });

  /**
   * Golden decay math, half-life 9d: weights are 0.5^(age/9), the score
   * is the engagement-weighted average. Engaged today (w=1) + unjoined 9
   * days ago (w=0.5) → 1 / 1.5 = 2/3, NOT the unweighted 1/2 — recent
   * behavior counts more. Mutation check: drop the decay (weight
   * everything 1) and this reads 0.5, failing the assertion.
   */
  it('weights recent events more than old ones (half-life 9 days)', () => {
    const signals = compute([row(0, { joined: true }), row(ENGAGEMENT_HALF_LIFE_DAYS)]);
    expect(signals.engagedScore).toBeCloseTo(2 / 3, 10);
  });

  it('matches the golden three-event weighting (ages 0/9/18, engaged/missed/engaged)', () => {
    const signals = compute([
      row(0, { joined: true }),
      row(9),
      row(18, { joined: true }),
    ]);
    // Weights 1, 0.5, 0.25 → (1 + 0.25) / 1.75 = 5/7.
    expect(signals.engagedScore).toBeCloseTo(5 / 7, 10);
  });

  /**
   * The documented neutral: zero scheduled invitations is OUR absence
   * (no calendar, new user), never theirs, so the score must not read as
   * disengagement. The policy engine independently treats no-data as
   * "no change", but a neutral 1 here keeps any future reader of the
   * score honest too.
   */
  it('is a neutral 1 when there were no scheduled invitations at all', () => {
    const signals = compute([]);
    expect(signals).toMatchObject({ scheduledCount: 0, engagedScore: 1, consecutiveUnjoined: 0 });
  });

  it('clamps a clock-skewed future invitation to weight 1 rather than amplifying it', () => {
    // A "future" engaged event (age −2d) must weigh exactly like a
    // present one — 0.5^(−2/9) ≈ 1.17 would let skew mint extra credit.
    const skewed = compute([row(-2, { joined: true }), row(9)]);
    const present = compute([row(0, { joined: true }), row(9)]);
    expect(skewed.engagedScore).toBeCloseTo(present.engagedScore, 10);
  });
});

describe('what counts as engaged', () => {
  /**
   * #323 acceptance: a feedback row counts as engagement even without
   * Amen. The row here has NO join and NO completion — only its id in
   * the feedback set — so if `engaged()` stops consulting feedback
   * (mutation check), both assertions flip: the score drops and the
   * trailing run counts it as unjoined.
   */
  it('feedback-without-Amen counts as engaged and breaks the unjoined run', () => {
    const fb = row(1, {});
    const signals = compute([row(0), fb, row(2)], {
      feedbackIds: new Set([fb.devotional_id]),
    });
    expect(signals.consecutiveUnjoined).toBe(1); // only the newest row; fb broke the run
    expect(signals.engagedScore).toBeGreaterThan(0);
  });

  it('a completion counts even if joined_at was never recorded', () => {
    const signals = compute([row(0, { completed: true })]);
    expect(signals.engagedScore).toBe(1);
    expect(signals.consecutiveUnjoined).toBe(0);
  });
});

describe('consecutiveUnjoined — the trailing run', () => {
  it('counts from the most recent invitation and stops at the first engaged one', () => {
    const signals = compute([
      row(0),
      row(1),
      row(2, { joined: true }),
      row(3), // behind the join — must NOT be counted
      row(4),
    ]);
    expect(signals.consecutiveUnjoined).toBe(2);
  });

  it('is the full count when nothing was ever engaged', () => {
    const signals = compute([row(0), row(5), row(10), row(15)]);
    expect(signals.consecutiveUnjoined).toBe(4);
  });

  it('does not depend on the order rows arrive in', () => {
    const rows = [row(3), row(0), row(2, { joined: true }), row(1)];
    const shuffled = [rows[2]!, rows[0]!, rows[3]!, rows[1]!];
    expect(compute(rows)).toEqual(compute(shuffled));
  });
});

describe('reengagedSinceBackoff', () => {
  const backoffAt = new Date('2026-07-16T08:00:00Z');

  it('is true only for a join STRICTLY after the newest back-off decision', () => {
    const after = compute([], { latestJoin: new Date('2026-07-16T08:00:01Z'), lastBackoffAt: backoffAt });
    expect(after.reengagedSinceBackoff).toBe(true);

    // A join at the exact decision instant preceded it (the decision was
    // made in its light) — boundary pinned so >= can't creep in.
    const exact = compute([], { latestJoin: backoffAt, lastBackoffAt: backoffAt });
    expect(exact.reengagedSinceBackoff).toBe(false);

    const before = compute([], { latestJoin: new Date('2026-07-15T08:00:00Z'), lastBackoffAt: backoffAt });
    expect(before.reengagedSinceBackoff).toBe(false);
  });

  it('is false when the user was never backed off, however recently they joined', () => {
    const signals = compute([], { latestJoin: NOW, lastBackoffAt: null });
    expect(signals.reengagedSinceBackoff).toBe(false);
  });

  it('is false when there is no join at all', () => {
    const signals = compute([], { latestJoin: null, lastBackoffAt: backoffAt });
    expect(signals.reengagedSinceBackoff).toBe(false);
  });
});

describe('loadAttendanceSignals — the loader seam', () => {
  it('queries the trailing window anchored at the injected now and reduces the rows', async () => {
    const rows = [row(1, { joined: true }), row(3)];
    const listScheduledAttendance = vi.fn().mockResolvedValue(rows);
    const latestJoinedAt = vi.fn().mockResolvedValue(rows[0]!.joined_at);
    const devotionalIdsWithFeedback = vi.fn().mockResolvedValue(new Set<string>());

    const signals = await loadAttendanceSignals(
      {
        sessions: { listScheduledAttendance, latestJoinedAt } as never,
        feedback: { devotionalIdsWithFeedback },
      },
      'user-1' as never,
      { now: NOW, lastBackoffAt: null },
    );

    const expectedStart = new Date(NOW.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY);
    expect(listScheduledAttendance).toHaveBeenCalledWith('user-1', expectedStart, NOW);
    expect(latestJoinedAt).toHaveBeenCalledWith('user-1', expectedStart);
    expect(devotionalIdsWithFeedback).toHaveBeenCalledWith(
      'user-1',
      rows.map((r) => r.devotional_id),
    );
    expect(signals.scheduledCount).toBe(2);
    expect(signals.consecutiveUnjoined).toBe(0);
    expect(signals.lastJoinedAt).toEqual(rows[0]!.joined_at);
  });

  it('never queries feedback when there are no scheduled rows to attribute it to', async () => {
    const devotionalIdsWithFeedback = vi.fn();
    const signals = await loadAttendanceSignals(
      {
        sessions: {
          listScheduledAttendance: vi.fn().mockResolvedValue([]),
          latestJoinedAt: vi.fn().mockResolvedValue(null),
        } as never,
        feedback: { devotionalIdsWithFeedback },
      },
      'user-1' as never,
      { now: NOW, lastBackoffAt: null },
    );
    expect(devotionalIdsWithFeedback).not.toHaveBeenCalled();
    expect(signals.scheduledCount).toBe(0);
  });
});
