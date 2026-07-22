/**
 * MP3 -> raw PCM decode for the LiveKit publish pipeline (D4/#32).
 *
 * Uses a spawned `ffmpeg` process (binary from `@ffmpeg-installer/ffmpeg`
 * — the same package `@livekit/agents` itself bundles for this exact
 * purpose) rather than the deprecated `fluent-ffmpeg` wrapper, and rather
 * than pulling in the full `@livekit/agents` framework (see
 * docs/23_LIVEKIT_DELIVERY.md's DEC-K10 note for why D4 uses a
 * webhook + `@livekit/rtc-node` architecture instead of an agents-js
 * worker process).
 *
 * ⚠️ Must-confirm (docs/00_FOUNDATION.md §11 convention): the exact
 * sample-rate/frame-size/backpressure contract of `@livekit/rtc-node`'s
 * `AudioSource.captureFrame` has not been exercised against a live
 * LiveKit server (no account exists yet) — this function's output format
 * (48kHz mono s16le) is chosen to match common WebRTC/LiveKit examples,
 * not verified end-to-end.
 */
import { spawn } from 'node:child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 1;

export interface DecodeMp3ToPcmOptions {
  /** Defaults to PCM_SAMPLE_RATE (48kHz, LiveKit's rate). H1's Attendee transport needs 8000/16000/24000 — see meetBot/attendeeClient.ts. */
  sampleRate?: number;
  /** Defaults to PCM_CHANNELS (mono). */
  channels?: number;
  ffmpegPath?: string;
}

export function decodeMp3ToPcm(mp3: Buffer, options: DecodeMp3ToPcmOptions = {}): Promise<Buffer> {
  const sampleRate = options.sampleRate ?? PCM_SAMPLE_RATE;
  const channels = options.channels ?? PCM_CHANNELS;
  const ffmpegPath = options.ffmpegPath ?? ffmpeg.path;

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      String(channels),
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    // ffmpeg may exit (and close stdin) before we finish writing on a
    // malformed input — swallow the resulting EPIPE here; the 'close'
    // handler above is what reports the real failure via the exit code.
    proc.stdin.on('error', () => {});
    proc.stdin.write(mp3);
    proc.stdin.end();
  });
}
