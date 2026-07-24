/**
 * StageResponseService tests (EPIC V #360 / V2 #363) — fake repos/engine/tts/
 * audio, no Postgres. Covers the gate matrix, idempotency, the TTS-failure →
 * silence degrade, and the privacy pin (no transcript in logs).
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  LiveResponse,
  OpenMomentContext,
  OpenMomentStoredResponse,
} from '@kairos/shared-contracts';
import { StageResponseService } from '../../../src/services/stage/stageResponseService.js';

const CONTEXT: OpenMomentContext = {
  language: 'en',
  tradition: 'general',
  translation: 'BSB',
  preferredVersionId: 3034,
  voiceName: 'en-US-Chirp3-HD-Achernar',
};

const LIVE_RESPONSE: LiveResponse = {
  acknowledgment: 'I hear you.',
  verse: {
    usfm: 'MAT.11.28',
    versionId: 3034,
    reference: 'Matthew 11:28',
    fetchedText: 'Come to Me, all you who labor and are heavy-laden, and I will give you rest.',
    attribution: 'Berean Standard Bible (BSB). Public domain.',
  },
  framing: 'Rest in that.',
};

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    token: 'tok-1',
    devotional_id: 'devo-1',
    user_id: 'user-1',
    expires_at: FUTURE,
    joined_at: new Date(),
    completed_at: null,
    duration_listened_sec: null,
    open_moment_response: null as OpenMomentStoredResponse | null,
    created_at: new Date(),
    ...overrides,
  };
}

function build(opts: {
  session?: ReturnType<typeof sessionRow> | null;
  devotionalOpenMoment?: OpenMomentContext | null;
  engineResult?: Awaited<ReturnType<StageResponseService['respond']>> extends unknown
    ? Parameters<typeof vi.fn>[0]
    : never;
  engine?: { respond: ReturnType<typeof vi.fn> };
  tts?: { synthesizeLiveResponse: ReturnType<typeof vi.fn> };
  markReturns?: ReturnType<typeof sessionRow> | null;
  logger?: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}) {
  const session = opts.session === undefined ? sessionRow() : opts.session;
  const findByToken = vi.fn().mockResolvedValue(session);
  const markOpenMomentResponse = vi
    .fn()
    .mockImplementation((_uid: string, _token: string, stored: OpenMomentStoredResponse) =>
      Promise.resolve(
        opts.markReturns !== undefined
          ? opts.markReturns
          : sessionRow({ open_moment_response: stored }),
      ),
    );
  const sessions = { findByToken, markOpenMomentResponse };

  const devotionals = {
    getById: vi.fn().mockResolvedValue({
      id: 'devo-1',
      open_moment: opts.devotionalOpenMoment === undefined ? CONTEXT : opts.devotionalOpenMoment,
    }),
  };

  const engine =
    opts.engine ??
    ({
      respond: vi
        .fn()
        .mockResolvedValue({
          outcome: 'response',
          response: LIVE_RESPONSE,
          distressFlagged: false,
        }),
    } as { respond: ReturnType<typeof vi.fn> });

  const tts =
    opts.tts ??
    ({
      synthesizeLiveResponse: vi.fn().mockResolvedValue({
        audio: Buffer.from('mp3'),
        voiceName: 'x',
        durations: { acknowledgmentSec: 1, verseSec: 2, framingSec: 1, totalSec: 4 },
      }),
    } as { synthesizeLiveResponse: ReturnType<typeof vi.fn> });

  const audioStorage = {
    upload: vi.fn().mockResolvedValue({ objectKey: 'devotionals/open-moment-tok-1.mp3' }),
    getSignedUrl: vi
      .fn()
      .mockResolvedValue({ url: 'https://signed.example/clip.mp3', expiresAt: FUTURE }),
  };

  const logger = opts.logger ?? { info: vi.fn(), error: vi.fn() };

  const service = new StageResponseService({
    sessions: sessions as never,
    devotionals: devotionals as never,
    engine: engine as never,
    tts: tts as never,
    audioStorage: audioStorage as never,
    logger,
  });
  return { service, sessions, devotionals, engine, tts, audioStorage, logger };
}

describe('StageResponseService — gate matrix', () => {
  it('unknown token → not_found', async () => {
    const { service } = build({ session: null });
    expect((await service.respond('tok-x', 'hi')).kind).toBe('not_found');
  });

  it('expired session → not_found (enumeration-safe)', async () => {
    const { service } = build({ session: sessionRow({ expires_at: PAST }) });
    expect((await service.respond('tok-1', 'hi')).kind).toBe('not_found');
  });

  it('open moment not enabled on the devotional → disabled', async () => {
    const { service, engine } = build({ devotionalOpenMoment: null });
    expect((await service.respond('tok-1', 'hi')).kind).toBe('disabled');
    expect(engine.respond).not.toHaveBeenCalled();
  });
});

describe('StageResponseService — response + silence outcomes', () => {
  it('response outcome → synthesizes, uploads, stores, and returns a signed audio envelope', async () => {
    const { service, tts, audioStorage, sessions } = build({});
    const result = await service.respond('tok-1', 'I am weary');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.envelope.outcome).toBe('response');
    expect(result.envelope.audioUrl).toBe('https://signed.example/clip.mp3');
    expect(result.envelope.verse?.reference).toBe('Matthew 11:28');
    expect(result.envelope.durations?.totalSec).toBe(4);
    expect(tts.synthesizeLiveResponse).toHaveBeenCalledWith(
      LIVE_RESPONSE,
      CONTEXT.voiceName,
      CONTEXT.language,
    );
    expect(audioStorage.upload).toHaveBeenCalledWith('open-moment-tok-1', expect.any(Buffer));
    expect(sessions.markOpenMomentResponse).toHaveBeenCalledTimes(1);
  });

  it('silence outcome → no TTS, envelope is silence', async () => {
    const engine = {
      respond: vi.fn().mockResolvedValue({ outcome: 'silence', distressFlagged: false }),
    };
    const { service, tts } = build({ engine });
    const result = await service.respond('tok-1', '');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.envelope.outcome).toBe('silence');
    expect(tts.synthesizeLiveResponse).not.toHaveBeenCalled();
  });

  it('a distress response carries distressFlagged through to the envelope', async () => {
    const engine = {
      respond: vi
        .fn()
        .mockResolvedValue({ outcome: 'response', response: LIVE_RESPONSE, distressFlagged: true }),
    };
    const { service } = build({ engine });
    const result = await service.respond('tok-1', 'crisis');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.envelope.distressFlagged).toBe(true);
  });

  it('TTS failure degrades to silence (the quiet is never broken by a failure)', async () => {
    const tts = {
      synthesizeLiveResponse: vi.fn().mockRejectedValue(new Error('AUDIO_UNAVAILABLE')),
    };
    const { service } = build({ tts });
    const result = await service.respond('tok-1', 'weary');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.envelope.outcome).toBe('silence');
  });
});

describe('StageResponseService — idempotency (V2 #363)', () => {
  it('a second POST replays the stored result WITHOUT re-running the engine', async () => {
    const stored: OpenMomentStoredResponse = {
      outcome: 'response',
      distressFlagged: false,
      audioId: 'open-moment-tok-1',
      verse: { reference: 'Matthew 11:28', fetchedText: 'Come to Me...', attribution: 'BSB' },
      durations: { acknowledgmentSec: 1, verseSec: 2, framingSec: 1, totalSec: 4 },
    };
    const { service, engine, tts, audioStorage } = build({
      session: sessionRow({ open_moment_response: stored }),
    });
    const result = await service.respond('tok-1', 'weary');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.envelope.outcome).toBe('response');
    expect(result.envelope.audioUrl).toBe('https://signed.example/clip.mp3'); // re-signed
    expect(engine.respond).not.toHaveBeenCalled();
    expect(tts.synthesizeLiveResponse).not.toHaveBeenCalled();
    expect(audioStorage.getSignedUrl).toHaveBeenCalled();
  });

  it('on a lost write race, honors the winner’s stored result (re-read), not ours', async () => {
    const winnerStored: OpenMomentStoredResponse = { outcome: 'silence', distressFlagged: false };
    // markOpenMomentResponse returns null (someone else won); re-read returns the winner.
    const { service, sessions } = build({ markReturns: null });
    sessions.findByToken
      .mockResolvedValueOnce(sessionRow()) // first lookup: no response yet
      .mockResolvedValueOnce(sessionRow({ open_moment_response: winnerStored })); // re-read after lost race
    const result = await service.respond('tok-1', 'weary');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.envelope.outcome).toBe('silence');
  });
});

describe('StageResponseService — privacy (epic §5)', () => {
  it('NEVER logs the transcript (metadata-only ops line)', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const secret = 'my-very-distinctive-secret-transcript-phrase-12345';
    const { service } = build({ logger });
    await service.respond('tok-1', secret);

    const allLoggedArgs = [...logger.info.mock.calls, ...logger.error.mock.calls];
    for (const call of allLoggedArgs) {
      expect(JSON.stringify(call)).not.toContain(secret);
    }
    // And the ops line is metadata-only.
    const opsLine = logger.info.mock.calls.find(([msg]) =>
      String(msg).includes('Open Moment responded'),
    );
    expect(opsLine).toBeTruthy();
    const meta = opsLine?.[1] as Record<string, unknown>;
    expect(Object.keys(meta ?? {}).sort()).toEqual([
      'distressFlagged',
      'latencyMs',
      'outcome',
      'sessionTokenHash',
    ]);
  });
});
