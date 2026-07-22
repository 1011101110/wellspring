import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The journal (N9, issue #268; owner's decision: free text is KEPT and
 * serves as a journal space).
 *
 * ## How this differs from `prayer_intentions`, and why it is a new table
 *
 * `prayer_intentions` (1721200000000) looks superficially similar — a
 * line of the user's own words — but it is a different thing in three
 * ways that matter, and merging them would break all three:
 *
 *  - **Retention.** Prayer intentions are purged at 14 days (`purgeJobs`).
 *    Journal entries are KEPT until the user deletes them or deletes their
 *    account. There is deliberately no purge job for this table.
 *  - **Generation.** A prayer intention is injected into the NEXT
 *    devotional's instructions. A journal entry is **never** sent to the
 *    model (v1) — it is for the person, not an input to generation, which
 *    also keeps the prompt-injection surface closed. Whether it ever
 *    informs generation is a separate, later decision.
 *  - **Anchor.** A prayer intention is one-per-devotional. A journal entry
 *    is standalone — written whenever the person has something to bring,
 *    tied to no devotional.
 *
 * ## What §9 still forbids over this table
 *
 * Keeping the text is a journal; COUNTING it is accounting. No query in
 * this repository returns a tally, a streak, or a "you journal most on
 * Tuesdays" — the read paths are "give me my entries" and nothing that
 * reduces them to a number (Foundation §9, and the #271 ruling: Kairos
 * keeps your words, it never charges you for them).
 *
 * ## Deletion
 *
 * `user_id` cascades, so `DELETE /v1/account`'s hard-delete removes every
 * entry with the user (Privacy §account-deletion), and the per-entry
 * `DELETE /v1/journal/:id` lets the user remove one at a time. Both are
 * real deletes of user content, which is the standard this kind of data
 * is held to.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('journal_entries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    text: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Newest-first listing per user is the only read pattern, so the index
  // matches it directly.
  pgm.createIndex('journal_entries', ['user_id', 'created_at']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('journal_entries');
}
