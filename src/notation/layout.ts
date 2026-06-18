import type { Bar, Note, Event, NoteType, TimeSignature, KeySignature, Clef, ClefSign, DynamicValue } from '../types';
import { staffPosition } from './pitchMap';

// ── Constants ─────────────────────────────────────────────────────────────────

export const STAFF_LINE_COUNT = 5;
export const SPACE = 10;           // px between adjacent staff lines (one staff space)
export const STAFF_HEIGHT = SPACE * (STAFF_LINE_COUNT - 1); // 40px per staff
export const BRACE_WIDTH = 4;
export const CLEF_WIDTH = 28;
export const KEY_SIG_WIDTH_PER_ACC = 10;
export const TIME_SIG_WIDTH = 24;
export const NOTE_AREA_MARGIN = 12; // padding left of note area (after prefix)
export const RIGHT_MARGIN = 20;     // whitespace between right barline and SVG edge
export const HIT_W_MIN = 14;        // minimum hit-box width per beat position

// Each diatonic step = SPACE/2 pixels (half a staff space)
export const STEP_PX = SPACE / 2;

// Vertical layout constants
export const TOP_MARGIN = 90; // kept for legacy reference only

// Zone layout constants — shared with touch.ts
// Staff area = STAFF_AREA_PAD + STAFF_HEIGHT + STAFF_AREA_PAD = 2.5 × STAFF_HEIGHT = 100px
export const STAFF_AREA_PAD = Math.round(STAFF_HEIGHT * 0.75); // 30px above/below staff lines within its area
export const DEAD_ZONE_H    = 40;                              // height of each dead zone (blue, no tap-advance)
// Full staff area height (used to position consecutive staves)
export const STAFF_AREA_H   = STAFF_AREA_PAD + STAFF_HEIGHT + STAFF_AREA_PAD; // 100

// Default staff tops (used as initial value before first render)
export const TREBLE_TOP = DEAD_ZONE_H + STAFF_AREA_PAD;       // 70
export const BASS_TOP   = DEAD_ZONE_H + STAFF_AREA_H + STAFF_AREA_PAD; // 170

// ── Clef helpers ──────────────────────────────────────────────────────────────

/** Y coordinate of middle C (C4) on a staff given the active clef. */
function middleCYForClef(staffTop: number, sign: ClefSign, line: number, octaveChange = 0): number {
  const refY = staffTop + SPACE * (5 - line);
  const refDiatonic = (sign === 'G' ? 4 : sign === 'F' ? -4 : 0) + octaveChange * 7;
  return refY + refDiatonic * STEP_PX;
}

/** Diatonic position of the middle staff line (line 3) for a given clef. */
function midLineDiatonicForClef(sign: ClefSign, line: number, octaveChange = 0): number {
  const refDiatonic = (sign === 'G' ? 4 : sign === 'F' ? -4 : 0) + octaveChange * 7;
  return refDiatonic + 2 * (3 - line);
}

// ── Layout types ──────────────────────────────────────────────────────────────

export interface NoteSymbol {
  kind: 'note';
  x: number; y: number;
  noteId: string;
  noteType: NoteType;
  dots: number;
  filled: boolean;
  stemUp: boolean;
  stemX: number; stemY1: number; stemY2: number;
  hasFlag: boolean;
  ledgerLines: number[];
  accidental: string | null;
  staff: number;
  voice: string;
  midiPitch: number;
  tieStart: boolean;
  tieStop: boolean;
  slurStart: boolean;
  slurStop: boolean;
  staccato: boolean;
  accent: boolean;
  tenuto: boolean;
}

export interface RestSymbol {
  kind: 'rest';
  x: number; y: number;
  noteType: NoteType;
  dots: number;
  wholeRest: boolean;
  staff: number;
}

export interface BeamGroup {
  kind: 'beam';
  x1: number; y1: number;
  x2: number; y2: number;
  beamNumber: number;
}

export interface StaffLines {
  kind: 'staffLines';
  staff: number;
}

export interface DynamicSymbol {
  kind: 'dynamic';
  x: number; y: number;
  value: DynamicValue;
  staff: number;
}

export interface TupletNumber {
  kind: 'tuplet';
  x: number; y: number;
  number: number;
}

