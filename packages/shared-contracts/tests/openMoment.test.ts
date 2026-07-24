import { describe, expect, it } from 'vitest';
import {
  LiveResponseSchema,
  OpenMomentResponseEnvelopeSchema,
  OpenMomentRequestBodySchema,
  OpenMomentContextSchema,
  OpenMomentStoredResponseSchema,
  LIVE_ACKNOWLEDGMENT_MAX_LENGTH,
  LIVE_FRAMING_MAX_LENGTH,
  StageSectionSchema,
  STAGE_SECTIONS,
  TimingManifestSchema,
} from '../src/index.js';

const VALID_LIVE_RESPONSE = {
  acknowledgment: 'I hear the weight in what you carried into this hour.',
  verse: {
    usfm: 'MAT.11.28',
    versionId: 3034,
    reference: 'Matthew 11:28',
    fetchedText: 'Come to Me, all you who labor and are heavy-laden, and I will give you rest.',
    attribution: 'Berean Standard Bible (BSB). Public domain.',
  },
  framing: 'Let that invitation be the last word before we pray.',
};

describe('LiveResponse contract (EPIC V #360 / V2 #363)', () => {
  it('round-trips a valid response', () => {
    const parsed = LiveResponseSchema.parse(VALID_LIVE_RESPONSE);
    expect(parsed.verse.reference).toBe('Matthew 11:28');
  });

  it('rejects an acknowledgment over the length cap', () => {
    const tooLong = {
      ...VALID_LIVE_RESPONSE,
      acknowledgment: 'a'.repeat(LIVE_ACKNOWLEDGMENT_MAX_LENGTH + 1),
    };
    expect(LiveResponseSchema.safeParse(tooLong).success).toBe(false);
  });

  it('rejects a framing over the length cap', () => {
    const tooLong = { ...VALID_LIVE_RESPONSE, framing: 'a'.repeat(LIVE_FRAMING_MAX_LENGTH + 1) };
    expect(LiveResponseSchema.safeParse(tooLong).success).toBe(false);
  });

  it('is strict — extra fields fail (unvalidated content can never reach TTS)', () => {
    const extra = { ...VALID_LIVE_RESPONSE, followUpQuestion: 'And how did that feel?' };
    expect(LiveResponseSchema.safeParse(extra).success).toBe(false);
  });

  it('requires a non-empty fetchedText and reference on the verse', () => {
    const emptyText = {
      ...VALID_LIVE_RESPONSE,
      verse: { ...VALID_LIVE_RESPONSE.verse, fetchedText: '' },
    };
    expect(LiveResponseSchema.safeParse(emptyText).success).toBe(false);
  });
});

describe('OpenMomentResponseEnvelope contract', () => {
  it('round-trips a response envelope', () => {
    const env = OpenMomentResponseEnvelopeSchema.parse({
      outcome: 'response',
      audioUrl: 'https://storage.example.com/open-moment-abc.mp3?sig=x',
      verse: {
        reference: 'Matthew 11:28',
        fetchedText: 'Come to Me...',
        attribution: 'BSB',
      },
      durations: { acknowledgmentSec: 2.1, verseSec: 6.4, framingSec: 3.0, totalSec: 11.5 },
      distressFlagged: false,
    });
    expect(env.outcome).toBe('response');
  });

  it('round-trips a silence envelope', () => {
    const env = OpenMomentResponseEnvelopeSchema.parse({
      outcome: 'silence',
      distressFlagged: false,
    });
    expect(env.outcome).toBe('silence');
    expect(env.audioUrl).toBeUndefined();
  });

  it('rejects an unknown outcome', () => {
    expect(OpenMomentResponseEnvelopeSchema.safeParse({ outcome: 'chat' }).success).toBe(false);
  });
});

describe('OpenMomentRequestBody contract', () => {
  it('accepts an empty transcript (the honored-silence path is a valid request)', () => {
    expect(OpenMomentRequestBodySchema.safeParse({ transcript: '' }).success).toBe(true);
  });

  it('is strict — no extra fields', () => {
    expect(
      OpenMomentRequestBodySchema.safeParse({ transcript: 'hi', audioBlob: 'x' }).success,
    ).toBe(false);
  });
});

describe('OpenMomentContext + stored-response contracts', () => {
  it('round-trips a context', () => {
    const ctx = OpenMomentContextSchema.parse({
      language: 'es',
      tradition: 'catholic',
      translation: 'RVR1960',
      preferredVersionId: 149,
      voiceName: 'es-US-Chirp3-HD-Achernar',
    });
    expect(ctx.language).toBe('es');
  });

  it('round-trips a stored response and never carries a transcript field (privacy §5)', () => {
    const stored = OpenMomentStoredResponseSchema.parse({
      outcome: 'response',
      distressFlagged: true,
      audioId: 'open-moment-tok',
      verse: { reference: 'PS.34.18', fetchedText: 'The LORD is near...', attribution: 'BSB' },
      durations: { acknowledgmentSec: 1, verseSec: 2, framingSec: 1, totalSec: 4 },
    });
    expect(stored.audioId).toBe('open-moment-tok');
    // A stored payload with a transcript is rejected by .strict() — the schema
    // makes persisting the transcript unrepresentable.
    expect(
      OpenMomentStoredResponseSchema.safeParse({
        outcome: 'silence',
        distressFlagged: false,
        transcript: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('timing manifest open_moment marker (V4 #365)', () => {
  it('adds open_moment to STAGE_SECTIONS additively', () => {
    expect(STAGE_SECTIONS).toContain('open_moment');
    // The pre-existing five stay present (additive — existing manifests unchanged).
    for (const s of ['greeting', 'scripture', 'stillness', 'reflection', 'prayer']) {
      expect(STAGE_SECTIONS).toContain(s);
    }
  });

  it('round-trips a manifest carrying an open_moment marker with valid bounds', () => {
    const manifest = TimingManifestSchema.parse([
      { section: 'reflection', startSec: 0, endSec: 30, text: 'the question' },
      {
        section: 'open_moment',
        startSec: 30,
        endSec: 34,
        text: 'If you would like, speak what you are carrying.',
      },
      { section: 'prayer', startSec: 34, endSec: 45, text: 'Let us pray.' },
    ]);
    expect(manifest[1]?.section).toBe('open_moment');
    // Contiguity: prayer resumes exactly where the open_moment marker ends.
    expect(manifest[1]?.endSec).toBe(manifest[2]?.startSec);
  });

  it('accepts open_moment as a StageSection', () => {
    expect(StageSectionSchema.safeParse('open_moment').success).toBe(true);
  });
});
