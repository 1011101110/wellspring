import { describe, expect, it, vi } from 'vitest';
import {
  YouVersionClient,
  YouVersionClientError,
  normalizeUsfmRange,
  type FetchLike,
} from '../../../src/services/youversion/youVersionClient.js';

const BSB = 3034;
const ASV = 12;

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyRes(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => undefined,
    text: async () => '',
  };
}

/** Minimal index fixture with one book (MAT), one chapter (11) of 30 verses. */
function fakeIndex(bookId = 'MAT', chapterId = '11', verseCount = 30) {
  return {
    text_direction: 'ltr',
    books: [
      {
        id: bookId,
        chapters: [
          {
            id: chapterId,
            verses: Array.from({ length: verseCount }, (_, i) => ({ id: String(i + 1) })),
          },
        ],
      },
    ],
  };
}

function fakeBibleDetail(id: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    abbreviation: 'BSB',
    title: 'Berean Standard Bible',
    copyright: null,
    ...overrides,
  };
}

/** Builds a router-style fetch mock: maps a predicate over the path to a canned response. */
function routedFetch(routes: Array<{ match: (path: string) => boolean; respond: () => unknown }>): FetchLike {
  return vi.fn(async (url: string) => {
    const path = url.replace('https://api.youversion.com', '');
    for (const route of routes) {
      if (route.match(path)) return route.respond() as ReturnType<FetchLike> extends Promise<infer R> ? R : never;
    }
    throw new Error(`No route matched for ${path}`);
  }) as unknown as FetchLike;
}

describe('normalizeUsfmRange', () => {
  it('rewrites long-form same-chapter ranges to the short form YouVersion actually accepts', () => {
    expect(normalizeUsfmRange('MAT.11.28-MAT.11.30')).toBe('MAT.11.28-30');
  });

  it('leaves single verses unchanged', () => {
    expect(normalizeUsfmRange('JHN.3.16')).toBe('JHN.3.16');
  });

  it('leaves already-short ranges unchanged', () => {
    expect(normalizeUsfmRange('MAT.11.28-30')).toBe('MAT.11.28-30');
  });

  it('leaves cross-chapter long-form ranges unchanged (not supported short-form)', () => {
    expect(normalizeUsfmRange('MAT.11.28-MAT.12.2')).toBe('MAT.11.28-MAT.12.2');
  });
});

describe('YouVersionClient construction', () => {
  it('throws if apiKey is missing', () => {
    expect(() => new YouVersionClient({ apiKey: '' })).toThrow(YouVersionClientError);
  });
});

describe('YouVersionClient.getVerse — success path', () => {
  it('fetches a passage, validates against the index, and builds attribution from bible detail', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex()) },
      {
        match: (p) => p.includes('/passages/'),
        respond: () =>
          jsonRes({
            id: 'MAT.11.28-30',
            content: 'Come to Me, all you who are weary and burdened, and I will give you rest.',
            reference: 'Matthew 11:28-30',
          }),
      },
      {
        match: (p) => p === `/v1/bibles/${BSB}`,
        respond: () => jsonRes(fakeBibleDetail(BSB, { copyright: 'Public Domain' })),
      },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });

    const result = await client.getVerse('MAT.11.28-MAT.11.30', BSB);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.usfm).toBe('MAT.11.28-30');
      expect(result.data.versionId).toBe(BSB);
      expect(result.data.text).toContain('Come to Me');
      expect(result.data.attribution).toContain('Berean Standard Bible');
      expect(result.data.attribution).toContain('Public Domain');
      expect(result.meta.source).toBe('youversion');
      expect(() => new Date(result.meta.fetched_at).toISOString()).not.toThrow();
    }
  });

  it('falls back to "Version {id}" attribution when bible detail is unavailable', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      {
        match: (p) => p.includes('/passages/'),
        respond: () => jsonRes({ id: 'JHN.3.16', content: 'For God so loved the world...', reference: 'John 3:16' }),
      },
      { match: (p) => p === `/v1/bibles/${ASV}`, respond: () => emptyRes(500) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });

    const result = await client.getVerse('JHN.3.16', ASV);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.attribution).toBe(`Version ${ASV}`);
  });
});

