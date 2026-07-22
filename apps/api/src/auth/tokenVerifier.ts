/**
 * TokenVerifier — the one interface the Fastify auth middleware depends
 * on. Foundation §10: "API endpoints require auth (Firebase Auth JWT or
 * equivalent)"; Foundation §8/§10 + issue #14: `userId` must come ONLY
 * from a verified token's claims, never from a request body/header.
 *
 * Two implementations:
 *  - `FirebaseTokenVerifier` — wraps firebase-admin's `verifyIdToken`.
 *    Wired but NOT live-tested: there is no live Firebase project yet
 *    (same class of blocker as GCP IAM provisioning in issue #11 — see
 *    docs/00_FOUNDATION.md §10 and docs/10_CREDENTIALS_ACCESS.md row 6).
 *    TODO(#11-class blocker): once a real Firebase project exists and
 *    `FIREBASE_SERVICE_ACCOUNT` is provisioned in Secret Manager, smoke
 *    test this against a real ID token minted by the iOS client and
 *    delete this TODO.
 *  - `FakeTokenVerifier` — verifies locally-signed JWTs (via `jose`)
 *    against an in-memory test keypair. Used in tests/dev so the
 *    middleware's control flow (401 on missing/expired/malformed/
 *    tampered tokens, userId extraction on success) is fully covered
 *    without any live infra.
 */

export interface VerifiedTokenClaims {
  /** Firebase UID (or fake-verifier equivalent `sub`) — the ONLY source of userId for downstream code. */
  userId: string;
  /** Present when the token carries a verified email claim; optional because not every verifier guarantees it. */
  email?: string;
}

export class TokenVerificationError extends Error {
  constructor(
    message: string,
    readonly reason: 'missing' | 'malformed' | 'expired' | 'invalid_signature' | 'other',
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

export interface TokenVerifier {
  /**
   * Verifies a raw bearer token string and returns the claims to trust.
   * Must throw `TokenVerificationError` (never return a falsy/partial
   * result) for anything that isn't a valid, current, correctly-signed
   * token — the middleware treats any thrown error as "401".
   */
  verify(token: string): Promise<VerifiedTokenClaims>;
}
