// ── Pitch ────────────────────────────────────────────────────────────────────

export type Accidental = 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'flat-flat';

export interface Pitch {
  step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
  octave: number;
  alter: number; // semitones: -1 flat, 0 natural, 1 sharp
  accidental?: Accidental; // display accidental (only when explicitly marked)
}

// ── Rhythm ───────────────────────────────────────────────────────────────────

export type NoteType =
  | 'whole' | 'half' | 'quarter' | 'eighth' | '16th' | '32nd';

export interface Beam {
  number: number;
  type: 'begin' | 'continue' | 'end' | 'forward hook' | 'backward hook';
}

// ── Clef ─────────────────────────────────────────────────────────────────────

export type ClefSign = 'G' | 'F' | 'C';

export interface Clef {
  sign: ClefSign;
  line: number; // staff line the clef reference note sits on (1=bottom, 5=top)
  octaveChange?: number; // e.g. -1 for 8vb treble clef, +1 for 8va bass clef
}

// ── Dynamics ─────────────────────────────────────────────────────────────────

export type DynamicValue = 'ppp' | 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff' | 'fff' | 'sfz' | 'sf' | 'fp' | 'fz';

// ── Notes & Rests ────────────────────────────────────────────────────────────

export interface Note {
  kind: 'note';
  pitch: Pitch;
  type: NoteType;
  dots: number;
  timeModification?: { actualNotes: number; normalNotes: number }; // for triplets etc.
  beams: Beam[];
  tieStart: boolean;
  tieStop: boolean;
  slurStart: boolean;
  slurStop: boolean;
  chord: boolean; // this note sounds simultaneously with the previous
  staff: number;
  voice: string;
  staccato: boolean;
  accent: boolean;
  tenuto: boolean;
}

export interface Rest {
  kind: 'rest';
  type: NoteType;
  dots: number;
  staff: number;
  voice: string;
  whole: boolean; // whole-measure rest
}

export interface Dynamic {
  kind: 'dynamic';
  value: DynamicValue;
  staff: number;
  voice: string;
}

export type Event = Note | Rest | Dynamic;

// ── Bar ──────────────────────────────────────────────────────────────────────

export interface TimeSignature {
  beats: number;
  beatType: number;
}

export interface KeySignature {
  fifths: number; // negative = flats, positive = sharps
  mode: 'major' | 'minor';
}

export interface Bar {
  number: number;
  timeSig?: TimeSignature;  // present when it changes (or on bar 1)
  keySig?: KeySignature;
  clefs?: Record<number, Clef>; // per-staff clef changes in this bar
  events: Event[];
}

// ── Score ────────────────────────────────────────────────────────────────────

export interface Score {
  title: string;
  composer: string;
  bars: Bar[];
  initialTimeSig: TimeSignature;
  initialKeySig: KeySignature;
  initialClefs: Record<number, Clef>;
  staffCount: number;
}
