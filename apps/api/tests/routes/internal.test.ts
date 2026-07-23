/**
 * Unit tests for POST /internal/generate-now, POST /internal/trigger-daily-run,
 * and POST /internal/purge (issue #74, #28 C7, #82). GenerateNowOrchestrator,
 * UsersRepository, and the purge job repositories are faked so this suite
 * only exercises the route's own concerns: shared-secret auth, request
 * validation, response shape, and fan-out/composition logic.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerInternalRoutes } from '../../src/routes/internal.js';
import type { GenerateNowOrchestrator } from '../../src/services/orchestrator/generateNowOrchestrator.js';
import { AlreadyExistsError } from '../../src/services/orchestrator/generateNowOrchestrator.js';
import type { PreferencesRepository, SessionsRepository, UsersRepository } from '../../src/db/repositories/index.js';
import type { AttendanceSignalsDeps } from '../../src/services/rhythm/attendanceSignals.js';
import type { PurgeJobsDeps } from '../../src/services/retention/purgeJobs.js';
import type { RescheduleWatcherDeps } from '../../src/services/calendar/rescheduleWatcher.js';
import type { AttendeeClient } from '../../src/services/meetBot/attendeeClient.js';
import { FakeAttendeeClient } from '../../src/services/meetBot/fakeAttendeeClient.js';
import type { MeetBotConsentGateDeps } from '../../src/services/meetBot/meetBotConsentGate.js';
import { deriveMeetBotAudioToken } from '../../src/services/meetBot/meetBotAudioCapabilityToken.js';

/** Root secret every dispatch test derives its per-devotional audio capability from (#221). */
const TEST_AUDIO_TOKEN_SECRET = 'test-meetbot-audio-root-secret';

/**
 * Builds the #217 fire-time consent gate's deps out of plain fakes.
 *
 * Modelled as *database state* (does the devotional row exist, does the
 * user row exist, what is the connection's status) rather than as a
 * stubbed decision, so these tests exercise the real gate logic in
 * meetBotConsentGate.ts instead of a mock of it. A test that stubbed the
 * decision could pass while the gate itself was inverted.
 */
function fakeConsentGate(
  state: {
    /** `null` models a devotional row that no longer exists — i.e. a deleted account (FK cascade). */
    ownerUserId?: string | null;
    /** `false` models the `users` row being gone. */
    userExists?: boolean;
    /** `null` models no connection row at all; otherwise the row's `status`. */
    connectionStatus?: string | null;
  } = {},
): MeetBotConsentGateDeps {
  const ownerUserId = state.ownerUserId === undefined ? 'user-1' : state.ownerUserId;
  const userExists = state.userExists ?? true;
  const connectionStatus = state.connectionStatus === undefined ? 'active' : state.connectionStatus;

  return {
    devotionals: { findOwnerUserId: vi.fn().mockResolvedValue(ownerUserId) },
    users: {
      findById: vi.fn().mockResolvedValue(userExists ? { id: ownerUserId, email: null } : null),
    },
    connections: {
      findByProvider: vi
        .fn()
        .mockResolvedValue(
          connectionStatus === null
            ? null
            : { id: 'conn-1', user_id: ownerUserId, provider: 'google_calendar', status: connectionStatus },
        ),
    },
  } as unknown as MeetBotConsentGateDeps;
}

/** The happy path: devotional exists, user exists, calendar still connected. */
function consentingGate(): MeetBotConsentGateDeps {
  return fakeConsentGate();
}

function fakeOrchestrator(opts: {
  shouldFail?: boolean;
  alreadyExists?: boolean;
} = {}): GenerateNowOrchestrator {
  let generateNowImpl: () => Promise<unknown>;

  if (opts.alreadyExists) {
    generateNowImpl = () =>
      Promise.reject(new AlreadyExistsError('devo-1', 'tok-1', 'http://localhost:8080/session/tok-1'));
  } else if (opts.shouldFail) {
    generateNowImpl = () => Promise.reject(new Error('generateNow failed'));
  } else {
    generateNowImpl = () =>
      Promise.resolve({
        sessionUrl: 'http://localhost:8080/session/abc-123',
        sessionToken: 'abc-123',
        devotionalId: 'devo-1',
        devotional: { format: 'short', theme: 'Rest', cardSummary: 'Rest for the weary.' },
        source: 'gloo',
        audio: { status: 'uploaded', objectKey: 'devotionals/devo-1.mp3' },
      });
  }

  return {
    generateNow: vi.fn().mockImplementation(generateNowImpl),
  } as unknown as GenerateNowOrchestrator;
}

