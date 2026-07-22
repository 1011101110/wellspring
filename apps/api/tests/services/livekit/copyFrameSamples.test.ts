import { describe, expect, it } from 'vitest';
import { copyFrameSamples, FRAME_SAMPLES } from '../../../src/services/livekit/connectAndPublishPcmToRoom.js';
import { PCM_CHANNELS } from '../../../src/services/livekit/decodeMp3ToPcm.js';

/**
 * Regression test for the real bug found live 2026-07-06
 * (docs/23_LIVEKIT_DELIVERY.md §1): `@livekit/rtc-node`'s
 * `AudioFrame.protoInfo()` builds its native pointer via `new
 * Uint8Array(this.data.buffer)` — this reads the ENTIRE underlying
 * ArrayBuffer of whatever Int16Array is passed, ignoring byteOffset and
 * length completely. A frame's samples must therefore live in their OWN
 * dedicated buffer (byteOffset 0, no extra trailing data) or the native
 * side silently reads the wrong bytes. `nativeProtoInfoRead` below
 * replicates that exact (buggy) native-read behavior so this test fails
 * if `copyFrameSamples` ever regresses back to returning a view into a
 * larger shared buffer.
 */
function nativeProtoInfoRead(samples: Int16Array): Int16Array {
  const fullBufferView = new Uint8Array(samples.buffer);
  return new Int16Array(fullBufferView.buffer, 0, samples.length);
}

const bytesPerFrame = FRAME_SAMPLES * PCM_CHANNELS * 2;

describe('copyFrameSamples', () => {
  it('returns a fresh Int16Array with byteOffset 0 (a real copy, not a view into the shared buffer)', () => {
    const pcm = Buffer.alloc(bytesPerFrame * 3);
    const samples = copyFrameSamples(pcm, bytesPerFrame, FRAME_SAMPLES, PCM_CHANNELS);
    expect(samples.byteOffset).toBe(0);
    expect(samples.buffer.byteLength).toBe(bytesPerFrame);
  });

  it('reproduces the exact values for the requested frame, not an earlier one — the actual regression this fixes', () => {
    const totalFrames = 10;
    const pcm = Buffer.alloc(bytesPerFrame * totalFrames);
    // Frame 0 carries a near-silent value; frame 5 carries a distinct loud value.
    for (let f = 0; f < totalFrames; f++) {
      const value = f === 5 ? 999 : 1;
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        pcm.writeInt16LE(value, f * bytesPerFrame + i * 2);
      }
    }

    const frame5Offset = 5 * bytesPerFrame;
    const samples = copyFrameSamples(pcm, frame5Offset, FRAME_SAMPLES, PCM_CHANNELS);

    // The JS-level view is correct even without the fix (this alone
    // would not have caught the bug — see the next assertion).
    expect(samples[0]).toBe(999);

    // This is the assertion that actually catches the regression: it
    // replicates what the NATIVE side reads via AudioFrame.protoInfo()'s
    // `new Uint8Array(this.data.buffer)`. Before the fix, this returned
    // frame 0's value (1) for every frame regardless of the requested
    // offset, because `samples.buffer` was the entire shared pcm buffer.
    const nativeRead = nativeProtoInfoRead(samples);
    expect(nativeRead[0]).toBe(999);
  });

  it('every frame across a full buffer round-trips correctly through the native-read simulation', () => {
    const totalFrames = 20;
    const pcm = Buffer.alloc(bytesPerFrame * totalFrames);
    for (let f = 0; f < totalFrames; f++) {
      pcm.writeInt16LE(f * 100, f * bytesPerFrame); // distinct marker value per frame
    }

    for (let f = 0; f < totalFrames; f++) {
      const samples = copyFrameSamples(pcm, f * bytesPerFrame, FRAME_SAMPLES, PCM_CHANNELS);
      const nativeRead = nativeProtoInfoRead(samples);
      expect(nativeRead[0]).toBe(f * 100);
    }
  });
});
