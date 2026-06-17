// Configurable gain mapping for the Sound 01 instrument.
// Six anchor touch-heights (CSS px) each have independent gain settings
// for tap and for swipe. Values between anchors are interpolated.
// Gain is stored 0–100 in the UI and converted to 0.0–1.0 internally.

export const ANCHOR_PX = [25, 50, 75, 101, 126, 151] as const;

export interface Sound01Dynamics {
  tap:   [number, number, number, number, number, number]; // 0–100
  swipe: [number, number, number, number, number, number];
}

export const DEFAULT_DYNAMICS: Sound01Dynamics = {
  tap:   [44, 62, 69, 81, 87, 100],
  swipe: [37, 51, 66, 79, 92, 100],
};

let _dynamics: Sound01Dynamics = {
  tap:   [...DEFAULT_DYNAMICS.tap],
  swipe: [...DEFAULT_DYNAMICS.swipe],
};

export function getSound01Dynamics(): Sound01Dynamics {
  return { tap: [..._dynamics.tap], swipe: [..._dynamics.swipe] };
}

export function setSound01Dynamics(d: Sound01Dynamics): void {
  _dynamics = { tap: [...d.tap], swipe: [...d.swipe] };
}

export function computeGain(touchH: number, isTap: boolean): number {
  const vals = isTap ? _dynamics.tap : _dynamics.swipe;
  if (touchH <= ANCHOR_PX[0]) return vals[0] / 100;
  if (touchH >= ANCHOR_PX[ANCHOR_PX.length - 1]) return vals[vals.length - 1] / 100;
  for (let i = 0; i < ANCHOR_PX.length - 1; i++) {
    if (touchH <= ANCHOR_PX[i + 1]) {
      const t = (touchH - ANCHOR_PX[i]) / (ANCHOR_PX[i + 1] - ANCHOR_PX[i]);
      return (vals[i] + (vals[i + 1] - vals[i]) * t) / 100;
    }
  }
  return vals[vals.length - 1] / 100;
}
