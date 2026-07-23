/**
 * Per-language spoken connective phrases for the TTS script — Epic O
 * (kairos-devotional #311) decision 4, story O4 (#316).
 *
 * ssmlBuilder.ts speaks a handful of fixed connective lines around the
 * generated content: the greeting wrapper, the verse lead-in, the
 * stillness hand-off and re-entry, lectio's "Once more, slower.", and the
 * closing reference recap. Before #316 these were hard-coded English, so
 * a Spanish devotional (Spanish Scripture, Spanish prose, Spanish voice —
 * O2/O3) would still open with "A moment of…" in an es-US voice.
 *
 * WHY A HAND-WRITTEN TABLE AND NOT RUNTIME TRANSLATION
 * These are six short lines per language, fixed at build time — exactly
 * the case where a human-reviewed string table is cheaper AND more honest
 * than machine translation at runtime (which #316 rules out). Per the
 * story's fallback rule, a phrase we could not translate confidently
 * would be dropped for that language rather than shipped wrong or left in
 * English; as it stands every phrase below is translated, with two
 * deliberate structural adaptations noted inline (fr/de/zh greeting, fr
 * verse lead-in) where a literal calque would collide with grammatical
 * gender or elision on an arbitrary generated noun.
 *
 * The table is keyed by `LanguageTag` — the closed six-language enum — so
 * "language with no phrase entries" is unrepresentable at the type level,
 * the same trick language.ts uses for `ttsLocale`.
 */

import type { LanguageTag } from '@kairos/shared-contracts';

export interface SpokenPhrases {
  /**
   * Opening line wrapping the devotional's theme. `theme` arrives already
   * SSML-escaped (as do all interpolated args below) — these functions
   * only ever add fixed, escape-free connective text around it.
   */
  greeting(theme: string): string;
  /** Spoken before the verse text, e.g. "From Matthew 11:28-30." — the listener learns where the passage lives (docs/14 §5.1). */
  verseLeadIn(reference: string): string;
  /** Stillness hand-off spoken before the encoded silence (docs/14 §5.2). */
  readonly stillnessHandOff: string;
  /** Gentle re-entry spoken after the encoded silence. */
  readonly stillnessReturn: string;
  /** Lectio divina's cue before the second, slower verse reading (docs/14 §5.4). */
  readonly lectioOnceMore: string;
  /** Closing recap naming the reference(s), spoken last. */
  referenceRecap(joinedReferences: string): string;
  /** Joins all-but-the-last references when a devotional cites several, e.g. ", ". */
  readonly referenceListSeparator: string;
  /** Joins the penultimate and final references, e.g. " and ". */
  readonly referenceFinalJoiner: string;
}

/**
 * tag -> phrase set. `en` is byte-for-byte the pre-#316 hard-coded text —
 * the acceptance criterion "language 'en' is byte-identical to today"
 * bottoms out in these literals not changing.
 */
export const SPOKEN_PHRASES: Readonly<Record<LanguageTag, SpokenPhrases>> = Object.freeze({
  en: Object.freeze({
    greeting: (theme: string) => `A moment of ${theme}.`,
    verseLeadIn: (reference: string) => `From ${reference}.`,
    stillnessHandOff: "Let's sit with this — I'll keep the time.",
    stillnessReturn: '…still here.',
    lectioOnceMore: 'Once more, slower.',
    referenceRecap: (joined: string) =>
      `That was ${joined} — it'll be here when you want to come back.`,
    referenceListSeparator: ', ',
    referenceFinalJoiner: ' and ',
  }),
  es: Object.freeze({
    greeting: (theme: string) => `Un momento de ${theme}.`,
    verseLeadIn: (reference: string) => `De ${reference}.`,
    stillnessHandOff: 'Quedémonos un momento con esto — yo llevo el tiempo.',
    stillnessReturn: '…aquí sigo.',
    lectioOnceMore: 'Una vez más, más despacio.',
    referenceRecap: (joined: string) => `Eso fue ${joined} — aquí estará cuando quieras volver.`,
    referenceListSeparator: ', ',
    referenceFinalJoiner: ' y ',
  }),
  fr: Object.freeze({
    // Colon apposition instead of «Un moment de {theme}» — «de» would need
    // eliding to «d'» before a vowel-initial theme (d'espoir), and elision
    // rules on an arbitrary generated noun (mute vs aspirated h) are not
    // decidable here. The apposition is natural spoken French and immune.
    greeting: (theme: string) => `Un moment : ${theme}.`,
    // «Dans {reference}» rather than «De {reference}» for the same reason —
    // vowel-initial book names are common (Éphésiens, Actes, Apocalypse)
    // and «de Actes» is wrong; «dans» never elides.
    verseLeadIn: (reference: string) => `Dans ${reference}.`,
    stillnessHandOff: "Restons un instant avec cela — je m'occupe du temps.",
    stillnessReturn: '…je suis toujours là.',
    lectioOnceMore: 'Encore une fois, plus lentement.',
    referenceRecap: (joined: string) =>
      `C'était ${joined} — vous pourrez y revenir quand vous le souhaitez.`,
    referenceListSeparator: ', ',
    referenceFinalJoiner: ' et ',
  }),
  de: Object.freeze({
    // Colon apposition instead of a genitive («Ein Moment der Ruhe») — the
    // genitive article depends on the theme noun's grammatical gender,
    // which an arbitrary generated noun doesn't declare. Same rationale as
    // fr above. Informal "du" in the recap: the established register of
    // German-language devotional apps (incl. YouVersion's German UI).
    greeting: (theme: string) => `Ein Moment: ${theme}.`,
    verseLeadIn: (reference: string) => `Aus ${reference}.`,
    stillnessHandOff: 'Bleiben wir einen Moment dabei — ich achte auf die Zeit.',
    stillnessReturn: '…ich bin noch da.',
    lectioOnceMore: 'Noch einmal, langsamer.',
    referenceRecap: (joined: string) =>
      `Das war ${joined} — du kannst jederzeit dorthin zurückkehren.`,
    referenceListSeparator: ', ',
    referenceFinalJoiner: ' und ',
  }),
  pt: Object.freeze({
    greeting: (theme: string) => `Um momento de ${theme}.`,
    verseLeadIn: (reference: string) => `De ${reference}.`,
    stillnessHandOff: 'Vamos ficar com isso por um instante — eu cuido do tempo.',
    stillnessReturn: '…ainda estou aqui.',
    lectioOnceMore: 'Mais uma vez, mais devagar.',
    referenceRecap: (joined: string) =>
      `Esse foi ${joined} — estará aqui quando você quiser voltar.`,
    referenceListSeparator: ', ',
    referenceFinalJoiner: ' e ',
  }),
  zh: Object.freeze({
    // 「此刻，{theme}。」 — "This moment: {theme}." Apposition again: it
    // reads naturally whether the theme is a bare noun (平安) or a phrase,
    // where a genitive wrapper (「…的时刻」) would not.
    greeting: (theme: string) => `此刻，${theme}。`,
    verseLeadIn: (reference: string) => `出自${reference}。`,
    stillnessHandOff: '让我们在这里安静片刻——我来为你计时。',
    stillnessReturn: '……我还在。',
    lectioOnceMore: '再读一遍，慢一些。',
    referenceRecap: (joined: string) => `刚才读的是${joined}——你想回来时，它都在。`,
    // Chinese enumerates with the enumeration comma 、 and joins the final
    // pair with 和, no surrounding spaces.
    referenceListSeparator: '、',
    referenceFinalJoiner: '和',
  }),
});
