/**
 * Session purge job (EPIC D, issue #33). Retention rule per
 * docs/04_DATA_PRIVACY_SECURITY.md and `SessionsRepository.purgeExpiredBefore`
 * doc comment: session rows are purged 7 days after `expires_at` (which
 * is itself event-end + 48h, docs/04 §5.1). This is a thin, independently
 * testable wrapper around `SessionsRepository.purgeExpiredBefore` so it
 * can be invoked from a Cloud Scheduler-triggered internal route (a
 * later stage — no internal routes exist yet in this repo) or a cron
 * script, without duplicating the retention-window math at each call
 * site.
 */
import type { SessionsRepository } from '../../db/repositories/index.js';

export const SESSION_PURGE_RETENTION_DAYS = 7;

export interface PurgeExpiredSessionsOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Override the retention window; defaults to SESSION_PURGE_RETENTION_DAYS. */
  retentionDays?: number;
}

/**
 * Deletes every session row whose `expires_at` is more than
 * `retentionDays` in the past. Returns the number of rows purged.
 */
export async function purgeExpiredSessions(
  sessions: SessionsRepository,
  options: PurgeExpiredSessionsOptions = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const retentionDays = options.retentionDays ?? SESSION_PURGE_RETENTION_DAYS;
  const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return sessions.purgeExpiredBefore(cutoff);
}
