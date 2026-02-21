/* ════════════════════════════════════════════════════════════════
   RSVPReader v4.0 — app.js
   ────────────────────────────────────────────────────────────────
   v4.0 CHANGES
   1.  parser.js loaded as a plain <script> before this file.
       EPUB support DROPPED.
   2.  RAF LOOP: Phase-locked ping-pong rAF replaces setTimeout.
       Pre-allocated Float32Array for durations. Zero heap
       allocations in the hot render path.
   3.  ADAPTIVE CHUNK CENTERING: chunkSize > 1 → centred block +
       25 ms cognitive-reset blank. chunkSize = 1 → ORP two-half.
       Vguide hidden in multi-word mode.
   4.  WPM EMOJI BADGE relocated to #stage-badges next to live WPM.
   5.  FLOATING PROGRESS PERCENTAGE above seek slider.
   6.  TTS REWRITE: 12-word micro-chunks, local-voice priority,
       10 s heartbeat, strong reference array prevents GC.
   7.  PROGRESS PERSISTENCE: localStorage auto-save + resume prompt.
   8.  SECURITY: SRI + CSP implemented in index.html.
   ════════════════════════════════════════════════════════════════ */
'use strict';


/* ── PDF.js worker bootstrap ──────────────────────────────────── */
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ══════════════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════════════ */
const HISTORY_SIZE   = 15;
const SPARKLINE_MAX  = 60;
const WPM_SAMPLE_N   = 8;
const WORDS_PER_PAGE = 250;
const FONT_MAX       = 420;

/* TTS: 10–15 word chunks per spec */
const TTS_CHUNK_SIZE  = 12;
/* TTS heartbeat: 10 s (not 14 s) per spec */
const TTS_HEARTBEAT_MS = 10000;

/* Cognitive-reset blank between multi-word chunks (Change 3) */
const BLANK_MULTI_MS  = 25;

/* localStorage key for progress persistence (Change 7) */
const LS_KEY = 'rsvp_progress';
/* Save to localStorage every N seconds during playback */
const LS_SAVE_INTERVAL_MS = 5000;

const COMMON_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'it','is','was','are','be','been','by','from','as','we','he','she','they',
  'you','i','my','your','our','his','her','its','this','that','these','those',
  'not','no','so','if','up','do','did','can','will','just','all','one','had',
  'has','have','would','could','should','may','might','than','then','when',
  'who','what','how','am','were','get','got','go','went','see','say','said',
  'know','think','come','also','very','well','more','over','into','out','about',
  'like','im','id','ive','dont','wont','cant','isnt','wasnt','arent'
]);

const RARE_WORD_MIN_LEN  = 9;
const RE_SENTENCE_END    = /[.!?…]+['"]?\s*$/;
const RE_CLAUSE_END      = /[,;:—–]+\s*$/;
const RE_SENTENCE_START  = /^[A-Z]/;

/* ── WPM Emoji bands ──────────────────────────────────────────── */
const WPM_BANDS = [
  { max:199,  emoji:'🐢', label:'Crawling',       bg:'#1a2a4a', border:'#2a4a7a' },
  { max:299,  emoji:'😴', label:'Drowsy',          bg:'#1e2a3a', border:'#3a4a6a' },
  { max:399,  emoji:'🚶', label:'Strolling',       bg:'#252a35', border:'#404858' },
  { max:499,  emoji:'🚴', label:'Cycling',         bg:'#1a3030', border:'#2a5050' },
  { max:599,  emoji:'🏃', label:'Running',         bg:'#1a3020', border:'#2a5030' },
  { max:699,  emoji:'⚡', label:'Charged',         bg:'#3a3010', border:'#6a5010' },
  { max:799,  emoji:'🚀', label:'Sweet spot ✦',    bg:'#3a2a10', border:'#7a5010' },
  { max:899,  emoji:'🔥', label:'Expert zone',     bg:'#3a1a0a', border:'#8a3a0a' },
  { max:999,  emoji:'💀', label:'Human limit',     bg:'#3a0a0a', border:'#8a1010' },
  { max:1499, emoji:'☢️', label:'Beyond human',    bg:'#2a0000', border:'#6a0000' },
  { max:9999, emoji:'🌀', label:'Ludicrous',       bg:'#0a0a0a', border:'#444'    },
];

/* ══════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════ */
const state = {
  words:          [],
  chapters:       [],
  bookmarks:      [],
  currentIndex:   0,
  isPlaying:      false,
  wpm:            700,
  fontSize:       64,
  fontFamily:     "'Courier New', Courier, monospace",
  chunkSize:      1,
  blankFlash:     false,
  speedRamp:      true,
  ttsEnabled:     false,
  loaded:         false,
  fileName:       '',
  wordHistory:    [],
  sessionStart:   null,
  totalPlayMs:    0,
  playStartTs:    null,
  wpmHistory:     [],
  wpmSampleCount: 0,
  wpmLastTs:      null,
  ttsSupported:   typeof window !== 'undefined' && !!window.speechSynthesis,
  ttsResumeTimer: null,
  ttsVoice:       null,
  focusActive:    false,
  focusHintTimer: null,
  pendingConfirm: null,
  touchStartX:    0,
  touchStartY:    0,
};

/* ══════════════════════════════════════════════════
   ELEMENT CACHE  (queried once at startup)
   ══════════════════════════════════════════════════ */
const el = {
  themeBtns:            document.querySelectorAll('.theme-btn'),
  btnToc:               document.getElementById('btn-toc'),
  btnBookmarks:         document.getElementById('btn-bookmarks'),
  btnStats:             document.getElementById('btn-stats'),
  btnFocus:             document.getElementById('btn-focus'),
  btnShortcut:          document.getElementById('btn-shortcut'),
  btnExport:            document.getElementById('btn-export'),
  btnImport:            document.getElementById('btn-import'),
  importFileInput:      document.getElementById('import-file-input'),
  uploadZone:           document.getElementById('upload-zone'),
  dropArea:             document.getElementById('drop-area'),
  fileInput:            document.getElementById('file-input'),
  fileBar:              document.getElementById('file-bar'),
  fileBarName:          document.getElementById('file-bar-name'),
  changeFileBtn:        document.getElementById('change-file-btn'),
  loadingOverlay:       document.getElementById('loading-overlay'),
  loadingFilename:      document.getElementById('loading-filename-display'),
  loadingFill:          document.getElementById('loading-progress-fill'),
  loadingPageInfo:      document.getElementById('loading-page-info'),
  loadingPct:           document.getElementById('loading-pct-display'),
  loadingLog:           document.getElementById('loading-log'),
  historyStrip:         document.getElementById('word-history-strip'),
  wordStage:            document.getElementById('word-stage'),
  stageVguide:          document.getElementById('stage-vguide'),
  stageMessage:         document.getElementById('stage-message'),
  wordDisplay:          document.getElementById('word-display'),
  wordLeft:             document.getElementById('word-left'),
  wordRight:            document.getElementById('word-right'),
  wordBefore:           document.getElementById('word-before'),
  wordPivot:            document.getElementById('word-pivot'),
  wordAfter:            document.getElementById('word-after'),
  /* Change 3: new centered block for multi-word chunks */
  wordCenterBlock:      document.getElementById('word-center-block'),
  wordCenterText:       document.getElementById('word-center-text'),
  /* Change 4: badges wrapper (relocated) */
  liveWpmBadge:         document.getElementById('live-wpm-badge'),
  liveWpmValue:         document.getElementById('live-wpm-value'),
  wpmEmoji:             document.getElementById('wpm-emoji'),
  wpmEmojiLabel:        document.getElementById('wpm-emoji-label'),
  wpmEmojiBadge:        document.getElementById('wpm-emoji-badge'),
  /* Change 5: progress tooltip */
  progressPctTooltip:   document.getElementById('progress-pct-tooltip'),
  progressSlider:       document.getElementById('progress-slider'),
  progressChapterMarks: document.getElementById('progress-chapter-markers'),
  btnRestart:           document.getElementById('btn-restart'),
  btnBack10:            document.getElementById('btn-back10'),
  btnPlayPause:         document.getElementById('btn-playpause'),
  btnFwd10:             document.getElementById('btn-fwd10'),
  btnEnd:               document.getElementById('btn-end'),
  sliderWpm:            document.getElementById('slider-wpm'),
  wpmDisplay:           document.getElementById('wpm-display'),
  sliderFont:           document.getElementById('slider-font'),
  fontDisplay:          document.getElementById('font-display'),
  fontSelect:           document.getElementById('font-select'),
  sliderChunk:          document.getElementById('slider-chunk'),
  chunkDisplay:         document.getElementById('chunk-display'),
  wordIndexInput:       document.getElementById('word-index-input'),
  totalWordsDisplay:    document.getElementById('total-words-display'),
  blankFlashToggle:     document.getElementById('blank-flash-toggle'),
  speedRampToggle:      document.getElementById('speed-ramp-toggle'),
  ttsToggle:            document.getElementById('tts-toggle'),
  ttsLabel:             document.getElementById('tts-label'),
  panelBackdrop:        document.getElementById('panel-backdrop'),
  statsPanel:           document.getElementById('stats-panel'),
  tocPanel:             document.getElementById('toc-panel'),
  bookmarksPanel:       document.getElementById('bookmarks-panel'),
  statWordsRead:        document.getElementById('stat-words-read'),
  statProgress:         document.getElementById('stat-progress'),
  statSessionTime:      document.getElementById('stat-session-time'),
  statRemaining:        document.getElementById('stat-remaining'),
  statAvgWpm:           document.getElementById('stat-avg-wpm'),
  sparklineCanvas:      document.getElementById('sparkline-canvas'),
  tocList:              document.getElementById('toc-list'),
  bookmarksList:        document.getElementById('bookmarks-list'),
  btnAddBookmark:       document.getElementById('btn-add-bookmark'),
  shortcutModal:        document.getElementById('shortcut-modal'),
  shortcutClose:        document.getElementById('shortcut-close'),
  summaryModal:         document.getElementById('summary-modal'),
  sumFilename:          document.getElementById('sum-filename'),
  sumWords:             document.getElementById('sum-words'),
  sumPages:             document.getElementById('sum-pages'),
  sumTime:              document.getElementById('sum-time'),
  sumAvgWpm:            document.getElementById('sum-avg-wpm'),
  sumPeakWpm:           document.getElementById('sum-peak-wpm'),
  sumRestart:           document.getElementById('sum-restart'),
  sumClose:             document.getElementById('sum-close'),
  confirmDialog:        document.getElementById('confirm-dialog'),
  confirmMessage:       document.getElementById('confirm-message'),
  confirmYes:           document.getElementById('confirm-yes'),
  confirmNo:            document.getElementById('confirm-no'),
  focusHint:            document.getElementById('focus-hint'),
  toastContainer:       document.getElementById('toast-container'),
};

/* ══════════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════════ */
function toast(msg, ms = 2700) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = msg;
  el.toastContainer.appendChild(d);
  setTimeout(() => d.remove(), ms + 100);
}

