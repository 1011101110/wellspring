/**
 * instructionsBuilder — pure function that compiles the Gloo Responses `instructions`
 * string (the system prompt) for a single devotional generation call.
 *
 * Contract: docs/00_FOUNDATION.md §5 (format heuristics), §7 (tradition enum/framing),
 * §9 (theological safety guardrails — reproduced verbatim below). §4.4 (canonical
 * `get_bible_verse` tool — "never quote Scripture from memory" is restated here too,
 * since `instructions` is the model's only durable reminder of that rule across the
 * tool-calling loop turns).
 *
 * Pure: no I/O, no randomness, no clock reads. Same inputs -> byte-identical string.
 * This determinism is what makes the safety spec and format-target lines snapshot-safe
 * and is required for the theological-QA rubric (docs/07_TEST_PLAN.md §4) to review a
 * stable prompt.
 */

import type { BandInput, DevotionalFormat, SlotType, Tradition } from '@kairos/shared-contracts';
import {
  getLiturgicalSeason,
  liturgicalSeasonInformsGeneration,
  liturgicalSeasonInstructionLine,
} from './liturgicalCalendar.js';

/**
 * User's duration preference. `null`/`undefined` is the "auto" option from the
 * preferences UI (docs/05_UX_FLOWS.md §5: "duration (auto / 2 / 5 / 10 / 15 min)") —
 * meaning the caller has not pinned a format and the band-derived heuristic
 * (Foundation §5) should choose it. A concrete `DevotionalFormat` is an explicit user
 * override of the auto-selected target, EXCEPT that `distressSignal` always wins
 * (Foundation §5 + §9: "Distress lowers volume ... never alarm" is a safety floor,
 * not a preference the user can opt out of).
 */
export type DurationPreference = DevotionalFormat | null | undefined;

/**
 * Which of the signals in `bands` are REAL observations versus
 * `NEUTRAL_DEFAULT_BANDS` placeholders (issue #196 / K10).
 *
 * `BandInput` is a total record — every field always carries a value — so by
 * the time bands reach this builder there is nothing in the data itself that
 * distinguishes "this user's recovery was measured as moderate" from "this
 * user has never granted HealthKit, so recovery defaulted to moderate". The
 * two are byte-identical. That ambiguity is the bug this type exists to close:
 * without it the instructions presented every band under the heading "Today's
 * signals for this user", and the model — correctly reading that as a claim of
 * knowledge — narrated the defaults back as insight. A real generated
 * devotional opened with "There is a particular kind of tiredness ... moderate
 * demands, scattered energy" for a user with no health data at all.
 *
 * Under the calendar-first pivot (PRD §2/§3, Foundation §32) that failure is
 * not cosmetic: the product's entire posture is that a calendar-only user is a
 * complete user, and speaking a hardcoded fallback as an observation both
 * claims knowledge Wellspring does not have and quietly implies the user is
 * missing something. Foundation §9's "no inference of health condition" points
 * the same direction — inventing an observation is the strongest form of it.
 *
 * `busyness` is included deliberately. It is usually a REAL calendar-derived
 * signal (BusynessAnalyzer) and stays real for calendar-connected users even
 * when every health signal is absent — that is exactly the case the pivot
 * cares about, and it must not be suppressed. But when no `daily_bands` row
 * exists at all, busyness falls back to a neutral default like the rest, so
 * provenance has to be tracked per-signal rather than assumed from the
 * health/calendar split.
 */
export interface SignalProvenance {
  recovery: boolean;
  sleepQuality: boolean;
  activity: boolean;
  busyness: boolean;
}

/** Every signal is a real measurement — the fully-personalized case. */
export const ALL_SIGNALS_OBSERVED: SignalProvenance = {
  recovery: true,
  sleepQuality: true,
  activity: true,
  busyness: true,
};

/**
 * Nothing was measured — every band in hand is a `NEUTRAL_DEFAULT_BANDS`
 * placeholder. Used by the paths that generate from neutral bands by design
 * (team devotionals, invite-triggered devotionals) and by any caller with no
 * per-signal knowledge to offer.
 */
export const NO_SIGNALS_OBSERVED: SignalProvenance = {
  recovery: false,
  sleepQuality: false,
  activity: false,
  busyness: false,
};

/**
 * The calendar-first default shape (PRD §5 persona "Maya"): the calendar is
 * connected and real, health is simply absent. This is a complete user, not a
 * degraded one.
 */
