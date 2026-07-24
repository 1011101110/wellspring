/**
 * Server-rendered HTML for the session page (EPIC D, issue #31).
 * Contract: docs/05_UX_FLOWS.md §4 ("Web session page — the join-link
 * surface"), docs/00_FOUNDATION.md §4.5 (AUDIO_UNAVAILABLE), §9
 * (theological safety — companionship tone), §10 (no PII displayed).
 *
 * No frontend framework for MVP (task instructions) — plain server-
 * rendered HTML from Fastify, mobile-first, WCAG AA contrast, landmarks
 * (`main`), native `<audio controls>` element as the accessible fallback
 * (05_UX_FLOWS §7 "Session page semantics").
 *
 * SECURITY: every dynamic string that traces back to Gloo/LLM output
 * (theme, devotionalBody, prayer, cardSummary, verse text/attribution,
 * journalingPrompt, actionStep) is passed through `escapeHtml` — LLM
 * output is untrusted input (docs/04 §5.4). Do not add a new
 * interpolation site without escaping it.
 */
import { WS, WS_SANS, WS_SERIF, wsFontFaceCss } from '../design/wsTokens.js';
import { escapeHtml } from './html.js';

export interface SessionPageVerse {
  usfm: string;
  reference: string;
  fetchedText: string;
  attribution: string;
}

export interface SessionPageDevotional {
  theme: string;
  format: string;
  verses: SessionPageVerse[];
  devotionalBody: string;
  prayer: string;
  journalingPrompt?: string | null;
  actionStep?: string | null;
}

export interface SessionPageData {
  devotional: SessionPageDevotional;
  /** Signed playback URL from AudioStorage, or null when AUDIO_UNAVAILABLE (05_UX_FLOWS §4 "Audio failure" state). */
  audioUrl: string | null;
  completed: boolean;
  token: string;
}

/**
 * Shared page chrome, styled per the Wellspring Design System (T3 #350,
 * epic #347): canvas→mist ground, Hanken Grotesk UI chrome, Spectral for
 * scripture (the hero), prayer, and the title. Zero JS as ever (docs/04
 * §5.3 CSP) — fonts are self-hosted @font-face (`font-src 'self'`) with
 * Georgia/system-ui fallbacks, so the page is correct with or without the
 * woff2 files.
 *
 * WCAG AA (the session-a11y e2e suite is a hard gate): every small-text
 * role that the design pins to muted #A2937F (2.8:1 on canvas) or
 * terracotta #B4795A (3.4:1) is darkened to clay #8A5F43 (≥4.5:1 on every
 * ground used here); the CTA gradient uses darkened terracotta ends
 * (#96684a→#8A5F43, white text ≥4.5:1 on both). Roles are otherwise kept
 * verbatim (sizes, weights, tracking, families).
 */
function pageShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  ${wsFontFaceCss()}
  :root {
    color-scheme: light;
    --ws-canvas: ${WS.canvas};
    --ws-mist: ${WS.mist};
    --ws-terracotta: ${WS.terracotta};
    --ws-clay: ${WS.clay};
    --ws-ink: ${WS.ink};
    --serif: ${WS_SERIF};
    --sans: ${WS_SANS};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    background: var(--ws-canvas);
    background-image: linear-gradient(180deg, var(--ws-canvas) 0%, var(--ws-mist) 100%);
    background-attachment: fixed;
    color: var(--ws-ink);
    font-family: var(--sans);
    line-height: 1.6;
  }
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
  }
  /* Title role (§03): Spectral 400, slight negative tracking. */
  h1 { font-family: var(--serif); font-size: 1.75rem; font-weight: 400; letter-spacing: -0.01em; margin: 0 0 0.25rem; }
  .theme { color: var(--ws-clay); font-size: 0.95rem; margin: 0 0 2rem; }
  /* Verse block (§05 signature component): scripture is the hero — a
     soft-gradient card, eyebrow-styled reference, Spectral 300 quote at
     26px (lh 1.4, text-wrap: pretty), reference-role attribution line. */
  .verse {
    background: ${WS.gradientVerse};
    border-radius: ${WS.radiusCard};
    box-shadow: ${WS.shadow};
    padding: 1.75rem 1.75rem 1.5rem;
    margin: 0 0 1.75rem;
  }
  .verse-ref {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--ws-clay);
    margin: 0 0 0.9rem;
  }
  .verse-text {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(1.5rem, 5.5vw, 1.625rem);
    line-height: 1.4;
    text-wrap: pretty;
    margin: 0 0 1rem;
  }
  .attribution { color: var(--ws-clay); font-size: 13px; font-weight: 500; letter-spacing: 0.04em; margin: 0; }
  audio { width: 100%; margin: 1.5rem 0; }
  .transcript { font-family: var(--serif); font-size: 1.05rem; line-height: 1.7; white-space: pre-wrap; margin: 1.5rem 0; }
  /* Prayer role (§03): Spectral 300 italic on a mist card. */
  .prayer {
    font-family: var(--serif);
    font-style: italic;
    font-weight: 300;
    font-size: 1.375rem;
    line-height: 1.5;
    margin: 1.5rem 0;
    padding: 1.5rem 1.75rem;
    background: var(--ws-mist);
    border-radius: ${WS.radiusCard};
  }
  .action-step, .journaling-prompt { margin: 1.75rem 0; }
  .action-step h2, .journaling-prompt h2 {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--ws-clay);
    margin: 0 0 0.4rem;
  }
  .complete-form { margin-top: 2rem; }
  .prayer-intention-label { display: block; font-size: 0.95rem; color: var(--ws-clay); margin-bottom: 0.5rem; }
  .prayer-intention-input {
    display: block;
    width: 100%;
    min-height: 44px;
    padding: 0.65rem 1.1rem;
    margin-bottom: 1rem;
    font-size: 1rem;
    font-family: inherit;
    color: var(--ws-ink);
    background: #fff;
    border: 1px solid #d4bfae;
    border-radius: ${WS.radiusPill};
  }
  .prayer-intention-input:focus { outline: 2px solid var(--ws-terracotta); outline-offset: 1px; }
  /* Primary CTA (§05): pill, terracotta-family gradient, white 15px/600
     Hanken, warm CTA shadow. Gradient ends darkened from the token pair
     (#c98a63→#b4795a) to #96684a→#8A5F43 so white text meets AA 4.5:1. */
  button.complete {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0.7rem 1.75rem;
    font-family: inherit;
    font-size: 15px;
    font-weight: 600;
    color: #fff;
    background: #8A5F43 linear-gradient(145deg, #96684a, #8A5F43);
    border: none;
    border-radius: ${WS.radiusPill};
    box-shadow: ${WS.shadowCta};
    cursor: pointer;
  }
  button.complete:focus-visible { outline: 2px solid var(--ws-terracotta); outline-offset: 2px; }
  /* #6b6459: 4.7:1 against the white label — keeps the AA floor the
     original #8a8375 failed (axe pass in e2e/sessionPage.a11y.spec.ts, #67). */
  button.complete:disabled { background: #6b6459; cursor: default; }
  .completed-badge { color: var(--ws-clay); font-weight: 600; }
  /* Post-Amen feedback form (P2 #321) — zero-JS radio groups styled as
     tap targets. min-height 44px per the mobile tap-target floor (#264's
     accessibility bar); label wraps the input so the whole row is the
     target. Pills per the design system: glass rest state, clay-terracotta
     selected state via :has() (older engines still show the native radio
     dot, so selection stays legible without it). This is part of the Amen
     moment, not a survey. */
  .feedback-form { margin-top: 2.5rem; }
  .feedback-form fieldset { border: none; margin: 0 0 1.25rem; padding: 0; }
  .feedback-form legend { font-size: 0.95rem; color: var(--ws-clay); margin-bottom: 0.4rem; padding: 0; }
  .feedback-option {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 44px;
    padding: 0 1.1rem;
    margin: 0 0.5rem 0.5rem 0;
    background: rgba(255, 255, 255, 0.55);
    border: 1px solid #d4bfae;
    border-radius: ${WS.radiusPill};
    cursor: pointer;
    font-size: 0.95rem;
  }
  .feedback-option input { accent-color: var(--ws-clay); }
  .feedback-option:has(input:checked) {
    background: #8A5F43 linear-gradient(145deg, #96684a, #8A5F43);
    border-color: transparent;
    color: #fff;
    box-shadow: ${WS.shadowCta};
  }
  .feedback-option:has(input:checked) input { accent-color: #fff; }
  .feedback-option:focus-within { outline: 2px solid var(--ws-terracotta); outline-offset: 2px; }
  .feedback-note-label { display: block; font-size: 0.95rem; color: var(--ws-clay); margin: 0.5rem 0; }
  .audio-unavailable { color: var(--ws-clay); font-size: 0.95rem; margin: 1rem 0 1.5rem; }
  .gentle-message { font-family: var(--serif); font-size: 1.15rem; margin: 3rem 0; }
  a { color: var(--ws-clay); }
</style>
</head>
<body>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

/** 05_UX_FLOWS §4 "Invalid token" / "Token expired" states — deliberately identical body (enumeration-safe, 04 §5.4) except for the optional app-deep-link line, which UX explicitly allows to differ only for a *valid, expired* token, never for an unknown one. See sessionService.ts for why both map to the SAME HTTP 404 status either way. */
export function renderGoneOrUnknownPage(): string {
  return pageShell(
    "This link isn't active — Wellspring",
    `<p class="gentle-message">This link isn't active.</p>`,
  );
}

export interface SessionCompletePageData {
  token: string;
  /** True once a session_feedback row exists — renders the thanked state and NO form (grace: never nag twice, #321). */
  feedbackSubmitted: boolean;
  /**
   * True ONLY when the devotional's verse has actually been saved to the
   * user's YouVersion highlights (U3, kairos-devotional#356). Shows one quiet
   * proof line and NOTHING otherwise — the completion page never advertises or
   * nags about YouVersion to a user who is not connected/consented, and never
   * claims a save that has not happened. Defaults to false (omitted line).
   */
  youVersionHighlightSaved?: boolean;
}

/**
 * One zero-JS radio group of the feedback form (#321). `<label>` WRAPS the
 * `<input type="radio">` so the whole pill is the tap target (44px min via
 * .feedback-option) with no `for`/`id` bookkeeping. All values are static
 * strings from the P1 contract enums (sessionFeedback.ts) — nothing
 * user- or LLM-authored flows through here, so there is nothing to escape.
 */
function feedbackGroup(name: string, legend: string, options: Array<[value: string, label: string]>): string {
  const optionsHtml = options
    .map(
      ([value, label]) =>
        `<label class="feedback-option"><input type="radio" name="${name}" value="${value}" /> ${label}</label>`,
    )
    .join('\n');
  return `<fieldset>
<legend>${legend}</legend>
${optionsHtml}
</fieldset>`;
}

/**
 * Post-completion confirmation (#297) + the post-Amen feedback moment
 * (P2 #321). The "Amen — mark complete" form is a zero-JS full-page POST
 * (CSP policy, docs/04 §5.3), so before this the user landed on the raw
 * `{"ok":true,...}` JSON of the POST handler. The handler now 303-redirects
 * a browser submission here. Content-type: the same `text/html;
 * charset=utf-8` as every other page in this module.
 *
 * Two states (#321):
 *  - no feedback yet → confirmation + the 4-question all-optional form,
 *    POSTing (zero-JS, form-urlencoded) to /session/:token/feedback; the
 *    route 303s straight back here, which then renders —
 *  - feedback exists → confirmation + a one-line thank-you and NO form.
 *    Once submitted, never re-asked.
 *
 * Formation guardrails (Foundation §9, epic #312): the questions are about
 * THIS devotional only — no attendance, frequency, streak, or history
 * wording anywhere on this page, and nothing is required. Radio values are
 * the exact enum strings of SessionFeedbackBodySchema (shared-contracts) —
 * the render test pins each one so the form and contract cannot drift.
 */
export function renderSessionCompletePage(data: SessionCompletePageData): string {
  const { token, feedbackSubmitted } = data;

  // One quiet proof line (U3 #356), shown ONLY in the written state — the mark
  // the devotional left in the user's real Bible. §07 voice (understated,
  // never triumphant); `.theme` role = the clay muted-text token, AA-safe.
  // Static string (no user/LLM content), so nothing to escape.
  const highlightProof = data.youVersionHighlightSaved
    ? `<p class="theme" role="status">Saved to your YouVersion highlights.</p>`
    : '';

  const feedbackSection = feedbackSubmitted
    ? `<p class="gentle-message">Thank you &mdash; this shapes what comes next.</p>`
    : `<form class="feedback-form" method="post" action="/session/${encodeURIComponent(token)}/feedback">
<p class="theme">Before you go &mdash; only if you&#39;d like. Every question is optional.</p>
${feedbackGroup('contentHelpful', 'Did this meet you today?', [
  ['true', 'Yes'],
  ['false', 'Not really'],
])}
${feedbackGroup('topicMore', 'More on this topic?', [
  ['true', 'Yes, please'],
  ['false', 'Mix it up'],
])}
${feedbackGroup('lengthFeel', 'The length felt&hellip;', [
  ['shorter', 'Shorter, please'],
  ['right', 'Just right'],
  ['longer', 'Longer is fine'],
])}
${feedbackGroup('timeFeel', 'The time of day was&hellip;', [
  ['earlier', 'Earlier suits me'],
  ['right', 'Just right'],
  ['later', 'Later suits me'],
])}
<label for="feedbackNote" class="feedback-note-label">Anything else on your heart?</label>
<input type="text" id="feedbackNote" name="note" class="prayer-intention-input" maxlength="500" autocomplete="off" />
<button type="submit" class="complete">Send</button>
</form>`;

  return pageShell(
    'Marked complete — Wellspring',
    `<p class="completed-badge" role="status">Completed &#10003;</p>
<p class="gentle-message">Amen. Your time is marked complete &mdash; thank you for being here.</p>
<p class="theme">You can close this page and carry the quiet with you. We'll meet you again tomorrow.</p>
${highlightProof}
${feedbackSection}`,
  );
}

/** 05_UX_FLOWS §4 "Main" and "Audio failure" states. */
export function renderSessionPage(data: SessionPageData): string {
  const { devotional, audioUrl, completed, token } = data;

  const versesHtml = devotional.verses
    .map(
      (v) => `<div class="verse">
  <p class="verse-ref">${escapeHtml(v.reference)}</p>
  <p class="verse-text">${escapeHtml(v.fetchedText)}</p>
  <p class="attribution">${escapeHtml(v.attribution)}</p>
</div>`,
    )
    .join('\n');

  const audioSection = audioUrl
    ? `<audio controls preload="none" aria-label="Devotional audio">
  <source src="${escapeHtml(audioUrl)}" type="audio/mpeg" />
  Your browser does not support the audio element.
</audio>`
    : `<p class="audio-unavailable" role="status">The audio is resting today — the words are all here.</p>`;

  const journalingHtml = devotional.journalingPrompt
    ? `<div class="journaling-prompt"><h2>Journaling prompt</h2><p>${escapeHtml(devotional.journalingPrompt)}</p></div>`
    : '';

  const actionStepHtml = devotional.actionStep
    ? `<div class="action-step"><h2>Today</h2><p>${escapeHtml(devotional.actionStep)}</p></div>`
    : '';

  const completeSection = completed
    ? `<p class="completed-badge" role="status">Completed &#10003;</p>`
    : `<form class="complete-form" method="post" action="/session/${encodeURIComponent(token)}/complete">
  <label for="prayerIntention" class="prayer-intention-label">Anything you're carrying? &mdash; one line, only used to pray with you tomorrow</label>
  <input type="text" id="prayerIntention" name="prayerIntention" class="prayer-intention-input" maxlength="500" autocomplete="off" />
  <button type="submit" class="complete">Amen &mdash; mark complete</button>
</form>`;

  const body = `<h1>${escapeHtml(devotional.theme)}</h1>
<p class="theme">A ${escapeHtml(devotional.format)} moment of rest</p>
${versesHtml}
${audioSection}
<section class="transcript" aria-label="Devotional transcript">
<p>${escapeHtml(devotional.devotionalBody)}</p>
</section>
<section class="prayer" aria-label="Prayer">
<p>${escapeHtml(devotional.prayer)}</p>
</section>
${journalingHtml}
${actionStepHtml}
${completeSection}`;

  return pageShell(devotional.theme, body);
}
