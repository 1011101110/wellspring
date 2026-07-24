/**
 * U4 (#357) golden-params seam — the #326 idiom: a faked highlight signal →
 * the EXACT `highlightedReference` param the spied `DevotionalEngine.generate`
 * receives, through the real orchestrator.
 *
 * Load-bearing assertions:
 *  - a real highlight is woven as `highlightedReference` (standard-slot,
 *    applyFeedbackSteering);
 *  - only-when-real: no highlights → param absent, byte-identical to a run
 *    with no bridge wired at all (the regression pin);
 *  - precedence: inviteContext (higher rung) suppresses the highlight;
 *  - no-repeat: a passage already in the recent devotionals is skipped;
 *  - generate-now shape (no applyFeedbackSteering) never consults the bridge;
 *  - fail-open: a read explosion still generates, unwoven.
 */
import { describe, expect, it, vi } from 'vitest';
import { GenerateNowOrchestrator } from '../../../src/services/orchestrator/generateNowOrchestrator.js';
import type {
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
import type { HighlightsReadBridge } from '../../../src/services/orchestrator/generateNowOrchestrator.js';
import type { NormalizedHighlight } from '../../../src/services/youversion/youVersionHighlightsClient.js';
import type { DevotionalOutput } from '@kairos/shared-contracts';

const NOW = new Date('2026-07-24T12:00:00Z');

const DEVOTIONAL: DevotionalOutput = {
  format: 'standard',
  theme: 'Rest',
  verses: [{ usfm: 'MAT.11.28', versionId: 3034, fetchedText: 't', attribution: 'BSB' }],
  devotionalBody: 'Body.',
  cardSummary: 'Summary.',
  prayer: 'Prayer.',
};

function buildHarness(opts: {
  highlights?: NormalizedHighlight[];
  recentRangeDevotionals?: Array<{ verses: Array<{ usfm: string }> }>;
  withoutBridge?: boolean;
  readImpl?: () => Promise<NormalizedHighlight[]>;
} = {}) {
  const engineParams: GenerateDevotionalParams[] = [];

  const users = {
    findById: vi.fn().mockResolvedValue({
      id: 'user-1',
      tradition: 'general',
      translation_id: 3034,
      language: 'en',
      timezone: 'UTC',
    }),
  } as unknown as UsersRepository;
  const preferences = { get: vi.fn().mockResolvedValue(null) } as unknown as PreferencesRepository;
  const dailyBands = { getForDate: vi.fn().mockResolvedValue(null) } as unknown as DailyBandsRepository;
  const devotionals = {
    getForDate: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockImplementation((_uid: string, input: Record<string, unknown>) =>
        Promise.resolve({ id: 'devo-1', ...input }),
      ),
    setAudioObject: vi.fn().mockResolvedValue(undefined),
    listForUserInRange: vi.fn().mockResolvedValue(opts.recentRangeDevotionals ?? []),
  } as unknown as DevotionalsRepository;
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
    synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from('mp3'), segmentCount: 1, charCount: 1, voiceName: 'x' }),
  } as unknown as TtsService;
  const audioStorage = {
    upload: vi.fn().mockResolvedValue({ objectKey: 'devotionals/devo-1.mp3' }),
    uploadManifest: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioStorage;

  const readRecentHighlights = vi
    .fn()
    .mockImplementation(opts.readImpl ?? (() => Promise.resolve(opts.highlights ?? [])));
  const highlightsBridge: HighlightsReadBridge = { readRecentHighlights };

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
    ...(opts.withoutBridge ? {} : { highlightsBridge }),
  });

  return { orchestrator, engineParams, readRecentHighlights };
}

const HL = (passageId: string, createdAt?: string): NormalizedHighlight => ({
  passageId,
  bibleId: 3034,
  ...(createdAt ? { createdAt } : {}),
});

describe('U4 golden params — highlight weaving', () => {
  it('weaves a real highlight as `highlightedReference` (standard, applyFeedbackSteering)', async () => {
    const h = buildHarness({ highlights: [HL('JHN.3.16', '2026-07-23T00:00:00Z')] });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    expect(h.engineParams[0]!.highlightedReference).toBe('JHN.3.16');
  });

  it('only-when-real: no highlights → param absent and byte-identical to no bridge wired', async () => {
    const woven = buildHarness({ highlights: [] });
    await woven.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    const control = buildHarness({ withoutBridge: true });
    await control.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    expect(woven.engineParams[0]).toEqual(control.engineParams[0]);
    expect('highlightedReference' in woven.engineParams[0]!).toBe(false);
  });

  it('precedence: inviteContext (higher rung) suppresses the highlight', async () => {
    const h = buildHarness({ highlights: [HL('JHN.3.16')] });
    await h.orchestrator.generateNow({
      userId: 'user-1',
      applyFeedbackSteering: true,
      skipCalendar: true,
      inviteContext: 'Team standup — pray for focus',
    });
    expect(h.engineParams[0]!.highlightedReference).toBeUndefined();
    expect(h.engineParams[0]!.inviteContext).toBe('Team standup — pray for focus');
  });

  it('no-repeat: a passage already in the recent devotionals is skipped for the next candidate', async () => {
    const h = buildHarness({
      highlights: [HL('JHN.3.16', '2026-07-23T00:00:00Z'), HL('PSA.23.1', '2026-07-20T00:00:00Z')],
      recentRangeDevotionals: [{ verses: [{ usfm: 'JHN.3.16' }] }],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    expect(h.engineParams[0]!.highlightedReference).toBe('PSA.23.1');
  });

  it('generate-now shape (no applyFeedbackSteering) never consults the bridge', async () => {
    const h = buildHarness({ highlights: [HL('JHN.3.16')] });
    await h.orchestrator.generateNow({ userId: 'user-1', skipCalendar: true });
    expect(h.readRecentHighlights).not.toHaveBeenCalled();
    expect(h.engineParams[0]!.highlightedReference).toBeUndefined();
  });

  it('fail-open: a read explosion still generates, unwoven', async () => {
    const h = buildHarness({ readImpl: () => Promise.reject(new Error('yv read down (test)')) });
    const result = await h.orchestrator.generateNow({
      userId: 'user-1',
      applyFeedbackSteering: true,
      skipCalendar: true,
    });
    expect(result.devotionalId).toBe('devo-1');
    expect(h.engineParams[0]!.highlightedReference).toBeUndefined();
  });
});
