/**
 * Preference -> engine traceability (K7, issue #193).
 *
 * WHY this file exists separately from the per-service suites: those suites
 * prove each service behaves correctly *given* an input. This one proves the
 * input actually arrives — that a value a user stores in `preferences`/`users`
 * reaches a consumer and demonstrably changes generated output or a scheduling
 * decision.
 *
 * The distinction is not academic. `users.timezone` (issue #187) was threaded
 * through repository, orchestrator, and calendar client for months — every
 * layer "passed it correctly" — and still produced a 3:30am devotional, because
 * the one place that mattered never applied it. `preferences.cadence` (#188) is
 * stored, constrained, and round-tripped by the API, and no code reads it.
 * Both were found by accident. Every assertion here is therefore of the form
 * "change the stored value, observe the OUTPUT differ" — never "the value was
 * passed to a function".
 *
 * Tests are deliberately fake-backed (no Postgres, no Docker) so this suite
 * runs in the default `vitest run` pass. Where a field's only consumer is a DB
 * query predicate, the fake repository stands in for the query and the
 * assertion is on the resulting scheduling decision.
 *
 * Fields with NO consumer are covered by the `dead config` describe block
 * below. Those tests assert the CURRENT (ignored) behavior on purpose: they
 * are characterization tests, and each one is expected to be inverted — not
 * deleted — by whoever wires the field up. Deleting the columns is a separate
 * decision (#193 acceptance explicitly defers it).
 *
 * The full field-by-field table lives in docs/03_API_INTEGRATION_SPEC.md §12.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  ALL_SIGNALS_OBSERVED,
  NO_SIGNALS_OBSERVED,
  buildInstructions,
  resolveTargetFormat,
} from '../../src/services/gloo/instructionsBuilder.js';
import { buildDevotionalSsml } from '../../src/services/tts/ssmlBuilder.js';
import { registerInternalRoutes } from '../../src/routes/internal.js';
import {
  GenerateNowOrchestrator,
  NEUTRAL_DEFAULT_BANDS,
} from '../../src/services/orchestrator/generateNowOrchestrator.js';
import type {
  PreferencesRow,
  PreferencesRepository,
  UsersRepository,
  DailyBandsRepository,
  DevotionalsRepository,
  SessionsRepository,
  ConnectionsRepository,
  CalendarEventsRepository,
} from '../../src/db/repositories/index.js';
import type { DevotionalEngine, GenerateDevotionalParams } from '../../src/services/devotionalEngine.js';
import type { TtsService } from '../../src/services/tts/ttsService.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';
import type { GoogleCalendarClient } from '../../src/services/calendar/googleCalendarClient.js';
import type { GoogleKmsService } from '../../src/services/calendar/googleKmsService.js';
import type { GenerateNowOrchestrator as OrchestratorType } from '../../src/services/orchestrator/generateNowOrchestrator.js';
import {
  DEFAULT_VOICE_NAME,
  VOICE_CATALOG,
  type BandInput,
  type DevotionalOutput,
} from '@kairos/shared-contracts';

const BANDS: BandInput = {
  recovery: 'moderate',
  sleepQuality: 'fair',
  activity: 'moderate',
  busyness: 'moderate',
  communicationLoad: null,
  distressSignal: false,
};

const DEVOTIONAL: DevotionalOutput = {
  format: 'short',
  theme: 'Rest for the weary',
  verses: [
    {
      usfm: 'MAT.11.28',
      reference: 'Matthew 11:28',
      versionId: 3034,
      fetchedText: 'Come to me, all you who are weary and burdened, and I will give you rest.',
      attribution: 'Berean Standard Bible',
    },
  ],
  devotionalBody: 'A short devotional body about rest.',
  cardSummary: 'Rest for the weary.',
  prayer: 'Lord, grant me rest.',
};

/** Every column of `preferences` at its migration default — the row a brand-new user gets. */
function defaultPrefsRow(overrides: Partial<PreferencesRow> = {}): PreferencesRow {
  return {
    user_id: 'user-1',
    window_start_local: '07:00:00',
    window_end_local: '09:00:00',
    active_days: [1, 2, 3, 4, 5],
    cadence: 'daily',
    // NULL = "auto", the column default since migration 1721500000000 (#202).
    // Was `'short'` — the old default, which became load-bearing the moment
    // the column was actually read, hence the migration that nulls it.
    duration_preference: null,
    voice: 'en-US-Chirp3-HD-Achernar',
    stillness: 'off',
    lectio: false,
    // `true` since #201 — matches the column default set by migration
    // 1721700000000. These were `false` here (the old column default) back
    // when they gated nothing; now that they are real read-time consent
    // gates, leaving them `false` would silently disable calendar/health/
    // communication for every test in this file that isn't about consent.
    calendar_enabled: true,
    health_enabled: true,
    communication_enabled: true,
    notify_on_skip: true,
    examen_enabled: false,
    sabbath_day: 0,
    sabbath_enabled: false,
    sabbath_session: false,
    liturgical_seasons_enabled: false,
    updated_at: new Date('2026-07-18T00:00:00Z'),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Orchestrator harness — fake repositories, real GenerateNowOrchestrator.
 * Captures what the engine, TTS, and calendar freeBusy actually receive,
 * so a test can assert on the observable consequence of a stored value.
 * ------------------------------------------------------------------ */

interface HarnessCaptures {
  engineParams: GenerateDevotionalParams[];
  ttsCalls: Array<{ stillness: string; lectio: boolean; voiceName: string | undefined }>;
  freeBusyCalls: Array<{ timeMin: string; timeMax: string; timeZone: string }>;
  /** #201: proves `calendar_enabled=false` blocks the *write* half of calendar access too, not just the read. */
  insertEventCalls: Array<Record<string, unknown>>;
  createdDevotionals: Array<Record<string, unknown>>;
}

function buildOrchestrator(opts: {
  prefs: PreferencesRow | null;
  timezone?: string;
  tradition?: string;
  translationId?: number;
  withCalendar?: boolean;
  /** #201: a stored `daily_bands` row, so a consent test can prove stored data is ignored at read time. `undefined` keeps the default no-row behavior. */
  bands?: Record<string, unknown> | null;
}): { orchestrator: OrchestratorType; captures: HarnessCaptures } {
  const captures: HarnessCaptures = {
    engineParams: [],
    ttsCalls: [],
    freeBusyCalls: [],
    insertEventCalls: [],
    createdDevotionals: [],
  };

  const users = {
    findById: vi.fn().mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      tradition: opts.tradition ?? 'general',
      translation_id: opts.translationId ?? 3034,
      timezone: opts.timezone ?? 'UTC',
    }),
  } as unknown as UsersRepository;

  const preferences = {
    get: vi.fn().mockResolvedValue(opts.prefs),
  } as unknown as PreferencesRepository;

  const dailyBands = {
    getForDate: vi.fn().mockResolvedValue(opts.bands ?? null), // null -> NEUTRAL_DEFAULT_BANDS
  } as unknown as DailyBandsRepository;

  const devotionals = {
    getForDate: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation((_uid: string, input: Record<string, unknown>) => {
      captures.createdDevotionals.push(input);
      return Promise.resolve({ id: 'devo-1', ...input });
    }),
    setAudioObject: vi.fn().mockResolvedValue(undefined),
  } as unknown as DevotionalsRepository;

  const sessions = {
    create: vi.fn().mockResolvedValue({ id: 'sess-1', token: 'tok-1' }),
    listForUser: vi.fn().mockResolvedValue([]),
  } as unknown as SessionsRepository;

  const devotionalEngine = {
    generate: vi.fn().mockImplementation((params: GenerateDevotionalParams) => {
      captures.engineParams.push(params);
      return Promise.resolve({ devotional: DEVOTIONAL, source: 'gloo' as const });
    }),
  } as unknown as DevotionalEngine;

  const ttsService = {
    synthesize: vi
      .fn()
      .mockImplementation(
        (_d: DevotionalOutput, stillness: string, lectio: boolean, voiceName?: string) => {
          captures.ttsCalls.push({ stillness, lectio, voiceName });
          return Promise.resolve({
            audio: Buffer.from('mp3'),
            segmentCount: 1,
            charCount: 10,
            voiceName: voiceName ?? 'x',
          });
        },
      ),
  } as unknown as TtsService;

  const audioStorage = {
    upload: vi.fn().mockResolvedValue({ objectKey: 'devotionals/devo-1.mp3' }),
  } as unknown as AudioStorage;

  const calendarDeps = opts.withCalendar
    ? {
        connections: {
          findByProvider: vi
            .fn()
            .mockResolvedValue({ status: 'active', encrypted_refresh_token: 'enc' }),
        } as unknown as ConnectionsRepository,
        kmsService: { decryptToken: vi.fn().mockResolvedValue('refresh') } as unknown as GoogleKmsService,
        calendarEvents: { create: vi.fn().mockResolvedValue({ id: 'ce-1' }) } as unknown as CalendarEventsRepository,
        calendarClient: {
          withRefreshToken: vi.fn().mockReturnValue({
            getFreeBusyBlocks: vi
              .fn()
              .mockImplementation((args: { timeMin: string; timeMax: string; timeZone: string }) => {
                captures.freeBusyCalls.push(args);
                // No busy blocks -> the whole window is one gap.
                return Promise.resolve([]);
              }),
            insertEvent: vi.fn().mockImplementation((args: Record<string, unknown>) => {
              captures.insertEventCalls.push(args);
              return Promise.resolve({ id: 'gcal-1' });
            }),
          }),
        } as unknown as GoogleCalendarClient,
      }
    : {};

  const orchestrator = new GenerateNowOrchestrator({
    users,
    preferences,
    dailyBands,
    devotionals,
    sessions,
    devotionalEngine,
    ttsService,
    audioStorage,
    publicBaseUrl: 'http://localhost:8080',
    now: () => new Date('2026-07-18T12:00:00Z'),
    logger: { info: vi.fn(), error: vi.fn() },
    ...calendarDeps,
  });

  return { orchestrator, captures };
}

