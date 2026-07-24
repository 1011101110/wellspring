/**
 * Open Moment window state machine (EPIC V #360 / V3 #364) — pure-function
 * tests, off-DOM. These functions ARE the shipped client code (embedded via
 * toString() into stageClient.ts), so this suite is the window's decision
 * logic coverage, not a parallel copy's — exhaustive like the captionAt
 * suite, because the live parts (mic, VAD, fetch) can never run headless.
 */
import { describe, expect, it } from 'vitest';
import type { LiveResponseDurations, TimingManifest } from '@kairos/shared-contracts';
import { buildStageClientJs } from '../../../src/services/stage/stageClient.js';
import {
  OPEN_MOMENT_SILENCE_MS,
  OPEN_MOMENT_WINDOW_MS,
  chooseOutcome,
  computeRms,
  findOpenMomentWindow,
  hasTranscript,
  isSpeechEnergy,
  openMomentExit,
  releaseStream,
  verseRevealMs,
} from '../../../src/services/stage/stageOpenMoment.js';

/** A manifest with the open-moment marker between reflection and the closing prayer. */
const OM_MANIFEST: TimingManifest = [
  { section: 'greeting', startSec: 0, endSec: 2, text: 'A moment of rest.' },
  { section: 'scripture', startSec: 2, endSec: 12, text: 'Come to me, all who are weary.' },
  { section: 'reflection', startSec: 12, endSec: 40, text: 'A steady word about rest.' },
  { section: 'open_moment', startSec: 40, endSec: 46, text: 'If you like, speak what you are carrying.' },
  { section: 'prayer', startSec: 46, endSec: 58, text: 'Lord, grant us rest. Amen.' },
  { section: 'scripture', startSec: 58, endSec: 62, text: 'That was Matthew 11.' },
];

describe('findOpenMomentWindow', () => {
  it('returns null for empty/missing manifests', () => {
    expect(findOpenMomentWindow([])).toBeNull();
    expect(findOpenMomentWindow(undefined as unknown as TimingManifest)).toBeNull();
  });

  it('returns null when there is no open_moment marker (every pre-#360 devotional)', () => {
    const noMarker = OM_MANIFEST.filter((r) => r.section !== 'open_moment');
    expect(findOpenMomentWindow(noMarker)).toBeNull();
  });

  it('opens at the marker start and resumes at the following prayer start', () => {
    expect(findOpenMomentWindow(OM_MANIFEST)).toEqual({ startSec: 40, resumeSec: 46 });
  });

  it('resumes at the marker end when no prayer follows (defensive fallback)', () => {
    const noPrayer: TimingManifest = [
      { section: 'reflection', startSec: 0, endSec: 10, text: 'x' },
      { section: 'open_moment', startSec: 10, endSec: 15, text: 'invite' },
      { section: 'scripture', startSec: 15, endSec: 20, text: 'recap' },
    ];
    expect(findOpenMomentWindow(noPrayer)).toEqual({ startSec: 10, resumeSec: 15 });
  });

  it('finds the FIRST prayer at/after the marker even if a later stillness intervenes', () => {
    const withStillness: TimingManifest = [
      { section: 'open_moment', startSec: 5, endSec: 9, text: 'invite' },
      { section: 'stillness', startSec: 9, endSec: 12, text: '' },
      { section: 'prayer', startSec: 12, endSec: 20, text: 'amen' },
    ];
    expect(findOpenMomentWindow(withStillness)).toEqual({ startSec: 5, resumeSec: 12 });
  });
});

