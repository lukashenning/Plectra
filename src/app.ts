import { unzipSync, strFromU8 } from 'fflate';
import rawMusicIndex from './music-index.json';
import { parseMusicXML } from './musicxml/parser';
import { layoutBar, computeBarBeats, computePrefixWidth, computeSplitPoint, HIT_W_MIN, RIGHT_MARGIN, type SlurAnchor } from './notation/layout';
import { renderBar, type HitTarget } from './notation/renderer';
import { createTouchContext } from './input/touch';
import { installIOSFixes } from './input/ios';
import { ensureAudioReady, setInstrument, startLoadingPianoforte, pianoforteReady, type InstrumentId } from './audio/synth';
import { getPianoforteDynamics, setPianoforteDynamics, DEFAULT_DYNAMICS, ANCHOR_PX } from './audio/pianoforteDynamics';
import { getSound01Dynamics, setSound01Dynamics, DEFAULT_DYNAMICS as SOUND01_DEFAULT_DYNAMICS } from './audio/sound01Dynamics';
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
let hitTargetsTop: HitTarget[] = [];
// Slur state per page index: incoming slurs at the start of each page
let slurStateByPage: Map<string, SlurAnchor>[] = [];
let slurStateByPageTop: Map<string, SlurAnchor>[] = [];

let viewMode: 'solo' | '2player' = 'solo';

// Touch contexts
let sharedCooldown = { until: 0 };
let touchCtx  = createTouchContext();
let bottomCtx = createTouchContext({ sharedCooldown, compact: true });
let topCtx    = createTouchContext({ flipped: true, sharedCooldown, compact: true });

// ── DOM refs ──────────────────────────────────────────────────────────────────

const scoreContainer    = document.getElementById('score-container')!;
const scoreContainerTop = document.getElementById('score-container-top')!;
const scoreContainerBot = document.getElementById('score-container-bottom')!;
const scoreInfo      = document.getElementById('score-info')!;
const scoreTitleEl   = document.getElementById('score-title')!;
const scoreComposer  = document.getElementById('score-composer')!;
const barNumberEl    = document.getElementById('bar-number-btn') as HTMLInputElement;
const loadBtn        = document.getElementById('load-btn')!;
const fileInput      = document.getElementById('file-input') as HTMLInputElement;
const prevBtn        = document.getElementById('prev-btn')!;
const nextBtn        = document.getElementById('next-btn')!;
const nextBarZone        = document.getElementById('next-bar-zone')!;
const instrumentSelectEl = document.getElementById('instrument-select') as HTMLSelectElement;
const viewSelectEl       = document.getElementById('view-select') as HTMLSelectElement;
const topBarEl              = document.getElementById('top-bar')!;
const navBarEl              = document.getElementById('nav-bar')!;
const splitScreenHeader     = document.getElementById('split-screen-header')!;
const splitScreenEl         = document.getElementById('split-screen')!;
// Original parent elements for solo-mode restore
const topBarSoloParent  = topBarEl.parentElement!;
const topBarSoloNextSib = topBarEl.nextElementSibling;
const navBarSoloParent  = navBarEl.parentElement!;

function applyViewLayout(mode: 'solo' | '2player') {
  if (mode === '2player') {
    // Header between the two halves; nav at the very bottom of split-screen.
    // Both player halves are flex:1 siblings of the header → equal height.
    splitScreenHeader.appendChild(topBarEl);
    splitScreenEl.appendChild(navBarEl);
  } else {
    // Restore to body-level positions
    topBarSoloParent.insertBefore(topBarEl, topBarSoloNextSib);
    navBarSoloParent.appendChild(navBarEl);
  }
}

barNumberEl.classList.add('hidden');

// Pre-load Pianoforte samples (works before first user gesture; context resumes on first tap)
instrumentSelectEl.classList.add('loading');
startLoadingPianoforte().then(() => {
  instrumentSelectEl.classList.remove('loading');
}).catch(() => {
  // Pianoforte unavailable — fall back silently to Sound 01
  instrumentSelectEl.value = 'sound01';
  setInstrument('sound01');
  instrumentSelectEl.classList.remove('loading');
});

instrumentSelectEl.addEventListener('change', () => {
  if (instrumentSelectEl.value === 'pianoforte-settings') {
    instrumentSelectEl.value = 'pianoforte';
    openPianoforteSettings();
    return;
  }
  if (instrumentSelectEl.value === 'sound01-settings') {
    instrumentSelectEl.value = 'sound01';
    openSound01Settings();
    return;
  }
  setInstrument(instrumentSelectEl.value as InstrumentId);
  if (instrumentSelectEl.value === 'pianoforte' && !pianoforteReady()) {
    instrumentSelectEl.classList.add('loading');
    startLoadingPianoforte().then(() => {
      instrumentSelectEl.classList.remove('loading');
    }).catch(() => {
      instrumentSelectEl.classList.remove('loading');
    });
  }
});

