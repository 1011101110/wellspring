import { z } from 'zod';

/**
 * `GET /v1/calendar-events/upcoming` (L4, issue #240).
 *
 * ## Why a separate route rather than `GET /v1/calendar-events?from=now`
 *
 * #240 leaves the choice open ("`?from=now` filter (or a dedicated
 * shape)"). A dedicated route, because the two differ in **shape**, not
 * just in which rows come back:
 *
 *  - `GET /v1/calendar-events` returns raw `calendar_events` rows
 *    (snake_case, every column, `provider_event_id` and `gap_source`
 *    included). #240 asks for something else entirely — a camelCased
 *    projection joined across to `devotionals` for `theme` and
 *    `cardSummary`. A query parameter that changes the response *type* is
 *    the thing that makes a client's decoder unpredictable: the same URL
 *    would return two different structures depending on a flag, and every
 *    consumer would have to branch on a parameter it sent rather than on
 *    the endpoint it called.
 *  - The existing route has shipped consumers. Leaving it byte-identical
 *    means this story cannot regress them, which a shared handler growing
 *    a conditional projection could not promise as cheaply.
 *  - "Upcoming" is a server-side judgement (what counts as future, in
 *    which zone, with what ordering), not a caller-supplied filter. Baking
 *    it into a route name means there is exactly one answer to it. A
 *    `?from=` timestamp would additionally invite clients to send *their*
 *    idea of now — precisely the #205 class of timezone bug, arriving
 *    over the wire.
 */
export const UpcomingCalendarEventSchema = z.object({
  id: z.string(),
  /** ISO-8601 instants (UTC). Clients render them in the user's profile zone — #205: never a bare `toLocaleString()`. */
  gapStartAt: z.string(),
  gapEndAt: z.string(),
  /** H1 (#53): real Meet join URL when the event was created with conferenceData, else `null`. */
  meetUri: z.string().nullable(),
  /** Architecture §3.3 bumps this each time the watcher moves the event. */
  rescheduleCount: z.number().int(),
  /**
   * The linked devotional, or `null`. Nullable because
   * `calendar_events.devotional_id` is itself nullable — an event can be
   * booked for a gap before its devotional exists, and #217's cleanup
   * semantics can leave an event whose devotional is gone. A row with no
   * devotional is still a real booking on the user's calendar and still
   * belongs in this list; the client shows the time without a theme
   * rather than the list silently losing an event it booked.
   */
  devotional: z
    .object({
      id: z.string(),
      theme: z.string(),
      cardSummary: z.string(),
    })
    .nullable(),
});
export type UpcomingCalendarEvent = z.infer<typeof UpcomingCalendarEventSchema>;

export const UpcomingCalendarEventsResponseSchema = z.object({
  ok: z.literal(true),
  data: z.array(UpcomingCalendarEventSchema),
});
export type UpcomingCalendarEventsResponse = z.infer<typeof UpcomingCalendarEventsResponseSchema>;
