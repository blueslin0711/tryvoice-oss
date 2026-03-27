// Gesture handling — swipe to expand/collapse chat, drag handle dblclick

export function initGestures(
  transcript: HTMLElement,
  settingsOverlay: HTMLElement | null,
  dragHandle: HTMLElement | null,
): void {
  let touchStartY = 0;
  let touchStartScrollTop = 0;
  let touchStartedInTranscript = false;
  let gestureTriggered = false;
  let touchStartInTopZone = false;
  let topZoneExpandCapture = false;
  const TOP_ZONE_RATIO = 0.25;

  document.addEventListener('touchstart', (e) => {
    if (settingsOverlay?.classList.contains('open')) return;
    touchStartY = e.touches[0].clientY;
    touchStartedInTranscript = !!transcript?.contains(e.target as Node);
    touchStartScrollTop = transcript?.scrollTop ?? 0;
    const viewportH = window.visualViewport?.height || window.innerHeight || 0;
    touchStartInTopZone = touchStartY <= (viewportH * TOP_ZONE_RATIO);
    topZoneExpandCapture = document.body.classList.contains('chat-expanded') && touchStartInTopZone;
    gestureTriggered = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (gestureTriggered || settingsOverlay?.classList.contains('open')) return;
    const dy = touchStartY - e.touches[0].clientY;
    const expanded = document.body.classList.contains('chat-expanded');
    if (expanded && topZoneExpandCapture) {
      if (dy <= 0) e.preventDefault();
      if (dy < -34) { gestureTriggered = true; document.body.classList.remove('chat-expanded'); }
      return;
    }
    if (expanded && !touchStartInTopZone) return;
    if (touchStartedInTranscript) {
      if (!expanded) {
        if (touchStartScrollTop <= 0 && dy > 80) { gestureTriggered = true; document.body.classList.add('chat-expanded'); }
      }
    } else {
      if (dy > 50 && !expanded) { gestureTriggered = true; document.body.classList.add('chat-expanded'); }
      else if (dy < -50 && expanded && touchStartInTopZone) { gestureTriggered = true; document.body.classList.remove('chat-expanded'); }
    }
  }, { passive: false });

  if (dragHandle) {
    dragHandle.addEventListener('dblclick', () => document.body.classList.toggle('chat-expanded'));
  }
}
