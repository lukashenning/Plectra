// SVG path helpers — all glyphs are pre-extracted Bravura paths.
import { GLYPHS } from './glyphs';
import type { NoteType, DynamicValue } from '../types';

const NS = 'http://www.w3.org/2000/svg';

function pathEl(d: string, fill = '#111'): SVGPathElement {
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', fill);
  return p;
}

function glyph(name: string, x: number, y: number): SVGGElement {
  const g = GLYPHS[name];
  if (!g) throw new Error(`Unknown glyph: ${name}`);
  const group = document.createElementNS(NS, 'g');
  group.setAttribute('transform', `translate(${x},${y})`);
  group.appendChild(pathEl(g.d));
  return group;
}

export function drawGClef(svg: SVGElement, x: number, baselineY: number) {
  svg.appendChild(glyph('gClef', x, baselineY));
}

export function drawFClef(svg: SVGElement, x: number, baselineY: number) {
  svg.appendChild(glyph('fClef', x, baselineY));
}

export function drawCClef(svg: SVGElement, x: number, refY: number) {
  // cClef baseline = vertical centre of glyph = C4 reference line position.
  svg.appendChild(glyph('cClef', x, refY));
}

export function drawNoteHead(
  svg: SVGElement, x: number, y: number, type: NoteType,
): SVGElement {
  const name =
    type === 'whole' ? 'noteheadWhole' :
    type === 'half'  ? 'noteheadHalf'  : 'noteheadBlack';
  const g = GLYPHS[name];
  const cx = x - g.w / 2 - g.left;
  const group = document.createElementNS(NS, 'g');
  group.setAttribute('transform', `translate(${cx},${y})`);
  group.appendChild(pathEl(g.d));
  svg.appendChild(group);
  return group;
}

export function noteHeadWidth(type: NoteType): number {
  const name = type === 'whole' ? 'noteheadWhole' : type === 'half' ? 'noteheadHalf' : 'noteheadBlack';
  return GLYPHS[name]?.w ?? 10;
}

export function drawAccidental(
  svg: SVGElement, x: number, y: number,
  kind: 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'flat-flat',
) {
  const name =
    kind === 'sharp'        ? 'accSharp'      :
    kind === 'flat'         ? 'accFlat'       :
    kind === 'natural'      ? 'accNatural'    :
    kind === 'double-sharp' ? 'accDoubleSharp':
                              'accDoubleFlat';
  const g = GLYPHS[name];
  const group = document.createElementNS(NS, 'g');
  group.setAttribute('transform', `translate(${x - g.w - 2},${y})`);
  group.appendChild(pathEl(g.d));
  svg.appendChild(group);
}

export function drawAugDot(svg: SVGElement, x: number, y: number) {
  const g = GLYPHS['augDot'];
  const group = document.createElementNS(NS, 'g');
  group.setAttribute('transform', `translate(${x - g.w / 2 - g.left},${y})`);
  group.appendChild(pathEl(g.d));
  svg.appendChild(group);
}

export function drawFlag(
  svg: SVGElement, stemTipX: number, stemTipY: number,
  type: NoteType, stemUp: boolean,
) {
  const name =
    type === 'eighth' ? (stemUp ? 'flag8thUp'  : 'flag8thDown') :
    type === '16th'   ? (stemUp ? 'flag16thUp' : 'flag16thDown') :
    type === '32nd'   ? (stemUp ? 'flag16thUp' : 'flag16thDown') :
    null;
  if (!name) return;
  const group = document.createElementNS(NS, 'g');
  group.setAttribute('transform', `translate(${stemTipX},${stemTipY})`);
  group.appendChild(pathEl(GLYPHS[name].d));
  svg.appendChild(group);
}

export function drawRest(svg: SVGElement, x: number, y: number, type: NoteType) {
  // y = staffTop + 2*SPACE (middle line) for all rests.
  // Whole rest hangs from 4th line (1 space above middle), so shift up by 10px.
  const SPACE = 10;

  if (type === 'whole') {
    const g = GLYPHS['restWhole'];
    const group = document.createElementNS(NS, 'g');
    // Baseline on line 4 from bottom = y - SPACE
    group.setAttribute('transform', `translate(${x - g.w / 2 - g.left},${y - SPACE})`);
    group.appendChild(pathEl(g.d));
    svg.appendChild(group);
    return;
  }
  if (type === 'half') {
    const g = GLYPHS['restHalf'];
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('transform', `translate(${x - g.w / 2 - g.left},${y})`);
    group.appendChild(pathEl(g.d));
    svg.appendChild(group);
    return;
  }

  // Quarter, eighth, 16th, 32nd — use correctly mapped glyph names.
  const map: Record<string, string> = {
    quarter: 'restQuarter', eighth: 'rest8th', '16th': 'rest16th', '32nd': 'rest32nd',
  };
  const name = map[type] ?? 'restQuarter';
  const g = GLYPHS[name];
  const group = document.createElementNS(NS, 'g');
  group.setAttribute('transform', `translate(${x - g.w / 2 - g.left},${y})`);
  group.appendChild(pathEl(g.d));
  svg.appendChild(group);
}

export function drawTimeSigDigit(svg: SVGElement, digit: number, cx: number, cy: number) {
  const name = `timeSig${digit}`;
  const g = GLYPHS[name];
  if (!g) return;
  const group = document.createElementNS(NS, 'g');
  const tx = cx - g.left - g.w / 2;
  const ty = cy - g.h / 2 - g.top;
  group.setAttribute('transform', `translate(${tx},${ty})`);
  group.appendChild(pathEl(g.d));
  svg.appendChild(group);
}

export function drawArticulation(
  svg: SVGElement, x: number, y: number,
  kind: 'staccato' | 'accent' | 'tenuto',
) {
  const name = kind === 'staccato' ? 'staccato' : kind === 'accent' ? 'accent' : 'tenuto';
  const g = GLYPHS[name];
  if (!g) return;
  const group = document.createElementNS(NS, 'g');
  group.setAttribute('transform', `translate(${x - g.w / 2 - g.left},${y})`);
  group.appendChild(pathEl(g.d));
  svg.appendChild(group);
}

const DYNAMIC_GLYPH: Partial<Record<DynamicValue, string>> = {
  p: 'dynamicP', f: 'dynamicF', ff: 'dynamicFF', pp: 'dynamicPP',
  mp: 'dynamicMP', mf: 'dynamicMF', fff: 'dynamicFFF', ppp: 'dynamicPPP',
  sfz: 'dynamicSFZ', sf: 'dynamicSF', fp: 'dynamicFP', fz: 'dynamicFZ',
};

export function drawDynamic(svg: SVGElement, x: number, y: number, value: DynamicValue) {
  const name = DYNAMIC_GLYPH[value];
  if (!name) return;
  const g = GLYPHS[name];
  if (!g) return;
  const group = document.createElementNS(NS, 'g');
  // Centre horizontally on x
  group.setAttribute('transform', `translate(${x - g.w / 2 - g.left},${y})`);
  group.appendChild(pathEl(g.d));
  svg.appendChild(group);
}
