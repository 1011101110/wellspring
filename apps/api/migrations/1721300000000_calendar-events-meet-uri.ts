import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * H1 (#53), docs/22_EPIC_H_PLAN.md §3: nullable Meet URI column for when
 * GoogleCalendarClient.insertEvent is called with conferenceData
 * requested — populated from the Calendar API response's
 * conferenceData.entryPoints (the video entry point's `uri`), never
 * derived from anything else. NULL for every event that doesn't request
 * a real Meet link (the entire fleet today, and any future event that
 * stays on the hosted-session-only path) — this is purely additive,
 * no existing row or caller is affected.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('calendar_events', {
    meet_uri: { type: 'text', notNull: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('calendar_events', 'meet_uri');
}