/* ══════════════════════════════════════════════════
   CONFIRM DIALOG
   ══════════════════════════════════════════════════ */
function showConfirm(message, btnLabel, callback) {
  el.confirmMessage.textContent = message;
  el.confirmYes.textContent     = btnLabel || 'Confirm';
  state.pendingConfirm = callback;
  el.confirmDialog.classList.remove('hidden');
}
el.confirmYes.addEventListener('click', () => {
  el.confirmDialog.classList.add('hidden');
  if (typeof state.pendingConfirm === 'function') state.pendingConfirm();
  state.pendingConfirm = null;
});
el.confirmNo.addEventListener('click', () => {
  el.confirmDialog.classList.add('hidden');
  state.pendingConfirm = null;
});

/* ══════════════════════════════════════════════════
   THEMES
   ══════════════════════════════════════════════════ */
function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  el.themeBtns.forEach(b => b.classList.toggle('active', b.dataset.theme === name));
  if (state.wpmHistory.length >= 2) drawSparkline();
}
el.themeBtns.forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.theme)));

/* ══════════════════════════════════════════════════
   WPM EMOJI BADGE  (Change 4: now in #word-stage)
   ══════════════════════════════════════════════════ */
function updateWpmEmoji() {
  const band = WPM_BANDS.find(b => state.wpm <= b.max) || WPM_BANDS[WPM_BANDS.length - 1];
  el.wpmEmoji.textContent           = band.emoji;
  el.wpmEmojiLabel.textContent      = band.label;
  el.wpmEmojiBadge.style.background = band.bg;
  el.wpmEmojiBadge.style.borderColor= band.border;
  el.wpmEmojiLabel.style.color      = state.wpm >= 300 ? 'rgba(255,255,255,0.65)' : '';
}

/* ══════════════════════════════════════════════════
   ORP — Optimal Recognition Point
   pivot ≈ 33 % from start (research-corrected)
   ══════════════════════════════════════════════════ */
function getPivotIndex(word) {
  const n = word.length;
  if (n <= 0) return 0;
  return Math.max(0, Math.min(Math.round(n / 3) - 1, n - 1));
}

/* ══════════════════════════════════════════════════
   WORD RENDERING
   ──────────────────────────────────────────────────
   Change 3: Adaptive centering
   · chunkSize > 1  → #word-center-block (geometric centre),
                       vguide hidden, .multi-word on #word-display
   · chunkSize = 1  → classic ORP two-half (#word-left/#word-right),
                       vguide shown
   ══════════════════════════════════════════════════ */

/**
 * Set ORP two-half spans (single-word mode).
 * Does NOT show or hide #word-display — caller controls visibility.
 */
function _setOrpSpans(before, pivot, after) {
  el.wordBefore.textContent = before;
  el.wordPivot.textContent  = pivot;
  el.wordAfter.textContent  = after;
  const fStyle = `${state.fontSize}px ${state.fontFamily}`;
  el.wordLeft.style.font  = fStyle;
  el.wordRight.style.font = fStyle;
}

/**
 * Prepare the chunk content in the DOM (does NOT reveal it).
 * Separating "prepare" from "reveal" lets the rAF loop
 * pre-render while still in the blank-flash interval.
 */
function prepareChunk(startIndex) {
  if (startIndex >= state.words.length) return false;

  /* Skip paragraph break sentinels */
  let idx = startIndex;
  while (idx < state.words.length && state.words[idx] === PARA_BREAK_TOKEN) idx++;
  if (idx >= state.words.length) return false;

  /* Collect up to chunkSize real words */
  const chunk = [];
  let   ci    = idx;
  while (chunk.length < state.chunkSize && ci < state.words.length) {
    const w = state.words[ci];
    if (w === PARA_BREAK_TOKEN) break;
    chunk.push(w);
    ci++;
  }
  if (!chunk.length) return false;

  el.stageMessage.style.display = 'none';

  if (state.chunkSize > 1) {
    /* ── Multi-word: centred block ─────────────────────
       The fixed-width container (#word-center-block at
       width:100%) ensures the geometric centre never
       shifts regardless of chunk length.
       ─────────────────────────────────────────────── */
    el.wordDisplay.classList.add('multi-word');
    el.wordCenterText.textContent = chunk.join(' ');
    el.wordCenterText.style.font  = `${state.fontSize}px ${state.fontFamily}`;
    el.stageVguide.classList.remove('visible');
  } else {
    /* ── Single-word: ORP two-half ────────────────────
       Pivot letter sits at exactly the 50% screen seam.
       ─────────────────────────────────────────────── */
    el.wordDisplay.classList.remove('multi-word');
    const first  = chunk[0];
    const pi     = getPivotIndex(first);
    const before = first.slice(0, pi);
    const pivCh  = first[pi] || '';
    const after  = first.slice(pi + 1);
    _setOrpSpans(before, pivCh, after);
    el.stageVguide.classList.add('visible');
  }

  pushHistory(chunk[0]);
  return true;
}

