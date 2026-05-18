import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';

export function getExpenseFundingRecords(periodId) {
  return apiGet('/api/expense-funding/records', { periodId });
}

export function createExpenseFundingRecord(payload) {
  return apiPost('/api/expense-funding/records', payload);
}

export function updateExpenseFundingRecord(id, payload) {
  return apiPatch('/api/expense-funding/records/' + encodeURIComponent(id), payload);
}

export function deleteExpenseFundingRecord(id) {
  return apiDelete('/api/expense-funding/records/' + encodeURIComponent(id));
}
