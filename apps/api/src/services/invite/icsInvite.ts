/**
 * icsInvite — RFC 5545 calendar invite generation for the .ics email path
 * (EPIC C, issue #26). Covers Apple Calendar / M365 / "anything else" users
 * who have not connected Google Calendar (docs/03_API_INTEGRATION_SPEC.md
 * §5), and is also the fallback when `events.insert` fails after retries
 * (API spec §4, Architecture §4).
 *
 * Scope of this module: **generation only**. Building the
 * `text/calendar; method=REQUEST` MIME part and handing it to an email
 * provider (Resend primary / SendGrid alternate, API spec §5) needs
 * `RESEND_API_KEY`, which is not available yet — actual sending is
 * intentionally out of scope here. `EmailSender` below is the seam a later
 * stage wires a real provider into; `ConsoleEmailSender` is the test
 * double that stands in until then.
 *
 * Contract sources:
 *   - docs/03_API_INTEGRATION_SPEC.md §5 (.ics email invite path table):
 *     METHOD:REQUEST for initial + updates, UID stability
 *     (`kairos-<devotionalId>@kairos.app`), SEQUENCE increments on update,
 *     METHOD:CANCEL for cancellation (same UID), ORGANIZER = Wellspring sender
 *     address / ATTENDEE = user email (RSVP=FALSE), DESCRIPTION/URL = same
 *     content contract as §4.2.
 *   - docs/05_UX_FLOWS.md §5 (calendar-event copy spec, F3): title default
 *     "Wellspring — a moment of rest"; description template = cardSummary +
 *     blank line + "Join: {session URL}" + blank line + one-line YouVersion
 *     attribution (short form) + blank line + "Scheduled by Wellspring around
 *     your meetings — kairos.app"; never include bands/health language.
 *   - docs/00_FOUNDATION.md §8: event descriptions must never carry bands,
 *     raw event titles/attendees from other events, or health language —
 *     this module only ever sees devotional content the user already
 *     consented to receive (cardSummary, verse attribution), never raw
 *     calendar/health data, so there is nothing to filter here — but no
 *     caller should ever pass ambient calendar data into `description`.
 *
 * ⚠️ Doc discrepancy (not silently resolved, per repo instructions): API
 * spec §4.2's Google `events.insert` example titles the event
 * "Wellspring — a moment with God", while UX Flows §5 (the more detailed,
 * later-numbered copy spec) pins the default title as
 * "Wellspring — a moment of rest". This module follows UX Flows §5 as the more
 * specific source for exact user-facing copy; flagged in the final report
 * for a doc fix.
 */

import ical, { ICalCalendarMethod, ICalEventStatus, type ICalCalendar } from 'ical-generator';

/** Wellspring's own domain — UID suffix and the "Scheduled by Wellspring" footer link. API spec §5. */
const KAIROS_DOMAIN = 'kairos.app';

/** Default event title — UX Flows §5 (user-customizable *prefix* in Preferences; this is the base default). */
export const DEFAULT_EVENT_TITLE = 'Wellspring — a moment of rest';

/** Footer line appended to every description — UX Flows §5 description template, final line. */
const SCHEDULED_BY_FOOTER = `Scheduled by Wellspring around your meetings — ${KAIROS_DOMAIN}`;

/**
 * Stable UID for a devotional's calendar event — API spec §5: "identical
 * across updates so clients replace, not duplicate." A later
 * `METHOD:CANCEL` must reference this exact same UID to cancel the same
 * event, so the format is intentionally a pure function of `devotionalId`
 * with no time/nonce component.
 */
export function icsUidFor(devotionalId: string): string {
  return `kairos-${devotionalId}@${KAIROS_DOMAIN}`;
}

/** One verse's attribution, as carried in `DevotionalOutput.verses[]` (shared-contracts `VerseSchema`). */
export interface InviteVerseAttribution {
  attribution: string;
}

/** Minimal input this module needs from a full `DevotionalOutput` — kept narrow so callers don't have to construct a whole devotional just to build an invite (e.g. tests). */
export interface InviteContent {
  /** ≤300 chars, `DevotionalOutput.cardSummary` — Foundation §6. */
  cardSummary: string;
  /** Full URL to the hosted session page (`GET /session/:token`, API spec §8.2). */
  sessionUrl: string;
  /** At least one verse's attribution string; the first is used as the description's short attribution line (matches the session-page/SSML convention of "first verse leads"). */
  verses: InviteVerseAttribution[];
}

export interface InviteAttendee {
  email: string;
  /** Display name, never a raw calendar contact name from another event — just cosmetic (e.g. "Jane"). Optional. */
  name?: string;
}

export interface InviteOrganizer {
  email: string;
  name?: string;
}

