import { unzipSync, strFromU8 } from 'fflate';
import rawMusicIndex from './music-index.json';
import { parseMusicXML } from './musicxml/parser';
import { layoutBar, computeBarBeats, computePrefixWidth, computeSplitPoint, HIT_W_MIN, RIGHT_MARGIN, type SlurAnchor } from './notation/layout';
import { renderBar, type HitTarget } from './notation/renderer';
import { attachTouchHandlers, stopAllNotes, captureForTransition } from './input/touch';
import { installIOSFixes } from './input/ios';
import { ensureAudioReady } from './audio/synth';
import type { Score, TimeSignature, KeySignature, Clef } from './types';

installIOSFixes();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/Plectra/sw.js', { scope: '/Plectra/' });
}

document.addEventListener('pointerdown', ensureAudioReady, { once: true, capture: true });

// ── Page model ────────────────────────────────────────────────────────────────
// A bar is split into two pages when any adjacent beat pair would have less than
// MIN_HIT_GAP px between their hit-boxes at the current container width.

const MIN_HIT_GAP = 4;

interface Page {
  barIndex: number;
  startBeat: number;  // QN from bar start (inclusive)
  endBeat: number;    // QN from bar start (exclusive upper bound for beat spacing)
  isFirstInBar: boolean;
  isLastInBar: boolean;
}

interface BarState {
  timeSig: TimeSignature;
  keySig: KeySignature;
  clefs: Record<number, Clef>;
}

// ── State ─────────────────────────────────────────────────────────────────────

let score: Score | null = null;
let pages: Page[] = [];
let barStates: BarState[] = [];
let currentPageIndex = 0;
let hitTargets: HitTarget[] = [];
// Slur state per page index: incoming slurs at the start of each page
let slurStateByPage: Map<string, SlurAnchor>[] = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const scoreContainer = document.getElementById('score-container')!;
const scoreInfo      = document.getElementById('score-info')!;
const scoreTitleEl   = document.getElementById('score-title')!;
const scoreComposer  = document.getElementById('score-composer')!;
const barNumberEl    = document.getElementById('bar-number-btn') as HTMLInputElement;
const loadBtn        = document.getElementById('load-btn')!;
const fileInput      = document.getElementById('file-input') as HTMLInputElement;
const prevBtn        = document.getElementById('prev-btn')!;
const nextBtn        = document.getElementById('next-btn')!;
const nextBarZone    = document.getElementById('next-bar-zone')!;

barNumberEl.classList.add('hidden');

// ── Page / state precomputation ───────────────────────────────────────────────

function buildBarStates(s: Score): BarState[] {
  const states: BarState[] = [];
  let timeSig  = s.initialTimeSig;
  let keySig   = s.initialKeySig;
  let clefs    = { ...s.initialClefs };
  for (const bar of s.bars) {
    if (bar.timeSig) timeSig = bar.timeSig;
    if (bar.keySig)  keySig  = bar.keySig;
    if (bar.clefs) {
      for (const [sk, c] of Object.entries(bar.clefs)) clefs[parseInt(sk)] = c;
    }
    states.push({ timeSig, keySig, clefs: { ...clefs } });
  }
  return states;
}

function buildSlurStates(s: Score, states: BarState[], pgs: Page[], containerWidth: number): Map<string, SlurAnchor>[] {
  const result: Map<string, SlurAnchor>[] = [];
  let incoming = new Map<string, SlurAnchor>();
  for (const page of pgs) {
    result.push(incoming);
    const bar = s.bars[page.barIndex];
    const state = states[page.barIndex];
    const showTimeSig = page.barIndex === 0 || bar.timeSig !== undefined;
    const layout = layoutBar(
      bar, state.timeSig, state.keySig, containerWidth,
      true, s.staffCount, state.clefs,
      page.startBeat, page.endBeat, showTimeSig,
    );
    if (page.isLastInBar) {
      // Cross-bar: carry forward open slurs; within same bar carry nothing (handled inline)
      incoming = new Map(layout.openSlursOut);
    } else {
      // Split page: open slurs continue to next page of same bar
      incoming = new Map(layout.openSlursOut);
    }
  }
  return result;
}

