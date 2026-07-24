/**
 * U3 (#356) session-completion wiring + proof line.
 *  - completeSession fires the highlight writer FIRE-AND-FORGET on first
 *    completion, and Amen is unaffected when the writer rejects (fail-open);
 *  - a second (idempotent) Amen never re-fires it;
 *  - renderSessionCompletePage shows the "Saved to your YouVersion highlights."
 *    proof line ONLY in the written state.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionService } from '../../../src/services/session/sessionService.js';
import { renderSessionCompletePage } from '../../../src/services/session/renderSessionPage.js';
import type { SessionsRepository, DevotionalsRepository } from '../../../src/db/repositories/index.js';
import type { AudioStorage } from '../../../src/services/audio/audioStorage.js';

const NOW = new Date('2026-07-24T12:00:00Z');

function buildService(opts: {
  completedAt?: Date | null;
  writerImpl?: () => Promise<'written'>;
} = {}) {
  const sessionRow = {
    token: 'tok-1',
    user_id: 'user-1',
    devotional_id: 'devo-1',
    expires_at: new Date('2026-08-01T00:00:00Z'),
    completed_at: opts.completedAt ?? null,
    joined_at: NOW,
  };
  const markCompleted = vi.fn().mockResolvedValue({ ...sessionRow, completed_at: NOW });
  const sessions = {
    findByToken: vi.fn().mockResolvedValue(sessionRow),
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
  return { service, writeHighlightForDevotional, markCompleted };
}

describe('completeSession — highlight write hook (U3 #356)', () => {
  it('fires the writer once on first completion, with the owner + devotional id', async () => {
    const h = buildService();
    const result = await h.service.completeSession('tok-1');
    expect(result.kind).toBe('ok');
    expect(h.writeHighlightForDevotional).toHaveBeenCalledTimes(1);
    expect(h.writeHighlightForDevotional).toHaveBeenCalledWith('user-1', 'devo-1');
  });

  it('Amen succeeds even when the writer REJECTS (fail-open — a YouVersion outage never breaks completion)', async () => {
    const h = buildService({ writerImpl: () => Promise.reject(new Error('yv down (test)')) });
    // completeSession must resolve ok despite the rejected fire-and-forget.
    const result = await h.service.completeSession('tok-1');
    expect(result.kind).toBe('ok');
    // Let the microtask queue drain so the .catch runs without an unhandled rejection.
    await Promise.resolve();
  });

  it('a second (already-completed) Amen never re-fires the writer', async () => {
    const h = buildService({ completedAt: new Date('2026-07-24T11:00:00Z') });
    await h.service.completeSession('tok-1');
    expect(h.writeHighlightForDevotional).not.toHaveBeenCalled();
    expect(h.markCompleted).not.toHaveBeenCalled();
  });
});

describe('renderSessionCompletePage — proof line only in the written state (U3 #356)', () => {
  it('shows the line when youVersionHighlightSaved is true', () => {
    const html = renderSessionCompletePage({
      token: 'tok-1',
      feedbackSubmitted: true,
      youVersionHighlightSaved: true,
    });
    expect(html).toContain('Saved to your YouVersion highlights.');
  });

  it('omits the line when the highlight was not saved (never advertises/nags)', () => {
    const saved = renderSessionCompletePage({ token: 'tok-1', feedbackSubmitted: true, youVersionHighlightSaved: false });
    const absent = renderSessionCompletePage({ token: 'tok-1', feedbackSubmitted: true });
    expect(saved).not.toContain('Saved to your YouVersion highlights.');
    expect(absent).not.toContain('Saved to your YouVersion highlights.');
  });
});
