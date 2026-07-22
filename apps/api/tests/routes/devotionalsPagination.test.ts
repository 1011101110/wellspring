/**
 * L5 backend half (#241): cursor pagination and card-only projection on
 * `GET /v1/devotionals`.
 *
 * ## What is real here and what is faked
 *
 * The repository fake below implements the SAME keyset semantics as
 * `listCardsForUser`'s SQL (newest first by `(date, created_at, id)`,
 * return rows strictly past the cursor tuple) over an in-memory fixture.
 * That is deliberate and it is what makes these tests meaningful rather
 * than circular: the behavior under test is the **route's** paging loop —
 * encode a cursor from the last row, decode it back, fetch limit+1 to
 * detect the end, clamp the page size, stop with `nextCursor: null`. Every
 * one of those steps lives in `userScoped.ts` and every one of them is a
 * place a paginator silently repeats or skips rows.
 *
 * The SQL itself is asserted separately, against a real Postgres, in
 * `tests/db/repositories.test.ts` — including the same-date case that a
 * date-only cursor would get wrong. Neither layer's test would catch the
 * other's bug, which is why both exist.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerUserScopedRoutes } from '../../src/routes/userScoped.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository, UserRow } from '../../src/db/repositories/usersRepository.js';
import type {
  DevotionalCardCursor,
  DevotionalCardRow,
} from '../../src/db/repositories/devotionalsRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const FIREBASE_UID = 'firebase-devotional-list';

/**
 * `count` devotionals, one per day counting back from 2026-06-30, newest
 * first. `seq` (the descending index) is embedded in both the id suffix
 * and the date, so id order and date order agree — which is what lets the
 * assertions below check "page 2 continues page 1" numerically.
 */
const EPOCH = Date.UTC(2026, 5, 30, 7, 0, 0);

function makeCards(count: number): DevotionalCardRow[] {
  return Array.from({ length: count }, (_, i) => {
    const seq = count - i; // count..1, descending with the sort order
    const createdAt = new Date(EPOCH - i * 24 * 60 * 60 * 1000);
    return {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      date: createdAt.toISOString().slice(0, 10),
      theme: `Theme ${seq}`,
      card_summary: `Summary ${seq}`,
      format: 'standard',
      created_at: createdAt,
      completed_at: seq % 2 === 0 ? new Date(createdAt.getTime() + 20 * 60 * 1000) : null,
    } as DevotionalCardRow;
  });
}

/** The descending sequence number embedded in a fixture id — higher = newer. */
function seqOf(id: string): number {
  return Number(id.slice(-12));
}

/** Lexicographic compare of the (date, created_at, id) sort key — the JS mirror of the SQL row-value comparison. */
function sortKeyBelow(row: DevotionalCardRow, cursor: DevotionalCardCursor): boolean {
  if (row.date !== cursor.date) return row.date < cursor.date;
  const rowTime = row.created_at.getTime();
  const cursorTime = cursor.createdAt.getTime();
  if (rowTime !== cursorTime) return rowTime < cursorTime;
  return row.id < cursor.id;
}

