/**
 * Live-integration test against the REAL `your GCS audio bucket (set GCS_LIVE_TEST_BUCKET)`
 * GCS bucket (provisioned 2026-07-02, `publicAccessPrevention=enforced`,
 * 14-day lifecycle rule — issue #11, now resolved). Issue #68 (docs/14
 * §1.1) called for this exact round-trip once the bucket existed, to
 * replace the `TODO(issue #11): UNTESTED` markers that previously covered
 * every method in GcsAudioStorage — this test is that verification.
 *
 * Auth is gcloud ADC (Application Default Credentials), like
 * ttsService.live.test.ts — NOT a .env secret. Gated on ADC actually
 * being configured (checked via GOOGLE_APPLICATION_CREDENTIALS or the
 * well-known ADC file path `gcloud auth application-default login`
 * writes) rather than a separate manual opt-in flag, since "do I have
 * credentials to hit real GCP" is directly detectable and CI has none by
 * default. Run locally with:
 *
 *   npm --workspace apps/api run test -- gcsAudioStorage.live
 *
 * IMPORTANT — signed-URL minting needs a SIGNABLE identity, not just an
 * authenticated one: `getSignedUrl` calls `GoogleAuth.sign()`, which
 * requires `client_email` on the resolved credential (google-auth-
 * library's `getCredentialsAsync()` only returns that for a service-
 * account key file, an impersonated service account, a workload-identity
 * client, or GCE/Cloud Run metadata — never for a plain human's
 * `gcloud auth application-default login` OAuth2 user credential, which
 * is what this repo's developer ADC is, by design: no service-account
 * key file exists locally, and granting IAM impersonation rights would
 * be an IAM-mutating action this task is expressly forbidden from
 * taking). Upload/exists/delete (bearer-token operations) and the
 * direct-object-URL 403 check work identically regardless — only the
 * signed-URL-fetch sub-assertion is skipped, with an explicit console
 * message, when the resolved ADC identity cannot sign. In the deployed
 * environment this is a non-issue: Cloud Run's runtime identity IS
 * `kairos-api-sa` (GCE-style metadata credentials, which
 * getCredentialsAsync() DOES resolve a client_email for), so
 * `getSignedUrl` works there with the exact same code path this test
 * exercises for every other operation.
 *
 * Requires (both already true in this environment as of 2026-07-02):
 *   - `gcloud auth application-default login` once
 *   - `gcloud auth application-default set-quota-project <project>` once
 *     (storage.googleapis.com needs a quota project on ADC)
 *   - The resolved ADC principal must have storage object
 *     read/write/delete on the bucket — confirmed live below by the
 *     round-trip itself succeeding.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { GcsAudioStorage, audioObjectKey } from '../../../src/services/audio/audioStorage.js';

/**
 * The exact message google-auth-library's `GoogleAuth.sign()` throws when
 * the resolved credential has no `client_email` — i.e. no signing
 * capability (see file header). Matched narrowly so any OTHER failure
 * from getSignedUrl (wrong bucket, no permission, network error, a real
 * regression in GcsAudioStorage) still fails the test loudly instead of
 * being swallowed as "signing unavailable".
 */
const NO_SIGNING_CAPABILITY_MESSAGE = 'Cannot sign data without `client_email`';

const LIVE_BUCKET = process.env.GCS_LIVE_TEST_BUCKET ?? '';

/** Same well-known-file detection `gcloud`/google-auth-library itself uses for ADC. */
function wellKnownAdcPath(): string {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json');
  }
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

const hasAdc =
  Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS) || existsSync(wellKnownAdcPath());

describe.skipIf(!hasAdc || !LIVE_BUCKET)('GcsAudioStorage — LIVE (real GCS bucket, issue #11/#68)', () => {
  // Unique per test run so repeated local runs (and any accidental
  // parallelism) never collide on the same object key.
  const devotionalId = `live-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const objectKey = audioObjectKey(devotionalId);
  const storage = new GcsAudioStorage({ bucketName: LIVE_BUCKET });

  afterAll(async () => {
    // Best-effort cleanup even if an assertion above failed mid-test —
    // delete() is documented idempotent, so this is safe to call even if
    // the object was already removed by the test's own delete step.
    await storage.delete(devotionalId).catch(() => undefined);
  });

  it(
    'uploads a real object, [signing-permitting] mints a working signed URL, confirms the direct object URL is 403 (public access prevention), then deletes it',
    async () => {
      const payload = Buffer.from(
        `live round-trip test payload — ${devotionalId} — ${new Date().toISOString()}`,
      );

      // 1. Upload.
      const ref = await storage.upload(devotionalId, payload);
      expect(ref.objectKey).toBe(objectKey);

      // 2. exists() reflects the real object.
      expect(await storage.exists(devotionalId)).toBe(true);

      // 3. getSignedUrl mints a real V4 signed URL; fetching it must
      // return 200 with the EXACT bytes uploaded. Attempted
      // unconditionally — only the specific "no client_email to sign
      // with" failure (expected for a human `gcloud auth application-
      // default login` user credential, see file header) is treated as
      // "skip this sub-assertion"; ANY other error (wrong bucket, no
      // permission, a real regression) fails the test normally.
      try {
        const { url, expiresAt } = await storage.getSignedUrl(devotionalId, {
          expirySeconds: 300,
        });
        expect(url).toContain(LIVE_BUCKET);
        expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

        const signedRes = await fetch(url);
        expect(signedRes.status).toBe(200);
        const signedBytes = Buffer.from(await signedRes.arrayBuffer());
        expect(signedBytes.equals(payload)).toBe(true);
        console.log(
          `[GCS live] signed URL fetch: status=${signedRes.status} bytes=${signedBytes.length}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes(NO_SIGNING_CAPABILITY_MESSAGE)) {
          throw err; // A real failure — do not swallow it.
        }
        console.warn(
          '[GCS live] SKIPPED signed-URL-fetch sub-assertion: the resolved ADC identity ' +
            'has no client_email to sign with (expected for a human `gcloud auth ' +
            'application-default login` user credential — see file header). Upload, ' +
            'exists, direct-URL-403, and delete below still exercise the real bucket.',
        );
      }

      // 4. The DIRECT (unsigned) object URL must be 403 — proves
      // publicAccessPrevention=enforced is actually doing something, not
      // just configured on paper. This is the other half of the "no
      // public GCS buckets" contract (Foundation §10, API spec §6) — a
      // signed URL working is necessary but not sufficient; the object
      // must ALSO be unreachable without one. This assertion needs no
      // signing capability at all, so it always runs.
      const directUrl = `https://storage.googleapis.com/${LIVE_BUCKET}/${objectKey}`;
      const directRes = await fetch(directUrl);
      expect(directRes.status).toBe(403);
      console.log(`[GCS live] direct object URL fetch (should be blocked): status=${directRes.status}`);

      // 5. Delete, then confirm exists() reflects the deletion.
      await storage.delete(devotionalId);
      expect(await storage.exists(devotionalId)).toBe(false);

      // 6. delete() must be idempotent (AudioStorage contract) — a
      // second delete of an already-gone object must not throw.
      await expect(storage.delete(devotionalId)).resolves.not.toThrow();
    },
    30_000,
  );
});
