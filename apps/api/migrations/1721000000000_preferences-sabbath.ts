import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Sabbath awareness (docs/14 §5.6 / issue #94): an opt-in weekly rest day
 * on which /internal/trigger-daily-run either skips the ordinary
 * devotional entirely (sabbath_session=false, the default — genuine rest)
 * or generates an extended, action-step-free contemplative session
 * instead (sabbath_session=true). `sabbath_day` follows `active_days`'
 * 0=Sunday..6=Saturday convention. `sabbath_enabled` defaults false,
 * mirroring `examen_enabled` (migration 1720600000000) — opt-in, so
 * existing users see no behavior change until they turn it on.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('preferences', {
    sabbath_day: { type: 'smallint', notNull: true, default: 0 },
    sabbath_enabled: { type: 'boolean', notNull: true, default: false },
    sabbath_session: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('preferences', 'preferences_sabbath_day_check', 'CHECK (sabbath_day BETWEEN 0 AND 6)');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('preferences', 'preferences_sabbath_day_check');
  pgm.dropColumn('preferences', ['sabbath_day', 'sabbath_enabled', 'sabbath_session']);
}
