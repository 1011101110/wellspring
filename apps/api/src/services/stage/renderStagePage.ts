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
import type { SlotType, TimingManifest } from '@kairos/shared-contracts';
import { WS, WS_SANS, WS_SERIF, wsFontFaceCss } from '../design/wsTokens.js';
import { escapeHtml } from '../session/html.js';
import type { SessionPageData } from '../session/renderSessionPage.js';

export interface StagePageData {
  page: SessionPageData;
  /**
   * The session capability token (from the URL path) — used ONLY to build the
   * same-origin `POST /v1/stage/:token/respond` URL for the Open Moment
   * window (EPIC V #360 / V3 #364). It is already in the page's own URL, so
   * inlining it leaks nothing new. Only used when the manifest carries an
   * `open_moment` marker; otherwise the field is unused.
   */
  token: string;
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
  /**
   * The devotional's slot (T3 #350 residual): `examen` renders the
   * design's evening/dark variant (night/dusk grounds, candle accent,
   * paper text — "light for morning, dark evening"); `standard` the
   * light one. The variant is a `ws-evening` class on `<body>` plus CSS
   * custom-property overrides — layout, markup, timing, and script are
   * byte-identical between the two (the parity test pins this).
   */
  slotType: SlotType;
}

/**
 * Shared Stage chrome, styled per the Wellspring Design System (T3 #350,
 * epic #347): canvas→mist→dawn gradient ground, Spectral 300 scripture at
 * 26–36px (lh 1.4, text-wrap: pretty), Hanken Grotesk chrome, terracotta
 * as the ONLY accent (active tab pill, progress fill, caption-chip dot,
 * Begin CTA, brand circle), warm-tinted shadows, brand mark small in the
 * top-left corner. Fonts are self-hosted @font-face with the shared
 * literal's Georgia/system-ui fallback tails (wsTokens.ts) — the page is
 * correct with or without the woff2 files. `prefers-reduced-motion`
 * disables fades/transitions.
 *
 * ## Evening/examen variant (§08 dark set; #347 residual)
 *
 * Every themable value routes through a `--stage-*` role variable whose
 * light default lives on `:root` and whose dark override lives under
 * `body.ws-evening` — night ground into dusk, candle replacing terracotta
 * as THE accent, paper text, the candle glow replacing warm drop shadows.
 * `options.evening` adds ONLY the class to `<body>`; the CSS (including
 * the override block), markup, timing, and script are byte-identical
 * between variants, so autoplay/captions/manifest/404-parity behavior
 * structurally cannot fork. The brand circle deliberately stays
 * terracotta-gradient in BOTH variants (decorative, aria-hidden — brand
 * continuity over palette purity; it picks up the candle glow instead of
 * the warm shadow).
 */
