/**
 * The journal (N9, #268). Kept, user-owned, never sent to the model.
 *
 * Every response is parsed through the shared contract rather than cast —
 * the same discipline as the other clients here, so a client/server drift
 * surfaces as a parse failure on the first request, not an `undefined`
 * three components later.
 */
import {
  CreateJournalEntryResponseSchema,
  JournalListResponseSchema,
  type JournalEntry,
  type JournalListResponse,
} from '@kairos/shared-contracts';
import { ApiError, apiFetch } from './client';

function shapeError(): ApiError {
  return new ApiError(200, 'Wellspring sent your journal in a shape this app does not understand.');
}

/** One page, newest first. `before` is the previous page's `nextCursor`. */
export async function getJournal(before: string | null = null): Promise<JournalListResponse> {
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  const result = JournalListResponseSchema.safeParse(await apiFetch<unknown>(`/v1/journal${query}`));
  if (!result.success) throw shapeError();
  return result.data;
}

export async function createJournalEntry(text: string): Promise<JournalEntry> {
  const result = CreateJournalEntryResponseSchema.safeParse(
    await apiFetch<unknown>('/v1/journal', { method: 'POST', body: { text } }),
  );
  if (!result.success) throw shapeError();
  return result.data.data;
}

export async function deleteJournalEntry(id: string): Promise<void> {
  // No body to parse — a 2xx is the whole answer, and `apiFetch` throws on
  // a non-2xx, so reaching here means it is gone.
  await apiFetch<unknown>(`/v1/journal/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
