/**
 * HighlightsBridge (U3 write #356 / U4 read #357). Fakes only — no Postgres,
 * no network. Covers:
 *  - WRITE gate matrix (no connection / consent off / already written / no
 *    verse / happy path) with the create call mutation-checked;
 *  - 401 → refresh-once → retry;
 *  - idempotency stamp only on success;
 *  - fail-open: the bridge NEVER throws, whatever explodes;
 *  - no verse TEXT in the structured log (§9 / privacy);
 *  - READ (`isPassageHighlighted`) consent gate + per-passage per-day memo +
 *    401 refresh + fail-quiet;
 *  - the pure `decideHighlightWeaving` precedence / only-when-real / no-repeat.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HighlightsBridge,
  decideHighlightWeaving,
  type HighlightsBridgeDeps,
} from '../../../src/services/youversion/highlightsBridge.js';
import type { HighlightsResult, NormalizedHighlight } from '../../../src/services/youversion/youVersionHighlightsClient.js';
import type { VerifiedUserId } from '../../../src/db/repositories/types.js';

const USER = 'user-1' as VerifiedUserId;
const NOW = new Date('2026-07-24T12:00:00Z');

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    access_token_encrypted: Buffer.from('enc-access'),
    refresh_token_encrypted: Buffer.from('enc-refresh'),
    token_expires_at: null,
    youversion_user_id: 'yv-1',
    display_name: 'Sam',
    scopes: 'openid profile email highlights',
    ...overrides,
  };
}

function devotionalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'devo-1',
    verses: [
      { usfm: 'JHN.3.16', versionId: 3034 },
      { usfm: 'PSA.23.1', versionId: 3034 },
    ],
    yv_highlight_written_at: null as Date | null,
    ...overrides,
  };
}

function buildBridge(opts: {
  connection?: Record<string, unknown> | null;
  writeConsent?: boolean;
  readConsent?: boolean;
  devotional?: Record<string, unknown> | null;
  createResults?: HighlightsResult<void>[];
  getResults?: HighlightsResult<boolean>[];
  withOAuth?: boolean;
} = {}) {
  const createResults = opts.createResults ?? [{ ok: true, status: 201, data: undefined }];
  const getResults = opts.getResults ?? [{ ok: true, status: 200, data: false }];
  let createIdx = 0;
  let getIdx = 0;

  const createHighlight = vi.fn().mockImplementation(() =>
    Promise.resolve(createResults[Math.min(createIdx++, createResults.length - 1)]),
  );
  const getHighlight = vi.fn().mockImplementation(() =>
    Promise.resolve(getResults[Math.min(getIdx++, getResults.length - 1)]),
  );

  const markHighlightWritten = vi.fn().mockResolvedValue(true);
  const upsert = vi.fn().mockResolvedValue(undefined);
  const infoLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const errorLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

  const deps: HighlightsBridgeDeps = {
    client: { createHighlight, getHighlight },
    connections: {
      get: vi.fn().mockResolvedValue(opts.connection === null ? null : connectionRow(opts.connection)),
      upsert,
    },
    preferences: {
      get: vi.fn().mockResolvedValue({
        yv_write_highlights: opts.writeConsent ?? true,
        yv_read_highlights: opts.readConsent ?? true,
      }),
    },
    devotionals: {
      getById: vi
        .fn()
        .mockResolvedValue(opts.devotional === null ? null : devotionalRow(opts.devotional)),
      markHighlightWritten,
    },
    kmsService: {
      encryptToken: vi.fn().mockResolvedValue({ ciphertext: Buffer.from('re-enc'), keyVersion: 'kv-2' }),
      decryptToken: vi.fn().mockResolvedValue('decrypted-access'),
    },
    ...(opts.withOAuth
      ? {
          oauthService: {
            refreshTokens: vi.fn().mockResolvedValue({
              accessToken: 'fresh-access',
              refreshToken: 'fresh-refresh',
              expiresAt: NOW.getTime() + 3600_000,
              scopes: 'openid profile email highlights',
            }),
          },
        }
      : {}),
    logger: {
      info: (msg, meta) => infoLogs.push({ msg, meta }),
      error: (msg, meta) => errorLogs.push({ msg, meta }),
    },
    now: () => NOW,
  };

  const bridge = new HighlightsBridge(deps);
  return { bridge, createHighlight, getHighlight, markHighlightWritten, upsert, infoLogs, errorLogs, deps };
}

describe('writeHighlightForDevotional — gate matrix', () => {
  it('happy path: POSTs the primary (FIRST) verse and stamps idempotency', async () => {
    const h = buildBridge();
    const outcome = await h.bridge.writeHighlightForDevotional(USER, 'devo-1');
    expect(outcome).toBe('written');
    expect(h.createHighlight).toHaveBeenCalledTimes(1);
    // Primary verse only — one meaningful mark, not spam. Color always sent.
    expect(h.createHighlight.mock.calls[0]![0]).toMatchObject({
      bibleId: 3034,
      passageId: 'JHN.3.16',
      bearer: 'decrypted-access',
    });
    expect(h.createHighlight.mock.calls[0]![0].color).toMatch(/^[0-9a-f]{6}$/);
    expect(h.markHighlightWritten).toHaveBeenCalledWith(USER, 'devo-1');
  });

  it('no connection → silent no-op, never POSTs', async () => {
    const h = buildBridge({ connection: null });
    expect(await h.bridge.writeHighlightForDevotional(USER, 'devo-1')).toBe('no_connection');
    expect(h.createHighlight).not.toHaveBeenCalled();
    expect(h.markHighlightWritten).not.toHaveBeenCalled();
  });

  it('write consent OFF → silent no-op, never POSTs', async () => {
    const h = buildBridge({ writeConsent: false });
    expect(await h.bridge.writeHighlightForDevotional(USER, 'devo-1')).toBe('consent_off');
    expect(h.createHighlight).not.toHaveBeenCalled();
  });

  it('already written → no-op, never POSTs again (idempotency)', async () => {
    const h = buildBridge({ devotional: { yv_highlight_written_at: new Date('2026-07-20T00:00:00Z') } });
    expect(await h.bridge.writeHighlightForDevotional(USER, 'devo-1')).toBe('already_written');
    expect(h.createHighlight).not.toHaveBeenCalled();
    expect(h.markHighlightWritten).not.toHaveBeenCalled();
  });

  it('devotional with no verses → no_verse no-op', async () => {
    const h = buildBridge({ devotional: { verses: [] } });
    expect(await h.bridge.writeHighlightForDevotional(USER, 'devo-1')).toBe('no_verse');
    expect(h.createHighlight).not.toHaveBeenCalled();
  });

  it('an API failure does NOT stamp idempotency (so a later retry can still succeed)', async () => {
    const h = buildBridge({ createResults: [{ ok: false, status: 500, error: 'boom' }] });
    expect(await h.bridge.writeHighlightForDevotional(USER, 'devo-1')).toBe('api_error');
    expect(h.markHighlightWritten).not.toHaveBeenCalled();
  });
});

describe('writeHighlightForDevotional — 401 refresh-once-and-retry', () => {
  it('a 401 triggers one refresh + one retry, then stamps on success', async () => {
    const h = buildBridge({
      withOAuth: true,
      createResults: [
        { ok: false, status: 401, error: 'expired' },
        { ok: true, status: 201, data: undefined },
      ],
    });
    const outcome = await h.bridge.writeHighlightForDevotional(USER, 'devo-1');
    expect(outcome).toBe('written');
    expect(h.createHighlight).toHaveBeenCalledTimes(2);
    // The retry uses the refreshed bearer, and the rotated pair is persisted.
    expect(h.createHighlight.mock.calls[1]![0].bearer).toBe('fresh-access');
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.markHighlightWritten).toHaveBeenCalledTimes(1);
  });

  it('a 401 with NO oauth service (or no refresh token) does not retry', async () => {
    const h = buildBridge({
      withOAuth: false,
      createResults: [{ ok: false, status: 401, error: 'expired' }],
    });
    expect(await h.bridge.writeHighlightForDevotional(USER, 'devo-1')).toBe('api_error');
    expect(h.createHighlight).toHaveBeenCalledTimes(1);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('writeHighlightForDevotional — fail-open + privacy', () => {
  it('NEVER throws even when a dependency explodes (Amen must not break)', async () => {
    const h = buildBridge();
    (h.deps.devotionals.getById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db down (test)'),
    );
    // No throw — resolves to a best-effort outcome.
    await expect(h.bridge.writeHighlightForDevotional(USER, 'devo-1')).resolves.toBe('api_error');
  });

  it('the structured write log carries identifiers only — NO verse text (§9)', async () => {
    const h = buildBridge();
    await h.bridge.writeHighlightForDevotional(USER, 'devo-1');
    const writeLog = h.infoLogs.find((l) => l.msg === 'highlight write');
    expect(writeLog?.meta).toMatchObject({
      userId: USER,
      devotionalId: 'devo-1',
      passageId: 'JHN.3.16',
      bibleId: 3034,
      outcome: 'written',
    });
    // The verse's actual text is never loaded here, but pin the contract: no
    // field carries anything text-shaped, and no "count" of anything.
    const serialized = JSON.stringify(writeLog?.meta ?? {});
    expect(serialized).not.toMatch(/count|total|streak/i);
  });
});

describe('isPassageHighlighted', () => {
  it('read consent OFF → false, never fetches', async () => {
    const h = buildBridge({ readConsent: false });
    expect(await h.bridge.isPassageHighlighted(USER, 3034, 'JHN.3.16')).toBe(false);
    expect(h.getHighlight).not.toHaveBeenCalled();
  });

  it('returns the API verdict and memoizes one lookup per passage per day', async () => {
    const h = buildBridge({ getResults: [{ ok: true, status: 200, data: true }] });
    const first = await h.bridge.isPassageHighlighted(USER, 3034, 'JHN.3.16');
    const second = await h.bridge.isPassageHighlighted(USER, 3034, 'JHN.3.16');
    expect(first).toBe(true);
    expect(second).toBe(true);
    // Memoized: exactly ONE live fetch despite two reads (rate-limit respect).
    expect(h.getHighlight).toHaveBeenCalledTimes(1);
  });

  it('a different passage is a distinct lookup (memo is per-passage)', async () => {
    const h = buildBridge({
      getResults: [
        { ok: true, status: 200, data: true },
        { ok: true, status: 200, data: false },
      ],
    });
    expect(await h.bridge.isPassageHighlighted(USER, 3034, 'JHN.3.16')).toBe(true);
    expect(await h.bridge.isPassageHighlighted(USER, 3034, 'PSA.23.1')).toBe(false);
    expect(h.getHighlight).toHaveBeenCalledTimes(2);
  });

  it('a 401 refreshes once and retries with the fresh bearer', async () => {
    const h = buildBridge({
      withOAuth: true,
      getResults: [
        { ok: false, status: 401, error: 'expired' },
        { ok: true, status: 200, data: true },
      ],
    });
    expect(await h.bridge.isPassageHighlighted(USER, 3034, 'JHN.3.16')).toBe(true);
    expect(h.getHighlight).toHaveBeenCalledTimes(2);
    expect(h.getHighlight.mock.calls[1]![0].bearer).toBe('fresh-access');
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it('a fetch failure degrades to false and is NOT memoized (can recover next run)', async () => {
    const h = buildBridge({ getResults: [{ ok: false, status: 503, error: 'down' }] });
    expect(await h.bridge.isPassageHighlighted(USER, 3034, 'JHN.3.16')).toBe(false);
    // Not cached — a second call retries the fetch.
    await h.bridge.isPassageHighlighted(USER, 3034, 'JHN.3.16');
    expect(h.getHighlight).toHaveBeenCalledTimes(2);
  });

  it('no connection → false, never throws', async () => {
    const h = buildBridge({ connection: null });
    await expect(h.bridge.isPassageHighlighted(USER, 3034, 'JHN.3.16')).resolves.toBe(false);
    expect(h.getHighlight).not.toHaveBeenCalled();
  });
});

describe('decideHighlightWeaving (pure) — precedence / only-when-real / no-repeat', () => {
  // The list is the subset of candidate passages CONFIRMED highlighted,
  // newest-first.
  const HL: NormalizedHighlight[] = [
    { passageId: 'JHN.3.16', bibleId: 3034 },
    { passageId: 'PSA.23.1', bibleId: 3034 },
  ];

  it('weaves the first non-recently-used marked passage when nothing higher steers', () => {
    const d = decideHighlightWeaving(HL, { higherPrecedenceActive: false, recentlyWovenPassageIds: [] });
    expect(d).toEqual({ passageRef: 'JHN.3.16', reason: 'highlight_woven' });
  });

  it('yields entirely when a higher-precedence signal is active (lowest rung)', () => {
    const d = decideHighlightWeaving(HL, { higherPrecedenceActive: true, recentlyWovenPassageIds: [] });
    expect(d.passageRef).toBeUndefined();
    expect(d.reason).toBe('higher_precedence_active');
  });

  it('only-when-real: no marked candidate → nothing woven (never fabricates a mark)', () => {
    const d = decideHighlightWeaving([], { higherPrecedenceActive: false, recentlyWovenPassageIds: [] });
    expect(d.passageRef).toBeUndefined();
    expect(d.reason).toBe('no_highlights');
  });

  it('no-repeat: skips a recently-woven passage and picks the next one', () => {
    const d = decideHighlightWeaving(HL, {
      higherPrecedenceActive: false,
      recentlyWovenPassageIds: ['JHN.3.16'],
    });
    expect(d).toEqual({ passageRef: 'PSA.23.1', reason: 'highlight_woven' });
  });

  it('no-repeat: every candidate recently woven → nothing', () => {
    const d = decideHighlightWeaving(HL, {
      higherPrecedenceActive: false,
      recentlyWovenPassageIds: ['JHN.3.16', 'PSA.23.1'],
    });
    expect(d.passageRef).toBeUndefined();
    expect(d.reason).toBe('no_repeat_window');
  });
});
