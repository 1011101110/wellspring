import { z } from 'zod';
import {
  ActivitySchema,
  BusynessSchema,
  CommunicationLoadSchema,
  RecoverySchema,
  SleepQualitySchema,
} from '../bands.js';
import { IsoDateParamSchema } from './params.js';

/**
 * `POST /v1/bands` request body (docs/03 §8.1, docs/14 §1.5 / issue #72).
 * Reuses the exact per-field enum schemas `BandInputSchema` (../bands.ts)
 * is built from — same canonical spellings, one source of truth — but is
 * NOT `BandInputSchema` itself: that schema requires
 * recovery/sleepQuality/activity/busyness. This route's contract is
 * different on purpose.
 *
 * `recovery`/`sleepQuality`/`activity` are OPTIONAL here (docs/14 §1.8 /
 * issue #70, the parallel iOS-consent fix): a category the user has
 * withheld consent for, or one HealthKit returned no evidence for, must
 * be omittable from the wire payload rather than forced to carry a
 * fabricated value. This mirrors how `busyness` (backend-derived,
 * Foundation §5) and `communicationLoad` (unshipped stretch signal) were
 * already optional/nullable — the fix here is bringing the three
 * on-device bands to the same "omittable, never fabricated" standard.
 * `dailyBandsRepository.upsertForDate` already stores `undefined`/`null`
 * inputs as SQL NULL for every one of these columns, so an omitted key
 * round-trips as a stored NULL, not a default/invented enum value.
 */
export const BandsUploadRequestSchema = z.object({
  date: IsoDateParamSchema,
  recovery: RecoverySchema.optional(),
  sleepQuality: SleepQualitySchema.optional(),
  activity: ActivitySchema.optional(),
  busyness: BusynessSchema.optional(),
  communicationLoad: CommunicationLoadSchema.optional(),
  distressSignal: z.boolean().default(false),
});
export type BandsUploadRequest = z.infer<typeof BandsUploadRequestSchema>;

/** `POST /v1/bands` response — the upserted row, camelCased for the wire (matches iOS's `BandUploadRequest` field naming). */
export const BandsUploadResponseDataSchema = z.object({
  date: z.string(),
  recovery: RecoverySchema.nullable(),
  sleepQuality: SleepQualitySchema.nullable(),
  activity: ActivitySchema.nullable(),
  busyness: BusynessSchema.nullable(),
  communicationLoad: CommunicationLoadSchema,
  distressSignal: z.boolean(),
});
export type BandsUploadResponseData = z.infer<typeof BandsUploadResponseDataSchema>;

export const BandsUploadResponseSchema = z.object({
  ok: z.literal(true),
  data: BandsUploadResponseDataSchema,
});
export type BandsUploadResponse = z.infer<typeof BandsUploadResponseSchema>;
