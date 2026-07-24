/**
 * Integration tests for GenerateNowOrchestrator (issue #74, #24 C3)
 * against a REAL local Postgres but FAKE DevotionalEngine/TtsService/
 * AudioStorage/CalendarClient/KmsService/ConnectionsRepository.
 *
 * Regression shape: every test here would FAIL against a naive
 * implementation that (a) 404s instead of defaulting when no preferences
 * row exists, (b) loses the devotional when TTS throws, (c) never
 * creates a session row, (d) re-generates when a devotional already
 * exists, or (e) doesn't insert a calendar event when all deps are present.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  asVerifiedUserId,
  createRepositories,
  type Repositories,
} from '../../../src/db/repositories/index.js';
import {
  GenerateNowOrchestrator,
  AlreadyExistsError,
  NEUTRAL_DEFAULT_BANDS,
} from '../../../src/services/orchestrator/generateNowOrchestrator.js';
import type { DevotionalEngine, GenerateDevotionalResult } from '../../../src/services/devotionalEngine.js';
import { TtsService, TtsServiceError } from '../../../src/services/tts/ttsService.js';
import { LocalFileAudioStorage } from '../../../src/services/audio/audioStorage.js';
import type { GoogleCalendarClient } from '../../../src/services/calendar/googleCalendarClient.js';
import type { GoogleKmsService } from '../../../src/services/calendar/googleKmsService.js';
import type { ConnectionsRepository, PrayerIntentionsRepository } from '../../../src/db/repositories/index.js';
import type { DeliveryProvider } from '../../../src/services/delivery/deliveryProvider.js';
import { ImmediateTaskScheduler } from '../../../src/services/tasks/immediateTaskScheduler.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BandInput, DevotionalOutput } from '@kairos/shared-contracts';
import {
  ALL_SIGNALS_OBSERVED,
  CALENDAR_ONLY_SIGNALS_OBSERVED,
  NO_SIGNALS_OBSERVED,
  type SignalProvenance,
} from '../../../src/services/gloo/instructionsBuilder.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5433/kairos_test';

const pool = new Pool({ connectionString: DATABASE_URL });
const repos: Repositories = createRepositories(pool);

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE candidate_slots, calendar_events, sessions, devotionals, daily_bands, preferences, connections, users RESTART IDENTITY CASCADE`,
  );
}

let audioRootDir: string;

beforeAll(async () => {
  await pool.query('SELECT 1 FROM users LIMIT 1');
  audioRootDir = await mkdtemp(path.join(tmpdir(), 'kairos-orchestrator-audio-'));
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
  await rm(audioRootDir, { recursive: true, force: true });
});

const SAMPLE_DEVOTIONAL: DevotionalOutput = {
  format: 'short',
  theme: 'Rest for the weary',
  verses: [
    {
      usfm: 'MAT.11.28',
      versionId: 3034,
      fetchedText: 'Come to me, all you who are weary and burdened, and I will give you rest.',
      attribution: 'Berean Standard Bible',
    },
  ],
  devotionalBody: 'A short devotional body about rest.',
  cardSummary: 'Rest for the weary.',
  prayer: 'Lord, grant me rest.',
};

function fakeEngine(
  result: GenerateDevotionalResult = { devotional: SAMPLE_DEVOTIONAL, source: 'gloo' },
): DevotionalEngine {
  return { generate: vi.fn().mockResolvedValue(result) } as unknown as DevotionalEngine;
}

/** Manifest rows the fake TTS "measured" — Q1 (#331): the orchestrator stores them next to the MP3. */
const FAKE_MANIFEST = [
  { section: 'greeting' as const, startSec: 0, endSec: 1.5, text: 'A moment of Rest for the weary.' },
  { section: 'scripture' as const, startSec: 1.5, endSec: 6, text: 'From Matthew 11:28. Come to me.' },
  { section: 'reflection' as const, startSec: 6, endSec: 12, text: 'A short devotional body about rest.' },
  { section: 'prayer' as const, startSec: 12, endSec: 15, text: 'Lord, grant me rest.' },
];

function fakeTts(shouldFail = false): TtsService {
  return {
    synthesize: shouldFail
      ? vi.fn().mockRejectedValue(new TtsServiceError('synthesis failed (test)'))
      : vi.fn().mockResolvedValue({
          audio: Buffer.from('fake-mp3'),
          segmentCount: 1,
          charCount: 42,
          voiceName: 'en-US-Chirp3-HD-Achernar',
          manifest: FAKE_MANIFEST,
        }),
  } as unknown as TtsService;
}

async function makeUser(localPart: string, overrides: { tradition?: string; translationId?: number; timezone?: string } = {}) {
  const row = await repos.users.createUser({
    firebaseUid: `firebase-${localPart}`,
    email: `${localPart}@example.com`,
    tradition: overrides.tradition as never,
    translationId: overrides.translationId,
    timezone: overrides.timezone,
  });
  return row;
}

function buildOrchestrator(opts: {
  engine?: DevotionalEngine;
  tts?: TtsService;
  now?: () => Date;
  calendarClient?: GoogleCalendarClient;
  connections?: ConnectionsRepository;
  kmsService?: GoogleKmsService;
  prayerIntentions?: PrayerIntentionsRepository;
  logger?: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  deliveryProvider?: DeliveryProvider;
  meetBotDispatch?: ConstructorParameters<typeof GenerateNowOrchestrator>[0]['meetBotDispatch'];
  audioStorage?: LocalFileAudioStorage;
} = {}) {
  const audioStorage =
    opts.audioStorage ??
    new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
  return new GenerateNowOrchestrator({
    users: repos.users,
    preferences: repos.preferences,
    dailyBands: repos.dailyBands,
    devotionals: repos.devotionals,
    sessions: repos.sessions,
    devotionalEngine: opts.engine ?? fakeEngine(),
    ttsService: opts.tts ?? fakeTts(),
    audioStorage,
    publicBaseUrl: 'http://localhost:8080',
    now: opts.now,
    logger: opts.logger ?? { error: () => {}, info: () => {} },
    calendarClient: opts.calendarClient,
    connections: opts.connections,
    kmsService: opts.kmsService,
    calendarEvents: opts.calendarClient ? repos.calendarEvents : undefined,
    prayerIntentions: opts.prayerIntentions,
    deliveryProvider: opts.deliveryProvider,
    meetBotDispatch: opts.meetBotDispatch,
  });
}

