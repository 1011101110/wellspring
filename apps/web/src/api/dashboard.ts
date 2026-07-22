/**
 * The remaining dashboard reads and the one dashboard write.
 *
 * Each function is one endpoint, parsed through its shared contract. They
 * are separate calls rather than one aggregate fetch because #237 requires
 * cards to fail independently: an aggregate would make any single failure
 * everyone's failure, which is the spinner-of-everything in a different
 * costume.
 */
import {
  ConnectionsResponseSchema,
  GenerateNowResponseSchema,
  MonthlyRecapResponseSchema,
  UpcomingCalendarEventsResponseSchema,
  type ConnectionsResponse,
  type GenerateNowResponse,
  type MonthlyRecapResponseData,
  type UpcomingCalendarEvent,
} from '@kairos/shared-contracts';
import { ApiError, apiFetch } from './client';

function shapeError(what: string): ApiError {
  return new ApiError(200, `Wellspring sent ${what} in a shape this app does not understand.`);
}

export async function getUpcomingEvents(): Promise<readonly UpcomingCalendarEvent[]> {
  const result = UpcomingCalendarEventsResponseSchema.safeParse(
    await apiFetch<unknown>('/v1/calendar-events/upcoming'),
  );
  if (!result.success) throw shapeError('your schedule');
  return result.data.data;
}

export async function getConnections(): Promise<ConnectionsResponse> {
  const result = ConnectionsResponseSchema.safeParse(await apiFetch<unknown>('/v1/connections'));
  if (!result.success) throw shapeError('your calendar connection');
  return result.data;
}

/**
 * The monthly recap (#96), whose first client consumer this is.
 *
 * `month` is 1-based to match the route (`/v1/recap/:year/:month`), not
 * JavaScript's 0-based `getMonth()`. The conversion happens at the call
 * site, once, and is the kind of off-by-one that is invisible until a user
 * reads their July recap in August.
 */
export async function getRecap(year: number, month: number): Promise<MonthlyRecapResponseData> {
  const result = MonthlyRecapResponseSchema.safeParse(
    await apiFetch<unknown>(`/v1/recap/${year}/${month}`),
  );
  if (!result.success) throw shapeError('your recap');
  return result.data.data;
}

/**
 * The "+" button (L2, #238).
 *
 * `mode: 'now'` is what separates this from the distress check-in (#77)
 * that shares the endpoint. Sending it explicitly matters: the request
 * schema *defaults* to `'distress'`, so an omitted mode would silently
 * hand a user who pressed "+" an elevated-care `micro` devotional with a
 * crisis resource pointer they did not ask for. The default is right for
 * the older caller and wrong for this one.
 *
 * `distressSignal` is deliberately not sent. The route ignores it in
 * `'now'` mode by design, and sending a field the server discards is the
 * beginning of a client that believes it controls something it does not.
 */
export async function generateNow(): Promise<GenerateNowResponse> {
  const result = GenerateNowResponseSchema.safeParse(
    await apiFetch<unknown>('/v1/devotional/generate-now', {
      method: 'POST',
      body: { mode: 'now' },
    }),
  );
  if (!result.success) throw shapeError('the new devotional');
  return result.data;
}
