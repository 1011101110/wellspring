// Language catalog — the six devotional content languages, each pinned to
// the YouVersion versions our app key is actually licensed for and the
// Cloud TTS locale that actually has Chirp 3 HD voices.
// Epic O (kairos-devotional #311), story O2 (#314); catalog literal pinned
// by O1 (#313). Consumers: apps/api/src/routes/userScoped.ts (write path),
// and — as Epic O lands — generateNowOrchestrator (O3) and ttsService (O4).
//
// WHY A STATIC MAP AND NOT THE LIVE CATALOG
// YouVersion can list what our key is licensed for
// (`GET /v1/bibles?language_ranges[]=xx`), but listings can overstate
// licensing — the passage endpoint is where a 403 actually surfaces, and
// our client disambiguates exactly that case. Every default below was
// therefore **passage-verified live on 2026-07-23**: a real
// `GET /v1/bibles/{id}/passages/JHN.3.16?format=text` returned 200 with
// text, on our key. A curated map of proven ids is honest and demo-safe;
// the API-driven catalog is the documented v2 path (O7, #319). Do not add
// a language or version here from memory — re-verify against the live API
// first (same discipline as ALLOWED_VOICE_NAMES in voice.ts).
//
// WHY BCP-47 PRIMARY SUBTAGS, NOT FULL LOCALES
// Users pick a *language*, not a region, and YouVersion's
// `language_ranges[]` takes exactly this shape. The one consumer that
// needs a region — TTS — gets it from `ttsLocale` below, derived here
// precisely so it cannot be re-derived wrong elsewhere: Chirp 3 HD's
// Chinese locale is `cmn-CN` (30 voices), while the "obvious" `zh-CN` has
// ZERO Chirp 3 HD voices (live-verified 2026-07-23). That trap is the
// single strongest argument for this field existing at all.

import { z } from 'zod';

/**
 * The devotional content languages v1 offers (epic #311 decision 1).
 * BCP-47 primary-language subtags, stored verbatim in `users.language`
 * (migration 1722300000000, default `'en'`).
 */
export const LANGUAGE_TAGS = ['en', 'es', 'fr', 'de', 'pt', 'zh'] as const;
export const LanguageTagSchema = z.enum(LANGUAGE_TAGS);
export type LanguageTag = z.infer<typeof LanguageTagSchema>;

/** The language every existing row reads back as — the column default, matching today's behavior exactly. */
export const DEFAULT_LANGUAGE: LanguageTag = 'en';

export interface LanguageCatalogEntry {
  /** Native-script display label — a person picking their own language should not need English to find it. */
  readonly label: string;
  /**
   * The translation a language *change* snaps `users.translation_id` to
   * when no explicit `translationId` rides along (epic #311 decision 2).
   */
  readonly defaultVersionId: number;
  /**
   * Every versionId a user may explicitly choose for this language — the
   * default plus the verified alternates. All passage-verified 2026-07-23
   * except the en list, which is Foundation §4.3's standing 11-version
   * catalog (BSB itself re-verified 2026-07-23).
   */
  readonly versionIds: readonly number[];
  /**
   * The `LICENSE_UNAVAILABLE` retry chain, in order, after
   * `defaultVersionId` fails — generalizing the existing en pattern
   * (BSB 3034 → WEBUS 206 → ASV 12). Where this is empty (pt: BLT is the
   * only licensed option), the O3 error path goes to the fixture fallback,
   * **never to another language** (O1/#313 decision — a wrong-language
   * devotional is worse than an honestly-flagged English one).
   */
  readonly fallbackVersionIds: readonly number[];
  /**
   * The Cloud TTS locale whose Chirp 3 HD voices speak this language.
   * Voice *names* are deliberately NOT listed per language: every locale
   * here carries the same 30 name suffixes (live-verified 2026-07-23), so
   * a user's chosen voice survives a language switch by swapping this
   * prefix onto the suffix they already picked — the locale-swap function
   * itself is O4's (#316), not this file's.
   */
  readonly ttsLocale: string;
}

