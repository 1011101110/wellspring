/**
 * Server-rendered HTML for the Stage page — Q2 (#332), captions/progress
 * Q3 (#333), epic Q (#330). The mockup experience: SCRIPTURE /
 * REFLECTION / QUESTIONS / PRAYER tab pills, warm cream palette, large
 * serif verse type, live-caption chip, thin progress bar — composed for
 * 1280×720 (Attendee's browser-voice-agent canvas AND the standalone
 * demo floor), while degrading responsively for other viewports.
 *
 * Rendering conventions follow renderSessionPage.ts: plain server-
 * rendered HTML, no framework, and EVERY dynamic string that traces back
 * to Gloo/LLM output routes through `escapeHtml` — LLM output is
 * untrusted input (docs/04 §5.4). The Q1 timing manifest is inlined as a
 * `<script type="application/json">` block (no extra fetch, no manifest
 * signed URL); `<` is JSON-escaped so LLM text can never break out of
 * the JSON block.
 *
 * Language (Epic O #311): the page renders whatever language the
 * devotional was generated in — content, verse, prayer, captions all come
 * from stored data. Tab labels stay English for the hackathon (same scope
 * decision as O's "app UI stays English").
 */
import type { TimingManifest } from '@kairos/shared-contracts';
import { escapeHtml } from '../session/html.js';
import type { SessionPageData } from '../session/renderSessionPage.js';

export interface StagePageData {
  page: SessionPageData;
  /** Q1 timing manifest, or null → the page renders without captions/tab sync. */
  manifest: TimingManifest | null;
  /** `?mute=1` — the screenshare instance (Q5): muted audio, timeline still runs. */
  muted: boolean;
}

/**
 * Shared Stage chrome. Palette per the mockup: cream #f4efe7 ground,
 * deep brown-black #2a2118 text, Iowan/Palatino/Georgia serif stack for
 * verse/prose, small-caps sans tab pills, progress bar at the bottom.
 * `prefers-reduced-motion` disables the fades/transitions.
 */
