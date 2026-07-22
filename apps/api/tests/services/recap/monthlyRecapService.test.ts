/**
 * Unit tests for the pure recap-building logic (docs/14 §5.9, issue #96)
 * — narrative composition, recurring-passage detection, and heavy-week
 * bucketing — against fake repositories rather than a real Postgres, since
 * none of this logic touches SQL directly (the date-range/scoping SQL
 * itself is covered by apps/api/tests/db/repositories.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { asVerifiedUserId } from '../../../src/db/repositories/index.js';
import { buildMonthlyRecap, type MonthlyRecapDeps } from '../../../src/services/recap/monthlyRecapService.js';

const USER_ID = asVerifiedUserId('11111111-1111-1111-1111-111111111111');

function verse(reference: string) {
  return {
    usfm: 'MAT.11.28',
    versionId: 3034,
    fetchedText: 'text',
    attribution: 'Berean Standard Bible',
    reference,
  };
}

function devotional(date: string, references: string[]) {
  return {
    id: `devo-${date}`,
    user_id: USER_ID,
    date,
    format: 'short' as const,
    theme: 'rest',
    verses: references.map(verse),
    devotional_body: 'body',
    card_summary: 'summary',
    prayer: 'prayer',
    journaling_prompt: null,
    action_step: null,
    audio_object: null,
    status: 'ready' as const,
    is_fixture_fallback: false,
    slot_type: 'standard' as const,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function bandsRow(date: string, overrides: Partial<{ recovery: string | null; sleep_quality: string | null; busyness: string | null; distress_signal: boolean }> = {}) {
  return {
    id: `bands-${date}`,
    user_id: USER_ID,
    date,
    recovery: null,
    sleep_quality: null,
    activity: null,
    busyness: null,
    communication_load: null,
    distress_signal: false,
    created_at: new Date(),
    ...overrides,
  };
}

function buildDeps(overrides: {
  devotionals?: ReturnType<typeof devotional>[];
  bands?: ReturnType<typeof bandsRow>[];
  sessionsCount?: number;
} = {}): MonthlyRecapDeps {
  return {
    devotionals: {
      listForUserInRange: vi.fn().mockResolvedValue(overrides.devotionals ?? []),
    } as unknown as MonthlyRecapDeps['devotionals'],
    dailyBands: {
      listForUserInRange: vi.fn().mockResolvedValue(overrides.bands ?? []),
    } as unknown as MonthlyRecapDeps['dailyBands'],
    sessions: {
      countJoinedInRange: vi.fn().mockResolvedValue(overrides.sessionsCount ?? 0),
    } as unknown as MonthlyRecapDeps['sessions'],
  };
}

describe('buildMonthlyRecap — narrative composition (docs/14 §5.9, issue #96)', () => {
  it('returns the zero-guilt "didn\'t sit" narrative when no sessions were joined this month', async () => {
    const recap = await buildMonthlyRecap(buildDeps({ sessionsCount: 0 }), USER_ID, 2026, 6);
    expect(recap.narrative).toBe("You didn't sit with Scripture this month. Whenever you're ready, Wellspring will be here.");
    expect(recap.sessionsCount).toBe(0);
  });

  it('uses singular "time" for exactly one session', async () => {
    const recap = await buildMonthlyRecap(buildDeps({ sessionsCount: 1 }), USER_ID, 2026, 6);
    expect(recap.narrative).toContain('sat with Scripture 1 time.');
    expect(recap.narrative).not.toContain('1 times');
  });

  it('uses plural "times" for more than one session', async () => {
    const recap = await buildMonthlyRecap(buildDeps({ sessionsCount: 11 }), USER_ID, 2026, 6);
    expect(recap.narrative).toContain('sat with Scripture 11 times.');
  });

  it('never mentions streaks, badges, or numeric-first framing — narrative is always a sentence, not a bare count', async () => {
    const recap = await buildMonthlyRecap(buildDeps({ sessionsCount: 5 }), USER_ID, 2026, 6);
    expect(recap.narrative).not.toMatch(/streak/i);
    expect(recap.narrative).not.toMatch(/badge/i);
    expect(recap.narrative).toMatch(/^This month/);
  });
});

describe('buildMonthlyRecap — recurring passages', () => {
  it('groups verses to chapter level ("Matthew 11:28-30" -> "Matthew 11") and only surfaces passages recurring across 2+ devotionals', async () => {
    const deps = buildDeps({
      sessionsCount: 2,
      devotionals: [
        devotional('2026-06-01', ['Matthew 11:28-30']),
        devotional('2026-06-08', ['Matthew 11:29']),
        devotional('2026-06-15', ['Psalm 46:1-3']), // appears once — should not recur
      ],
    });
    const recap = await buildMonthlyRecap(deps, USER_ID, 2026, 6);
    expect(recap.recurringPassages).toEqual(['Matthew 11']);
    expect(recap.narrative).toContain('One passage kept returning: Matthew 11.');
  });

  it('sorts recurring passages by frequency descending and caps at 3', async () => {
    const deps = buildDeps({
      sessionsCount: 6,
      devotionals: [
        devotional('2026-06-01', ['Matthew 11:1']),
        devotional('2026-06-02', ['Matthew 11:2']),
        devotional('2026-06-03', ['Matthew 11:3']), // Matthew 11 x3
        devotional('2026-06-04', ['Psalm 46:1']),
        devotional('2026-06-05', ['Psalm 46:2']), // Psalm 46 x2
        devotional('2026-06-06', ['John 3:16']),
        devotional('2026-06-07', ['John 3:17']), // John 3 x2
        devotional('2026-06-08', ['Romans 8:1']),
        devotional('2026-06-09', ['Romans 8:2']), // Romans 8 x2
      ],
    });
    const recap = await buildMonthlyRecap(deps, USER_ID, 2026, 6);
    expect(recap.recurringPassages).toHaveLength(3);
    expect(recap.recurringPassages[0]).toBe('Matthew 11');
  });

  it('counts a chapter only once per devotional even if it appears in multiple verses of the same devotional', async () => {
    const deps = buildDeps({
      sessionsCount: 1,
      devotionals: [
        devotional('2026-06-01', ['Matthew 11:28', 'Matthew 11:29']),
        devotional('2026-06-08', ['Matthew 11:1']),
      ],
    });
    const recap = await buildMonthlyRecap(deps, USER_ID, 2026, 6);
    // Two distinct devotionals both touch Matthew 11 -> recurs; NOT a false recurrence from within one devotional.
    expect(recap.recurringPassages).toEqual(['Matthew 11']);
  });

  it('falls back to the raw reference when it has no ":" (already chapter-level or malformed)', async () => {
    const deps = buildDeps({
      sessionsCount: 1,
      devotionals: [devotional('2026-06-01', ['Matthew 11']), devotional('2026-06-08', ['Matthew 11'])],
    });
    const recap = await buildMonthlyRecap(deps, USER_ID, 2026, 6);
    expect(recap.recurringPassages).toEqual(['Matthew 11']);
  });
});

describe('buildMonthlyRecap — heavy week detection', () => {
  it('is null when no daily_bands rows exist this month', async () => {
    const recap = await buildMonthlyRecap(buildDeps({ sessionsCount: 3 }), USER_ID, 2026, 6);
    expect(recap.heavyWeek).toBeNull();
  });

  it('is null when bands exist but carry no adverse signal', async () => {
    const deps = buildDeps({
      sessionsCount: 3,
      bands: [bandsRow('2026-06-10', { recovery: 'high', sleep_quality: 'good' })],
    });
    const recap = await buildMonthlyRecap(deps, USER_ID, 2026, 6);
    expect(recap.heavyWeek).toBeNull();
  });

  it('picks the 7-day bucket with the highest combined adverse-signal score, labeled by the bucket-ending day', async () => {
    const deps = buildDeps({
      sessionsCount: 3,
      bands: [
        // Days 1-7: one mild signal.
        bandsRow('2026-06-03', { recovery: 'low' }),
        // Days 8-14: three adverse signals -> heaviest bucket, ends on the 14th.
        bandsRow('2026-06-10', { recovery: 'low', sleep_quality: 'poor' }),
        bandsRow('2026-06-13', { distress_signal: true }),
      ],
    });
    const recap = await buildMonthlyRecap(deps, USER_ID, 2026, 6);
    expect(recap.heavyWeek).toEqual({ label: 'the week of the 14th' });
  });

  it('counts "heavy" busyness (not "high" — BusynessSchema is light/moderate/heavy) as an adverse signal', async () => {
    const deps = buildDeps({
      sessionsCount: 1,
      bands: [bandsRow('2026-06-10', { busyness: 'heavy' })],
    });
    const recap = await buildMonthlyRecap(deps, USER_ID, 2026, 6);
    expect(recap.heavyWeek).toEqual({ label: 'the week of the 14th' });
  });

  it('clamps the final bucket to the last real day of the month (e.g. day 30 for June, not day 35)', async () => {
    const deps = buildDeps({
      sessionsCount: 1,
      bands: [bandsRow('2026-06-29', { recovery: 'low', distress_signal: true })],
    });
    const recap = await buildMonthlyRecap(deps, USER_ID, 2026, 6);
    expect(recap.heavyWeek).toEqual({ label: 'the week of the 30th' });
  });
});
