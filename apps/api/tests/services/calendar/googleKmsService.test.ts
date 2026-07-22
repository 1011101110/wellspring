/**
 * Unit tests for GoogleKmsService — verifies the correct KMS REST endpoints
 * are called, base64 encode/decode is correct, and error paths throw.
 *
 * fetch is replaced with a vi.fn() stub; no real GCP calls are made.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GoogleKmsService } from '../../../src/services/calendar/googleKmsService.js';

const FAKE_KEY_NAME =
  'projects/test-project/locations/us-central1/keyRings/kairos/cryptoKeys/token-encryption';

const FAKE_KEY_VERSION = `${FAKE_KEY_NAME}/cryptoKeyVersions/1`;

function fakeGetAccessToken() {
  return Promise.resolve('fake-access-token');
}

function buildService() {
  return new GoogleKmsService({ keyName: FAKE_KEY_NAME, getAccessToken: fakeGetAccessToken });
}

describe('GoogleKmsService.encryptToken', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs to the correct encrypt endpoint with base64-encoded plaintext', async () => {
    const plaintext = 'my-refresh-token';
    const fakeCiphertext = Buffer.from('encrypted-bytes').toString('base64');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ciphertext: fakeCiphertext, name: FAKE_KEY_VERSION }),
    } as Response);
    globalThis.fetch = mockFetch;

    const service = buildService();
    const result = await service.encryptToken(plaintext);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://cloudkms.googleapis.com/v1/${FAKE_KEY_NAME}:encrypt`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer fake-access-token');

    const body = JSON.parse(init.body as string) as { plaintext: string };
    // plaintext must be base64-encoded
    expect(body.plaintext).toBe(Buffer.from(plaintext).toString('base64'));

    // Result
    expect(result.ciphertext).toEqual(Buffer.from(fakeCiphertext, 'base64'));
    expect(result.keyVersion).toBe(FAKE_KEY_VERSION);
  });

  it('throws on a non-OK HTTP response from KMS', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Permission denied',
    } as unknown as Response);
    globalThis.fetch = mockFetch;

    const service = buildService();
    await expect(service.encryptToken('some-token')).rejects.toThrow('KMS encrypt failed: HTTP 403');
  });
});

describe('GoogleKmsService.decryptToken', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs to the correct decrypt endpoint and returns the decoded plaintext', async () => {
    const plaintext = 'my-refresh-token';
    const ciphertext = Buffer.from('some-cipher-bytes');
    const fakePlaintextB64 = Buffer.from(plaintext).toString('base64');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plaintext: fakePlaintextB64 }),
    } as Response);
    globalThis.fetch = mockFetch;

    const service = buildService();
    const result = await service.decryptToken(ciphertext);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    // Decrypt uses the CryptoKey path (not the version path)
    expect(url).toBe(`https://cloudkms.googleapis.com/v1/${FAKE_KEY_NAME}:decrypt`);
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as { ciphertext: string };
    expect(body.ciphertext).toBe(ciphertext.toString('base64'));

    expect(result).toBe(plaintext);
  });

  it('throws on a non-OK HTTP response from KMS', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as unknown as Response);
    globalThis.fetch = mockFetch;

    const service = buildService();
    await expect(service.decryptToken(Buffer.from('bad'))).rejects.toThrow(
      'KMS decrypt failed: HTTP 500',
    );
  });

  it('round-trips: encrypt output is decryptable to original plaintext', async () => {
    const plaintext = 'super-secret-refresh-token-abc123';
    const simulatedCiphertext = Buffer.from(`ENC:${plaintext}`); // simulated — not real KMS

    // Encrypt stub
    const encryptFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ciphertext: simulatedCiphertext.toString('base64'),
        name: FAKE_KEY_VERSION,
      }),
    } as Response);
    globalThis.fetch = encryptFetch;

    const service = buildService();
    const { ciphertext } = await service.encryptToken(plaintext);
    expect(ciphertext).toEqual(simulatedCiphertext);

    // Decrypt stub — returns the plaintext back
    const decryptFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plaintext: Buffer.from(plaintext).toString('base64'),
      }),
    } as Response);
    globalThis.fetch = decryptFetch;

    const decrypted = await service.decryptToken(ciphertext);
    expect(decrypted).toBe(plaintext);
  });
});