export type LayoutSymbol = NoteSymbol | RestSymbol | BeamGroup | StaffLines | DynamicSymbol | TupletNumber;

export interface SlurAnchor { y: number; above: boolean; }

export interface BarLayout {
  symbols: LayoutSymbol[];
  svgWidth: number;
  svgHeight: number;
  prefixWidth: number;
  staffCount: number;
  staffTops: number[];       // y of top staff line for each staff (0-indexed)
  staffMiddleCYs: number[];  // y of middle C on each staff (0-indexed)
  activeClefs: Record<number, Clef>;
  openSlursOut: Map<string, SlurAnchor>; // key = "${staff}-${voice}", unresolved slur starts
}

// ── Pitch → MIDI ──────────────────────────────────────────────────────────────

const STEP_SEMITONE: Record<string, number> = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };

function toMidi(pitch: { step: string; octave: number; alter: number }): number {
  return (pitch.octave + 1) * 12 + STEP_SEMITONE[pitch.step] + pitch.alter;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Round beat position to avoid floating-point drift when accumulating triplets. */


function durationInBeats(type: NoteType, dots: number, timeMod?: { actualNotes: number; normalNotes: number }): number {
  const base: Record<NoteType, number> = {
    whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125,
  };
  let dur = base[type] ?? 1;
  if (dots >= 1) dur *= 1.5;
  if (dots >= 2) dur *= 1.75 / 1.5;
  if (timeMod) dur *= timeMod.normalNotes / timeMod.actualNotes;
  return dur;
}

/** Prefix width used before the note area — mirrors the calculation in layoutBar. */
export function computePrefixWidth(keySig: KeySignature, showTimeSig = true): number {
  return BRACE_WIDTH + CLEF_WIDTH + Math.abs(keySig.fifths) * KEY_SIG_WIDTH_PER_ACC + (showTimeSig ? TIME_SIG_WIDTH : 0) + NOTE_AREA_MARGIN;
}

// ── Beat utility (used by app to build page list) ─────────────────────────────

/** Returns sorted unique beat positions (QN from bar start) across all staffs. */
export function computeBarBeats(bar: Bar): number[] {
  const beatByVoice: Record<string, number> = {};
  const set = new Set<number>();
  for (const ev of bar.events) {
    if (ev.kind === 'dynamic') continue;
    if (ev.kind === 'note' && ev.chord) continue;
    const key = `${ev.staff}-${ev.voice}`;
    if (beatByVoice[key] === undefined) beatByVoice[key] = 0;
    set.add(beatByVoice[key]);
    beatByVoice[key] = beatByVoice[key] + durationInBeats(
      ev.type, ev.dots,
      ev.kind === 'note' ? ev.timeModification : undefined,
    );
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Returns the best beat position at which to split a bar for display.
 * Defaults to barLengthQN/2 but moves the split to avoid cutting through
 * a triplet group (3 consecutive notes with actualNotes=3).
 */
export function computeSplitPoint(bar: Bar, barLengthQN: number): number {
  const idealSplit = barLengthQN / 2;

  const beatByVoice: Record<string, number> = {};
  const runByVoice: Record<string, { start: number; count: number }> = {};
  const groups: { start: number; end: number }[] = [];

  for (const ev of bar.events) {
    if (ev.kind === 'dynamic') continue;
    if (ev.kind === 'note' && ev.chord) continue;
    const key = `${ev.staff}-${ev.voice}`;
    if (beatByVoice[key] === undefined) beatByVoice[key] = 0;
    const beat = beatByVoice[key];
    const dur = durationInBeats(ev.type, ev.dots, ev.kind === 'note' ? ev.timeModification : undefined);
    const isTriplet = ev.kind === 'note' && ev.timeModification?.actualNotes === 3;

    if (isTriplet) {
      if (!runByVoice[key]) {
        runByVoice[key] = { start: beat, count: 1 };
      } else {
        runByVoice[key].count++;
        if (runByVoice[key].count === 3) {
          groups.push({ start: runByVoice[key].start, end: beat + dur });
          delete runByVoice[key];
        }
      }
    } else {
      delete runByVoice[key];
    }

    beatByVoice[key] = beatByVoice[key] + dur;
  }

  for (const g of groups) {
    if (idealSplit > g.start + 0.001 && idealSplit < g.end - 0.001) {
      return (idealSplit - g.start) <= (g.end - idealSplit) ? g.start : g.end;
    }
  }
  return idealSplit;
}

// ── Main layout function ───────────────────────────────────────────────────────

export function layoutBar(
  bar: Bar,
  timeSig: TimeSignature,
  keySig: KeySignature,
  containerWidth: number,
  showClef: boolean,
  staffCount: number,
  activeClefs: Record<number, Clef>,
  pageStartBeat = 0,
  pageEndBeat?: number,
  showTimeSig = true,
  staffOffset = 0,
  compact = false,
  containerHeight = 0,
): BarLayout {

  // ── Vertical layout ──────────────────────────────────────────────────────────
  //
  // Solo layout (top → bottom):
  //   tap-advance (fills space)  ← red zone, flexible
  //   dead zone 40px             ← blue zone, no tap-advance
  //   staff area 120px each      ← 40px pad + 40px lines + 40px pad
  //   dead zone 40px             ← blue zone, no tap-advance
  //   tap-advance (fills space)  ← red zone, flexible
  //
  // 2-player / compact layout (divider → outer edge):
  //   staff area 100px each
  //   dead zone 40px             ← blue zone
  //   tap-advance (fills space)  ← red zone, flexible
  //
  // svgHeight = containerHeight so the viewBox matches the container exactly
  // (no letterboxing, no scale factors, no overflow tricks needed).

  const staffTops: number[] = [];
  const staffMiddleCYs: number[] = [];

  if (compact) {
    // Fixed positions: staves stacked from top, dead zone + tap-advance below.
    // staffTop[i] = i * STAFF_AREA_H + STAFF_AREA_PAD
    for (let i = 0; i < staffCount; i++) {
      const top = i * STAFF_AREA_H + STAFF_AREA_PAD;
      staffTops.push(top);
      const clef = activeClefs[i + 1 + staffOffset] ?? (i === 0 ? { sign: 'G' as ClefSign, line: 2 } : { sign: 'F' as ClefSign, line: 4 });
      staffMiddleCYs.push(middleCYForClef(top, clef.sign, clef.line, clef.octaveChange ?? 0));
    }
  } else {
    // Dynamic: split remaining space equally between top and bottom tap-advance areas.
    const fixedH = DEAD_ZONE_H + staffCount * STAFF_AREA_H + DEAD_ZONE_H; // 80 + 120N
    const h = containerHeight > 0 ? containerHeight : (staffCount === 1 ? 420 : 520);
    const tapH = Math.max(0, Math.floor((h - fixedH) / 2));
    for (let i = 0; i < staffCount; i++) {
      const top = tapH + DEAD_ZONE_H + i * STAFF_AREA_H + STAFF_AREA_PAD;
      staffTops.push(top);
      const clef = activeClefs[i + 1 + staffOffset] ?? (i === 0 ? { sign: 'G' as ClefSign, line: 2 } : { sign: 'F' as ClefSign, line: 4 });
      staffMiddleCYs.push(middleCYForClef(top, clef.sign, clef.line, clef.octaveChange ?? 0));
    }
  }

  const svgHeight = containerHeight > 0 ? containerHeight : (() => {
    // Fallback when no container height is provided (e.g. buildSlurStates pre-pass).
    const fixedH = DEAD_ZONE_H + staffCount * STAFF_AREA_H + DEAD_ZONE_H;
    return compact ? fixedH + staffCount * STAFF_AREA_H : fixedH + 200;
  })();

  function noteY(diatonicFromMiddleC: number, staff: number): number {
    return staffMiddleCYs[staff - 1] - diatonicFromMiddleC * STEP_PX;
  }

  const numAccidentals = Math.abs(keySig.fifths);
  const prefixWidth =
    BRACE_WIDTH +
    (showClef ? CLEF_WIDTH : 0) +
    numAccidentals * KEY_SIG_WIDTH_PER_ACC +
    (showTimeSig ? TIME_SIG_WIDTH : 0) +
    NOTE_AREA_MARGIN;

  const barLengthQN = timeSig.beats * (4 / timeSig.beatType);
  const pageEnd = pageEndBeat ?? barLengthQN;
  const pageDuration = pageEnd - pageStartBeat;

  // Minimum beat spacing — count unique beat positions in this page's range
  const HIT_W_MIN = 14;
  const uniqueBeats = new Set<number>();
  const beatByStaff: Record<number, number> = {};

  for (const ev of bar.events) {
    if (ev.kind === 'dynamic') continue;
    const isChord = ev.kind === 'note' && ev.chord;
    if (isChord) continue;
    if (ev.staff <= staffOffset || ev.staff > staffOffset + staffCount) continue;
    if (beatByStaff[ev.staff] === undefined) beatByStaff[ev.staff] = 0;
    const b = beatByStaff[ev.staff];
    if (b >= pageStartBeat && b < pageEnd) uniqueBeats.add(b);
    beatByStaff[ev.staff] = beatByStaff[ev.staff] + durationInBeats(ev.type, ev.dots, ev.kind === 'note' ? ev.timeModification : undefined);
  }

  const baseNoteAreaWidth = containerWidth - prefixWidth - RIGHT_MARGIN;
  const noteAreaWidth = Math.max(baseNoteAreaWidth, uniqueBeats.size * HIT_W_MIN);
  const svgWidth = prefixWidth + noteAreaWidth + RIGHT_MARGIN;
  const symbols: LayoutSymbol[] = [];

  for (let s = 1; s <= staffCount; s++) {
    symbols.push({ kind: 'staffLines', staff: s });
  }

  // ── Group events by staff, assign beat positions ───────────────────────────

  interface EventWithBeat { event: Event; beatStart: number; }

  function assignBeats(events: Event[], staff: number): EventWithBeat[] {
    const beatByVoice = new Map<string, number>();
    const result: EventWithBeat[] = [];
    for (const ev of events) {
      if (ev.staff !== staff + staffOffset) continue;
      const voice = ev.voice;
      const beat = beatByVoice.get(voice) ?? 0;
      if (ev.kind === 'dynamic') {
        if (beat >= pageStartBeat && beat < pageEnd) result.push({ event: ev, beatStart: beat });
        continue;
      }
      const isChord = ev.kind === 'note' && ev.chord;
      if (!isChord) {
        if (beat >= pageStartBeat && beat < pageEnd) result.push({ event: ev, beatStart: beat });
        beatByVoice.set(voice, beat + durationInBeats(ev.type, ev.dots, ev.kind === 'note' ? ev.timeModification : undefined));
      } else {
        // Chord note: same beat as preceding non-chord note; include iff that note was included
        const prev = result[result.length - 1];
        if (prev) result.push({ event: ev, beatStart: prev.beatStart });
      }
    }
    return result;
  }

  function beatToX(beat: number): number {
    return prefixWidth + ((beat - pageStartBeat) / pageDuration) * noteAreaWidth;
  }

  function getAccidentalGlyph(note: Note): string | null {
    const pos = staffPosition(note.pitch, keySig);
    return pos.displayAccidental ?? null;
  }

  function renderStaffEvents(staff: number) {
    const clef = activeClefs[staff + staffOffset] ?? (staff === 1
      ? { sign: 'G' as ClefSign, line: 2 }
      : { sign: 'F' as ClefSign, line: 4 });
    const octaveChange = clef.octaveChange ?? 0;
    const refDiatonic = (clef.sign === 'G' ? 4 : clef.sign === 'F' ? -4 : 0) + octaveChange * 7;
    const midLineDiatonic = midLineDiatonicForClef(clef.sign, clef.line, octaveChange);
    const bottomLineDiatonic = refDiatonic + 2 * (1 - clef.line);
    const topLineDiatonic = refDiatonic + 2 * (5 - clef.line);

    const stemLength = SPACE * 3.5;
    const eventsWithBeats = assignBeats(bar.events, staff);

    interface RawNote {
      note: Note; x: number; y: number;
      diatonic: number; beatStart: number;
      ledgerLines: number[]; accGlyph: string | null;
    }
    let beamGroup: RawNote[] = [];

    function buildNoteSymbol(raw: RawNote, stemUp: boolean): NoteSymbol {
      const stemX = raw.x + (stemUp ? (raw.note.type === 'whole' ? 8 : 6) : -6);
      const stemY1 = raw.y;
      const stemY2 = stemUp ? raw.y - stemLength : raw.y + stemLength;
      return {
        kind: 'note',
        x: raw.x, y: raw.y,
        noteId: `${staff}-${Math.round(raw.beatStart * 1000)}-${raw.note.pitch.step}${raw.note.pitch.octave}`,
        noteType: raw.note.type,
        dots: raw.note.dots,
        filled: raw.note.type !== 'whole' && raw.note.type !== 'half',
        stemUp,
        stemX, stemY1, stemY2,
        hasFlag: false,
        ledgerLines: raw.ledgerLines,
        accidental: raw.accGlyph,
        staff,
        voice: raw.note.voice,
        midiPitch: toMidi(raw.note.pitch),
        tieStart: raw.note.tieStart,
        tieStop: raw.note.tieStop,
        slurStart: raw.note.slurStart,
        slurStop: raw.note.slurStop,
        staccato: raw.note.staccato,
        accent: raw.note.accent,
        tenuto: raw.note.tenuto,
      };
    }

    function flushBeamGroup() {
      if (beamGroup.length === 0) return;
      const avg = beamGroup.reduce((s, r) => s + r.diatonic, 0) / beamGroup.length;
      const stemUp = avg < midLineDiatonic;

      const syms = beamGroup.map(r => buildNoteSymbol(r, stemUp));
      syms.forEach(s => symbols.push(s));

      if (syms.length >= 2) {
        const first = syms[0], last = syms[syms.length - 1];
        symbols.push({
          kind: 'beam',
          x1: first.stemX, y1: first.stemY2,
          x2: last.stemX, y2: last.stemY2,
          beamNumber: 1,
        });

        const BEAM_SPACING = 6;
        const yOff = (beamGroup[0] && beamGroup[0].diatonic < midLineDiatonic ? 1 : -1) * BEAM_SPACING;

        for (let beamNum = 2; beamNum <= 3; beamNum++) {
          let segStart: number | null = null;
          for (let i = 0; i <= beamGroup.length; i++) {
            const b = i < beamGroup.length
              ? beamGroup[i].note.beams.find(bm => bm.number === beamNum)
              : null;

            if (b && (b.type === 'begin' || b.type === 'continue')) {
              if (segStart === null) segStart = i;
            }

            const isHook = b && (b.type === 'forward hook' || b.type === 'backward hook');
            const segEnds = !b || b.type === 'end' || isHook;

            if (segEnds && segStart !== null) {
              const fSym = syms[segStart];
              const lSym = (b && b.type === 'end') ? syms[i] : syms[i - 1];
              if (fSym && lSym) {
                const beamDX = last.stemX - first.stemX;
                const beamDY = last.stemY2 - first.stemY2;
                const slope = beamDX !== 0 ? beamDY / beamDX : 0;
                const y1sec = first.stemY2 + slope * (fSym.stemX - first.stemX) + yOff * (beamNum - 1);
                const y2sec = first.stemY2 + slope * (lSym.stemX - first.stemX) + yOff * (beamNum - 1);
                symbols.push({ kind: 'beam', x1: fSym.stemX, y1: y1sec, x2: lSym.stemX, y2: y2sec, beamNumber: beamNum });
              }
              segStart = null;
            }

            if (isHook && b) {
              const hookW = syms.length > 1 ? (syms[1].stemX - syms[0].stemX) * 0.45 : 8;
              const hSym = syms[i];
              if (hSym) {
                const beamDX = last.stemX - first.stemX;
                const beamDY = last.stemY2 - first.stemY2;
                const slope = beamDX !== 0 ? beamDY / beamDX : 0;
                const yh = first.stemY2 + slope * (hSym.stemX - first.stemX) + yOff * (beamNum - 1);
                const x1h = b.type === 'backward hook' ? hSym.stemX - hookW : hSym.stemX;
                const x2h = b.type === 'forward hook'  ? hSym.stemX + hookW : hSym.stemX;
                symbols.push({ kind: 'beam', x1: x1h, y1: yh, x2: x2h, y2: yh, beamNumber: beamNum });
              }
              segStart = null;
            }
          }
        }
        // Tuplet number indicator (e.g. "3" for triplets)
        const timeMod = beamGroup[0]?.note.timeModification;
        if (timeMod) {
          const midX = (first.stemX + last.stemX) / 2;
          const beamMidY = (first.stemY2 + last.stemY2) / 2;
          const tupletY = stemUp ? beamMidY - SPACE * 1.5 : beamMidY + SPACE * 1.5;
          symbols.push({ kind: 'tuplet', x: midX, y: tupletY, number: timeMod.actualNotes });
        }
      } else if (syms.length === 1) {
        syms[0].hasFlag = true;
      }

      beamGroup = [];
    }

    function computeLedgerLines(diatonic: number): number[] {
      const lines: number[] = [];
      if (diatonic <= bottomLineDiatonic - 2) {
        for (let d = bottomLineDiatonic - 2; d >= diatonic; d -= 2) lines.push(noteY(d, staff));
      }
      if (diatonic >= topLineDiatonic + 2) {
        for (let d = topLineDiatonic + 2; d <= diatonic; d += 2) lines.push(noteY(d, staff));
      }
      return lines;
    }

    for (const { event, beatStart } of eventsWithBeats) {
      const x = beatToX(beatStart);

      if (event.kind === 'dynamic') {
        flushBeamGroup();
        symbols.push({
          kind: 'dynamic',
          x,
          y: staffTops[staff - 1] + STAFF_HEIGHT + SPACE * 2,
          value: event.value,
          staff,
        });
        continue;
      }

      if (event.kind === 'rest') {
        flushBeamGroup();
        // Whole rest hangs from 4th line from bottom (line 4 = topLineDiatonic - 2 diatonic steps up from it)
        // Use a fixed y relative to the staff top
        const cy = staffTops[staff - 1] + SPACE * 2;
        symbols.push({ kind: 'rest', x, y: cy, noteType: event.type, dots: event.dots, wholeRest: event.whole, staff });
        continue;
      }

      const note = event as Note;
      const pos = staffPosition(note.pitch, keySig);
      const y = noteY(pos.diatonicFromMiddleC, staff);
      const raw: RawNote = {
        note, x, y,
        diatonic: pos.diatonicFromMiddleC,
        beatStart,
        ledgerLines: computeLedgerLines(pos.diatonicFromMiddleC),
        accGlyph: getAccidentalGlyph(note),
      };

      const beam1 = note.beams.find(b => b.number === 1);
      if (beam1) {
        beamGroup.push(raw);
        if (beam1.type === 'end' || beam1.type === 'backward hook') flushBeamGroup();
      } else {
        flushBeamGroup();
        const stemUp = pos.diatonicFromMiddleC < midLineDiatonic;
        const sym = buildNoteSymbol(raw, stemUp);
        if (['eighth', '16th', '32nd'].includes(note.type)) sym.hasFlag = true;
        symbols.push(sym);
      }
    }
    flushBeamGroup();
  }

  for (let s = 1; s <= staffCount; s++) {
    renderStaffEvents(s);
  }

  // Compute which staff+voice combinations have unresolved slur starts at end of page
  const openSlursOut = new Map<string, SlurAnchor>();
  const slurTracker = new Map<string, NoteSymbol>();
  for (const sym of symbols) {
    if (sym.kind !== 'note') continue;
    const key = `${sym.staff}-${sym.voice}`;
    if (sym.slurStop || sym.tieStop) slurTracker.delete(key);
    if (sym.slurStart || sym.tieStart) slurTracker.set(key, sym);
  }
  for (const [key, sym] of slurTracker) {
    openSlursOut.set(key, { y: sym.y, above: !sym.stemUp });
  }

  // Remap activeClefs to local staff indices (1..staffCount)
  const localActiveClefs: Record<number, Clef> = {};
  for (let s = 1; s <= staffCount; s++) {
    const c = activeClefs[s + staffOffset];
    if (c) localActiveClefs[s] = c;
  }

  return {
    symbols,
    svgWidth,
    svgHeight,
    prefixWidth,
    staffCount,
    staffTops,
    staffMiddleCYs,
    activeClefs: localActiveClefs,
    openSlursOut,
  };
}
