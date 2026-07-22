import { describe, expect, it } from 'vitest';
import type { DevotionalCard, DevotionalListResponse } from '@kairos/shared-contracts';
import { appendPage, EMPTY_HISTORY, firstPage, hasMore, pageQuery } from '../src/lib/history';

function card(id: string): DevotionalCard {
  return {
    id,
    date: '2026-07-20',
    theme: `Theme ${id}`,
    cardSummary: 'Summary.',
    format: 'short',
    createdAt: '2026-07-20T12:00:00Z',
    completedAt: null,
  };
}

function response(ids: string[], nextCursor: string | null): DevotionalListResponse {
  return { ok: true, data: ids.map(card), nextCursor };
}

describe('firstPage', () => {
  it('replaces rather than appends, so a retry cannot double the list', () => {
    const page = firstPage(response(['a', 'b'], 'cursor-1'));
    expect(page.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe('cursor-1');
  });
});

describe('appendPage', () => {
  it('appends the next page in order', () => {
    const page = appendPage(firstPage(response(['a', 'b'], 'c1')), response(['c', 'd'], 'c2'));
    expect(page.items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(page.nextCursor).toBe('c2');
  });

  it('drops rows already held, keeping the first occurrence', () => {
    // The real scenario: a devotional generated mid-scroll shifts the
    // window, and a page legitimately returns a row the client has.
    const page = appendPage(firstPage(response(['a', 'b'], 'c1')), response(['b', 'c'], null));
    expect(page.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('carries the incoming cursor even when every row was a duplicate', () => {
    const page = appendPage(firstPage(response(['a'], 'c1')), response(['a'], 'c2'));
    expect(page.items.map((i) => i.id)).toEqual(['a']);
    expect(page.nextCursor).toBe('c2');
  });

  it('records the end of the list when the server sends a null cursor', () => {
    const page = appendPage(firstPage(response(['a'], 'c1')), response(['b'], null));
    expect(hasMore(page)).toBe(false);
  });
});

describe('hasMore', () => {
  it('is keyed on the cursor, not on page fullness', () => {
    // A short page with a cursor still has more. Inferring from length
    // would silently truncate the archive.
    expect(hasMore({ items: [card('a')], nextCursor: 'c1' })).toBe(true);
    expect(hasMore({ items: [card('a')], nextCursor: null })).toBe(false);
    expect(hasMore(EMPTY_HISTORY)).toBe(false);
  });
});

describe('pageQuery', () => {
  it('omits the cursor on the first page', () => {
    expect(pageQuery(20, null)).toBe('?limit=20');
  });

  it('round-trips an opaque cursor verbatim, url-encoded', () => {
    // Cursors are base64-ish and can contain characters that must not
    // reach the query string raw.
    const cursor = 'eyJkIjoiMjAyNi0wNy0yMCJ9==';
    expect(pageQuery(20, cursor)).toBe(`?limit=20&cursor=${encodeURIComponent(cursor)}`);
  });
});