/**
 * Make the word display visible.
 */
function revealWord() {
  el.wordDisplay.classList.remove('hidden');
}

/**
 * Hide the word display (blank flash).
 */
function hideWord() {
  el.wordDisplay.classList.add('hidden');
  if (state.chunkSize === 1) el.stageVguide.classList.remove('visible');
}

/**
 * Public render entry — prepare + reveal (used for seeks / jumps).
 */
function renderChunk(startIndex) {
  if (startIndex >= state.words.length) { renderDone(); return; }
  let idx = startIndex;
  while (idx < state.words.length && state.words[idx] === PARA_BREAK_TOKEN) idx++;
  if (idx >= state.words.length) { renderDone(); return; }
  if (prepareChunk(idx)) revealWord();
}

function renderDone() {
  el.stageMessage.textContent   = '✓ Done';
  el.stageMessage.className     = 'done-text';
  el.stageMessage.style.display = '';
  el.wordDisplay.classList.add('hidden');
  el.stageVguide.classList.remove('visible');
  showSummaryModal();
}

/* ══════════════════════════════════════════════════
   HISTORY STRIP
   ══════════════════════════════════════════════════ */
function pushHistory(word) {
  if (word === PARA_BREAK_TOKEN) return;
  state.wordHistory.push(word);
  if (state.wordHistory.length > HISTORY_SIZE) state.wordHistory.shift();
  renderHistory();
}
function renderHistory() {
  el.historyStrip.innerHTML = '';
  const n = state.wordHistory.length;
  state.wordHistory.forEach((w, i) => {
    const span = document.createElement('span');
    span.className   = 'history-word';
    span.style.opacity = (0.07 + (i / Math.max(n - 1, 1)) * 0.46).toFixed(2);
    span.textContent = w;
    el.historyStrip.appendChild(span);
  });
}

/* ══════════════════════════════════════════════════
   PROGRESS + CHAPTER TICKS
   Change 5: also updates #progress-pct-tooltip
   ══════════════════════════════════════════════════ */
function updateProgress() {
  const total = state.words.length;
  const idx   = state.currentIndex;
  let pct     = 0;

  if (total > 0) {
    pct = Math.min(100, (idx / Math.max(1, total - 1)) * 100);
    el.progressSlider.style.setProperty('--pct', pct.toFixed(2) + '%');
    el.progressSlider.value = pct;
    el.progressSlider.setAttribute('aria-valuenow', Math.round(pct));
    el.wordIndexInput.value = Math.min(idx + 1, total);
  } else {
    el.progressSlider.style.setProperty('--pct', '0%');
    el.progressSlider.value = 0;
    el.wordIndexInput.value = 1;
  }

  /* Change 5: floating percentage tooltip above slider thumb */
  if (el.progressPctTooltip) {
    el.progressPctTooltip.textContent = Math.round(pct) + '%';
    el.progressPctTooltip.style.left  = pct.toFixed(2) + '%';
  }

  markActiveTocItem();
}

function renderChapterMarkers() {
  el.progressChapterMarks.innerHTML = '';
  if (!state.chapters.length || !state.words.length) return;
  const total = state.words.length;
  state.chapters.forEach(ch => {
    const pct  = (ch.wordIndex / Math.max(1, total - 1)) * 100;
    const tick = document.createElement('span');
    tick.className = 'chapter-tick';
    tick.style.left = pct.toFixed(2) + '%';
    tick.title = ch.title;
    tick.setAttribute('aria-label', ch.title);
    tick.addEventListener('click', () => {
      jumpToIndex(ch.wordIndex);
      toast(`📑 ${ch.title.slice(0, 40)}`);
    });
    el.progressChapterMarks.appendChild(tick);
  });
}

/* ══════════════════════════════════════════════════
   SMART PACE
   ══════════════════════════════════════════════════ */
function wordIntervalMs(word) {
  const base = Math.round(60000 / state.wpm);
  if (word === PARA_BREAK_TOKEN) return Math.round(base * 2.5);
  if (!state.speedRamp) return base;
  const lower = word.toLowerCase().replace(/[^a-z]/g, '');
  let m = 1.0;
  const n = word.replace(/[^a-zA-Z]/g, '').length;
  if      (n >= 15) m *= 2.0;
  else if (n >= 12) m *= 1.65;
  else if (n >= 9)  m *= 1.35;
  else if (n >= 7)  m *= 1.15;
  else if (n <= 2)  m *= 0.60;
  else if (n <= 4 && COMMON_WORDS.has(lower)) m *= 0.65;
  if      (RE_SENTENCE_END.test(word))  m *= 1.80;
  else if (RE_CLAUSE_END.test(word))    m *= 1.30;
  if (n >= RARE_WORD_MIN_LEN && !COMMON_WORDS.has(lower)) m *= 1.25;
  if (RE_SENTENCE_START.test(word) && state.currentIndex > 0) {
    const prev = state.words[state.currentIndex - 1] || '';
    if (RE_SENTENCE_END.test(prev)) m *= 1.20;
  }
  return Math.round(base * m);
}

/** ISI gap for single-word blank-flash toggle */
function getIsiMs() {
  if (!state.blankFlash || state.chunkSize > 1) return 0;
  if (state.wpm <= 200) return 50;
  if (state.wpm <= 300) return 30;
  return 0;
}

/* ══════════════════════════════════════════════════
   SESSION STATS
   ══════════════════════════════════════════════════ */
