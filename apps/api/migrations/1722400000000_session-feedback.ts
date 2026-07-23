import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * End-of-session feedback (EPIC P #312, story #320): one row per session,
 * capturing the ≤10-second post-Amen feedback moment (contentHelpful /
 * topicMore / lengthFeel / timeFeel / note). Every answer column is
 * nullable — every question is optional (Foundation §9: skippable
 * forever), and partial submits are valid. Re-submits upsert per-column
 * (sessionFeedbackRepository.ts COALESCEs), never duplicate.
 *
 * ## Retention: feedback must OUTLIVE the session row (#320's open risk)
 *
 * Sessions are purged 7 days after expiry (purgeJobs.ts
 * SESSION_RETENTION_DAYS_AFTER_EXPIRY; expiry itself is event-end + 48h),
 * but the cadence policy engine (P4/P5, #323/#324) reads feedback over a
 * TRAILING 28-DAY window — a `session_id ... ON DELETE CASCADE` design
 * would silently delete most feedback weeks before the engine could use
 * it, starving the very feature this table exists to feed. So:
 *
 *  - `user_id` (NOT NULL, CASCADE) + `devotional_id` are the DURABLE keys
 *    the engine reads by. Devotional text is kept until account deletion
 *    (Privacy §2), so `devotional_id` naturally lives as long as the
 *    feedback needs to.
 *  - `session_token` is `ON DELETE SET NULL`, not CASCADE: when the
 *    session row is purged the feedback survives, merely losing its
 *    (by then useless) capability-token linkage. NOTE: sessions' primary
 *    key is `token` (there is no `sessions.id` column —
 *    1720000000000_init-schema.ts), so the FK targets `sessions(token)`.
 *  - Deleting the ACCOUNT still hard-deletes feedback via the `user_id`
 *    cascade (Privacy §2 "hard-deletes all rows"), which is the retention
 *    boundary that actually matters for user data.
 *
 * The UNIQUE constraint on `session_token` is both the "one row per
 * session" invariant and the upsert target (`ON CONFLICT (session_token)`).
 * Postgres UNIQUE treats NULLs as distinct, so rows whose session has
 * been purged (token nulled) never collide with each other — and no new
 * row is ever inserted with a NULL token, because the only writer is the
 * token-scoped route, which by construction has a live session.
 *
 * ## What §9 forbids over this table
 *
 * Feedback is read server-side by the policy engine only — no
 * authenticated GET exposes these rows to clients (#320 acceptance), and
 * nothing may ever reduce them to a count/streak a client could display
 * (Foundation §9, the #271 "grace may notice; it may never charge" ruling).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('session_feedback', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // FK targets sessions' PK, which is `token` (see doc comment above).
    session_token: { type: 'uuid', references: 'sessions', onDelete: 'SET NULL' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    devotional_id: { type: 'uuid', references: 'devotionals', onDelete: 'SET NULL' },
    content_helpful: { type: 'boolean' },
    topic_more: { type: 'boolean' },
    // Same value sets as shared-contracts' LengthFeelSchema/TimeFeelSchema —
    // the CHECK formalizes what the route already enforces (the #87
    // convention: DB constraints mirror, never replace, contract validation).
    length_feel: { type: 'text', check: "length_feel IN ('shorter', 'right', 'longer')" },
    time_feel: { type: 'text', check: "time_feel IN ('earlier', 'right', 'later')" },
    // Same 500-char cap as prayerIntention (routes/session.ts) — one line,
    // not an essay; the CHECK backstops the contract's max().
    note: { type: 'text', check: 'char_length(note) <= 500' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('session_feedback', 'session_feedback_session_token_unique', {
    unique: ['session_token'],
  });
  // The policy engine's read pattern (#323/#324): this user's feedback over
  // a trailing window — the index matches it directly, like journal_entries'.
  pgm.createIndex('session_feedback', ['user_id', 'created_at']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('session_feedback');
}
