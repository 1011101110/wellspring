import { getApps, initializeApp, type App, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { TokenVerificationError, type TokenVerifier, type VerifiedTokenClaims } from './tokenVerifier.js';

/**
 * Real Firebase ID-token verifier, wired against firebase-admin.
 *
 * ⚠️ NOT LIVE-TESTED. There is no live Firebase project yet — Firebase
 * project creation is bundled with GCP provisioning (issue #11), which
 * is blocked pending human authorization to run mutating `gcloud`/
 * `firebase` commands (see docs/00_FOUNDATION.md §10, issue #11).
 *
 * TODO(#11-class blocker): once `FIREBASE_SERVICE_ACCOUNT` exists as a
 * real service-account JSON (Secret Manager, per
 * docs/06_DEPLOYMENT_CI_CD.md), and the iOS app can mint real ID tokens
 * via Sign in with Apple / email link, run a smoke test that:
 *   1. Signs in a real (or Firebase Auth emulator) test user.
 *   2. Sends its ID token to a protected route.
 *   3. Confirms `verifyIdToken` succeeds and `userId` matches the
 *      Firebase UID.
 * Until then this class is exercised only by construction-time/shape
 * tests — never by a real `verify()` call in CI.
 */
export class FirebaseTokenVerifier implements TokenVerifier {
  private readonly app: App;

  constructor(serviceAccountJson?: string) {
    const existing = getApps();
    if (existing.length > 0) {
      this.app = existing[0]!;
      return;
    }

    // FIREBASE_SERVICE_ACCOUNT holds the Admin SDK service-account JSON
    // (docs/06_DEPLOYMENT_CI_CD.md §Secrets). Falls back to Application
    // Default Credentials if unset, matching firebase-admin's normal
    // Cloud Run behavior — but on Cloud Run today there is no Firebase
    // project bound, so this path is untested (see class doc above).
    const raw = serviceAccountJson ?? process.env.FIREBASE_SERVICE_ACCOUNT;
    this.app = raw
      ? initializeApp({ credential: cert(JSON.parse(raw)) })
      : initializeApp();
  }

  async verify(token: string): Promise<VerifiedTokenClaims> {
    if (!token) {
      throw new TokenVerificationError('Missing token', 'missing');
    }
    try {
      const decoded = await getAuth(this.app).verifyIdToken(token);
      return { userId: decoded.uid, email: decoded.email };
    } catch (err) {
      // firebase-admin throws FirebaseAuthError with codes like
      // 'auth/id-token-expired', 'auth/argument-error', etc. We collapse
      // all of them to a generic 401 — never leak verifier internals to
      // the client (Foundation §10).
      const code = (err as { code?: string } | undefined)?.code ?? '';
      const reason = code.includes('expired')
        ? 'expired'
        : code.includes('argument') || code.includes('invalid')
          ? 'malformed'
          : 'other';
      throw new TokenVerificationError(
        `Firebase ID token verification failed: ${(err as Error).message ?? 'unknown error'}`,
        reason,
      );
    }
  }
}
