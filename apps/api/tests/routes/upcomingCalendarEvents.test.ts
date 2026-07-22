/**
 * L4 (#240): `GET /v1/calendar-events/upcoming`.
 *
 * Route-level concerns only — the clock seam, the wire mapping, the
 * nullable-devotional case, and the guarantee that the pre-existing
 * `GET /v1/calendar-events` did not change shape underneath its shipped
 * consumers.
 *
 * The filter and ordering themselves are SQL (`listUpcomingForUser`) and
 * are asserted against a real Postgres in `tests/db/repositories.test.ts`,
 * including the cross-user scoping that a joined query is the easiest
 * place to get wrong. The fake here mirrors that SQL's semantics so the
 * route's use of it is exercised honestly, but it is not evidence about
 * the query — that is what the repository test is for.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerUserScopedRoutes } from '../../src/routes/userScoped.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository, UserRow } from '../../src/db/repositories/usersRepository.js';
import type { UpcomingCalendarEventRow } from '../../src/db/repositories/calendarEventsRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';

const USER_ID = '00000000-0000-0000-0000-0000000000bb';
const FIREBASE_UID = 'firebase-upcoming';
const NOW = new Date('2026-07-19T12:00:00Z');

function event(
  id: string,
  startIso: string,
  endIso: string,
  extra: Partial<UpcomingCalendarEventRow> = {},
): UpcomingCalendarEventRow {
  return {
    id,
    gap_start_at: new Date(startIso),
    gap_end_at: new Date(endIso),
    meet_uri: 'https://meet.google.com/abc-defg-hij',
    reschedule_count: 0,
    devotional_id: `devo-${id}`,
    theme: `Theme ${id}`,
    card_summary: `Summary ${id}`,
    ...extra,
  };
}

const ALL_EVENTS: UpcomingCalendarEventRow[] = [
  // Yesterday — over and done.
  event('past', '2026-07-18T07:00:00Z', '2026-07-18T07:15:00Z'),
  // Started at 11:55, ends 12:10 — in progress at NOW.
  event('inprogress', '2026-07-19T11:55:00Z', '2026-07-19T12:10:00Z'),
  // Later today.
  event('soon', '2026-07-19T18:00:00Z', '2026-07-19T18:15:00Z'),
  // Next week, moved twice, no Meet link, no devotional linked yet.
  event('later', '2026-07-26T07:00:00Z', '2026-07-26T07:15:00Z', {
    meet_uri: null,
    reschedule_count: 2,
    devotional_id: null,
    theme: null,
    card_summary: null,
  }),
];

async function buildTestApp(rows: UpcomingCalendarEventRow[] = ALL_EVENTS) {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();
  const userRow = { id: USER_ID, firebase_uid: FIREBASE_UID } as unknown as UserRow;

  // Mirrors listUpcomingForUser's SQL: `gap_end_at > now`, ordered by
  // `gap_start_at ASC`.
  const listUpcomingForUser = vi.fn(async (_userId: string, now: Date, limit: number) =>
    rows
      .filter((r) => r.gap_end_at.getTime() > now.getTime())
      .sort((a, b) => a.gap_start_at.getTime() - b.gap_start_at.getTime())
      .slice(0, limit),
  );
  const listForUser = vi.fn(async () => rows);

  const repositories = {
    users: {
      findOrCreateByFirebaseUid: vi.fn(async () => userRow),
      findById: vi.fn(async () => userRow),
    } as unknown as UsersRepository,
    calendarEvents: { listUpcomingForUser, listForUser },
  } as unknown as Repositories;

  registerAuth(app, verifier, repositories.users);
  registerUserScopedRoutes(app, {
    repositories,
    audioStorage: {} as AudioStorage,
    now: () => NOW,
  });

  return { app, token: await verifier.mint(FIREBASE_UID), listUpcomingForUser, listForUser };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /v1/calendar-events/upcoming (#240)', () => {
  it('excludes finished events and orders the rest by start time', async () => {
    const { app, token } = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/calendar-events/upcoming',
      headers: authed(token),
    });

    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((e: { id: string }) => e.id);
    // Chronological, and yesterday's event is gone (#240: "Do not return
    // past events in the upcoming view").
    expect(ids).toEqual(['inprogress', 'soon', 'later']);
    expect(ids).not.toContain('past');

    await app.close();
  });

  it('keeps an event that is happening right now', async () => {
    // The deliberate boundary decision: "upcoming" cuts at `gap_end_at`,
    // not `gap_start_at`. An event whose window is still open has a live
    // Meet link, and dropping it the instant it starts would hide the one
    // row the user most needs at exactly the moment they need it.
    const { app, token } = await buildTestApp();

    const ids = (
      await app.inject({ method: 'GET', url: '/v1/calendar-events/upcoming', headers: authed(token) })
    )
      .json()
      .data.map((e: { id: string }) => e.id);

    expect(ids).toContain('inprogress');

    await app.close();
  });

  it('joins each row to its devotional theme and card summary', async () => {
    // The whole reason this is a separate shape rather than a filter on
    // the raw events route.
    const { app, token } = await buildTestApp();

    const rows = (
      await app.inject({ method: 'GET', url: '/v1/calendar-events/upcoming', headers: authed(token) })
    ).json().data;
    const soon = rows.find((e: { id: string }) => e.id === 'soon');

    expect(soon.devotional).toEqual({
      id: 'devo-soon',
      theme: 'Theme soon',
      cardSummary: 'Summary soon',
    });
    expect(soon.meetUri).toBe('https://meet.google.com/abc-defg-hij');
    expect(soon.rescheduleCount).toBe(0);
    // ISO-8601 instants, not pre-formatted local strings — the client
    // applies the user's profile zone (#240/#205).
    expect(soon.gapStartAt).toBe('2026-07-19T18:00:00.000Z');
    expect(soon.gapEndAt).toBe('2026-07-19T18:15:00.000Z');

    await app.close();
  });

  it('still lists an event whose devotional link is absent', async () => {
    // A booking with no devotional is still a real event on the user's
    // calendar. An inner join would drop it, and a schedule that hides
    // something Wellspring actually booked defeats the story's purpose.
    const { app, token } = await buildTestApp();

    const later = (
      await app.inject({ method: 'GET', url: '/v1/calendar-events/upcoming', headers: authed(token) })
    )
      .json()
      .data.find((e: { id: string }) => e.id === 'later');

    expect(later).toBeDefined();
    expect(later.devotional).toBeNull();
    expect(later.meetUri).toBeNull();
    // Surfaced, not hidden: an event Wellspring has moved twice is something
    // the user is entitled to see it admit.
    expect(later.rescheduleCount).toBe(2);

    await app.close();
  });

  it('serves an empty schedule as a 200 empty array, never an error', async () => {
    // #240: "Empty state is a real state" — weekends and non-active days
    // produce genuinely empty lists for default users (#188). A 404 or a
    // 500 here would make the client apologize for correct behavior.
    const { app, token } = await buildTestApp([
      event('past-only', '2026-07-01T07:00:00Z', '2026-07-01T07:15:00Z'),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/calendar-events/upcoming',
      headers: authed(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: [] });

    await app.close();
  });

  it('requires authentication', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/calendar-events/upcoming' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('leaves GET /v1/calendar-events exactly as it was', async () => {
    // #240 adds a view; it does not change the existing one. The raw route
    // still returns raw rows in booking order, so its shipped consumers
    // are untouched by this story.
    const { app, token, listForUser, listUpcomingForUser } = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/calendar-events',
      headers: authed(token),
    });

    expect(res.statusCode).toBe(200);
    expect(listForUser).toHaveBeenCalledTimes(1);
    expect(listUpcomingForUser).not.toHaveBeenCalled();
    // Raw snake_case rows, unfiltered — including the past event.
    const ids = res.json().data.map((e: { id: string }) => e.id);
    expect(ids).toContain('past');
    expect(res.json().data[0]).toHaveProperty('gap_start_at');

    await app.close();
  });
});
