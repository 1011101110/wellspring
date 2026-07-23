import { describe, expect, it } from 'vitest';
import {
  ALLOWED_VOICE_NAMES,
  DEFAULT_VOICE_NAME,
  VOICE_CATALOG,
  VOICE_LABELS,
  localizeVoiceName,
  resolveVoiceName,
} from '../src/voice.js';
import { LANGUAGE_CATALOG, LANGUAGE_TAGS } from '../src/language.js';

describe('resolveVoiceName (issue #202)', () => {
  it('maps every iOS picker label to a real Chirp 3 HD voice id', () => {
    // The load-bearing case: iOS stores `warm`/`calm`/`bright`, which Cloud
    // TTS would reject outright. Every label must resolve, or that user
    // silently loses audio.
    for (const label of VOICE_LABELS) {
      const resolved = resolveVoiceName(label);
      expect(resolved).not.toBeNull();
      expect(resolved).toMatch(/^en-US-Chirp3-HD-/);
      expect(resolved).toBe(VOICE_CATALOG[label]);
    }
  });

  it('distinct labels resolve to distinct voices — the picker is not cosmetic', () => {
    const resolved = VOICE_LABELS.map((l) => resolveVoiceName(l));
    expect(new Set(resolved).size).toBe(VOICE_LABELS.length);
  });

  it('passes through a real voice id that is in the allowed set', () => {
    // Both representations genuinely occur in the column: the migration
    // default is an id, iOS pushes labels.
    expect(resolveVoiceName(DEFAULT_VOICE_NAME)).toBe(DEFAULT_VOICE_NAME);
    expect(resolveVoiceName(VOICE_CATALOG.bright)).toBe(VOICE_CATALOG.bright);
  });

  it('returns null for anything outside the allowed set, so callers can log the fallback', () => {
    // Null rather than a silent default: the point of #193/#202 is that
    // "we ignored your choice" must be observable.
    expect(resolveVoiceName('not-a-real-voice')).toBeNull();
    expect(resolveVoiceName('en-US-Chirp3-HD-NotAStar')).toBeNull();
    expect(resolveVoiceName('')).toBeNull();
    expect(resolveVoiceName(null)).toBeNull();
    expect(resolveVoiceName(undefined)).toBeNull();
  });

  it('the default voice is itself allowed — the fallback can never be invalid', () => {
    expect(ALLOWED_VOICE_NAMES).toContain(DEFAULT_VOICE_NAME);
  });
});

describe('localizeVoiceName (story O4 #316)', () => {
  it('re-homes every allowed voice into every catalog locale, keeping the suffix', () => {
    // The whole premise of the locale swap (epic #311 decision 4): Chirp 3 HD
    // uses identical name suffixes across locales (live-verified 2026-07-23),
    // so a user's chosen voice survives a language switch as prefix + same
    // suffix — for ALL six languages, not just the ones a test happened to
    // spot-check.
    for (const tag of LANGUAGE_TAGS) {
      const locale = LANGUAGE_CATALOG[tag].ttsLocale;
      for (const name of ALLOWED_VOICE_NAMES) {
        const suffix = name.split('Chirp3-HD-')[1];
        expect(localizeVoiceName(name, locale)).toBe(`${locale}-Chirp3-HD-${suffix}`);
      }
    }
  });

  it('Chinese lands on cmn-CN, never zh-CN — the locale that actually has Chirp 3 HD voices', () => {
    // zh-CN has ZERO Chirp 3 HD voices (live-verified 2026-07-23); cmn-CN has
    // 30. The catalog encodes this so it cannot be re-derived wrong, and this
    // test pins the two facts together: the zh entry IS cmn-CN, and swapping
    // through it produces a cmn-CN name.
    expect(LANGUAGE_CATALOG.zh.ttsLocale).toBe('cmn-CN');
    const swapped = localizeVoiceName(DEFAULT_VOICE_NAME, LANGUAGE_CATALOG.zh.ttsLocale);
    expect(swapped).toBe('cmn-CN-Chirp3-HD-Achernar');
    expect(swapped.startsWith('zh-CN')).toBe(false);
  });

  it('swapping into en-US is the identity for every allowed voice — en output stays byte-identical', () => {
    for (const name of ALLOWED_VOICE_NAMES) {
      expect(localizeVoiceName(name, LANGUAGE_CATALOG.en.ttsLocale)).toBe(name);
    }
  });

  it('parses a three-letter-language source locale (cmn-CN) back out — the swap round-trips', () => {
    // The locale group must accept cmn-CN on the INPUT side too, or a voice
    // already localized to Chinese could never follow the user back to
    // another language.
    expect(localizeVoiceName('cmn-CN-Chirp3-HD-Kore', 'en-US')).toBe('en-US-Chirp3-HD-Kore');
  });

  it('keeps a multi-part suffix intact rather than truncating at the first dash', () => {
    expect(localizeVoiceName('en-US-Chirp3-HD-Some-Star', 'de-DE')).toBe(
      'de-DE-Chirp3-HD-Some-Star',
    );
  });

  it('returns a non-Chirp3-HD name unchanged — a configured off-catalog voice is not mangled', () => {
    // TtsService's constructor deliberately accepts deployment-configured
    // voices outside the catalog; forcing one into a locale it may not exist
    // in would trade working audio for AUDIO_UNAVAILABLE.
    expect(localizeVoiceName('en-GB-Neural2-A', 'de-DE')).toBe('en-GB-Neural2-A');
    expect(localizeVoiceName('warm', 'de-DE')).toBe('warm');
    expect(localizeVoiceName('', 'de-DE')).toBe('');
  });
});
