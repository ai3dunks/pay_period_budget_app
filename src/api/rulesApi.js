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

export function applyRules(dryRun, periodId) {
  return apiPost('/api/rules/apply', {
    dryRun,
    periodId: periodId || undefined,
  });
}
