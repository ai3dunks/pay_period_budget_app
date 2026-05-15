import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';

export function getCashFlowAdjustments(budgetPeriodId) {
  return apiGet('/api/cash-flow/adjustments', { budgetPeriodId });
}

export function createCashFlowAdjustment(payload) {
  return apiPost('/api/cash-flow/adjustments', payload || {});
}

export function updateCashFlowAdjustment(id, payload) {
  return apiPatch('/api/cash-flow/adjustments/' + encodeURIComponent(id), payload || {});
}

export function deleteCashFlowAdjustment(id) {
  return apiDelete('/api/cash-flow/adjustments/' + encodeURIComponent(id));
}
