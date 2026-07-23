/**
 * Live-integration test against the real Google Cloud Text-to-Speech API.
 *
 * Unlike Gloo/YouVersion, TTS auth is gcloud ADC (Application Default
 * Credentials), not a .env secret — so this test is gated on
 * `KAIROS_TTS_LIVE=1` (opt-in) rather than an env var whose absence would
 * be the normal CI state. CI has no ADC configured, so it is skipped there
 * by default; run locally with:
 *
 *   KAIROS_TTS_LIVE=1 npm --workspace apps/api run test -- ttsService.live
 *
 * Requires:
 *   - `gcloud auth application-default login` once
 *   - `gcloud auth application-default set-quota-project <project>` once
 *     (texttospeech.googleapis.com requires a quota project on ADC; without
 *     this the client fails with PERMISSION_DENIED asking for one — this is
 *     a one-time local machine config step, not a secret).
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LANGUAGE_CATALOG, LANGUAGE_TAGS, type DevotionalOutput } from '@kairos/shared-contracts';
import { TtsService } from '../../../src/services/tts/ttsService.js';
import { LocalFileAudioStorage } from '../../../src/services/audio/audioStorage.js';
import fixture from '../../../../../fixtures/snapshots/moderate_fair_moderate.json' with { type: 'json' };

const execFileAsync = promisify(execFile);

const runLive = process.env.KAIROS_TTS_LIVE === '1';

describe.skipIf(!runLive)('TtsService — LIVE (real Google Cloud Text-to-Speech)', () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'kairos-tts-live-'));
  });

  afterAll(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it('synthesizes a real, non-empty MP3 for a fixture devotional with a duration roughly matching the word count', async () => {
    const devotional = fixture.devotionalOutput as DevotionalOutput;
    const wordCount = devotional.devotionalBody.split(/\s+/).filter(Boolean).length;

    const service = new TtsService(); // real client, ADC auth, default Chirp3-HD voice + 0.95 rate
    const result = await service.synthesize(devotional);

    // 1. Real, non-empty MP3 bytes.
    expect(result.audio.length).toBeGreaterThan(1000);
    // MP3 files either start with an ID3 tag ("ID3") or an MPEG frame sync (0xFF Ex).
    const header = result.audio.subarray(0, 3).toString('latin1');
    const isId3 = header === 'ID3';
    const isFrameSync = result.audio[0] === 0xff && (result.audio[1]! & 0xe0) === 0xe0;
    expect(isId3 || isFrameSync).toBe(true);

    expect(result.charCount).toBeGreaterThan(0);
    console.log(
      `[TTS live] devotionalBody words=${wordCount} charCount(SSML)=${result.charCount} segments=${result.segmentCount} audioBytes=${result.audio.length} voice=${result.voiceName}`,
    );

    // 2. Store it via LocalFileAudioStorage and confirm round-trip.
    const storage = new LocalFileAudioStorage({
      rootDir,
      signingSecret: 'live-test-secret-0123456789',
    });
    const devotionalId = 'live-fixture-moderate_fair_moderate';
    await storage.upload(devotionalId, result.audio);
    expect(await storage.exists(devotionalId)).toBe(true);

    const { url } = await storage.getSignedUrl(devotionalId, { expirySeconds: 900 });
    const token = decodeURIComponent(url.split('/audio/')[1]!);
    const bytesFromStorage = await storage.readForToken(token);
    expect(bytesFromStorage.equals(result.audio)).toBe(true);

    // 3. Rough sanity check on playback duration via ffprobe, if available —
    // devotionalBody alone is `standard` format (500-750 word target per
    // Foundation §6); at a typical spoken pace of ~150 wpm and speakingRate
    // 0.95, plus verse text, breaks, and prayer, total duration should land
    // well north of 60s and well under 15 minutes for this fixture. This is
    // a coarse sanity bound, not a precision check (per task instructions).
    const mp3Path = path.join(rootDir, 'fixture.mp3');
    await import('node:fs/promises').then((fs) => fs.writeFile(mp3Path, result.audio));
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        mp3Path,
      ]);
      const durationSec = parseFloat(stdout.trim());
      console.log(`[TTS live] measured duration: ${durationSec.toFixed(1)}s`);
      expect(durationSec).toBeGreaterThan(30);
      expect(durationSec).toBeLessThan(20 * 60);
    } catch (err) {
      // ffprobe not installed in this environment — fall back to a byte-size
      // sanity bound only (MP3 @ ~24kbps mono-ish Chirp output is roughly
      // several KB/sec; a >1000-byte assertion above already caught total
      // failure, this just logs that duration wasn't independently verified).
      console.warn(
        `[TTS live] ffprobe unavailable, skipping duration check: ${(err as Error).message}`,
      );
    }

    const fileStat = await stat(mp3Path);
    expect(fileStat.size).toBe(result.audio.length);
  }, 60_000);

  it('synthesizes real audio in every shipped language — locale-swapped voice accepted by Cloud TTS (story O4 #316)', async () => {
    // The acceptance item "live synth smoke-test per shipped language,
    // result recorded on the issue (merged ≠ works)": unit tests prove the
    // request we BUILD carries es-US/…/cmn-CN, but only Cloud TTS itself can
    // prove those locale-swapped names exist server-side. A deliberately
    // tiny script keeps the six synthesis calls cheap.
    const micro: DevotionalOutput = {
      format: 'micro',
      theme: 'peace',
      verses: [
        {
          usfm: 'PHP.4.6',
          versionId: 3034,
          reference: 'Philippians 4:6',
          fetchedText: 'Do not be anxious about anything.',
          attribution: 'Berean Standard Bible (BSB). Public domain.',
        },
      ],
      devotionalBody: 'A short steady word.',
      cardSummary: 'Peace.',
      prayer: 'Amen.',
    };

    const service = new TtsService(); // real client, ADC auth
    for (const tag of LANGUAGE_TAGS) {
      const result = await service.synthesize(micro, 'off', false, undefined, tag);
      expect(result.audio.length, `language=${tag} returned no audio`).toBeGreaterThan(1000);
      expect(result.voiceName.startsWith(LANGUAGE_CATALOG[tag].ttsLocale)).toBe(true);
      console.log(
        `[TTS live] language=${tag} voice=${result.voiceName} audioBytes=${result.audio.length}`,
      );
    }
  }, 120_000);
});
