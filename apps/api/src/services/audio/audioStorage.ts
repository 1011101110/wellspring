/**
 * AudioStorage — private object storage for synthesized devotional MP3s,
 * with time-limited signed-URL-style access. EPIC D, issue #30.
 * Contract: docs/00_FOUNDATION.md §10 ("no public GCS buckets... short-lived
 * signed URLs"), docs/03_API_INTEGRATION_SPEC.md §6 ("V4 signed URL, 15-min
 * expiry, at session-join time — never at generation time, never stored").
 *
 * Two implementations:
 *   - `LocalFileAudioStorage` — writes to the local filesystem, mints a
 *     token via HMAC-SHA256 with the same *security semantics* as a real
 *     cloud signed URL (expiry-bound, object-scoped, tamper-evident) for
 *     dev/test and CI, where there is no GCS bucket.
 *   - `GcsAudioStorage` — real `@google-cloud/storage` V4 signed-URL code
 *     against the private `<your-audio-bucket>` bucket
 *     (provisioned 2026-07-02, `publicAccessPrevention=enforced`, issue
 *     #11). Live-verified 2026-07-03 (issue #68, docs/14 §1.1) via
 *     tests/services/audio/gcsAudioStorage.live.test.ts: upload/exists/
 *     delete and the direct-object-URL-403 check all round-trip against
 *     the real bucket under Application Default Credentials.
 *     `getSignedUrl` itself uses the identical code path but was
 *     exercised there only under Cloud Run's `kairos-api-sa` runtime
 *     identity, not a local human ADC user credential (V4 signing needs
 *     a signable identity — a service-account key or GCE/Cloud-Run
 *     metadata — which a plain `gcloud auth application-default login`
 *     user credential structurally lacks); see that test file's header
 *     for the full explanation.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Canonical object key layout — API spec §6: `devotionals/{devotionalId}.mp3`. */
export function audioObjectKey(devotionalId: string): string {
  return `devotionals/${devotionalId}.mp3`;
}

export interface StoredAudioRef {
  objectKey: string;
}

export interface SignedUrlOptions {
  /** Signed-URL lifetime in seconds. API spec §6: 15-minute expiry at session-join time. */
  expirySeconds?: number;
}

export interface SignedUrlResult {
  url: string;
  expiresAt: Date;
}

/**
 * Storage abstraction so `SessionService` (a later stage) can depend on an
 * interface, not a concrete cloud SDK — swap `LocalFileAudioStorage` for
 * `GcsAudioStorage` purely via constructor wiring / DI, no call-site changes.
 */
export interface AudioStorage {
  /** Uploads/overwrites the MP3 for a devotional. Returns the object key it was stored under. */
  upload(devotionalId: string, audio: Buffer): Promise<StoredAudioRef>;
  /** Mints a time-limited signed URL for playback. Never called at generation time (API spec §6). */
  getSignedUrl(devotionalId: string, options?: SignedUrlOptions): Promise<SignedUrlResult>;
  /** Returns true if an object exists for this devotional. */
  exists(devotionalId: string): Promise<boolean>;
  /**
   * Deletes the object for a devotional, if any. Used by the retention
   * purge job (audio 14 days, Privacy §retention) and account hard-delete.
   * Must not throw when the object is already absent — deletion is
   * idempotent, matching how the retention job re-runs are expected to be
   * safe to retry.
   */
  delete(devotionalId: string): Promise<void>;
}

const DEFAULT_EXPIRY_SECONDS = 15 * 60; // API spec §6: 15-minute expiry.

// ---------------------------------------------------------------------------
// LocalFileAudioStorage — dev/test substitute for the private GCS bucket.
// ---------------------------------------------------------------------------

export interface LocalFileAudioStorageOptions {
  /** Directory MP3s are written under, e.g. apps/api/.data/audio. */
  rootDir: string;
  /** HMAC secret for signing tokens. Required — never defaults to a fixed string in a security-relevant primitive. */
  signingSecret: string;
  /** Base URL the token is appended to, purely for constructing a realistic playback URL in dev (e.g. http://localhost:8080). */
  baseUrl?: string;
  /** Injectable clock for deterministic expiry tests. */
  now?: () => Date;
}

interface LocalSignedToken {
  /** Object key this token is scoped to — a token for one object must never validate for another. */
  objectKey: string;
  /** Unix ms expiry. */
  exp: number;
  /** Random nonce so repeated calls for the same object don't produce identical tokens (cosmetic, not a security requirement here). */
  nonce: string;
}

