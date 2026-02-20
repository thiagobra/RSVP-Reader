/* ════════════════════════════════════════════════════════════════
   RSVPReader v4.0 — parser.js  (plain globals, no import/export)
   ────────────────────────────────────────────────────────────────
   Loaded before app.js via a plain <script> tag.
   Exposes: PARA_BREAK_TOKEN, tokenize, extractTXT, extractPDF
   ════════════════════════════════════════════════════════════════ */
'use strict';

/* ──────────────────────────────────────────────────
   SHARED TOKEN SENTINEL
   A null-byte-bracketed string that can never appear
   in normal text, used to mark paragraph boundaries
   without a separate data structure.
   ────────────────────────────────────────────────── */
const PARA_BREAK_TOKEN = '\u0000PARA\u0000';

/* ──────────────────────────────────────────────────
   TOKENISE
   Splits text into word tokens, inserting
   PARA_BREAK_TOKEN between non-empty paragraphs.
   Filters tokens that contain at least one letter
   (Latin + extended Latin) to skip pure-symbol lines.
   ────────────────────────────────────────────────── */
function tokenize(text) {
  const paragraphs = text.split(/\n{2,}|\r\n{2,}/);
  const result     = [];
  // Matches any Latin or extended-Latin letter
  const wordRe     = /[a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]/;

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const tokens = paragraphs[pi]
      .split(/\s+/)
      .filter(t => t.length > 0 && wordRe.test(t));

    if (tokens.length === 0) continue;
    if (pi > 0 && result.length > 0) result.push(PARA_BREAK_TOKEN);
    for (let ti = 0; ti < tokens.length; ti++) result.push(tokens[ti]);
  }
  return result;
}

/* ──────────────────────────────────────────────────
   PLAIN TEXT EXTRACTION
   Reads a .txt File object and tokenises its content.
   Chapters array is empty (no structure in plain text).
   ────────────────────────────────────────────────── */
async function extractTXT(file) {
  const text = await file.text();
  const words = tokenize(text);
  return { words, chapters: [] };
}

/* ──────────────────────────────────────────────────
   PDF EXTRACTION
   Uses PDF.js (must be loaded globally as pdfjsLib).
   Callbacks are injected to avoid coupling to the DOM.

   @param {File}   file
   @param {object} cb  — { setLoadingProgress, addLog }
   @returns {{ words: string[], chapters: object[] }}
   ────────────────────────────────────────────────── */
async function extractPDF(file, { setLoadingProgress, addLog }) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const N   = pdf.numPages;
  const allPageItems = [];

  addLog('> Scanning ' + N + ' pages…');

  for (let p = 1; p <= N; p++) {
    setLoadingProgress(p, N, file.name);
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent({ includeMarkedContent: false });
    allPageItems.push(content.items.filter(i => i.str));
    if (p % 10 === 0) addLog(`  ↳ ${p}/${N} scanned`);
  }

  addLog('> Reconstructing reading order…');

  /* ── Determine heading threshold ──────────────────
     Use the 65th percentile text height as "body" size;
     anything ≥ 1.5× body is treated as a heading.
     ─────────────────────────────────────────────── */
  const allHeights = allPageItems
    .flat()
    .map(i => i.height || 0)
    .filter(h => h > 0)
    .sort((a, b) => a - b);
  const medH  = allHeights.length
    ? allHeights[Math.floor(allHeights.length * 0.65)]
    : 0;
  const headT = medH > 0 ? medH * 1.5 : Infinity;

  const words    = [];
  const chapters = [];

  for (const items of allPageItems) {
    if (!items.length) continue;

    /* ── Two-column detection ─────────────────────
       Find the largest horizontal gap between text
       origins to detect a column break.
       ──────────────────────────────────────────── */
    const xs     = items.map(i => i.transform[4]).sort((a, b) => a - b);
    const pageW  = (xs[xs.length - 1] - xs[0]) || 1;
    let colBreak = null;
    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i] - xs[i - 1];
      const mid = (xs[i] + xs[i - 1]) / 2;
      if (gap > pageW * 0.15 && mid > xs[0] + pageW * 0.2 && mid < xs[0] + pageW * 0.8) {
        colBreak = (xs[i - 1] + xs[i]) / 2;
        break;
      }
    }

    /* Sort: left column top-to-bottom, then right column */
    const sorted = colBreak !== null
      ? [
          ...items.filter(i => i.transform[4] <= colBreak)
                  .sort((a, b) => b.transform[5] - a.transform[5]),
          ...items.filter(i => i.transform[4] >  colBreak)
                  .sort((a, b) => b.transform[5] - a.transform[5]),
        ]
      : items.sort((a, b) => b.transform[5] - a.transform[5]);

    for (const item of sorted) {
      const str       = item.str.trim();
      if (!str) continue;
      const isHeading = (item.height || 0) >= headT;
      const toks      = tokenize(str);
      const realToks  = toks.filter(t => t !== PARA_BREAK_TOKEN);
      if (isHeading && realToks.length) {
        chapters.push({ title: realToks.join(' ').slice(0, 80), wordIndex: words.length });
      }
      for (let k = 0; k < toks.length; k++) words.push(toks[k]);
    }
  }

  addLog(
    `> Done — ${words.filter(w => w !== PARA_BREAK_TOKEN).length.toLocaleString()} words, ` +
    `${chapters.length} headings`,
    true
  );
  return { words, chapters };
}
