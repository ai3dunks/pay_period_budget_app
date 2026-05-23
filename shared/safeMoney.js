/**
 * shared/safeMoney.js — Safe-to-spend and safe-to-transfer calculations.
 * No DOM, no fetch, no localStorage.
 */

import { toNumber } from './money.js';

const DEFAULT_SAFETY_BUFFER = 100;

function formatCurrencyLike(value) {
  return '$' + Math.abs(toNumber(value, 0)).toFixed(2);
}

function classifySafeMoneyAmount(amount, safetyBuffer, unavailable = false) {
  if (unavailable) return 'unavailable';
  const num = toNumber(amount, 0);
  if (num < 0) return 'danger';
  if (num < safetyBuffer) return 'warning';
  if (num < safetyBuffer * 2) return 'tight';
  return 'good';
}

function createSafeMoneyResult({ amount, safetyBuffer, unavailable = false, label, warnings = [], blockers = [], breakdown = {} }) {
  const status = classifySafeMoneyAmount(amount, safetyBuffer, unavailable);
  const finalAmount = unavailable ? null : toNumber(amount, 0);
  const displayLabel = unavailable
    ? 'Unavailable'
    : finalAmount < 0
      ? 'Short by ' + formatCurrencyLike(Math.abs(finalAmount))
      : formatCurrencyLike(finalAmount) + ' available';
  return {
    amount: finalAmount,
    status,
    label: label || displayLabel,
    warnings: Array.from(new Set((warnings || []).filter(Boolean))),
    blockers: Array.from(new Set((blockers || []).filter(Boolean))),
    breakdown,
  };
}

/**
 * Classify an amount relative to the safety buffer.
 * Returns 'good' | 'tight' | 'warning' | 'danger' | 'unavailable'.
 */
export function getSafeMoneyStatus(amount, safetyBuffer, unavailableReason) {
  if (unavailableReason) return 'unavailable';
  return classifySafeMoneyAmount(amount, safetyBuffer);
}

/**
 * Calculate Safe to Spend.
 *
 * Dashboard Safe to Spend = Needs remaining - reserved expense budget.
 *
 * Expenses are part of the Needs budget, so this deliberately does not
 * subtract planned transfers, Wants, Debt/Savings, or the safety buffer.
 */
export function calculateSafeToSpend(summaryInputs = {}) {
  const includePendingTransactions = !!summaryInputs.includePendingTransactions;
  const rawNeedsRemaining = summaryInputs.needsRemaining ?? summaryInputs.needsRemainingAfterBills;
  const hasNeedsRemaining = rawNeedsRemaining !== null && rawNeedsRemaining !== undefined;
  const needsRemaining = hasNeedsRemaining ? toNumber(rawNeedsRemaining, 0) : 0;
  const expenseBudgetRemaining = Math.max(0, toNumber(summaryInputs.expenseBudgetRemaining, 0));

  const warnings = [];
  const blockers = [];

  warnings.push(includePendingTransactions ? 'Pending transactions included.' : 'Pending transactions excluded.');

  if (!hasNeedsRemaining) blockers.push('Needs remaining unavailable');
  if (summaryInputs.expenseOverrun > 0) blockers.push('Expense budget overrun');

  const amount = needsRemaining - expenseBudgetRemaining;

  return createSafeMoneyResult({
    amount,
    safetyBuffer: 0,
    unavailable: !hasNeedsRemaining,
    warnings,
    blockers,
    breakdown: {
      needsRemaining,
      expenseBudgetRemaining,
      finalSafeToSpend: amount,
    },
  });
}

/**
 * Calculate Safe to Transfer.
 *
 * Safe to Transfer = boaCurrentBalance
 *   - unpaidBoaBills
 *   - pendingBoaSpending
 *   - safetyBuffer
 */
export function calculateSafeToTransfer(summaryInputs = {}) {
  const safetyBuffer = Math.max(0, toNumber(summaryInputs.safetyBuffer, DEFAULT_SAFETY_BUFFER));
  const includePendingTransactions = !!summaryInputs.includePendingTransactions;
  const boaAccount = summaryInputs.boaAccount || null;

  const rawBoaBalance = summaryInputs.boaCurrentBalance;
  const boaCurrentBalance =
    rawBoaBalance !== null && rawBoaBalance !== undefined
      ? toNumber(rawBoaBalance, 0)
      : null;

  const unpaidBoaBills = Math.max(0, toNumber(summaryInputs.unpaidBoaBills, 0));
  const pendingBoaSpending = Math.max(0, toNumber(summaryInputs.pendingBoaSpending, 0));

  const warnings = [];
  const blockers = [];
  warnings.push(includePendingTransactions ? 'Pending transactions included.' : 'Pending transactions excluded.');

  const failShape = {
    boaCurrentBalance: null,
    unpaidBoaBills,
    pendingBoaSpending,
    safetyBuffer,
    finalSafeToTransfer: null,
  };

  if (!boaAccount) {
    blockers.push('Bank of America account could not be identified.');
    return createSafeMoneyResult({ amount: null, safetyBuffer, unavailable: true, warnings, blockers, breakdown: failShape });
  }

  if (boaCurrentBalance === null) {
    blockers.push('Bank of America balance is unavailable.');
    return createSafeMoneyResult({ amount: null, safetyBuffer, unavailable: true, warnings, blockers, breakdown: failShape });
  }

  if (unpaidBoaBills > 0) blockers.push(formatCurrencyLike(unpaidBoaBills) + ' in unpaid BOA bills');
  if (includePendingTransactions && pendingBoaSpending > 0) blockers.push('Pending BOA spending included');

  const amount = boaCurrentBalance - unpaidBoaBills - pendingBoaSpending - safetyBuffer;

  return createSafeMoneyResult({
    amount,
    safetyBuffer,
    unavailable: false,
    warnings,
    blockers,
    breakdown: {
      boaCurrentBalance,
      unpaidBoaBills,
      pendingBoaSpending,
      safetyBuffer,
      finalSafeToTransfer: amount,
    },
  });
}

/**
 * Build a human-readable breakdown object for display.
 */
export function buildSafeMoneyBreakdown(summaryInputs = {}) {
  const safeToSpend = calculateSafeToSpend(summaryInputs);
  const safeToTransfer = calculateSafeToTransfer(summaryInputs);
  return {
    safeToSpend,
    safeToTransfer,
    safetyBuffer: toNumber(summaryInputs.safetyBuffer, DEFAULT_SAFETY_BUFFER),
    includePendingTransactions: !!summaryInputs.includePendingTransactions,
  };
}