function fakeUsers(
  users: Array<{ id: string; email: string | null; timezone?: string }> = [],
  overrides: Partial<UsersRepository> = {},
): UsersRepository {
  return {
    listWithActiveGoogleCalendar: vi
      .fn()
      .mockResolvedValue(users.map((u) => ({ timezone: 'UTC', ...u }))),
    listAllIds: vi.fn().mockResolvedValue(users.map((u) => u.id)),
    // K1 (#187). Defaults are the "nothing to do" answers: no users
    // awaiting a backfill, and every adoption outranked/no-op — so every
    // pre-existing test in this file behaves exactly as it did before the
    // time zone refresh was added to the daily run.
    listAwaitingCalendarTimezone: vi.fn().mockResolvedValue([]),
    adoptTimezone: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as UsersRepository;
}

function fakePreferences(
  users: Array<{ user_id: string }> = [],
  sabbathUsers: Array<{ user_id: string; sabbath_day: number; sabbath_session: boolean }> = [],
  // K2 (#188). Defaults to no rows, which is the "no user has ever
  // expressed a day preference" answer — the active-days gate fails open
  // on a missing row, so every pre-existing test in this file behaves
  // exactly as it did before the gate was added.
  //
  // P6 (#325): rows may also carry the adaptive columns. Optional here so
  // every pre-#325 row literal in this file stands untouched — a row
  // without `adaptive_enabled: true` never enters the engine, which is
  // exactly the fixed-schedule regression posture the story demands.
  activeDaysUsers: Array<{
    user_id: string;
    active_days: number[];
    min_per_week?: number;
    adaptive_enabled?: boolean;
    adaptive_days_per_week?: number | null;
    adaptive_reason?: string | null;
    adaptive_decided_at?: Date | null;
  }> = [],
): PreferencesRepository {
  return {
    listWithExamenEnabled: vi.fn().mockResolvedValue(users),
    listWithSabbathEnabled: vi.fn().mockResolvedValue(sabbathUsers),
    listActiveDays: vi.fn().mockResolvedValue(activeDaysUsers),
    updateAdaptiveState: vi.fn().mockResolvedValue(undefined),
  } as unknown as PreferencesRepository;
}

/**
 * P6 (#325): fakes for P4's `loadAttendanceSignals` reads. The default is
 * "no history at all" (a `no_data` hold); `unjoinedRows` below manufactures
 * back-off pressure. `signalsError` makes the very first read throw — the
 * fail-open case.
 */
function fakeRhythm(
  opts: {
    scheduled?: Array<{
      devotional_id: string;
      scheduled_at: Date;
      joined_at: Date | null;
      completed_at: Date | null;
    }>;
    latestJoin?: Date | null;
    signalsError?: Error;
  } = {},
): AttendanceSignalsDeps {
  return {
    sessions: {
      listScheduledAttendance: opts.signalsError
        ? vi.fn().mockRejectedValue(opts.signalsError)
        : vi.fn().mockResolvedValue(opts.scheduled ?? []),
      latestJoinedAt: vi.fn().mockResolvedValue(opts.latestJoin ?? null),
    } as unknown as SessionsRepository,
    feedback: { devotionalIdsWithFeedback: vi.fn().mockResolvedValue(new Set<string>()) },
  };
}

/** `count` scheduled-but-never-engaged invitations, newest one day before `now` — enough for BACKOFF_UNJOINED_THRESHOLD. */
function unjoinedRows(count: number, now: Date) {
  return Array.from({ length: count }, (_, i) => ({
    devotional_id: `devo-unjoined-${i}`,
    scheduled_at: new Date(now.getTime() - (i + 1) * 86_400_000),
    joined_at: null,
    completed_at: null,
  }));
}

function fakePurgeJobs(overrides: Partial<Omit<PurgeJobsDeps, 'now'>> = {}): Omit<PurgeJobsDeps, 'now'> {
  return {
    dailyBands: { purgeOlderThan: vi.fn().mockResolvedValue(0) } as unknown as PurgeJobsDeps['dailyBands'],
    devotionals: {
      findWithAudioOlderThan: vi.fn().mockResolvedValue([]),
      clearAudioObject: vi.fn().mockResolvedValue(undefined),
    } as unknown as PurgeJobsDeps['devotionals'],
    sessions: { purgeExpiredBefore: vi.fn().mockResolvedValue(0) } as unknown as PurgeJobsDeps['sessions'],
    users: fakeUsers(),
    audioStorage: { delete: vi.fn().mockResolvedValue(undefined) } as unknown as PurgeJobsDeps['audioStorage'],
    prayerIntentions: {
      purgeOlderThan: vi.fn().mockResolvedValue(0),
    } as unknown as PurgeJobsDeps['prayerIntentions'],
    ...overrides,
  };
}

function fakeRescheduleWatcherDeps(
  overrides: Partial<Omit<RescheduleWatcherDeps, 'now'>> = {},
): Omit<RescheduleWatcherDeps, 'now'> {
  return {
    connections: { findByProvider: vi.fn().mockResolvedValue(null) } as unknown as RescheduleWatcherDeps['connections'],
    calendarEvents: { listForUser: vi.fn().mockResolvedValue([]) } as unknown as RescheduleWatcherDeps['calendarEvents'],
    preferences: { get: vi.fn().mockResolvedValue(null) } as unknown as RescheduleWatcherDeps['preferences'],
    users: fakeUsers(),
    calendarClient: { withRefreshToken: vi.fn() } as unknown as RescheduleWatcherDeps['calendarClient'],
    kmsService: { decryptToken: vi.fn() } as unknown as RescheduleWatcherDeps['kmsService'],
    ...overrides,
  };
}

function buildTestApp(opts: {
  orchestrator: GenerateNowOrchestrator;
  users?: UsersRepository;
  preferences?: PreferencesRepository;
  rhythm?: AttendanceSignalsDeps;
  purgeJobs?: Omit<PurgeJobsDeps, 'now'>;
  rescheduleWatcher?: Omit<RescheduleWatcherDeps, 'now'>;
  meetBotDispatch?: {
    attendeeClient: AttendeeClient;
    audioWebsocketBaseUrl: string;
    /**
     * #217. Optional *here only* — the production type requires it (see
     * `InternalRoutesDeps.meetBotDispatch.consentGate` for why). Defaulting
     * to a fully-consenting gate keeps every pre-#217 test in this file
     * asserting exactly what it asserted before, so the consent tests below
     * are the only place the gate's behavior is under test.
     */
    consentGate?: MeetBotConsentGateDeps;
    /**
     * #221. Optional *here only*, same trick as `consentGate` above — the
     * production type requires it. Defaulting keeps every call site in
     * this file unchanged; the one test that cares about the derived
     * capability token passes it explicitly.
     */
    audioTokenSecret?: string;
  };
  getCalendarTimeZoneForUser?: (userId: string) => Promise<string | undefined>;
  internalApiToken?: string;
  now?: () => Date;
}): FastifyInstance {
  const app = Fastify();
  registerInternalRoutes(app, {
    generateNowOrchestrator: opts.orchestrator,
    users: opts.users,
    preferences: opts.preferences,
    rhythm: opts.rhythm,
    purgeJobs: opts.purgeJobs,
    rescheduleWatcher: opts.rescheduleWatcher,
    meetBotDispatch: opts.meetBotDispatch
      ? {
          ...opts.meetBotDispatch,
          consentGate: opts.meetBotDispatch.consentGate ?? consentingGate(),
          audioTokenSecret: opts.meetBotDispatch.audioTokenSecret ?? TEST_AUDIO_TOKEN_SECRET,
        }
      : undefined,
    getCalendarTimeZoneForUser: opts.getCalendarTimeZoneForUser,
    internalApiToken: opts.internalApiToken,
    now: opts.now,
  });
  return app;
}

// ──────────────────────────────────────────────────────────────
// POST /internal/generate-now
// ──────────────────────────────────────────────────────────────

describe('POST /internal/generate-now', () => {
  it('401s when X-Internal-Token is missing', async () => {
    const app = buildTestApp({ orchestrator: fakeOrchestrator(), internalApiToken: 'secret-token' });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/generate-now',
      payload: { userId: 'user-1' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('401s when X-Internal-Token does not match', async () => {
    const app = buildTestApp({ orchestrator: fakeOrchestrator(), internalApiToken: 'secret-token' });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/generate-now',
      headers: { 'x-internal-token': 'wrong' },
      payload: { userId: 'user-1' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('fails closed (401) when INTERNAL_API_TOKEN is not configured at all, even with a header presented', async () => {
    const app = buildTestApp({ orchestrator: fakeOrchestrator(), internalApiToken: undefined });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/generate-now',
      headers: { 'x-internal-token': 'anything' },
      payload: { userId: 'user-1' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('400s on a missing userId', async () => {
    const app = buildTestApp({ orchestrator: fakeOrchestrator(), internalApiToken: 'secret-token' });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/generate-now',
      headers: { 'x-internal-token': 'secret-token' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('calls the orchestrator and returns sessionUrl + devotionalId on success', async () => {
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({ orchestrator, internalApiToken: 'secret-token' });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/generate-now',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { userId: 'user-1', date: '2026-07-02' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.sessionUrl).toBe('http://localhost:8080/session/abc-123');
    expect(body.devotionalId).toBe('devo-1');
    expect(orchestrator.generateNow).toHaveBeenCalledWith({ userId: 'user-1', date: '2026-07-02' });
    await app.close();
  });
});

// ──────────────────────────────────────────────────────────────
// POST /internal/trigger-daily-run
// ──────────────────────────────────────────────────────────────

describe('POST /internal/trigger-daily-run', () => {
  it('401s when X-Internal-Token is missing', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users: fakeUsers(),
      internalApiToken: 'secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('501 when users repository is not wired', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users: undefined,
      internalApiToken: 'secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });
    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it('returns triggered/succeeded/skipped/failed counts for an empty user list', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users: fakeUsers([]),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.triggered).toBe(0);
    expect(body.succeeded).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.errors).toEqual([]);
    await app.close();
  });

  it('counts succeeded for each successful generateNow call', async () => {
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([
        { id: 'user-a', email: 'a@example.com' },
        { id: 'user-b', email: 'b@example.com' },
      ]),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.triggered).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.failed).toBe(0);
    expect(orchestrator.generateNow).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('counts AlreadyExistsError as skipped (idempotent), not failed', async () => {
    // First user: already exists. Second user: succeeds.
    let callCount = 0;
    const orchestrator = {
      generateNow: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(
            new AlreadyExistsError('devo-x', 'tok-x', 'http://localhost:8080/session/tok-x'),
          );
        }
        return Promise.resolve({
          sessionUrl: 'http://localhost:8080/session/new',
          sessionToken: 'new',
          devotionalId: 'devo-y',
          devotional: {},
          source: 'gloo',
          audio: { status: 'uploaded', objectKey: 'k' },
        });
      }),
    } as unknown as GenerateNowOrchestrator;

    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([
        { id: 'user-existing', email: null },
        { id: 'user-new', email: null },
      ]),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.triggered).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.errors).toHaveLength(0);
    await app.close();
  });

  it('counts unexpected errors as failed and includes them in errors[], but continues the batch', async () => {
    let callCount = 0;
    const orchestrator = {
      generateNow: vi.fn().mockImplementation(({ userId }: { userId: string }) => {
        callCount++;
        if (userId === 'user-fail') {
          return Promise.reject(new Error('something broke'));
        }
        return Promise.resolve({
          sessionUrl: 'http://localhost:8080/session/tok',
          sessionToken: 'tok',
          devotionalId: 'devo-ok',
          devotional: {},
          source: 'gloo',
          audio: { status: 'uploaded', objectKey: 'k' },
        });
      }),
    } as unknown as GenerateNowOrchestrator;

    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([
        { id: 'user-ok', email: null },
        { id: 'user-fail', email: null },
        { id: 'user-ok2', email: null },
      ]),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.triggered).toBe(3);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].userId).toBe('user-fail');
    expect(body.errors[0].reason).toContain('something broke');
    // All 3 were attempted — failure in one didn't abort the others.
    expect(callCount).toBe(3);
    await app.close();
  });

  // ──────────────────────────────────────────────────────────────
  // Sabbath awareness (docs/14 §5.6, issue #94)
  // ──────────────────────────────────────────────────────────────

  it('skips generation entirely on a sabbath day with sabbath_session=false — counted as skipped, generateNow not called', async () => {
    // 2026-07-05 is a Sunday (localDayOfWeek convention: 0=Sunday).
    const fixedNow = new Date('2026-07-05T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-sabbath', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences([], [{ user_id: 'user-sabbath', sabbath_day: 0, sabbath_session: false }]),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.triggered).toBe(1);
    expect(body.succeeded).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.failed).toBe(0);
    expect(orchestrator.generateNow).not.toHaveBeenCalled();
    await app.close();
  });

  it('passes sabbathSession=true to generateNow on a sabbath day with sabbath_session=true, instead of skipping', async () => {
    const fixedNow = new Date('2026-07-05T12:00:00.000Z'); // Sunday
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-sabbath-session', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences(
        [],
        [{ user_id: 'user-sabbath-session', sabbath_day: 0, sabbath_session: true }],
      ),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(1);
    expect(body.skipped).toBe(0);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({
      userId: 'user-sabbath-session',
      sabbathSession: true,
    });
    await app.close();
  });

  it('generates as normal (no sabbathSession flag) for a sabbath-enabled user on a non-sabbath day', async () => {
    const fixedNow = new Date('2026-07-06T12:00:00.000Z'); // Monday (1) — sabbath_day is 0 (Sunday)
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-not-today', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences(
        [],
        [{ user_id: 'user-not-today', sabbath_day: 0, sabbath_session: false }],
      ),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(1);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({ userId: 'user-not-today' });
    await app.close();
  });

  it('sabbath awareness is silently disabled (generates as normal, no crash) when the preferences dep is not wired', async () => {
    const fixedNow = new Date('2026-07-05T12:00:00.000Z'); // Sunday
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-no-prefs-dep', email: null, timezone: 'UTC' }]),
      preferences: undefined,
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(1);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({ userId: 'user-no-prefs-dep' });
    await app.close();
  });

  it('resolves the sabbath day-of-week in the user\'s own timezone, not UTC', async () => {
    // 2026-07-05T02:00:00Z is still Saturday 2026-07-04 21:00 in America/Chicago (UTC-5 CDT).
    const fixedNow = new Date('2026-07-05T02:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-tz', email: null, timezone: 'America/Chicago' }]),
      // sabbath_day=6 (Saturday) — should match in America/Chicago local time, even though UTC is already Sunday.
      preferences: fakePreferences([], [{ user_id: 'user-tz', sabbath_day: 6, sabbath_session: false }]),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.skipped).toBe(1);
    expect(orchestrator.generateNow).not.toHaveBeenCalled();
    await app.close();
  });

  // ──────────────────────────────────────────────────────────────
  // Active days (K2, issue #188)
  //
  // Per #193's standard of proof, each of these asserts on *behavior* —
  // whether `generateNow` was called for a user — not on whether a value
  // was passed to a function. `active_days` was passed nowhere at all
  // before #188, and `users.timezone` was "passed correctly" for months
  // while still producing 3:30am devotionals (#205).
  // ──────────────────────────────────────────────────────────────

  it('skips a user whose local weekday is not in active_days — a skip, not a failure', async () => {
    // 2026-07-18 is a Saturday (localDayOfWeek convention: 0=Sunday..6=Saturday).
    // This is the exact scenario in #188: a user who selected Mon–Fri and
    // was getting a Saturday devotional anyway.
    const fixedNow = new Date('2026-07-18T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-weekdays', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences([], [], [{ user_id: 'user-weekdays', active_days: [1, 2, 3, 4, 5] }]),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.triggered).toBe(1);
    expect(body.succeeded).toBe(0);
    expect(body.skipped).toBe(1);
    // The load-bearing half of this assertion pair: a skip must not be an
    // error, or a Cloud Scheduler run would alert every weekend.
    expect(body.failed).toBe(0);
    expect(body.errors).toEqual([]);
    expect(orchestrator.generateNow).not.toHaveBeenCalled();
    await app.close();
  });

  it('generates for the same user on a weekday that IS in active_days', async () => {
    // Same user, same preference, one day later: 2026-07-20 is a Monday.
    // Paired with the test above so the skip is provably caused by the day
    // rather than by the gate rejecting everything.
    const fixedNow = new Date('2026-07-20T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-weekdays', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences([], [], [{ user_id: 'user-weekdays', active_days: [1, 2, 3, 4, 5] }]),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(1);
    expect(body.skipped).toBe(0);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({ userId: 'user-weekdays' });
    await app.close();
  });

  it('resolves the active-day weekday in the user\'s own zone, not UTC (Sydney across midnight)', async () => {
    // THE CASE A NAIVE IMPLEMENTATION GETS WRONG (#205's defect class).
    //
    // 2026-07-17T22:00:00Z is Friday in UTC, but 2026-07-18 08:00 in
    // Australia/Sydney (UTC+10) — already Saturday where the user lives.
    // A UTC-derived weekday reads 5 (Friday), finds it in {1..5}, and
    // generates a Saturday devotional for a user who asked for Mon–Fri:
    // the precise bug #188 exists to fix, reintroduced through the back
    // door. Only a zone-aware read skips here.
    const fixedNow = new Date('2026-07-17T22:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-sydney', email: null, timezone: 'Australia/Sydney' }]),
      preferences: fakePreferences([], [], [{ user_id: 'user-sydney', active_days: [1, 2, 3, 4, 5] }]),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skipped).toBe(1);
    expect(orchestrator.generateNow).not.toHaveBeenCalled();
    await app.close();
  });

  it('generates for a zone that is still on an active day while UTC has already rolled past it', async () => {
    // The mirror image, so the test above cannot pass merely by skipping
    // everyone in a non-UTC zone. 2026-07-18T02:00:00Z is Saturday in UTC
    // but Friday 2026-07-17 21:00 in America/Chicago (UTC-5 CDT). A
    // UTC-derived weekday would wrongly *withhold* this user's Friday
    // devotional.
    const fixedNow = new Date('2026-07-18T02:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-chicago', email: null, timezone: 'America/Chicago' }]),
      preferences: fakePreferences([], [], [{ user_id: 'user-chicago', active_days: [1, 2, 3, 4, 5] }]),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toBe(1);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({ userId: 'user-chicago' });
    await app.close();
  });

  it('one user\'s inactive day does not affect the rest of the batch', async () => {
    // Saturday. `user-weekend` selected Sat/Sun; `user-weekdays` did not.
    // Isolation matters here for the same reason AlreadyExistsError is a
    // skip: a fan-out must not let one user's ordinary "not today" cost
    // anyone else their devotional.
    const fixedNow = new Date('2026-07-18T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([
        { id: 'user-weekdays', email: null, timezone: 'UTC' },
        { id: 'user-weekend', email: null, timezone: 'UTC' },
      ]),
      preferences: fakePreferences(
        [],
        [],
        [
          { user_id: 'user-weekdays', active_days: [1, 2, 3, 4, 5] },
          { user_id: 'user-weekend', active_days: [0, 6] },
        ],
      ),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.triggered).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.failed).toBe(0);
    expect(orchestrator.generateNow).toHaveBeenCalledTimes(1);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({ userId: 'user-weekend' });
    await app.close();
  });

  it('fails open for a user with no preferences row at all', async () => {
    // Saturday, and the user is absent from the active-days lookup. A
    // missing row means "never expressed a day preference", not "selected
    // no days" — reading it as the latter would withhold devotionals from
    // a user who never asked for silence.
    const fixedNow = new Date('2026-07-18T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-no-row', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences([], [], [{ user_id: 'someone-else', active_days: [1] }]),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toBe(1);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({ userId: 'user-no-row' });
    await app.close();
  });

  it('still runs the sabbath session on a sabbath day excluded from active_days', async () => {
    // The deliberate ordering decision (see internal.ts): a sabbath day
    // resolves wholly through the sabbath rules. The shipped defaults are
    // active_days = Mon–Fri and sabbath_day = Sunday, so gating the
    // sabbath session on active_days would make `sabbath_session` dead
    // config for every user holding the defaults — fixing one ignored
    // preference by ignoring another (#193).
    const fixedNow = new Date('2026-07-19T12:00:00.000Z'); // Sunday
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-sabbath', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences(
        [],
        [{ user_id: 'user-sabbath', sabbath_day: 0, sabbath_session: true }],
        [{ user_id: 'user-sabbath', active_days: [1, 2, 3, 4, 5] }],
      ),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toBe(1);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({
      userId: 'user-sabbath',
      sabbathSession: true,
    });
    await app.close();
  });

  it('active-days awareness is silently disabled when the preferences dep is not wired', async () => {
    // Saturday. Same fail-open posture the sabbath gate takes: a deploy
    // without the repository wired should keep generating, not quietly
    // stop.
    const fixedNow = new Date('2026-07-18T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-no-prefs-dep', email: null, timezone: 'UTC' }]),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toBe(1);
    await app.close();
  });

  // --- time zone refresh (K1, #187) ---------------------------------------

  it('refreshes each connected user\'s calendar time zone before generating', async () => {
    // #185 only ever learned the zone at connect time, so users who
    // connected before it shipped are still on UTC, and nobody's zone
    // follows them when they move.
    const users = fakeUsers([{ id: 'user-1', email: null, timezone: 'UTC' }], {
      adoptTimezone: vi.fn().mockResolvedValue({ timezone: 'America/New_York' }),
    });
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users,
      getCalendarTimeZoneForUser: vi.fn().mockResolvedValue('America/New_York'),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().timezonesRefreshed).toBe(1);
    expect(users.adoptTimezone).toHaveBeenCalledWith('user-1', 'America/New_York', 'calendar');
    await app.close();
  });

  it('applies the freshly refreshed zone to the same run\'s sabbath check', async () => {
    // The refresh has to happen BEFORE the sabbath day-of-week
    // calculation, not after — otherwise the fix lands a day late for
    // every user whose stored zone is still the UTC default. Here the
    // stored zone is UTC (where it is already Sunday) but the calendar
    // says America/Chicago (where it is still Saturday), and sabbath_day=6
    // is Saturday: the user must be rested, which only happens if the
    // refreshed zone is what the check reads.
    const fixedNow = new Date('2026-07-05T02:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-tz', email: null, timezone: 'UTC' }], {
        adoptTimezone: vi.fn().mockResolvedValue({ timezone: 'America/Chicago' }),
      }),
      preferences: fakePreferences([], [{ user_id: 'user-tz', sabbath_day: 6, sabbath_session: false }]),
      getCalendarTimeZoneForUser: vi.fn().mockResolvedValue('America/Chicago'),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.json().skipped).toBe(1);
    expect(orchestrator.generateNow).not.toHaveBeenCalled();
    await app.close();
  });

  it('still generates the devotional when the time zone refresh throws', async () => {
    // Best-effort side work: a revoked token or a Calendar 5xx must not
    // cost this user (or anyone later in the loop) their devotional.
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-1', email: null, timezone: 'UTC' }]),
      getCalendarTimeZoneForUser: vi.fn().mockRejectedValue(new Error('token revoked')),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.timezonesRefreshed).toBe(0);
    await app.close();
  });

  it('runs normally when no calendar time zone lookup is wired at all', async () => {
    // A deploy without Google Calendar env vars configured — the device
    // zone from the preferences sync is its only signal, and the daily
    // run must not care.
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-1', email: null, timezone: 'UTC' }]),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.json().succeeded).toBe(1);
    expect(response.json().timezonesRefreshed).toBe(0);
    await app.close();
  });

  // ──────────────────────────────────────────────────────────────
  // Adaptive rhythm — effective days (P6 #325, epic #312)
  //
  // Same #193 standard as the K2 block above: every test asserts on
  // whether `generateNow` ran (and what the summary said), never merely
  // on values passed around. The engine itself is exercised for real —
  // only the repository reads under it are faked — so a test here cannot
  // pass while cadencePolicy.ts is inverted.
  // ──────────────────────────────────────────────────────────────

  it('rests a stated day outside the engine\'s effective set — skipped WITH the reason recorded, never silently', async () => {
    // 2026-07-22 is a Wednesday (day 3). The user stated Mon–Fri but the
    // engine previously eased them back to 2 days/week — effective days
    // are the first two in week order, [Mon, Tue] — so Wednesday rests.
    // The back-off was 2 days ago, so today's decision is a `hold` (the
    // 7-day limiter), which must NOT be persisted: recording holds
    // advances `adaptive_decided_at` daily and freezes the ladder shut.
    const fixedNow = new Date('2026-07-22T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const preferences = fakePreferences([], [], [
      {
        user_id: 'user-adaptive',
        active_days: [1, 2, 3, 4, 5],
        min_per_week: 1,
        adaptive_enabled: true,
        adaptive_days_per_week: 2,
        adaptive_reason: 'easing_back',
        adaptive_decided_at: new Date(fixedNow.getTime() - 2 * 86_400_000),
      },
    ]);
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-adaptive', email: null, timezone: 'UTC' }]),
      preferences,
      rhythm: fakeRhythm({ scheduled: unjoinedRows(3, fixedNow) }),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(0);
    expect(body.skipped).toBe(1);
    // A rhythm rest is a skip, never a failure — same reasoning as the
    // K2 gate: Cloud Scheduler must not alert on the engine working.
    expect(body.failed).toBe(0);
    expect(body.errors).toEqual([]);
    // The #286 lesson made observable: the rest carries its reason code.
    expect(body.skippedByRhythm).toEqual([{ userId: 'user-adaptive', reason: 'hold' }]);
    expect(orchestrator.generateNow).not.toHaveBeenCalled();
    expect(preferences.updateAdaptiveState).not.toHaveBeenCalled();
    await app.close();
  });

  it('generates for the same backed-off user on a day inside the effective set', async () => {
    // The pair that proves the skip above is caused by the day, not by
    // the gate rejecting adaptive users wholesale. 2026-07-20 is Monday
    // (day 1) — the first of the two effective days.
    const fixedNow = new Date('2026-07-20T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-adaptive', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences([], [], [
        {
          user_id: 'user-adaptive',
          active_days: [1, 2, 3, 4, 5],
          min_per_week: 1,
          adaptive_enabled: true,
          adaptive_days_per_week: 2,
          adaptive_reason: 'easing_back',
          adaptive_decided_at: new Date(fixedNow.getTime() - 2 * 86_400_000),
        },
      ]),
      rhythm: fakeRhythm({ scheduled: unjoinedRows(3, fixedNow) }),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(1);
    expect(body.skippedByRhythm).toEqual([]);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({ userId: 'user-adaptive' });
    await app.close();
  });

  it('persists a stepped-down decision exactly once, stamped with the run clock', async () => {
    // Never-adapted user (stored state null → current = ceiling 5) with
    // 3 unjoined invitations and no limiter clock: the engine steps down
    // to 4 (`easing_back`) and THAT is a state change, so it persists —
    // while today (Wednesday, day 3) is still inside [Mon..Thu], so the
    // devotional generates in the same run. Gating and persistence are
    // independent outcomes.
    const fixedNow = new Date('2026-07-22T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const preferences = fakePreferences([], [], [
      {
        user_id: 'user-adaptive',
        active_days: [1, 2, 3, 4, 5],
        min_per_week: 1,
        adaptive_enabled: true,
        adaptive_days_per_week: null,
        adaptive_reason: null,
        adaptive_decided_at: null,
      },
    ]);
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-adaptive', email: null, timezone: 'UTC' }]),
      preferences,
      rhythm: fakeRhythm({ scheduled: unjoinedRows(3, fixedNow) }),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toBe(1);
    expect(preferences.updateAdaptiveState).toHaveBeenCalledTimes(1);
    expect(preferences.updateAdaptiveState).toHaveBeenCalledWith('user-adaptive', {
      daysPerWeek: 4,
      reason: 'easing_back',
      decidedAt: fixedNow,
    });
    await app.close();
  });

  it('a hold for a never-adapted user writes no engine state (the ladder-freeze guard)', async () => {
    // No scheduled history → `no_data` at the ceiling. Numerically the
    // stored state is null and the decision says 5, but the engine
    // TREATS null as the ceiling, so nothing moved — and persisting this
    // "change" would start the 7-day limiter clock for a user the engine
    // has never actually touched. The naive `decision !== stored`
    // comparison is exactly the mutation this test exists to kill.
    const fixedNow = new Date('2026-07-22T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const preferences = fakePreferences([], [], [
      {
        user_id: 'user-adaptive',
        active_days: [1, 2, 3, 4, 5],
        min_per_week: 1,
        adaptive_enabled: true,
        adaptive_days_per_week: null,
        adaptive_reason: null,
        adaptive_decided_at: null,
      },
    ]);
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-adaptive', email: null, timezone: 'UTC' }]),
      preferences,
      rhythm: fakeRhythm(),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.json().succeeded).toBe(1);
    expect(preferences.updateAdaptiveState).not.toHaveBeenCalled();
    await app.close();
  });

  it('fails OPEN when the signal reads throw — full stated schedule, error collected, batch completes', async () => {
    // THE failure mode this story must never ship: "the adaptive engine
    // broke and silently stopped everyone's devotionals". The stored
    // state (2/week) would rest this Wednesday, but the engine cannot be
    // consulted — so the user gets their full Mon–Fri schedule, the
    // error is loud in the summary, and the next user is unaffected.
    // (Mutation check: fail-closed here turns succeeded 2 into 1.)
    const fixedNow = new Date('2026-07-22T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([
        { id: 'user-adaptive', email: null, timezone: 'UTC' },
        { id: 'user-plain', email: null, timezone: 'UTC' },
      ]),
      preferences: fakePreferences([], [], [
        {
          user_id: 'user-adaptive',
          active_days: [1, 2, 3, 4, 5],
          min_per_week: 1,
          adaptive_enabled: true,
          adaptive_days_per_week: 2,
          adaptive_reason: 'easing_back',
          adaptive_decided_at: new Date(fixedNow.getTime() - 2 * 86_400_000),
        },
      ]),
      rhythm: fakeRhythm({ signalsError: new Error('signals query exploded') }),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(2);
    // Not a `failed`: that count means "a user did not get their
    // devotional", and both users got theirs. The error is still visible.
    expect(body.failed).toBe(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].userId).toBe('user-adaptive');
    expect(body.errors[0].reason).toContain('signals query exploded');
    expect(body.skippedByRhythm).toEqual([]);
    expect(orchestrator.generateNow).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('adaptive_enabled=false bypasses the engine entirely — no signal reads, stale engine state ignored', async () => {
    // "Keep my schedule fixed" means the stated days, always — even with
    // a leftover adaptive_days_per_week=2 from before the user opted
    // out. The engine's inputs are not even loaded for them, which is
    // what keeps fixed-schedule scheduling byte-identical to K2.
    const fixedNow = new Date('2026-07-22T12:00:00.000Z'); // Wednesday
    const orchestrator = fakeOrchestrator();
    const rhythm = fakeRhythm({ scheduled: unjoinedRows(3, fixedNow) });
    const preferences = fakePreferences([], [], [
      {
        user_id: 'user-fixed',
        active_days: [1, 2, 3, 4, 5],
        min_per_week: 1,
        adaptive_enabled: false,
        adaptive_days_per_week: 2,
        adaptive_reason: 'easing_back',
        adaptive_decided_at: new Date(fixedNow.getTime() - 20 * 86_400_000),
      },
    ]);
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-fixed', email: null, timezone: 'UTC' }]),
      preferences,
      rhythm,
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.json().succeeded).toBe(1);
    expect(response.json().skippedByRhythm).toEqual([]);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({ userId: 'user-fixed' });
    expect(rhythm.sessions.listScheduledAttendance).not.toHaveBeenCalled();
    expect(preferences.updateAdaptiveState).not.toHaveBeenCalled();
    await app.close();
  });

  it('the opted-in sabbath session still runs on a sabbath day the engine would otherwise rest', async () => {
    // Ordering guard: the rhythm gate carries the same `!isSabbathToday`
    // deference as the K2 gate, because a sabbath day resolves wholly
    // through the sabbath rules — easing someone's week back must not
    // quietly turn off the extended session they explicitly opted into.
    // 2026-07-18 is Saturday (day 6): stated, but outside effective [1,2].
    const fixedNow = new Date('2026-07-18T12:00:00.000Z');
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-adaptive', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences(
        [],
        [{ user_id: 'user-adaptive', sabbath_day: 6, sabbath_session: true }],
        [
          {
            user_id: 'user-adaptive',
            active_days: [1, 2, 3, 4, 5, 6],
            min_per_week: 1,
            adaptive_enabled: true,
            adaptive_days_per_week: 2,
            adaptive_reason: 'easing_back',
            adaptive_decided_at: new Date(fixedNow.getTime() - 2 * 86_400_000),
          },
        ],
      ),
      rhythm: fakeRhythm({ scheduled: unjoinedRows(3, fixedNow) }),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.json().succeeded).toBe(1);
    expect(response.json().skippedByRhythm).toEqual([]);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({
      userId: 'user-adaptive',
      sabbathSession: true,
    });
    await app.close();
  });

  it('a day the user never stated is a plain skip, not a rhythm rest', async () => {
    // "You chose not to have Saturdays" and "we eased back your week"
    // must stay distinguishable in the logs — a Saturday skip for a
    // Mon–Fri adaptive user belongs to their own schedule, so it must
    // not surface in skippedByRhythm.
    const fixedNow = new Date('2026-07-18T12:00:00.000Z'); // Saturday
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      users: fakeUsers([{ id: 'user-adaptive', email: null, timezone: 'UTC' }]),
      preferences: fakePreferences([], [], [
        {
          user_id: 'user-adaptive',
          active_days: [1, 2, 3, 4, 5],
          min_per_week: 1,
          adaptive_enabled: true,
          adaptive_days_per_week: 2,
          adaptive_reason: 'easing_back',
          adaptive_decided_at: new Date(fixedNow.getTime() - 2 * 86_400_000),
        },
      ]),
      rhythm: fakeRhythm({ scheduled: unjoinedRows(3, fixedNow) }),
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.json().skipped).toBe(1);
    expect(response.json().skippedByRhythm).toEqual([]);
    expect(orchestrator.generateNow).not.toHaveBeenCalled();
    await app.close();
  });
});