describe('YouVersionClient.getVerse — error mapping (canonical tool envelope)', () => {
  it('maps empty/whitespace usfm to INVALID_ARGUMENT', async () => {
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl: routedFetch([]) });
    const result = await client.getVerse('   ', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('maps a non-positive-integer versionId to INVALID_ARGUMENT', async () => {
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl: routedFetch([]) });
    const result = await client.getVerse('JHN.3.16', -1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('maps a malformed USFM shape to INVALID_ARGUMENT without hitting the network', async () => {
    const fetchImpl = vi.fn();
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike });
    const result = await client.getVerse('not-a-real-ref', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.retryable).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps an unknown book (index validation) to INVALID_ARGUMENT', async () => {
    const fetchImpl = routedFetch([{ match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('MAT')) }]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('XYZ.1.1', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('maps an out-of-range verse (index validation) to REFERENCE_OUT_OF_RANGE', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('MAT', '11', 30)) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('MAT.11.999', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('REFERENCE_OUT_OF_RANGE');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('maps an unknown chapter (index validation) to REFERENCE_OUT_OF_RANGE', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('MAT', '11', 30)) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('MAT.99.1', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('REFERENCE_OUT_OF_RANGE');
  });

  it('maps HTTP 401 to AUTH_FAILED (bad app key)', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      {
        match: (p) => p.includes('/passages/'),
        respond: () => jsonRes({ fault: { faultstring: 'Invalid ApiKey' } }, 401),
      },
    ]);
    const client = new YouVersionClient({ apiKey: 'bad-key', fetchImpl });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AUTH_FAILED');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('maps HTTP 403 to BIBLE_NOT_FOUND when GET /v1/bibles/{id} 404s (genuinely unknown id)', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ message: 'Access denied for 999999' }, 403) },
      { match: (p) => p === '/v1/bibles/999999', respond: () => jsonRes({ message: 'not found' }, 404) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('JHN.3.16', 999999);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BIBLE_NOT_FOUND');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('maps HTTP 403 to LICENSE_UNAVAILABLE when GET /v1/bibles/{id} 200s (real but unlicensed id, e.g. NIV 111)', async () => {
    const NIV = 111;
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ message: `Access denied for ${NIV}` }, 403) },
      { match: (p) => p === `/v1/bibles/${NIV}`, respond: () => jsonRes(fakeBibleDetail(NIV, { abbreviation: 'NIV' })) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('JHN.3.16', NIV);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('LICENSE_UNAVAILABLE');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('maps HTTP 404 on the passage itself to PASSAGE_NOT_FOUND', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      {
        match: (p) => p.includes('/passages/'),
        respond: () => jsonRes({ message: 'Bible passage JHN.3.99 for version 3034 not found' }, 404),
      },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    // Bypass local index validation catching this by using a verse count that allows it through,
    // simulating an index/passage mismatch surfaced only by the live API.
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PASSAGE_NOT_FOUND');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('maps HTTP 204 on the passage to PASSAGE_NOT_FOUND', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => emptyRes(204) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PASSAGE_NOT_FOUND');
  });

  it('maps a 200 response with empty content to PASSAGE_NOT_FOUND', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ id: 'JHN.3.16', content: '' }) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PASSAGE_NOT_FOUND');
  });

  it('maps HTTP 422 to INVALID_ARGUMENT', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      {
        match: (p) => p.includes('/passages/'),
        respond: () => jsonRes({ detail: [{ type: 'int_parsing' }] }, 422),
      },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('maps HTTP 429 to RATE_LIMITED and marks it retryable', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ message: 'rate limited' }, 429) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RATE_LIMITED');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('maps HTTP 5xx to UPSTREAM_UNAVAILABLE and marks it retryable', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ message: 'boom' }, 503) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('catches a network-level transport failure and returns a retryable UPSTREAM_UNAVAILABLE envelope instead of throwing out of the tool loop (issue #73)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as FetchLike;
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl, retrySleep: async () => {}, retryRandom: () => 0 });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(result.error.retryable).toBe(true);
    }
    // The index fetch (inside validateReference) and the passage fetch each
    // independently retry 3x (1 initial + 2 retries) before giving up.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('maps HTTP 400 to INVALID_ARGUMENT (non-retryable)', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ message: 'bad request' }, 400) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('does not re-fetch the index on repeated calls for the same version (per-process cache)', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ id: 'JHN.3.16', content: 'text' }) },
      { match: (p) => p === `/v1/bibles/${BSB}`, respond: () => jsonRes(fakeBibleDetail(BSB)) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    await client.getVerse('JHN.3.16', BSB);
    await client.getVerse('JHN.3.17', BSB);
    const indexCalls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter(([url]: [string]) =>
      url.includes('/index'),
    );
    expect(indexCalls.length).toBe(1);
  });
});

