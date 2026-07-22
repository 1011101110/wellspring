/**
 * Route tests for the Meet-bot audio websocket.
 *
 * ## The standard of proof these tests hold themselves to (#193, #217, #221)
 *
 * A refusal test that only asserts "the gate was called" proves nothing a
 * user cares about — the gate can be called and the audio can play anyway.
 * What the user is promised is that **no sound comes out of the bot**. So
 * every refusal case below asserts on the *bytes*, via `assertNoPcmWritten`:
 *
 *   - the client received zero `realtime_audio.bot_output` frames (this is
 *     literally the PCM — the only way audio reaches the meeting), and
 *   - `getSignedUrl` was never called and `fetch` never ran, so the audio
 *     was not even retrieved, let alone decoded or sent.
 *
 * The second half matters independently of the first: it proves the refusal
 * happens *before* the devotional's audio is touched at all, rather than
 * after a decode that merely failed to transmit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { WebSocket } from 'ws';
import { buildApp } from '../../src/app.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';
import type { MeetBotPlaybackLedger } from '../../src/routes/meetBotAudio.js';
import type { MeetBotConsentGateDeps } from '../../src/services/meetBot/meetBotConsentGate.js';
import { deriveMeetBotAudioToken } from '../../src/services/meetBot/meetBotAudioCapabilityToken.js';
import { FakeAttendeeClient } from '../../src/services/meetBot/fakeAttendeeClient.js';

const ROOT_SECRET = 'test-meetbot-audio-root-secret';

/** The capability token a legitimately dispatched bot would present for `devotionalId`. */
const tokenFor = (devotionalId: string) => deriveMeetBotAudioToken(ROOT_SECRET, devotionalId);

function fakeAudioStorage(): AudioStorage {
  return {
    upload: vi.fn(),
    getSignedUrl: vi.fn().mockResolvedValue({ url: 'https://example.test/fake.mp3', expiresAt: new Date() }),
    exists: vi.fn(),
    delete: vi.fn(),
  } as unknown as AudioStorage;
}

/**
 * Consent-gate deps built out of plain database-shaped state rather than a
 * stubbed decision, mirroring internal.test.ts: these tests exercise the
 * REAL `checkMeetBotConsent` logic, so a regression in the gate itself
 * fails here too rather than being masked by a fake that always says yes.
 */
function consentGate(opts: {
  ownerUserId?: string | null;
  userExists?: boolean;
  connectionStatus?: string | null;
} = {}): MeetBotConsentGateDeps {
  const ownerUserId = opts.ownerUserId === undefined ? 'user-1' : opts.ownerUserId;
  const userExists = opts.userExists ?? true;
  const connectionStatus = opts.connectionStatus === undefined ? 'active' : opts.connectionStatus;
  return {
    devotionals: { findOwnerUserId: vi.fn().mockResolvedValue(ownerUserId) },
    users: { findById: vi.fn().mockResolvedValue(userExists ? { id: ownerUserId } : null) },
    connections: {
      findByProvider: vi.fn().mockResolvedValue(connectionStatus === null ? null : { status: connectionStatus }),
    },
  } as unknown as MeetBotConsentGateDeps;
}

/**
 * In-memory stand-in for `devotionals.meetbot_played_at`. Deliberately a
 * plain Set *outside* the route module: the whole point of #221 is that
 * the durable record survives a process that has forgotten everything, and
 * the restart test below re-creates the app around a ledger it keeps.
 */
function fakeLedger(playedIds: Set<string> = new Set()): MeetBotPlaybackLedger & { played: Set<string> } {
  return {
    played: playedIds,
    hasMeetBotPlayed: vi.fn(async (id: string) => playedIds.has(id)),
    markMeetBotPlayed: vi.fn(async (id: string) => {
      playedIds.add(id);
    }),
  };
}

