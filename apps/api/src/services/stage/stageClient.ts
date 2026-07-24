/**
 * Builds the Stage page's client script (served same-origin at
 * /stage/assets/stage.js — the stage scope's CSP is `script-src 'self'`,
 * no CDN, no inline). Vanilla JS, no bundler/framework — the room page's
 * join.js is the precedent (Q2 #332).
 *
 * The timeline math (sectionAt/tabAt/splitCaptionLines/captionAt) is
 * embedded via `Function.prototype.toString()` from stageTimeline.ts so
 * the unit-tested functions ARE the shipped ones — see that file's
 * dual-runtime constraint note. tsc (our only build step — no minifier)
 * preserves function declaration names, so the embedded bodies resolve
 * each other in the concatenated script scope.
 */
import { captionAt, sectionAt, splitCaptionLines, tabAt } from './stageTimeline.js';

/**
 * DOM wiring around the embedded pure functions. Kept deliberately small
 * and boring (epic #330: "keep it small and boring"):
 *  - reads the server-inlined JSON (#stage-data: manifest + hasQuestions);
 *  - Attendee container contract (Q2): request mic permission at load
 *    (denial non-fatal), attempt play() immediately, overlay only on
 *    rejection, retry on first pointer event;
 *  - drives tab highlight + caption chip + progress bar from
 *    audio.currentTime (timeupdate + a 200ms interval — no rAF loop, the
 *    chip only changes a few times per section);
 *  - QUESTIONS activates at audio end, only when the page has questions.
 */
const STAGE_WIRING_JS = `(function () {
  var dataEl = document.getElementById('stage-data');
  var data = { manifest: [], hasQuestions: false };
  try {
    var parsed = JSON.parse(dataEl.textContent);
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch (e) { /* degrade to no-captions */ }
  var manifest = Array.isArray(data.manifest) ? data.manifest : [];

  var audio = document.getElementById('stage-audio');
  var overlay = document.getElementById('begin-overlay');
  var chip = document.getElementById('caption-chip');
  var progressFill = document.getElementById('progress-fill');
  var TABS = ['scripture', 'reflection', 'questions', 'prayer'];

  // Deliberately NO microphone request (Q7 rehearsal finding, 2026-07-23).
  // Attendee's container patches the mic API: a mic request makes it open a
  // WebRTC path that pipes the MEETING's audio to the page as a virtual mic
  // (for two-way voice agents that listen), and when that track doesn't
  // arrive within 10s it injects a red "Failed to receive remote audio
  // stream" banner into our DOM — on screen for every participant. This
  // playback-only page never consumes meeting audio, and outgoing audio is
  // captured from the page's output independent of the mic path
  // (live-verified: audio reached the Meet while the virtual mic failed).
  // Requesting the mic here buys nothing and risks the banner; see
  // attendee-labs/attendee bots/webpage_streamer/webpage_streamer_payload.js.
  // A test pins that the mic API name never re-appears in this script.

  var activeTab = 'scripture';
  function setTab(tab) {
    if (tab === activeTab || !document.getElementById('panel-' + tab)) return;
    activeTab = tab;
    for (var i = 0; i < TABS.length; i++) {
      var name = TABS[i];
      var pill = document.getElementById('tab-' + name);
      var panel = document.getElementById('panel-' + name);
      if (!pill || !panel) continue;
      if (name === tab) {
        pill.classList.add('active');
        panel.classList.add('active');
      } else {
        pill.classList.remove('active');
        panel.classList.remove('active');
      }
    }
  }

  var started = false;
  var endedFlag = false;

  function setCaption(t) {
    if (!chip) return;
    // Chip hidden before play starts and during stillness rows (#333).
    var caption = started && !endedFlag ? captionAt(manifest, t) : null;
    if (!caption) {
      chip.classList.remove('visible');
      return;
    }
    if (chip.textContent !== caption.line) chip.textContent = caption.line;
    chip.classList.add('visible');
  }

  function tick() {
    if (!audio) return;
    var t = audio.currentTime || 0;
    // Scrubbing back after the end resumes the guided timeline (paused or
    // playing) — without this the page would stay frozen on QUESTIONS
    // after any post-end seek.
    if (endedFlag && audio.duration > 0 && t < audio.duration - 0.3) {
      endedFlag = false;
    }
    if (!endedFlag) {
      var tab = tabAt(manifest, t);
      if (tab) setTab(tab);
    }
    setCaption(t);
    // The audio element's own duration, NOT the manifest's last endSec —
    // a manifest/audio mismatch must not strand the bar short of 100% (#333).
    if (progressFill && audio.duration > 0 && isFinite(audio.duration)) {
      var pct = Math.min(100, (t / audio.duration) * 100);
      progressFill.style.width = pct + '%';
    }
  }

  function onEnded() {
    endedFlag = true;
    if (chip) chip.classList.remove('visible');
    if (progressFill) progressFill.style.width = '100%';
    // journalingPrompt/actionStep are never spoken — they surface when the
    // audio ends, and only for formats that have them (Q2 #332).
    if (data.hasQuestions) setTab('questions');
  }

  if (!audio) return;

  audio.addEventListener('play', function () { started = true; });
  audio.addEventListener('timeupdate', tick);
  audio.addEventListener('seeked', tick);
  audio.addEventListener('ended', onEnded);
  setInterval(tick, 200);

  // Autoplay-in-container (epic #330 risk): attempt play() immediately —
  // Attendee's container auto-grants and the overlay never appears. A
  // normal browser may reject un-gestured play; then show the overlay and
  // retry on the first pointer event anywhere (Q2 #332 point 5).
  function tryPlay() {
    var p;
    try {
      p = audio.play();
    } catch (e) {
      p = null;
    }
    if (p && typeof p.then === 'function') {
      p.then(function () {
        if (overlay) overlay.classList.remove('visible');
      }).catch(function () {
        if (overlay) overlay.classList.add('visible');
      });
    }
  }
  tryPlay();
  document.addEventListener('pointerdown', function () {
    if (overlay && overlay.classList.contains('visible')) tryPlay();
  });
})();
`;

export function buildStageClientJs(): string {
  return [
    '"use strict";',
    splitCaptionLines.toString(),
    sectionAt.toString(),
    tabAt.toString(),
    captionAt.toString(),
    STAGE_WIRING_JS,
  ].join('\n\n');
}
