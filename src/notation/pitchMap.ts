import type { Pitch, KeySignature } from '../types';

// Steps in order, used for staff position calculation
const STEP_ORDER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;

// Sharps affect: F C G D A E B (order of sharps)
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;
// Flats affect:  B E A D G C F (order of flats)
const FLAT_ORDER  = ['B', 'E', 'A', 'D', 'G', 'C', 'F'] as const;

export interface StaffPosition {
  // Distance in staff-spaces from middle C (C4).
  // 0 = first ledger line below treble staff (middle C).
  // Positive = up, negative = down.
  // Each step (C→D, D→E, etc.) = 0.5 staff-spaces in our coordinate system,
  // but we store it as "diatonic steps from C4" and convert to pixels in layout.
  diatonicFromMiddleC: number;
  // Which accidental sign to DISPLAY (null = none needed)
  displayAccidental: 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'flat-flat' | null;
}

/**
 * Returns the set of steps that have key-signature alterations.
 * e.g. for G major (1 sharp): { F: 1 }
 */
export function keyAccidentals(key: KeySignature): Map<string, number> {
  const map = new Map<string, number>();
  if (key.fifths > 0) {
    for (let i = 0; i < key.fifths; i++) map.set(SHARP_ORDER[i], 1);
  } else {
    for (let i = 0; i < -key.fifths; i++) map.set(FLAT_ORDER[i], -1);
  }
  return map;
}

/**
 * Given a pitch and the current key signature, returns the staff position
 * (diatonic steps above C4) and whether an accidental sign should be shown.
 */
export function staffPosition(pitch: Pitch, key: KeySignature): StaffPosition {
  const stepIndex = STEP_ORDER.indexOf(pitch.step as typeof STEP_ORDER[number]);
  // Diatonic steps from C4: each octave is 7 steps
  const diatonicFromMiddleC = (pitch.octave - 4) * 7 + stepIndex;

  const keyAlts = keyAccidentals(key);
  const keyAlt = keyAlts.get(pitch.step) ?? 0; // what key signature implies
  const noteAlt = pitch.alter; // what the note actually is

  let displayAccidental: StaffPosition['displayAccidental'] = null;

  if (pitch.accidental) {
    // MusicXML explicitly marks an accidental — display it
    displayAccidental = pitch.accidental;
  } else if (noteAlt !== keyAlt) {
    // Note deviates from key signature without explicit marking — infer display
    if (noteAlt === 1)        displayAccidental = 'sharp';
    else if (noteAlt === -1)  displayAccidental = 'flat';
    else if (noteAlt === 0)   displayAccidental = 'natural';
    else if (noteAlt === 2)   displayAccidental = 'double-sharp';
    else if (noteAlt === -2)  displayAccidental = 'flat-flat';
  }

  return { diatonicFromMiddleC, displayAccidental };
}