/* ================================================================== *
 * LIVE FIELDS — changing the stored value changes the output.
 * ================================================================== */

describe('users.tradition — instructionsBuilder framing (LIVE)', () => {
  it('produces materially different framing text per tradition, not just a different label', () => {
    const base = { translation: 'BSB', bands: BANDS, signalProvenance: ALL_SIGNALS_OBSERVED };
    const evangelical = buildInstructions({ ...base, tradition: 'evangelical' });
    const catholic = buildInstructions({ ...base, tradition: 'catholic' });
    const mainline = buildInstructions({ ...base, tradition: 'mainline' });
    const general = buildInstructions({ ...base, tradition: 'general' });

    // All four differ from each other — the guard against a stub that
    // interpolates the enum name into one shared sentence.
    const all = [evangelical, catholic, mainline, general];
    expect(new Set(all).size).toBe(4);

    // And each carries tradition-specific *substance*, not just its own name.
    expect(evangelical).toContain('personal-relationship-with-Jesus');
    expect(catholic).toContain('sacramental imagination');
    expect(mainline).toContain('room for mystery and doubt');
    expect(general).toContain('ecumenical');
    // Cross-contamination check: catholic-only vocabulary must not leak.
    expect(evangelical).not.toContain('sacramental');
  });

  it('reaches the engine from users.tradition through the orchestrator', async () => {
    const a = buildOrchestrator({ prefs: defaultPrefsRow(), tradition: 'catholic' });
    await a.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    const b = buildOrchestrator({ prefs: defaultPrefsRow(), tradition: 'evangelical' });
    await b.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    expect(a.captures.engineParams[0]!.tradition).toBe('catholic');
    expect(b.captures.engineParams[0]!.tradition).toBe('evangelical');
    // The engine turns these into different instruction strings (asserted above).
    expect(buildInstructions({ ...a.captures.engineParams[0]!, translation: 'BSB' })).not.toBe(
      buildInstructions({ ...b.captures.engineParams[0]!, translation: 'BSB' }),
    );
  });
});

describe('users.translation_id — passage fetch + instructions (LIVE)', () => {
  it('changes the translation line in the instructions', () => {
    const bsb = buildInstructions({ tradition: 'general', translation: 'BSB', bands: BANDS, signalProvenance: ALL_SIGNALS_OBSERVED });
    const niv = buildInstructions({ tradition: 'general', translation: 'NIV', bands: BANDS, signalProvenance: ALL_SIGNALS_OBSERVED });
    expect(bsb).toContain('Preferred Bible translation: BSB.');
    expect(niv).toContain('Preferred Bible translation: NIV.');
    expect(bsb).not.toBe(niv);
  });

  it('changes preferredVersionId reaching the engine (the id used for get_bible_verse)', async () => {
    const a = buildOrchestrator({ prefs: defaultPrefsRow(), translationId: 3034 });
    await a.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    const b = buildOrchestrator({ prefs: defaultPrefsRow(), translationId: 111 });
    await b.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    expect(a.captures.engineParams[0]!.preferredVersionId).toBe(3034);
    expect(b.captures.engineParams[0]!.preferredVersionId).toBe(111);
    // ...and the human-readable label follows the id, so the prompt changes too.
    expect(a.captures.engineParams[0]!.translation).not.toBe(b.captures.engineParams[0]!.translation);
  });
});

