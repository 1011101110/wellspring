/**
 * Real `@livekit/rtc-node` publish implementation (D4/#32) — connects as a
 * bot participant and streams pre-decoded PCM audio into the room.
 *
 * Live-verified end-to-end 2026-07-06 (docs/23_LIVEKIT_DELIVERY.md §1),
 * after three real bugs found and fixed in sequence:
 *
 * 1. Original code fed frames in a tight loop with no pacing, then closed
 *    the track and disconnected immediately — completed in well under a
 *    second for a ~99s clip, tearing the connection down before any
 *    audio reached the remote side.
 * 2. First fix attempt added manual `sleep(10ms)` pacing — a guess, later
 *    superseded.
 * 3. Correct pacing fix, found in LiveKit's own official example
 *    (github.com/livekit/node-sdks/tree/main/examples/publish-wav): no
 *    manual pacing needed; call `source.waitForPlayout()` once before
 *    closing the track.
 * 4. Timing was now correct, but a live Web Audio API energy measurement
 *    proved the received audio was pure silence — a real bug, confirmed
 *    by reading `@livekit/rtc-node`'s compiled `audio_frame.cjs`:
 *    `AudioFrame.protoInfo()` builds its native pointer via `new
 *    Uint8Array(this.data.buffer)`, which wraps the frame's Int16Array's
 *    UNDERLYING buffer in full, ignoring `byteOffset`/`length` entirely.
 *    Every frame's samples were a `subarray` VIEW into one large shared
 *    PCM buffer (correct data when read back in JS), but the native side
 *    always read from byte 0 of that shared buffer regardless of which
 *    frame was "sent" — every `captureFrame` call transmitted the same
 *    first ~10ms of the entire clip (its near-silent lead-in).
 *
 * Fixed by `copyFrameSamples` below: each frame gets its own dedicated,
 * zero-offset Int16Array (a real copy), so `protoInfo()`'s buggy
 * full-buffer read correctly captures just that frame. Live-confirmed
 * with the same Web Audio API energy measurement showing genuine,
 * fluctuating, non-zero signal.
 */
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { PCM_CHANNELS, PCM_SAMPLE_RATE } from './decodeMp3ToPcm.js';

/** 10ms frames at 48kHz mono s16le = 480 samples = 960 bytes. */
export const FRAME_SAMPLES = PCM_SAMPLE_RATE / 100;
const BOT_IDENTITY = 'kairos-agent';

export interface ConnectAndPublishParams {
  url: string;
  token: string;
  pcm: Buffer;
}

/**
 * Extracts one frame's samples as a fresh, dedicated, zero-offset
 * Int16Array — a real copy via `.set()`, never a view into the larger
 * shared `pcm` buffer. This is the fix for the `AudioFrame.protoInfo()`
 * byteOffset bug documented in this file's header: the native side reads
 * `this.data.buffer` in full, ignoring any byteOffset a view would carry,
 * so every frame's `.buffer` must contain exactly that frame's bytes and
 * nothing else. Pure and exported so the invariant is independently
 * unit-tested without needing the native `@livekit/rtc-node` module.
 */
export function copyFrameSamples(pcm: Buffer, offset: number, frameSamples: number, channels: number): Int16Array {
  const bytesPerFrame = frameSamples * channels * 2;
  const frameBuf = pcm.subarray(offset, offset + bytesPerFrame);
  const samples = new Int16Array(frameSamples * channels);
  samples.set(new Int16Array(frameBuf.buffer, frameBuf.byteOffset, frameBuf.byteLength / 2));
  return samples;
}

export async function connectAndPublishPcmToRoom(params: ConnectAndPublishParams): Promise<void> {
  const room = new Room();
  await room.connect(params.url, params.token, { autoSubscribe: false, dynacast: false });

  try {
    const source = new AudioSource(PCM_SAMPLE_RATE, PCM_CHANNELS);
    const track = LocalAudioTrack.createAudioTrack(`devotional-${BOT_IDENTITY}`, source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant?.publishTrack(track, options);

    const bytesPerFrame = FRAME_SAMPLES * PCM_CHANNELS * 2;
    for (let offset = 0; offset + bytesPerFrame <= params.pcm.length; offset += bytesPerFrame) {
      const samples = copyFrameSamples(params.pcm, offset, FRAME_SAMPLES, PCM_CHANNELS);
      await source.captureFrame(new AudioFrame(samples, PCM_SAMPLE_RATE, PCM_CHANNELS, FRAME_SAMPLES));
    }

    // Waits for the queued audio to actually finish playing out — the
    // library's own mechanism, not a manual sleep (see file header).
    await source.waitForPlayout();
    await track.close();
  } finally {
    await room.disconnect();
  }
}
