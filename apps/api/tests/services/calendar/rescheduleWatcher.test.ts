/**
 * Tests for the reschedule watcher (issue #25) — the poll-based half of
 * "the gap got booked -> move the event" (docs/02_ARCHITECTURE.md §3.3).
 * Real Postgres (repositories layer) but a FAKE GoogleCalendarClient/
 * GoogleKmsService, mirroring generateNowOrchestrator.test.ts's exact
 * convention for calendar-integration tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
} from '../../../src/db/repositories/index.js';
import type { GoogleCalendarClient, FreeBusyBlock } from '../../../src/services/calendar/googleCalendarClient.js';
import type { GoogleKmsService } from '../../../src/services/calendar/googleKmsService.js';
import {
  detectGapConflict,
  runRescheduleCheck,
  type RescheduleWatcherDeps,
} from '../../../src/services/calendar/rescheduleWatcher.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE candidate_slots, calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
}

beforeAll(async () => {
  await pool.query('SELECT 1 FROM users LIMIT 1');
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
});

async function makeUserWithConnection(
  localPart: string,
  encryptedTokenValue = 'encrypted-token',
  timezone = 'UTC',
) {
  const user = await repos.users.createUser({
    firebaseUid: `firebase-${localPart}`,
    email: `${localPart}@example.com`,
    timezone,
  });
  const userId = asVerifiedUserId(user.id);
  await repos.connections.upsert(userId, {
    provider: 'google_calendar',
    encryptedRefreshToken: Buffer.from(encryptedTokenValue),
    encryptionIv: Buffer.alloc(12),
    encryptionAuthTag: Buffer.alloc(16),
    kmsKeyVersion: 'v1',
    scopes: [],
  });
  return userId;
}

function fakeKms(): GoogleKmsService {
  return { decryptToken: vi.fn().mockResolvedValue('real-refresh-token') } as unknown as GoogleKmsService;
}

/** A `GoogleCalendarClient` whose `withRefreshToken` returns a fixed fake per-user client. */
function fakeCalendarClient(perUserClient: {
  getFreeBusyBlocks: ReturnType<typeof vi.fn>;
  patchEvent: ReturnType<typeof vi.fn>;
}): GoogleCalendarClient {
  return {
    withRefreshToken: vi.fn().mockReturnValue(perUserClient),
  } as unknown as GoogleCalendarClient;
}

describe('detectGapConflict (pure)', () => {
  const gap = { start: '2026-07-06T13:00:00.000Z', end: '2026-07-06T13:30:00.000Z' };

  it('returns false when no busy block overlaps the gap', () => {
    const busy: FreeBusyBlock[] = [{ start: '2026-07-06T14:00:00.000Z', end: '2026-07-06T14:30:00.000Z' }];
    expect(detectGapConflict(gap, busy)).toBe(false);
  });

  it('returns true when a busy block exactly matches the gap', () => {
    const busy: FreeBusyBlock[] = [{ start: gap.start, end: gap.end }];
    expect(detectGapConflict(gap, busy)).toBe(true);
  });

  it('returns true when a busy block partially overlaps the gap', () => {
    const busy: FreeBusyBlock[] = [{ start: '2026-07-06T13:15:00.000Z', end: '2026-07-06T13:45:00.000Z' }];
    expect(detectGapConflict(gap, busy)).toBe(true);
  });

  it('returns false when a busy block is merely adjacent (touches but does not overlap)', () => {
    const busy: FreeBusyBlock[] = [{ start: gap.end, end: '2026-07-06T14:00:00.000Z' }];
    expect(detectGapConflict(gap, busy)).toBe(false);
  });

  it('returns true when the busy block fully contains the gap', () => {
    const busy: FreeBusyBlock[] = [{ start: '2026-07-06T12:00:00.000Z', end: '2026-07-06T15:00:00.000Z' }];
    expect(detectGapConflict(gap, busy)).toBe(true);
  });
});

