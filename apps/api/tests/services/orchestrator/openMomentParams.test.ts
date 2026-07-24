/**
 * Open Moment orchestrator golden-params (EPIC V #360 / V4 #365) — fake
 * repositories, no Postgres (the feedbackSteeringParams / preferenceTraceability
 * harness precedent). Asserts the flag threading:
 *  - enabled → the OpenMomentContext is persisted on the devotional AND the
 *    invitation flag reaches TtsService.synthesize;
 *  - distress NEVER enables it (mutation-checked against the pure resolver);
 *  - a fixture-fallback generation NEVER enables it (pinned);
 *  - default (flag off) persists null.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GenerateNowOrchestrator,
  resolveOpenMomentEnabled,
} from '../../../src/services/orchestrator/generateNowOrchestrator.js';
import type {
  DailyBandsRepository,
  DevotionalsRepository,
  PreferencesRepository,
  SessionsRepository,
  UsersRepository,
} from '../../../src/db/repositories/index.js';
import type { DevotionalEngine } from '../../../src/services/devotionalEngine.js';
import type { TtsService } from '../../../src/services/tts/ttsService.js';
import type { AudioStorage } from '../../../src/services/audio/audioStorage.js';
import type { DevotionalOutput } from '@kairos/shared-contracts';

const NOW = new Date('2026-07-24T12:00:00Z');

const DEVOTIONAL: DevotionalOutput = {
  format: 'standard',
  theme: 'Rest for the weary',
  verses: [
    {
      usfm: 'MAT.11.28',
      versionId: 3034,
      reference: 'Matthew 11:28',
      fetchedText: 'Come to Me...',
      attribution: 'BSB',
    },
  ],
  devotionalBody: 'Body.',
  cardSummary: 'Summary.',
  prayer: 'Prayer.',
};

function buildHarness(opts: { source?: 'gloo' | 'fixture'; distressSignal?: boolean } = {}) {
  const createCalls: Array<Record<string, unknown>> = [];
  const synthesizeArgs: unknown[][] = [];

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

  const preferences = {
    get: vi.fn().mockResolvedValue({
      voice: 'en-US-Chirp3-HD-Achernar',
      stillness: 'off',
      lectio: false,
      liturgical_seasons_enabled: false,
      duration_preference: null,
      calendar_enabled: true,
      health_enabled: true,
      communication_enabled: true,
      examen_enabled: false,
    }),
  } as unknown as PreferencesRepository;

  const dailyBands = {
    getForDate: vi
      .fn()
      .mockResolvedValue(
        opts.distressSignal
          ? {
              recovery: 'moderate',
              sleep_quality: 'fair',
              activity: 'moderate',
              busyness: 'moderate',
              communication_load: null,
              distress_signal: true,
            }
          : null,
      ),
  } as unknown as DailyBandsRepository;

  const devotionals = {
    getForDate: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation((_uid: string, input: Record<string, unknown>) => {
      createCalls.push(input);
      return Promise.resolve({ id: 'devo-1', ...input });
    }),
    setAudioObject: vi.fn().mockResolvedValue(undefined),
    listRecentThemes: vi.fn().mockResolvedValue([]),
  } as unknown as DevotionalsRepository;

  const sessions = {
    create: vi.fn().mockResolvedValue({ id: 'sess-1', token: 'tok-1' }),
    updateExpiry: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionsRepository;

  const devotionalEngine = {
    generate: vi.fn().mockResolvedValue({ devotional: DEVOTIONAL, source: opts.source ?? 'gloo' }),
  } as unknown as DevotionalEngine;

  const ttsService = {
    synthesize: vi.fn().mockImplementation((...args: unknown[]) => {
      synthesizeArgs.push(args);
      return Promise.resolve({
        audio: Buffer.from('mp3'),
        segmentCount: 1,
        charCount: 10,
        voiceName: 'x',
        manifest: [],
      });
    }),
  } as unknown as TtsService;

  const audioStorage = {
    upload: vi.fn().mockResolvedValue({ objectKey: 'devotionals/devo-1.mp3' }),
    uploadManifest: vi
      .fn()
      .mockResolvedValue({ objectKey: 'devotionals/devo-1.mp3.manifest.json' }),
  } as unknown as AudioStorage;

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
    now: () => NOW,
    logger: { info: vi.fn(), error: vi.fn() },
  });

  return { orchestrator, createCalls, synthesizeArgs };
}

describe('resolveOpenMomentEnabled (pure, mutation-checked)', () => {
  it('honors the requested flag when there is no distress', () => {
    expect(resolveOpenMomentEnabled(true, false)).toBe(true);
    expect(resolveOpenMomentEnabled(false, false)).toBe(false);
  });

  it('distress NEVER enables it, even when requested (the hard rule)', () => {
    expect(resolveOpenMomentEnabled(true, true)).toBe(false);
    // MUTATION CHECK: the ONLY way distress+requested yields true is deleting
    // the distress guard — this asserts it is present.
    expect(resolveOpenMomentEnabled(true, true)).not.toBe(true);
  });
});

describe('generateNow — open moment threading', () => {
  it('enabled + non-distress + non-fixture → persists the OpenMomentContext and passes the invitation flag to TTS', async () => {
    const { orchestrator, createCalls, synthesizeArgs } = buildHarness();
    await orchestrator.generateNow({
      userId: 'user-1',
      skipCalendar: true,
      openMomentEnabled: true,
    });

    const ctx = createCalls[0]?.openMoment as Record<string, unknown> | null;
    expect(ctx).not.toBeNull();
    expect(ctx).toMatchObject({ language: 'en', tradition: 'general', preferredVersionId: 3034 });
    // translation is the human-readable display label the model frames prose with.
    expect(ctx?.translation).toContain('BSB');
    expect(ctx?.voiceName).toBeTruthy();
    // TtsService.synthesize's 6th positional arg is openMomentEnabled.
    expect(synthesizeArgs[0]?.[5]).toBe(true);
  });

  it('default (flag off) → persists null and no invitation', async () => {
    const { orchestrator, createCalls, synthesizeArgs } = buildHarness();
    await orchestrator.generateNow({ userId: 'user-1', skipCalendar: true });
    expect(createCalls[0]?.openMoment).toBeNull();
    expect(synthesizeArgs[0]?.[5]).toBe(false);
  });

  it('distress NEVER gets an open moment even when requested', async () => {
    const { orchestrator, createCalls, synthesizeArgs } = buildHarness();
    await orchestrator.generateNow({
      userId: 'user-1',
      skipCalendar: true,
      openMomentEnabled: true,
      distressSignalOverride: true,
    });
    expect(createCalls[0]?.openMoment).toBeNull();
    expect(synthesizeArgs[0]?.[5]).toBe(false);
  });

  it('PIN: a fixture-fallback generation never gets an open moment (no live engine)', async () => {
    const { orchestrator, createCalls, synthesizeArgs } = buildHarness({ source: 'fixture' });
    await orchestrator.generateNow({
      userId: 'user-1',
      skipCalendar: true,
      openMomentEnabled: true,
    });
    expect(createCalls[0]?.openMoment).toBeNull();
    expect(synthesizeArgs[0]?.[5]).toBe(false);
  });
});
