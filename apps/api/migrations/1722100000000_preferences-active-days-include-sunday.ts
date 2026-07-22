/**
 * `active_days` defaults to all seven days (N3, issue #262).
 *
 * ## What this changes, and what it deliberately does not
 *
 * The column default only ever applies to a row `ensureExists` creates at
 * signup — every later write names `active_days` explicitly. So this
 * changes what a NEW user gets and nothing else.
 *
 * It does **not** touch a single existing row. That restraint is the
 * whole design of this migration, and it is the lesson from #202: a user
 * holding `{1,2,3,4,5}` today did not necessarily choose Mon–Fri, but
 * they are also not asking for weekend devotionals, and quietly starting
 * to generate them is a behaviour change nobody consented to. #188's
 * cadence control is how anyone changes this, deliberately.
 *
 * The contrast with 1721750000000 is intentional: that migration DID
 * rewrite rows, because it was repairing a `cadence` label that
 * contradicted the `active_days` beside it — reconciling a
 * self-inconsistent row, not overriding a coherent choice. This one is
 * the opposite case and gets the opposite treatment.
 *
 * ## Why the default was wrong
 *
 * The engineering reasoning behind Mon–Fri was sound: the signal is a
 * work calendar and gap-finding is a workday mechanic. But a default is a
 * statement, and out of the box Kairos was silent on the Lord's Day while
 * the empty state read "Your next devotional is Monday." For a Christian
 * devotional product that says the faith is a workday supplement. As the
 * review put it: a Sunday that is genuinely open is the best kairos of
 * the week, and it was the one Kairos declined to book.
 *
 * ## Reversibility
 *
 * `down` restores the previous default and likewise leaves rows alone, so
 * neither direction can lose a user's chosen days.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

const ALL_DAYS = "'{0,1,2,3,4,5,6}'::smallint[]";
const WEEKDAYS = "'{1,2,3,4,5}'::smallint[]";

export const shorthands = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('preferences', 'active_days', { default: pgm.func(ALL_DAYS) });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('preferences', 'active_days', { default: pgm.func(WEEKDAYS) });
}
