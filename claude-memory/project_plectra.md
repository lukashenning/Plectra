---
name: project-plectra
description: Plectra — mobile-first music notation webapp for reading MusicXML one bar at a time with touch-based note playback
metadata: 
  node_type: memory
  type: project
  originSessionId: b51aee58-91a9-4038-8deb-a74c3f2714f0
---

Plectra is a mobile-first music notation prototype at `/Users/lukashenning/Archive/plectra`.

**Stack**: Vite + TypeScript, vanilla JS, no UI framework. No runtime library dependencies.

**Architecture**:
- `src/musicxml/parser.ts` — raw MusicXML XML parsing using DOMParser
- `src/notation/layout.ts` — computes SVG x/y for all symbols in a bar (proportional horizontal spacing)
- `src/notation/renderer.ts` — emits SVG DOM from layout data, returns HitTarget[] for touch
- `src/notation/symbols.ts` — draws glyphs (note heads, clefs, rests, accidentals) using path data
- `src/notation/glyphs.ts` — auto-generated: Bravura OTF paths extracted via fonttools, scaled 10px/staff-space, Y-flipped
- `src/notation/pitchMap.ts` — MIDI pitch → staff position (diatonic steps from middle C)
- `src/audio/synth.ts` — 4-harmonic oscillator + ADSR envelope, raw Web Audio API
- `src/input/touch.ts` — Pointer Events multi-touch, hit-tests against HitTarget[], legato swipe
- `src/app.ts` — state management, bar navigation, file loading

**Key technical decisions**:
- MusicXML (not MIDI) because it already contains notation data — no quantization needed
- All notation glyphs rendered as SVG `<path>` elements from extracted Bravura font paths (no @font-face dependency)
- Whole/half rests drawn as SVG `<rect>` elements (cleaner than glyph paths)
- Beam groups: all notes in a group share stem direction (avg diatonic vs middle line)
- Touch: Pointer Events API + `touch-action: none`, legato by tracking pointerId across moves

**Dev server**: `npm run dev` at `http://localhost:5173`. Test file at `/test.musicxml`.

**Why:** User is prototyping the concept of "one bar at a time score reading with touch-to-play notes" for mobile.