// ──────────────────────────────────────────────────────────────
// POST /internal/backfill-timezones (K1, #187)
// ──────────────────────────────────────────────────────────────

describe('POST /internal/backfill-timezones', () => {
  it('401s when X-Internal-Token is missing', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users: fakeUsers(),
      getCalendarTimeZoneForUser: vi.fn(),
      internalApiToken: 'secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/backfill-timezones',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('501s when the calendar time zone lookup is not wired', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users: fakeUsers(),
      internalApiToken: 'secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/backfill-timezones',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });
    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it('adopts the calendar zone for every user still on the untouched default', async () => {
    const users = fakeUsers([], {
      listAwaitingCalendarTimezone: vi.fn().mockResolvedValue(['user-1', 'user-2']),
      adoptTimezone: vi
        .fn()
        .mockResolvedValueOnce({ timezone: 'America/New_York' })
        .mockResolvedValueOnce({ timezone: 'Europe/Berlin' }),
    });
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users,
      getCalendarTimeZoneForUser: vi
        .fn()
        .mockResolvedValueOnce('America/New_York')
        .mockResolvedValueOnce('Europe/Berlin'),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/backfill-timezones',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      examined: 2,
      updated: 2,
      unchanged: 0,
      unavailable: 0,
      failed: 0,
    });
    expect(users.adoptTimezone).toHaveBeenCalledWith('user-1', 'America/New_York', 'calendar');
    expect(users.adoptTimezone).toHaveBeenCalledWith('user-2', 'Europe/Berlin', 'calendar');
    await app.close();
  });

  it('keeps going past a user whose calendar cannot be read, and counts them apart from failures', async () => {
    // A one-off sweep that aborts on the first revoked token would leave
    // the rest of the fleet on UTC — the exact state it exists to fix.
    // `unavailable` is counted separately from `failed` because it is not
    // an error to go fix, just a user this sweep cannot reach.
    const users = fakeUsers([], {
      listAwaitingCalendarTimezone: vi.fn().mockResolvedValue(['bad', 'silent', 'good']),
      adoptTimezone: vi.fn().mockResolvedValue({ timezone: 'Australia/Sydney' }),
    });
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users,
      getCalendarTimeZoneForUser: vi
        .fn()
        .mockRejectedValueOnce(new Error('token revoked'))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce('Australia/Sydney'),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/backfill-timezones',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.json()).toMatchObject({
      examined: 3,
      updated: 1,
      unavailable: 1,
      failed: 1,
    });
    await app.close();
  });

  it('is idempotent — a re-run with nothing left to fix is a no-op, not an error', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users: fakeUsers(),
      getCalendarTimeZoneForUser: vi.fn(),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/backfill-timezones',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, examined: 0, updated: 0 });
    await app.close();
  });
});

