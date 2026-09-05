/**
 * LinguaShadow – app.js
 * Language Shadowing SPA – Vanilla JS (ES2020+, no framework)
 * ============================================================
 */

'use strict';

/* ── Constants ─────────────────────────────────────────────── */
const AUTO_LISTEN_DELAY_MS   = 1000;   // gap between TTS end → auto mic start
const AUTO_ADVANCE_DELAY_MS  = 1500;   // gap between result → auto-next (auto mode)
const AUTO_RETRY_DELAY_MS    = 2200;   // delay before auto-retry on low score
const SCORE_THRESHOLD        = 80;     // ≥80% → show Next/Retry; <80% → auto-retry loop
const MAX_STT_SILENT_MS      = 10000;

/* ── App State ─────────────────────────────────────────────── */
const state = {
  text:         '',
  language:     'de-DE',
  rate:         1.0,
  pitch:        1.0,
  autoMode:     true,
  sentences:    [],
  current:      0,
  scores:       [],
  startTime:    null,
  transcript:   '',
  score:        null,
  phase:        'idle',
  recognition:  null,
  ttsKeepAlive:  null,
  autoTimer:     null,
  retryCount:    0,     // how many auto-retries on current sentence
  selectedVoice: null,  // SpeechSynthesisVoice object chosen by user
  micPermission: false, // whether mic was pre-tested
  hearYourself:  false,
  hearMicStream: null,
  hearAudioEl:   null,
  hearVisCtx:    null,
  hearRafId:     null,
  // Voice playback after scoring
  mediaRecorder:    null,  // MediaRecorder for capturing user speech
  lastRecordingUrl: null,  // blob URL of last recorded speech
  recMicStream:     null,  // mic stream used by MediaRecorder
};

/* ── DOM Cache (populated after DOMContentLoaded) ──────────── */
let dom = {};

function buildDomCache() {
  const $ = id => document.getElementById(id);
  dom = {
    screenInput:      $('screen-input'),
    screenSession:    $('screen-session'),
    screenSummary:    $('screen-summary'),
    textInput:        $('text-input'),
    langSelect:       $('lang-select'),
    rateSlider:       $('rate-slider'),
    rateValue:        $('rate-value'),
    pitchSlider:      $('pitch-slider'),
    pitchValue:       $('pitch-value'),
    startBtn:         $('start-btn'),
    charCount:        $('char-count'),
    btnDemo:          $('btn-demo'),
    progressBar:      $('progress-bar'),
    progressLabel:    $('progress-label'),
    sentenceText:     $('sentence-text'),
    phaseBadge:       $('phase-badge'),
    waveform:         $('waveform'),
    transcriptBox:    $('transcript-box'),
    scoreDisplay:     $('score-display'),
    feedbackWords:    $('feedback-words'),
    btnListen:        $('btn-listen'),
    btnSlow:          $('btn-slow'),
    btnMic:           $('btn-mic'),
    micLabel:         $('mic-label'),
    btnTryAgain:      $('btn-try-again'),
    btnBack:          $('btn-back'),
    btnNext:          $('btn-next'),
    btnSkip:          $('btn-skip'),
    btnQuit:          $('btn-quit'),
    autoToggle:       $('auto-toggle'),
    autoLabel:        $('auto-label'),
    summaryAccuracy:  $('summary-accuracy'),
    summaryTime:      $('summary-time'),
    summarySentences: $('summary-sentences'),
    reviewList:       $('review-list'),
    btnPracticeAgain: $('btn-practice-again'),
    btnNewText:       $('btn-new-text'),
    toastContainer:   $('toast-container'),
    // Voice & mic UI (input screen)
    voiceSelect:       $('voice-select'),
    voiceQualityBadge: $('voice-quality-badge'),
    voiceHint:         $('voice-hint'),
    btnTestMic:        $('btn-test-mic'),
    micStatusBadge:    $('mic-status-badge'),
    micGuide:          $('mic-guide'),
    // Session screen
    btnHearYourself:   $('btn-hear-yourself'),
    retryInfo:         $('retry-info'),
    btnPlayRecording:  $('btn-play-recording'),
  };
}

/* ═══════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
═══════════════════════════════════════════════════════════════ */

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const key = `screen${name.charAt(0).toUpperCase() + name.slice(1)}`;
  if (dom[key]) dom[key].classList.add('active');
}

function toast(message, type = 'info', duration = 4000) {
  if (!dom.toastContainer) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  dom.toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // fallback removal
    setTimeout(() => { if (el.parentNode) el.remove(); }, 500);
  }, duration);
}

