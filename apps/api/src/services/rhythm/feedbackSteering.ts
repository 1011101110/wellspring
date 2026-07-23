/**
 * P7 (#326): feedback → next generation. Turns trailing `session_feedback`
 * rows into nudges on the EXISTING `GenerateDevotionalParams` surface —
 * theme, duration band, time-of-day — for standard-slot, *scheduled*
 * generation only (the daily run opts in via
 * `GenerateNowParams.applyFeedbackSteering`; generate-now, examen,
 * invite, and distress paths never set it).
 *
 * Heuristic v1, deliberately (epic #312 decision #1): every rule below is
 * a threshold a settings sentence could state, every decision is a pure
 * function of its inputs (`decideSteering`), and every applied nudge is
 * logged with its reason — the same explainability bar `decideCadence`
 * holds.
 *
 * ## The one precedence rule, stated once
 *
 * **An explicit user choice always outranks feedback.** Concretely:
 *  - duration is nudged only when the stored preference is `'auto'`
 *    (NULL) — an explicit `duration_preference` passes through untouched;
 *  - the time bias moves a *preference point inside* the user's stated
 *    window and is clamped to `window_start_local..window_end_local` on
 *    every write — the window bounds themselves are the user's hand and
 *    are never widened or moved;
 *  - the steered theme sits at the BOTTOM of the orchestrator's theme
 *    precedence (invite context and prayer intention both outrank it —
 *    see the params-assembly comment in generateNowOrchestrator.ts).
 *
 * ## §9 guardrails
 *
 * Derivation is server-side only; nothing here is client-readable (the
 * `preferred_time_local` column is server-owned, and no `/v1` response
 * carries any of this in this story). The steer changes WHAT is
 * generated, never what the devotional *says about the user*: no count
 * or "because you said…" ever reaches the devotional text — the theme
 * param feeds the same `instructionsBuilder` line a team theme does.
 * The distress path is untouched by construction (it never sets
 * `applyFeedbackSteering`, and `resolveTargetFormat`'s distress→micro
 * floor sits above every duration input anyway).
 */
import type { DevotionalFormat } from '@kairos/shared-contracts';
import type { SteeringFeedbackRow } from '../../db/repositories/sessionFeedbackRepository.js';
import type { VerifiedUserId } from '../../db/repositories/types.js';

/** Trailing window of feedback rows the loader fetches (matches P4's spirit: recent signal only). */
export const FEEDBACK_WINDOW_DAYS = 14;

/** A `topicMore = true` older than this no longer steers the theme — enthusiasm has a shelf life (issue #326: "within 7 days"). */
export const THEME_STEER_MAX_AGE_DAYS = 7;

/**
 * Anti-rut bound (issue #326 acceptance: steer, steer, no-steer): the
 * steer is dropped once the theme has already run this many consecutive
 * recent devotionals — the original devotional the feedback was about
 * plus at most {@link MAX_STEERED_USES} steered repeats.
 */
export const MAX_STEERED_USES = 2;
const MAX_THEME_RUN = MAX_STEERED_USES + 1;

/** How many of the most recent answered rows the 2-of-N length/time rules look at. */
export const FEEL_LOOKBACK = 3;
/** How many of the last {@link FEEL_LOOKBACK} answers must agree before a nudge fires. */
export const FEEL_THRESHOLD = 2;

/** Minutes the preferred time moves per firing of the time rule. */
export const TIME_SHIFT_MINUTES = 30;

/**
 * Why each part of the decision came out the way it did — the
 * explainability channel (logged by the loader, replayable in tests).
 * Codes only, no counts of anything the user did or didn't do.
 */
export type SteeringReason =
  | 'theme_topic_more'
  | 'theme_suppressed_mix_it_up'
  | 'theme_dropped_anti_rut'
  | 'duration_nudge_shorter'
  | 'duration_nudge_longer'
  | 'duration_suppressed_explicit_preference'
  | 'time_shift_earlier'
  | 'time_shift_later'
  | 'time_clamped_to_window';

export interface SteeringDecision {
  /** Carry this devotional theme forward (feeds `GenerateDevotionalParams.theme`). Absent = no steer. */
  theme?: string;
  /** Nudge the auto-resolved duration one band this way. Only ever set when the stored preference is auto. */
  durationNudge?: 'shorter' | 'longer';
  /**
   * The effective preferred slot time (`HH:MM:SS`), already clamped into
   * the user's window — the calendar step orders candidate gaps by
   * distance to it. Absent = no bias (today's longest-gap-first order).
   */
  preferredTimeLocal?: string;
  /** True when `preferredTimeLocal` differs from the stored column and must be persisted. */
  preferredTimeChanged: boolean;
  reasons: SteeringReason[];
}

/** The empty decision — byte-for-byte what zero feedback must produce (the #326 regression criterion). */
export const NO_STEERING: SteeringDecision = Object.freeze({
  preferredTimeChanged: false,
  reasons: [],
});

