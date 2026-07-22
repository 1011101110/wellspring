import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerRoomRoutes } from '../../src/routes/room.js';
import type { SessionLookupResult } from '../../src/services/session/sessionService.js';
import { roomNameForSessionToken } from '../../src/services/delivery/liveKitRoomNaming.js';
import type { LiveKitConfig } from '../../src/services/delivery/liveKitConfig.js';

const TOKEN = '00000000-0000-4000-8000-000000000001';

const OK_VIEW: SessionLookupResult = {
  kind: 'ok',
  page: {
    token: TOKEN,
    completed: false,
    audioUrl: 'https://audio.example.com/signed',
    devotional: {
      theme: 'Rest',
      format: 'short',
      verses: [],
      devotionalBody: 'body',
      prayer: 'prayer',
      journalingPrompt: null,
      actionStep: null,
    },
  },
};

const LIVEKIT_CONFIG: LiveKitConfig = {
  url: 'wss://kairos-test.livekit.cloud',
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret-at-least-this-long',
  publicBaseUrl: 'http://localhost:8080',
};

function buildTestApp(getSessionView: (token: string) => Promise<SessionLookupResult>) {
  const app = Fastify();
  registerRoomRoutes(app, {
    sessionService: { getSessionView },
    liveKitConfig: LIVEKIT_CONFIG,
  });
  return app;
}

describe('GET /room/:token', () => {
  it('renders the room page for a valid, unexpired session', async () => {
    const app = buildTestApp(async () => OK_VIEW);
    const res = await app.inject({ method: 'GET', url: `/room/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('/session/' + TOKEN); // fallback link present
    expect(res.body).toContain('/room/assets/join.js');
    expect(res.body).toContain('livekit-client');
  });

  it('returns the identical gone/unknown page for a not-found session', async () => {
    const app = buildTestApp(async () => ({ kind: 'not_found' }));
    const res = await app.inject({ method: 'GET', url: `/room/${TOKEN}` });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns 404 without ever calling getSessionView for a non-UUID token (enumeration safety, mirrors session.ts)', async () => {
    const getSessionView = vi.fn();
    const app = buildTestApp(getSessionView);
    const res = await app.inject({ method: 'GET', url: '/room/not-a-uuid' });
    expect(res.statusCode).toBe(404);
    expect(getSessionView).not.toHaveBeenCalled();
  });
});

describe('GET /room/:token/token', () => {
  it('mints a viewer JWT scoped to the derived room name, subscribe-only', async () => {
    const app = buildTestApp(async () => OK_VIEW);
    const res = await app.inject({ method: 'GET', url: `/room/${TOKEN}/token` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.url).toBe(LIVEKIT_CONFIG.url);
    expect(body.roomName).toBe(roomNameForSessionToken(TOKEN));
    expect(typeof body.token).toBe('string');

    // Decode the JWT payload (no verification needed here — signature
    // correctness is livekit-server-sdk's concern; we're asserting OUR
    // grant shape) and confirm publish is denied for the viewer token.
    const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.video.roomJoin).toBe(true);
    expect(payload.video.room).toBe(roomNameForSessionToken(TOKEN));
    expect(payload.video.canPublish).toBe(false);
    expect(payload.video.canSubscribe).toBe(true);
  });

  it('returns 404 for an expired/unknown session — never mints a token', async () => {
    const app = buildTestApp(async () => ({ kind: 'not_found' }));
    const res = await app.inject({ method: 'GET', url: `/room/${TOKEN}/token` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).ok).toBe(false);
  });

  it('returns 404 for a non-UUID token', async () => {
    const app = buildTestApp(async () => OK_VIEW);
    const res = await app.inject({ method: 'GET', url: '/room/nope/token' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /room/assets/join.js', () => {
  it('serves the connect script same-origin', async () => {
    const app = buildTestApp(async () => OK_VIEW);
    const res = await app.inject({ method: 'GET', url: '/room/assets/join.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).toContain('LivekitClient.Room');
  });
});
