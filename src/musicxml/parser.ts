import type {
  Score, Bar, Event, Note, Rest, Dynamic,
  Pitch, NoteType, Beam, Accidental, ClefSign, Clef, DynamicValue,
  TimeSignature, KeySignature,
} from '../types';

function getText(el: Element, tag: string): string {
  return el.querySelector(tag)?.textContent?.trim() ?? '';
}

function parseAccidental(text: string): Accidental | undefined {
  const map: Record<string, Accidental> = {
    sharp: 'sharp', flat: 'flat', natural: 'natural',
    'double-sharp': 'double-sharp', 'flat-flat': 'flat-flat',
  };
  return map[text] ?? undefined;
}

function parseNoteType(text: string): NoteType {
  const valid: NoteType[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];
  return valid.includes(text as NoteType) ? (text as NoteType) : 'quarter';
}

function parseNote(el: Element, staff1Default: boolean): Note | Rest | null {
  const isRest = el.querySelector('rest') !== null;
  const staffNum = parseInt(getText(el, 'staff') || (staff1Default ? '1' : '2'), 10);
  const voice = getText(el, 'voice') || '1';
  const typeText = getText(el, 'type');
  const type = parseNoteType(typeText);
  const dots = el.querySelectorAll('dot').length;

  const timeMod = el.querySelector('time-modification');
  const timeModification = timeMod
    ? {
        actualNotes: parseInt(getText(timeMod, 'actual-notes'), 10),
        normalNotes: parseInt(getText(timeMod, 'normal-notes'), 10),
      }
    : undefined;

  const beams: Beam[] = [];
  el.querySelectorAll('beam').forEach(b => {
    const num = parseInt(b.getAttribute('number') ?? '1', 10);
    beams.push({ number: num, type: b.textContent?.trim() as Beam['type'] });
  });

  if (isRest) {
    const wholeAttr = el.querySelector('rest')?.getAttribute('measure') === 'yes';
    const rest: Rest = { kind: 'rest', type, dots, staff: staffNum, voice, whole: wholeAttr };
    return rest;
  }

  const pitchEl = el.querySelector('pitch');
  if (!pitchEl) return null;

  const step = getText(pitchEl, 'step') as Pitch['step'];
  const octave = parseInt(getText(pitchEl, 'octave'), 10);
  const alter = parseFloat(getText(pitchEl, 'alter') || '0');
  const accText = getText(el, 'accidental');
  const accidental = parseAccidental(accText);

  const tieStart = Array.from(el.querySelectorAll('tie')).some(t => t.getAttribute('type') === 'start');
  const tieStop = Array.from(el.querySelectorAll('tie')).some(t => t.getAttribute('type') === 'stop');
  const slurStart = Array.from(el.querySelectorAll('slur')).some(s => s.getAttribute('type') === 'start');
  const slurStop = Array.from(el.querySelectorAll('slur')).some(s => s.getAttribute('type') === 'stop');
  const chord = el.querySelector('chord') !== null;

  const artEl = el.querySelector('notations articulations');
  const staccato = artEl != null && artEl.querySelector('staccato') !== null;
  const accent   = artEl != null && artEl.querySelector('accent') !== null;
  const tenuto   = artEl != null && artEl.querySelector('tenuto') !== null;

  const note: Note = {
    kind: 'note',
    pitch: { step, octave, alter, accidental },
    type, dots, timeModification, beams,
    tieStart, tieStop, slurStart, slurStop, chord,
    staff: staffNum, voice,
    staccato, accent, tenuto,
  };
  return note;
}

const DYN_VALUES: DynamicValue[] = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz', 'sf', 'fp', 'fz'];

function parseMeasure(el: Element, measureNum: number): Bar {
  let timeSig: TimeSignature | undefined;
  let keySig: KeySignature | undefined;
  const barClefs: Record<number, Clef> = {};
  const events: Event[] = [];

  for (const child of Array.from(el.children)) {
    switch (child.tagName) {
      case 'attributes': {
        const timeEl = child.querySelector('time');
        if (timeEl) {
          timeSig = {
            beats: parseInt(getText(timeEl, 'beats'), 10),
            beatType: parseInt(getText(timeEl, 'beat-type'), 10),
          };
        }
        const keyEl = child.querySelector('key');
        if (keyEl) {
          keySig = {
            fifths: parseInt(getText(keyEl, 'fifths'), 10),
            mode: (getText(keyEl, 'mode') as 'major' | 'minor') || 'major',
          };
        }
        child.querySelectorAll('clef').forEach(clefEl => {
          const staffNum = parseInt(clefEl.getAttribute('number') ?? '1', 10);
          const sign = (getText(clefEl, 'sign') || 'G') as ClefSign;
          const defaultLine = sign === 'F' ? 4 : sign === 'C' ? 3 : 2;
          const line = parseInt(getText(clefEl, 'line') || String(defaultLine), 10);
          if (['G', 'F', 'C'].includes(sign)) {
            const octaveChangeText = getText(clefEl, 'clef-octave-change');
            const octaveChange = octaveChangeText ? parseInt(octaveChangeText, 10) : undefined;
            barClefs[staffNum] = { sign, line, ...(octaveChange !== undefined && { octaveChange }) };
          }
        });
        break;
      }
      case 'note': {
        if (child.querySelector('grace')) break;
        const event = parseNote(child, true);
        if (event) events.push(event);
        break;
      }
      case 'direction': {
        const dynamicsEl = child.querySelector('dynamics');
        if (dynamicsEl) {
          const staffNum = parseInt(getText(child, 'staff') || '1', 10);
          const voice = getText(child, 'voice') || '1';
          for (const dv of DYN_VALUES) {
            if (dynamicsEl.querySelector(dv)) {
              const dyn: Dynamic = { kind: 'dynamic', value: dv, staff: staffNum, voice };
              events.push(dyn);
              break;
            }
          }
        }
        break;
      }
    }
  }

  return {
    number: measureNum,
    timeSig,
    keySig,
    clefs: Object.keys(barClefs).length > 0 ? barClefs : undefined,
    events,
  };
}

