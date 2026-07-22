import { describe, expect, it } from 'vitest';
import { parseInboundIcs } from '../../../src/services/invite/inboundIcsParser.js';
import { buildInviteIcs } from '../../../src/services/invite/icsInvite.js';

/**
 * A realistic inbound invite: the USER is the organizer (they created this
 * event on their own calendar and invited Wellspring's routing address as an
 * attendee), per docs/12 §1.1 step 1 — the inverse direction from
 * icsInvite.ts's own outbound generation.
 */
function buildInboundFixture(overrides: Partial<Record<string, string>> = {}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'METHOD:' + (overrides.method ?? 'REQUEST'),
    'BEGIN:VEVENT',
    'UID:' + (overrides.uid ?? 'abc123@google.com'),
    'SEQUENCE:' + (overrides.sequence ?? '0'),
    'DTSTAMP:20260710T120000Z',
    'DTSTART:20260712T140000Z',
    'DTEND:20260712T143000Z',
    'SUMMARY:' + (overrides.summary ?? 'Weekly check-in with the team'),
    'DESCRIPTION:' +
      (overrides.description ??
        'Rough week honestly. Meet link: https://meet.google.com/abc-defg-hij'),
    'ORGANIZER;CN=Jane Doe:mailto:' + (overrides.organizer ?? 'jane@example.com'),
    'ATTENDEE;RSVP=TRUE:mailto:u_user-123@invite.kairos.app',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

describe('parseInboundIcs', () => {
  it('extracts uid, sequence, summary, description, organizer, and meeting URL', async () => {
    const result = await parseInboundIcs(buildInboundFixture());

    expect(result.uid).toBe('abc123@google.com');
    expect(result.sequence).toBe(0);
    expect(result.method).toBe('REQUEST');
    expect(result.isCancellation).toBe(false);
    expect(result.summary).toBe('Weekly check-in with the team');
    expect(result.description).toContain('Rough week honestly');
    expect(result.organizerEmail).toBe('jane@example.com');
    expect(result.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(result.start.toISOString()).toBe('2026-07-12T14:00:00.000Z');
    expect(result.end?.toISOString()).toBe('2026-07-12T14:30:00.000Z');
  });

  it('detects a CANCEL as isCancellation, same UID', async () => {
    const result = await parseInboundIcs(buildInboundFixture({ method: 'CANCEL', sequence: '1' }));
    expect(result.isCancellation).toBe(true);
    expect(result.sequence).toBe(1);
  });

  it('finds a Zoom link when present instead of Meet', async () => {
    const result = await parseInboundIcs(
      buildInboundFixture({ description: 'Join here: https://zoom.us/j/1234567890' }),
    );
    expect(result.meetingUrl).toBe('https://zoom.us/j/1234567890');
  });

  it('returns null meetingUrl when no known video-conferencing link is present', async () => {
    const result = await parseInboundIcs(buildInboundFixture({ description: 'No link this time.' }));
    expect(result.meetingUrl).toBeNull();
  });

  it('lowercases the organizer email', async () => {
    const result = await parseInboundIcs(buildInboundFixture({ organizer: 'Jane.Doe@Example.COM' }));
    expect(result.organizerEmail).toBe('jane.doe@example.com');
  });

  it('throws when there is no VEVENT at all', async () => {
    const bareCalendar = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR'].join('\r\n');
    await expect(parseInboundIcs(bareCalendar)).rejects.toThrow('no VEVENT found');
  });

  it('round-trips our own outbound generator output (icsInvite.ts) without throwing', async () => {
    const ics = buildInviteIcs({
      devotionalId: 'devotional-abc',
      start: new Date('2026-07-12T07:00:00Z'),
      end: new Date('2026-07-12T07:15:00Z'),
      content: {
        cardSummary: 'A short devotional summary.',
        sessionUrl: 'https://kairos.app/session/tok123',
        verses: [{ attribution: 'Psalm 46:10, NIV' }],
      },
      organizer: { email: 'noreply@kairos.app', name: 'Wellspring' },
      attendee: { email: 'user@example.com', name: 'Jane' },
    });

    const result = await parseInboundIcs(ics);
    expect(result.organizerEmail).toBe('noreply@kairos.app');
    expect(result.summary.length).toBeGreaterThan(0);
  });
});