function buildPages(s: Score, states: BarState[], containerWidth: number): Page[] {
  const result: Page[] = [];

  for (let bi = 0; bi < s.bars.length; bi++) {
    const bar = s.bars[bi];
    const { timeSig, keySig } = states[bi];
    const barLengthQN = timeSig.beats * (4 / timeSig.beatType);
    const beats = computeBarBeats(bar);

    if (beats.length <= 1) {
      result.push({ barIndex: bi, startBeat: 0, endBeat: barLengthQN, isFirstInBar: true, isLastInBar: true });
      continue;
    }

    // Mirror layoutBar's note area width for this bar.
    const showTimeSig = bi === 0 || bar.timeSig !== undefined;
    const prefixWidth  = computePrefixWidth(keySig, showTimeSig);
    const noteAreaWidth = Math.max(containerWidth - prefixWidth - RIGHT_MARGIN, beats.length * HIT_W_MIN);

    // Check whether any adjacent beat pair would have < MIN_HIT_GAP px between hit-boxes.
    let needsSplit = false;
    for (let i = 1; i < beats.length; i++) {
      const spacingPx = (beats[i] - beats[i - 1]) / barLengthQN * noteAreaWidth;
      if (spacingPx < HIT_W_MIN + MIN_HIT_GAP) { needsSplit = true; break; }
    }

    if (!needsSplit) {
      result.push({ barIndex: bi, startBeat: 0, endBeat: barLengthQN, isFirstInBar: true, isLastInBar: true });
    } else {
      // Split at the temporal midpoint, adjusted to avoid cutting through a triplet group.
      const splitBeat = computeSplitPoint(bar, barLengthQN);
      result.push({ barIndex: bi, startBeat: 0,         endBeat: splitBeat,   isFirstInBar: true,  isLastInBar: false });
      result.push({ barIndex: bi, startBeat: splitBeat, endBeat: barLengthQN, isFirstInBar: false, isLastInBar: true  });
    }
  }
  return result;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderCurrentBar() {
  if (!score || pages.length === 0) return;
  const page  = pages[currentPageIndex];
  const bar   = score.bars[page.barIndex];
  const state = barStates[page.barIndex];
  const containerWidth = scoreContainer.clientWidth;

  const showTimeSig = page.barIndex === 0 || bar.timeSig !== undefined;
  const layout = layoutBar(
    bar, state.timeSig, state.keySig, containerWidth,
    true, score.staffCount, state.clefs,
    page.startBeat, page.endBeat,
    showTimeSig,
  );
  const incoming = slurStateByPage[currentPageIndex] ?? new Map();
  hitTargets = renderBar(
    scoreContainer, layout, state.timeSig, state.keySig, bar.number, true,
    !page.isLastInBar,   // hideBarline: no barline on non-final split pages
    !page.isFirstInBar,  // hidePrefix: no clef/key/time on continuation pages
    showTimeSig,
    incoming,
  );
  if (barNumberEl.readOnly) barNumberEl.value = String(bar.number).padStart(3, '0');

  const onBar1 = page.barIndex === 0 && page.isFirstInBar;
  scoreInfo.classList.toggle('hidden', !onBar1);
  if (onBar1 && score) {
    scoreTitleEl.textContent   = score.title;
    scoreComposer.textContent  = score.composer;
    scoreComposer.classList.toggle('hidden', !score.composer);
  }

  const newSvg = scoreContainer.querySelector('svg') as SVGSVGElement;
  if (newSvg) {
    attachTouchHandlers(newSvg, () => hitTargets, advanceBarQuietly, layout);
    // Set next-bar-zone width to match RIGHT_MARGIN in screen pixels.
    // Deferred one frame so the SVG has a laid-out bounding rect.
    requestAnimationFrame(() => {
      const svgRect = newSvg.getBoundingClientRect();
      const vb = newSvg.viewBox.baseVal;
      const ea = svgRect.width / svgRect.height, va = vb.width / vb.height;
      const displayW = ea > va ? svgRect.height * va : svgRect.width;
      const pxPerUnit = displayW / vb.width;
      nextBarZone.style.width = `${Math.round(RIGHT_MARGIN * pxPerUnit)}px`;
    });
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

function goToPage(index: number) {
  if (!score) return;
  const svg = scoreContainer.querySelector('svg') as SVGSVGElement | null;
  stopAllNotes(svg ?? undefined);
  currentPageIndex = Math.max(0, Math.min(index, pages.length - 1));
  renderCurrentBar();
}

function retreatBarQuietly() {
  if (!score || currentPageIndex <= 0) return;
  const activeIds = captureForTransition(hitTargets);
  currentPageIndex--;
  renderCurrentBar();
  const newSvg = scoreContainer.querySelector('svg') as SVGSVGElement | null;
  if (newSvg) {
    for (const id of activeIds) { try { newSvg.setPointerCapture(id); } catch { } }
  }
}

function advanceBarQuietly() {
  if (!score || currentPageIndex >= pages.length - 1) return;
  const activeIds = captureForTransition(hitTargets);
  currentPageIndex++;
  renderCurrentBar();
  const newSvg = scoreContainer.querySelector('svg') as SVGSVGElement | null;
  if (newSvg) {
    for (const id of activeIds) { try { newSvg.setPointerCapture(id); } catch { } }
  }
}

prevBtn.addEventListener('pointerdown', e => { e.stopPropagation(); retreatBarQuietly(); });
nextBtn.addEventListener('pointerdown', e => { e.stopPropagation(); advanceBarQuietly(); });

// ── Bar jump ──────────────────────────────────────────────────────────────────

barNumberEl.addEventListener('pointerdown', e => {
  e.stopPropagation();
  barNumberEl.removeAttribute('readonly');
  barNumberEl.value = '';
});
barNumberEl.addEventListener('blur', () => commitBarJump());
barNumberEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); barNumberEl.blur(); } });

