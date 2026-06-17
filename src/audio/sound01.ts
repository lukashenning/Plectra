// "Sound 01" — triangle-wave oscillator with vibrato LFO.

const MIDI_FREQ = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

const ATTACK  = 0.008;
const DECAY   = 2.5;
const RELEASE = 0.08;

export interface Sound01Handle {
  stop(): void;
  setVibrato(rateHz: number, depthCents: number): void;
  setGain(value: number): void;
}

export function sound01NoteOn(c: AudioContext, midiPitch: number, velocity = 0.7, held = false): Sound01Handle {
  const t0   = c.currentTime;
  const freq = MIDI_FREQ(midiPitch);

  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;

  const gain = c.createGain();
  gain.gain.setValueAtTime(0.001, t0);
  gain.gain.linearRampToValueAtTime(velocity, t0 + ATTACK);
  if (held) {
    gain.gain.exponentialRampToValueAtTime(velocity * 0.70, t0 + ATTACK + 0.12);
  } else {
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + ATTACK + DECAY);
  }

  const lfo     = c.createOscillator();
  const lfoGain = c.createGain();
  lfo.type            = 'sine';
  lfo.frequency.value = 5;
  lfoGain.gain.value  = 0;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.detune);
  lfo.start(t0);

  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t0);
  osc.stop(held ? t0 + 120 : t0 + ATTACK + DECAY + 0.05);

  return {
    stop() {
      const t = c.currentTime;
      if (typeof gain.gain.cancelAndHoldAtTime === 'function') {
        gain.gain.cancelAndHoldAtTime(t);
      } else {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
      }
      gain.gain.linearRampToValueAtTime(0, t + RELEASE);
      try { osc.stop(t + RELEASE + 0.005); } catch {}
      try { lfo.stop(t + RELEASE + 0.005); } catch {}
    },
    setVibrato(rateHz: number, depthCents: number) {
      const now = c.currentTime;
      const TC  = 0.06;
      lfo.frequency.setTargetAtTime(Math.max(0.5, rateHz), now, TC);
      lfoGain.gain.setTargetAtTime(depthCents, now, TC);
    },
    setGain(value: number) {
      const t = c.currentTime;
      if (typeof gain.gain.cancelAndHoldAtTime === 'function') {
        gain.gain.cancelAndHoldAtTime(t);
      } else {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
      }
      gain.gain.linearRampToValueAtTime(value, t + ATTACK);
      if (!held) {
        gain.gain.exponentialRampToValueAtTime(0.001, t + ATTACK + DECAY);
      }
    },
  };
}
