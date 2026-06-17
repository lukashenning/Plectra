// Audio router — delegates to the active instrument.

import { sound01NoteOn }                          from './sound01';
import { loadPianoforte, pianoforteNoteOn, pianoforteReady } from './pianoforte';

export { pianoforteReady };

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/**
 * Unlock and start the AudioContext.  Must be called synchronously inside a
 * user-gesture handler (pointerdown / touchstart).
 *
 * Playing a 1-sample silent BufferSource within the gesture is the reliable
 * iOS Safari unlock trick — it forces the audio pipeline open at the system
 * level so that subsequent noteOn calls work immediately.  Calling resume()
 * alone is async and the context may still be 'suspended' when noteOn fires.
 */
export function ensureAudioReady(): void {
  const c = getCtx();
  if (c.state === 'running') return;
  try {
    const buf = c.createBuffer(1, 1, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
    src.stop(0.001);
  } catch { /* ignore — best effort */ }
  c.resume().catch(() => {});
}

export interface NoteHandle {
  stop(): void;
  setVibrato(rateHz: number, depthCents: number): void;
  setGain(value: number): void;
}

export type InstrumentId = 'sound01' | 'pianoforte';

let _instrument: InstrumentId = 'pianoforte';

export function setInstrument(id: InstrumentId): void {
  _instrument = id;
}

/** Start pre-loading Pianoforte samples.  Safe to call before the first user
 *  gesture — decodeAudioData works on a suspended context. */
export function startLoadingPianoforte(): Promise<void> {
  return loadPianoforte(getCtx());
}

export function noteOn(
  midiPitch: number,
  velocity = 0.7,
  held = false,
  touchH = 0,
  isTap = true,
): NoteHandle {
  const c = getCtx();
  if (_instrument === 'pianoforte' && pianoforteReady()) {
    return pianoforteNoteOn(c, midiPitch, touchH, isTap);
  }
  // Fallback to Sound 01 while Pianoforte samples are still loading
  return sound01NoteOn(c, midiPitch, velocity, held);
}
