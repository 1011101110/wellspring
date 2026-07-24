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
import {
  OPEN_MOMENT_SILENCE_MS,
  OPEN_MOMENT_VAD_POLL_MS,
  OPEN_MOMENT_VAD_THRESHOLD,
  OPEN_MOMENT_WINDOW_MS,
  chooseOutcome,
  computeRms,
  findOpenMomentWindow,
  hasTranscript,
  isSpeechEnergy,
  openMomentExit,
  releaseStream,
  verseRevealMs,
} from './stageOpenMoment.js';

/**
 * DOM wiring around the embedded pure functions. Kept deliberately small
 * and boring (epic #330: "keep it small and boring"):
 *  - reads the server-inlined JSON (#stage-data: manifest + hasQuestions +
 *    the openMoment config);
 *  - Attendee container contract (Q2): attempt play() immediately, overlay
 *    only on rejection, retry on first pointer event; NO mic at load;
 *  - drives tab highlight + caption chip + progress bar from
 *    audio.currentTime (timeupdate + a 200ms interval — no rAF loop, the
 *    chip only changes a few times per section);
 *  - QUESTIONS activates at audio end, only when the page has questions;
 *  - the OPEN MOMENT window (EPIC V #360 / V3 #364): when playback crosses
 *    the manifest `open_moment` marker, opens the mic (the ONLY getUserMedia
 *    in the page, ONLY here, ONLY during the window), runs the energy VAD,
 *    and takes one of the two graceful exits (a validated response, or the
 *    honored silence) — everything downstream fails open to silence.
 */
