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

/** Shared page chrome: calm, minimal styling per 05_UX_FLOWS §1 (P1 "Calm, unhurried"). WCAG AA contrast (dark text #1a1a1a on off-white #faf8f5; buttons meet 4.5:1). */
function pageShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    background: #faf8f5;
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Georgia, serif;
    line-height: 1.6;
  }
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
  }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 0.25rem; }
  .theme { color: #4a4a4a; font-size: 1rem; margin: 0 0 2rem; }
  .verse-ref { font-weight: 600; margin: 0 0 0.5rem; }
  .verse-text { font-size: 1.15rem; margin: 0 0 0.5rem; }
  .attribution { color: #5a5a5a; font-size: 0.85rem; margin: 0 0 2rem; }
  audio { width: 100%; margin: 1.5rem 0; }
  .transcript { white-space: pre-wrap; margin: 1.5rem 0; }
  .prayer { font-style: italic; margin: 1.5rem 0; padding: 1rem; background: #f1ede6; border-radius: 8px; }
  .action-step, .journaling-prompt { margin: 1.5rem 0; }
  .complete-form { margin-top: 2rem; }
  .prayer-intention-label { display: block; font-size: 0.95rem; color: #4a4a4a; margin-bottom: 0.5rem; }
  .prayer-intention-input {
    display: block;
    width: 100%;
    padding: 0.65rem 0.85rem;
    margin-bottom: 1rem;
    font-size: 1rem;
    font-family: inherit;
    color: #1a1a1a;
    background: #fff;
    border: 1px solid #cfc8bb;
    border-radius: 8px;
  }
  button.complete {
    display: inline-block;
    padding: 0.85rem 1.75rem;
    font-size: 1rem;
    color: #faf8f5;
    background: #3a3226;
    border: none;
    border-radius: 999px;
    cursor: pointer;
  }
  /* #6b6459 (not the original #8a8375) — the original only contrasted
     3.55:1 against the button's #faf8f5 text, failing WCAG AA's 4.5:1
     floor for normal-size text (caught by the axe-core pass in
     e2e/sessionPage.a11y.spec.ts, issue #67). */
  button.complete:disabled { background: #6b6459; cursor: default; }
  .completed-badge { color: #2f5d3a; font-weight: 600; }
  /* Post-Amen feedback form (P2 #321) — zero-JS radio groups styled as
     tap targets. min-height 44px per the mobile tap-target floor (#264's
     accessibility bar); label wraps the input so the whole row is the
     target. Same palette as the rest of the page — this is part of the
     Amen moment, not a survey. */
  .feedback-form { margin-top: 2.5rem; }
  .feedback-form fieldset { border: none; margin: 0 0 1.25rem; padding: 0; }
  .feedback-form legend { font-size: 0.95rem; color: #4a4a4a; margin-bottom: 0.4rem; padding: 0; }
  .feedback-option {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 44px;
    padding: 0 1rem;
    margin: 0 0.5rem 0.5rem 0;
    background: #f1ede6;
    border: 1px solid #cfc8bb;
    border-radius: 999px;
    cursor: pointer;
    font-size: 0.95rem;
  }
  .feedback-note-label { display: block; font-size: 0.95rem; color: #4a4a4a; margin: 0.5rem 0; }
  .audio-unavailable { color: #5a5a5a; font-size: 0.95rem; margin: 1rem 0 1.5rem; }
  .gentle-message { font-size: 1.1rem; margin: 3rem 0; }
  a { color: #3a3226; }
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
