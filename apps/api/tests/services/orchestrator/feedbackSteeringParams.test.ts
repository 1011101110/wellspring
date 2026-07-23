/**
 * P7 (#326) golden tests: seeded feedback rows → the EXACT params a spied
 * `DevotionalEngine.generate` receives, through the real orchestrator +
 * the real `FeedbackSteering` loader (fake repositories, no Postgres — so
 * this suite runs in the default `vitest run` pass, the
 * preferenceTraceability harness precedent).
 *
 * The load-bearing assertions, per the issue's acceptance criteria:
 *  - each nudge lands as the expected param (theme, durationPreference,
 *    calendar slot choice), with the threshold's mutation partner
 *    asserted in the pure-function suite (feedbackSteering.test.ts);
 *  - an explicit stored duration is byte-identically respected;
 *  - zero feedback rows → engine params deep-equal a run with no
 *    steering wired at all (the regression pin);
 *  - the distress and unsteered (generate-now-shaped) paths never even
 *    consult the steering service.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GenerateNowOrchestrator,
  nudgeDuration,
  DURATION_BANDS,
} from '../../../src/services/orchestrator/generateNowOrchestrator.js';
import { FeedbackSteering } from '../../../src/services/rhythm/feedbackSteering.js';
import type { SteeringFeedbackRow } from '../../../src/db/repositories/sessionFeedbackRepository.js';
import type {
  CalendarEventsRepository,
  ConnectionsRepository,
  DailyBandsRepository,
  DevotionalsRepository,
  PreferencesRepository,
  SessionsRepository,
  UsersRepository,
} from '../../../src/db/repositories/index.js';
import type {
  DevotionalEngine,
  GenerateDevotionalParams,
} from '../../../src/services/devotionalEngine.js';
import type { TtsService } from '../../../src/services/tts/ttsService.js';
import type { AudioStorage } from '../../../src/services/audio/audioStorage.js';
import type { GoogleCalendarClient } from '../../../src/services/calendar/googleCalendarClient.js';
import type { GoogleKmsService } from '../../../src/services/calendar/googleKmsService.js';
import type { DevotionalFormat, DevotionalOutput } from '@kairos/shared-contracts';

const NOW = new Date('2026-07-23T12:00:00Z');
const MS_PER_DAY = 86_400_000;

const DEVOTIONAL: DevotionalOutput = {
  format: 'short',
  theme: 'Rest for the weary',
  verses: [
    {
      usfm: 'MAT.11.28',
      versionId: 3034,
      fetchedText: 'Come to me, all you who are weary.',
      attribution: 'Berean Standard Bible',
    },
  ],
  devotionalBody: 'Body.',
  cardSummary: 'Summary.',
  prayer: 'Prayer.',
};

function fb(
  daysAgo: number,
  answers: Partial<Pick<SteeringFeedbackRow, 'topic_more' | 'length_feel' | 'time_feel'>> & {
    theme?: string | null;
  } = {},
): SteeringFeedbackRow {
  return {
    created_at: new Date(NOW.getTime() - daysAgo * MS_PER_DAY),
    topic_more: answers.topic_more ?? null,
    length_feel: answers.length_feel ?? null,
    time_feel: answers.time_feel ?? null,
    devotional_theme: answers.theme ?? null,
  };
}

/** The full preferences row both the orchestrator's loadPreferences and the steering loader read. */
function prefsRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'user-1',
    window_start_local: '09:00:00',
    window_end_local: '17:00:00',
    active_days: [1, 2, 3, 4, 5],
    cadence: 'weekdays',
    duration_preference: null,
    voice: 'en-US-Chirp3-HD-Achernar',
    stillness: 'off',
    lectio: false,
    calendar_enabled: true,
    health_enabled: true,
    communication_enabled: true,
    notify_on_skip: true,
    examen_enabled: false,
    sabbath_day: 0,
    sabbath_enabled: false,
    sabbath_session: false,
    liturgical_seasons_enabled: false,
    min_per_week: 2,
    adaptive_enabled: true,
    adaptive_days_per_week: null,
    adaptive_reason: null,
    adaptive_decided_at: null,
    preferred_time_local: null,
    updated_at: new Date('2026-07-18T00:00:00Z'),
    ...overrides,
  };
}

