import { z } from 'zod';

/**
 * `GET /v1/liturgical-season` (N10, issue #269).
 *
 * ## Why this route had to be invented rather than read from an existing one
 *
 * #269 says the season "is computed in the backend". That is true — the
 * computus lives in `apps/api/src/services/gloo/liturgicalCalendar.ts` and
 * has since #95 — but it was **never exposed over the wire**. It was a
 * private input to the generation prompt and nothing else. So "surface the
 * value that already exists" was, in fact, a backend change: there was no
 * field on any response for a client to read.
 *
 * `GET /v1/preferences` was the obvious host and is the wrong one. It
 * carries `liturgicalSeasonsEnabled` (the opt-in) but not `tradition`,
 * which lives on `users` and is deliberately absent from that payload. A
 * client therefore cannot decide whether the season applies to it, and any
 * client-side computus would be a second implementation of the season
 * boundaries — the "hand-copied SELECT" failure of Test Plan §3.1 with
 * Easter in it.
 *
 * ## `season: null` is the load-bearing part of this shape
 *
 * The season only reaches the devotional generator for some users:
 * catholic, mainline and anglican traditions always, everyone else only
 * when they have opted in (`liturgical_seasons_enabled`). See
 * `liturgicalSeasonInformsGeneration`, which this route and the
 * instructions builder both call — one predicate, so the dashboard cannot
 * claim a season the generator is not writing to.
 *
 * `null` therefore means **"the season is not shaping this user's
 * devotionals"**, not "we could not work out the date". A dashboard that
 * announced Lent to an evangelical user who never opted in would be
 * telling them their devotionals are Lenten when the prompt never mentions
 * Lent — the #193/#213 class of confident, specific, false claim that this
 * epic exists to stop repeating.
 *
 * ## There is no `week` here, on purpose
 *
 * `LiturgicalSeasonInfo` on the server carries a 1-based `week` for
 * Advent, Lent and Eastertide, and it is genuinely useful to the prompt.
 * It is dropped at this boundary rather than carried and ignored.
 *
 * docs/14 §5.10 and Foundation §9 forbid counts and progress indicators on
 * this surface, and "the 4th week of Lent" is a progress indicator wearing
 * liturgical clothes — it invites the reader to compute how many are left,
 * which turns a season into a countdown to Easter. Following the pattern
 * `lib/todayCard.ts` established for streaks: the constraint is enforced
 * by what crosses the boundary rather than by anyone remembering it in a
 * component. A contributor who wants to render a week number has to widen
 * this schema first, which is a visible act rather than an accident.
 */
export const LiturgicalSeasonSchema = z.enum([
  'advent',
  'christmastide',
  'lent',
  'eastertide',
  'ordinary_time',
]);
export type LiturgicalSeason = z.infer<typeof LiturgicalSeasonSchema>;

export const LiturgicalSeasonResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    /** The season now, or `null` when it does not inform this user's devotionals. */
    season: LiturgicalSeasonSchema.nullable(),
  }),
});
export type LiturgicalSeasonResponse = z.infer<typeof LiturgicalSeasonResponseSchema>;
