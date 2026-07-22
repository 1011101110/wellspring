import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Webhook } from 'svix';
import { registerInboundInviteRoutes } from '../../src/routes/inboundInvite.js';
import type { InboundEmailProvider } from '../../src/services/invite/inboundEmailProvider.js';

// Fake, hardcoded, test-only value — not a real credential, no live
// account exists behind it. Flagged by gitleaks' generic-api-key
// heuristic (high-entropy base64 + a whsec_-shaped prefix); allowlisted
// inline rather than suppressing the CI check itself.
const WEBHOOK_SECRET = 'whsec_YS1mYWtlLTMyLWJ5dGUtdGVzdC1zZWNyZXQtdmFsIQ=='; // gitleaks:allow
const DOMAIN = 'invite.kairos.app';

function buildIcsFixture(overrides: Partial<Record<string, string>> = {}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:' + (overrides.method ?? 'REQUEST'),
    'BEGIN:VEVENT',
    'UID:test-uid-1@google.com',
    'SEQUENCE:0',
    'DTSTAMP:20260710T120000Z',
    'DTSTART:20260712T140000Z',
    'DTEND:20260712T143000Z',
    'SUMMARY:Tough week',
    'DESCRIPTION:Meet link: https://meet.google.com/abc-defg-hij',
    'ORGANIZER:mailto:' + (overrides.organizer ?? 'jane@example.com'),
    `ATTENDEE:mailto:u_user-1@${DOMAIN}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function signedRequestFor(payload: object): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  const wh = new Webhook(WEBHOOK_SECRET);
  const msgId = 'msg_test_1';
  const timestamp = new Date();
  const signature = wh.sign(msgId, timestamp, body);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'svix-id': msgId,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': signature,
    },
  };
}

function fakeEmailProvider(icsText: string | null): InboundEmailProvider {
  return { fetchIcsAttachment: vi.fn().mockResolvedValue(icsText) };
}

function fakeUsers(usersById: Record<string, { id: string; email: string | null }>) {
  return {
    findById: vi.fn().mockImplementation(async (id: string) => usersById[id] ?? null),
  };
}

const WEBHOOK_PAYLOAD = {
  type: 'email.received',
  data: {
    email_id: 'email-abc-123',
    from: 'jane@example.com',
    to: [`u_user-1@${DOMAIN}`],
    subject: 'Tough week',
  },
};

describe('POST /invite/inbound', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('ingests a valid invite when everything matches (routing + user + organizer), no generation hook configured', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture()),
      users: fakeUsers({ 'user-1': { id: 'user-1', email: 'jane@example.com' } }),
      webhookSecret: WEBHOOK_SECRET,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: true, generated: false });
  });

  it('generates a devotional (I2) when the hook is configured, passing subject+description context and the invite-derived duration', async () => {
    const generateFromInvite = vi
      .fn()
      .mockResolvedValue({ sessionUrl: 'https://app/s/tok', devotionalId: 'dev-42' });
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture()),
      users: fakeUsers({ 'user-1': { id: 'user-1', email: 'jane@example.com' } }),
      webhookSecret: WEBHOOK_SECRET,
      generateFromInvite,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: true, generated: true, devotionalId: 'dev-42' });
    expect(generateFromInvite).toHaveBeenCalledTimes(1);
    const arg = generateFromInvite.mock.calls[0][0];
    expect(arg.userId).toBe('user-1');
    // 14:00–14:30 fixture -> 30 minutes -> extended.
    expect(arg.durationPreference).toBe('extended');
    // The user's own words become context; the organizer email never does.
    expect(arg.inviteContext).toContain('Tough week');
    expect(arg.inviteContext).not.toContain('jane@example.com');
  });

  it('acknowledges a cancellation without generating (generated:false, reason:cancellation)', async () => {
    const generateFromInvite = vi.fn();
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture({ method: 'CANCEL' })),
      users: fakeUsers({ 'user-1': { id: 'user-1', email: 'jane@example.com' } }),
      webhookSecret: WEBHOOK_SECRET,
      generateFromInvite,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: true, generated: false, reason: 'cancellation' });
    expect(generateFromInvite).not.toHaveBeenCalled();
  });

  it('declines silently (200, no retry) when generation throws — the webhook must never 5xx', async () => {
    const generateFromInvite = vi.fn().mockRejectedValue(new Error('engine exploded'));
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture()),
      users: fakeUsers({ 'user-1': { id: 'user-1', email: 'jane@example.com' } }),
      webhookSecret: WEBHOOK_SECRET,
      generateFromInvite,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: true, generated: false, reason: 'generation_failed' });
  });

  it('rejects with 401 when the webhook secret is not configured (fail-closed)', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture()),
      users: fakeUsers({}),
      webhookSecret: undefined,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });
    expect(response.statusCode).toBe(401);
  });

  it('rejects with 401 on an invalid signature', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture()),
      users: fakeUsers({ 'user-1': { id: 'user-1', email: 'jane@example.com' } }),
      webhookSecret: WEBHOOK_SECRET,
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/invite/inbound',
      payload: JSON.stringify(WEBHOOK_PAYLOAD),
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_bad',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,bogus',
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('declines silently (200) when no recipient matches our routing scheme', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture()),
      users: fakeUsers({}),
      webhookSecret: WEBHOOK_SECRET,
    });
    await app.ready();

    const { body, headers } = signedRequestFor({
      ...WEBHOOK_PAYLOAD,
      data: { ...WEBHOOK_PAYLOAD.data, to: ['someone-else@other-domain.com'] },
    });
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: false, reason: 'no_routing_match' });
  });

  it('declines silently (200) when the routing userId does not resolve to a real user', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture()),
      users: fakeUsers({}), // empty — user-1 doesn't exist
      webhookSecret: WEBHOOK_SECRET,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: false, reason: 'unknown_user' });
  });

  it('declines silently (200) when no .ics attachment is found', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(null),
      users: fakeUsers({ 'user-1': { id: 'user-1', email: 'jane@example.com' } }),
      webhookSecret: WEBHOOK_SECRET,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: false, reason: 'no_ics_attachment' });
  });

  it('declines silently (200) instead of crashing when fetching the .ics attachment throws', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: { fetchIcsAttachment: vi.fn().mockRejectedValue(new Error('Resend list attachments failed: HTTP 401')) },
      users: fakeUsers({ 'user-1': { id: 'user-1', email: 'jane@example.com' } }),
      webhookSecret: WEBHOOK_SECRET,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: false, reason: 'attachment_fetch_failed' });
  });

  it('declines silently (200) when the .ics fails to parse', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider('not a real ics payload'),
      users: fakeUsers({ 'user-1': { id: 'user-1', email: 'jane@example.com' } }),
      webhookSecret: WEBHOOK_SECRET,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: false, reason: 'unparseable_ics' });
  });

  it('declines silently (200) per docs/12 §1.4.3 when the organizer is not the account owner', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture({ organizer: 'someone-else@example.com' })),
      users: fakeUsers({ 'user-1': { id: 'user-1', email: 'jane@example.com' } }),
      webhookSecret: WEBHOOK_SECRET,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: false, reason: 'organizer_mismatch' });
  });

  it('declines silently (200) when the account has no registered email at all', async () => {
    app = Fastify();
    registerInboundInviteRoutes(app, {
      inviteDomain: DOMAIN,
      emailProvider: fakeEmailProvider(buildIcsFixture()),
      users: fakeUsers({ 'user-1': { id: 'user-1', email: null } }),
      webhookSecret: WEBHOOK_SECRET,
    });
    await app.ready();

    const { body, headers } = signedRequestFor(WEBHOOK_PAYLOAD);
    const response = await app.inject({ method: 'POST', url: '/invite/inbound', payload: body, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ingested: false, reason: 'organizer_mismatch' });
  });
});
