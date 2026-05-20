/**
 * Helpers for vanilla DOM re-renders that should feel like in-place updates.
 */

export function captureRenderState() {
  const active = document.activeElement;
  return {
    scrollY: window.scrollY || window.pageYOffset || 0,
    activeElementId: active?.id || '',
    activeElementName: active?.getAttribute?.('name') || '',
  };
}

export function restoreRenderState(state) {
  if (!state) return;
  window.requestAnimationFrame(() => {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(state.scrollY || 0, maxScroll), behavior: 'auto' });

    const escapedName = state.activeElementName && window.CSS?.escape
      ? CSS.escape(state.activeElementName)
      : String(state.activeElementName || '').replace(/"/g, '\\"');
    const focusTarget = state.activeElementId
      ? document.getElementById(state.activeElementId)
      : (escapedName ? document.querySelector('[name="' + escapedName + '"]') : null);
    focusTarget?.focus?.({ preventScroll: true });
  });
}

export async function withPreservedRenderState(callback) {
  const state = captureRenderState();
  try {
    return await callback();
  } finally {
    restoreRenderState(state);
  }
}

export function replaceHtmlPreservingHeight(element, html) {
  if (!element) return;
  const previousMinHeight = element.style.minHeight;
  element.style.minHeight = Math.ceil(element.getBoundingClientRect().height || 0) + 'px';
  element.innerHTML = html;
  window.requestAnimationFrame(() => {
    element.style.minHeight = previousMinHeight;
  });
}
