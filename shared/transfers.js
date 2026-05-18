/**
 * shared/transfers.js — Transfer plan and wants-actuals helpers.
 * No DOM, no fetch, no localStorage.
 */

import { isDateInBudgetPeriod } from './budgetPeriods.js';
import { toNumber } from './money.js';
import { normalizeText } from './text.js';

const DEFAULT_BUDGET_SPLIT = { Needs: 60, Wants: 20, 'Debts/Savings': 20 };
const BUDGET_CATEGORIES = ['Needs', 'Wants', 'Debts/Savings'];

function normalizeGroupName(value) {
  const key = normalizeText(value);
  if (key === 'needs') return 'Needs';
  if (key === 'wants') return 'Wants';
  if (key === 'debts/savings' || key === 'debt/savings' || key === 'debtsavings' || key === 'debts' || key === 'savings') {
    return 'Debts/Savings';
  }
  return null;
}

function normalizeSplitInput(splitSettings = {}) {
  const source = splitSettings?.default && typeof splitSettings.default === 'object'
    ? splitSettings.default
    : splitSettings;

  const needs = toNumber(source.Needs ?? source.needs_percent ?? DEFAULT_BUDGET_SPLIT.Needs, DEFAULT_BUDGET_SPLIT.Needs);
  const wants = toNumber(source.Wants ?? source.wants_percent ?? DEFAULT_BUDGET_SPLIT.Wants, DEFAULT_BUDGET_SPLIT.Wants);
  const debtsSavings = toNumber(
    source['Debts/Savings'] ?? source.debts_savings_percent ?? DEFAULT_BUDGET_SPLIT['Debts/Savings'],
    DEFAULT_BUDGET_SPLIT['Debts/Savings']
  );

  return {
    Needs: needs,
    Wants: wants,
    'Debts/Savings': debtsSavings,
  };
}

/**
 * Calculate how the budget income is split across Needs / Wants / Debts/Savings
 * categories, taking recurring bills as actuals for each category.
 */
export function calculateBudgetSplit({ budgetIncome, recurringBillsDue = [], splitSettings = {} }) {
  const income = toNumber(budgetIncome, 0);
  const rows = BUDGET_CATEGORIES.map((category) => {
    const percent = splitSettings[category] ?? DEFAULT_BUDGET_SPLIT[category] ?? 0;
    const allotted = (income * percent) / 100;
    const actual = (recurringBillsDue || []).reduce((sum, bill) => {
      if (String(bill.category || '').trim() !== category) return sum;
      return sum + toNumber(bill.amount, 0);
    }, 0);
    return {
      category,
      percent,
      allotted,
      actual,
      remaining: allotted - actual,
    };
  });
  return {
    rows,
    total: {
      percent: 100,
      allotted: income,
      actual: (recurringBillsDue || []).reduce((sum, bill) => sum + toNumber(bill.amount, 0), 0),
      remaining:
        income -
        (recurringBillsDue || []).reduce((sum, bill) => sum + toNumber(bill.amount, 0), 0),
    },
  };
}

/**
 * Return Wants-type transactions in the period, broken down by Josh / Taylor / Split.
 */
export function calculateWantsActuals({ transactions = [], period }) {
  const wantsRows = (transactions || []).filter((row) => {
    if (!row || row.ignored) return false;
    if (normalizeText(row.type) !== 'wants') return false;
    return isDateInBudgetPeriod(row.date, period);
  });

  let joshDirect = 0;
  let taylorDirect = 0;
  let splitTotal = 0;

  for (const row of wantsRows) {
    const amount = Math.abs(toNumber(row.amount, 0));
    const category = normalizeText(row.category || '');
    if (category === 'josh') joshDirect += amount;
    else if (category === 'taylor') taylorDirect += amount;
    else if (category === 'split') splitTotal += amount;
  }

  const joshSplitShare = splitTotal / 2;
  const taylorSplitShare = splitTotal / 2;
  const joshActual = joshDirect + joshSplitShare;
  const taylorActual = taylorDirect + taylorSplitShare;

  return {
    wantsRows,
    joshDirect,
    taylorDirect,
    splitTotal,
    joshSplitShare,
    taylorSplitShare,
    joshActual,
    taylorActual,
  };
}

/**
 * Calculate transfer amounts (Josh, Taylor, Discover, Debt/Savings) from
 * budget split and wants actuals.
 *
 * Rules:
 * - Josh + Taylor each get half of wants-remaining after their actual spending
 * - Discover gets Needs remaining (up to expense budget), Debt/Savings fills shortfall
 */