describe('preferences.stillness — audio assembly (LIVE)', () => {
  it('changes the SSML: encoded silence and the hand-off line appear only when enabled', () => {
    const off = buildDevotionalSsml(DEVOTIONAL, 'off');
    const brief = buildDevotionalSsml(DEVOTIONAL, 'brief');
    expect(off).not.toBe(brief);
    expect(off).not.toContain("Let's sit with this");
    expect(brief).toContain("Let's sit with this");
    // Real encoded silence, not just a different sentence.
    expect(brief.length).toBeGreaterThan(off.length);
  });

  it('threads the stored stillness value from the preferences row into TTS', async () => {
    const off = buildOrchestrator({ prefs: defaultPrefsRow({ stillness: 'off' }) });
    await off.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    const brief = buildOrchestrator({ prefs: defaultPrefsRow({ stillness: 'brief' }) });
    await brief.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    expect(off.captures.ttsCalls[0]!.stillness).toBe('off');
    expect(brief.captures.ttsCalls[0]!.stillness).toBe('brief');
    // And that difference produces different audio script bytes.
    expect(buildDevotionalSsml(DEVOTIONAL, 'off')).not.toBe(buildDevotionalSsml(DEVOTIONAL, 'brief'));
  });
});

describe('preferences.lectio — instructions + audio assembly (LIVE)', () => {
  it('replaces the passage-selection instruction with the lectio divina structure', () => {
    const normal = buildInstructions({ tradition: 'general', translation: 'BSB', bands: BANDS, signalProvenance: ALL_SIGNALS_OBSERVED, lectio: false });
    const lectio = buildInstructions({ tradition: 'general', translation: 'BSB', bands: BANDS, signalProvenance: ALL_SIGNALS_OBSERVED, lectio: true });
    expect(normal).not.toBe(lectio);
    expect(lectio).toContain('This is LECTIO DIVINA');
    expect(normal).not.toContain('LECTIO DIVINA');
    expect(normal).toContain('Choose ONE (or a short connected pair of)');
  });

  it('changes the SSML structure (passage read twice) as well as the prompt', () => {
    expect(buildDevotionalSsml(DEVOTIONAL, 'off', true)).not.toBe(buildDevotionalSsml(DEVOTIONAL, 'off', false));
  });

  it('threads the stored lectio flag into BOTH the engine and TTS', async () => {
    const on = buildOrchestrator({ prefs: defaultPrefsRow({ lectio: true }) });
    await on.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    const offH = buildOrchestrator({ prefs: defaultPrefsRow({ lectio: false }) });
    await offH.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    expect(on.captures.engineParams[0]!.lectio).toBe(true);
    expect(offH.captures.engineParams[0]!.lectio).toBe(false);
    expect(on.captures.ttsCalls[0]!.lectio).toBe(true);
    expect(offH.captures.ttsCalls[0]!.lectio).toBe(false);
  });
});

describe('preferences.liturgical_seasons_enabled — instructions (LIVE, tradition-conditional)', () => {
  it('adds a season line for evangelical/general traditions only when enabled', () => {
    const base = { tradition: 'evangelical' as const, translation: 'BSB', bands: BANDS, signalProvenance: ALL_SIGNALS_OBSERVED, date: '2026-12-20' };
    const off = buildInstructions({ ...base, liturgicalSeasonsEnabled: false });
    const on = buildInstructions({ ...base, liturgicalSeasonsEnabled: true });
    expect(off).not.toBe(on);
    expect(on.length).toBeGreaterThan(off.length);
  });

  it('is a NO-OP for catholic/mainline — they always see the season line regardless', () => {
    // Documented behavior, not a bug (instructionsBuilder.ts:212-214): worth
    // pinning because "the toggle did nothing" looks identical to dead config
    // from the outside, and a future refactor could make it genuinely dead.
    const base = { tradition: 'catholic' as const, translation: 'BSB', bands: BANDS, signalProvenance: ALL_SIGNALS_OBSERVED, date: '2026-12-20' };
    expect(buildInstructions({ ...base, liturgicalSeasonsEnabled: false })).toBe(
      buildInstructions({ ...base, liturgicalSeasonsEnabled: true }),
    );
  });

  it('threads the stored flag into the engine', async () => {
    const on = buildOrchestrator({ prefs: defaultPrefsRow({ liturgical_seasons_enabled: true }) });
    await on.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    expect(on.captures.engineParams[0]!.liturgicalSeasonsEnabled).toBe(true);
  });
});

describe('preferences.window_start_local / window_end_local — gap selection (LIVE)', () => {
  it('changes the freeBusy query window the scheduler searches for a gap', async () => {
    const early = buildOrchestrator({
      prefs: defaultPrefsRow({ window_start_local: '06:00:00', window_end_local: '07:00:00' }),
      withCalendar: true,
    });
    await early.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    const late = buildOrchestrator({
      prefs: defaultPrefsRow({ window_start_local: '18:00:00', window_end_local: '20:00:00' }),
      withCalendar: true,
    });
    await late.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    const earlyCall = early.captures.freeBusyCalls[0]!;
    const lateCall = late.captures.freeBusyCalls[0]!;
    expect(earlyCall.timeMin).not.toBe(lateCall.timeMin);
    expect(earlyCall.timeMax).not.toBe(lateCall.timeMax);
    // Concrete, not merely "different": the window is honored to the hour.
    // NB (#205): this harness's default `timezone` is 'UTC', so these bounds
    // are deliberately UNCHANGED by the zone-aware window rewrite — they double
    // as the regression guard that the existing UTC fleet still schedules
    // exactly where it always did. The non-UTC cases live in
    // tests/services/calendar/schedulingWindow.test.ts and in the
    // America/Chicago test below.
    expect(earlyCall.timeMin).toBe('2026-07-19T06:00:00.000Z');
    expect(earlyCall.timeMax).toBe('2026-07-19T07:00:00.000Z');
    expect(lateCall.timeMin).toBe('2026-07-19T18:00:00.000Z');
    expect(lateCall.timeMax).toBe('2026-07-19T20:00:00.000Z');
  });
});

