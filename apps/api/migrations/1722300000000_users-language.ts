import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Epic O (kairos-devotional #311), story O2 (#314) — the devotional
 * content language, stored per user.
 *
 * ## What this column is
 *
 * A BCP-47 primary-language subtag (`'en' | 'es' | 'fr' | 'de' | 'pt' |
 * 'zh'`), validated on write by `LanguageTagSchema` (shared-contracts
 * `language.ts`). It is the single choice that Epic O fans out into three
 * consumers: which YouVersion translation is fetched (O3), which language
 * the Gloo prose is written in (O3), and which Cloud TTS locale speaks it
 * (O4). Users pick a *language*, not a region — the one consumer that
 * needs a region (TTS) derives it from the shared catalog, where the
 * `zh→cmn-CN` trap is pinned so it cannot be re-derived wrong (#311
 * decision 1/4).
 *
 * ## Why `text` and not a Postgres enum
 *
 * Same posture as `stillness`/`cadence` (and unlike `tradition`, the one
 * enum this schema has and has once already had to ALTER — migration
 * 1721400000000): the licensed-language set is expected to grow as
 * YouVersion licensing expands (O7's API-driven catalog is the declared
 * v2 path), and an ALTER TYPE per language buys nothing the
 * shared-contracts enum at the API door doesn't already provide.
 *
 * ## Why existing rows are backfilled to 'en' (via the default)
 *
 * Unlike `onboarded_at`'s deliberate NULL, there is no epistemic modesty
 * available here: every existing user's devotionals have in fact been
 * English — the instructions builder frames prose in English, TTS is
 * pinned to `en-US`, and `translation_id` defaults to BSB 3034. `'en'` is
 * not a guess about them, it is the recorded truth of what they have been
 * receiving, and it keeps their `translation_id` consistent with their
 * language from day one (#314 acceptance: existing rows read back
 * `language='en'`, `translation_id` unchanged).
 *
 * ## Down
 *
 * Drops the column. Safe in the usual asymmetric way: the pre-Epic-O
 * pipeline never reads it, so a rollback degrades to exactly today's
 * all-English behavior.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('users', {
    language: {
      type: 'text',
      notNull: true,
      default: 'en',
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('users', 'language');
}
