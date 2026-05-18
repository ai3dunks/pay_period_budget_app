/**
 * shared/recurringBills.js — Recurring bill due-date and matching helpers.
 * No DOM, no fetch, no localStorage.
 */

import { parseLocalDate, toDateKey } from './dates.js';
import { isDateInBudgetPeriod } from './budgetPeriods.js';
import { normalizeText, parseMatchWords } from './text.js';
import { toNumber } from './money.js';

/**
 * Build a map of { recurringBillId → statusRow } from an array of status rows.
 */
function buildStatusMap(billStatusRows = []) {
  const map = {};
  for (const row of billStatusRows || []) {
    if (row?.recurringBillId) map[row.recurringBillId] = row;
  }
  return map;
}

/**
 * Return the due Date for a bill within a period, or null if not due.
 * Handles cross-month periods (e.g. May 22 – June 4).
 */
export function getBillDueDateForPeriod(bill, period) {
  if (!period?.startDate || !period?.exclusiveEndDate) return null;

  const periodStart = parseLocalDate(period.startDate);
  const periodEnd = parseLocalDate(period.exclusiveEndDate);
  const startMonth = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
  const endMonth = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);

  const rawDueDay = Number(bill.dueDay || bill.due_day || 1);
  const dueDay = Number.isFinite(rawDueDay) ? Math.max(1, Math.min(31, Math.trunc(rawDueDay))) : 1;

  let cursor = new Date(startMonth);
  while (cursor <= endMonth) {
    const lastDayOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const safeDay = Math.min(dueDay, lastDayOfMonth);
    const candidate = new Date(cursor.getFullYear(), cursor.getMonth(), safeDay);
    if (candidate >= periodStart && candidate < periodEnd) return candidate;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return null;
}

/**
 * Return all active recurring bills that are due within the period,
 * each decorated with { dueDate: Date, dueDateStr: string }.
 */