/**
 * Local filesystem + HMAC-signed-token implementation of `AudioStorage`.
 * Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 of
 * the payload). This mirrors the real security properties of a cloud
 * signed URL:
 *   - object-scoped: the signature covers `objectKey`, so a valid token for
 *     one object is rejected for any other object.
 *   - time-bound: `exp` is checked against the clock at verification time;
 *     an expired token is rejected even if the signature is valid.
 *   - tamper-evident: any mutation to the payload (including swapping in a
 *     different object key or a later expiry) invalidates the signature,
 *     checked with a constant-time comparison to avoid timing side-channels.
 */
export class LocalFileAudioStorage implements AudioStorage {
  private readonly rootDir: string;
  private readonly signingSecret: string;
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(options: LocalFileAudioStorageOptions) {
    if (!options.signingSecret || options.signingSecret.length < 16) {
      throw new Error('LocalFileAudioStorage requires a signingSecret of at least 16 characters');
    }
    this.rootDir = options.rootDir;
    this.signingSecret = options.signingSecret;
    this.baseUrl = options.baseUrl ?? 'http://localhost:8080';
    this.now = options.now ?? (() => new Date());
  }

  private filePathFor(objectKey: string): string {
    // objectKey is always our own `devotionals/{devotionalId}.mp3` shape (never
    // user-supplied raw), but normalize defensively against path traversal.
    const safeRelative = path.normalize(objectKey).replace(/^(\.\.(\/|\\|$))+/, '');
    return path.join(this.rootDir, safeRelative);
  }

  async upload(devotionalId: string, audio: Buffer): Promise<StoredAudioRef> {
    const objectKey = audioObjectKey(devotionalId);
    const filePath = this.filePathFor(objectKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, audio);
    return { objectKey };
  }

  async exists(devotionalId: string): Promise<boolean> {
    try {
      await readFile(this.filePathFor(audioObjectKey(devotionalId)));
      return true;
    } catch {
      return false;
    }
  }

  /** Idempotent: deleting an already-absent file is not an error (retention job doc — see AudioStorage interface). */
  async delete(devotionalId: string): Promise<void> {
    try {
      await rm(this.filePathFor(audioObjectKey(devotionalId)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }

  /** Reads the raw audio bytes for a validated token (used by the session-page route to stream the file). */
  async readForToken(token: string): Promise<Buffer> {
    const verification = this.verifyToken(token);
    if (!verification.valid) {
      throw new Error(`Invalid or expired audio token: ${verification.reason}`);
    }
    return readFile(this.filePathFor(verification.objectKey));
  }

  async getSignedUrl(
    devotionalId: string,
    options: SignedUrlOptions = {},
  ): Promise<SignedUrlResult> {
    const objectKey = audioObjectKey(devotionalId);
    const expirySeconds = options.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
    const expiresAt = new Date(this.now().getTime() + expirySeconds * 1000);
    const token = this.signToken({ objectKey, exp: expiresAt.getTime(), nonce: randomUUID() });
    return { url: `${this.baseUrl}/audio/${encodeURIComponent(token)}`, expiresAt };
  }

  private signToken(payload: LocalSignedToken): string {
    const payloadJson = JSON.stringify(payload);
    const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.signingSecret)
      .update(payloadB64)
      .digest('base64url');
    return `${payloadB64}.${signature}`;
  }

  /**
   * Verifies a token's signature and expiry, and (when `expectedObjectKey`
   * is given) confirms it is scoped to that exact object — a token minted
   * for one devotional's audio must be rejected when presented for another.
   */
  verifyToken(
    token: string,
    expectedObjectKey?: string,
  ):
    | { valid: true; objectKey: string }
    | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_object' } {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { valid: false, reason: 'malformed' };
    }
    const [payloadB64, signature] = parts;

    const expectedSignature = createHmac('sha256', this.signingSecret)
      .update(payloadB64)
      .digest('base64url');

    const sigBuf = safeBufferFromBase64Url(signature);
    const expectedSigBuf = safeBufferFromBase64Url(expectedSignature);
    if (
      !sigBuf ||
      !expectedSigBuf ||
      sigBuf.length !== expectedSigBuf.length ||
      !timingSafeEqual(sigBuf, expectedSigBuf)
    ) {
      return { valid: false, reason: 'bad_signature' };
    }

    let payload: LocalSignedToken;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return { valid: false, reason: 'malformed' };
    }
    if (
      typeof payload.objectKey !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.nonce !== 'string'
    ) {
      return { valid: false, reason: 'malformed' };
    }

    if (this.now().getTime() >= payload.exp) {
      return { valid: false, reason: 'expired' };
    }

    if (expectedObjectKey !== undefined && payload.objectKey !== expectedObjectKey) {
      return { valid: false, reason: 'wrong_object' };
    }

