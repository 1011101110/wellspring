/**
 * Client for the Attendee (attendee.dev, ELv2) meeting-bot API — H1 (#53),
 * docs/22_EPIC_H_PLAN.md §3.
 *
 * Bot-creation shape, state names, and the realtime-audio websocket
 * message envelope below are taken from Attendee's own published docs
 * (docs.attendee.dev's "Realtime Audio Input and Output" guide and the
 * attendee-labs/voice-agent-example reference implementation) — not
 * guessed. Sample rate is constrained to Attendee's three supported
 * values (8000 | 16000 | 24000), distinct from the 48kHz LiveKit uses
 * (D4/#32) — decodeMp3ToPcm.ts now takes an options.sampleRate override
 * for exactly this reason.
 *
 * ⚠️ Must-confirm status (docs/00_FOUNDATION.md §11), updated with the
 * live findings of the H1a spike (2026-07-07, issue #129) and the Q4
 * voice-agent spike (2026-07-23, kairos-devotional#334):
 *   - `requestLeave`'s endpoint path is NOT documented anywhere found;
 *     `/api/v1/bots/{bot_id}/leave` follows the same
 *     `/bots/{bot_id}/<action>` shape as the one confirmed action
 *     endpoint (`delete_data`) — callers should treat `requestLeave`
 *     as best-effort (the bot will also leave on its own once the
 *     meeting ends or on a Fatal Error transition). Q4 live data point:
 *     `leave` on a `fatal_error` bot returns HTTP 400 (not 404), so this
 *     method throws there; `safeLeave` (meetBotSession.ts) catches it and
 *     still runs `delete_data`, which succeeds regardless.
 *   - Meet-specific admission/lobby behavior for a VOICE-AGENT bot has
 *     not been observed live (needs a host present to admit — owner
 *     runbook in kairos-devotional#334).
 *
 * ✅ Confirmed live 2026-07-23 (Q4 spike, kairos-devotional#334 — full
 * request/response transcripts there):
 *   - `voice_agent_settings` is accepted on our app.attendee.dev account
 *     (`ENABLE_VOICE_AGENTS` is on server-side). Shape: nested
 *     `voice_agent_settings: { url }` OR `{ screenshare_url }` —
 *     `screenshare_url` lives INSIDE `voice_agent_settings`, not
 *     top-level, and the two are MUTUALLY EXCLUSIVE (sending both →
 *     HTTP 400 "You cannot provide both url and screenshare_url"). The
 *     schema is strict (`additionalProperties: false` — unknown keys are
 *     rejected with a 400). URLs must be https://. The server auto-sets
 *     `reserve_resources: true` when either URL is present.
 *   - The container does NOT pre-fetch the voice-agent page: a bot that
 *     failed to join (`could_not_join_meeting`) never requested the page
 *     URL at all, so a failed dispatch cannot leak the page URL.
 *   - `recording_settings: {format:'none'}` and `delete_data` behave
 *     identically for a voice-agent bot (201 with
 *     `recording_state: "not_started"`; `delete_data` → `data_deleted`).
 *
 * ⚠️ Known privacy gap, confirmed 2026-07-07 against Attendee's own
 * source (bots/serializers.py): recording defaults ON unless explicitly
 * disabled (`recording_settings.format: "none"`, applied below,
 * hardcoded) — but **transcription cannot be fully disabled for Google
 * Meet bots**. `transcription_settings` unconditionally defaults to
 * `{"meeting_closed_captions": {}}` when omitted for Google Meet, with
 * no documented `"none"`/off value and no top-level disable flag. This
 * conflicts with docs/22 §3's "transcription stays off" requirement and
 * is a real go/no-go finding for H1a, not yet resolved — see docs/22 §3
 * for the decision record once the owner weighs in.
 */

export const ATTENDEE_SAMPLE_RATES = [8000, 16000, 24000] as const;
export type AttendeeSampleRate = (typeof ATTENDEE_SAMPLE_RATES)[number];

/**
 * Bot lifecycle states, as named in docs.attendee.dev's bot-basics guide.
 * We only branch on a subset (see meetBotSession.ts); the rest are
 * recorded here for completeness/future use.
 */
export type AttendeeBotState =
  | 'ready'
  | 'joining'
  | 'joined_not_recording'
  | 'joined_recording'
  | 'joined_recording_paused'
  | 'joined_recording_permission_denied'
  | 'waiting_room'
  | 'joining_breakout_room'
  | 'leaving_breakout_room'
  | 'leaving'
  | 'post_processing'
  | 'ended'
  | 'fatal_error'
  | 'data_deleted'
  | 'scheduled'
  | 'staged';

export interface CreateBotParams {
  meetingUrl: string;
  botName: string;
  /**
   * Publicly reachable wss:// URL Attendee's service will connect out to
   * for bidirectional audio. Omit for a join-only bot (no speaking) —
   * e.g. an admission-behavior spike before the audio pipeline is wired.
   * Websocket-PCM mode — mutually exclusive with the voice-agent fields
   * below (see `assertCreateBotModeExclusive`).
   */
  audioWebsocketUrl?: string;
  sampleRate?: AttendeeSampleRate;
  /**
   * Voice-agent mode (Epic Q, kairos-devotional#330/#335): a publicly
   * reachable https:// page Attendee's container loads; its video shows
   * as the bot's webcam tile and its audio plays into the call. Maps to
   * `voice_agent_settings: { url }` — shape confirmed live in the Q4
   * spike (see file header).
   */
  voiceAgentUrl?: string;
  /**
   * Same as `voiceAgentUrl` but the page's video is presented via
   * screenshare (main-stage treatment) instead of the webcam tile. Maps
   * to `voice_agent_settings: { screenshare_url }`. Q4 live finding:
   * Attendee REJECTS a bot with both `url` and `screenshare_url`, so
   * this and `voiceAgentUrl` are mutually exclusive — there is never a
   * second page instance, and no double-audio risk.
   */
  screenshareUrl?: string;
}

