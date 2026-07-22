import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Issue #242 (Epic L, #236) — full-text search across a user's own past
 * devotionals.
 *
 * "There was one about rest, a few weeks ago" is how people actually
 * recall a devotional, so `GET /v1/devotionals/search?q=` has to search
 * the words a person remembers: the theme, the card summary, the body,
 * and the Scripture reference.
 *
 * ## Why a STORED generated column and not an expression index
 *
 * An expression index (`CREATE INDEX ... USING gin (to_tsvector(...))`)
 * would avoid the on-disk column, but it only gets used when the query's
 * expression matches the index's expression *character for character*.
 * That couples every future caller to an exact 4-way concatenation with
 * exact `setweight` calls and exact `coalesce` order — reword any of it
 * at the call site and Postgres silently falls back to a sequential
 * scan. That is the failure mode issue #242's acceptance criterion
 * ("query uses the index — EXPLAIN in the PR, not vibes") exists to
 * catch, and it is invisible at the 10-row scale of a test suite.
 *
 * A generated column moves that expression into the schema exactly once.
 * Callers say `search_vector @@ query`, which cannot drift, and the
 * weights stay a property of the data rather than a convention every
 * query author has to reproduce from memory.
 *
 * Postgres requires generated-column expressions to be IMMUTABLE, which
 * is why `to_tsvector` is called with an explicit `'english'` regconfig
 * below (the one-argument form depends on `default_text_search_config`
 * and is only STABLE) and why the helper function is declared IMMUTABLE.
 *
 * ## Why the Scripture reference needs a lookup function at all
 *
 * This is the non-obvious part, and getting it wrong produces a search
 * that passes a naive test and still fails the issue's own example.
 *
 * `devotionals.verses` is a JSONB array of `{usfm, versionId,
 * fetchedText, attribution}` (see migration 1720000000000), and `usfm`
 * holds machine references like `PSA.62.1` or `LAM.3.22-LAM.3.23`. The
 * text search parser treats `PSA.62.1` as a single indivisible token:
 *
 *     to_tsvector('english', 'PSA.62.1')      -> 'psa.62.1':1
 *     plainto_tsquery('english', 'Psalm 62')  -> 'psalm' & '62'
 *
 * Those never match. Indexing `verses` raw — the obvious implementation
 * — would mean a user searching "Psalm 62" gets nothing back while the
 * devotional they are looking for sits in the table, and every test
 * written with a `usfm`-shaped query string would still pass. The issue
 * calls this out explicitly ("searching 'Psalm 62' should hit"), so the
 * reference has to be expanded into human words *before* it reaches
 * `to_tsvector`.
 *
 * `devotional_scripture_search_text` does that expansion: for each verse
 * it emits the book's English name, the chapter number, and the original
 * usfm string. "PSA.62.1" becomes "Psalms 62 PSA.62.1", which tokenizes
 * to 'psalm' + '62' + 'psa.62.1' — so "Psalm 62", "Psalms", "62" and a
 * verbatim usfm paste all hit. The English stemmer collapses
 * Psalms/Psalm, so only one spelling needs storing.
 *
 * Alternate titles are emitted only where a book is genuinely known by
 * two names in common use (Song of Songs / Song of Solomon, Sirach /
 * Ecclesiasticus). Deliberately NOT emitted: ordinal-word spellings
 * ("First Corinthians" alongside "1 Corinthians"). That is recall
 * tuning, and issue #242 is explicit that fuzzy matching and query
 * expansion are post-validation polish — the numeral form is how these
 * books are written in practice, and adding the words later is a
 * one-line change to this map plus a column rebuild.
 *
 * The deuterocanonical codes are included because the tradition
 * preference already supports Anglican and Orthodox (migration
 * 1721400000000), so those books can legitimately appear in `verses`.
 * An unknown code degrades gracefully — the chapter and raw usfm are
 * still indexed, only the English book name is missing.
 *
 * ## Why these weights
 *
 * `setweight` A/B/C rather than a flat vector, because the fields differ
 * sharply in how strongly a match in them signals relevance. A hit in
 * the theme ("Rest for the weary") or the Scripture reference is what
 * the person is actually reaching for; a hit in the card summary is a
 * good signal; the same word buried in a 600-word body is the weakest
 * evidence and would otherwise let one long devotional that mentions
 * "rest" in passing outrank the one actually *about* rest. `ts_rank`'s
 * default weights {D,C,B,A} = {0.1, 0.2, 0.4, 1.0} apply.
 *
 * `prayer`, `journaling_prompt` and `action_step` are deliberately left
 * out. They are the response-side of a devotional rather than the part a
 * person recalls it by, and including them mostly adds near-duplicate
 * body language that dilutes ranking.
 *
 * ## Why GIN and not GiST
 *
 * GIN is the standard choice for a static-ish document set that is read
 * far more than written: lookups are substantially faster, at the cost
 * of slower inserts and a larger index. Devotionals are written at most
 * a couple of times per user per day and searched interactively, so that
 * trade is entirely one-sided here.
 *
 * The index is `(user_id, search_vector)` via `btree_gin`, not
 * `search_vector` alone. Every search is owner-scoped — `WHERE user_id =
 * $1 AND search_vector @@ ...` (Foundation §10) — and a single-column
 * text index makes Postgres match the query term across *every* user's
 * devotionals and then discard the ones that fail the `user_id` filter.
 * That is correct but backwards: it does the expensive work on the whole
 * table and the cheap selective work last, and it degrades as the table
 * grows with other users' rows. Leading with `user_id` keeps the scan
 * proportional to the searching user's own history, which is the only
 * thing that should ever bound it.
 *
 * ## When this index actually earns its keep (measured, PG16.14)
 *
 * Worth being honest about, because for most users today it does
 * nothing. `devotionals` already has a btree on `user_id`, and for a
 * short history Postgres correctly prefers it: read the user's rows,
 * recheck the tsvector, done. Measured crossover for this query shape:
 *
 *   ~1-2k rows/user -> btree wins; GIN is not even attractive
 *   ~4k rows/user   -> costs are within noise; the planner flips on
 *                      version and statistics (PG14 chose GIN, PG16
 *                      chose btree — this cost a CI failure to learn)
 *   ~8k+ rows/user  -> GIN wins clearly: 0.63ms vs 3.57ms for btree at
 *                      *half* that history
 *
 * A realistic two-year user holds ~700-1,400 devotionals, i.e. below the
 * crossover, where this index is simply unused. It is not carrying
 * today's load. What it buys is that per-search cost stops growing with
 * history for the users who stay longest — the ones least acceptable to
 * degrade — and it buys that almost for free, because GIN's tradeoff is
 * slower writes for faster reads and devotionals are written once or
 * twice per user per day.
 *
 * The I/O gap is wider than the warm-cache timings suggest: at 4k rows
 * the btree plan touched 1,112 heap blocks and discarded 3,960 rows,
 * against 40 blocks and no discards for GIN. That 28x difference is
 * invisible when the buffer pool is warm and decisive when it is not.
 *
 * ## Backfill
 *
 * None needed, and none possible to get wrong: a STORED generated column
 * is computed for every existing row when the column is added, and
 * maintained by Postgres on every subsequent write. There is no
 * trigger to forget and no application code that can skip it.
 *
 * ## Down
 *
 * Drops the index, the column, then the function — in that order,
 * because the column depends on the function and the index on the
 * column. Reverts to no search, which is the pre-#242 state.
 */

