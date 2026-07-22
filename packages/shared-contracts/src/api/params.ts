import { z } from 'zod';

/**
 * Shared route-param validators (docs/14 §2.9 / issue #72): every `:id`,
 * `:date`, and `:token` path parameter across `/v1/*` and the public
 * `/session/:token` surface must be validated BEFORE it reaches a
 * repository query — an unvalidated string reaching a `uuid`- or
 * `date`-typed Postgres column throws a driver-level cast error (pg
 * `22P02`) that, absent a global error handler, becomes a 500 leaking
 * the raw pg message (exactly the `GET /session/abc` bug this issue
 * describes). Validating the shape here lets route handlers respond
 * with the SAME "not found" behavior for a malformed id as for a
 * well-formed-but-nonexistent one — required for the public session
 * route's enumeration-safety contract (Foundation §10 / docs/04 §5.4)
 * and good hygiene everywhere else.
 */

/** Matches any RFC 4122 UUID (v1–v5), case-insensitive — matches Postgres's own `uuid` input parser. */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const UuidParamSchema = z.string().regex(UUID_REGEX, 'must be a UUID');

/** YYYY-MM-DD only — matches Postgres's `date` column input shape used throughout (daily_bands.date, devotionals.date). */
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const IsoDateParamSchema = z.string().regex(ISO_DATE_REGEX, 'must be an ISO date (YYYY-MM-DD)');

/** True calendar-date check (rejects e.g. 2026-02-30) beyond the regex's shape check, matching Postgres's own validation. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
  );
}

/** Convenience boolean check mirroring `UuidParamSchema` for call sites that don't want a full safeParse. */
export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/** Four-digit calendar year path param (e.g. `GET /v1/recap/:year/:month`, issue #96). */
export const YEAR_REGEX = /^\d{4}$/;
export const YearParamSchema = z.string().regex(YEAR_REGEX, 'must be a 4-digit year');

/** Month-of-year path param, 1-12, with or without a leading zero. */
export const MONTH_REGEX = /^(0?[1-9]|1[0-2])$/;
export const MonthParamSchema = z.string().regex(MONTH_REGEX, 'must be a month 1-12');