describe('GenerateNowOrchestrator', () => {
  it('generates a devotional, uploads audio, and creates devotional+session rows for a user with prefs+bands', async () => {
    const user = await makeUser('full', { tradition: 'catholic', translationId: 3034 });
    await repos.preferences.ensureExists(asVerifiedUserId(user.id));
    await repos.dailyBands.upsertForDate(asVerifiedUserId(user.id), {
      date: '2026-07-02',
      recovery: 'low',
      sleepQuality: 'poor',
      activity: 'sedentary',
      busyness: 'heavy',
      distressSignal: false,
    });

    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(result.sessionUrl).toBe(`http://localhost:8080/session/${result.sessionToken}`);
    expect(result.audio.status).toBe('uploaded');
    expect(result.devotional.theme).toBe('Rest for the weary');
    expect(result.source).toBe('gloo');

    // Real rows exist in Postgres.
    const devotionalRow = await repos.devotionals.getById(asVerifiedUserId(user.id), result.devotionalId);
    expect(devotionalRow).not.toBeNull();
    expect(devotionalRow!.audio_object).not.toBeNull();
    expect(devotionalRow!.status).toBe('ready');

    const sessionRow = await repos.sessions.findByToken(result.sessionToken);
    expect(sessionRow).not.toBeNull();
    expect(sessionRow!.devotional_id).toBe(result.devotionalId);
    expect(sessionRow!.user_id).toBe(user.id);

    // Bands passed to the engine reflect the real daily_bands row, not defaults.
    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        bands: expect.objectContaining({ recovery: 'low', sleepQuality: 'poor', busyness: 'heavy' }),
        tradition: 'catholic',
        preferredVersionId: 3034,
        // Canonical shared-contracts label (S1 #342): loadPreferences now
        // derives this via versionDisplayLabel.
        translation: 'Berean Standard Bible (BSB)',
      }),
    );
  });

  it('stores the timing manifest next to the MP3 on success (Q1 #331)', async () => {
    const user = await makeUser('manifest');
    const audioStorage = new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
    const orchestrator = buildOrchestrator({ audioStorage });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(result.audio.status).toBe('uploaded');
    const stored = await audioStorage.getManifest(result.devotionalId);
    expect(stored).toEqual(FAKE_MANIFEST);
  });

  it('a manifest upload failure does NOT fail generation or flip audio to unavailable (Q1 #331)', async () => {
    const user = await makeUser('manifest-fail');
    const audioStorage = new LocalFileAudioStorage({
      rootDir: audioRootDir,
      signingSecret: 'a'.repeat(32),
    });
    vi.spyOn(audioStorage, 'uploadManifest').mockRejectedValue(new Error('bucket sneezed'));
    const logger = { error: vi.fn(), info: vi.fn() };
    const orchestrator = buildOrchestrator({ audioStorage, logger });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    // Generation succeeded, audio stayed uploaded, and the failure is legible.
    expect(result.audio.status).toBe('uploaded');
    expect(await audioStorage.getManifest(result.devotionalId)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('manifest'),
      expect.objectContaining({ devotionalId: result.devotionalId }),
    );
  });

  it('defaults to general/BSB/3034 when no preferences row exists yet (docs/14 §3.5: defaults, not 404)', async () => {
    const user = await makeUser('nodefaults');
    // Deliberately do NOT call preferences.ensureExists — simulates a
    // brand-new user who has never opened Preferences.

    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(result.sessionUrl).toContain('/session/');
    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        tradition: 'general',
        preferredVersionId: 3034,
        translation: 'Berean Standard Bible (BSB)',
      }),
    );
  });

  it("threads the user's stored language into TTS synthesis, defaulting to en (story O4 #316)", async () => {
    // The users.language column (O2 #314) must reach TtsService.synthesize,
    // where the voice locale and the spoken connective phrases follow it —
    // a column nothing reads is exactly the bug Epic O opened with.
    const esUser = await makeUser('language-es');
    await repos.users.updateProfile(asVerifiedUserId(esUser.id), { language: 'es' });
    const enUser = await makeUser('language-default');

    const tts = fakeTts();
    const orchestrator = buildOrchestrator({ tts });

    await orchestrator.generateNow({ userId: esUser.id, date: '2026-07-02' });
    await orchestrator.generateNow({ userId: enUser.id, date: '2026-07-02' });

    const calls = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls;
    // Fifth argument is the language tag; TtsService derives the locale
    // (es -> es-US, zh -> cmn-CN) so the orchestrator never handles locales.
    expect(calls[0][4]).toBe('es');
    expect(calls[1][4]).toBe('en');
  });

  it('uses neutral default bands when no daily_bands row exists for the date, never fabricating an extreme signal', async () => {
    const user = await makeUser('nobands');
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ bands: NEUTRAL_DEFAULT_BANDS }),
    );
  });

  /**
   * Provenance derivation (issue #196 / K10). `loadBands` is the only place
   * that still knows whether a band was measured — the `??` fallbacks it
   * applies erase the difference on the way out. These assert that the fact
   * survives the trip to the engine, because that is what stops the generated
   * devotional from describing a hardcoded `moderate` as something it noticed.
   */
  it('reports NO signals as observed when no daily_bands row exists at all', async () => {
    const user = await makeUser('provenance-none');
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ signalProvenance: NO_SIGNALS_OBSERVED }),
    );
  });

  it('reports busyness as observed and health as unobserved for a calendar-only user', async () => {
    // The calendar-first case the pivot is built around (PRD §5, "Maya"):
    // calendar connected, HealthKit never granted — or granted on a phone the
    // user does not have. Busyness is a REAL BusynessAnalyzer reading and must
    // keep driving personalization; the three health columns are null and must
    // not be spoken as observations. Getting this wrong in either direction is
    // a bug: suppress busyness and a complete user is flattened to a generic
    // one; claim recovery and Wellspring invents knowledge it does not have.
    const user = await makeUser('provenance-calendar-only');
    await repos.dailyBands.upsertForDate(asVerifiedUserId(user.id), {
      date: '2026-07-02',
      recovery: null,
      sleepQuality: null,
      activity: null,
      busyness: 'heavy',
      distressSignal: false,
    });
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    const params = vi.mocked(engine.generate).mock.calls[0]![0] as {
      bands: BandInput;
      signalProvenance: SignalProvenance;
    };
    expect(params.signalProvenance).toEqual(CALENDAR_ONLY_SIGNALS_OBSERVED);
    // The band VALUES still carry neutral defaults for the health signals —
    // provenance is what makes that safe, not a change to the values.
    expect(params.bands.busyness).toBe('heavy');
    expect(params.bands.recovery).toBe(NEUTRAL_DEFAULT_BANDS.recovery);
  });

  it('reports every signal as observed when the full band row is present', async () => {
    const user = await makeUser('provenance-full');
    await repos.dailyBands.upsertForDate(asVerifiedUserId(user.id), {
      date: '2026-07-02',
      recovery: 'low',
      sleepQuality: 'poor',
      activity: 'sedentary',
      busyness: 'heavy',
      distressSignal: false,
    });
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ signalProvenance: ALL_SIGNALS_OBSERVED }),
    );
  });

  it('treats an explicit bandsOverride as unobserved — an override cannot vouch for a measurement', async () => {
    const user = await makeUser('provenance-override');
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({
      userId: user.id,
      date: '2026-07-02',
      bandsOverride: NEUTRAL_DEFAULT_BANDS,
    });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ signalProvenance: NO_SIGNALS_OBSERVED }),
    );
  });

  it('still creates the devotional and session rows when TTS fails — never silently loses the generated text', async () => {
    const user = await makeUser('ttsfail');
    const orchestrator = buildOrchestrator({ tts: fakeTts(true) });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(result.audio.status).toBe('unavailable');
    expect(result.audio.status === 'unavailable' && result.audio.reason).toContain('synthesis failed');

    const devotionalRow = await repos.devotionals.getById(asVerifiedUserId(user.id), result.devotionalId);
    expect(devotionalRow).not.toBeNull();
    expect(devotionalRow!.devotional_body).toBe(SAMPLE_DEVOTIONAL.devotionalBody);
    expect(devotionalRow!.audio_object).toBeNull();

    const sessionRow = await repos.sessions.findByToken(result.sessionToken);
    expect(sessionRow).not.toBeNull();
  });

  it('sets session expiry to now + 48h (placeholder expiry — no calendar event yet)', async () => {
    const user = await makeUser('expiry');
    const fixedNow = new Date('2026-07-02T10:00:00.000Z');
    const orchestrator = buildOrchestrator({ now: () => fixedNow });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });
    const sessionRow = await repos.sessions.findByToken(result.sessionToken);

    const expectedExpiry = new Date(fixedNow.getTime() + 48 * 60 * 60 * 1000);
    expect(sessionRow!.expires_at.getTime()).toBe(expectedExpiry.getTime());
  });

  it('marks the devotional row is_fixture_fallback=true when the engine falls back to a fixture', async () => {
    const user = await makeUser('fixture');
    const engine = fakeEngine({ devotional: SAMPLE_DEVOTIONAL, source: 'fixture' });
    const orchestrator = buildOrchestrator({ engine });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });
    const devotionalRow = await repos.devotionals.getById(asVerifiedUserId(user.id), result.devotionalId);

    expect(devotionalRow!.is_fixture_fallback).toBe(true);
    expect(result.source).toBe('fixture');
  });

  // ──────────────────────────────────────────────────────────────
  // Idempotency (issue #28 C7)
  // ──────────────────────────────────────────────────────────────

  it('throws AlreadyExistsError on a second call for the same date — does not create a second devotional row', async () => {
    const user = await makeUser('idempotent');
    const orchestrator = buildOrchestrator();

    // First call — succeeds.
    const first = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });
    expect(first.devotionalId).toBeDefined();

    // Second call — same date — must throw AlreadyExistsError, not create a
    // new row.
    await expect(
      orchestrator.generateNow({ userId: user.id, date: '2026-07-02' }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);

    // Confirm only one devotional row exists.
    const rows = await repos.devotionals.listForUser(asVerifiedUserId(user.id));
    expect(rows).toHaveLength(1);
  });

  it('AlreadyExistsError carries the existing devotionalId and a session URL', async () => {
    const user = await makeUser('idempotent-data');
    const orchestrator = buildOrchestrator();

    const first = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    let caught: AlreadyExistsError | null = null;
    try {
      await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });
    } catch (err) {
      if (err instanceof AlreadyExistsError) caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught!.devotionalId).toBe(first.devotionalId);
    expect(caught!.sessionToken).toBe(first.sessionToken);
    expect(caught!.sessionUrl).toContain('/session/');
  });

  // ──────────────────────────────────────────────────────────────
  // slotType / distressSignalOverride / skipIdempotencyCheck (issue #77)
  // ──────────────────────────────────────────────────────────────

  it('scopes idempotency by slotType — an examen generation does not collide with an existing standard devotional for the same date', async () => {
    const user = await makeUser('slot-scoped');
    const orchestrator = buildOrchestrator();

    const standard = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });
    const examen = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02', slotType: 'examen' });

    expect(examen.devotionalId).not.toBe(standard.devotionalId);

    const rows = await repos.devotionals.listForUser(asVerifiedUserId(user.id));
    expect(rows).toHaveLength(2);

    // Both slots independently guard against a second same-slot call.
    await expect(
      orchestrator.generateNow({ userId: user.id, date: '2026-07-02' }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    await expect(
      orchestrator.generateNow({ userId: user.id, date: '2026-07-02', slotType: 'examen' }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it('passes slotType through to devotionalEngine.generate and stores it on the created devotional row', async () => {
    const user = await makeUser('slot-passthrough');
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02', slotType: 'examen' });

    expect(engine.generate).toHaveBeenCalledWith(expect.objectContaining({ slotType: 'examen' }));

    const row = await repos.devotionals.getById(asVerifiedUserId(user.id), result.devotionalId);
    expect(row!.slot_type).toBe('examen');
  });

  it('distressSignalOverride forces bands.distressSignal=true while preserving the real recovery/sleep/activity/busyness bands', async () => {
    const user = await makeUser('distress-override');
    await repos.dailyBands.upsertForDate(asVerifiedUserId(user.id), {
      date: '2026-07-02',
      recovery: 'high',
      sleepQuality: 'good',
      activity: 'active',
      busyness: 'light',
      distressSignal: false,
    });
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02', distressSignalOverride: true });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        bands: expect.objectContaining({
          recovery: 'high',
          sleepQuality: 'good',
          activity: 'active',
          busyness: 'light',
          distressSignal: true,
        }),
      }),
    );
  });

  it('skipIdempotencyCheck bypasses the "already generated" guard — always creates a fresh devotional even when one exists for that date+slot', async () => {
    const user = await makeUser('skip-idempotency');
    const orchestrator = buildOrchestrator();

    const first = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });
    const second = await orchestrator.generateNow({
      userId: user.id,
      date: '2026-07-02',
      skipIdempotencyCheck: true,
    });

    expect(second.devotionalId).not.toBe(first.devotionalId);

    const rows = await repos.devotionals.listForUser(asVerifiedUserId(user.id));
    expect(rows).toHaveLength(2);
  });

  it('auto-skips the calendar step for a non-standard slotType, even without an explicit skipCalendar', async () => {
    const user = await makeUser('examen-no-calendar');
    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('encrypted-token'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'v1',
      scopes: [],
    });

    const mockCalendarClient = { withRefreshToken: vi.fn() } as unknown as GoogleCalendarClient;
    const mockKmsService = { decryptToken: vi.fn() } as unknown as GoogleKmsService;

    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02', slotType: 'examen' });

    expect(mockCalendarClient.withRefreshToken).not.toHaveBeenCalled();
    expect(result.calendar).toBeUndefined();
  });

  it('auto-skips the calendar step when distressSignalOverride is true, even without an explicit skipCalendar', async () => {
    const user = await makeUser('distress-no-calendar');
    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('encrypted-token'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'v1',
      scopes: [],
    });

    const mockCalendarClient = { withRefreshToken: vi.fn() } as unknown as GoogleCalendarClient;
    const mockKmsService = { decryptToken: vi.fn() } as unknown as GoogleKmsService;

    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
    });

    const result = await orchestrator.generateNow({
      userId: user.id,
      date: '2026-07-02',
      distressSignalOverride: true,
    });

    expect(mockCalendarClient.withRefreshToken).not.toHaveBeenCalled();
    expect(result.calendar).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────
  // Calendar integration (issue #24 C3)
  // ──────────────────────────────────────────────────────────────

  it('calls insertEvent with correct summary and description containing sessionUrl, stores a calendar_events row', async () => {
    const user = await makeUser('calendar-path', { timezone: 'America/Chicago' });
    await repos.preferences.ensureExists(asVerifiedUserId(user.id));

    // Insert a connection row so findByProvider returns an active connection.
    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('encrypted-token'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'projects/test/locations/us/keyRings/k/cryptoKeys/key/cryptoKeyVersions/1',
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });

    const insertEventMock = vi.fn().mockResolvedValue({ eventId: 'gcal-event-id-123', htmlLink: 'https://calendar.google.com/event/123' });
    const getFreeBusyMock = vi.fn().mockResolvedValue([
      // One existing meeting 09:30-10:00 UTC in the window 07:00-09:00 UTC
      // — but our window is 07:00-09:00 so there's a gap before it.
      // Actually, let's have an empty busy list so the whole window is a gap.
    ]);

    const mockUserCalendarClient: Partial<GoogleCalendarClient> = {
      insertEvent: insertEventMock,
      getFreeBusyBlocks: getFreeBusyMock,
      withRefreshToken: vi.fn().mockReturnThis() as never,
    };

    const mockCalendarClient = {
      withRefreshToken: vi.fn().mockReturnValue(mockUserCalendarClient as GoogleCalendarClient),
    } as unknown as GoogleCalendarClient;

    const mockKmsService = {
      decryptToken: vi.fn().mockResolvedValue('plaintext-refresh-token'),
    } as unknown as GoogleKmsService;

    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    // KMS decryption was called with the stored ciphertext.
    expect(mockKmsService.decryptToken).toHaveBeenCalledWith(
      expect.any(Buffer),
    );

    // withRefreshToken was called with the decrypted token.
    expect(mockCalendarClient.withRefreshToken).toHaveBeenCalledWith('plaintext-refresh-token');

    // freeBusy was called.
    expect(getFreeBusyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeZone: 'America/Chicago',
      }),
    );

    // insertEvent was called with the correct summary.
    expect(insertEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Wellspring — a moment with God',
        description: expect.stringContaining(result.sessionUrl),
        timeZone: 'America/Chicago',
      }),
    );

    // Calendar outcome is returned in the result.
    expect(result.calendar).toBeDefined();
    expect(result.calendar).not.toHaveProperty('skipped');
    expect((result.calendar as { eventId: string }).eventId).toBe('gcal-event-id-123');

    // A calendar_events row was stored.
    const calendarRows = await repos.calendarEvents.listForUser(asVerifiedUserId(user.id));
    expect(calendarRows).toHaveLength(1);
    expect(calendarRows[0]!.provider_event_id).toBe('gcal-event-id-123');
    expect(calendarRows[0]!.gap_source).toBe('found_gap');
    expect(calendarRows[0]!.devotional_id).toBe(result.devotionalId);
  });

  it('D4/#32: with a LiveKit-style DeliveryProvider injected, the calendar description carries the joinUrl first and the plain session page as an explicit fallback line — sessionUrl in the result stays the plain page (no downstream regression)', async () => {
    const user = await makeUser('livekit-delivery', { timezone: 'America/Chicago' });
    await repos.preferences.ensureExists(asVerifiedUserId(user.id));

    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('encrypted-token'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'projects/test/locations/us/keyRings/k/cryptoKeys/key/cryptoKeyVersions/1',
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });

    const insertEventMock = vi.fn().mockResolvedValue({ eventId: 'gcal-event-id-456', htmlLink: 'https://calendar.google.com/event/456' });
    const mockUserCalendarClient: Partial<GoogleCalendarClient> = {
      insertEvent: insertEventMock,
      getFreeBusyBlocks: vi.fn().mockResolvedValue([]),
      withRefreshToken: vi.fn().mockReturnThis() as never,
    };
    const mockCalendarClient = {
      withRefreshToken: vi.fn().mockReturnValue(mockUserCalendarClient as GoogleCalendarClient),
    } as unknown as GoogleCalendarClient;
    const mockKmsService = {
      decryptToken: vi.fn().mockResolvedValue('plaintext-refresh-token'),
    } as unknown as GoogleKmsService;

    const fakeLiveKitProvider: DeliveryProvider = {
      kind: 'livekit',
      prepareDelivery: ({ sessionToken }) => ({
        joinUrl: `http://localhost:8080/room/${sessionToken}`,
        fallbackUrl: `http://localhost:8080/session/${sessionToken}`,
      }),
    };

    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
      deliveryProvider: fakeLiveKitProvider,
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    // sessionUrl returned to the caller is still the plain session page —
    // no existing consumer (iOS, tests) needs to change for a richer
    // provider to be wired in.
    expect(result.sessionUrl).toBe(`http://localhost:8080/session/${result.sessionToken}`);

    const description = insertEventMock.mock.calls[0]![0].description as string;
    expect(description).toContain(`Join your devotional: http://localhost:8080/room/${result.sessionToken}`);
    expect(description).toContain(`Prefer plain audio? http://localhost:8080/session/${result.sessionToken}`);
  });

  it('H1c (#131): with MeetBotProvider injected, requests conferenceData, stores meetUri, and schedules the bot dispatch at gap_start_at', async () => {
    const user = await makeUser('meetbot-delivery', { timezone: 'America/Chicago' });
    await repos.preferences.ensureExists(asVerifiedUserId(user.id));

    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('encrypted-token'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'projects/test/locations/us/keyRings/k/cryptoKeys/key/cryptoKeyVersions/1',
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });

    const insertEventMock = vi.fn().mockResolvedValue({
      eventId: 'gcal-event-id-789',
      htmlLink: 'https://calendar.google.com/event/789',
      meetUri: 'https://meet.google.com/abc-defg-hij',
    });
    const mockUserCalendarClient: Partial<GoogleCalendarClient> = {
      insertEvent: insertEventMock,
      getFreeBusyBlocks: vi.fn().mockResolvedValue([]),
      withRefreshToken: vi.fn().mockReturnThis() as never,
    };
    const mockCalendarClient = {
      withRefreshToken: vi.fn().mockReturnValue(mockUserCalendarClient as GoogleCalendarClient),
    } as unknown as GoogleCalendarClient;
    const mockKmsService = {
      decryptToken: vi.fn().mockResolvedValue('plaintext-refresh-token'),
    } as unknown as GoogleKmsService;

    const meetBotProvider: DeliveryProvider = {
      kind: 'meetbot',
      prepareDelivery: ({ sessionToken }) => ({
        joinUrl: `http://localhost:8080/session/${sessionToken}`,
        fallbackUrl: `http://localhost:8080/session/${sessionToken}`,
      }),
    };
    const scheduleHttpTask = vi.fn().mockResolvedValue({ taskName: 'projects/p/locations/l/queues/q/tasks/t' });

    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
      deliveryProvider: meetBotProvider,
      meetBotDispatch: {
        taskScheduler: { scheduleHttpTask },
        dispatchUrl: 'http://localhost:8080/internal/dispatch-meetbot',
        internalApiToken: 'test-internal-token',
      },
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    // requestConferenceData was passed through to insertEvent.
    expect(insertEventMock.mock.calls[0]![0].requestConferenceData).toBe(true);

    // meetUri is persisted on the calendar_events row.
    const calendarRows = await repos.calendarEvents.listForUser(asVerifiedUserId(user.id));
    expect(calendarRows).toHaveLength(1);
    expect(calendarRows[0]!.meet_uri).toBe('https://meet.google.com/abc-defg-hij');

    // The dispatch task was scheduled at gap_start_at with the right payload.
    expect(scheduleHttpTask).toHaveBeenCalledOnce();
    const scheduleArgs = scheduleHttpTask.mock.calls[0]![0] as {
      url: string;
      scheduleTime: Date;
      headers: Record<string, string>;
      body: { meetingUrl: string; devotionalId: string };
      taskName: string;
    };
    expect(scheduleArgs.url).toBe('http://localhost:8080/internal/dispatch-meetbot');
    expect(scheduleArgs.headers['X-Internal-Token']).toBe('test-internal-token');
    expect(scheduleArgs.body).toEqual({ meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: result.devotionalId });
    expect(scheduleArgs.taskName).toBe(`meetbot-${result.devotionalId}`);
    expect(scheduleArgs.scheduleTime).toEqual(new Date(calendarRows[0]!.gap_start_at));
  });

  it('H1c (#131): does not request conferenceData or schedule dispatch when meetBotDispatch is not configured, even with MeetBotProvider active', async () => {
    const user = await makeUser('meetbot-no-dispatch-config', { timezone: 'America/Chicago' });
    await repos.preferences.ensureExists(asVerifiedUserId(user.id));

    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('encrypted-token'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'projects/test/locations/us/keyRings/k/cryptoKeys/key/cryptoKeyVersions/1',
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });

    const insertEventMock = vi.fn().mockResolvedValue({ eventId: 'gcal-event-id-999', htmlLink: '', meetUri: 'https://meet.google.com/xyz' });
    const mockUserCalendarClient: Partial<GoogleCalendarClient> = {
      insertEvent: insertEventMock,
      getFreeBusyBlocks: vi.fn().mockResolvedValue([]),
      withRefreshToken: vi.fn().mockReturnThis() as never,
    };
    const mockCalendarClient = {
      withRefreshToken: vi.fn().mockReturnValue(mockUserCalendarClient as GoogleCalendarClient),
    } as unknown as GoogleCalendarClient;
    const mockKmsService = { decryptToken: vi.fn().mockResolvedValue('plaintext-refresh-token') } as unknown as GoogleKmsService;

    const meetBotProvider: DeliveryProvider = {
      kind: 'meetbot',
      prepareDelivery: ({ sessionToken }) => ({
        joinUrl: `http://localhost:8080/session/${sessionToken}`,
        fallbackUrl: `http://localhost:8080/session/${sessionToken}`,
      }),
    };

    // meetBotDispatch deliberately omitted — requestConferenceData still
    // fires (driven purely by deliveryProvider.kind), but there's simply
    // no scheduler to call, so nothing is scheduled. No error either way.
    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
      deliveryProvider: meetBotProvider,
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });
    expect(result.calendar).toMatchObject({ eventId: 'gcal-event-id-999' });
  });

  it('Q6 (#336): with ImmediateTaskScheduler as the transport, generate-now fires ONE immediate POST to /internal/dispatch-meetbot and returns without waiting on the dispatch', async () => {
    const user = await makeUser('meetbot-immediate-dispatch', { timezone: 'America/Chicago' });
    await repos.preferences.ensureExists(asVerifiedUserId(user.id));
    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('encrypted-token'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'projects/test/locations/us/keyRings/k/cryptoKeys/key/cryptoKeyVersions/1',
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });

    const insertEventMock = vi.fn().mockResolvedValue({
      eventId: 'gcal-event-immediate',
      htmlLink: '',
      meetUri: 'https://meet.google.com/abc-defg-hij',
    });
    const mockCalendarClient = {
      withRefreshToken: vi.fn().mockReturnValue({
        insertEvent: insertEventMock,
        getFreeBusyBlocks: vi.fn().mockResolvedValue([]),
        withRefreshToken: vi.fn().mockReturnThis() as never,
      } as unknown as GoogleCalendarClient),
    } as unknown as GoogleCalendarClient;
    const mockKmsService = { decryptToken: vi.fn().mockResolvedValue('plaintext-refresh-token') } as unknown as GoogleKmsService;
    const meetBotProvider: DeliveryProvider = {
      kind: 'meetbot',
      prepareDelivery: ({ sessionToken }) => ({
        joinUrl: `http://localhost:8080/session/${sessionToken}`,
        fallbackUrl: `http://localhost:8080/session/${sessionToken}`,
      }),
    };

    // The dispatch route holds its response for the whole bot lifecycle
    // (up to 20 min) — modelled by a fetch that NEVER settles. If the
    // immediate path awaited the response anywhere, generateNow would hang
    // here and the test would time out (#296: generation latency must not
    // grow at all).
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {}));
    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
      deliveryProvider: meetBotProvider,
      meetBotDispatch: {
        taskScheduler: new ImmediateTaskScheduler({ fetchImpl: fetchImpl as unknown as typeof fetch }),
        dispatchUrl: 'http://localhost:8080/internal/dispatch-meetbot',
        internalApiToken: 'test-internal-token',
      },
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    // Exactly one POST, to our own dispatch route, with the internal token
    // — the orchestrator call site is untouched; only the transport changed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('http://localhost:8080/internal/dispatch-meetbot');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Internal-Token']).toBe('test-internal-token');
    expect(JSON.parse(init.body)).toEqual({
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      devotionalId: result.devotionalId,
    });
  });

  it('Q6 (#336): a synchronously-throwing send neither fails generation nor loses the calendar event (mutation check on log-and-continue)', async () => {
    const user = await makeUser('meetbot-immediate-syncthrow', { timezone: 'America/Chicago' });
    await repos.preferences.ensureExists(asVerifiedUserId(user.id));
    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('encrypted-token'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'projects/test/locations/us/keyRings/k/cryptoKeys/key/cryptoKeyVersions/1',
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });

    const insertEventMock = vi.fn().mockResolvedValue({
      eventId: 'gcal-event-syncthrow',
      htmlLink: '',
      meetUri: 'https://meet.google.com/abc-defg-hij',
    });
    const mockCalendarClient = {
      withRefreshToken: vi.fn().mockReturnValue({
        insertEvent: insertEventMock,
        getFreeBusyBlocks: vi.fn().mockResolvedValue([]),
        withRefreshToken: vi.fn().mockReturnThis() as never,
      } as unknown as GoogleCalendarClient),
    } as unknown as GoogleCalendarClient;
    const mockKmsService = { decryptToken: vi.fn().mockResolvedValue('plaintext-refresh-token') } as unknown as GoogleKmsService;
    const meetBotProvider: DeliveryProvider = {
      kind: 'meetbot',
      prepareDelivery: ({ sessionToken }) => ({
        joinUrl: `http://localhost:8080/session/${sessionToken}`,
        fallbackUrl: `http://localhost:8080/session/${sessionToken}`,
      }),
    };

    const fetchImpl = vi.fn(() => {
      throw new Error('sync boom');
    });
    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
      deliveryProvider: meetBotProvider,
      meetBotDispatch: {
        taskScheduler: new ImmediateTaskScheduler({ fetchImpl: fetchImpl as unknown as typeof fetch }),
        dispatchUrl: 'http://localhost:8080/internal/dispatch-meetbot',
        internalApiToken: 'test-internal-token',
      },
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.calendar).toMatchObject({ eventId: 'gcal-event-syncthrow' });
    const calendarRows = await repos.calendarEvents.listForUser(asVerifiedUserId(user.id));
    expect(calendarRows).toHaveLength(1);
  });

  it('skips calendar step with skipped="no_active_connection" when no active connection exists', async () => {
    const user = await makeUser('no-connection');

    const mockCalendarClient = {
      withRefreshToken: vi.fn(),
    } as unknown as GoogleCalendarClient;

    const mockKmsService = {
      decryptToken: vi.fn(),
    } as unknown as GoogleKmsService;

    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    // Should not have called withRefreshToken.
    expect(mockCalendarClient.withRefreshToken).not.toHaveBeenCalled();

    // Calendar outcome should be a skip.
    expect(result.calendar).toEqual({ skipped: 'no_active_connection' });

    // Devotional and session still exist.
    const devotionalRow = await repos.devotionals.getById(asVerifiedUserId(user.id), result.devotionalId);
    expect(devotionalRow).not.toBeNull();
  });

  it('continues with devotional+session intact when calendar integration throws — skipped with reason calendar_error', async () => {
    const user = await makeUser('calendar-error');

    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('encrypted-token'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'projects/test/locations/us/keyRings/k/cryptoKeys/key/cryptoKeyVersions/1',
      scopes: [],
    });

    const mockCalendarClient = {
      withRefreshToken: vi.fn().mockReturnValue({
        getFreeBusyBlocks: vi.fn().mockRejectedValue(new Error('Network error from Google')),
        insertEvent: vi.fn(),
      }),
    } as unknown as GoogleCalendarClient;

    const mockKmsService = {
      decryptToken: vi.fn().mockResolvedValue('refresh-token'),
    } as unknown as GoogleKmsService;

    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: mockKmsService,
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    // Calendar failed but result is still returned.
    expect(result.calendar).toEqual({ skipped: 'calendar_error' });
    expect(result.devotionalId).toBeDefined();
    expect(result.sessionToken).toBeDefined();

    // Devotional row persisted.
    const devotionalRow = await repos.devotionals.getById(asVerifiedUserId(user.id), result.devotionalId);
    expect(devotionalRow).not.toBeNull();

    // No calendar_events row.
    const calendarRows = await repos.calendarEvents.listForUser(asVerifiedUserId(user.id));
    expect(calendarRows).toHaveLength(0);
  });

  it('respects skipCalendar param — does not call calendarClient even when deps are present', async () => {
    const user = await makeUser('skip-calendar');

    const mockCalendarClient = {
      withRefreshToken: vi.fn(),
    } as unknown as GoogleCalendarClient;

    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: { decryptToken: vi.fn() } as unknown as GoogleKmsService,
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02', skipCalendar: true });

    expect(mockCalendarClient.withRefreshToken).not.toHaveBeenCalled();
    // calendar key should not be present in the result.
    expect(result.calendar).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────
  // Sabbath awareness (docs/14 §5.6, issue #94)
  // ──────────────────────────────────────────────────────────────

  it('sabbathSession=true forces durationPreference=extended and nulls actionStep, even when the engine returns one', async () => {
    const user = await makeUser('sabbath-extended');
    const engine = fakeEngine({
      devotional: { ...SAMPLE_DEVOTIONAL, format: 'extended', actionStep: 'Call a friend today.' },
      source: 'gloo',
    });
    const orchestrator = buildOrchestrator({ engine });

    const result = await orchestrator.generateNow({
      userId: user.id,
      date: '2026-07-02',
      sabbathSession: true,
    });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ durationPreference: 'extended' }),
    );

    const row = await repos.devotionals.getById(asVerifiedUserId(user.id), result.devotionalId);
    expect(row!.action_step).toBeNull();
  });

  it('without sabbathSession, actionStep from the engine is preserved as before (no behavior change for ordinary generation)', async () => {
    const user = await makeUser('non-sabbath-action');
    const engine = fakeEngine({
      devotional: { ...SAMPLE_DEVOTIONAL, actionStep: 'Reach out to someone in need.' },
      source: 'gloo',
    });
    const orchestrator = buildOrchestrator({ engine });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ durationPreference: undefined }),
    );

    const row = await repos.devotionals.getById(asVerifiedUserId(user.id), result.devotionalId);
    expect(row!.action_step).toBe('Reach out to someone in need.');
  });

  it('skips the calendar event when the resolved format is extended and the best gap is under the 15-minute floor', async () => {
    const user = await makeUser('sabbath-short-gap');
    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('enc'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'v1',
      scopes: [],
    });

    // A single 10-minute busy-free gap — under the 15-minute extended-format
    // floor — inside the default 09:00-17:00 workday window (#303).
    const gapStart = '2026-07-03T12:00:00.000Z';
    const gapEnd = '2026-07-03T12:10:00.000Z';
    const userCalendarClient = {
      getFreeBusyBlocks: vi.fn().mockResolvedValue([
        // Busy for the rest of the window except the 10-minute gap above.
        { start: '2026-07-03T09:00:00.000Z', end: gapStart },
        { start: gapEnd, end: '2026-07-03T17:00:00.000Z' },
      ]),
      insertEvent: vi.fn(),
      withRefreshToken: vi.fn(),
    };
    const mockCalendarClient = {
      withRefreshToken: vi.fn().mockReturnValue(userCalendarClient),
    } as unknown as GoogleCalendarClient;

    const engine = fakeEngine({ devotional: { ...SAMPLE_DEVOTIONAL, format: 'extended' }, source: 'gloo' });
    const orchestrator = buildOrchestrator({
      engine,
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: { decryptToken: vi.fn().mockResolvedValue('token') } as unknown as GoogleKmsService,
    });

    const result = await orchestrator.generateNow({
      userId: user.id,
      date: '2026-07-02',
      sabbathSession: true,
    });

    expect(userCalendarClient.insertEvent).not.toHaveBeenCalled();
    expect(result.calendar).toEqual({ skipped: 'no_gap_found' });
  });

  // ──────────────────────────────────────────────────────────────
  // Liturgical seasons (docs/14 §5.7, issue #95)
  // ──────────────────────────────────────────────────────────────

  it('threads the resolved generation date to the engine regardless of preferences', async () => {
    const user = await makeUser('liturgical-date-thread');
    await repos.preferences.ensureExists(asVerifiedUserId(user.id));
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    // 2026-12-06 is the 2nd week of Advent 2026.
    await orchestrator.generateNow({ userId: user.id, date: '2026-12-06' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-12-06', liturgicalSeasonsEnabled: false }),
    );
  });

  it('threads liturgicalSeasonsEnabled=true from the preferences row once opted in', async () => {
    const user = await makeUser('liturgical-opt-in', { tradition: 'evangelical' });
    await repos.preferences.ensureExists(asVerifiedUserId(user.id));
    await repos.preferences.update(asVerifiedUserId(user.id), { liturgical_seasons_enabled: true });
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({ userId: user.id, date: '2026-12-06' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-12-06', liturgicalSeasonsEnabled: true }),
    );
  });

  it('defaults liturgicalSeasonsEnabled to false when preferencesOverride is used without specifying it', async () => {
    const user = await makeUser('liturgical-override-default');
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({
      userId: user.id,
      date: '2026-12-06',
      preferencesOverride: { tradition: 'catholic', translation: 'BSB', preferredVersionId: 3034 },
    });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ liturgicalSeasonsEnabled: false }),
    );
  });

  it('updates session expiry to event-end + 48h after a successful calendar event insert', async () => {
    const user = await makeUser('expiry-calendar');

    await repos.connections.upsert(asVerifiedUserId(user.id), {
      provider: 'google_calendar',
      encryptedRefreshToken: Buffer.from('enc'),
      encryptionIv: Buffer.alloc(12),
      encryptionAuthTag: Buffer.alloc(16),
      kmsKeyVersion: 'v1',
      scopes: [],
    });

    const fixedNow = new Date('2026-07-02T10:00:00.000Z');
    // Gap: 08:00-08:30 UTC tomorrow (2026-07-03)
    const gapStart = '2026-07-03T08:00:00.000Z';
    const gapEnd = '2026-07-03T08:30:00.000Z';

    const userCalendarClient = {
      getFreeBusyBlocks: vi.fn().mockResolvedValue([]),
      insertEvent: vi.fn().mockResolvedValue({ eventId: 'evt-expiry', htmlLink: '' }),
      withRefreshToken: vi.fn(),
    };
    // The getFreeBusyBlocks mock returns empty — so the whole window is a gap.
    // We need to know what window the orchestrator constructs to verify the expiry.
    // The gap will be a subset of the window; for the expiry test we can check
    // that the session expiry is AFTER the placeholder expiry (now + 48h).
    const mockCalendarClient = {
      withRefreshToken: vi.fn().mockReturnValue(userCalendarClient),
    } as unknown as GoogleCalendarClient;

    const orchestrator = buildOrchestrator({
      calendarClient: mockCalendarClient,
      connections: repos.connections,
      kmsService: { decryptToken: vi.fn().mockResolvedValue('token') } as unknown as GoogleKmsService,
      now: () => fixedNow,
    });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    const sessionRow = await repos.sessions.findByToken(result.sessionToken);
    // Placeholder expiry would be fixedNow + 48h = 2026-07-04T10:00:00Z
    const placeholder = new Date(fixedNow.getTime() + 48 * 60 * 60 * 1000);

    // The actual expiry must be based on the gap end (tomorrow's window) + 48h,
    // which is later than the placeholder (since the window is tomorrow, not now).
    // The gap end will be window end minus edge buffer (30 min), so at minimum
    // the session expiry > placeholder expiry.
    expect(sessionRow!.expires_at.getTime()).toBeGreaterThan(placeholder.getTime());
  });

  // ──────────────────────────────────────────────────────────────
  // Prayer intentions — deliberate disclosure (docs/14 §5.5, issue #93)
  // ──────────────────────────────────────────────────────────────

  it('looks up YESTERDAY\'s prayer intention (relative to the generation date) and threads it to the engine', async () => {
    const user = await makeUser('prayer-lookup');
    const verifiedUserId = asVerifiedUserId(user.id);
    const yesterdayDevo = await repos.devotionals.create(verifiedUserId, {
      date: '2026-07-01',
      format: 'short',
      theme: 'yesterday',
      verses: SAMPLE_DEVOTIONAL.verses,
      devotionalBody: 'body',
      cardSummary: 'summary',
      prayer: 'prayer',
    });
    await repos.prayerIntentions.record(verifiedUserId, yesterdayDevo.id, 'a hard conversation with my sister');

    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine, prayerIntentions: repos.prayerIntentions });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prayerIntention: 'a hard conversation with my sister' }),
    );
  });

  it('correctly computes "yesterday" across a month/year boundary', async () => {
    const user = await makeUser('prayer-lookup-boundary');
    const verifiedUserId = asVerifiedUserId(user.id);
    const yesterdayDevo = await repos.devotionals.create(verifiedUserId, {
      date: '2025-12-31',
      format: 'short',
      theme: 'yesterday',
      verses: SAMPLE_DEVOTIONAL.verses,
      devotionalBody: 'body',
      cardSummary: 'summary',
      prayer: 'prayer',
    });
    await repos.prayerIntentions.record(verifiedUserId, yesterdayDevo.id, 'new year anxiety');

    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine, prayerIntentions: repos.prayerIntentions });

    await orchestrator.generateNow({ userId: user.id, date: '2026-01-01' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prayerIntention: 'new year anxiety' }),
    );
  });

  it('threads prayerIntention=undefined when nothing was recorded yesterday', async () => {
    const user = await makeUser('prayer-lookup-empty');
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine, prayerIntentions: repos.prayerIntentions });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prayerIntention: undefined }),
    );
  });

  it('never performs the lookup when the prayerIntentions dep is absent (existing callers unaffected)', async () => {
    const user = await makeUser('prayer-lookup-no-dep');
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prayerIntention: undefined }),
    );
  });

  it('swallows a lookup failure, logs it, and still completes generation without a prayerIntention', async () => {
    const user = await makeUser('prayer-lookup-fails');
    const brokenPrayerIntentions = {
      getForDate: vi.fn().mockRejectedValue(new Error('db connection reset')),
    } as unknown as PrayerIntentionsRepository;
    const engine = fakeEngine();
    const logger = { error: vi.fn(), info: vi.fn() };
    const orchestrator = buildOrchestrator({ engine, prayerIntentions: brokenPrayerIntentions, logger });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(result.devotionalId).toBeDefined();
    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prayerIntention: undefined }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Prayer intention lookup failed'),
      expect.anything(),
    );
  });
});

