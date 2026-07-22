import type { DeliveryPreparation, DeliveryProvider } from './deliveryProvider.js';

/**
 * H1 (#53) delivery provider — Epic H's Attendee/Google-Meet join-and-speak
 * capability. Unlike `LiveKitRoomProvider`, the real join link (a Google
 * Meet URL) does NOT exist at `prepareDelivery()` time — it's only known
 * once `GenerateNowOrchestrator.runCalendarStep()` actually calls
 * `insertEvent({ requestConferenceData: true })` and gets a `meetUri`
 * back, which happens *after* `prepareDelivery()` runs. So `joinUrl` and
 * `fallbackUrl` here are byte-identical to `HostedSessionProvider` — this
 * provider's only real job is to be a **discriminator**
 * (`deliveryProvider.kind === 'meetbot'`) the calendar step checks to
 * decide whether to request conferenceData and schedule a bot dispatch.
 * The permanent DEC-K3 fallback (a working plain-audio session page) is
 * never at risk regardless of what happens with the Meet/bot path.
 */
export class MeetBotProvider implements DeliveryProvider {
  readonly kind = 'meetbot' as const;
  private readonly publicBaseUrl: string;

  constructor(publicBaseUrl: string) {
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  prepareDelivery(params: { sessionToken: string }): DeliveryPreparation {
    const url = `${this.publicBaseUrl}/session/${params.sessionToken}`;
    return { joinUrl: url, fallbackUrl: url };
  }
}
