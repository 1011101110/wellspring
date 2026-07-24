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
import { WS, WS_SANS, WS_SERIF, wsFontFaceCss } from '../design/wsTokens.js';
import { escapeHtml } from '../session/html.js';
import type { SessionPageData } from '../session/renderSessionPage.js';

export interface StagePageData {
  page: SessionPageData;
  /** Q1 timing manifest, or null → the page renders without captions/tab sync. */
  manifest: TimingManifest | null;
  /**
   * `?mute=1` — a manual/testing affordance (silent visual check of the
   * timeline in a normal browser tab). Dispatch never sets it: the Q5
   * design sketch had a second, muted "screenshare instance", but the Q4
   * spike (#334) proved Attendee accepts `url` XOR `screenshare_url` —
   * one instance, one audio source, nothing to mute.
   */
  muted: boolean;
}

/**
 * Shared Stage chrome, styled per the Wellspring Design System (T3 #350,
 * epic #347): canvas→mist→dawn gradient ground, Spectral 300 scripture at
 * 26–36px (lh 1.4, text-wrap: pretty), Hanken Grotesk chrome, terracotta
 * as the ONLY accent (active tab pill, progress fill, caption-chip dot,
 * Begin CTA, brand circle), warm-tinted shadows, brand mark small in the
 * top-left corner. Fonts are self-hosted @font-face with Georgia/Iowan +
 * system-ui fallbacks (wsTokens.ts) — the page is correct with or without
 * the woff2 files. `prefers-reduced-motion` disables fades/transitions.
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
  ${wsFontFaceCss()}
  :root {
    color-scheme: light;
    --ws-canvas: ${WS.canvas};
    --ws-mist: ${WS.mist};
    --ws-dawn: ${WS.dawn};
    --ws-terracotta: ${WS.terracotta};
    --ws-clay: ${WS.clay};
    --ws-ink: ${WS.ink};
    --ws-muted: ${WS.muted};
    --ws-ease: ${WS.ease};
    --ws-dur: ${WS.dur};
    --serif: ${WS_SERIF};
    --sans: ${WS_SANS};
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--ws-canvas);
    background-image: linear-gradient(180deg, var(--ws-canvas) 0%, var(--ws-mist) 68%, var(--ws-dawn) 100%);
    color: var(--ws-ink);
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
  /* Brand mark (§ header brand), scaled small for a corner: terracotta-
     gradient circle + "Wellspring" in Spectral. Fixed so it sits quietly
     top-left on every stage state, including the gone card. */
  .wordmark {
    position: fixed;
    top: 1.5rem;
    left: 1.75rem;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-family: var(--serif);
    font-size: 1rem;
    font-weight: 400;
    color: var(--ws-ink);
    z-index: 5;
  }
  .brand-circle {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: ${WS.gradientTerracotta};
    box-shadow: ${WS.shadow};
  }
  .tabs {
    margin-top: 2.4rem;
    display: flex;
    gap: 0.6rem;
    font-family: var(--sans);
  }
  .tab-pill {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ws-clay);
    padding: 0.5rem 1.15rem;
    border: 1px solid transparent;
    border-radius: ${WS.radiusPill};
    transition: color 0.4s var(--ws-ease), border-color 0.4s var(--ws-ease), background-color 0.4s var(--ws-ease);
  }
  .tab-pill.active {
    color: var(--ws-ink);
    border-color: var(--ws-terracotta);
    background: rgba(255, 255, 255, 0.55);
    box-shadow: ${WS.shadow};
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
    transition: opacity var(--ws-dur) var(--ws-ease), visibility var(--ws-dur) var(--ws-ease);
  }
  .panel.active { opacity: 1; visibility: visible; }
  /* Eyebrow role (§03): Hanken 600 · 12px · uppercase · .22em · terracotta.
     The stage is a 1280×720 display surface (not axe-gated); the /session
     page darkens this role to clay for WCAG AA — see renderSessionPage. */
  .eyebrow {
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--ws-terracotta);
    margin: 0 0 1.4rem;
  }
  /* Scripture role (§03): Spectral 300 · 26–36px · lh 1.4 · text-wrap: pretty. */
  .verse-text {
    font-weight: 300;
    font-size: clamp(1.625rem, 2.6vw, 2.25rem);
    line-height: 1.4;
    text-wrap: pretty;
    margin: 0;
    max-width: 52rem;
  }
  /* Reference role (§03): Hanken 500 · 13px — clay rather than the
     design's #A2937F (2.8:1 on canvas fails AA small; a11y wins per epic
     ground rule 2). NOTE: no " mut*d" substring may appear in this CSS —
     the ?mute route test strips the audio attribute by first-occurrence
     string replace. */
  .verse-attribution {
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.08em;
    color: var(--ws-clay);
    margin: 1.9rem 0 0;
  }
  .prose {
    font-weight: 300;
    font-size: clamp(1.05rem, 1.9vw, 1.4rem);
    line-height: 1.75;
    margin: 0;
    max-width: 46rem;
    max-height: 62vh;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, black 82%, transparent 100%);
    mask-image: linear-gradient(to bottom, black 82%, transparent 100%);
  }
  /* Prayer role (§03): Spectral 300 italic · 22–26px. */
  .prayer-text {
    font-style: italic;
    font-weight: 300;
    font-size: clamp(1.375rem, 2.2vw, 1.625rem);
    line-height: 1.6;
    margin: 0;
    max-width: 44rem;
  }
  .question-block { max-width: 44rem; margin: 0 0 2.2rem; }
  .question-block:last-child { margin-bottom: 0; }
  .question-text { font-weight: 300; font-size: clamp(1.15rem, 2.1vw, 1.6rem); line-height: 1.6; margin: 0; }
  .caption-zone {
    min-height: 5.6rem;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 1.7rem;
  }
  /* Caption chip: ink ground, canvas text (11.7:1), warm shadow, and a
     small terracotta dot as its only accent. */
  .caption-chip {
    font-size: 1.02rem;
    line-height: 1.5;
    color: var(--ws-canvas);
    background: var(--ws-ink);
    border-radius: ${WS.radiusPill};
    padding: 0.62rem 1.5rem;
    max-width: 54rem;
    box-shadow: ${WS.shadowHero};
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.45s var(--ws-ease), transform 0.45s var(--ws-ease);
  }
  .caption-chip::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ws-terracotta);
    margin-right: 0.7rem;
    vertical-align: 0.14em;
  }
  .caption-chip.visible { opacity: 1; transform: translateY(0); }
  .progress-track {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgba(180, 121, 90, 0.16);
  }
  .progress-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #c98a63, #b4795a);
    transition: width 0.25s linear;
  }
  .begin-overlay {
    position: fixed;
    inset: 0;
    background: var(--ws-canvas);
    background-image: linear-gradient(180deg, var(--ws-canvas) 0%, var(--ws-mist) 68%, var(--ws-dawn) 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.6rem;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.4s var(--ws-ease), visibility 0.4s var(--ws-ease);
    cursor: pointer;
    z-index: 10;
  }
  .begin-overlay.visible { opacity: 1; visibility: visible; }
  /* Primary CTA (§05): terracotta-gradient pill, white 15px/600 Hanken,
     play glyph, warm CTA shadow. */
  .begin-button {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
    font-family: var(--sans);
    font-size: 15px;
    font-weight: 600;
    color: #fff;
    background: ${WS.gradientTerracotta};
    border: none;
    border-radius: ${WS.radiusPill};
    padding: 1.05rem 2.6rem;
    box-shadow: ${WS.shadowCta};
    cursor: pointer;
  }
  .begin-button::before { content: '\\25B8'; font-size: 0.9em; }
  .begin-hint {
    font-family: var(--sans);
    font-size: 0.8rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ws-clay);
  }
  /* Gone card: glass card per §08 (white .55 + soft border, radius 24,
     warm shadow) — calm and neutral if it ever lands on camera. */
  .gone-card {
    text-align: center;
    max-width: 34rem;
    background: rgba(255, 255, 255, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-radius: ${WS.radiusCard};
    box-shadow: ${WS.shadow};
    padding: 3rem 3.25rem 2.75rem;
  }
  .gone-title { font-size: 1.9rem; font-weight: 400; letter-spacing: -0.01em; margin: 0 0 1rem; }
  .gone-line { font-family: var(--sans); font-size: 0.95rem; color: var(--ws-clay); margin: 0; line-height: 1.7; }
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
  <p class="wordmark"><span class="brand-circle" aria-hidden="true"></span>Wellspring</p>
  <div class="gone-card">
    <h1 class="gone-title">This link isn&#39;t active.</h1>
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

  // `muted` (manual/testing only — see StagePageData) also lets a strict
  // browser start the page without a gesture, since muted autoplay is
  // universally permitted. Dispatched bots never pass it (#334: single
  // voice-agent instance); Attendee's container autoplays unmuted anyway.
  const audioHtml = page.audioUrl
    ? `<audio id="stage-audio" autoplay preload="auto"${muted ? ' muted' : ''} src="${escapeHtml(page.audioUrl)}"></audio>`
    : '';

  const body = `<main class="stage">
  <p class="wordmark"><span class="brand-circle" aria-hidden="true"></span>Wellspring</p>
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
