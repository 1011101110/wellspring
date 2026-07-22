import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Normalizes `preferences.cadence` to the label its `active_days` actually
 * describes — K2, issue #188.
 *
 * THE CONTRADICTION. Migration 1720000000000 defaults `cadence` to
 * `'daily'` and `active_days` to `{1,2,3,4,5}`. Every row this project has
 * ever created therefore says "daily" while listing Mon–Fri, and until
 * #188 that was invisible because *neither column was read by anything*
 * (docs/03 §10, issue #193). #188 makes `active_days` the single source of
 * truth for the daily-run fan-out and `cadence` a derived label over the
 * same set; `PUT /v1/preferences` now recomputes the label on every write.
 * This backfills the rows that were written before that rule existed, so
 * the settings screen stops reporting "Daily" to users whose devotionals
 * are, correctly, Mon–Fri.
 *
 * WHY THIS TOUCHES ONLY `cadence`. The tempting symmetric move — widen
 * every default-looking `active_days` to all seven days so nobody loses a
 * weekend devotional on deploy day — is the one #202's migration made for
 * `duration_preference`, and it is right there and wrong here. The two
 * cases differ in whether the user was ever shown the value:
 *
 *   - For `duration_preference`, the iOS default was `auto` while the
 *     column default was `'short'`. The two disagreed, so activating the
 *     column would have delivered something no user had ever chosen or
 *     seen. Backfilling to NULL was behavior-preserving *and*
 *     intent-preserving.
 *   - For `active_days`, the iOS default and the column default **agree**:
 *     Mon–Fri. Onboarding shows the day rows with Mon–Fri switched on and
 *     the user taps "Looks good". Every such user has been told they
 *     picked Mon–Fri and has been quietly receiving Saturday and Sunday
 *     devotionals anyway. Widening to seven days would preserve today's
 *     *behavior* by permanently discarding the only *intent* anyone ever
 *     expressed. Honoring Mon–Fri is not a regression to mitigate; it is
 *     the entire story of #188.
 *
 * So this migration is deliberately display-only: no user's schedule
 * changes because of anything written here. Their schedules change because
 * the daily run now reads the preference they set, which is the point.
 *
 * IDEMPOTENT. Pure function of `active_days`; re-running is a no-op.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Compared as sorted arrays so a set stored in a different order (or with
  // duplicates, which the column does not forbid) still matches its preset.
  // `cadenceForActiveDays` in shared-contracts normalizes identically.
  pgm.sql(`
    UPDATE preferences
    SET cadence = CASE
      WHEN (SELECT array_agg(DISTINCT d ORDER BY d) FROM unnest(active_days) AS d)
             = ARRAY[0,1,2,3,4,5,6]::smallint[] THEN 'daily'
      WHEN (SELECT array_agg(DISTINCT d ORDER BY d) FROM unnest(active_days) AS d)
             = ARRAY[1,2,3,4,5]::smallint[] THEN 'weekdays'
      ELSE 'custom'
    END
  `);
}

/**
 * No down-migration of the *data*: the pre-migration `cadence` values were
 * by definition not derivable from anything (that is why they contradicted
 * `active_days`), so there is nothing to restore them from. Reverting the
 * code that reads `active_days` is sufficient to revert the behavior; a
 * stale-but-consistent label is harmless once nothing consumes either
 * column again. Deliberately a no-op rather than a throw, so an operator
 * rolling back the surrounding batch is not blocked by this step.
 */
export async function down(): Promise<void> {
  // Intentionally empty — see above.
}
