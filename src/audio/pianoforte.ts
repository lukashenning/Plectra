// "Pianoforte" — Steinway grand piano via smplr's SplendidGrandPiano.
// smplr handles sample loading, pitch shifting, velocity layers, and envelopes.

import { SplendidGrandPiano } from 'smplr';
import { computeMidiVelocity } from './pianoforteDynamics';

let _piano: SplendidGrandPiano | null = null;
let _ready = false;
let _loadPromise: Promise<void> | null = null;
let _voiceCounter = 0;

// Chain: smplr → high-shelf filter → limiter → output gain → destination.
// The limiter clamps transient peaks before they can overdrive phone speakers.
let _chainInput: BiquadFilterNode | null = null;

function getDestination(ctx: AudioContext): AudioNode {
  if (_chainInput) return _chainInput;

  // Output gain: keeps the overall level comfortably below the speaker ceiling
  // so even at high phone volume the samples don't cause hardware distortion.
  const outGain = ctx.createGain();
  outGain.gain.value = 0.75;
  outGain.connect(ctx.destination);

  // Hard limiter: 20:1 ratio, 1 ms attack, −3 dBFS threshold.
  // Catches hammer-transient peaks that slip past the attack window.
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -3;
  lim.knee.value      = 0;
  lim.ratio.value     = 20;
  lim.attack.value    = 0.001;
  lim.release.value   = 0.1;
  lim.connect(outGain);

  // High-shelf cut: tames the harsh upper-frequency brightness of the samples.
  const f = ctx.createBiquadFilter();
  f.type = 'highshelf';
  f.frequency.value = 5000;
  f.gain.value = -7;
  f.connect(lim);

  _chainInput = f;
  return f;
}

export function loadPianoforte(ctx: AudioContext): Promise<void> {
  if (_loadPromise) return _loadPromise;
  const inst = new SplendidGrandPiano(ctx, {
    destination: getDestination(ctx) as AudioNode,
    // decayTime = ampRelease: how long the note fades after stop() is called.
    // Short value = quick dampening + less perceived reverb tail on release.
    decayTime: 0.1,
  });
  _loadPromise = inst.load.then(() => {
    _piano = inst;
    _ready = true;
  });
  return _loadPromise;
}

export function pianoforteReady(): boolean {
  return _ready;
}

export interface PianoforteHandle {
  stop(): void;
  setVibrato(rateHz: number, depthCents: number): void;
  setGain(value: number): void;
}

export function pianoforteNoteOn(
  _c: AudioContext,
  midiPitch: number,
  touchH: number,
  isTap: boolean,
): PianoforteHandle {
  const piano = _piano!;
  const midiVelocity = computeMidiVelocity(touchH, isTap);
  const stopFn = piano.start({ note: midiPitch, velocity: midiVelocity, stopId: `${midiPitch}-${++_voiceCounter}` });
  let stopped = false;

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      stopFn();
    },
    // Piano pitch is fixed at hammer-strike — vibrato is a no-op.
    setVibrato(_rateHz: number, _depthCents: number) { /* intentional no-op */ },
    // smplr does not expose per-voice gain after start.
    setGain(_value: number) { /* intentional no-op */ },
  };
}