const STAGE_WIRING_JS = `(function () {
  var dataEl = document.getElementById('stage-data');
  var data = { manifest: [], hasQuestions: false, openMoment: { enabled: false } };
  try {
    var parsed = JSON.parse(dataEl.textContent);
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch (e) { /* degrade to no-captions */ }
  var manifest = Array.isArray(data.manifest) ? data.manifest : [];
  var omConfig = (data.openMoment && typeof data.openMoment === 'object') ? data.openMoment : { enabled: false };

  var audio = document.getElementById('stage-audio');
  var overlay = document.getElementById('begin-overlay');
  var chip = document.getElementById('caption-chip');
  var progressFill = document.getElementById('progress-fill');
  var TABS = ['scripture', 'reflection', 'questions', 'prayer'];

  // Microphone policy (Q7 rehearsal finding, 2026-07-23; EPIC V #360). At
  // LOAD the page never touches the mic: Attendee's container patches the
  // mic API to pipe the MEETING's audio to the page as a virtual mic, and
  // when that track doesn't arrive within 10s it injects a red "Failed to
  // receive remote audio stream" banner into our DOM — on screen for every
  // participant (webpage_streamer_payload.js). Playback audio reaches the
  // Meet independent of the mic path (live-verified). The ONE deliberate
  // exception is the Open Moment window: getUserMedia is requested there and
  // ONLY there, mid-call, for the bounded listening window every participant
  // can see (the breathing orb) — the happy path the container's timeout was
  // designed around — and the stream is released the instant the window
  // ends. A test pins that getUserMedia appears ONLY inside that module.

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

  // === OPEN MOMENT WINDOW MODULE (EPIC V #360 / V3 #364) ===================
  // The ONLY getUserMedia in this page lives in startMic() below, reached
  // ONLY from the listening state, ONLY during the bounded window. State:
  //   idle → listening → thinking → (responding | closing) → done
  // The window is consumed at most once (omConsumed); every failure path
  // funnels to goSilence() → resumePrayer(), so no error ever renders.
  var omWindow = findOpenMomentWindow(manifest);
  var omPanel = document.getElementById('panel-open-moment');
  var omResponsePanel = document.getElementById('panel-om-response');
  var omOrb = document.getElementById('om-orb');
  var omAudio = document.getElementById('om-audio');
  var omLive = document.getElementById('om-live');
  var omVerseTextEl = document.getElementById('om-verse-text');
  var omVerseRefEl = document.getElementById('om-verse-ref');
  var OM_WINDOW_MS = ${OPEN_MOMENT_WINDOW_MS};
  var OM_SILENCE_MS = ${OPEN_MOMENT_SILENCE_MS};
  var OM_VAD_THRESHOLD = ${OPEN_MOMENT_VAD_THRESHOLD};
  var OM_VAD_POLL_MS = ${OPEN_MOMENT_VAD_POLL_MS};

  var omState = 'idle';
  var omConsumed = false;
  var omPaused = false;
  var omStream = null;
  var omAudioCtx = null;
  var omAnalyser = null;
  var omBuf = null;
  var omPollTimer = null;
  var omStartTime = 0;
  var omLastSpeechTime = 0;
  var omSpeechDetected = false;
  var omRecognition = null;
  var omTranscript = '';

  function omIsActive() {
    return omState === 'listening' || omState === 'thinking' ||
      omState === 'responding' || omState === 'closing';
  }

  function omShowPanel(el) {
    var panels = document.querySelectorAll('.panel');
    for (var i = 0; i < panels.length; i++) panels[i].classList.remove('active');
    if (el) el.classList.add('active');
  }

  function omAnnounce(msg) { if (omLive) omLive.textContent = msg; }

  function enterListening() {
    if (omConsumed || omState !== 'idle') return;
    omState = 'listening';
    omConsumed = true;
    omStartTime = Date.now();
    omSpeechDetected = false;
    omLastSpeechTime = 0;
    omTranscript = '';
    if (chip) chip.classList.remove('visible');
    if (omOrb) omOrb.classList.remove('still');
    omShowPanel(omPanel);
    // The question is now the screen; mark the QUESTIONS pill active for
    // continuity (the panel it points to is replaced by the orb panel).
    var qpill = document.getElementById('tab-questions');
    if (qpill) {
      var pills = document.querySelectorAll('.tab-pill');
      for (var k = 0; k < pills.length; k++) pills[k].classList.remove('active');
      qpill.classList.add('active');
    }
    omAnnounce('Listening');
    startMic();
  }

  // The ONE getUserMedia call in the page — only reachable from
  // enterListening(), only during the window. Denial/absence is non-fatal:
  // it takes the honored-silence path (feature #361 Path B).
  function startMic() {
    var md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') { endListening('denied'); return; }
    md.getUserMedia({ audio: true }).then(function (stream) {
      if (omState !== 'listening') { releaseStream(stream); return; }
      omStream = stream;
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        omAudioCtx = new Ctx();
        var source = omAudioCtx.createMediaStreamSource(stream);
        omAnalyser = omAudioCtx.createAnalyser();
        omAnalyser.fftSize = 1024;
        omBuf = new Float32Array(omAnalyser.fftSize);
        source.connect(omAnalyser);
      } catch (e) { omAnalyser = null; }
      startRecognition();
      omPollTimer = setInterval(pollVad, OM_VAD_POLL_MS);
    }).catch(function () { endListening('denied'); });
  }

  // Best-effort in-browser transcript (the "text path" — the STT seam;
  // routes/stage.ts). Absent SpeechRecognition is fine: no transcript →
  // the silence path. The energy VAD, not this, owns end-of-speech.
  function startRecognition() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    try {
      omRecognition = new SR();
      omRecognition.continuous = true;
      omRecognition.interimResults = false;
      omRecognition.onresult = function (ev) {
        var text = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i] && ev.results[i][0]) text += ev.results[i][0].transcript + ' ';
        }
        if (text) omTranscript = (omTranscript + ' ' + text).replace(/^\\s+|\\s+$/g, '');
      };
      omRecognition.onerror = function () {};
      omRecognition.start();
    } catch (e) { omRecognition = null; }
  }

  function pollVad() {
    if (omState !== 'listening') return;
    var rms = 0;
    if (omAnalyser && omBuf) {
      if (omAnalyser.getFloatTimeDomainData) omAnalyser.getFloatTimeDomainData(omBuf);
      rms = computeRms(omBuf);
    }
    var now = Date.now();
    if (isSpeechEnergy(rms, OM_VAD_THRESHOLD)) {
      omSpeechDetected = true;
      omLastSpeechTime = now;
    }
    var silence = omSpeechDetected ? (now - omLastSpeechTime) : 0;
    var elapsed = now - omStartTime;
    var decision = openMomentExit(omSpeechDetected, silence, elapsed, OM_WINDOW_MS, OM_SILENCE_MS);
    if (decision === 'end-speech') endListening('speech');
    else if (decision === 'end-cap') endListening('cap');
  }

  function endListening(reason) {
    if (omState !== 'listening') return;
    omState = 'thinking';
    if (omPollTimer) { clearInterval(omPollTimer); omPollTimer = null; }
    if (omRecognition) { try { omRecognition.stop(); } catch (e) {} omRecognition = null; }
    if (omAudioCtx) { try { omAudioCtx.close(); } catch (e) {} omAudioCtx = null; }
    // Release the mic immediately — the window is over (feature #361).
    releaseStream(omStream);
    omStream = null;
    // Orb to a STILL held-silence state — NOT a spinner (this is sacred
    // silence, not loading).
    if (omOrb) omOrb.classList.add('still');
    omAnnounce('A moment of stillness');
    if (reason === 'denied' || !omSpeechDetected || !hasTranscript(omTranscript)) {
      goSilence();
      return;
    }
    postTranscript(omTranscript);
  }

  function postTranscript(transcript) {
    var url = omConfig.respondUrl;
    if (!url) { goSilence(); return; }
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: transcript })
    }).then(function (r) {
      if (!r.ok) throw new Error('bad status');
      return r.json();
    }).then(function (env) {
      if (chooseOutcome(env) === 'response') playResponse(env);
      else goSilence();
    }).catch(function () { goSilence(); });
  }

  function playResponse(env) {
    if (omState === 'done') return;
    omState = 'responding';
    var verse = env.verse || {};
    // textContent only — LLM-chosen bytes never become markup.
    if (omVerseTextEl) omVerseTextEl.textContent = verse.fetchedText || '';
    if (omVerseRefEl) {
      omVerseRefEl.textContent = (verse.reference || '') +
        (verse.attribution ? ' \\u00b7 ' + verse.attribution : '');
    }
    var revealed = false;
    function revealVerse() {
      if (revealed) return;
      revealed = true;
      omShowPanel(omResponsePanel);
      omAnnounce('A word for you' + (verse.reference ? ': ' + verse.reference : ''));
    }
    var revealTimer = setTimeout(revealVerse, verseRevealMs(env.durations));
    if (omAudio) {
      omAudio.src = env.audioUrl;
      omAudio.addEventListener('ended', function () { resumePrayer(); }, { once: true });
      var p;
      try { p = omAudio.play(); } catch (e) { p = null; }
      if (p && typeof p.then === 'function') {
        p['catch'](function () {
          // Autoplay blocked — reveal the verse and resume anyway (fail-open).
          clearTimeout(revealTimer); revealVerse(); resumePrayer();
        });
      }
    } else {
      clearTimeout(revealTimer);
      revealVerse();
      resumePrayer();
    }
  }

  // Path B / any failure (feature #361): honor the silence with the
  // pre-synth close when V4 provides one, else fall straight into the
  // prayer. NEVER an error state on camera.
  function goSilence() {
    if (omState === 'done') return;
    omState = 'closing';
    var closeUrl = omConfig.silenceCloseUrl;
    if (closeUrl && omAudio) {
      omAudio.src = closeUrl;
      omAudio.addEventListener('ended', function () { resumePrayer(); }, { once: true });
      var p;
      try { p = omAudio.play(); } catch (e) { p = null; }
      if (p && typeof p.then === 'function') p['catch'](function () { resumePrayer(); });
    } else {
      resumePrayer();
    }
  }

  function resumePrayer() {
    if (omState === 'done') return;
    omState = 'done';
    omShowPanel(null);
    if (audio && omWindow) {
      if (audio.currentTime < omWindow.resumeSec - 0.05) {
        try { audio.currentTime = omWindow.resumeSec; } catch (e) {}
      }
      var pp;
      try { pp = audio.play(); } catch (e) { pp = null; }
      if (pp && typeof pp.then === 'function') pp['catch'](function () {});
    }
    tick();
  }
  // === END OPEN MOMENT WINDOW MODULE ======================================

  function setCaption(t) {
    if (!chip) return;
    // The window owns the screen (question + orb); no caption chip during it.
    if (omIsActive()) { chip.classList.remove('visible'); return; }
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
    // Open Moment (EPIC V #360): open the window when playback crosses the
    // marker; pause at the resume point so the prayer waits for the exit.
    if (omConfig.enabled && omWindow) {
      if (omState === 'idle' && !omConsumed && t >= omWindow.startSec) {
        enterListening();
      }
      if (omIsActive() && !omPaused && t >= omWindow.resumeSec - 0.05) {
        omPaused = true;
        try { audio.pause(); } catch (e) {}
      }
      if (omIsActive()) {
        if (chip) chip.classList.remove('visible');
        return; // the state machine owns the panels + progress during the window
      }
    }
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
    // Open Moment (EPIC V #360 / V3 #364) pure functions — embedded like the
    // timeline math so the unit-tested functions ARE the shipped ones.
    findOpenMomentWindow.toString(),
    openMomentExit.toString(),
    computeRms.toString(),
    isSpeechEnergy.toString(),
    chooseOutcome.toString(),
    hasTranscript.toString(),
    verseRevealMs.toString(),
    releaseStream.toString(),
    STAGE_WIRING_JS,
  ].join('\n\n');
}
