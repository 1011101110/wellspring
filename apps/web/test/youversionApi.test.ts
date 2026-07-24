/**
 * `getYouVersionConnectUrl` / `disconnectYouVersion` (U5, #358) — the two
 * client functions for the YouVersion handoff. `apiFetch` is stubbed rather
 * than the network (same reasoning as `calendarApi.test.ts`: importing the
 * real client pulls in Firebase config these tests have nothing to say
 * about), so what is under test is only each function's own request shape and
 * how it treats the response — including letting a 503 (not configured yet)
 * surface as an `ApiError` the caller can turn into a quiet "coming soon".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../src/api/client', () => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError, apiFetch };
});

const { getYouVersionConnectUrl, disconnectYouVersion } = await import('../src/api/youversion');

beforeEach(() => apiFetch.mockReset());
afterEach(() => vi.clearAllMocks());

describe('getYouVersionConnectUrl', () => {
  it('POSTs to the connect endpoint and returns the authorize URL', async () => {
    apiFetch.mockResolvedValue({ ok: true, authUrl: 'https://youversion.test/authorize?x=1' });

    const url = await getYouVersionConnectUrl();

    expect(url).toBe('https://youversion.test/authorize?x=1');
    expect(apiFetch).toHaveBeenCalledWith('/v1/youversion/connect', { method: 'POST' });
  });

  it('throws when the response carries no usable link', async () => {
    apiFetch.mockResolvedValue({ ok: true });
    await expect(getYouVersionConnectUrl()).rejects.toThrow(/did not return a YouVersion/);

    apiFetch.mockResolvedValue({ ok: true, authUrl: '' });
    await expect(getYouVersionConnectUrl()).rejects.toThrow(/did not return a YouVersion/);
  });

  // The 503 "not configured yet" propagation — where `getYouVersionConnectUrl`
  // re-throws the `ApiError` and the shell turns it into a quiet "coming soon"
  // instead of an error — is exercised end-to-end through the real `<App />`
  // in `App.test.tsx` ("503 (not configured): the connect row disables …"),
  // which is where the status is actually branched on.
});

describe('disconnectYouVersion', () => {
  it('DELETEs the connection', async () => {
    apiFetch.mockResolvedValue({ ok: true });

    await disconnectYouVersion();

    expect(apiFetch).toHaveBeenCalledWith('/v1/youversion/connection', { method: 'DELETE' });
  });
});
