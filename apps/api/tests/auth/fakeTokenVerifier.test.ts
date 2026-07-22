import { describe, expect, it } from 'vitest';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { TokenVerificationError } from '../../src/auth/tokenVerifier.js';

describe('FakeTokenVerifier', () => {
  it('verifies a token it minted and returns the subject as userId', async () => {
    const verifier = await FakeTokenVerifier.create();
    const token = await verifier.mint('some-user-id', { email: 'a@b.com' });
    const claims = await verifier.verify(token);
    expect(claims.userId).toBe('some-user-id');
    expect(claims.email).toBe('a@b.com');
  });

  it('omits email when not provided at mint time', async () => {
    const verifier = await FakeTokenVerifier.create();
    const token = await verifier.mint('some-user-id');
    const claims = await verifier.verify(token);
    expect(claims.email).toBeUndefined();
  });

  it('rejects an empty token with a "missing" reason', async () => {
    const verifier = await FakeTokenVerifier.create();
    await expect(verifier.verify('')).rejects.toBeInstanceOf(TokenVerificationError);
    try {
      await verifier.verify('');
      expect.unreachable();
    } catch (err) {
      expect((err as TokenVerificationError).reason).toBe('missing');
    }
  });

  it('rejects an expired token with an "expired" reason', async () => {
    const verifier = await FakeTokenVerifier.create();
    const token = await verifier.mintExpired('some-user-id');
    try {
      await verifier.verify(token);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TokenVerificationError);
      expect((err as TokenVerificationError).reason).toBe('expired');
    }
  });

  it('rejects a token from a different keypair', async () => {
    const verifierA = await FakeTokenVerifier.create();
    const verifierB = await FakeTokenVerifier.create();
    const token = await verifierA.mint('some-user-id');
    await expect(verifierB.verify(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });
});
