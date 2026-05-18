import { apiGet, apiPatch, apiPost } from './client.js';

const TRANSACTIONS_MAX_LIMIT = 500;

export function clearTransactionDerivedCaches() {
  // Transaction-derived summaries are computed at render time from live API data.
  // This hook keeps restore refresh flows explicit and centralized.
}

export function getTransactions(params = {}) {
  return apiGet('/api/transactions', params);
}

export function normalizeTransactionRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

export async function getTransactionRows(params = {}) {
  const result = await getTransactions(params);
  return normalizeTransactionRows(result);
}

export async function getTransactionRowsForPeriod(period, options = {}) {
  if (!period?.startDate || !period?.exclusiveEndDate) {
    throw new Error('Transaction period requires startDate and exclusiveEndDate.');
  }

  const {
    limit: requestedLimit,
    offset: requestedOffset,
    ...filters
  } = options || {};
  const parsedLimit = Number.parseInt(requestedLimit, 10);
  const pageLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, TRANSACTIONS_MAX_LIMIT)
    : TRANSACTIONS_MAX_LIMIT;
  let offset = Number.parseInt(requestedOffset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const allRows = [];
  while (true) {
    const result = await getTransactions({
      ...filters,
      startDate: period.startDate,
      exclusiveEndDate: period.exclusiveEndDate,
      limit: pageLimit,
      offset,
    });
    const rows = normalizeTransactionRows(result);
    allRows.push(...rows);

    const pagination = result && !Array.isArray(result) ? result.pagination : null;
    if (!pagination) break;
    if (!pagination.hasNext || pagination.nextOffset === null || pagination.nextOffset === undefined) break;
    if (rows.length === 0 || Number(pagination.nextOffset) === offset) break;
    offset = Number(pagination.nextOffset);
  }

  return allRows;
}

export function getTransactionById(id) {
  return apiGet('/api/transactions/' + encodeURIComponent(id));
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