// ──────────────────────────────────────────────────────────────
// POST /internal/trigger-examen-run (issue #77)
// ──────────────────────────────────────────────────────────────

describe('POST /internal/trigger-examen-run', () => {
  it('401s when X-Internal-Token is missing', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      preferences: fakePreferences(),
      internalApiToken: 'secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-examen-run',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('501 when preferences repository is not wired', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      preferences: undefined,
      internalApiToken: 'secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-examen-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });
    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it('returns triggered/succeeded/skipped/failed counts for an empty examen-enabled list', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      preferences: fakePreferences([]),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-examen-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.triggered).toBe(0);
    expect(body.succeeded).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.errors).toEqual([]);
    await app.close();
  });

  it('calls generateNow with slotType=examen + skipCalendar=true for each examen-enabled user', async () => {
    const orchestrator = fakeOrchestrator();
    const app = buildTestApp({
      orchestrator,
      preferences: fakePreferences([{ user_id: 'user-a' }, { user_id: 'user-b' }]),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-examen-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.triggered).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({
      userId: 'user-a',
      slotType: 'examen',
      skipCalendar: true,
    });
    expect(orchestrator.generateNow).toHaveBeenCalledWith({
      userId: 'user-b',
      slotType: 'examen',
      skipCalendar: true,
    });
    await app.close();
  });

  it('counts AlreadyExistsError as skipped (idempotent), not failed', async () => {
    let callCount = 0;
    const orchestrator = {
      generateNow: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(
            new AlreadyExistsError('devo-x', 'tok-x', 'http://localhost:8080/session/tok-x'),
          );
        }
        return Promise.resolve({
          sessionUrl: 'http://localhost:8080/session/new',
          sessionToken: 'new',
          devotionalId: 'devo-y',
          devotional: {},
          source: 'gloo',
          audio: { status: 'uploaded', objectKey: 'k' },
        });
      }),
    } as unknown as GenerateNowOrchestrator;

    const app = buildTestApp({
      orchestrator,
      preferences: fakePreferences([{ user_id: 'user-existing' }, { user_id: 'user-new' }]),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-examen-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.triggered).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.failed).toBe(0);
    await app.close();
  });

  it('counts unexpected errors as failed and includes them in errors[], but continues the batch', async () => {
    const orchestrator = {
      generateNow: vi.fn().mockImplementation(({ userId }: { userId: string }) => {
        if (userId === 'user-fail') {
          return Promise.reject(new Error('something broke'));
        }
        return Promise.resolve({
          sessionUrl: 'http://localhost:8080/session/tok',
          sessionToken: 'tok',
          devotionalId: 'devo-ok',
          devotional: {},
          source: 'gloo',
          audio: { status: 'uploaded', objectKey: 'k' },
        });
      }),
    } as unknown as GenerateNowOrchestrator;

    const app = buildTestApp({
      orchestrator,
      preferences: fakePreferences([
        { user_id: 'user-ok' },
        { user_id: 'user-fail' },
        { user_id: 'user-ok2' },
      ]),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-examen-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.triggered).toBe(3);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].userId).toBe('user-fail');
    expect(body.errors[0].reason).toContain('something broke');
    await app.close();
  });

  it('is never gated by the adaptive rhythm engine (P6 #325 — the rhythm governs the standard morning slot only)', async () => {
    // The same epic exemption that keeps distress check-ins fully outside
    // the engine (they never enter P4's denominator and their route never
    // consults the gate): an adaptive user rested down to 2/week still
    // gets their evening examen on a rested day, and the engine's signal
    // reads are not even attempted here.
    const fixedNow = new Date('2026-07-22T12:00:00.000Z'); // Wednesday — outside effective [Mon, Tue]
    const orchestrator = fakeOrchestrator();
    const rhythm = fakeRhythm({ scheduled: unjoinedRows(3, fixedNow) });
    const app = buildTestApp({
      orchestrator,
      preferences: fakePreferences(
        [{ user_id: 'user-adaptive' }],
        [],
        [
          {
            user_id: 'user-adaptive',
            active_days: [1, 2, 3, 4, 5],
            min_per_week: 1,
            adaptive_enabled: true,
            adaptive_days_per_week: 2,
            adaptive_reason: 'easing_back',
            adaptive_decided_at: new Date(fixedNow.getTime() - 2 * 86_400_000),
          },
        ],
      ),
      rhythm,
      internalApiToken: 'secret',
      now: () => fixedNow,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-examen-run',
      headers: { 'x-internal-token': 'secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toBe(1);
    expect(orchestrator.generateNow).toHaveBeenCalledWith({
      userId: 'user-adaptive',
      slotType: 'examen',
      skipCalendar: true,
    });
    expect(rhythm.sessions.listScheduledAttendance).not.toHaveBeenCalled();
    await app.close();
  });
});

// ──────────────────────────────────────────────────────────────
// POST /internal/purge
// ──────────────────────────────────────────────────────────────

describe('POST /internal/purge', () => {
  it('401s when X-Internal-Token is missing', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      purgeJobs: fakePurgeJobs(),
      internalApiToken: 'secret',
    });
    const response = await app.inject({ method: 'POST', url: '/internal/purge' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('501 when purge job dependencies are not wired', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      purgeJobs: undefined,
      internalApiToken: 'secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/purge',
      headers: { 'x-internal-token': 'secret' },
    });
    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it('runs all three sweeps and returns their counts', async () => {
    const dailyBands = { purgeOlderThan: vi.fn().mockResolvedValue(3) } as unknown as PurgeJobsDeps['dailyBands'];
    const devotionals = {
      findWithAudioOlderThan: vi.fn().mockResolvedValue([{ id: 'devo-1' }, { id: 'devo-2' }]),
      clearAudioObject: vi.fn().mockResolvedValue(undefined),
    } as unknown as PurgeJobsDeps['devotionals'];
    const sessions = { purgeExpiredBefore: vi.fn().mockResolvedValue(5) } as unknown as PurgeJobsDeps['sessions'];
    const users = fakeUsers([{ id: 'user-a', email: null }]);
    const audioStorage = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as PurgeJobsDeps['audioStorage'];

    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      purgeJobs: fakePurgeJobs({ dailyBands, devotionals, sessions, users, audioStorage }),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/purge',
      headers: { 'x-internal-token': 'secret' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.dailyBandsDeleted).toBe(3);
    expect(body.devotionalAudioPurged).toBe(2);
    expect(body.sessionsDeleted).toBe(5);
    expect(users.listAllIds).toHaveBeenCalled();
    expect(dailyBands.purgeOlderThan).toHaveBeenCalledWith('user-a', 90);
    await app.close();
  });
});

describe('POST /internal/trigger-reschedule-check', () => {
  it('401s when X-Internal-Token is missing', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      rescheduleWatcher: fakeRescheduleWatcherDeps(),
      internalApiToken: 'secret',
    });
    const response = await app.inject({ method: 'POST', url: '/internal/trigger-reschedule-check' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('501 when reschedule watcher dependencies are not wired', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      rescheduleWatcher: undefined,
      internalApiToken: 'secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-reschedule-check',
      headers: { 'x-internal-token': 'secret' },
    });
    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it('501 when users repository is not wired, even if rescheduleWatcher deps are present', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users: undefined,
      rescheduleWatcher: fakeRescheduleWatcherDeps(),
      internalApiToken: 'secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-reschedule-check',
      headers: { 'x-internal-token': 'secret' },
    });
    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it('fans out over listWithActiveGoogleCalendar and returns the check summary', async () => {
    const activeUsers = fakeUsers([{ id: 'user-a', email: null }, { id: 'user-b', email: null }]);
    const rescheduleUsers = { findById: vi.fn().mockResolvedValue(null) } as unknown as RescheduleWatcherDeps['users'];
    const connections = {
      findByProvider: vi.fn().mockResolvedValue(null), // no active connection -> both users skipped, checked stays 0
    } as unknown as RescheduleWatcherDeps['connections'];

    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      users: activeUsers,
      rescheduleWatcher: fakeRescheduleWatcherDeps({ users: rescheduleUsers, connections }),
      internalApiToken: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/trigger-reschedule-check',
      headers: { 'x-internal-token': 'secret' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.checked).toBe(0);
    expect(body.moved).toBe(0);
    expect(activeUsers.listWithActiveGoogleCalendar).toHaveBeenCalled();
    expect(connections.findByProvider).toHaveBeenCalledTimes(2); // once per fanned-out user
    await app.close();
  });
});

