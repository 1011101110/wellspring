import { describe, expect, it } from 'vitest';
import { runMeetBotDispatch } from '../../../src/services/meetBot/meetBotSession.js';
import { FakeAttendeeClient } from '../../../src/services/meetBot/fakeAttendeeClient.js';

const instantSleep = () => Promise.resolve();

const BASE_PARAMS = {
  mode: 'websocket' as const,
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  botName: 'Wellspring',
  audioWebsocketUrl: 'wss://api.kairos.app/meetbot/audio/token/devotional-id',
};

const VOICE_AGENT_PARAMS = {
  mode: 'voice-agent' as const,
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  botName: 'Wellspring',
  stageUrl: 'https://api.kairos.app/stage/session-token-uuid',
};

describe('runMeetBotDispatch', () => {
  it('creates the bot, waits for admission, supervises until ended, and cleans up', async () => {
    const attendeeClient = new FakeAttendeeClient({
      stateSequence: ['joining', 'joined_recording', 'joined_recording', 'ended'],
    });

    const result = await runMeetBotDispatch(BASE_PARAMS, { attendeeClient, sleep: instantSleep });

    expect(result).toEqual({ ok: true, botId: 'fake-bot-id', lastState: 'ended' });
    expect(attendeeClient.createBotCalls).toEqual([
      {
        meetingUrl: BASE_PARAMS.meetingUrl,
        botName: BASE_PARAMS.botName,
        audioWebsocketUrl: BASE_PARAMS.audioWebsocketUrl,
        sampleRate: 16000,
      },
    ]);
    expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('returns admission_timeout and still cleans up if the bot never gets admitted', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['waiting_room'] });

    const result = await runMeetBotDispatch(
      { ...BASE_PARAMS, admissionTimeoutMs: 4000, pollIntervalMs: 2000 },
      { attendeeClient, sleep: instantSleep },
    );

    expect(result).toEqual({
      ok: false,
      botId: 'fake-bot-id',
      failureReason: 'admission_timeout',
      lastState: 'waiting_room',
    });
    expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('returns fatal_error and cleans up if the bot fails mid-session (after admission)', async () => {
    const attendeeClient = new FakeAttendeeClient({
      stateSequence: ['joined_recording', 'joined_recording', 'fatal_error'],
    });

    const result = await runMeetBotDispatch(BASE_PARAMS, { attendeeClient, sleep: instantSleep });

    expect(result).toEqual({ ok: false, botId: 'fake-bot-id', failureReason: 'fatal_error', lastState: 'fatal_error' });
    expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('returns session_timeout and forces a leave if the bot never reaches a terminal state', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording'] });

    const result = await runMeetBotDispatch(
      { ...BASE_PARAMS, sessionTimeoutMs: 4000, pollIntervalMs: 2000 },
      { attendeeClient, sleep: instantSleep },
    );

    expect(result).toEqual({
      ok: false,
      botId: 'fake-bot-id',
      failureReason: 'session_timeout',
      lastState: 'joined_recording',
    });
    expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('honors an explicit sampleRate override', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });

    await runMeetBotDispatch({ ...BASE_PARAMS, sampleRate: 8000 }, { attendeeClient, sleep: instantSleep });

    expect(attendeeClient.createBotCalls[0]!.sampleRate).toBe(8000);
  });

  // ────────────────────────────────────────────────────────────
  // Voice-agent mode (Epic Q, #335)
  // ────────────────────────────────────────────────────────────

  it('voice-agent mode: creates the bot with the stage URL and NO websocket fields (#335)', async () => {
    const attendeeClient = new FakeAttendeeClient({
      stateSequence: ['joining', 'joined_recording', 'ended'],
    });

    const result = await runMeetBotDispatch(VOICE_AGENT_PARAMS, { attendeeClient, sleep: instantSleep });

    expect(result).toEqual({ ok: true, botId: 'fake-bot-id', lastState: 'ended' });
    // toEqual on the WHOLE params object: proves voiceAgentUrl is present
    // AND that audioWebsocketUrl/sampleRate keys are entirely absent — a
    // voice-agent bot must never carry websocket leftovers (the client
    // would map them into websocket_settings alongside voice_agent_settings).
    expect(attendeeClient.createBotCalls).toEqual([
      {
        meetingUrl: VOICE_AGENT_PARAMS.meetingUrl,
        botName: VOICE_AGENT_PARAMS.botName,
        voiceAgentUrl: VOICE_AGENT_PARAMS.stageUrl,
      },
    ]);
  });

  it('voice-agent mode: lifecycle parity — leave + delete_data run exactly as in websocket mode (#335 privacy invariant)', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });

    await runMeetBotDispatch(VOICE_AGENT_PARAMS, { attendeeClient, sleep: instantSleep });

    expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('voice-agent mode: admission failure still cleans up (mode-independent supervision)', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['waiting_room'] });

    const result = await runMeetBotDispatch(
      { ...VOICE_AGENT_PARAMS, admissionTimeoutMs: 4000, pollIntervalMs: 2000 },
      { attendeeClient, sleep: instantSleep },
    );

    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe('admission_timeout');
    expect(attendeeClient.leaveCalls).toEqual(['fake-bot-id']);
    expect(attendeeClient.deleteDataCalls).toEqual(['fake-bot-id']);
  });

  it('websocket-mode payload is byte-identical to before #335 (fallback-path regression)', async () => {
    const attendeeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });

    await runMeetBotDispatch(BASE_PARAMS, { attendeeClient, sleep: instantSleep });

    // Exactly the four keys the pre-#335 dispatch sent, no voice-agent
    // fields — asserted with toEqual so a drifted key set fails.
    expect(attendeeClient.createBotCalls).toEqual([
      {
        meetingUrl: BASE_PARAMS.meetingUrl,
        botName: BASE_PARAMS.botName,
        audioWebsocketUrl: BASE_PARAMS.audioWebsocketUrl,
        sampleRate: 16000,
      },
    ]);
  });
});
