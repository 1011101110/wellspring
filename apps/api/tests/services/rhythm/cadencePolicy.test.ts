/**
 * P5 (#324): the cadence policy engine. Pure function, injected clock —
 * every branch of the truth table is pinned here, plus the three golden
 * multi-week scenarios and a property sweep.
 *
 * Mutation-check doctrine (per the epic): each guard's test is built so
 * removing the guard flips the assertion — e.g. the rate-limit tests use
 * signals that WOULD step if the ≥7-day check vanished, and the floor
 * tests use back-off pressure that WOULD cut below `min_per_week` if the
 * floor vanished.
 */
import { describe, expect, it } from 'vitest';
import type { AttendanceSignals } from '../../../src/services/rhythm/attendanceSignals.js';
import {
  BACKOFF_UNJOINED_THRESHOLD,
  MIN_DAYS_BETWEEN_STEPS,
  decideCadence,
  type CadencePolicyPrefs,
} from '../../../src/services/rhythm/cadencePolicy.js';

const NOW = new Date('2026-07-23T06:00:00Z');
const MS_PER_DAY = 86_400_000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * MS_PER_DAY);
}

/** Quiet, engaged baseline — nothing suggesting change. */
function signals(overrides: Partial<AttendanceSignals> = {}): AttendanceSignals {
  return {
    scheduledCount: 10,
    engagedScore: 0.9,
    consecutiveUnjoined: 0,
    lastJoinedAt: daysAgo(1),
    reengagedSinceBackoff: false,
    ...overrides,
  };
}

/** Mon–Fri user, floor 2, adaptive on, never adapted. */
function prefs(overrides: Partial<CadencePolicyPrefs> = {}): CadencePolicyPrefs {
  return {
    activeDays: [1, 2, 3, 4, 5],
    minPerWeek: 2,
    adaptiveEnabled: true,
    adaptiveDaysPerWeek: null,
    adaptiveDecidedAt: null,
    ...overrides,
  };
}

function decide(s: Partial<AttendanceSignals>, p: Partial<CadencePolicyPrefs>, now: Date = NOW) {
  return decideCadence(signals(s), prefs(p), { now });
}

describe('decideCadence — opt-out and empty history', () => {
  /**
   * Mutation check: the signals here carry maximal back-off pressure and
   * a stored adaptive level of 2, so if the `adaptive_enabled` bypass is
   * removed, the result would be 2 (or 1 after a step) — not the full 5.
   */
  it('adaptive_enabled=false restores the full stated schedule and reads no signals', () => {
    const decision = decide(
      { consecutiveUnjoined: 12, engagedScore: 0 },
      { adaptiveEnabled: false, adaptiveDaysPerWeek: 2, adaptiveDecidedAt: daysAgo(30) },
    );
    expect(decision).toEqual({
      daysPerWeek: 5,
      effectiveDays: [1, 2, 3, 4, 5],
      reason: 'fixed_by_user',
    });
  });

  /**
   * The coordinator-pinned new-user rule: empty history holds at the
   * CEILING — a brand-new user gets their full stated schedule, because
   * the absence of invitations is our doing, not theirs. Mutation check:
   * treat no-data as back-off pressure and daysPerWeek drops below 5.
   */
  it('a new user with no scheduled history holds at the ceiling with no_data', () => {
    const decision = decide({ scheduledCount: 0, consecutiveUnjoined: 0, lastJoinedAt: null }, {});
    expect(decision).toEqual({
      daysPerWeek: 5,
      effectiveDays: [1, 2, 3, 4, 5],
      reason: 'no_data',
    });
  });

  it('an already-adapted user with an empty window holds at their current level, not the ceiling', () => {
    const decision = decide(
      { scheduledCount: 0, consecutiveUnjoined: 0 },
      { adaptiveDaysPerWeek: 3, adaptiveDecidedAt: daysAgo(10) },
    );
    expect(decision).toEqual({ daysPerWeek: 3, effectiveDays: [1, 2, 3], reason: 'no_data' });
  });
});

