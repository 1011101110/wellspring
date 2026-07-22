/**
 * N10 (#269): the season line the dashboard renders.
 *
 * The wire contract is tested on the API side (`liturgicalSeason.test.ts`),
 * where "surfaces a season iff the prompt has one" lives. This file owns
 * the two client-side properties:
 *
 *  1. `null` renders nothing — not a placeholder, not a greyed season.
 *  2. Every season the contract can send has a line, and no line carries a
 *     count. Foundation §9 / docs/14 §5.10 forbid counts and progress on
 *     this surface, and "a season as a position within a season" is a
 *     countdown to Easter wearing vestments.
 *
 * `SEASON_LINES` is a `Record<LiturgicalSeason, string>`, so the compiler
 * already guarantees completeness; the loop below is driven by the
 * contract enum so a sixth season added upstream fails here rather than
 * rendering a blank line, and it checks the *content* rule the type cannot.
 */
import { describe, expect, it } from 'vitest';
import { LiturgicalSeasonSchema } from '@kairos/shared-contracts';
import { SEASON_LINES, seasonLine } from '../src/lib/season';

describe('seasonLine', () => {
  it('says nothing when the season does not inform this user’s devotionals', () => {
    // `null` is the server saying "not this user". The correct rendering
    // is silence — announcing a season Wellspring is not writing in would be
    // the confident-and-false claim (#193/#213) this epic exists to stop.
    expect(seasonLine(null)).toBeNull();
  });

  it('has a line for every season the contract can send', () => {
    for (const season of LiturgicalSeasonSchema.options) {
      const line = seasonLine(season);
      expect(line, `no line for ${season}`).toBeTruthy();
      expect(line).toBe(SEASON_LINES[season]);
    }
  });

  it('carries no number, week, or countdown in any line', () => {
    // The load-bearing constraint. A digit here, or the word "week"/"day",
    // or a reference to Easter as a date to reach, would be the metric
    // §9 forbids. Asserting it across every line means a future edit that
    // reintroduces "the 3rd week of Lent" fails.
    for (const season of LiturgicalSeasonSchema.options) {
      const line = seasonLine(season)!;
      expect(line, `${season} contains a digit`).not.toMatch(/\d/);
      expect(line, `${season} counts weeks or days`).not.toMatch(/\b(week|weeks|day|days)\b/i);
      // "Easter" as a date still to reach — but not "Eastertide", which is
      // the name of a season we are *in*, the opposite of a countdown.
      expect(line, `${season} points at a target`).not.toMatch(/\buntil\b|\bleft\b|to go|\bEaster\b(?!tide)/i);
    }
  });

  it('names the season as a place, in the present tense', () => {
    // "It is Lent" — orientation, where-are-we. Not "Lent begins in…" or
    // "…of Lent". A weak check, but it pins the register #269 asks for.
    for (const season of LiturgicalSeasonSchema.options) {
      expect(seasonLine(season)).toMatch(/^It is /);
    }
  });
});
