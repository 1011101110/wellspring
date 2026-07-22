import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Makes `preferences.duration_preference` nullable so that NULL can mean
 * "auto" — issue #202, prerequisite for actually honoring the column.
 *
 * THE PROBLEM. docs/05_UX_FLOWS.md §5 offers "auto / 2 / 5 / 10 / 15 min" and
 * the iOS picker's default is `.auto` (OnboardingPreferences.swift). The column
 * is `devotional_format NOT NULL DEFAULT 'short'` (migration 1720000000000) and
 * the enum has no `auto` member, so "auto" has never been representable
 * server-side. iOS papers over it by omitting the field from the PUT payload
 * when the user picks auto (HTTPPreferencesClient.swift:161), which — combined
 * with `PreferencesRepository.update`'s COALESCE — means "auto" is silently
 * stored as whatever the column already held.
 *
 * That was harmless while nothing read the column. #202 wires it into
 * `resolveTargetFormat`, and the harm is immediate: every user still sitting on
 * the `'short'` default would start receiving 5-minute devotionals, and the
 * band heuristic — which is what "auto" means, and what every user experiences
 * today — would be dead for the entire user base. Fixing a preference that was
 * ignored by breaking the behavior of everyone who never set it is a worse bug
 * than the one being fixed, and a more demo-visible one.
 *
 * THE BACKFILL, and why it discards data. Every existing `'short'` row is
 * ambiguous: it is either a user who explicitly picked 5 min, or a user who
 * picked auto (or never opened the screen) and got the column default. Nothing
 * distinguishes them. This migration resolves the ambiguity toward auto, for
 * three reasons: (1) auto is the picker's default, so it is the majority
 * intent; (2) iOS's omit-on-auto behavior actively produces `'short'` rows for
 * users who chose auto, so a meaningful share of them are auto; (3) it is the
 * only choice that is behavior-preserving — `duration_preference` has never
 * once influenced a generated devotional, so nulling it changes nothing any
 * user has actually experienced, whereas keeping `'short'` would change the
 * output for nearly everyone on the day this ships. A user who genuinely wanted
 * 5 min was not getting it before this migration either, and re-picks it once.
 *
 * Only rows still at the old default are nulled. `micro`/`standard`/`extended`
 * cannot have come from the column default, so they are unambiguously a
 * deliberate choice and are preserved.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('preferences', 'duration_preference', { notNull: false, default: null });
  pgm.sql(`UPDATE preferences SET duration_preference = NULL WHERE duration_preference = 'short'`);
}

/**
 * Reverting restores the NOT NULL constraint, so the NULLs this migration
 * created (and any written since) must go back to the original `'short'`
 * default first — otherwise the ALTER fails on existing rows.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`UPDATE preferences SET duration_preference = 'short' WHERE duration_preference IS NULL`);
  pgm.alterColumn('preferences', 'duration_preference', { notNull: true, default: 'short' });
}
