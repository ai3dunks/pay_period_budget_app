import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';

export function getSnowballTransfers(periodId) {
  return apiGet('/api/debt-snowball/snowball-transfers', { periodId });
}

export function createSnowballTransfer(payload) {
  return apiPost('/api/debt-snowball/snowball-transfers', payload);
}

export function updateSnowballTransfer(id, payload) {
  return apiPatch('/api/debt-snowball/snowball-transfers/' + encodeURIComponent(id), payload);
}

export function deleteSnowballTransfer(id) {
  return apiDelete('/api/debt-snowball/snowball-transfers/' + encodeURIComponent(id));
}

export function getPaymentPlans(periodId) {
  return apiGet('/api/debt-snowball/payment-plans', { periodId });
}

export function createPaymentPlan(payload) {
  return apiPost('/api/debt-snowball/payment-plans', payload);
}

export function confirmPaymentPlan(id) {
  return apiPatch('/api/debt-snowball/payment-plans/' + encodeURIComponent(id) + '/confirm', {});
}

export function holdPaymentPlan(id) {
  return apiPatch('/api/debt-snowball/payment-plans/' + encodeURIComponent(id) + '/hold', {});
}

export function deletePaymentPlan(id) {
  return apiDelete('/api/debt-snowball/payment-plans/' + encodeURIComponent(id));
}