describe('openMomentExit', () => {
  const W = OPEN_MOMENT_WINDOW_MS;
  const S = OPEN_MOMENT_SILENCE_MS;

  it('stays listening before any speech, within the window', () => {
    expect(openMomentExit(false, 0, 0, W, S)).toBe('listening');
    expect(openMomentExit(false, 0, W - 1, W, S)).toBe('listening');
  });

  it('a silent listener rides to the cap (the honored-silence path)', () => {
    expect(openMomentExit(false, 0, W, W, S)).toBe('end-cap');
    expect(openMomentExit(false, 999999, W + 500, W, S)).toBe('end-cap');
  });

  it('ends on 2.5s of silence AFTER speech was detected', () => {
    expect(openMomentExit(true, S - 1, 5000, W, S)).toBe('listening');
    expect(openMomentExit(true, S, 5000, W, S)).toBe('end-speech');
    expect(openMomentExit(true, S + 1000, 5000, W, S)).toBe('end-speech');
  });

  it('silence before speech never ends the window — only the cap can', () => {
    // speechDetected=false, so silenceMsAfterSpeech is meaningless and ignored.
    expect(openMomentExit(false, S + 10000, 100, W, S)).toBe('listening');
  });

  it('the cap wins ties — it is the hard bound', () => {
    // Both conditions satisfied at once → end-cap (evaluated first).
    expect(openMomentExit(true, S, W, W, S)).toBe('end-cap');
  });
});

describe('computeRms', () => {
  it('is 0 for empty/absent samples', () => {
    expect(computeRms(null)).toBe(0);
    expect(computeRms(undefined)).toBe(0);
    expect(computeRms(new Float32Array(0))).toBe(0);
    expect(computeRms([])).toBe(0);
  });

  it('is 0 for pure silence and rises with amplitude', () => {
    expect(computeRms([0, 0, 0, 0])).toBe(0);
    // RMS of [±0.5] alternating = 0.5.
    expect(computeRms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 6);
    // RMS of a constant 1 block = 1.
    expect(computeRms([1, 1, 1])).toBeCloseTo(1, 6);
  });
});

describe('isSpeechEnergy', () => {
  it('is speech at/above the threshold, not below', () => {
    expect(isSpeechEnergy(0.02, 0.015)).toBe(true);
    expect(isSpeechEnergy(0.015, 0.015)).toBe(true);
    expect(isSpeechEnergy(0.0149, 0.015)).toBe(false);
    expect(isSpeechEnergy(0, 0.015)).toBe(false);
  });
});

describe('chooseOutcome (fail-open exit selection)', () => {
  it('chooses response ONLY for a well-formed response envelope with playable audio', () => {
    expect(chooseOutcome({ outcome: 'response', audioUrl: 'https://x/a.mp3' })).toBe('response');
  });

  it('falls to silence for every degraded/absent shape (no error, no unvalidated word)', () => {
    expect(chooseOutcome({ outcome: 'silence' })).toBe('silence');
    expect(chooseOutcome(null)).toBe('silence'); // network error
    expect(chooseOutcome(undefined)).toBe('silence');
    expect(chooseOutcome({})).toBe('silence');
    expect(chooseOutcome({ outcome: 'response' })).toBe('silence'); // no audioUrl
    expect(chooseOutcome({ outcome: 'response', audioUrl: '' })).toBe('silence'); // empty audioUrl
    expect(chooseOutcome({ outcome: 'response', audioUrl: 123 as unknown as string })).toBe('silence');
    expect(chooseOutcome({ outcome: 'weird', audioUrl: 'https://x/a.mp3' })).toBe('silence');
  });
});

describe('hasTranscript', () => {
  it('is false for empty/whitespace/absent — the honored-silence path skips the POST', () => {
    expect(hasTranscript('')).toBe(false);
    expect(hasTranscript('   ')).toBe(false);
    expect(hasTranscript('\n\t ')).toBe(false);
    expect(hasTranscript(null)).toBe(false);
    expect(hasTranscript(undefined)).toBe(false);
  });

  it('is true for any real content', () => {
    expect(hasTranscript('I feel tired')).toBe(true);
    expect(hasTranscript('  hi  ')).toBe(true);
  });
});

