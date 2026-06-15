// Polyphonic synthesizer — triangle wave, two note modes.

let ctx: AudioContext | null = null;

function getContext(): AudioContext {
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
  const c = getContext();
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
  /** Smoothly update vibrato. rateHz=0 or depthCents=0 means no vibrato. */
  setVibrato(rateHz: number, depthCents: number): void;
  /**
   * Retroactively correct the peak gain — used when a note was started on
   * pointerdown with height=0, then the first pointermove delivers the real
   * contact area.  Cancels current automation, ramps to the new value over
   * ATTACK, then re-schedules the decay for non-held notes.
   */
  setGain(value: number): void;
}

const MIDI_FREQ = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

const ATTACK  = 0.008;
const DECAY   = 2.5;   // natural fade-to-silence for single taps
const RELEASE = 0.08;

/**
 * @param held  If true the note sustains at ~70% until stop() is called
 *              (used for arpeggio/chord bags).
 *              If false the note decays to silence over DECAY seconds on its own
 *              (used for single taps and legato slides).
 */
export function noteOn(midiPitch: number, velocity = 0.7, held = false): NoteHandle {
  const c   = getContext();
  const t0  = c.currentTime;
  const freq = MIDI_FREQ(midiPitch);

  const osc = c.createOscillator();
  osc.type  = 'triangle';
  osc.frequency.value = freq;

  const gain = c.createGain();

  if (held) {
    // Sustaining mode: attack → brief initial bloom decay → hold until stop()
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(velocity, t0 + ATTACK);
    gain.gain.exponentialRampToValueAtTime(velocity * 0.70, t0 + ATTACK + 0.12);
  } else {
    // Decaying mode: attack → smooth exponential fade to silence
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(velocity, t0 + ATTACK);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + ATTACK + DECAY);
  }

  // ── Vibrato LFO ─────────────────────────────────────────────────────────
  // A sine LFO modulates osc.detune (in cents). Gain starts at 0 (no
  // vibrato); setVibrato() smoothly ramps both rate and depth.
  const lfo     = c.createOscillator();
  const lfoGain = c.createGain();
  lfo.type            = 'sine';
  lfo.frequency.value = 5;   // Hz — updated by setVibrato
  lfoGain.gain.value  = 0;   // cents — updated by setVibrato
  lfo.connect(lfoGain);
  lfoGain.connect(osc.detune);
  lfo.start(t0);

  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t0);
  // schedule stop AFTER start (Web Audio requirement)
  if (held) {
    osc.stop(t0 + 120); // safety ceiling — normally stopped via stop()
  } else {
    osc.stop(t0 + ATTACK + DECAY + 0.05);
  }

  return {
    stop() {
      const t = c.currentTime;
      // cancelAndHoldAtTime holds the exact instantaneous gain value before
      // cancelling future automation, preventing the discontinuity (pop) that
      // cancelScheduledValues can cause.  Linear ramp to exact 0 is cleaner
      // than exponential-to-near-zero (no residual click at the very tail).
      if (typeof gain.gain.cancelAndHoldAtTime === 'function') {
        gain.gain.cancelAndHoldAtTime(t);
      } else {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
      }
      gain.gain.linearRampToValueAtTime(0, t + RELEASE);
      osc.stop(t + RELEASE + 0.005);
      lfo.stop(t + RELEASE + 0.005);
    },
    setVibrato(rateHz: number, depthCents: number): void {
      const now = c.currentTime;
      const TC  = 0.06; // 60 ms time-constant → smooth but responsive
      lfo.frequency.setTargetAtTime(Math.max(0.5, rateHz), now, TC);
      lfoGain.gain.setTargetAtTime(depthCents, now, TC);
    },
    setGain(value: number): void {
      const t = c.currentTime;
      if (typeof gain.gain.cancelAndHoldAtTime === 'function') {
        gain.gain.cancelAndHoldAtTime(t);
      } else {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
      }
      gain.gain.linearRampToValueAtTime(value, t + ATTACK);
      if (!held) {
        // Re-schedule the decay from the new peak; the osc.stop already set
        // at start time is still valid — it fires at the same absolute time.
        gain.gain.exponentialRampToValueAtTime(0.001, t + ATTACK + DECAY);
      }
    },
  };
}
