import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `devotionals.yv_highlight_written_at` — the idempotency stamp for the
 * YouVersion WRITE bridge (U3, kairos-devotional#356 / epic #353).
 *
 * When a user completes a devotional (Amen) and has `yv_write_highlights`
 * consent on, Wellspring writes that devotional's PRIMARY verse as a
 * highlight in their real YouVersion account. This column records the
 * moment that write succeeded so a second Amen (double-tap, retry after a
 * flaky response, an idempotent re-POST) never writes the highlight twice.
 *
 * Why a column here rather than trusting the API's own upsert semantics:
 * whether `POST /v1/highlights` is idempotent is a ⚠️ must-confirm value
 * owned by U1 — its exact request/response schema is not publicly
 * documented. A local "have we already done this?" stamp is correct
 * regardless of what U1 finds, so the guard does not depend on an
 * unconfirmed provider behavior. `markHighlightWritten` writes it with
 * `WHERE yv_highlight_written_at IS NULL`, preserving the FIRST write's
 * timestamp (same first-writer-wins shape as `meetbot_played_at`,
 * migration 1721900000000).
 *
 * On `devotionals` rather than `sessions` because the highlight is a
 * property of the devotional's verse, not of a particular join session — a
 * devotional has exactly one primary verse to mark, and re-joining the same
 * devotional through a different session must not re-write it.
 *
 * Nullable, no default — NULL means "never written" (the overwhelming
 * majority of rows: pre-existing devotionals, and every user who has not
 * connected YouVersion or has write consent off). Touches no existing
 * behavior on deploy: nothing reads it until the write bridge is wired, and
 * the completion-page proof line only appears when it is non-null.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('devotionals', {
    yv_highlight_written_at: { type: 'timestamptz' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('devotionals', 'yv_highlight_written_at');
}
