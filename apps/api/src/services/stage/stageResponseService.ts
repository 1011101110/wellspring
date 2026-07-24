/**
 * StageResponseService — the orchestration behind `POST /v1/stage/:token/
 * respond` (EPIC V #360 / V2 #363). Owns the gates and the
 * validate-before-speak → TTS → store → envelope flow, keeping the route a
 * thin HTTP shell.
 *
 * Flow:
 *   1. Resolve the session (unexpired) — enumeration-safe `not_found`.
 *   2. Idempotent replay: if this session already has a stored response,
 *      return it (a second POST returns the first result — never re-runs the
 *      engine). Signed URLs are re-minted on each read, never stored.
 *   3. Gate: the devotional must carry an `open_moment` context (the open
 *      moment was enabled for it) — else `disabled`.
 *   4. Run the OpenMomentEngine (distress pre-check + bounded Gloo turn +
 *      full validation gauntlet). Only a VALIDATED response is eligible for
 *      TTS; anything else is `silence`.
 *   5. On a response: synthesize the live audio, upload it, and store the
 *      outcome (set-once, idempotency). A TTS/upload failure degrades to
 *      silence — the quiet is never broken by a failure.
 *
 * Privacy (epic §5): the transcript is NEVER persisted and NEVER logged. The
 * ops log this service emits is metadata only —
 * `{ sessionTokenHash, outcome, latencyMs, distressFlagged }`.
 */

import { createHash } from 'node:crypto';
import {
  OpenMomentContextSchema,
  type OpenMomentContext,
  type OpenMomentResponseEnvelope,
  type OpenMomentStoredResponse,
  type LiveResponseDurations,
} from '@kairos/shared-contracts';
import { asVerifiedUserId } from '../../db/repositories/index.js';
import type { DevotionalsRepository, SessionsRepository } from '../../db/repositories/index.js';
import type { AudioStorage, SignedUrlOptions } from '../audio/audioStorage.js';
import type { LiveResponse } from '@kairos/shared-contracts';

/** The engine surface StageResponseService needs — narrowed so tests can fake it without a Gloo/YouVersion client. */
export interface OpenMomentEngineLike {
  respond(
    transcript: string,
    context: OpenMomentContext,
  ): Promise<
    | { outcome: 'silence'; distressFlagged: boolean }
    | { outcome: 'response'; response: LiveResponse; distressFlagged: boolean }
  >;
}

/** The TTS surface StageResponseService needs — narrowed for the same reason. */
export interface LiveResponseTtsLike {
  synthesizeLiveResponse(
    response: LiveResponse,
    voiceName?: string,
    language?: string,
  ): Promise<{ audio: Buffer; voiceName: string; durations: LiveResponseDurations }>;
}

export interface StageResponseServiceLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: StageResponseServiceLogger = {
  info: (msg, meta) => console.info(`[stageResponseService] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[stageResponseService] ${msg}`, meta ?? ''),
};

export interface StageResponseServiceDeps {
  sessions: Pick<SessionsRepository, 'findByToken' | 'markOpenMomentResponse'>;
  devotionals: Pick<DevotionalsRepository, 'getById'>;
  engine: OpenMomentEngineLike;
  tts: LiveResponseTtsLike;
  audioStorage: Pick<AudioStorage, 'upload' | 'getSignedUrl'>;
  now?: () => Date;
  signedUrlOptions?: SignedUrlOptions;
  logger?: StageResponseServiceLogger;
}

export type OpenMomentRespondResult =
  | { kind: 'not_found' }
  | { kind: 'disabled' }
  | { kind: 'ok'; envelope: OpenMomentResponseEnvelope };

/** The audio-storage id for a session's live-response clip — distinct from the devotional MP3 id. */
function openMomentAudioId(token: string): string {
  return `open-moment-${token}`;
}

