import type { HitTarget } from '../notation/renderer';
import { noteOn, ensureAudioReady, type NoteHandle } from '../audio/synth';
import { TREBLE_TOP, BASS_TOP, STAFF_HEIGHT } from '../notation/layout';
import { computeGain } from '../audio/sound01Dynamics';

// Current bar's staff tops — updated in attachTouchHandlers.
let currentStaffTops: number[] = [TREBLE_TOP, BASS_TOP];

// ── Constants ─────────────────────────────────────────────────────────────────

const COLOR_ACTIVE      = '#e03030';
const COLOR_DEFAULT     = '#111';
const THUMB_MIN_CSS     = 60;
const STAFF_Y_PAD       = 20;

function nextBarZoneW(): number {
  return window.matchMedia('(orientation: landscape)').matches ? 24 : 12;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface StaffState {
  activeBeat: string | null;
  activeNotes: Map<string, NoteHandle>;
  activeTouchH: number;
  activeNoteCount: number;
  // midiPitches with tieStart at activeBeat — kept sounding when the beat advances
  tiedPitches: Set<number>;
  // noteId → midiPitch for handles carried from a previous bar (stale noteIds not in current targets)
  carriedHandlePitches: Map<string, number>;
}

interface PointerState {
  staffs: Record<number, StaffState>;
  lastX: number; lastY: number;
  triggeredNextBar: boolean;
  wiggle: WiggleTracker;
  isTapAdvance: boolean;
}

interface TransitionEntry {
  staffHandles: Record<number, Map<string, NoteHandle>>;
  lockedBeat: Record<number, string | null>;
  newStaffs: Record<number, StaffState>;
  lastX: number; lastY: number;
  triggeredNextBar: boolean;
  wiggle: WiggleTracker;
}

// ── Wiggle / vibrato tracker ──────────────────────────────────────────────────

const pointerMoveState = new Map<number, { cx: number; cy: number; t: number }>();

function trackAndGetVelocity(pointerId: number, cx: number, cy: number): number {
  const last = pointerMoveState.get(pointerId);
  const now  = performance.now();
  pointerMoveState.set(pointerId, { cx, cy, t: now });
  if (!last) return 0;
  const dt = now - last.t;
  if (dt < 4 || dt > 120) return 0;
  const dx = cx - last.cx, dy = cy - last.cy;
  return Math.sqrt(dx * dx + dy * dy) / dt;
}


// ── Wiggle / vibrato tracker ──────────────────────────────────────────────────

const WIGGLE_WINDOW_MS  = 600;
const WIGGLE_RECENT_MS  = 350;
const WIGGLE_DEAD_PX    = 3;

class WiggleTracker {
  private history: Array<{ t: number; x: number }> = [];
  private lastDir = 0;
  private reversalTimes: number[] = [];

  update(x: number): void {
    const t = performance.now();
    this.history.push({ t, x });
    const cutoff = t - WIGGLE_WINDOW_MS;
    this.history       = this.history.filter(e => e.t >= cutoff);
    this.reversalTimes = this.reversalTimes.filter(rt => rt >= cutoff);

    if (this.history.length >= 2) {
      const prev = this.history[this.history.length - 2];
      const dx   = x - prev.x;
      if (Math.abs(dx) >= 1.5) {
        const dir = dx > 0 ? 1 : -1;
        if (this.lastDir !== 0 && dir !== this.lastDir) {
          this.reversalTimes.push(t);
        }
        this.lastDir = dir;
      }
    }
  }

  getMetrics(): { rateHz: number; depthCents: number } {
    const now = performance.now();
    if (!this.reversalTimes.some(rt => rt > now - WIGGLE_RECENT_MS) ||
        this.history.length < 3) {
      return { rateHz: 0, depthCents: 0 };
    }

    const xs  = this.history.map(e => e.x);
    const amp = (Math.max(...xs) - Math.min(...xs)) / 2;

    let rateHz = 4;
    if (this.reversalTimes.length >= 2) {
      let sum = 0;
      for (let i = 1; i < this.reversalTimes.length; i++) {
        sum += this.reversalTimes[i] - this.reversalTimes[i - 1];
      }
      rateHz = 500 / (sum / (this.reversalTimes.length - 1));
    }

    const depthCents = Math.min(4, Math.max(0, (amp - WIGGLE_DEAD_PX) * 0.25));
    return { rateHz: Math.min(8, Math.max(2, rateHz)), depthCents };
  }

  reset(): void {
    this.history       = [];
    this.lastDir       = 0;
    this.reversalTimes = [];
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

const pointers    = new Map<number, PointerState>();
const transitions = new Map<number, TransitionEntry>();
// Non-tied notes from the last bar advance ring until the next note activates.
const pendingRingOut = new Set<NoteHandle>();

let nextBarCooldownUntil = 0;

// ── Tap-advance state ─────────────────────────────────────────────────────────

// Tracks the most recently activated beat per staff. Used only for tap-advance:
// if a beat was activated within TAP_ADVANCE_WINDOW_MS, advance to the next one;
// otherwise restart from the first beat in the staff.
let staffLastBeat: Record<number, { beat: string; ms: number }> = {};

const TAP_ADVANCE_WINDOW_MS = 1000;

function staffNums(): number[] {
  return Array.from({ length: currentStaffTops.length }, (_, i) => i + 1);
}

function makeStaffState(): StaffState {
  return { activeBeat: null, activeNotes: new Map(), activeTouchH: 0, activeNoteCount: 0, tiedPitches: new Set(), carriedHandlePitches: new Map() };
}

// Returns pitches with tieStart at the given beat — kept sounding when advancing to the next beat.
function tiedPitchesFromBeat(targets: HitTarget[], beatPrefix: string | null): Set<number> {
  if (!beatPrefix) return new Set();
  const s = new Set<number>();
  for (const t of targets) {
    if (getBeatPrefix(t.noteId) === beatPrefix && t.tieStart) s.add(t.midiPitch);
  }
  return s;
}

function makePointerState(x: number, y: number, isTapAdvance = false): PointerState {
  const staffs: Record<number, StaffState> = {};
  for (const s of staffNums()) staffs[s] = makeStaffState();
  return { staffs, lastX: x, lastY: y, triggeredNextBar: false, wiggle: new WiggleTracker(), isTapAdvance };
}

// ── Bar-transition capture ────────────────────────────────────────────────────

export function captureForTransition(currentTargets: HitTarget[] = []): number[] {
  const next = new Map<number, TransitionEntry>();
  const ids: number[] = [];

  for (const [id, st] of pointers.entries()) {
    const staffHandles: Record<number, Map<string, NoteHandle>> = {};
    const lockedBeat: Record<number, string | null> = {};
    const newStaffs: Record<number, StaffState> = {};
    for (const s of staffNums()) {
      staffHandles[s] = new Map();
      lockedBeat[s] = st.staffs[s]?.activeBeat ?? null;
      newStaffs[s] = makeStaffState();
      const tp = st.staffs[s]?.tiedPitches;
      if (tp?.size) {
        newStaffs[s].tiedPitches = new Set(tp);
      }
      // Separate tied-forward handles from ring-out handles.
      // Tied handles go into newStaffs so the selective stop keeps them sounding;
      // everything else goes into staffHandles to ring out normally.
      for (const [noteId, handle] of (st.staffs[s]?.activeNotes ?? new Map())) {
        const t = currentTargets.find((t2: HitTarget) => t2.noteId === noteId);
        if (t && tp?.has(t.midiPitch)) {
          newStaffs[s].activeNotes.set(noteId, handle);
          newStaffs[s].carriedHandlePitches.set(noteId, t.midiPitch);
        } else {
          staffHandles[s].set(noteId, handle);
          pendingRingOut.add(handle); // ring until next note activates
        }
      }
    }
    next.set(id, {
      staffHandles, lockedBeat, newStaffs,
      lastX: st.lastX, lastY: st.lastY,
      triggeredNextBar: st.triggeredNextBar,
      wiggle: st.wiggle,
    });
    ids.push(id);
  }
  pointers.clear();

  for (const [id, tr] of transitions.entries()) {
    const merged: Record<number, Map<string, NoteHandle>> = {};
    const lockedBeat: Record<number, string | null> = {};
    const newStaffs: Record<number, StaffState> = {};
    for (const s of staffNums()) {
      merged[s] = new Map();
      tr.staffHandles[s]?.forEach((h, nid) => merged[s].set(nid, h));
      // Only merge non-carried active notes; carry tied handles forward again.
      const prevCarried = tr.newStaffs[s]?.carriedHandlePitches ?? new Map();
      const prevTp = tr.newStaffs[s]?.tiedPitches ?? new Set();
      tr.newStaffs[s]?.activeNotes.forEach((h, nid) => {
        if (prevCarried.has(nid)) return; // handled below
        merged[s].set(nid, h);
      });
      lockedBeat[s] = tr.newStaffs[s]?.activeBeat ?? null;
      newStaffs[s] = makeStaffState();
      const tp = prevTp.size ? prevTp : undefined;
      if (tp?.size) {
        newStaffs[s].tiedPitches = new Set(tp);
      }
      // Re-carry tied handles into the next bar's newStaffs
      for (const [noteId, handle] of (tr.newStaffs[s]?.activeNotes ?? new Map())) {
        if (!prevCarried.has(noteId)) continue;
        const midiPitch = prevCarried.get(noteId)!;
        newStaffs[s].activeNotes.set(noteId, handle);
        newStaffs[s].carriedHandlePitches.set(noteId, midiPitch);
      }
    }
    next.set(id, {
      staffHandles: merged, lockedBeat, newStaffs,
      lastX: tr.lastX, lastY: tr.lastY,
      triggeredNextBar: tr.triggeredNextBar,
      wiggle: tr.wiggle,
    });
    if (!ids.includes(id)) ids.push(id);
  }
  transitions.clear();

  for (const [id, entry] of next) transitions.set(id, entry);
  return ids;
}

export function getActivePointerIds(): number[] { return [...pointers.keys()]; }

// ── Coordinate helpers ────────────────────────────────────────────────────────

interface Scale { sx: number; sy: number; rect: DOMRect; oX: number; oY: number; }

function svgScale(svg: SVGSVGElement): Scale {
  const rect = svg.getBoundingClientRect();
  const vb   = svg.viewBox.baseVal;
  const ea = rect.width / rect.height, va = vb.width / vb.height;
  let cW: number, cH: number, oX: number, oY: number;
  if (ea > va) { cH = rect.height; cW = rect.height * va; oX = (rect.width - cW) / 2; oY = 0; }
  else         { cW = rect.width;  cH = rect.width  / va; oX = 0; oY = (rect.height - cH) / 2; }
  return { sx: vb.width / cW, sy: vb.height / cH, rect, oX, oY };
}

function clientToSVG(e: { clientX: number; clientY: number }, sc: Scale) {
  return {
    x: (e.clientX - sc.rect.left - sc.oX) * sc.sx,
    y: (e.clientY - sc.rect.top  - sc.oY) * sc.sy,
  };
}

function touchHalfH(e: PointerEvent, sc: Scale): number {
  const cssH = e.height ?? 0;
  if (cssH < THUMB_MIN_CSS) return 0;
  return (cssH / 2) * sc.sy;
}

// ── Staff / beat helpers ──────────────────────────────────────────────────────

function getBeatPrefix(noteId: string): string {
  const i1 = noteId.indexOf('-');
  const i2 = noteId.indexOf('-', i1 + 1);
  return noteId.slice(0, i2);
}

// Returns the y-range of the 5 staff lines (top line to bottom line) plus padding.
// This is the primary gate for whether a touch is "on a staff" — leger-line notes
// outside this range are still reachable, but only when the touch actually overlaps
// their bounding box (checked separately in updateStaff / updateTransition).
// Gate range: top staff line (- small top pad) to bottom staff line (no bottom pad).
// Touches below the bottom line are only accepted when they overlap a note's own
// hit box at the found beat — handled by touchInBeatYRange.
function staffLineYRange(staff: number): [number, number] | null {
  const staffTop = currentStaffTops[staff - 1];
  if (staffTop === undefined) return null;
  return [staffTop - STAFF_Y_PAD, staffTop + STAFF_HEIGHT];
}

// Returns true if touchY falls within the note hit box (HIT_H = 30, centered on note head)
// at beatPrefix. No extra padding — the 30px box is the zone.
function touchInBeatYRange(targets: HitTarget[], beatPrefix: string, touchY: number): boolean {
  for (const t of targets) {
    if (getBeatPrefix(t.noteId) !== beatPrefix) continue;
    if (touchY >= t.y && touchY <= t.y + t.h) return true;
  }
  return false;
}

interface BeatResult { beatPrefix: string; closestNote: HitTarget; }

function findBestBeat(
  targets: HitTarget[], staff: number,
  touchX: number, touchY: number,
  halfH: number,
  prevTouchX?: number,
): BeatResult | null {
  const p = staff + '-';

  if (halfH > 0) {
    const beatCenterX = new Map<string, number>();
    const beatHitboxX = new Map<string, { lo: number; hi: number }>();
    for (const t of targets) {
      if (!t.noteId.startsWith(p)) continue;
      const bp = getBeatPrefix(t.noteId);
      if (!beatCenterX.has(bp)) {
        beatCenterX.set(bp, t.x + t.w / 2);
        beatHitboxX.set(bp, { lo: t.x, hi: t.x + t.w });
      }
    }
    let closestBeat = '';
    let closestXDist = Infinity;
    for (const [bp, cx] of beatCenterX) {
      const hbx = beatHitboxX.get(bp)!;
      if (touchX + halfH < hbx.lo || touchX - halfH > hbx.hi) continue;
      const d = Math.abs(cx - touchX);
      if (d < closestXDist) { closestXDist = d; closestBeat = bp; }
    }
    if (!closestBeat) return null;
    let bestNote: HitTarget | null = null, bestYDist = Infinity;
    for (const t of targets) {
      if (getBeatPrefix(t.noteId) !== closestBeat) continue;
      const d = Math.abs((t.y + t.h / 2) - touchY);
      if (d < bestYDist) { bestYDist = d; bestNote = t; }
    }
    return bestNote ? { beatPrefix: closestBeat, closestNote: bestNote } : null;
  }

  const sweptLo = prevTouchX !== undefined ? Math.min(prevTouchX, touchX) : touchX;
  const sweptHi = prevTouchX !== undefined ? Math.max(prevTouchX, touchX) : touchX;

  interface Candidate { beat: string; note: HitTarget; xDist: number; yDist: number; }
  const candidates: Candidate[] = [];

  for (const t of targets) {
    if (!t.noteId.startsWith(p)) continue;
    const hitLo = t.x, hitHi = t.x + t.w;
    const hit = (touchX >= hitLo && touchX <= hitHi)
             || (sweptLo <= hitHi && sweptHi >= hitLo);
    if (!hit) continue;
    candidates.push({
      beat:  getBeatPrefix(t.noteId),
      note:  t,
      xDist: Math.abs(t.x + t.w / 2 - touchX),
      yDist: Math.abs(t.y + t.h / 2 - touchY),
    });
  }
  if (candidates.length === 0) {
    if (prevTouchX !== undefined) return null;
    const NEAR_PX = 20;
    let nearBeat = '', nearDist = NEAR_PX;
    for (const t of targets) {
      if (!t.noteId.startsWith(p)) continue;
      const d = Math.abs(t.x + t.w / 2 - touchX);
      if (d < nearDist) { nearDist = d; nearBeat = getBeatPrefix(t.noteId); }
    }
    if (!nearBeat) return null;
    let bestNote: HitTarget | null = null, bestYDist = Infinity;
    for (const t of targets) {
      if (getBeatPrefix(t.noteId) !== nearBeat) continue;
      const d = Math.abs(t.y + t.h / 2 - touchY);
      if (d < bestYDist) { bestYDist = d; bestNote = t; }
    }
    return bestNote ? { beatPrefix: nearBeat, closestNote: bestNote } : null;
  }
  candidates.sort((a, b) => a.xDist - b.xDist || a.yDist - b.yDist);
  return { beatPrefix: candidates[0].beat, closestNote: candidates[0].note };
}


// ── Audio / color ─────────────────────────────────────────────────────────────

// When a new beat activates on a staff, stop any cross-bar carried handles that
// live in the transition state for that staff so tied-to notes damp correctly.
function stopTransitionCarries(svg: SVGSVGElement, staff: number) {
  for (const tr of transitions.values()) {
    const ns = tr.newStaffs[staff];
    if (!ns) continue;
    for (const [noteId, handle] of [...ns.activeNotes]) {
      if (!ns.carriedHandlePitches.has(noteId)) continue;
      handle.stop();
      setColor(svg, noteId, COLOR_DEFAULT);
      ns.activeNotes.delete(noteId);
      ns.carriedHandlePitches.delete(noteId);
    }
  }
}

function setColor(svg: SVGSVGElement, noteId: string, color: string) {
  svg.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`)
    ?.querySelectorAll('path').forEach(p => p.setAttribute('fill', color));
}

function startNote(svg: SVGSVGElement, t: HitTarget, bag: Map<string, NoteHandle>, vel = 0, touchH = 0) {
  if (bag.has(t.noteId)) return;
  pendingRingOut.forEach(h => h.stop());
  pendingRingOut.clear();
  navigator.vibrate?.(10);
  const isTap = vel === 0;
  const gain = computeGain(touchH, isTap);
  bag.set(t.noteId, noteOn(t.midiPitch, gain, false, touchH, isTap));
  setColor(svg, t.noteId, COLOR_ACTIVE);
}

function stopNote(svg: SVGSVGElement, id: string, bag: Map<string, NoteHandle>) {
  const h = bag.get(id); if (!h) return;
  h.stop(); setColor(svg, id, COLOR_DEFAULT); bag.delete(id);
}

function stopBag(svg: SVGSVGElement, bag: Map<string, NoteHandle>) {
  for (const id of [...bag.keys()]) stopNote(svg, id, bag);
}

// ── Tap-advance helpers ───────────────────────────────────────────────────────


// Whitespace between the tap-advance area and the staff area (SVG user units).
// Both margins are equal so dead zones above and below the staff are symmetric.
const TAP_ADVANCE_MARGIN_TOP    = 60;
const TAP_ADVANCE_MARGIN_BOTTOM = TAP_ADVANCE_MARGIN_TOP;

// For scores with ≤3 staves the bottom dead zone is 25% taller so accidental
// taps below the last staff are less likely to trigger tap-advance.
function bottomDeadZoneHeight(): number {
  return currentStaffTops.length <= 3
    ? Math.round(TAP_ADVANCE_MARGIN_BOTTOM * 1.25)
    : TAP_ADVANCE_MARGIN_BOTTOM;
}

/**
 * Tap-advance areas occupy the full gap above staff 1 and below staff N,
 * leaving a margin adjacent to the staff.
 * Layout (top → bottom):  [tap-advance] [margin] [staff 1] … [staff N] [margin] [tap-advance]
 */
function getTapAdvanceArea(svg: SVGSVGElement, staff: number): [number, number] | null {
  const sc = svgScale(svg);
  const staffTop = currentStaffTops[staff - 1];
  if (staffTop === undefined) return null;

  if (staff === 1) {
    const areaTop    = -sc.oY * sc.sy;
    const areaBottom = staffTop - TAP_ADVANCE_MARGIN_TOP;
    if (areaBottom <= areaTop) return null;
    return [areaTop, areaBottom];
  }

  const lastStaffIdx = currentStaffTops.length - 1;
  if (staff === lastStaffIdx + 1) {
    const vb = svg.viewBox.baseVal;
    const areaTop    = staffTop + STAFF_HEIGHT + bottomDeadZoneHeight();
    const areaBottom = vb.height + sc.oY * sc.sy;
    if (areaBottom <= areaTop) return null;
    return [areaTop, areaBottom];
  }

  return null; // intermediate staves have no tap-advance area
}

// When there is only one staff, also expose a tap-advance area below it
// (20 px gap from the bottom of the staff, same advance effect as the top area).
function getBottomTapAdvanceAreaSingleStaff(svg: SVGSVGElement): [number, number] | null {
  if (currentStaffTops.length !== 1) return null;
  const sc = svgScale(svg);
  const vb = svg.viewBox.baseVal;
  const staffTop = currentStaffTops[0];
  const areaTop    = staffTop + STAFF_HEIGHT + bottomDeadZoneHeight();
  const areaBottom = vb.height + sc.oY * sc.sy;
  if (areaBottom <= areaTop) return null;
  return [areaTop, areaBottom];
}

function isTapAdvanceAreaY(svg: SVGSVGElement, staff: number, touchY: number): boolean {
  const area = getTapAdvanceArea(svg, staff);
  if (area !== null && touchY >= area[0] && touchY < area[1]) return true;
  if (staff === 1) {
    const bottom = getBottomTapAdvanceAreaSingleStaff(svg);
    if (bottom !== null && touchY >= bottom[0] && touchY < bottom[1]) return true;
  }
  return false;
}

function sortedBeatsOnStaff(targets: HitTarget[], staff: number): string[] {
  const p = `${staff}-`;
  const set = new Set<string>();
  for (const t of targets) if (t.noteId.startsWith(p)) set.add(getBeatPrefix(t.noteId));
  return [...set].sort((a, b) => parseFloat(a.split('-')[1]) - parseFloat(b.split('-')[1]));
}

// Union of beat positions (the float part) across multiple staffs, sorted.
function sortedBeatPositionsAcrossStaffs(targets: HitTarget[], staffs: number[]): number[] {
  const posSet = new Set<number>();
  for (const s of staffs) {
    for (const bp of sortedBeatsOnStaff(targets, s)) posSet.add(parseFloat(bp.split('-')[1]));
  }
  return [...posSet].sort((a, b) => a - b);
}

// Beat prefix for a staff at a specific position value, or null if none.
function beatPrefixAtPosition(targets: HitTarget[], staff: number, pos: number): string | null {
  for (const bp of sortedBeatsOnStaff(targets, staff)) {
    if (Math.abs(parseFloat(bp.split('-')[1]) - pos) < 0.0001) return bp;
  }
  return null;
}


function activateBeatDirect(
  svg: SVGSVGElement,
  targets: HitTarget[],
  ss: StaffState,
  staff: number,
  beatPrefix: string,
  touchH: number,
) {
  stopBag(svg, ss.activeNotes);
  stopTransitionCarries(svg, staff);
  ss.activeBeat      = beatPrefix;
  ss.activeTouchH    = touchH;
  ss.activeNoteCount = 0;
  ss.tiedPitches     = tiedPitchesFromBeat(targets, beatPrefix);

  for (const t of targets) {
    if (getBeatPrefix(t.noteId) !== beatPrefix) continue;
    if (t.tieStop) continue; // tieStop notes only via direct tap, never tap-advance
    startNote(svg, t, ss.activeNotes, 0, touchH);
  }

  const n = ss.activeNotes.size;
  if (n > 0) {
    ss.activeNoteCount = n;
    const base  = computeGain(touchH, true); // activateBeatDirect is always a tap
    const scale = n === 1 ? 1.0 : Math.max(0.55, 1 / Math.sqrt(n));
    for (const h of ss.activeNotes.values()) h.setGain(Math.min(0.95, base * scale));
  }

  staffLastBeat[staff] = { beat: beatPrefix, ms: performance.now() };
}

function advanceStaffGroup(
  svg: SVGSVGElement,
  targets: HitTarget[],
  x: number, y: number,
  touchH: number,
  group: number[],
): PointerState | null {
  let currentPos: number | null = null;
  for (const s of group) {
    const rb = staffLastBeat[s];
    if (!rb?.beat) continue;
    const staffHeld = [...pointers.values()].some(st => (st.staffs[s]?.activeNotes.size ?? 0) > 0);
    if (!staffHeld && performance.now() - rb.ms >= TAP_ADVANCE_WINDOW_MS) continue;
    const pos = parseFloat(rb.beat.split('-')[1]);
    if (currentPos === null || pos > currentPos) currentPos = pos;
  }

  const allPositions = sortedBeatPositionsAcrossStaffs(targets, group);
  const unactivated = group.filter(s => !staffLastBeat[s]?.beat);

  let targetPos: number | null;
  if (currentPos === null) {
    targetPos = allPositions[0] ?? null;
  } else {
    const idx = allPositions.findIndex(p => Math.abs(p - currentPos!) < 0.0001);
    if (idx < 0 || idx >= allPositions.length - 1) return null;

    if (unactivated.length > 0) {
      targetPos = null;
      for (let i = idx + 1; i < allPositions.length; i++) {
        const p = allPositions[i];
        if (unactivated.some(s => beatPrefixAtPosition(targets, s, p) !== null)) {
          targetPos = p; break;
        }
      }
      if (targetPos === null) targetPos = allPositions[idx + 1];
    } else {
      targetPos = allPositions[idx + 1];
    }
  }
  if (targetPos === null) return null;

  // Skip forward past beats where every staff in the group has only tieStop notes.
  const startIdx = allPositions.findIndex(p => Math.abs(p - targetPos!) < 0.0001);
  for (let i = startIdx; i < allPositions.length; i++) {
    const p = allPositions[i];
    const hasReal = group.some(s => {
      const bp = beatPrefixAtPosition(targets, s, p);
      return bp !== null && targets.some(t => getBeatPrefix(t.noteId) === bp && !t.tieStop);
    });
    if (hasReal) { targetPos = p; break; }
    if (i === allPositions.length - 1) return null;
  }

  const st = makePointerState(x, y, true);
  for (const s of group) {
    const bp = beatPrefixAtPosition(targets, s, targetPos);
    if (!bp) continue;
    activateBeatDirect(svg, targets, st.staffs[s], s, bp, touchH);
  }
  return st;
}

function tryTapAdvance(
  svg: SVGSVGElement,
  targets: HitTarget[],
  x: number, y: number,
  _hh: number, touchH: number,
): PointerState | null {
  const allStaffs = staffNums();

  // With exactly 2 staffs each tap area controls its own staff independently.
  if (allStaffs.length === 2) {
    for (const s of allStaffs) {
      if (isTapAdvanceAreaY(svg, s, y)) return advanceStaffGroup(svg, targets, x, y, touchH, [s]);
    }
    return null;
  }

  // 1 or 3+ staffs: any tap area advances all staffs together.
  if (!allStaffs.some(s => isTapAdvanceAreaY(svg, s, y))) return null;
  return advanceStaffGroup(svg, targets, x, y, touchH, allStaffs);
}

// ── Per-staff update ──────────────────────────────────────────────────────────

function updateStaff(
  svg: SVGSVGElement,
  targets: HitTarget[],
  ss: StaffState,
  staff: number,
  touchX: number, touchY: number,
  halfH: number,
  swipeVel = 0,
  touchH = 0,
  prevTouchX?: number,
  trackRecentBeat = true,
  allowTieStop = false,
) {
  const range = staffLineYRange(staff);
  if (!range) return;
  const inStaffLines = touchY >= range[0] && touchY <= range[1];
  if (!inStaffLines) {
    // Outside the 5-line bounds — only proceed if the touch overlaps a note's
    // actual bounding box at the nearest beat (leger-line notes are still reachable).
    const probe = findBestBeat(targets, staff, touchX, touchY, halfH, prevTouchX);
    if (!probe || !touchInBeatYRange(targets, probe.beatPrefix, touchY)) return;
  }

  const result = findBestBeat(targets, staff, touchX, touchY, halfH, prevTouchX);
  if (!result) return;

  const { beatPrefix, closestNote } = result;

  if (ss.activeBeat !== beatPrefix) {
    stopTransitionCarries(svg, staff);
    // Keep notes that are tied forward from the current beat, or handles carried across a barline.
    const tiedForward = tiedPitchesFromBeat(targets, ss.activeBeat);
    for (const [noteId, handle] of [...ss.activeNotes]) {
      if (ss.carriedHandlePitches.has(noteId)) continue; // cross-bar carry
      const t = targets.find(t2 => t2.noteId === noteId);
      if (t && tiedForward.has(t.midiPitch)) continue;   // tied forward within bar
      handle.stop();
      setColor(svg, noteId, COLOR_DEFAULT);
      ss.activeNotes.delete(noteId);
      ss.carriedHandlePitches.delete(noteId);
    }
    ss.activeBeat      = beatPrefix;
    ss.activeTouchH    = touchH;
    ss.activeNoteCount = 0;
    ss.tiedPitches     = tiedPitchesFromBeat(targets, beatPrefix);
    if (trackRecentBeat) {
      staffLastBeat[staff] = { beat: beatPrefix, ms: performance.now() };
    }
    if (allowTieStop || !closestNote.tieStop) {
      startNote(svg, closestNote, ss.activeNotes, swipeVel, touchH);
    }
    const preLoopIds = new Set(ss.activeNotes.keys());
    for (const t of targets) {
      if (getBeatPrefix(t.noteId) !== ss.activeBeat) continue;
      if (t.y > touchY + halfH || t.y + t.h < touchY - halfH) continue;
      if (!allowTieStop && t.tieStop) continue;
      startNote(svg, t, ss.activeNotes, swipeVel, touchH);
    }
    const n = ss.activeNotes.size;
    if (n > 0 && n !== ss.activeNoteCount) {
      ss.activeNoteCount = n;
      const effectiveTouchH = ss.activeTouchH > 0 ? ss.activeTouchH : touchH;
      const baseGain   = computeGain(effectiveTouchH, swipeVel === 0);
      const chordScale = n === 1 ? 1.0 : Math.max(0.55, 1 / Math.sqrt(n));
      const chordGain  = Math.min(0.95, baseGain * chordScale);
      for (const [id, h] of ss.activeNotes) {
        if (!preLoopIds.has(id)) h.setGain(chordGain);
      }
    }
    return;
  } else if (ss.activeTouchH === 0 && touchH > 0) {
    ss.activeTouchH    = touchH;
    ss.activeNoteCount = 0;
  }

  // Same beat: add any newly in-range notes (finger moved vertically within the beat).
  const preLoopIds = new Set(ss.activeNotes.keys());
  for (const t of targets) {
    if (getBeatPrefix(t.noteId) !== ss.activeBeat) continue;
    if (t.y > touchY + halfH || t.y + t.h < touchY - halfH) continue;
    if (!allowTieStop && t.tieStop) continue;
    startNote(svg, t, ss.activeNotes, swipeVel, touchH);
  }

  const n = ss.activeNotes.size;
  if (n > 0 && n !== ss.activeNoteCount) {
    ss.activeNoteCount = n;
    const effectiveTouchH = ss.activeTouchH > 0 ? ss.activeTouchH : touchH;
    const baseGain   = computeGain(effectiveTouchH, swipeVel === 0);
    const chordScale = n === 1 ? 1.0 : Math.max(0.55, 1 / Math.sqrt(n));
    const chordGain  = Math.min(0.95, baseGain * chordScale);
    for (const [id, h] of ss.activeNotes) {
      if (!preLoopIds.has(id)) h.setGain(chordGain);
    }
  }
}


// ── Transition pointer handling ───────────────────────────────────────────────

function updateTransition(
  svg: SVGSVGElement,
  targets: HitTarget[],
  tr: TransitionEntry,
  x: number, y: number, halfH: number,
  swipeVel = 0,
  touchH = 0,
  prevTouchX?: number,
) {
  tr.lastX = x; tr.lastY = y;

  for (const s of staffNums()) {
    const range = staffLineYRange(s);
    if (!range) continue;
    const inStaffLines = y >= range[0] && y <= range[1];
    if (!inStaffLines) {
      const probe = findBestBeat(targets, s, x, y, halfH);
      if (!probe || !touchInBeatYRange(targets, probe.beatPrefix, y)) continue;
    }

    const result = findBestBeat(targets, s, x, y, halfH);
    if (!result) continue;

    const { beatPrefix } = result;

    if (tr.lockedBeat[s] !== null) {
      if (beatPrefix === tr.lockedBeat[s]) continue;
      tr.staffHandles[s]?.forEach(h => h.stop());
      tr.staffHandles[s]?.clear();
      tr.lockedBeat[s] = null;
    }

    if (!tr.newStaffs[s]) tr.newStaffs[s] = makeStaffState();
    updateStaff(svg, targets, tr.newStaffs[s], s, x, y, halfH, swipeVel, touchH, prevTouchX, false);
  }
}

function endTransition(svg: SVGSVGElement, id: number) {
  const tr = transitions.get(id); if (!tr) return;
  for (const s of staffNums()) {
    tr.staffHandles[s]?.forEach(h => h.stop());
    if (tr.newStaffs[s]) stopBag(svg, tr.newStaffs[s].activeNotes);
  }
  transitions.delete(id);
  removeIndicator(id);
  pointerMoveState.delete(id);
}

function endTransitionGlobal(pointerId: number, ringOut: boolean) {
  pointerMoveState.delete(pointerId);
  if (!transitions.has(pointerId)) return;
  const tr = transitions.get(pointerId)!;
  for (const s of staffNums()) {
    // staffHandles are in pendingRingOut; stop + remove them now that the
    // finger has lifted (no need to wait for the next note to activate).
    tr.staffHandles[s]?.forEach(h => { h.stop(); pendingRingOut.delete(h); });
    if (!ringOut) {
      tr.newStaffs[s]?.activeNotes.forEach(h => h.stop());
    }
  }
  transitions.delete(pointerId);
  removeIndicator(pointerId);
}
window.addEventListener('pointerup', e => {
  const tr = transitions.get(e.pointerId);
  endTransitionGlobal(e.pointerId, !!(tr?.triggeredNextBar));
});
window.addEventListener('pointercancel', e => {
  const tr = transitions.get(e.pointerId);
  endTransitionGlobal(e.pointerId, !!(tr?.triggeredNextBar));
});

// ── Touch overlay ─────────────────────────────────────────────────────────────

const overlayEls = new Map<number, SVGGElement>();

function getOverlay(svg: SVGSVGElement): SVGGElement {
  let g = svg.querySelector<SVGGElement>('#touch-overlay');
  if (!g) {
    const NS = 'http://www.w3.org/2000/svg';
    g = document.createElementNS(NS, 'g') as SVGGElement;
    g.setAttribute('id', 'touch-overlay');
    g.setAttribute('pointer-events', 'none');
    svg.appendChild(g);
  }
  return g;
}

function upsertIndicator(
  svg: SVGSVGElement, id: number,
  x: number, y: number, twCSS: number, thCSS: number,
) {
  const sc = svgScale(svg);
  const rX = Math.max(8, (twCSS / 2) * sc.sx);
  const rY = Math.max(8, (thCSS / 2) * sc.sy);
  const NS = 'http://www.w3.org/2000/svg';
  let g = overlayEls.get(id);
  if (!g) {
    g = document.createElementNS(NS, 'g') as SVGGElement;
    const ring = document.createElementNS(NS, 'ellipse');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'rgba(224,48,48,0.55)');
    ring.setAttribute('stroke-width', '1.5');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', 'rgba(224,48,48,0.7)');
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('fill', 'rgba(220,30,30,0.9)');
    label.setAttribute('font-size', '18');
    label.setAttribute('font-family', 'system-ui, sans-serif');
    label.setAttribute('font-weight', '600');
    label.setAttribute('pointer-events', 'none');
    g.appendChild(ring); g.appendChild(dot); g.appendChild(label);
    getOverlay(svg).appendChild(g);
    overlayEls.set(id, g);
  }
  g.querySelector('ellipse')!.setAttribute('cx', String(x));
  g.querySelector('ellipse')!.setAttribute('cy', String(y));
  g.querySelector('ellipse')!.setAttribute('rx', String(rX));
  g.querySelector('ellipse')!.setAttribute('ry', String(rY));
  g.querySelector('circle')!.setAttribute('cx', String(x));
  g.querySelector('circle')!.setAttribute('cy', String(y));
  const lbl = g.querySelector('text')!;
  lbl.textContent = String(Math.round(thCSS));
  lbl.setAttribute('x', String(x + rX + 4));
  lbl.setAttribute('y', String(y + 6));
}

function removeIndicator(id: number) {
  const g = overlayEls.get(id);
  g?.parentNode?.removeChild(g);
  overlayEls.delete(id);
}

// ── Vibrato application ───────────────────────────────────────────────────────

function applyVibrato(bags: Map<string, NoteHandle>[], rateHz: number, depthCents: number) {
  for (const bag of bags) {
    for (const h of bag.values()) h.setVibrato(rateHz, depthCents);
  }
}

// ── attachTouchHandlers ───────────────────────────────────────────────────────

export function attachTouchHandlers(
  svg: SVGSVGElement,
  getTargets: () => HitTarget[],
  onNavigateNext?: () => void,
  vertLayout?: { staffTops: number[] },
) {
  if (vertLayout) {
    currentStaffTops = vertLayout.staffTops;
  }

  // Reinitialise per-staff tap-advance state for the new bar
  staffLastBeat = {};


  svg.style.touchAction = 'none';
  (svg.style as any).webkitUserSelect = 'none';
  (svg.style as any).webkitTouchCallout = 'none';
  svg.addEventListener('contextmenu', e => e.preventDefault());

  // Returns true when y is in the dead zone between the lowest note hit target on
  // the last staff and the start of the bottom tap-advance area.
  function inBottomDeadZone(targets: HitTarget[], y: number): boolean {
    const n = currentStaffTops.length;
    if (n === 0) return false;
    const lastTop = currentStaffTops[n - 1];
    const tapStart = lastTop + STAFF_HEIGHT + bottomDeadZoneHeight();
    const pfx = `${n}-`;
    const lowestHit = targets.reduce(
      (m, t) => t.noteId.startsWith(pfx) ? Math.max(m, t.y + t.h) : m,
      lastTop + STAFF_HEIGHT,
    );
    return y > lowestHit && y < tapStart;
  }

  svg.addEventListener('pointerdown', (e: PointerEvent) => {
    if (transitions.has(e.pointerId)) return;
    e.preventDefault();
    ensureAudioReady();
    try { svg.setPointerCapture(e.pointerId); } catch { }

    const sc = svgScale(svg);
    const { x, y } = clientToSVG(e, sc);
    const hh = touchHalfH(e, sc);
    upsertIndicator(svg, e.pointerId, x, y, e.width ?? 1, e.height ?? 1);


    trackAndGetVelocity(e.pointerId, e.clientX, e.clientY);
    const touchH = e.height ?? 0;
    const targets = getTargets();

    const tapSt = tryTapAdvance(svg, targets, x, y, hh, touchH);
    if (tapSt) {
      pointers.set(e.pointerId, tapSt);
      return;
    }

    // Single-staff bottom gap: dead zone between staff bottom and tap area.
    const st = makePointerState(x, y);
    pointers.set(e.pointerId, st);
    if (inBottomDeadZone(targets, y)) return;
    for (const s of staffNums()) {
      updateStaff(svg, targets, st.staffs[s], s, x, y, hh, 0, touchH, undefined, true, true);
    }
  });

  svg.addEventListener('pointermove', (e: PointerEvent) => {
    const sc = svgScale(svg);
    const { x, y } = clientToSVG(e, sc);
    const hh = touchHalfH(e, sc);

    if (transitions.has(e.pointerId)) {
      const tr = transitions.get(e.pointerId)!;
      tr.lastX = x; tr.lastY = y;
      upsertIndicator(svg, e.pointerId, x, y, e.width ?? 1, e.height ?? 1);
      if (!tr.triggeredNextBar && e.clientX >= window.innerWidth - nextBarZoneW()) {
        tr.triggeredNextBar = true;
        if (Date.now() >= nextBarCooldownUntil) {
          nextBarCooldownUntil = Date.now() + 1000;
          onNavigateNext?.();
        }
        return;
      }
      if (tr.triggeredNextBar && e.clientX < window.innerWidth - nextBarZoneW() - 10) {
        tr.triggeredNextBar = false;
      }
      const trPrevX = tr.lastX;
      const trVel   = trackAndGetVelocity(e.pointerId, e.clientX, e.clientY);
      updateTransition(svg, getTargets(), tr, x, y, hh, trVel, e.height ?? 0, trPrevX);
      tr.wiggle.update(e.clientX);
      const trM = tr.wiggle.getMetrics();
      const trBags = staffNums().flatMap(s => [
        tr.staffHandles[s] ?? new Map(),
        tr.newStaffs[s]?.activeNotes ?? new Map(),
      ]);
      applyVibrato(trBags, trM.rateHz, trM.depthCents);
      return;
    }

    const st = pointers.get(e.pointerId);
    if (!st) return;
    const prevX = st.lastX;
    st.lastX = x; st.lastY = y;
    upsertIndicator(svg, e.pointerId, x, y, e.width ?? 1, e.height ?? 1);

    if (!st.triggeredNextBar && e.clientX >= window.innerWidth - nextBarZoneW()) {
      st.triggeredNextBar = true;
      if (Date.now() >= nextBarCooldownUntil) {
        nextBarCooldownUntil = Date.now() + 1000;
        onNavigateNext?.();
      }
      return;
    }
    if (st.triggeredNextBar && e.clientX < window.innerWidth - nextBarZoneW() - 10) {
      st.triggeredNextBar = false;
    }

    const vel    = trackAndGetVelocity(e.pointerId, e.clientX, e.clientY);
    const touchH = e.height ?? 0;
    if (!st.isTapAdvance) {
      const targets = getTargets();
      if (inBottomDeadZone(targets, y)) { st.wiggle.update(e.clientX); return; }
      for (const s of staffNums()) {
        updateStaff(svg, targets, st.staffs[s], s, x, y, hh, vel, touchH, prevX);
      }
    }
    st.wiggle.update(e.clientX);
    const stM = st.wiggle.getMetrics();
    applyVibrato(staffNums().map(s => st.staffs[s].activeNotes), stM.rateHz, stM.depthCents);
  });

  function endTouch(e: PointerEvent) {
    if (transitions.has(e.pointerId)) {
      if (!svg.isConnected) return;
      const tr = transitions.get(e.pointerId)!;
      if (tr.triggeredNextBar) {
        transitions.delete(e.pointerId);
        removeIndicator(e.pointerId);
        pointerMoveState.delete(e.pointerId);
        return;
      }
      endTransition(svg, e.pointerId);
      return;
    }
    const st = pointers.get(e.pointerId); if (!st) return;
    for (const s of staffNums()) {
      const ss = st.staffs[s];
      if (!ss) continue;
      // Refresh timestamp before stopping so the 1000ms window starts from release.
      if (ss.activeNotes.size > 0 && staffLastBeat[s]?.beat) {
        staffLastBeat[s] = { ...staffLastBeat[s], ms: performance.now() };
      }
      stopBag(svg, ss.activeNotes);
    }
    removeIndicator(e.pointerId);
    pointers.delete(e.pointerId);
    pointerMoveState.delete(e.pointerId);
  }
  svg.addEventListener('pointerup',     endTouch);
  svg.addEventListener('pointercancel', endTouch);
}

// ── Public helpers ────────────────────────────────────────────────────────────

export function stopAllNotes(svg?: SVGSVGElement) {
  pendingRingOut.forEach(h => h.stop());
  pendingRingOut.clear();
  for (const [id, st] of pointers.entries()) {
    for (const ss of Object.values(st.staffs) as StaffState[]) {
      if (svg) stopBag(svg, ss.activeNotes);
      else ss.activeNotes.forEach(h => h.stop());
    }
    removeIndicator(id);
  }
  pointers.clear();
  for (const tr of transitions.values()) {
    for (const handles of Object.values(tr.staffHandles) as Map<string, NoteHandle>[]) {
      handles.forEach(h => h.stop());
    }
    for (const ss of Object.values(tr.newStaffs) as StaffState[]) {
      if (svg) stopBag(svg, ss.activeNotes);
      else ss.activeNotes.forEach(h => h.stop());
    }
  }
  transitions.clear();
}

// ── Debug zone overlay ────────────────────────────────────────────────────────

export function drawDebugZones(svg: SVGSVGElement, _targets: HitTarget[]): void {
  svg.querySelector('#debug-zones')?.remove();
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.id = 'debug-zones';
  g.style.pointerEvents = 'none';

  const sc  = svgScale(svg);
  const vb  = svg.viewBox.baseVal;
  const n   = currentStaffTops.length;
  if (n === 0) { svg.appendChild(g); return; }

  const svgW           = vb.width;
  const viewportTop    = -sc.oY * sc.sy;
  const viewportBottom =  vb.height + sc.oY * sc.sy;
  const topStaffY      = currentStaffTops[0];
  const lastStaffTop   = currentStaffTops[n - 1];
  const staffBottom    = lastStaffTop + STAFF_HEIGHT;

  function rect(y1: number, y2: number, color: string) {
    if (y2 <= y1) return;
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', '0');
    r.setAttribute('y', String(y1));
    r.setAttribute('width', String(svgW));
    r.setAttribute('height', String(y2 - y1));
    r.setAttribute('fill', color);
    r.setAttribute('opacity', '0.25');
    g.appendChild(r);
  }

  // Top: [viewport top → tap-advance (red) → dead zone (blue) → staff 1]
  const topDeadTop = topStaffY - TAP_ADVANCE_MARGIN_TOP;
  rect(viewportTop, topDeadTop, 'red');
  rect(topDeadTop, topStaffY, 'blue');

  // Bottom: [last staff → dead zone (blue) → tap-advance (red) → viewport bottom]
  const bottomDeadBottom = staffBottom + bottomDeadZoneHeight();
  rect(staffBottom, bottomDeadBottom, 'blue');
  rect(bottomDeadBottom, viewportBottom, 'red');

  svg.appendChild(g);
}
