/**
 * Monthly recap (docs/14 §5.9, issue #96): "the zero-guilt principle
 * rules out streaks, but memory still serves formation." Built entirely
 * from data already held (devotionals, sessions, daily_bands) — no new
 * table, no new collection. Deliberately narrative, not numeric-first
 * (docs/14 §5.10 "what NOT to build": no gamification, badges, streaks,
 * social sharing, re-engagement pushes, expanded health data, or
 * model-paraphrased Scripture) — the numbers exist to be woven into a
 * sentence, never surfaced as a bare counter or a chart.
 *
 * "Recurring passages" reuses the exact, YouVersion-sourced `reference`
 * string already stored on each devotional's verses (docs/14 §5.1) rather
 * than deriving book names from USFM codes — chapter-level grouping is a
 * simple string trim of that existing field, not a new book-name mapping.
 *
 * "Heavy week" buckets the month into fixed 7-day windows (days 1-7,
 * 8-14, 15-21, 22-28, 29-end) rather than ISO calendar weeks — simpler,
 * deterministic, and matches the doc's own example phrasing ("the week
 * of the 14th").
 */
import type {
  DailyBandsRepository,
  DevotionalsRepository,
  SessionsRepository,
  VerifiedUserId,
} from '../../db/repositories/index.js';

export interface MonthlyRecapDeps {
  devotionals: DevotionalsRepository;
  sessions: SessionsRepository;
  dailyBands: DailyBandsRepository;
}

export interface MonthlyRecap {
  year: number;
  month: number;
  sessionsCount: number;
  recurringPassages: string[];
  heavyWeek: { label: string } | null;
  narrative: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Last calendar day of `year`-`month` (1-12), via the "day 0 of next month" trick. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Chapter-level label from a stored reference like "Matthew 11:28-30" -> "Matthew 11". Falls back to the raw reference if it has no ":" (already chapter-only or malformed). */
function chapterLabel(reference: string): string {
  const idx = reference.indexOf(':');
  return idx === -1 ? reference : reference.slice(0, idx).trim();
}

/** Ordinal suffix for a day-of-month number (1st, 2nd, 3rd, 4th, 11th, 21st, ...). */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

interface HeavyBandsRow {
  recovery: string | null;
  sleep_quality: string | null;
  /** One of 'light' | 'moderate' | 'heavy' (BusynessSchema, packages/shared-contracts/src/bands.ts). */
  busyness: string | null;
  distress_signal: boolean;
}

/** One "heaviness point" per adverse signal on a day — low recovery, poor sleep, heavy busyness, or a distress signal. */
function heavinessScore(row: HeavyBandsRow): number {
  let score = 0;
  if (row.recovery === 'low') score += 1;
  if (row.sleep_quality === 'poor') score += 1;
  if (row.busyness === 'heavy') score += 1;
  if (row.distress_signal) score += 1;
  return score;
}

export async function buildMonthlyRecap(
  deps: MonthlyRecapDeps,
  userId: VerifiedUserId,
  year: number,
  month: number,
): Promise<MonthlyRecap> {
  const lastDay = daysInMonth(year, month);
  const startDate = `${year}-${pad2(month)}-01`;
  const endDate = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  const rangeStart = new Date(Date.UTC(year, month - 1, 1));
  const rangeEnd = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));

  const [devotionals, bands, sessionsCount] = await Promise.all([
    deps.devotionals.listForUserInRange(userId, startDate, endDate),
    deps.dailyBands.listForUserInRange(userId, startDate, endDate),
    deps.sessions.countJoinedInRange(userId, rangeStart, rangeEnd),
  ]);

  // Recurring passages: chapter-level references appearing across 2+ distinct devotionals this month, most-recurring first.
  const chapterCounts = new Map<string, number>();
  for (const devo of devotionals) {
    const chaptersThisDevo = new Set(devo.verses.map((v) => chapterLabel(v.reference)));
    for (const chapter of chaptersThisDevo) {
      chapterCounts.set(chapter, (chapterCounts.get(chapter) ?? 0) + 1);
    }
  }
  const recurringPassages = [...chapterCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([chapter]) => chapter);

  // Heavy week: fixed 7-day buckets, scored by adverse daily_bands signals; report the heaviest bucket (if any signal at all).
  const bucketScores = new Map<number, number>();
  for (const row of bands) {
    const day = Number(row.date.slice(8, 10));
    const bucketEnd = Math.min(Math.ceil(day / 7) * 7, lastDay);
    bucketScores.set(bucketEnd, (bucketScores.get(bucketEnd) ?? 0) + heavinessScore(row));
  }
  let heavyWeek: { label: string } | null = null;
  let topScore = 0;
  for (const [bucketEnd, score] of bucketScores) {
    if (score > topScore) {
      topScore = score;
      heavyWeek = { label: `the week of the ${ordinal(bucketEnd)}` };
    }
  }

  const narrative = buildNarrative(sessionsCount, recurringPassages, heavyWeek);

  return { year, month, sessionsCount, recurringPassages, heavyWeek, narrative };
}

function buildNarrative(
  sessionsCount: number,
  recurringPassages: string[],
  heavyWeek: { label: string } | null,
): string {
  if (sessionsCount === 0) {
    return "You didn't sit with Scripture this month. Whenever you're ready, Wellspring will be here.";
  }

  const sentences = [
    `This month you sat with Scripture ${sessionsCount} ${sessionsCount === 1 ? 'time' : 'times'}.`,
  ];

  if (recurringPassages.length > 0) {
    const countWord = recurringPassages.length === 1 ? 'One passage' : `${recurringPassages.length === 2 ? 'Two' : 'Three'} passages`;
    sentences.push(`${countWord} kept returning: ${recurringPassages.join(', ')}.`);
  }

  if (heavyWeek) {
    sentences.push(`You marked ${heavyWeek.label} as heavy; Wellspring met you in micro moments that week.`);
  }

  return sentences.join(' ');
}
