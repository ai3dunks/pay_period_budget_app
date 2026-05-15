/**
 * shared/payrollDetection.js — Pure Cisco payroll detection logic.
 * No DOM, no fetch, no localStorage.
 */

import { isDateInBudgetPeriod } from './budgetPeriods.js';
import { parseJsonSafe } from './text.js';

const CISCO_PAYROLL_PATTERNS = [
  'CISCO SYSTEMS',
  'DES:PAYROLL',
  'CISCO PAYROLL',
];

function normalizeUpper(value) {
  return String(value || '').toUpperCase();
}

function collectPayrollSearchFields(transaction) {
  const raw = parseJsonSafe(transaction?.raw_json);
  return [
    transaction?.name,
    transaction?.description,
    transaction?.merchant_name,
    typeof transaction?.raw_json === 'string' ? transaction?.raw_json : null,
    raw?.original_description,
    raw?.name,
    raw?.merchant_name,
  ];
}

/**
 * Returns true if the transaction contains Cisco payroll identifiers.
 */
export function isCiscoPayrollTransaction(transaction) {
  const haystack = collectPayrollSearchFields(transaction)
    .map((v) => normalizeUpper(v))
    .filter(Boolean)
    .join(' ');
  return CISCO_PAYROLL_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/**
 * Return all Cisco payroll transactions that fall within the given period.
 * Filters out ignored transactions and non-positive amounts.
 */
export function getPayrollTransactionsForPeriod(transactions = [], period) {
  return (transactions || []).filter((transaction) => {
    if (!transaction) return false;
    if (transaction.ignored) return false;
    if (!isDateInBudgetPeriod(transaction.date, period)) return false;
    if (Number(transaction.amount || 0) <= 0) return false;
    return isCiscoPayrollTransaction(transaction);
  });
}

function getPrimaryDateValue(transaction) {
  return String(transaction?.date || '').slice(0, 10);
}

function getFallbackTimestamp(transaction) {
  const candidates = [
    transaction?.posted_datetime,
    transaction?.posted_at,
    transaction?.authorized_datetime,
    transaction?.authorized_date,
    transaction?.created_at,
    transaction?.date,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(String(candidate));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function comparePayrollTransactionsDesc(a, b) {
  const primaryDateCompare = getPrimaryDateValue(b).localeCompare(getPrimaryDateValue(a));
  if (primaryDateCompare !== 0) return primaryDateCompare;
  const fallbackCompare = getFallbackTimestamp(b) - getFallbackTimestamp(a);
  if (fallbackCompare !== 0) return fallbackCompare;
  return String(b?.id || '').localeCompare(String(a?.id || ''));
}

/**
 * Detect payroll income for a period.
 * Uses the latest Cisco payroll transaction by date.
 * If multiple are found, warns and returns only the latest one.
 *
 * @param {Array}   transactions - All transactions (pre-filtered to period preferred)
 * @param {object}  period       - Budget period { startDate, exclusiveEndDate }
 * @param {object}  options      - { includePendingTransactions }
 * @returns {{ detected, amount, count, selectedTransaction, transactions,
 *             ignoredDuplicatePayrollTransactions, selectedTransactionId, warning }}
 */
export function getDetectedPayrollIncome(transactions = [], period, options = {}) {
  const includePendingTransactions = options?.includePendingTransactions !== false;
  const payrollTransactions = getPayrollTransactionsForPeriod(transactions, period)
    .filter((transaction) => includePendingTransactions || !transaction?.pending)
    .slice()
    .sort(comparePayrollTransactionsDesc);

  const selectedTransaction = payrollTransactions[0] || null;
  const ignoredDuplicatePayrollTransactions = payrollTransactions.slice(1);
  const amount = selectedTransaction ? Number(selectedTransaction.amount || 0) : 0;
  const warning =
    payrollTransactions.length > 1
      ? 'Multiple Cisco payroll deposits found. Using the latest one for Budget Income.'
      : null;

  return {
    detected: payrollTransactions.length > 0,
    amount,
    count: payrollTransactions.length,
    selectedTransactionId: selectedTransaction?.id || null,
    selectedTransaction,
    transactions: payrollTransactions,
    ignoredDuplicatePayrollTransactions,
    warning,
  };
}
