# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RSVP-Reader is a browser-based speed reading tool using Rapid Serial Visual Presentation. It flashes words (or multi-word chunks) at configurable speeds, supporting PDF and TXT file input.

## Development

This is a zero-build, vanilla HTML/CSS/JS project. There is no package manager, bundler, linter, or test framework.

- **Run locally**: Open `index.html` directly in a browser (`file://` protocol) or serve with any static HTTP server (e.g., `python3 -m http.server`)
- **No build step**: Edit files and reload the browser
- **No ES modules**: Plain `<script>` tags are used for `file://` compatibility

## Architecture

### File Structure

| File | Purpose |
|------|---------|
| `index.html` | Single-page app shell with all HTML markup, CSP meta tag, and CDN script for PDF.js |
| `style.css` | All styles including 5 theme definitions (VS Dark, Solarized, High Contrast, Light, Sepia) via `[data-theme]` selectors |
| `parser.js` | Text extraction and tokenization — loaded first, exposes globals: `PARA_BREAK_TOKEN`, `tokenize`, `extractTXT`, `extractPDF` |
| `app.js` | All application logic (~1550 lines): state management, rendering, playback loop, UI controls, TTS, persistence |

### Key Patterns

**Global state object**: All mutable state lives in a single `state` object (`app.js:85`). The `el` object (`app.js:120`) caches every DOM element reference at startup — never re-query the DOM.

**Script load order matters**: `parser.js` must load before `app.js` because `app.js` calls `extractPDF`, `extractTXT`, and references `PARA_BREAK_TOKEN` as globals.

**ORP (Optimal Recognition Point)**: In single-word mode (`chunkSize=1`), the display uses a two-half layout (`#word-left` / `#word-right`) with the pivot letter positioned at screen center via `getPivotIndex()`. In multi-word mode (`chunkSize>1`), a centered block (`#word-center-block`) replaces the ORP layout.

**RAF playback loop**: Word display timing uses a phase-locked `requestAnimationFrame` ping-pong loop with pre-allocated `Float32Array` for durations — not `setTimeout`. The loop alternates between prepare/reveal and blank-flash phases.

**Smart pace**: When enabled, `smartDelay()` adjusts per-word display duration based on word length, punctuation, rare words (not in `COMMON_WORDS` set + length >= 9), and sentence boundaries.

**TTS strategy**: Text-to-speech uses 12-word micro-chunks (`TTS_CHUNK_SIZE`) to avoid Chromium's 15s cloud-voice timeout. Local voices are preferred. A `_ttsQueue[]` array holds strong references to prevent GC of pending utterances.

**Progress persistence**: Reading position is auto-saved to `localStorage` under the key `rsvp_progress` every 5 seconds during playback. On file reload, a resume prompt is shown.

**PDF extraction**: Uses PDF.js 3.11.174 from cdnjs CDN. Includes two-column detection (finds largest horizontal gap between text origins) and heading detection (text height >= 1.5x the 65th-percentile body text height).

### Content Security Policy

CSP is enforced via a `<meta>` tag in `index.html`. Scripts are restricted to `'self'` and `https://cdnjs.cloudflare.com`. Inline scripts/styles are blocked. Trusted Types are intentionally omitted because PDF.js 3.x uses `eval()` internally for font rendering.
