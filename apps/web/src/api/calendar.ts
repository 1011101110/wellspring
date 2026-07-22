/**
 * `GET /v1/calendar/freebusy` — the calendar view's only new read
 * (M2–M5, epic #255).
 *
 * Parsed through `FreeBusyResponseSchema` rather than cast. That matters
 * more here than on most reads: the response is a discriminated union
 * whose `ok` variant is the only one carrying `busy`, and a cast would
 * hand the caller a type that *claims* the key exists on every variant.
 * The decoder is what makes the contract's guarantee real on this side of
 * the wire.
 */
import {
  FreeBusyResponseSchema,
  FREEBUSY_MAX_RANGE_DAYS,
  type FreeBusyData,
} from '@kairos/shared-contracts';
import { ApiError, apiFetch } from './client';

/**
 * The 400 the range gate answers with.
 *
 * No view can currently provoke it — the widest grid is 42 days against a
 * 45-day cap — but "cannot currently happen" is not "cannot happen", and
 * the failure mode if it ever does is a card stuck in a retry loop against
 * a request that will never be accepted. Naming the state lets the card
 * say so instead. The message is written for a user, not a developer: the
 * server's own text ("Query parameter \"to\" must be after \"from\"") is
 * accurate and useless to them.
 */
export const FREEBUSY_RANGE_MESSAGE = `Wellspring asked for more calendar than it is allowed to read at once (${FREEBUSY_MAX_RANGE_DAYS} days). This is a bug on our side, not something you can fix.`;

export async function getFreeBusy(from: string, to: string): Promise<FreeBusyData> {
  const query = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  let body: unknown;
  try {
    body = await apiFetch<unknown>(`/v1/calendar/freebusy${query}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      throw new ApiError(400, FREEBUSY_RANGE_MESSAGE, err.code);
    }
    /*
     * A 502 (`UPSTREAM_UNAVAILABLE`) deliberately falls through to the
     * card's error state. The route returns it when Google could not be
     * read at all, and the route's own comment explains why that is not
     * one of the degraded 200s: we do not know what the calendar looks
     * like, and drawing it as empty would render a packed day as wide
     * open.
     */
    throw err;
  }

  const result = FreeBusyResponseSchema.safeParse(body);
  if (!result.success) {
    throw new ApiError(200, 'Wellspring sent your calendar in a shape this app does not understand.');
  }
  return result.data.data;
}
