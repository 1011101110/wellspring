/**
 * YouVersionHighlightsClient (U3/U4 #356/#357) — the user-Bearer
 * `/v1/highlights` client. Best-effort by contract: HTTP/transport failures
 * become `{ ok: false, status }` results, never throws. Tests inject a fake
 * fetch so nothing touches the network.
 */
import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_DEFAULT_COLOR,
  YouVersionHighlightsClient,
  normalizeHighlight,
  type FetchLike,
} from '../../../src/services/youversion/youVersionHighlightsClient.js';

function okJson(body: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
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

describe('YouVersionHighlightsClient.createHighlight', () => {
  it('POSTs the must-confirm body shape and BOTH auth headers (mutation-checked)', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(okJson(undefined, 201));
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
    // The exact body the ⚠️ must-confirm schema assumes — mutation-checked so a
    // silent field rename can't pass.
    expect(JSON.parse(init!.body!)).toEqual({
      bible_id: 3034,
      passage_id: 'JHN.3.16',
      color: HIGHLIGHT_DEFAULT_COLOR,
    });
    expect(init?.headers?.['X-YVP-App-Key']).toBe('app-key-1');
    expect(init?.headers?.Authorization).toBe('Bearer user-bearer');
  });

  it('omits color when not provided', async () => {
    let body: string | undefined;
    const fetchImpl: FetchLike = (_url, init) => {
      body = init?.body;
      return Promise.resolve(okJson(undefined, 201));
    };
    const client = new YouVersionHighlightsClient({ appKey: 'k', fetchImpl });
    await client.createHighlight({ bearer: 'b', bibleId: 1, passageId: 'GEN.1.1' });
    expect(JSON.parse(body!)).toEqual({ bible_id: 1, passage_id: 'GEN.1.1' });
    expect(JSON.parse(body!)).not.toHaveProperty('color');
  });

  it('a non-2xx status returns ok:false WITH the status preserved (so the bridge can spot a 401), never throws', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: () => Promise.resolve(errStatus(401, 'Missing or invalid Bearer token')),
    });
    const result = await client.createHighlight({ bearer: 'stale', bibleId: 1, passageId: 'GEN.1.1' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('a transport error resolves to ok:false status 0 (never throws out of the write path)', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });
    const result = await client.createHighlight({ bearer: 'b', bibleId: 1, passageId: 'GEN.1.1' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });

  it('throws only on programmer misuse (empty bearer)', async () => {
    const client = new YouVersionHighlightsClient({ appKey: 'k', fetchImpl: () => Promise.resolve(okJson({})) });
    await expect(client.createHighlight({ bearer: '', bibleId: 1, passageId: 'GEN.1.1' })).rejects.toThrow();
  });
});

describe('YouVersionHighlightsClient.listHighlights', () => {
  it('normalizes a { data: [...] } envelope to passageId/bibleId', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: (url) => {
        expect(url).toContain('/v1/highlights?');
        expect(url).toContain('bible_id=3034');
        return Promise.resolve(
          okJson({
            data: [
              { passage_id: 'JHN.3.16', bible_id: 3034, created_at: '2026-07-20T00:00:00Z' },
              { passage_id: 'PSA.23.1', bible_id: 3034 },
            ],
          }),
        );
      },
    });
    const result = await client.listHighlights({ bearer: 'b', bibleId: 3034 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { passageId: 'JHN.3.16', bibleId: 3034, createdAt: '2026-07-20T00:00:00Z' },
      { passageId: 'PSA.23.1', bibleId: 3034 },
    ]);
  });

  it('a malformed envelope degrades to an empty list, not an error', async () => {
    const client = new YouVersionHighlightsClient({
      appKey: 'k',
      fetchImpl: () => Promise.resolve(okJson({ unexpected: true })),
    });
    const result = await client.listHighlights({ bearer: 'b' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });
});

describe('normalizeHighlight', () => {
  it('tolerates alternate field names (passageId/versionId, string bible id)', () => {
    expect(normalizeHighlight({ passageId: 'JHN.3.16', versionId: '3034' })).toEqual({
      passageId: 'JHN.3.16',
      bibleId: 3034,
    });
  });

  it('drops items missing a usable passage id or bible id (never fabricates a reference)', () => {
    expect(normalizeHighlight({ bible_id: 3034 })).toBeNull();
    expect(normalizeHighlight({ passage_id: 'JHN.3.16' })).toBeNull();
    expect(normalizeHighlight({ passage_id: 'JHN.3.16', bible_id: 0 })).toBeNull();
    expect(normalizeHighlight(null)).toBeNull();
    expect(normalizeHighlight('nope')).toBeNull();
  });
});
