import type { DeliveryPreparation, DeliveryProvider } from './deliveryProvider.js';

/**
 * Stretch delivery provider (D4/#32, docs/22 §2.1): the join link points at
 * `/room/:token` (routes/room.ts) — a page that connects to a LiveKit room
 * where an agent publishes the devotional's TTS audio (routes/livekitWebhook.ts).
 * The plain session page stays the `fallbackUrl` (DEC-K3 permanent fallback
 * + accessibility surface) — always present, never removed, regardless of
 * whether LiveKit is reachable.
 *
 * No LiveKit API call happens here (see liveKitRoomNaming.ts header) — this
 * is pure URL construction, identical in cost/risk to HostedSessionProvider.
 */
export class LiveKitRoomProvider implements DeliveryProvider {
  readonly kind = 'livekit' as const;
  private readonly publicBaseUrl: string;

  constructor(publicBaseUrl: string) {
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  prepareDelivery(params: { sessionToken: string }): DeliveryPreparation {
    // The LiveKit room name (see liveKitRoomNaming.ts) is re-derived from
    // the token by routes/room.ts and the webhook handler — not embedded
    // in this URL — keeping one source of truth for the mapping.
    return {
      joinUrl: `${this.publicBaseUrl}/room/${params.sessionToken}`,
      fallbackUrl: `${this.publicBaseUrl}/session/${params.sessionToken}`,
    };
  }
}