/** A real, tiny (0.1s) silent MP3 so the decode+stream path runs to completion. */
function generateSilentMp3(): Buffer {
  const result = spawnSync(ffmpeg.path, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
    '-t', '0.1', '-f', 'mp3', 'pipe:1',
  ]);
  if (result.status !== 0) throw new Error(`fixture MP3 generation failed: ${result.stderr.toString('utf8')}`);
  return result.stdout;
}

interface ConnectResult {
  closeCode: number;
  /** Every `realtime_audio.bot_output` frame the server sent — i.e. the PCM. */
  pcmFrames: unknown[];
}

/** Opens a connection, collects any audio frames, and resolves when it closes. */
function connect(port: number, path: string, opts: { sendBotId?: string } = {}): Promise<ConnectResult> {
  return new Promise<ConnectResult>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const pcmFrames: unknown[] = [];
    ws.on('open', () => {
      if (opts.sendBotId) {
        ws.send(JSON.stringify({ bot_id: opts.sendBotId, trigger: 'realtime_audio.mixed', data: {} }));
      }
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { trigger?: string };
        if (msg.trigger === 'realtime_audio.bot_output') pcmFrames.push(msg);
      } catch {
        // Non-JSON frame — not audio, ignore.
      }
    });
    ws.on('close', (code) => resolve({ closeCode: code, pcmFrames }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timed out waiting for close')), 8000);
  });
}

/**
 * The #193/#217/#221 assertion: not "a check ran", but "no audio existed".
 */
function assertNoPcmWritten(result: ConnectResult, audioStorage: AudioStorage): void {
  expect(result.pcmFrames).toEqual([]);
  expect(audioStorage.getSignedUrl).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
}

