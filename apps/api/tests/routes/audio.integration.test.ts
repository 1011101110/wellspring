/**
 * Integration tests for GET /audio/:token (issue #68, docs/14 §1.2).
 * Regression coverage: before this route existed, LocalFileAudioStorage
 * minted `${baseUrl}/audio/<token>` URLs (audioStorage.ts) that nothing in
 * app.ts served — the session page's <audio> element was a dead link in
 * every environment where local storage was active. These tests actually
 * GET the minted URL (not just assert the URL string), which is the exact
 * gap the pre-fix test suite had.
 *
 * No database needed: the route depends only on AudioStorage, not
 * SessionService's devotional/session lookups — so this file wires
 * `buildApp({ sessionService, audioStorage })` directly against a
 * temp-directory LocalFileAudioStorage without touching Postgres.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { LocalFileAudioStorage, GcsAudioStorage } from '../../src/services/audio/audioStorage.js';
import { SessionService } from '../../src/services/session/sessionService.js';
import type { SessionsRepository } from '../../src/db/repositories/sessionsRepository.js';
import type { DevotionalsRepository } from '../../src/db/repositories/devotionalsRepository.js';
import type { FastifyInstance } from 'fastify';

// SessionService requires real repositories to be fully functional, but
// none of these tests exercise /session/:token — only /audio/:token,
// which the app registers whenever `audioStorage` is passed. We still
// need a SessionService instance for `sessionService` to be truthy (the
// gate that opens the whole session-scope registration in app.ts,
// including /audio/:token) — a minimal stub repository set satisfies the
// constructor without ever being called.
const unusedRepo = {
  findByToken: async () => null,
  markCompleted: async () => null,
} as unknown as SessionsRepository;
const unusedDevotionals = {} as unknown as DevotionalsRepository;

describe('GET /audio/:token', () => {
  let rootDir: string;
  let audioStorage: LocalFileAudioStorage;
  let app: FastifyInstance;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'kairos-audio-route-'));
    audioStorage = new LocalFileAudioStorage({ rootDir, signingSecret: 'a'.repeat(32) });
    const sessionService = new SessionService({
      sessions: unusedRepo,
      devotionals: unusedDevotionals,
      audioStorage,
    });
    app = buildApp({ sessionService, audioStorage });
  });

  afterEach(async () => {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function mintTokenFor(devotionalId: string, audio: Buffer): Promise<string> {
    await audioStorage.upload(devotionalId, audio);
    const { url } = await audioStorage.getSignedUrl(devotionalId, { expirySeconds: 900 });
    return decodeURIComponent(url.split('/audio/')[1]!);
  }

  it('200: serves the full MP3 bytes with content-type audio/mpeg and accept-ranges: bytes', async () => {
    const audio = Buffer.from('fake mp3 bytes for the full-request test');
    const token = await mintTokenFor('dev-full', audio);

    const res = await app.inject({ method: 'GET', url: `/audio/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(audio.length));
    expect(Buffer.from(res.rawPayload).equals(audio)).toBe(true);
  });

  it('206: serves a partial range with correct Content-Range and Content-Length (iOS Safari range-request requirement)', async () => {
    const audio = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes, easy to slice by hand.
    const token = await mintTokenFor('dev-range', audio);

    const res = await app.inject({
      method: 'GET',
      url: `/audio/${token}`,
      headers: { range: 'bytes=5-9' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 5-9/${audio.length}`);
    expect(res.headers['content-length']).toBe('5');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.from(res.rawPayload).toString('utf8')).toBe('56789');
  });

  it('206: open-ended range (bytes=N-) serves from N to the end of the file', async () => {
    const audio = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes.
    const token = await mintTokenFor('dev-range-open', audio);

    const res = await app.inject({
      method: 'GET',
      url: `/audio/${token}`,
      headers: { range: 'bytes=15-' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 15-19/${audio.length}`);
    expect(res.headers['content-length']).toBe('5');
    expect(Buffer.from(res.rawPayload).toString('utf8')).toBe('FGHIJ');
  });

  it('206: first-byte range (bytes=0-0) serves exactly one byte — common iOS Safari probe pattern', async () => {
    const audio = Buffer.from('0123456789');
    const token = await mintTokenFor('dev-range-probe', audio);

    const res = await app.inject({
      method: 'GET',
      url: `/audio/${token}`,
      headers: { range: 'bytes=0-0' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-0/${audio.length}`);
    expect(Buffer.from(res.rawPayload).toString('utf8')).toBe('0');
  });

  it('416: an unsatisfiable range (start beyond file length) is rejected with Content-Range: bytes */N', async () => {
    const audio = Buffer.from('short');
    const token = await mintTokenFor('dev-range-oob', audio);

    const res = await app.inject({
      method: 'GET',
      url: `/audio/${token}`,
      headers: { range: 'bytes=999-1000' },
    });

    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${audio.length}`);
  });

  it('a malformed Range header is ignored — falls back to a full 200 response', async () => {
    const audio = Buffer.from('fallback bytes');
    const token = await mintTokenFor('dev-range-malformed', audio);

    const res = await app.inject({
      method: 'GET',
      url: `/audio/${token}`,
      headers: { range: 'bananas=not-a-range' },
    });

    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(audio)).toBe(true);
  });

  it('404 for a nonexistent/never-minted token', async () => {
    const res = await app.inject({ method: 'GET', url: '/audio/not-a-real-token' });
    expect(res.statusCode).toBe(404);
  });

  it('404 for a tampered token (payload swapped, signature invalid)', async () => {
    const audio1 = Buffer.from('audio-1-bytes');
    const audio2 = Buffer.from('audio-2-bytes-longer');
    const token1 = await mintTokenFor('dev-tamper-1', audio1);
    const token2 = await mintTokenFor('dev-tamper-2', audio2);

    const forged = `${token2.split('.')[0]}.${token1.split('.')[1]}`;
    const res = await app.inject({ method: 'GET', url: `/audio/${forged}` });
    expect(res.statusCode).toBe(404);
  });

  it('enumeration-safe: an expired token returns the IDENTICAL 404 body/headers as a never-existed token', async () => {
    let currentTime = new Date('2026-07-02T12:00:00Z');
    const expiringStorage = new LocalFileAudioStorage({
      rootDir,
      signingSecret: 'a'.repeat(32),
      now: () => currentTime,
    });
    const expiringSessionService = new SessionService({
      sessions: unusedRepo,
      devotionals: unusedDevotionals,
      audioStorage: expiringStorage,
      now: () => currentTime,
    });
    const expiringApp = buildApp({
      sessionService: expiringSessionService,
      audioStorage: expiringStorage,
    });

    try {
      await expiringStorage.upload('dev-expiring', Buffer.from('will expire'));
      const { url } = await expiringStorage.getSignedUrl('dev-expiring', { expirySeconds: 60 });
      const token = decodeURIComponent(url.split('/audio/')[1]!);

      // Advance past expiry.
      currentTime = new Date(currentTime.getTime() + 61_000);

      const expiredRes = await expiringApp.inject({ method: 'GET', url: `/audio/${token}` });
      const unknownRes = await expiringApp.inject({
        method: 'GET',
        url: '/audio/definitely-never-existed',
      });

      expect(expiredRes.statusCode).toBe(404);
      expect(unknownRes.statusCode).toBe(404);
      expect(expiredRes.body).toBe(unknownRes.body);
      expect(expiredRes.headers['content-type']).toBe(unknownRes.headers['content-type']);
    } finally {
      await expiringApp.close();
    }
  });

  it('a token minted for one devotional is rejected when its bytes are requested via a different (validly-signed) token scope check', async () => {
    // Belt-and-suspenders on top of the LocalFileAudioStorage unit tests:
    // the route itself must not accept a token whose signature verifies
    // but whose payload has been altered to point at a different object
    // (covered above by 'tampered token'); this test instead confirms
    // that two independently-minted, both-valid tokens serve only their
    // OWN bytes — no cross-contamination between concurrent tokens.
    const audioA = Buffer.from('AAAA-owned-by-dev-a');
    const audioB = Buffer.from('BBBB-owned-by-dev-b-and-longer');
    const tokenA = await mintTokenFor('dev-a', audioA);
    const tokenB = await mintTokenFor('dev-b', audioB);

    const resA = await app.inject({ method: 'GET', url: `/audio/${tokenA}` });
    const resB = await app.inject({ method: 'GET', url: `/audio/${tokenB}` });

    expect(Buffer.from(resA.rawPayload).equals(audioA)).toBe(true);
    expect(Buffer.from(resB.rawPayload).equals(audioB)).toBe(true);
  });

  it('GCS-mode AudioStorage: the route is not registered to serve bytes — returns 404 rather than throwing', async () => {
    const gcsStorage = new GcsAudioStorage({
      bucketName: 'irrelevant-bucket',
      storageClient: {
        bucket: () => ({
          file: () => ({
            save: async () => {},
            exists: async () => [false] as [boolean],
            getSignedUrl: async () => ['https://storage.googleapis.com/irrelevant-bucket/x.mp3'] as [string],
            delete: async () => undefined,
          }),
        }),
      },
    });
    const gcsSessionService = new SessionService({
      sessions: unusedRepo,
      devotionals: unusedDevotionals,
      audioStorage: gcsStorage,
    });
    const gcsApp = buildApp({ sessionService: gcsSessionService, audioStorage: gcsStorage });

    try {
      const res = await gcsApp.inject({ method: 'GET', url: '/audio/any-token-at-all' });
      expect(res.statusCode).toBe(404);
    } finally {
      await gcsApp.close();
    }
  });
});
