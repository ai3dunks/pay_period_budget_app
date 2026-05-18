import { getTransactionRowsForPeriod } from '../api/transactionsApi.js';

const BACKEND = '';

async function fetchJson(path) {
  const response = await fetch(BACKEND + path);
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  return await response.json();
}

async function fetchSetting(key, fallback = null) {
  try {
    const data = await fetchJson('/api/settings/' + encodeURIComponent(key));
    if (data.value === null || data.value === undefined) return fallback;
    return data.value;
  } catch {
    return fallback;
  }
}

async function fetchSettingWithFallback(primaryKey, fallbackKey, fallbackValue) {
  const primary = await fetchSetting(primaryKey, null);
  if (primary !== null && primary !== undefined) return primary;
  return await fetchSetting(fallbackKey, fallbackValue);
}

function normalizeSettingMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export async function loadBudgetContext({ period }) {
  const [plaidStatus, transactions, masterLists, recurringBillStatuses, manualIncomeByPeriod, autoDetectedIncomeByPeriod, splitSettings, safeMoneySettings, transferTargets] = await Promise.all([
    fetchJson('/api/plaid/status'),
    getTransactionRowsForPeriod(period),
    fetchJson('/api/master-lists'),
    fetchJson('/api/recurring-bills/status?periodId=' + encodeURIComponent(period.id)).catch(() => []),
    fetchSettingWithFallback('manualIncomeByPeriod', 'budget_income_by_period', {}),
    fetchSettingWithFallback('autoDetectedIncomeByPeriod', 'auto_detected_income_by_period', {}),
    fetchSettingWithFallback('splitSettings', 'budget_split_settings', {}),
    fetchSettingWithFallback('safeMoneySettings', 'safe_money_settings', {}),
    fetchSetting('transfer_targets', {}),
  ]);

  const normalizedSafeMoneySettings = safeMoneySettings && typeof safeMoneySettings === 'object' ? safeMoneySettings : {};
  const includePendingTransactions = normalizedSafeMoneySettings.includePendingTransactions
    ?? normalizedSafeMoneySettings.include_pending_transactions
    ?? false;

  return {
    period,
    accounts: Array.isArray(plaidStatus.accounts) ? plaidStatus.accounts : [],
    transactions: Array.isArray(transactions) ? transactions : [],
    expenseList: Array.isArray(masterLists.expenseList) ? masterLists.expenseList : [],
    recurringBillsList: Array.isArray(masterLists.recurringBillsList) ? masterLists.recurringBillsList : [],
    recurringBillStatuses: Array.isArray(recurringBillStatuses) ? recurringBillStatuses : [],
    settings: {
      budget_income_by_period: normalizeSettingMap(manualIncomeByPeriod),
      auto_detected_income_by_period: normalizeSettingMap(autoDetectedIncomeByPeriod),
      manualIncomeByPeriod: normalizeSettingMap(manualIncomeByPeriod),
      autoDetectedIncomeByPeriod: normalizeSettingMap(autoDetectedIncomeByPeriod),
      splitSettings: normalizeSettingMap(splitSettings),
      transferTargets: transferTargets && typeof transferTargets === 'object' ? transferTargets : {},
      transfer_targets: transferTargets && typeof transferTargets === 'object' ? transferTargets : {},
      includePendingTransactions: includePendingTransactions === true,
      includePending: includePendingTransactions === true,
      safeMoneySettings: normalizeSettingMap(normalizedSafeMoneySettings),
      todayIso: new Date().toISOString().slice(0, 10),
    },
  };
}
