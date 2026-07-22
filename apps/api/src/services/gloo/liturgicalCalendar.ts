/**
 * liturgicalCalendar — pure Gregorian-computus season lookup (docs/14 §5.7,
 * issue #95). Kept as its own file, separate from instructionsBuilder.ts,
 * so that file's stricter "no clock reads" framing stays undiluted — this
 * module still takes an already-resolved date string as input and does no
 * I/O or clock reads of its own; it's just isolated as its own
 * independently-testable unit for the computus math.
 *
 * Pure: same `date` in -> same `LiturgicalSeasonInfo` out, every time.
 *
 * Season boundaries (Western/Gregorian calendar):
 *   - Advent: the 4 Sundays before Christmas (1st Sunday = Sunday nearest
 *     Nov 30) through Dec 24.
 *   - Christmastide: Dec 25 through Jan 5 (the Twelve Days).
 *   - Ordinary Time (after Epiphany): Jan 6 through the day before Ash
 *     Wednesday.
 *   - Lent: Ash Wednesday (Easter minus 46 days) through Holy Saturday.
 *   - Eastertide: Easter Sunday through Pentecost (Easter plus 49 days).
 *   - Ordinary Time (after Pentecost): the day after Pentecost through the
 *     day before the next Advent.
 */

import type { LiturgicalSeason, Tradition } from '@kairos/shared-contracts';

/**
 * Re-exported so the many existing importers of this module keep working.
 * The definition now lives in shared-contracts (`api/liturgy.ts`) because
 * N10 (#269) put these five values on the wire, and a wire enum with two
 * definitions is the `'google'` / `'google_calendar'` bug waiting to
 * happen (Test Plan §3.1 rule 2). There is one `z.enum`, and this type is
 * inferred from it.
 */
export type { LiturgicalSeason };

export interface LiturgicalSeasonInfo {
  season: LiturgicalSeason;
  /** 1-based week within the season. Only meaningful for Advent (1-4), Lent (1-6), and Eastertide (1-7) — undefined for Christmastide/Ordinary Time, which this instruction line doesn't number. */
  week?: number;
}

/**
 * Traditions for which the liturgical-season line is shown regardless of the
 * user's `liturgical_seasons_enabled` flag (docs/14 §5.7, issue #95): the
 * church year is not an opt-in feature in these traditions, it is the
 * ordinary shape of the year, so defaulting them to "off" would be wrong.
 *
 * `anglican` added by #192: unambiguously belongs here. The Book of Common
 * Prayer is organized around exactly the seasons this module computes
 * (Advent / Christmas / Lent / Easter / Ordinary Time), on exactly the
 * Western Gregorian computus it uses.
 *
 * `orthodox` is deliberately NOT in this set, despite being the most
 * thoroughly liturgical tradition on the list. This is a Gregorian-computus
 * implementation, and most Orthodox churches reckon Pascha on the Julian
 * calendar — so Great Lent and Pascha usually fall on different dates than
 * the Western ones, sometimes weeks apart. Forcing that line on would
 * confidently tell an Orthodox user "it is the 3rd week of Lent" during a
 * week when Great Lent has not begun. Under #192's own standard, asserting
 * the wrong season is worse than asserting none, so the season line stays
 * opt-in for orthodox and is qualified by `ORTHODOX_CALENDAR_CAVEAT` in
 * instructionsBuilder.ts when the user does opt in. Adding orthodox here is
 * correct only once an Orthodox paschalion exists (tracked as follow-up
 * work, not silently assumed here).
 */
const FORCED_LITURGICAL_SEASON_TRADITIONS: ReadonlySet<Tradition> = new Set<Tradition>([
  'catholic',
  'mainline',
  'anglican',
]);

/**
 * Does the liturgical season actually shape this user's devotionals?
 *
 * This lived inline inside `buildInstructions` until N10 (#269) needed a
 * second caller: `GET /v1/liturgical-season`, which tells the web dashboard
 * whether it may say "Wellspring is writing in Lent". Two callers of one rule,
 * so it is one function.
 *
 * The alternative — the route re-deriving `forced || opted-in` for itself —
 * is precisely the hand-copied-`SELECT` failure of Test Plan §3.1 rule 3.
 * The two copies would agree on the day they were written and drift the
 * first time the forced set changes, and the drift would surface as a
 * dashboard announcing a season the prompt never mentions. Sharing the
 * predicate means the UI claim is *derived from* the generator's behaviour
 * rather than describing it from memory.
 */