let statsInterval = null;
function startStats() {
  if (!state.sessionStart) state.sessionStart = Date.now();
  state.playStartTs = Date.now();
  if (!statsInterval) statsInterval = setInterval(refreshStatsPanel, 1000);
}
function pauseStats() {
  if (state.playStartTs) { state.totalPlayMs += Date.now() - state.playStartTs; state.playStartTs = null; }
  clearInterval(statsInterval); statsInterval = null;
}
function sampleWpm() {
  state.wpmSampleCount += state.chunkSize;
  if (state.wpmSampleCount >= WPM_SAMPLE_N) {
    state.wpmSampleCount = 0;
    const now = Date.now();
    if (state.wpmLastTs) {
      const mins = (now - state.wpmLastTs) / 60000;
      if (mins > 0) {
        const actual = Math.round(WPM_SAMPLE_N / mins);
        state.wpmHistory.push(Math.min(2500, Math.max(30, actual)));
        if (state.wpmHistory.length > SPARKLINE_MAX) state.wpmHistory.shift();
      }
    }
    state.wpmLastTs = now;
  }
}
function refreshStatsPanel() {
  if (!state.loaded) return;
  const total = state.words.length, idx = state.currentIndex;
  el.statWordsRead.textContent = idx.toLocaleString();
  el.statProgress.textContent  = total > 0 ? Math.round((idx / total) * 100) + '%' : '0%';
  const playedMs = state.totalPlayMs + (state.playStartTs ? Date.now() - state.playStartTs : 0);
  el.statSessionTime.textContent = fmtTime(Math.floor(playedMs / 1000));
  el.statRemaining.textContent   = total - idx > 0
    ? fmtTime(Math.floor(((total - idx) / state.wpm) * 60)) : '—';
  if (state.wpmHistory.length) {
    const avg = Math.round(state.wpmHistory.reduce((a, b) => a + b, 0) / state.wpmHistory.length);
    el.statAvgWpm.textContent = avg + ' WPM';
  }
  drawSparkline();
}
function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function drawSparkline() {
  const canvas = el.sparklineCanvas;
  const W = canvas.clientWidth || 260, H = canvas.clientHeight || 62;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx  = canvas.getContext('2d'), data = state.wpmHistory;
  const cs   = getComputedStyle(document.documentElement);
  const bgC  = cs.getPropertyValue('--bg-panel').trim()  || '#2d2d30';
  const acC  = cs.getPropertyValue('--accent').trim()    || '#007acc';
  const muC  = cs.getPropertyValue('--text-muted').trim()|| '#9d9d9d';
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = bgC; ctx.fillRect(0, 0, W, H);
  if (data.length < 2) {
    ctx.fillStyle = muC; ctx.font = '10px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Read to build WPM history', W / 2, H / 2);
    return;
  }
  const pad = 6, iW = W - pad * 2, iH = H - pad * 2;
  const minV = Math.max(0, Math.min(...data) - 20), maxV = Math.max(...data) + 20;
  const range = maxV - minV || 1;
  const tx = i => pad + (i / (data.length - 1)) * iW;
  const ty = v => pad + iH - ((v - minV) / range) * iH;
  ctx.beginPath(); ctx.moveTo(tx(0), ty(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(tx(i), ty(data[i]));
  ctx.lineTo(tx(data.length - 1), H - pad); ctx.lineTo(tx(0), H - pad); ctx.closePath();
  ctx.globalAlpha = 0.2; ctx.fillStyle = acC; ctx.fill(); ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.moveTo(tx(0), ty(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(tx(i), ty(data[i]));
  ctx.strokeStyle = acC; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = acC; ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(data[data.length - 1] + ' WPM', W - pad - 1, pad + 1);
}

/* ══════════════════════════════════════════════════
   Change 6 — TTS REWRITE
   ──────────────────────────────────────────────────
   Strategy: 12-word micro-chunks (reduces GC pressure
   and avoids Chromium 15 s cloud-voice timeout).
   · Local voices forced (v.localService === true) to
     sidestep the Chromium cloud TTS cutoff bug.
   · 10 s pause/resume heartbeat for systems where no
     local voice is available.
   · _ttsQueue[] holds strong references to all pending
     SpeechSynthesisUtterance objects — prevents the
     browser's aggressive GC from silently collecting
     them mid-playback.
   · TTS is fully decoupled from the visual rAF loop.
   ══════════════════════════════════════════════════ */

/**
 * Strong-reference array: the browser GC won't collect
 * utterances that are still in this array.
 * @type {SpeechSynthesisUtterance[]}
 */
const _ttsQueue = [];

/**
 * Detect document language by sampling words.
 * Returns 'pt' for Portuguese, 'en' for English (default).
 */
function _detectTextLanguage() {
  if (!state.words.length) return 'en';
  const PT_MARKERS = new Set([
    'de','da','do','das','dos','que','em','um','uma','não','nao','para','com',
    'por','mais','como','seu','sua','pelo','pela','são','sao','ele','ela',
    'isso','este','esta','esse','essa','entre','quando','muito','também',
    'tambem','já','ja','nos','nas','aos','ter','pode','foi','será','sera',
    'fazer','onde','até','ate','sobre','ainda','depois','então','entao',
    'mesmo','outro','outra','todos','todas','havia','porque','aqui','seus',
    'suas','você','voce','meu','minha','nosso','nossa','qual','quais'
  ]);
  /* Sample up to 500 real words evenly across the document */
  const real = state.words.filter(w => w !== PARA_BREAK_TOKEN);
  const step = Math.max(1, Math.floor(real.length / 500));
  let ptHits = 0, total = 0;
  for (let i = 0; i < real.length; i += step) {
    const w = real[i].toLowerCase().replace(/[^a-záàâãéèêíïóôõúüç]/g, '');
    if (w.length < 2) continue;
    total++;
    if (PT_MARKERS.has(w)) ptHits++;
  }
  return (total > 0 && ptHits / total > 0.06) ? 'pt' : 'en';
}

function _pickTtsVoice() {
  if (!state.ttsSupported) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;

  const lang = _detectTextLanguage();

  if (lang === 'pt') {
    const localPt = voices.filter(v => v.localService === true && v.lang.startsWith('pt'));
    const anyPt   = voices.filter(v => v.lang.startsWith('pt'));
    state.ttsVoice = localPt[0] || anyPt[0] || voices[0] || null;
  } else {
    const localEn = voices.filter(v => v.localService === true && v.lang.startsWith('en'));
    const anyLocal = voices.filter(v => v.localService === true);
    const anyEn   = voices.filter(v => v.lang.startsWith('en'));
    state.ttsVoice = localEn[0] || anyLocal[0] || anyEn[0] || voices[0] || null;
  }
}

function initTtsVoice() {
  if (!state.ttsSupported) return;
  const tryPick = () => {
    _pickTtsVoice();
  };
  tryPick();
  window.speechSynthesis.addEventListener('voiceschanged', tryPick);
}

function ttsStartFrom(wordIndex) {
  if (!state.ttsEnabled || !state.ttsSupported || !state.isPlaying) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  _ttsQueue.length = 0;   // drop strong refs from previous utterances
  _ttsEnqueue(wordIndex);

  /* Heartbeat: only activate for non-local voices (cloud TTS bug) */
  stopTtsResumeTimer();
  if (!state.ttsVoice || !state.ttsVoice.localService) {
    state.ttsResumeTimer = setInterval(() => {
      if (!synth.speaking) { stopTtsResumeTimer(); return; }
      synth.pause(); synth.resume();
    }, TTS_HEARTBEAT_MS);
  }
}

/**
 * Build one micro-utterance of TTS_CHUNK_SIZE words and
 * chain to the next on completion.
 * @param {number} wordIndex - starting word index in state.words
 */
function _ttsEnqueue(wordIndex) {
  if (!state.ttsEnabled || !state.isPlaying) return;
  const synth = window.speechSynthesis;

  /* Collect up to TTS_CHUNK_SIZE real (non-sentinel) words */
  const realWords = [];
  let   ci        = wordIndex;
  while (realWords.length < TTS_CHUNK_SIZE && ci < state.words.length) {
    const w = state.words[ci++];
    if (w !== PARA_BREAK_TOKEN) realWords.push(w);
  }
  if (!realWords.length) return;

  const utt = new SpeechSynthesisUtterance(realWords.join(' '));
  _ttsQueue.push(utt);  // strong ref — prevents GC

  if (state.ttsVoice) utt.voice = state.ttsVoice;
  /* Rate capped at 2.0 for reliability */
  utt.rate  = Math.min(2.0, Math.max(0.5, state.wpm / 200));
  utt.pitch = 1;

  /**
   * onboundary: fires on word boundaries in supported browsers.
   * We use performance.now() to record when TTS words start;
   * this could be used for future drift correction.
   */
  utt.onboundary = (/*ev*/) => {
    /* Reserved: drift correction hook */
  };

  utt.onend = () => {
    const idx = _ttsQueue.indexOf(utt);
    if (idx !== -1) _ttsQueue.splice(idx, 1);
    /* Chain next micro-chunk; ci captured from outer scope */
    _ttsEnqueue(ci);
  };

  utt.onerror = (ev) => {
    /* 'canceled' / 'interrupted' are expected on pause — not errors */
    if (ev.error === 'canceled' || ev.error === 'interrupted') return;
    const idx = _ttsQueue.indexOf(utt);
    if (idx !== -1) _ttsQueue.splice(idx, 1);
  };

  synth.speak(utt);
}

function stopTtsResumeTimer() {
  clearInterval(state.ttsResumeTimer);
  state.ttsResumeTimer = null;
}
function stopTts() {
  if (state.ttsSupported) window.speechSynthesis.cancel();
  stopTtsResumeTimer();
  _ttsQueue.length = 0;
}

/* ══════════════════════════════════════════════════
   LIVE WPM BADGE
   ══════════════════════════════════════════════════ */
function updateLiveWpmBadge() {
  el.liveWpmValue.textContent = state.wpm;
}

/* ══════════════════════════════════════════════════
   Change 2 — ZERO-ALLOCATION rAF PLAYBACK ENGINE
   ──────────────────────────────────────────────────
   Replaces the old setTimeout engine.
   · _durBuf: Float32Array — pre-computed per-word durations
              allocated once per play() call, not per frame.
   · _rafAccum: accumulated elapsed ms toward the current word.
   · _blanking: true during blank-flash phase.
   · _blankMs: duration of the current blank interval.
   · Zero heap allocations occur inside _rafTick().
   ══════════════════════════════════════════════════ */

/** Pre-allocated flat duration buffer (Float32Array avoids boxing) */
let _durBuf    = new Float32Array(0);
let _rafId     = 0;        // handle returned by requestAnimationFrame
let _rafPrevTs = 0.0;      // performance.now() of previous frame
let _rafAccum  = 0.0;      // ms accumulated since last word
let _blanking  = false;    // true = blank flash in progress
let _blankMs   = 0.0;      // target blank duration for this interval

/**
 * Build the per-word duration buffer.
 * Called once when playback starts or when WPM changes mid-play.
 * Reuses the existing Float32Array buffer if length unchanged.
 */
function _buildDurations() {
  const n = state.words.length;
  if (_durBuf.length !== n) _durBuf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    _durBuf[i] = wordIntervalMs(state.words[i]);
  }
}

/**
 * The hot rAF tick — MUST NOT allocate on the heap.
 * Uses only arithmetic and direct property access.
 * @param {number} ts — DOMHighResTimeStamp from rAF
 */
function _rafTick(ts) {
  /* --- GUARD: stop if paused externally ─────────── */
  if (!state.isPlaying) { _rafId = 0; return; }

  /* --- DELTA TIME ───────────────────────────────── */
  const delta = ts - _rafPrevTs;
  _rafPrevTs  = ts;
  _rafAccum  += delta;

  /* --- BLANK FLASH PHASE ────────────────────────── */
  if (_blanking) {
    if (_rafAccum >= _blankMs) {
      _rafAccum -= _blankMs;
      _blanking  = false;
      revealWord();
    }
    _rafId = requestAnimationFrame(_rafTick);
    return;
  }

  /* --- WORD DISPLAY PHASE ───────────────────────── */
  const dur = _durBuf[state.currentIndex] || (60000.0 / state.wpm);

  if (_rafAccum >= dur) {
    _rafAccum -= dur;

    /* ── Advance word index ─────────────────────── */
    state.currentIndex += state.chunkSize;

    /* ── End of document ────────────────────────── */
    if (state.currentIndex >= state.words.length) {
      state.currentIndex = state.words.length;
      state.isPlaying    = false;
      _rafId = 0;
      updatePlayPauseBtn();
      stopTts();
      pauseStats();
      renderDone();
      updateProgress();
      saveProgressToLS();
      return;
    }

    sampleWpm();
    updateProgress();

    /* ── Pre-render next word/chunk ─────────────── */
    const ready = prepareChunk(state.currentIndex);
    if (!ready) {
      /* All remaining tokens are paragraph sentinels — done */
      state.isPlaying = false;
      _rafId = 0;
      renderDone();
      return;
    }

    /* ── Blank flash decision ───────────────────── */
    if (state.chunkSize > 1) {
      /* Multi-word: always 25 ms cognitive-reset blank */
      hideWord();
      _blankMs  = BLANK_MULTI_MS;
      _blanking = true;
    } else {
      /* Single-word: blank-flash toggle via getIsiMs() */
      const isi = getIsiMs();
      if (isi > 0) {
        hideWord();
        _blankMs  = isi;
        _blanking = true;
      } else {
        revealWord();
      }
    }
  }

  _rafId = requestAnimationFrame(_rafTick);
}

/* ══════════════════════════════════════════════════
   PLAYBACK CONTROLS
   ══════════════════════════════════════════════════ */
function play() {
  if (!state.loaded || !state.words.length) return;
  if (state.currentIndex >= state.words.length) state.currentIndex = 0;
  state.isPlaying = true;
  state.wpmLastTs = Date.now();

  _buildDurations();           // pre-allocate duration buffer
  _rafAccum  = 0.0;
  _blanking  = false;

  updatePlayPauseBtn();
  startStats();
  renderChunk(state.currentIndex);
  updateProgress();
  ttsStartFrom(state.currentIndex);

  /* Kick off the rAF loop */
  _rafPrevTs = performance.now();
  _rafId     = requestAnimationFrame(_rafTick);

  /* Start localStorage save timer */
  _startLsSaveTimer();
}

function pause() {
  state.isPlaying = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  updatePlayPauseBtn();
  stopTts();
  pauseStats();
  _stopLsSaveTimer();
  saveProgressToLS();
}

function togglePlayPause() { state.isPlaying ? pause() : play(); }

function restart() {
  pause();
  state.currentIndex = 0;
  state.wordHistory  = [];
  renderHistory();
  if (state.loaded && state.words.length) renderChunk(0);
  updateProgress();
}

function jumpWords(delta) {
  const wasPlaying = state.isPlaying;
  if (wasPlaying) pause();
  state.currentIndex = clampIdx(state.currentIndex + delta);
  if (state.loaded) { renderChunk(state.currentIndex); updateProgress(); }
  if (wasPlaying) play();
}

function jumpToIndex(idx) {
  const wasPlaying = state.isPlaying;
  if (wasPlaying) pause();
  state.currentIndex = clampIdx(idx);
  if (state.loaded) { renderChunk(state.currentIndex); updateProgress(); }
  if (wasPlaying) play();
}

function jumpToEnd() {
  pause();
  state.currentIndex = Math.max(0, state.words.length - 1);
  if (state.loaded) { renderChunk(state.currentIndex); updateProgress(); }
}

function clampIdx(n) { return Math.max(0, Math.min(state.words.length - 1, n)); }
function updatePlayPauseBtn() { el.btnPlayPause.textContent = state.isPlaying ? '⏸ Pause' : '▶ Play'; }

/* ══════════════════════════════════════════════════
   Change 7 — PROGRESS HISTORY PERSISTENCE
   ──────────────────────────────────────────────────
   Saves { fileName, currentIndex } to localStorage
   every LS_SAVE_INTERVAL_MS during playback.
   On file load, if the same filename is found in
   storage, a resume prompt is shown.
   ══════════════════════════════════════════════════ */
let _lsSaveTimer = null;

function _startLsSaveTimer() {
  if (_lsSaveTimer) return;
  _lsSaveTimer = setInterval(saveProgressToLS, LS_SAVE_INTERVAL_MS);
}
function _stopLsSaveTimer() {
  clearInterval(_lsSaveTimer);
  _lsSaveTimer = null;
}

/** Persist current position to localStorage (non-critical — ignores quota errors). */
function saveProgressToLS() {
  if (!state.loaded || !state.fileName || state.currentIndex <= 0) return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      fileName:     state.fileName,
      currentIndex: state.currentIndex,
      savedAt:      Date.now(),
    }));
  } catch (_) { /* storage quota exceeded — silently skip */ }
}