// ── Pianoforte settings dialog ────────────────────────────────────────────────

function openPianoforteSettings(): void {
  if (document.getElementById('piano-settings-dialog')) return;

  const overlay = document.createElement('div');
  overlay.id = 'piano-settings-dialog';
  overlay.className = 'piano-settings-overlay';

  const sheet = document.createElement('div');
  sheet.className = 'piano-settings-sheet';

  const header = document.createElement('div');
  header.className = 'piano-settings-header';
  const title = document.createElement('span');
  title.className = 'piano-settings-title';
  title.textContent = 'Pianoforte dynamics';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'piano-settings-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'piano-settings-body';

  // Human-readable label for each of the 5 anchor touch heights.
  const anchorLabels = ['25 px', '50 px', '75 px', '101 px', '126 px', '151+ px'];

  // Build one section (tap or swipe) with 5 sliders.
  // allInputs[mode][anchorIndex] holds the <input> element.
  const allInputs: [HTMLInputElement[], HTMLInputElement[]] = [[], []];

  function buildSection(mode: 'tap' | 'swipe', modeIndex: 0 | 1): void {
    const section = document.createElement('div');
    section.className = 'piano-settings-section';

    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'piano-settings-section-label';
    sectionLabel.textContent = mode === 'tap' ? 'Tap' : 'Swipe';
    section.appendChild(sectionLabel);

    const cur = getPianoforteDynamics();

    for (let i = 0; i < ANCHOR_PX.length; i++) {
      const row = document.createElement('div');
      row.className = 'piano-setting-row';

      const lbl = document.createElement('label');
      lbl.className = 'piano-setting-label';
      lbl.textContent = anchorLabels[i];

      const valSpan = document.createElement('span');
      valSpan.className = 'piano-setting-value';
      valSpan.textContent = String(cur[mode][i]);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(cur[mode][i]);
      slider.className = 'piano-setting-slider';

      const idx = i;
      slider.addEventListener('input', () => {
        valSpan.textContent = slider.value;
        const d = getPianoforteDynamics();
        d[mode][idx] = Number(slider.value);
        setPianoforteDynamics(d);
      });

      allInputs[modeIndex].push(slider);
      row.appendChild(lbl);
      row.appendChild(slider);
      row.appendChild(valSpan);
      section.appendChild(row);
    }

    body.appendChild(section);
  }

  buildSection('tap',   0);
  buildSection('swipe', 1);

  const footer = document.createElement('div');
  footer.className = 'piano-settings-footer';
  const resetBtn = document.createElement('button');
  resetBtn.className = 'piano-settings-reset';
  resetBtn.textContent = 'Reset defaults';
  resetBtn.addEventListener('click', () => {
    setPianoforteDynamics({ tap: [...DEFAULT_DYNAMICS.tap], swipe: [...DEFAULT_DYNAMICS.swipe] });
    for (let m = 0; m < 2; m++) {
      const mode = m === 0 ? 'tap' : 'swipe' as const;
      for (let i = 0; i < ANCHOR_PX.length; i++) {
        const inp = allInputs[m][i];
        inp.value = String(DEFAULT_DYNAMICS[mode][i]);
        inp.dispatchEvent(new Event('input'));
      }
    }
  });
  footer.appendChild(resetBtn);

  sheet.appendChild(header);
  sheet.appendChild(body);
  sheet.appendChild(footer);
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  overlay.addEventListener('pointerdown', e => {
    if (e.target === overlay) overlay.remove();
  });
}

// ── Sound 01 settings dialog ──────────────────────────────────────────────────