describe('decideCadence — back-off', () => {
  it('3 consecutive unjoined invitations step down by exactly one', () => {
    const decision = decide({ consecutiveUnjoined: BACKOFF_UNJOINED_THRESHOLD }, {});
    expect(decision).toEqual({ daysPerWeek: 4, effectiveDays: [1, 2, 3, 4], reason: 'easing_back' });
  });

  /** Boundary pinned: `>= 3`, not `> 3`. */
  it('2 consecutive unjoined invitations are not yet pressure', () => {
    const decision = decide({ consecutiveUnjoined: BACKOFF_UNJOINED_THRESHOLD - 1 }, {});
    expect(decision.reason).toBe('hold');
    expect(decision.daysPerWeek).toBe(5);
  });

  it('a heavier run still steps down only one — nothing sudden', () => {
    const decision = decide({ consecutiveUnjoined: 11 }, { adaptiveDaysPerWeek: 4, adaptiveDecidedAt: daysAgo(8) });
    expect(decision.daysPerWeek).toBe(3);
    expect(decision.reason).toBe('easing_back');
  });

  /**
   * One step per calendar week. The pressure here WOULD step (unjoined
   * 6 ≥ 3, above floor), so if the ≥7-day guard is removed this becomes
   * `easing_back` and fails.
   */
  it('holds when the last state change was under 7 days ago', () => {
    const decision = decide(
      { consecutiveUnjoined: 6 },
      { adaptiveDaysPerWeek: 4, adaptiveDecidedAt: daysAgo(MIN_DAYS_BETWEEN_STEPS - 1) },
    );
    expect(decision).toEqual({ daysPerWeek: 4, effectiveDays: [1, 2, 3, 4], reason: 'hold' });
  });

  it('steps again at exactly 7 days', () => {
    const decision = decide(
      { consecutiveUnjoined: 6 },
      { adaptiveDaysPerWeek: 4, adaptiveDecidedAt: daysAgo(MIN_DAYS_BETWEEN_STEPS) },
    );
    expect(decision.reason).toBe('easing_back');
    expect(decision.daysPerWeek).toBe(3);
  });

  /**
   * The floor. Pressure is maximal and the step window is open, so if
   * the floor guard is removed this cuts to 1 and fails — `min_per_week`
   * default 2 means even a fully-lapsed user keeps two standing
   * invitations.
   */
  it('never cuts below min_per_week, and says so with at_floor', () => {
    const decision = decide(
      { consecutiveUnjoined: 20, engagedScore: 0 },
      { adaptiveDaysPerWeek: 2, adaptiveDecidedAt: daysAgo(30) },
    );
    expect(decision).toEqual({ daysPerWeek: 2, effectiveDays: [1, 2], reason: 'at_floor' });
  });

  it('a step that lands ON the floor is still easing_back (the step happened)', () => {
    const decision = decide(
      { consecutiveUnjoined: 4 },
      { adaptiveDaysPerWeek: 3, adaptiveDecidedAt: daysAgo(9) },
    );
    expect(decision.daysPerWeek).toBe(2);
    expect(decision.reason).toBe('easing_back');
  });
});

describe('decideCadence — ramp-up', () => {
  it('a join after back-off climbs one step with welcoming_back', () => {
    const decision = decide(
      { reengagedSinceBackoff: true },
      { adaptiveDaysPerWeek: 2, adaptiveDecidedAt: daysAgo(8) },
    );
    expect(decision).toEqual({ daysPerWeek: 3, effectiveDays: [1, 2, 3], reason: 'welcoming_back' });
  });

  it('ramp-up obeys the same one-step-per-week pace', () => {
    const decision = decide(
      { reengagedSinceBackoff: true },
      { adaptiveDaysPerWeek: 2, adaptiveDecidedAt: daysAgo(2) },
    );
    expect(decision).toEqual({ daysPerWeek: 2, effectiveDays: [1, 2], reason: 'hold' });
  });

  it('at the ceiling, renewed engagement reads at_ceiling and climbs no further', () => {
    const decision = decide(
      { reengagedSinceBackoff: true },
      { adaptiveDaysPerWeek: 5, adaptiveDecidedAt: daysAgo(8) },
    );
    expect(decision).toEqual({ daysPerWeek: 5, effectiveDays: [1, 2, 3, 4, 5], reason: 'at_ceiling' });
  });

  /**
   * Precedence, pinned: a user leaning on generate-now during a
   * backed-off stretch shows BOTH a 3+ trailing unjoined run (scheduled
   * invitations only) and a recent join. A join may only ever count FOR
   * them — mutation check: evaluate back-off first and this becomes
   * `easing_back` to 2, failing both assertions.
   */
  it('re-engagement suppresses simultaneous back-off pressure', () => {
    const decision = decide(
      { consecutiveUnjoined: 6, reengagedSinceBackoff: true },
      { adaptiveDaysPerWeek: 3, adaptiveDecidedAt: daysAgo(8) },
    );
    expect(decision.daysPerWeek).toBe(4);
    expect(decision.reason).toBe('welcoming_back');
  });
});

