/**
 * Unit tests for the #217 fire-time Meet-bot consent gate.
 *
 * The route-level tests (tests/routes/internal.test.ts) prove the
 * behavior that actually matters — no Attendee bot is created when
 * consent is gone. These cover the gate's own decision logic in isolation:
 * which signal it reads, in what order, and that it stops reading as soon
 * as it has an answer.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkMeetBotConsent, type MeetBotConsentGateDeps } from '../../../src/services/meetBot/meetBotConsentGate.js';

function gate(state: {
  ownerUserId?: string | null;
  userExists?: boolean;
  connectionStatus?: string | null;
}): MeetBotConsentGateDeps {
  const ownerUserId = state.ownerUserId === undefined ? 'user-1' : state.ownerUserId;
  const userExists = state.userExists ?? true;
  const connectionStatus = state.connectionStatus === undefined ? 'active' : state.connectionStatus;

  return {
    devotionals: { findOwnerUserId: vi.fn().mockResolvedValue(ownerUserId) },
    users: { findById: vi.fn().mockResolvedValue(userExists ? { id: ownerUserId } : null) },
    connections: {
      findByProvider: vi
        .fn()
        .mockResolvedValue(connectionStatus === null ? null : { status: connectionStatus }),
    },
  } as unknown as MeetBotConsentGateDeps;
}

describe('checkMeetBotConsent', () => {
  it('allows dispatch when the devotional, the user, and an active connection all exist', async () => {
    const decision = await checkMeetBotConsent(gate({}), 'devo-1');
    expect(decision).toEqual({ allowed: true, userId: 'user-1' });
  });

  it('resolves the owner from the devotional id, never from a caller-supplied userId', async () => {
    // Foundation §10: identity comes from an authoritative source, not the
    // request body. The gate's only input besides its deps is the
    // devotionalId, and the connection lookup must use the id the database
    // returned for that row.
    const deps = gate({ ownerUserId: 'owner-from-db' });
    const decision = await checkMeetBotConsent(deps, 'devo-1');

    expect(deps.devotionals.findOwnerUserId).toHaveBeenCalledWith('devo-1');
    expect(deps.connections.findByProvider).toHaveBeenCalledWith('owner-from-db', 'google_calendar');
    expect(decision.allowed).toBe(true);
  });

  it('refuses, and stops looking, when the devotional row is gone (deleted account)', async () => {
    const deps = gate({ ownerUserId: null });
    const decision = await checkMeetBotConsent(deps, 'devo-gone');

    expect(decision).toEqual({ allowed: false, reason: 'devotional_not_found' });
    // No point querying a user we cannot name — and nothing should be able
    // to un-refuse the decision after this point.
    expect(deps.users.findById).not.toHaveBeenCalled();
    expect(deps.connections.findByProvider).not.toHaveBeenCalled();
  });

  it('refuses when the user row is gone', async () => {
    const deps = gate({ userExists: false });
    const decision = await checkMeetBotConsent(deps, 'devo-1');

    expect(decision).toEqual({ allowed: false, reason: 'user_not_found', userId: 'user-1' });
    expect(deps.connections.findByProvider).not.toHaveBeenCalled();
  });

  it('refuses when there is no connection row', async () => {
    const decision = await checkMeetBotConsent(gate({ connectionStatus: null }), 'devo-1');
    expect(decision).toEqual({ allowed: false, reason: 'connection_missing', userId: 'user-1' });
  });

  it('refuses when the connection was revoked', async () => {
    const decision = await checkMeetBotConsent(gate({ connectionStatus: 'revoked' }), 'devo-1');
    expect(decision).toEqual({ allowed: false, reason: 'connection_revoked', userId: 'user-1' });
  });

  it.each(['suspended', 'pending', 'expired', ''])(
    'refuses for the unrecognized connection status %o — allow-list, not deny-list',
    async (status) => {
      const decision = await checkMeetBotConsent(gate({ connectionStatus: status }), 'devo-1');
      expect(decision.allowed).toBe(false);
    },
  );

  it('propagates a repository failure rather than reporting a refusal', async () => {
    // The distinction the route depends on: a thrown error means "could
    // not determine consent" (retryable 500), which is not the same as
    // "consent was withdrawn" (non-retryable 200 refusal). Collapsing the
    // two would make a database blip look like a revocation in the audit
    // log.
    const deps = {
      devotionals: { findOwnerUserId: vi.fn().mockRejectedValue(new Error('db down')) },
      users: { findById: vi.fn() },
      connections: { findByProvider: vi.fn() },
    } as unknown as MeetBotConsentGateDeps;

    await expect(checkMeetBotConsent(deps, 'devo-1')).rejects.toThrow('db down');
  });
});
