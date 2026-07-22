import type { DeliveryPreparation, DeliveryProvider } from './deliveryProvider.js';

/**
 * The MVP delivery mechanism and permanent fallback (DEC-K3): the plain
 * server-rendered session page (`GET /session/:token`, EPIC D issue #31).
 * `joinUrl` and `fallbackUrl` are identical — there is nothing to fall back
 * FROM. This is a pure extraction of `GenerateNowOrchestrator`'s prior
 * inline `${publicBaseUrl}/session/${token}` construction; behavior is
 * byte-identical to before the `DeliveryProvider` interface existed.
 */
export class HostedSessionProvider implements DeliveryProvider {
  readonly kind = 'hosted' as const;
  private readonly publicBaseUrl: string;

  constructor(publicBaseUrl: string) {
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  prepareDelivery(params: { sessionToken: string }): DeliveryPreparation {
    const url = `${this.publicBaseUrl}/session/${params.sessionToken}`;
    return { joinUrl: url, fallbackUrl: url };
  }
}