function splitSentences(text) {
  // Split on sentence-ending punctuation; also handle line breaks as separators
  const raw = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?؟])\s+|[\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 2);
  return raw.length > 0 ? raw : [text.trim()];
}

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(str) {
  return normalize(str).split(' ').filter(Boolean);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Levenshtein Distance ──────────────────────────────────── */
function levenshtein(a, b) {
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  const la = a.length, lb = b.length;
  // Use two-row rolling array for memory efficiency
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  let curr = new Array(lb + 1);
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

function computeScore(original, spoken) {
  const origTokens   = tokenize(original);
  const spokenTokens = tokenize(spoken);
  if (origTokens.length === 0) return 0;
  if (spokenTokens.length === 0) return 0;

  let matched = 0;
  const spokenCopy = [...spokenTokens];
  for (const w of origTokens) {
    const idx = spokenCopy.findIndex(sw => sw === w || levenshtein(sw, w) <= 1);
    if (idx !== -1) { matched++; spokenCopy.splice(idx, 1); }
  }
  const tokenScore = (matched / origTokens.length) * 100;

  const normOrig  = normalize(original);
  const normSpoke = normalize(spoken);
  const dist      = levenshtein(normOrig, normSpoke);
  const maxLen    = Math.max(normOrig.length, normSpoke.length) || 1;
  const levScore  = ((maxLen - dist) / maxLen) * 100;

  return Math.min(100, Math.round(tokenScore * 0.7 + levScore * 0.3));
}

function diffWords(original, spoken) {
  const origWords  = tokenize(original);
  const spokenCopy = [...tokenize(spoken)];
  const result     = [];

  for (const word of origWords) {
    const idx = spokenCopy.findIndex(sw => sw === word || levenshtein(sw, word) <= 1);
    if (idx !== -1) {
      result.push({ word, status: 'correct' });
      spokenCopy.splice(idx, 1);
    } else {
      result.push({ word, status: 'wrong' });
    }
  }
  for (const extra of spokenCopy) {
    result.push({ word: extra, status: 'extra' });
  }
  return result;
}

function scoreClass(score) {
  if (score >= 85) return { cls: 'score-excellent', label: '🌟 Ausgezeichnet' };
  if (score >= 70) return { cls: 'score-good',      label: '👍 Gut' };
  if (score >= 50) return { cls: 'score-fair',       label: '📈 Befriedigend' };
  return              { cls: 'score-poor',      label: '💪 Weiter üben' };
}

/* ═══════════════════════════════════════════════════════════════
   TTS (Text-to-Speech)
   Chrome has a bug where speechSynthesis pauses after ~15s.
   We use a keep-alive ping to prevent it.
═══════════════════════════════════════════════════════════════ */

function startTTSKeepAlive() {
  stopTTSKeepAlive();
  state.ttsKeepAlive = setInterval(() => {
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    } else {
      stopTTSKeepAlive();
    }
  }, 5000);
}

function stopTTSKeepAlive() {
  if (state.ttsKeepAlive) {
    clearInterval(state.ttsKeepAlive);
    state.ttsKeepAlive = null;
  }
}

function pickBestVoice(voices) {
  if (!voices || !voices.length) return null;
  const preferred = voices.find(v => /google|natural|neural|online/i.test(v.name));
  if (preferred) return preferred;
  const remote = voices.find(v => !v.localService);
  if (remote) return remote;
  return voices[0] || null;
}

function speakSentence(sentence, rate, onEnd) {
  if (!window.speechSynthesis) {
    toast('Your browser does not support Text-to-Speech.', 'error');
    if (onEnd) onEnd();
    return;
  }

  // Cancel any ongoing speech and ensure synthesis is not paused
  try {
    window.speechSynthesis.cancel();
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  } catch(e) {}
  stopTTSKeepAlive();

  const utter   = new SpeechSynthesisUtterance(sentence);
  utter.lang    = state.language || 'de-DE';
  utter.rate    = typeof rate === 'number' ? rate : state.rate;
  utter.pitch   = state.pitch;
  utter.volume  = 1;

  // Pick best matching voice using selectedVoice first, then auto-select
  const voices     = window.speechSynthesis.getVoices();
  const langCode   = (state.language || 'de-DE').split('-')[0].toLowerCase();

  let chosenVoice = null;
  if (state.selectedVoice) {
    const sName = typeof state.selectedVoice === 'string' ? state.selectedVoice : state.selectedVoice.name;
    chosenVoice = voices.find(v => v.name === sName) || null;
  }
  if (!chosenVoice && voices.length > 0) {
    const langVoices = voices.filter(v =>
      v.lang.toLowerCase() === (state.language || 'de-DE').toLowerCase() ||
      v.lang.toLowerCase().startsWith(langCode)
    );
    chosenVoice = pickBestVoice(langVoices) || voices.find(v => v.lang.toLowerCase().startsWith(langCode)) || voices[0] || null;
  }
  if (chosenVoice) utter.voice = chosenVoice;

  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    stopTTSKeepAlive();
    setWaveformActive(false);
    if (onEnd) onEnd();
  };

  utter.onstart = () => {
    setPhase('tts');
    setWaveformActive(true);
    startTTSKeepAlive();
  };

  utter.onend   = finish;
  utter.onerror = (e) => {
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      console.warn(`[TTS] ${e.error}`);
    }
    finish();
  };

  // Small delay needed in Chromium for cancel() to settle
  setTimeout(() => {
    try {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
      window.speechSynthesis.speak(utter);
    } catch (e) {
      console.error('[TTS] speak failed:', e);
      toast('TTS failed to start. Please try again.', 'error');
      finish();
    }
  }, 60);
}

function stopTTS() {
  stopTTSKeepAlive();
  try { window.speechSynthesis.cancel(); } catch(e) {}
  setWaveformActive(false);
}

/* ═══════════════════════════════════════════════════════════════
   STT (Speech-to-Text)
═══════════════════════════════════════════════════════════════ */

function getRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function startListening(onResult) {
  // Abort any previous session
  if (state.recognition) {
    try { state.recognition.abort(); } catch(e) {}
    state.recognition = null;
  }

  const SpeechRecognition = getRecognitionConstructor();
  if (!SpeechRecognition) {
    toast('Speech recognition is not supported. Please use Chrome or Edge.', 'error', 6000);
    setPhase('idle');
    return;
  }

  const rec = new SpeechRecognition();
  rec.continuous     = false;
  rec.interimResults = true;
  rec.lang           = state.language;
  rec.maxAlternatives = 1;
  state.recognition  = rec;

  let finalTranscript   = '';
  let interimTranscript = '';
  let silentTimer       = null;
  let hasStarted        = false;

  const clearSilentTimer = () => {
    if (silentTimer) { clearTimeout(silentTimer); silentTimer = null; }
  };

  rec.onstart = () => {
    hasStarted = true;
    setPhase('listening');
    dom.transcriptBox.textContent = '';
    dom.transcriptBox.classList.remove('has-content');
    dom.btnMic.classList.add('mic-btn-recording');
    dom.btnMic.classList.remove('mic-btn-idle');
    dom.micLabel.textContent = 'Listening…';
    setWaveformActive(true);
    // Abort if silence for too long
    silentTimer = setTimeout(() => {
      try { rec.stop(); } catch(e) {}
    }, MAX_STT_SILENT_MS);
  };

  rec.onresult = (e) => {
    clearSilentTimer();
    // Reset and rebuild from all results
    finalTranscript   = '';
    interimTranscript = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalTranscript   += r[0].transcript + ' ';
      else           interimTranscript += r[0].transcript;
    }
    const display = (finalTranscript + interimTranscript).trim();
    dom.transcriptBox.textContent = display;
    if (display) dom.transcriptBox.classList.add('has-content');
  };

  rec.onerror = (e) => {
    clearSilentTimer();
    resetMicBtn();
    setWaveformActive(false);
    const errMessages = {
      'not-allowed':  'Microphone access denied. Please allow microphone permissions in your browser and reload.',
      'no-speech':    'No speech detected. Try speaking closer to the mic.',
      'network':      'Network error. Speech recognition requires an internet connection.',
      'audio-capture':'No microphone found. Please connect a microphone.',
      'service-not-allowed': 'Speech service not allowed. Please use HTTPS or localhost.',
    };
    if (e.error !== 'aborted') {
      const msg = errMessages[e.error] || `Mic error: ${e.error}`;
      toast(msg, 'error', 6000);
    }
    setPhase(state.score !== null ? 'result' : 'idle');
    state.recognition = null;
  };

  rec.onend = () => {
    clearSilentTimer();
    resetMicBtn();
    setWaveformActive(false);
    state.recognition = null;

    const transcript = (finalTranscript + interimTranscript).trim();
    state.transcript = transcript;

    if (transcript) {
      onResult(transcript);
    } else {
      if (hasStarted) {
        toast('No speech detected. Try speaking louder or closer to the mic.', 'warning');
      }
      setPhase(state.score !== null ? 'result' : 'idle');
    }
  };

  try {
    rec.start();
  } catch(e) {
    toast('Could not start microphone. Please check permissions.', 'error');
    setPhase('idle');
    state.recognition = null;
  }
}

