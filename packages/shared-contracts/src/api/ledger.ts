import { z } from 'zod';
import { BandsUploadResponseDataSchema } from './bands.js';

/**
 * `GET /v1/ledger/today` (docs/14 §4.2, issue #85). Backend's own record of
 * what it actually received for today's `daily_bands` upload — the
 * read-back endpoint `DataLedger.swift` (iOS) notes doesn't exist yet,
 * where the on-device "data ledger" (docs/05 §3.1) instead reconstructs
 * itself from `BandUploadService.lastSentRequest`. This endpoint makes that
 * claim server-verifiable rather than only self-reported by the client that
 * sent it.
 *
 * `data` is the same shape `POST`/`GET /v1/bands/:date` already return
 * (`BandsUploadResponseDataSchema`) — the ledger is nothing more than "the
 * `daily_bands` row for today," so it reuses that schema rather than
 * defining a parallel one. `data` is nullable: no upload has landed yet
 * today is a normal, expected state (docs/05 §3.1 empty state: "Nothing
 * sent yet today"), not an error.
 */
/**
 * Today's recorded prayer intention (docs/14 §5.5, issue #93) — shown in
 * the data ledger per that issue's explicit requirement ("shown in the
 * data ledger"). A new, additive sibling field to `data` rather than a
 * restructuring of it, so existing consumers of this already-shipped,
 * contract-tested response shape (docs/03, issue #83) are unaffected.
 * `null` when nothing was recorded today (the normal case), not an error.
 */
const LedgerPrayerIntentionSchema = z.object({
  text: z.string(),
  createdAt: z.string(),
});

export const LedgerTodayResponseSchema = z.object({
  ok: z.literal(true),
  data: BandsUploadResponseDataSchema.nullable(),
  prayerIntention: LedgerPrayerIntentionSchema.nullable(),
});
export type LedgerTodayResponse = z.infer<typeof LedgerTodayResponseSchema>;
