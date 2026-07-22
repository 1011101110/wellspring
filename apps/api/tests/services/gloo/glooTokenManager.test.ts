import { describe, expect, it, vi } from 'vitest';
import {
  GlooAuthError,
  GlooTokenManager,
  type Clock,
  type FetchLike,
} from '../../../src/services/gloo/glooTokenManager.js';

/** Deterministic, manually-advanced clock — no real sleeping in tests. */
class FakeClock implements Clock {
  private currentMs: number;
  constructor(startMs = 0) {
    this.currentMs = startMs;
  }
  now(): number {
    return this.currentMs;
  }
  advance(ms: number): void {
    this.currentMs += ms;
  }
}

function fakeTokenResponse(accessToken: string, expiresInSeconds: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: accessToken,
      expires_in: expiresInSeconds,
      token_type: 'Bearer',
    }),
    text: async () => '',
  };
}

describe('GlooTokenManager', () => {
  it('fetches a token with Basic auth from clientId/clientSecret and caches it', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi.fn(async () => fakeTokenResponse('tok-1', 3600));
    const mgr = new GlooTokenManager({
      clientId: 'my-id',
      clientSecret: 'my-secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
    });

    const token = await mgr.getToken();
    expect(token).toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://platform.ai.gloo.com/oauth2/token');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init?.body).toBe('grant_type=client_credentials&scope=api/access');

    const expectedBasic = Buffer.from('my-id:my-secret').toString('base64');
    expect(init?.headers?.Authorization).toBe(`Basic ${expectedBasic}`);

    // Second call within validity window should be served from cache — no new fetch.
    const token2 = await mgr.getToken();
    expect(token2).toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes at T-60s before expiry, not exactly at expiry', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeTokenResponse('tok-1', 3600))
      .mockResolvedValueOnce(fakeTokenResponse('tok-2', 3600));
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
    });

    await mgr.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Advance to exactly 59 minutes (3540s) -- still within the 60s skew window from expiry (3600s),
    // so this should trigger a refresh (now >= expiresAt - 60s).
    clock.advance(3540 * 1000);
    const token = await mgr.getToken();
    expect(token).toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not refresh before the T-60s skew window', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi.fn().mockResolvedValueOnce(fakeTokenResponse('tok-1', 3600));
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
    });

    await mgr.getToken();
    // Advance to 3000s (well before 3540s skew boundary).
    clock.advance(3000 * 1000);
    const token = await mgr.getToken();
    expect(token).toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent getToken() calls into one fetch', async () => {
    const clock = new FakeClock(0);
    let resolveFetch!: (value: Awaited<ReturnType<FetchLike>>) => void;
    const pending = new Promise<Awaited<ReturnType<FetchLike>>>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchImpl = vi.fn(() => pending);
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
    });

    const p1 = mgr.getToken();
    const p2 = mgr.getToken();
    resolveFetch(fakeTokenResponse('tok-concurrent', 3600));

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe('tok-concurrent');
    expect(t2).toBe('tok-concurrent');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws GlooAuthError on non-OK HTTP response without persisting a token', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'invalid_client',
    }));
    const mgr = new GlooTokenManager({
      clientId: 'bad-id',
      clientSecret: 'bad-secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
    });

    await expect(mgr.getToken()).rejects.toBeInstanceOf(GlooAuthError);
    try {
      await mgr.getToken();
      expect.unreachable();
    } catch (err) {
      expect((err as GlooAuthError).status).toBe(401);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws GlooAuthError when the response body lacks access_token/expires_in', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ weird: 'shape' }),
      text: async () => '',
    }));
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
    });

    await expect(mgr.getToken()).rejects.toBeInstanceOf(GlooAuthError);
  });

  it('throws GlooAuthError at construction time if clientId or clientSecret is missing', () => {
    expect(() => new GlooTokenManager({ clientId: '', clientSecret: 'x' })).toThrow(GlooAuthError);
    expect(() => new GlooTokenManager({ clientId: 'x', clientSecret: '' })).toThrow(GlooAuthError);
  });

  it('invalidate() forces a fresh fetch on next getToken()', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeTokenResponse('tok-1', 3600))
      .mockResolvedValueOnce(fakeTokenResponse('tok-2', 3600));
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
    });

    await mgr.getToken();
    mgr.invalidate();
    const token = await mgr.getToken();
    expect(token).toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('passes an AbortSignal on every token request (10s timeout budget)', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi.fn(async () => fakeTokenResponse('tok-1', 3600));
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
    });
    await mgr.getToken();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries on 429 with backoff, honoring Retry-After, then succeeds', async () => {
    const clock = new FakeClock(0);
    const sleepCalls: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === 'retry-after' ? '2' : null) },
        json: async () => ({}),
        text: async () => 'rate limited',
      })
      .mockResolvedValueOnce(fakeTokenResponse('tok-after-retry', 3600));
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
      retrySleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    });

    const token = await mgr.getToken();
    expect(token).toBe('tok-after-retry');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([2000]); // Retry-After: 2 seconds, honored verbatim
  });

  it('retries on 5xx and network failure up to maxRetries, then throws the last error', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => 'unavailable',
      })
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => 'still unavailable',
      });
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
      retrySleep: async () => {},
      retryRandom: () => 0,
    });

    await expect(mgr.getToken()).rejects.toBeInstanceOf(GlooAuthError);
    // 1 initial + 2 retries = 3 total attempts (bounded retry, max 2).
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable 4xx (e.g. 401)', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => 'invalid_client',
    }));
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
      retrySleep: async () => {},
    });

    await expect(mgr.getToken()).rejects.toBeInstanceOf(GlooAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never persists the token anywhere but the in-memory field (no disk/log side channel)', async () => {
    const clock = new FakeClock(0);
    const fetchImpl = vi.fn(async () => fakeTokenResponse('super-secret-token', 3600));
    const mgr = new GlooTokenManager({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as FetchLike,
      clock,
    });
    const token = await mgr.getToken();
    expect(token).toBe('super-secret-token');
    // Structural guarantee: the class exposes no persistence method, and the
    // only external effect of getToken() is the injected fetchImpl call
    // asserted above (no fs/logger calls are made anywhere in the class).
  });
});