export function parseMusicXML(xmlText: string): Score {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Invalid MusicXML: ' + parseError.textContent);

  const titleEl = doc.querySelector('work-title') ?? doc.querySelector('movement-title');
  const title = titleEl?.textContent?.trim() ?? 'Untitled';
  const composerEl = doc.querySelector('creator[type="composer"]') ?? doc.querySelector('creator');
  const composer = composerEl?.textContent?.trim() ?? '';

  let currentTime: TimeSignature = { beats: 4, beatType: 4 };
  let currentKey: KeySignature = { fifths: 0, mode: 'major' };

  const barMap = new Map<number, Bar>();

  // First pass: determine how many staves each part contributes so we can
  // assign globally-unique staff numbers when merging multi-part scores.
  const partStaveCounts: number[] = [];
  doc.querySelectorAll('part').forEach(part => {
    const stavesEl = part.querySelector('measure attributes staves');
    const n = stavesEl ? parseInt(stavesEl.textContent?.trim() ?? '1', 10) : 1;
    // Also check max staff number used in notes within this part
    let maxStaff = n;
    part.querySelectorAll('note staff').forEach(s => {
      const v = parseInt(s.textContent?.trim() ?? '1', 10);
      if (v > maxStaff) maxStaff = v;
    });
    partStaveCounts.push(maxStaff);
  });

  // Compute global staff offset for each part (0-indexed part → staff base offset)
  const partStaveOffsets: number[] = [];
  let runningOffset = 0;
  for (const count of partStaveCounts) {
    partStaveOffsets.push(runningOffset);
    runningOffset += count;
  }
  const totalStaffCount = runningOffset;

  let partIndex = 0;
  doc.querySelectorAll('part').forEach(part => {
    let localTime = currentTime;
    let localKey = currentKey;
    const offset = partStaveOffsets[partIndex];

    part.querySelectorAll('measure').forEach(measureEl => {
      const num = parseInt(measureEl.getAttribute('number') ?? '1', 10);
      const bar = parseMeasure(measureEl, num);

      if (bar.timeSig) localTime = bar.timeSig;
      if (bar.keySig) localKey = bar.keySig;

      // Remap staff numbers to global space
      if (offset > 0) {
        for (const ev of bar.events) ev.staff += offset;
        if (bar.clefs) {
          const remapped: Record<number, Clef> = {};
          for (const [sStr, clef] of Object.entries(bar.clefs)) {
            remapped[parseInt(sStr) + offset] = clef;
          }
          bar.clefs = remapped;
        }
      }

      if (barMap.has(num)) {
        barMap.get(num)!.events.push(...bar.events);
        if (bar.clefs) {
          const existing = barMap.get(num)!;
          existing.clefs = { ...existing.clefs, ...bar.clefs };
        }
      } else {
        barMap.set(num, bar);
      }
    });

    currentTime = localTime;
    currentKey = localKey;
    partIndex++;
  });

  const bars = Array.from(barMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, bar]) => bar);

  let staffCount = totalStaffCount;

  // Build initial clefs from first occurrence across all bars
  const initialClefs: Record<number, Clef> = {};
  for (const bar of bars) {
    if (bar.clefs) {
      for (const [sStr, clef] of Object.entries(bar.clefs)) {
        const s = parseInt(sStr);
        if (!initialClefs[s]) initialClefs[s] = clef;
      }
    }
    if (Object.keys(initialClefs).length >= staffCount) break;
  }
  // Fill defaults for any staff without an explicit clef
  for (let s = 1; s <= staffCount; s++) {
    if (!initialClefs[s]) {
      initialClefs[s] = s === 1
        ? { sign: 'G', line: 2 }
        : { sign: 'F', line: 4 };
    }
  }

  const initialTimeSig = bars[0]?.timeSig ?? { beats: 4, beatType: 4 };
  const initialKeySig = bars[0]?.keySig ?? { fifths: 0, mode: 'major' };

  return { title, composer, bars, initialTimeSig, initialKeySig, initialClefs, staffCount };
}
