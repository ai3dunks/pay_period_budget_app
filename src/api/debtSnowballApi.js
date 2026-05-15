import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';

export function getDebtSnowballData() {
  return apiGet('/api/debt-snowball');
}

export function updateDebtSnowballConfig(payload) {
  return apiPatch('/api/debt-snowball/config', payload || {});
}

export function createDebt(payload) {
  return apiPost('/api/debt-snowball/debts', payload || {});
}

export function updateDebt(id, payload) {
  return apiPatch('/api/debt-snowball/debts/' + encodeURIComponent(id), payload || {});
}

export function replaceDebts(payload) {
  return apiPost('/api/debt-snowball/debts/replace', payload || { rows: [] });
}

export function deleteDebt(id) {
  return apiDelete('/api/debt-snowball/debts/' + encodeURIComponent(id));
}

export function createRecurringBillFromDebt(id) {
  return apiPost('/api/debt-snowball/debts/' + encodeURIComponent(id) + '/create-recurring-bill', {});
}

export function getDebtSnowballPaymentPlans(periodId) {
  return apiGet('/api/debt-snowball/payment-plans', { periodId });
}

export function createDebtSnowballPaymentPlan(payload) {
  return apiPost('/api/debt-snowball/payment-plans', payload || {});
}

export function confirmDebtSnowballPaymentPlan(id) {
  return apiPatch('/api/debt-snowball/payment-plans/' + encodeURIComponent(id) + '/confirm', {});
}
