/**
 * Range parsing and the server-side span limit for
 * `GET /v1/calendar/freebusy` (M1, issue #255).
 *
 * Split out of the route so the limit is unit-testable on its own and so
 * the route handler reads as a sequence of gates rather than a wall of
 * date arithmetic. See `FREEBUSY_MAX_RANGE_DAYS` in shared-contracts for
 * the sourced justification of the cap itself — including the finding that
 * Google documents *no* range cap, which is why this one has to exist here.
 */
import { FREEBUSY_MAX_RANGE_DAYS } from '@kairos/shared-contracts';

const MS_PER_DAY = 86_400_000;

export type FreeBusyRangeError =
  /** `from` or `to` missing, or not a parseable RFC3339/ISO-8601 instant. */
  | 'invalid'
  /**
   * `to` is at or before `from`. Rejected here rather than forwarded:
   * Google answers an inverted range with a 400, so passing it through
   * would surface an upstream error for a mistake we can name precisely,
   * and would spend a quota unit to learn what we already knew.
   */
  | 'not_ascending'
  /** Span exceeds `FREEBUSY_MAX_RANGE_DAYS`. */
  | 'too_wide';

export interface ParsedFreeBusyRange {
  /** Normalized to UTC ISO strings — what actually goes on the wire to Google. */
  timeMin: string;
  timeMax: string;
  spanDays: number;
}

export type ParseFreeBusyRangeResult =
  | { ok: true; range: ParsedFreeBusyRange }
  | { ok: false; error: FreeBusyRangeError; message: string };

/**
 * Validates a caller-supplied `from`/`to` pair and normalizes it.
 *
 * Returns a result rather than throwing so the route can map each failure
 * to its own message without a try/catch that would flatten three distinct
 * client mistakes into one opaque 400.
 *
 * The span is measured in absolute elapsed time, not calendar days, and
 * that is the correct choice here despite docs/07 §3.1's warning that a
 * calendar day and an instant are different things. The reason: this limit
 * exists to bound *how much Google work one request can buy*, and Google
 * meters instants. A DST-shifted 45-day span is 45 days ± 1 hour of real
 * time and costs the same; there is no user-visible boundary to get wrong,
 * because nothing here is rendered. The zone-sensitive part of this feature
 * is the grid the client draws, which is why the *route* still resolves and
 * echoes `users.timezone` — the two concerns are kept apart deliberately.
 */
export function parseFreeBusyRange(
  from: unknown,
  to: unknown,
): ParseFreeBusyRangeResult {
  if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') {
    return {
      ok: false,
      error: 'invalid',
      message: 'Query parameters "from" and "to" are required ISO-8601 instants.',
    };
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return {
      ok: false,
      error: 'invalid',
      message: 'Query parameters "from" and "to" must be ISO-8601 instants.',
    };
  }

  if (toMs <= fromMs) {
    return {
      ok: false,
      error: 'not_ascending',
      message: 'Query parameter "to" must be after "from".',
    };
  }

  const spanMs = toMs - fromMs;
  const spanDays = spanMs / MS_PER_DAY;
  if (spanDays > FREEBUSY_MAX_RANGE_DAYS) {
    return {
      ok: false,
      error: 'too_wide',
      // The limit is stated in the message because the client cannot infer
      // it from a bare rejection, and a calendar UI that grows a new view
      // should learn its ceiling from the failure rather than from a doc.
      message: `Requested range spans ${spanDays.toFixed(1)} days; the maximum is ${FREEBUSY_MAX_RANGE_DAYS}.`,
    };
  }

  return {
    ok: true,
    range: {
      timeMin: new Date(fromMs).toISOString(),
      timeMax: new Date(toMs).toISOString(),
      spanDays,
    },
  };
}
