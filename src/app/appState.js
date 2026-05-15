import {
  generateBudgetPeriods,
  getCurrentBudgetPeriod,
  getSelectedBudgetPeriod,
  setSelectedBudgetPeriod,
} from '../utils/budgetPeriods.js';

const BUDGET_ANCHOR_DATE = '2026-05-08';

const state = {
  activeTab: 'dashboard',
  selectedPeriodId: null,
  periods: generateBudgetPeriods(BUDGET_ANCHOR_DATE, 16, 16),
};

const listeners = [];

function notify() {
  for (const fn of listeners) {
    try { fn(state); } catch (_e) { /* ignore listener errors */ }
  }
}

function resolveInitialPeriodId(periods) {
  const stored = getSelectedBudgetPeriod();
  if (stored && periods.some((p) => p.id === stored)) return stored;
  const current = getCurrentBudgetPeriod(periods, new Date());
  return (current || periods[0]).id;
}

state.selectedPeriodId = resolveInitialPeriodId(state.periods);

export function getAppState() {
  return {
    activeTab: state.activeTab,
    selectedPeriodId: state.selectedPeriodId,
    periods: state.periods,
  };
}

export function setActiveTab(tab) {
  state.activeTab = tab;
  notify();
}

export function setSelectedPeriodId(periodId) {
  if (!periodId || !state.periods.some((p) => p.id === periodId)) return;
  state.selectedPeriodId = periodId;
  setSelectedBudgetPeriod(periodId);
  notify();
}

export function getActivePeriod() {
  const found = state.periods.find((p) => p.id === state.selectedPeriodId);
  if (found) return found;
  return getCurrentBudgetPeriod(state.periods, new Date()) || state.periods[0];
}

export function subscribe(listener) {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}