export const CALENDAR_ONLY_SIGNALS_OBSERVED: SignalProvenance = {
  recovery: false,
  sleepQuality: false,
  activity: false,
  busyness: true,
};

export interface BuildInstructionsParams {
  tradition: Tradition;
  /** Translation the user prefers, e.g. "BSB" — used only for prose framing; the
   *  actual versionId lookup/enforcement happens elsewhere (YouVersionClient). */
  translation: string;
  bands: BandInput;
  /**
   * Which entries in `bands` are real observations (issue #196 / K10).
   *
   * REQUIRED, and deliberately not defaulted. A default in either direction is
   * wrong: defaulting to "observed" reintroduces exactly the bug — a caller
   * that forgets silently causes the model to narrate hardcoded fallbacks as
   * insight — and defaulting to "not observed" would silently discard real
   * personalization for callers that do have data. Making it required turns
   * "did you think about where these numbers came from?" into a compile error,
   * the same posture `TRADITION_FRAMING`'s exhaustive `Record` takes.
   */
  signalProvenance: SignalProvenance;
  durationPreference?: DurationPreference;
  /** Defaults to 'standard'. 'examen' is the evening reflection (docs/14 §5.3, issue #77). */
  slotType?: SlotType;
  /** Lectio divina mode (docs/14 §5.4, issue #92): a single passage read twice, slowly, with silence between. Defaults to false. Examen still takes priority when both are somehow set, since they represent different daily slots. */
  lectio?: boolean;
  /**
   * ISO date (YYYY-MM-DD) this devotional is being generated for — the
   * caller's already-resolved generation date (docs/14 §5.7, issue #95),
   * passed in rather than read from a clock here to preserve this
   * function's "no clock reads" purity. Required only to render the
   * liturgical-season line below; omitted entirely (no line, no error)
   * when not provided.
   */
  date?: string;
  /**
   * Liturgical-season awareness opt-in (docs/14 §5.7, issue #95). Catholic,
   * mainline, and anglican traditions always see the season line regardless
   * of this flag (see FORCED_LITURGICAL_SEASON_TRADITIONS); evangelical,
   * general, and orthodox see it only when this is true — orthodox is
   * excluded from the forced set on purpose because the computed season is
   * Gregorian and Orthodox paschal reckoning usually differs (#192).
   * Defaults to false.
   */
  liturgicalSeasonsEnabled?: boolean;
  /**
   * The prior day's one-line "anything you're carrying?" response (docs/14
   * §5.5, issue #93), captured on the session-completion page and passed
   * in by the caller (never fetched here — this function stays I/O-free).
   * Woven in as deliberate disclosure — "I remember this, and I'm praying
   * with you" — never surfaced as a problem to analyze or fix
   * (THEOLOGICAL_SAFETY_SPEC's no-shame/no-fixing framing governs this too).
   * Omitted entirely (no line) when not provided.
   */
  prayerIntention?: string;
  /**
   * An optional thematic focus the caller has chosen for this devotional
   * (Epic I / I4, #63/#64, docs/12 §2.2) — e.g. a team organizer's "this
   * week: perseverance". Distinct from `prayerIntention` (which is a
   * personal, remembered disclosure): this is a topical directive that
   * shapes passage selection and reflection. Omitted entirely (no line)
   * when not provided.
   */
  theme?: string;
  /**
   * The user's own words from an event they explicitly invited Wellspring to —
   * the subject + description (Epic I / I2, #62, docs/12 §1.2, Foundation
   * §8 deliberate-disclosure exception). Deliberate disclosure (written FOR
   * Wellspring, like a note to any guest), so unlike the ambient calendar it
   * may shape the devotional — but it carries an ELEVATED safety bar:
   * free-text emotional disclosure is exactly what the §9 guardrails exist
   * for. Framed with extra care below (no analyzing, no fixing, no shame),
   * never surfaced as a problem. Omitted entirely (no line) when not given.
   */
  inviteContext?: string;
}

/**
 * Resolve the target `DevotionalOutput.format` for this generation.
 *
 * Precedence (Foundation §5, read top-to-bottom — first match wins):
 *   1. distressSignal=true            -> always "micro" (safety floor, cannot be overridden)
 *   2. slotType='examen'               -> "micro", or "short" when busyness=heavy (the
 *                                          examen is a brief evening reflection by design —
 *                                          it deliberately bypasses the user's pinned
 *                                          durationPreference, which governs the morning
 *                                          devotional's length, not the examen's)
 *   3. explicit durationPreference     -> user override, honored as-is
 *   4. recovery=low AND busyness=heavy -> "short" (micro/short heuristic; distress
 *                                          already claimed the "micro" case above, so
 *                                          the non-distress low+heavy case lands on
 *                                          "short")
 *   5. busyness=light AND recovery=high -> "extended"
 *   6. default                          -> "standard"
 */
