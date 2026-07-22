import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Prayer intentions (docs/14 §5.5 / issue #93): a one-line optional
 * response captured on the session-completion page ("Anything you're
 * carrying? — one line, only used to pray with you tomorrow"), stored
 * user-scoped with 14-day retention (purgeJobs.ts) and injected into the
 * NEXT generation's instructions as deliberate disclosure. One row per
 * (user_id, devotional_id) — the session-completion flow is the only
 * writer and is idempotent (sessionService.completeSession() only records
 * on genuine first completion), so a uniqueness constraint here keeps a
 * retried/duplicate write from ever producing two rows for the same devotional.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('prayer_intentions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    devotional_id: { type: 'uuid', notNull: true, references: 'devotionals', onDelete: 'CASCADE' },
    text: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('prayer_intentions', 'prayer_intentions_user_devotional_unique', {
    unique: ['user_id', 'devotional_id'],
  });
  pgm.createIndex('prayer_intentions', ['user_id', 'created_at']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('prayer_intentions');
}
