import { describe, expect, it } from 'vitest';
import { buildInviteContext } from '../../../src/services/invite/inviteContext.js';
import type { ParsedInboundInvite } from '../../../src/services/invite/inboundIcsParser.js';

function invite(overrides: Partial<ParsedInboundInvite> = {}): ParsedInboundInvite {
  return {
    uid: 'uid-1',
    sequence: 0,
    method: 'REQUEST',
    isCancellation: false,
    start: new Date('2026-07-12T14:00:00Z'),
    end: new Date('2026-07-12T14:10:00Z'),
    summary: 'Tough week',
    description: 'Rough stretch with my team lately.',
    organizerEmail: 'jane@example.com',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    ...overrides,
  };
}

describe('buildInviteContext (I2, #62)', () => {
  it('assembles context from subject + description only', () => {
    const { context } = buildInviteContext(invite());
    expect(context).toBe('Tough week\n\nRough stretch with my team lately.');
  });

  it('NEVER includes the organizer email, meeting URL, or any other event field (Foundation §8)', () => {
    const { context } = buildInviteContext(invite());
    expect(context).not.toContain('jane@example.com');
    expect(context).not.toContain('meet.google.com');
    expect(context).not.toContain('uid-1');
  });

  it('uses just the subject when there is no description', () => {
    expect(buildInviteContext(invite({ description: null })).context).toBe('Tough week');
  });

  it('returns undefined context when both subject and description are empty', () => {
    expect(buildInviteContext(invite({ summary: '', description: null })).context).toBeUndefined();
  });

  it('derives durationPreference from the event length', () => {
    // 10-minute event -> "standard"
    expect(buildInviteContext(invite()).durationPreference).toBe('standard');
    // 3-minute event -> "micro"
    expect(
      buildInviteContext(invite({ end: new Date('2026-07-12T14:03:00Z') })).durationPreference,
    ).toBe('micro');
    // 30-minute event -> "extended"
    expect(
      buildInviteContext(invite({ end: new Date('2026-07-12T14:30:00Z') })).durationPreference,
    ).toBe('extended');
  });

  it('leaves durationPreference undefined when the event has no end (engine heuristic picks)', () => {
    expect(buildInviteContext(invite({ end: null })).durationPreference).toBeUndefined();
  });
});