describe('decideCadence — user edits move the bounds immediately', () => {
  /**
   * Acceptance criterion verbatim: active_days edited below the current
   * adaptive level → immediate clamp, at_ceiling. `adaptiveDecidedAt` is
   * yesterday, so if the clamp were subject to the 7-day limiter this
   * would hold at 5 instead.
   */
  it('clamps to a shrunken active_days set at once, ignoring the step limiter', () => {
    const decision = decide(
      {},
      {
        activeDays: [1, 3, 5],
        adaptiveDaysPerWeek: 5,
        adaptiveDecidedAt: daysAgo(1),
      },
    );
    expect(decision).toEqual({ daysPerWeek: 3, effectiveDays: [1, 3, 5], reason: 'at_ceiling' });
  });

  it('clamps up to a raised min_per_week at once', () => {
    const decision = decide(
      {},
      { minPerWeek: 4, adaptiveDaysPerWeek: 2, adaptiveDecidedAt: daysAgo(1) },
    );
    expect(decision).toEqual({ daysPerWeek: 4, effectiveDays: [1, 2, 3, 4], reason: 'at_floor' });
  });

  it('min_per_week above the day-set size clamps to the day set — the user\'s days are the outer bound', () => {
    const decision = decide({}, { activeDays: [2, 4], minPerWeek: 6 });
    expect(decision.daysPerWeek).toBe(2);
    expect(decision.effectiveDays).toEqual([2, 4]);
  });
});

describe('decideCadence — day selection', () => {
  it('keeps the first N active days in week order, Sunday first (migration 1722100000000 ordering)', () => {
    const decision = decide(
      { consecutiveUnjoined: 3 },
      { activeDays: [5, 0, 4, 2], adaptiveDaysPerWeek: 3, adaptiveDecidedAt: daysAgo(10) },
    );
    expect(decision.daysPerWeek).toBe(2);
    expect(decision.effectiveDays).toEqual([0, 2]);
  });

  it('de-duplicates a sloppy stored day set before counting the ceiling', () => {
    const decision = decide({}, { activeDays: [1, 1, 3, 3, 5], adaptiveEnabled: false });
    expect(decision).toEqual({ daysPerWeek: 3, effectiveDays: [1, 3, 5], reason: 'fixed_by_user' });
  });
});

describe('decideCadence — distress exemption (Foundation §9)', () => {
  /**
   * The distress path inserts no calendar event, so P4's denominator
   * never contains it (proven structurally in the DB suite): a
   * distress-heavy week reaches this function as an EMPTY window plus
   * whatever joins those sessions produced — inputs that can only hold
   * or climb. Asserted here at the policy level too, so the exemption
   * survives even if someone changes the loader.
   */
  it('a distress-heavy week cannot produce easing_back', () => {
    // Five distress check-ins, all joined, none scheduled: scheduledCount
    // stays 0, and their joins surface only as lastJoinedAt.
    const decision = decide(
      { scheduledCount: 0, consecutiveUnjoined: 0, lastJoinedAt: daysAgo(0.5) },
      { adaptiveDaysPerWeek: 3, adaptiveDecidedAt: daysAgo(10) },
    );
    expect(decision.reason).not.toBe('easing_back');
    expect(decision.daysPerWeek).toBeGreaterThanOrEqual(3);
  });
});

/**
 * Golden multi-week walks — the #325 persistence loop in miniature.
 * State is written exactly the way `updateAdaptiveState`'s doc requires:
 * only when the decision CHANGED the level (steps/clamps), never on
 * holds, so `adaptiveDecidedAt` stays the limiter's honest clock.
 */