function openSound01Settings(): void {
  if (document.getElementById('sound01-settings-dialog')) return;

  const overlay = document.createElement('div');
  overlay.id = 'sound01-settings-dialog';
  overlay.className = 'piano-settings-overlay';

  const sheet = document.createElement('div');
  sheet.className = 'piano-settings-sheet';

  const header = document.createElement('div');
  header.className = 'piano-settings-header';
  const title = document.createElement('span');
  title.className = 'piano-settings-title';
  title.textContent = 'Sound 01 dynamics';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'piano-settings-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'piano-settings-body';

  const anchorLabels = ['25 px', '50 px', '75 px', '101 px', '126 px', '151+ px'];
  const allInputs: [HTMLInputElement[], HTMLInputElement[]] = [[], []];

  function buildSection(mode: 'tap' | 'swipe', modeIndex: 0 | 1): void {
    const section = document.createElement('div');
    section.className = 'piano-settings-section';

    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'piano-settings-section-label';
    sectionLabel.textContent = mode === 'tap' ? 'Tap' : 'Swipe';
    section.appendChild(sectionLabel);

    const cur = getSound01Dynamics();

    for (let i = 0; i < ANCHOR_PX.length; i++) {
      const row = document.createElement('div');
      row.className = 'piano-setting-row';

      const lbl = document.createElement('label');
      lbl.className = 'piano-setting-label';
      lbl.textContent = anchorLabels[i];

      const valSpan = document.createElement('span');
      valSpan.className = 'piano-setting-value';
      valSpan.textContent = String(cur[mode][i]);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(cur[mode][i]);
      slider.className = 'piano-setting-slider';

      const idx = i;
      slider.addEventListener('input', () => {
        valSpan.textContent = slider.value;
        const d = getSound01Dynamics();
        d[mode][idx] = Number(slider.value);
        setSound01Dynamics(d);
      });

      allInputs[modeIndex].push(slider);
      row.appendChild(lbl);
      row.appendChild(slider);
      row.appendChild(valSpan);
      section.appendChild(row);
    }

    body.appendChild(section);
  }

  buildSection('tap',   0);
  buildSection('swipe', 1);

  const footer = document.createElement('div');
  footer.className = 'piano-settings-footer';
  const resetBtn = document.createElement('button');
  resetBtn.className = 'piano-settings-reset';
  resetBtn.textContent = 'Reset defaults';
  resetBtn.addEventListener('click', () => {
    setSound01Dynamics({ tap: [...SOUND01_DEFAULT_DYNAMICS.tap], swipe: [...SOUND01_DEFAULT_DYNAMICS.swipe] });
    for (let m = 0; m < 2; m++) {
      const mode = m === 0 ? 'tap' : 'swipe' as const;
      for (let i = 0; i < ANCHOR_PX.length; i++) {
        const inp = allInputs[m][i];
        inp.value = String(SOUND01_DEFAULT_DYNAMICS[mode][i]);
        inp.dispatchEvent(new Event('input'));
      }
    }
  });
  footer.appendChild(resetBtn);

  sheet.appendChild(header);
  sheet.appendChild(body);
  sheet.appendChild(footer);
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  overlay.addEventListener('pointerdown', e => {
    if (e.target === overlay) overlay.remove();
  });
}

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

