/**
 * Live-integration tests against the real YouVersion Platform API.
 *
 * Skipped entirely (describe.skipIf) when YOUVERSION_API_KEY is not present
 * in the environment — CI has no .env and must skip gracefully, not fail.
 * Run locally with:
 *   set -a; source .env; set +a; npm --workspace apps/api run test -- youVersionClient.live
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { YouVersionClient } from '../../../src/services/youversion/youVersionClient.js';

const BSB = 3034;
const ASV = 12;
const WEBUS = 206;

const apiKey = process.env.YOUVERSION_API_KEY;

describe.skipIf(!apiKey)('YouVersionClient — LIVE (real YouVersion API)', () => {
  // Constructed lazily in beforeAll (not at describe-body eval time) so that
  // when this suite is skipped (no YOUVERSION_API_KEY, e.g. in CI) we never
  // even attempt `new YouVersionClient({ apiKey: '' })`, which throws.
  let client: YouVersionClient;
  beforeAll(() => {
    client = new YouVersionClient({ apiKey: apiKey ?? '' });
  });

  it('fetches Matthew 11:28-30 from BSB 3034 and returns the expected text + attribution', async () => {
    const result = await client.getVerse('MAT.11.28-MAT.11.30', BSB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.usfm).toBe('MAT.11.28-30');
    expect(result.data.versionId).toBe(BSB);
    // Spot check: this is Jesus' well-known "Come to me, all who are weary" invitation.
    expect(result.data.text).toMatch(/come to me/i);
    expect(result.data.text).toMatch(/weary/i);
    expect(result.data.text).toMatch(/rest/i);
    expect(result.data.text).toMatch(/yoke/i);
    expect(result.data.attribution).toMatch(/berean/i);
  });

  it('fetches John 3:16 from ASV 12 with recognizably correct KJV-family wording', async () => {
    const result = await client.getVerse('JHN.3.16', ASV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toMatch(/God so loved the world/i);
    expect(result.data.text).toMatch(/only begotten Son/i);
  });

  it('fetches John 3:16 from WEBUS 206', async () => {
    const result = await client.getVerse('JHN.3.16', WEBUS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toMatch(/God so loved the world/i);
  });

  it('maps a deliberately invalid/out-of-range verse to REFERENCE_OUT_OF_RANGE via local index validation', async () => {
    // Matthew 11 has 30 verses; 999 is out of range — caught by /index before the network call.
    const result = await client.getVerse('MAT.11.999', BSB);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REFERENCE_OUT_OF_RANGE');
    expect(result.error.retryable).toBe(false);
  });

  it('maps a nonexistent book to INVALID_ARGUMENT via local index validation', async () => {
    const result = await client.getVerse('XYZ.1.1', BSB);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('maps a real-but-unlicensed version id (NIV 111) to LICENSE_UNAVAILABLE — live-verified HTTP 403 disambiguated via GET /v1/bibles/{id}', async () => {
    const NIV = 111;
    const result = await client.getVerse('JHN.3.16', NIV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('LICENSE_UNAVAILABLE');
    expect(result.error.retryable).toBe(false);
  });

  it('maps a genuinely nonexistent bible id to BIBLE_NOT_FOUND — live-verified HTTP 403 disambiguated via GET /v1/bibles/{id} 404', async () => {
    const result = await client.getVerse('JHN.3.16', 999999);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BIBLE_NOT_FOUND');
  });

  it('maps an invalid app key to AUTH_FAILED — live-verified HTTP 401', async () => {
    const badClient = new YouVersionClient({ apiKey: 'definitely-not-a-real-key-12345' });
    const result = await badClient.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_FAILED');
  });

  it('lists the live catalog and confirms BSB/ASV/WEBUS are present, NIV/KJV/ESV are not', async () => {
    const result = await client.listBibles(['en']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.data.map((b) => b.id);
    expect(ids).toContain(BSB);
    expect(ids).toContain(ASV);
    expect(ids).toContain(WEBUS);
    expect(ids).not.toContain(111); // NIV
    expect(ids).not.toContain(1); // KJV
    expect(ids).not.toContain(59); // ESV
  });
});