function buildHarness(opts: {
  feedback?: SteeringFeedbackRow[];
  recentThemes?: string[];
  prefs?: Record<string, unknown>;
  /** Omit the FeedbackSteering dep entirely (the pre-P7 construction). */
  withoutSteering?: boolean;
  withCalendar?: boolean;
  busyBlocks?: Array<{ start: string; end: string }>;
}) {
  const engineParams: GenerateDevotionalParams[] = [];
  const insertEventCalls: Array<Record<string, unknown>> = [];
  const prefs = prefsRow(opts.prefs ?? {});

  const users = {
    findById: vi.fn().mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      tradition: 'general',
      translation_id: 3034,
      language: 'en',
      timezone: 'UTC',
    }),
  } as unknown as UsersRepository;
  const preferencesRepo = {
    get: vi.fn().mockResolvedValue(prefs),
    updatePreferredTimeLocal: vi.fn().mockResolvedValue(undefined),
  };
  const dailyBands = {
    getForDate: vi.fn().mockResolvedValue(null),
  } as unknown as DailyBandsRepository;
  const devotionalsRepo = {
    getForDate: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockImplementation((_uid: string, input: Record<string, unknown>) =>
        Promise.resolve({ id: 'devo-1', ...input }),
      ),
    setAudioObject: vi.fn().mockResolvedValue(undefined),
    listRecentThemes: vi.fn().mockResolvedValue(opts.recentThemes ?? []),
  };
  const sessions = {
    create: vi.fn().mockResolvedValue({ id: 'sess-1', token: 'tok-1' }),
    listForUser: vi.fn().mockResolvedValue([]),
    updateExpiry: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionsRepository;
  const devotionalEngine = {
    generate: vi.fn().mockImplementation((params: GenerateDevotionalParams) => {
      engineParams.push(params);
      return Promise.resolve({ devotional: DEVOTIONAL, source: 'gloo' as const });
    }),
  } as unknown as DevotionalEngine;
  const ttsService = {
    synthesize: vi.fn().mockResolvedValue({
      audio: Buffer.from('mp3'),
      segmentCount: 1,
      charCount: 10,
      voiceName: 'x',
    }),
  } as unknown as TtsService;
  const audioStorage = {
    upload: vi.fn().mockResolvedValue({ objectKey: 'devotionals/devo-1.mp3' }),
  } as unknown as AudioStorage;

  const steering = new FeedbackSteering({
    feedback: { listRecentForSteering: vi.fn().mockResolvedValue(opts.feedback ?? []) },
    devotionals: devotionalsRepo,
    preferences: preferencesRepo,
  });
  const deriveSpy = vi.spyOn(steering, 'deriveSteering');

  const calendarDeps = opts.withCalendar
    ? {
        connections: {
          findByProvider: vi
            .fn()
            .mockResolvedValue({ status: 'active', encrypted_refresh_token: 'enc' }),
        } as unknown as ConnectionsRepository,
        kmsService: {
          decryptToken: vi.fn().mockResolvedValue('refresh'),
        } as unknown as GoogleKmsService,
        calendarEvents: {
          create: vi.fn().mockResolvedValue({ id: 'ce-1' }),
        } as unknown as CalendarEventsRepository,
        calendarClient: {
          withRefreshToken: vi.fn().mockReturnValue({
            getFreeBusyBlocks: vi.fn().mockResolvedValue(opts.busyBlocks ?? []),
            insertEvent: vi.fn().mockImplementation((args: Record<string, unknown>) => {
              insertEventCalls.push(args);
              return Promise.resolve({ eventId: 'gcal-1', meetUri: undefined });
            }),
          }),
        } as unknown as GoogleCalendarClient,
      }
    : {};

  const orchestrator = new GenerateNowOrchestrator({
    users,
    preferences: preferencesRepo as unknown as PreferencesRepository,
    dailyBands,
    devotionals: devotionalsRepo as unknown as DevotionalsRepository,
    sessions,
    devotionalEngine,
    ttsService,
    audioStorage,
    publicBaseUrl: 'http://localhost:8080',
    now: () => NOW,
    logger: { info: vi.fn(), error: vi.fn() },
    ...(opts.withoutSteering ? {} : { feedbackSteering: steering }),
    ...calendarDeps,
  });

  return {
    orchestrator,
    engineParams,
    insertEventCalls,
    deriveSpy,
    updatePreferredTimeLocal: preferencesRepo.updatePreferredTimeLocal,
  };
}

