/**
 * Retention & purge jobs (EPIC F, issue #44). Contract:
 * docs/04_DATA_PRIVACY_SECURITY.md §2 retention row: "daily_bands 90
 * days; devotional audio 14 days; devotionals text kept for user history
 * until account deletion; sessions rows purged 7 days after expiry."
 * (Audio retention reconciled from 30d to 14d — issue #82 — to match the
 * GCS bucket's own 14-day lifecycle rule, docs/06 §1.4, which deletes the
 * underlying object independently of this job. The two numbers disagreeing
 * meant a 16-day window where `audio_object` still pointed at a file GCS
 * had already deleted.)
 *
 * Invoked daily by Cloud Scheduler via `POST /internal/purge`
 * (routes/internal.ts, issue #82) — same shared-secret `/internal/*`
 * pattern as `trigger-daily-run` (issue #28 C7); real OIDC-token
 * verification is tracked as follow-up work (see routes/internal.ts).
 *
 * Each job is independently callable and independently testable via
 * time-travel (inserting rows with a backdated `created_at`/`date` and
 * an injectable clock), matching the existing
 * `SessionsRepository.purgeExpiredBefore` / `DailyBandsRepository.
 * purgeOlderThan` convention from #13/#33 — this module does not
 * reimplement that SQL, it composes it plus the audio-file side effect
 * that a pure SQL DELETE cannot perform.
 */
import type { AudioStorage } from '../audio/audioStorage.js';
import {
  asVerifiedUserId,
  type DailyBandsRepository,
  type DevotionalsRepository,
  type PrayerIntentionsRepository,
  type SessionsRepository,
  type UsersRepository,
} from '../../db/repositories/index.js';
import {
  revokeGoogleConnection,
  type RevokeGoogleConnectionDeps,
  type RevokeLogger,
} from '../calendar/revokeGoogleConnection.js';

export const DAILY_BANDS_RETENTION_DAYS = 90;
export const DEVOTIONAL_AUDIO_RETENTION_DAYS = 14;
export const SESSION_RETENTION_DAYS_AFTER_EXPIRY = 7;
/** docs/14 §5.5 / issue #93 — "user-scoped, 14-day retention, deletable, shown in the data ledger." */
export const PRAYER_INTENTIONS_RETENTION_DAYS = 14;

export interface PurgeJobsDeps {
  dailyBands: DailyBandsRepository;
  devotionals: DevotionalsRepository;
  sessions: SessionsRepository;
  users: UsersRepository;
  audioStorage: AudioStorage;
  prayerIntentions: PrayerIntentionsRepository;
  /** Injectable clock — every job's cutoff math runs off this, never `Date.now()` directly, so tests can time-travel. */
  now?: () => Date;
}

