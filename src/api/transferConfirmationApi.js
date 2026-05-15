import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';

export function getTransferConfirmations(periodId, targetName) {
  const params = { budget_period_id: periodId };
  if (targetName) params.target_name = targetName;
  return apiGet('/api/transfers/confirmations', params);
}

export function createTransferConfirmation(payload) {
  return apiPost('/api/transfers/confirmations', payload);
}

export function updateTransferConfirmation(id, payload) {
  return apiPatch('/api/transfers/confirmations/' + encodeURIComponent(id), payload);
}

export function deleteTransferConfirmation(id) {
  return apiDelete('/api/transfers/confirmations/' + encodeURIComponent(id));
}
