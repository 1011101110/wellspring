import type { Queryable, VerifiedUserId } from './types.js';

export interface JournalEntryRow {
  id: string;
  user_id: string;
  text: string;
  created_at: Date;
}

/**
 * The journal (N9, issue #268). A place for the person to write what they
 * are carrying — kept until they delete it, never sent to the model.
 *
 * Every method takes `userId: VerifiedUserId` and scopes `WHERE user_id =
 * $1`, matching every other per-user repository (Foundation §10). The
 * per-entry delete is doubly scoped (`id` AND `user_id`) so one user can
 * never delete another's entry even with a guessed id.
 *
 * ## No method returns a count
 *
 * There is deliberately no `count`, no `streak`, no "entries this week".
 * Keeping the words is a journal; reducing them to a number is the
 * accounting Foundation §9 forbids. The only reads are "create",
 * "list mine", and "delete mine" — none of which can produce a tally.
 */
export class JournalRepository {
  constructor(private readonly db: Queryable) {}

  async create(userId: VerifiedUserId, text: string): Promise<JournalEntryRow> {
    const result = await this.db.query<JournalEntryRow>(
      `INSERT INTO journal_entries (user_id, text) VALUES ($1, $2) RETURNING *`,
      [userId, text],
    );
    const row = result.rows[0];
    if (!row) throw new Error('journal create: insert returned no row');
    return row;
  }

  /**
   * The user's entries, newest first.
   *
   * `limit + 1` is fetched so the route can tell whether another page
   * exists without a second `count(*)` — the same cursor shape the
   * devotionals list uses (#241). The extra row is dropped before
   * returning; `hasMore` reports whether it was there.
   */
  async list(
    userId: VerifiedUserId,
    limit: number,
    before?: Date,
  ): Promise<{ entries: JournalEntryRow[]; hasMore: boolean }> {
    const result = await this.db.query<JournalEntryRow>(
      `SELECT * FROM journal_entries
       WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [userId, before ?? null, limit + 1],
    );
    const rows = result.rows;
    const hasMore = rows.length > limit;
    return { entries: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  /**
   * Deletes one entry the user owns. Returns whether a row was removed, so
   * the route can answer 404 for an id that is not theirs (or does not
   * exist) rather than a misleading 200 — the double scope means those two
   * cases are indistinguishable here, and both correctly delete nothing.
   */
  async deleteOne(userId: VerifiedUserId, id: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM journal_entries WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
