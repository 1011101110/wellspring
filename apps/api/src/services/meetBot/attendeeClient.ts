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
 * ⚠️ Must-confirm (docs/00_FOUNDATION.md §11): everything below is built
 * from Attendee's documentation, not exercised against a live account —
 * no attendee.dev account exists yet (tracked in issue #129, the H1a
 * spike). In particular:
 *   - `requestLeave`'s endpoint path is NOT documented anywhere found;
 *     `/api/v1/bots/{bot_id}/leave` follows the same
 *     `/bots/{bot_id}/<action>` shape as the one confirmed action
 *     endpoint (`delete_data`), but must be verified live before this
 *     path is trusted — until then, callers should treat `requestLeave`
 *     as best-effort (the bot will also leave on its own once the
 *     meeting ends or on a Fatal Error transition).
 *   - Meet-specific admission/lobby behavior (the "Waiting Room" state)
 *     has not been observed live.
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
   */
  audioWebsocketUrl?: string;
  sampleRate?: AttendeeSampleRate;
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
