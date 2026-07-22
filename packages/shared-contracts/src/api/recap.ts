import { z } from 'zod';

/**
 * `GET /v1/recap/:year/:month` (docs/14 §5.9, issue #96) — a monthly
 * recap built entirely from data already held (devotionals, sessions,
 * daily_bands). Deliberately narrative, not numeric-first (docs/14
 * §5.10 "what NOT to build": no streaks, no gamification, no badges) —
 * `narrative` is the primary surface; the structured fields exist so a
 * client can render its own layout, not so a client can build a streak
 * counter out of them.
 */
export const MonthlyRecapResponseDataSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  /** Count of sessions actually joined (`joined_at IS NOT NULL`) this month — "sat with Scripture N times." */
  sessionsCount: z.number().int().min(0),
  /** Chapter-level passages ("Matthew 11") that recurred across two or more devotionals this month, most-recurring first. */
  recurringPassages: z.array(z.string()),
  /** The heaviest 7-day window this month by daily_bands signal, or null if no bands data / nothing stood out. */
  heavyWeek: z
    .object({
      /** e.g. "the week of the 14th" */
      label: z.string(),
    })
    .nullable(),
  narrative: z.string(),
});
export type MonthlyRecapResponseData = z.infer<typeof MonthlyRecapResponseDataSchema>;

export const MonthlyRecapResponseSchema = z.object({
  ok: z.literal(true),
  data: MonthlyRecapResponseDataSchema,
});
export type MonthlyRecapResponse = z.infer<typeof MonthlyRecapResponseSchema>;
