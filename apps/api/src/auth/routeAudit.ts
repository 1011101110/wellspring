import type { FastifyInstance, RouteOptions } from 'fastify';
import { requireAuth } from './middleware.js';

/**
 * Default-deny auth invariant (docs/14 §2.3 / issue #80): auth on this API
 * is opt-in per route (`{ preHandler: requireAuth }`), so a route added
 * later that forgets it ships silently public. Rather than trust every
 * future route author to remember, this asserts the invariant at boot
 * time: every `/v1/*` route MUST have `requireAuth` in its preHandler
 * chain unless its exact path is in `allowedPublicV1Routes` — an
 * allowlist that has to be edited (and thus reviewed) for a route to
 * become intentionally public, rather than a route silently missing the
 * option going unnoticed.
 *
 * Fails the whole app's `onReady` (boot) if the invariant is violated —
 * this is meant to be impossible to accidentally ship, not just caught in
 * CI, so a misconfigured deploy crashes at startup rather than serving a
 * public route that was meant to be protected.
 */
export function auditV1RoutesRequireAuth(
  app: FastifyInstance,
  options: { allowedPublicV1Routes?: string[] } = {},
): void {
  const allowlist = new Set(options.allowedPublicV1Routes ?? []);
  const violations: string[] = [];

  app.addHook('onRoute', (routeOptions: RouteOptions) => {
    if (!routeOptions.url.startsWith('/v1/') && routeOptions.url !== '/v1') {
      return;
    }
    if (allowlist.has(routeOptions.url)) {
      return;
    }
    const preHandlers = ([] as unknown[]).concat(routeOptions.preHandler ?? []);
    if (!preHandlers.includes(requireAuth)) {
      const methods = ([] as string[]).concat(routeOptions.method);
      violations.push(`${methods.join(',')} ${routeOptions.url}`);
    }
  });

  app.addHook('onReady', async () => {
    if (violations.length > 0) {
      throw new Error(
        `Default-deny auth violation (issue #80): the following /v1 route(s) are missing ` +
          `{ preHandler: requireAuth } and are not in the explicit public allowlist: ` +
          `${violations.join(', ')}. If a route is intentionally public, add its exact path to ` +
          `allowedPublicV1Routes in app.ts with a comment explaining why.`,
      );
    }
  });
}
