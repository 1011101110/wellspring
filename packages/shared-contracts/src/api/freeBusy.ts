import { z } from 'zod';

/**
 * `GET /v1/calendar/freebusy` (M1, issue #255) — the dashboard calendar
 * view's live free/busy proxy.
 *
 * ## This endpoint reads through to Google on every request
 *
 * Busy blocks are **never written to the database** (Foundation §8:
 * "calendar access is used for free/busy computation and event insertion
 * only; event titles/attendees are not persisted", and the header comment
 * on `googleCalendarClient.ts` restates it as an invariant). Epic #255
 * calls this out as the second constraint shaping the feature: "this
 * cannot read from our own tables — it needs a live proxy to Google per
 * request".
 *
 * So there is no table behind this contract, no migration, and no cursor.
 * What comes back is what Google said a moment ago, for the range asked.
 *
 * ## Why the response is a discriminated union rather than `busy: []`
 *
 * This is the load-bearing design decision in the whole contract, and it
 * exists because of a bug this repo already shipped once.
 *
 * The obvious shape is `{ busy: [...], calendarEnabled: boolean }` — a
 * list plus a flag. The problem is what a client does when it forgets the
 * flag: it renders an empty `busy` array as **a completely free calendar**.
 * That is not a degraded state, it is a confident lie, and it is exactly
 * the failure mode of #253 (the connection card that rendered "no calendar
 * connected" — indistinguishable from the genuine empty state — while an
 * active row sat in the database). docs/07 §3.1 files that bug under
 * "distinct concepts get distinct types", and a free hour and an unread
 * calendar are as distinct as two concepts get.
 *
 * So `busy` exists **only** on the `ok` variant. In every degraded state
 * the key is absent, not empty. A client that ignores `status` cannot
 * render a wrong calendar, because there is no array for it to render —
 * it fails visibly at the decoder instead of silently at the pixel. The
 * dishonest rendering is unreachable by construction rather than
 * prevented by a convention someone has to remember.
 */

/**
 * A single opaque busy window.
 *
 * Start and end, and deliberately nothing else — this is the entire
 * payload Google's `freebusy.query` returns, and per epic #255 that is
 * "not a limitation to work around; it is the product's privacy posture".
 * The granted scopes are `calendar.freebusy` + `calendar.events`, never
 * `calendar.readonly`, so no title/attendee/location field exists to omit.
 * There is nothing to strip here because there was never anything to strip.
 */
export const FreeBusyBlockSchema = z.object({
  /** ISO-8601 instant. The client renders it in the user's profile zone (#205), never the browser's. */
  start: z.string(),
  end: z.string(),
});
export type FreeBusyBlockDto = z.infer<typeof FreeBusyBlockSchema>;

/**
 * Why each non-`ok` state is a 200 and not an error status.
 *
 * A user who turned the calendar toggle off, and a user who never
 * connected Google, have both produced *correct* system behaviour. #255's
 * acceptance criterion is that they "degrade honestly" — and an HTTP error
 * is not honest here: it makes the client's error path apologize for
 * something that is working as designed, and (per #240's identical call on
 * the empty schedule) "a 404 or a 500 here would make the client apologize
 * for correct behavior".
 *
 * Genuine faults keep their error statuses: a bad range is a 400, a Google
 * failure is a 502. Those are in `ErrorEnvelopeSchema`, not here.
 */
export const FreeBusyStatusSchema = z.enum([
  /** A real read happened. `busy` is present and authoritative for the range. */
  'ok',
  /**
   * `preferences.calendar_enabled = false`. No free/busy read was
   * attempted and the OAuth refresh token was not decrypted (#201,
   * Foundation §8: the gate suppresses the signal at *read* time). The UI
   * should offer the consent toggle, not a reconnect button — the Google
   * grant is untouched and re-enabling is one switch away (Foundation §8:
   * "revoking a category does not revoke the underlying OAuth grant").
   */
  'consent_disabled',
  /**
   * No `google_calendar` connection row, or one whose status is not
   * `active`. The UI renders "connect to see your calendar". Distinct from
   * `consent_disabled` because the remedy is different: this one needs the
   * OAuth flow, that one needs a toggle. Collapsing them would send a
   * revoked user to a switch that changes nothing.
   */
  'not_connected',
]);
export type FreeBusyStatus = z.infer<typeof FreeBusyStatusSchema>;

