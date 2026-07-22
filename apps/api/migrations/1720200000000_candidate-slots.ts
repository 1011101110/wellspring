import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `candidate_slots` — backs `POST /v1/slots` (docs/03_API_INTEGRATION_SPEC.md
 * §8.1, docs/14_IMPROVEMENT_REVIEW.md §4.1 step 3, issue #74).
 *
 * A dedicated table rather than reusing `calendar_events` (docs/14 §4.1
 * leaves the choice open — "reuse calendar_events with a candidate flag —
 * your call"): `calendar_events` is shaped around a PLACED Kairos event
 * (FK to `devotionals`, `gap_source` enum describing how the placement was
 * chosen, `reschedule_count`) — none of that applies to a raw EventKit
 * free-window upload, which is just "this time range is free" with no
 * devotional/placement decision attached yet. Overloading that table would
 * mean either nullable-everything on the placement columns or a confusing
 * dual-purpose row shape; a narrow table matching exactly what
 * `POST /v1/slots` receives (Foundation §8: start/end instants only, no
 * titles/attendees) is the cleaner schema.
 *
 * One upload replaces the day's candidate slots for that user (see
 * `CandidateSlotsRepository.replaceForDate`) — old candidate rows for a
 * date are not kept once superseded, since a superseded free/busy snapshot
 * has no scheduling value and this table is not a historical record.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('candidate_slots', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    date: { type: 'date', notNull: true },
    start_at: { type: 'timestamptz', notNull: true },
    end_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('candidate_slots', 'candidate_slots_end_after_start', {
    check: 'end_at > start_at',
  });
  pgm.createIndex('candidate_slots', ['user_id', 'date']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('candidate_slots');
}
