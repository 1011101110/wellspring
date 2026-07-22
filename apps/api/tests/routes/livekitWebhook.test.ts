import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerLiveKitWebhookRoutes } from '../../src/routes/livekitWebhook.js';
import { BOT_IDENTITY } from '../../src/services/livekit/publishDevotionalAudioToRoom.js';
import type { LiveKitConfig } from '../../src/services/delivery/liveKitConfig.js';

const LIVEKIT_CONFIG: LiveKitConfig = {
  url: 'wss://kairos-test.livekit.cloud',
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  publicBaseUrl: 'http://localhost:8080',
};

type ReceivedEvent = { event: string; room?: { name?: string }; participant?: { identity?: string } };

function buildTestApp(opts: {
  receive: (body: string, authHeader?: string) => Promise<ReceivedEvent>;
  publish?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  registerLiveKitWebhookRoutes(app, {
    liveKitConfig: LIVEKIT_CONFIG,
    sessionService: { getSessionView: vi.fn() },
    webhookReceiver: { receive: opts.receive },
    publish: opts.publish as never,
  });
  return app;
}

describe('POST /livekit/webhook', () => {
  it('returns 401 without calling publish when signature verification fails', async () => {
    const publish = vi.fn();
    const receive = vi.fn().mockRejectedValue(new Error('sha256 checksum of body does not match'));
    const app = buildTestApp({ receive, publish });

    const res = await app.inject({
      method: 'POST',
      url: '/livekit/webhook',
      headers: { 'content-type': 'application/webhook+json', authorization: 'bad-sig' },
      payload: '{"event":"participant_joined","room":{"name":"kairos-room-x"}}',
    });

    expect(res.statusCode).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  });

  it('acks 200 and invokes publish for a real (non-bot) participant_joined event', async () => {
    const publish = vi.fn().mockResolvedValue({ outcome: 'published' });
    const receive = vi.fn().mockResolvedValue({
      event: 'participant_joined',
      room: { name: 'kairos-room-00000000-0000-4000-8000-000000000001' },
      participant: { identity: 'viewer-00000000-0000-4000-8000-000000000001' },
    });
    const app = buildTestApp({ receive, publish });

    const res = await app.inject({
      method: 'POST',
      url: '/livekit/webhook',
      headers: { 'content-type': 'application/webhook+json', authorization: 'good-sig' },
      payload: '{"event":"participant_joined","room":{"name":"kairos-room-00000000-0000-4000-8000-000000000001"}}',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    // Fire-and-forget: give the microtask queue a tick to run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(publish).toHaveBeenCalledWith(
      'kairos-room-00000000-0000-4000-8000-000000000001',
      expect.objectContaining({ liveKitConfig: LIVEKIT_CONFIG }),
    );
  });

  it('acks 200 but does NOT invoke publish when the joining participant is the bot itself (self-trigger guard)', async () => {
    const publish = vi.fn();
    const receive = vi.fn().mockResolvedValue({
      event: 'participant_joined',
      room: { name: 'kairos-room-x' },
      participant: { identity: BOT_IDENTITY },
    });
    const app = buildTestApp({ receive, publish });

    const res = await app.inject({
      method: 'POST',
      url: '/livekit/webhook',
      headers: { 'content-type': 'application/webhook+json' },
      payload: '{"event":"participant_joined"}',
    });

    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publish).not.toHaveBeenCalled();
  });

  it('acks 200 but does not invoke publish for a non-participant_joined event (e.g. participant_left)', async () => {
    const publish = vi.fn();
    const receive = vi.fn().mockResolvedValue({ event: 'participant_left', room: { name: 'kairos-room-x' } });
    const app = buildTestApp({ receive, publish });

    const res = await app.inject({
      method: 'POST',
      url: '/livekit/webhook',
      headers: { 'content-type': 'application/webhook+json' },
      payload: '{"event":"participant_left"}',
    });

    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publish).not.toHaveBeenCalled();
  });

  it('acks 200 but does not invoke publish when participant_joined carries no room name', async () => {
    const publish = vi.fn();
    const receive = vi.fn().mockResolvedValue({ event: 'participant_joined', room: undefined });
    const app = buildTestApp({ receive, publish });

    const res = await app.inject({
      method: 'POST',
      url: '/livekit/webhook',
      headers: { 'content-type': 'application/webhook+json' },
      payload: '{"event":"participant_joined"}',
    });

    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publish).not.toHaveBeenCalled();
  });
});