/** A stable, non-reversible hash of the session token for the metadata-only ops log (epic §5). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export class StageResponseService {
  private readonly sessions: StageResponseServiceDeps['sessions'];
  private readonly devotionals: StageResponseServiceDeps['devotionals'];
  private readonly engine: OpenMomentEngineLike;
  private readonly tts: LiveResponseTtsLike;
  private readonly audioStorage: StageResponseServiceDeps['audioStorage'];
  private readonly now: () => Date;
  private readonly signedUrlOptions: SignedUrlOptions | undefined;
  private readonly logger: StageResponseServiceLogger;

  constructor(deps: StageResponseServiceDeps) {
    this.sessions = deps.sessions;
    this.devotionals = deps.devotionals;
    this.engine = deps.engine;
    this.tts = deps.tts;
    this.audioStorage = deps.audioStorage;
    this.now = deps.now ?? (() => new Date());
    this.signedUrlOptions = deps.signedUrlOptions;
    this.logger = deps.logger ?? consoleLogger;
  }

  async respond(token: string, transcript: string): Promise<OpenMomentRespondResult> {
    const startedAt = this.now().getTime();
    const session = await this.sessions.findByToken(token);
    if (!session) {
      return { kind: 'not_found' };
    }
    if (session.expires_at.getTime() <= this.now().getTime()) {
      return { kind: 'not_found' };
    }

    const ownerId = asVerifiedUserId(session.user_id);

    // Idempotent replay (V2 #363): a second POST returns the first result and
    // NEVER re-runs the engine. Signed URLs are minted fresh on read.
    if (session.open_moment_response) {
      const envelope = await this.buildEnvelope(token, session.open_moment_response);
      return { kind: 'ok', envelope };
    }

    const devotional = await this.devotionals.getById(ownerId, session.devotional_id);
    if (!devotional) {
      return { kind: 'not_found' };
    }

    // Gate: the open moment must have been enabled for this devotional
    // (context stored at generation, V4). null / malformed → disabled.
    const parsedContext = OpenMomentContextSchema.safeParse(devotional.open_moment);
    if (!parsedContext.success) {
      return { kind: 'disabled' };
    }
    const context = parsedContext.data;

    const engineResult = await this.engine.respond(transcript, context);

    let stored: OpenMomentStoredResponse;
    if (engineResult.outcome === 'response') {
      stored = await this.synthesizeAndStore(
        token,
        engineResult.response,
        engineResult.distressFlagged,
        context,
      );
    } else {
      stored = { outcome: 'silence', distressFlagged: engineResult.distressFlagged };
    }

    // Set-once persist (idempotency). If we lost a race, re-read and honor the
    // winner's stored result rather than ours.
    const winner = await this.sessions.markOpenMomentResponse(ownerId, token, stored);
    const authoritative =
      winner?.open_moment_response ?? (await this.reReadStored(token)) ?? stored;

    this.logger.info('Open Moment responded', {
      sessionTokenHash: hashToken(token),
      outcome: authoritative.outcome,
      latencyMs: this.now().getTime() - startedAt,
      distressFlagged: authoritative.distressFlagged,
    });

    const envelope = await this.buildEnvelope(token, authoritative);
    return { kind: 'ok', envelope };
  }

  /**
   * Synthesizes + uploads the live-response audio and returns the stored
   * payload. A TTS/upload failure degrades to `silence` (the quiet is never
   * broken by an unvalidated OR unspeakable word — epic §2/§6).
   */
  private async synthesizeAndStore(
    token: string,
    response: LiveResponse,
    distressFlagged: boolean,
    context: OpenMomentContext,
  ): Promise<OpenMomentStoredResponse> {
    try {
      const synthesized = await this.tts.synthesizeLiveResponse(
        response,
        context.voiceName,
        context.language,
      );
      const audioId = openMomentAudioId(token);
      await this.audioStorage.upload(audioId, synthesized.audio);
      return {
        outcome: 'response',
        distressFlagged,
        audioId,
        verse: {
          reference: response.verse.reference,
          fetchedText: response.verse.fetchedText,
          attribution: response.verse.attribution,
        },
        durations: synthesized.durations,
      };
    } catch (err) {
      this.logger.error('Open Moment TTS/upload failed — degrading to silence', {
        sessionTokenHash: hashToken(token),
        reason: err instanceof Error ? err.message : String(err),
      });
      return { outcome: 'silence', distressFlagged };
    }
  }

  private async reReadStored(token: string): Promise<OpenMomentStoredResponse | null> {
    const fresh = await this.sessions.findByToken(token);
    return fresh?.open_moment_response ?? null;
  }

  /** Builds the wire envelope, minting a fresh signed URL for a response outcome. */
  private async buildEnvelope(
    token: string,
    stored: OpenMomentStoredResponse,
  ): Promise<OpenMomentResponseEnvelope> {
    if (stored.outcome !== 'response' || !stored.audioId) {
      return { outcome: 'silence', distressFlagged: stored.distressFlagged };
    }
    let audioUrl: string | undefined;
    try {
      const signed = await this.audioStorage.getSignedUrl(stored.audioId, this.signedUrlOptions);
      audioUrl = signed.url;
    } catch (err) {
      // Audio unavailable at read time (Foundation §4.5): degrade to silence
      // rather than returning a response envelope with no audio.
      this.logger.error('Open Moment signed-URL mint failed — degrading to silence', {
        sessionTokenHash: hashToken(token),
        reason: err instanceof Error ? err.message : String(err),
      });
      return { outcome: 'silence', distressFlagged: stored.distressFlagged };
    }
    return {
      outcome: 'response',
      audioUrl,
      verse: stored.verse,
      durations: stored.durations,
      distressFlagged: stored.distressFlagged,
    };
  }
}
