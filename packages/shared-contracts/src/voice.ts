// Voice catalog — the allowed set of Cloud TTS voices, and the mapping
// from what the iOS picker stores to what Cloud TTS will actually accept.
// Issue #202 (epic #186); consumers: apps/api/src/services/tts/ttsService.ts,
// apps/api/src/services/orchestrator/generateNowOrchestrator.ts.
//
// WHY THIS FILE EXISTS
// Before #202 there was no allowed set anywhere in the repo. The column is
// `voice text NOT NULL DEFAULT 'en-US-Chirp3-HD-Achernar'` (migrations
// 1720000000000, 1720800000000), the wire schema is `z.string().min(1).max(200)`
// (api/preferences.ts), and the iOS picker
// (apps/ios/Wellspring/Models/OnboardingPreferences.swift, `VoiceChoice`) stores
// `warm` / `calm` / `bright` — semantic labels that are NOT valid Cloud TTS
// voice names. `HTTPPreferencesClient.swift`'s own doc comment acknowledges
// this mismatch and declares it out of scope; it was harmless precisely
// because nothing ever read the column.
//
// #202 makes it harmful. Wiring `preferences.voice` through to
// texttospeech.googleapis.com means an iOS user's stored `warm` would be sent
// verbatim as a voice name, Cloud TTS would reject it, and TtsService would
// raise AUDIO_UNAVAILABLE — every iOS user silently loses audio. Worse, the
// pull path (`VoiceChoice(rawValue: data.voice) ?? .warm`) never matches a real
// voice id, so any iOS user who opens the preferences screen once rewrites the
// column from a valid id to `warm`. The label mapping below is therefore not
// defensive polish; it is the thing that makes wiring the column through safe.

import { z } from 'zod';

/**
 * The labels the iOS picker offers (docs/05_UX_FLOWS.md §2 screen 5,
 * "2-3 choices with 3-s preview"). Kept in lockstep with `VoiceChoice`
 * in apps/ios/Wellspring/Models/OnboardingPreferences.swift — if a case is
 * added there it must be added here, or the new choice resolves to the
 * default and the picker silently lies again.
 */
export const VOICE_LABELS = ['warm', 'calm', 'bright'] as const;
export const VoiceLabelSchema = z.enum(VOICE_LABELS);
export type VoiceLabel = z.infer<typeof VoiceLabelSchema>;

/**
 * The voice every user hears today. Canonical per docs/14 §3.5 / issue #89:
 * `TtsService`'s own DEFAULT_VOICE won over the older column default
 * (`en-US-Chirp3-HD-Kore`), and migration 1720800000000 brought the column
 * into agreement with it. Anything unrecognized falls back here.
 */
export const DEFAULT_VOICE_NAME = 'en-US-Chirp3-HD-Achernar';

/**
 * Label -> real Chirp 3 HD voice id.
 *
 * On the choice of ids: all three are voices this repo already names, rather
 * than picks pulled from the wider 30-voice `en-US-Chirp3-HD-*` catalog that
 * ttsService.ts's header live-verified on 2026-07-02. `warm` is deliberately
 * pinned to Achernar — the shipped default — so that wiring this up does NOT
 * change the audio any existing user hears: the iOS pull path already coerces
 * every unrecognized stored value to `.warm`, so `warm` is what the majority
 * of rows will say, and mapping it to the current default keeps today's output
 * byte-identical for them. `calm` is Kore, the previous column default
 * (migration 1720800000000). `bright` is Zubenelgenubi.
 *
 * CAVEAT worth carrying forward: the label -> id assignment for `calm` and
 * `bright` is a structural placeholder, not an acoustic judgement — nobody has
 * sat down and listened to confirm that Kore reads as "calm" or Zubenelgenubi
 * as "bright". The wiring is correct and safe either way; if a listening pass
 * disagrees, change the two ids here and nothing else moves.
 */
export const VOICE_CATALOG: Readonly<Record<VoiceLabel, string>> = Object.freeze({
  warm: DEFAULT_VOICE_NAME,
  calm: 'en-US-Chirp3-HD-Kore',
  bright: 'en-US-Chirp3-HD-Zubenelgenubi',
});

/**
 * The allow-list checked before a voice name reaches Cloud TTS.
 *
 * Deliberately the set the product actually offers, not all 30 `en-US-Chirp3-HD-*`
 * voices: a value outside this set cannot have come from the picker, so honoring
 * it would mean synthesizing in a voice no user could have chosen and no test
 * covers. Broadening this to the full catalog is a real option, but it needs a
 * fresh live `voices.list` verification pass (the last one is dated 2026-07-02
 * in ttsService.ts's header) — do not widen it from memory.
 */
export const ALLOWED_VOICE_NAMES: readonly string[] = Object.freeze(Object.values(VOICE_CATALOG));

/**
 * Resolves whatever is sitting in `preferences.voice` to a voice name Cloud TTS
 * will accept, or `null` when the stored value is unrecognized.
 *
 * Accepts BOTH representations on purpose, because both are genuinely present in
 * the column: real voice ids (the column default, and any row written before the
 * iOS picker touched it) and picker labels (`warm`/`calm`/`bright`, what iOS
 * pushes today). Returning `null` rather than silently defaulting keeps the
 * "we ignored your choice" case observable — the orchestrator logs it (#202
 * acceptance: a bad name must not fail generation, but it must not be invisible
 * either).
 */
export function resolveVoiceName(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const label = VoiceLabelSchema.safeParse(stored);
  if (label.success) return VOICE_CATALOG[label.data];
  return ALLOWED_VOICE_NAMES.includes(stored) ? stored : null;
}
