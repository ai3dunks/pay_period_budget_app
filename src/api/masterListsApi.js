import { apiGet, apiPatch, apiPost, apiDelete } from './client.js';
import { normalizeMatchWordsInput, normalizeText, toNumber } from '../utils/formatters.js';

let _cache = null;
let _loaded = false;

function mapItem(item) {
  return {
    ...item,
    name: normalizeText(item.name),
    budgetAmount: toNumber(item.budgetAmount, 0),
    active: !!item.active,
    notes: item.notes || '',
    displayOrder: item.displayOrder ?? 0,
  };
}

function mapBill(item) {
  return {
    ...item,
    name: normalizeText(item.name),
    category: String(item.category || '').trim(),
    dueDay: parseInt(item.dueDay, 10) || 1,
    amount: toNumber(item.amount, 0),
    paidFrom: item.paidFrom || '',
    matchWords: normalizeMatchWordsInput(item.matchWords || []),
    autopay: !!item.autopay,
    active: !!item.active,
    notes: item.notes || '',
    displayOrder: item.displayOrder ?? 0,
  };
}

export async function getMasterLists(forceReload = false) {
  if (_loaded && !forceReload) return _cache;
  try {
    const data = await apiGet('/api/master-lists');
    _cache = {
      loaded: true,
      error: '',
      expenseList: Array.isArray(data.expenseList) ? data.expenseList.map(mapItem) : [],
      recurringBillsList: Array.isArray(data.recurringBillsList) ? data.recurringBillsList.map(mapBill) : [],
    };
    _loaded = true;
  } catch (err) {
    _cache = {
      loaded: false,
      error: err.offline ? 'Backend not running on http://localhost:8787.' : err.message,
      expenseList: _cache?.expenseList || [],
      recurringBillsList: _cache?.recurringBillsList || [],
    };
  }
  return _cache;
}

export function getMasterListsCache() {
  return _cache || { loaded: false, error: '', expenseList: [], recurringBillsList: [] };
}

export function createExpenseItem(form) {
  return apiPost('/api/master-lists/expenses', form);
}

export function updateExpenseItem(id, form) {
  return apiPatch('/api/master-lists/expenses/' + encodeURIComponent(id), form);
}

export function toggleExpenseItemActive(id, activeNow) {
  return activeNow
    ? apiDelete('/api/master-lists/expenses/' + encodeURIComponent(id))
    : apiPatch('/api/master-lists/expenses/' + encodeURIComponent(id), { active: true });
}

export function createRecurringBill(form) {
  return apiPost('/api/master-lists/recurring-bills', form);
}

export function updateRecurringBill(id, form) {
  return apiPatch('/api/master-lists/recurring-bills/' + encodeURIComponent(id), form);
}

export function toggleRecurringBillActive(id, activeNow) {
  return activeNow
    ? apiDelete('/api/master-lists/recurring-bills/' + encodeURIComponent(id))
    : apiPatch('/api/master-lists/recurring-bills/' + encodeURIComponent(id), { active: true });
}
