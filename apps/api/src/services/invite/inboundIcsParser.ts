/**
 * Inbound `.ics` invite parsing (Epic I, issue #61, docs/12 §1.1 steps
 * 2–3). This is the receiving-side counterpart to `icsInvite.ts`, which
 * only ever *generates* outbound invites (EPIC C) — parsing is a
 * different concern and uses a different library (`node-ical`;
 * `ical-generator` is generation-only).
 *
 * Scope: extract exactly the fields docs/12 §1.1 needs (UID/SEQUENCE for
 * update-vs-new detection, start/end, subject+description as deliberate-
 * disclosure generation context, organizer email for the docs/12 §1.4.3
 * account-ownership check, and a best-effort meeting URL). Does not
 * validate theological content or call DevotionalEngine — that's issue
 * #62's job.
 */
import ical from 'node-ical';

export interface ParsedInboundInvite {
  uid: string;
  sequence: number;
  method: string | null;
  /** Cancellation per docs/12 §1.1 step 6 ("METHOD:CANCEL, same UID"). */
  isCancellation: boolean;
  start: Date;
  end: Date | null;
  summary: string;
  description: string | null;
  /** Lowercased, `mailto:`-stripped organizer email, or null if absent/unparseable. */
  organizerEmail: string | null;
  /** Best-effort Meet/Zoom/Teams link found in location/description/url — null if none found. */
  meetingUrl: string | null;
}

const MEETING_URL_PATTERN =
  /https?:\/\/(?:[\w-]+\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com)\/\S+/i;

function unwrapParamValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'val' in (value as Record<string, unknown>)) {
    const val = (value as { val: unknown }).val;
    return typeof val === 'string' ? val : null;
  }
  return null;
}

function extractOrganizerEmail(organizer: unknown): string | null {
  const raw = unwrapParamValue(organizer);
  if (!raw) return null;
  const email = raw.replace(/^mailto:/i, '').trim();
  return email.length > 0 ? email.toLowerCase() : null;
}

function extractMeetingUrl(...candidates: Array<string | null>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(MEETING_URL_PATTERN);
    if (match) return match[0];
  }
  return null;
}

/**
 * Parses a raw iCalendar payload and returns the single VEVENT it
 * describes. Inbound invite emails carry exactly one VEVENT per docs/12's
 * flow (an individual invite, not a bulk calendar export) — if none is
 * found, or more than one non-cancellation VEVENT is present, this
 * throws rather than guessing which one matters.
 */
export async function parseInboundIcs(icsText: string): Promise<ParsedInboundInvite> {
  const parsed = await ical.async.parseICS(icsText);

  const vevents = Object.values(parsed).filter(
    (component): component is ical.VEvent => component?.type === 'VEVENT',
  );

  if (vevents.length === 0) {
    throw new Error('parseInboundIcs: no VEVENT found in payload');
  }
  if (vevents.length > 1) {
    throw new Error(`parseInboundIcs: expected exactly one VEVENT, found ${vevents.length}`);
  }

  const event = vevents[0]!;
  const method = (unwrapParamValue(event.method) ?? '').toUpperCase() || null;
  const location = unwrapParamValue(event.location);
  const description = unwrapParamValue(event.description);
  const summary = unwrapParamValue(event.summary) ?? '';

  return {
    uid: event.uid,
    sequence: event.sequence ?? 0,
    method,
    isCancellation: method === 'CANCEL',
    start: event.start,
    end: event.end ?? null,
    summary,
    description,
    organizerEmail: extractOrganizerEmail(event.organizer),
    meetingUrl: extractMeetingUrl(location, description, unwrapParamValue(event.url)),
  };
}