/**
 * USFM book code -> English name(s) to index.
 *
 * Kept as a TS map purely for readability; it is inlined into an
 * immutable SQL CASE below. Values are the words a person would type,
 * not display strings.
 */
const USFM_BOOK_NAMES: Record<string, string> = {
  // --- Old Testament ---
  GEN: 'Genesis',
  EXO: 'Exodus',
  LEV: 'Leviticus',
  NUM: 'Numbers',
  DEU: 'Deuteronomy',
  JOS: 'Joshua',
  JDG: 'Judges',
  RUT: 'Ruth',
  '1SA': '1 Samuel',
  '2SA': '2 Samuel',
  '1KI': '1 Kings',
  '2KI': '2 Kings',
  '1CH': '1 Chronicles',
  '2CH': '2 Chronicles',
  EZR: 'Ezra',
  NEH: 'Nehemiah',
  EST: 'Esther',
  JOB: 'Job',
  PSA: 'Psalms',
  PRO: 'Proverbs',
  ECC: 'Ecclesiastes',
  // Two titles in genuinely common use — both indexed (see header).
  SNG: 'Song of Songs Song of Solomon',
  ISA: 'Isaiah',
  JER: 'Jeremiah',
  LAM: 'Lamentations',
  EZK: 'Ezekiel',
  DAN: 'Daniel',
  HOS: 'Hosea',
  JOL: 'Joel',
  AMO: 'Amos',
  OBA: 'Obadiah',
  JON: 'Jonah',
  MIC: 'Micah',
  NAM: 'Nahum',
  HAB: 'Habakkuk',
  ZEP: 'Zephaniah',
  HAG: 'Haggai',
  ZEC: 'Zechariah',
  MAL: 'Malachi',
  // --- New Testament ---
  MAT: 'Matthew',
  MRK: 'Mark',
  LUK: 'Luke',
  JHN: 'John',
  ACT: 'Acts',
  ROM: 'Romans',
  '1CO': '1 Corinthians',
  '2CO': '2 Corinthians',
  GAL: 'Galatians',
  EPH: 'Ephesians',
  PHP: 'Philippians',
  COL: 'Colossians',
  '1TH': '1 Thessalonians',
  '2TH': '2 Thessalonians',
  '1TI': '1 Timothy',
  '2TI': '2 Timothy',
  TIT: 'Titus',
  PHM: 'Philemon',
  HEB: 'Hebrews',
  JAS: 'James',
  '1PE': '1 Peter',
  '2PE': '2 Peter',
  '1JN': '1 John',
  '2JN': '2 John',
  '3JN': '3 John',
  JUD: 'Jude',
  REV: 'Revelation',
  // --- Deuterocanon (Anglican / Orthodox traditions, migration 1721400000000) ---
  TOB: 'Tobit',
  JDT: 'Judith',
  WIS: 'Wisdom of Solomon',
  SIR: 'Sirach Ecclesiasticus',
  BAR: 'Baruch',
  '1MA': '1 Maccabees',
  '2MA': '2 Maccabees',
  '1ES': '1 Esdras',
  '2ES': '2 Esdras',
  MAN: 'Prayer of Manasseh',
  SUS: 'Susanna',
  BEL: 'Bel and the Dragon',
};

