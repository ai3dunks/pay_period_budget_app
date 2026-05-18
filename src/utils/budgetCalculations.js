// Temporary compatibility wrapper. Shared logic lives in /shared.
export {
  calculateBudgetSplit,
  calculateWantsActuals,
  calculateTransferPlan,
  calculateFlexibleBudgetSplitEngine,
  DEFAULT_TRANSFER_TARGETS,
  getTransferTargetsConfig,
  isTransferTargetsConfigMissing,
} from '../../shared/transfers.js';
export { calculateExpenseBudget } from '../../shared/expenses.js';
export {
  calculateRecurringBillsDue,
  getRecurringBillsDueInPeriod,
  getBillsDueInPeriod,
  getRecurringBillDueDate,
  calculateRecurringBillTotals as calculateRecurringBillsTotals,
} from '../../shared/recurringBills.js';

// Keep locally: getBudgetIncome (used by dashboardCalculations.js) and formatters
export function getBudgetIncome({ periodId, manualIncomeByPeriod = {}, autoDetectedIncomeByPeriod = {} }) {
  const manualIncome = manualIncomeByPeriod?.[periodId] ?? null;
  const autoDetectedIncome = autoDetectedIncomeByPeriod?.[periodId] ?? null;
  const hasManualIncome = manualIncome !== null && manualIncome !== undefined;
  const hasDetectedIncome = autoDetectedIncome !== null && autoDetectedIncome !== undefined;
  const value = hasManualIncome
    ? Number(manualIncome || 0)
    : hasDetectedIncome
      ? Number(autoDetectedIncome || 0)
      : 0;
  return {
    value,
    manualIncome,
    autoDetectedIncome,
    hasManualIncome,
    hasDetectedIncome,
    sourceLabel: hasManualIncome
      ? 'Manual override'
      : hasDetectedIncome
        ? 'Cisco payroll'
        : 'No income found',
  };
}

export function formatCurrencyValue(value) {
  return '$' + Number(value || 0).toFixed(2);
}

export function formatSignedCurrencyValue(value) {
  const amount = Number(value || 0);
  const prefix = amount < 0 ? '-' : amount > 0 ? '+' : '';
  return prefix + '$' + Math.abs(amount).toFixed(2);
}
