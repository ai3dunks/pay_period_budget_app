import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';

export function getRules() {
  return apiGet('/api/rules');
}

export function createRule(payload) {
  return apiPost('/api/rules', payload);
}

export function patchRule(id, updates) {
  return apiPatch('/api/rules/' + encodeURIComponent(id), updates);
}

export function disableRule(id) {
  return apiDelete('/api/rules/' + encodeURIComponent(id));
}

export function deleteRule(id) {
  return apiDelete('/api/rules/' + encodeURIComponent(id));
}

export function previewRule(id, periodId) {
  return apiPost('/api/rules/' + encodeURIComponent(id) + '/preview', {
    periodId: periodId || undefined,
  });
}

export function applyRule(id, options = {}) {
  return apiPost('/api/rules/' + encodeURIComponent(id) + '/apply', options || {});
}

export function applyRules(dryRun, periodId) {
  return apiPost('/api/rules/apply', {
    dryRun,
    periodId: periodId || undefined,
  });
}
