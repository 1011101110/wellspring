import { z } from 'zod';
import {
  RecoverySchema,
  SleepQualitySchema,
  ActivitySchema,
  BusynessSchema,
  CommunicationLoadSchema,
  DevotionalFormatSchema,
} from './bands.js';

/**
 * F8 Gloo engagement summary (docs/14_IMPROVEMENT_REVIEW.md §4.3,
 * pinned payload shape in docs/03_API_INTEGRATION_SPEC.md §7). Sent
 * fire-and-forget from `POST /session/:token/complete` — never blocks or
 * fails the completion response. Band *values* only (Foundation §8: no
 * raw HealthKit numbers leave the phone).
 */
export const GlooEngagementBandsSchema = z.object({
  recovery: RecoverySchema.nullable(),
  sleepQuality: SleepQualitySchema.nullable(),
  activity: ActivitySchema.nullable(),
  busyness: BusynessSchema.nullable(),
  communicationLoad: CommunicationLoadSchema,
});
export type GlooEngagementBands = z.infer<typeof GlooEngagementBandsSchema>;

export const GlooEngagementSummarySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  bands: GlooEngagementBandsSchema,
  format: DevotionalFormatSchema,
  theme: z.string().min(1),
  passage_usfm: z.string().min(1),
  versionId: z.number().int().positive(),
  completed: z.boolean(),
  durationListenedSec: z.number().int().nonnegative().nullable(),
});
export type GlooEngagementSummary = z.infer<typeof GlooEngagementSummarySchema>;
