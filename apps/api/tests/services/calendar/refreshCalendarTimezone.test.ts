/**
 * K1 (#187): time zone source precedence, IANA validation, and the
 * calendar refresh path shared by the daily run and the backfill sweep.
 *
 * The precedence rule is the part worth testing hardest — #187 names both
 * failure modes explicitly ("stale zones for travelers or silently
 * clobbering a deliberate setting — both are worse than the current
 * honest-but-wrong UTC"), and neither one produces an error anywhere. A
 * clobbered choice just quietly moves someone's devotional.
 *
 * `UsersRepository.adoptTimezone` enforces precedence in SQL (so it is
 * atomic against a device sync and a daily run landing together), which
 * means it can't be exercised without Postgres. The fake here implements
 * the same rule from the same exported `timezoneSourceWins` predicate the
 * SQL's CASE ladder is generated from — so these tests pin the behavior,
 * and `tests/db/repositories.test.ts` pins that the SQL agrees.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isValidIanaTimeZone,
  timezoneSourceWins,
  TIMEZONE_SOURCE_RANK,
  type TimezoneSource,
} from '@kairos/shared-contracts';
import type { UsersRepository, UserRow } from '../../../src/db/repositories/usersRepository.js';
import { refreshCalendarTimezone } from '../../../src/services/calendar/refreshCalendarTimezone.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Stand-in for one `users` row plus the adoptTimezone semantics: write
 * only if the incoming source outranks-or-equals the stored one AND
 * something actually changes; return the row on write, `null` otherwise.
 */
function fakeUsers(initial: { timezone: string; timezone_source: TimezoneSource }) {
  const row = { id: USER_ID, ...initial };

  const adoptTimezone = vi.fn(
    async (_userId: string, timezone: string, source: TimezoneSource): Promise<UserRow | null> => {
      if (!timezoneSourceWins(source, row.timezone_source)) return null;
      if (row.timezone === timezone && row.timezone_source === source) return null;
      row.timezone = timezone;
      row.timezone_source = source;
      return row as unknown as UserRow;
    },
  );

  return { repo: { adoptTimezone } as unknown as UsersRepository, row, adoptTimezone };
}

describe('time zone source precedence (user > calendar > device > default)', () => {
  it('ranks the four sources in the order #187 specifies', () => {
    expect(TIMEZONE_SOURCE_RANK.user).toBeGreaterThan(TIMEZONE_SOURCE_RANK.calendar);
    expect(TIMEZONE_SOURCE_RANK.calendar).toBeGreaterThan(TIMEZONE_SOURCE_RANK.device);
    expect(TIMEZONE_SOURCE_RANK.device).toBeGreaterThan(TIMEZONE_SOURCE_RANK.default);
  });

  it('lets every source replace the untouched UTC default', () => {
    expect(timezoneSourceWins('device', 'default')).toBe(true);
    expect(timezoneSourceWins('calendar', 'default')).toBe(true);
    expect(timezoneSourceWins('user', 'default')).toBe(true);
  });

  it('never lets an automatic source overwrite an explicit user choice', () => {
    // The clobbering half of #187's warning: a user who deliberately
    // picked a zone must keep it through every calendar connect, every
    // daily-run refresh, and every device sync from a phone in another
    // country.
    expect(timezoneSourceWins('device', 'user')).toBe(false);
    expect(timezoneSourceWins('calendar', 'user')).toBe(false);
  });

  it('does not let the device zone overwrite a calendar-derived one', () => {
    // The calendar zone is where the user's scheduling actually lives; the
    // device zone flips the instant they step off a plane, which is
    // exactly when their 7am devotional should NOT jump.
    expect(timezoneSourceWins('device', 'calendar')).toBe(false);
  });

  it('lets a source replace its own earlier value, so a relocation still lands', () => {
    // The staleness half of #187's warning — `>=`, not `>`. Without this a
    // traveler would be frozen on whichever zone happened to be written
    // first.
    expect(timezoneSourceWins('device', 'device')).toBe(true);
    expect(timezoneSourceWins('calendar', 'calendar')).toBe(true);
    expect(timezoneSourceWins('user', 'user')).toBe(true);
  });
});

describe('isValidIanaTimeZone', () => {
  it('accepts real identifiers, including the backward-compat aliases devices still report', () => {
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('UTC')).toBe(true);
    expect(isValidIanaTimeZone('Australia/Sydney')).toBe(true);
    expect(isValidIanaTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    // Rejecting a zone the platform itself handed us would be worse than
    // the bug being fixed — hence not Intl.supportedValuesOf.
    expect(isValidIanaTimeZone('US/Eastern')).toBe(true);
    expect(isValidIanaTimeZone('Asia/Calcutta')).toBe(true);
  });

  it('rejects junk rather than letting it reach a scheduling calculation', () => {
    expect(isValidIanaTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidIanaTimeZone('Not A Zone')).toBe(false);
    expect(isValidIanaTimeZone('')).toBe(false);
    expect(isValidIanaTimeZone('America/New_York; DROP TABLE users')).toBe(false);
  });

  it('rejects bare UTC offsets, which have no DST rules', () => {
    // ECMA-402 lets Intl accept these as a timeZone, but a user stored as
    // "+05:00" is wrong for half of every year in most of the world.
    expect(isValidIanaTimeZone('+05:00')).toBe(false);
    expect(isValidIanaTimeZone('-08:00')).toBe(false);
  });
});

