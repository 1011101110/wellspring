import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Issue #225 — server-authoritative onboarding completion, the prerequisite
 * for iOS<->web parity (#195, epic #186).
 *
 * ## What this replaces
 *
 * "Has this person finished onboarding" has lived, until now, in a single
 * `UserDefaults` boolean on one device (`UserDefaultsOnboardingCompletionStore`,
 * issue #71). That was correct while iOS was the only surface: the fact it
 * records — "the Done screen was reached" — was a fact about a device,
 * because there was only ever one. It stops being correct the moment a
 * second surface exists. A user who onboards on web and then opens iOS is
 * shown onboarding again, having already done it, and the app has no way to
 * know better because the truth was never written anywhere both clients can
 * see. `findOrCreateByFirebaseUid` already guarantees the two surfaces
 * resolve to the same `users.id`, so `users` is exactly where this belongs.
 *
 * ## Why a nullable timestamp and not a boolean
 *
 * `onboarded_at timestamptz NULL` carries strictly more than
 * `onboarded boolean NOT NULL DEFAULT false` at identical storage cost:
 *
 *   - It records *when*, which a boolean cannot. That is the difference
 *     between "this user is onboarded" and "this user onboarded on the day
 *     the web app shipped" — the second is answerable from this column and
 *     nowhere else, and support/analytics questions of that shape are the
 *     ones that actually get asked.
 *   - NULL is unambiguous. A `false` boolean conflates "we asked and they
 *     have not finished" with "this column was added yesterday and nothing
 *     has written it yet" — precisely the ambiguity that made the consent
 *     trio's backfill (migration 1721700000000) a whole judgement call
 *     rather than a one-liner. NULL here means only one thing.
 *
 * ## Why existing rows are deliberately NOT backfilled
 *
 * Every row predating this migration gets `NULL`, i.e. "not onboarded",
 * even though many of those users demonstrably *have* onboarded — they have
 * preferences rows, calendar connections, and devotional history.
 *
 * That looks like the mirror-image mistake of 1721700000000, and it is not,
 * because the client rule is not "server wins" for this column. Onboarding
 * completion is a **latch** (see `OnboardingCompletionStore` on iOS): a
 * client treats itself as onboarded if *either* the server says so *or* its
 * own local cache says so, and pushes the local `true` up when the server
 * has no timestamp. So an existing iOS user's device boolean still carries
 * them straight past onboarding on the next launch, and their first pull
 * backfills the server column for them, individually and accurately — with
 * a timestamp that means something rather than a fabricated one shared by
 * the entire table.
 *
 * A blanket `UPDATE users SET onboarded_at = now()` would instead assert
 * that every existing row finished onboarding, including rows that were
 * provisioned by `requireAuth` on a first API call and abandoned mid-flow.
 * Those users would be dropped into the tab shell having never picked a
 * window, a tradition, or a translation. The latch gets the common case
 * right without inventing history for the uncommon one.
 *
 * ## Down
 *
 * Drops the column. Losing it is safe in the same asymmetric way the latch
 * is safe: every iOS client still holds its local cache, so a rollback
 * degrades to exactly the pre-#225 behavior (device-local truth) rather
 * than to "everyone re-onboards".
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('users', {
    onboarded_at: {
      type: 'timestamptz',
      notNull: false,
      default: null,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('users', 'onboarded_at');
}
