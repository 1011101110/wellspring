/**
 * Q2 (#332): `getStageView` — the READ-ONLY session lookup behind
 * GET /stage/:token. The load-bearing assertion here is structural: the
 * Stage lookup must NEVER call the sessions repository's write method
 * (`markJoined`), because the Attendee bot container loads the Stage URL
 * and a bot page-load counted as a join would silently corrupt Epic P's
 * attendance signals. The same suite pins that `getSessionView` STILL
 * writes — so a refactor that accidentally made both read-only (killing
 * real join metrics) fails here too, not just the reverse mutation.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TimingManifest } from '@kairos/shared-contracts';
import { SessionService } from '../../../src/services/session/sessionService.js';
import type { AudioStorage } from '../../../src/services/audio/audioStorage.js';
import type {
  DevotionalsRepository,
  SessionsRepository,
} from '../../../src/db/repositories/index.js';

const TOKEN = '00000000-0000-4000-8000-000000000001';
const FUTURE = new Date('2027-01-01T00:00:00Z');

const MANIFEST: TimingManifest = [
  { section: 'greeting', startSec: 0, endSec: 2, text: 'A moment of rest.' },
  { section: 'scripture', startSec: 2, endSec: 8, text: 'From Matthew 11:28. Come to me.' },
];

function fakeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    user_id: 'user-1',
    devotional_id: 'devo-1',
    expires_at: FUTURE,
    completed_at: null,
    joined_at: null,
    ...overrides,
  };
}

function fakeDevotionalRow() {
  return {
    id: 'devo-1',
    theme: 'Rest',
    format: 'short',
    verses: [
      {
        usfm: 'MAT.11.28',
        reference: 'Matthew 11:28',
        fetchedText: 'Come to me, all you who are weary.',
        attribution: 'Berean Standard Bible',
      },
    ],
    devotional_body: 'body',
    prayer: 'prayer',
    journaling_prompt: null,
    action_step: null,
    audio_object: 'devotionals/devo-1.mp3',
  };
}

function build(options: { manifest?: TimingManifest | null; manifestThrows?: boolean } = {}) {
  const sessions = {
    findByToken: vi.fn().mockResolvedValue(fakeSessionRow()),
    markJoined: vi.fn().mockResolvedValue(fakeSessionRow({ joined_at: new Date() })),
  } as unknown as SessionsRepository;
  const devotionals = {
    getById: vi.fn().mockResolvedValue(fakeDevotionalRow()),
  } as unknown as DevotionalsRepository;
  const audioStorage = {
    upload: vi.fn(),
    exists: vi.fn().mockResolvedValue(true),
    getSignedUrl: vi
      .fn()
      .mockResolvedValue({ url: 'https://storage.googleapis.com/b/devo-1.mp3?sig=x', expiresAt: FUTURE }),
    delete: vi.fn(),
    uploadManifest: vi.fn(),
    getManifest: options.manifestThrows
      ? vi.fn().mockRejectedValue(new Error('bucket sneezed'))
      : vi.fn().mockResolvedValue(options.manifest === undefined ? MANIFEST : options.manifest),
  } as unknown as AudioStorage;

  const service = new SessionService({
    sessions,
    devotionals,
    audioStorage,
    now: () => new Date('2026-07-23T12:00:00Z'),
  });
  return { service, sessions, audioStorage };
}

describe('getStageView (Q2 #332)', () => {
  it('STRUCTURAL NO-WRITE: never calls sessions.markJoined', async () => {
    const { service, sessions } = build();

    const result = await service.getStageView(TOKEN);

    expect(result.kind).toBe('ok');
    expect(sessions.markJoined).not.toHaveBeenCalled();
  });

  it('…while getSessionView on the SAME service still marks joined (join metrics stay alive)', async () => {
    const { service, sessions } = build();

    await service.getSessionView(TOKEN);

    expect(sessions.markJoined).toHaveBeenCalledTimes(1);
  });

  it('returns the same page data as the session view, plus the manifest', async () => {
    const { service } = build();

    const stage = await service.getStageView(TOKEN);
    const session = await service.getSessionView(TOKEN);

    if (stage.kind !== 'ok' || session.kind !== 'ok') throw new Error('expected ok results');
    expect(stage.page).toEqual(session.page);
    expect(stage.manifest).toEqual(MANIFEST);
  });

  it('collapses unknown and expired tokens to the identical not_found (enumeration safety)', async () => {
    const { service, sessions } = build();
    (sessions.findByToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const unknown = await service.getStageView(TOKEN);

    (sessions.findByToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakeSessionRow({ expires_at: new Date('2026-07-01T00:00:00Z') }),
    );
    const expired = await service.getStageView(TOKEN);

    expect(unknown).toEqual({ kind: 'not_found' });
    expect(expired).toEqual({ kind: 'not_found' });
    expect(sessions.markJoined).not.toHaveBeenCalled();
  });

  it('a missing manifest degrades to null, never an error', async () => {
    const { service } = build({ manifest: null });
    const result = await service.getStageView(TOKEN);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.manifest).toBeNull();
    expect(result.page.audioUrl).toContain('storage.googleapis.com');
  });

  it('a THROWING manifest read degrades to null too (no-captions posture)', async () => {
    const { service } = build({ manifestThrows: true });
    const result = await service.getStageView(TOKEN);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.manifest).toBeNull();
  });
});
