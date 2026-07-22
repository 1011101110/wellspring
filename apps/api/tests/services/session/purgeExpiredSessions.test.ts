import { describe, expect, it, vi } from 'vitest';
import {
  purgeExpiredSessions,
  SESSION_PURGE_RETENTION_DAYS,
} from '../../../src/services/session/purgeExpiredSessions.js';
import type { SessionsRepository } from '../../../src/db/repositories/index.js';

function fakeSessionsRepo(): {
  repo: SessionsRepository;
  purgeExpiredBefore: ReturnType<typeof vi.fn>;
} {
  const purgeExpiredBefore = vi.fn().mockResolvedValue(3);
  const repo = { purgeExpiredBefore } as unknown as SessionsRepository;
  return { repo, purgeExpiredBefore };
}

describe('purgeExpiredSessions', () => {
  it('purges rows with expires_at more than the retention window in the past', async () => {
    const { repo, purgeExpiredBefore } = fakeSessionsRepo();
    const now = new Date('2026-07-20T00:00:00.000Z');

    const count = await purgeExpiredSessions(repo, { now: () => now });

    expect(count).toBe(3);
    expect(purgeExpiredBefore).toHaveBeenCalledTimes(1);
    const cutoffArg = purgeExpiredBefore.mock.calls[0][0] as Date;
    const expectedCutoff = new Date(
      now.getTime() - SESSION_PURGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(cutoffArg.toISOString()).toBe(expectedCutoff.toISOString());
  });

  it('honors a custom retentionDays override', async () => {
    const { repo, purgeExpiredBefore } = fakeSessionsRepo();
    const now = new Date('2026-07-20T00:00:00.000Z');

    await purgeExpiredSessions(repo, { now: () => now, retentionDays: 1 });

    const cutoffArg = purgeExpiredBefore.mock.calls[0][0] as Date;
    expect(cutoffArg.toISOString()).toBe(
      new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    );
  });
});
