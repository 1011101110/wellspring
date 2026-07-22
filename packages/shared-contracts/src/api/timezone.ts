import { z } from 'zod';

/**
 * IANA time zone identifiers (issue #187, epic #186).
 *
 * `users.timezone` is the single field every "when is their morning"
 * decision reads — gap selection, `active_days`, `sabbath_day`, the daily
 * run. It defaulted to `'UTC'` and, until #185, nothing ever wrote it: the
 * first real connected user got a devotional gap at 07:30 UTC, which was
 * 3:30am where they actually live. Now that three separate sources write
 * the field (device, calendar, explicit choice), the value has to be
 * validated at every door — a junk zone stored here doesn't fail loudly,
 * it silently reschedules someone's devotional to the middle of the night,
 * and `luxon`'s `DateTime.fromJSDate(..., { zone })` returns an *invalid*
 * DateTime rather than throwing, so the damage surfaces far from the write.
 */

/**
 * True exactly when `value` is a zone identifier this runtime's ICU
 * database recognizes.
 *
 * Two checks, both needed:
 *
 *  1. The shape regex. ECMA-402 lets `Intl.DateTimeFormat` accept UTC
 *     offset strings (`'+05:00'`) as `timeZone`, and those are NOT what we
 *     want stored: an offset has no DST rules, so a user "in +05:00" is
 *     wrong for half the year in most of the world. Only region/location
 *     identifiers (and the bare `UTC`) get through.
 *  2. Constructing an `Intl.DateTimeFormat`, which throws `RangeError` for
 *     an unrecognized identifier. This is the authoritative check —
 *     hand-maintaining a list of ~600 zone names in this repo would go
 *     stale the moment the IANA database ships a rename.
 *
 * Deliberately NOT `Intl.supportedValuesOf('timeZone')`: that list omits
 * the backward-compatibility aliases (`US/Eastern`, `Asia/Calcutta`) that
 * real devices and real Google Calendar accounts still report, and
 * rejecting a zone the platform itself handed us would be worse than the
 * bug we're fixing.
 */
export function isValidIanaTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * A stored/transmitted IANA zone id. The length cap is a cheap guard
 * against an unbounded string reaching a `text` column; the longest real
 * identifier (`America/Argentina/ComodRivadavia`) is 32 characters.
 */
export const TimezoneIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidIanaTimeZone, 'must be an IANA time zone identifier (e.g. America/New_York)');

/**
 * Where a stored `users.timezone` came from, in precedence order (issue
 * #187): `user` > `calendar` > `device` > `default`.
 *
 *  - `default` — nobody ever set it; the `'UTC'` column default stands.
 *  - `device`  — the phone's `TimeZone.current.identifier`, sent on
 *                preferences sync. The educated guess, available before
 *                any calendar is connected and for users who never
 *                connect one at all.
 *  - `calendar` — the connected Google Calendar's own zone. Outranks the
 *                device because it is the zone the user's *scheduling*
 *                already lives in; a device zone flips the moment they
 *                step off a plane, which is exactly when we do NOT want
 *                their 7am devotional to jump.
 *  - `user`    — an explicit, deliberate choice. Nothing automatic may
 *                ever overwrite it (#187: "getting it wrong means either
 *                stale zones for travelers or silently clobbering a
 *                deliberate setting — both are worse than the current
 *                honest-but-wrong UTC").
 */
export const TimezoneSourceSchema = z.enum(['default', 'device', 'calendar', 'user']);
export type TimezoneSource = z.infer<typeof TimezoneSourceSchema>;

/**
 * Numeric precedence for each source. Exported (rather than inlined at the
 * comparison sites) because the SQL in `UsersRepository.adoptTimezone`
 * builds its `CASE` ladder from this very map — one source of truth for
 * the ordering, so the database and the application can't drift.
 */
export const TIMEZONE_SOURCE_RANK: Readonly<Record<TimezoneSource, number>> = Object.freeze({
  default: 0,
  device: 1,
  calendar: 2,
  user: 3,
});

/**
 * True when a write from `incoming` is allowed to replace a value stored
 * by `stored`.
 *
 * Equal ranks DO overwrite, and that is the point of using `>=` rather
 * than `>`: a traveler's second device sync (device -> device) must be
 * able to move them, a daily-run refresh (calendar -> calendar) must be
 * able to follow a calendar zone change, and a user re-picking a zone
 * (user -> user) must obviously stick. What `>=` still forbids is the
 * only case that actually loses information: a lower-ranked automatic
 * source stomping a higher-ranked one.
 */
export function timezoneSourceWins(incoming: TimezoneSource, stored: TimezoneSource): boolean {
  return TIMEZONE_SOURCE_RANK[incoming] >= TIMEZONE_SOURCE_RANK[stored];
}