function stopListening() {
  if (state.recognition) {
    try { state.recognition.stop(); } catch(e) {}
    state.recognition = null;
  }
  resetMicBtn();
}

function resetMicBtn() {
  if (!dom.btnMic) return;
  dom.btnMic.classList.remove('mic-btn-recording');
  dom.btnMic.classList.add('mic-btn-idle');
  dom.micLabel.textContent = 'Sprechen starten';
}

/* ═══════════════════════════════════════════════════════════════
   UI PHASE CONTROL
═══════════════════════════════════════════════════════════════ */

function setPhase(phase) {
  state.phase = phase;

  const phaseConfig = {
    idle:      { badge: '⏳ Bereit',       cls: 'phase-ready',  micEnabled: true,  nextEnabled: false, tryEnabled: false },
    tts:       { badge: '🔊 Hören…',      cls: 'phase-listen', micEnabled: false, nextEnabled: false, tryEnabled: false },
    listening: { badge: '🎙️ Sprechen…',   cls: 'phase-speak',  micEnabled: true,  nextEnabled: false, tryEnabled: false },
    result:    { badge: '📊 Ergebnis',     cls: 'phase-result', micEnabled: true,  nextEnabled: true,  tryEnabled: true  },
  };

  const cfg = phaseConfig[phase] || phaseConfig.idle;

  if (dom.phaseBadge) {
    dom.phaseBadge.textContent = cfg.badge;
    dom.phaseBadge.className   = `phase-badge ${cfg.cls}`;
  }

  if (dom.btnMic)      dom.btnMic.disabled      = !cfg.micEnabled;
  if (dom.btnNext)     dom.btnNext.disabled     = !cfg.nextEnabled;
  if (dom.btnTryAgain) dom.btnTryAgain.disabled = !cfg.tryEnabled;
  if (dom.btnListen)   dom.btnListen.disabled   = (phase === 'tts' || phase === 'listening');
  if (dom.btnSlow)     dom.btnSlow.disabled     = (phase === 'tts' || phase === 'listening');

  // Sync mic button appearance
  if (phase !== 'listening') {
    if (dom.btnMic) {
      dom.btnMic.classList.remove('mic-btn-recording');
      dom.btnMic.classList.add('mic-btn-idle');
    }
    if (dom.micLabel) {
      dom.micLabel.textContent = (phase === 'result') ? 'Nochmal sprechen' : 'Sprechen starten';
    }
  }
}

function setWaveformActive(active) {
  if (dom.waveform) dom.waveform.classList.toggle('idle', !active);
}

/* ═══════════════════════════════════════════════════════════════
   SENTENCE RENDERING
═══════════════════════════════════════════════════════════════ */

function renderSentencePlain(sentence) {
  if (!dom.sentenceText) return;
  const words = sentence.split(/\s+/);
  dom.sentenceText.innerHTML = words
    .map(w => `<span class="word">${escHtml(w)}</span>`)
    .join(' ');
}

function renderSentenceDiff(sentence, diffResult) {
  if (!dom.sentenceText) return;
  const rawWords = sentence.split(/\s+/);
  // Work on a copy so we can mark used diff items
  const diffCopy = diffResult.map(d => ({ ...d, _used: false }));

  dom.sentenceText.innerHTML = rawWords.map(rw => {
    const normRw = normalize(rw);
    // Find matching diff entry
    const idx = diffCopy.findIndex(d => {
      if (d._used) return false;
      const normD = normalize(d.word);
      return normD === normRw || levenshtein(normD, normRw) <= 1;
    });
    let cls = 'word-wrong';
    if (idx !== -1) {
      diffCopy[idx]._used = true;
      cls = diffCopy[idx].status === 'correct' ? 'word-correct' : 'word-wrong';
    }
    return `<span class="word ${cls}">${escHtml(rw)}</span>`;
  }).join(' ');
}

/* ═══════════════════════════════════════════════════════════════
   SESSION LOGIC
═══════════════════════════════════════════════════════════════ */

function startSession() {
  const raw = dom.textInput ? dom.textInput.value.trim() : '';
  if (!raw) {
    toast('Bitte gib zuerst einen Übungstext ein.', 'warning');
    return;
  }

  state.text      = raw;
  state.language  = dom.langSelect ? dom.langSelect.value : 'de-DE';
  state.rate      = dom.rateSlider  ? parseFloat(dom.rateSlider.value)  : 1.0;
  state.pitch     = dom.pitchSlider ? parseFloat(dom.pitchSlider.value) : 1.0;
  state.autoMode  = dom.autoToggle ? dom.autoToggle.checked : true;
  state.sentences = splitSentences(raw);
  state.current   = 0;
  state.scores    = new Array(state.sentences.length).fill(null);
  state.startTime = Date.now();

  if (state.sentences.length === 0) {
    toast('Keine Sätze gefunden. Bitte überprüfe deinen Text.', 'warning');
    return;
  }

  showScreen('session');
  // Reset auto-toggle display
  if (dom.autoToggle) dom.autoToggle.checked = state.autoMode;
  if (dom.autoLabel)  dom.autoLabel.textContent = state.autoMode ? 'Auto ▶️' : 'Auto ⏸️';

  loadSentence(0);
}

function loadSentence(index) {
  if (index >= state.sentences.length) {
    showSummary();
    return;
  }

  state.current    = index;
  state.transcript = '';
  state.score      = null;
  state.retryCount = 0;

  clearTimeout(state.autoTimer);

  const sentence = state.sentences[index];
  const total    = state.sentences.length;

  const pct = (index / total) * 100;
  if (dom.progressBar)   dom.progressBar.style.width = `${pct}%`;
  if (dom.progressLabel) dom.progressLabel.textContent = `Satz ${index + 1} von ${total}`;

  renderSentencePlain(sentence);

  if (dom.transcriptBox) {
    dom.transcriptBox.textContent = 'Deine Sprache erscheint hier…';
    dom.transcriptBox.classList.remove('has-content');
  }
  if (dom.scoreDisplay)  dom.scoreDisplay.innerHTML  = '';
  if (dom.feedbackWords) dom.feedbackWords.innerHTML = '';
  if (dom.retryInfo)     dom.retryInfo.textContent   = '';

  setWaveformActive(false);
  setPhase('idle');

  // ── Auto-play TTS then open mic ONLY if Auto mode is ON ──
  if (state.autoMode) {
    state.autoTimer = setTimeout(() => {
      playCurrentSentence(false, () => {
        // TTS finished → wait briefly then open mic automatically
        state.autoTimer = setTimeout(() => {
          if (state.phase === 'idle') startSpeaking();
        }, AUTO_LISTEN_DELAY_MS);
      });
    }, 800);
  }
}