export function resolveTargetFormat(
  bands: BandInput,
  durationPreference?: DurationPreference,
  slotType: SlotType = 'standard',
): DevotionalFormat {
  if (bands.distressSignal) {
    return 'micro';
  }
  if (slotType === 'examen') {
    return bands.busyness === 'heavy' ? 'short' : 'micro';
  }
  if (durationPreference) {
    return durationPreference;
  }
  if (bands.recovery === 'low' && bands.busyness === 'heavy') {
    return 'short';
  }
  // An open calendar is sufficient evidence of capacity on its own (#212).
  //
  // This previously required `recovery === 'high'` as well, which meant the
  // auto heuristic could never reach `extended` without HealthKit — and a
  // browser cannot read HealthKit at all, so under the calendar-first
  // direction (#197) every web user was structurally capped below the
  // "15-minute invitation to go deeper" the PRD promises them. Requiring a
  // biometric to earn a longer devotional also inverts the product's own
  // claim that the calendar is a sufficient signal.
  //
  // Health is still respected when we actually have it: a measured `low`
  // recovery keeps the shorter form, because knowing someone is depleted is
  // a reason to be gentler even on an open day. `moderate` — which is both
  // a real reading and the neutral default for a user with no health data —
  // no longer blocks it. Note this deliberately does NOT distinguish the two
  // (see SignalProvenance, #196): the choice is defensible either way, and
  // treating an unobserved default as "not low" is the reading that keeps
  // calendar-only users whole.
  if (bands.busyness === 'light' && bands.recovery !== 'low') {
    return 'extended';
  }
  return 'standard';
}

/**
 * Theological safety guardrails — Foundation §9, reproduced verbatim (bullet-for-bullet)
 * so instructions text and the source of truth cannot silently drift. If §9 changes,
 * this block must change in the same PR.
 */
const THEOLOGICAL_SAFETY_SPEC = `Theological safety guardrails (non-negotiable):
- No medical diagnosis, treatment claims, or inference of health/spiritual condition.
- No prosperity framing; no shame/guilt framing ("your metrics prove you failed").
- No proof-texting that inverts a passage's meaning.
- Bands are framed as "where your body is today," never as verdict. Tone: companionship, not correction.
- Distress lowers volume: extreme signals trigger gentleness and a resource pointer, never alarm.
- Exact Scripture text always comes from YouVersion via get_bible_verse.`;

/** Restates the canonical-tool rule (Foundation §4.4) as an explicit instruction line. */
const SCRIPTURE_SOURCING_RULE =
  'Never quote Scripture from memory. Always call the get_bible_verse tool to fetch exact, licensed text for every reference before including it in the devotional.';

/**
 * Per-tradition framing (Foundation §7). Typed as an exhaustive
 * `Record<Tradition, string>` deliberately: adding a value to `TraditionSchema`
 * without writing framing for it is a COMPILE error here, not a silent fallback
 * to generic content. That is the failure #192 names as worse than not offering
 * the tradition at all — "a tradition label that produces generically-evangelical
 * content under an Orthodox heading ... misrepresents a tradition to someone who
 * chose it deliberately."
 *
 * Every entry follows the same two-part shape the catholic branch established:
 * what to LEAN INTO, then what to AVOID. Each is reviewed against the #47
 * theological-QA rubric (docs/17_THEOLOGICAL_QA_REVIEW.md) before shipping.
 */