export interface BuildInviteInput {
  /** Stable ID this devotional/event is keyed by — drives the UID (API spec §5) and, unless overridden, the local part of derived identifiers. */
  devotionalId: string;
  /** Event start time (UTC or zoned `Date` — ical-generator handles the VTIMEZONE). */
  start: Date;
  /** Event end time. Must be after `start`. */
  end: Date;
  /** Event title. Defaults to `DEFAULT_EVENT_TITLE`; callers pass a user-customized prefix per UX Flows §5. */
  title?: string;
  content: InviteContent;
  organizer: InviteOrganizer;
  /**
   * Single recipient — the base-product (#26) single-user .ics path.
   * Provide exactly one of `attendee` or `attendees`.
   */
  attendee?: InviteAttendee;
  /**
   * Multiple recipients — team devotionals (Epic I / I3, #63, docs/12
   * §2.1/§2.4): one shared devotional, one invite, N attendees. Emits one
   * ATTENDEE line per entry. Provide exactly one of `attendee`/`attendees`.
   */
  attendees?: InviteAttendee[];
  /**
   * SEQUENCE number — API spec §5: "Re-send same UID with incremented
   * SEQUENCE" on update. Starts at 0 for the original invite. Callers own
   * tracking this per devotional (e.g. a `sequence` column); this module
   * does not persist state.
   */
  sequence?: number;
  /** IANA timezone for start/end, e.g. "America/Denver". Defaults to UTC when omitted (ical-generator floats otherwise; we always pin one explicitly for determinism). */
  timezone?: string;
  /** Injectable clock for deterministic DTSTAMP in golden-file tests. Defaults to `Date.now`. */
  now?: () => Date;
}

export interface BuildCancelInput {
  devotionalId: string;
  start: Date;
  end: Date;
  title?: string;
  organizer: InviteOrganizer;
  /** Provide exactly one of `attendee`/`attendees` — see BuildInviteInput. */
  attendee?: InviteAttendee;
  attendees?: InviteAttendee[];
  /** SEQUENCE for the cancellation — API spec §5 doesn't mandate a specific bump rule beyond "same UID"; convention (and every major client's expectation) is SEQUENCE strictly greater than the last REQUEST's, so cancelling after N updates should pass `sequence: N + 1`. */
  sequence?: number;
  timezone?: string;
  now?: () => Date;
}

/** Builds the DESCRIPTION body — UX Flows §5 template: cardSummary, blank line, "Join: {url}", blank line, attribution, blank line, footer. */
export function buildInviteDescription(content: InviteContent): string {
  const attributionLine = content.verses[0]?.attribution;
  const lines = [content.cardSummary, '', `Join: ${content.sessionUrl}`];
  if (attributionLine) {
    lines.push('', attributionLine);
  }
  lines.push('', SCHEDULED_BY_FOOTER);
  return lines.join('\n');
}

/**
 * Resolves the one-or-many attendee input into a non-empty list. Prefers
 * the plural `attendees` (team path, I3); falls back to the singular
 * `attendee` (base path). Throws if neither is provided — an invite with
 * no recipient is a caller bug, not a silently-empty ATTENDEE list.
 */
function resolveAttendees(input: { attendee?: InviteAttendee; attendees?: InviteAttendee[] }): InviteAttendee[] {
  const list = input.attendees ?? (input.attendee ? [input.attendee] : []);
  if (list.length === 0) {
    throw new Error('icsInvite: at least one attendee is required (provide `attendee` or `attendees`)');
  }
  return list;
}

function assertValidWindow(start: Date, end: Date): void {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new Error('icsInvite: start must be a valid Date');
  }
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new Error('icsInvite: end must be a valid Date');
  }
  if (end.getTime() <= start.getTime()) {
    throw new Error('icsInvite: end must be after start');
  }
}

/**
 * Builds the `METHOD:REQUEST` calendar object for a devotional's invite —
 * used both for the initial invite and for updates (API spec §5: "Re-send
 * same UID with incremented SEQUENCE"). Returns the `ICalCalendar` so
 * callers can either serialize it (`.toString()`) or inspect it in tests
 * before choosing how to transport it.
 */
export function buildInviteCalendar(input: BuildInviteInput): ICalCalendar {
  assertValidWindow(input.start, input.end);
  const now = input.now ?? (() => new Date());
  const title = input.title ?? DEFAULT_EVENT_TITLE;
  const timezone = input.timezone ?? 'UTC';

  const calendar = ical({
    method: ICalCalendarMethod.REQUEST,
    prodId: { company: 'Wellspring', product: 'kairos-devotional', language: 'EN' },
    timezone,
  });

  calendar.createEvent({
    id: icsUidFor(input.devotionalId),
    sequence: input.sequence ?? 0,
    stamp: now(),
    start: input.start,
    end: input.end,
    timezone,
    summary: title,
    description: buildInviteDescription(input.content),
    url: input.content.sessionUrl,
    status: ICalEventStatus.CONFIRMED,
    organizer: organizerFor(input.organizer),
    attendees: resolveAttendees(input).map((a) => ({ name: a.name, email: a.email, rsvp: false })),
  });

  return calendar;
}

/** `ICalOrganizer.name` is required (unlike attendee `name`) — fall back to the email so callers don't have to supply a display name themselves. */
function organizerFor(organizer: InviteOrganizer): { name: string; email: string } {
  return { name: organizer.name ?? organizer.email, email: organizer.email };
}

