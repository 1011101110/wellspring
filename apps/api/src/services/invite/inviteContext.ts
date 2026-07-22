/**
 * Assembles the deliberate-disclosure generation context from a parsed
 * inbound invite (Epic I / I2, #62, docs/12 §1.2, Foundation §8).
 *
 * The ONLY fields that may become generation context are the event's
 * subject (summary) and description — the user's own words, written on an
 * invitation they deliberately sent Wellspring. The organizer email, meeting
 * URL, attendees, and location are NEVER included (Foundation §8: only
 * subject+description are the scoped exception; everything else about the
 * event stays private). `ParsedInboundInvite` doesn't even carry an
 * attendee list, but this is enforced here explicitly so the boundary is
 * a single, tested choke point rather than an accident of the parser's
 * shape.
 *
 * Also derives a `durationPreference` from the event's own length — an
 * invite carries its own start/end, so the devotional should fit the
 * meeting the user actually booked (docs/12 §1.1 step 3).
 */
import type { DurationPreference } from '../gloo/instructionsBuilder.js';
import type { ParsedInboundInvite } from './inboundIcsParser.js';

export interface InviteGenerationContext {
  /** The user's own words (subject + description), or undefined if both are empty. */
  context: string | undefined;
  /** Format derived from the event's own duration; undefined lets the engine's band heuristic pick. */
  durationPreference: DurationPreference;
}

/** Maps an event duration (minutes) to a target format (docs/00 §5 length tiers). */
function durationToFormat(minutes: number): DurationPreference {
  if (minutes <= 3) return 'micro';
  if (minutes <= 7) return 'short';
  if (minutes <= 12) return 'standard';
  return 'extended';
}

export function buildInviteContext(invite: ParsedInboundInvite): InviteGenerationContext {
  // Subject + description ONLY — never organizer, meetingUrl, or location.
  const parts = [invite.summary?.trim(), invite.description?.trim()].filter(
    (p): p is string => !!p && p.length > 0,
  );
  const context = parts.length > 0 ? parts.join('\n\n') : undefined;

  let durationPreference: DurationPreference;
  if (invite.end) {
    const minutes = Math.round((invite.end.getTime() - invite.start.getTime()) / 60_000);
    if (minutes > 0) durationPreference = durationToFormat(minutes);
  }

  return { context, durationPreference };
}
