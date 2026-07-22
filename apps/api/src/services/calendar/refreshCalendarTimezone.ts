/**
 * K1 (#187): re-reads a user's connected Google Calendar zone and adopts
 * it onto `users.timezone`, subject to the source precedence in migration
 * 1721400000000.
 *
 * Two callers, one implementation:
 *  - `POST /internal/trigger-daily-run`, once per connected user per day.
 *    #185 only ever learned the zone at connect time, so anyone who
 *    connected before that shipped stayed on UTC forever and nobody's
 *    zone followed them when they moved.
 *  - `POST /internal/backfill-timezones`, the one-off sweep over rows
 *    still on the `'UTC'` default.
 *
 * Cheap enough to run per-user per-day: `getCalendarTimeZone` is a single
 * Calendar API call over a far-future, guaranteed-empty window (see that
 * method's doc for how it reads the zone without touching event content,
 * keeping the Foundation §8 minimization invariant intact).
 *
 * This function NEVER throws. Both callers are batch jobs where one
 * user's revoked token or transient 5xx must not abort the run — same
 * best-effort contract as the connect-time adoption in routes/connect.ts.
 */
import { isValidIanaTimeZone } from '@kairos/shared-contracts';
import { asVerifiedUserId } from '../../db/repositories/index.js';
import type { UsersRepository } from '../../db/repositories/usersRepository.js';

export interface RefreshCalendarTimezoneDeps {
  users: UsersRepository;
  /**
   * Resolves the IANA zone of a user's connected calendar, or `undefined`
   * when there is nothing to read. A narrow callback rather than
   * (connections + kmsService + calendarClient), matching
   * `ConnectRoutesDeps.getCalendarTimeZone` — the caller in index.ts owns
   * the decrypt-then-call chain, and tests here need only a stub.
   */
  getCalendarTimeZoneForUser: (userId: string) => Promise<string | undefined>;
}

export type RefreshOutcome =
  /** A new zone was written; `timezone` holds it. */
  | 'adopted'
  /** Stored value already matches, or an equal/higher-ranked source owns it. */
  | 'unchanged'
  /** The calendar reported no zone (no connection, revoked token, empty response). */
  | 'unavailable'
  /** The calendar reported something that is not an IANA identifier. */
  | 'rejected'
  /** The lookup or the write threw. */
  | 'failed';

export interface RefreshResult {
  outcome: RefreshOutcome;
  /** The user's effective zone after this call, when it changed. */
  timezone?: string;
}

export async function refreshCalendarTimezone(
  deps: RefreshCalendarTimezoneDeps,
  userId: string,
): Promise<RefreshResult> {
  try {
    const timezone = await deps.getCalendarTimeZoneForUser(userId);
    if (!timezone) return { outcome: 'unavailable' };

    // Google is a trusted source but not an infallible one, and a zone
    // string it hands back goes straight into scheduling arithmetic.
    // Storing an unrecognized identifier doesn't fail loudly — luxon
    // yields an invalid DateTime and the user's gap lands somewhere
    // arbitrary — so refuse it here and leave the previous value alone.
    if (!isValidIanaTimeZone(timezone)) return { outcome: 'rejected' };

    const updated = await deps.users.adoptTimezone(asVerifiedUserId(userId), timezone, 'calendar');
    // null = outranked by an explicit user choice, or already identical.
    // Either way the stored value stands and there is nothing to report.
    return updated ? { outcome: 'adopted', timezone: updated.timezone } : { outcome: 'unchanged' };
  } catch {
    return { outcome: 'failed' };
  }
}
