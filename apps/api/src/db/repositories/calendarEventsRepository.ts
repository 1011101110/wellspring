import type { Queryable, VerifiedUserId } from './types.js';

export type CalendarGapSource = 'found_gap' | 'micro_gap' | 'no_gap_skipped';

export interface CalendarEventRow {
  id: string;
  user_id: string;
  devotional_id: string | null;
  provider_event_id: string;
  gap_source: CalendarGapSource;
  gap_start_at: Date;
  gap_end_at: Date;
  reschedule_count: number;
  created_at: Date;
  updated_at: Date;
  /** H1 (#53): real Meet join URL, only present when insertEvent requested conferenceData. */
  meet_uri: string | null;
}

/**
 * One row of the upcoming schedule (L4, issue #240) — the calendar event
 * joined to the devotional it was booked for.
 *
 * The devotional half is nullable as a group (`devotional_id`/`theme`/
 * `card_summary` are all null together) because the join is a LEFT join
 * over a nullable FK — see `listUpcomingForUser`.
 *
 * `provider_event_id` and `gap_source` are deliberately not projected:
 * they are internal bookkeeping (an opaque Google handle and a scheduler
 * decision label), and neither is anything a dashboard row renders
 * (Foundation §8 data minimization).
 */
export interface UpcomingCalendarEventRow {
  id: string;
  gap_start_at: Date;
  gap_end_at: Date;
  meet_uri: string | null;
  reschedule_count: number;
  devotional_id: string | null;
  theme: string | null;
  card_summary: string | null;
}

export interface CreateCalendarEventInput {
  devotionalId: string | null;
  providerEventId: string;
  gapSource: CalendarGapSource;
  gapStartAt: Date;
  gapEndAt: Date;
  /** H1 (#53): optional — omitted/undefined stores NULL, matching every existing caller. */
  meetUri?: string | null;
}

/**
 * Every method takes `userId: VerifiedUserId` first and every query is
 * scoped `WHERE user_id = $1`. Per Foundation §8, this table never stores
 * event titles/attendees/notes/precise-original timestamps — only the
 * provider event id (an opaque handle) and the chosen gap window.
 */
export class CalendarEventsRepository {
  constructor(private readonly db: Queryable) {}

  async create(
    userId: VerifiedUserId,
    input: CreateCalendarEventInput,
  ): Promise<CalendarEventRow> {
    const result = await this.db.query<CalendarEventRow>(
      `INSERT INTO calendar_events
         (user_id, devotional_id, provider_event_id, gap_source, gap_start_at, gap_end_at, meet_uri)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        userId,
        input.devotionalId,
        input.providerEventId,
        input.gapSource,
        input.gapStartAt,
        input.gapEndAt,
        input.meetUri ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('create: insert returned no row');
    return row;
  }

  async getByProviderEventId(
    userId: VerifiedUserId,
    providerEventId: string,
  ): Promise<CalendarEventRow | null> {
    const result = await this.db.query<CalendarEventRow>(
      `SELECT * FROM calendar_events WHERE user_id = $1 AND provider_event_id = $2`,
      [userId, providerEventId],
    );
    return result.rows[0] ?? null;
  }

  async listForUser(userId: VerifiedUserId): Promise<CalendarEventRow[]> {
    const result = await this.db.query<CalendarEventRow>(
      `SELECT * FROM calendar_events WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  /**
   * The upcoming schedule (L4, issue #240): what Wellspring has booked that
   * has not finished yet, soonest first, joined to the devotional it is
   * for.
   *
   * ## What counts as "upcoming": `gap_end_at > now`, not `gap_start_at`
   *
   * #240 says "future events only" and "do not return past events". The
   * boundary case those two phrases leave open is the event happening
   * *right now* — started, not yet over. It is filtered on `gap_end_at`
   * so that event stays in the list, because it is the single most useful
   * row on the whole dashboard while it is live: its Meet link is joinable
   * at that exact moment. Cutting at `gap_start_at` would make the
   * devotional vanish from the schedule the instant it became the thing
   * the user wanted to click. No genuinely past event (window closed) is
   * returned either way, which is the requirement the issue is actually
   * protecting.
   *
   * ## Ordering and the join
   *
   * `ORDER BY gap_start_at ASC` — chronological, per #240; the existing
   * `listForUser` orders by `created_at DESC`, which is booking order and
   * unrelated to when anything happens.
   *
   * `LEFT JOIN`, additionally scoped `d.user_id = ce.user_id`: the join
   * predicate re-asserts ownership on the devotionals side rather than
   * trusting `ce.devotional_id` alone. Belt and braces against a
   * cross-user content leak (Foundation §10) — `theme`/`card_summary` are
   * real devotional content crossing into this payload, so the join must
   * not be the one place in this class where a row's owner is assumed
   * rather than checked. `LEFT` (not inner) because
   * `calendar_events.devotional_id` is nullable and an event with no
   * devotional is still a booking on the user's real calendar; an inner
   * join would silently drop it, and a booking the dashboard doesn't
   * show is exactly the trust problem #240 exists to fix.
   */
  async listUpcomingForUser(
    userId: VerifiedUserId,
    now: Date,
    limit: number,
  ): Promise<UpcomingCalendarEventRow[]> {
    const result = await this.db.query<UpcomingCalendarEventRow>(
      `SELECT ce.id, ce.gap_start_at, ce.gap_end_at, ce.meet_uri, ce.reschedule_count,
              d.id AS devotional_id, d.theme, d.card_summary
         FROM calendar_events ce
         LEFT JOIN devotionals d
           ON d.id = ce.devotional_id AND d.user_id = ce.user_id
        WHERE ce.user_id = $1 AND ce.gap_end_at > $2
        ORDER BY ce.gap_start_at ASC
        LIMIT $3`,
      [userId, now, limit],
    );
    return result.rows;
  }

  /** Reschedule flow — Architecture §3.3 moves the event and bumps the counter. */
  async recordReschedule(
    userId: VerifiedUserId,
    providerEventId: string,
    newGapStartAt: Date,
    newGapEndAt: Date,
  ): Promise<CalendarEventRow | null> {
    const result = await this.db.query<CalendarEventRow>(
      `UPDATE calendar_events SET
         gap_start_at = $3,
         gap_end_at = $4,
         reschedule_count = reschedule_count + 1,
         updated_at = now()
       WHERE user_id = $1 AND provider_event_id = $2
       RETURNING *`,
      [userId, providerEventId, newGapStartAt, newGapEndAt],
    );
    return result.rows[0] ?? null;
  }
}
