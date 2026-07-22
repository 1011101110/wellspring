import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Liturgical seasons (docs/14 §5.7 / issue #95): an opt-in instructions
 * line naming the current liturgical season (Advent, Christmastide, Lent,
 * Eastertide, Ordinary Time), computed from the generation date via a
 * hand-written Gregorian computus (liturgicalCalendar.ts). Catholic and
 * mainline traditions see the line automatically; evangelical/general
 * traditions only when `liturgical_seasons_enabled` is set. Defaults
 * false, mirroring `examen_enabled`/`sabbath_enabled` — opt-in, so
 * existing users see no behavior change until they turn it on.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('preferences', {
    liturgical_seasons_enabled: { type: 'boolean', notNull: true, default: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('preferences', ['liturgical_seasons_enabled']);
}
