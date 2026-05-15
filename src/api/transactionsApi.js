import { apiGet, apiPatch } from './client.js';

export function getTransactions(params = {}) {
  return apiGet('/api/transactions', params);
}

export function patchTransaction(id, payload) {
  return apiPatch('/api/transactions/' + encodeURIComponent(id), payload);
}
