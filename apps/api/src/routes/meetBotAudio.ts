/**
 * The websocket-PCM half of meet-bot delivery — the websocket server
 * Attendee's service connects out to for bot audio (docs/22 §3). Born as
 * the H1a (#129) live spike, but long since permanent: #221 hardened it
 * (per-devotional capability tokens, connect-time consent gate, durable
 * play-once ledger) and routes/internal.ts's dispatch-meetbot dispatches
 * to it per devotional. Since Epic Q (#335) it is one of TWO dispatch
 * modes: `websocket` (this route — Attendee connects here and we stream
 * decoded PCM) vs `voice-agent` (no websocket at all — the bot's browser
 * container loads the Stage page, which plays its own audio). Deployment
 * config picks the mode; see `InternalRoutesDeps.meetBotDispatch`.
 *
 * ## This is the door the bot actually walks through (#221)
 *
 * #217 put a fire-time consent gate on the *dispatch* endpoint
 * (routes/internal.ts). That was necessary and not sufficient, because
 * dispatch is not the moment audio plays — **this** is. And the gap
 * between the two is controlled by a third party: Attendee decides when it
 * opens this websocket, and re-opens it freely for the bot's whole
 * session. A revoke landing anywhere in that window used to result in the
 * devotional playing aloud in the user's meeting anyway, with #217 merged
 * and green. Until this handler gated, the sentence "no bot speaks after
 * you revoke" (docs/00_FOUNDATION.md §8, docs/04_DATA_PRIVACY_SECURITY.md
 * §2) was simply not true.
 *
 * So the gate below runs at the top of the handler, on **every** connection
 * rather than once per dispatch, and before a single byte of audio is
 * fetched, decoded, or sent. Ordering is the whole point: everything that
 * could produce sound lives inside the async IIFE at the bottom, and every
 * refusal returns before reaching it.
 *
 * ## Auth: a per-devotional capability, not a global secret
 *
 * Attendee's websocket client cannot be assumed to set custom headers, so
 * the credential rides in the URL path itself. It used to be a single
 * global `MEETBOT_AUDIO_TOKEN` shared across all users and all
 * devotionals — one long-lived secret handed to a third-party vendor,
 * proving only "the caller is Attendee" and nothing about *whose*
 * devotional could be streamed. It is now a per-devotional capability
 * derived from that secret; see
 * services/meetBot/meetBotAudioCapabilityToken.ts for the full rationale.
 *
 * The root secret remains deliberately NOT `INTERNAL_API_TOKEN`
 * (routes/internal.ts), because this URL is sent to a third party
 * (Attendee, as part of the createBot request body). Reusing the
 * admin-scoped INTERNAL_API_TOKEN here would leak a secret that also
 * guards /internal/purge and /internal/trigger-daily-run to an external
 * service — caught by review before this ever ran live. Fail-closed if
 * unset, same pattern as routes/internal.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { AudioStorage } from '../services/audio/audioStorage.js';
import type { DevotionalsRepository } from '../db/repositories/devotionalsRepository.js';
import { decodeMp3ToPcm } from '../services/livekit/decodeMp3ToPcm.js';
import { streamPcm } from '../services/meetBot/meetBotSession.js';
import type { BotAudioChannel } from '../services/meetBot/meetBotSession.js';
import { checkMeetBotConsent } from '../services/meetBot/meetBotConsentGate.js';
import type { MeetBotConsentGateDeps } from '../services/meetBot/meetBotConsentGate.js';
import { verifyMeetBotAudioToken } from '../services/meetBot/meetBotAudioCapabilityToken.js';
import type { AttendeeClient, AttendeeSampleRate } from '../services/meetBot/attendeeClient.js';

/**
 * The durable half of the play-once guard (#221). Narrow structural deps
 * — the two methods, not the whole repository — for the same reason
 * `MeetBotConsentGateDeps` is narrow: it makes this route's data access
 * auditable at a glance (it reads and sets one timestamp, and nothing
 * else) and stops a test fake from satisfying it by accident.
 */
export type MeetBotPlaybackLedger = Pick<
  DevotionalsRepository,
  'hasMeetBotPlayed' | 'markMeetBotPlayed'
>;

