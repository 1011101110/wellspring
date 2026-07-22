import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Issue #221 — makes the Meet-bot "play once" guard durable.
 *
 * ## What was wrong
 *
 * `routes/meetBotAudio.ts` guarded against replaying a devotional with a
 * module-level `Set<string>` — process-local memory. That guard exists
 * because the audio websocket is a PERSISTENT channel that Attendee (a
 * third party) re-establishes for the bot's whole session: closing our end
 * just makes Attendee reconnect, and a naive handler replays the devotional
 * from the beginning. That was a real loop bug found live on 2026-07-09.
 *
 * A `Set` in process memory closes that hole only for reconnects that land
 * on the same Cloud Run instance. It does not survive:
 *
 *   - a cold start (Cloud Run scales to zero between the morning and
 *     evening slots, so this is the common case, not the exotic one),
 *   - a scale-out onto a second instance,
 *   - a revision rollout mid-session.
 *
 * In every one of those, a reconnect arrives at a process whose `Set` is
 * empty, the guard says "never played", and the devotional plays aloud in
 * the user's meeting a second time. The guard was strongest exactly where
 * it was least needed (a fast reconnect racing the leave) and absent where
 * it mattered most.
 *
 * ## Why a column on `devotionals` and not a new table
 *
 * The fact being recorded — "this devotional has been spoken into a
 * meeting" — is a property *of the devotional*, one-to-one with the row,
 * and it is written at most once in that row's life. A dedicated table
 * would add a join, a second thing for `users.hardDelete` to cascade
 * through, and its own retention question, all to store one nullable
 * timestamp per devotional. The column inherits all of that for free:
 * `devotionals.user_id` is `ON DELETE CASCADE` from `users`, so deleting an
 * account takes this timestamp with it (docs/04_DATA_PRIVACY_SECURITY.md
 * §2), and `purgeJobs.ts` retention already reaps the row.
 *
 * ## Why a timestamp and not a boolean
 *
 * Same reasoning as `users.onboarded_at` (migration 1721800000000): the
 * timestamp costs the same and answers "when did a bot speak in this
 * person's meeting", which is a question a privacy incident review will
 * actually ask and which a boolean cannot answer. NULL is unambiguous —
 * "no bot has played this" — with no "or the column is new" confusion,
 * because nothing has ever played *before* the column existed either.
 *
 * ## Why no backfill
 *
 * NULL for existing rows is not merely acceptable, it is accurate for every
 * row that matters. Any devotional whose meeting has already happened is
 * past its `gap_start_at` and will never be dispatched again; the handful
 * from the H1a spike that genuinely did play are for slots long finished.
 * Backfilling `now()` across the table would assert that every historical
 * devotional was spoken by a bot, which is false for almost all of them and
 * would corrupt precisely the audit signal the column is here to provide.
 *
 * ## Down
 *
 * Dropping the column reverts to the pre-#221 process-local guard — the
 * behavior we are fixing, but not worse than it. Deliberately not
 * destructive of anything else.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('devotionals', {
    meetbot_played_at: {
      type: 'timestamptz',
      notNull: false,
      default: null,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('devotionals', 'meetbot_played_at');
}
