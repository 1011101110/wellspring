/**
 * Calendar event body per the Wellspring Design System §06 (T4 #351,
 * epic #347) — shared by BOTH writers of event descriptions:
 *
 *   - the Google Calendar insert path (generateNowOrchestrator's Step 6g),
 *   - the .ics invite DESCRIPTION (icsInvite.buildInviteDescription).
 *
 * §06 contract: the exact verse text comes FIRST (never paraphrased —
 * §08), with its reference + version/attribution line, then one short
 * reflection line (cardSummary), then ONE link labeled
 * "Begin your moment ↗" (§07 voice — an invitation, never urgency).
 * Plain-text-safe: no HTML/markdown, works verbatim in Google Calendar,
 * Apple Calendar, and Outlook description fields.
 *
 * Fallback-link semantics (DEC-K3, D4/#32) are preserved: when a richer
 * delivery provider's join link differs from the plain session page, the
 * session page stays as an explicit "Prefer plain audio?" line — for the
 * default providers the two are byte-identical and the body carries
 * exactly one link. The "Scheduled by Wellspring" sign-off (UX Flows §5)
 * stays as the final line — it identifies the sender and is not a link.
 */

/** The verse §06 leads with — the "first verse leads" convention shared with the session page and SSML. */
export interface EventBodyVerse {
  /** Human-readable reference, e.g. "Matthew 11:28-30". */
  reference: string;
  /** The exact fetched translation text — rendered verbatim, never paraphrased. */
  fetchedText: string;
  /** Version + license line, e.g. "Berean Standard Bible (BSB). Public domain." */
  attribution: string;
}

export interface EventBodyInput {
  /** Scripture-first block; omit only when no verse content is available (the body then opens with the reflection). */
  verse?: EventBodyVerse | null;
  /** One short reflection line — `DevotionalOutput.cardSummary` (≤300 chars, Foundation §6). */
  reflection: string;
  /** The ONE link — the delivery provider's join URL (session or stage player). */
  beginUrl: string;
  /** Plain session page; rendered as an extra fallback line ONLY when it differs from `beginUrl` (DEC-K3). */
  fallbackUrl?: string;
}

/** Final sign-off line (UX Flows §5) — plain text, not a link. */
export const EVENT_BODY_FOOTER = 'Scheduled by Wellspring around your meetings — kairos.app';

/** §07 voice: the one action line. An invitation, never a command or countdown. */
export const BEGIN_LINE_LABEL = 'Begin your moment ↗';

export function buildEventBody(input: EventBodyInput): string {
  const lines: string[] = [];
  if (input.verse) {
    lines.push(`“${input.verse.fetchedText}”`, `${input.verse.reference} · ${input.verse.attribution}`, '');
  }
  lines.push(input.reflection, '', `${BEGIN_LINE_LABEL} ${input.beginUrl}`);
  if (input.fallbackUrl && input.fallbackUrl !== input.beginUrl) {
    lines.push(`Prefer plain audio? ${input.fallbackUrl}`);
  }
  lines.push('', EVENT_BODY_FOOTER);
  return lines.join('\n');
}