describe('YouVersionClient outbound-call hardening (issue #73)', () => {
  it('passes an AbortSignal (10s timeout budget) on every request', async () => {
    const fetchImpl = routedFetch([{ match: () => true, respond: () => jsonRes({ data: [fakeBibleDetail(BSB)] }) }]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    await client.listBibles(['en']);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    let passageCalls = 0;
    const sleepCalls: number[] = [];
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      {
        match: (p) => p.includes('/passages/'),
        respond: () => {
          passageCalls += 1;
          if (passageCalls === 1) {
            return {
              ok: false,
              status: 429,
              headers: { get: (name: string) => (name === 'retry-after' ? '4' : null) },
              json: async () => ({}),
              text: async () => 'rate limited',
            };
          }
          return jsonRes({ id: 'JHN.3.16', content: 'For God so loved the world...' });
        },
      },
      { match: (p) => p === `/v1/bibles/${BSB}`, respond: () => jsonRes(fakeBibleDetail(BSB)) },
    ]);
    const client = new YouVersionClient({
      apiKey: 'k',
      fetchImpl,
      retrySleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(true);
    expect(sleepCalls).toEqual([4000]);
  });

  it('retries a 5xx up to the full budget (max 2 retries), then returns UPSTREAM_UNAVAILABLE', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ message: 'boom' }, 503) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl, retrySleep: async () => {}, retryRandom: () => 0 });
    const result = await client.getVerse('JHN.3.16', BSB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UPSTREAM_UNAVAILABLE');

    const passageCalls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter(([url]: [string]) =>
      url.includes('/passages/'),
    );
    expect(passageCalls.length).toBe(3); // 1 initial + 2 retries
  });

  it('does not retry a non-retryable 4xx (e.g. 400)', async () => {
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ message: 'bad' }, 400) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl, retrySleep: async () => {} });
    await client.getVerse('JHN.3.16', BSB);
    const passageCalls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter(([url]: [string]) =>
      url.includes('/passages/'),
    );
    expect(passageCalls.length).toBe(1);
  });

  it('recovers from a transient bibleDetail-cache rejection instead of poisoning it forever (issue #73)', async () => {
    let getVerseCallCount = 0;
    const fetchImpl = routedFetch([
      { match: (p) => p.includes('/index'), respond: () => jsonRes(fakeIndex('JHN', '3', 36)) },
      { match: (p) => p.includes('/passages/'), respond: () => jsonRes({ id: 'JHN.3.16', content: 'text' }) },
      {
        match: (p) => p === `/v1/bibles/${BSB}`,
        respond: () => {
          getVerseCallCount += 1;
          // Fail EVERY attempt during the first getVerse() call (index +
          // passage together take 2 fetches before bibleDetail's own 3
          // internal retry attempts run) with a non-2xx/non-404 status, so
          // getBibleDetail's cached promise rejects on the first getVerse()
          // call; succeed unconditionally afterwards.
          if (getVerseCallCount <= 3) {
            return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => 'boom' };
          }
          return jsonRes(fakeBibleDetail(BSB, { copyright: 'Public Domain' }));
        },
      },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl, retrySleep: async () => {}, retryRandom: () => 0 });

    // First call: bibleDetail's own request() retries internally on the 500
    // (3 attempts) and still fails -> getBibleDetail's promise rejects ->
    // attribution falls back to "Version {id}" (getVerse swallows via .catch()).
    const first = await client.getVerse('JHN.3.16', BSB);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.attribution).toBe(`Version ${BSB}`);

    // Second call: the cache must have been cleared on rejection, so this
    // retries the bible-detail fetch fresh and succeeds this time — proving
    // the cache does NOT permanently pin the earlier failure.
    const second = await client.getVerse('JHN.3.16', BSB);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.attribution).toContain('Berean Standard Bible');
      expect(second.data.attribution).toContain('Public Domain');
    }
  });
});

describe('YouVersionClient.listBibles', () => {
  it('returns the catalog on success', async () => {
    const fetchImpl = routedFetch([
      { match: () => true, respond: () => jsonRes({ data: [fakeBibleDetail(BSB), fakeBibleDetail(ASV, { abbreviation: 'ASV' })] }) },
    ]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.listBibles(['en']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.length).toBe(2);
  });

  it('maps a 204 to NO_BIBLES_AVAILABLE', async () => {
    const fetchImpl = routedFetch([{ match: () => true, respond: () => emptyRes(204) }]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.listBibles(['en']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_BIBLES_AVAILABLE');
  });

  it('maps an empty data array to NO_BIBLES_AVAILABLE', async () => {
    const fetchImpl = routedFetch([{ match: () => true, respond: () => jsonRes({ data: [] }) }]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.listBibles(['en']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_BIBLES_AVAILABLE');
  });

  it('maps a 401 to AUTH_FAILED', async () => {
    const fetchImpl = routedFetch([{ match: () => true, respond: () => jsonRes({ message: 'no' }, 401) }]);
    const client = new YouVersionClient({ apiKey: 'k', fetchImpl });
    const result = await client.listBibles(['en']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_FAILED');
  });
});
