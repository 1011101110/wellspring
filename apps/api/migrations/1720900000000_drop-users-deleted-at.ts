import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * docs/14_IMPROVEMENT_REVIEW.md §4.4 / issue #91: `users.deleted_at`
 * (migrations/1720000000000_init-schema.ts) was added as a "nullable
 * soft-marker for in-flight purge jobs", but no code anywhere ever sets it
 * — `UsersRepository.hardDelete` is a real `DELETE FROM users`, which
 * cascades to every other table via FK `ON DELETE CASCADE`. Every read
 * method filters on `deleted_at IS NULL`, which was always true for every
 * row, since nothing ever wrote a non-null value. A vestigial column that
 * looks load-bearing but isn't; dropping it removes a false signal that
 * account deletion is (or ever was) soft.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('users', 'deleted_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('users', {
    deleted_at: { type: 'timestamptz' },
  });
}
