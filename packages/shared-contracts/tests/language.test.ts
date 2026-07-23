import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_CATALOG,
  LANGUAGE_TAGS,
  LanguageTagSchema,
  defaultVersionIdFor,
  isVersionInLanguage,
  versionIdsForLanguage,
} from '../src/language.js';

describe('LANGUAGE_CATALOG (Epic O #311 / O2 #314 — pinned by O1 #313)', () => {
  it('pins the six passage-verified defaults exactly — live-verified 2026-07-23, do not edit from memory', () => {
    // These six ids were each proven with a real passage fetch (JHN.3.16,
    // 200 + text) on our key, not merely catalog-listed. A drifted id here
    // would pass typecheck and fail only in production against YouVersion,
    // so the literal is asserted value-for-value.
    expect(defaultVersionIdFor('en')).toBe(3034); // BSB — today's users.translation_id default
    expect(defaultVersionIdFor('es')).toBe(3365); // spaPdDpt (modern), NOT 147 RVES (archaic)
    expect(defaultVersionIdFor('fr')).toBe(93); // LSG 1910
    expect(defaultVersionIdFor('de')).toBe(51); // DELUT Luther 1912
    expect(defaultVersionIdFor('pt')).toBe(3254); // BLT — only licensed pt option
    expect(defaultVersionIdFor('zh')).toBe(43); // CSBS
  });

  it("zh maps to cmn-CN — zh-CN has ZERO Chirp 3 HD voices and must never be re-derived from the tag", () => {
    // The single most re-derivable-wrong fact in the epic (#311 decision
    // 4): the "obvious" locale for zh is the one with no voices at all.
    expect(LANGUAGE_CATALOG.zh.ttsLocale).toBe('cmn-CN');
    expect(LANGUAGE_CATALOG.zh.ttsLocale).not.toBe('zh-CN');
  });

  it('every language has a TTS locale with live-verified Chirp 3 HD coverage', () => {
    const verifiedLocales = ['en-US', 'es-US', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR', 'cmn-CN'];
    for (const tag of LANGUAGE_TAGS) {
      expect(verifiedLocales).toContain(LANGUAGE_CATALOG[tag].ttsLocale);
    }
  });

  it('the default is always choosable, and every fallback is in-catalog', () => {
    // A default outside its own versionIds would make the snap rule store
    // a value the 400 guard then rejects on round-trip; a fallback outside
    // it would let the O3 error path reach a version no user could pick.
    for (const tag of LANGUAGE_TAGS) {
      const entry = LANGUAGE_CATALOG[tag];
      expect(entry.versionIds).toContain(entry.defaultVersionId);
      for (const fallback of entry.fallbackVersionIds) {
        expect(entry.versionIds).toContain(fallback);
        expect(fallback).not.toBe(entry.defaultVersionId);
      }
    }
  });

  it('no versionId belongs to two languages — membership is what the 400 guard means', () => {
    // isVersionInLanguage(tag, id) is only a coherent gate if an id names
    // one language's translation; a shared id would make "not a {lang}
    // translation" ambiguous.
    const seen = new Map<number, string>();
    for (const tag of LANGUAGE_TAGS) {
      for (const id of versionIdsForLanguage(tag)) {
        expect(seen.has(id), `versionId ${id} in both ${seen.get(id)} and ${tag}`).toBe(false);
        seen.set(id, tag);
      }
    }
  });

  it('en keeps the pre-existing BSB → WEBUS → ASV fallback chain, in order', () => {
    expect(LANGUAGE_CATALOG.en.fallbackVersionIds).toEqual([206, 12]);
  });

  it('pt has an empty fallback chain — fixture, never another language', () => {
    expect(LANGUAGE_CATALOG.pt.fallbackVersionIds).toEqual([]);
  });
});

describe('isVersionInLanguage / LanguageTagSchema — the write-path gates', () => {
  it('accepts a verified alternate and rejects a cross-language id', () => {
    expect(isVersionInLanguage('es', 147)).toBe(true); // RVES — archaic but licensed
    expect(isVersionInLanguage('es', 3034)).toBe(false); // BSB is an en Bible
    expect(isVersionInLanguage('en', 2660)).toBe(true); // LSV, from the 11-version en catalog
    expect(isVersionInLanguage('zh', 3354)).toBe(true); // FEB
    expect(isVersionInLanguage('pt', 147)).toBe(false);
  });

  it('rejects tags outside the six — region-full locales included, per #311 decision 1', () => {
    // Users pick a language, not a region: `es-MX` and `cmn-CN` are wire
    // errors even though they are real BCP-47 tags, because accepting them
    // would fork the stored representation.
    for (const bad of ['es-MX', 'en-US', 'cmn-CN', 'EN', 'spanish', '', 'ja']) {
      expect(LanguageTagSchema.safeParse(bad).success).toBe(false);
    }
    for (const tag of LANGUAGE_TAGS) {
      expect(LanguageTagSchema.safeParse(tag).success).toBe(true);
    }
  });

  it('the default language is en, and it is a member of the catalog it defaults into', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect(LANGUAGE_TAGS).toContain(DEFAULT_LANGUAGE);
  });
});