describe('P7 golden params — theme steering', () => {
  it('passes the praised devotional theme as the engine `theme` param', async () => {
    const h = buildHarness({
      feedback: [fb(1, { topic_more: true, theme: 'Hope in waiting' })],
      recentThemes: ['Hope in waiting'],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    expect(h.engineParams).toHaveLength(1);
    expect(h.engineParams[0]!.theme).toBe('Hope in waiting');
  });

  it('prayer intention outranks the steered theme (precedence rung 2 over rung 3)', async () => {
    const h = buildHarness({
      feedback: [fb(1, { topic_more: true, theme: 'Hope in waiting' })],
      recentThemes: ['Hope in waiting'],
    });
    // Wire a prayer-intentions repo by rebuilding params: simplest is the
    // inviteContext rung, which is a call-site param.
    await h.orchestrator.generateNow({
      userId: 'user-1',
      applyFeedbackSteering: true,
      skipCalendar: true,
      inviteContext: 'Our team standup — pray for focus',
    });
    expect(h.engineParams[0]!.theme).toBeUndefined();
    expect(h.engineParams[0]!.inviteContext).toBe('Our team standup — pray for focus');
  });
});

describe('P7 golden params — duration nudge', () => {
  it('2-of-3 "shorter" on an auto preference: the auto band (standard, neutral bands) arrives nudged to short', async () => {
    const h = buildHarness({
      feedback: [
        fb(1, { length_feel: 'shorter' }),
        fb(2, { length_feel: 'right' }),
        fb(3, { length_feel: 'shorter' }),
      ],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    expect(h.engineParams[0]!.durationPreference).toBe('short');
  });

  it('"longer" is symmetric: standard → extended', async () => {
    const h = buildHarness({
      feedback: [fb(1, { length_feel: 'longer' }), fb(2, { length_feel: 'longer' })],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    expect(h.engineParams[0]!.durationPreference).toBe('extended');
  });

  it('an explicit stored duration is respected byte-for-byte — params unchanged despite a "longer" majority', async () => {
    const h = buildHarness({
      prefs: { duration_preference: 'short' },
      feedback: [fb(1, { length_feel: 'longer' }), fb(2, { length_feel: 'longer' })],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    const control = buildHarness({ prefs: { duration_preference: 'short' }, withoutSteering: true });
    await control.orchestrator.generateNow({ userId: 'user-1', skipCalendar: true });
    expect(h.engineParams[0]).toEqual(control.engineParams[0]);
    expect(h.engineParams[0]!.durationPreference).toBe('short');
  });

  it('nudgeDuration clamps at both ends of the ladder', () => {
    expect(nudgeDuration('micro', 'shorter')).toBe('micro');
    expect(nudgeDuration('extended', 'longer')).toBe('extended');
    expect(nudgeDuration('standard', 'shorter')).toBe('short');
    for (const band of DURATION_BANDS) {
      expect(DURATION_BANDS).toContain(nudgeDuration(band as DevotionalFormat, 'shorter'));
      expect(DURATION_BANDS).toContain(nudgeDuration(band as DevotionalFormat, 'longer'));
    }
  });
});

describe('P7 golden params — regression and exemptions', () => {
  it('zero feedback rows: engine params deep-equal a run with no steering wired at all', async () => {
    const steered = buildHarness({ feedback: [] });
    await steered.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    const unsteered = buildHarness({ withoutSteering: true });
    await unsteered.orchestrator.generateNow({ userId: 'user-1', skipCalendar: true });
    expect(steered.engineParams[0]).toEqual(unsteered.engineParams[0]);
    expect('theme' in steered.engineParams[0]!).toBe(false);
  });

  it('a caller that does not opt in (generate-now shape) never consults the steering service', async () => {
    const h = buildHarness({
      feedback: [fb(1, { topic_more: true, theme: 'Hope' })],
      recentThemes: ['Hope'],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', skipCalendar: true });
    expect(h.deriveSpy).not.toHaveBeenCalled();
    expect(h.engineParams[0]!.theme).toBeUndefined();
  });

  it('the distress path is untouched even when the flag is set', async () => {
    const h = buildHarness({
      feedback: [
        fb(1, { topic_more: true, theme: 'Hope', length_feel: 'shorter' }),
        fb(2, { length_feel: 'shorter' }),
      ],
      recentThemes: ['Hope'],
    });
    await h.orchestrator.generateNow({
      userId: 'user-1',
      applyFeedbackSteering: true,
      distressSignalOverride: true,
      skipIdempotencyCheck: true,
      skipCalendar: true,
    });
    expect(h.deriveSpy).not.toHaveBeenCalled();
    expect(h.engineParams[0]!.theme).toBeUndefined();
    expect(h.engineParams[0]!.durationPreference).toBeUndefined();
    expect(h.engineParams[0]!.bands.distressSignal).toBe(true);
  });

  it('the examen slot never steers', async () => {
    const h = buildHarness({
      feedback: [fb(1, { topic_more: true, theme: 'Hope' })],
      recentThemes: ['Hope'],
    });
    await h.orchestrator.generateNow({
      userId: 'user-1',
      applyFeedbackSteering: true,
      slotType: 'examen',
      skipCalendar: true,
    });
    expect(h.deriveSpy).not.toHaveBeenCalled();
  });

  it('a steering failure fails OPEN: the devotional still generates, unsteered', async () => {
    const h = buildHarness({ feedback: [fb(1, { topic_more: true, theme: 'Hope' })] });
    h.deriveSpy.mockRejectedValueOnce(new Error('steering exploded (test)'));
    const result = await h.orchestrator.generateNow({
      userId: 'user-1',
      applyFeedbackSteering: true,
      skipCalendar: true,
    });
    expect(result.devotionalId).toBe('devo-1');
    expect(h.engineParams[0]!.theme).toBeUndefined();
  });
});

describe('P7 golden params — time-of-day bias in the calendar step', () => {
  // Window 09:00–17:00 UTC on tomorrow (2026-07-24). One busy block
  // 10:00–15:00 leaves two gaps after edge/meeting buffers:
  //   morning  09:30–09:50 (20 min), afternoon 15:10–16:30 (80 min).
  const BUSY = [{ start: '2026-07-24T10:00:00Z', end: '2026-07-24T15:00:00Z' }];

  it('without a preferred time the longest gap wins (pre-P7 behavior)', async () => {
    const h = buildHarness({ withCalendar: true, busyBlocks: BUSY, withoutSteering: true });
    await h.orchestrator.generateNow({ userId: 'user-1' });
    expect(h.insertEventCalls).toHaveLength(1);
    expect(h.insertEventCalls[0]!.startDateTime).toBe('2026-07-24T15:10:00.000Z');
  });

  it('an established preferred time pulls the slot to the nearest gap instead', async () => {
    const h = buildHarness({
      withCalendar: true,
      busyBlocks: BUSY,
      prefs: { preferred_time_local: '09:40:00' },
      // A stored bias persists with no fresh feedback rows — but the
      // loader short-circuits only when BOTH feedback and the stored
      // value are empty, so seed one inert row to exercise the real path.
      feedback: [fb(1, { topic_more: null })],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true });
    expect(h.insertEventCalls).toHaveLength(1);
    expect(h.insertEventCalls[0]!.startDateTime).toBe('2026-07-24T09:30:00.000Z');
  });

  it('a fresh "earlier" majority persists the shifted time through the repository', async () => {
    const h = buildHarness({
      withCalendar: true,
      busyBlocks: BUSY,
      feedback: [fb(1, { time_feel: 'earlier' }), fb(2, { time_feel: 'earlier' })],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true });
    // Midpoint 13:00 − 30 min = 12:30, inside the window.
    expect(h.updatePreferredTimeLocal).toHaveBeenCalledWith('user-1', '12:30:00');
  });

  it('a user-initiated generate-now keeps longest-gap-first even with a stored preferred time', async () => {
    const h = buildHarness({
      withCalendar: true,
      busyBlocks: BUSY,
      prefs: { preferred_time_local: '09:40:00' },
    });
    await h.orchestrator.generateNow({ userId: 'user-1' });
    expect(h.insertEventCalls[0]!.startDateTime).toBe('2026-07-24T15:10:00.000Z');
  });
});