/** Renders the book map as a SQL `CASE` over the upper-cased book code. */
function bookNameCaseSql(): string {
  const whens = Object.entries(USFM_BOOK_NAMES)
    // Values are repo-authored constants above, never user input, but they
    // still go through quote-doubling so an apostrophe added to this map
    // later (e.g. a title with one) cannot break the function body.
    .map(([code, name]) => `      WHEN '${code}' THEN '${name.replace(/'/g, "''")}'`)
    .join('\n');
  return `CASE upper(split_part(verse_usfm, '.', 1))\n${whens}\n      ELSE ''\n    END`;
}

export async function up(pgm: MigrationBuilder): Promise<void> {
  // btree_gin lets a plain btree-typed column (user_id uuid) sit in the
  // same GIN index as the tsvector. Without it the composite index below
  // cannot be created — GIN has no native uuid opclass.
  pgm.createExtension('btree_gin', { ifNotExists: true });

  // STRICT: a NULL `verses` yields NULL rather than executing the body.
  // The column is NOT NULL with a '[]' default so this should not arise,
  // but the generated expression coalesces anyway (below).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION devotional_scripture_search_text(verses jsonb)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    STRICT
    PARALLEL SAFE
    AS $fn$
      SELECT CASE
        -- Guard rather than let jsonb_array_elements raise: this function
        -- backs a generated column, so an exception here would reject the
        -- INSERT itself and take devotional creation down with it.
        WHEN jsonb_typeof(verses) <> 'array' THEN ''
        ELSE coalesce(
          (
            SELECT string_agg(
              -- concat_ws skips NULLs, so an unknown book code (empty
              -- name -> NULL via nullif) degrades to "chapter + usfm"
              -- instead of leaving a stray separator.
              concat_ws(' ',
                nullif(${bookNameCaseSql()}, ''),
                nullif(split_part(verse_usfm, '.', 2), ''),
                verse_usfm
              ),
              ' '
            )
            FROM (
              SELECT element->>'usfm' AS verse_usfm
              FROM jsonb_array_elements(verses) AS element
            ) AS refs
            WHERE verse_usfm IS NOT NULL AND verse_usfm <> ''
          ),
          ''
        )
      END;
    $fn$;
  `);

  pgm.sql(`
    ALTER TABLE devotionals
      ADD COLUMN search_vector tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(theme, '')), 'A') ||
        setweight(to_tsvector('english', devotional_scripture_search_text(coalesce(verses, '[]'::jsonb))), 'A') ||
        setweight(to_tsvector('english', coalesce(card_summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(devotional_body, '')), 'C')
      ) STORED;
  `);

  pgm.sql(`
    CREATE INDEX devotionals_user_search_vector_idx
      ON devotionals USING gin (user_id, search_vector);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP INDEX IF EXISTS devotionals_user_search_vector_idx;`);
  pgm.sql(`ALTER TABLE devotionals DROP COLUMN IF EXISTS search_vector;`);
  pgm.sql(`DROP FUNCTION IF EXISTS devotional_scripture_search_text(jsonb);`);
  // btree_gin is left installed: other indexes may come to rely on it and
  // dropping an extension is not safely reversible mid-rollback.
}
