import { z } from 'zod';

/**
 * The journal (N9, issue #268). A kept, user-owned place to write what one
 * is carrying — never sent to the model (v1).
 *
 * These schemas are the wire contract shared by `apps/api`'s validation
 * and the web client, so the two cannot drift (docs/14 §3.6). Note what is
 * NOT here: no count, no streak, no "entries this month" — the response
 * carries entries and a pagination cursor and nothing that reduces them to
 * a number (Foundation §9).
 */

/** One journal entry as it goes over the wire. */
export const JournalEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/**
 * `POST /v1/journal`. The text is trimmed and bounded: empty is a 400
 * (there is nothing to keep), and the cap keeps a single entry from being
 * a denial-of-storage vector. 4000 chars is generous for "what am I
 * carrying" while still being a bound.
 */
export const CreateJournalEntryRequestSchema = z.object({
  text: z.string().trim().min(1, 'an entry cannot be empty').max(4000, 'entry is too long'),
});
export type CreateJournalEntryRequest = z.infer<typeof CreateJournalEntryRequestSchema>;

export const CreateJournalEntryResponseSchema = z.object({
  ok: z.literal(true),
  data: JournalEntrySchema,
});
export type CreateJournalEntryResponse = z.infer<typeof CreateJournalEntryResponseSchema>;

/**
 * `GET /v1/journal`. Newest first, cursor-paginated the same way the
 * devotionals list is (#241): `nextCursor` is the `createdAt` to pass as
 * `?before=` for the next page, or `null` when there are no older entries.
 */
export const JournalListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.array(JournalEntrySchema),
  nextCursor: z.string().nullable(),
});
export type JournalListResponse = z.infer<typeof JournalListResponseSchema>;

export const DeleteJournalEntryResponseSchema = z.object({
  ok: z.literal(true),
});
export type DeleteJournalEntryResponse = z.infer<typeof DeleteJournalEntryResponseSchema>;
