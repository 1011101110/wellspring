import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `users.email NOT NULL` vs. an optional Firebase email claim (docs/14
 * §2.12 / issue #69): Sign in with Apple's "Hide My Email" and some
 * federated-identity flows can produce a verified Firebase ID token with
 * no `email` claim at all. The auth-provisioning path
 * (`findOrCreateByFirebaseUid`, src/auth/middleware.ts) must be able to
 * create a `users` row for such a token without inventing a fake email
 * address — the simplest honest fix is making the column nullable, not
 * synthesizing a placeholder value that would be indistinguishable from
 * a real one downstream.
 *
 * Forward-only per docs/06_DEPLOYMENT_CI_CD.md §5 — `down` is implemented
 * for local dev resets only; it is unsafe to run in any environment that
 * may already have NULL emails (would fail the NOT NULL backfill).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('users', 'email', { notNull: false });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('users', 'email', { notNull: true });
}
