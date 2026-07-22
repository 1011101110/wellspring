import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * K1 (#187, epic #186): records WHERE `users.timezone` came from, so the
 * three writers of that column can be ordered against each other.
 *
 * `users.timezone` now has three automatic/manual sources — the device's
 * own zone (preferences sync), the connected calendar's zone (connect
 * time, #185, plus a refresh on every daily run), and eventually an
 * explicit pick in settings. Without a recorded source, "should this
 * write win?" is unanswerable: a relocation would silently undo a
 * deliberate choice, or a deliberate choice would freeze a traveler on a
 * stale zone. #187 names both outcomes as worse than today's
 * honest-but-wrong UTC.
 *
 * Precedence (see `TimezoneSourceSchema` in shared-contracts for the full
 * reasoning): `user` > `calendar` > `device` > `default`. The comparison
 * itself lives in `UsersRepository.adoptTimezone`'s conditional UPDATE.
 *
 * Backfill: any existing row already off `'UTC'` can only have gotten
 * there one way — #185's connect-time calendar adoption is, as of this
 * migration, the only code that has ever written the column — so those
 * rows are marked `'calendar'`. Everything still on the `'UTC'` default
 * is exactly the population `POST /internal/backfill-timezones` targets.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('users', {
    timezone_source: { type: 'text', notNull: true, default: 'default' },
  });

  // Same rationale as migration 1720700000000's cadence/status checks:
  // the value set is already enforced app-side, and this only formalizes
  // an invariant that already holds — but a typo in a future write would
  // otherwise land a rank-0 (`default`) source silently, since the CASE
  // ladder in `adoptTimezone` maps anything unrecognized to the lowest
  // rank. That would make an unknown source overwritable by everything,
  // which is the failure mode this whole column exists to prevent.
  pgm.addConstraint('users', 'users_timezone_source_check', {
    check: "timezone_source IN ('default', 'device', 'calendar', 'user')",
  });

  pgm.sql(`UPDATE users SET timezone_source = 'calendar' WHERE timezone <> 'UTC'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('users', 'users_timezone_source_check');
  pgm.dropColumn('users', 'timezone_source');
}
