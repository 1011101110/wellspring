import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { asVerifiedUserId, type VerifiedUserId } from '../db/repositories/types.js';
import type { UsersRepository } from '../db/repositories/usersRepository.js';
import { TokenVerificationError, type TokenVerifier } from './tokenVerifier.js';

/**
 * Auth context attached to the request AFTER successful verification.
 * `userId` is a `VerifiedUserId` (branded, per db/repositories/types.ts)
 * so route handlers can pass it straight into a repository call — the
 * type system enforces that it can only have come from
 * `asVerifiedUserId`, which this middleware is the sole caller of on the
 * request path (Foundation §10: "userId from the verified token — never
 * from the request body").
 *
 * Critically (issue #69, docs/14 §1.7), `userId` here is the resolved
 * **`users.id`** (a real UUID, the repository layer's scoping key) — NOT
 * the raw Firebase UID from the token's `sub` claim. Those are different
 * strings; `firebaseUid` (below) carries the raw claim for the rare
 * caller that needs it (none should — it exists for symmetry/debugging).
 */
export interface AuthContext {
  userId: VerifiedUserId;
  firebaseUid: string;
  email?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const BEARER_PREFIX = 'Bearer ';

function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Registers a Fastify `onRequest` hook that verifies the bearer token on
 * every request and, on success, sets `request.auth`. It does NOT reject
 * unauthenticated requests itself — routes opt in via `requireAuth`
 * (below) so public routes (`/status`, `/session/:token`) are
 * unaffected, matching Foundation §10 / Architecture §2.1's short list
 * of public routes.
 *
 * Issue #69 / docs/14 §1.7 fix: verifying the token only proves WHO the
 * caller is (the Firebase UID) — it says nothing about the `users.id`
 * UUID every repository scopes queries by. This hook now takes that one
 * extra step: after a successful `verifier.verify`, it resolves (and, on
 * first sight, provisions) the corresponding `users` row via
 * `UsersRepository.findOrCreateByFirebaseUid`, and `request.auth.userId`
 * is THAT row's `id` — never the raw claim. Every existing call site
 * that read `request.auth.userId` continues to get a `VerifiedUserId`
 * exactly as before; only what backs it has changed (from "trust the
 * claim as a UUID" — which crashed on any real, non-UUID Firebase UID —
 * to "resolve the claim to the real UUID").
 *
 * `usersRepository` is optional so tests that only exercise the
 * middleware's verification control-flow (401 paths, claim extraction)
 * without a database can still build an app — `requireAuth`-gated
 * routes will still need it in practice (every real user-scoped route
 * does), but omitting it here does not eagerly require a DB connection
 * until a request with a valid token actually arrives.
 */
export function registerAuth(
  app: FastifyInstance,
  verifier: TokenVerifier,
  usersRepository?: UsersRepository,
): void {
  app.decorateRequest('auth', undefined);

  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = extractBearerToken(request);
    if (!token) {
      return; // no token presented; requireAuth (if used) will 401
    }
    try {
      const claims = await verifier.verify(token);
      if (!usersRepository) {
        // No DB wired (middleware-only test context) — cannot resolve a
        // users.id, so treat this the same as any other verification
        // failure: leave request.auth unset, requireAuth (if used) 401s.
        return;
      }
      const user = await usersRepository.findOrCreateByFirebaseUid(claims.userId, claims.email);
      request.auth = {
        userId: asVerifiedUserId(user.id),
        firebaseUid: claims.userId,
        email: claims.email,
      };
    } catch (err) {
      // Leave request.auth unset — requireAuth will 401. We deliberately
      // do not distinguish reasons to the client (Foundation §10: don't
      // leak verifier internals), but we DO log server-side (issue #80) —
      // a run of these against one IP/route is exactly what a
      // brute-force/token-guessing attempt looks like, and until now it
      // left literally no trace to alert on.
      request.log.warn({ err }, 'bearer token verification failed');
    }
  });
}

/**
 * Fastify `preHandler` for protected routes: 401s any request without a
 * successfully verified `request.auth`. Use as:
 *   app.get('/v1/whatever', { preHandler: requireAuth }, handler)
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.auth) {
    await reply.status(401).send({
      ok: false,
      error: { code: 'AUTH_FAILED', message: 'Missing or invalid authentication token', retryable: false },
    });
  }
}

export { TokenVerificationError };
export type { TokenVerifier };
