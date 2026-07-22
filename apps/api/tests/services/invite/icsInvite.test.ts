import { describe, expect, it } from 'vitest';
import {
  ConsoleEmailSender,
  DEFAULT_EVENT_TITLE,
  buildCancelCalendar,
  buildCancelEmail,
  buildCancelIcs,
  buildInviteCalendar,
  buildInviteDescription,
  buildInviteEmail,
  buildInviteIcs,
  icsUidFor,
  type BuildCancelInput,
  type BuildInviteInput,
} from '../../../src/services/invite/icsInvite.js';

const FIXED_NOW = () => new Date('2026-07-02T12:00:00.000Z');

const baseInput: BuildInviteInput = {
  devotionalId: 'devo-abc123',
  start: new Date('2026-07-03T16:40:00.000Z'),
  end: new Date('2026-07-03T16:50:00.000Z'),
  content: {
    cardSummary: 'Come to me, weary one. Your body needs rest, not more hustle. Matthew 11:28–30',
    sessionUrl: 'https://kairos.app/session/f47ac10b-58cc-4372-a567-0e02b2c3d479',
    verses: [{ attribution: 'Berean Standard Bible (BSB). Public domain.' }],
  },
  organizer: { email: 'invites@kairos.app', name: 'Wellspring' },
  attendee: { email: 'jane@example.com', name: 'Jane' },
  timezone: 'UTC',
  now: FIXED_NOW,
};

// Captured verbatim from a real `buildInviteIcs(baseInput)` run (RFC 5545
// §3.1 75-octet line folding computed by ical-generator, not hand-typed) —
// this IS the golden file; any future diff here should come from an
// intentional change to icsInvite.ts, reviewed line-by-line, not from
// re-deriving the fold points by hand.
const GOLDEN_REQUEST =
  'BEGIN:VCALENDAR\r\n' +
  'VERSION:2.0\r\n' +
  'PRODID:-//Wellspring//kairos-devotional//EN\r\n' +
  'METHOD:REQUEST\r\n' +
  'BEGIN:VEVENT\r\n' +
  'UID:kairos-devo-abc123@kairos.app\r\n' +
  'SEQUENCE:0\r\n' +
  'DTSTAMP:20260702T120000Z\r\n' +
  'DTSTART:20260703T164000Z\r\n' +
  'DTEND:20260703T165000Z\r\n' +
  'SUMMARY:Wellspring — a moment of rest\r\n' +
  'DESCRIPTION:Come to me\\, weary one. Your body needs rest\\, not more hustle\r\n' +
  ' . Matthew 11:28–30\\n\\nJoin: https://kairos.app/session/f47ac10b-58cc-437\r\n' +
  ' 2-a567-0e02b2c3d479\\n\\nBerean Standard Bible (BSB). Public domain.\\n\\nSche\r\n' +
  ' duled by Wellspring around your meetings — kairos.app\r\n' +
  'ORGANIZER;CN="Wellspring":mailto:invites@kairos.app\r\n' +
  'ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE;CN="Jane":MAILTO:jane@example.com\r\n' +
  'URL;VALUE=URI:https://kairos.app/session/f47ac10b-58cc-4372-a567-0e02b2c3d\r\n' +
  ' 479\r\n' +
  'STATUS:CONFIRMED\r\n' +
  'END:VEVENT\r\n' +
  'END:VCALENDAR';

describe('icsUidFor', () => {
  it('is a pure function of devotionalId, stable across calls', () => {
    expect(icsUidFor('devo-abc123')).toBe('kairos-devo-abc123@kairos.app');
    expect(icsUidFor('devo-abc123')).toBe(icsUidFor('devo-abc123'));
  });

  it('differs for different devotionalIds', () => {
    expect(icsUidFor('devo-1')).not.toBe(icsUidFor('devo-2'));
  });
});