function stageShell(title: string, bodyHtml: string, options: { withScript: boolean }): string {
  const script = options.withScript
    ? '\n<script src="/stage/assets/stage.js" defer></script>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light;
    --cream: #f4efe7;
    --cream-deep: #ece5d8;
    --ink: #2a2118;
    --ink-soft: #6b5f4e;
    --ink-faint: #93876f;
    --chip-bg: #322921;
    --chip-text: #f6f1e7;
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--cream);
    background-image: radial-gradient(ellipse 90% 70% at 50% 20%, #f8f4ec 0%, var(--cream) 62%, #efe8da 100%);
    color: var(--ink);
    font-family: var(--serif);
    overflow: hidden;
  }
  .stage {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0 4rem;
  }
  .wordmark {
    margin-top: 2.1rem;
    font-family: var(--sans);
    font-size: 0.68rem;
    letter-spacing: 0.42em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .tabs {
    margin-top: 1.4rem;
    display: flex;
    gap: 0.6rem;
    font-family: var(--sans);
  }
  .tab-pill {
    font-size: 0.72rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-soft);
    padding: 0.5rem 1.15rem;
    border: 1px solid transparent;
    border-radius: 999px;
    transition: color 0.4s ease, border-color 0.4s ease, background-color 0.4s ease;
  }
  .tab-pill.active {
    color: var(--ink);
    border-color: #cfc4ae;
    background: rgba(255, 253, 248, 0.65);
  }
  .panels {
    flex: 1;
    width: 100%;
    max-width: 62rem;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .panel {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.7s ease, visibility 0.7s ease;
  }
  .panel.active { opacity: 1; visibility: visible; }
  .eyebrow {
    font-family: var(--sans);
    font-size: 0.72rem;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin: 0 0 1.4rem;
  }
  .verse-text {
    font-size: clamp(1.6rem, 3.4vw, 2.75rem);
    line-height: 1.4;
    margin: 0;
    max-width: 56rem;
  }
  .verse-attribution {
    font-family: var(--sans);
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    color: var(--ink-soft);
    margin: 1.9rem 0 0;
  }
  .prose {
    font-size: clamp(1.05rem, 1.9vw, 1.45rem);
    line-height: 1.75;
    margin: 0;
    max-width: 46rem;
    max-height: 62vh;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, black 82%, transparent 100%);
    mask-image: linear-gradient(to bottom, black 82%, transparent 100%);
  }
  .prayer-text {
    font-style: italic;
    font-size: clamp(1.3rem, 2.6vw, 2.05rem);
    line-height: 1.6;
    margin: 0;
    max-width: 48rem;
  }
  .question-block { max-width: 44rem; margin: 0 0 2.2rem; }
  .question-block:last-child { margin-bottom: 0; }
  .question-text { font-size: clamp(1.15rem, 2.1vw, 1.6rem); line-height: 1.6; margin: 0; }
  .caption-zone {
    min-height: 5.6rem;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 1.7rem;
  }
  .caption-chip {
    font-size: 1.02rem;
    line-height: 1.5;
    color: var(--chip-text);
    background: var(--chip-bg);
    border-radius: 999px;
    padding: 0.62rem 1.5rem;
    max-width: 54rem;
    box-shadow: 0 10px 28px rgba(42, 33, 24, 0.18);
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.45s ease, transform 0.45s ease;
  }
  .caption-chip.visible { opacity: 1; transform: translateY(0); }
  .progress-track {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgba(42, 33, 24, 0.12);
  }
  .progress-fill {
    height: 100%;
    width: 0%;
    background: var(--ink);
    transition: width 0.25s linear;
  }
  .begin-overlay {
    position: fixed;
    inset: 0;
    background: var(--cream);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.6rem;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.4s ease, visibility 0.4s ease;
    cursor: pointer;
    z-index: 10;
  }
  .begin-overlay.visible { opacity: 1; visibility: visible; }
  .begin-button {
    font-family: var(--serif);
    font-size: 1.3rem;
    color: var(--chip-text);
    background: var(--chip-bg);
    border: none;
    border-radius: 999px;
    padding: 1.1rem 3.2rem;
    cursor: pointer;
  }
  .begin-hint {
    font-family: var(--sans);
    font-size: 0.8rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .gone-card { text-align: center; max-width: 34rem; }
  .gone-title { font-size: 1.9rem; margin: 0 0 1rem; }
  .gone-line { font-family: var(--sans); font-size: 0.95rem; color: var(--ink-soft); margin: 0; line-height: 1.7; }
  @media (prefers-reduced-motion: reduce) {
    .tab-pill, .panel, .caption-chip, .progress-fill, .begin-overlay { transition: none; }
  }
  /* Attendee's container injects diagnostic banners into this DOM under this
     id (webpage_streamer_payload.js) — seen live on the Q7 rehearsal
     2026-07-23 ("Failed to receive remote audio stream"). The trigger (our
     mic request) is removed in stageClient.ts; this rule is defense-in-depth
     so no container-side diagnostic can ever appear on the screen every
     participant sees. */
  #attendee-audio-error { display: none !important; }
</style>
</head>
<body>
${bodyHtml}${script}
</body>
</html>`;
}

/**
 * The Stage's enumeration-safe dead-token page (Q3 #333): unknown,
 * expired-not-yet-purged, and purged tokens all receive THIS byte-
 * identical body with a 404 (parity with /session's collapse, docs/04
 * §5.4). Styled for the Stage surface — a bot pointed at a dead token
 * shows a calm neutral card on camera, never a stack trace; fits 1280×720
 * with no scrollbars (body overflow is hidden and the card is centered).
 */
export function renderStageGonePage(): string {
  return stageShell(
    "This link isn't active — Wellspring",
    `<main class="stage" style="justify-content:center">
  <div class="gone-card">
    <p class="wordmark">Wellspring</p>
    <h1 class="gone-title" style="margin-top:1.6rem">This link isn&#39;t active.</h1>
    <p class="gone-line">The devotional this link pointed to has ended or moved on.<br />There will be another moment of rest tomorrow.</p>
  </div>
</main>`,
    { withScript: false },
  );
}

/** JSON-inlining that can never break out of its <script> block: escape `<` (covers `</script` and `<!--`). */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderStagePage(data: StagePageData): string {
  const { page, manifest, muted } = data;
  const devotional = page.devotional;

  const journaling = devotional.journalingPrompt ?? null;
  const actionStep = devotional.actionStep ?? null;
  const hasQuestions = journaling !== null || actionStep !== null;

  const versesHtml = devotional.verses
    .map(
      (v) => `<p class="verse-text">${escapeHtml(v.fetchedText)}</p>
      <p class="verse-attribution">${escapeHtml(v.reference)} &middot; ${escapeHtml(v.attribution)}</p>`,
    )
    .join('\n      ');
  const firstReference = devotional.verses[0]?.reference ?? '';

  const questionBlocks = [
    journaling
      ? `<div class="question-block"><p class="eyebrow">Journal</p><p class="question-text">${escapeHtml(journaling)}</p></div>`
      : '',
    actionStep
      ? `<div class="question-block"><p class="eyebrow">Today</p><p class="question-text">${escapeHtml(actionStep)}</p></div>`
      : '',
  ]
    .filter((block) => block.length > 0)
    .join('\n      ');

  const questionsTab = hasQuestions
    ? `<span class="tab-pill" id="tab-questions">Questions</span>`
    : '';
  const questionsPanel = hasQuestions
    ? `<section class="panel" id="panel-questions" aria-label="Questions">
      ${questionBlocks}
    </section>`
    : '';

  // `muted` also lets a strict browser start the screenshare instance
  // without a gesture (muted autoplay is universally permitted).
  const audioHtml = page.audioUrl
    ? `<audio id="stage-audio" autoplay preload="auto"${muted ? ' muted' : ''} src="${escapeHtml(page.audioUrl)}"></audio>`
    : '';

  const body = `<main class="stage">
  <p class="wordmark">Wellspring</p>
  <nav class="tabs" aria-label="Devotional sections">
    <span class="tab-pill active" id="tab-scripture">Scripture</span>
    <span class="tab-pill" id="tab-reflection">Reflection</span>
    ${questionsTab}
    <span class="tab-pill" id="tab-prayer">Prayer</span>
  </nav>
  <div class="panels">
    <section class="panel active" id="panel-scripture" aria-label="Scripture">
      <p class="eyebrow">${escapeHtml(devotional.theme)}</p>
      ${versesHtml}
    </section>
    <section class="panel" id="panel-reflection" aria-label="Reflection">
      <p class="eyebrow">${escapeHtml(firstReference)}</p>
      <p class="prose">${escapeHtml(devotional.devotionalBody)}</p>
    </section>
    ${questionsPanel}
    <section class="panel" id="panel-prayer" aria-label="Prayer">
      <p class="eyebrow">Prayer</p>
      <p class="prayer-text">${escapeHtml(devotional.prayer)}</p>
    </section>
  </div>
  <div class="caption-zone">
    <div class="caption-chip" id="caption-chip" aria-live="polite"></div>
  </div>
</main>
<div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
<div class="begin-overlay" id="begin-overlay">
  <button type="button" class="begin-button">Begin</button>
  <p class="begin-hint">A moment of rest is ready</p>
</div>
${audioHtml}
<script type="application/json" id="stage-data">${inlineJson({
    manifest: manifest ?? [],
    hasQuestions,
  })}</script>`;

  return stageShell(`${devotional.theme} — Wellspring`, body, { withScript: true });
}