    return { valid: true, objectKey: payload.objectKey };
  }
}

function safeBufferFromBase64Url(value: string): Buffer | undefined {
  try {
    const buf = Buffer.from(value, 'base64url');
    // Re-encoding must round-trip, otherwise `value` contained characters
    // outside the base64url alphabet and Buffer.from silently truncated it —
    // treat that as an invalid signature rather than comparing a truncated buffer.
    return buf.toString('base64url') === value ? buf : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// GcsAudioStorage — real signed-URL implementation against the private
// `<your-audio-bucket>` bucket (provisioned 2026-07-02,
// publicAccessPrevention=enforced, issue #11). Live round-trip verified
// 2026-07-03 — tests/services/audio/gcsAudioStorage.live.test.ts:
// upload -> HTTP GET on the signed URL succeeds; direct object URL -> 403
// (Foundation §10, API spec §6, Test Plan's no-public-bucket CI guard).
// ---------------------------------------------------------------------------

export interface GcsAudioStorageOptions {
  bucketName: string;
  /** Injectable for tests; defaults to a real `@google-cloud/storage` Storage client (ADC auth). */
  storageClient?: GcsClientLike;
}

/** Minimal shape of the `@google-cloud/storage` surface this class needs, for test injection. */
export interface GcsFileLike {
  save(data: Buffer, options?: { contentType?: string; resumable?: boolean }): Promise<void>;
  exists(): Promise<[boolean]>;
  getSignedUrl(options: { version: 'v4'; action: 'read'; expires: number }): Promise<[string]>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
}
export interface GcsBucketLike {
  file(name: string): GcsFileLike;
}
export interface GcsClientLike {
  bucket(name: string): GcsBucketLike;
}

export class GcsAudioStorage implements AudioStorage {
  private readonly bucketName: string;
  private clientPromise: Promise<GcsClientLike> | undefined;
  private readonly injectedClient: GcsClientLike | undefined;

  constructor(options: GcsAudioStorageOptions) {
    this.bucketName = options.bucketName;
    this.injectedClient = options.storageClient;
  }

  private async getClient(): Promise<GcsClientLike> {
    if (this.injectedClient) return this.injectedClient;
    if (!this.clientPromise) {
      // Real @google-cloud/storage client, ADC auth — on Cloud Run via
      // the kairos-api-sa service account's runtime identity; live
      // round-trip verified against the real bucket, see file header.
      this.clientPromise = import('@google-cloud/storage').then(({ Storage }) => {
        return new Storage() as unknown as GcsClientLike;
      });
    }
    return this.clientPromise;
  }

  async upload(devotionalId: string, audio: Buffer): Promise<StoredAudioRef> {
    const objectKey = audioObjectKey(devotionalId);
    const client = await this.getClient();
    const file = client.bucket(this.bucketName).file(objectKey);
    await file.save(audio, { contentType: 'audio/mpeg', resumable: false });
    return { objectKey };
  }

  async exists(devotionalId: string): Promise<boolean> {
    const client = await this.getClient();
    const file = client.bucket(this.bucketName).file(audioObjectKey(devotionalId));
    const [exists] = await file.exists();
    return exists;
  }

  /**
   * Idempotent per the AudioStorage contract — `ignoreNotFound: true` mirrors
   * LocalFileAudioStorage's ENOENT swallow. Live round-trip verified,
   * including double-delete idempotency — see file header.
   */
  async delete(devotionalId: string): Promise<void> {
    const client = await this.getClient();
    const file = client.bucket(this.bucketName).file(audioObjectKey(devotionalId));
    await file.delete({ ignoreNotFound: true });
  }

  /**
   * V4 signed URL, minted only at session-join time (API spec §6) — never
   * at generation time, never persisted. Default 15-minute expiry.
   * Requires a signable identity (a service-account key, or GCE/Cloud Run
   * metadata credentials) — this is what kairos-api-sa provides on Cloud
   * Run in production; see file header for why local developer ADC
   * (a plain user OAuth2 credential) cannot exercise this specific method.
   */
  async getSignedUrl(
    devotionalId: string,
    options: SignedUrlOptions = {},
  ): Promise<SignedUrlResult> {
    const expirySeconds = options.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
    const client = await this.getClient();
    const file = client.bucket(this.bucketName).file(audioObjectKey(devotionalId));
    const expiresAtMs = Date.now() + expirySeconds * 1000;
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: expiresAtMs });
    return { url, expiresAt: new Date(expiresAtMs) };
  }
}

/** Utility export kept for callers/tests that want a stable content hash without pulling in the whole class. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
