import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Backs issue #86 (F8 Gloo engagement summary, docs/14_IMPROVEMENT_REVIEW.md
 * §4.3 / docs/03_API_INTEGRATION_SPEC.md §7).
 *
 * `sessions.duration_listened_sec` is what `POST /session/:token/complete`
 * captures from the client and what feeds the outbound summary's
 * `durationListenedSec` field. The currently-shipped session page ships
 * zero client-side JS by deliberate CSP policy (docs/04_DATA_PRIVACY_SECURITY.md
 * §5.3 — "the session page ships zero inline/external JS"), so this always
 * comes through as `NULL` today; the column exists so a future client that
 * *can* measure playback time has somewhere to put the number without a
 * second migration.
 *
 * `gloo_engagement_summaries` is the "persisted locally" half of docs/03
 * §7's "transport stubbed (logged + persisted locally until confirmed)" —
 * Cloud Run has no durable local disk, so the only place "locally" can mean
 * is our own Postgres. Rows here are the record of every stubbed
 * fire-and-forget send, kept until the real Gloo ingestion surface (issue
 * #21) is confirmed and they can be backfilled/replayed. Cascades on user
 * and devotional deletion like every other per-user table (Privacy
 * §account-deletion — nothing here is PII, but it is still tied to a real
 * account and must not outlive it).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('sessions', {
    duration_listened_sec: { type: 'integer' },
  });
  pgm.addConstraint('sessions', 'sessions_duration_listened_sec_nonnegative', {
    check: 'duration_listened_sec IS NULL OR duration_listened_sec >= 0',
  });

  pgm.createTable('gloo_engagement_summaries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    devotional_id: {
      type: 'uuid',
      notNull: true,
      references: 'devotionals',
      onDelete: 'CASCADE',
    },
    session_token: { type: 'uuid', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('gloo_engagement_summaries', 'user_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('gloo_engagement_summaries');
  pgm.dropConstraint('sessions', 'sessions_duration_listened_sec_nonnegative');
  pgm.dropColumn('sessions', 'duration_listened_sec');
}
