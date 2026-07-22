import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Evening examen (docs/14 §5.3/§5.8, issue #77): a devotional can now be a
 * `standard` (morning) or `examen` (evening) slot. `slot_type` replaces
 * date-only idempotency keying in generateNowOrchestrator — the existing
 * unique-ish lookup was `(user_id, date)` only, which would have treated a
 * same-day examen as "already generated" and skipped it. `examen_enabled`
 * on preferences is the opt-in for the scheduled evening cadence; the
 * distress check-in path (§5.8) does not require this flag since it is a
 * user-initiated, immediate action rather than a scheduled one.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('devotionals', {
    slot_type: { type: 'text', notNull: true, default: 'standard' },
  });
  pgm.addConstraint('devotionals', 'devotionals_slot_type_check', {
    check: "slot_type IN ('standard', 'examen')",
  });
  pgm.addColumn('preferences', {
    examen_enabled: { type: 'boolean', notNull: true, default: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('preferences', 'examen_enabled');
  pgm.dropConstraint('devotionals', 'devotionals_slot_type_check');
  pgm.dropColumn('devotionals', 'slot_type');
}
