import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { decodeMp3ToPcm, PCM_CHANNELS, PCM_SAMPLE_RATE } from '../../../src/services/livekit/decodeMp3ToPcm.js';

/**
 * Generates a tiny real MP3 (1/10s of silence) via the same ffmpeg binary,
 * so this test exercises the real decode path end-to-end rather than
 * asserting against a hand-crafted fixture.
 */
function generateSilentMp3(): Buffer {
  const result = spawnSync(ffmpeg.path, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=mono',
    '-t',
    '0.1',
    '-f',
    'mp3',
    'pipe:1',
  ]);
  if (result.status !== 0) {
    throw new Error(`fixture generation failed: ${result.stderr.toString('utf8')}`);
  }
  return result.stdout;
}

describe('decodeMp3ToPcm', () => {
  it('decodes a real MP3 into s16le PCM at the expected sample rate/channel count', async () => {
    const mp3 = generateSilentMp3();
    const pcm = await decodeMp3ToPcm(mp3);

    expect(pcm.length).toBeGreaterThan(0);
    // s16le mono: 2 bytes/sample; ~0.1s @ 48kHz should be roughly 4800 samples (9600 bytes) give or take encoder framing.
    const approxSamples = pcm.length / 2;
    expect(approxSamples).toBeGreaterThan(PCM_SAMPLE_RATE * 0.05);
    expect(approxSamples).toBeLessThan(PCM_SAMPLE_RATE * 0.5);
    expect(PCM_CHANNELS).toBe(1);
  });

  it('rejects with a descriptive error for malformed input', async () => {
    await expect(decodeMp3ToPcm(Buffer.from('not an mp3 at all'))).rejects.toThrow(/ffmpeg exited with code/);
  });
});
