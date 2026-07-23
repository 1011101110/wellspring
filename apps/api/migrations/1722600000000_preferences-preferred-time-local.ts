import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `preferred_time_local` (Epic P #312, story P7 #326): the feedback loop's
 * time-of-day bias — a wall-clock `time` the scheduler *prefers* inside
 * the user's stated window, nudged 30 minutes at a time by trailing
 * `session_feedback.time_feel` rows ("earlier suits me" / "later suits
 * me").
 *
 * Server-owned, like the `adaptive_*` columns of 1722500000000 and for
 * the same reason: it is the steering engine's state, not a control the
 * user sets — the user's stated controls remain `window_start_local` /
 * `window_end_local`, which this value is CLAMPED inside on every write
 * (`FeedbackSteering`, feedbackSteering.ts). No API accepts it from a
 * client (`PreferencesUpdate` cannot name it at the type level) and no
 * API returns it in this story (#326 §9 guardrail: derivation stays
 * server-side; no new client-readable fields).
 *
 * NULL means "no bias yet" — the scheduler keeps today's behavior
 * (longest gap first) until feedback establishes a preference, so deploy
 * day changes nobody's slot. No CHECK against the window columns: the
 * window itself is editable, so a stored time can legitimately fall
 * outside a *newly narrowed* window — the read path re-clamps instead
 * (same posture as `adaptive_days_per_week`'s read-side clamp against an
 * edited `active_days`).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('preferences', {
    preferred_time_local: { type: 'time' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('preferences', 'preferred_time_local');
}
