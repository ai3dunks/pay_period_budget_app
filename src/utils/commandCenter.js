/**
 * Command Center — centralized feature toggle system.
 *
 * Settings are stored in the SQLite-backed settings API under key "command_center".
 * All functions are pure / side-effect-free except updateCommandCenterFeature,
 * resetCommandCenterPage, and resetAllCommandCenterDefaults which call the API.
 */

import { getSetting, updateSetting } from '../api/settingsApi.js';

export const COMMAND_CENTER_SETTING_KEY = 'command_center';

export function clearCommandCenterCache() {
  // Command Center settings are loaded from settings API on demand.
  // This hook keeps restore refresh flows explicit and centralized.
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const COMMAND_CENTER_DEFAULTS = {
  dashboard: {
    pageEnabled: true,
    showPayPeriodCard: true,
    showBudgetSummaryCards: true,
    showSafeToSpendCard: true,
    showTransferSummaryCard: true,
    showCashFlowPreview: false,
    showDebtPreview: false,
    showDebugPanels: false,
  },
  transactions: {
    pageEnabled: true,
    showBankTabs: true,
    showReviewQueue: true,
    showSplitTransactionTools: true,
    showAdvancedFilters: true,
    showRawPlaidDetails: false,
  },
  recurringBills: {
    pageEnabled: true,
    showBillMatchingTools: true,
    showAutoPaidDetection: true,
    showAdvancedBillRules: false,
  },
  expenses: {
    pageEnabled: true,
    showExpenseCategoryManager: true,
    showUncategorizedWarnings: true,
  },
  transfers: {
    pageEnabled: true,
    showDiscoverTransferPlan: true,
    showDebtSavingsTransferPlan: true,
    showJoshTaylorSplit: true,
    showTransferMatching: true,
    showAdvancedTransferMath: false,
  },
  debtSnowball: {
    pageEnabled: true,
    showDebtAccounts: true,
    showCurrentBalanceDistribution: true,
    showAvailableExtraDebtPayment: true,
    showPayoffProjection: true,
  },
  cashFlowForecast: {
    pageEnabled: true,
    showProjectedBalances: true,
    showScenarioTools: false,
  },
  reports: {
    pageEnabled: true,
    showSpendingTrends: true,
    showCategoryReports: true,
    showIncomeReports: true,
    showExportTools: true,
  },
  dataHealth: {
    pageEnabled: true,
    showPlaidHealth: true,
    showClassificationHealth: true,
    showSplitHealth: true,
    showBillMatchHealth: true,
    showTransferHealth: true,
  },
  paycheckPlanner: {
    pageEnabled: true,
    showDetectedPayrollIncome: true,
    showManualOverride: true,
    showIncomeBreakdown: true,
  },
  history: {
    pageEnabled: true,
    showPayPeriodHistory: true,
    showSnapshotComparison: true,
  },
  closeout: {
    pageEnabled: true,
  },
  masterLists: {
    pageEnabled: true,
  },
  settings: {
    showPlaidConnections: true,
    showAccountTabNames: true,
    showRulesManager: true,
    showDataTools: true,
    showSafeMoney: true,
    showCommandCenter: true,
  },
};

// ── Presets ───────────────────────────────────────────────────────────────────

export const PRESETS = {
  clean: {
    label: 'Clean Mode',
    description: 'Core decision-making cards only. Hides advanced tools, debug panels, and experimental features.',
    overrides: {
      dashboard: { showCashFlowPreview: false, showDebtPreview: false, showDebugPanels: false },
      transactions: { showRawPlaidDetails: false },
      recurringBills: { showAdvancedBillRules: false },
      transfers: { showAdvancedTransferMath: false },
      cashFlowForecast: { showScenarioTools: false },
      settings: { showDataTools: true, showSafeMoney: true },
    },
  },
  advanced: {
    label: 'Advanced Mode',
    description: 'Enables most tools and features. Debug panels remain off.',
    overrides: {
      dashboard: { showCashFlowPreview: true, showDebtPreview: true, showDebugPanels: false },
      transactions: { showAdvancedFilters: true, showRawPlaidDetails: false },
      recurringBills: { showAdvancedBillRules: true },
      transfers: { showAdvancedTransferMath: true },
      cashFlowForecast: { showScenarioTools: true },
      settings: { showDataTools: true, showSafeMoney: true },
    },
  },
  developer: {
    label: 'Developer Mode',
    description: 'Enables debug panels and raw data views on all pages.',
    overrides: Object.fromEntries(
      Object.keys(COMMAND_CENTER_DEFAULTS).map((page) => [
        page,
        { showDebugPanels: true, ...(COMMAND_CENTER_DEFAULTS[page].showRawPlaidDetails !== undefined ? { showRawPlaidDetails: true } : {}) },
      ])
    ),
  },
};

// ── Per-toggle metadata (labels + descriptions) ───────────────────────────────

export const TOGGLE_META = {
  dashboard: {
    showPayPeriodCard: { label: 'Pay Period Summary Card', description: 'Income, bills, and budget overview at the top.' },
    showBudgetSummaryCards: { label: 'Budget Summary Cards', description: 'Spending watchlists and envelope summary.' },
    showSafeToSpendCard: { label: 'Safe to Spend Card', description: 'Shows calculated safe-to-spend amount.' },
    showTransferSummaryCard: { label: 'Transfer Summary Card', description: 'Transfer plan and budget split actions.' },
    showCashFlowPreview: { label: 'Cash Flow Preview', description: 'Mini cash flow forecast card on dashboard.' },
    showDebtPreview: { label: 'Reports/Debt Preview', description: 'Quick snapshot of recent reports data.' },
    showDebugPanels: { label: 'Debug Panels', description: 'Raw JSON and diagnostic panels (developer use).' },
  },
  transactions: {
    showBankTabs: { label: 'Bank Account Tabs', description: 'Tab strip to filter by bank account.' },
    showReviewQueue: { label: 'Review Queue Stats', description: 'Reviewed / Needs Review count cards.' },
    showSplitTransactionTools: { label: 'Split Transaction Tools', description: 'Split button and split editor popup.' },
    showAdvancedFilters: { label: 'Advanced Filters', description: 'Type, reviewed status, and show-ignored filters.' },
    showRawPlaidDetails: { label: 'Raw Plaid Details', description: 'Institution name and raw Plaid data columns.' },
  },
  recurringBills: {
    showBillMatchingTools: { label: 'Bill Matching Tools', description: 'Transaction match popup and match score.' },
    showAutoPaidDetection: { label: 'Auto-Paid Detection', description: 'Auto-detected payment indicators.' },
    showAdvancedBillRules: { label: 'Advanced Bill Rules', description: 'Auto-detect button and match settings.' },
  },
  expenses: {
    showExpenseCategoryManager: { label: 'Category Progress Bars', description: 'Category-by-category budget vs actual bars.' },
    showUncategorizedWarnings: { label: 'Uncategorized Warnings', description: 'Review queue for uncategorized transactions.' },
  },
  transfers: {
    showDiscoverTransferPlan: { label: 'Discover Transfer Plan', description: 'Discover card payoff transfer section.' },
    showDebtSavingsTransferPlan: { label: 'Debt Savings Transfer Plan', description: 'Debt savings transfer row.' },
    showJoshTaylorSplit: { label: 'Josh / Taylor Split', description: 'Individual split transfer amounts.' },
    showTransferMatching: { label: 'Transfer Matching', description: 'Match transfers to transactions.' },
    showAdvancedTransferMath: { label: 'Advanced Transfer Math', description: 'Detailed transfer calculation breakdown.' },
  },
  debtSnowball: {
    showDebtAccounts: { label: 'Debt Accounts', description: 'Individual debt column cards.' },
    showCurrentBalanceDistribution: { label: 'Balance Distribution Chart', description: 'Donut chart of balance by account.' },
    showAvailableExtraDebtPayment: { label: 'Extra Debt Payment', description: 'Available extra payment row.' },
    showPayoffProjection: { label: 'Payoff Projection', description: 'Projected payoff timeline.' },
  },
  cashFlowForecast: {
    showProjectedBalances: { label: 'Projected Balances', description: 'Day-by-day projected balance table.' },
    showScenarioTools: { label: 'Scenario Tools', description: 'What-if scenario planning tools.' },
  },
  reports: {
    showSpendingTrends: { label: 'Spending Trends', description: 'Multi-period spending trend section.' },
    showCategoryReports: { label: 'Category Reports', description: 'Per-category spending breakdown.' },
    showIncomeReports: { label: 'Income Reports', description: 'Income summary by period.' },
    showExportTools: { label: 'Export Tools', description: 'CSV/JSON export buttons.' },
  },
  dataHealth: {
    showPlaidHealth: { label: 'Plaid Connection Health', description: 'Plaid sync status and account checks.' },
    showClassificationHealth: { label: 'Classification Health', description: 'Unreviewed and untyped transaction warnings.' },
    showSplitHealth: { label: 'Split Transaction Health', description: 'Unfinalized split checks.' },
    showBillMatchHealth: { label: 'Bill Match Health', description: 'Unmatched recurring bill warnings.' },
    showTransferHealth: { label: 'Transfer Health', description: 'Unconfirmed transfer checks.' },
  },
  paycheckPlanner: {
    showDetectedPayrollIncome: { label: 'Detected Payroll Income', description: 'Auto-detected paycheck transactions.' },
    showManualOverride: { label: 'Manual Override', description: 'Manual income entry fields.' },
    showIncomeBreakdown: { label: 'Income Breakdown', description: 'Detailed income source breakdown.' },
  },
  history: {
    showPayPeriodHistory: { label: 'Pay Period History', description: 'Historical pay period summary rows.' },
    showSnapshotComparison: { label: 'Snapshot Comparison', description: 'Side-by-side period comparison.' },
  },
  settings: {
    showPlaidConnections: { label: 'Plaid Connections', description: 'Bank connection and sync section.' },
    showAccountTabNames: { label: 'Account Tab Names', description: 'Rename account tabs used on the Transactions page.' },
    showRulesManager: { label: 'Rules Manager', description: 'Transaction classification rules section.' },
    showDataTools: { label: 'Data Tools', description: 'Health checks, cleanup actions, and backup tools.' },
    showSafeMoney: { label: 'Safe Money', description: 'Shared safe-to-spend and safe-to-transfer settings.' },
    showCommandCenter: { label: 'Command Center', description: 'This feature toggle panel itself.' },
  },
};

export const PAGE_META = {
  dashboard: { label: 'Dashboard', description: 'Main pay period overview and command center.' },
  transactions: { label: 'Transactions', description: 'Synced transaction list with review tools.' },
  recurringBills: { label: 'Recurring Bills', description: 'Bill tracking and auto-match detection.' },
  expenses: { label: 'Expenses', description: 'Category spending tracker vs budget.' },
  transfers: { label: 'Transfers', description: 'Transfer planning and confirmation.' },
  debtSnowball: { label: 'Debt Snowball', description: 'Debt payoff tracker and projections.' },
  cashFlowForecast: { label: 'Cash Flow Forecast', description: 'Projected account balances over time.' },
  reports: { label: 'Reports', description: 'Multi-period spending and income reports.' },
  dataHealth: { label: 'Data Health', description: 'System health checks and data quality.' },
  paycheckPlanner: { label: 'Paycheck Planner', description: 'Income detection and budget planning.' },
  history: { label: 'History', description: 'Historical pay period snapshots and closeouts.' },
  closeout: { label: 'Closeout', description: 'Finalize period outcomes and archival records.' },
  masterLists: { label: 'Master Lists', description: 'Manage recurring bills and expense category lists.' },
  settings: { label: 'Settings', description: 'App configuration and connection settings.' },
};

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Merge stored settings over defaults, filling in any missing keys.
 */
export function getCommandCenterSettings(stored) {
  const result = {};
  for (const [page, defaults] of Object.entries(COMMAND_CENTER_DEFAULTS)) {
    const storedPage = (stored && typeof stored === 'object') ? (stored[page] || {}) : {};
    result[page] = { ...defaults, ...storedPage };
    if (page === 'settings' && 'pageEnabled' in result[page]) {
      delete result[page].pageEnabled;
    }
  }
  return result;
}

/**
 * Check if an entire page is enabled. Defaults to true if missing.
 */
export function isPageEnabled(ccSettings, pageKey) {
  if (pageKey === 'settings') return true;
  if (!ccSettings || typeof ccSettings !== 'object') return true;
  const page = ccSettings[pageKey];
  if (!page || typeof page !== 'object') return true;
  return page.pageEnabled !== false;
}

/**
 * Check if a specific feature is enabled. Defaults to true if missing.
 */
export function isFeatureEnabled(ccSettings, pageKey, featureKey) {
  if (!ccSettings || typeof ccSettings !== 'object') return true;
  const page = ccSettings[pageKey];
  if (!page || typeof page !== 'object') return true;
  if (!(featureKey in page)) {
    // Fall back to defaults
    return COMMAND_CENTER_DEFAULTS[pageKey]?.[featureKey] !== false;
  }
  return page[featureKey] !== false;
}

/**
 * Load command center settings from the API, merged with defaults.
 */
export async function loadCommandCenterSettings() {
  try {
    const stored = await getSetting(COMMAND_CENTER_SETTING_KEY);
    return getCommandCenterSettings(stored || {});
  } catch {
    return getCommandCenterSettings({});
  }
}

/**
 * Persist a single feature toggle change.
 */
export async function updateCommandCenterFeature(currentSettings, pageKey, featureKey, value) {
  if (pageKey === 'settings' && featureKey === 'pageEnabled') {
    return getCommandCenterSettings(currentSettings || {});
  }
  const next = {
    ...currentSettings,
    [pageKey]: {
      ...(currentSettings[pageKey] || COMMAND_CENTER_DEFAULTS[pageKey] || {}),
      [featureKey]: value,
    },
  };
  if (pageKey === 'settings' && next.settings && 'pageEnabled' in next.settings) {
    delete next.settings.pageEnabled;
  }
  await updateSetting(COMMAND_CENTER_SETTING_KEY, next);
  return getCommandCenterSettings(next);
}

/**
 * Reset a single page back to its defaults.
 */
export async function resetCommandCenterPage(currentSettings, pageKey) {
  const next = {
    ...currentSettings,
    [pageKey]: { ...COMMAND_CENTER_DEFAULTS[pageKey] },
  };
  await updateSetting(COMMAND_CENTER_SETTING_KEY, next);
  return getCommandCenterSettings(next);
}

/**
 * Reset all pages to defaults.
 */
export async function resetAllCommandCenterDefaults() {
  const defaults = getCommandCenterSettings({});
  await updateSetting(COMMAND_CENTER_SETTING_KEY, defaults);
  return defaults;
}

/**
 * Apply a named preset, merging overrides on top of current settings.
 */
export async function applyCommandCenterPreset(currentSettings, presetKey) {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error('Unknown preset: ' + presetKey);
  let next = { ...currentSettings };
  for (const [page, overrides] of Object.entries(preset.overrides)) {
    next[page] = { ...(next[page] || COMMAND_CENTER_DEFAULTS[page] || {}), ...overrides };
  }
  if (next.settings && 'pageEnabled' in next.settings) {
    delete next.settings.pageEnabled;
  }
  await updateSetting(COMMAND_CENTER_SETTING_KEY, next);
  return getCommandCenterSettings(next);
}
