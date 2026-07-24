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
 * SEAM FOR V5 (#366): the red-team safety suite owns hardening this — richer
 * multilingual coverage, negation handling ("I would never hurt myself"),
 * and adversarial phrasing. Keep the surface (`detectSpokenDistress`) stable
 * so V5 can strengthen the body without touching the engine/route.
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
  // English
  'kill myself',
  'killing myself',
  'want to die',
  'wanna die',
  'want to end it',
  'end my life',
  'ending my life',
  'take my own life',
  'taking my own life',
  'suicidal',
  'suicide',
  'hurt myself',
  'harm myself',
  'harming myself',
  'self harm',
  'self-harm',
  "don't want to be here anymore",
  'do not want to be here anymore',
  "can't go on",
  'cannot go on',
  'no reason to live',
  'better off dead',
  'better off without me',
  // Spanish
  'quiero morir',
  'quitarme la vida',
  'suicidarme',
  'suicidio',
  'hacerme daño',
  // French
  'je veux mourir',
  'me suicider',
  'suicide',
  'en finir avec la vie',
  'me faire du mal',
  // German
  'mich umbringen',
  'nicht mehr leben',
  'selbstmord',
  'mir etwas antun',
  // Portuguese
  'quero morrer',
  'tirar minha vida',
  'me matar',
  'suicídio',
  'suicidio',
  'me machucar',
  // Simplified Chinese
  '想死',
  '自杀',
  '结束生命',
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