/**
 * Builds the `METHOD:CANCEL` calendar object for a devotional's invite —
 * API spec §5: "Cancellation: METHOD:CANCEL, same UID." Per RFC 5545 §3.6.3
 * / common client behavior, a CANCEL should carry the same event window and
 * a SEQUENCE greater than any prior REQUEST so clients recognize it as
 * superseding the earlier invite rather than as a stray/older message.
 */
export function buildCancelCalendar(input: BuildCancelInput): ICalCalendar {
  assertValidWindow(input.start, input.end);
  const now = input.now ?? (() => new Date());
  const title = input.title ?? DEFAULT_EVENT_TITLE;
  const timezone = input.timezone ?? 'UTC';

  const calendar = ical({
    method: ICalCalendarMethod.CANCEL,
    prodId: { company: 'Wellspring', product: 'kairos-devotional', language: 'EN' },
    timezone,
  });

  calendar.createEvent({
    id: icsUidFor(input.devotionalId),
    sequence: input.sequence ?? 1,
    stamp: now(),
    start: input.start,
    end: input.end,
    timezone,
    summary: title,
    status: ICalEventStatus.CANCELLED,
    organizer: organizerFor(input.organizer),
    attendees: resolveAttendees(input).map((a) => ({ name: a.name, email: a.email, rsvp: false })),
  });

  return calendar;
}

/** Convenience wrapper: builds the REQUEST calendar and serializes it to the RFC 5545 text form ready for the `text/calendar` MIME part. */
export function buildInviteIcs(input: BuildInviteInput): string {
  return buildInviteCalendar(input).toString();
}

/** Convenience wrapper: builds the CANCEL calendar and serializes it to RFC 5545 text. */
export function buildCancelIcs(input: BuildCancelInput): string {
  return buildCancelCalendar(input).toString();
}

// ---------------------------------------------------------------------------
// EmailSender seam — where actual delivery plugs in later (needs
// RESEND_API_KEY, API spec §5 "emailed via Resend (primary) or SendGrid
// (alternate) as a text/calendar; method=REQUEST MIME part"). Not
// implemented in this module; only the interface + a logging test double.
// ---------------------------------------------------------------------------

/** MIME method parameter — RFC 5546 — mirrors `ICalCalendarMethod` but kept as a narrow string union so `EmailSender` implementations don't need to import ical-generator. */
export type IcsMethod = 'REQUEST' | 'CANCEL';

export interface IcsEmailMessage {
  /** One or more recipients — a team invite (I3) addresses all attendees on one email. */
  to: InviteAttendee[];
  from: InviteOrganizer;
  subject: string;
  /** Plain-text or simple HTML body shown alongside the calendar part (e.g. "Your Wellspring moment is booked."). Not the .ics content itself. */
  bodyText: string;
  /** Serialized RFC 5545 calendar text (`buildInviteIcs` / `buildCancelIcs` output). */
  ics: string;
  method: IcsMethod;
}

/**
 * Delivery seam. A real implementation (Resend primary / SendGrid
 * alternate, per API spec §5) sends `message` as a
 * `text/calendar; method=REQUEST` (or `method=CANCEL`) MIME part alongside
 * a plain-text/HTML body. Intentionally not implemented here — blocked on
 * `RESEND_API_KEY` (not available yet).
 */
export interface EmailSender {
  send(message: IcsEmailMessage): Promise<void>;
}

/**
 * Test/dev double: logs what *would* be sent instead of actually sending.
 * Also records every call so tests can assert on it without depending on
 * console output.
 */
export class ConsoleEmailSender implements EmailSender {
  public readonly sent: IcsEmailMessage[] = [];

  async send(message: IcsEmailMessage): Promise<void> {
    this.sent.push(message);
    // docs/14_IMPROVEMENT_REVIEW.md §2.12 / issue #87: the recipient
    // address is PII (docs/04 §1 — email is the only PII column in this
    // schema) and this dev-only stand-in otherwise wrote it straight to
    // stdout, which on Cloud Run means Cloud Logging. Log enough to
    // confirm a send happened without the address itself.
    console.log(
      `[ConsoleEmailSender] would send ${message.method} to <redacted>: "${message.subject}"`,
    );
  }
}

/** Builds the full email envelope (subject/body/ics) for a fresh or updated invite, ready to hand to an `EmailSender`. Does not send anything itself. */
export function buildInviteEmail(input: BuildInviteInput): IcsEmailMessage {
  return {
    to: resolveAttendees(input),
    from: input.organizer,
    subject: input.title ?? DEFAULT_EVENT_TITLE,
    bodyText: buildInviteDescription(input.content),
    ics: buildInviteIcs(input),
    method: 'REQUEST',
  };
}

/** Builds the full email envelope for a cancellation, ready to hand to an `EmailSender`. Does not send anything itself. */
export function buildCancelEmail(input: BuildCancelInput): IcsEmailMessage {
  return {
    to: resolveAttendees(input),
    from: input.organizer,
    subject: `Cancelled: ${input.title ?? DEFAULT_EVENT_TITLE}`,
    bodyText: `Your Wellspring moment has been cancelled.`,
    ics: buildCancelIcs(input),
    method: 'CANCEL',
  };
}
