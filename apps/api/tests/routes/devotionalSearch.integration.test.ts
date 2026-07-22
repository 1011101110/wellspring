/**
 * `GET /v1/devotionals/search` against real Postgres (issue #242).
 *
 * CI-only: needs the kairos-test-pg container (A5 convention, port 5433),
 * same as authzProbes.integration.test.ts / repositories.test.ts. Does not
 * start a container. With Docker down these fail on connection, alongside
 * the suite's other `*.integration.test.ts` files.
 *
 * Everything here needs a database for a reason that matters — the
 * behaviour worth proving lives in SQL, not in the handler:
 *
 *   - owner scoping is a `WHERE user_id = $1` predicate,
 *   - Scripture matching depends on the generated column's usfm
 *     expansion (migration 1722000000000),
 *   - ranking and keyset paging are `ts_rank` and a row comparison,
 *   - and the index plan is a property of the planner.
 *
 * Mocking any of those would test the mock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DevotionalCardSchema } from '@kairos/shared-contracts';
import { buildApp } from '../../src/app.js';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
} from '../../src/db/repositories/index.js';
import { DEVOTIONAL_SEARCH_SQL } from '../../src/db/repositories/devotionalsRepository.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { LocalFileAudioStorage } from '../../src/services/audio/audioStorage.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

const ALICE_UID = 'search-alice-uid';
const BOB_UID = 'search-bob-uid';

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
}

let audioRootDir: string;
let verifier: FakeTokenVerifier;
let app: FastifyInstance;

beforeAll(async () => {
  await pool.query('SELECT 1 FROM users LIMIT 1');
  audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-search-audio-'));
  verifier = await FakeTokenVerifier.create();
  app = buildApp({
    tokenVerifier: verifier,
    repositories: repos,
    audioStorage: new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    }),
  });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await rm(audioRootDir, { recursive: true, force: true });
});

async function createUser(firebaseUid: string, email: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (firebase_uid, email, timezone) VALUES ($1, $2, 'UTC') RETURNING id`,
    [firebaseUid, email],
  );
  return res.rows[0]!.id;
}

interface SeedDevotional {
  date: string;
  theme: string;
  usfm: string;
  body: string;
  cardSummary: string;
}

async function seedDevotional(userId: string, d: SeedDevotional): Promise<void> {
  await repos.devotionals.create(asVerifiedUserId(userId), {
    date: d.date,
    format: 'short',
    theme: d.theme,
    verses: [{ usfm: d.usfm, versionId: 3034, fetchedText: 'seeded verse text' }],
    devotionalBody: d.body,
    cardSummary: d.cardSummary,
    prayer: 'Amen',
  });
}

async function search(uid: string, qs: string) {
  const token = await verifier.mint(uid);
  return app.inject({
    method: 'GET',
    url: `/v1/devotionals/search?${qs}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /v1/devotionals/search — owner scoping', () => {
  /**
   * THE test for this endpoint (issue #242 acceptance: "another user's
   * devotionals never surface — owner-scoping test, not just requireAuth
   * presence").
   *
   * Seeded so the SAME query matches rows belonging to BOTH users. That
   * detail is the whole point: a search endpoint whose scoping is broken
   * does not fail closed the way a by-id lookup does, it returns
   * strangers' content that is indistinguishable from your own. If the
   * seed data only matched Alice's rows, an entirely unscoped
   * implementation (`WHERE search_vector @@ query`, no user_id at all)
   * would pass this suite — so the pre-condition below asserts that the
   * query really is ambiguous before the scoping assertion means
   * anything.
   */
  it("never returns another user's devotionals for a query that matches both", async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    const bob = await createUser(BOB_UID, 'bob@example.com');

    await seedDevotional(alice, {
      date: '2026-06-01',
      theme: 'Rest for the weary',
      usfm: 'MAT.11.28',
      body: 'Alice: laying down burdens and finding stillness.',
      cardSummary: 'Alice finding rest',
    });
    await seedDevotional(bob, {
      date: '2026-06-02',
      theme: 'Rest and renewal',
      usfm: 'PSA.62.5',
      body: 'Bob: a private meditation on rest.',
      cardSummary: 'Bob finding rest',
    });

    // Pre-condition: "rest" is genuinely ambiguous across both users at
    // the SQL level. Without this, the assertion below could pass simply
    // because Bob had nothing to match.
    const unscoped = await pool.query<{ count: string }>(
      `SELECT count(*) FROM devotionals WHERE search_vector @@ plainto_tsquery('english', 'rest')`,
    );
    expect(Number(unscoped.rows[0]!.count)).toBe(2);

    const res = await search(ALICE_UID, 'q=rest');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { theme: string; cardSummary: string }[] };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.theme).toBe('Rest for the weary');

    // Belt and braces: nothing of Bob's anywhere in the serialized
    // response, not merely absent from the field we happened to check.
    expect(res.body).not.toContain('Bob');
    expect(res.body).not.toContain('renewal');
  });

  it("does not leak another user's devotionals via a forged cursor", async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    const bob = await createUser(BOB_UID, 'bob@example.com');

    await seedDevotional(alice, {
      date: '2026-06-01',
      theme: 'Rest for the weary',
      usfm: 'MAT.11.28',
      body: 'Alice on rest.',
      cardSummary: 'Alice card',
    });
    await seedDevotional(bob, {
      date: '2026-06-02',
      theme: 'Rest and renewal',
      usfm: 'PSA.62.5',
      body: 'Bob on rest.',
      cardSummary: 'Bob card',
    });

    const bobRow = await pool.query<{ id: string }>(
      `SELECT id FROM devotionals WHERE user_id = $1`,
      [bob],
    );

    // A cursor naming Bob's devotional id, presented by Alice. The
    // cursor only narrows an already-owner-scoped set, so the worst it
    // can do is position a page within Alice's own results.
    const forged = Buffer.from(
      JSON.stringify({ r: '1.0', d: '2026-06-02', i: bobRow.rows[0]!.id }),
      'utf8',
    ).toString('base64url');

    const res = await search(ALICE_UID, `q=rest&cursor=${forged}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Bob');
  });
});

describe('GET /v1/devotionals/search — matching', () => {
  let alice: string;

  beforeEach(async () => {
    alice = await createUser(ALICE_UID, 'alice@example.com');
    await seedDevotional(alice, {
      date: '2026-06-01',
      theme: 'Rest for the weary',
      usfm: 'PSA.62.1',
      // Deliberately avoids "stillness": the English stemmer collapses it
      // with "stilling" from the other row's card summary, which would
      // make the card-summary test below ambiguous rather than wrong.
      body: 'A meditation on laying down burdens and finding quiet.',
      cardSummary: 'Finding rest in God alone',
    });
    await seedDevotional(alice, {
      date: '2026-06-02',
      theme: 'Courage in the storm',
      usfm: 'MRK.4.39',
      body: 'The disciples were afraid when the squall rose.',
      cardSummary: 'Stilling the storm',
    });
  });

  it('matches on theme', async () => {
    const res = await search(ALICE_UID, 'q=courage');
    const body = res.json() as { data: { theme: string }[] };
    expect(body.data.map((d) => d.theme)).toEqual(['Courage in the storm']);
  });

  it('matches on card summary', async () => {
    const res = await search(ALICE_UID, 'q=stilling');
    const body = res.json() as { data: { theme: string }[] };
    expect(body.data.map((d) => d.theme)).toEqual(['Courage in the storm']);
  });

  it('matches on devotional body', async () => {
    const res = await search(ALICE_UID, 'q=burdens');
    const body = res.json() as { data: { theme: string }[] };
    expect(body.data.map((d) => d.theme)).toEqual(['Rest for the weary']);
  });

  /**
   * Issue #242's own worked example, and the case that silently fails on
   * the obvious implementation.
   *
   * `verses` stores `PSA.62.1`, which the text search parser treats as
   * one opaque token — `to_tsvector('english','PSA.62.1')` is
   * `'psa.62.1'`, and `plainto_tsquery('english','Psalm 62')` is
   * `'psalm' & '62'`. Those never match. Migration 1722000000000 expands
   * the reference to "Psalms 62 PSA.62.1" before indexing, and the
   * English stemmer collapses Psalms/Psalm. Indexing `verses` raw would
   * pass every other test in this file and fail this one.
   */
  it('matches a Scripture reference typed the way a person writes it ("Psalm 62")', async () => {
    const res = await search(ALICE_UID, 'q=Psalm+62');
    const body = res.json() as { data: { theme: string }[] };
    expect(body.data.map((d) => d.theme)).toEqual(['Rest for the weary']);
  });

  it('matches a book name on its own', async () => {
    const res = await search(ALICE_UID, 'q=Mark');
    const body = res.json() as { data: { theme: string }[] };
    expect(body.data.map((d) => d.theme)).toEqual(['Courage in the storm']);
  });

  it('matches a verbatim usfm reference', async () => {
    const res = await search(ALICE_UID, 'q=PSA.62.1');
    const body = res.json() as { data: { theme: string }[] };
    expect(body.data.map((d) => d.theme)).toEqual(['Rest for the weary']);
  });

  it('returns an empty list (not an error) when nothing matches', async () => {
    const res = await search(ALICE_UID, 'q=xyzzy');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; nextCursor: string | null };
    expect(body.data).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  /**
   * `plainto_tsquery` treats operator characters as data. `to_tsquery`
   * would raise a syntax error on this input and turn an ordinary user
   * typo into a 500.
   */
  it('treats query punctuation as text rather than tsquery syntax', async () => {
    for (const q of ['rest+%26+renewal', 'rest+%7C+storm', '%21%21%21', 'rest%3A*', '((']) {
      const res = await search(ALICE_UID, `q=${q}`);
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('GET /v1/devotionals/search — ranking and projection', () => {
  it('ranks a theme match above a body-only match for the same term', async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    // Body-only match, and the MORE RECENT of the two — so if ranking
    // were ignored and this were ordered by date alone, it would come
    // first. It must not.
    await seedDevotional(alice, {
      date: '2026-06-10',
      theme: 'Courage in the storm',
      usfm: 'MRK.4.39',
      body: 'They had no rest that night, and the wind rose against them.',
      cardSummary: 'Stilling the storm',
    });
    await seedDevotional(alice, {
      date: '2026-06-01',
      theme: 'Rest for the weary',
      usfm: 'MAT.11.28',
      body: 'A meditation on laying down burdens.',
      cardSummary: 'Finding stillness',
    });

    const res = await search(ALICE_UID, 'q=rest');
    const body = res.json() as { data: { theme: string }[] };
    expect(body.data.map((d) => d.theme)).toEqual([
      'Rest for the weary',
      'Courage in the storm',
    ]);
  });

  it('breaks a relevance tie by recency, newest first', async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    // Identical searchable content, different dates -> identical rank.
    for (const date of ['2026-06-01', '2026-06-03', '2026-06-02']) {
      await seedDevotional(alice, {
        date,
        theme: 'Rest for the weary',
        usfm: 'MAT.11.28',
        body: 'A meditation on laying down burdens.',
        cardSummary: 'Finding rest',
      });
    }

    const res = await search(ALICE_UID, 'q=rest');
    const body = res.json() as { data: { date: string }[] };
    expect(body.data.map((d) => d.date)).toEqual(['2026-06-03', '2026-06-02', '2026-06-01']);
  });

  /**
   * Issue #236 requires result rows to render identically to history
   * rows, and #242 explicitly forbids bodies.
   *
   * Validated against `DevotionalCardSchema` — the history list's own
   * contract — rather than a hand-copied key list, so the two cannot
   * drift: `.strict()` makes an extra field fail, and the schema itself
   * makes a missing one fail. A literal key array would have to be
   * updated by hand every time the card changes, which is exactly the
   * kind of assertion that gets updated to match a regression.
   */
  it('returns exactly the history card shape and never the devotional body', async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    await seedDevotional(alice, {
      date: '2026-06-01',
      theme: 'Rest for the weary',
      usfm: 'MAT.11.28',
      body: 'SECRET-BODY-TEXT that must never reach a search result.',
      cardSummary: 'Finding rest',
    });

    const res = await search(ALICE_UID, 'q=rest');
    const body = res.json() as { data: unknown[] };

    const parsed = DevotionalCardSchema.strict().safeParse(body.data[0]);
    expect(parsed.success ? null : parsed.error.issues, 'search card must match DevotionalCardSchema exactly').toBeNull();

    expect(res.body).not.toContain('SECRET-BODY-TEXT');
    // The body is searchable but not returned — proving the omission is
    // a projection choice, not an indexing gap.
    const hit = await search(ALICE_UID, 'q=SECRET-BODY-TEXT');
    expect((hit.json() as { data: unknown[] }).data).toHaveLength(1);
  });

  /**
   * The reconciliation #236 turns on: a devotional the user actually sat
   * with must read as completed in search results, not merely
   * "unknown". `completed_at` is joined from `sessions`, so it is the one
   * card field that could plausibly have been dropped from the search
   * projection — and a client rendering a false "not completed" badge on
   * a devotional the user finished is precisely the small lie Epic L's
   * ground rules forbid.
   */
  it('reports completion state, so a finished devotional does not read as unfinished', async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    await seedDevotional(alice, {
      date: '2026-06-01',
      theme: 'Rest for the weary',
      usfm: 'MAT.11.28',
      body: 'A meditation.',
      cardSummary: 'Completed one',
    });
    await seedDevotional(alice, {
      date: '2026-06-02',
      theme: 'Rest renewed',
      usfm: 'MAT.11.28',
      body: 'A meditation.',
      cardSummary: 'Untouched one',
    });

    const rows = await pool.query<{ id: string; card_summary: string }>(
      `SELECT id, card_summary FROM devotionals WHERE user_id = $1`,
      [alice],
    );
    const completed = rows.rows.find((r) => r.card_summary === 'Completed one')!;
    await pool.query(
      `INSERT INTO sessions (devotional_id, user_id, expires_at, completed_at)
       VALUES ($1, $2, now() + interval '2 days', now())`,
      [completed.id, alice],
    );

    const res = await search(ALICE_UID, 'q=rest');
    const body = res.json() as { data: { cardSummary: string; completedAt: string | null }[] };

    const byCard = new Map(body.data.map((c) => [c.cardSummary, c.completedAt]));
    expect(byCard.get('Completed one')).toEqual(expect.any(String));
    // Genuinely null — "we asked and there is no completed session" —
    // rather than the field being absent, which is the ambiguity the
    // join exists to remove.
    expect(byCard.get('Untouched one')).toBeNull();
  });
});

describe('GET /v1/devotionals/search — pagination', () => {
  it('walks every result exactly once across pages, with no repeats or gaps', async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    // Identical rank across all 7 so paging is driven entirely by the
    // (date, id) tie-break — the boundary case a rank-only cursor would
    // get wrong.
    for (let i = 0; i < 7; i += 1) {
      await seedDevotional(alice, {
        date: `2026-06-0${i + 1}`,
        theme: 'Rest for the weary',
        usfm: 'MAT.11.28',
        body: 'A meditation on laying down burdens.',
        cardSummary: `Card ${i}`,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const qs: string = cursor ? `q=rest&limit=3&cursor=${cursor}` : 'q=rest&limit=3';
      const res = await search(ALICE_UID, qs);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: { id: string }[]; nextCursor: string | null };
      seen.push(...body.data.map((d) => d.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(cursor).toBeNull();
  });

  /**
   * The cap is MAX_LIMIT (100), matching the history list's
   * `DEVOTIONAL_PAGE_SIZE_MAX` — seeds past it so the assertion exercises
   * the clamp rather than simply running out of rows.
   */
  it('caps an oversized limit rather than returning the whole history', async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    // Bulk-inserted: 110 repository round-trips is slow and this test
    // cares only about the row count, not how the rows were written.
    await pool.query(
      `INSERT INTO devotionals (user_id, date, format, theme, verses, devotional_body, card_summary, prayer)
       SELECT $1, DATE '2026-01-01' + g, 'short', 'Rest for the weary',
              '[{"usfm":"MAT.11.28","versionId":3034}]'::jsonb,
              'A meditation.', 'Card ' || g, 'Amen'
         FROM generate_series(1, 110) g`,
      [alice],
    );

    const res = await search(ALICE_UID, 'q=rest&limit=5000');
    const body = res.json() as { data: unknown[]; nextCursor: string | null };
    expect(body.data).toHaveLength(100);
    // Capped, not exhausted — there are 10 more rows behind the cursor.
    expect(body.nextCursor).not.toBeNull();
  });

  it('ignores a malformed cursor instead of erroring', async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    await seedDevotional(alice, {
      date: '2026-06-01',
      theme: 'Rest for the weary',
      usfm: 'MAT.11.28',
      body: 'A meditation.',
      cardSummary: 'Finding rest',
    });

    for (const c of ['not-base64!!', 'eyJib2d1cyI6dHJ1ZX0', "'; DROP TABLE devotionals; --"]) {
      const res = await search(ALICE_UID, `q=rest&cursor=${encodeURIComponent(c)}`);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { data: unknown[] }).data).toHaveLength(1);
    }
  });
});

describe('GET /v1/devotionals/search — validation', () => {
  beforeEach(async () => {
    await createUser(ALICE_UID, 'alice@example.com');
  });

  it('rejects a missing q with 400', async () => {
    expect((await search(ALICE_UID, '')).statusCode).toBe(400);
  });

  it('rejects a blank/whitespace q with 400', async () => {
    expect((await search(ALICE_UID, 'q=')).statusCode).toBe(400);
    expect((await search(ALICE_UID, 'q=%20%20%20')).statusCode).toBe(400);
  });

  it('rejects an over-long q with 400', async () => {
    expect((await search(ALICE_UID, `q=${'a'.repeat(201)}`)).statusCode).toBe(400);
  });
});

describe('devotionals search index (issue #242 acceptance: EXPLAIN, not vibes)', () => {
  /**
   * A full-text search with no usable index passes every functional test
   * above at 10 rows and degrades linearly with the user's history. This
   * asserts the degradation cannot happen — but only at the scale where
   * it is actually a degradation, which took measuring to establish.
   *
   * ## Why the seed is this big (measured, not guessed)
   *
   * The first version of this test seeded 4,000 rows for the searching
   * user. It passed on PG14 and failed on PG16 (CI), which looked like a
   * bad index and was really a bad seed: **4,000 rows is the crossover
   * point**, where btree-then-recheck and the GIN index cost almost
   * exactly the same, so the planner's choice flips on version, on
   * statistics, and on how many rows the term matches.
   *
   * Measured on PG16.14, this query shape, warm cache:
   *
   *   user rows | planner picks | exec
   *   ----------|---------------|------
   *      1,000  | btree         | 0.49ms   (GIN not attractive at all —
   *      2,000  | btree         | 1.64ms    hiding btree gives Seq Scan)
   *      4,000  | *flips*       | 1.7-3.6ms (crossover — do not test here)
   *      8,000  | GIN           | 0.63ms
   *     16,000  | GIN           | 1.15ms
   *
   * Below the crossover the planner is RIGHT to ignore the GIN index and
   * this test would be asserting that it makes a bad choice. Above it,
   * GIN wins decisively — note 8,000 rows via GIN (0.63ms) beats 4,000
   * rows via btree (3.57ms), i.e. the indexed path at twice the history
   * is 5.6x faster than the unindexed one.
   *
   * So the seed is 40,000 rows / 8,000 for the searching user: past the
   * crossover with margin, verified stable 5/5 across re-seed+ANALYZE on
   * PG16 and also correct on PG14, so this is not version-locked in
   * either direction.
   *
   * ## Why the index is still worth having
   *
   * 8,000 devotionals is roughly a decade of daily use, and a realistic
   * two-year user holds ~700-1,400 — below the crossover, where btree is
   * optimal and this index simply goes unused. It is not carrying
   * today's load; it is what stops per-search cost growing with history
   * for the users who stay longest, which are the users least acceptable
   * to degrade. Its cost is near zero: GIN trades write speed for read
   * speed, and devotionals are written once or twice per user per day.
   *
   * Even at the crossover the *work* differs sharply — at 4,000 rows
   * btree touched 1,112 heap blocks and discarded 3,960 rows, GIN
   * touched 40 and discarded none. Warm-cache timings hide that; a cold
   * buffer pool on Cloud SQL would not.
   *
   * ## Two properties of the seed shape are load-bearing
   *
   * 1. Rows are INTERLEAVED between users (every 5th is the searcher's)
   *    rather than inserted one user at a time. Contiguous insertion
   *    leaves each user's rows physically clustered, which makes a btree
   *    scan look almost sequential and cheap. Production rows are
   *    written per-user per-day across the whole base, so interleaving
   *    is both realistic and the honest comparison.
   * 2. The term stays RARE (1 in 500). A term matching a large fraction
   *    of the table makes a sequential scan genuinely cheaper, and the
   *    test would again be demanding a bad choice.
   *
   * Deliberately does NOT set `enable_seqscan = off` or force the
   * planner's hand: that proves the index is *usable*, not that it is
   * *used*, and only the latter matters in production.
   */
  it('uses the composite GIN index for an owner-scoped search', async () => {
    const alice = await createUser(ALICE_UID, 'alice@example.com');
    const other = await createUser(BOB_UID, 'bob@example.com');

    // Bulk-inserted in one statement: 40,000 repository round-trips would
    // take minutes, and the generated column is maintained by Postgres
    // regardless of how the row arrives.
    await pool.query(
      `INSERT INTO devotionals (user_id, date, format, theme, verses, devotional_body, card_summary, prayer)
       SELECT CASE WHEN g % 5 = 0 THEN $1::uuid ELSE $2::uuid END,
              DATE '2020-01-01' + (g % 1800), 'short', 'Ordinary theme ' || g,
              '[{"usfm":"ROM.8.28","versionId":3034}]'::jsonb,
              CASE WHEN g % 500 = 0
                   THEN 'A rare meditation on sabbath keeping.'
                   ELSE 'Generic reflection ' || g || ' on faith and daily practice.' END,
              'Card ' || g, 'Amen'
         FROM generate_series(1, 40000) g`,
      [alice, other],
    );
    await pool.query('ANALYZE devotionals');

    // ANALYZE (not bare EXPLAIN) so the second assertion below can read
    // actual work done rather than estimates. EXPLAINs the exact string
    // `searchForUser` executes — see DEVOTIONAL_SEARCH_SQL's docstring.
    const explain = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${DEVOTIONAL_SEARCH_SQL}`,
      [alice, 'sabbath', null, null, null, 20],
    );
    const plan = explain.rows.map((r) => r['QUERY PLAN']).join('\n');

    // (1) Mechanism: the composite index serves BOTH predicates.
    // `(user_id, search_vector)` rather than `search_vector` alone is
    // what keeps the scan proportional to the searching user's own
    // history rather than the whole table — see migration 1722000000000.
    expect(plan, `plan was:\n${plan}`).toContain('devotionals_user_search_vector_idx');
    expect(plan, `plan was:\n${plan}`).toMatch(/Index Cond:.*user_id/s);
    expect(plan, `plan was:\n${plan}`).toMatch(/Index Cond:.*search_vector/s);

    // (2) Outcome: the work done is proportional to MATCHES, not to the
    // user's history. This is the assertion that actually encodes the
    // bug — a btree-then-recheck plan reads all ~8,000 of the user's
    // rows and throws away the ~7,980 that do not match, which shows up
    // here as a large "Rows Removed by Filter". The GIN plan removes
    // none because the index already answered the predicate.
    //
    // Deliberately not `expect(plan).not.toContain('Seq Scan')`: that
    // would pass on the exact btree degradation this index exists to
    // prevent, i.e. it is a test that survives its own bug. Unlike the
    // index-name check above, this one is phrased in work rather than in
    // plan-node names, so it stays meaningful if a future planner finds
    // some third way to answer the query.
    const removed = [...plan.matchAll(/Rows Removed by Filter: (\d+)/g)].map((m) => Number(m[1]));
    const worstFilter = removed.length > 0 ? Math.max(...removed) : 0;
    expect(worstFilter, `plan discarded ${worstFilter} rows after reading them:\n${plan}`)
      .toBeLessThan(100);
    // Explicit budget: seeding 40k rows and ANALYZEing them far exceeds
    // vitest's 5s default. The row count is not padding — see the header
    // for the measurements that set it.
  }, 120_000);
});
