/**
 * shared/expenses.js — Expense budget and actuals helpers.
 * No DOM, no fetch, no localStorage.
 */

import { isDateInBudgetPeriod } from './budgetPeriods.js';
import { normalizeText } from './text.js';
import { toNumber } from './money.js';

/**
 * Calculate total expense budget from the active expense list items.
 */
export function calculateExpenseBudget(expenseList = []) {
  const activeExpenseList = (expenseList || []).filter((item) => item && item.active);
  const totalExpenseBudget = activeExpenseList.reduce(
    (sum, item) => sum + toNumber(item.budgetAmount, 0),
    0
  );
  const topBudgets = activeExpenseList
    .map((item) => ({ name: item.name, budgetAmount: toNumber(item.budgetAmount, 0) }))
    .sort((a, b) => b.budgetAmount - a.budgetAmount)
    .slice(0, 5);
  return {
    totalExpenseBudget,
    activeCount: activeExpenseList.length,
    topBudgets,
  };
}

/**
 * Return only Expense-type, non-ignored transactions in the given period.
 * Respects includePendingTransactions setting.
 */
export function getExpenseTransactionsForPeriod(transactions = [], period, settings = {}) {
  const includePending =
    settings?.includePendingTransactions === true || settings?.includePending === true;
  return (transactions || []).filter((row) => {
    if (!row || row.ignored) return false;
    if (!includePending && row.pending) return false;
    if (normalizeText(row.type) !== 'expense') return false;
    return isDateInBudgetPeriod(row.date, period);
  });
}

/**
 * Expand finalized expense splits into split-line transactions.
 * Non-final splits keep the original parent transaction.
 */
export function expandExpenseTransactionsWithFinalSplits(transactions = []) {
  const expanded = [];

  for (const row of transactions || []) {
    if (!row || row.ignored) continue;
    if (normalizeText(row.type) !== 'expense') {
      expanded.push(row);
      continue;
    }

    const splitLines = Array.isArray(row.split_lines) ? row.split_lines : [];
    const isFinalSplit = row.split_is_final === true;
    if (!isFinalSplit || !splitLines.length) {
      expanded.push(row);
      continue;
    }

    const parentAmount = toNumber(row.amount, 0);
    const signedDirection = parentAmount < 0 ? -1 : 1;
    const normalizedLines = splitLines
      .map((line) => {
        const amount = Math.abs(toNumber(line?.amount, 0));
        if (amount <= 0) return null;
        return {
          category: String(line?.category || '').trim(),
          subcategory: String(line?.subcategory || '').trim(),
          note: String(line?.note || '').trim(),
          amount,
        };
      })
      .filter(Boolean);

    if (!normalizedLines.length) {
      expanded.push(row);
      continue;
    }

    for (const split of normalizedLines) {
      expanded.push({
        ...row,
        category: split.category,
        subcategory: split.subcategory,
        split_note: split.note,
        amount: signedDirection * split.amount,
        split_parent_transaction_id: row.id,
        split_is_line: true,
      });
    }
  }

  return expanded;
}

/**
 * Calculate actual expense spending, grouped by category.
 * Returns { totalActual, byCategory: Map<normalizedName, number> }.
 */
export function calculateExpenseActuals(transactions = [], expenseList = [], period, settings = {}) {
  const expenseTxns = expandExpenseTransactionsWithFinalSplits(
    getExpenseTransactionsForPeriod(transactions, period, settings)
  );
  const byCategory = new Map();
  for (const row of expenseTxns) {
    const key = normalizeText(row.category || 'uncategorized');
    byCategory.set(key, (byCategory.get(key) || 0) + Math.abs(toNumber(row.amount, 0)));
  }
  const totalActual = expenseTxns.reduce((sum, row) => sum + Math.abs(toNumber(row.amount, 0)), 0);
  return { totalActual, byCategory };
}

/**
 * Build per-category budget vs actual rows for all active expense items.
 */
export function calculateExpenseCategoryRows(expenseList = [], transactions = [], period, settings = {}) {
  const { byCategory } = calculateExpenseActuals(transactions, expenseList, period, settings);
  return (expenseList || [])
    .filter((item) => !!item?.active)
    .map((item) => {
      const key = normalizeText(item.name);
      const budget = toNumber(item.budgetAmount, 0);
      const actual = toNumber(byCategory.get(key), 0);
      return {
        name: item.name,
        budget,
        actual,
        remaining: budget - actual,
        overBudget: budget > 0 && actual > budget,
      };
    });
}

/**
 * Return expense-type transactions that have no matching category in the expense list.
 */
export function getUncategorizedExpenseTransactions(
  transactions = [],
  expenseList = [],
  period,
  settings = {}
) {
  const expenseTxns = expandExpenseTransactionsWithFinalSplits(
    getExpenseTransactionsForPeriod(transactions, period, settings)
  );
  const knownCategories = new Set(
    (expenseList || []).filter((item) => item?.active).map((item) => normalizeText(item.name))
  );
  return expenseTxns.filter((row) => {
    const cat = normalizeText(row.category || '');
    return !cat || !knownCategories.has(cat);
  });
}