const TRADITION_FRAMING: Record<Tradition, string> = {
  evangelical:
    'Tradition: evangelical. Frame the devotional with a personal-relationship-with-Jesus emphasis, direct application, and confidence in Scripture as immediately authoritative for daily life. Avoid liturgical or denominational jargon.',
  catholic:
    "Tradition: catholic. Frame the devotional in a way that is at home with the Church's teaching, sacramental imagination, and the wider Christian tradition (saints, Church history, and the Mass are welcome touchpoints where natural). Do not contradict Catholic doctrine; avoid language that presumes a sola-scriptura-only frame.",
  mainline:
    'Tradition: mainline. Frame the devotional with a reflective, socially-engaged, and intellectually open tone that welcomes questions and nuance. Avoid triumphalist or certainty-heavy language; make room for mystery and doubt as part of faith.',
  anglican:
    "Tradition: anglican. Frame the devotional in the idiom of common prayer: the Book of Common Prayer, the daily office of Morning and Evening Prayer, the collects, the psalms read in course, and the church year are the native furniture here — formation happens by praying shared, inherited words repeatedly over a lifetime, not by novelty or intensity. Hold the via media honestly: this tradition carries both a catholic inheritance (sacramental life, the creeds, the Church across centuries) and a reformed inheritance (Scripture in the vernacular, salvation by grace), and it declines to resolve that tension in either direction. Avoid language that presumes Roman magisterial authority, and avoid revivalist or altar-call idiom and a purely spontaneous prayer register — a collected, measured, prayer-book cadence is closer to home.",
  orthodox:
    "Tradition: orthodox. Frame the devotional within Eastern Orthodox Christian life: the Church Fathers as living teachers rather than historical citations, theosis (union with God, becoming by grace what Christ is by nature) as the horizon of the Christian life rather than merely forgiveness or self-improvement, the Jesus Prayer and the hesychast tradition of stillness and watchfulness of the heart, icons as windows rather than decoration, fasting as ordinary practice, and the Theotokos and the saints as present company. Assume an ascetic-but-not-joyless register: repentance here means turning toward God, never self-loathing. Note that the Orthodox Old Testament follows the Septuagint, so both its canon and some of its Psalm numbering differ from Western Bibles — do not assert that any Western canon or numbering is simply 'the' Bible, and prefer references that read the same in both. Avoid Western-scholastic framings (merit, satisfaction/penal atonement mechanics), avoid presuming papal authority, and avoid revivalist or altar-call idiom.",
  general:
    'Tradition: general (default). Use warm, ecumenical, broadly-Christian language that does not presume any one tradition\'s vocabulary, doctrine, or worship style. Avoid denomination-specific terms, sacraments, or altar-call language.',
};

/**
 * Appended to the season line only for `orthodox` (see the note on
 * `liturgicalSeasonInformsGeneration`): the computed season is Western, and
 * saying so out loud is the honest alternative to either suppressing the
 * user's explicit opt-in or passing off a Western date as an Orthodox one.
 */
const ORTHODOX_CALENDAR_CAVEAT =
  'That season is computed on the Western (Gregorian) calendar. Orthodox reckoning of Great Lent and Pascha usually differs, so treat the season as general context only — never state or imply a specific date, week, or fast to this listener as though it were the Orthodox one.';

/**
 * Evening examen structure (docs/14 §5.3, issue #77) — an Ignatian
 * gratitude-review-grace-tomorrow reflection, in place of the ordinary
 * expository "choose a passage and unpack it" instruction. Reflective and
 * unhurried in tone: it should reference the day honestly (busyness band
 * included), without shame, and let the day "blur away" less rather than
 * teach a concept.
 *
 * Movement (2) previously read "using the busyness/recovery signals below",
 * which instructed the model to narrate `recovery` unconditionally — including
 * when recovery was a `NEUTRAL_DEFAULT_BANDS` placeholder. For a calendar-only
 * user that turned "honest review" into precisely the dishonesty issue #196
 * names: an examen opening on the listener's supposed tiredness, sourced from a
 * hardcoded constant. It now defers to the provenance markers on the band list.
 */
const EXAMEN_STRUCTURE_INSTRUCTION =
  'This is an EVENING EXAMEN, not an expository devotional. Structure it as a reflective, unhurried walk through four movements: (1) gratitude — invite noticing one specific good thing from today; (2) honest review — name today\'s texture plainly and without shame, e.g. acknowledging a full or heavy day rather than glossing over it, drawing ONLY on the signals below that are real observations and never on one marked NOT OBSERVED (an honest review cannot be built from a placeholder); (3) grace — where might God have been present in it, even quietly, even unnoticed until now; (4) tomorrow — a brief, gentle handing-over of what\'s next, not a to-do list. Still choose ONE specific Bible reference that fits this reflective posture (not an exhortation-heavy one) and weave it into the review/grace movements rather than opening with it.';