/**
 * The requested range, echoed back on every variant including the degraded
 * ones.
 *
 * Echoed because the client is a calendar grid that keeps several ranges in
 * flight at once (a day/week/month toggle fires overlapping requests, and
 * they can land out of order). Without the range in the body, a late
 * response for last week's window is indistinguishable from the current
 * one and paints the wrong grid. The client matches on these fields rather
 * than assuming the newest response answers the newest request.
 *
 * `timeZone` is the zone the query was actually resolved in — the user's
 * profile zone (`users.timezone`), not the browser's (#205, and #255's
 * timezone section). Returned so the grid can label its axis with the same
 * zone the server used instead of re-deriving it and disagreeing.
 */
export const FreeBusyRangeSchema = z.object({
  from: z.string(),
  to: z.string(),
  timeZone: z.string(),
});

export const FreeBusyDataSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    range: FreeBusyRangeSchema,
    /** Present ONLY here. See the module doc for why absence beats `[]`. */
    busy: z.array(FreeBusyBlockSchema),
  }),
  z.object({
    status: z.literal('consent_disabled'),
    range: FreeBusyRangeSchema,
  }),
  z.object({
    status: z.literal('not_connected'),
    range: FreeBusyRangeSchema,
  }),
]);
export type FreeBusyData = z.infer<typeof FreeBusyDataSchema>;

export const FreeBusyResponseSchema = z.object({
  ok: z.literal(true),
  data: FreeBusyDataSchema,
});
export type FreeBusyResponse = z.infer<typeof FreeBusyResponseSchema>;

/**
 * Maximum queryable span, in days.
 *
 * ## Google does not document a range cap — this is our limit, not theirs
 *
 * Epic #255 states that "Google both caps the range and meters the rate"
 * and instructs verifying the actual limits rather than assuming. Verified,
 * and the premise is **half wrong**, which is worth recording so nobody
 * re-derives it:
 *
 *  - **Rate: real and documented.** 600 requests/minute per user per
 *    project and 10,000/minute per project, metered on a sliding window,
 *    plus a 1,000,000 requests/project/day billing threshold from
 *    2026-05-01. (Calendar API "Usage limits" guide.)
 *  - **Range: no documented cap.** The `freebusy.query` reference specifies
 *    `timeMin`/`timeMax` only as RFC3339 instants. The documented limits on
 *    that page are about *breadth*, not *length* — `calendarExpansionMax`
 *    (≤50 calendars) and `groupExpansionMax` (≤100), with errors
 *    `tooManyCalendarsRequested` and `groupTooBig`. Neither constrains how
 *    long a span may be, and no "range too long" error is documented.
 *
 * Sources:
 *  - https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
 *  - https://developers.google.com/workspace/calendar/api/guides/quota
 *
 * So this cap is a **product decision about our own quota**, and it is
 * enforced precisely *because* Google will not enforce it for us: an
 * unbounded range would be accepted upstream, and the failure would arrive
 * later as rate-limiting across every user on the project rather than as a
 * 400 to the one caller who asked for a year. #255's requirement that "a
 * client asking for a year must fail fast, not melt the quota" is
 * achievable only server-side.
 *
 * ## Why 45
 *
 * Sized to the widest legitimate view and no wider. A month grid renders
 * whole weeks, so a 31-day month starting late in the week spans **6 rows
 * = 42 days**. Adding a day of slack for the zone offset between a grid
 * built in the user's zone and a range expressed as instants (up to ±14h,
 * so at most one extra calendar day at each edge) gives 44; 45 is the
 * round number above it.
 *
 * This is deliberately not a generous ceiling. A limit that admits a
 * quarter would silently permit a client bug to become a quota incident,
 * and M4's month view is the widest thing #255 plans to build.
 */
export const FREEBUSY_MAX_RANGE_DAYS = 45;
