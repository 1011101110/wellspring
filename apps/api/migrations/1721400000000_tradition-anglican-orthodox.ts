import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Extend the `tradition` enum with `anglican` and `orthodox` (issue #192 / K6,
 * docs/00_FOUNDATION.md §7).
 *
 * Why these two and no more: Anglican/Episcopal users were being filed under
 * `mainline`, which is defensible but misses the Book of Common Prayer frame —
 * arguably the single most distinctive thing about praying in that tradition.
 * Orthodox had no representation at all, and `general` is a poor fit given a
 * distinct liturgical calendar and a Septuagint-based Old Testament canon.
 * Per #192 the enum is now explicitly CAPPED at six values; further
 * denominational nuance is carried by the existing practice flags
 * (`lectio`, `liturgical_seasons_enabled`, `stillness`, `sabbath_*`) instead.
 *
 * `pgm.noTransaction()` is required. `ALTER TYPE ... ADD VALUE` cannot run
 * inside a transaction block on PostgreSQL before 12, and node-pg-migrate wraps
 * every migration in a transaction by default — so without this the migration
 * fails with "ALTER TYPE ... ADD VALUE cannot run inside a transaction block".
 * PG 12+ relaxed this, but only for values not USED in the same transaction;
 * running outside a transaction is correct on every supported version and costs
 * nothing here, since the two ADD VALUEs are individually atomic and
 * `ifNotExists` makes a partial re-run safe.
 *
 * No `down()` counterpart: PostgreSQL has no `ALTER TYPE ... DROP VALUE`. The
 * only way to remove an enum value is to recreate the type and rewrite every
 * dependent column, which would also have to decide what to do with rows that
 * already chose the value being dropped (silently rewriting a user's stated
 * tradition is not an acceptable automatic migration). Down is therefore an
 * explicit, documented no-op rather than a lie — additive and irreversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();
  pgm.addTypeValue('tradition', 'anglican', { ifNotExists: true });
  pgm.addTypeValue('tradition', 'orthodox', { ifNotExists: true });
}

export async function down(): Promise<void> {
  // Intentionally empty — see the note above: PostgreSQL cannot drop an enum
  // value, and rewriting users who selected 'anglican'/'orthodox' onto some
  // other tradition is not a decision a migration may make silently.
}
