/**
 * DeliveryProvider — how a generated devotional's "join link" is delivered
 * (docs/22_EPIC_H_PLAN.md §2.1, D4/issue #32).
 *
 * docs/02_ARCHITECTURE.md §5 deliberately deferred formalizing this
 * interface until a second implementation existed ("extracting an
 * interface for a single implementation ahead of that would be
 * speculative abstraction with no second caller to validate its shape").
 * `LiveKitRoomProvider` is that second implementation; `HostedSessionProvider`
 * is the extracted (behavior-identical) default.
 *
 * `HostedSessionProvider` is also the PERMANENT FALLBACK (DEC-K3) — every
 * `DeliveryPreparation.fallbackUrl` must always be a working plain-audio
 * session page, regardless of which provider is primary. The demo/join
 * experience must never depend on a stretch delivery mechanism.
 */
export interface DeliveryPreparation {
  /** Primary "Join your devotional" link — what goes first in the calendar event description / returned to the caller. */
  joinUrl: string;
  /**
   * The plain-audio session page — identical to `joinUrl` for
   * `HostedSessionProvider`; a distinct always-on accessibility/fallback
   * surface for any richer provider (DEC-K3).
   */
  fallbackUrl: string;
}

export interface DeliveryProvider {
  readonly kind: 'hosted' | 'livekit' | 'meetbot';
  /**
   * Pure URL construction — no network calls, no side effects. Real
   * providers (e.g. LiveKit) must NOT create external resources here;
   * anything live-provisioned happens lazily at actual join time (see
   * `liveKitRoomProvider.ts`'s header comment for why).
   */
  prepareDelivery(params: { sessionToken: string }): DeliveryPreparation;
}