/**
 * Check localStorage for a saved position matching this filename.
 * @param {string} fileName
 * @returns {{ fileName, currentIndex, savedAt }|null}
 */
function _checkSavedProgress(fileName) {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.fileName === fileName &&
        typeof data.currentIndex === 'number' &&
        data.currentIndex > 0) {
      return data;
    }
  } catch (_) { /* corrupt storage — ignore */ }
  return null;
}

/* ══════════════════════════════════════════════════
   LOADING PROGRESS UI
   ══════════════════════════════════════════════════ */
function setLoadingProgress(current, total, filename) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  el.loadingFilename.textContent = '📄 ' + (filename || '');
  el.loadingFill.style.width     = pct + '%';
  el.loadingPageInfo.textContent = total > 0 ? `Page ${current} of ${total}` : 'Reading…';
  el.loadingPct.textContent      = pct + '%';
}
function addLog(msg, done = false) {
  const line = document.createElement('div');
  line.className = done ? 'log-line log-done' : 'log-line';
  line.textContent = msg;
  el.loadingLog.appendChild(line);
  while (el.loadingLog.childElementCount > 12)
    el.loadingLog.removeChild(el.loadingLog.firstElementChild);
  el.loadingLog.scrollTop = el.loadingLog.scrollHeight;
}