function playCurrentSentence(slow = false, onEnd = null) {
  if (state.sentences.length === 0 || state.current >= state.sentences.length) return;
  const sentence = state.sentences[state.current];
  const rate     = slow ? Math.max(0.5, state.rate * 0.65) : state.rate;
  speakSentence(sentence, rate, () => {
    // Only set to idle if we didn't already go to listening/result
    if (state.phase === 'tts') setPhase('idle');
    if (onEnd) onEnd();
  });
}

function startSpeaking() {
  if (state.phase === 'tts') {
    stopTTS();
    setPhase('idle');
    setTimeout(() => startListening(handleTranscript), 300);
    return;
  }
  if (state.phase === 'listening') {
    stopListening();
    stopVoiceCapture();
    setPhase(state.score !== null ? 'result' : 'idle');
    return;
  }
  // idle or result → start fresh
  // Hide old play button when new attempt starts
  if (dom.btnPlayRecording) dom.btnPlayRecording.style.display = 'none';
  startListening(handleTranscript);
  startVoiceCapture(); // record alongside STT
}

function handleTranscript(transcript) {
  if (!transcript || !state.sentences[state.current]) return;

  const sentence = state.sentences[state.current];
  const score    = computeScore(sentence, transcript);
  const diff     = diffWords(sentence, transcript);

  state.score      = score;
  state.transcript = transcript;

  // Save best score per sentence
  const prev = state.scores[state.current];
  if (!prev || score > prev.score) {
    state.scores[state.current] = { sentence, score, transcript };
  }

  // Show diff on sentence
  renderSentenceDiff(sentence, diff);

  // Transcript box
  if (dom.transcriptBox) {
    dom.transcriptBox.textContent = transcript;
    dom.transcriptBox.classList.add('has-content');
  }

  // Score badge
  const { cls, label } = scoreClass(score);
  if (dom.scoreDisplay) {
    dom.scoreDisplay.innerHTML = `
      <div class="score-badge ${cls}">
        <span>${score}%</span>
        <span style="font-size:0.7rem;font-weight:500;opacity:0.85;display:block;margin-top:1px">${label}</span>
      </div>`;
  }

  // Feedback words
  const missed = diff.filter(d => d.status === 'wrong').map(d => escHtml(d.word));
  const extras = diff.filter(d => d.status === 'extra').map(d => escHtml(d.word));
  let feedback = '';
  if (missed.length) feedback += `<span style="color:var(--danger);font-size:0.8rem">❌ Gefehlt: <em>${missed.join(', ')}</em></span>`;
  if (extras.length) feedback += `<span style="color:var(--warning);font-size:0.8rem;margin-left:0.75rem">➕ Hinzugefügt: <em>${extras.join(', ')}</em></span>`;
  if (!missed.length && !extras.length) feedback = `<span style="color:var(--success);font-size:0.8rem">✅ Perfekte Aussprache!</span>`;
  if (dom.feedbackWords) dom.feedbackWords.innerHTML = feedback;

  // ── SCORE-BASED BRANCHING ──
  if (score >= SCORE_THRESHOLD) {
    // ✅ Good score → show Next + Retry buttons
    setPhase('result');
    if (dom.retryInfo) dom.retryInfo.textContent = '';
    clearTimeout(state.autoTimer);

    // Stop capture → wait for recorded audio to be ready → play user recording first
    // Only trigger goToNextSentence() after the audio has finished playing (onended)
    if (state.autoMode) {
      stopVoiceCapture(() => {
        playLastRecording(() => goToNextSentence());
      });
    } else {
      stopVoiceCapture(() => {
        playLastRecording();
      });
    }
  } else {
    // ❌ Score too low → auto-retry
    stopVoiceCapture();
    state.retryCount++;
    setPhase('result');
    if (dom.btnNext) dom.btnNext.disabled = true;

    const countdown = Math.ceil(AUTO_RETRY_DELAY_MS / 1000);
    if (dom.retryInfo) {
      dom.retryInfo.textContent =
        `🔄 Ergebnis unter ${SCORE_THRESHOLD}% — Wiederholung in ${countdown}s… (Versuch ${state.retryCount})`;
      dom.retryInfo.style.color = 'var(--warning)';
    }
    toast(`Ergebnis ${score}% — Satz wird automatisch wiederholt…`, 'warning', AUTO_RETRY_DELAY_MS - 200);

    state.autoTimer = setTimeout(() => {
      renderSentencePlain(sentence);
      if (dom.transcriptBox) {
        dom.transcriptBox.textContent = 'Deine Sprache erscheint hier…';
        dom.transcriptBox.classList.remove('has-content');
      }
      if (dom.scoreDisplay)  dom.scoreDisplay.innerHTML  = '';
      if (dom.feedbackWords) dom.feedbackWords.innerHTML = '';
      if (dom.btnPlayRecording) dom.btnPlayRecording.style.display = 'none';
      state.score      = null;
      state.transcript = '';
      setPhase('idle');

      playCurrentSentence(false, () => {
        state.autoTimer = setTimeout(() => {
          if (state.phase === 'idle') startSpeaking();
        }, AUTO_LISTEN_DELAY_MS);
      });
    }, AUTO_RETRY_DELAY_MS);
  }
}

function tryAgain() {
  clearTimeout(state.autoTimer);
  stopTTS();
  if (state.recognition) stopListening();
  renderSentencePlain(state.sentences[state.current]);
  if (dom.transcriptBox) {
    dom.transcriptBox.textContent = 'Your speech will appear here…';
    dom.transcriptBox.classList.remove('has-content');
  }
  if (dom.scoreDisplay)  dom.scoreDisplay.innerHTML  = '';
  if (dom.feedbackWords) dom.feedbackWords.innerHTML = '';
  if (dom.retryInfo)     dom.retryInfo.textContent   = '';
  state.score      = null;
  state.transcript = '';
  setPhase('idle');

  // Auto-play TTS again then open mic ONLY if Auto mode is ON
  if (state.autoMode) {
    state.autoTimer = setTimeout(() => {
      playCurrentSentence(false, () => {
        state.autoTimer = setTimeout(() => {
          if (state.phase === 'idle') startSpeaking();
        }, AUTO_LISTEN_DELAY_MS);
      });
    }, 300);
  }
}