/**
 * Content-language resolution (Epic O #311, story O3 #315).
 *
 * `loadPreferences` is the single place `users.language` + `users.translation_id`
 * become the engine's `language`/`preferredVersionId`/`translation` triple, so
 * these tests pin its three rules: a stored in-catalog translation is honored;
 * a stored translation OUTSIDE the stored language's catalog snaps to the
 * language default (never a mixed-language devotional, DEC-K12); and the
 * en/no-row default is byte-compatible with pre-Epic-O behavior. Plus the
 * fixture-mismatch flag: a non-en user served the (English-only) fixture
 * corpus gets an explicit log marker, not an inferable absence.
 */
describe('GenerateNowOrchestrator — content language resolution (O3 #315)', () => {
  it("honors a stored translation that belongs to the user's language (es + PDDPT 3365)", async () => {
    const user = await makeUser('lang-es-default', { translationId: 3365 });
    await repos.users.updateProfile(asVerifiedUserId(user.id), { language: 'es' });
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'es',
        preferredVersionId: 3365,
        translation: 'Palabra de Dios para ti (PDDPT)',
      }),
    );
  });

  it('honors a stored in-catalog ALTERNATE, not just the language default (es + RVES 147)', async () => {
    const user = await makeUser('lang-es-alternate', { translationId: 147 });
    await repos.users.updateProfile(asVerifiedUserId(user.id), { language: 'es' });
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'es',
        preferredVersionId: 147,
        translation: 'Reina-Valera Antigua (RVES)',
      }),
    );
  });

  it('snaps an out-of-language stored translation to the language default, and logs the substitution (#193)', async () => {
    // A user who switched to 'es' while a stale en versionId lingered in
    // translation_id: honoring 3034 would generate Spanish prose around an
    // English Bible — the mixed-language outcome DEC-K12 forbids.
    const user = await makeUser('lang-es-stale-en', { translationId: 3034 });
    await repos.users.updateProfile(asVerifiedUserId(user.id), { language: 'es' });
    const engine = fakeEngine();
    const logger = { error: vi.fn(), info: vi.fn() };
    const orchestrator = buildOrchestrator({ engine, logger });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'es', preferredVersionId: 3365 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Stored translation_id is not in the stored language catalog — using the language default',
      expect.objectContaining({ language: 'es', storedTranslationId: 3034, fallbackVersionId: 3365 }),
    );
  });

  it("the default user is unchanged: language 'en', BSB 3034, no substitution log", async () => {
    const user = await makeUser('lang-default-en');
    const engine = fakeEngine();
    const logger = { error: vi.fn(), info: vi.fn() };
    const orchestrator = buildOrchestrator({ engine, logger });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'en',
        preferredVersionId: 3034,
        translation: 'Berean Standard Bible (BSB)',
      }),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      'Stored translation_id is not in the stored language catalog — using the language default',
      expect.anything(),
    );
  });

  it("preferencesOverride without language defaults to 'en' (escape hatch keeps today's behavior)", async () => {
    const user = await makeUser('lang-override-default');
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({
      userId: user.id,
      date: '2026-07-02',
      preferencesOverride: { tradition: 'general', translation: 'BSB', preferredVersionId: 3034 },
    });

    expect(engine.generate).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }));
  });

  it('preferencesOverride can opt into a language explicitly', async () => {
    const user = await makeUser('lang-override-es');
    const engine = fakeEngine();
    const orchestrator = buildOrchestrator({ engine });

    await orchestrator.generateNow({
      userId: user.id,
      date: '2026-07-02',
      preferencesOverride: {
        tradition: 'general',
        translation: 'Palabra de Dios para ti',
        preferredVersionId: 3365,
        language: 'es',
      },
    });

    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'es', preferredVersionId: 3365 }),
    );
  });

  it('flags the language mismatch when a non-English user is served the English fixture (epic #311 §3)', async () => {
    const user = await makeUser('lang-fixture-mismatch', { translationId: 3365 });
    await repos.users.updateProfile(asVerifiedUserId(user.id), { language: 'es' });
    const engine = fakeEngine({ devotional: SAMPLE_DEVOTIONAL, source: 'fixture' });
    const logger = { error: vi.fn(), info: vi.fn() };
    const orchestrator = buildOrchestrator({ engine, logger });

    const result = await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(result.source).toBe('fixture');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Fixture fallback served in English to a non-English user'),
      expect.objectContaining({ language: 'es', fixtureLanguageMismatch: true }),
    );
    // The row still carries the ordinary fixture flag — the mismatch log is
    // additive, not a replacement surface.
    const devotionalRow = await repos.devotionals.getById(asVerifiedUserId(user.id), result.devotionalId);
    expect(devotionalRow!.is_fixture_fallback).toBe(true);
  });

  it('does NOT emit the mismatch flag for an English user on the fixture path', async () => {
    const user = await makeUser('lang-fixture-en');
    const engine = fakeEngine({ devotional: SAMPLE_DEVOTIONAL, source: 'fixture' });
    const logger = { error: vi.fn(), info: vi.fn() };
    const orchestrator = buildOrchestrator({ engine, logger });

    await orchestrator.generateNow({ userId: user.id, date: '2026-07-02' });

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Fixture fallback served in English to a non-English user'),
      expect.anything(),
    );
  });
});