describe('refreshCalendarTimezone', () => {
  it('adopts the calendar zone for a user still on the untouched UTC default', async () => {
    // The population #185 never reached: connected before it shipped, so
    // stuck on UTC forever. This is what the backfill sweep fixes.
    const { repo, row, adoptTimezone } = fakeUsers({ timezone: 'UTC', timezone_source: 'default' });

    const result = await refreshCalendarTimezone(
      { users: repo, getCalendarTimeZoneForUser: async () => 'America/New_York' },
      USER_ID,
    );

    expect(result).toEqual({ outcome: 'adopted', timezone: 'America/New_York' });
    expect(adoptTimezone).toHaveBeenCalledWith(USER_ID, 'America/New_York', 'calendar');
    expect(row.timezone).toBe('America/New_York');
    expect(row.timezone_source).toBe('calendar');
  });

  it('follows a calendar zone change, so a relocated user is not left stale', async () => {
    const { repo, row } = fakeUsers({ timezone: 'America/New_York', timezone_source: 'calendar' });

    const result = await refreshCalendarTimezone(
      { users: repo, getCalendarTimeZoneForUser: async () => 'Europe/Berlin' },
      USER_ID,
    );

    expect(result).toEqual({ outcome: 'adopted', timezone: 'Europe/Berlin' });
    expect(row.timezone).toBe('Europe/Berlin');
  });

  it('leaves an explicit user choice alone', async () => {
    const { repo, row } = fakeUsers({ timezone: 'Pacific/Auckland', timezone_source: 'user' });

    const result = await refreshCalendarTimezone(
      { users: repo, getCalendarTimeZoneForUser: async () => 'America/New_York' },
      USER_ID,
    );

    expect(result).toEqual({ outcome: 'unchanged' });
    expect(row.timezone).toBe('Pacific/Auckland');
    expect(row.timezone_source).toBe('user');
  });

  it('upgrades the source when a device-set zone is confirmed by the calendar', async () => {
    // Same string, higher-ranked source: the write still has to happen,
    // otherwise a later device sync from a plane could move a zone the
    // calendar has already vouched for.
    const { repo, row } = fakeUsers({ timezone: 'America/New_York', timezone_source: 'device' });

    await refreshCalendarTimezone(
      { users: repo, getCalendarTimeZoneForUser: async () => 'America/New_York' },
      USER_ID,
    );

    expect(row.timezone_source).toBe('calendar');
  });

  it('refuses a non-IANA zone rather than storing it', async () => {
    const { repo, row, adoptTimezone } = fakeUsers({ timezone: 'UTC', timezone_source: 'default' });

    const result = await refreshCalendarTimezone(
      { users: repo, getCalendarTimeZoneForUser: async () => 'Middle-earth/Shire' },
      USER_ID,
    );

    expect(result).toEqual({ outcome: 'rejected' });
    expect(adoptTimezone).not.toHaveBeenCalled();
    expect(row.timezone).toBe('UTC');
  });

  it('reports `unavailable` when the calendar has no zone to give', async () => {
    const { repo, adoptTimezone } = fakeUsers({ timezone: 'UTC', timezone_source: 'default' });

    const result = await refreshCalendarTimezone(
      { users: repo, getCalendarTimeZoneForUser: async () => undefined },
      USER_ID,
    );

    expect(result).toEqual({ outcome: 'unavailable' });
    expect(adoptTimezone).not.toHaveBeenCalled();
  });

  it('swallows a lookup failure instead of throwing at its batch callers', async () => {
    // Both callers are batch jobs — one user's revoked token must not
    // cost anyone else in the loop their devotional.
    const { repo } = fakeUsers({ timezone: 'UTC', timezone_source: 'default' });

    const result = await refreshCalendarTimezone(
      {
        users: repo,
        getCalendarTimeZoneForUser: async () => {
          throw new Error('token revoked');
        },
      },
      USER_ID,
    );

    expect(result).toEqual({ outcome: 'failed' });
  });

  it('swallows a write failure too', async () => {
    const repo = {
      adoptTimezone: vi.fn().mockRejectedValue(new Error('connection terminated')),
    } as unknown as UsersRepository;

    const result = await refreshCalendarTimezone(
      { users: repo, getCalendarTimeZoneForUser: async () => 'America/New_York' },
      USER_ID,
    );

    expect(result).toEqual({ outcome: 'failed' });
  });
});
