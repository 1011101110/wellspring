/**
 * Unit tests for HttpAttendeeClient's bot-creation payload mapping and the
 * #335 mode-exclusivity boundary. The HTTP payload shapes asserted here are
 * the ones confirmed LIVE in the Q4 spike (kairos-devotional#334,
 * 2026-07-23) — `voice_agent_settings` nested, `screenshare_url` inside it,
 * strict schema — so these tests are the executable record of that
 * transcript, not a restatement of Attendee's docs.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  HttpAttendeeClient,
  assertCreateBotModeExclusive,
  type CreateBotParams,
} from '../../../src/services/meetBot/attendeeClient.js';
import { FakeAttendeeClient } from '../../../src/services/meetBot/fakeAttendeeClient.js';

const MEETING = 'https://meet.google.com/abc-defg-hij';

function stubFetchOnce(): { fetchSpy: ReturnType<typeof vi.fn>; sentBody: () => unknown } {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'bot_123' }),
  });
  vi.stubGlobal('fetch', fetchSpy);
  return {
    fetchSpy,
    sentBody: () => JSON.parse((fetchSpy.mock.calls[0]![1] as { body: string }).body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpAttendeeClient.createBot payload mapping', () => {
  it('websocket mode: sends websocket_settings and never voice_agent_settings (pre-#335 regression shape)', async () => {
    const { sentBody } = stubFetchOnce();
    const client = new HttpAttendeeClient('key');

    await client.createBot({
      meetingUrl: MEETING,
      botName: 'Wellspring',
      audioWebsocketUrl: 'wss://api.example.com/meetbot/audio/tok/devo-1',
      sampleRate: 16000,
    });

    expect(sentBody()).toEqual({
      meeting_url: MEETING,
      bot_name: 'Wellspring',
      recording_settings: { format: 'none' },
      websocket_settings: {
        audio: { url: 'wss://api.example.com/meetbot/audio/tok/devo-1', sample_rate: 16000 },
      },
    });
  });

  it('voice-agent mode: sends nested voice_agent_settings.url, recording still forced off, no websocket_settings (Q4-confirmed shape)', async () => {
    const { sentBody } = stubFetchOnce();
    const client = new HttpAttendeeClient('key');

    await client.createBot({
      meetingUrl: MEETING,
      botName: 'Wellspring',
      voiceAgentUrl: 'https://api.example.com/stage/session-token',
    });

    // toEqual over the whole body: also proves no websocket_settings and
    // no top-level screenshare key sneak in (Attendee's schema is strict —
    // additionalProperties rejected, Q4 probe C).
    expect(sentBody()).toEqual({
      meeting_url: MEETING,
      bot_name: 'Wellspring',
      recording_settings: { format: 'none' },
      voice_agent_settings: { url: 'https://api.example.com/stage/session-token' },
    });
  });

  it('screenshare variant: screenshare_url nested INSIDE voice_agent_settings (Q4 finding — not top-level)', async () => {
    const { sentBody } = stubFetchOnce();
    const client = new HttpAttendeeClient('key');

    await client.createBot({
      meetingUrl: MEETING,
      botName: 'Wellspring',
      screenshareUrl: 'https://api.example.com/stage/session-token',
    });

    expect(sentBody()).toEqual({
      meeting_url: MEETING,
      bot_name: 'Wellspring',
      recording_settings: { format: 'none' },
      voice_agent_settings: { screenshare_url: 'https://api.example.com/stage/session-token' },
    });
  });
});

describe('assertCreateBotModeExclusive (#335 acceptance: throws at the client boundary)', () => {
  const base = { meetingUrl: MEETING, botName: 'Wellspring' };

  it('rejects websocket + voice-agent URLs together', () => {
    const params: CreateBotParams = {
      ...base,
      audioWebsocketUrl: 'wss://x.example.com/audio',
      voiceAgentUrl: 'https://x.example.com/stage/t',
    };
    expect(() => assertCreateBotModeExclusive(params)).toThrow(/mutually exclusive/);
  });

  it('rejects websocket + screenshare URLs together', () => {
    const params: CreateBotParams = {
      ...base,
      audioWebsocketUrl: 'wss://x.example.com/audio',
      screenshareUrl: 'https://x.example.com/stage/t',
    };
    expect(() => assertCreateBotModeExclusive(params)).toThrow(/mutually exclusive/);
  });

  it('rejects voiceAgentUrl + screenshareUrl together (Attendee 400s this live — Q4 probe B)', () => {
    const params: CreateBotParams = {
      ...base,
      voiceAgentUrl: 'https://x.example.com/stage/t',
      screenshareUrl: 'https://x.example.com/stage/t?screenshare=1',
    };
    expect(() => assertCreateBotModeExclusive(params)).toThrow(/screenshareUrl/);
  });

  it('accepts each mode alone (and a join-only bot with no URL at all)', () => {
    expect(() => assertCreateBotModeExclusive({ ...base })).not.toThrow();
    expect(() => assertCreateBotModeExclusive({ ...base, audioWebsocketUrl: 'wss://a' })).not.toThrow();
    expect(() => assertCreateBotModeExclusive({ ...base, voiceAgentUrl: 'https://b' })).not.toThrow();
    expect(() => assertCreateBotModeExclusive({ ...base, screenshareUrl: 'https://c' })).not.toThrow();
  });

  it('is enforced by the real client without any network round-trip', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new HttpAttendeeClient('key');

    await expect(
      client.createBot({ ...base, audioWebsocketUrl: 'wss://a', voiceAgentUrl: 'https://b' }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is enforced by FakeAttendeeClient too, so dispatch tests hit the same boundary production hits', async () => {
    const fake = new FakeAttendeeClient();
    await expect(
      fake.createBot({ ...base, voiceAgentUrl: 'https://a', screenshareUrl: 'https://b' }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(fake.createBotCalls).toHaveLength(0);
  });
});
