/**
 * MeetBotSession — the websocket-PCM bot lifecycle (H1 #53): create →
 * wait for admission → stream the devotional as PCM → leave. docs/22 §3
 * execution plan step 3 (H1c). This is one of TWO dispatch modes since
 * Q5 (kairos-devotional#335) — the other is the voice-agent mode, where
 * Attendee's container renders the Stage page and this streaming loop
 * never runs. Built against the `AttendeeClient` interface so it is
 * fully unit-testable with `FakeAttendeeClient`; the live account and
 * bot join were verified in the H1a spike (2026-07-07) and again in the
 * Q4 voice-agent spike + Q7 rehearsal (2026-07-23).
 *
 * Bounded, request-driven lifecycle (DEC-K11 lesson carried over from D4,
 * docs/22 §3 point 5) — this function runs to completion within one
 * request; no persistent worker.
 *
 * Privacy (docs/22 §3 "Privacy"): we never request recording
 * (`recording_settings.format: "none"`, confirmed effective — see
 * attendeeClient.ts) or transcription. **Updated 2026-07-07, live
 * finding**: Google Meet bots ALWAYS report `joined_recording`, never
 * `joined_not_recording` — confirmed against Attendee's own source
 * (transcription cannot be disabled for Google Meet regardless of
 * settings, which drives Meet's own recording-permission consent gate).
 * `joined_recording` is therefore now treated as a normal admitted
 * state for Meet, not an abort condition — the original hard-abort
 * would otherwise block every real Meet session, making this feature
 * non-functional on its only in-scope platform. `format: "none"` still
 * guarantees no file is persisted; nothing here changes that. Owner
 * accepted this live (2026-07-07) for diagnostic purposes — **the
 * broader privacy-posture question for real end users is still open**
 * (docs/22 §3, issue #53's "what's NOT done" section) and this is not a
 * final policy decision. `joined_recording_paused` and
 * `joined_recording_permission_denied` remain hard-abort states — both
 * suggest something went wrong beyond the expected/observed pattern.
 */
import type { AttendeeClient, AttendeeSampleRate, BotStatus } from './attendeeClient.js';
import { decodeMp3ToPcm } from '../livekit/decodeMp3ToPcm.js';

export interface BotAudioChannel {
  /**
   * Sends one chunk of base64-encoded 16-bit mono PCM at the session's
   * sample rate, per Attendee's `realtime_audio.bot_output` message
   * shape (docs.attendee.dev "Realtime Audio Input and Output"). The
   * real implementation is the websocket connection Attendee's service
   * opens to our `audioWebsocketUrl` — served by routes/meetBotAudio.ts
   * (permanent since #221; framing live-verified in the H1a spike).
   */
  sendChunk(chunkBase64: string, sampleRate: AttendeeSampleRate): Promise<void>;
}

export interface MeetBotSessionParams {
  meetingUrl: string;
  botName: string;
  audioWebsocketUrl: string;
  mp3: Buffer;
  sampleRate?: AttendeeSampleRate;
  /** Wall-clock budget for the bot to reach an admitted state. Default 60s. */
  admissionTimeoutMs?: number;
  /** Poll interval while waiting for admission or for a post-leave "ended" state. Default 2s. */
  pollIntervalMs?: number;
  /** Duration of each PCM chunk sent to the audio channel. Default 100ms. */
  chunkMs?: number;
}

export type MeetBotSessionFailureReason =
  | 'admission_timeout'
  | 'fatal_error'
  | 'recording_detected'
  | 'audio_send_failed';

export interface MeetBotSessionResult {
  ok: boolean;
  botId?: string;
  failureReason?: MeetBotSessionFailureReason;
  /** Last observed state, for structured logging. */
  lastState?: BotStatus['state'];
}

