import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';

export function getBudgetBuckets(params) {
  return apiGet('/api/budget-buckets', params || {});
}

export function createBudgetBucket(payload) {
  return apiPost('/api/budget-buckets', payload || {});
}

export function updateBudgetBucket(id, payload) {
  return apiPatch('/api/budget-buckets/' + encodeURIComponent(id), payload || {});
}

export function deleteBudgetBucket(id) {
  return apiDelete('/api/budget-buckets/' + encodeURIComponent(id));
}

export function assignTransactionToBucket(bucketId, transactionId) {
  return apiPost('/api/budget-buckets/' + encodeURIComponent(bucketId) + '/assign-transaction', {
    transactionId,
  });
}
