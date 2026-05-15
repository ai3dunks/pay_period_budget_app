/**
 * Thin wrapper around window CustomEvents.
 * Uses window so existing page modules can still emit/listen with
 * window.dispatchEvent(new CustomEvent(...)).
 */

export function emitAppEvent(name, detail = {}) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function onAppEvent(name, handler) {
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}