// ──────────────────────────────────────────────────────────────
// POST /internal/dispatch-meetbot
// ──────────────────────────────────────────────────────────────

describe('POST /internal/dispatch-meetbot', () => {
  it('401s when X-Internal-Token is missing', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: new FakeAttendeeClient() as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('501s when meetBotDispatch deps are not wired', async () => {
    const app = buildTestApp({ orchestrator: fakeOrchestrator(), internalApiToken: 'secret-token' });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
    });

    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it('400s on a malformed body', async () => {
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: new FakeAttendeeClient() as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij' }, // missing devotionalId
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('dispatches the bot, builds a per-devotional capability audio URL, and returns the result (#221)', async () => {
    const fakeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: fakeClient as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    // The URL handed to Attendee carries a token derived from THIS
    // devotional id, not a shared global secret (#221). Asserting the
    // derived value rather than a hardcoded string keeps the test honest
    // about which id the capability is bound to.
    const expectedToken = deriveMeetBotAudioToken(TEST_AUDIO_TOKEN_SECRET, 'devo-1');
    expect(fakeClient.createBotCalls[0]!.audioWebsocketUrl).toBe(
      `wss://api.example.com/meetbot/audio/${expectedToken}/devo-1`,
    );
    // The root secret itself must never appear in what we send a third party.
    expect(fakeClient.createBotCalls[0]!.audioWebsocketUrl).not.toContain(TEST_AUDIO_TOKEN_SECRET);
    expect(fakeClient.createBotCalls[0]!.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    await app.close();
  });

  // ────────────────────────────────────────────────────────────
  // Fire-time consent gate (#217, epic #186)
  //
  // Per #193, these prove BEHAVIOR, not bookkeeping: every refusal case
  // asserts `createBotCalls` is empty — no Attendee bot was created — not
  // merely that some status check was consulted. A test that only asserted
  // "findByProvider was called" would still pass if the gate read the
  // connection and then dispatched anyway, which is precisely the bug.
  // ────────────────────────────────────────────────────────────

  it('does not create a bot when the user disconnected their calendar after the task was enqueued', async () => {
    const fakeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: fakeClient as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
        consentGate: fakeConsentGate({ connectionStatus: 'revoked' }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
    });

    // THE assertion this whole issue is about: no bot joined the meeting.
    expect(fakeClient.createBotCalls).toHaveLength(0);

    // 2xx so Cloud Tasks marks the task done. A non-2xx refusal would be
    // re-delivered (queue `maxAttempts: 2`) only to be refused again.
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.dispatched).toBe(false);
    expect(body.reason).toBe('connection_revoked');
    await app.close();
  });

  it('does not create a bot when the user deleted their account after the task was enqueued', async () => {
    // Account deletion hard-deletes the `users` row, which cascades to
    // `devotionals` — so the queued task arrives pointing at a devotional
    // id that resolves to nothing.
    const fakeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: fakeClient as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
        consentGate: fakeConsentGate({ ownerUserId: null }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-gone' },
    });

    expect(fakeClient.createBotCalls).toHaveLength(0);
    expect(response.statusCode).toBe(200);
    expect(response.json().dispatched).toBe(false);
    expect(response.json().reason).toBe('devotional_not_found');
    await app.close();
  });

  it('does not create a bot when the devotional outlives its user row', async () => {
    // Should be unreachable through the FK, but the gate must fail closed
    // on it rather than inferring the user still exists.
    const fakeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: fakeClient as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
        consentGate: fakeConsentGate({ userExists: false }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
    });

    expect(fakeClient.createBotCalls).toHaveLength(0);
    expect(response.statusCode).toBe(200);
    expect(response.json().reason).toBe('user_not_found');
    await app.close();
  });

  it('does not create a bot when there is no calendar connection row at all', async () => {
    const fakeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: fakeClient as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
        consentGate: fakeConsentGate({ connectionStatus: null }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
    });

    expect(fakeClient.createBotCalls).toHaveLength(0);
    expect(response.statusCode).toBe(200);
    expect(response.json().reason).toBe('connection_missing');
    await app.close();
  });

  it('does not create a bot for an unrecognized connection status (fails closed, not open)', async () => {
    // The gate tests `status === 'active'` positively. If it had been
    // written as `status !== 'revoked'`, a future status value would sail
    // straight through and dispatch a bot — this test is what stops that
    // refactor from landing quietly.
    const fakeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: fakeClient as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
        consentGate: fakeConsentGate({ connectionStatus: 'suspended' }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
    });

    expect(fakeClient.createBotCalls).toHaveLength(0);
    expect(response.json().reason).toBe('connection_revoked');
    await app.close();
  });

  it('does not create a bot when the consent lookup itself fails, and returns a retryable 500', async () => {
    // "We could not determine consent" is not "consent was withdrawn". A
    // 500 lets Cloud Tasks retry — and no bot is created on either
    // attempt, which is the property that matters.
    const fakeClient = new FakeAttendeeClient({ stateSequence: ['joined_recording', 'ended'] });
    const brokenGate = {
      devotionals: { findOwnerUserId: vi.fn().mockRejectedValue(new Error('connection terminated')) },
      users: { findById: vi.fn() },
      connections: { findByProvider: vi.fn() },
    } as unknown as MeetBotConsentGateDeps;

    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: fakeClient as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
        consentGate: brokenGate,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
    });

    expect(fakeClient.createBotCalls).toHaveLength(0);
    expect(response.statusCode).toBe(500);
    await app.close();
  });

  it('never reaches the consent gate without a valid internal token', async () => {
    // Ordering guard: auth still precedes the gate, so an unauthenticated
    // caller cannot use this endpoint to probe whether a given devotional
    // id exists or whether its owner is still connected.
    const gate = fakeConsentGate();
    const app = buildTestApp({
      orchestrator: fakeOrchestrator(),
      internalApiToken: 'secret-token',
      meetBotDispatch: {
        attendeeClient: new FakeAttendeeClient() as unknown as AttendeeClient,
        audioWebsocketBaseUrl: 'wss://api.example.com/meetbot/audio',
        consentGate: gate,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/dispatch-meetbot',
      headers: { 'x-internal-token': 'wrong' },
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
    });

    expect(response.statusCode).toBe(401);
    expect(gate.devotionals.findOwnerUserId).not.toHaveBeenCalled();
    await app.close();
  });
});
