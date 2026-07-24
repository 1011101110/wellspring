import type { DeliveryPreparation, DeliveryProvider } from './deliveryProvider.js';
import { sessionUrlFor } from './sessionUrls.js';

/**
 * The MVP delivery mechanism and permanent fallback (DEC-K3): the plain
 * server-rendered session page (`GET /session/:token`, EPIC D issue #31).
 * `joinUrl` and `fallbackUrl` are identical — there is nothing to fall back
 * FROM. Originally a pure extraction of `GenerateNowOrchestrator`'s prior
 * inline session-URL construction; the URL template itself now lives in
 * sessionUrls.ts (#343) so it cannot drift between providers.
 */
export class HostedSessionProvider implements DeliveryProvider {
  readonly kind = 'hosted' as const;
  private readonly publicBaseUrl: string;

  constructor(publicBaseUrl: string) {
    this.publicBaseUrl = publicBaseUrl;
  }

  prepareDelivery(params: { sessionToken: string }): DeliveryPreparation {
    const url = sessionUrlFor(this.publicBaseUrl, params.sessionToken);
    return { joinUrl: url, fallbackUrl: url };
  }
}