describe('preferences.examen_enabled — evening examen fan-out (LIVE)', () => {
  it('decides whether a user gets an examen devotional at all', async () => {
    async function runExamen(examenUsers: Array<{ user_id: string }>) {
      const generateNow = vi.fn().mockResolvedValue({
        sessionUrl: 'u',
        sessionToken: 't',
        devotionalId: 'd',
        devotional: { format: 'micro', theme: 'x', cardSummary: 'y' },
        source: 'gloo',
        audio: { status: 'uploaded', objectKey: 'k' },
      });
      const app = Fastify();
      registerInternalRoutes(app, {
        generateNowOrchestrator: { generateNow } as unknown as OrchestratorType,
        preferences: {
          listWithExamenEnabled: vi.fn().mockResolvedValue(examenUsers),
          listWithSabbathEnabled: vi.fn().mockResolvedValue([]),
        } as unknown as PreferencesRepository,
        internalApiToken: 'secret',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/internal/trigger-examen-run',
        headers: { 'x-internal-token': 'secret' },
      });
      await app.close();
      return { body: res.json(), generateNow };
    }

    const disabled = await runExamen([]);
    expect(disabled.body.triggered).toBe(0);
    expect(disabled.generateNow).not.toHaveBeenCalled();

    const enabled = await runExamen([{ user_id: 'user-1' }]);
    expect(enabled.body.triggered).toBe(1);
    expect(enabled.generateNow).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', slotType: 'examen' }),
    );
  });

  it("and slotType='examen' demonstrably changes the generated instructions", () => {
    const standard = buildInstructions({ tradition: 'general', translation: 'BSB', bands: BANDS, signalProvenance: ALL_SIGNALS_OBSERVED, slotType: 'standard' });
    const examen = buildInstructions({ tradition: 'general', translation: 'BSB', bands: BANDS, signalProvenance: ALL_SIGNALS_OBSERVED, slotType: 'examen' });
    expect(standard).not.toBe(examen);
    expect(examen).toContain('This is an EVENING EXAMEN');
  });
});

describe('preferences.sabbath_enabled / sabbath_day / sabbath_session — daily run (LIVE)', () => {
  async function runDaily(opts: {
    sabbath?: Array<{ user_id: string; sabbath_day: number; sabbath_session: boolean }>;
    timezone?: string;
    now: Date;
  }) {
    const generateNow = vi.fn().mockResolvedValue({
      sessionUrl: 'u',
      sessionToken: 't',
      devotionalId: 'd',
      devotional: { format: 'short', theme: 'x', cardSummary: 'y' },
      source: 'gloo',
      audio: { status: 'uploaded', objectKey: 'k' },
    });
    const app = Fastify();
    registerInternalRoutes(app, {
      generateNowOrchestrator: { generateNow } as unknown as OrchestratorType,
      users: {
        listWithActiveGoogleCalendar: vi
          .fn()
          .mockResolvedValue([{ id: 'user-1', email: null, timezone: opts.timezone ?? 'UTC' }]),
      } as unknown as UsersRepository,
      preferences: {
        listWithExamenEnabled: vi.fn().mockResolvedValue([]),
        // K2 (#188). Empty = no user has a stored day preference, which
        // is the fail-open case — so these sabbath/timezone tests keep
        // exercising exactly what they always did.
        listActiveDays: vi.fn().mockResolvedValue([]),
        listWithSabbathEnabled: vi.fn().mockResolvedValue(opts.sabbath ?? []),
      } as unknown as PreferencesRepository,
      internalApiToken: 'secret',
      now: () => opts.now,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/trigger-daily-run',
      headers: { 'x-internal-token': 'secret' },
    });
    await app.close();
    return { body: res.json(), generateNow };
  }

  const SUNDAY = new Date('2026-07-19T12:00:00Z');

  it('sabbath_enabled=false generates; sabbath_enabled=true + sabbath_session=false skips entirely', async () => {
    // listWithSabbathEnabled IS the sabbath_enabled predicate — an empty
    // result set is exactly what the disabled case produces.
    const disabled = await runDaily({ sabbath: [], now: SUNDAY });
    expect(disabled.body.succeeded).toBe(1);
    expect(disabled.generateNow).toHaveBeenCalled();

    const enabled = await runDaily({
      sabbath: [{ user_id: 'user-1', sabbath_day: 0, sabbath_session: false }],
      now: SUNDAY,
    });
    expect(enabled.body.succeeded).toBe(0);
    expect(enabled.body.skipped).toBe(1);
    expect(enabled.generateNow).not.toHaveBeenCalled();
  });

  it('sabbath_session=true generates a sabbath session instead of skipping', async () => {
    const rest = await runDaily({
      sabbath: [{ user_id: 'user-1', sabbath_day: 0, sabbath_session: true }],
      now: SUNDAY,
    });
    expect(rest.body.succeeded).toBe(1);
    expect(rest.generateNow).toHaveBeenCalledWith(expect.objectContaining({ sabbathSession: true }));
  });

  it('sabbath_day selects WHICH day is protected', async () => {
    // Same Sunday clock, different sabbath_day -> opposite decisions.
    const sunday = await runDaily({
      sabbath: [{ user_id: 'user-1', sabbath_day: 0, sabbath_session: false }],
      now: SUNDAY,
    });
    const saturday = await runDaily({
      sabbath: [{ user_id: 'user-1', sabbath_day: 6, sabbath_session: false }],
      now: SUNDAY,
    });
    expect(sunday.body.skipped).toBe(1);
    expect(saturday.body.succeeded).toBe(1);
  });

  it('sabbathSession=true changes the devotional itself: extended format and no actionStep', async () => {
    // The scheduling decision above is only half the promise — this asserts
    // the generated artifact differs, which is the part a user experiences.
    const h = buildOrchestrator({ prefs: defaultPrefsRow() });
    await h.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18', sabbathSession: true });
    expect(h.captures.engineParams[0]!.durationPreference).toBe('extended');
    expect(h.captures.createdDevotionals[0]!.actionStep).toBeNull();

    const normal = buildOrchestrator({ prefs: defaultPrefsRow() });
    await normal.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    expect(normal.captures.engineParams[0]!.durationPreference).toBeUndefined();
  });
});

