/**
 * TtsService — Google Cloud Text-to-Speech synthesis for a DevotionalOutput.
 * EPIC D, issue #29. Contract: docs/00_FOUNDATION.md §6, §10;
 * docs/03_API_INTEGRATION_SPEC.md §6.
 *
 *   POST https://texttospeech.googleapis.com/v1/text:synthesize
 *   Auth: service-account ADC on Cloud Run; locally, `gcloud auth
 *   application-default login` + a quota project set on the ADC file
 *   (`gcloud auth application-default set-quota-project <project>`) — no
 *   .env credential needed, this is NOT one of the Gloo/YouVersion secrets.
 *
 * Voice: Chirp 3 HD — live-verified 2026-07-02 against the real
 * texttospeech.googleapis.com voices.list: 30 `en-US-Chirp3-HD-*` voices
 * exist, and SSML (including `<break>` tags) IS honored by Chirp3-HD
 * (live-synthesized a 2s-break sample and confirmed audio duration grew by
 * ~2s vs the no-break control) — resolves the "Must confirm" flag in API
 * spec §6; no fallback to Studio/Neural2 was needed.
 *
 * `audioConfig`: MP3, speakingRate 0.95 (gentle pacing, API spec §6).
 *
 * Long scripts: `extended` devotionals can exceed the ~5000-byte SSML
 * request limit. `buildDevotionalSsmlSegments` (ssmlBuilder.ts) splits on
 * section boundaries when needed; `synthesize` synthesizes each segment and
 * concatenates the resulting MP3 buffers (valid for MP3 — sequential frames
 * concatenate into a single playable stream, same approach the spec calls
 * for in §6 "Long scripts").
 */

import {
  DEFAULT_LANGUAGE,
  LANGUAGE_CATALOG,
  localizeVoiceName,
  resolveVoiceName,
  type DevotionalOutput,
  type LanguageTag,
  type Stillness,
} from '@kairos/shared-contracts';
import { buildDevotionalSsmlSegments } from './ssmlBuilder.js';

/** Canonical error code for TTS failure — Foundation §4.5 / §6 error-code list. */
export const AUDIO_UNAVAILABLE = 'AUDIO_UNAVAILABLE' as const;

export class TtsServiceError extends Error {
  readonly code = AUDIO_UNAVAILABLE;
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TtsServiceError';
  }
}

export interface SynthesizeResult {
  /** Concatenated MP3 bytes for the full devotional script. */
  audio: Buffer;
  /** Number of SSML segments synthesized (1 unless the script needed splitting — API spec §6). */
  segmentCount: number;
  /** Total SSML input characters sent to Cloud TTS across all segments — for cost-smoke logging (issue #29 acceptance). */
  charCount: number;
  voiceName: string;
}

/**
 * Minimal shape of the subset of `@google-cloud/text-to-speech`'s
 * `TextToSpeechClient` this service actually uses, so tests can inject a
 * fake client without touching real GCP credentials or network.
 */
export interface TtsClientLike {
  synthesizeSpeech(request: {
    input: { ssml: string };
    voice: { languageCode: string; name: string };
    audioConfig: { audioEncoding: 'MP3'; speakingRate: number };
  }): Promise<[{ audioContent: Uint8Array | string | null | undefined }]>;
}

export interface TtsServiceOptions {
  client?: TtsClientLike;
  /** Chirp 3 HD voice name, e.g. "en-US-Chirp3-HD-Achernar". Live-verified list, see file header. */
  voiceName?: string;
  languageCode?: string;
  /** Gentle pacing — API spec §6: speakingRate 0.95. */
  speakingRate?: number;
  /** Max SSML input bytes per segment before splitting (API spec §6 "Long scripts"). */
  maxSegmentBytes?: number;
}

const DEFAULT_VOICE = 'en-US-Chirp3-HD-Achernar';
const DEFAULT_LANGUAGE_CODE = 'en-US';
const DEFAULT_SPEAKING_RATE = 0.95;
const DEFAULT_MAX_SEGMENT_BYTES = 4500;

export class TtsService {
  private readonly voiceName: string;
  private readonly languageCode: string;
  private readonly speakingRate: number;
  private readonly maxSegmentBytes: number;
  private clientPromise: Promise<TtsClientLike> | undefined;
  private readonly injectedClient: TtsClientLike | undefined;

  constructor(options: TtsServiceOptions = {}) {
    this.injectedClient = options.client;
    this.voiceName = options.voiceName ?? DEFAULT_VOICE;
    this.languageCode = options.languageCode ?? DEFAULT_LANGUAGE_CODE;
    this.speakingRate = options.speakingRate ?? DEFAULT_SPEAKING_RATE;
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
  }