function commitBarJump() {
  const n = parseInt(barNumberEl.value, 10);
  barNumberEl.setAttribute('readonly', '');
  updateBarDisplay();
  if (!score || isNaN(n)) return;
  const target = Math.max(1, n);
  const idx = pages.findIndex(p => score!.bars[p.barIndex].number >= target && p.isFirstInBar);
  goToPage(idx < 0 ? pages.length - 1 : idx);
}

function updateBarDisplay() {
  if (!score || pages.length === 0) return;
  barNumberEl.value = String(score.bars[pages[currentPageIndex].barIndex].number).padStart(3, '0');
}
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight') goToPage(currentPageIndex + 1);
  if (e.key === 'ArrowLeft')  goToPage(currentPageIndex - 1);
});

// ── Right-edge next-bar zone ──────────────────────────────────────────────────

let lastQuietAdvance = 0;
nextBarZone.addEventListener('pointerdown', () => {
  const now = Date.now();
  if (now - lastQuietAdvance < 2000) return;
  lastQuietAdvance = now;
  advanceBarQuietly();
});

// ── Loading ───────────────────────────────────────────────────────────────────

function loadFromText(text: string) {
  barNumberEl.classList.remove('hidden');
  score            = parseMusicXML(text);
  barStates        = buildBarStates(score);
  const w          = scoreContainer.clientWidth || window.innerWidth;
  pages            = buildPages(score, barStates, w);
  slurStateByPage  = buildSlurStates(score, barStates, pages, w);
  currentPageIndex = 0;
  renderCurrentBar();
}

async function loadFromUrl(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  loadFromText(await res.text());
}

function extractXml(filename: string, data: ArrayBuffer): string {
  if (!filename.toLowerCase().endsWith('.mxl')) {
    return new TextDecoder().decode(data);
  }
  const files = unzipSync(new Uint8Array(data));
  const containerBytes = files['META-INF/container.xml'];
  if (!containerBytes) throw new Error('Invalid MXL: missing META-INF/container.xml');
  const container = strFromU8(containerBytes);
  const match = container.match(/full-path="([^"]+)"/);
  if (!match) throw new Error('Invalid MXL: no rootfile found in container.xml');
  const rootPath = match[1];
  const rootBytes = files[rootPath];
  if (!rootBytes) throw new Error(`Invalid MXL: rootfile "${rootPath}" not found in archive`);
  return strFromU8(rootBytes);
}

loadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const xml = extractXml(file.name, reader.result as ArrayBuffer);
      loadFromText(xml);
      closeFindDialog();
    } catch { /* ignore bad files */ }
  };
  reader.readAsArrayBuffer(file);
  fileInput.value = '';
});

// ── Find music dialog (local Music/ folder) ───────────────────────────────────

interface FileEntry {
  name: string;
  path: string;
  composer: string;
  staffs: number;
}

interface DirEntry {
  name: string;
  path: string;
  files: FileEntry[];
  dirs: DirEntry[];
}