function nextSentence() {
  clearTimeout(state.autoTimer);
  stopTTS();
  stopListening();
  // Stop any still-playing recording audio
  try {
    if (state._activeRecordingAudio) {
      state._activeRecordingAudio.pause();
      state._activeRecordingAudio = null;
    }
  } catch(e) {}
  // Complete the progress bar
  const total = state.sentences.length;
  const pct   = ((state.current + 1) / total) * 100;
  if (dom.progressBar) dom.progressBar.style.width = `${pct}%`;
  setTimeout(() => loadSentence(state.current + 1), 120);
}

const goToNextSentence = nextSentence;
window.goToNextSentence = nextSentence;

function prevSentence() {
  clearTimeout(state.autoTimer);
  stopTTS();
  stopListening();
  stopVoiceCapture();

  // Don't go back if we're at the first sentence
  if (state.current <= 0) {
    toast('Bereits beim ersten Satz', 'info', 2000);
    return;
  }

  // Move to previous sentence
  const newIndex = state.current - 1;
  const total = state.sentences.length;
  const pct = (newIndex / total) * 100;
  if (dom.progressBar) dom.progressBar.style.width = `${pct}%`;

  toast('Zurück zum vorherigen Satz', 'info', 2000);
  setTimeout(() => loadSentence(newIndex), 100);
}

function skipSentence() {
  clearTimeout(state.autoTimer);
  stopTTS();
  stopListening();
  stopVoiceCapture();
  
  // Mark current sentence as skipped with null score
  state.scores[state.current] = { 
    sentence: state.sentences[state.current], 
    score: null, 
    transcript: 'Übersprungen' 
  };
  
  // Move to next sentence immediately
  const total = state.sentences.length;
  const pct   = ((state.current + 1) / total) * 100;
  if (dom.progressBar) dom.progressBar.style.width = `${pct}%`;
  
  toast('Satz übersprungen', 'info', 2000);
  setTimeout(() => loadSentence(state.current + 1), 100);
}

/* ═══════════════════════════════════════════════════════════════
   SUMMARY SCREEN
═══════════════════════════════════════════════════════════════ */

function showSummary() {
  clearTimeout(state.autoTimer);
  stopTTS();
  stopListening();

  const elapsed   = Math.round((Date.now() - state.startTime) / 1000);
  const scored    = state.scores.filter(Boolean);
  const avgScore  = scored.length
    ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length)
    : 0;
  const totalSent = state.sentences.length;
  const attempted = scored.length;

  if (dom.summaryAccuracy)  dom.summaryAccuracy.textContent  = `${avgScore}%`;
  if (dom.summaryTime)      dom.summaryTime.textContent      = formatTime(elapsed);
  if (dom.summarySentences) dom.summarySentences.textContent = `${attempted}/${totalSent}`;

  // Build review list – show sentences below 85%, sorted worst first
  const allItems = state.sentences.map((s, i) => ({
    sentence:   s,
    score:      state.scores[i]?.score    ?? null,
    transcript: state.scores[i]?.transcript ?? '(nicht geübt)',
  }));

  const toReview = allItems
    .filter(r => r.score === null || r.score < 85)
    .sort((a, b) => (a.score ?? -1) - (b.score ?? -1));

  if (dom.reviewList) {
    dom.reviewList.innerHTML = '';
    if (toReview.length === 0) {
      dom.reviewList.innerHTML = `
        <p style="color:var(--text-secondary);text-align:center;padding:1.5rem;">
          🎉 Alle Sätze mit 85%+ bestanden!
        </p>`;
    } else {
      for (const item of toReview) {
        const scoreVal = item.score !== null ? item.score : 0;
        const { cls }  = scoreClass(scoreVal);
        const el = document.createElement('div');
        el.className = 'review-item fade-in';
        el.innerHTML = `
          <span class="review-score-pill ${cls}">
            ${item.score !== null ? item.score + '%' : 'N/A'}
          </span>
          <div style="flex:1;min-width:0">
            <p style="font-size:0.875rem;color:var(--text-primary);margin-bottom:0.25rem;line-height:1.5">
              ${escHtml(item.sentence)}
            </p>
            <p style="font-size:0.75rem;color:var(--text-muted);font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              Du hast gesagt: "${escHtml(item.transcript)}"
            </p>
          </div>`;
        dom.reviewList.appendChild(el);
      }
    }
  }

  showScreen('summary');
  animateCountUp(dom.summaryAccuracy, avgScore, '%');
}

function animateCountUp(el, target, suffix = '') {
  if (!el) return;
  let current = 0;
  const step  = Math.max(1, Math.ceil(target / 45));
  const timer = setInterval(() => {
    current = Math.min(current + step, target);
    el.textContent = `${current}${suffix}`;
    if (current >= target) clearInterval(timer);
  }, 25);
}

function setupSummaryScreen() {
  if (dom.btnPracticeAgain) {
    dom.btnPracticeAgain.addEventListener('click', () => {
      clearTimeout(state.autoTimer);
      stopTTS();
      stopListening();
      stopVoiceCapture();
      state.scores = new Array(state.sentences.length).fill(null);
      state.startTime = Date.now();
      showScreen('session');
      loadSentence(0);
    });
  }

  if (dom.btnNewText) {
    dom.btnNewText.addEventListener('click', () => {
      clearTimeout(state.autoTimer);
      stopTTS();
      stopListening();
      stopVoiceCapture();
      if (dom.textInput) {
        dom.textInput.value = '';
        if (dom.charCount) dom.charCount.textContent = '0 Zeichen';
      }
      showScreen('input');
    });
  }
}

/* ═══════════════════════════════════════════════════════════════
   DEMO TEXTS
═══════════════════════════════════════════════════════════════ */

