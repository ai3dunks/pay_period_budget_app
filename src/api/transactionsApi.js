import { apiGet, apiPatch, apiPost } from './client.js';

export function getTransactions(params = {}) {
  return apiGet('/api/transactions', params);
}

export function patchTransaction(id, payload) {
  return apiPatch('/api/transactions/' + encodeURIComponent(id), payload);
}

export function getTransactionSplits(id) {
  return apiGet('/api/transactions/' + encodeURIComponent(id) + '/splits');
}

export function saveTransactionSplits(id, payload) {
  return apiPost('/api/transactions/' + encodeURIComponent(id) + '/splits', payload || {});
}