  /** Lazily constructs the real `TextToSpeechClient` (ADC auth) unless a fake client was injected for tests. */
  private async getClient(): Promise<TtsClientLike> {
    if (this.injectedClient) return this.injectedClient;
    if (!this.clientPromise) {
      this.clientPromise = import('@google-cloud/text-to-speech').then(({ TextToSpeechClient }) => {
        return new TextToSpeechClient() as unknown as TtsClientLike;
      });
    }
    return this.clientPromise;
  }

  /**
   * Synthesizes the full spoken devotional script (greeting, verses +
   * spoken attribution, body, prayer) to a single concatenated MP3 buffer.
   * Never throws for expected upstream failure (auth/permission/quota/
   * network) — surfaces as `TtsServiceError` (AUDIO_UNAVAILABLE) so callers
   * can degrade to transcript-first (Architecture §4) instead of a 500.
   */
  async synthesize(
    devotional: DevotionalOutput,
    stillness: Stillness = 'off',
    lectio = false,
    voiceName?: string,
    language?: LanguageTag,
  ): Promise<SynthesizeResult> {
    // Per-request voice (#202). Before this, the voice came only from the
    // constructor, so `preferences.voice` had no path to Cloud TTS at all and
    // every user heard the deployment default regardless of what they picked.
    //
    // Validated here rather than trusted from the caller because this is a
    // public entry point: an unrecognized name would be rejected by Cloud TTS
    // and surface as AUDIO_UNAVAILABLE, costing the user their audio over a
    // stale preference. Degrading to the configured default instead is the
    // #202 acceptance criterion ("a bad name should not fail generation").
    // Absent argument = keep the constructor voice, so existing callers that
    // pass three arguments are unaffected.
    const requestedVoice = voiceName === undefined ? this.voiceName : resolveVoiceName(voiceName);
    const canonicalVoice = requestedVoice ?? this.voiceName;

    // Per-request language (Epic O #311 decision 4, story O4 #316), same
    // absent-argument contract as the voice above: existing four-argument
    // callers keep the constructor languageCode and the canonical (en-US)
    // voice byte-for-byte.
    //
    // The caller passes the user's LANGUAGE (the BCP-47 primary subtag in
    // `users.language`), not a TTS locale — the locale is looked up here via
    // the catalog's `ttsLocale` so the zh -> cmn-CN trap (`zh-CN` has ZERO
    // Chirp 3 HD voices) is decided in exactly one place (language.ts) and
    // cannot be re-derived wrong at a call site. Validation happened on the
    // canonical en-US form above; the locale swap comes LAST, so an es user
    // with voice `warm` hears `es-US-Chirp3-HD-Achernar` — same voice
    // suffix, their language (suffix parity across locales live-verified
    // 2026-07-23, see localizeVoiceName).
    const languageCode =
      language === undefined ? this.languageCode : LANGUAGE_CATALOG[language].ttsLocale;
    const effectiveVoice =
      language === undefined ? canonicalVoice : localizeVoiceName(canonicalVoice, languageCode);
    const segments = buildDevotionalSsmlSegments(
      devotional,
      this.maxSegmentBytes,
      stillness,
      lectio,
      language ?? DEFAULT_LANGUAGE,
    );
    let client: TtsClientLike;
    try {
      client = await this.getClient();
    } catch (err) {
      throw new TtsServiceError(
        `Failed to initialize Cloud TTS client: ${(err as Error).message}`,
        err,
      );
    }

    const buffers: Buffer[] = [];
    let charCount = 0;

    for (const ssml of segments) {
      charCount += ssml.length;
      try {
        const [response] = await client.synthesizeSpeech({
          input: { ssml },
          voice: { languageCode, name: effectiveVoice },
          audioConfig: { audioEncoding: 'MP3', speakingRate: this.speakingRate },
        });
        const content = response.audioContent;
        if (!content || content.length === 0) {
          throw new Error('Cloud TTS returned empty audioContent');
        }
        buffers.push(
          typeof content === 'string' ? Buffer.from(content, 'base64') : Buffer.from(content),
        );
      } catch (err) {
        throw new TtsServiceError(`Cloud TTS synthesis failed: ${(err as Error).message}`, err);
      }
    }

    return {
      audio: Buffer.concat(buffers),
      segmentCount: segments.length,
      charCount,
      // The voice actually synthesized with, not the one requested — so a
      // caller (and the orchestrator's success log) can see when a stale
      // preference was silently degraded to the default (#202). Post-#316
      // this is the locale-swapped name (e.g. `es-US-Chirp3-HD-Achernar`),
      // i.e. what Cloud TTS was actually asked for — never an en-US name
      // dressed up as a Spanish synthesis or vice versa.
      voiceName: effectiveVoice,
    };
  }
}
