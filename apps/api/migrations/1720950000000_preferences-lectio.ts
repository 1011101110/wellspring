import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Lectio divina mode preference (docs/14 §5.4 / issue #92). When true, the
 * devotional audio restructures as: verse (rate 0.95) -> silence -> same
 * verse (rate 0.85) -> the meditative question -> silence -> prayer,
 * instead of the ordinary verse -> devotionalBody -> prayer flow. `false`
 * preserves today's behavior exactly, hence the safe default.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('preferences', {
    lectio: { type: 'boolean', notNull: true, default: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('preferences', 'lectio');
}