function buildSlurStates(
  s: Score, states: BarState[], pgs: Page[], containerWidth: number,
  staffOffset = 0, localStaffCount?: number, compact = false, containerHeight = 0,
): Map<string, SlurAnchor>[] {
  const sc = localStaffCount ?? s.staffCount;
  const result: Map<string, SlurAnchor>[] = [];
  let incoming = new Map<string, SlurAnchor>();
  for (const page of pgs) {
    result.push(incoming);
    const bar = s.bars[page.barIndex];
    const state = states[page.barIndex];
    const showTimeSig = page.barIndex === 0 || bar.timeSig !== undefined;
    const layout = layoutBar(
      bar, state.timeSig, state.keySig, containerWidth,
      true, sc, state.clefs,
      page.startBeat, page.endBeat, showTimeSig, staffOffset, compact, containerHeight,
    );
    incoming = new Map(layout.openSlursOut);
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
  const showTimeSig = page.barIndex === 0 || bar.timeSig !== undefined;

  if (viewMode === '2player') {
    const totalStaffs = score.staffCount;
    const bottomStaffCount = Math.ceil(totalStaffs / 2);
    const topStaffCount    = totalStaffs - bottomStaffCount;

    const botWidth  = scoreContainerBot.clientWidth  || window.innerWidth;
    const topWidth  = scoreContainerTop.clientWidth  || window.innerWidth;
    const botHeight = scoreContainerBot.clientHeight || 400;
    const topHeight = scoreContainerTop.clientHeight || 400;

    // Bottom half: staves 1..bottomStaffCount (staffOffset=0)
    const botLayout = layoutBar(
      bar, state.timeSig, state.keySig, botWidth,
      true, bottomStaffCount, state.clefs,
      page.startBeat, page.endBeat, showTimeSig, 0, true, botHeight,
    );
    const botIncoming = slurStateByPage[currentPageIndex] ?? new Map();
    hitTargets = renderBar(
      scoreContainerBot, botLayout, state.timeSig, state.keySig, bar.number, true,
      !page.isLastInBar, !page.isFirstInBar, showTimeSig, botIncoming,
    );

    // Top half: staves (bottomStaffCount+1)..totalStaffs (staffOffset=bottomStaffCount)
    if (topStaffCount > 0) {
      const topLayout = layoutBar(
        bar, state.timeSig, state.keySig, topWidth,
        true, topStaffCount, state.clefs,
        page.startBeat, page.endBeat, showTimeSig, bottomStaffCount, true, topHeight,
      );
      const topIncoming = slurStateByPageTop[currentPageIndex] ?? new Map();
      hitTargetsTop = renderBar(
        scoreContainerTop, topLayout, state.timeSig, state.keySig, bar.number, true,
        !page.isLastInBar, !page.isFirstInBar, showTimeSig, topIncoming,
      );
      const topSvg = scoreContainerTop.querySelector('svg') as SVGSVGElement;
      if (topSvg) {
        topCtx.attachTouchHandlers(topSvg, () => hitTargetsTop, advanceBarQuietly, topLayout);
        topCtx.drawDebugZones(topSvg, hitTargetsTop);
      }
    } else {
      scoreContainerTop.innerHTML = '';
      hitTargetsTop = [];
    }

    const botSvg = scoreContainerBot.querySelector('svg') as SVGSVGElement;
    if (botSvg) {
      bottomCtx.attachTouchHandlers(botSvg, () => hitTargets, advanceBarQuietly, botLayout);
      bottomCtx.drawDebugZones(botSvg, hitTargets);
    }

    if (barNumberEl.readOnly) barNumberEl.value = String(bar.number).padStart(3, '0');
    const onBar1 = page.barIndex === 0 && page.isFirstInBar;
    scoreInfo.classList.toggle('hidden', !onBar1);
    if (onBar1 && score) {
      scoreTitleEl.textContent  = score.title;
      scoreComposer.textContent = score.composer;
      scoreComposer.classList.toggle('hidden', !score.composer);
    }
    return;
  }

  // Solo mode
  const containerWidth  = scoreContainer.clientWidth;
  const containerHeight = scoreContainer.clientHeight;
  const layout = layoutBar(
    bar, state.timeSig, state.keySig, containerWidth,
    true, score.staffCount, state.clefs,
    page.startBeat, page.endBeat, showTimeSig, 0, false, containerHeight,
  );
  const incoming = slurStateByPage[currentPageIndex] ?? new Map();
  hitTargets = renderBar(
    scoreContainer, layout, state.timeSig, state.keySig, bar.number, true,
    !page.isLastInBar,
    !page.isFirstInBar,
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
    touchCtx.attachTouchHandlers(newSvg, () => hitTargets, advanceBarQuietly, layout);
    touchCtx.drawDebugZones(newSvg, hitTargets);
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
  if (viewMode === '2player') {
    const botSvg = scoreContainerBot.querySelector('svg') as SVGSVGElement | null;
    const topSvg = scoreContainerTop.querySelector('svg') as SVGSVGElement | null;
    bottomCtx.stopAllNotes(botSvg ?? undefined);
    topCtx.stopAllNotes(topSvg ?? undefined);
  } else {
    const svg = scoreContainer.querySelector('svg') as SVGSVGElement | null;
    touchCtx.stopAllNotes(svg ?? undefined);
  }
  currentPageIndex = Math.max(0, Math.min(index, pages.length - 1));
  renderCurrentBar();
}

function retreatBarQuietly() {
  if (!score || currentPageIndex <= 0) return;
  if (viewMode === '2player') {
    const botIds = bottomCtx.captureForTransition(hitTargets);
    const topIds = topCtx.captureForTransition(hitTargetsTop);
    currentPageIndex--;
    renderCurrentBar();
    const botSvg = scoreContainerBot.querySelector('svg') as SVGSVGElement | null;
    const topSvg = scoreContainerTop.querySelector('svg') as SVGSVGElement | null;
    if (botSvg) for (const id of botIds) { try { botSvg.setPointerCapture(id); } catch { } }
    if (topSvg) for (const id of topIds) { try { topSvg.setPointerCapture(id); } catch { } }
  } else {
    const activeIds = touchCtx.captureForTransition(hitTargets);
    currentPageIndex--;
    renderCurrentBar();
    const newSvg = scoreContainer.querySelector('svg') as SVGSVGElement | null;
    if (newSvg) {
      for (const id of activeIds) { try { newSvg.setPointerCapture(id); } catch { } }
    }
  }
}

function advanceBarQuietly() {
  if (!score || currentPageIndex >= pages.length - 1) return;
  if (viewMode === '2player') {
    const botIds = bottomCtx.captureForTransition(hitTargets);
    const topIds = topCtx.captureForTransition(hitTargetsTop);
    currentPageIndex++;
    renderCurrentBar();
    const botSvg = scoreContainerBot.querySelector('svg') as SVGSVGElement | null;
    const topSvg = scoreContainerTop.querySelector('svg') as SVGSVGElement | null;
    if (botSvg) for (const id of botIds) { try { botSvg.setPointerCapture(id); } catch { } }
    if (topSvg) for (const id of topIds) { try { topSvg.setPointerCapture(id); } catch { } }
  } else {
    const activeIds = touchCtx.captureForTransition(hitTargets);
    currentPageIndex++;
    renderCurrentBar();
    const newSvg = scoreContainer.querySelector('svg') as SVGSVGElement | null;
    if (newSvg) {
      for (const id of activeIds) { try { newSvg.setPointerCapture(id); } catch { } }
    }
  }
}

prevBtn.addEventListener('pointerdown', e => { e.stopPropagation(); retreatBarQuietly(); });
nextBtn.addEventListener('pointerdown', e => { e.stopPropagation(); advanceBarQuietly(); });

viewSelectEl.addEventListener('change', () => {
  viewMode = viewSelectEl.value as 'solo' | '2player';
  document.body.classList.toggle('mode-2player', viewMode === '2player');
  applyViewLayout(viewMode);

  // Stop all notes and recreate touch contexts
  touchCtx.stopAllNotes();
  bottomCtx.stopAllNotes();
  topCtx.stopAllNotes();
  sharedCooldown = { until: 0 };
  touchCtx  = createTouchContext();
  bottomCtx = createTouchContext({ sharedCooldown, compact: true });
  topCtx    = createTouchContext({ flipped: true, sharedCooldown, compact: true });

  if (score) {
    const w = (viewMode === '2player' ? scoreContainerBot.clientWidth : scoreContainer.clientWidth) || window.innerWidth;
    const h = viewMode === '2player' ? 0 : (scoreContainer.clientHeight || 600);
    pages           = buildPages(score, barStates, w);
    slurStateByPage = buildSlurStates(score, barStates, pages, w, 0, undefined, false, h);
    if (viewMode === '2player') {
      const bottomStaffCount = Math.ceil(score.staffCount / 2);
      const topStaffCount    = score.staffCount - bottomStaffCount;
      slurStateByPageTop = topStaffCount > 0
        ? buildSlurStates(score, barStates, pages, scoreContainerTop.clientWidth || window.innerWidth, bottomStaffCount, topStaffCount, true, 0)
        : [];
    }
    currentPageIndex = Math.min(currentPageIndex, pages.length - 1);
  }
  renderCurrentBar();
});

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
  const h          = viewMode === '2player' ? 0 : (scoreContainer.clientHeight || 600);
  pages            = buildPages(score, barStates, w);
  slurStateByPage  = buildSlurStates(score, barStates, pages, w, 0, undefined, false, h);
  if (viewMode === '2player') {
    const bottomStaffCount = Math.ceil(score.staffCount / 2);
    const topStaffCount    = score.staffCount - bottomStaffCount;
    slurStateByPageTop = topStaffCount > 0
      ? buildSlurStates(score, barStates, pages, scoreContainerTop.clientWidth || window.innerWidth, bottomStaffCount, topStaffCount, true, 0)
      : [];
  }
  currentPageIndex = 0;
  renderCurrentBar();
}

async function loadFromUrl(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const filename = url.split('/').pop() ?? '';
  const xml = extractXml(filename, await res.arrayBuffer());
  loadFromText(xml);
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
      const w = (viewMode === '2player' ? scoreContainerBot.clientWidth : scoreContainer.clientWidth) || window.innerWidth;
      const h = viewMode === '2player' ? 0 : (scoreContainer.clientHeight || 600);
      pages = buildPages(score, barStates, w);
      slurStateByPage = buildSlurStates(score, barStates, pages, w, 0, undefined, false, h);
      if (viewMode === '2player') {
        const bottomStaffCount = Math.ceil(score.staffCount / 2);
        const topStaffCount    = score.staffCount - bottomStaffCount;
        slurStateByPageTop = topStaffCount > 0
          ? buildSlurStates(score, barStates, pages, scoreContainerTop.clientWidth || window.innerWidth, bottomStaffCount, topStaffCount, true, 0)
          : [];
      }
      currentPageIndex = Math.min(currentPageIndex, pages.length - 1);
    }
    renderCurrentBar();
  }, 100);
});

document.fonts.ready.then(() => { if (score) renderCurrentBar(); });

loadFromUrl('/Plectra/Music/Song/Beethoven/ode-to-joy-ludwig-van-beethoven.mxl').catch(console.error);