describe('users.timezone — scheduling (LIVE — window arithmetic fixed in #205)', () => {
  it('IS honored for the sabbath day-of-week decision', async () => {
    // 2026-07-19T02:00Z is already Sunday in UTC but still Saturday in
    // America/Chicago. sabbath_day=6 (Saturday) must therefore match for the
    // Chicago user and not for the UTC user.
    async function run(timezone: string) {
      const generateNow = vi.fn().mockResolvedValue({
        sessionUrl: 'u',
        sessionToken: 't',
        devotionalId: 'd',
        devotional: { format: 'short', theme: 'x', cardSummary: 'y' },
        source: 'gloo',
        audio: { status: 'uploaded', objectKey: 'k' },
      });
      const app = Fastify();
      registerInternalRoutes(app, {
        generateNowOrchestrator: { generateNow } as unknown as OrchestratorType,
        users: {
          listWithActiveGoogleCalendar: vi.fn().mockResolvedValue([{ id: 'user-1', email: null, timezone }]),
        } as unknown as UsersRepository,
        preferences: {
          listWithExamenEnabled: vi.fn().mockResolvedValue([]),
        // K2 (#188). Empty = no user has a stored day preference, which
        // is the fail-open case — so these sabbath/timezone tests keep
        // exercising exactly what they always did.
        listActiveDays: vi.fn().mockResolvedValue([]),
          listWithSabbathEnabled: vi
            .fn()
            .mockResolvedValue([{ user_id: 'user-1', sabbath_day: 6, sabbath_session: false }]),
        } as unknown as PreferencesRepository,
        internalApiToken: 'secret',
        now: () => new Date('2026-07-19T02:00:00Z'),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/internal/trigger-daily-run',
        headers: { 'x-internal-token': 'secret' },
      });
      await app.close();
      return res.json();
    }

    expect((await run('America/Chicago')).skipped).toBe(1); // still Saturday locally
    expect((await run('UTC')).succeeded).toBe(1); // already Sunday
  });

  it('IS honored when building the devotional window (#205 — was the 3:30am bug)', async () => {
    // INVERTED from the characterization test this replaces. It previously
    // pinned the defect: runCalendarStep built the window with setUTCHours(),
    // so window_start_local='07:00' meant 07:00 UTC for every user on earth,
    // and it asserted that the Chicago and UTC users searched *identical*
    // instants. #205 moved window construction into
    // calendar/schedulingWindow.ts, so the two must now diverge by the zone's
    // real offset. Each original expectation below is inverted, not deleted,
    // so the diff shows precisely which behavior changed.
    const utc = buildOrchestrator({ prefs: defaultPrefsRow(), timezone: 'UTC', withCalendar: true });
    await utc.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    const chicago = buildOrchestrator({
      prefs: defaultPrefsRow(),
      timezone: 'America/Chicago',
      withCalendar: true,
    });
    await chicago.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    // The zone is still forwarded to the freeBusy call — necessary, and never
    // the thing that was broken. Kept so a regression here is still caught.
    expect(utc.captures.freeBusyCalls[0]!.timeZone).toBe('UTC');
    expect(chicago.captures.freeBusyCalls[0]!.timeZone).toBe('America/Chicago');

    // ...and the searched INSTANTS now differ, which is the assertion that
    // actually proves the fix. Chicago in July is CDT (-5), so the user's
    // stated 07:00-09:00 morning is searched at 12:00-14:00Z, not 07:00Z.
    expect(chicago.captures.freeBusyCalls[0]!.timeMin).not.toBe(
      utc.captures.freeBusyCalls[0]!.timeMin,
    );
    expect(chicago.captures.freeBusyCalls[0]!.timeMin).toBe('2026-07-19T12:00:00.000Z');
    expect(chicago.captures.freeBusyCalls[0]!.timeMax).toBe('2026-07-19T14:00:00.000Z');

    // The UTC user is unchanged — byte-identical to the pre-#205 behavior.
    expect(utc.captures.freeBusyCalls[0]!.timeMin).toBe('2026-07-19T07:00:00.000Z');
    expect(utc.captures.freeBusyCalls[0]!.timeMax).toBe('2026-07-19T09:00:00.000Z');
  });
});

describe('preferences.duration_preference — devotional length (LIVE, was dead until #202)', () => {
  /**
   * Composes the harness capture with the real instructions builder: the fake
   * engine records the params it was handed, and `buildInstructions` is the
   * genuine function the real engine calls, which runs `resolveTargetFormat`
   * internally and writes the decision into the `Target format:` line sent to
   * Gloo. Asserting on that line — rather than on the captured param — is the
   * difference #193 insists on: it proves the stored value changed the text
   * that leaves the process, not merely that it was forwarded one hop.
   */
  function targetFormatLineFor(captures: HarnessCaptures): string {
    const params = captures.engineParams[0]!;
    return buildInstructions({
      tradition: 'general',
      translation: 'BSB',
      bands: NEUTRAL_DEFAULT_BANDS,
      // Provenance became required in #196 so a neutral default can never be
      // narrated as an observation. These duration assertions are about the
      // `Target format:` line only, so the honest reading for hand-built
      // neutral bands is NO_SIGNALS_OBSERVED — nothing here measured anything.
      signalProvenance: NO_SIGNALS_OBSERVED,
      durationPreference: params.durationPreference,
    })
      .split('\n')
      .find((line) => line.startsWith('Target format:'))!;
  }

  async function generateWith(prefs: PreferencesRow) {
    const h = buildOrchestrator({ prefs });
    await h.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    return h;
  }

  it('a different stored duration produces a different target format in the Gloo instructions', async () => {
    const micro = await generateWith(defaultPrefsRow({ duration_preference: 'micro' }));
    const extended = await generateWith(defaultPrefsRow({ duration_preference: 'extended' }));

    const microLine = targetFormatLineFor(micro.captures);
    const extendedLine = targetFormatLineFor(extended.captures);

    // The output differs — not just the argument.
    expect(microLine).not.toBe(extendedLine);
    expect(microLine).toContain('Target format: micro');
    expect(extendedLine).toContain('Target format: extended');
  });

  it('auto (NULL) falls through to the band heuristic rather than being treated as a format', async () => {
    // The whole point of `auto`: neutral bands must still land on the
    // heuristic's `standard`, not on any stored literal. Migration
    // 1721500000000 makes NULL representable so this case exists at all.
    const auto = await generateWith(defaultPrefsRow({ duration_preference: null }));
    expect(auto.captures.engineParams[0]!.durationPreference).toBeUndefined();
    expect(targetFormatLineFor(auto.captures)).toContain('Target format: standard');

    // And a stored literal genuinely diverges from that heuristic baseline,
    // so the previous assertion is not passing by coincidence.
    const micro = await generateWith(defaultPrefsRow({ duration_preference: 'micro' }));
    expect(targetFormatLineFor(micro.captures)).toContain('Target format: micro');
  });

  it('precedence: invite override > sabbath session > stored preference > heuristic', async () => {
    const prefs = defaultPrefsRow({ duration_preference: 'micro' });

    // 3 vs 4: stored preference beats the heuristic.
    const stored = await generateWith(prefs);
    expect(stored.captures.engineParams[0]!.durationPreference).toBe('micro');

    // 2 beats 3: the sabbath session's extended format wins over stored micro.
    const sabbath = buildOrchestrator({ prefs });
    await sabbath.orchestrator.generateNow({
      userId: 'user-1',
      date: '2026-07-18',
      sabbathSession: true,
    });
    expect(sabbath.captures.engineParams[0]!.durationPreference).toBe('extended');

    // 1 beats 2: an invite-derived override wins over the sabbath session,
    // because a calendar hole has a literal length the devotional must fit.
    const invited = buildOrchestrator({ prefs });
    await invited.orchestrator.generateNow({
      userId: 'user-1',
      date: '2026-07-18',
      sabbathSession: true,
      durationPreferenceOverride: 'short',
    });
    expect(invited.captures.engineParams[0]!.durationPreference).toBe('short');
  });

  it('the distress safety floor still overrides the stored preference', async () => {
    // resolveTargetFormat enforces this above the whole precedence ladder:
    // a user who pinned "15 minutes" and is in distress still gets micro.
    expect(
      resolveTargetFormat({ ...NEUTRAL_DEFAULT_BANDS, distressSignal: true }, 'extended'),
    ).toBe('micro');
  });
});

