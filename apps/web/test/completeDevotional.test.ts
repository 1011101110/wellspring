/**
 * #3 — the web client for the authenticated "Amen" (`completeDevotional`).
 * Focused on this one function: it POSTs to the completion endpoint and returns
 * the server's completion instant, and it rejects a response it cannot trust
 * rather than returning a bogus value.
 *
 * `apiFetch` is stubbed (same rationale as `dashboardApi.test.ts`): importing
 * the real client pulls in `config.ts`, which throws without a Firebase key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { completeDevotional } = await import('../src/api/devotionals');
const { ApiError } = await import('../src/api/client');

beforeEach(() => {
  apiFetch.mockReset();
});

describe('completeDevotional (#3)', () => {
  it('POSTs to the devotional completion endpoint and returns the completion instant', async () => {
    apiFetch.mockResolvedValue({ ok: true, completedAt: '2026-07-24T12:00:00.000Z' });

    const at = await completeDevotional('dev-1');

    expect(at).toBe('2026-07-24T12:00:00.000Z');
    expect(apiFetch).toHaveBeenCalledWith('/v1/devotionals/dev-1/complete', { method: 'POST' });
  });

  it('URL-encodes the id (never interpolates it raw into the path)', async () => {
    apiFetch.mockResolvedValue({ ok: true, completedAt: '2026-07-24T12:00:00.000Z' });

    await completeDevotional('a/b?c');

    expect(apiFetch).toHaveBeenCalledWith('/v1/devotionals/a%2Fb%3Fc/complete', { method: 'POST' });
  });

  it('throws on a response shape it cannot trust rather than returning a bogus instant', async () => {
    apiFetch.mockResolvedValue({ ok: true /* completedAt missing */ });

    await expect(completeDevotional('dev-1')).rejects.toBeInstanceOf(ApiError);
  });
});