function stageShell(
  title: string,
  bodyHtml: string,
  options: { withScript: boolean; evening?: boolean },
): string {
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
    --ws-night: ${WS.night};
    --ws-dusk: ${WS.dusk};
    --ws-candle: ${WS.candle};
    --ws-paper: ${WS.paper};
    --ws-muted-ink-dark: ${WS.mutedInkDark};
    --ws-ease: ${WS.ease};
    --ws-dur: ${WS.dur};
    --serif: ${WS_SERIF};
    --sans: ${WS_SANS};
    /* Role variables — light (morning) defaults. The evening/examen
       overrides live on body.ws-evening below; rules only ever read the
       role, never the palette directly, so the two variants cannot
       diverge structurally. */
    --stage-ground: var(--ws-canvas);
    --stage-ground-image: linear-gradient(180deg, var(--ws-canvas) 0%, var(--ws-mist) 68%, var(--ws-dawn) 100%);
    --stage-text: var(--ws-ink);
    --stage-accent: var(--ws-terracotta);
    --stage-secondary: var(--ws-clay);
    --stage-shadow: ${WS.shadow};
    --stage-shadow-hero: ${WS.shadowHero};
    --stage-pill-active-bg: rgba(255, 255, 255, 0.55);
    --stage-chip-bg: var(--ws-ink);
    --stage-chip-text: var(--ws-canvas);
    --stage-progress-track: rgba(180, 121, 90, 0.16);
    --stage-progress-fill: ${WS.gradientTerracotta.replace('145deg', '90deg')};
    --stage-cta-bg: ${WS.gradientTerracotta};
    --stage-cta-text: #fff;
    --stage-cta-shadow: ${WS.shadowCta};
    /* §05 verse-block ground — used by the Open Moment response panel. */
    --stage-verse-ground: ${WS.gradientVerse};
  }
  /* Evening/examen (§08 dark set): night→dusk ground, candle accent
     (11.75:1 on night — AA even at small sizes), paper text, the
     dark-set text role for secondary lines, and the candle glow as the
     only shadow. Same roles, same layout — palette only. */
  body.ws-evening {
    color-scheme: dark;
    --stage-ground: var(--ws-night);
    --stage-ground-image: linear-gradient(180deg, var(--ws-night) 0%, var(--ws-night) 55%, var(--ws-dusk) 100%);
    --stage-text: var(--ws-paper);
    --stage-accent: var(--ws-candle);
    --stage-secondary: var(--ws-muted-ink-dark);
    --stage-shadow: ${WS.glowDark};
    --stage-shadow-hero: ${WS.glowDark};
    --stage-pill-active-bg: rgba(36, 44, 64, 0.72);
    --stage-chip-bg: var(--ws-dusk);
    --stage-chip-text: var(--ws-paper);
    --stage-progress-track: rgba(231, 215, 166, 0.18);
    --stage-progress-fill: ${WS.gradientCtaDark.replace('145deg', '90deg')};
    --stage-cta-bg: ${WS.gradientCtaDark};
    --stage-cta-text: var(--ws-night);
    --stage-cta-shadow: ${WS.glowDark};
    /* Dusk→night verse-block ground so the response card reads as a lit
       panel on the evening stage rather than a bright card on dark. */
    --stage-verse-ground: linear-gradient(180deg, var(--ws-dusk) 0%, var(--ws-night) 100%);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--stage-ground);
    background-image: var(--stage-ground-image);
    color: var(--stage-text);
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
    color: var(--stage-text);
    z-index: 5;
  }
  .brand-circle {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: ${WS.gradientTerracotta};
    box-shadow: var(--stage-shadow);
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
    color: var(--stage-secondary);
    padding: 0.5rem 1.15rem;
    border: 1px solid transparent;
    border-radius: ${WS.radiusPill};
    transition: color 0.4s var(--ws-ease), border-color 0.4s var(--ws-ease), background-color 0.4s var(--ws-ease);
  }
  .tab-pill.active {
    color: var(--stage-text);
    border-color: var(--stage-accent);
    background: var(--stage-pill-active-bg);
    box-shadow: var(--stage-shadow);
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
  /* Eyebrow role (§03): Hanken 600 · 12px · uppercase · .22em · the accent
     (terracotta by day — the stage is a 1280×720 display surface, not
     axe-gated; the /session page darkens this role to clay for WCAG AA,
     see renderSessionPage — and candle by evening, 11.75:1 on night). */
  .eyebrow {
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--stage-accent);
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
    color: var(--stage-secondary);
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
    color: var(--stage-chip-text);
    background: var(--stage-chip-bg);
    border-radius: ${WS.radiusPill};
    padding: 0.62rem 1.5rem;
    max-width: 54rem;
    box-shadow: var(--stage-shadow-hero);
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
    background: var(--stage-accent);
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
    background: var(--stage-progress-track);
  }
  .progress-fill {
    height: 100%;
    width: 0%;
    background: var(--stage-progress-fill);
    transition: width 0.25s linear;
  }
  .begin-overlay {
    position: fixed;
    inset: 0;
    background: var(--stage-ground);
    background-image: var(--stage-ground-image);
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
    color: var(--stage-cta-text);
    background: var(--stage-cta-bg);
    border: none;
    border-radius: ${WS.radiusPill};
    padding: 1.05rem 2.6rem;
    box-shadow: var(--stage-cta-shadow);
    cursor: pointer;
  }
  .begin-button::before { content: '\\25B8'; font-size: 0.9em; }
  .begin-hint {
    font-family: var(--sans);
    font-size: 0.8rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--stage-secondary);
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
  /* ── Open Moment window (EPIC V #360 / V3 #364) ──────────────────────
     The listening state: the design's 7s breathing orb (scale+opacity),
     the accent-gradient body (terracotta by day, candle by evening), the
     question, and the invitation line. The orb goes STILL (no animation,
     no spinner) while the response is prepared — sacred silence, not a
     loading screen. */
  .om-orb {
    width: 128px;
    height: 128px;
    border-radius: 50%;
    margin: 0 0 2.1rem;
    background: radial-gradient(circle at 50% 38%, var(--stage-accent) 0%, var(--stage-secondary) 82%);
    box-shadow: var(--stage-shadow-hero);
    animation: om-breathe 7s var(--ws-ease) infinite;
    will-change: transform, opacity;
  }
  @keyframes om-breathe {
    0%, 100% { transform: scale(0.9); opacity: 0.72; }
    50% { transform: scale(1.06); opacity: 1; }
  }
  /* Held-silence state: the orb rests, breathing stops — never a spinner. */
  .om-orb.still { animation: none; transform: scale(1); opacity: 0.95; }
  .om-panel .question-text { max-width: 40rem; margin: 0; }
  .om-invitation {
    font-family: var(--sans);
    font-size: 0.95rem;
    font-weight: 500;
    letter-spacing: 0.02em;
    line-height: 1.6;
    color: var(--stage-secondary);
    margin: 1.5rem 0 0;
    max-width: 34rem;
  }
  /* §05 verse block — the response's on-camera provenance (reference +
     translation), warm verse ground, warm shadow, generous padding. */
  .om-verse-block {
    background: var(--stage-verse-ground);
    border-radius: ${WS.radiusCard};
    box-shadow: var(--stage-shadow);
    padding: 2.6rem 3rem 2.4rem;
    max-width: 52rem;
  }
  .om-verse-block .verse-attribution { margin-top: 1.6rem; }
  /* Visually-hidden aria-live region: window state changes announced to AT
     without adding anything to the 1280×720 composition. */
  .om-live {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .tab-pill, .panel, .caption-chip, .progress-fill, .begin-overlay { transition: none; }
    /* Orb still-frame at its resting size (no breathing) when motion is reduced. */
    .om-orb { animation: none; transform: scale(1); opacity: 0.95; }
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
<body${options.evening ? ' class="ws-evening"' : ''}>
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

  // Open Moment (EPIC V #360 / V3 #364): the window is enabled iff the timing
  // manifest carries an `open_moment` marker (V4 emits it only when generated
  // with the moment enabled AND the language has a confidently-phrased
  // invitation — ssmlBuilder.ts). Pre-#360 manifests never carry it, so the
  // markup + inlined config below are simply absent and every existing page
  // is byte-identical. The invitation LINE shown under the orb is the spoken
  // invitation text from that manifest row (already validated + escaped).
  const openMomentEntry = (manifest ?? []).find((row) => row.section === 'open_moment') ?? null;
  const openMomentEnabled = openMomentEntry !== null;
  const openMomentQuestion = journaling ?? actionStep ?? null;
  const openMomentPanels = openMomentEnabled
    ? `
    <section class="panel om-panel" id="panel-open-moment" aria-label="A moment to respond">
      <div class="om-orb" id="om-orb" aria-hidden="true"></div>
      <p class="eyebrow">Listening</p>
      ${openMomentQuestion ? `<p class="question-text">${escapeHtml(openMomentQuestion)}</p>` : ''}
      <p class="om-invitation">${escapeHtml(openMomentEntry.text)}</p>
    </section>
    <section class="panel om-response" id="panel-om-response" aria-label="A word in response">
      <div class="om-verse-block">
        <p class="verse-text" id="om-verse-text"></p>
        <p class="verse-attribution" id="om-verse-ref"></p>
      </div>
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
    </section>${openMomentPanels}
  </div>
  <div class="caption-zone">
    <div class="caption-chip" id="caption-chip" aria-live="polite"></div>
  </div>${openMomentEnabled ? '\n  <div class="om-live" id="om-live" role="status" aria-live="polite"></div>' : ''}
</main>
<div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
<div class="begin-overlay" id="begin-overlay">
  <button type="button" class="begin-button">Begin</button>
  <p class="begin-hint">A moment of rest is ready</p>
</div>
${audioHtml}${
    openMomentEnabled
      ? '\n<audio id="om-audio" preload="auto"></audio>'
      : ''
  }
<script type="application/json" id="stage-data">${inlineJson({
    manifest: manifest ?? [],
    hasQuestions,
    // Open Moment (EPIC V #360): `enabled` gates the whole window in the
    // client; `respondUrl` is the same-origin POST endpoint (connect-src
    // 'self'); `silenceCloseUrl` is the pre-synth Path-B clip — null until
    // V4 (#365) synthesizes + wires it, in which case Path B falls straight
    // into the prayer (feature #361: an omitted close does exactly that).
    openMoment: openMomentEnabled
      ? {
          enabled: true,
          respondUrl: `/v1/stage/${data.token}/respond`,
          silenceCloseUrl: null,
        }
      : { enabled: false },
  })}</script>`;

  return stageShell(`${devotional.theme} — Wellspring`, body, {
    withScript: true,
    evening: data.slotType === 'examen',
  });
}