describe('preferences.voice — Cloud TTS voice (LIVE, was dead until #202)', () => {
  async function synthesizedVoiceFor(voice: string): Promise<string | undefined> {
    const h = buildOrchestrator({ prefs: defaultPrefsRow({ voice }) });
    await h.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    return h.captures.ttsCalls[0]!.voiceName;
  }

  it('a different stored voice reaches synthesize() as a different voice name', async () => {
    const calm = await synthesizedVoiceFor('calm');
    const bright = await synthesizedVoiceFor('bright');

    expect(calm).not.toBe(bright);
    expect(calm).toBe(VOICE_CATALOG.calm);
    expect(bright).toBe(VOICE_CATALOG.bright);
  });

  it('accepts a real voice id as well as a picker label', async () => {
    // Both representations genuinely live in the column: the migration default
    // is a real id, while iOS pushes labels. See voice.ts's header.
    expect(await synthesizedVoiceFor('en-US-Chirp3-HD-Kore')).toBe(VOICE_CATALOG.calm);
    expect(await synthesizedVoiceFor('calm')).toBe(VOICE_CATALOG.calm);
  });

  it('an unrecognized stored voice falls back to the default WITHOUT failing generation', async () => {
    // The #202 acceptance criterion. `en-US-Chirp3-HD-Zubeneschamali` is not in
    // the catalog; a stale or hand-edited value must cost the user their voice
    // choice, never their audio.
    const h = buildOrchestrator({ prefs: defaultPrefsRow({ voice: 'not-a-real-voice' }) });
    const result = await h.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    expect(h.captures.ttsCalls[0]!.voiceName).toBe(DEFAULT_VOICE_NAME);
    // Generation completed and audio was still produced.
    expect(result.audio.status).toBe('uploaded');
  });
});

/* ================================================================== *
 * DEAD CONFIG — stored, API-round-tripped, read by nothing.
 *
 * Each test below asserts that changing the value changes NOTHING. They
 * are characterization tests: when the field is wired up, invert them.
 * Per #193, the columns are NOT deleted here — that is a separate call.
 * ================================================================== */

/* ================================================================== *
 * preferences.active_days / preferences.cadence — daily run (LIVE, #188)
 *
 * These two were the "active_days is never read" / "cadence is never
 * read" characterization tests in this file's DEAD CONFIG block. Per that
 * block's own standing instruction — "when the field is wired up, invert
 * them" — they are inverted here rather than deleted: the same scenarios,
 * asserting the opposite outcome, so the record of what changed survives
 * in the test that proves it.
 * ================================================================== */

describe('preferences.active_days — daily run (LIVE, #188)', () => {
  function runDailyWithActiveDays(opts: {
    activeDays: number[];
    now: Date;
    timezone?: string;
  }) {
    const generateNow = vi.fn().mockResolvedValue({
      sessionUrl: 'u',
      sessionToken: 't',
      devotionalId: 'd',
      devotional: { format: 'short', theme: 'x', cardSummary: 'y' },
      source: 'gloo',
      audio: { status: 'uploaded', objectKey: 'k' },
    });
    const app = Fastify();
    registerInternalRoutes(app, {
      generateNowOrchestrator: { generateNow } as unknown as OrchestratorType,
      users: {
        listWithActiveGoogleCalendar: vi
          .fn()
          .mockResolvedValue([{ id: 'user-1', email: null, timezone: opts.timezone ?? 'UTC' }]),
      } as unknown as UsersRepository,
      preferences: {
        listWithExamenEnabled: vi.fn().mockResolvedValue([]),
        listWithSabbathEnabled: vi.fn().mockResolvedValue([]),
        listActiveDays: vi
          .fn()
          .mockResolvedValue([{ user_id: 'user-1', active_days: opts.activeDays }]),
      } as unknown as PreferencesRepository,
      internalApiToken: 'secret',
      now: () => opts.now,
    });
    return app
      .inject({
        method: 'POST',
        url: '/internal/trigger-daily-run',
        headers: { 'x-internal-token': 'secret' },
      })
      .then(async (res) => {
        await app.close();
        return { body: res.json(), generateNow };
      });
  }

  const SUNDAY_NOON_UTC = new Date('2026-07-19T12:00:00Z'); // day 0

  it('the same clock and the same user produce opposite decisions on different day sets', async () => {
    // The inversion of "active_days is never read: the daily run generates
    // on a day excluded from active_days". Nothing differs between these
    // two runs except the stored preference, which is the whole point of
    // #193's standard of proof — "the value is passed to a function" is
    // not evidence, a changed outcome is.
    const excluded = await runDailyWithActiveDays({ activeDays: [1, 2, 3, 4, 5], now: SUNDAY_NOON_UTC });
    expect(excluded.body.succeeded).toBe(0);
    expect(excluded.body.skipped).toBe(1);
    expect(excluded.generateNow).not.toHaveBeenCalled();

    const included = await runDailyWithActiveDays({ activeDays: [0, 6], now: SUNDAY_NOON_UTC });
    expect(included.body.succeeded).toBe(1);
    expect(included.generateNow).toHaveBeenCalledTimes(1);
  });

  it('is resolved in the user\'s zone, not UTC', async () => {
    // 2026-07-17T22:00Z is Friday in UTC and Saturday 08:00 in Sydney. A
    // UTC-derived weekday finds 5 in [1..5] and generates the Saturday
    // devotional the user excluded — #205's defect class, one unit up.
    const sydney = await runDailyWithActiveDays({
      activeDays: [1, 2, 3, 4, 5],
      now: new Date('2026-07-17T22:00:00Z'),
      timezone: 'Australia/Sydney',
    });
    expect(sydney.body.skipped).toBe(1);
    expect(sydney.generateNow).not.toHaveBeenCalled();

    // Same instant, a zone where it is still Friday — must still generate,
    // or the test above would pass for the wrong reason.
    const chicago = await runDailyWithActiveDays({
      activeDays: [1, 2, 3, 4, 5],
      now: new Date('2026-07-17T22:00:00Z'),
      timezone: 'America/Chicago',
    });
    expect(chicago.body.succeeded).toBe(1);
  });

  it('an excluded day is a skip, never a failure', async () => {
    // A fan-out that reported every weekend as an error would page whoever
    // watches the Cloud Scheduler job. Same treatment AlreadyExistsError
    // gets.
    const { body } = await runDailyWithActiveDays({ activeDays: [1, 2, 3, 4, 5], now: SUNDAY_NOON_UTC });
    expect(body.failed).toBe(0);
    expect(body.errors).toEqual([]);
  });
});