export function getRecurringBillsDueInPeriod(recurringBills = [], period) {
  if (!period?.startDate || !period?.exclusiveEndDate) return [];
  return (recurringBills || [])
    .filter((bill) => !!bill?.active)
    .map((bill) => {
      const dueDate = getBillDueDateForPeriod(bill, period);
      if (!dueDate) return null;
      return {
        ...bill,
        dueDate,
        dueDateStr: dueDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.dueDate - b.dueDate);
}

/** Alias kept for backward compat */
export const getBillsDueInPeriod = getRecurringBillsDueInPeriod;

/**
 * @deprecated Use getRecurringBillsDueInPeriod. Kept for backward compat.
 */
export function getRecurringBillDueDate(bill, periodStart) {
  const dueDate = new Date(periodStart);
  dueDate.setDate(Number(bill.dueDay || bill.due_day || 1));
  if (dueDate < periodStart) dueDate.setMonth(dueDate.getMonth() + 1);
  return dueDate;
}

/**
 * Calculate totals from a bills array + a status map.
 */
export function calculateRecurringBillTotals(billsDue = [], statusMap = {}) {
  return billsDue.reduce(
    (acc, bill) => {
      const amount = toNumber(bill.amount, 0);
      acc.total += amount;
      const status = statusMap[bill.id];
      if (status?.paid) {
        acc.alreadyPaid += amount;
      } else {
        acc.leftToPay += amount;
      }
      if (status?.matchStatus === 'Possible match') acc.possibleMatches += 1;
      return acc;
    },
    { total: 0, alreadyPaid: 0, leftToPay: 0, possibleMatches: 0 }
  );
}

/**
 * Attach a status object to a bill row.
 */
export function mapRecurringBillStatus(bill, status) {
  return { ...bill, status: status || null };
}

/**
 * Score how well a transaction matches a recurring bill.
 * Returns { score: 0-100, reasons: string[] }.
 */
export function scoreRecurringBillPaymentMatch(bill, transaction, dueDate, options = {}) {
  if (!bill || !transaction) return { score: 0, reasons: [] };

  const reasons = [];
  let score = 0;

  // Amount match
  const billAmount = Math.abs(toNumber(bill.amount, 0));
  const txnAmount = Math.abs(toNumber(transaction.amount, 0));
  if (billAmount > 0 && Math.abs(billAmount - txnAmount) < 0.01) {
    score += 40;
    reasons.push('Exact amount match');
  } else if (billAmount > 0 && Math.abs(billAmount - txnAmount) / billAmount < 0.05) {
    score += 20;
    reasons.push('Close amount match');
  }

  // Match words
  const matchWords = parseMatchWords(bill.matchWords || bill.match_words || '');
  if (matchWords.length > 0) {
    const txnText = normalizeText(
      [transaction.name, transaction.merchant_name, transaction.description].filter(Boolean).join(' ')
    );
    const matched = matchWords.filter((word) => txnText.includes(word));
    if (matched.length > 0) {
      score += 30;
      reasons.push('Match word: ' + matched[0]);
    }
  }

  // Date proximity
  if (dueDate) {
    const txnDate = transaction.date ? parseLocalDate(String(transaction.date).slice(0, 10)) : null;
    if (txnDate) {
      const diffDays = Math.abs((txnDate - dueDate) / (1000 * 60 * 60 * 24));
      if (diffDays <= 1) {
        score += 20;
        reasons.push('Date matches due date');
      } else if (diffDays <= 5) {
        score += 10;
        reasons.push('Date close to due date');
      }
    }
  }

  // Autopay boost
  if (bill.autopay) {
    score += 5;
    reasons.push('Autopay bill');
  }

  return { score: Math.min(100, score), reasons };
}

/**
 * Find the best-matching transaction for each bill due in the period.
 * Returns an array of { bill, transaction, score, reasons, matchStatus }.
 */
export function findRecurringBillMatches(billsDue = [], transactions = [], options = {}) {
  const results = [];
  for (const bill of billsDue || []) {
    let bestMatch = null;
    let bestScore = 0;
    let bestReasons = [];

    for (const txn of transactions || []) {
      const { score, reasons } = scoreRecurringBillPaymentMatch(bill, txn, bill.dueDate, options);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = txn;
        bestReasons = reasons;
      }
    }

    const matchStatus =
      bestScore >= 70 ? 'Matched' : bestScore >= 40 ? 'Possible match' : 'No match';

    results.push({
      bill,
      transaction: bestMatch,
      score: bestScore,
      reasons: bestReasons,
      matchStatus,
    });
  }
  return results;
}

/**
 * Main helper: build the full recurring-bills-due structure including statuses
 * and unpaid totals.
 *
 * @param {{ recurringBillsList, period, billStatusRows }} opts
 * @returns {{ statusMap, billsDue, billsDueWithStatus, categoryActuals,
 *             unpaidBills, unpaidTotal }}
 */
export function calculateRecurringBillsDue({ recurringBillsList = [], period, billStatusRows = [] }) {
  const statusMap = buildStatusMap(billStatusRows);
  const billsDue = getRecurringBillsDueInPeriod(recurringBillsList, period);
  const billsDueWithStatus = billsDue.map((bill) => ({
    ...bill,
    status: statusMap[bill.id] || null,
  }));

  const categoryActuals = { Needs: 0, Wants: 0, 'Debts/Savings': 0 };
  for (const bill of billsDueWithStatus) {
    const category = String(bill.category || '').trim();
    if (Object.prototype.hasOwnProperty.call(categoryActuals, category)) {
      categoryActuals[category] += toNumber(bill.amount, 0);
    }
  }

  const unpaidBills = billsDueWithStatus.filter((bill) => !(bill.status?.paid));
  const unpaidTotal = unpaidBills.reduce((sum, bill) => sum + toNumber(bill.amount, 0), 0);

  return {
    statusMap,
    billsDue,
    billsDueWithStatus,
    categoryActuals,
    unpaidBills,
    unpaidTotal,
  };
}
