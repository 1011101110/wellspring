import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFileAudioStorage, audioObjectKey } from '../../../src/services/audio/audioStorage.js';

describe('LocalFileAudioStorage', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'kairos-audio-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('rejects a signing secret that is too short', () => {
    expect(() => new LocalFileAudioStorage({ rootDir, signingSecret: 'short' })).toThrow();
  });

  it('audioObjectKey uses the canonical devotionals/{id}.mp3 layout', () => {
    expect(audioObjectKey('abc-123')).toBe('devotionals/abc-123.mp3');
  });

  describe('upload + exists', () => {
    it('writes the file and exists() reflects it', async () => {
      const storage = new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });
      expect(await storage.exists('dev-1')).toBe(false);

      const audio = Buffer.from('fake mp3 bytes');
      const ref = await storage.upload('dev-1', audio);

      expect(ref.objectKey).toBe('devotionals/dev-1.mp3');
      expect(await storage.exists('dev-1')).toBe(true);
    });

    it('does not leak into a different devotional id', async () => {
      const storage = new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });
      await storage.upload('dev-1', Buffer.from('content-1'));
      expect(await storage.exists('dev-2')).toBe(false);
    });
  });

  describe('signed-URL-style token: minting + verification', () => {
    it('mints a token that is valid within the expiry window', async () => {
      const currentTime = new Date('2026-07-02T12:00:00Z');
      const storage = new LocalFileAudioStorage({
        rootDir,
        signingSecret: 'a'.repeat(32),
        now: () => currentTime,
      });
      await storage.upload('dev-1', Buffer.from('audio'));

      const { url, expiresAt } = await storage.getSignedUrl('dev-1', { expirySeconds: 900 });
      expect(expiresAt.getTime()).toBe(currentTime.getTime() + 900_000);

      const token = decodeURIComponent(url.split('/audio/')[1]!);
      const verification = storage.verifyToken(token, audioObjectKey('dev-1'));
      expect(verification.valid).toBe(true);
    });

    it('rejects the token once the expiry window has passed', async () => {
      let currentTime = new Date('2026-07-02T12:00:00Z');
      const storage = new LocalFileAudioStorage({
        rootDir,
        signingSecret: 'a'.repeat(32),
        now: () => currentTime,
      });
      await storage.upload('dev-1', Buffer.from('audio'));

      const { url } = await storage.getSignedUrl('dev-1', { expirySeconds: 900 }); // 15 min
      const token = decodeURIComponent(url.split('/audio/')[1]!);

      // Still valid 1 second before expiry.
      currentTime = new Date(currentTime.getTime() + 899_000);
      expect(storage.verifyToken(token).valid).toBe(true);

      // Expired at/after the exact expiry instant.
      currentTime = new Date(new Date('2026-07-02T12:00:00Z').getTime() + 900_000);
      const afterExpiry = storage.verifyToken(token);
      expect(afterExpiry.valid).toBe(false);
      if (!afterExpiry.valid) expect(afterExpiry.reason).toBe('expired');
    });

    it('rejects a token scoped to a different object (cross-devotional reuse)', async () => {
      const storage = new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });
      await storage.upload('dev-1', Buffer.from('audio-1'));
      await storage.upload('dev-2', Buffer.from('audio-2'));

      const { url } = await storage.getSignedUrl('dev-1', { expirySeconds: 900 });
      const tokenForDev1 = decodeURIComponent(url.split('/audio/')[1]!);

      // Valid for the object it was minted for...
      expect(storage.verifyToken(tokenForDev1, audioObjectKey('dev-1')).valid).toBe(true);
      // ...but rejected when checked against a different object key.
      const wrongObject = storage.verifyToken(tokenForDev1, audioObjectKey('dev-2'));
      expect(wrongObject.valid).toBe(false);
      if (!wrongObject.valid) expect(wrongObject.reason).toBe('wrong_object');
    });

    it('readForToken serves the correct bytes for a valid token', async () => {
      const storage = new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });
      const original = Buffer.from('real audio payload');
      await storage.upload('dev-1', original);

      const { url } = await storage.getSignedUrl('dev-1');
      const token = decodeURIComponent(url.split('/audio/')[1]!);

      const bytes = await storage.readForToken(token);
      expect(bytes.equals(original)).toBe(true);
    });

    it('readForToken throws for an expired token', async () => {
      let currentTime = new Date('2026-07-02T12:00:00Z');
      const storage = new LocalFileAudioStorage({
        rootDir,
        signingSecret: 'a'.repeat(32),
        now: () => currentTime,
      });
      await storage.upload('dev-1', Buffer.from('audio'));

      const { url } = await storage.getSignedUrl('dev-1', { expirySeconds: 60 });
      const token = decodeURIComponent(url.split('/audio/')[1]!);

      currentTime = new Date(currentTime.getTime() + 61_000);
      await expect(storage.readForToken(token)).rejects.toThrow(/Invalid or expired/);
    });

    it('rejects a token that has been tampered with (payload swapped, signature unchanged)', async () => {
      const storage = new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });
      await storage.upload('dev-1', Buffer.from('audio-1'));
      await storage.upload('dev-2', Buffer.from('audio-2'));

      const { url: url1 } = await storage.getSignedUrl('dev-1');
      const { url: url2 } = await storage.getSignedUrl('dev-2');
      const token1 = decodeURIComponent(url1.split('/audio/')[1]!);
      const token2 = decodeURIComponent(url2.split('/audio/')[1]!);

      // Splice dev-2's payload onto dev-1's signature — should fail signature check.
      const forged = `${token2.split('.')[0]}.${token1.split('.')[1]}`;
      const result = storage.verifyToken(forged);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe('bad_signature');
    });

    it('rejects a malformed token (no signature separator)', () => {
      const storage = new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });
      const result = storage.verifyToken('not-a-real-token');
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe('malformed');
    });

    it('rejects a token signed with a different secret', async () => {
      const storageA = new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });
      const storageB = new LocalFileAudioStorage({ rootDir, signingSecret: 'b'.repeat(32) });
      await storageA.upload('dev-1', Buffer.from('audio'));

      const { url } = await storageA.getSignedUrl('dev-1');
      const token = decodeURIComponent(url.split('/audio/')[1]!);

      // storageB uses a different HMAC key, so it must not accept storageA's token.
      const result = storageB.verifyToken(token);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe('bad_signature');
    });

    it('defaults to a 15-minute expiry per API spec §6', async () => {
      const currentTime = new Date('2026-07-02T12:00:00Z');
      const storage = new LocalFileAudioStorage({
        rootDir,
        signingSecret: 'a'.repeat(32),
        now: () => currentTime,
      });
      await storage.upload('dev-1', Buffer.from('audio'));

      const { expiresAt } = await storage.getSignedUrl('dev-1');
      expect(expiresAt.getTime() - currentTime.getTime()).toBe(15 * 60 * 1000);
    });

    it('mints distinct tokens on repeated calls for the same object (nonce)', async () => {
      const storage = new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });
      await storage.upload('dev-1', Buffer.from('audio'));
      const { url: urlA } = await storage.getSignedUrl('dev-1');
      const { url: urlB } = await storage.getSignedUrl('dev-1');
      expect(urlA).not.toBe(urlB);
    });
  });
});
