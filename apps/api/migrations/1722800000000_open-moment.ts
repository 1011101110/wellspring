import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The Open Moment (EPIC V #360 / V2 #363 + V4 #365).
 *
 * `devotionals.open_moment` (jsonb, nullable): the generation-time context
 * the live-response engine needs — language, tradition, translation,
 * preferredVersionId, voiceName (OpenMomentContextSchema). Set by the
 * orchestrator ONLY when the open moment is enabled for a generation;
 * `NULL` means the open moment is NOT enabled for this devotional — the gate
 * the respond route checks. Fixtures and distress check-ins always leave it
 * `NULL` (no live engine / a crisis moment gets comfort, not a prompt).
 *
 * `sessions.open_moment_response` (jsonb, nullable): the stored outcome of
 * the ONE allowed response for this session (OpenMomentStoredResponseSchema).
 * `NULL` means "not yet responded"; a set-once guarded UPDATE (like
 * `markJoined`/`markCompleted`) makes a second POST idempotent — it returns
 * the first result rather than running the engine again. The transcript is
 * NEVER stored here (epic §5) — only the outcome, the distress flag, and (on
 * a response) the synthetic audio id + verse display + durations.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('devotionals', {
    open_moment: { type: 'jsonb', notNull: false, default: null },
  });
  pgm.addColumn('sessions', {
    open_moment_response: { type: 'jsonb', notNull: false, default: null },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('sessions', 'open_moment_response');
  pgm.dropColumn('devotionals', 'open_moment');
}
