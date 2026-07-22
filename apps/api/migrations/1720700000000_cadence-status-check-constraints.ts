import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * docs/14_IMPROVEMENT_REVIEW.md §2.12 / issue #87: `preferences.cadence`
 * and `connections.status` were free-text columns with only a code comment
 * documenting their valid values (`daily | weekdays | custom` and
 * `active | revoked | error` respectively, migrations/1720000000000_init-
 * schema.ts) — nothing stopped a typo or a future careless write from
 * inserting a value the app doesn't understand. Both value sets are
 * already enforced app-side (packages/shared-contracts's `CadenceSchema`
 * for cadence; connectionsRepository's own writes for status), so these
 * CHECK constraints only formalize an invariant that already holds.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addConstraint('preferences', 'preferences_cadence_check', {
    check: "cadence IN ('daily', 'weekdays', 'custom')",
  });
  pgm.addConstraint('connections', 'connections_status_check', {
    check: "status IN ('active', 'revoked', 'error')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('connections', 'connections_status_check');
  pgm.dropConstraint('preferences', 'preferences_cadence_check');
}
