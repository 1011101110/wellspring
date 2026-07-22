/**
 * Paging the devotional archive (L5, issue #241).
 *
 * The list is cursor-paginated newest-first. The cursor is **opaque** —
 * the contract says so explicitly — so this module round-trips it verbatim
 * and never parses it. Everything here is a pure function over
 * (current page state, newly arrived page), which is what makes the paging
 * behavior testable without a network or a browser.
 */
import type { DevotionalCard, DevotionalListResponse } from '@kairos/shared-contracts';

export interface HistoryPage {
  items: readonly DevotionalCard[];
  /** `null` means the last page has been reached — not "unknown". */
  nextCursor: string | null;
}

export const EMPTY_HISTORY: HistoryPage = { items: [], nextCursor: null };

/**
 * Appends a page, dropping any row already held.
 *
 * The de-duplication is not defensive padding — it is required by the
 * clock. A keyset cursor is stable against *insertions*, but the archive's
 * newest-first ordering means a devotional generated while the user is
 * mid-scroll lands at the head of the list, and a subsequent refetch of
 * page one legitimately returns rows the client already has. Rendering
 * both copies would produce two identical cards with the same React key,
 * which is both a visible duplicate and a console error.
 *
 * First occurrence wins, so the earlier (already rendered, possibly
 * scrolled-to) instance keeps its position rather than jumping.
 */
export function appendPage(current: HistoryPage, incoming: DevotionalListResponse): HistoryPage {
  const seen = new Set(current.items.map((item) => item.id));
  const added = incoming.data.filter((item) => !seen.has(item.id));
  return {
    items: [...current.items, ...added],
    nextCursor: incoming.nextCursor,
  };
}

/** The first page replaces rather than appends — used by retry and by refresh. */
export function firstPage(incoming: DevotionalListResponse): HistoryPage {
  return { items: [...incoming.data], nextCursor: incoming.nextCursor };
}

/**
 * Whether to offer "Show more".
 *
 * Keyed on the cursor rather than on page fullness. A page can come back
 * shorter than `limit` and still have a next cursor, and a client that
 * inferred "short page means the end" would silently truncate the archive.
 */
export function hasMore(page: HistoryPage): boolean {
  return page.nextCursor !== null;
}

/**
 * The query string for a page request.
 *
 * The cursor is appended only when present: sending `cursor=` empty would
 * be a valid-looking cursor the server has to decide how to interpret, and
 * the contract distinguishes `null` from an empty string precisely to
 * avoid that.
 */
export function pageQuery(limit: number, cursor: string | null): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return `?${params.toString()}`;
}