describe('buildInviteDescription', () => {
  it('follows the UX Flows §5 template: cardSummary, blank, Join line, blank, attribution, blank, footer', () => {
    const description = buildInviteDescription(baseInput.content);
    expect(description.split('\n')).toEqual([
      'Come to me, weary one. Your body needs rest, not more hustle. Matthew 11:28–30',
      '',
      'Join: https://kairos.app/session/f47ac10b-58cc-4372-a567-0e02b2c3d479',
      '',
      'Berean Standard Bible (BSB). Public domain.',
      '',
      'Scheduled by Wellspring around your meetings — kairos.app',
    ]);
  });

  it('omits the attribution line (but keeps structure) when there are no verses', () => {
    const description = buildInviteDescription({
      cardSummary: 'Summary only.',
      sessionUrl: 'https://kairos.app/session/tok',
      verses: [],
    });
    expect(description.split('\n')).toEqual([
      'Summary only.',
      '',
      'Join: https://kairos.app/session/tok',
      '',
      'Scheduled by Wellspring around your meetings — kairos.app',
    ]);
  });

  it('never contains band/health language (Foundation §8 — nothing to leak here since inputs are pre-filtered, but guard the template itself)', () => {
    const description = buildInviteDescription(baseInput.content);
    for (const forbidden of ['recovery', 'sleepQuality', 'busyness', 'HRV', 'heart rate']) {
      expect(description.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('buildInviteIcs — golden file (METHOD:REQUEST)', () => {
  it('renders the exact expected RFC 5545 structure for a known input', () => {
    const ics = buildInviteIcs(baseInput);
    expect(ics).toBe(GOLDEN_REQUEST);
  });

  it('starts with BEGIN:VCALENDAR and ends with END:VCALENDAR', () => {
    const ics = buildInviteIcs(baseInput);
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics.trim().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('contains exactly one VEVENT block', () => {
    const ics = buildInviteIcs(baseInput);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics.match(/END:VEVENT/g)).toHaveLength(1);
  });

  it('uses CRLF line endings per RFC 5545 §3.1', () => {
    const ics = buildInviteIcs(baseInput);
    // Every line break must be \r\n, not a bare \n.
    expect(ics.includes('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('sets METHOD:REQUEST at the calendar level', () => {
    expect(buildInviteIcs(baseInput)).toMatch(/METHOD:REQUEST\r\n/);
  });

  it('sets STATUS:CONFIRMED on the event', () => {
    expect(buildInviteIcs(baseInput)).toMatch(/STATUS:CONFIRMED\r\n/);
  });

  it('applies a default DTSTART/DTEND matching the input window', () => {
    const ics = buildInviteIcs(baseInput);
    expect(ics).toContain('DTSTART:20260703T164000Z');
    expect(ics).toContain('DTEND:20260703T165000Z');
  });

  it('defaults SEQUENCE to 0 for a fresh invite', () => {
    expect(buildInviteIcs(baseInput)).toContain('SEQUENCE:0');
  });

  it('defaults the title to DEFAULT_EVENT_TITLE when none is supplied', () => {
    expect(buildInviteIcs(baseInput)).toContain(`SUMMARY:${DEFAULT_EVENT_TITLE}`);
  });

  it('honors a custom title override (UX Flows §5 user-customizable prefix)', () => {
    const ics = buildInviteIcs({ ...baseInput, title: 'Focus time — a moment of rest' });
    expect(ics).toContain('SUMMARY:Focus time — a moment of rest');
    expect(ics).not.toContain(`SUMMARY:${DEFAULT_EVENT_TITLE}`);
  });

  it('sets ATTENDEE RSVP=FALSE (API spec §5: user is RSVP=FALSE)', () => {
    expect(buildInviteIcs(baseInput)).toMatch(/ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE/);
  });

  it('rejects an end time that is not after start', () => {
    expect(() => buildInviteIcs({ ...baseInput, end: baseInput.start })).toThrow(
      /end must be after start/,
    );
  });
});

describe('UID stability across a regenerate-for-update call', () => {
  it('produces the identical UID when the same devotionalId is regenerated with a new SEQUENCE/time', () => {
    const first = buildInviteCalendar(baseInput);
    const updated = buildInviteCalendar({
      ...baseInput,
      start: new Date('2026-07-03T17:10:00.000Z'),
      end: new Date('2026-07-03T17:20:00.000Z'),
      sequence: 1,
      now: () => new Date('2026-07-02T13:00:00.000Z'),
    });

    const firstUid = first.events()[0]?.id();
    const updatedUid = updated.events()[0]?.id();
    expect(firstUid).toBe(updatedUid);
    expect(firstUid).toBe('kairos-devo-abc123@kairos.app');
  });

  it('increments SEQUENCE on the regenerated (update) calendar object', () => {
    const first = buildInviteCalendar(baseInput);
    const updated = buildInviteCalendar({ ...baseInput, sequence: 1 });
    expect(first.events()[0]?.sequence()).toBe(0);
    expect(updated.events()[0]?.sequence()).toBe(1);
  });

  it('keeps METHOD:REQUEST on an update (API spec §5: updates are still METHOD:REQUEST)', () => {
    const updated = buildInviteIcs({ ...baseInput, sequence: 2 });
    expect(updated).toMatch(/METHOD:REQUEST\r\n/);
  });
});

describe('buildCancelIcs — METHOD:CANCEL variant', () => {
  const cancelInput: BuildCancelInput = {
    devotionalId: baseInput.devotionalId,
    start: baseInput.start,
    end: baseInput.end,
    organizer: baseInput.organizer,
    attendee: baseInput.attendee,
    timezone: 'UTC',
    now: FIXED_NOW,
    sequence: 1,
  };

  it('sets METHOD:CANCEL at the calendar level', () => {
    expect(buildCancelIcs(cancelInput)).toMatch(/METHOD:CANCEL\r\n/);
  });

  it('sets STATUS:CANCELLED on the event', () => {
    expect(buildCancelIcs(cancelInput)).toMatch(/STATUS:CANCELLED\r\n/);
  });

  it('references the exact same UID as the original REQUEST for the same devotionalId', () => {
    const request = buildInviteCalendar(baseInput);
    const cancel = buildCancelCalendar(cancelInput);
    expect(cancel.events()[0]?.id()).toBe(request.events()[0]?.id());
  });

  it('uses a SEQUENCE greater than the original REQUEST default (0)', () => {
    const cancel = buildCancelCalendar(cancelInput);
    expect(cancel.events()[0]?.sequence()).toBeGreaterThan(0);
  });

  it('defaults SEQUENCE to 1 when not supplied', () => {
    const { sequence: _seq, ...withoutSequence } = cancelInput;
    const cancel = buildCancelCalendar(withoutSequence);
    expect(cancel.events()[0]?.sequence()).toBe(1);
  });

  it('does not include a DESCRIPTION (cancellations need no devotional content)', () => {
    expect(buildCancelIcs(cancelInput)).not.toMatch(/DESCRIPTION:/);
  });

  it('renders exactly one VEVENT with CRLF line endings', () => {
    const ics = buildCancelIcs(cancelInput);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });
});

describe('EmailSender seam', () => {
  it('ConsoleEmailSender records sends instead of delivering anything', async () => {
    const sender = new ConsoleEmailSender();
    const message = buildInviteEmail(baseInput);

    await sender.send(message);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.to).toEqual([{ email: 'jane@example.com', name: 'Jane' }]);
    expect(sender.sent[0]?.method).toBe('REQUEST');
    expect(sender.sent[0]?.ics).toBe(GOLDEN_REQUEST);
  });

  it('buildCancelEmail produces a CANCEL-method message referencing the cancelled subject', async () => {
    const sender = new ConsoleEmailSender();
    const cancelInput: BuildCancelInput = {
      devotionalId: baseInput.devotionalId,
      start: baseInput.start,
      end: baseInput.end,
      organizer: baseInput.organizer,
      attendee: baseInput.attendee,
      timezone: 'UTC',
      now: FIXED_NOW,
      sequence: 1,
    };
    const message = buildCancelEmail(cancelInput);

    await sender.send(message);

    expect(message.method).toBe('CANCEL');
    expect(message.subject).toContain('Cancelled');
    expect(message.ics).toMatch(/METHOD:CANCEL/);
    expect(sender.sent).toHaveLength(1);
  });

  it('never actually performs network I/O (pure in-memory double)', async () => {
    const sender = new ConsoleEmailSender();
    await sender.send(buildInviteEmail(baseInput));
    // No fetch/http assertions needed — ConsoleEmailSender has no I/O
    // dependencies at all; this test documents that guarantee explicitly.
    expect(sender.sent[0]?.ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
  });
});

describe('team devotionals — multiple attendees (I3, #63)', () => {
  const teamAttendees = [
    { email: 'jane@example.com', name: 'Jane' },
    { email: 'sam@example.com', name: 'Sam' },
    { email: 'noname@example.com' },
  ];

  it('emits one ATTENDEE line per recipient in the .ics', () => {
    const ics = buildInviteIcs({ ...baseInput, attendee: undefined, attendees: teamAttendees });
    const attendeeLines = ics.split(/\r?\n/).filter((l) => l.startsWith('ATTENDEE'));
    expect(attendeeLines).toHaveLength(3);
    expect(ics).toContain('jane@example.com');
    expect(ics).toContain('sam@example.com');
    expect(ics).toContain('noname@example.com');
  });

  it('addresses all recipients on the email envelope', () => {
    const message = buildInviteEmail({ ...baseInput, attendee: undefined, attendees: teamAttendees });
    expect(message.to).toEqual(teamAttendees);
  });

  it('the single-attendee path still produces exactly one ATTENDEE line (backward compatible)', () => {
    const ics = buildInviteIcs(baseInput);
    expect(ics.split(/\r?\n/).filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(1);
  });

  it('cancellations also fan out to every recipient', () => {
    const ics = buildCancelIcs({
      devotionalId: baseInput.devotionalId,
      start: baseInput.start,
      end: baseInput.end,
      organizer: baseInput.organizer,
      attendees: teamAttendees,
      sequence: 1,
      timezone: 'UTC',
      now: FIXED_NOW,
    });
    expect(ics.split(/\r?\n/).filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(3);
    expect(ics).toMatch(/METHOD:CANCEL/);
  });

  it('throws when neither attendee nor attendees is provided', () => {
    expect(() => buildInviteIcs({ ...baseInput, attendee: undefined, attendees: undefined })).toThrow(
      /at least one attendee/,
    );
  });

  it('throws on an empty attendees array', () => {
    expect(() => buildInviteIcs({ ...baseInput, attendee: undefined, attendees: [] })).toThrow(/at least one attendee/);
  });
});
