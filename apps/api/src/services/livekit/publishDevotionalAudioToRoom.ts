/**
 * Orchestration for D4/#32's `room_started` webhook handler: resolve a
 * LiveKit room name back to a Wellspring session, fetch its already-synthesized
 * audio, decode it, and publish it into the room as a bot participant.
 *
 * Deliberately mirrors this repo's established "pure orchestration with
 * injectable I/O" pattern (e.g. rescheduleWatcher.ts's `runRescheduleCheck`)
 * so every branch here — foreign room, expired/unknown session,
 * AUDIO_UNAVAILABLE, and the happy path — is unit-testable with fakes,
 * without needing a real LiveKit server, ffmpeg binary, or network call.
 * Only the default `connectAndPublish` (connectAndPublishPcmToRoom.ts) and
 * default `decode` (decodeMp3ToPcm.ts) touch anything real, and neither is
 * exercised by these tests — see those files' own "must-confirm" notes.
 */
import { AccessToken } from 'livekit-server-sdk';
import type { SessionLookupResult } from '../session/sessionService.js';
import { sessionTokenFromRoomName } from '../delivery/liveKitRoomNaming.js';
import type { LiveKitConfig } from '../delivery/liveKitConfig.js';
import { decodeMp3ToPcm } from './decodeMp3ToPcm.js';
import { connectAndPublishPcmToRoom } from './connectAndPublishPcmToRoom.js';

/** Exported so routes/livekitWebhook.ts can ignore the bot's own participant_joined event (else it would re-trigger itself on every publish). */
export const BOT_IDENTITY = 'kairos-agent';

export interface PublishLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: PublishLogger = {
  info: (msg, meta) => console.info(`[livekitPublish] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[livekitPublish] ${msg}`, meta ?? ''),
};

export interface PublishDevotionalAudioDeps {
  sessionService: { getSessionView(token: string): Promise<SessionLookupResult> };
  liveKitConfig: LiveKitConfig;
  logger?: PublishLogger;
  /** Injectable for tests — real default is a plain `fetch`. */
  fetchAudio?: (url: string) => Promise<Buffer>;
  /** Injectable for tests — real default is decodeMp3ToPcm.ts. */
  decode?: (mp3: Buffer) => Promise<Buffer>;
  /** Injectable for tests — real default is connectAndPublishPcmToRoom.ts. */
  connectAndPublish?: (params: { url: string; token: string; pcm: Buffer }) => Promise<void>;
}

export type PublishOutcome =
  | { outcome: 'ignored_foreign_room' }
  | { outcome: 'session_not_found' }
  | { outcome: 'audio_unavailable' }
  | { outcome: 'published' }
  | { outcome: 'failed'; reason: string };

async function defaultFetchAudio(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch devotional audio: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Called from the webhook route AFTER it has already sent its fast 200
 * ack (LiveKit expects a prompt response) — this function's duration
 * spans the full audio length and must never block that ack.
 */
export async function publishDevotionalAudioForRoom(
  roomName: string,
  deps: PublishDevotionalAudioDeps,
): Promise<PublishOutcome> {
  const logger = deps.logger ?? consoleLogger;
  const sessionToken = sessionTokenFromRoomName(roomName);
  if (!sessionToken) {
    logger.info('Ignoring room_started for a non-Wellspring room', { roomName });
    return { outcome: 'ignored_foreign_room' };
  }

  const view = await deps.sessionService.getSessionView(sessionToken);
  if (view.kind !== 'ok') {
    logger.info('Session not found or expired — nothing to publish', { roomName, sessionToken });
    return { outcome: 'session_not_found' };
  }

  if (!view.page.audioUrl) {
    logger.info('AUDIO_UNAVAILABLE for this devotional — room stays silent', {
      roomName,
      sessionToken,
    });
    return { outcome: 'audio_unavailable' };
  }

  try {
    const fetchAudio = deps.fetchAudio ?? defaultFetchAudio;
    const decode = deps.decode ?? decodeMp3ToPcm;
    const connectAndPublish = deps.connectAndPublish ?? connectAndPublishPcmToRoom;

    const mp3 = await fetchAudio(view.page.audioUrl);
    const pcm = await decode(mp3);

    const at = new AccessToken(deps.liveKitConfig.apiKey, deps.liveKitConfig.apiSecret, {
      identity: BOT_IDENTITY,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: false });
    const token = await at.toJwt();

    await connectAndPublish({ url: deps.liveKitConfig.url, token, pcm });
    logger.info('Published devotional audio to room', { roomName, sessionToken });
    return { outcome: 'published' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('Failed to publish devotional audio — room stays silent', {
      roomName,
      sessionToken,
      reason,
    });
    return { outcome: 'failed', reason };
  }
}
