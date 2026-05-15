/**
 * Performance diagnostics — only active when window.__BUDGET_DEBUG__ === true.
 */

export function timeAsync(label, fn) {
  if (typeof window === 'undefined' || !window.__BUDGET_DEBUG__) return fn();
  const start = performance.now();
  return fn().then((result) => {
    console.log('[perf] ' + label + ': ' + (performance.now() - start).toFixed(1) + 'ms');
    return result;
  });
}

export function logRenderTime(label, startedAt) {
  if (typeof window === 'undefined' || !window.__BUDGET_DEBUG__) return;
  console.log('[render] ' + label + ': ' + (performance.now() - startedAt).toFixed(1) + 'ms');
}