/**
 * Lectio divina structure (docs/14 §5.4, issue #92) — the historic
 * lectio/meditatio/oratio/contemplatio pattern: read the passage; silence;
 * read it again slower; one question; prayer; silence. The audio pipeline
 * (ssmlBuilder.ts) handles the two readings, the 20s silence, and the pacing
 * — this instruction's job is just to make the model pick a SINGLE short
 * passage (never a pair — there's no room in this format for two) and
 * produce exactly one meditative question plus a short devotionalBody,
 * since the passage itself carries the weight here, not commentary on it.
 */
const LECTIO_STRUCTURE_INSTRUCTION =
  'This is LECTIO DIVINA, not an expository devotional. Choose exactly ONE specific Bible reference — a single short passage (never a pair or a range spanning multiple ideas) — that the listener will hear read aloud twice, slowly, with silence between the two readings. Keep the devotionalBody very short (a sentence or two at most): the passage itself, heard twice, does the work — this is deliberately not a teaching format. Provide exactly one short, open, meditative journalingPrompt question (not a to-do or analysis prompt) inviting the listener to sit with what they just heard.';

const FORMAT_WORD_TARGETS: Record<DevotionalFormat, string> = {
  micro: 'micro (~2 spoken minutes, 100-200 words)',
  short: 'short (~5 spoken minutes, 250-400 words)',
  standard: 'standard (~10 spoken minutes, 500-750 words)',
  extended: 'extended (~15+ spoken minutes, 900-1300 words)',
};

/**
 * Suffix marking a band the model must NOT treat as knowledge (issue #196).
 * Inline on the band line rather than only in a separate paragraph so the
 * marker cannot be read apart from the value it qualifies.
 */
const UNOBSERVED_MARKER = ' [NOT OBSERVED — neutral default, no data for this signal]';

function describeBandContext(bands: BandInput, provenance: SignalProvenance): string {
  const signal = (label: string, value: string, observed: boolean): string =>
    `- ${label}: ${value}${observed ? '' : UNOBSERVED_MARKER}`;

  const lines = [
    signal('recovery', bands.recovery, provenance.recovery),
    signal('sleepQuality', bands.sleepQuality, provenance.sleepQuality),
    signal('activity', bands.activity, provenance.activity),
    signal('busyness', bands.busyness, provenance.busyness),
    // communicationLoad and distressSignal need no provenance marker: both are
    // self-describing about their own absence. communicationLoad renders "not
    // connected" when null (Foundation §5 models null as a real value), and
    // distressSignal is a manual check-in flag whose `false` means "not
    // flagged", never "unmeasured".
    `- communicationLoad: ${bands.communicationLoad ?? 'not connected'}`,
    `- distressSignal: ${bands.distressSignal}`,
  ];
  return lines.join('\n');
}

/**
 * Emitted whenever at least one signal is a neutral default (issue #196 / K10).
 *
 * The band list alone is not enough. Marking a line "[NOT OBSERVED]" tells the
 * model what the value is, but not what to DO about it — and the failure mode
 * here is not the model stating "recovery: moderate" outright, it is the model
 * dressing a placeholder up as perception ("a particular kind of tiredness",
 * "scattered energy"). So the rule is stated as a behavioral instruction, and
 * it is phrased as "write as if the signal were absent" rather than "don't
 * mention it", because the latter is satisfiable by paraphrase.
 *
 * The complementary half matters just as much: the observed signals are named
 * as still-usable. A calendar-connected user with no health data has a real
 * `busyness` band, and over-correcting into a generic devotional would trade
 * one dishonesty for a different failure — PRD §2's "a user who connects only
 * a calendar is a complete user, not a degraded one".
 */
function signalHonestyInstruction(provenance: SignalProvenance): string | null {
  const unobserved = (
    [
      ['recovery', provenance.recovery],
      ['sleepQuality', provenance.sleepQuality],
      ['activity', provenance.activity],
      ['busyness', provenance.busyness],
    ] as const
  )
    .filter(([, observed]) => !observed)
    .map(([label]) => label);

  if (unobserved.length === 0) {
    return null;
  }

  const observed = (
    [
      ['recovery', provenance.recovery],
      ['sleepQuality', provenance.sleepQuality],
      ['activity', provenance.activity],
      ['busyness', provenance.busyness],
    ] as const
  )
    .filter(([, isObserved]) => isObserved)
    .map(([label]) => label);

  const observedClause =
    observed.length > 0
      ? ` Only these signals are real observations you may reflect: ${observed.join(', ')}. Personalize from those with full confidence — they are genuine, and a user who shares only these is fully known to you in the ways that matter here, not a partial user.`
      : ' No signal here is a real observation. Write a devotional that does not claim to know anything about this particular day or body at all.';

  return `SIGNAL PROVENANCE (non-negotiable): the following are NOT observations — they are neutral placeholder values used because Wellspring has no data for them: ${unobserved.join(', ')}. You have not measured, seen, or inferred anything about them. Do not describe them, allude to them, or open the devotional with a characterization of the listener's tiredness, rest, energy, sleep, or physical state derived from them. Write as though those signals were simply absent, not as though they read "average" — narrating a default back to the listener as if it were noticed is a false claim of knowledge and is never acceptable.${observedClause}`;
}