export interface PurgeJobsResult {
  dailyBandsDeleted: number;
  devotionalAudioPurged: number;
  sessionsDeleted: number;
  prayerIntentionsDeleted: number;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * `daily_bands` older than 90 days — global sweep across all users (no
 * `userId` scoping possible/needed at this call site since it's a
 * scheduled job, not a request; `DailyBandsRepository.purgeOlderThan` is
 * userId-scoped for the normal per-user case, so this loops over
 * distinct users. For MVP scale (hackathon-era user counts) this is a
 * simple, correct, and cheap-enough approach; a future optimization
 * could add an unscoped bulk-delete-by-date method if user counts grow).
 */
async function purgeDailyBands(
  dailyBands: DailyBandsRepository,
  listAllUserIds: () => Promise<string[]>,
): Promise<number> {
  const userIds = await listAllUserIds();
  let total = 0;
  for (const userId of userIds) {
    total += await dailyBands.purgeOlderThan(asVerifiedUserId(userId), DAILY_BANDS_RETENTION_DAYS);
  }
  return total;
}

/**
 * Devotional audio references older than 14 days: deletes the
 * `LocalFileAudioStorage`/`GcsAudioStorage` object AND nulls the
 * `audio_object` DB column (Privacy §retention — "devotional audio 14
 * days" governs the AUDIO, not the devotional text/transcript, which is
 * kept per Privacy §2 "devotionals text kept for user history until
 * account deletion"). Order matters: delete the file first, then null
 * the reference — if the process crashes between the two, the worst
 * case on retry is a redundant (idempotent) file-delete attempt, never a
 * dangling reference to a file that no longer exists.
 */
export async function purgeDevotionalAudio(
  devotionals: DevotionalsRepository,
  audioStorage: AudioStorage,
  now: Date,
): Promise<number> {
  const cutoff = daysAgo(now, DEVOTIONAL_AUDIO_RETENTION_DAYS);
  const candidates = await devotionals.findWithAudioOlderThan(cutoff);
  let purged = 0;
  for (const row of candidates) {
    await audioStorage.delete(row.id);
    await devotionals.clearAudioObject(row.id);
    purged += 1;
  }
  return purged;
}

/** Sessions 7 days past expiry — thin wrapper matching purgeExpiredSessions.ts (issue #33) exactly. */
export async function purgeExpiredSessionRows(
  sessions: SessionsRepository,
  now: Date,
): Promise<number> {
  const cutoff = daysAgo(now, SESSION_RETENTION_DAYS_AFTER_EXPIRY);
  return sessions.purgeExpiredBefore(cutoff);
}

/** Prayer intentions older than 14 days (docs/14 §5.5 / issue #93) — a global sweep, mirroring purgeDevotionalAudio's cutoff-Date shape rather than DailyBandsRepository's per-user loop, since the delete is a plain age-based DELETE with no per-user side effect to perform. */
export async function purgePrayerIntentions(
  prayerIntentions: PrayerIntentionsRepository,
  now: Date,
): Promise<number> {
  const cutoff = daysAgo(now, PRAYER_INTENTIONS_RETENTION_DAYS);
  return prayerIntentions.purgeOlderThan(cutoff);
}

/**
 * Runs all three retention sweeps. `listAllUserIds` is injected rather
 * than assumed (UsersRepository has no "list all" method by design —
 * Foundation §10 minimizes broad-scan query surfaces — so the caller
 * supplies a narrowly-scoped lister, e.g. a raw pool query used only by
 * this job, or a paginated Postgres cursor in production).
 */
export async function runAllPurgeJobs(
  deps: PurgeJobsDeps,
  listAllUserIds: () => Promise<string[]>,
): Promise<PurgeJobsResult> {
  const now = (deps.now ?? (() => new Date()))();

  const dailyBandsDeleted = await purgeDailyBands(deps.dailyBands, listAllUserIds);
  const devotionalAudioPurged = await purgeDevotionalAudio(
    deps.devotionals,
    deps.audioStorage,
    now,
  );
  const sessionsDeleted = await purgeExpiredSessionRows(deps.sessions, now);
  const prayerIntentionsDeleted = await purgePrayerIntentions(deps.prayerIntentions, now);

  return { dailyBandsDeleted, devotionalAudioPurged, sessionsDeleted, prayerIntentionsDeleted };
}

/**
 * Account hard-delete (Privacy §2: "Account deletion ... hard-deletes
 * all rows and GCS objects within 24 h and revokes Google tokens").
 * Fulfils the full contract:
 *   1. Revoke the Google refresh token with Google itself (issue #81) —
 *      best-effort; a revoke failure never blocks the rest of deletion
 *      (see revokeGoogleConnection.ts). `oauth` is optional so retention
 *      tests / environments without Google Calendar configured don't have
 *      to construct oauth/KMS services; production always passes it (see
 *      routes/userScoped.ts) so it can't be silently forgotten there.
 *   2. Delete every audio file for the user's devotionals (the FK
 *      CASCADE on `users.hardDelete()` removes the DB rows, but does
 *      NOT touch files in object storage).
 *   3. Hard-delete the user row, which cascades (ON DELETE CASCADE) to
 *      connections, preferences, daily_bands, devotionals, sessions,
 *      and calendar_events — see migrations/1720000000000_init-schema.ts.
 * Order matters for the same reason as purgeDevotionalAudio: revoke/
 * delete anything that depends on the row still existing FIRST, then
 * delete the DB rows last.
 */
export async function hardDeleteAccount(
  deps: Pick<PurgeJobsDeps, 'devotionals' | 'users' | 'audioStorage'> & {
    oauth?: RevokeGoogleConnectionDeps;
  },
  userId: string,
  log?: RevokeLogger,
): Promise<void> {
  const verifiedUserId = asVerifiedUserId(userId);

  if (deps.oauth) {
    await revokeGoogleConnection(deps.oauth, verifiedUserId, log);
  }

  const devotionalsWithAudio = await deps.devotionals.listWithAudioForUser(verifiedUserId);
  for (const row of devotionalsWithAudio) {
    await deps.audioStorage.delete(row.id);
  }
  await deps.users.hardDelete(verifiedUserId);
}
