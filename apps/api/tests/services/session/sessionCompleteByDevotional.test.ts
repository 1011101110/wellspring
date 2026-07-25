/**
 * #3 — the authenticated "Amen" (`SessionService.completeByDevotionalId`) the
 * web + iOS dashboard readers post to. It shares the completion + highlight
 * path with the capability-token `completeSession`, so these focus only on what
 * is new: resolving the session BY (userId, devotionalId) rather than by token,
 * and that the shared side effects (highlight write, idempotency) carry through.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionService } from '../../../src/services/session/sessionService.js';
import type { SessionsRepository, DevotionalsRepository } from '../../../src/db/repositories/index.js';
import type { AudioStorage } from '../../../src/services/audio/audioStorage.js';

const NOW = new Date('2026-07-24T12:00:00Z');

function buildService(opts: {
  sessionRow?: unknown;
  completedAt?: Date | null;
  writerImpl?: () => Promise<'written'>;
} = {}) {
  const sessionRow =
    opts.sessionRow === undefined
      ? {
          token: 'tok-1',
          user_id: 'user-1',
          devotional_id: 'devo-1',
          // Deliberately in the PAST — the authed path has no expiry gate, so an
          // old devotional reopened from History can still be completed.
          expires_at: new Date('2026-07-01T00:00:00Z'),
          completed_at: opts.completedAt ?? null,
          joined_at: NOW,
        }
      : opts.sessionRow;

  const markCompleted = vi.fn().mockResolvedValue({ ...(sessionRow as object), completed_at: NOW });
  const findByDevotionalIdForUser = vi.fn().mockResolvedValue(sessionRow);
  const sessions = {
    findByDevotionalIdForUser,
    markCompleted,
  } as unknown as SessionsRepository;
  const devotionals = { getById: vi.fn().mockResolvedValue(null) } as unknown as DevotionalsRepository;
  const audioStorage = {} as unknown as AudioStorage;

  const writeHighlightForDevotional = vi
    .fn()
    .mockImplementation(opts.writerImpl ?? (() => Promise.resolve('written' as const)));

  const service = new SessionService({
    sessions,
    devotionals,
    audioStorage,
    now: () => NOW,
    logger: { error: vi.fn() },
    highlightWriter: { writeHighlightForDevotional },
  });
  return { service, findByDevotionalIdForUser, markCompleted, writeHighlightForDevotional };
}

describe('completeByDevotionalId — authed dashboard Amen (#3)', () => {
  it('resolves the session by (userId, devotionalId), completes it, and fires the highlight write once', async () => {
    const h = buildService();
    const result = await h.service.completeByDevotionalId('user-1' as never, 'devo-1');

    expect(result).toEqual({ kind: 'ok', completedAt: NOW });
    expect(h.findByDevotionalIdForUser).toHaveBeenCalledWith('user-1', 'devo-1');
    // Marks the RESOLVED row's own token complete (not a token the caller had).
    expect(h.markCompleted).toHaveBeenCalledWith('user-1', 'tok-1', null);
    expect(h.writeHighlightForDevotional).toHaveBeenCalledTimes(1);
    expect(h.writeHighlightForDevotional).toHaveBeenCalledWith('user-1', 'devo-1');
  });

  it('is a no-op highlight-wise on an already-completed session (idempotent — Amen is a one-way door)', async () => {
    const already = new Date('2026-07-24T11:00:00Z');
    const h = buildService({ completedAt: already });
    const result = await h.service.completeByDevotionalId('user-1' as never, 'devo-1');

    expect(result).toEqual({ kind: 'ok', completedAt: already });
    expect(h.markCompleted).not.toHaveBeenCalled();
    expect(h.writeHighlightForDevotional).not.toHaveBeenCalled();
  });

  it('returns not_found when the user has no session for the devotional (route → 404, never 403)', async () => {
    const h = buildService({ sessionRow: null });
    const result = await h.service.completeByDevotionalId('user-1' as never, 'devo-missing');

    expect(result).toEqual({ kind: 'not_found' });
    expect(h.markCompleted).not.toHaveBeenCalled();
    expect(h.writeHighlightForDevotional).not.toHaveBeenCalled();
  });

  it('completion succeeds even when the highlight writer REJECTS (fail-open — a YouVersion outage never breaks Amen)', async () => {
    const h = buildService({ writerImpl: () => Promise.reject(new Error('yv down (test)')) });
    const result = await h.service.completeByDevotionalId('user-1' as never, 'devo-1');

    expect(result.kind).toBe('ok');
    // Drain the microtask queue so the fire-and-forget .catch runs (no unhandled rejection).
    await Promise.resolve();
  });
});