describe('preferences.cadence — a derived label over active_days (LIVE, #188)', () => {
  // The inversion of "cadence is never read: the daily-run selection query
  // does not consider it". `cadence` is still not read by the daily run —
  // and that is now correct by design rather than by omission. #188
  // resolved the overlap by making `active_days` the single source of
  // truth and `cadence` a *name* for it, so the way `cadence` reaches the
  // schedule is by expanding into `active_days` at write time. Its
  // traceability therefore lives on the write path, and is proven in
  // `tests/routes/preferencesCadence.test.ts` (PUT `cadence: 'daily'` ->
  // `active_days` = all seven days) plus the derivation unit tests in
  // `packages/shared-contracts/tests/api.test.ts`.

  it('is derived from the day set rather than stored independently', async () => {
    const { cadenceForActiveDays, activeDaysForCadence } = await import('@kairos/shared-contracts');

    // The pair that was the column default of every pre-#188 row
    // (`cadence: 'daily'` beside Mon–Fri) is no longer expressible: the
    // days name themselves.
    expect(cadenceForActiveDays([1, 2, 3, 4, 5])).toBe('weekdays');
    expect(cadenceForActiveDays([0, 1, 2, 3, 4, 5, 6])).toBe('daily');

    // And the preset direction genuinely changes which days generate,
    // which is what makes it more than a label the daily run ignores.
    expect(activeDaysForCadence('daily')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(activeDaysForCadence('weekdays')).toEqual([1, 2, 3, 4, 5]);
  });
});

/* ------------------------------------------------------------------ *
 * DEAD CONFIG — what is left after #202, #205, #201 and #188.
 * Only `notify_on_skip` remains: no skip-notification path exists to
 * consume it. The consent trio moved out when #201 made them real; the
 * active_days/cadence pair moved out with #188 above.
 * ------------------------------------------------------------------ */
describe('DEAD CONFIG — preferences fields no consumer reads', () => {
  it('notify_on_skip changes nothing in generation', async () => {
    // Still pure storage: written by PUT /v1/preferences, read back by GET
    // /v1/preferences, referenced by no service. No skip-notification path
    // exists to consume it (docs/03 §10). The consent trio that used to
    // share this test moved out when #201 made them real — see the
    // `#201 — granular consent` block below.
    const off = buildOrchestrator({
      prefs: defaultPrefsRow({ notify_on_skip: false }),
      withCalendar: true,
    });
    await off.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    const on = buildOrchestrator({
      prefs: defaultPrefsRow({ notify_on_skip: true }),
      withCalendar: true,
    });
    await on.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    expect(off.captures.engineParams[0]).toEqual(on.captures.engineParams[0]);
    expect(off.captures.ttsCalls[0]).toEqual(on.captures.ttsCalls[0]);
    expect(off.captures.freeBusyCalls[0]).toEqual(on.captures.freeBusyCalls[0]);
  });
});

/* ------------------------------------------------------------------ *
 * #201 — granular consent (Foundation §8)
 *
 * These were the three fields the #193 audit flagged as the P0: they read
 * as privacy controls and gated nothing. The tests below follow #193's
 * standard of proof — assert the *behavior* changes, never that a value was
 * read. Every assertion here is about what Gloo receives or what Google is
 * called with, because "the flag was read" passes against code that reads
 * it and throws it away, which is exactly the class of bug that hid here.
 *
 * The critical setup detail: a fully-populated `daily_bands` row is stored
 * in every one of these tests. Consent must suppress *use* of data that
 * already exists — gating collection would leave a user who revokes today
 * still being narrated from yesterday's rows.
 * ------------------------------------------------------------------ */
describe('granular consent gates (#201)', () => {
  /** Every band measured — so a suppressed signal is unambiguously a consent effect, not missing data. */
  const FULL_BANDS = {
    recovery: 'high',
    sleep_quality: 'good',
    activity: 'high',
    busyness: 'heavy',
    communication_load: 'heavy',
    distress_signal: false,
  } as const;

  it('health_enabled=false suppresses stored health bands AND marks them unobserved (#196)', async () => {
    const denied = buildOrchestrator({
      prefs: defaultPrefsRow({ health_enabled: false }),
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    await denied.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    const params = denied.captures.engineParams[0]!;

    // 1. The measured values genuinely do not reach the engine. `high`
    //    recovery is stored; Gloo must not see it.
    expect(params.bands.recovery).not.toBe('high');
    expect(params.bands.sleepQuality).not.toBe('good');
    expect(params.bands.activity).not.toBe('high');

    // 2. And — the #196 interaction, the half that actually protects the
    //    user — they are NOT OBSERVED, so `buildInstructions` cannot narrate
    //    the neutral fallback as if it were a measurement. Suppressing the
    //    value without this would have the devotional confidently telling a
    //    user who just revoked health access how rested they are.
    expect(params.signalProvenance.recovery).toBe(false);
    expect(params.signalProvenance.sleepQuality).toBe(false);
    expect(params.signalProvenance.activity).toBe(false);

    // 3. Health revocation must not collaterally kill the calendar signal —
    //    busyness is calendar-derived and separately consented.
    expect(params.signalProvenance.busyness).toBe(true);
    expect(params.bands.busyness).toBe('heavy');
  });

  it('health_enabled=false changes the actual instructions sent to Gloo, not just the params', async () => {
    // The end of the chain: #193's standard is that a flag must change
    // observable output. `buildInstructions` is the real prompt text Gloo
    // receives, so this asserts the user's revocation survives all the way
    // to the wire rather than being normalized away downstream.
    const granted = buildOrchestrator({
      prefs: defaultPrefsRow({ health_enabled: true }),
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    await granted.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    const denied = buildOrchestrator({
      prefs: defaultPrefsRow({ health_enabled: false }),
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    await denied.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    const grantedText = buildInstructions({
      ...granted.captures.engineParams[0]!,
      translation: 'BSB',
    });
    const deniedText = buildInstructions({
      ...denied.captures.engineParams[0]!,
      translation: 'BSB',
    });

    expect(deniedText).not.toBe(grantedText);
    // The granted run names the measured recovery band; the denied one must not.
    expect(grantedText).toContain('recovery');
    expect(deniedText).not.toMatch(/recovery: high/i);
  });

  it('communication_enabled=false drops a stored communicationLoad', async () => {
    const denied = buildOrchestrator({
      prefs: defaultPrefsRow({ communication_enabled: false }),
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    await denied.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    expect(denied.captures.engineParams[0]!.bands.communicationLoad).toBeNull();

    const granted = buildOrchestrator({
      prefs: defaultPrefsRow({ communication_enabled: true }),
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    await granted.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    expect(granted.captures.engineParams[0]!.bands.communicationLoad).toBe('heavy');
  });

  it('calendar_enabled=false performs NO free/busy read and NO event insert', async () => {
    // The inversion of the old characterization test's final assertion,
    // which asserted `freeBusyCalls` had length 1 despite calendar_enabled
    // being false. Both privileged calendar operations must be absent —
    // asserting only on freeBusy would let an event insert slip through.
    const denied = buildOrchestrator({
      prefs: defaultPrefsRow({ calendar_enabled: false }),
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    const result = await denied.orchestrator.generateNow({
      userId: 'user-1',
      date: '2026-07-18',
    });

    expect(denied.captures.freeBusyCalls).toHaveLength(0);
    expect(denied.captures.insertEventCalls).toHaveLength(0);
    // Reported as a consent decision rather than an absence, so the reason a
    // user has no calendar event is legible in the result.
    expect(result.calendar).toEqual({ skipped: 'consent_revoked' });

    // Control: the same harness with consent granted does both.
    const granted = buildOrchestrator({
      prefs: defaultPrefsRow({ calendar_enabled: true }),
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    await granted.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    expect(granted.captures.freeBusyCalls).toHaveLength(1);
    expect(granted.captures.insertEventCalls).toHaveLength(1);
  });

  it('calendar_enabled=false ignores a stored busyness band and marks it unobserved', async () => {
    // Read-time suppression, the point of #201: the `busyness` row is right
    // there in `daily_bands` from before revocation, and must not be used.
    const denied = buildOrchestrator({
      prefs: defaultPrefsRow({ calendar_enabled: false }),
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    await denied.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    const params = denied.captures.engineParams[0]!;
    expect(params.bands.busyness).not.toBe('heavy');
    expect(params.signalProvenance.busyness).toBe(false);
    // Health is independently consented and unaffected (Foundation §8:
    // "each signal category... is an independent, revocable opt-in").
    expect(params.bands.recovery).toBe('high');
    expect(params.signalProvenance.recovery).toBe(true);
  });

  it('still produces a devotional with every category revoked (Foundation §8 "functions with reduced personalization")', async () => {
    // Decision #2 in #201: with the calendar-first pivot (#197), revoking
    // calendar leaves very little signal. This asserts the floor — the user
    // is degraded, never broken. A devotional is still generated, still has
    // audio, and still returns a usable session URL.
    const none = buildOrchestrator({
      prefs: defaultPrefsRow({
        calendar_enabled: false,
        health_enabled: false,
        communication_enabled: false,
      }),
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    const result = await none.orchestrator.generateNow({
      userId: 'user-1',
      date: '2026-07-18',
    });

    expect(result.devotionalId).toBeTruthy();
    expect(result.sessionUrl).toContain('/session/');
    expect(none.captures.engineParams).toHaveLength(1);

    // Nothing is narrated as observed — the devotional is generic rather
    // than personalized, which is the promised degraded mode.
    const params = none.captures.engineParams[0]!;
    expect(params.signalProvenance).toEqual({
      recovery: false,
      sleepQuality: false,
      activity: false,
      busyness: false,
    });
    expect(params.bands.communicationLoad).toBeNull();
  });

  it('distress_signal is NOT gated by consent — safety is not a personalization category', async () => {
    // Foundation §9. The distress path only ever becomes true through an
    // explicit user action, and a privacy toggle must not double as an
    // off-switch for a safety guardrail.
    const denied = buildOrchestrator({
      prefs: defaultPrefsRow({
        calendar_enabled: false,
        health_enabled: false,
        communication_enabled: false,
      }),
      bands: { ...FULL_BANDS, distress_signal: true },
      withCalendar: true,
    });
    await denied.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });
    expect(denied.captures.engineParams[0]!.bands.distressSignal).toBe(true);
  });

  it('a missing preferences row does not suppress signals', async () => {
    // `loadPreferences` deliberately tolerates a missing row (docs/14 §3.5's
    // "return defaults instead of 404"). A user who has never synced
    // preferences has not revoked anything, so the absent row must not read
    // as a revocation — that would be #201's own bug in mirror image.
    const noRow = buildOrchestrator({
      prefs: null,
      bands: { ...FULL_BANDS },
      withCalendar: true,
    });
    await noRow.orchestrator.generateNow({ userId: 'user-1', date: '2026-07-18' });

    const params = noRow.captures.engineParams[0]!;
    expect(params.bands.recovery).toBe('high');
    expect(params.bands.busyness).toBe('heavy');
    expect(params.bands.communicationLoad).toBe('heavy');
    expect(noRow.captures.freeBusyCalls).toHaveLength(1);
  });
});
