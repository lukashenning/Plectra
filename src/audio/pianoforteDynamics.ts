// Configurable velocity mapping for the Pianoforte instrument.
// Six anchor touch-heights (CSS px) each have independent MIDI velocity
// settings for tap and for swipe. Values between anchors are interpolated.

// Anchor touch heights in CSS pixels, matching real device-reported values.
export const ANCHOR_PX = [25, 50, 75, 101, 126, 151] as const;
export type AnchorIndex = 0 | 1 | 2 | 3 | 4 | 5;

export interface PianoforteDynamics {
  tap:   [number, number, number, number, number, number]; // MIDI vel 0–100 at each anchor
  swipe: [number, number, number, number, number, number];
}

export const DEFAULT_DYNAMICS: PianoforteDynamics = {
  tap:   [60, 70, 80, 90, 95, 100],
  swipe: [50, 60, 70, 80, 90, 100],
};

let _dynamics: PianoforteDynamics = {
  tap:   [...DEFAULT_DYNAMICS.tap],
  swipe: [...DEFAULT_DYNAMICS.swipe],
};

export function getPianoforteDynamics(): PianoforteDynamics {
  return { tap: [..._dynamics.tap], swipe: [..._dynamics.swipe] };
}

export function setPianoforteDynamics(d: PianoforteDynamics): void {
  _dynamics = { tap: [...d.tap], swipe: [...d.swipe] };
}

export function computeMidiVelocity(touchH: number, isTap: boolean): number {
  const vels = isTap ? _dynamics.tap : _dynamics.swipe;
  if (touchH <= ANCHOR_PX[0]) return Math.max(1, vels[0]);
  if (touchH >= ANCHOR_PX[ANCHOR_PX.length - 1]) return Math.max(1, vels[vels.length - 1]);
  for (let i = 0; i < ANCHOR_PX.length - 1; i++) {
    if (touchH <= ANCHOR_PX[i + 1]) {
      const t = (touchH - ANCHOR_PX[i]) / (ANCHOR_PX[i + 1] - ANCHOR_PX[i]);
      return Math.max(1, Math.round(vels[i] + (vels[i + 1] - vels[i]) * t));
    }
  }
  return Math.max(1, vels[vels.length - 1]);
}
