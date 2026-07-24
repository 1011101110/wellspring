/**
 * The Open Moment (EPIC V #360 / V3 #364) — the bounded listening window's
 * pure decision logic. Same role for the window state machine that
 * stageTimeline.ts plays for the caption/tab timeline: the exhaustively
 * unit-tested functions ARE the shipped ones, embedded into the Stage
 * page's client script via `Function.prototype.toString()` (stageClient.ts).
 *
 * ⚠️ DUAL-RUNTIME CONSTRAINT (identical to stageTimeline.ts — read that
 * file's note): plain `function` declarations only; a body may only call
 * the other functions in this file and browser/ES built-ins (NO module
 * imports referenced inside a body, NO module constants read from a body —
 * the tuning constants are PARAMETERS, so the DOM wiring supplies them and
 * the same values live once in the exported constants below); no TS runtime
 * features; browser-compatible ES5-ish syntax (the DOM wiring around these
 * is ES5-style too).
 *
 * Why the split-out: the live parts of the window (getUserMedia, the Web
 * Audio analyser, SpeechRecognition, `fetch`) cannot run headless, so the
 * page's correctness rests on THESE pure functions — the trigger point, the
 * end-of-speech vs. cap decision, the fail-open exit selection, and mic
 * release — being tested off-DOM, with only a thin, boring glue layer left
 * un-unit-tested (epic #330: "keep it small and boring").
 */
import type { LiveResponseDurations, TimingManifestEntry } from '@kairos/shared-contracts';

/**
 * The listening window's tuning constants (feature #361). ONE window, 30s
 * cap, end-of-speech after 2.5s of silence once speech is detected. The VAD
 * threshold is normalized RMS (0..1) on the analyser's time-domain samples;
 * it and the poll interval are deliberately conservative and MUST be
 * re-tuned against the real Meet virtual-mic signal in V6 (#367) — the
 * live-audio rehearsal is where a real level exists to calibrate against.
 */
export const OPEN_MOMENT_WINDOW_MS = 30000;
export const OPEN_MOMENT_SILENCE_MS = 2500;
export const OPEN_MOMENT_VAD_THRESHOLD = 0.015;
export const OPEN_MOMENT_VAD_POLL_MS = 100;

/** The window's location in the timeline: where it opens and where the devotional resumes. */
export interface OpenMomentWindow {
  /** The `open_moment` marker's `startSec` — playback crossing it opens the window. */
  startSec: number;
  /** Where the devotional resumes on BOTH exits: the following `prayer` row's start (the closing prayer). */
  resumeSec: number;
}

/**
 * The window bounds derived from the timing manifest, or null when this
 * devotional has no open moment (pre-#360 manifests never carry the
 * section, so every existing devotional returns null and the page behaves
 * exactly as before). `resumeSec` is the first `prayer` row at/after the
 * marker — the closing prayer both exits flow into (feature #361 steps
 * 3–4). Rows are contiguous (Q1 invariant) so the prayer's `startSec`
 * equals the marker's `endSec`, but we locate the prayer explicitly rather
 * than assume adjacency.
 */
export function findOpenMomentWindow(
  manifest: TimingManifestEntry[],
): OpenMomentWindow | null {
  if (!manifest || manifest.length === 0) return null;
  let omIndex = -1;
  for (let i = 0; i < manifest.length; i += 1) {
    if ((manifest[i] as TimingManifestEntry).section === 'open_moment') {
      omIndex = i;
      break;
    }
  }
  if (omIndex < 0) return null;
  const marker = manifest[omIndex] as TimingManifestEntry;
  let resumeSec = marker.endSec;
  for (let j = omIndex + 1; j < manifest.length; j += 1) {
    if ((manifest[j] as TimingManifestEntry).section === 'prayer') {
      resumeSec = (manifest[j] as TimingManifestEntry).startSec;
      break;
    }
  }
  return { startSec: marker.startSec, resumeSec: resumeSec };
}

