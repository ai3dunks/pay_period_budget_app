// Temporary compatibility wrapper. Shared logic lives in /shared.
// Note: Cannot use export * because getSelectedBudgetPeriod has different signature.
// shared: getSelectedBudgetPeriod(periods, selectedPeriodId) — pure
// frontend: getSelectedBudgetPeriod() — reads localStorage (no-args)
export {
  generateBudgetPeriods,
  getCurrentBudgetPeriod,
  isDateInBudgetPeriod,
  formatBudgetPeriodLabel,
  getPreviousBudgetPeriod,
  getNextBudgetPeriod,
  parseLocalDate,
  addDays,
  toDateKey,
} from '../../shared/budgetPeriods.js';

// Frontend-only: localStorage persistence
const UI_STORAGE_KEY = 'budgetDashboardSelectedPeriod';

export function getSelectedBudgetPeriod() {
  try {
    return localStorage.getItem(UI_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setSelectedBudgetPeriod(periodId) {
  try {
    localStorage.setItem(UI_STORAGE_KEY, periodId);
  } catch {}
}
