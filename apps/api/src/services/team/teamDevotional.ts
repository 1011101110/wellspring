/**
 * Team devotionals — content policy (Epic I / I4, #64, docs/12 §2.2).
 *
 * A team devotional is ONE shared devotional sent to multiple recipients
 * (the multi-attendee `.ics` is I3, #63). Its defining privacy rule: it
 * must NOT use any individual's private health bands. Picking one
 * person's bands and applying them to everyone (nobody consented to their
 * health state shaping a group experience), or aggregating bands across a
 * small team (still attributable), are both out. So this path always
 * generates with `NEUTRAL_DEFAULT_BANDS` — the same neutral profile the
 * base product uses when it has no bands for a user — and the policy is
 * enforced by construction: this function has no `bands` parameter, so a
 * caller cannot inject a personal health signal even by mistake.
 *
 * Content can still vary by the organizer's optional theme (deliberate
 * disclosure, their own words — same doctrine as the invite flow's
 * subject/description, docs/12 §1.2), and by date-driven signals the
 * engine already applies with no personal data (liturgical season).
 *
 * This is the composable generation piece; the trigger (an endpoint that
 * takes an email list + time + optional theme, generates once, and sends
 * one multi-attendee invite) is not built yet — see the Epic I follow-up.
 */
import type { Tradition } from '@kairos/shared-contracts';
import type { DevotionalEngine, GenerateDevotionalResult } from '../devotionalEngine.js';
import { NO_SIGNALS_OBSERVED, type DurationPreference } from '../gloo/instructionsBuilder.js';
import { NEUTRAL_DEFAULT_BANDS } from '../orchestrator/generateNowOrchestrator.js';

export interface GenerateTeamDevotionalParams {
  tradition: Tradition;
  /** Preferred translation label for prose framing, e.g. "BSB". */
  translation: string;
  /** Default YouVersion versionId the model should prefer. */
  preferredVersionId: number;
  /**
   * The organizer's optional thematic focus (e.g. "this week: perseverance").
   * Deliberate disclosure — the organizer's own words, on behalf of the
   * group — never anyone's biometric data. Omitted → a neutral devotional.
   */
  organizerTheme?: string;
  /** ISO date (YYYY-MM-DD) being generated for — enables the liturgical-season line (no personal data). */
  date?: string;
  durationPreference?: DurationPreference;
  liturgicalSeasonsEnabled?: boolean;
}

/**
 * Generates one shared team devotional. **No `bands` parameter by
 * design** — `NEUTRAL_DEFAULT_BANDS` is always used, so no individual's
 * health signal can shape a group experience (docs/12 §2.2). Reuses the
 * same `DevotionalEngine` as every other path; the only difference is the
 * neutral bands and the organizer theme in place of any personalization.
 */
export function generateTeamDevotional(
  engine: DevotionalEngine,
  params: GenerateTeamDevotionalParams,
): Promise<GenerateDevotionalResult> {
  return engine.generate({
    bands: NEUTRAL_DEFAULT_BANDS,
    // Stated explicitly rather than left to the engine's fail-safe default
    // (#196): here the neutral bands are a deliberate privacy choice, not
    // missing data, and either way the devotional must not narrate them as
    // though it had observed the group.
    signalProvenance: NO_SIGNALS_OBSERVED,
    tradition: params.tradition,
    translation: params.translation,
    preferredVersionId: params.preferredVersionId,
    durationPreference: params.durationPreference,
    date: params.date,
    liturgicalSeasonsEnabled: params.liturgicalSeasonsEnabled,
    theme: params.organizerTheme,
    // slotType/lectio/prayerIntention intentionally omitted — a team
    // devotional is a plain shared 'standard' slot with no per-person state.
  });
}