/* ══════════════════════════════════════════════════
   FILE HANDLER  (PDF + TXT only — EPUB removed)
   ══════════════════════════════════════════════════ */
async function handleFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'pdf' && ext !== 'txt') {
    toast('⚠ Only .pdf and .txt files are supported');
    return;
  }
  if (state.loaded && state.currentIndex > 0) {
    showConfirm(
      `Replace "${state.fileName}" with "${file.name}"?\nYour current position will be lost.`,
      'Replace File',
      () => doLoadFile(file)
    );
    return;
  }
  doLoadFile(file);
}

async function doLoadFile(file) {
  pause();
  Object.assign(state, {
    loaded: false, words: [], chapters: [], bookmarks: [], wordHistory: [],
    currentIndex: 0, sessionStart: null, totalPlayMs: 0,
    wpmHistory: [], wpmSampleCount: 0, wpmLastTs: null, fileName: file.name,
  });
  renderHistory();
  el.loadingLog.innerHTML = '';
  el.loadingOverlay.classList.remove('hidden');
  el.uploadZone.classList.replace('upload-expanded', 'upload-collapsed');
  el.fileBar.classList.remove('hidden');
  el.fileBarName.textContent = file.name;
  el.wordDisplay.classList.add('hidden');
  el.stageVguide.classList.remove('visible');
  el.stageMessage.className    = '';
  el.stageMessage.style.display= '';
  el.stageMessage.textContent  = 'Extracting text…';
  el.liveWpmBadge.classList.remove('hidden');
  el.historyStrip.classList.remove('hidden');

  try {
    const ext    = file.name.split('.').pop().toLowerCase();
    const cbs    = { setLoadingProgress, addLog };
    const result = ext === 'txt' ? await extractTXT(file) : await extractPDF(file, cbs);

    const realWords = result.words.filter(w => w !== PARA_BREAK_TOKEN);
    if (!realWords.length) throw new Error('No readable text found in this file.');

    state.words    = result.words;
    state.chapters = result.chapters;
    state.loaded   = true;

    el.totalWordsDisplay.textContent = realWords.length.toLocaleString();
    el.loadingOverlay.classList.add('hidden');
    el.btnToc.disabled = (state.chapters.length === 0);

    renderToc();
    renderBookmarks();
    renderChapterMarkers();
    renderChunk(0);
    updateProgress();
    updateLiveWpmBadge();
    /* Re-pick TTS voice now that words are loaded (language detection) */
    _pickTtsVoice();

    toast(`✓ Loaded ${realWords.length.toLocaleString()} words` +
          (result.chapters.length ? ` · ${result.chapters.length} chapters` : ''));

    /* Change 7: offer to resume from saved position */
    const saved = _checkSavedProgress(file.name);
    if (saved && saved.currentIndex < state.words.length) {
      const pct = Math.round((saved.currentIndex / Math.max(1, state.words.length - 1)) * 100);
      showConfirm(
        `Resume "${file.name}" from ${pct}%?\n(Word ${saved.currentIndex + 1})`,
        'Resume',
        () => jumpToIndex(saved.currentIndex)
      );
    }
  } catch (err) {
    el.loadingOverlay.classList.add('hidden');
    console.error(err);
    toast('❌ ' + err.message);
    resetToUploadState();
  }
}

function resetToUploadState() {
  pause();
  _stopLsSaveTimer();
  Object.assign(state, { loaded: false, words: [], chapters: [], currentIndex: 0 });
  el.uploadZone.classList.replace('upload-collapsed', 'upload-expanded');
  el.fileBar.classList.add('hidden');
  el.stageMessage.textContent    = 'Upload a PDF or TXT to begin';
  el.stageMessage.className      = '';
  el.stageMessage.style.display  = '';
  el.wordDisplay.classList.add('hidden');
  el.stageVguide.classList.remove('visible');
  el.historyStrip.classList.add('hidden');
  el.liveWpmBadge.classList.add('hidden');
  el.progressSlider.style.setProperty('--pct', '0%');
  el.progressSlider.value            = 0;
  el.progressChapterMarks.innerHTML  = '';
  el.totalWordsDisplay.textContent   = '0';
  el.wordIndexInput.value            = 1;
  el.fileInput.value                 = '';
  el.btnToc.disabled                 = true;
  if (el.progressPctTooltip) {
    el.progressPctTooltip.textContent = '0%';
    el.progressPctTooltip.style.left  = '0%';
  }
}

/* ══════════════════════════════════════════════════
   TABLE OF CONTENTS
   ══════════════════════════════════════════════════ */
function renderToc() {
  if (!state.chapters.length) {
    el.tocList.innerHTML = '<p class="panel-empty">No chapters detected.</p>';
    return;
  }
  el.tocList.innerHTML = '';
  state.chapters.forEach((ch, i) => {
    const div = document.createElement('div');
    div.className = 'toc-item'; div.dataset.idx = i;
    div.innerHTML = `<span class="toc-item-title">${escHtml(ch.title)}</span>` +
                    `<span class="toc-item-word">w${ch.wordIndex + 1}</span>`;
    div.addEventListener('click', () => {
      jumpToIndex(ch.wordIndex); closeAllPanels();
      toast(`📑 ${ch.title.slice(0, 40)}`);
    });
    el.tocList.appendChild(div);
  });
  markActiveTocItem();
}
function markActiveTocItem() {
  if (!state.chapters.length) return;
  const items = el.tocList.querySelectorAll('.toc-item');
  let active = 0;
  state.chapters.forEach((ch, i) => { if (state.currentIndex >= ch.wordIndex) active = i; });
  items.forEach((item, i) => item.classList.toggle('active', i === active));
}

/* ══════════════════════════════════════════════════
   BOOKMARKS
   ══════════════════════════════════════════════════ */
function addBookmark() {
  if (!state.loaded) return;
  const context = state.words
    .filter(w => w !== PARA_BREAK_TOKEN)
    .slice(state.currentIndex, state.currentIndex + 4)
    .join(' ');
  state.bookmarks.push({
    name: `Word ${state.currentIndex + 1}: "${context.slice(0, 30)}…"`,
    wordIndex: state.currentIndex,
    ts: Date.now()
  });
  renderBookmarks();
  toast('🔖 Bookmark added');
}
function renderBookmarks() {
  if (!state.bookmarks.length) {
    el.bookmarksList.innerHTML =
      '<p class="panel-empty">No bookmarks yet.<br>Press <kbd>B</kbd> while reading to add one.</p>';
    return;
  }
  el.bookmarksList.innerHTML = '';
  state.bookmarks.forEach((bm, i) => {
    const div = document.createElement('div');
    div.className = 'bookmark-item';
    div.innerHTML =
      `<span class="bookmark-name">${escHtml(bm.name)}</span>` +
      `<span class="bookmark-word">w${bm.wordIndex + 1}</span>` +
      `<button class="bookmark-delete" data-i="${i}" title="Delete">✕</button>`;
    div.querySelector('.bookmark-name').addEventListener('click', () => {
      jumpToIndex(bm.wordIndex); closeAllPanels();
    });
    div.querySelector('.bookmark-delete').addEventListener('click', e => {
      e.stopPropagation(); state.bookmarks.splice(i, 1); renderBookmarks();
    });
    el.bookmarksList.appendChild(div);
  });
}

/* ══════════════════════════════════════════════════
   SUMMARY MODAL
   ══════════════════════════════════════════════════ */