const DEMO_TEXTS = {
  'en-US': 'The quick brown fox jumps over the lazy dog. She sells seashells by the seashore. How much wood would a woodchuck chuck? Peter Piper picked a peck of pickled peppers. The rain in Spain stays mainly in the plain.',
  'de-DE': 'Fischers Fritz fischt frische Fische. Der Mondschein schien schon schön. Brautkleid bleibt Brautkleid und Blaukraut bleibt Blaukraut. Wenn Hinter Fliegen Fliegen fliegen.',
  'fr-FR': "Un chasseur sachant chasser sait chasser sans son chien. Les chaussettes de l'archiduchesse sont-elles sèches? Je suis ce que je suis.",
  'es-ES': 'Tres tristes tigres comían trigo en un trigal. Pablito clavó un clavito en la calva de un calvito. Cuando cuentes cuentos cuenta cuántos cuentas.',
  'ar-SA': 'كل يوم نتعلم شيئاً جديداً. العلم نور والجهل ظلام. الصبر مفتاح الفرج. من جد وجد ومن زرع حصد.',
};

function insertDemoText() {
  if (!dom.langSelect || !dom.textInput) return;
  const lang = dom.langSelect.value;
  dom.textInput.value = DEMO_TEXTS[lang] || DEMO_TEXTS['de-DE'];
  if (dom.charCount) dom.charCount.textContent = `${dom.textInput.value.length} Zeichen`;
}

/* ═══════════════════════════════════════════════════════════════
   BROWSER SUPPORT CHECK
═══════════════════════════════════════════════════════════════ */

