/**
 * LiveKit configuration — env-var loader, fail-closed (mirrors
 * `buildGoogleOAuthServiceFromEnv` in services/calendar/googleOAuthService.ts).
 * D4/#32, docs/22 §2.1/§2.2.
 *
 * Required env vars:
 *   LIVEKIT_URL         — e.g. wss://kairos-xxxx.livekit.cloud
 *   LIVEKIT_API_KEY      — LiveKit Cloud project API key
 *   LIVEKIT_API_SECRET   — LiveKit Cloud project API secret
 *   PUBLIC_BASE_URL      — already required for calendar OAuth; reused here
 *                          for the room-join page URL
 *
 * Throws at construction time if any required var is missing — callers
 * (index.ts) catch this and skip registering LiveKit routes/provider
 * entirely, exactly like the Google Calendar OAuth boot-skip pattern. A
 * deploy with no LiveKit account configured yet boots and serves normally;
 * `HostedSessionProvider` remains the only active delivery provider.
 */
export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  publicBaseUrl: string;
}

export function buildLiveKitConfigFromEnv(): LiveKitConfig {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;

  if (!url) throw new Error('LIVEKIT_URL is not set');
  if (!apiKey) throw new Error('LIVEKIT_API_KEY is not set');
  if (!apiSecret) throw new Error('LIVEKIT_API_SECRET is not set');
  if (!publicBaseUrl) throw new Error('PUBLIC_BASE_URL is not set');

  return { url, apiKey, apiSecret, publicBaseUrl };
}