describe('verseRevealMs', () => {
  const durations = (ackSec: number): LiveResponseDurations => ({
    acknowledgmentSec: ackSec,
    verseSec: 4,
    framingSec: 3,
    totalSec: ackSec + 7,
  });

  it('reveals immediately when the acknowledgment duration is unknown/zero', () => {
    expect(verseRevealMs(null)).toBe(0);
    expect(verseRevealMs(undefined)).toBe(0);
    expect(verseRevealMs(durations(0))).toBe(0);
  });

  it('waits the acknowledgment beat (ms, rounded) when measured', () => {
    expect(verseRevealMs(durations(2))).toBe(2000);
    expect(verseRevealMs(durations(1.2345))).toBe(1235);
  });
});

describe('releaseStream (mic release)', () => {
  it('stops every track and reports the count', () => {
    const stopped: number[] = [];
    const stream = {
      getTracks: () => [
        { stop: () => stopped.push(1) },
        { stop: () => stopped.push(2) },
        { stop: () => stopped.push(3) },
      ],
    };
    expect(releaseStream(stream)).toBe(3);
    expect(stopped).toEqual([1, 2, 3]);
  });

  it('is null-safe (mic-denied path never captured a stream)', () => {
    expect(releaseStream(null)).toBe(0);
    expect(releaseStream(undefined)).toBe(0);
    expect(releaseStream({} as never)).toBe(0);
  });
});

describe('embedded open-moment functions evaluate and agree with the module (no toString drift)', () => {
  it('re-evaluates the shipped copies and matches the imported functions', () => {
    const js = buildStageClientJs();
    const prefix = js.slice(0, js.indexOf('(function () {'));
    const evaluate = new Function(
      `${prefix}; return {
        findOpenMomentWindow: findOpenMomentWindow,
        openMomentExit: openMomentExit,
        computeRms: computeRms,
        isSpeechEnergy: isSpeechEnergy,
        chooseOutcome: chooseOutcome,
        hasTranscript: hasTranscript,
        verseRevealMs: verseRevealMs,
        releaseStream: releaseStream
      };`,
    )() as {
      findOpenMomentWindow: typeof findOpenMomentWindow;
      openMomentExit: typeof openMomentExit;
      computeRms: typeof computeRms;
      isSpeechEnergy: typeof isSpeechEnergy;
      chooseOutcome: typeof chooseOutcome;
      hasTranscript: typeof hasTranscript;
      verseRevealMs: typeof verseRevealMs;
      releaseStream: typeof releaseStream;
    };

    expect(evaluate.findOpenMomentWindow(OM_MANIFEST)).toEqual(findOpenMomentWindow(OM_MANIFEST));
    for (let ms = 0; ms <= OPEN_MOMENT_WINDOW_MS + 1000; ms += 2500) {
      expect(evaluate.openMomentExit(true, ms, ms, OPEN_MOMENT_WINDOW_MS, OPEN_MOMENT_SILENCE_MS)).toBe(
        openMomentExit(true, ms, ms, OPEN_MOMENT_WINDOW_MS, OPEN_MOMENT_SILENCE_MS),
      );
    }
    expect(evaluate.computeRms([0.5, -0.5])).toBeCloseTo(computeRms([0.5, -0.5]), 9);
    expect(evaluate.isSpeechEnergy(0.02, 0.015)).toBe(isSpeechEnergy(0.02, 0.015));
    expect(evaluate.chooseOutcome({ outcome: 'response', audioUrl: 'https://x/a.mp3' })).toBe('response');
    expect(evaluate.chooseOutcome(null)).toBe('silence');
    expect(evaluate.hasTranscript('  ')).toBe(false);
    expect(evaluate.verseRevealMs({ acknowledgmentSec: 2, verseSec: 0, framingSec: 0, totalSec: 2 })).toBe(2000);

    const stopped: number[] = [];
    expect(evaluate.releaseStream({ getTracks: () => [{ stop: () => stopped.push(1) }] })).toBe(1);
    expect(stopped).toEqual([1]);
  });
});
