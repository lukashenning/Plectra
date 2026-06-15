import type { BarLayout, NoteSymbol, SlurAnchor } from './layout';
import type { TimeSignature, KeySignature, ClefSign, Clef } from '../types';
import {
  STAFF_HEIGHT, SPACE, BRACE_WIDTH, CLEF_WIDTH,
  KEY_SIG_WIDTH_PER_ACC, TIME_SIG_WIDTH, STEP_PX, RIGHT_MARGIN,
} from './layout';
import {
  drawGClef, drawFClef, drawCClef, drawNoteHead, drawAccidental,
  drawAugDot, drawFlag, drawRest, drawTimeSigDigit,
  drawArticulation, drawDynamic,
} from './symbols';

export interface HitTarget {
  noteId: string;
  midiPitch: number;
  x: number; y: number;
  w: number; h: number;
  tieStart: boolean;
  tieStop: boolean;
}

const STAFF_LINE_COUNT = 5;
const NS = 'http://www.w3.org/2000/svg';

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function staffLines(svg: SVGElement, top: number, width: number) {
  for (let i = 0; i < STAFF_LINE_COUNT; i++) {
    svg.appendChild(el('line', {
      x1: 0, y1: top + i * SPACE,
      x2: width, y2: top + i * SPACE,
      stroke: '#111', 'stroke-width': 1,
    }));
  }
}


function drawClefForStaff(svg: SVGElement, x: number, staffTop: number, clef: Clef) {
  const refY = staffTop + SPACE * (5 - clef.line);
  if (clef.sign === 'G') drawGClef(svg, x + 2, refY);
  else if (clef.sign === 'F') drawFClef(svg, x + 2, refY);
  else if (clef.sign === 'C') drawCClef(svg, x + 2, refY);

  if (clef.octaveChange) {
    // Place the "8" immediately below (G clef) or above (F clef) the glyph.
    // gClef: top=-43.92, h=70.25 → bottom edge = refY + 26.33
    // fClef: top=-10.48, h=35.88 → top edge = refY - 10.48
    const labelY = clef.sign === 'G'
      ? refY + 26.33 + 7   // 7px gap + font baseline positions "8" just below curl
      : refY - 10.48 - 2;  // just above f clef
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', String(x + 2 + CLEF_WIDTH * 0.25));
    t.setAttribute('y', String(labelY));
    t.setAttribute('font-size', '8');
    t.setAttribute('font-family', 'serif');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', '#111');
    t.textContent = '8';
    svg.appendChild(t);
  }
}

function makeDiatonicToY(staffMiddleCYs: number[]) {
  return (d: number, staff: number) => staffMiddleCYs[staff - 1] - d * STEP_PX;
}

// Key signature accidental diatonic positions per clef sign.
// Each array gives diatonic-from-middle-C positions for F C G D A E B (sharps)
// and B E A D G C F (flats) respectively.
const SHARP_POSITIONS: Record<ClefSign, number[]> = {
  G: [10, 7, 11, 8, 5, 9, 6],
  F: [-4, -7, -3, -6, -2, -5, -1],
  C: [ 3,  0,  4,  1, -2,  2, -1],  // alto: F4 C4 G4 D4 A3 E4 B3
};
const FLAT_POSITIONS: Record<ClefSign, number[]> = {
  G: [6, 9, 5, 8, 4, 7, 3],
  F: [-8, -5, -9, -6, -3, -7, -4],
  C: [-1,  2, -2,  1, -3,  0,  3],  // alto: B3 E4 A3 D4 G3 C4 F4
};

function drawKeySignature(
  svg: SVGElement, keySig: KeySignature, x: number,
  staffCount: number, clefs: Record<number, Clef>,
  diatonicToY: (d: number, s: number) => number,
) {
  const count = Math.abs(keySig.fifths);
  const isSharp = keySig.fifths > 0;
  const kind = isSharp ? 'sharp' as const : 'flat' as const;

  for (let s = 1; s <= staffCount; s++) {
    const clef = clefs[s] ?? { sign: 'G' as ClefSign, line: 2 };
    const positions = isSharp ? SHARP_POSITIONS[clef.sign] : FLAT_POSITIONS[clef.sign];
    // diatonicToY is shifted by octaveChange; compensate so accidentals land on the
    // same staff lines as in the un-shifted clef.
    const octaveOffset = (clef.octaveChange ?? 0) * 7;
    for (let i = 0; i < count; i++) {
      drawAccidental(svg, x + i * KEY_SIG_WIDTH_PER_ACC + 8, diatonicToY(positions[i] + octaveOffset, s), kind);
    }
  }
}

