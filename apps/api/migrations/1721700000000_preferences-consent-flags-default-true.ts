import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Issue #201 (P0 privacy defect) — prerequisite for making
 * `calendar_enabled` / `health_enabled` / `communication_enabled` genuine
 * read-time consent gates.
 *
 * ## Why the defaults have to flip before the gates go live
 *
 * These three columns were created `notNull, default false` by the initial
 * schema (migration 1720000000000). Since then:
 *
 *   - **No service has ever read them.** docs/03 §10's traceability table
 *     marks all three **dead** — the calendar step gates on the `connections`
 *     row status, band ingestion gates on nothing, and `communicationLoad`
 *     comes straight off `daily_bands`.
 *   - **No client has ever written them.** `HTTPPreferencesClient`'s own doc
 *     comment states it: "`calendarEnabled`/`healthEnabled`/
 *     `communicationEnabled`/`notifyOnSkip` have no representation in
 *     `OnboardingPreferences` and are omitted from the push payload
 *     entirely." The iOS Data & Privacy toggles write to a device-local
 *     `ConsentStore` (UserDefaults), never to these columns.
 *
 * So every `preferences` row in production currently holds `false` for all
 * three — not because any user chose it, but because nobody ever asked and
 * nothing ever wrote. **A stored `false` here means "never asked", not
 * "revoked."**
 *
 * That distinction is the whole migration. #201 fixes a defect where a user
 * who revokes consent has nothing happen. Turning these columns into real
 * gates *without* this backfill would ship the exact mirror-image defect:
 * every existing user — including all the ones who explicitly connected a
 * calendar and explicitly opted into health categories during onboarding —
 * would silently lose every signal at once, having revoked nothing. One
 * broken promise about privacy would be traded for a broken product, and
 * neither is what the user asked for.
 *
 * ## Why `true` does not weaken consent
 *
 * Backfilling `true` is not "consent by default." The genuine opt-in gates
 * are untouched and still upstream of these flags:
 *
 *   - **Calendar:** an active `connections` row, created only by completing
 *     the Google OAuth flow. No connection, no calendar read — same as today.
 *   - **Health:** the device-local `ConsentStore` (default *off* per category,
 *     issue #70) plus the OS HealthKit grant. A band the user never consented
 *     to is never derived, never uploaded, and lands in `daily_bands` as NULL
 *     — which #196's provenance work already reports as NOT OBSERVED.
 *
 * These columns are a *second*, server-side gate layered on top of those.
 * Setting them `true` says "this new gate does not itself revoke anything the
 * user already opted into through the real gates" — it does not manufacture
 * consent that was never given, because the upstream gates still have to pass
 * before there is any signal to suppress. Foundation §8's "independent,
 * revocable opt-in" is about *revocability*, which is precisely what this
 * unlocks: after #201 the toggle finally does something when turned off.
 *
 * ## New-row default
 *
 * `default true` for the same reason. A row is created at first preferences
 * sync, typically before (and independent of) any calendar connection or
 * health grant. Defaulting it `false` would mean a brand-new user's genuine
 * onboarding consent is overridden by a server-side flag they never saw,
 * reproducing the same silent-suppression bug for every future signup.
 *
 * ## Down
 *
 * Restores `default false`. It deliberately does NOT rewrite stored values
 * back to `false`: by the time a rollback runs, a user may have used the
 * now-functional toggle to make a real choice, and clobbering a genuine
 * revocation-or-grant is worse than leaving a permissive default behind.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  for (const column of ['calendar_enabled', 'health_enabled', 'communication_enabled'] as const) {
    pgm.alterColumn('preferences', column, { default: true });
  }

  // Backfill every existing row. Unconditional (no `WHERE ... = false`)
  // because, per the doc comment above, no stored `false` in this table can
  // currently be a user decision — nothing has ever written these columns
  // from a consent surface.
  pgm.sql(`
    UPDATE preferences
       SET calendar_enabled = true,
           health_enabled = true,
           communication_enabled = true
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const column of ['calendar_enabled', 'health_enabled', 'communication_enabled'] as const) {
    pgm.alterColumn('preferences', column, { default: false });
  }
}
