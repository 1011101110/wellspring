import { describe, expect, it } from 'vitest';
import { generateInviteRoutingAddress, parseInviteRoutingAddress } from '../../../src/services/invite/inviteRoutingAddress.js';

const DOMAIN = 'invite.kairos.app';

describe('invite routing address', () => {
  it('generates the documented u_<userId>@<domain> scheme', () => {
    expect(generateInviteRoutingAddress('abc-123', DOMAIN)).toBe('u_abc-123@invite.kairos.app');
  });

  it('round-trips generate -> parse', () => {
    const address = generateInviteRoutingAddress('user-xyz', DOMAIN);
    expect(parseInviteRoutingAddress(address, DOMAIN)).toBe('user-xyz');
  });

  it('is case-insensitive on the domain', () => {
    expect(parseInviteRoutingAddress('u_abc-123@INVITE.KAIROS.APP', DOMAIN)).toBe('abc-123');
  });

  it('returns null for a different domain (not our routing address)', () => {
    expect(parseInviteRoutingAddress('u_abc-123@some-other-domain.com', DOMAIN)).toBeNull();
  });

  it('returns null for an address on our domain without the u_ prefix', () => {
    expect(parseInviteRoutingAddress('support@invite.kairos.app', DOMAIN)).toBeNull();
  });

  it('returns null when there is no @ at all', () => {
    expect(parseInviteRoutingAddress('not-an-email', DOMAIN)).toBeNull();
  });

  it('returns null for an empty userId after the prefix', () => {
    expect(parseInviteRoutingAddress('u_@invite.kairos.app', DOMAIN)).toBeNull();
  });
});