describe('meetBotAudio websocket route', () => {
  let originalFetch: typeof globalThis.fetch;
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  /** Builds + listens, returns the port. Every app is closed in afterEach. */
  async function start(routeDeps: Parameters<typeof buildApp>[0]['meetBotAudioRoutes']): Promise<number> {
    const app = buildApp({ meetBotAudioRoutes: routeDeps });
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('unexpected server address');
    return address.port;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, arrayBuffer: async () => generateSilentMp3().buffer } as Response);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  // ── Capability token (#221) ─────────────────────────────────────────

  it('rejects a connection with the wrong token (close code 1008) and streams nothing', async () => {
    const audioStorage = fakeAudioStorage();
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: consentGate(),
      playbackLedger: fakeLedger(),
      sleep: () => Promise.resolve(),
    });

    const result = await connect(port, '/meetbot/audio/wrong-token/some-devotional-id');

    expect(result.closeCode).toBe(1008);
    assertNoPcmWritten(result, audioStorage);
  });

  it("refuses a token minted for a DIFFERENT devotional — the capability cannot be retargeted (#221)", async () => {
    const audioStorage = fakeAudioStorage();
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: consentGate(),
      playbackLedger: fakeLedger(),
      sleep: () => Promise.resolve(),
    });

    // A perfectly valid token — for someone else's devotional. This is the
    // leaked-URL case the global token could not defend against at all.
    const result = await connect(port, `/meetbot/audio/${tokenFor('devo-A')}/devo-B`);

    expect(result.closeCode).toBe(1008);
    assertNoPcmWritten(result, audioStorage);
  });

  it('closes the connection immediately when MEETBOT_AUDIO_TOKEN is unset (fail-closed)', async () => {
    const audioStorage = fakeAudioStorage();
    const port = await start({
      audioStorage,
      meetBotAudioSecret: undefined,
      consentGate: consentGate(),
      playbackLedger: fakeLedger(),
    });

    const result = await connect(port, '/meetbot/audio/anything/some-devotional-id');

    expect(result.closeCode).toBe(1008);
    assertNoPcmWritten(result, audioStorage);
  });

  // ── Consent gate (#221) — the P0 ────────────────────────────────────

  it('refuses a REVOKED user: no PCM written, connection closed 1008', async () => {
    const audioStorage = fakeAudioStorage();
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      // The explicit-disconnect case: the connection row still exists, its
      // status is no longer `active`.
      consentGate: consentGate({ connectionStatus: 'revoked' }),
      playbackLedger: fakeLedger(),
      sleep: () => Promise.resolve(),
    });

    const result = await connect(port, `/meetbot/audio/${tokenFor('devo-revoked')}/devo-revoked`);

    expect(result.closeCode).toBe(1008);
    assertNoPcmWritten(result, audioStorage);
  });

  it('refuses a DELETED user: no PCM written, connection closed 1008', async () => {
    const audioStorage = fakeAudioStorage();
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      // `users.hardDelete` cascades to `devotionals`, so a deleted account's
      // devotional row is gone and the owner lookup returns null.
      consentGate: consentGate({ ownerUserId: null }),
      playbackLedger: fakeLedger(),
      sleep: () => Promise.resolve(),
    });

    const result = await connect(port, `/meetbot/audio/${tokenFor('devo-deleted')}/devo-deleted`);

    expect(result.closeCode).toBe(1008);
    assertNoPcmWritten(result, audioStorage);
  });

  it('refuses when the user has no calendar connection at all: no PCM written', async () => {
    const audioStorage = fakeAudioStorage();
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: consentGate({ connectionStatus: null }),
      playbackLedger: fakeLedger(),
      sleep: () => Promise.resolve(),
    });

    const result = await connect(port, `/meetbot/audio/${tokenFor('devo-noconn')}/devo-noconn`);

    expect(result.closeCode).toBe(1008);
    assertNoPcmWritten(result, audioStorage);
  });

  it('fails CLOSED when the consent lookup throws — not knowing is not permission (#221)', async () => {
    const audioStorage = fakeAudioStorage();
    const brokenGate = {
      devotionals: { findOwnerUserId: vi.fn().mockRejectedValue(new Error('db unreachable')) },
      users: { findById: vi.fn() },
      connections: { findByProvider: vi.fn() },
    } as unknown as MeetBotConsentGateDeps;
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: brokenGate,
      playbackLedger: fakeLedger(),
      sleep: () => Promise.resolve(),
    });

    const result = await connect(port, `/meetbot/audio/${tokenFor('devo-dberr')}/devo-dberr`);

    expect(result.closeCode).toBe(1011);
    assertNoPcmWritten(result, audioStorage);
  });

  it('does NOT consult the consent gate before the capability token is verified', async () => {
    // Ordering matters for more than tidiness: an unauthenticated caller
    // must not be able to make us do database work, and must not learn
    // anything about whether a devotional id exists.
    const audioStorage = fakeAudioStorage();
    const gate = consentGate();
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: gate,
      playbackLedger: fakeLedger(),
    });

    await connect(port, '/meetbot/audio/bogus/devo-1');

    expect(gate.devotionals.findOwnerUserId).not.toHaveBeenCalled();
  });

  // ── Happy path ──────────────────────────────────────────────────────

  it('accepts a consenting connection, streams PCM, and records the play durably', async () => {
    const audioStorage = fakeAudioStorage();
    const ledger = fakeLedger();
    const attendeeClient = new FakeAttendeeClient();
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: consentGate(),
      playbackLedger: ledger,
      attendeeClient: attendeeClient as never,
      sleep: () => Promise.resolve(),
    });

    const result = await connect(port, `/meetbot/audio/${tokenFor('devo-ok')}/devo-ok`, {
      sendBotId: 'bot-ok',
    });

    expect(result.closeCode).toBe(1000);
    // The positive control for `assertNoPcmWritten`: audio really does flow
    // when consent is present, so the refusal assertions above are testing
    // something that would otherwise have happened.
    expect(result.pcmFrames.length).toBeGreaterThan(0);
    expect(audioStorage.getSignedUrl).toHaveBeenCalledWith('devo-ok');
    // Durable record written, and the bot pulled out of the meeting.
    expect(ledger.markMeetBotPlayed).toHaveBeenCalledWith('devo-ok');
    expect(ledger.played.has('devo-ok')).toBe(true);
    expect(attendeeClient.leaveCalls).toEqual(['bot-ok']);
  });

  // ── Durable play-once guard (#221) ──────────────────────────────────

  it('does not replay on a reconnect to the same instance (the original loop fix)', async () => {
    const audioStorage = fakeAudioStorage();
    const ledger = fakeLedger();
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: consentGate(),
      playbackLedger: ledger,
      attendeeClient: new FakeAttendeeClient() as never,
      sleep: () => Promise.resolve(),
    });
    const path = `/meetbot/audio/${tokenFor('devo-replay')}/devo-replay`;

    const first = await connect(port, path, { sendBotId: 'bot-replay' });
    expect(first.pcmFrames.length).toBeGreaterThan(0);

    (audioStorage.getSignedUrl as ReturnType<typeof vi.fn>).mockClear();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();

    const second = await connect(port, path);

    expect(second.closeCode).toBe(1000);
    assertNoPcmWritten(second, audioStorage);
  });

  it('does not replay after an INSTANCE RESTART — the durable guard, not the in-memory Set (#221)', async () => {
    // This is the case the process-local `Set` could not cover and which
    // #221 exists to close. Cloud Run scales to zero between slots, so a
    // reconnect landing on a cold instance is the ordinary case, not an
    // exotic one.
    //
    // The restart is simulated the only way that is actually meaningful:
    // the SHARED ledger (standing in for `devotionals.meetbot_played_at`)
    // already says the devotional played, while the route module's
    // in-memory Set has never seen this id — exactly the state a fresh
    // process is in. If the handler consulted only the Set, this would
    // replay the devotional aloud in the user's meeting.
    const audioStorage = fakeAudioStorage();
    const ledgerAfterRestart = fakeLedger(new Set(['devo-cold-start']));
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: consentGate(),
      playbackLedger: ledgerAfterRestart,
      sleep: () => Promise.resolve(),
    });

    const result = await connect(port, `/meetbot/audio/${tokenFor('devo-cold-start')}/devo-cold-start`);

    expect(result.closeCode).toBe(1000);
    assertNoPcmWritten(result, audioStorage);
    // And it was the DURABLE record that said no — proving the refusal came
    // from storage rather than from a Set that happened to be populated.
    expect(ledgerAfterRestart.hasMeetBotPlayed).toHaveBeenCalledWith('devo-cold-start');
  });

  it('fails CLOSED when the playback-ledger lookup throws — not knowing is not permission (#221)', async () => {
    const audioStorage = fakeAudioStorage();
    const brokenLedger: MeetBotPlaybackLedger = {
      hasMeetBotPlayed: vi.fn().mockRejectedValue(new Error('db unreachable')),
      markMeetBotPlayed: vi.fn(),
    };
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: consentGate(),
      playbackLedger: brokenLedger,
      sleep: () => Promise.resolve(),
    });

    const result = await connect(port, `/meetbot/audio/${tokenFor('devo-ledgererr')}/devo-ledgererr`);

    expect(result.closeCode).toBe(1011);
    assertNoPcmWritten(result, audioStorage);
  });

  it('checks consent BEFORE the playback ledger, so a revoked user is refused as revoked', async () => {
    // Not a stylistic preference. The two refusals are logged differently
    // and mean different things: `already-played` is a routine no-op,
    // `consent-revoked` is a privacy signal worth alerting on. Checking
    // playback first would mask every revoke that arrives after playback.
    const audioStorage = fakeAudioStorage();
    const ledger = fakeLedger(new Set(['devo-both']));
    const port = await start({
      audioStorage,
      meetBotAudioSecret: ROOT_SECRET,
      consentGate: consentGate({ connectionStatus: 'revoked' }),
      playbackLedger: ledger,
      sleep: () => Promise.resolve(),
    });

    const result = await connect(port, `/meetbot/audio/${tokenFor('devo-both')}/devo-both`);

    expect(result.closeCode).toBe(1008); // consent refusal, not 1000/already-played
    expect(ledger.hasMeetBotPlayed).not.toHaveBeenCalled();
    assertNoPcmWritten(result, audioStorage);
  });
});
