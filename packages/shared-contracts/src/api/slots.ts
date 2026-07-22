import { z } from 'zod';

/**
 * `POST /v1/slots` request body (docs/03_API_INTEGRATION_SPEC.md §8.1,
 * docs/00_FOUNDATION.md §8): EventKit candidate free-window upload for
 * Apple-calendar users — the phone derives free gaps on-device and
 * uploads candidate windows ONLY (start/end instants), never titles,
 * attendees, or any other event content (Foundation §8 "never sent" list
 * — raw calendar event titles/attendees/locations/notes/precise event
 * timestamps are never sent to Gloo/YouVersion; this endpoint doesn't
 * even accept those fields from the client in the first place, so there
 * is structurally nothing of that kind to leak downstream).
 *
 * A single upload replaces the day's candidate slots for that user (see
 * `CandidateSlotsRepository.replaceForDate` doc) — the client is expected
 * to re-derive and re-upload the full set each time EventKit data changes,
 * not to incrementally patch.
 */
export const CandidateSlotSchema = z
  .object({
    startIso: z.string().datetime({ offset: true }),
    endIso: z.string().datetime({ offset: true }),
  })
  .refine((slot) => new Date(slot.endIso).getTime() > new Date(slot.startIso).getTime(), {
    message: 'endIso must be after startIso',
    path: ['endIso'],
  });
export type CandidateSlot = z.infer<typeof CandidateSlotSchema>;

/** Cap on slots-per-upload — a full day of 5-minute EventKit slivers is still well under this; guards against a malformed/hostile client sending an unbounded array. */
export const MAX_SLOTS_PER_UPLOAD = 500;

export const SlotsUploadRequestSchema = z.object({
  /** ISO date (YYYY-MM-DD) these candidate slots apply to, in the user's local calendar day. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)'),
  slots: z.array(CandidateSlotSchema).max(MAX_SLOTS_PER_UPLOAD),
});
export type SlotsUploadRequest = z.infer<typeof SlotsUploadRequestSchema>;

export const SlotsUploadResponseDataSchema = z.object({
  date: z.string(),
  count: z.number().int().nonnegative(),
});
export type SlotsUploadResponseData = z.infer<typeof SlotsUploadResponseDataSchema>;

export const SlotsUploadResponseSchema = z.object({
  ok: z.literal(true),
  data: SlotsUploadResponseDataSchema,
});
export type SlotsUploadResponse = z.infer<typeof SlotsUploadResponseSchema>;