export interface MeetBotSessionDeps {
  attendeeClient: AttendeeClient;
  audioChannel: BotAudioChannel;
  decode?: typeof decodeMp3ToPcm;
  /** Injectable for tests — real default is a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  logger?: { info: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void };
}

const DEFAULT_SAMPLE_RATE: AttendeeSampleRate = 16000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CHUNK_MS = 100;

// joined_recording included: confirmed live 2026-07-07 as the only state
// real Google Meet bots ever report — see the file header for the full
// finding and the open policy question this doesn't resolve.
const ADMITTED_STATES = new Set<BotStatus['state']>(['joined_not_recording', 'joined_recording']);
const RECORDING_STATES = new Set<BotStatus['state']>([
  'joined_recording_paused',
  'joined_recording_permission_denied',
]);
const WAITING_STATES = new Set<BotStatus['state']>(['ready', 'joining', 'waiting_room', 'scheduled', 'staged']);
const TERMINAL_FAILURE_STATES = new Set<BotStatus['state']>(['fatal_error']);

const noopLogger = { info: () => {}, error: () => {} };
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runMeetBotSession(
  params: MeetBotSessionParams,
  deps: MeetBotSessionDeps,
): Promise<MeetBotSessionResult> {
  const attendeeClient = deps.attendeeClient;
  const audioChannel = deps.audioChannel;
  const decode = deps.decode ?? decodeMp3ToPcm;
  const sleep = deps.sleep ?? realSleep;
  const logger = deps.logger ?? noopLogger;

  const sampleRate = params.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const admissionTimeoutMs = params.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const chunkMs = params.chunkMs ?? DEFAULT_CHUNK_MS;

  const { botId } = await attendeeClient.createBot({
    meetingUrl: params.meetingUrl,
    botName: params.botName,
    audioWebsocketUrl: params.audioWebsocketUrl,
    sampleRate,
  });
  logger.info({ botId, meetingUrl: params.meetingUrl }, 'meetBot: created bot');

  const admission = await waitForAdmission(attendeeClient, botId, admissionTimeoutMs, pollIntervalMs, sleep, logger);
  if (!admission.ok) {
    // Best-effort cleanup regardless of why admission failed — never leave
    // a bot dangling in a meeting we can't otherwise observe.
    await safeLeave(attendeeClient, botId, logger);
    return { ok: false, botId, failureReason: admission.failureReason, lastState: admission.lastState };
  }

  try {
    const pcm = await decode(params.mp3, { sampleRate });
    await streamPcm(audioChannel, pcm, sampleRate, chunkMs, sleep);
    logger.info({ botId, pcmBytes: pcm.length }, 'meetBot: finished streaming audio');
  } catch (err) {
    logger.error({ botId, err: err instanceof Error ? err.message : String(err) }, 'meetBot: audio send failed');
    await safeLeave(attendeeClient, botId, logger);
    return { ok: false, botId, failureReason: 'audio_send_failed' };
  }

  await safeLeave(attendeeClient, botId, logger);
  return { ok: true, botId, lastState: 'joined_not_recording' };
}

export type MeetBotDispatchFailureReason = MeetBotSessionFailureReason | 'session_timeout';

export interface MeetBotDispatchResult {
  ok: boolean;
  botId?: string;
  failureReason?: MeetBotDispatchFailureReason;
  lastState?: BotStatus['state'];
}

/**
 * Dispatch mode (Epic Q, #335) — a discriminated union so a caller cannot
 * assemble a bot that is half websocket-PCM, half voice-agent:
 *
 *  - `websocket`: the pre-Epic-Q path — the bot connects out to our
 *    meetBotAudio websocket and we stream PCM (routes/meetBotAudio.ts).
 *    Kept intact as the fallback mode; its payload must stay byte-identical
 *    to before #335 (regression-asserted in meetBotDispatch.test.ts).
 *  - `voice-agent`: the bot loads the Stage page in Attendee's container
 *    and streams its video+audio into the call (`voice_agent_settings`,
 *    live-confirmed shape — Q4 spike, kairos-devotional#334). The
 *    supervision loop below is mode-independent: the page ends on its own
 *    and the bot leaves/ends, with `sessionTimeoutMs` as the backstop.
 */
export type MeetBotDispatchParams = {
  meetingUrl: string;
  botName: string;
  admissionTimeoutMs?: number;
  /** Wall-clock budget for the whole post-admission bot lifecycle. Streaming/playback happens externally (meetBotAudio.ts or the Stage page itself); this is just a generous supervision timeout. Default 20 minutes. */
  sessionTimeoutMs?: number;
  pollIntervalMs?: number;
} & (
  | {
      mode: 'websocket';
      /** The real, publicly reachable meetBotAudio websocket URL for this devotional — see routes/meetBotAudio.ts. */
      audioWebsocketUrl: string;
      sampleRate?: AttendeeSampleRate;
    }
  | {
      mode: 'voice-agent';
      /** Absolute https:// URL of the Stage page (`/stage/:token`) for this devotional. The token in it is a live capability — never log this URL. */
      stageUrl: string;
    }
);

export interface MeetBotDispatchDeps {
  attendeeClient: AttendeeClient;
  sleep?: (ms: number) => Promise<void>;
  logger?: MeetBotSessionDeps['logger'];
}

const DEFAULT_SESSION_TIMEOUT_MS = 20 * 60 * 1000;
const COMPLETED_STATES = new Set<BotStatus['state']>(['ended', 'data_deleted']);

/**
 * Production bot-dispatch entry point (H1c, #131) — invoked by
 * routes/internal.ts's Cloud-Tasks-triggered dispatch endpoint, distinct
 * from `runMeetBotSession` (the H1a spike's all-in-one create+stream+leave
 * flow, where the caller supplies its own `BotAudioChannel`). In the
 * deployed architecture, audio streaming happens independently —
 * routes/meetBotAudio.ts starts streaming as soon as Attendee's service
 * connects to `audioWebsocketUrl`, with no coordination back to this
 * function. So this function's job is narrower: create the bot pointed
 * at the real audio endpoint, wait for admission, then supervise the
 * bot's overall lifecycle (wait for it to end on its own, or hit a
 * generous timeout) and always clean up.
 */
export async function runMeetBotDispatch(
  params: MeetBotDispatchParams,
  deps: MeetBotDispatchDeps,
): Promise<MeetBotDispatchResult> {
  const attendeeClient = deps.attendeeClient;
  const sleep = deps.sleep ?? realSleep;
  const logger = deps.logger ?? noopLogger;

  const admissionTimeoutMs = params.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  const sessionTimeoutMs = params.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const { botId } = await attendeeClient.createBot(
    params.mode === 'voice-agent'
      ? {
          meetingUrl: params.meetingUrl,
          botName: params.botName,
          voiceAgentUrl: params.stageUrl,
        }
      : {
          meetingUrl: params.meetingUrl,
          botName: params.botName,
          audioWebsocketUrl: params.audioWebsocketUrl,
          sampleRate: params.sampleRate ?? DEFAULT_SAMPLE_RATE,
        },
  );
  logger.info({ botId, meetingUrl: params.meetingUrl, mode: params.mode }, 'meetBotDispatch: created bot');

  const admission = await waitForAdmission(attendeeClient, botId, admissionTimeoutMs, pollIntervalMs, sleep, logger);
  if (!admission.ok) {
    await safeLeave(attendeeClient, botId, logger);
    return { ok: false, botId, failureReason: admission.failureReason, lastState: admission.lastState };
  }

  let elapsed = 0;
  for (;;) {
    const status = await attendeeClient.getBotStatus(botId);

    if (COMPLETED_STATES.has(status.state)) {
      logger.info({ botId, state: status.state }, 'meetBotDispatch: bot session completed');
      await safeLeave(attendeeClient, botId, logger);
      return { ok: true, botId, lastState: status.state };
    }
    if (TERMINAL_FAILURE_STATES.has(status.state)) {
      logger.error({ botId, state: status.state }, 'meetBotDispatch: bot reported fatal_error mid-session');
      await safeLeave(attendeeClient, botId, logger);
      return { ok: false, botId, failureReason: 'fatal_error', lastState: status.state };
    }

    if (elapsed >= sessionTimeoutMs) {
      logger.error({ botId, state: status.state, elapsed }, 'meetBotDispatch: session timed out — forcing leave');
      await safeLeave(attendeeClient, botId, logger);
      return { ok: false, botId, failureReason: 'session_timeout', lastState: status.state };
    }

    await sleep(pollIntervalMs);
    elapsed += pollIntervalMs;
  }
}

async function waitForAdmission(
  attendeeClient: AttendeeClient,
  botId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
  logger: NonNullable<MeetBotSessionDeps['logger']>,
): Promise<{ ok: true } | { ok: false; failureReason: MeetBotSessionFailureReason; lastState?: BotStatus['state'] }> {
  const deadline = timeoutMs;
  let elapsed = 0;

  // At least one status check even if timeoutMs is 0 (tests use this).
  for (;;) {
    const status = await attendeeClient.getBotStatus(botId);

    if (RECORDING_STATES.has(status.state)) {
      logger.error({ botId, state: status.state }, 'meetBot: bot reported a recording state — aborting');
      return { ok: false, failureReason: 'recording_detected', lastState: status.state };
    }
    if (TERMINAL_FAILURE_STATES.has(status.state)) {
      logger.error({ botId, state: status.state }, 'meetBot: bot reported fatal_error — aborting');
      return { ok: false, failureReason: 'fatal_error', lastState: status.state };
    }
    if (ADMITTED_STATES.has(status.state)) {
      logger.info({ botId, state: status.state }, 'meetBot: admitted');
      return { ok: true };
    }
    if (!WAITING_STATES.has(status.state)) {
      // Unrecognized/unexpected state — treat conservatively as not yet admitted,
      // but don't loop forever on something we don't understand.
      logger.error({ botId, state: status.state }, 'meetBot: unexpected state while waiting for admission');
    }

    if (elapsed >= deadline) {
      logger.error({ botId, state: status.state, elapsed }, 'meetBot: admission timed out');
      return { ok: false, failureReason: 'admission_timeout', lastState: status.state };
    }

    await sleep(pollIntervalMs);
    elapsed += pollIntervalMs;
  }
}

/**
 * Exported so any real `BotAudioChannel` implementation (e.g. the live
 * websocket route in routes/meetBotAudio.ts) can reuse the exact same
 * tested chunking/pacing logic rather than re-deriving it.
 */
export async function streamPcm(
  audioChannel: BotAudioChannel,
  pcm: Buffer,
  sampleRate: AttendeeSampleRate,
  chunkMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  // 16-bit mono: 2 bytes/sample.
  const bytesPerChunk = Math.round((sampleRate * chunkMs) / 1000) * 2;
  for (let offset = 0; offset < pcm.length; offset += bytesPerChunk) {
    const chunk = pcm.subarray(offset, Math.min(offset + bytesPerChunk, pcm.length));
    await audioChannel.sendChunk(Buffer.from(chunk).toString('base64'), sampleRate);
    // Real-time pacing: Attendee's protocol doesn't document a required
    // cadence, but sending an entire clip's worth of chunks instantly
    // would front-load audio Attendee expects to arrive roughly in real
    // time — pace to the chunk's own duration, same reasoning as D4's
    // frame pacing (docs/23_LIVEKIT_DELIVERY.md). The H1a live bot
    // (2026-07-07) streamed with this pacing and the owner heard clean
    // audio, so it is sufficient for the clip lengths we produce.
    await sleep(chunkMs);
  }
}

async function safeLeave(
  attendeeClient: AttendeeClient,
  botId: string,
  logger: NonNullable<MeetBotSessionDeps['logger']>,
): Promise<void> {
  try {
    await attendeeClient.requestLeave(botId);
  } catch (err) {
    logger.error({ botId, err: err instanceof Error ? err.message : String(err) }, 'meetBot: requestLeave failed');
  }
  try {
    await attendeeClient.deleteData(botId);
  } catch (err) {
    logger.error({ botId, err: err instanceof Error ? err.message : String(err) }, 'meetBot: deleteData failed');
  }
}
