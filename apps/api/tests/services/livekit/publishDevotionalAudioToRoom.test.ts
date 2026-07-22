import { describe, expect, it, vi } from 'vitest';
import { publishDevotionalAudioForRoom } from '../../../src/services/livekit/publishDevotionalAudioToRoom.js';
import { roomNameForSessionToken } from '../../../src/services/delivery/liveKitRoomNaming.js';
import type { SessionLookupResult } from '../../../src/services/session/sessionService.js';
import type { LiveKitConfig } from '../../../src/services/delivery/liveKitConfig.js';

const TOKEN = '00000000-0000-4000-8000-000000000001';
const ROOM_NAME = roomNameForSessionToken(TOKEN);

const LIVEKIT_CONFIG: LiveKitConfig = {
  url: 'wss://kairos-test.livekit.cloud',
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  publicBaseUrl: 'http://localhost:8080',
};

const quietLogger = { info: () => {}, error: () => {} };

function okView(audioUrl: string | null): SessionLookupResult {
  return {
    kind: 'ok',
    page: {
      token: TOKEN,
      completed: false,
      audioUrl,
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
}

describe('publishDevotionalAudioForRoom', () => {
  it('ignores a foreign (non-Wellspring) room name without calling sessionService', async () => {
    const getSessionView = vi.fn();
    const result = await publishDevotionalAudioForRoom('some-other-room', {
      sessionService: { getSessionView },
      liveKitConfig: LIVEKIT_CONFIG,
      logger: quietLogger,
    });
    expect(result).toEqual({ outcome: 'ignored_foreign_room' });
    expect(getSessionView).not.toHaveBeenCalled();
  });

  it('returns session_not_found for an expired/unknown session — publishes nothing', async () => {
    const connectAndPublish = vi.fn();
    const result = await publishDevotionalAudioForRoom(ROOM_NAME, {
      sessionService: { getSessionView: async () => ({ kind: 'not_found' }) },
      liveKitConfig: LIVEKIT_CONFIG,
      logger: quietLogger,
      connectAndPublish,
    });
    expect(result).toEqual({ outcome: 'session_not_found' });
    expect(connectAndPublish).not.toHaveBeenCalled();
  });

  it('returns audio_unavailable and publishes nothing when the devotional has no audio', async () => {
    const connectAndPublish = vi.fn();
    const result = await publishDevotionalAudioForRoom(ROOM_NAME, {
      sessionService: { getSessionView: async () => okView(null) },
      liveKitConfig: LIVEKIT_CONFIG,
      logger: quietLogger,
      connectAndPublish,
    });
    expect(result).toEqual({ outcome: 'audio_unavailable' });
    expect(connectAndPublish).not.toHaveBeenCalled();
  });

  it('fetches audio, decodes it, mints a publish-only bot token, and connects — happy path', async () => {
    const mp3 = Buffer.from('fake-mp3-bytes');
    const pcm = Buffer.from('fake-pcm-bytes');
    const fetchAudio = vi.fn().mockResolvedValue(mp3);
    const decode = vi.fn().mockResolvedValue(pcm);
    const connectAndPublish = vi.fn().mockResolvedValue(undefined);

    const result = await publishDevotionalAudioForRoom(ROOM_NAME, {
      sessionService: { getSessionView: async () => okView('https://audio.example.com/signed') },
      liveKitConfig: LIVEKIT_CONFIG,
      logger: quietLogger,
      fetchAudio,
      decode,
      connectAndPublish,
    });

    expect(result).toEqual({ outcome: 'published' });
    expect(fetchAudio).toHaveBeenCalledWith('https://audio.example.com/signed');
    expect(decode).toHaveBeenCalledWith(mp3);
    expect(connectAndPublish).toHaveBeenCalledTimes(1);
    const call = connectAndPublish.mock.calls[0]![0];
    expect(call.url).toBe(LIVEKIT_CONFIG.url);
    expect(call.pcm).toBe(pcm);

    const payload = JSON.parse(Buffer.from(call.token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.video.room).toBe(ROOM_NAME);
    expect(payload.video.canPublish).toBe(true);
    expect(payload.video.canSubscribe).toBe(false);
  });

  it('returns failed (not thrown) and never crashes the caller when fetch/decode/connect throws', async () => {
    const result = await publishDevotionalAudioForRoom(ROOM_NAME, {
      sessionService: { getSessionView: async () => okView('https://audio.example.com/signed') },
      liveKitConfig: LIVEKIT_CONFIG,
      logger: quietLogger,
      fetchAudio: vi.fn().mockRejectedValue(new Error('network blew up')),
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'network blew up' });
  });
});