// Music files are served from public/Music/ — resolve relative to document URL.
const MUSIC_BASE = new URL('Music/', document.baseURI).href;

// Index is bundled at build time (no fetch needed).
const musicRoot: DirEntry = { name: 'Music', path: '', ...(rawMusicIndex as { files: FileEntry[]; dirs: DirEntry[] }) };

const findBtn     = document.getElementById('find-btn')!;
const findDialog  = document.getElementById('find-dialog')!;
const findClose   = document.getElementById('find-close')!;
const findBack    = document.getElementById('find-back')!;
const findTitle   = document.getElementById('find-title')!;
const findStatus  = document.getElementById('find-status')!;
const findResults = document.getElementById('find-results')!;

// Navigation stack: each entry is the DirEntry currently shown.
let dirStack: DirEntry[] = [];

findBtn.addEventListener('pointerdown', e => {
  e.stopPropagation();
  dirStack = [];
  findDialog.classList.remove('hidden');
  openDir(null);
});
findClose.addEventListener('pointerdown', e => { e.stopPropagation(); closeFindDialog(); });
findBack.addEventListener('pointerdown', e => {
  e.stopPropagation();
  dirStack.pop();
  openDir(dirStack[dirStack.length - 1] ?? null);
});
findDialog.addEventListener('pointerdown', e => { if (e.target === findDialog) closeFindDialog(); });

function closeFindDialog() { findDialog.classList.add('hidden'); }

function openDir(dir: DirEntry | null) {
  renderDir(dir ?? musicRoot);
}

function renderDir(dir: DirEntry) {
  const inSub = dirStack.length > 0;
  findBack.classList.toggle('hidden', !inSub);
  loadBtn.classList.toggle('hidden', inSub);
  findTitle.textContent = inSub ? dir.name : 'Choose a score';
  findStatus.textContent = '';
  findResults.innerHTML  = '';

  if (dir.dirs.length === 0 && dir.files.length === 0) {
    findStatus.textContent = 'No files found.';
    return;
  }

  for (const sub of dir.dirs) {
    const el = document.createElement('div');
    el.className = 'find-result find-result-dir';
    el.innerHTML = `<span class="find-result-title">${escHtml(sub.name)}</span>`
                 + `<span class="find-result-repo">folder</span>`;
    addTapHandler(el, () => { dirStack.push(dir); renderDir(sub); });
    findResults.appendChild(el);
  }

  for (const file of dir.files) {
    const el = document.createElement('div');
    el.className = 'find-result';
    const sub = [
      file.composer,
      file.staffs > 0 ? `${file.staffs} part${file.staffs > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' · ');
    el.innerHTML = `<span class="find-result-title">${escHtml(file.name)}</span>`
                 + (sub ? `<span class="find-result-repo">${escHtml(sub)}</span>` : '');
    addTapHandler(el, () => {
      closeFindDialog();
      loadMusicFile(file.path);
    });
    findResults.appendChild(el);
  }
}

function addTapHandler(el: HTMLElement, action: () => void) {
  let startY = 0;
  // passive: true lets iOS start scrolling immediately without waiting for JS.
  el.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (Math.abs(e.changedTouches[0].clientY - startY) < 10) {
      e.preventDefault(); // suppress subsequent mouse/click events
      action();
    }
  });
  // Non-touch fallback (desktop mouse).
  el.addEventListener('mouseup', action);
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadMusicFile(relPath: string) {
  try {
    const res = await fetch(MUSIC_BASE + relPath);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const filename = relPath.split('/').pop() ?? relPath;
    const xml = extractXml(filename, buf);
    loadFromText(xml);
  } catch { /* silently ignore */ }
}

// ── Resize ────────────────────────────────────────────────────────────────────

let resizeTimer: number;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (score) {
      // Rebuild pages because spacing thresholds depend on container width.
      const w = scoreContainer.clientWidth || window.innerWidth;
      pages = buildPages(score, barStates, w);
      slurStateByPage = buildSlurStates(score, barStates, pages, w);
      currentPageIndex = Math.min(currentPageIndex, pages.length - 1);
    }
    renderCurrentBar();
  }, 100);
});

document.fonts.ready.then(() => { if (score) renderCurrentBar(); });

loadFromUrl('/beethoven_ode_to_joy.musicxml');