function showSummaryModal() {
  const total    = state.words.filter(w => w !== PARA_BREAK_TOKEN).length;
  const playedMs = state.totalPlayMs + (state.playStartTs ? Date.now() - state.playStartTs : 0);
  const avgWpm   = state.wpmHistory.length
    ? Math.round(state.wpmHistory.reduce((a, b) => a + b, 0) / state.wpmHistory.length)
    : state.wpm;
  const peakWpm  = state.wpmHistory.length ? Math.max(...state.wpmHistory) : state.wpm;
  el.sumFilename.textContent = state.fileName || '—';
  el.sumWords.textContent    = total.toLocaleString();
  el.sumPages.textContent    = Math.ceil(total / WORDS_PER_PAGE) + ' est.';
  el.sumTime.textContent     = fmtTime(Math.floor(playedMs / 1000));
  el.sumAvgWpm.textContent   = avgWpm + ' WPM';
  el.sumPeakWpm.textContent  = peakWpm + ' WPM';
  el.summaryModal.classList.remove('hidden');
}
el.sumRestart.addEventListener('click', () => { el.summaryModal.classList.add('hidden'); restart(); });
el.sumClose.addEventListener(  'click', () =>   el.summaryModal.classList.add('hidden'));

/* ══════════════════════════════════════════════════
   PANELS
   ══════════════════════════════════════════════════ */
function openPanel(id) {
  closeAllPanels();
  document.getElementById(id).classList.remove('hidden');
  el.panelBackdrop.classList.remove('hidden');
  if (id === 'stats-panel') refreshStatsPanel();
}
function closeAllPanels() {
  ['stats-panel', 'toc-panel', 'bookmarks-panel']
    .forEach(id => document.getElementById(id).classList.add('hidden'));
  el.panelBackdrop.classList.add('hidden');
}
el.panelBackdrop.addEventListener('click', closeAllPanels);
document.querySelectorAll('.panel-close').forEach(btn => btn.addEventListener('click', closeAllPanels));
el.btnStats.addEventListener(    'click', () => openPanel('stats-panel'));
el.btnToc.addEventListener(      'click', () => openPanel('toc-panel'));
el.btnBookmarks.addEventListener('click', () => openPanel('bookmarks-panel'));
el.btnAddBookmark.addEventListener('click', () => addBookmark());

/* ══════════════════════════════════════════════════
   SHORTCUT MODAL
   ══════════════════════════════════════════════════ */
function toggleShortcutModal() { el.shortcutModal.classList.toggle('hidden'); }
el.btnShortcut.addEventListener('click', toggleShortcutModal);
el.shortcutClose.addEventListener('click', () => el.shortcutModal.classList.add('hidden'));
el.shortcutModal.addEventListener('click', e => {
  if (e.target === el.shortcutModal) el.shortcutModal.classList.add('hidden');
});

/* ══════════════════════════════════════════════════
   FOCUS MODE
   ══════════════════════════════════════════════════ */
/** Request browser fullscreen (best-effort, ignores errors). */
function _requestFullscreen() {
  const el = document.documentElement;
  const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (rfs) {
    try { rfs.call(el); } catch (_) { /* user gesture required — ignore */ }
  }
}
/** Exit browser fullscreen if active. */
function _exitFullscreen() {
  const efs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (efs && (document.fullscreenElement || document.webkitFullscreenElement)) {
    try { efs.call(document); } catch (_) { /* ignore */ }
  }
}

function toggleFocusMode() {
  state.focusActive = !state.focusActive;
  document.body.classList.toggle('focus-mode', state.focusActive);
  el.btnFocus.classList.toggle('active', state.focusActive);
  clearTimeout(state.focusHintTimer);
  if (state.focusActive) {
    _requestFullscreen();
    el.focusHint.classList.remove('hidden', 'fading');
    state.focusHintTimer = setTimeout(() => {
      el.focusHint.classList.add('fading');
      setTimeout(() => el.focusHint.classList.add('hidden'), 500);
    }, 3500);
  } else {
    _exitFullscreen();
    el.focusHint.classList.add('hidden');
  }
}
function exitFocusMode() {
  if (!state.focusActive) return;
  state.focusActive = false;
  document.body.classList.remove('focus-mode');
  el.btnFocus.classList.remove('active');
  el.focusHint.classList.add('hidden');
  clearTimeout(state.focusHintTimer);
  _exitFullscreen();
}

/* Sync state if user exits fullscreen via browser controls (e.g. swipe down) */
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !document.webkitFullscreenElement && state.focusActive) {
    state.focusActive = false;
    document.body.classList.remove('focus-mode');
    el.btnFocus.classList.remove('active');
    el.focusHint.classList.add('hidden');
    clearTimeout(state.focusHintTimer);
  }
});
el.btnFocus.addEventListener('click', toggleFocusMode);

/* ══════════════════════════════════════════════════
   EXPORT / IMPORT
   ══════════════════════════════════════════════════ */
el.btnExport.addEventListener('click', () => {
  if (!state.loaded) { toast('⚠ No file loaded'); return; }
  const data = {
    version: 2, fileName: state.fileName, wordIndex: state.currentIndex,
    wpm: state.wpm, fontSize: state.fontSize, fontFamily: state.fontFamily,
    bookmarks: state.bookmarks, savedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = (state.fileName.replace(/\.[^.]+$/, '') || 'rsvp') + '-position.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('⬇ Position exported');
});
el.btnImport.addEventListener('click', () => el.importFileInput.click());
el.importFileInput.addEventListener('change', () => {
  const file = el.importFileInput.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.wpm)        setWpm(data.wpm);
      if (data.fontSize)   setFontSize(data.fontSize);
      if (data.fontFamily) applyFont(data.fontFamily);
      if (Array.isArray(data.bookmarks)) { state.bookmarks = data.bookmarks; renderBookmarks(); }
      if (state.loaded && typeof data.wordIndex === 'number') jumpToIndex(data.wordIndex);
      toast(`⬆ Imported position${data.fileName ? ' for ' + data.fileName : ''}`);
    } catch (_) { toast('❌ Invalid position file'); }
    el.importFileInput.value = '';
  };
  reader.readAsText(file);
});

/* ══════════════════════════════════════════════════
   SEEK SLIDER
   ══════════════════════════════════════════════════ */
el.progressSlider.addEventListener('input', () => {
  if (!state.loaded || !state.words.length) return;
  const pct = parseFloat(el.progressSlider.value) / 100;
  jumpToIndex(Math.round(pct * (state.words.length - 1)));
});

/* ══════════════════════════════════════════════════
   FONT FAMILY
   ══════════════════════════════════════════════════ */
function applyFont(family) {
  state.fontFamily = family;
  if (!el.wordDisplay.classList.contains('hidden')) {
    el.wordLeft.style.font  = `${state.fontSize}px ${family}`;
    el.wordRight.style.font = `${state.fontSize}px ${family}`;
    if (el.wordCenterText) el.wordCenterText.style.font = `${state.fontSize}px ${family}`;
  }
  const opt = [...el.fontSelect.options].find(o => o.value === family);
  if (opt) el.fontSelect.value = family;
}
el.fontSelect.addEventListener('change', () => applyFont(el.fontSelect.value));

/* ══════════════════════════════════════════════════
   TOUCH / SWIPE
   ══════════════════════════════════════════════════ */
const SWIPE_T = 50;
let _lastTapTime = 0;
const DOUBLE_TAP_MS = 350;