export function calculateTransferPlan({ splitSummary, expenseBudget, wantsActuals }) {
  const splitRowByCategory = {};
  for (const row of splitSummary?.rows || []) {
    splitRowByCategory[row.category] = row;
  }

  const wantsRemaining = toNumber(splitRowByCategory.Wants?.remaining, 0);
  const needsRemaining = toNumber(splitRowByCategory.Needs?.remaining, 0);
  const debtSavingsRemaining = toNumber(splitRowByCategory['Debts/Savings']?.remaining, 0);

  const joshBaseShare = Math.max(0, wantsRemaining) / 2;
  const taylorBaseShare = Math.max(0, wantsRemaining) / 2;
  const joshOverused = Math.max(0, toNumber(wantsActuals?.joshActual, 0) - joshBaseShare);
  const taylorOverused = Math.max(0, toNumber(wantsActuals?.taylorActual, 0) - taylorBaseShare);
  const joshTransfer = Math.max(0, joshBaseShare - toNumber(wantsActuals?.joshActual, 0));
  const taylorTransfer = Math.max(0, taylorBaseShare - toNumber(wantsActuals?.taylorActual, 0));

  const discoverTarget = toNumber(expenseBudget?.totalExpenseBudget, 0);
  const needsToDiscover = Math.min(Math.max(0, needsRemaining), discoverTarget);
  const shortfallAfterNeeds = discoverTarget - needsToDiscover;

  let debtSavingsRedirect = 0;
  if (needsRemaining < discoverTarget) {
    debtSavingsRedirect = Math.min(Math.max(0, debtSavingsRemaining), shortfallAfterNeeds);
  }

  const discoverTransfer = needsToDiscover + debtSavingsRedirect;
  const discoverShortfall = Math.max(0, discoverTarget - discoverTransfer);
  const debtSavingsTransfer = Math.max(0, Math.max(0, debtSavingsRemaining) - debtSavingsRedirect);
  const totalPlannedTransfers =
    joshTransfer + taylorTransfer + discoverTransfer + debtSavingsTransfer;

  return {
    wantsRemaining,
    needsRemaining,
    debtSavingsRemaining,
    joshBaseShare,
    taylorBaseShare,
    joshTransfer,
    taylorTransfer,
    joshOverused,
    taylorOverused,
    discoverTarget,
    needsToDiscover,
    debtSavingsRedirect,
    discoverTransfer,
    discoverShortfall,
    debtSavingsTransfer,
    totalPlannedTransfers,
  };
}

/**
 * Score how well a transaction matches a transfer checklist item.
 * Returns { score: 0-100, reasons: string[] }.
 */
export function scoreTransferMatch(checklistItem, transaction, options = {}) {
  if (!checklistItem || !transaction) return { score: 0, reasons: [] };

  const reasons = [];
  let score = 0;

  const expectedAmount = Math.abs(toNumber(checklistItem.amount, 0));
  const txnAmount = Math.abs(toNumber(transaction.amount, 0));

  if (expectedAmount > 0 && Math.abs(expectedAmount - txnAmount) < 0.01) {
    score += 50;
    reasons.push('Exact amount match');
  } else if (expectedAmount > 0 && Math.abs(expectedAmount - txnAmount) / expectedAmount < 0.05) {
    score += 25;
    reasons.push('Close amount match');
  }

  const targetKey = normalizeText(checklistItem.targetKey || checklistItem.target || '');
  const txnText = normalizeText(
    [transaction.name, transaction.merchant_name, transaction.description].filter(Boolean).join(' ')
  );
  if (targetKey && txnText.includes(targetKey)) {
    score += 30;
    reasons.push('Target name in transaction');
  }

  return { score: Math.min(100, score), reasons };
}

/**
 * Evaluate completion status of a transfer checklist (array of { targetKey, amount, ... })
 * against actual transactions in the period.
 */
export function calculateTransferChecklistStatus(checklistItems = [], transactions = [], period, settings = {}) {
  const includePending =
    settings?.includePendingTransactions === true || settings?.includePending === true;

  const periodTxns = (transactions || []).filter((row) => {
    if (!row || row.ignored) return false;
    if (!includePending && row.pending) return false;
    return isDateInBudgetPeriod(row.date, period);
  });

  return (checklistItems || []).map((item) => {
    let bestMatch = null;
    let bestScore = 0;
    let bestReasons = [];

    for (const txn of periodTxns) {
      const { score, reasons } = scoreTransferMatch(item, txn, settings);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = txn;
        bestReasons = reasons;
      }
    }

    return {
      ...item,
      matchTransaction: bestMatch,
      matchScore: bestScore,
      matchReasons: bestReasons,
      completed: bestScore >= 50,
      completedAmount: bestMatch ? Math.abs(toNumber(bestMatch.amount, 0)) : 0,
    };
  });
}

/**
 * Flexible percentage-based budget split engine (Needs / Wants / Debts/Savings).
 * Actuals come from recurring bills due in the selected pay period.
 */
export function calculateFlexibleBudgetSplitEngine({
  budgetIncome = 0,
  recurringBillsDue = [],
  splitSettings = {},
}) {
  const income = toNumber(budgetIncome, 0);
  const percents = normalizeSplitInput(splitSettings);
  const percentTotal = toNumber(percents.Needs, 0) + toNumber(percents.Wants, 0) + toNumber(percents['Debts/Savings'], 0);

  const actualByGroup = {
    Needs: 0,
    Wants: 0,
    'Debts/Savings': 0,
  };

  for (const row of recurringBillsDue || []) {
    if (!row) continue;
    const group = normalizeGroupName(row.budget_group ?? row.category);
    if (!group) continue;
    actualByGroup[group] += Math.abs(toNumber(row.amount, 0));
  }

  const rows = BUDGET_CATEGORIES.map((group) => {
    const percent = toNumber(percents[group], 0);
    const allotted = income * percent / 100;
    const actual = actualByGroup[group] || 0;
    return {
      group,
      percent,
      allotted,
      actual,
      remaining: allotted - actual,
    };
  });

  const totalActual = rows.reduce((sum, row) => sum + toNumber(row.actual, 0), 0);
  const totalRemaining = income - totalActual;
  const deltaTo100 = 100 - percentTotal;
  const validation = {
    isValid: Math.abs(deltaTo100) < 0.0001,
    percentTotal,
    message:
      deltaTo100 > 0.0001
        ? 'Budget percentages must equal 100%. You still have ' + deltaTo100.toFixed(2) + '% unassigned.'
        : deltaTo100 < -0.0001
          ? 'Budget percentages exceed 100%. Reduce by ' + Math.abs(deltaTo100).toFixed(2) + '%. '
          : '',
  };

  return {
    income,
    rows,
    totals: {
      allotted: income,
      actual: totalActual,
      remaining: totalRemaining,
    },
    validation,
  };
}
