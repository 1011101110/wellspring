import { describe, it, expect } from 'vitest';
import {
  GetBibleVerseEnvelopeSchema,
  ToolErrorCodeSchema,
  CANONICAL_ERROR_CODES,
  GetBibleVerseArgsSchema,
  GET_BIBLE_VERSE_TOOL_NAME,
} from '../src/index.js';

describe('tool envelope — success shape', () => {
  it('accepts a well-formed get_bible_verse success envelope', () => {
    const envelope = {
      ok: true,
      data: {
        usfm: 'JHN.3.16',
        versionId: 111,
        reference: 'John 3:16',
        text: 'For God so loved the world...',
        attribution: 'New International Version (NIV)',
      },
      meta: { source: 'youversion', fetched_at: '2026-07-02T12:00:00Z' },
    };
    expect(GetBibleVerseEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('rejects a success envelope with ok:true but missing data', () => {
    const envelope = {
      ok: true,
      meta: { source: 'youversion', fetched_at: '2026-07-02T12:00:00Z' },
    };
    expect(GetBibleVerseEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('rejects a success envelope with a non-ISO8601 fetched_at', () => {
    const envelope = {
      ok: true,
      data: { usfm: 'JHN.3.16', versionId: 111, text: 'x', attribution: 'y' },
      meta: { source: 'youversion', fetched_at: 'not-a-date' },
    };
    expect(GetBibleVerseEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });
});

describe('tool envelope — error shape', () => {
  it('accepts a well-formed error envelope with a canonical code', () => {
    const envelope = {
      ok: false,
      error: { code: 'PASSAGE_NOT_FOUND', message: 'No such passage', retryable: false },
      meta: { source: 'youversion', fetched_at: '2026-07-02T12:00:00Z' },
    };
    expect(GetBibleVerseEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('covers every canonical error code from Foundation §4.5', () => {
    expect(CANONICAL_ERROR_CODES).toEqual([
      'INVALID_ARGUMENT',
      'AUTH_FAILED',
      'LICENSE_UNAVAILABLE',
      'NO_BIBLES_AVAILABLE',
      'BIBLE_NOT_FOUND',
      'PASSAGE_NOT_FOUND',
      'REFERENCE_OUT_OF_RANGE',
      'RATE_LIMITED',
      'UPSTREAM_UNAVAILABLE',
      'AUDIO_UNAVAILABLE',
    ]);
    for (const code of CANONICAL_ERROR_CODES) {
      expect(ToolErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('rejects a retired/unknown error code', () => {
    expect(ToolErrorCodeSchema.safeParse('NOT_FOUND').success).toBe(false);
    expect(ToolErrorCodeSchema.safeParse('TIMEOUT').success).toBe(false);
  });

  it('rejects an error envelope missing retryable', () => {
    const envelope = {
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      meta: { source: 'youversion', fetched_at: '2026-07-02T12:00:00Z' },
    };
    expect(GetBibleVerseEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('rejects an envelope that is neither a clean success nor a clean error (ok:true + error field)', () => {
    const envelope = {
      ok: true,
      error: { code: 'RATE_LIMITED', message: 'x', retryable: true },
      meta: { source: 'youversion', fetched_at: '2026-07-02T12:00:00Z' },
    };
    // discriminatedUnion requires `data` when ok:true, regardless of extra fields
    expect(GetBibleVerseEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });
});

describe('get_bible_verse tool definition', () => {
  it('canonical tool name is exactly "get_bible_verse"', () => {
    expect(GET_BIBLE_VERSE_TOOL_NAME).toBe('get_bible_verse');
  });

  it('accepts args with usfm + versionId, reason optional', () => {
    expect(GetBibleVerseArgsSchema.safeParse({ usfm: 'JHN.3.16', versionId: 111 }).success).toBe(
      true,
    );
    expect(
      GetBibleVerseArgsSchema.safeParse({
        usfm: 'MAT.11.28-MAT.11.30',
        versionId: 3034,
        reason: 'fits a heavy day',
      }).success,
    ).toBe(true);
  });

  it('rejects args missing versionId', () => {
    expect(GetBibleVerseArgsSchema.safeParse({ usfm: 'JHN.3.16' }).success).toBe(false);
  });
});
