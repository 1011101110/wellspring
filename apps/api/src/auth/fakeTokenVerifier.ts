import { SignJWT, jwtVerify, generateKeyPair, type CryptoKey } from 'jose';
import { TokenVerificationError, type TokenVerifier, type VerifiedTokenClaims } from './tokenVerifier.js';

const ALG = 'RS256';
const ISSUER = 'kairos-fake-issuer';
const AUDIENCE = 'kairos-fake-audience';

/**
 * Locally-signed-JWT verifier for tests/dev — no live Firebase project
 * required. Generates its own RS256 keypair (mirrors how Firebase ID
 * tokens are RS256-signed) and verifies tokens minted by
 * `FakeTokenVerifier.mint`, which is the only supported way to produce a
 * token this verifier accepts.
 *
 * This exists purely so the *middleware's* logic (bearer parsing, 401
 * behavior, userId extraction into request context) is fully testable
 * without live infra — it intentionally does not try to emulate every
 * Firebase claim.
 */
export class FakeTokenVerifier implements TokenVerifier {
  private constructor(
    private readonly publicKey: CryptoKey,
    private readonly privateKey: CryptoKey,
  ) {}

  static async create(): Promise<FakeTokenVerifier> {
    const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
    return new FakeTokenVerifier(publicKey, privateKey);
  }

  /** Mints a valid signed token for `userId`, for use in tests/dev only. */
  async mint(userId: string, opts: { email?: string; expiresInSeconds?: number } = {}): Promise<string> {
    const expiresIn = opts.expiresInSeconds ?? 3600;
    return new SignJWT({ email: opts.email })
      .setProtectedHeader({ alg: ALG })
      .setSubject(userId)
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
      .sign(this.privateKey);
  }

  /** Mints a token that is already expired — for the expired-token test case. */
  async mintExpired(userId: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: ALG })
      .setSubject(userId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(this.privateKey);
  }

  async verify(token: string): Promise<VerifiedTokenClaims> {
    if (!token) {
      throw new TokenVerificationError('Missing token', 'missing');
    }
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (!payload.sub) {
        throw new TokenVerificationError('Token missing sub claim', 'malformed');
      }
      return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
    } catch (err) {
      if (err instanceof TokenVerificationError) throw err;
      const code = (err as { code?: string } | undefined)?.code ?? '';
      const reason = code.includes('EXPIRED')
        ? 'expired'
        : code.includes('SIGNATURE') || code.includes('JWS')
          ? 'invalid_signature'
          : 'malformed';
      throw new TokenVerificationError(
        `Fake token verification failed: ${(err as Error).message ?? 'unknown error'}`,
        reason,
      );
    }
  }
}
