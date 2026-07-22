import { describe, expect, it } from 'vitest';
import {
  ALLOWED_VOICE_NAMES,
  DEFAULT_VOICE_NAME,
  VOICE_CATALOG,
  VOICE_LABELS,
  resolveVoiceName,
} from '../src/voice.js';

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