describe('decideCadence — golden scenarios', () => {
  function persist(p: CadencePolicyPrefs, decision: { daysPerWeek: number }, at: Date): CadencePolicyPrefs {
    if (decision.daysPerWeek === (p.adaptiveDaysPerWeek ?? [...new Set(p.activeDays)].length)) return p;
    return { ...p, adaptiveDaysPerWeek: decision.daysPerWeek, adaptiveDecidedAt: at };
  }

  it('a full lapse eases 5 → 4 → 3 → 2 over three weeks, then rests at the floor', () => {
    let p = prefs();
    const lapsed = { consecutiveUnjoined: 10, engagedScore: 0, lastJoinedAt: null };
    const expected = [
      { daysPerWeek: 4, reason: 'easing_back' },
      { daysPerWeek: 3, reason: 'easing_back' },
      { daysPerWeek: 2, reason: 'easing_back' },
      { daysPerWeek: 2, reason: 'at_floor' },
      { daysPerWeek: 2, reason: 'at_floor' },
    ];
    expected.forEach((want, week) => {
      const now = new Date(NOW.getTime() + week * 7 * MS_PER_DAY);
      const decision = decideCadence(signals(lapsed), p, { now });
      expect({ daysPerWeek: decision.daysPerWeek, reason: decision.reason }).toEqual(want);
      p = persist(p, decision, now);
    });
  });

  it('a return climbs 2 → 3 → 4 → 5 over three weeks, then rests at the ceiling', () => {
    let p = prefs({ adaptiveDaysPerWeek: 2, adaptiveDecidedAt: daysAgo(14) });
    const returned = { reengagedSinceBackoff: true, consecutiveUnjoined: 0 };
    const expected = [
      { daysPerWeek: 3, reason: 'welcoming_back' },
      { daysPerWeek: 4, reason: 'welcoming_back' },
      { daysPerWeek: 5, reason: 'welcoming_back' },
      { daysPerWeek: 5, reason: 'at_ceiling' },
    ];
    expected.forEach((want, week) => {
      const now = new Date(NOW.getTime() + week * 7 * MS_PER_DAY);
      const decision = decideCadence(signals(returned), p, { now });
      expect({ daysPerWeek: decision.daysPerWeek, reason: decision.reason }).toEqual(want);
      p = persist(p, decision, now);
    });
  });

  it('opting out mid-back-off restores the full schedule on the very next run', () => {
    const p = prefs({ adaptiveDaysPerWeek: 3, adaptiveDecidedAt: daysAgo(2), adaptiveEnabled: false });
    const decision = decideCadence(signals({ consecutiveUnjoined: 8 }), p, { now: NOW });
    expect(decision).toEqual({
      daysPerWeek: 5,
      effectiveDays: [1, 2, 3, 4, 5],
      reason: 'fixed_by_user',
    });
  });
});

/**
 * Property sweep (#324 acceptance): for ANY signal sequence —
 * adversarial included — the bounds hold, steps are |Δ| ≤ 1, and state
 * changes are ≥7 days apart. Seeded PRNG (mulberry32), so a failure
 * reproduces exactly.
 */
describe('decideCadence — properties over random signal sequences', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('floor ≤ daysPerWeek ≤ |active_days|, |Δ| ≤ 1, and ≥7 days between changes — 100 seeded 60-day runs', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rand = mulberry32(seed);
      const activeDays = [0, 1, 2, 3, 4, 5, 6].filter(() => rand() < 0.6);
      if (activeDays.length === 0) activeDays.push(3);
      const minPerWeek = 1 + Math.floor(rand() * 7);
      let p = prefs({ activeDays, minPerWeek });
      const floor = Math.min(minPerWeek, activeDays.length);
      const changeTimes: number[] = [];

      let previous = p.adaptiveDaysPerWeek ?? activeDays.length;
      for (let day = 0; day < 60; day++) {
        const now = new Date(NOW.getTime() + day * MS_PER_DAY);
        const s = signals({
          scheduledCount: Math.floor(rand() * 20),
          engagedScore: rand(),
          consecutiveUnjoined: Math.floor(rand() * 10),
          reengagedSinceBackoff: rand() < 0.3,
          lastJoinedAt: rand() < 0.5 ? new Date(now.getTime() - rand() * 20 * MS_PER_DAY) : null,
        });
        const decision = decideCadence(s, p, { now });

        expect(decision.daysPerWeek, `seed ${seed} day ${day} floor`).toBeGreaterThanOrEqual(floor);
        expect(decision.daysPerWeek, `seed ${seed} day ${day} ceiling`).toBeLessThanOrEqual(activeDays.length);
        expect(Math.abs(decision.daysPerWeek - previous), `seed ${seed} day ${day} step size`).toBeLessThanOrEqual(1);
        expect(decision.effectiveDays, `seed ${seed} day ${day} day pool`).toEqual(
          [...activeDays].sort((a, b) => a - b).slice(0, decision.daysPerWeek),
        );

        if (decision.daysPerWeek !== previous) {
          changeTimes.push(now.getTime());
          p = { ...p, adaptiveDaysPerWeek: decision.daysPerWeek, adaptiveDecidedAt: now };
          previous = decision.daysPerWeek;
        }
      }

      for (let i = 1; i < changeTimes.length; i++) {
        expect(
          changeTimes[i]! - changeTimes[i - 1]!,
          `seed ${seed}: state changes must be ≥7 days apart`,
        ).toBeGreaterThanOrEqual(MIN_DAYS_BETWEEN_STEPS * MS_PER_DAY);
      }
    }
  });
});
