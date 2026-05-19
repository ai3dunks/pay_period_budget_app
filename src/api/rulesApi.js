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

function normalizeRulePeriodOptions(periodOrId) {
  if (!periodOrId) return {};
  if (typeof periodOrId === 'object') {
    return {
      periodId: periodOrId.id || undefined,
      startDate: periodOrId.startDate || undefined,
      exclusiveEndDate: periodOrId.exclusiveEndDate || undefined,
    };
  }
  return { periodId: periodOrId };
}

export function previewRule(id, periodOrId) {
  return apiPost('/api/rules/' + encodeURIComponent(id) + '/preview', {
    ...normalizeRulePeriodOptions(periodOrId),
  });
}

export function previewRuleDraft(payload, periodOrId) {
  return apiPost('/api/rules/preview-draft', {
    ...(payload || {}),
    ...normalizeRulePeriodOptions(periodOrId),
  });
}

export function applyRule(id, options = {}) {
  return apiPost('/api/rules/' + encodeURIComponent(id) + '/apply', options || {});
}

export function applyRules(dryRun, periodOrId) {
  return apiPost('/api/rules/apply', {
    dryRun,
    ...normalizeRulePeriodOptions(periodOrId),
  });
}