export interface MeetBotAudioRoutesDeps {
  audioStorage: AudioStorage;
  /**
   * The ROOT secret (`process.env.MEETBOT_AUDIO_TOKEN` by default) from
   * which each connection's per-devotional capability token is derived —
   * NOT the token that appears in the URL, and not `INTERNAL_API_TOKEN`
   * (see file header). Injectable for tests.
   */
  meetBotAudioSecret?: string;
  /**
   * Consent gate deps (#221). REQUIRED, not optional — the same asymmetry,
   * and the same reasoning, as `InternalRoutesDeps.meetBotDispatch.consentGate`
   * (#217): an optional consent gate would mean a deploy that forgot to
   * wire it streams devotionals into meetings with no consent check at
   * all, which is the exact defect this route is being fixed for. Required
   * turns that from a silent production privacy violation into a `tsc`
   * error.
   */
  consentGate: MeetBotConsentGateDeps;
  /**
   * Durable play-once guard (#221). REQUIRED for the same reason as
   * `consentGate`: a deploy without it would silently regress to the
   * process-local `Set` this replaced, and the symptom — a devotional
   * replaying after a cold start — is one nobody would attribute to a
   * missing dependency.
   */
  playbackLedger: MeetBotPlaybackLedger;
  /**
   * Used to make the bot LEAVE the meeting once the devotional has played
   * once (see the play-once note below). Optional: without it, the bot
   * just stops sending audio and relies on runMeetBotDispatch's session
   * timeout to eventually pull it out.
   */
  attendeeClient?: AttendeeClient;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Process-local FAST PATH in front of the durable guard below — no longer
 * the guard itself (#221).
 *
 * The audio websocket is a PERSISTENT channel Attendee re-establishes for
 * the bot's whole session — closing our end just makes Attendee reconnect,
 * and a naive handler replays the devotional from the beginning (a real
 * loop bug found live 2026-07-09). This Set short-circuits a reconnect
 * that races the leave and lands on this same instance, without paying a
 * database round-trip for the overwhelmingly common case.
 *
 * What it is NOT is a correctness boundary. It is empty after a cold start,
 * on a scaled-out second instance, and after any revision rollout — which
 * is exactly when a reconnect would have replayed the devotional aloud.
 * `devotionals.meetbot_played_at` (migration 1721900000000) is the
 * authoritative record; this is a cache in front of it, and the durable
 * check below runs on every connection this Set does not already answer.
 */
const playedDevotionals = new Set<string>();

class WebSocketBotAudioChannel implements BotAudioChannel {
  constructor(private readonly socket: WebSocket) {}

  async sendChunk(chunkBase64: string, sampleRate: AttendeeSampleRate): Promise<void> {
    this.socket.send(
      JSON.stringify({ trigger: 'realtime_audio.bot_output', data: { chunk: chunkBase64, sample_rate: sampleRate } }),
    );
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function registerMeetBotAudioRoutes(app: FastifyInstance, deps: MeetBotAudioRoutesDeps): void {
  const rootSecret = deps.meetBotAudioSecret ?? process.env.MEETBOT_AUDIO_TOKEN;
  const sleep = deps.sleep ?? realSleep;

  app.get<{ Params: { token: string; devotionalId: string } }>(
    '/meetbot/audio/:token/:devotionalId',
    { websocket: true },
    (socket, req) => {
      const { token, devotionalId } = req.params;

      // Capture the bot id from Attendee's incoming meeting-audio messages
      // (realtime_audio.mixed carries `bot_id`). We don't consume the audio
      // itself — H1 is speak-only (docs/22 §3) — but the bot id is how we
      // ask Attendee to make the bot LEAVE when playback finishes.
      //
      // Registered before the async checks below, not after, because a
      // websocket with no 'message' listener DROPS frames: the consent and
      // playback lookups are two database round-trips during which
      // Attendee is already sending, and a dropped `bot_id` means we never
      // pull the bot out at the end. This listener is purely passive — it
      // reads an id off inbound frames and writes nothing, sends nothing,
      // and persists nothing — so having it attached before consent is
      // confirmed cannot itself produce sound or store anyone's audio.
      let botId: string | undefined;
      socket.on('message', (data: RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as { trigger?: string; bot_id?: string };
          if (msg.bot_id && !botId) botId = msg.bot_id;
          if (msg.trigger && msg.trigger !== 'realtime_audio.bot_output') {
            req.log.info({ trigger: msg.trigger }, 'meetBotAudio: received message from Attendee');
          }
        } catch {
          // Non-JSON frame — ignore.
        }
      });

      // Everything below is inside one async IIFE so the gate can await the
      // database. Nothing in it sends audio until every check has passed;
      // the streaming block is the last thing in the function.
      void (async () => {
        // ── 1. Capability check ───────────────────────────────────────
        //
        // Fail-closed when the root secret is unset, exactly as before:
        // an unconfigured deploy refuses every connection rather than
        // accepting any. Verified against the devotionalId from THIS URL,
        // so a leaked URL cannot be retargeted at another devotional.
        if (!rootSecret || !verifyMeetBotAudioToken(rootSecret, devotionalId, token)) {
          req.log.error({ devotionalId }, 'meetBotAudio: rejected connection with invalid/missing capability token');
          socket.close(1008, 'unauthorized');
          return;
        }

        // ── 2. Consent gate (#221) ────────────────────────────────────
        //
        // The reason this route exists in its current form. Runs on every
        // connection — not once per dispatch — because Attendee, a third
        // party, chooses when to connect, and a revoke can land at any
        // point in the session. See services/meetBot/meetBotConsentGate.ts
        // for why the gate resolves the owner server-side from the
        // devotional id rather than trusting anything on the wire.
        //
        // A repository failure is deliberately NOT caught as a refusal
        // here: `checkMeetBotConsent` throws only when it could not
        // *determine* consent, which is not the same as knowing consent
        // was withdrawn. The catch below turns that into a closed socket
        // with nothing streamed, which is the fail-closed outcome — the
        // distinction that matters in routes/internal.ts (2xx vs retry)
        // has no analogue on a websocket, where the only two outcomes are
        // "speak" and "don't".
        try {
          const decision = await checkMeetBotConsent(deps.consentGate, devotionalId);
          if (!decision.allowed) {
            // Audit trail (docs/04_DATA_PRIVACY_SECURITY.md §2). Opaque
            // internal ids and a fixed enum reason only — never the
            // meeting URL, never an email. `warn` rather than `info` for
            // the same reason as #217: a refusal here is correct behavior,
            // but a *spike* in refusals means something upstream is
            // dispatching bots it shouldn't.
            req.log.warn(
              { devotionalId, userId: decision.userId, reason: decision.reason },
              'meetBotAudio: refused — consent no longer valid at connect time (#221)',
            );
            socket.close(1008, 'consent-revoked');
            return;
          }
        } catch (err) {
          req.log.error(
            { devotionalId, err: err instanceof Error ? err.message : String(err) },
            'meetBotAudio: could not determine consent — refusing (fail-closed, #221)',
          );
          socket.close(1011, 'consent-check-failed');
          return;
        }

        // ── 3. Play once, durably (#221) ──────────────────────────────
        //
        // If this devotional has already finished playing, a reconnect
        // must NOT replay it — close without streaming so the bot goes
        // quiet rather than looping. The in-memory Set answers the common
        // same-instance reconnect for free; the database answers the case
        // that actually used to break, where the reconnect lands on an
        // instance that has never heard of this devotional (cold start,
        // scale-out, rollout).
        //
        // A ledger failure refuses rather than replays, on the same
        // asymmetry as the consent gate: not knowing whether we already
        // spoke is not permission to speak again.
        let alreadyPlayed: boolean;
        try {
          alreadyPlayed = playedDevotionals.has(devotionalId) || (await deps.playbackLedger.hasMeetBotPlayed(devotionalId));
        } catch (err) {
          req.log.error(
            { devotionalId, err: err instanceof Error ? err.message : String(err) },
            'meetBotAudio: could not determine playback state — refusing (fail-closed, #221)',
          );
          socket.close(1011, 'playback-check-failed');
          return;
        }
        if (alreadyPlayed) {
          req.log.info({ devotionalId }, 'meetBotAudio: reconnect after playback already finished — not replaying');
          socket.close(1000, 'already-played');
          return;
        }

        // ── 4. Only now may audio exist ───────────────────────────────
        req.log.info({ devotionalId }, 'meetBotAudio: connection accepted, starting playback');

        const sampleRate: AttendeeSampleRate = 16000;
        const channel = new WebSocketBotAudioChannel(socket);

        try {
          const { url } = await deps.audioStorage.getSignedUrl(devotionalId);
          const response = await fetch(url);
          if (!response.ok) throw new Error(`fetch devotional audio failed: HTTP ${response.status}`);
          const mp3 = Buffer.from(await response.arrayBuffer());

          const pcm = await decodeMp3ToPcm(mp3, { sampleRate });
          req.log.info({ devotionalId, pcmBytes: pcm.length }, 'meetBotAudio: decoded, streaming now');
          await streamPcm(channel, pcm, sampleRate, 100, sleep);

          // Mark BEFORE leaving so a reconnect racing the leave is caught
          // by the guard above rather than starting a fresh playback. The
          // durable write goes first and the in-memory Set second: if the
          // write throws we want the error to propagate to the catch below
          // rather than leave this instance believing it recorded
          // something it did not.
          await deps.playbackLedger.markMeetBotPlayed(devotionalId);
          playedDevotionals.add(devotionalId);
          req.log.info({ devotionalId, botId }, 'meetBotAudio: finished streaming — leaving the meeting');

          // Stop at the end: pull the bot out of the meeting so it doesn't
          // sit there while Attendee reconnects the audio channel. Without
          // this the bot would loop the devotional until runMeetBotDispatch's
          // session timeout (docs/22 §3, loop bug found live 2026-07-09).
          if (botId && deps.attendeeClient) {
            try {
              await deps.attendeeClient.requestLeave(botId);
            } catch (err) {
              req.log.error({ devotionalId, botId, err: err instanceof Error ? err.message : String(err) }, 'meetBotAudio: requestLeave after playback failed');
            }
          }
        } catch (err) {
          req.log.error({ devotionalId, err: err instanceof Error ? err.message : String(err) }, 'meetBotAudio: streaming failed');
        } finally {
          socket.close(1000, 'done');
        }
      })();
    },
  );
}