describe('runRescheduleCheck', () => {
  it('leaves an event unchanged when a fresh freeBusy check finds no conflict', async () => {
    const userId = await makeUserWithConnection('unchanged');
    const eventRow = await repos.calendarEvents.create(userId, {
      devotionalId: null,
      providerEventId: 'evt-1',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-07-06T13:00:00.000Z'),
      gapEndAt: new Date('2026-07-06T13:30:00.000Z'),
    });

    const perUserClient = {
      getFreeBusyBlocks: vi.fn().mockResolvedValue([]), // nothing booked anywhere
      patchEvent: vi.fn(),
    };
    const deps: RescheduleWatcherDeps = {
      connections: repos.connections,
      calendarEvents: repos.calendarEvents,
      preferences: repos.preferences,
      users: repos.users,
      calendarClient: fakeCalendarClient(perUserClient),
      kmsService: fakeKms(),
      now: () => new Date('2026-07-05T00:00:00.000Z'), // before the gap
    };

    const result = await runRescheduleCheck(deps, [userId]);

    expect(result.checked).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.moved).toBe(0);
    expect(perUserClient.patchEvent).not.toHaveBeenCalled();

    const stored = await repos.calendarEvents.getByProviderEventId(userId, 'evt-1');
    expect(stored?.gap_start_at.toISOString()).toBe(eventRow.gap_start_at.toISOString());
    expect(stored?.reschedule_count).toBe(0);
  });

  it('moves the event to a new gap when the original gap conflicts, and records the reschedule', async () => {
    const userId = await makeUserWithConnection('moved');
    await repos.calendarEvents.create(userId, {
      devotionalId: null,
      providerEventId: 'evt-2',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-07-06T13:00:00.000Z'),
      gapEndAt: new Date('2026-07-06T13:30:00.000Z'),
    });

    const perUserClient = {
      // Something now occupies the original 13:00-13:30 gap.
      getFreeBusyBlocks: vi.fn().mockResolvedValue([
        { start: '2026-07-06T13:00:00.000Z', end: '2026-07-06T13:30:00.000Z' },
      ]),
      patchEvent: vi.fn().mockResolvedValue(undefined),
    };
    const deps: RescheduleWatcherDeps = {
      connections: repos.connections,
      calendarEvents: repos.calendarEvents,
      preferences: repos.preferences,
      users: repos.users,
      calendarClient: fakeCalendarClient(perUserClient),
      kmsService: fakeKms(),
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    };

    const result = await runRescheduleCheck(deps, [userId]);

    expect(result.checked).toBe(1);
    expect(result.moved).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(perUserClient.patchEvent).toHaveBeenCalledOnce();
    const [eventId, patch] = perUserClient.patchEvent.mock.calls[0];
    expect(eventId).toBe('evt-2');
    expect(patch.startDateTime).not.toBe('2026-07-06T13:00:00.000Z');

    const stored = await repos.calendarEvents.getByProviderEventId(userId, 'evt-2');
    expect(stored?.reschedule_count).toBe(1);
    expect(stored?.gap_start_at.toISOString()).not.toBe('2026-07-06T13:00:00.000Z');
  });

  it('reports noGapAvailable and leaves the event untouched when the whole window is now busy', async () => {
    const userId = await makeUserWithConnection('no-gap');
    await repos.calendarEvents.create(userId, {
      devotionalId: null,
      providerEventId: 'evt-3',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-07-06T13:00:00.000Z'),
      gapEndAt: new Date('2026-07-06T13:30:00.000Z'),
    });

    const perUserClient = {
      // The entire default 07:00-09:00 preferences window is now busy.
      getFreeBusyBlocks: vi.fn().mockResolvedValue([
        { start: '2026-07-06T00:00:00.000Z', end: '2026-07-06T23:59:59.000Z' },
      ]),
      patchEvent: vi.fn(),
    };
    const deps: RescheduleWatcherDeps = {
      connections: repos.connections,
      calendarEvents: repos.calendarEvents,
      preferences: repos.preferences,
      users: repos.users,
      calendarClient: fakeCalendarClient(perUserClient),
      kmsService: fakeKms(),
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    };

    const result = await runRescheduleCheck(deps, [userId]);

    expect(result.checked).toBe(1);
    expect(result.noGapAvailable).toBe(1);
    expect(result.moved).toBe(0);
    expect(perUserClient.patchEvent).not.toHaveBeenCalled();

    const stored = await repos.calendarEvents.getByProviderEventId(userId, 'evt-3');
    expect(stored?.reschedule_count).toBe(0);
  });

  it('skips a user with no active Google Calendar connection', async () => {
    const user = await repos.users.createUser({ firebaseUid: 'firebase-no-conn', email: 'noconn@example.com' });
    const userId = asVerifiedUserId(user.id);
    await repos.calendarEvents.create(userId, {
      devotionalId: null,
      providerEventId: 'evt-4',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-07-06T13:00:00.000Z'),
      gapEndAt: new Date('2026-07-06T13:30:00.000Z'),
    });

    const perUserClient = { getFreeBusyBlocks: vi.fn(), patchEvent: vi.fn() };
    const deps: RescheduleWatcherDeps = {
      connections: repos.connections,
      calendarEvents: repos.calendarEvents,
      preferences: repos.preferences,
      users: repos.users,
      calendarClient: fakeCalendarClient(perUserClient),
      kmsService: fakeKms(),
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    };

    const result = await runRescheduleCheck(deps, [userId]);

    expect(result.checked).toBe(0);
    expect(perUserClient.getFreeBusyBlocks).not.toHaveBeenCalled();
  });

  it('skips a user whose calendar_enabled is false, without decrypting their token (#201)', async () => {
    // The reschedule sweep is the *second* free/busy read in the system and
    // runs on its own ~15-minute Cloud Scheduler cadence, independent of
    // generation. Gating only the orchestrator would leave a user who
    // revoked calendar consent still having their free/busy polled four
    // times an hour — the "toggle did nothing" failure #201 exists to fix.
    const userId = await makeUserWithConnection('consent-revoked');
    await repos.calendarEvents.create(userId, {
      devotionalId: null,
      providerEventId: 'evt-consent',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-07-06T13:00:00.000Z'),
      gapEndAt: new Date('2026-07-06T13:30:00.000Z'),
    });
    await repos.preferences.ensureExists(userId);
    await repos.preferences.update(userId, { calendar_enabled: false });

    const perUserClient = { getFreeBusyBlocks: vi.fn(), patchEvent: vi.fn() };
    const kms = fakeKms();
    const deps: RescheduleWatcherDeps = {
      connections: repos.connections,
      calendarEvents: repos.calendarEvents,
      preferences: repos.preferences,
      users: repos.users,
      calendarClient: fakeCalendarClient(perUserClient),
      kmsService: kms,
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    };

    const result = await runRescheduleCheck(deps, [userId]);

    expect(result.checked).toBe(0);
    expect(perUserClient.getFreeBusyBlocks).not.toHaveBeenCalled();
    expect(perUserClient.patchEvent).not.toHaveBeenCalled();
    // The OAuth credential is never even unwrapped in memory for a user who
    // revoked — the gate sits above `decryptToken`, not below it.
    expect(kms.decryptToken).not.toHaveBeenCalled();
  });

  it('still checks a user whose calendar_enabled is true (#201 control)', async () => {
    const userId = await makeUserWithConnection('consent-granted');
    await repos.calendarEvents.create(userId, {
      devotionalId: null,
      providerEventId: 'evt-consent-on',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-07-06T07:15:00.000Z'),
      gapEndAt: new Date('2026-07-06T07:45:00.000Z'),
    });
    await repos.preferences.ensureExists(userId);
    await repos.preferences.update(userId, { calendar_enabled: true });

    const perUserClient = { getFreeBusyBlocks: vi.fn().mockResolvedValue([]), patchEvent: vi.fn() };
    const deps: RescheduleWatcherDeps = {
      connections: repos.connections,
      calendarEvents: repos.calendarEvents,
      preferences: repos.preferences,
      users: repos.users,
      calendarClient: fakeCalendarClient(perUserClient),
      kmsService: fakeKms(),
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    };

    const result = await runRescheduleCheck(deps, [userId]);

    expect(result.checked).toBe(1);
    expect(perUserClient.getFreeBusyBlocks).toHaveBeenCalledTimes(1);
  });

  it('skips events whose gap has already started (nothing to reschedule)', async () => {
    const userId = await makeUserWithConnection('already-started');
    await repos.calendarEvents.create(userId, {
      devotionalId: null,
      providerEventId: 'evt-5',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-07-01T13:00:00.000Z'),
      gapEndAt: new Date('2026-07-01T13:30:00.000Z'),
    });

    const perUserClient = { getFreeBusyBlocks: vi.fn(), patchEvent: vi.fn() };
    const deps: RescheduleWatcherDeps = {
      connections: repos.connections,
      calendarEvents: repos.calendarEvents,
      preferences: repos.preferences,
      users: repos.users,
      calendarClient: fakeCalendarClient(perUserClient),
      kmsService: fakeKms(),
      now: () => new Date('2026-07-05T00:00:00.000Z'), // after the gap
    };

    const result = await runRescheduleCheck(deps, [userId]);

    expect(result.checked).toBe(0);
    expect(perUserClient.getFreeBusyBlocks).not.toHaveBeenCalled();
  });

  it('collects an error for one user and continues checking the next, rather than aborting the batch', async () => {
    const brokenUserId = await makeUserWithConnection('broken', 'encrypted-token-broken');
    await repos.calendarEvents.create(brokenUserId, {
      devotionalId: null,
      providerEventId: 'evt-broken',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-07-06T13:00:00.000Z'),
      gapEndAt: new Date('2026-07-06T13:30:00.000Z'),
    });
    const okUserId = await makeUserWithConnection('ok', 'encrypted-token-ok');
    await repos.calendarEvents.create(okUserId, {
      devotionalId: null,
      providerEventId: 'evt-ok',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-07-06T13:00:00.000Z'),
      gapEndAt: new Date('2026-07-06T13:30:00.000Z'),
    });

    const brokenClient = {
      getFreeBusyBlocks: vi.fn().mockRejectedValue(new Error('calendar API down')),
      patchEvent: vi.fn(),
    };
    const okClient = {
      getFreeBusyBlocks: vi.fn().mockResolvedValue([]),
      patchEvent: vi.fn(),
    };
    const calendarClient = {
      withRefreshToken: vi.fn((token: string) => (token === 'broken-token' ? brokenClient : okClient)),
    } as unknown as GoogleCalendarClient;

    const kmsService = {
      decryptToken: vi.fn((buf: Buffer) =>
        Promise.resolve(buf.toString() === Buffer.from('encrypted-token-broken').toString() ? 'broken-token' : 'ok-token'),
      ),
    } as unknown as GoogleKmsService;

    const deps: RescheduleWatcherDeps = {
      connections: repos.connections,
      calendarEvents: repos.calendarEvents,
      preferences: repos.preferences,
      users: repos.users,
      calendarClient,
      kmsService,
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    };

    const result = await runRescheduleCheck(deps, [brokenUserId, okUserId]);

    expect(result.checked).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.providerEventId).toBe('evt-broken');
  });
});

