import { describe, expect, it, vi } from 'vitest';
import { runMeetBotSession } from '../../../src/services/meetBot/meetBotSession.js';
import { FakeAttendeeClient } from '../../../src/services/meetBot/fakeAttendeeClient.js';
import type { BotAudioChannel } from '../../../src/services/meetBot/meetBotSession.js';

class RecordingAudioChannel implements BotAudioChannel {
  readonly chunks: Array<{ chunkBase64: string; sampleRate: number }> = [];
  async sendChunk(chunkBase64: string, sampleRate: number): Promise<void> {
    this.chunks.push({ chunkBase64, sampleRate });
  }
}

// Instant sleep — these tests assert ordering/behavior, not real timing.
const instantSleep = () => Promise.resolve();

function fakeDecode(sampleRate: number) {
  return vi.fn().mockImplementation(async (_mp3: Buffer, options?: { sampleRate?: number }) => {
    expect(options?.sampleRate).toBe(sampleRate);
    // 200ms of fake PCM at the requested sample rate, 16-bit mono.
    return Buffer.alloc(Math.round(sampleRate * 0.2) * 2, 1);
  });
}

const BASE_PARAMS = {
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  botName: 'Wellspring',
  audioWebsocketUrl: 'wss://api.kairos.app/v1/meetbot/audio',
  mp3: Buffer.from('fake-mp3-bytes'),
};

describe('runMeetBotSession', () => {
  it('creates the bot, waits for admission, streams PCM in chunks, and leaves — happy path', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['joined_not_recording'] });
    const audioChannel = new RecordingAudioChannel();
    const decode = fakeDecode(16000);

    const result = await runMeetBotSession(BASE_PARAMS, {
      attendeeClient,
      audioChannel,
      decode,
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, botId: 'fake-bot-id', lastState: 'joined_not_recording' });
    expect(attendeeClient.createBotCalls).toEqual([
      {
        meetingUrl: BASE_PARAMS.meetingUrl,
        botName: BASE_PARAMS.botName,
        audioWebsocketUrl: BASE_PARAMS.audioWebsocketUrl,
        sampleRate: 16000,
      },
    ]);
    // 200ms of audio at 100ms default chunks = 2 chunks.
    expect(audioChannel.chunks).toHaveLength(2);
    expect(audioChannel.chunks[0]!.sampleRate).toBe(16000);
    expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('polls through waiting_room before admission succeeds', async () => {
    const attendeeClient = new FakeAttendeeClient({
      stateSequence: ['joining', 'waiting_room', 'waiting_room', 'joined_not_recording'],
    });
    const audioChannel = new RecordingAudioChannel();

    const result = await runMeetBotSession(BASE_PARAMS, {
      attendeeClient,
      audioChannel,
      decode: fakeDecode(16000),
      sleep: instantSleep,
    });

    expect(result.ok).toBe(true);
    expect(audioChannel.chunks.length).toBeGreaterThan(0);
  });

  it('fails with admission_timeout and still leaves/deletes data when the bot never gets admitted', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['waiting_room'] });
    const audioChannel = new RecordingAudioChannel();

    const result = await runMeetBotSession(
      { ...BASE_PARAMS, admissionTimeoutMs: 4000, pollIntervalMs: 2000 },
      { attendeeClient, audioChannel, decode: fakeDecode(16000), sleep: instantSleep },
    );

    expect(result).toEqual({
      ok: false,
      botId: 'fake-bot-id',
      failureReason: 'admission_timeout',
      lastState: 'waiting_room',
    });
    expect(audioChannel.chunks).toHaveLength(0);
    expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('aborts immediately on fatal_error without streaming any audio', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['fatal_error'] });
    const audioChannel = new RecordingAudioChannel();

    const result = await runMeetBotSession(BASE_PARAMS, {
      attendeeClient,
      audioChannel,
      decode: fakeDecode(16000),
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe('fatal_error');
    expect(audioChannel.chunks).toHaveLength(0);
  });

  it('treats joined_recording as a normal admitted state (confirmed live 2026-07-07: the only state real Google Meet bots ever report)', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording'] });
    const audioChannel = new RecordingAudioChannel();

    const result = await runMeetBotSession(BASE_PARAMS, {
      attendeeClient,
      audioChannel,
      decode: fakeDecode(16000),
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: true, botId: 'fake-bot-id', lastState: 'joined_not_recording' });
    expect(audioChannel.chunks.length).toBeGreaterThan(0);
  });

  it('still treats joined_recording_paused and joined_recording_permission_denied as hard privacy failures', async () => {
    for (const state of ['joined_recording_paused', 'joined_recording_permission_denied'] as const) {
      const attendeeClient = new FakeAttendeeClient({ stateSequence: [state] });
      const audioChannel = new RecordingAudioChannel();

      const result = await runMeetBotSession(BASE_PARAMS, {
        attendeeClient,
        audioChannel,
        decode: fakeDecode(16000),
        sleep: instantSleep,
      });

      expect(result).toEqual({ ok: false, botId: 'fake-bot-id', failureReason: 'recording_detected', lastState: state });
      expect(audioChannel.chunks).toHaveLength(0);
      expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
      expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
    }
  });

  it('returns audio_send_failed and still leaves/deletes data when the audio channel throws', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['joined_not_recording'] });
    const audioChannel: BotAudioChannel = {
      sendChunk: vi.fn().mockRejectedValue(new Error('websocket closed')),
    };

    const result = await runMeetBotSession(BASE_PARAMS, {
      attendeeClient,
      audioChannel,
      decode: fakeDecode(16000),
      sleep: instantSleep,
    });

    expect(result).toEqual({ ok: false, botId: 'fake-bot-id', failureReason: 'audio_send_failed' });
    expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('still purges bot data even if requestLeave itself throws', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['joined_not_recording'] });
    vi.spyOn(attendeeClient, 'requestLeave').mockRejectedValue(new Error('leave endpoint unavailable'));
    const audioChannel = new RecordingAudioChannel();

    const result = await runMeetBotSession(BASE_PARAMS, {
      attendeeClient,
      audioChannel,
      decode: fakeDecode(16000),
      sleep: instantSleep,
    });

    expect(result.ok).toBe(true);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('honors an explicit sampleRate override end to end', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['joined_not_recording'] });
    const audioChannel = new RecordingAudioChannel();

    await runMeetBotSession(
      { ...BASE_PARAMS, sampleRate: 8000 },
      { attendeeClient, audioChannel, decode: fakeDecode(8000), sleep: instantSleep },
    );

    expect(attendeeClient.createBotCalls[0]!.sampleRate).toBe(8000);
    expect(audioChannel.chunks[0]!.sampleRate).toBe(8000);
  });
});