/**
 * tag → catalog entry, lifted verbatim from O1's pinned literal
 * (kairos-devotional #313; source table in #311, live-verified 2026-07-23).
 */
export const LANGUAGE_CATALOG: Readonly<Record<LanguageTag, LanguageCatalogEntry>> = Object.freeze({
  en: Object.freeze({
    label: 'English',
    defaultVersionId: 3034, // BSB — today's column default, unchanged
    versionIds: Object.freeze([3034, 12, 42, 130, 206, 1207, 1209, 1932, 2163, 2660, 3427]),
    fallbackVersionIds: Object.freeze([206, 12]), // WEBUS, ASV — the pre-existing chain
    ttsLocale: 'en-US',
  }),
  es: Object.freeze({
    label: 'Español',
    // 3365 "Palabra de Dios para ti" (modern), NOT 147 Reina-Valera
    // Antigua — both verified, but RVES is archaic-register Spanish, and
    // a first-time listener should not meet Scripture in wording their
    // grandparents' grandparents would find old (O1/#313 decision).
    defaultVersionId: 3365,
    versionIds: Object.freeze([3365, 147]),
    fallbackVersionIds: Object.freeze([147]),
    ttsLocale: 'es-US',
  }),
  fr: Object.freeze({
    label: 'Français',
    defaultVersionId: 93, // LSG Segond 1910
    versionIds: Object.freeze([93, 62, 131, 64]), // + Martin, Ostervald, Darby
    fallbackVersionIds: Object.freeze([131]), // Ostervald
    ttsLocale: 'fr-FR',
  }),
  de: Object.freeze({
    label: 'Deutsch',
    defaultVersionId: 51, // DELUT Luther 1912
    versionIds: Object.freeze([51, 57, 58, 2351]), // + Elberfelder family
    fallbackVersionIds: Object.freeze([57]),
    ttsLocale: 'de-DE',
  }),
  pt: Object.freeze({
    label: 'Português',
    defaultVersionId: 3254, // BLT Bíblia Livre Para Todos — only licensed pt option
    versionIds: Object.freeze([3254]),
    fallbackVersionIds: Object.freeze([]), // empty chain → fixture, never another language
    ttsLocale: 'pt-BR',
  }),
  zh: Object.freeze({
    label: '中文（简体）',
    defaultVersionId: 43, // CSBS Chinese Standard Bible (Simplified)
    versionIds: Object.freeze([43, 3354]), // + FEB
    fallbackVersionIds: Object.freeze([3354]),
    ttsLocale: 'cmn-CN', // NOT zh-CN — zh-CN has zero Chirp 3 HD voices
  }),
});

/**
 * Human-readable name for every versionId in `LANGUAGE_CATALOG` (O5,
 * kairos-devotional #317): a picker option must never render as a bare
 * number — the same rule the voice picker holds for raw Chirp ids (#302).
 *
 * A single flat map rather than a field per catalog entry, because
 * versionIds are globally unique across languages (asserted in
 * tests/language.test.ts: "no versionId belongs to two languages"), and a
 * per-entry map would invite an id present in `versionIds` but missing a
 * label. Completeness is asserted in the same test file instead.
 *
 * Abbreviations and titles verified 2026-07-23 against bible.com's
 * canonical version pages (`bible.com/versions/{id}-{abbr}-{title}` —
 * same numeric id space as the Platform API), cross-checked with
 * Foundation §4.3's per-language table. Do not add or edit from memory —
 * same discipline as the catalog itself.
 */
export interface VersionLabel {
  /** Short display abbreviation, e.g. `BSB`. */
  readonly abbreviation: string;
  /** Full title, native-script where the translation's own name is (zh). */
  readonly title: string;
}

