/**
 * The church year, said once and quietly (N10, issue #269).
 *
 * ## What the line is for
 *
 * #269's complaint is that Wellspring reads the user's work calendar and
 * ignores the oldest calendar in Christianity. The fix is orientation —
 * *where are we* — not a feature. So this is one sentence, in the same
 * register the devotional itself was written in, and there is nothing to
 * press.
 *
 * ## No week, no countdown, and why the constraint lives here
 *
 * The server knows it is the fourth week of Lent. This module cannot know
 * that: `SEASON_LINES` is keyed by season alone, and the wire shape
 * (`api/liturgy.ts`) does not carry `week`. That is deliberate, and it is
 * the same technique `lib/todayCard.ts` uses against streaks — a
 * contributor who wants "3rd week of Lent" or "12 days until Easter" has
 * to widen the contract first.
 *
 * Foundation §9 and docs/14 §5.10 forbid counts and progress indicators
 * here. A season rendered as a position within a season is a progress bar;
 * "Lent" is a place. The lines below therefore name the season and its
 * character and stop, which is also why none of them mentions Easter: a
 * season that points at a date the user is waiting for has become a
 * countdown regardless of how it is punctuated.
 *
 * ## Why the wording echoes the prompt
 *
 * Each line's adjectives are lifted from `liturgicalSeasonInstructionLine`
 * in the API — the sentence the devotional engine is actually given. The
 * user reads the same characterization of the season that shaped the words
 * they are about to hear, rather than a second, independently-invented
 * description of Advent. (This is not a cross-boundary *value*, so it is
 * hand-written copy rather than a shared string: the API line is
 * imperative instruction addressed to a model, in the wrong register for a
 * card, and it carries the week.)
 */
import type { LiturgicalSeason } from '@kairos/shared-contracts';

/**
 * `Record`, not a lookup with a fallback: the compiler requires an entry
 * for every member of `LiturgicalSeasonSchema`, so a sixth season added to
 * the contract fails the build here instead of rendering an empty line.
 */
export const SEASON_LINES: Record<LiturgicalSeason, string> = {
  advent: 'It is Advent — a season of expectation.',
  christmastide: 'It is Christmastide — the arrival has come.',
  lent: 'It is Lent — a season of repentance, simplicity, and return.',
  eastertide: 'It is Eastertide — resurrection joy, unhurried.',
  ordinary_time: 'It is Ordinary Time — steady, unremarkable faithfulness.',
};

/**
 * The line to render, or `null` for "say nothing".
 *
 * `null` arrives from the server for a user whose devotionals are not
 * written to the season (see `api/liturgy.ts`), and saying nothing is the
 * correct rendering of it — not a hedge, not a greyed-out "Ordinary Time",
 * and not an invitation to turn seasons on. Announcing a season Wellspring is
 * not writing in would be a confident, specific, false claim about the
 * user's own devotionals, which is the failure class (#193/#213) this
 * epic keeps rediscovering.
 */
export function seasonLine(season: LiturgicalSeason | null): string | null {
  return season === null ? null : SEASON_LINES[season];
}