/**
 * Builds the full `instructions` string sent as the Gloo Responses `instructions`
 * field (Foundation §4.2, API spec §2.1/§2.3). Pure function: identical inputs always
 * produce an identical string.
 */
export function buildInstructions(params: BuildInstructionsParams): string {
  const { tradition, translation, bands, durationPreference, signalProvenance } = params;
  const slotType: SlotType = params.slotType ?? 'standard';
  const lectio = params.lectio ?? false;
  const targetFormat = resolveTargetFormat(bands, durationPreference, slotType);
  const showLiturgicalSeason =
    params.date !== undefined &&
    liturgicalSeasonInformsGeneration(tradition, params.liturgicalSeasonsEnabled ?? false);

  const sections = [
    'You are the devotional engine for Wellspring, a calendar-scheduled spoken devotional. You generate ONE short, personal devotional for a single user based only on the qualitative signals below — you never see their name, calendar contents, or raw health data.',
    TRADITION_FRAMING[tradition],
    showLiturgicalSeason
      ? tradition === 'orthodox'
        ? `${liturgicalSeasonInstructionLine(getLiturgicalSeason(params.date!))} ${ORTHODOX_CALENDAR_CAVEAT}`
        : liturgicalSeasonInstructionLine(getLiturgicalSeason(params.date!))
      : null,
    `Preferred Bible translation: ${translation}.`,
    `Today's signals for this user:\n${describeBandContext(bands, signalProvenance)}`,
    // Placed immediately after the band list, before any of the optional
    // context lines: the model must read the provenance qualifier while the
    // values are still in view (issue #196).
    signalHonestyInstruction(signalProvenance),
    params.prayerIntention
      ? `Yesterday, this user shared one thing they're carrying: "${params.prayerIntention}". Weave an awareness of this into the devotional gently and briefly — you are remembering with them and praying with them, not analyzing, advising, or "solving" it. Never present it back as a problem to fix or a metric to react to; a single quiet acknowledgment (in the devotionalBody or the prayer) that they are not carrying it alone is enough.`
      : null,
    params.theme
      ? `Center this devotional on the theme that was chosen for it: "${params.theme}". Let it shape the passage selection and the reflection, held with the same gentleness and non-prescriptive tone as everything else — a focus, not an agenda.`
      : null,
    params.inviteContext
      ? `For this devotional, the user wrote — in their own words, on the invitation they sent Wellspring — the following: "${params.inviteContext}". They shared this deliberately, for you to hold. Let it shape the devotional gently. If there is any weight, difficulty, or emotion in it, respond with the same non-shaming, non-fixing gentleness the safety guardrails require — never analyzing it, advising on it, or presenting it back as a problem to solve. A single quiet acknowledgment that they are not alone in it is enough.`
      : null,
    `Target format: ${targetFormat} — ${FORMAT_WORD_TARGETS[targetFormat]}. Match the devotionalBody length to this format.`,
    bands.distressSignal
      ? 'This user has flagged elevated distress. Keep the devotional to the micro format, gentle-comfort theme, low-pressure tone, and include this resource once, gently: in the US, you can call or text 988 (the Suicide & Crisis Lifeline) anytime for free, confidential support. Offer it as a quiet option, without diagnosing or dramatizing.'
      : null,
    slotType === 'examen'
      ? EXAMEN_STRUCTURE_INSTRUCTION
      : lectio
        ? LECTIO_STRUCTURE_INSTRUCTION
        : 'Choose ONE (or a short connected pair of) specific Bible reference(s) that fits these signals.',
    SCRIPTURE_SOURCING_RULE,
    THEOLOGICAL_SAFETY_SPEC,
    'Output must conform to the DevotionalOutput JSON schema provided in this request (format, theme, verses, devotionalBody, cardSummary, prayer, and journalingPrompt/actionStep where applicable for this format).',
  ].filter((section): section is string => section !== null);

  return sections.join('\n\n');
}
