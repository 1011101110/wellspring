import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Stillness preference (docs/14 §5.2 / issue #76): off | brief | full.
 * When not `off`, the devotional audio adds a spoken hand-off + genuine
 * encoded silence after the verse and again after the prayer. `off`
 * preserves today's behavior exactly, hence the safe default.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('preferences', {
    stillness: { type: 'text', notNull: true, default: 'off' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('preferences', 'stillness');
}