function drawTimeSig(svg: SVGElement, timeSig: TimeSignature, cx: number, staffTops: number[]) {
  for (const top of staffTops) {
    drawTimeSigDigit(svg, timeSig.beats,    cx, top + SPACE * 1.25);
    drawTimeSigDigit(svg, timeSig.beatType, cx, top + SPACE * 3.25);
  }
}

function drawSlur(svg: SVGElement, x1: number, y1: number, x2: number, y2: number, above: boolean) {
  // Offset endpoints away from note heads so the bow clears them
  const vOff = above ? -8 : 8;
  const sx1 = x1 + 3, sy1 = y1 + vOff;
  const sx2 = x2 - 3, sy2 = y2 + vOff;
  const midX = (sx1 + sx2) / 2;
  const bow = above ? -10 : 10;
  const cy = (sy1 + sy2) / 2 + bow;
  svg.appendChild(el('path', {
    d: `M ${sx1} ${sy1} Q ${midX} ${cy} ${sx2} ${sy2}`,
    fill: 'none', stroke: '#111', 'stroke-width': 1.5,
    'stroke-linecap': 'round',
  }));
}

export function renderBar(
  container: HTMLElement,
  layout: BarLayout,
  timeSig: TimeSignature,
  keySig: KeySignature,
  _barNumber: number,
  showClef: boolean,
  hideBarline = false,
  hidePrefix = false,
  showTimeSig = true,
  incomingSlurs: Map<string, SlurAnchor> = new Map(),
): HitTarget[] {
  container.innerHTML = '';

  const svg = el('svg', {
    viewBox: `0 0 ${layout.svgWidth} ${layout.svgHeight}`,
    preserveAspectRatio: 'xMidYMid meet',
  }) as SVGSVGElement;

  svg.appendChild(el('rect', {
    x: 0, y: 0, width: layout.svgWidth, height: layout.svgHeight,
    fill: 'white',
  }));

  const { staffTops, staffMiddleCYs, staffCount, activeClefs } = layout;
  const diatonicToY = makeDiatonicToY(staffMiddleCYs);

  const topY = staffTops[0];
  const bottomY = staffTops[staffCount - 1] + STAFF_HEIGHT;

  const staffRight = layout.svgWidth - RIGHT_MARGIN;

  // Staff lines
  for (const top of staffTops) {
    staffLines(svg, top, staffRight);
  }

  // Barlines (right edge only; invisible on non-final pages of a split bar)
  svg.appendChild(el('line', {
    x1: staffRight, y1: topY,
    x2: staffRight, y2: bottomY,
    stroke: '#111', 'stroke-width': 1.5,
    opacity: hideBarline ? 0 : 1,
  }));

  // Prefix (clef, key sig, time sig) — invisible on continuation pages of a split bar
  const prefixGroup = el('g', hidePrefix ? { opacity: '0' } : {});
  svg.appendChild(prefixGroup);

  let x = BRACE_WIDTH;
  if (showClef) {
    for (let s = 1; s <= staffCount; s++) {
      const clef = activeClefs[s] ?? (s === 1
        ? { sign: 'G' as ClefSign, line: 2 }
        : { sign: 'F' as ClefSign, line: 4 });
      drawClefForStaff(prefixGroup, x, staffTops[s - 1], clef);
    }
    x += CLEF_WIDTH;
  }

  const numAcc = Math.abs(keySig.fifths);
  if (numAcc > 0) {
    drawKeySignature(prefixGroup, keySig, x, staffCount, activeClefs, diatonicToY);
    x += numAcc * KEY_SIG_WIDTH_PER_ACC + 6;
  }

  if (showTimeSig) {
    const timeCx = x + TIME_SIG_WIDTH / 2;
    drawTimeSig(prefixGroup, timeSig, timeCx, staffTops);
  }

  // Notes, rests, beams, dynamics
  const hitTargets: HitTarget[] = [];
  const HIT_W = 14;
  const HIT_H = 30;

  for (const sym of layout.symbols) {
    if (sym.kind === 'staffLines') continue;

    if (sym.kind === 'note') {
      for (const ly of sym.ledgerLines) {
        svg.appendChild(el('line', {
          x1: sym.x - 8, y1: ly,
          x2: sym.x + 14, y2: ly,
          stroke: '#111', 'stroke-width': 1,
        }));
      }

      if (sym.accidental) {
        const kind = sym.accidental as 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'flat-flat';
        drawAccidental(svg, sym.x, sym.y, kind);
      }

      const headGroup = drawNoteHead(svg, sym.x, sym.y, sym.noteType);
      headGroup.setAttribute('data-note-id', sym.noteId);

      for (let d = 0; d < sym.dots; d++) {
        drawAugDot(svg, sym.x + 12 + d * 6, sym.y);
      }

      if (sym.noteType !== 'whole') {
        svg.appendChild(el('line', {
          x1: sym.stemX, y1: sym.stemY1,
          x2: sym.stemX, y2: sym.stemY2,
          stroke: '#111', 'stroke-width': 1.5,
        }));
      }

      if (sym.hasFlag) {
        drawFlag(svg, sym.stemX, sym.stemY2, sym.noteType, sym.stemUp);
      }

      hitTargets.push({
        noteId: sym.noteId,
        midiPitch: sym.midiPitch,
        x: sym.x - HIT_W / 2,
        y: sym.y - HIT_H / 2,
        w: HIT_W,
        h: HIT_H,
        tieStart: sym.tieStart,
        tieStop: sym.tieStop,
      });

      // Articulations: place on notehead side (opposite to stem)
      const artOff = SPACE * 1.4;
      if (sym.staccato) {
        const ay = sym.stemUp ? sym.y + artOff : sym.y - artOff;
        drawArticulation(svg, sym.x, ay, 'staccato');
      }
      if (sym.accent) {
        const ay = sym.stemUp ? sym.y + artOff : sym.y - artOff;
        drawArticulation(svg, sym.x, ay, 'accent');
      }
      if (sym.tenuto) {
        const ay = sym.stemUp ? sym.y + artOff : sym.y - artOff;
        drawArticulation(svg, sym.x, ay, 'tenuto');
      }

    } else if (sym.kind === 'rest') {
      drawRest(svg, sym.x, sym.y, sym.noteType);

    } else if (sym.kind === 'beam') {
      svg.appendChild(el('line', {
        x1: sym.x1, y1: sym.y1,
        x2: sym.x2, y2: sym.y2,
        stroke: '#111', 'stroke-width': 5,
      }));

    } else if (sym.kind === 'dynamic') {
      drawDynamic(svg, sym.x, sym.y, sym.value);
    } else if (sym.kind === 'tuplet') {
      const txt = el('text', {
        x: sym.x, y: sym.y,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-size': '18',
        'font-weight': 'bold',
        'font-style': 'italic',
        'font-family': 'serif',
        fill: '#111',
      });
      txt.textContent = String(sym.number);
      svg.appendChild(txt);
    }
  }

  // Slurs: within-bar pairs + cross-bar partial slurs
  const pendingIncoming = new Map(incomingSlurs); // copy so we can consume entries
  const slurStarts = new Map<string, NoteSymbol>();
  for (const sym of layout.symbols) {
    if (sym.kind !== 'note') continue;
    const key = `${sym.staff}-${sym.voice}`;
    if (sym.slurStop || sym.tieStop) {
      if (pendingIncoming.has(key)) {
        // Tail of a cross-bar curve: draw from left note-area edge to this note
        const { y: fromY, above } = pendingIncoming.get(key)!;
        drawSlur(svg, layout.prefixWidth, fromY, sym.x, sym.y, above);
        pendingIncoming.delete(key);
      } else {
        const start = slurStarts.get(key);
        if (start) {
          drawSlur(svg, start.x, start.y, sym.x, sym.y, !start.stemUp);
          slurStarts.delete(key);
        }
      }
    }
    if (sym.slurStart || sym.tieStart) slurStarts.set(key, sym);
  }
  // Outgoing partial slurs: start in this bar but no stop — draw to right edge
  for (const [, sym] of slurStarts) {
    drawSlur(svg, sym.x, sym.y, staffRight, sym.y, !sym.stemUp);
  }
  // Incoming slurs with no stop in this bar — span the full note area
  for (const [, { y, above }] of pendingIncoming) {
    drawSlur(svg, layout.prefixWidth, y, staffRight, y, above);
  }

  container.appendChild(svg);
  return hitTargets;
}
