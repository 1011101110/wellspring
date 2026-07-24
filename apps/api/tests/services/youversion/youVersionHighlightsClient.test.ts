/**
 * YouVersionHighlightsClient (U3/U4 #356/#357) — the user-Bearer
 * `/v1/highlights` client. Best-effort by contract: HTTP/transport failures
 * become `{ ok: false, status }` results, never throws. Tests inject a fake
 * fetch so nothing touches the network.
 *
 * LIVE-VERIFIED shapes (2026-07-24):
 *  - BOTH headers on every call (Bearer + X-YVP-App-Key);
 *  - POST body `{ request_id, highlight: { bible_id, passage_id, color } }`
 *    with a uuid request_id and a required 6-hex color;
 *  - GET `?bible_id=&passage_id=` (both required) → boolean "is highlighted".
 */
import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_DEFAULT_COLOR,
  YouVersionHighlightsClient,
  type FetchLike,
} from '../../../src/services/youversion/youVersionHighlightsClient.js';

function okJson(body: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
  };
}

function errStatus(status: number, text = 'error'): Awaited<ReturnType<FetchLike>> {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(text),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('YouVersionHighlightsClient.createHighlight', () => {
  it('POSTs the live-verified wrapper body and BOTH auth headers (mutation-checked)', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(okJson({ bible_id: 3034, passage_id: 'JHN.3.16', color: HIGHLIGHT_DEFAULT_COLOR }, 201));
    };
    const client = new YouVersionHighlightsClient({ appKey: 'app-key-1', fetchImpl });

    const result = await client.createHighlight({
      bearer: 'user-bearer',
      bibleId: 3034,
      passageId: 'JHN.3.16',
      color: HIGHLIGHT_DEFAULT_COLOR,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.youversion.com/v1/highlights');
    expect(init?.method).toBe('POST');
    // The exact live-verified body: a wrapper with a uuid request_id and a
    // { bible_id, passage_id, color } highlight — mutation-checked so a silent
    // field rename can't pass.
    const parsed = JSON.parse(init!.body!) as {
      request_id: string;
      highlight: Record<string, unknown>;
    };
    expect(parsed.request_id).toMatch(UUID_RE);
    expect(parsed.highlight).toEqual({
      bible_id: 3034,
      passage_id: 'JHN.3.16',
      color: HIGHLIGHT_DEFAULT_COLOR,
    });
    // BOTH headers required (Bearer alone → 401 "Failed to resolve API Key").
    expect(init?.headers?.['X-YVP-App-Key']).toBe('app-key-1');
    expect(init?.headers?.Authorization).toBe('Bearer user-bearer');
  });

  it('the default color is a 6-hex string (the API requires it)', () => {
    expect(HIGHLIGHT_DEFAULT_COLOR).toMatch(/^[0-9a-f]{6}$/);
  });

  it('generates a fresh request_id per write (idempotent-retry key)', async () => {
    const bodies: string[] = [];
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: (_url, init) => {
        bodies.push(init!.body!);
        return Promise.resolve(okJson(undefined, 201));
      },
    });
    await client.createHighlight({ bearer: 'b', bibleId: 1, passageId: 'GEN.1.1', color: 'b4795a' });
    await client.createHighlight({ bearer: 'b', bibleId: 1, passageId: 'GEN.1.1', color: 'b4795a' });
    const id0 = (JSON.parse(bodies[0]!) as { request_id: string }).request_id;
    const id1 = (JSON.parse(bodies[1]!) as { request_id: string }).request_id;
    expect(id0).not.toBe(id1);
  });

  it('a non-2xx status returns ok:false WITH the status preserved (so the bridge can spot a 401), never throws', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: () => Promise.resolve(errStatus(401, 'Failed to resolve API Key')),
    });
    const result = await client.createHighlight({ bearer: 'stale', bibleId: 1, passageId: 'GEN.1.1', color: 'b4795a' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('a transport error resolves to ok:false status 0 (never throws out of the write path)', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });
    const result = await client.createHighlight({ bearer: 'b', bibleId: 1, passageId: 'GEN.1.1', color: 'b4795a' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });

  it('throws only on programmer misuse (empty bearer)', async () => {
    const client = new YouVersionHighlightsClient({ appKey: 'k', fetchImpl: () => Promise.resolve(okJson({})) });
    await expect(
      client.createHighlight({ bearer: '', bibleId: 1, passageId: 'GEN.1.1', color: 'b4795a' }),
    ).rejects.toThrow();
  });
});

describe('YouVersionHighlightsClient.getHighlight', () => {
  it('sends BOTH required query params and BOTH auth headers', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const client = new YouVersionHighlightsClient({
      appKey: 'app-key-1',
      fetchImpl: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(
          okJson({ data: [{ bible_id: 3034, passage_id: 'JHN.3.16', color: 'b4795a' }] }),
        );
      },
    });
    const result = await client.getHighlight({ bearer: 'b', bibleId: 3034, passageId: 'JHN.3.16' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(true);
    const { url, init } = calls[0]!;
    expect(url).toContain('/v1/highlights?');
    expect(url).toContain('bible_id=3034');
    expect(url).toContain('passage_id=JHN.3.16');
    expect(init?.headers?.['X-YVP-App-Key']).toBe('app-key-1');
    expect(init?.headers?.Authorization).toBe('Bearer b');
  });

  it('returns true when the { data: [...] } envelope carries a highlight', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: () => Promise.resolve(okJson({ data: [{ bible_id: 3034, passage_id: 'JHN.3.16', color: 'b4795a' }] })),
    });
    const result = await client.getHighlight({ bearer: 'b', bibleId: 3034, passageId: 'JHN.3.16' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(true);
  });

  it('returns false on an empty data array', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: () => Promise.resolve(okJson({ data: [] })),
    });
    const result = await client.getHighlight({ bearer: 'b', bibleId: 3034, passageId: 'PSA.23.1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(false);
  });

  it('returns false on a 204/empty body (not highlighted)', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: () => Promise.resolve(okJson(undefined, 204)),
    });
    const result = await client.getHighlight({ bearer: 'b', bibleId: 3034, passageId: 'PSA.23.1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(false);
  });

  it('a 401 returns ok:false with the status preserved (bridge refreshes), never throws', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: () => Promise.resolve(errStatus(401, 'Missing or invalid Bearer token')),
    });
    const result = await client.getHighlight({ bearer: 'stale', bibleId: 1, passageId: 'GEN.1.1' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('throws only on programmer misuse (empty bearer)', async () => {
    const client = new YouVersionHighlightsClient({ appKey: 'k', fetchImpl: () => Promise.resolve(okJson({})) });
    await expect(client.getHighlight({ bearer: '', bibleId: 1, passageId: 'GEN.1.1' })).rejects.toThrow();
  });
});
