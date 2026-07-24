/**
 * U4 (#357) golden-params seam — the #326 idiom: a faked highlight signal →
 * the EXACT `highlightedReference` param the spied `DevotionalEngine.generate`
 * receives, through the real orchestrator.
 *
 * READ model (live-verified 2026-07-24): there is NO list-all endpoint, so the
 * orchestrator draws CANDIDATE passages from the user's recent devotional
 * verses and asks the bridge (`isPassageHighlighted`) which the user marked.
 *
 * Load-bearing assertions:
 *  - a marked recent passage is woven as `highlightedReference` (standard-slot,
 *    applyFeedbackSteering);
 *  - only-when-real: nothing marked → param absent, byte-identical to a run
 *    with no bridge wired at all (the regression pin);
 *  - precedence: inviteContext (higher rung) suppresses the highlight AND skips
 *    every per-passage lookup;
 *  - no-repeat: a marked passage shown within the no-repeat window is skipped
 *    for the next marked candidate;
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
import type { DevotionalOutput } from '@kairos/shared-contracts';

const NOW = new Date('2026-07-24T12:00:00Z');

// A recent (within 30d) date and an older (30–90d) date, relative to NOW.
const RECENT_DATE = '2026-07-10'; // 14 days ago — inside the no-repeat window
const OLDER_DATE = '2026-06-10'; // 44 days ago — a candidate, outside no-repeat

const DEVOTIONAL: DevotionalOutput = {
  format: 'standard',
  theme: 'Rest',
  verses: [{ usfm: 'MAT.11.28', versionId: 3034, fetchedText: 't', attribution: 'BSB' }],
  devotionalBody: 'Body.',
  cardSummary: 'Summary.',
  prayer: 'Prayer.',
};

interface CandidateDevotional {
  date: string;
  verses: Array<{ usfm: string; versionId: number }>;
}

function buildHarness(opts: {
  markedPassages?: string[];
  recentDevotionals?: CandidateDevotional[];
  withoutBridge?: boolean;
  readImpl?: () => Promise<boolean>;
} = {}) {
  const engineParams: GenerateDevotionalParams[] = [];
  const marked = new Set(opts.markedPassages ?? []);

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
    listForUserInRange: vi.fn().mockResolvedValue(opts.recentDevotionals ?? []),
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

  const isPassageHighlighted = vi
    .fn()
    .mockImplementation(
      opts.readImpl
        ? () => opts.readImpl!()
        : (_uid: string, _bibleId: number, passageId: string) => Promise.resolve(marked.has(passageId)),
    );
  const highlightsBridge: HighlightsReadBridge = { isPassageHighlighted };

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

  return { orchestrator, engineParams, isPassageHighlighted };
}

describe('U4 golden params — highlight weaving', () => {
  it('weaves a marked recent passage as `highlightedReference` (standard, applyFeedbackSteering)', async () => {
    const h = buildHarness({
      markedPassages: ['JHN.3.16'],
      recentDevotionals: [{ date: OLDER_DATE, verses: [{ usfm: 'JHN.3.16', versionId: 3034 }] }],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    expect(h.engineParams[0]!.highlightedReference).toBe('JHN.3.16');
  });

  it('only-when-real: nothing marked → param absent and byte-identical to no bridge wired', async () => {
    const woven = buildHarness({
      markedPassages: [],
      recentDevotionals: [{ date: OLDER_DATE, verses: [{ usfm: 'JHN.3.16', versionId: 3034 }] }],
    });
    await woven.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    const control = buildHarness({ withoutBridge: true });
    await control.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    expect(woven.engineParams[0]).toEqual(control.engineParams[0]);
    expect('highlightedReference' in woven.engineParams[0]!).toBe(false);
  });

  it('precedence: inviteContext (higher rung) suppresses the highlight and skips every lookup', async () => {
    const h = buildHarness({
      markedPassages: ['JHN.3.16'],
      recentDevotionals: [{ date: OLDER_DATE, verses: [{ usfm: 'JHN.3.16', versionId: 3034 }] }],
    });
    await h.orchestrator.generateNow({
      userId: 'user-1',
      applyFeedbackSteering: true,
      skipCalendar: true,
      inviteContext: 'Team standup — pray for focus',
    });
    expect(h.engineParams[0]!.highlightedReference).toBeUndefined();
    expect(h.engineParams[0]!.inviteContext).toBe('Team standup — pray for focus');
    expect(h.isPassageHighlighted).not.toHaveBeenCalled();
  });

  it('no-repeat: a marked passage shown within the no-repeat window is skipped for the next marked candidate', async () => {
    const h = buildHarness({
      markedPassages: ['JHN.3.16', 'PSA.23.1'],
      recentDevotionals: [
        // Oldest first (ASC), like the repo returns.
        { date: OLDER_DATE, verses: [{ usfm: 'PSA.23.1', versionId: 3034 }] },
        { date: RECENT_DATE, verses: [{ usfm: 'JHN.3.16', versionId: 3034 }] },
      ],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', applyFeedbackSteering: true, skipCalendar: true });
    // JHN.3.16 is marked but shown within the last 30d → held back; PSA.23.1 wins.
    expect(h.engineParams[0]!.highlightedReference).toBe('PSA.23.1');
  });

  it('generate-now shape (no applyFeedbackSteering) never consults the bridge', async () => {
    const h = buildHarness({
      markedPassages: ['JHN.3.16'],
      recentDevotionals: [{ date: OLDER_DATE, verses: [{ usfm: 'JHN.3.16', versionId: 3034 }] }],
    });
    await h.orchestrator.generateNow({ userId: 'user-1', skipCalendar: true });
    expect(h.isPassageHighlighted).not.toHaveBeenCalled();
    expect(h.engineParams[0]!.highlightedReference).toBeUndefined();
  });

  it('fail-open: a read explosion still generates, unwoven', async () => {
    const h = buildHarness({
      recentDevotionals: [{ date: OLDER_DATE, verses: [{ usfm: 'JHN.3.16', versionId: 3034 }] }],
      readImpl: () => Promise.reject(new Error('yv read down (test)')),
    });
    const result = await h.orchestrator.generateNow({
      userId: 'user-1',
      applyFeedbackSteering: true,
      skipCalendar: true,
    });
    expect(result.devotionalId).toBe('devo-1');
    expect(h.engineParams[0]!.highlightedReference).toBeUndefined();
  });
});