async function buildTestApp(cards: DevotionalCardRow[]) {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();

  const userRow = { id: USER_ID, firebase_uid: FIREBASE_UID } as unknown as UserRow;

  const listCardsForUser = vi.fn(
    async (
      _userId: string,
      opts: { limit: number; cursor?: DevotionalCardCursor | null },
    ): Promise<DevotionalCardRow[]> => {
      const sorted = [...cards].sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        const t = b.created_at.getTime() - a.created_at.getTime();
        if (t !== 0) return t;
        return a.id < b.id ? 1 : -1;
      });
      const after = opts.cursor ? sorted.filter((r) => sortKeyBelow(r, opts.cursor!)) : sorted;
      return after.slice(0, opts.limit);
    },
  );

  // Deliberately NOT provided: if the route ever fell back to
  // `listForUser` (the old unbounded `SELECT *`), these tests would throw
  // rather than quietly pass with a full, body-laden payload.
  const repositories = {
    users: {
      findOrCreateByFirebaseUid: vi.fn(async () => userRow),
      findById: vi.fn(async () => userRow),
    } as unknown as UsersRepository,
    devotionals: { listCardsForUser },
  } as unknown as Repositories;

  registerAuth(app, verifier, repositories.users);
  registerUserScopedRoutes(app, { repositories, audioStorage: {} as AudioStorage });

  return { app, token: await verifier.mint(FIREBASE_UID), listCardsForUser };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /v1/devotionals — cursor pagination (#241)', () => {
  it('returns a second page that shares no rows with the first', async () => {
    // The assertion the story asks for. A paginator that returns the same
    // rows twice (or drops the boundary row) is the classic offset bug,
    // and it is invisible to a test that only checks page sizes.
    const { app, token } = await buildTestApp(makeCards(12));

    const page1 = await app.inject({ method: 'GET', url: '/v1/devotionals?limit=5', headers: authed(token) });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.data).toHaveLength(5);
    expect(body1.nextCursor).toBeTypeOf('string');

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/devotionals?limit=5&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: authed(token),
    });
    const body2 = page2.json();
    expect(body2.data).toHaveLength(5);

    const ids1 = body1.data.map((d: { id: string }) => d.id);
    const ids2 = body2.data.map((d: { id: string }) => d.id);
    expect(ids2).not.toEqual(ids1);
    expect(ids1.filter((id: string) => ids2.includes(id))).toEqual([]);

    // Newest first, and page 2 genuinely continues page 1 rather than
    // restarting: every row on page 2 is older than every row on page 1.
    const seq1 = ids1.map(seqOf);
    const seq2 = ids2.map(seqOf);
    expect(seq1).toEqual([...seq1].sort((a, b) => b - a));
    expect(Math.max(...seq2)).toBeLessThan(Math.min(...seq1));

    await app.close();
  });

  it('walks the whole list exactly once across pages, then stops', async () => {
    // Termination is behavior too: a cursor that never goes null is an
    // infinite scroll that never reaches the bottom.
    const { app, token } = await buildTestApp(makeCards(11));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string = cursor
        ? `/v1/devotionals?limit=4&cursor=${encodeURIComponent(cursor)}`
        : '/v1/devotionals?limit=4';
      const res = await app.inject({ method: 'GET', url, headers: authed(token) });
      const body = res.json();
      seen.push(...body.data.map((d: { id: string }) => d.id));
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10); // guards against a non-terminating cursor
    } while (cursor !== null);

    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
    expect(pages).toBe(3);

    await app.close();
  });

  it('reports nextCursor: null on a page that exactly exhausts the list', async () => {
    // The off-by-one that the limit+1 fetch exists to prevent: with
    // exactly `limit` rows left, there is no next page, and a paginator
    // that assumed "a full page means more" would hand the client a
    // cursor leading to an empty one.
    const { app, token } = await buildTestApp(makeCards(5));

    const res = await app.inject({ method: 'GET', url: '/v1/devotionals?limit=5', headers: authed(token) });
    expect(res.json().data).toHaveLength(5);
    expect(res.json().nextCursor).toBeNull();

    await app.close();
  });

  it('serves an empty list as a 200 with no cursor, not an error', async () => {
    const { app, token } = await buildTestApp([]);

    const res = await app.inject({ method: 'GET', url: '/v1/devotionals', headers: authed(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
    expect(res.json().nextCursor).toBeNull();

    await app.close();
  });

  it('clamps an oversized limit instead of reinstating the unbounded query', async () => {
    // `?limit=` is caller-controlled; without a ceiling the whole story is
    // one query parameter away from being undone.
    const { app, token, listCardsForUser } = await buildTestApp(makeCards(250));

    const res = await app.inject({ method: 'GET', url: '/v1/devotionals?limit=100000', headers: authed(token) });

    expect(res.json().data.length).toBeLessThanOrEqual(100);
    // The cap is applied before the database is asked, not after — the
    // point is not to fetch 100,000 rows and then slice.
    expect(listCardsForUser.mock.calls[0]![1].limit).toBeLessThanOrEqual(101);

    await app.close();
  });

  it('serves page one for a malformed or forged cursor rather than failing the screen', async () => {
    const { app, token } = await buildTestApp(makeCards(6));

    const clean = await app.inject({ method: 'GET', url: '/v1/devotionals?limit=3', headers: authed(token) });
    for (const bad of ['not-base64!!', Buffer.from('{"d":"x"}').toString('base64url'), '']) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/devotionals?limit=3&cursor=${encodeURIComponent(bad)}`,
        headers: authed(token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual(clean.json().data);
    }

    await app.close();
  });
});

describe('GET /v1/devotionals — card projection (#241)', () => {
  it('omits devotional bodies from every list row', async () => {
    // "The list payload excludes bodies; detail includes them." Asserted
    // on the serialized payload, because the failure mode is a field
    // sneaking back in via a repository change rather than via this route.
    const { app, token } = await buildTestApp(makeCards(3));

    const res = await app.inject({ method: 'GET', url: '/v1/devotionals', headers: authed(token) });
    const raw = res.payload;

    for (const heavyField of ['devotional_body', 'devotionalBody', 'prayer', 'verses', 'action_step']) {
      expect(raw).not.toContain(heavyField);
    }

    for (const row of res.json().data) {
      expect(Object.keys(row).sort()).toEqual(
        ['cardSummary', 'completedAt', 'createdAt', 'date', 'format', 'id', 'theme'].sort(),
      );
    }

    await app.close();
  });

  it('carries per-row completion state', async () => {
    // #241: "Completion state visible per row" — it comes from `sessions`,
    // not `devotionals`, so it is the one field a naive projection would
    // drop.
    const { app, token } = await buildTestApp(makeCards(4));

    const rows = (await app.inject({ method: 'GET', url: '/v1/devotionals', headers: authed(token) })).json().data;

    // The fixture completes every even-numbered day; both states must be
    // represented, or this assertion could pass on an all-null column.
    const completed = rows.filter((r: { completedAt: string | null }) => r.completedAt !== null);
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.length).toBeLessThan(rows.length);
    expect(completed[0].completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await app.close();
  });
});
