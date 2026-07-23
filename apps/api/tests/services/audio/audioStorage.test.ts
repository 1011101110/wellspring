import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TimingManifest } from '@kairos/shared-contracts';
import {
  GcsAudioStorage,
  LocalFileAudioStorage,
  audioObjectKey,
  manifestObjectKey,
  type GcsClientLike,
  type GcsFileLike,
} from '../../../src/services/audio/audioStorage.js';

/** Fixture manifest reused by the Local and GCS manifest suites below (Q1 #331). */
const SAMPLE_MANIFEST: TimingManifest = [
  { section: 'greeting', startSec: 0, endSec: 1.5, text: 'A moment of peace.' },
  { section: 'scripture', startSec: 1.5, endSec: 5.5, text: 'From Philippians 4:6-7. …' },
  { section: 'stillness', startSec: 5.5, endSec: 21, text: '' },
  { section: 'reflection', startSec: 21, endSec: 30, text: 'A steady word.' },
  { section: 'prayer', startSec: 30, endSec: 34, text: 'Father, thank You. Amen.' },
];

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

/* ------------------------------------------------------------------ *
 * Timing manifest storage — Q1 (kairos-devotional #331).
 * ------------------------------------------------------------------ */

describe('LocalFileAudioStorage — timing manifest (Q1 #331)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'kairos-audio-manifest-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const build = () => new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });

  it('manifestObjectKey lives next to the MP3 key', () => {
    expect(manifestObjectKey('abc-123')).toBe('devotionals/abc-123.mp3.manifest.json');
  });

  it('round-trips a manifest', async () => {
    const storage = build();
    const { objectKey } = await storage.uploadManifest('dev-1', SAMPLE_MANIFEST);
    expect(objectKey).toBe(manifestObjectKey('dev-1'));
    expect(await storage.getManifest('dev-1')).toEqual(SAMPLE_MANIFEST);
  });

  it('returns null for an absent manifest', async () => {
    expect(await build().getManifest('never-uploaded')).toBeNull();
  });

  it('returns null (never throws) for corrupt or schema-invalid JSON', async () => {
    const storage = build();
    const filePath = path.join(rootDir, manifestObjectKey('dev-corrupt'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'not json at all', 'utf8');
    expect(await storage.getManifest('dev-corrupt')).toBeNull();

    await writeFile(filePath, JSON.stringify([{ section: 'nope', startSec: 0 }]), 'utf8');
    expect(await storage.getManifest('dev-corrupt')).toBeNull();
  });

  it('delete removes the manifest along with the audio (retention lifecycle)', async () => {
    const storage = build();
    await storage.upload('dev-1', Buffer.from('audio'));
    await storage.uploadManifest('dev-1', SAMPLE_MANIFEST);
    await storage.delete('dev-1');
    expect(await storage.exists('dev-1')).toBe(false);
    expect(await storage.getManifest('dev-1')).toBeNull();
    // Still idempotent with a manifest-less devotional.
    await expect(storage.delete('dev-1')).resolves.toBeUndefined();
  });
});

describe('GcsAudioStorage — timing manifest via the fake bucket types (Q1 #331)', () => {
  /** In-memory GcsClientLike: one Map of objectKey → saved bytes. */
  function fakeGcs() {
    const objects = new Map<string, Buffer>();
    const client: GcsClientLike = {
      bucket: () => ({
        file: (name: string): GcsFileLike => ({
          save: async (data: Buffer) => {
            objects.set(name, Buffer.from(data));
          },
          exists: async () => [objects.has(name)] as [boolean],
          getSignedUrl: async () => [`https://storage.googleapis.com/test/${name}`] as [string],
          delete: async (options?: { ignoreNotFound?: boolean }) => {
            if (!objects.has(name) && !options?.ignoreNotFound) throw new Error('404');
            objects.delete(name);
          },
          download: async () => {
            const data = objects.get(name);
            if (!data) throw new Error('404');
            return [data] as [Buffer];
          },
        }),
      }),
    };
    return { client, objects };
  }

  it('round-trips a manifest through save/download under the manifest key', async () => {
    const { client, objects } = fakeGcs();
    const storage = new GcsAudioStorage({ bucketName: 'b', storageClient: client });

    await storage.uploadManifest('dev-9', SAMPLE_MANIFEST);
    expect([...objects.keys()]).toEqual([manifestObjectKey('dev-9')]);
    expect(await storage.getManifest('dev-9')).toEqual(SAMPLE_MANIFEST);
  });

  it('returns null when the manifest object does not exist', async () => {
    const { client } = fakeGcs();
    const storage = new GcsAudioStorage({ bucketName: 'b', storageClient: client });
    expect(await storage.getManifest('missing')).toBeNull();
  });

  it('returns null for schema-invalid stored JSON', async () => {
    const { client, objects } = fakeGcs();
    objects.set(manifestObjectKey('dev-bad'), Buffer.from('[{"section":"nope"}]', 'utf8'));
    const storage = new GcsAudioStorage({ bucketName: 'b', storageClient: client });
    expect(await storage.getManifest('dev-bad')).toBeNull();
  });

  it('delete removes both the audio and the manifest objects', async () => {
    const { client, objects } = fakeGcs();
    const storage = new GcsAudioStorage({ bucketName: 'b', storageClient: client });
    await storage.upload('dev-9', Buffer.from('mp3'));
    await storage.uploadManifest('dev-9', SAMPLE_MANIFEST);
    expect(objects.size).toBe(2);
    await storage.delete('dev-9');
    expect(objects.size).toBe(0);
  });
});