function checkBrowserSupport() {
  const hasTTS = 'speechSynthesis' in window;
  const hasSTT = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  if (!hasTTS && !hasSTT) {
    toast('⚠️ Web Speech APIs werden nicht unterstützt. Bitte nutze Chrome oder Edge.', 'error', 8000);
    return false;
  }
  if (!hasTTS) {
    toast('⚠️ Text-to-Speech wird nicht unterstützt.', 'warning', 6000);
  }
  if (!hasSTT) {
    toast('⚠️ Spracherkennung wird nicht unterstützt.', 'warning', 6000);
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════════════════════════ */

function populateVoiceSelector() {
  if (!window.speechSynthesis || !dom.voiceSelect) return;
  const lang     = dom.langSelect ? dom.langSelect.value : (state.language || 'de-DE');
  const voices   = window.speechSynthesis.getVoices();
  const filtered = voices.filter(v => v.lang.startsWith(lang.split('-')[0]));
  const list     = filtered.length ? filtered : voices;
  dom.voiceSelect.innerHTML = '';
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' ★'}`;
    dom.voiceSelect.appendChild(o);
  });
  state.voiceList = list;
  if (state.selectedVoice) dom.voiceSelect.value = state.selectedVoice;
}

async function testMicrophoneAccess() {
  const btn = dom.btnTestMic;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Wird getestet…'; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    toast('✅ Das Mikrofon funktioniert einwandfrei!', 'success', 3000);
    if (btn) { btn.textContent = '✅ Mikrofon funktioniert'; btn.disabled = false; }
  } catch(err) {
    const msgs = {
      NotAllowedError:  '❌ Mikrofonberechtigung verweigert.',
      NotFoundError:    '❌ Kein Mikrofon gefunden.',
      NotReadableError: '❌ Das Mikrofon wird von einer anderen Anwendung verwendet.',
    };
    toast(msgs[err.name] || `❌ ${err.message}`, 'error', 5000);
    if (btn) { btn.textContent = '🎤 Mikrofon testen'; btn.disabled = false; }
  }
}

function setupInputScreen() {
  if (dom.textInput) {
    dom.textInput.addEventListener('input', () => {
      if (dom.charCount) dom.charCount.textContent = `${dom.textInput.value.length} Zeichen`;
    });
  }

  if (dom.rateSlider) {
    dom.rateSlider.addEventListener('input', () => {
      const v = parseFloat(dom.rateSlider.value);
      if (dom.rateValue) dom.rateValue.textContent = `${v.toFixed(1)}x`;
      state.rate = v;
    });
  }

  if (dom.pitchSlider) {
    dom.pitchSlider.addEventListener('input', () => {
      const v = parseFloat(dom.pitchSlider.value);
      if (dom.pitchValue) dom.pitchValue.textContent = v.toFixed(1);
      state.pitch = v;
    });
  }

  if (dom.startBtn) {
    dom.startBtn.addEventListener('click', () => {
      if (checkBrowserSupport()) startSession();
    });
  }

  if (dom.btnDemo) {
    dom.btnDemo.addEventListener('click', insertDemoText);
  }

  // Voice selector: update state when user picks a voice
  if (dom.voiceSelect) {
    dom.voiceSelect.addEventListener('change', () => {
      const voices = window.speechSynthesis.getVoices();
      const chosen = voices.find(v => v.name === dom.voiceSelect.value);
      state.selectedVoice = chosen || null;
      // Preview the voice
      if (chosen) {
        const previewText = {
          'en-US': 'Hello! This is a voice preview.',
          'de-DE': 'Hallo! Das ist eine Sprachvorschau.',
          'fr-FR': 'Bonjour! Ceci est un aperçu vocal.',
          'es-ES': '¡Hola! Esta es una vista previa de voz.',
          'ar-SA': 'مرحباً! هذا معاينة للصوت.',
        };
        const lang = dom.langSelect ? dom.langSelect.value : 'en-US';
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(previewText[lang] || previewText['en-US']);
        u.voice = chosen;
        u.lang  = lang;
        u.rate  = state.rate;
        u.pitch = state.pitch;
        setTimeout(() => window.speechSynthesis.speak(u), 80);
      }
    });
  }

  // Language selector: repopulate voices when language changes
  if (dom.langSelect) {
    dom.langSelect.addEventListener('change', () => {
      state.selectedVoice = null;
      populateVoiceSelector();
    });
  }

  // Mic test button
  if (dom.btnTestMic) {
    dom.btnTestMic.addEventListener('click', testMicrophoneAccess);
  }
}

function setupSessionScreen() {
  if (dom.btnListen)   dom.btnListen.addEventListener('click',   () => playCurrentSentence(false));
  if (dom.btnSlow)     dom.btnSlow.addEventListener('click',     () => playCurrentSentence(true));
  if (dom.btnMic)      dom.btnMic.addEventListener('click',      startSpeaking);
  if (dom.btnTryAgain) dom.btnTryAgain.addEventListener('click', tryAgain);
  if (dom.btnBack)     dom.btnBack.addEventListener('click',     prevSentence);
  if (dom.btnNext)     dom.btnNext.addEventListener('click',     nextSentence);
  if (dom.btnSkip)     dom.btnSkip.addEventListener('click',     skipSentence);

  if (dom.btnQuit) {
    dom.btnQuit.addEventListener('click', () => {
      clearTimeout(state.autoTimer);
      stopTTS();
      stopListening();
      stopHearYourself();
      showScreen('input');
    });
  }

  // Auto-advance toggle
  if (dom.autoToggle) {
    dom.autoToggle.addEventListener('change', () => {
      state.autoMode = dom.autoToggle.checked;
      if (dom.autoLabel) dom.autoLabel.textContent = state.autoMode ? 'Auto ▶️' : 'Auto ⏸️';
      toast(state.autoMode ? '▶️ الوضع التلقائي مفعّل' : '⏸️ الوضع التلقائي معطّل', 'info', 2500);
      if (state.autoMode && state.phase === 'idle') {
        playCurrentSentence(false, () => {
          state.autoTimer = setTimeout(() => {
            if (state.phase === 'idle') startSpeaking();
          }, AUTO_LISTEN_DELAY_MS);
        });
      }
    });
  }

  // Hear yourself toggle
  if (dom.btnHearYourself) {
    dom.btnHearYourself.addEventListener('click', toggleHearYourself);
  }
}

/* ═══════════════════════════════════════════════════════════════
   HEAR YOURSELF — Audio Element approach
   WHY: Chrome silently blocks ctx.destination mic routing.
   FIX: <audio>.srcObject = stream  (same as WebRTC — guaranteed).
═══════════════════════════════════════════════════════════════ */

async function toggleHearYourself() {
  if (state.hearYourself) { stopHearYourself(); return; }

  if (location.protocol === 'file:') {
    toast('❌ يجب فتح الموقع عبر http://localhost:8000', 'error', 6000);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    toast('❌ المتصفح لا يدعم الوصول للميكروفون', 'error', 5000);
    return;
  }

  const btn = dom.btnHearYourself;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري…'; }

  try {
    // echoCancellation MUST be false — otherwise the browser
    // cancels the speaker output signal before it reaches your ear!
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
      video: false,
    });

    // Create hidden <audio> and pipe the mic stream directly into it.
    // This is identical to how WebRTC renders remote audio — always works.
    const audioEl        = document.createElement('audio');
    audioEl.srcObject    = stream;
    audioEl.volume       = 1.0;
    audioEl.muted        = false;  // MUST not be muted
    audioEl.autoplay     = true;
    audioEl.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
    document.body.appendChild(audioEl);
    await audioEl.play();

    state.hearYourself  = true;
    state.hearMicStream = stream;
    state.hearAudioEl   = audioEl;

    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔊 تسمع صوتك • ON';
      btn.classList.replace('btn-secondary', 'btn-success');
      btn.style.boxShadow = '0 0 18px rgba(16,185,129,0.55)';
    }
    const volRow = document.getElementById('hear-vol-row');
    if (volRow) volRow.style.display = 'flex';

    toast('🎧 أنت تسمع صوتك الآن! استخدم سماعات أذن لتجنب الصدى.', 'success', 5000);

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '🎧 Hear Yourself'; }
    const msgs = {
      NotAllowedError:  '❌ تم رفض إذن الميكروفون — انقر على 🔒 في شريط العنوان واسمح بالوصول.',
      NotFoundError:    '❌ لم يُعثر على ميكروفون.',
      NotReadableError: '❌ الميك مستخدم من تطبيق آخر.',
    };
    toast(msgs[err.name] || `❌ ${err.message}`, 'error', 6000);
    console.error('[HearYourself]', err.name, err.message);
  }
}

function stopHearYourself() {
  if (!state.hearYourself) return;

  if (state.hearRafId) cancelAnimationFrame(state.hearRafId);
  try { if (state.hearVisCtx) state.hearVisCtx.close(); } catch(e) {}
  state.hearRafId  = null;
  state.hearVisCtx = null;

  try {
    if (state.hearAudioEl) {
      state.hearAudioEl.pause();
      state.hearAudioEl.srcObject = null;
      state.hearAudioEl.remove();
    }
  } catch(e) {}

  try {
    if (state.hearMicStream) state.hearMicStream.getTracks().forEach(t => t.stop());
  } catch(e) {}

  state.hearYourself  = false;
  state.hearMicStream = null;
  state.hearAudioEl   = null;

  const btn     = dom.btnHearYourself;
  const vuMeter = document.getElementById('vu-meter');
  const volRow  = document.getElementById('hear-vol-row');
  const statusEl = document.getElementById('hear-status-text');
  const vuBar   = document.getElementById('vu-bar');

  if (btn) {
    btn.textContent = '🎧 Hear Yourself';
    btn.classList.replace('btn-success', 'btn-secondary');
    btn.style.boxShadow = '';
    btn.disabled = false;
  }
  if (vuMeter) vuMeter.style.display = 'none';
  if (volRow)  volRow.style.display  = 'none';
  if (statusEl) statusEl.style.display = 'none';
  if (vuBar)   vuBar.style.width     = '0%';

  toast('🔇 تم إيقاف مراقبة الصوت.', 'info', 2000);
}

/** Called by the volume slider in HTML */
function setHearYourselfVolume(val) {
  const v = Math.max(0, Math.min(1, parseFloat(val)));
  if (state.hearAudioEl) state.hearAudioEl.volume = v;
  const lbl = document.getElementById('hear-vol-label');
  if (lbl) lbl.textContent = `${Math.round(v * 100)}%`;
}


/* ═══════════════════════════════════════════════════════════════
   HEAR YOURSELF  (start — was partially cut)
═══════════════════════════════════════════════════════════════ */

async function startHearYourself() {
  if (state.hearYourself) { stopHearYourself(); return; }

  if (location.protocol === 'file:') {
    toast('❌ يجب فتح الموقع عبر http://localhost:8000', 'error', 6000);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('❌ المتصفح لا يدعم الوصول للميكروفون', 'error', 5000);
    return;
  }

  const btn = dom.btnHearYourself;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري…'; }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });

    const audioEl        = document.createElement('audio');
    audioEl.srcObject    = stream;
    audioEl.volume       = 1.0;
    audioEl.muted        = false;
    audioEl.autoplay     = true;
    audioEl.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
    document.body.appendChild(audioEl);
    await audioEl.play();

    state.hearYourself  = true;
    state.hearMicStream = stream;
    state.hearAudioEl   = audioEl;

    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔊 تسمع صوتك • ON';
      btn.classList.replace('btn-secondary', 'btn-success');
      btn.style.boxShadow = '0 0 18px rgba(16,185,129,0.55)';
    }
    const volRow = document.getElementById('hear-vol-row');
    if (volRow) volRow.style.display = 'flex';

    toast('🎧 أنت تسمع صوتك الآن! استخدم سماعات أذن لتجنب الصدى.', 'success', 5000);

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '🎧 Hear Yourself'; }
    const msgs = {
      NotAllowedError:  '❌ تم رفض إذن الميكروفون — انقر على 🔒 في شريط العنوان واسمح بالوصول.',
      NotFoundError:    '❌ لم يُعثر على ميكروفون.',
      NotReadableError: '❌ الميك مستخدم من تطبيق آخر.',
    };
    toast(msgs[err.name] || `❌ ${err.message}`, 'error', 6000);
    console.error('[HearYourself]', err.name, err.message);
  }
}

/* ═══════════════════════════════════════════════════════════════
   VOICE CAPTURE & PLAYBACK
   Records user speech via MediaRecorder alongside STT.
   On score >= 80%: auto-plays so user hears own pronunciation.
═══════════════════════════════════════════════════════════════ */

async function startVoiceCapture() {
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) return;
  if (location.protocol === 'file:') return;

  try {
    const mimeType = getSupportedMimeType();
    const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const chunks   = [];

    recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      if (state.lastRecordingUrl) URL.revokeObjectURL(state.lastRecordingUrl);
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      state.lastRecordingUrl = URL.createObjectURL(blob);
      stream.getTracks().forEach(t => t.stop());
      state.recMicStream = null;
      // Notify waiting callback that the URL is ready
      if (state._onRecordingReady) {
        const cb = state._onRecordingReady;
        state._onRecordingReady = null;
        setTimeout(cb, 50);
      }
    };

    recorder.start(100);
    state.mediaRecorder = recorder;
    state.recMicStream  = stream;
  } catch(e) {
    console.warn('[VoiceCapture]', e.message);
  }
}

function stopVoiceCapture(onReady = null) {
  try {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      if (onReady) state._onRecordingReady = onReady;
      state.mediaRecorder.stop();
    } else {
      if (onReady) setTimeout(onReady, 100);
    }
  } catch(e) {
    if (onReady) setTimeout(onReady, 100);
  }
  state.mediaRecorder = null;
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4',''];
  return types.find(t => !t || MediaRecorder.isTypeSupported(t)) || '';
}

function playLastRecording(onEnd = null) {
  if (!state.lastRecordingUrl) {
    console.warn('[playLastRecording] No URL — skipping');
    if (onEnd) setTimeout(onEnd, 300);
    return;
  }

  // Stop any previously playing recording
  if (state._activeRecordingAudio) {
    try {
      state._activeRecordingAudio.pause();
      state._activeRecordingAudio.currentTime = 0;
    } catch(e) {}
    state._activeRecordingAudio = null;
  }

  const audio = new Audio(state.lastRecordingUrl);
  audio.volume = 1.0;
  state._activeRecordingAudio = audio;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    state._activeRecordingAudio = null;
    if (typeof onEnd === 'function') {
      onEnd();
    }
  };

  // ── Primary trigger: Wait until audio finishes playing completely ──
  audio.addEventListener('ended', () => {
    console.log('[playLastRecording] Audio playback finished completely (onended)');
    // Short comfortable breathing room before advancing
    setTimeout(finish, 400);
  }, { once: true });

  // ── Fallback error handler ──
  audio.addEventListener('error', (err) => {
    console.error('[playLastRecording] Audio playback error:', err);
    finish();
  }, { once: true });

  // ── Start playback ──
  audio.play().catch(err => {
    console.warn('[playLastRecording] Audio play() failed or blocked:', err.message);
    finish();
  });

  // UI feedback
  toast('🔊 استمع لنطقك الآن…', 'success', 2500);

  const btn = dom.btnPlayRecording;
  if (btn) {
    btn.style.display = 'inline-flex';
    btn.textContent   = '🔊 أعد تشغيل صوتك';
    if (!btn.hasAttribute('data-rplay-set')) {
      btn.setAttribute('data-rplay-set', '1');
      btn.addEventListener('click', () => {
        if (!state.lastRecordingUrl) return;
        const a = new Audio(state.lastRecordingUrl);
        a.volume = 1.0;
        btn.textContent = '▶️ يُشغَّل…';
        a.play().catch(() => {});
        a.addEventListener('ended', () => { btn.textContent = '🔊 أعد تشغيل صوتك'; }, { once: true });
      });
    }
  }
}

function showPlayButton() {
  if (!state.lastRecordingUrl) return;
  const btn = dom.btnPlayRecording;
  if (!btn) return;
  btn.style.display = 'inline-flex';
  btn.textContent   = '🔊 استمع لصوتك';
  if (!btn.hasAttribute('data-listener-set')) {
    btn.onclick = () => {
      if (!state.lastRecordingUrl) return;
      btn.textContent = '▶️ يُشغَّل…';
      const a = new Audio(state.lastRecordingUrl);
      a.volume = 1.0;
      a.play().catch(() => {});
      a.onended = () => { btn.textContent = '🔊 استمع لصوتك'; };
    };
    btn.setAttribute('data-listener-set', 'true');
  }
}

/* ═══════════════════════════════════════════════════════════════
   VOICE LIST
═══════════════════════════════════════════════════════════════ */

function populateVoiceList() {
  if (!window.speechSynthesis || !dom.voiceSelect) return;

  const lang      = state.language || 'de-DE';
  const allVoices  = window.speechSynthesis.getVoices();
  const filtered  = allVoices.filter(v => v.lang.startsWith(lang.split('-')[0]));
  const list      = filtered.length ? filtered : allVoices;

  dom.voiceSelect.innerHTML = '';
  list.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' ★'}`;
    dom.voiceSelect.appendChild(o);
  });
  state.voiceList = list;
}

/* ═══════════════════════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════════════════════ */

function setupEventListeners() {
  /* ── Keyboard shortcuts ── */
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.code === 'Space')      { e.preventDefault(); startSpeaking(); }
    if (e.code === 'ArrowRight') { e.preventDefault(); nextSentence(); }
    if (e.code === 'ArrowLeft')  { e.preventDefault(); prevSentence(); }
    if (e.code === 'KeyR')       { e.preventDefault(); playCurrentSentence(false); }
    if (e.code === 'KeyS')       { e.preventDefault(); playCurrentSentence(true); }
  });

  /* ── Voice list ── */
  if ('onvoiceschanged' in window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {
      populateVoiceSelector();
      populateVoiceList();
    };
  }
  populateVoiceSelector();
  populateVoiceList();
}

/* ═══════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════ */

function init() {
  buildDomCache();
  checkBrowserSupport();
  setupInputScreen();
  setupSessionScreen();
  setupSummaryScreen();
  setupEventListeners();
  showScreen('input');
  startTTSKeepAlive();
  console.log('[LinguaShadow] Ready ✓');
}

document.addEventListener('DOMContentLoaded', init);