el.wordStage.addEventListener('touchstart', e => {
  state.touchStartX = e.touches[0].clientX;
  state.touchStartY = e.touches[0].clientY;
}, { passive: true });
el.wordStage.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - state.touchStartX;
  const dy = e.changedTouches[0].clientY - state.touchStartY;
  if (Math.abs(dx) < SWIPE_T && Math.abs(dy) < SWIPE_T) {
    const now = Date.now();
    if (now - _lastTapTime < DOUBLE_TAP_MS) {
      /* Double-tap: exit focus mode (mobile has no ESC key) */
      _lastTapTime = 0;
      if (state.focusActive) { exitFocusMode(); return; }
    }
    _lastTapTime = now;
    togglePlayPause();
  }
  else if (Math.abs(dx) > Math.abs(dy)) { if (dx < 0) jumpWords(+10); else jumpWords(-10); }
}, { passive: true });

/* ══════════════════════════════════════════════════
   DRAG & DROP
   ══════════════════════════════════════════════════ */
el.dropArea.addEventListener('click',    () => el.fileInput.click());
el.dropArea.addEventListener('dragover', e  => { e.preventDefault(); el.dropArea.classList.add('dragover'); });
el.dropArea.addEventListener('dragleave',e  => { if (!el.dropArea.contains(e.relatedTarget)) el.dropArea.classList.remove('dragover'); });
el.dropArea.addEventListener('drop',     e  => {
  e.preventDefault(); el.dropArea.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
el.fileInput.addEventListener('change', () => { if (el.fileInput.files[0]) handleFile(el.fileInput.files[0]); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop',     e => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
el.changeFileBtn.addEventListener('click', () => {
  if (state.loaded && state.currentIndex > 0)
    showConfirm('Leave current position and load a new file?', 'Change File', resetToUploadState);
  else resetToUploadState();
});

/* ══════════════════════════════════════════════════
   CONTROL LISTENERS
   ══════════════════════════════════════════════════ */
el.btnPlayPause.addEventListener('click', togglePlayPause);
el.btnRestart.addEventListener(  'click', restart);
el.btnBack10.addEventListener(   'click', () => jumpWords(-10));
el.btnFwd10.addEventListener(    'click', () => jumpWords(+10));
el.btnEnd.addEventListener(      'click', jumpToEnd);
el.sliderWpm.addEventListener('input', () => setWpm(parseInt(el.sliderWpm.value, 10)));
el.sliderFont.addEventListener('input', () => setFontSize(parseInt(el.sliderFont.value, 10)));
el.sliderChunk.addEventListener('input', () => {
  state.chunkSize = parseInt(el.sliderChunk.value, 10);
  el.chunkDisplay.textContent = state.chunkSize;
  /* Rebuild durations if playing, since chunk affects ISI logic */
  if (state.isPlaying) _buildDurations();
  if (state.loaded && !state.isPlaying) renderChunk(state.currentIndex);
});
el.blankFlashToggle.addEventListener('change', () => { state.blankFlash = el.blankFlashToggle.checked; });
el.speedRampToggle.addEventListener( 'change', () => { state.speedRamp  = el.speedRampToggle.checked;  });
el.ttsToggle.addEventListener('change', () => {
  state.ttsEnabled = el.ttsToggle.checked;
  if (!state.ttsSupported) {
    toast('⚠ TTS not supported in this browser');
    el.ttsToggle.checked = false; state.ttsEnabled = false;
    return;
  }
  if (state.ttsEnabled && state.isPlaying) ttsStartFrom(state.currentIndex);
  if (!state.ttsEnabled) stopTts();
});
el.wordIndexInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = parseInt(el.wordIndexInput.value, 10);
    if (!isNaN(v)) jumpToIndex(v - 1);
  }
});

/* ══════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ══════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  const tag  = document.activeElement.tagName.toLowerCase();
  const type = document.activeElement.type || '';
  if ((tag === 'input' && type !== 'range' && type !== 'checkbox') ||
      tag === 'textarea' || tag === 'select') return;

  if (e.key === 'Escape') {
    if (!el.shortcutModal.classList.contains('hidden'))  { el.shortcutModal.classList.add('hidden');  return; }
    if (!el.summaryModal.classList.contains('hidden'))   { el.summaryModal.classList.add('hidden');   return; }
    if (!el.confirmDialog.classList.contains('hidden'))  { el.confirmDialog.classList.add('hidden'); state.pendingConfirm = null; return; }
    const anyPanel = ['stats-panel', 'toc-panel', 'bookmarks-panel']
      .some(id => !document.getElementById(id).classList.contains('hidden'));
    if (anyPanel) { closeAllPanels(); return; }
    exitFocusMode();
    return;
  }
  switch (e.code) {
    case 'Space':        e.preventDefault(); togglePlayPause();           break;
    case 'ArrowLeft':    e.preventDefault(); jumpWords(-10);              break;
    case 'ArrowRight':   e.preventDefault(); jumpWords(+10);              break;
    case 'ArrowUp':      e.preventDefault(); setWpm(state.wpm + 10);     break;
    case 'ArrowDown':    e.preventDefault(); setWpm(state.wpm - 10);     break;
    case 'BracketLeft':  e.preventDefault(); setFontSize(state.fontSize - 4); break;
    case 'BracketRight': e.preventDefault(); setFontSize(state.fontSize + 4); break;
    case 'KeyR':         e.preventDefault(); restart();                   break;
    case 'KeyB':         e.preventDefault(); addBookmark();               break;
    case 'KeyF':         e.preventDefault(); toggleFocusMode();           break;
    case 'Slash': if (e.shiftKey) { e.preventDefault(); toggleShortcutModal(); } break;
  }
});

/* ══════════════════════════════════════════════════
   SETTERS
   ══════════════════════════════════════════════════ */
function setWpm(val) {
  state.wpm = Math.max(100, Math.min(1500, Math.round(val / 10) * 10));
  el.sliderWpm.value       = state.wpm;
  el.wpmDisplay.textContent= state.wpm;
  updateLiveWpmBadge();
  updateWpmEmoji();
  /* Rebuild duration buffer if playing — WPM changed */
  if (state.isPlaying) _buildDurations();
}
function setFontSize(val) {
  state.fontSize = Math.max(16, Math.min(FONT_MAX, Math.round(val / 2) * 2));
  el.sliderFont.value        = state.fontSize;
  el.fontDisplay.textContent = state.fontSize;
  if (!el.wordDisplay.classList.contains('hidden')) {
    el.wordLeft.style.fontSize  = state.fontSize + 'px';
    el.wordRight.style.fontSize = state.fontSize + 'px';
    if (el.wordCenterText) el.wordCenterText.style.fontSize = state.fontSize + 'px';
  }
}

/* ══════════════════════════════════════════════════
   RESIZE
   ══════════════════════════════════════════════════ */
window.addEventListener('resize', () => {
  if (state.wpmHistory.length >= 2) drawSparkline();
});

/* ══════════════════════════════════════════════════
   UTILITY
   ══════════════════════════════════════════════════ */
function escHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════ */
(function init() {
  el.sliderWpm.value          = state.wpm;
  el.wpmDisplay.textContent   = state.wpm;
  el.sliderFont.value         = state.fontSize;
  el.fontDisplay.textContent  = state.fontSize;
  el.sliderChunk.value        = state.chunkSize;
  el.chunkDisplay.textContent = state.chunkSize;
  el.totalWordsDisplay.textContent = '0';
  el.wordIndexInput.value     = 1;
  el.wordDisplay.classList.add('hidden');
  el.historyStrip.classList.add('hidden');
  el.liveWpmBadge.classList.add('hidden');
  el.stageMessage.style.display = '';
  el.stageMessage.textContent   = 'Upload a PDF or TXT to begin';
  el.btnToc.disabled = true;

  if (!state.ttsSupported) {
    el.ttsLabel.style.opacity = '0.4';
    el.ttsToggle.disabled     = true;
    el.ttsLabel.title         = 'TTS not supported in this browser';
  }

  /* Smart pace on by default */
  el.speedRampToggle.checked = state.speedRamp;

  applyFont(el.fontSelect.value);
  initTtsVoice();
  updateLiveWpmBadge();
  updateWpmEmoji();
})();