/**
 * #205 — the reschedule path carried the same defect as the insert path, plus
 * a second one of its own. These assert the **resolved freeBusy bounds** the
 * watcher actually queries, not that a timezone string reached a function:
 * the latter passed against the broken code for months (docs/16 §2b).
 */
describe('runRescheduleCheck — the re-derived window is zone-aware (#205)', () => {
  /** Runs the watcher for one future event and returns the freeBusy args it used. */
  async function captureWindow(opts: {
    localPart: string;
    timezone: string;
    gapStartAt: Date;
    gapEndAt: Date;
    now: Date;
  }) {
    const userId = await makeUserWithConnection(opts.localPart, 'encrypted-token', opts.timezone);
    await repos.calendarEvents.create(userId, {
      devotionalId: null,
      providerEventId: `evt-${opts.localPart}`,
      gapSource: 'found_gap',
      gapStartAt: opts.gapStartAt,
      gapEndAt: opts.gapEndAt,
    });
    const perUserClient = {
      getFreeBusyBlocks: vi.fn().mockResolvedValue([]),
      patchEvent: vi.fn(),
    };
    const result = await runRescheduleCheck(
      {
        connections: repos.connections,
        calendarEvents: repos.calendarEvents,
        preferences: repos.preferences,
        users: repos.users,
        calendarClient: fakeCalendarClient(perUserClient),
        kmsService: fakeKms(),
        now: () => opts.now,
      },
      [userId],
    );
    return { call: perUserClient.getFreeBusyBlocks.mock.calls[0]?.[0], result, perUserClient };
  }

  it('searches a New York user\'s real 07:00-09:00 Eastern, not 07:00-09:00 UTC', async () => {
    // Default prefs (07:00-09:00). The user's gap sits at 07:30 Eastern on
    // 2026-07-20 == 11:30Z. Pre-#205 this queried 07:00-09:00Z (03:00-05:00
    // Eastern) — a window that does not even contain the event it was
    // re-deriving, which is how a "no conflict" verdict could be meaningless.
    const { call } = await captureWindow({
      localPart: 'tz-ny',
      timezone: 'America/New_York',
      gapStartAt: new Date('2026-07-20T11:30:00.000Z'),
      gapEndAt: new Date('2026-07-20T12:00:00.000Z'),
      now: new Date('2026-07-19T00:00:00.000Z'),
    });

    expect(call.timeMin).toBe('2026-07-20T11:00:00.000Z');
    expect(call.timeMax).toBe('2026-07-20T13:00:00.000Z');
    expect(call.timeZone).toBe('America/New_York');
  });

  it('derives the gap\'s LOCAL date, not its UTC date, for a southern-hemisphere user', async () => {
    // The watcher's second #205 defect. 07:30 Sydney on 2026-01-15 is
    // 20:30Z on 2026-01-14. Deriving the date with toISOString().slice(0, 10)
    // yields 2026-01-14 and rebuilds the window for the WRONG LOCAL DAY.
    // Correct: the window for 2026-01-15 local == 2026-01-14T20:00Z-22:00Z.
    const { call } = await captureWindow({
      localPart: 'tz-syd',
      timezone: 'Australia/Sydney',
      gapStartAt: new Date('2026-01-14T20:30:00.000Z'),
      gapEndAt: new Date('2026-01-14T21:00:00.000Z'),
      now: new Date('2026-01-13T00:00:00.000Z'),
    });

    expect(call.timeMin).toBe('2026-01-14T20:00:00.000Z');
    expect(call.timeMax).toBe('2026-01-14T22:00:00.000Z');

    // The window must actually contain the event it is re-deriving. This is
    // the invariant the UTC-date bug broke, and it is worth stating directly.
    expect(new Date(call.timeMin).getTime()).toBeLessThanOrEqual(
      new Date('2026-01-14T20:30:00.000Z').getTime(),
    );
    expect(new Date(call.timeMax).getTime()).toBeGreaterThanOrEqual(
      new Date('2026-01-14T21:00:00.000Z').getTime(),
    );
  });

  it('is unchanged for a UTC user — regression guard', async () => {
    const { call } = await captureWindow({
      localPart: 'tz-utc',
      timezone: 'UTC',
      gapStartAt: new Date('2026-07-20T07:30:00.000Z'),
      gapEndAt: new Date('2026-07-20T08:00:00.000Z'),
      now: new Date('2026-07-19T00:00:00.000Z'),
    });

    expect(call.timeMin).toBe('2026-07-20T07:00:00.000Z');
    expect(call.timeMax).toBe('2026-07-20T09:00:00.000Z');
  });

  it('skips freeBusy entirely when DST erases the window, leaving the event untouched', async () => {
    // Window 02:00-03:00 on a US spring-forward day: that hour never happened,
    // so there is nothing to search and an inverted range would be a 400.
    // The event stays on the calendar and counts as unchanged, not failed.
    const userId = await makeUserWithConnection('tz-dst', 'encrypted-token', 'America/New_York');
    await repos.preferences.ensureExists(userId);
    await repos.preferences.update(userId, {
      window_start_local: '02:00:00',
      window_end_local: '03:00:00',
    });
    await repos.calendarEvents.create(userId, {
      devotionalId: null,
      providerEventId: 'evt-tz-dst',
      gapSource: 'found_gap',
      gapStartAt: new Date('2026-03-08T07:00:00.000Z'), // 03:00 EDT on the transition day
      gapEndAt: new Date('2026-03-08T07:30:00.000Z'),
    });
    const perUserClient = {
      getFreeBusyBlocks: vi.fn().mockResolvedValue([]),
      patchEvent: vi.fn(),
    };

    const result = await runRescheduleCheck(
      {
        connections: repos.connections,
        calendarEvents: repos.calendarEvents,
        preferences: repos.preferences,
        users: repos.users,
        calendarClient: fakeCalendarClient(perUserClient),
        kmsService: fakeKms(),
        now: () => new Date('2026-03-07T00:00:00.000Z'),
      },
      [userId],
    );

    expect(perUserClient.getFreeBusyBlocks).not.toHaveBeenCalled();
    expect(perUserClient.patchEvent).not.toHaveBeenCalled();
    expect(result.checked).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.failed).toBe(0);
  });
});
