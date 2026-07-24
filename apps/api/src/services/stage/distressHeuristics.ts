/**
 * Spoken-distress heuristics for the Open Moment (EPIC V #360 / V2 #363,
 * epic §4). Run over the listener's transcript BEFORE the Gloo turn: when it
 * flags, the response engine forces the 988 comfort variant (a gentle
 * passage + the tested 988 resource line) instead of an ordinary grounded
 * response — "a crisis moment gets comfort, not a prompt to perform"
 * (feature #361).
 *
 * DELIBERATELY CONSERVATIVE and keyword-based. This is a fail-SAFE
 * pre-filter, not a clinical classifier: a false positive costs a listener a
 * gentler-than-necessary answer with a resource line (a non-event); a false
 * negative still passes through the full theological-safety spec on the Gloo
 * turn. It errs toward flagging on explicit self-harm / suicidal-ideation
 * cues and does NOT try to infer distress from ordinary sadness ("I'm
 * anxious", "I'm exhausted") — those get a normal grounded response.
 *
 * HARDENED in V5 (#366): the phrase list was broadened across all six content
 * languages to cover more explicit self-harm / suicidal-ideation cues plus a
 * set of high-confidence crisis / hopelessness phrasings ("no point in
 * living", "can't take it anymore", "want to disappear"). The surface
 * (`detectSpokenDistress`) is unchanged so the engine/route are untouched.
 *
 * DELIBERATE NON-CHANGE — negation handling: the seam once flagged negation
 * suppression ("I would never hurt myself") as V5 work, and it is intentionally
 * NOT added. Suppressing on a nearby negation trades a false POSITIVE (a gentle
 * comfort + resource line — a non-event) for the risk of a false NEGATIVE ("I
 * don't think I can go on") — and a false negative is the only failure this
 * filter exists to prevent. The conservative doctrine above governs: over-
 * flagging is safe, under-flagging is the danger, so we keep flagging.
 */

/**
 * High-precision self-harm / suicidal-ideation cues. English is primary
 * (the demo + STT baseline); a small set of high-confidence phrases in the
 * other five content languages is included so a non-English listener is not
 * silently unprotected. Matched case-insensitively as substrings of a
 * whitespace-normalized transcript — each entry is chosen to be specific
 * enough that a substring match is very unlikely to fire on benign speech.
 */
const DISTRESS_PHRASES: readonly string[] = [
  // English — self-harm / suicidal ideation
  'kill myself',
  'killing myself',
  'kill me',
  'want to die',
  'wanna die',
  'wish i was dead',
  'wish i were dead',
  'want to end it',
  'want it to end',
  'end it all',
  'end my life',
  'ending my life',
  'take my own life',
  'taking my own life',
  'took my own life',
  'suicidal',
  'suicide',
  'hurt myself',
  'hurting myself',
  'harm myself',
  'harming myself',
  'self harm',
  'self-harm',
  'cut myself',
  'cutting myself',
  'hang myself',
  'overdose',
  // English — crisis / hopelessness phrasing (still deliberately explicit,
  // not ordinary sadness — each is chosen to read as crisis, not a bad day)
  "don't want to be here anymore",
  'do not want to be here anymore',
  "don't want to be alive",
  'do not want to be alive',
  "don't want to live",
  'do not want to live',
  'want to disappear',
  "don't want to wake up",
  'do not want to wake up',
  "can't go on",
  'cannot go on',
  "can't take it anymore",
  'cannot take it anymore',
  "can't do this anymore",
  'cannot do this anymore',
  'no reason to live',
  'no point in living',
  'nothing to live for',
  'not worth living',
  'tired of living',
  'give up on life',
  'better off dead',
  'better off without me',
  'everyone would be better off without me',
  // Spanish
  'quiero morir',
  'quiero morirme',
  'no quiero vivir',
  'no quiero seguir viviendo',
  'quitarme la vida',
  'acabar con mi vida',
  'suicidarme',
  'suicidio',
  'matarme',
  'hacerme daño',
  'no vale la pena vivir',
  // French
  'je veux mourir',
  'je ne veux plus vivre',
  'me suicider',
  'suicide',
  'me tuer',
  'en finir avec la vie',
  'je veux en finir',
  'mettre fin à mes jours',
  'me faire du mal',
  'je veux disparaître',
  // German
  'mich umbringen',
  'nicht mehr leben',
  'ich will sterben',
  'selbstmord',
  'mir etwas antun',
  'mir das leben nehmen',
  'mich selbst verletzen',
  // Portuguese
  'quero morrer',
  'não quero viver',
  'não quero mais viver',
  'tirar minha vida',
  'tirar a minha vida',
  'acabar com a minha vida',
  'me matar',
  'suicídio',
  'suicidio',
  'me machucar',
  'não vale a pena viver',
  // Simplified Chinese
  '想死',
  '自杀',
  '结束生命',
  '结束自己的生命',
  '不想活了',
  '活不下去',
  '轻生',
  '伤害自己',
] as const;

/**
 * Returns true when the transcript contains an explicit distress cue.
 * Whitespace is normalized and matching is case-insensitive; an
 * empty/whitespace-only transcript is never flagged (it is the silence
 * path, handled upstream).
 */
export function detectSpokenDistress(transcript: string): boolean {
  const normalized = transcript.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return false;
  return DISTRESS_PHRASES.some((phrase) => normalized.includes(phrase));
}
