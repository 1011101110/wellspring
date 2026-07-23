import { describe, expect, it, vi } from 'vitest';
import { VOICE_CATALOG, VOICE_LABELS, type DevotionalOutput } from '@kairos/shared-contracts';
import {
  TtsService,
  TtsServiceError,
  type TtsClientLike,
} from '../../../src/services/tts/ttsService.js';

const devotional: DevotionalOutput = {
  format: 'micro',
  theme: 'peace',
  verses: [
    {
      usfm: 'PHP.4.6-7',
      versionId: 3034,
      reference: 'Philippians 4:6-7',
      fetchedText: 'Do not be anxious about anything.',
      attribution: 'Berean Standard Bible (BSB). Public domain.',
    },
  ],
  devotionalBody: 'A short steady word for a short steady day.',
  cardSummary: 'Peace for today.',
  prayer: 'Father, thank You. Amen.',
};

function fakeClient(audioContent: Buffer | null = Buffer.from('fake-mp3-bytes')): TtsClientLike {
  return {
    synthesizeSpeech: vi.fn().mockResolvedValue([{ audioContent }]),
  };
}

/**
 * Maps each fake per-segment MP3 buffer to PCM of a known byte length so
 * manifest duration math is deterministic without spawning ffmpeg
 * (durationsSec[i] applies to the i-th synthesized segment, matched by
 * buffer content `seg{i+1}`). 16000 Hz mono s16le: bytes = sec × 16000 × 2.
 */
function fakeDecoder(durationsSec: number[]) {
  return async (mp3: Buffer, options?: { sampleRate?: number }) => {
    const rate = options?.sampleRate ?? 16_000;
    const index = Number(mp3.toString('utf8').replace('seg', '')) - 1;
    const sec = durationsSec[index];
    if (sec === undefined) throw new Error(`no fixture duration for segment ${index}`);
    return Buffer.alloc(Math.round(sec * rate * 2));
  };
}

/** Fake client emitting `seg1`, `seg2`, … per call, so buffer order is observable. */
function sequenceClient(): TtsClientLike {
  let call = 0;
  return {
    synthesizeSpeech: vi.fn().mockImplementation(async () => {
      call += 1;
      return [{ audioContent: Buffer.from(`seg${call}`) }];
    }),
  };
}