/**
 * Mode exclusivity at the client boundary (#335 acceptance criteria):
 *  - websocket-PCM mode (`audioWebsocketUrl`) and voice-agent mode
 *    (`voiceAgentUrl`/`screenshareUrl`) are exclusive by design — one bot
 *    speaks through exactly one mechanism;
 *  - `voiceAgentUrl` and `screenshareUrl` are exclusive because Attendee
 *    rejects both together (Q4 live finding, kairos-devotional#334) —
 *    throwing here surfaces the mistake before a bot-creation round-trip.
 * Called by BOTH the real client and `FakeAttendeeClient`, so unit tests
 * exercise the same boundary production hits.
 */
export function assertCreateBotModeExclusive(params: CreateBotParams): void {
  if (params.audioWebsocketUrl && (params.voiceAgentUrl || params.screenshareUrl)) {
    throw new Error(
      'createBot: audioWebsocketUrl (websocket-PCM mode) and voiceAgentUrl/screenshareUrl (voice-agent mode) are mutually exclusive',
    );
  }
  if (params.voiceAgentUrl && params.screenshareUrl) {
    throw new Error(
      'createBot: voiceAgentUrl and screenshareUrl are mutually exclusive — Attendee rejects a bot with both (Q4 live finding, kairos-devotional#334)',
    );
  }
}

export interface CreateBotResult {
  botId: string;
}

export interface BotStatus {
  botId: string;
  state: AttendeeBotState;
}

export interface AttendeeClient {
  createBot(params: CreateBotParams): Promise<CreateBotResult>;
  getBotStatus(botId: string): Promise<BotStatus>;
  /** Best-effort — see ⚠️ Must-confirm above. */
  requestLeave(botId: string): Promise<void>;
  /**
   * Privacy defense-in-depth (docs/22 §3 "Privacy"): purges any bot-side
   * data even though recording/transcription are never enabled by us.
   * Confirmed endpoint: POST /api/v1/bots/{bot_id}/delete_data.
   */
  deleteData(botId: string): Promise<void>;
}

const ATTENDEE_API_BASE = 'https://app.attendee.dev/api/v1';

/**
 * Real HTTP implementation. Never constructed by tests — see
 * `FakeAttendeeClient` in `fakeAttendeeClient.ts` for the test double
 * `MeetBotSession` is exercised against until H1a's live spike lands.
 */
export class HttpAttendeeClient implements AttendeeClient {
  constructor(private readonly apiKey: string) {}

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Token ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async createBot(params: CreateBotParams): Promise<CreateBotResult> {
    assertCreateBotModeExclusive(params);
    const body: Record<string, unknown> = {
      meeting_url: params.meetingUrl,
      bot_name: params.botName,
      // Privacy invariant (docs/22 §3, non-negotiable): recording is NEVER
      // requested. Confirmed via Attendee's own source
      // (bots/serializers.py) that recording_settings defaults to ON
      // (MP4) if omitted — "format": "none" is the confirmed, real way to
      // disable it. This is hardcoded, not caller-configurable.
      recording_settings: { format: 'none' },
    };

    if (params.audioWebsocketUrl) {
      body['websocket_settings'] = {
        audio: {
          url: params.audioWebsocketUrl,
          sample_rate: params.sampleRate ?? 16000,
        },
      };
    }

    // Voice-agent mode (Epic Q). Payload shape confirmed live 2026-07-23
    // (Q4 spike — see file header): nested under voice_agent_settings,
    // exactly one of url/screenshare_url, never alongside
    // websocket_settings (both enforced above).
    if (params.voiceAgentUrl) {
      body['voice_agent_settings'] = { url: params.voiceAgentUrl };
    } else if (params.screenshareUrl) {
      body['voice_agent_settings'] = { screenshare_url: params.screenshareUrl };
    }

    const response = await fetch(`${ATTENDEE_API_BASE}/bots`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Attendee createBot failed: HTTP ${response.status} — ${text}`);
    }

    const data = (await response.json()) as { id?: string };
    if (!data.id) throw new Error('Attendee createBot: response missing bot id');
    return { botId: data.id };
  }

  async getBotStatus(botId: string): Promise<BotStatus> {
    const response = await fetch(`${ATTENDEE_API_BASE}/bots/${encodeURIComponent(botId)}`, {
      headers: this.authHeaders(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Attendee getBotStatus failed: HTTP ${response.status} — ${text}`);
    }

    const data = (await response.json()) as { state?: string };
    if (!data.state) throw new Error('Attendee getBotStatus: response missing state');
    return { botId, state: data.state as AttendeeBotState };
  }

  async requestLeave(botId: string): Promise<void> {
    const response = await fetch(`${ATTENDEE_API_BASE}/bots/${encodeURIComponent(botId)}/leave`, {
      method: 'POST',
      headers: this.authHeaders(),
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Attendee requestLeave failed: HTTP ${response.status} — ${text}`);
    }
  }

  async deleteData(botId: string): Promise<void> {
    const response = await fetch(
      `${ATTENDEE_API_BASE}/bots/${encodeURIComponent(botId)}/delete_data`,
      { method: 'POST', headers: this.authHeaders() },
    );

    if (!response.ok && response.status !== 404) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Attendee deleteData failed: HTTP ${response.status} — ${text}`);
    }
  }
}