/**
 * Everything `decideSteering` reads, gathered by the loader. `feedback`
 * and `recentThemes` are both newest-first — the reduction re-sorts
 * feedback defensively (same posture as `computeAttendanceSignals`) but
 * trusts `recentThemes`' order since consecutiveness is its whole meaning.
 */
export interface SteeringInputs {
  now: Date;
  /** Trailing {@link FEEDBACK_WINDOW_DAYS} days of feedback, newest first. */
  feedback: readonly SteeringFeedbackRow[];
  /** Themes of the most recent standard-slot devotionals, newest first (≥ {@link MAX_THEME_RUN} entries suffice). */
  recentThemes: readonly string[];
  /** Stored `duration_preference` — NULL is "auto", the only state the duration nudge may touch. */
  durationPreference: DevotionalFormat | null;
  windowStartLocal: string;
  windowEndLocal: string;
  /** Stored `preferred_time_local`, or null if feedback has never biased the time. */
  preferredTimeLocal: string | null;
}

const MS_PER_DAY = 86_400_000;

/** `'HH:MM'`/`'HH:MM:SS'` → minutes since midnight, or null for anything unparseable. */
export function parseTimeLocal(value: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes since midnight → `'HH:MM:SS'` (seconds always `:00` — same precision the window columns use in practice). */
export function formatTimeLocal(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

/**
 * The 2-of-last-3 tally for a "feel" question. Only ANSWERED rows count
 * toward the lookback — a row where the user skipped the question is not
 * an opinion, so it neither dilutes nor ages out real answers.
 */
function feelMajority<A extends string, B extends string>(
  answers: readonly (string | null)[],
  a: A,
  b: B,
): A | B | null {
  const recent = answers.filter((v): v is string => v !== null).slice(0, FEEL_LOOKBACK);
  const countA = recent.filter((v) => v === a).length;
  const countB = recent.filter((v) => v === b).length;
  if (countA >= FEEL_THRESHOLD) return a;
  if (countB >= FEEL_THRESHOLD) return b;
  return null;
}

/** Length of the leading run of `theme` in a newest-first theme list. */
function leadingThemeRun(recentThemes: readonly string[], theme: string): number {
  let run = 0;
  for (const t of recentThemes) {
    if (t !== theme) break;
    run += 1;
  }
  return run;
}

/**
 * The decision function. Pure — no I/O, no clock reads (`now` arrives as
 * data) — so every threshold is directly mutation-checkable in
 * tests/services/rhythm/feedbackSteering.test.ts.
 */
export function decideSteering(input: SteeringInputs): SteeringDecision {
  const reasons: SteeringReason[] = [];
  const decision: SteeringDecision = { preferredTimeChanged: false, reasons };

  // Newest first — every rule below indexes from the front.
  const feedback = [...input.feedback].sort(
    (x, y) => y.created_at.getTime() - x.created_at.getTime(),
  );

  // ── Theme (issue #326 §1) ──────────────────────────────────────────
  // The newest ANSWERED topic question is the user's current opinion;
  // older answers are superseded, not averaged.
  const topicRow = feedback.find((row) => row.topic_more !== null);
  if (topicRow) {
    if (topicRow.topic_more === false) {
      // "Mix it up": explicitly no theme, and any active steer is
      // suppressed — the absence IS the steer here.
      reasons.push('theme_suppressed_mix_it_up');
    } else {
      const ageDays = (input.now.getTime() - topicRow.created_at.getTime()) / MS_PER_DAY;
      if (ageDays <= THEME_STEER_MAX_AGE_DAYS && topicRow.devotional_theme !== null) {
        // Anti-rut: the run the steer would EXTEND is the leading run of
        // this theme in the recent devotionals — the original devotional
        // the feedback praised counts as its first link, so the steer is
        // dropped once the run reaches 1 + MAX_STEERED_USES (the
        // steer/steer/no-steer shape the acceptance pins). Deterministic:
        // no randomness anywhere, just a run length.
        if (leadingThemeRun(input.recentThemes, topicRow.devotional_theme) >= MAX_THEME_RUN) {
          reasons.push('theme_dropped_anti_rut');
        } else {
          decision.theme = topicRow.devotional_theme;
          reasons.push('theme_topic_more');
        }
      }
    }
  }

  // ── Duration (issue #326 §2) ───────────────────────────────────────
  const lengthMajority = feelMajority(
    feedback.map((row) => row.length_feel),
    'shorter',
    'longer',
  );
  if (lengthMajority) {
    if (input.durationPreference !== null) {
      // The user said a length in words; feedback never silently
      // overrides it (the ceiling principle, same as cadence). The signal
      // surfaces — if anywhere — as settings-card prose, never as a
      // changed param.
      reasons.push('duration_suppressed_explicit_preference');
    } else {
      decision.durationNudge = lengthMajority;
      reasons.push(lengthMajority === 'shorter' ? 'duration_nudge_shorter' : 'duration_nudge_longer');
    }
  }

  // ── Time of day (issue #326 §3) ────────────────────────────────────
  const windowStart = parseTimeLocal(input.windowStartLocal);
  const windowEnd = parseTimeLocal(input.windowEndLocal);
  const stored = input.preferredTimeLocal !== null ? parseTimeLocal(input.preferredTimeLocal) : null;
  // A malformed or inverted window means there is no "inside the window"
  // to bias within — the rule stands down entirely rather than guessing.
  if (windowStart !== null && windowEnd !== null && windowStart < windowEnd) {
    const clamp = (m: number) => Math.min(Math.max(m, windowStart), windowEnd);
    const timeMajority = feelMajority(
      feedback.map((row) => row.time_feel),
      'earlier',
      'later',
    );
    let effective: number | null = null;
    if (timeMajority) {
      // Initialized from the window midpoint — the neutral "somewhere in
      // your window" the bias then walks from — and clamped on EVERY
      // write, so however many consecutive "earlier"s arrive, the value
      // can reach the window edge and never cross it (the user's stated
      // bound is a ceiling the engine works under, never past).
      const base = stored ?? Math.floor((windowStart + windowEnd) / 2);
      const delta = timeMajority === 'earlier' ? -TIME_SHIFT_MINUTES : TIME_SHIFT_MINUTES;
      effective = clamp(base + delta);
      reasons.push(timeMajority === 'earlier' ? 'time_shift_earlier' : 'time_shift_later');
    } else if (stored !== null) {
      // No fresh majority, but an established bias persists — re-clamped
      // in case the user has since narrowed their window (their edit
      // outranks our stored point, immediately).
      effective = clamp(stored);
      if (effective !== stored) reasons.push('time_clamped_to_window');
    }
    if (effective !== null) {
      decision.preferredTimeLocal = formatTimeLocal(effective);
      decision.preferredTimeChanged = effective !== stored;
    }
  }

  return decision;
}

/* ------------------------------------------------------------------ *
 * Loader — the thin I/O shell around decideSteering.
 * ------------------------------------------------------------------ */

/** The narrow repository seams the loader reads/writes — interfaces so tests fake exactly what is consumed. */
export interface FeedbackSteeringDeps {
  feedback: {
    listRecentForSteering(userId: VerifiedUserId, since: Date): Promise<SteeringFeedbackRow[]>;
  };
  devotionals: {
    listRecentThemes(userId: VerifiedUserId, limit: number): Promise<string[]>;
  };
  preferences: {
    get(userId: VerifiedUserId): Promise<{
      duration_preference: DevotionalFormat | null;
      window_start_local: string;
      window_end_local: string;
      preferred_time_local?: string | null;
    } | null>;
    updatePreferredTimeLocal(userId: VerifiedUserId, timeLocal: string): Promise<void>;
  };
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Loads one user's steering inputs, decides, persists the time bias when
 * it moved, and logs what was applied and why. The signature the
 * orchestrator consumes (issue #326):
 * `deriveSteering(userId, { now }) → { theme?, durationNudge?, preferredTimeLocal? }`.
 */
export class FeedbackSteering {
  constructor(private readonly deps: FeedbackSteeringDeps) {}

  async deriveSteering(userId: VerifiedUserId, opts: { now: Date }): Promise<SteeringDecision> {
    const prefs = await this.deps.preferences.get(userId);
    // No preferences row means no window to bias within and (being a
    // brand-new user) no feedback to read — nothing to steer.
    if (!prefs) return NO_STEERING;

    const since = new Date(opts.now.getTime() - FEEDBACK_WINDOW_DAYS * MS_PER_DAY);
    const feedback = await this.deps.feedback.listRecentForSteering(userId, since);
    const storedPreferred = prefs.preferred_time_local ?? null;
    // The common case in the daily fan-out: nothing to steer from and no
    // established bias — skip the themes query and return the canonical
    // empty decision (the zero-feedback regression contract).
    if (feedback.length === 0 && storedPreferred === null) return NO_STEERING;

    const recentThemes = await this.deps.devotionals.listRecentThemes(userId, MAX_THEME_RUN);
    const decision = decideSteering({
      now: opts.now,
      feedback,
      recentThemes,
      durationPreference: prefs.duration_preference,
      windowStartLocal: prefs.window_start_local,
      windowEndLocal: prefs.window_end_local,
      preferredTimeLocal: storedPreferred,
    });

    if (decision.preferredTimeChanged && decision.preferredTimeLocal !== undefined) {
      await this.deps.preferences.updatePreferredTimeLocal(userId, decision.preferredTimeLocal);
    }

    if (decision.reasons.length > 0) {
      // Explainability (#326: "log the applied steering with reasons",
      // the decideCadence standard). Reason codes and the resulting
      // params only — never counts of what the user said or did.
      this.deps.logger?.info('feedback steering derived', {
        userId,
        reasons: decision.reasons,
        theme: decision.theme,
        durationNudge: decision.durationNudge,
        preferredTimeLocal: decision.preferredTimeLocal,
      });
    }

    return decision;
  }
}