describe('TtsService', () => {
  it('synthesizes one segment per section (Q1 #331) and returns concatenated audio + charCount', async () => {
    const client = fakeClient(Buffer.from('abc'));
    const service = new TtsService({ client });

    const result = await service.synthesize(devotional);

    // micro fixture: greeting, scripture, reflection, prayer, scripture recap.
    expect(result.segmentCount).toBe(5);
    expect(result.audio.equals(Buffer.concat(Array.from({ length: 5 }, () => Buffer.from('abc'))))).toBe(
      true,
    );
    expect(result.charCount).toBeGreaterThan(0);
    expect(result.voiceName).toBe('en-US-Chirp3-HD-Achernar');
  });

  it('passes the configured voice, language, and gentle speaking rate to the client', async () => {
    const client = fakeClient();
    const service = new TtsService({
      client,
      voiceName: 'en-US-Chirp3-HD-Charon',
      speakingRate: 0.95,
    });

    await service.synthesize(devotional);

    expect(client.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Charon' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95 },
      }),
    );
  });

  it('defaults speakingRate to 0.95 per API spec §6 gentle pacing', async () => {
    const client = fakeClient();
    const service = new TtsService({ client });
    await service.synthesize(devotional);
    const call = (client.synthesizeSpeech as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.audioConfig.speakingRate).toBe(0.95);
  });

  it('splits into multiple segments and concatenates audio buffers for a long script', async () => {
    const longBody = Array.from(
      { length: 300 },
      (_, i) => `Sentence number ${i} about steady grace today.`,
    ).join(' ');
    const extended: DevotionalOutput = {
      ...devotional,
      format: 'extended',
      devotionalBody: longBody,
    };

    let call = 0;
    const client: TtsClientLike = {
      synthesizeSpeech: vi.fn().mockImplementation(async () => {
        call += 1;
        return [{ audioContent: Buffer.from(`seg${call}`) }];
      }),
    };
    const service = new TtsService({ client, maxSegmentBytes: 500 });

    const result = await service.synthesize(extended);

    expect(result.segmentCount).toBeGreaterThan(1);
    expect(client.synthesizeSpeech).toHaveBeenCalledTimes(result.segmentCount);
    // Concatenated buffer should be the literal concatenation of each segment's fake bytes, in order.
    const expected = Buffer.concat(
      Array.from({ length: result.segmentCount }, (_, i) => Buffer.from(`seg${i + 1}`)),
    );
    expect(result.audio.equals(expected)).toBe(true);
  });

  it('wraps a client rejection in TtsServiceError (AUDIO_UNAVAILABLE) instead of throwing raw', async () => {
    const client: TtsClientLike = {
      synthesizeSpeech: vi.fn().mockRejectedValue(new Error('permission denied')),
    };
    const service = new TtsService({ client });

    await expect(service.synthesize(devotional)).rejects.toBeInstanceOf(TtsServiceError);
    await expect(service.synthesize(devotional)).rejects.toThrow(/Cloud TTS synthesis failed/);
  });

  it('treats an empty audioContent response as a failure (AUDIO_UNAVAILABLE)', async () => {
    const client = fakeClient(Buffer.alloc(0));
    const service = new TtsService({ client });

    await expect(service.synthesize(devotional)).rejects.toBeInstanceOf(TtsServiceError);
  });

  it('defaults stillness to off — no hand-off/silence text sent to Cloud TTS', async () => {
    const client = fakeClient();
    const service = new TtsService({ client });
    await service.synthesize(devotional);
    const call = (client.synthesizeSpeech as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.input.ssml).not.toContain("Let's sit with this");
  });

  it('threads a non-off stillness preference into the SSML sent to Cloud TTS (docs/14 §5.2)', async () => {
    const client = fakeClient();
    const service = new TtsService({ client });
    await service.synthesize(devotional, 'brief');
    const allSsml = (client.synthesizeSpeech as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0].input.ssml)
      .join('');
    expect(allSsml).toContain("Let's sit with this — I'll keep the time.");
    expect(allSsml).toContain('still here.');
  });

  /* ---------------------------------------------------------------- *
   * Per-request voice — issue #202. Before this, the voice came only from
   * the constructor, so `preferences.voice` had no path to Cloud TTS and
   * every user heard the deployment default.
   * ---------------------------------------------------------------- */

  function voiceSentToClient(client: TtsClientLike): string {
    return (client.synthesizeSpeech as ReturnType<typeof vi.fn>).mock.calls[0][0].voice.name;
  }

  it('a per-request voice overrides the constructor voice in the Cloud TTS request', async () => {
    const client = fakeClient();
    const service = new TtsService({ client, voiceName: 'en-US-Chirp3-HD-Achernar' });

    const result = await service.synthesize(devotional, 'off', false, 'en-US-Chirp3-HD-Kore');

    // The request that actually leaves the process carries the per-request
    // voice, not the constructor's — the output differs, not just the arg.
    expect(voiceSentToClient(client)).toBe('en-US-Chirp3-HD-Kore');
    expect(result.voiceName).toBe('en-US-Chirp3-HD-Kore');
  });

  it('two different per-request voices produce two different Cloud TTS requests', async () => {
    const calmClient = fakeClient();
    const brightClient = fakeClient();
    await new TtsService({ client: calmClient }).synthesize(devotional, 'off', false, 'calm');
    await new TtsService({ client: brightClient }).synthesize(devotional, 'off', false, 'bright');

    expect(voiceSentToClient(calmClient)).not.toBe(voiceSentToClient(brightClient));
  });

  it('resolves a picker label to a real voice id before it reaches Cloud TTS', async () => {
    // iOS stores `warm`/`calm`/`bright` (VoiceChoice), which are NOT valid
    // Cloud TTS voice names — sending one verbatim would be rejected. See
    // packages/shared-contracts/src/voice.ts.
    const client = fakeClient();
    await new TtsService({ client }).synthesize(devotional, 'off', false, 'calm');

    expect(voiceSentToClient(client)).toBe(VOICE_CATALOG.calm);
    expect(VOICE_LABELS).toContain('calm');
  });

  it('falls back to the configured voice on an unrecognized name instead of failing', async () => {
    // #202 acceptance: a bad or stale voice name must cost the user their
    // voice choice, never their audio.
    const client = fakeClient(Buffer.from('abc'));
    const service = new TtsService({ client, voiceName: 'en-US-Chirp3-HD-Achernar' });

    const result = await service.synthesize(devotional, 'off', false, 'not-a-real-voice');

    expect(voiceSentToClient(client)).toBe('en-US-Chirp3-HD-Achernar');
    expect(result.audio.equals(Buffer.concat(Array.from({ length: result.segmentCount }, () => Buffer.from('abc'))))).toBe(true);
  });

  it('omitting the voice argument keeps the constructor voice (existing callers unaffected)', async () => {
    const client = fakeClient();
    const service = new TtsService({ client, voiceName: 'en-US-Chirp3-HD-Charon' });

    await service.synthesize(devotional, 'off', false);

    // Note this is deliberately NOT run through the catalog: a deployment
    // may legitimately be configured to a voice outside the offered set.
    expect(voiceSentToClient(client)).toBe('en-US-Chirp3-HD-Charon');
  });

  /* ---------------------------------------------------------------- *
   * Per-request language — story O4 #316 (epic #311 decision 4). Same
   * absent-argument contract as the per-request voice above: omitted =
   * constructor languageCode + canonical en-US voice, byte-identical to
   * before.
   * ---------------------------------------------------------------- */

  function requestSentToClient(client: TtsClientLike) {
    return (client.synthesizeSpeech as ReturnType<typeof vi.fn>).mock.calls[0][0];
  }

  it('a per-request language swaps BOTH the languageCode and the voice-name locale prefix', async () => {
    const client = fakeClient();
    const service = new TtsService({ client });

    const result = await service.synthesize(
      devotional,
      'off',
      false,
      'en-US-Chirp3-HD-Achernar',
      'de',
    );

    expect(requestSentToClient(client).voice).toEqual({
      languageCode: 'de-DE',
      name: 'de-DE-Chirp3-HD-Achernar',
    });
    // The reported voice is what was actually synthesized — the localized
    // name, never the canonical en-US form dressed up as German audio.
    expect(result.voiceName).toBe('de-DE-Chirp3-HD-Achernar');
  });

  it('zh synthesizes under cmn-CN, never zh-CN — the locale with zero Chirp 3 HD voices', async () => {
    // The single sharpest trap in the epic (#311 risk list): `zh-CN` looks
    // right and has NO Chirp 3 HD voices (live-verified 2026-07-23). The
    // catalog's ttsLocale must be what reaches the wire.
    const client = fakeClient();
    await new TtsService({ client }).synthesize(devotional, 'off', false, undefined, 'zh');

    const { voice } = requestSentToClient(client);
    expect(voice.languageCode).toBe('cmn-CN');
    expect(voice.name).toBe('cmn-CN-Chirp3-HD-Achernar');
    expect(voice.languageCode).not.toBe('zh-CN');
  });

  it('a picker label resolves to its canonical voice FIRST, then localizes — fr calm is fr-FR Kore', async () => {
    // Order matters: validation happens on the canonical en-US form (the
    // allow-list's live-verified invariant), the locale swap comes last.
    const client = fakeClient();
    await new TtsService({ client }).synthesize(devotional, 'off', false, 'calm', 'fr');

    expect(requestSentToClient(client).voice).toEqual({
      languageCode: 'fr-FR',
      name: 'fr-FR-Chirp3-HD-Kore',
    });
  });

  it('an unrecognized voice still degrades to the configured default — localized into the requested language', async () => {
    // #202's "a bad name must not fail generation" survives #316: the
    // fallback voice follows the user's language too, rather than snapping
    // their Portuguese devotional back to an en-US voice.
    const client = fakeClient();
    const service = new TtsService({ client, voiceName: 'en-US-Chirp3-HD-Achernar' });

    await service.synthesize(devotional, 'off', false, 'not-a-real-voice', 'pt');

    expect(requestSentToClient(client).voice).toEqual({
      languageCode: 'pt-BR',
      name: 'pt-BR-Chirp3-HD-Achernar',
    });
  });

  it("language 'en' produces a request byte-identical to omitting the argument (acceptance: en unchanged)", async () => {
    const explicit = fakeClient();
    const omitted = fakeClient();
    await new TtsService({ client: explicit }).synthesize(devotional, 'brief', false, 'warm', 'en');
    await new TtsService({ client: omitted }).synthesize(devotional, 'brief', false, 'warm');

    expect(requestSentToClient(explicit)).toEqual(requestSentToClient(omitted));
  });

  it('the SSML sent to Cloud TTS speaks the per-language phrases — es carries no English hand-off', async () => {
    // Mutation check at the request boundary: a language param that reached
    // the voice but never the SSML builder would pass every test above and
    // still play English speech in an es-US voice.
    const client = fakeClient();
    await new TtsService({ client }).synthesize(devotional, 'brief', false, undefined, 'es');

    const allSsml = (client.synthesizeSpeech as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0].input.ssml)
      .join('');
    expect(allSsml).not.toContain("Let's sit with this");
    expect(allSsml).not.toContain('That was');
    expect(allSsml).toContain('Quedémonos un momento con esto — yo llevo el tiempo.');
  });

  it('TtsServiceError carries the canonical AUDIO_UNAVAILABLE code (Foundation §4.5)', async () => {
    const client: TtsClientLike = {
      synthesizeSpeech: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const service = new TtsService({ client });
    try {
      await service.synthesize(devotional);
      throw new Error('expected synthesize to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(TtsServiceError);
      expect((err as TtsServiceError).code).toBe('AUDIO_UNAVAILABLE');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Timing manifest — Q1 (kairos-devotional #331). Duration math is
 * measured from each segment's own MP3→PCM decode; these tests inject a
 * deterministic decoder so the offsets are exact.
 * ------------------------------------------------------------------ */

describe('TtsService — timing manifest (Q1 #331)', () => {
  // micro fixture sections: greeting, scripture, reflection, prayer, recap.
  const DURATIONS = [1.5, 4, 6, 3, 2];

  it('emits script-ordered rows whose offsets chain exactly from 0 to the total duration', async () => {
    const client = sequenceClient();
    const service = new TtsService({ client, decodeMp3: fakeDecoder(DURATIONS) });

    const { manifest } = await service.synthesize(devotional);

    expect(manifest).toEqual([
      { section: 'greeting', startSec: 0, endSec: 1.5, text: 'A moment of peace.' },
      {
        section: 'scripture',
        startSec: 1.5,
        endSec: 5.5,
        text: 'From Philippians 4:6-7. Do not be anxious about anything. Berean Standard Bible (BSB).',
      },
      {
        section: 'reflection',
        startSec: 5.5,
        endSec: 11.5,
        text: 'A short steady word for a short steady day.',
      },
      { section: 'prayer', startSec: 11.5, endSec: 14.5, text: 'Father, thank You. Amen.' },
      {
        section: 'scripture',
        startSec: 14.5,
        endSec: 16.5,
        text: "That was Philippians 4:6-7 — it'll be here when you want to come back.",
      },
    ]);
    // Anchored-assertion invariants, independent of the literal above:
    expect(manifest[0]!.startSec).toBe(0);
    for (let i = 1; i < manifest.length; i += 1) {
      expect(manifest[i]!.startSec).toBe(manifest[i - 1]!.endSec);
    }
    expect(manifest[manifest.length - 1]!.endSec).toBeCloseTo(
      DURATIONS.reduce((a, b) => a + b, 0),
      3,
    );
  });

  it('mutation check: swapping two segment durations moves the boundary between their rows', async () => {
    // If the per-segment decode were ignored (e.g. durations divided
    // uniformly, or buffers measured out of order), swapping two segment
    // lengths would leave the boundaries unchanged and this test fails.
    const swapped = [...DURATIONS];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    const client = sequenceClient();
    const service = new TtsService({ client, decodeMp3: fakeDecoder(swapped) });

    const { manifest } = await service.synthesize(devotional);

    expect(manifest[1]).toMatchObject({ section: 'scripture', startSec: 1.5, endSec: 7.5 });
    expect(manifest[2]).toMatchObject({ section: 'reflection', startSec: 7.5, endSec: 11.5 });
  });

  it('coalesces byte-limit body chunks into ONE reflection row spanning their combined time and text', async () => {
    const longBody = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i} about steady grace today.`,
    ).join(' ');
    const extended = { ...devotional, format: 'extended' as const, devotionalBody: longBody };
    const client = sequenceClient();
    // Every segment 2s — we only care about structure here.
    const service = new TtsService({
      client,
      maxSegmentBytes: 500,
      decodeMp3: async () => Buffer.alloc(2 * 16_000 * 2),
    });

    const result = await service.synthesize(extended);

    expect(result.segmentCount).toBeGreaterThan(5); // body really did split
    const reflections = result.manifest.filter((r) => r.section === 'reflection');
    expect(reflections).toHaveLength(1);
    const reflection = reflections[0]!;
    // Combined time: one 2s slot per body chunk.
    const bodyChunks = result.segmentCount - 4; // greeting, scripture, prayer, recap
    expect(reflection.endSec - reflection.startSec).toBeCloseTo(bodyChunks * 2, 3);
    expect(reflection.text).toBe(longBody);
  });

  it('coalesces multiple verses into one scripture row, while the recap stays its own row', async () => {
    const twoVerses: DevotionalOutput = {
      ...devotional,
      verses: [
        devotional.verses[0]!,
        {
          usfm: 'JHN.3.16',
          versionId: 3034,
          reference: 'John 3:16',
          fetchedText: 'For God so loved the world.',
          attribution: 'Berean Standard Bible (BSB). Public domain.',
        },
      ],
    };
    const client = sequenceClient();
    const service = new TtsService({
      client,
      decodeMp3: async () => Buffer.alloc(1 * 16_000 * 2),
    });

    const { manifest } = await service.synthesize(twoVerses);

    expect(manifest.map((r) => r.section)).toEqual([
      'greeting',
      'scripture',
      'reflection',
      'prayer',
      'scripture',
    ]);
    const verses = manifest[1]!;
    expect(verses.endSec - verses.startSec).toBeCloseTo(2, 3); // both verse segments
    expect(verses.text).toContain('Do not be anxious about anything.');
    expect(verses.text).toContain('For God so loved the world.');
  });

  it('lectio produces a valid manifest too (repeated-verse structure)', async () => {
    const client = sequenceClient();
    const service = new TtsService({
      client,
      decodeMp3: async () => Buffer.alloc(3 * 16_000 * 2),
    });

    const { manifest } = await service.synthesize(devotional, 'brief', true);

    expect(manifest.map((r) => r.section)).toEqual([
      'greeting',
      'scripture',
      'stillness',
      'prayer',
      'stillness',
      'scripture',
    ]);
    expect(manifest[0]!.startSec).toBe(0);
    for (let i = 1; i < manifest.length; i += 1) {
      expect(manifest[i]!.startSec).toBe(manifest[i - 1]!.endSec);
    }
    const stillnessRows = manifest.filter((r) => r.section === 'stillness');
    for (const row of stillnessRows) {
      expect(row.text).toBe('');
    }
  });

  it('manifest rows carry plain text, never SSML markup', async () => {
    const withMarkupBait: DevotionalOutput = {
      ...devotional,
      theme: 'peace & <quiet>',
      devotionalBody: 'Grace & truth < mercy > judgment.',
    };
    const client = sequenceClient();
    const service = new TtsService({
      client,
      decodeMp3: async () => Buffer.alloc(16_000 * 2),
    });

    const { manifest } = await service.synthesize(withMarkupBait);

    for (const row of manifest) {
      // Plain pre-escape text: no SSML entities, no SSML/markup tags. The
      // content's own literal `& < >` characters must survive UNescaped.
      expect(row.text).not.toContain('&amp;');
      expect(row.text).not.toContain('&lt;');
      expect(row.text).not.toContain('<speak>');
      expect(row.text).not.toContain('<p>');
      expect(row.text).not.toContain('<break');
    }
    expect(manifest[0]!.text).toBe('A moment of peace & <quiet>.');
  });

  it('a decode failure yields an empty manifest but never costs the caller their audio', async () => {
    const client = sequenceClient();
    const service = new TtsService({
      client,
      decodeMp3: async () => {
        throw new Error('ffmpeg unavailable');
      },
    });

    const result = await service.synthesize(devotional);

    expect(result.manifest).toEqual([]);
    expect(result.audio.length).toBeGreaterThan(0);
    expect(result.segmentCount).toBe(5);
  });
});
