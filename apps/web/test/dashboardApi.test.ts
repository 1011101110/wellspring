/**
 * The two API behaviours Epic L most depends on getting right:
 *
 *  - a second same-day "+" press is a SUCCESS that opens the existing
 *    devotional (#238), never an error;
 *  - purged audio is a terminal, expected state (#241), never a retry
 *    loop against a file that is not coming back.
 *
 * `apiFetch` is stubbed rather than the network, so these assert this
 * client's handling of a real server response shape — the shapes were read
 * off the handlers in `apps/api/src/routes/`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The client module is replaced wholesale rather than spied on, because
 * importing the real one pulls in `config.ts`, which throws without a
 * Firebase API key in the environment. These tests are about response
 * handling and have nothing to say about Firebase.
 *
 * `vi.hoisted` is required: `vi.mock` is hoisted above the imports, so a
 * plain `const apiFetch = vi.fn()` would not exist yet when the factory
 * runs.
 */
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../src/api/client', () => {
  // The double of the real `ApiError`. Because the modules under test
  // import `ApiError` from this same mocked path, this class is the one
  // their `instanceof` checks compare against — so the 404 branches are
  // genuinely exercised.
  class ApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError, apiFetch };
});

const { generateNow } = await import('../src/api/dashboard');
const { getDevotionalAudio, searchDevotionals } = await import('../src/api/devotionals');
const { ApiError } = await import('../src/api/client');
const { describeGenerateOutcome } = await import('../src/lib/generateNow');

beforeEach(() => {
  apiFetch.mockReset();
});

describe('generateNow', () => {
  it('sends mode "now" so the "+" cannot reach the distress path (#238)', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      sessionUrl: 'https://example.test/s/tok',
      devotionalId: 'dev-1',
      alreadyExisted: false,
      data: { sessionToken: 'tok', source: 'gloo', audio: null, devotional: null },
    });

    await generateNow();

    // The request schema *defaults* to 'distress', so omitting the mode
    // would hand a routine press an elevated-care micro devotional.
    expect(apiFetch).toHaveBeenCalledWith('/v1/devotional/generate-now', {
      method: 'POST',
      body: { mode: 'now' },
    });
  });

  it('parses a fresh generation', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      sessionUrl: 'https://example.test/s/tok',
      devotionalId: 'dev-1',
      alreadyExisted: false,
      data: {
        sessionToken: 'tok',
        source: 'gloo',
        audio: { objectName: 'a.mp3' },
        devotional: { format: 'short', theme: 'Rest', cardSummary: 'A summary.' },
      },
    });

    const outcome = describeGenerateOutcome(await generateNow());
    expect(outcome).toEqual({ devotionalId: 'dev-1', existing: false, note: null });
  });

  it('treats a second same-day press as a success that opens the existing devotional', async () => {
    // The exact already-existed body: ok:true, null source/audio (no
    // generation happened on this request), and the existing session.
    apiFetch.mockResolvedValue({
      ok: true,
      sessionUrl: 'https://example.test/s/existing',
      devotionalId: 'dev-existing',
      alreadyExisted: true,
      data: {
        sessionToken: 'existing',
        source: null,
        audio: null,
        devotional: { format: 'short', theme: 'Rest', cardSummary: 'A summary.' },
      },
    });

    const outcome = describeGenerateOutcome(await generateNow());

    expect(outcome.existing).toBe(true);
    expect(outcome.devotionalId).toBe('dev-existing');
    // Honest copy, and emphatically not an error.
    expect(outcome.note).toBeTruthy();
    expect(outcome.note).not.toMatch(/error|failed|sorry|could not|couldn/i);
  });

  it('still opens the session when the server could not re-read the devotional summary', async () => {
    // The handler logs and continues if that read fails, because a failed
    // lookup must not turn a success into an error.
    apiFetch.mockResolvedValue({
      ok: true,
      sessionUrl: 'https://example.test/s/existing',
      devotionalId: 'dev-existing',
      alreadyExisted: true,
      data: { sessionToken: 'existing', source: null, audio: null, devotional: null },
    });

    const outcome = describeGenerateOutcome(await generateNow());
    expect(outcome.devotionalId).toBe('dev-existing');
    expect(outcome.existing).toBe(true);
  });

  it('rejects a response shape it does not understand rather than returning undefined', async () => {
    apiFetch.mockResolvedValue({ ok: true, devotionalId: 'dev-1' });
    await expect(generateNow()).rejects.toThrow(/shape/i);
  });
});

describe('getDevotionalAudio', () => {
  it('returns a fresh signed url for playable audio', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: { url: 'https://storage.test/signed', expiresAt: '2026-07-20T12:15:00+00:00' },
    });

    const audio = await getDevotionalAudio('dev-1');
    expect(audio?.url).toBe('https://storage.test/signed');
    expect(apiFetch).toHaveBeenCalledWith('/v1/devotionals/dev-1/audio');
  });

  it('returns null — not a throw — when the audio has been purged (#82)', async () => {
    apiFetch.mockRejectedValue(new ApiError(404, 'not found', 'AUDIO_UNAVAILABLE'));

    // null is "render the transcript and say the audio is gone", which is
    // what keeps this from becoming a dead player or a pointless retry.
    await expect(getDevotionalAudio('dev-1')).resolves.toBeNull();
  });

  it('treats a 404 with no readable envelope as unavailable too', async () => {
    apiFetch.mockRejectedValue(new ApiError(404, 'not found'));
    await expect(getDevotionalAudio('dev-1')).resolves.toBeNull();
  });

  it('still throws on a real failure, which is a different state from purged', async () => {
    apiFetch.mockRejectedValue(new ApiError(0, 'network down'));
    await expect(getDevotionalAudio('dev-1')).rejects.toThrow();
  });

  it('url-encodes the id', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: { url: 'https://storage.test/signed', expiresAt: '2026-07-20T12:15:00+00:00' },
    });
    await getDevotionalAudio('a/b');
    expect(apiFetch).toHaveBeenCalledWith('/v1/devotionals/a%2Fb/audio');
  });
});

describe('searchDevotionals (L6 #242 — endpoint not yet merged)', () => {
  it('returns null when the route does not exist, so the control can be hidden', async () => {
    apiFetch.mockRejectedValue(new ApiError(404, 'not found'));
    await expect(searchDevotionals('rest')).resolves.toBeNull();
  });

  it('parses results as the same DevotionalCard shape the archive uses', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'dev-1',
          date: '2026-07-20',
          theme: 'Rest',
          cardSummary: 'A summary.',
          format: 'short',
          createdAt: '2026-07-20T12:00:00Z',
          completedAt: null,
        },
      ],
      nextCursor: null,
    });

    const result = await searchDevotionals('rest');
    expect(result?.data[0]?.theme).toBe('Rest');
  });
});