export function liturgicalSeasonInformsGeneration(
  tradition: Tradition,
  liturgicalSeasonsEnabled: boolean,
): boolean {
  return FORCED_LITURGICAL_SEASON_TRADITIONS.has(tradition) || liturgicalSeasonsEnabled;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function diffDays(date: Date, base: Date): number {
  return Math.round((date.getTime() - base.getTime()) / 86_400_000);
}

/**
 * Anonymous/Meeus Gregorian computus algorithm — computes the date of
 * Easter Sunday for a given year. Returns midnight UTC on that date.
 */
export function computeEasterDate(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** The Sunday nearest November 30 — Advent's 1st Sunday, always between Nov 27 and Dec 3. */
function firstAdventSunday(year: number): Date {
  const nov30 = new Date(Date.UTC(year, 10, 30));
  const dow = nov30.getUTCDay();
  const sundayBefore = addDays(nov30, -dow);
  const sundayAfter = dow === 0 ? sundayBefore : addDays(nov30, 7 - dow);
  const distanceBefore = dow;
  const distanceAfter = dow === 0 ? 0 : 7 - dow;
  return distanceBefore <= distanceAfter ? sundayBefore : sundayAfter;
}

/**
 * Resolves the liturgical season for a given ISO date (YYYY-MM-DD),
 * evaluated as midnight UTC — same convention as the rest of the
 * generation pipeline's `date` parameter (docs-declared "naive UTC
 * approximation" already used for calendar-window math elsewhere in
 * generateNowOrchestrator.ts).
 */
export function getLiturgicalSeason(isoDate: string): LiturgicalSeasonInfo {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const year = date.getUTCFullYear();

  const advent1 = firstAdventSunday(year);
  const christmas = new Date(Date.UTC(year, 11, 25));
  const epiphany = new Date(Date.UTC(year, 0, 6));
  const easter = computeEasterDate(year);
  const ashWednesday = addDays(easter, -46);
  const pentecost = addDays(easter, 49);

  if (date >= advent1 && date < christmas) {
    const week = Math.floor(diffDays(date, advent1) / 7) + 1;
    return { season: 'advent', week: Math.min(week, 4) };
  }
  if (date >= christmas) {
    return { season: 'christmastide' };
  }
  // date < advent1, i.e. somewhere in Jan 1 .. (Nov/early-Dec of this year).
  if (date < epiphany) {
    return { season: 'christmastide' };
  }
  if (date < ashWednesday) {
    return { season: 'ordinary_time' };
  }
  if (date < easter) {
    const week = Math.floor(diffDays(date, ashWednesday) / 7) + 1;
    return { season: 'lent', week: Math.min(week, 6) };
  }
  if (date <= pentecost) {
    const week = Math.floor(diffDays(date, easter) / 7) + 1;
    return { season: 'eastertide', week: Math.min(week, 7) };
  }
  return { season: 'ordinary_time' };
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
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

/**
 * Renders the season lookup as a single instructions line (docs/14 §5.7).
 * Kept out of instructionsBuilder.ts's `TRADITION_FRAMING`-style constant
 * tables since it's dynamic per-date, but produces the same kind of short,
 * declarative sentence.
 */
export function liturgicalSeasonInstructionLine(info: LiturgicalSeasonInfo): string {
  switch (info.season) {
    case 'advent':
      return `It is the ${ordinal(info.week ?? 1)} week of Advent — a season of expectation, not yet arrival.`;
    case 'christmastide':
      return 'It is Christmastide — the arrival has come; dwell in incarnation and quiet joy, not urgency.';
    case 'lent':
      return `It is the ${ordinal(info.week ?? 1)} week of Lent — a season of repentance, simplicity, and return.`;
    case 'eastertide':
      return `It is the ${ordinal(info.week ?? 1)} week of Eastertide — resurrection joy, unhurried and sure.`;
    case 'ordinary_time':
      return 'It is Ordinary Time — steady, unremarkable faithfulness, the shape of most of life.';
  }
}
