/**
 * iOS Safari — game-mode input hardening.
 *
 * Root cause of magnifier / zoom issues:
 *   PointerEvent.preventDefault() does NOT suppress the underlying TouchEvent
 *   in Safari.  The magnifier is triggered by the TouchEvent system separately.
 *   We must prevent TouchEvent defaults independently.
 *
 * Strategy: block touch defaults globally, but allow them on elements that
 * genuinely need native touch behaviour (buttons, inputs, links).
 */

function needsNativeTouch(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  // Native interactive elements need their default touch → click flow
  if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' ||
      tag === 'TEXTAREA' || tag === 'A' || tag === 'LABEL') return true;
  // Anything nested inside a button or the load dialog is also allowed
  if (target.closest('button') || target.closest('#load-dialog')) return true;
  // Allow native scroll in the music browser list
  if (target.closest('#find-results')) return true;
  return false;
}

export function installIOSFixes() {
  // ── Prevent long-press magnifier / callout ─────────────────────────────
  document.addEventListener('touchstart', e => {
    if (!needsNativeTouch(e.target)) e.preventDefault();
  }, { passive: false });

  // ── Prevent double-tap zoom (iOS 10+ ignores user-scalable=no) ─────────
  document.addEventListener('touchend', e => {
    if (!needsNativeTouch(e.target)) e.preventDefault();
  }, { passive: false });

  // ── Prevent scroll / pinch-zoom via touchmove ─────────────────────────
  document.addEventListener('touchmove', e => {
    if (!needsNativeTouch(e.target)) e.preventDefault();
  }, { passive: false });

  // ── Prevent right-click / long-press context menu ─────────────────────
  document.addEventListener('contextmenu', e => {
    if (!needsNativeTouch(e.target)) e.preventDefault();
  });
}