export const VERSION_LABELS: Readonly<Record<number, VersionLabel>> = Object.freeze({
  // en — Foundation §4.3's standing 11-version catalog
  3034: Object.freeze({ abbreviation: 'BSB', title: 'Berean Standard Bible' }),
  12: Object.freeze({ abbreviation: 'ASV', title: 'American Standard Version' }),
  42: Object.freeze({ abbreviation: 'CPDV', title: 'Catholic Public Domain Version' }),
  130: Object.freeze({ abbreviation: 'TOJB2011', title: 'The Orthodox Jewish Bible' }),
  206: Object.freeze({ abbreviation: 'WEBUS', title: 'World English Bible, American English' }),
  1207: Object.freeze({ abbreviation: 'WMBBE', title: 'World Messianic Bible British Edition' }),
  1209: Object.freeze({ abbreviation: 'WMB', title: 'World Messianic Bible' }),
  1932: Object.freeze({ abbreviation: 'FBV', title: 'Free Bible Version' }),
  2163: Object.freeze({ abbreviation: 'GNV', title: 'Geneva Bible' }),
  2660: Object.freeze({ abbreviation: 'LSV', title: 'Literal Standard Version' }),
  3427: Object.freeze({ abbreviation: 'TCENT', title: 'The Text-Critical English New Testament' }),
  // es
  3365: Object.freeze({ abbreviation: 'PDDPT', title: 'Palabra de Dios para ti' }),
  147: Object.freeze({ abbreviation: 'RVES', title: 'Reina-Valera Antigua' }),
  // fr
  93: Object.freeze({ abbreviation: 'LSG', title: 'Louis Segond 1910' }),
  62: Object.freeze({ abbreviation: 'FMAR', title: 'Martin 1744' }),
  131: Object.freeze({ abbreviation: 'OST', title: 'Ostervald' }),
  64: Object.freeze({ abbreviation: 'JND', title: 'Bible J.N. Darby' }),
  // de
  51: Object.freeze({ abbreviation: 'DELUT', title: 'Lutherbibel 1912' }),
  57: Object.freeze({ abbreviation: 'ELB', title: 'Darby Unrevidierte Elberfelder' }),
  58: Object.freeze({ abbreviation: 'ELB71', title: 'Elberfelder 1871' }),
  2351: Object.freeze({
    abbreviation: 'ELBBK',
    title: 'Elberfelder Übersetzung (bibelkommentare.de)',
  }),
  // pt
  3254: Object.freeze({ abbreviation: 'BLT', title: 'Bíblia Livre Para Todos' }),
  // zh — native-script titles, same choice as the `中文（简体）` language label
  43: Object.freeze({ abbreviation: 'CSBS', title: '中文标准译本' }),
  3354: Object.freeze({ abbreviation: 'FEB', title: '免费的易读圣经' }),
});

/**
 * `3034` → `"Berean Standard Bible (BSB)"` — the shape the web UI already
 * used for its one hard-coded option, and iOS's `TranslationChoice`
 * `displayName`. Total on purpose: an id outside the catalog (a legacy or
 * out-of-band row) degrades to `"Version {id}"` rather than throwing, but
 * client pickers should repair such a value before rendering it (the web
 * client snaps to the language default in `validate`).
 */
export function versionDisplayLabel(versionId: number): string {
  const label = VERSION_LABELS[versionId];
  return label ? `${label.title} (${label.abbreviation})` : `Version ${versionId}`;
}

/** The translation a language *change* snaps `users.translation_id` to (re-asserting the stored language snaps nothing). */
export function defaultVersionIdFor(tag: LanguageTag): number {
  return LANGUAGE_CATALOG[tag].defaultVersionId;
}

/** Every versionId a user may explicitly choose for `tag` (default + verified alternates). */
export function versionIdsForLanguage(tag: LanguageTag): readonly number[] {
  return LANGUAGE_CATALOG[tag].versionIds;
}

/**
 * Whether `versionId` is a translation of `tag` — the write-path gate
 * behind "a translationId outside the chosen language's catalog → 400"
 * (#314). A membership check rather than a lookup-and-compare so the
 * route's guard reads as the rule it enforces.
 */
export function isVersionInLanguage(tag: LanguageTag, versionId: number): boolean {
  return LANGUAGE_CATALOG[tag].versionIds.includes(versionId);
}