/**
 * The end-of-speech decision (feature #361 step 3): the window stays open
 * until EITHER 2.5s of silence has passed after speech was detected, OR the
 * 30s cap is reached — whichever comes first. The cap wins ties (it is the
 * hard bound). `silenceMsAfterSpeech` is meaningful only once
 * `speechDetected` is true; before any speech only the cap can end the
 * window (a silent listener rides to `end-cap` → the honored-silence path).
 * Constants are parameters so this stays pure and the wiring passes the
 * exported values (dual-runtime constraint).
 */
export function openMomentExit(
  speechDetected: boolean,
  silenceMsAfterSpeech: number,
  elapsedMs: number,
  windowMs: number,
  silenceMs: number,
): 'listening' | 'end-speech' | 'end-cap' {
  if (elapsedMs >= windowMs) return 'end-cap';
  if (speechDetected && silenceMsAfterSpeech >= silenceMs) return 'end-speech';
  return 'listening';
}

/** Root-mean-square level of a block of time-domain samples (−1..1), for the energy VAD. Empty/absent → 0. */
export function computeRms(samples: Float32Array | number[] | null | undefined): number {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** Whether an RMS level counts as speech for the energy VAD. */
export function isSpeechEnergy(rms: number, threshold: number): boolean {
  return rms >= threshold;
}

/**
 * Fail-open exit selection (feature #361 / epic §2, §6): a `response`
 * outcome is chosen ONLY for a well-formed response envelope that actually
 * carries playable audio. Everything else — a `silence` outcome, a network
 * error (null/undefined), a malformed body, a response envelope missing its
 * audioUrl — resolves to `silence`. No unvalidated word is ever spoken, and
 * no error state ever renders: the quiet is the safe default.
 */
export function chooseOutcome(
  envelope: { outcome?: unknown; audioUrl?: unknown } | null | undefined,
): 'response' | 'silence' {
  if (
    envelope &&
    envelope.outcome === 'response' &&
    typeof envelope.audioUrl === 'string' &&
    (envelope.audioUrl as string).length > 0
  ) {
    return 'response';
  }
  return 'silence';
}

/**
 * Whether a transcript has any content worth sending to the engine. An
 * empty/whitespace transcript (no speech, or STT produced nothing) is the
 * honored-silence path — feature #361 Path B — so the page skips the POST
 * entirely and goes straight to the warm close.
 */
export function hasTranscript(transcript: string | null | undefined): boolean {
  return typeof transcript === 'string' && transcript.trim().length > 0;
}

/**
 * When to reveal the verse block on screen as the response is spoken
 * (feature #361 step 3: "the verse ON SCREEN ... as it is SPOKEN"): after
 * the acknowledgment beat. Durations are best-effort (0 when ffmpeg is
 * absent — openMoment.ts), so a 0/absent acknowledgment reveals the verse
 * immediately rather than stranding a blank panel.
 */
export function verseRevealMs(durations: LiveResponseDurations | null | undefined): number {
  if (durations && typeof durations.acknowledgmentSec === 'number' && durations.acknowledgmentSec > 0) {
    return Math.round(durations.acknowledgmentSec * 1000);
  }
  return 0;
}

/**
 * Releases a captured microphone stream by stopping every track (feature
 * #361: "stop tracks immediately"). Returns the number of tracks stopped so
 * a test can pin the release without a real MediaStream. Null-safe: a page
 * that reached the silence path without ever capturing (mic denied) passes
 * null here and nothing throws.
 */
export function releaseStream(
  stream: { getTracks?: () => Array<{ stop?: () => void }> } | null | undefined,
): number {
  if (!stream || typeof stream.getTracks !== 'function') return 0;
  const tracks = stream.getTracks();
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i];
    if (track && typeof track.stop === 'function') track.stop();
  }
  return tracks.length;
}
