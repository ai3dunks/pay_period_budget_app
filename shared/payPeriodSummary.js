/**
 * shared/payPeriodSummary.js — Main pay-period business math.
 * No DOM, no fetch, no localStorage.
 *
 * This is the single source of truth for pay-period calculations.
 * Both frontend (src/ui/*) and backend (server/routes/*) import from here.
 */

import { isDateInBudgetPeriod, parseLocalDate } from './budgetPeriods.js';
import { calculateBudgetSplit, calculateTransferPlan, calculateWantsActuals } from './transfers.js';
import { calculateExpenseBudget } from './expenses.js';
import { calculateRecurringBillsDue } from './recurringBills.js';
import { calculateBoaRolloverFromLastPrePaycheckTransaction } from './boaRollover.js';
import { getDetectedPayrollIncome, isCiscoPayrollTransaction } from './payrollDetection.js';
import { calculateSafeToSpend, calculateSafeToTransfer } from './safeMoney.js';
import { toNumber } from './money.js';
import { normalizeText } from './text.js';

export { calculateSafeToSpend, calculateSafeToTransfer } from './safeMoney.js';

const DEFAULT_BUDGET_SPLIT = { Needs: 60, Wants: 20, 'Debts/Savings': 20 };
const DEFAULT_SAFE_MONEY_SETTINGS = {
  safetyBuffer: 100,
  includeBoaRolloverInSafeToSpend: true,
  includePendingTransactions: false,
};
const BOA_NAME_PATTERNS = ['bank of america', 'boa', 'bofa'];

// ── Private helpers ──────────────────────────────────────────────────────────

function getSettingMap(settings, keys) {
  for (const key of keys) {
    const value = settings?.[key];
    if (value && typeof value === 'object') return value;
  }
  return {};
}

function getSplitSettings(settings) {
  const raw = settings?.splitSettings || settings?.budget_split_settings || {};
  if (raw && typeof raw === 'object' && raw.default && typeof raw.default === 'object') {
    return raw.default;
  }
  if (raw && typeof raw === 'object') return raw;
  return DEFAULT_BUDGET_SPLIT;
}

function getSafeMoneySettings(settings) {
  const raw =
    settings?.safeMoneySettings ||
    settings?.safe_money_settings ||
    settings?.safeMoney ||
    settings?.safe_money ||
    {};
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    safetyBuffer: Math.max(
      0,
      toNumber(
        source.safetyBuffer ?? source.safety_buffer ?? DEFAULT_SAFE_MONEY_SETTINGS.safetyBuffer,
        DEFAULT_SAFE_MONEY_SETTINGS.safetyBuffer
      )
    ),
    includeBoaRolloverInSafeToSpend:
      source.includeBoaRolloverInSafeToSpend ??
      source.include_boa_rollover_in_safe_to_spend ??
      DEFAULT_SAFE_MONEY_SETTINGS.includeBoaRolloverInSafeToSpend,
    includePendingTransactions:
      source.includePendingTransactions ??
      source.include_pending_transactions ??
      settings?.includePendingTransactions ??
      settings?.includePending ??
      DEFAULT_SAFE_MONEY_SETTINGS.includePendingTransactions,
  };
}

function normalizeAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function formatCurrencyLike(value) {
  return '$' + Math.abs(toNumber(value, 0)).toFixed(2);
}

function isBankOfAmericaAccount(account) {
  if (!account) return false;
  const name = String(account.name || account.officialName || '').toLowerCase();
  const institution = String(account.institutionName || '').toLowerCase();
  return BOA_NAME_PATTERNS.some((p) => name.includes(p) || institution.includes(p));
}

function isBankOfAmericaCheckingAccount(account) {
  if (!isBankOfAmericaAccount(account)) return false;
  const subtype = String(account.subtype || '').toLowerCase();
  if (!subtype) return true;
  return subtype.includes('checking');
}

function findBoaAccount(accounts = []) {
  const boaAccounts = (accounts || []).filter(isBankOfAmericaAccount);
  if (!boaAccounts.length) return null;
  const checkingAccounts = boaAccounts.filter(isBankOfAmericaCheckingAccount);
  const candidates = checkingAccounts.length ? checkingAccounts : boaAccounts;
  return (
    candidates
      .slice()
      .sort((a, b) => {
        const aBalance = normalizeAmount(a.balanceCurrent);
        const bBalance = normalizeAmount(b.balanceCurrent);
        if (aBalance !== null && bBalance !== null && aBalance !== bBalance) return bBalance - aBalance;
        if (aBalance !== null && bBalance === null) return -1;
        if (aBalance === null && bBalance !== null) return 1;
        return String(a.name || '').localeCompare(String(b.name || ''));
      })[0] || null
  );
}

function isBoaTransaction(txn, boaAccount) {
  if (!txn || !boaAccount) return false;
  const txnAccountId = String(txn.account_id || '').trim();
  const txnPlaidAccountId = String(txn.plaid_account_id || '').trim();
  if (boaAccount.id && txnAccountId && boaAccount.id === txnAccountId) return true;
  if (boaAccount.plaidAccountId && txnPlaidAccountId && boaAccount.plaidAccountId === txnPlaidAccountId) return true;

  const txnMask = String(txn.mask || '').trim();
  const txnInst = String(txn.institution_name || '').toLowerCase().trim();
  const txnName = String(txn.account_name || '').toLowerCase().trim();
  const accMask = String(boaAccount.mask || '').trim();
  const accInst = String(boaAccount.institutionName || '').toLowerCase().trim();
  const accName = String(boaAccount.name || '').toLowerCase().trim();

  if (accMask && txnMask && accMask === txnMask) return true;
  if (accName && txnName && accName === txnName) return true;
  if (accInst && txnInst && accInst === txnInst) return true;
  return BOA_NAME_PATTERNS.some((p) => txnInst.includes(p) || txnName.includes(p));
}

function getPendingBoaSpending({ transactions = [], boaAccount, includePendingTransactions = false, period }) {
  if (!includePendingTransactions || !boaAccount) return 0;
  return (transactions || []).reduce((sum, txn) => {
    if (!txn || txn.ignored || !txn.pending) return sum;
    if (!isDateInBudgetPeriod(txn.date, period)) return sum;
    if (!isBoaTransaction(txn, boaAccount)) return sum;
    const amount = Number(txn.amount || 0);
    if (amount >= 0) return sum;
    return sum + Math.abs(amount);
  }, 0);
}

function getPeriodTransactions(period, transactions = [], includePendingTransactions = false) {
  return (transactions || []).filter((row) => {
    if (!row || row.ignored) return false;
    if (!includePendingTransactions && row.pending) return false;
    return isDateInBudgetPeriod(row.date, period);
  });
}

function isInSelectedPeriod(dateValue, period) {
  if (!dateValue || !period?.startDate || !period?.exclusiveEndDate) return false;
  try {
    const target =
      typeof dateValue === 'string' ? parseLocalDate(dateValue) : new Date(dateValue);
    const start = parseLocalDate(period.startDate);
    const exclusiveEnd = parseLocalDate(period.exclusiveEndDate);
    return target >= start && target < exclusiveEnd;
  } catch {
    return false;
  }
}

function toPeriodShape(period) {
  return {
    id: period?.id || null,
    label: period?.label || null,
    startDate: period?.startDate || null,
    displayEndDate: period?.displayEndDate || null,
    exclusiveEndDate: period?.exclusiveEndDate || null,
  };
}

// ── Public export ─────────────────────────────────────────────────────────────

/**
 * Build the full pay-period summary: income, rollover, recurring bills,
 * expenses, wants, transfers, safe money, and alerts.
 *
 * @param {{ period, accounts, transactions, expenseList, recurringBillsList,
 *           recurringBillStatuses, settings }} context
 */
export function buildPayPeriodSummary({
  period,
  accounts = [],
  transactions = [],
  expenseList = [],
  recurringBillsList = [],
  recurringBillStatuses = [],
  settings = {},
}) {
  const safeMoneySettings = getSafeMoneySettings(settings);
  const includePendingTransactions = safeMoneySettings.includePendingTransactions === true;
  const periodTransactions = getPeriodTransactions(period, transactions, includePendingTransactions);

  const manualIncomeByPeriod = getSettingMap(settings, ['manualIncomeByPeriod', 'budgetIncomeByPeriod', 'budget_income_by_period']);
  const autoDetectedIncomeByPeriod = getSettingMap(settings, ['autoDetectedIncomeByPeriod', 'auto_detected_income_by_period']);

  const allIncomeOrPayrollTransactions = (transactions || []).filter((row) => {
    if (!row || row.ignored) return false;
    if (normalizeText(row?.type) === 'income') return true;
    return isCiscoPayrollTransaction(row) && toNumber(row.amount, 0) > 0;
  });

  const periodIncomeOrPayrollTransactions = allIncomeOrPayrollTransactions.filter((row) =>
    isInSelectedPeriod(row.date, period)
  );

  const excludedIncomeOutsidePeriodCount =
    allIncomeOrPayrollTransactions.length - periodIncomeOrPayrollTransactions.length;

  const detectedPayroll = getDetectedPayrollIncome(periodIncomeOrPayrollTransactions, period, {
    includePendingTransactions,
  });

  const payrollTransactions = (detectedPayroll.transactions || []).map((row) => ({
    id: row.id,
    date: row.date,
    description: row.name || row.merchant_name || row.description || '',
    amount: toNumber(row.amount, 0),
    accountName: row.account_name || '',
    institutionName: row.institution_name || '',
  }));

  const selectedPayrollTransactionId = detectedPayroll.selectedTransactionId;

  const bonusIncomeTransactions = periodIncomeOrPayrollTransactions.filter((row) => {
    if (normalizeText(row?.type) !== 'income') return false;
    if (normalizeText(row.category) !== 'bonus') return false;
    if (selectedPayrollTransactionId && row.id === selectedPayrollTransactionId) return false;
    return toNumber(row.amount, 0) > 0;
  });

  const otherIncomeTransactions = periodIncomeOrPayrollTransactions.filter((row) => {
    if (normalizeText(row?.type) !== 'income') return false;
    if (normalizeText(row.category) !== 'other income') return false;
    if (selectedPayrollTransactionId && row.id === selectedPayrollTransactionId) return false;
    return toNumber(row.amount, 0) > 0;
  });

  const bonusIncome = bonusIncomeTransactions.reduce((sum, row) => sum + Math.max(0, toNumber(row.amount, 0)), 0);
  const otherIncome = otherIncomeTransactions.reduce((sum, row) => sum + Math.max(0, toNumber(row.amount, 0)), 0);

  const detectedPayrollIncome = Math.max(0, toNumber(detectedPayroll.amount, 0));
  const manualIncome = manualIncomeByPeriod?.[period?.id] ?? null;
  const autoDetectedIncome = autoDetectedIncomeByPeriod?.[period?.id] ?? null;
  const hasManualIncome = manualIncome !== null && manualIncome !== undefined;
  const hasDetectedPayroll = detectedPayrollIncome > 0;
  const hasAutoDetectedIncome = autoDetectedIncome !== null && autoDetectedIncome !== undefined;
  const regularPaycheck = hasManualIncome
    ? toNumber(manualIncome, 0)
    : hasDetectedPayroll
      ? detectedPayrollIncome
      : hasAutoDetectedIncome
        ? toNumber(autoDetectedIncome, 0)
        : 0;
  const budgetIncome = regularPaycheck + bonusIncome + otherIncome;
  const incomeSourceLabel = hasManualIncome
    ? 'Manual override'
    : hasDetectedPayroll || hasAutoDetectedIncome
      ? 'Cisco payroll'
      : 'No income found';

  const selectedPayrollTransaction = detectedPayroll.selectedTransaction
    ? {
        id: detectedPayroll.selectedTransaction.id,
        date: detectedPayroll.selectedTransaction.date || null,
        description:
          detectedPayroll.selectedTransaction.name ||
          detectedPayroll.selectedTransaction.description ||
          detectedPayroll.selectedTransaction.merchant_name ||
          '',
        amount: toNumber(detectedPayroll.selectedTransaction.amount, 0),
      }
    : null;

  const ignoredDuplicatePayrollTransactions = (detectedPayroll.ignoredDuplicatePayrollTransactions || []).map((row) => ({
    id: row.id,
    date: row.date || null,
    description: row.name || row.description || row.merchant_name || '',
    amount: toNumber(row.amount, 0),
  }));

  // ── Recurring bills ────────────────────────────────────────────────────────
  const recurringDue = calculateRecurringBillsDue({
    recurringBillsList,
    period,
    billStatusRows: recurringBillStatuses,
  });

  const todayIso = String(settings?.todayIso || new Date().toISOString().slice(0, 10));

  const recurringRows = (recurringDue.billsDueWithStatus || []).map((bill) => {
    const dueDateIso = String(bill.dueDate?.toISOString?.().slice(0, 10) || '');
    const isPaid = !!bill.status?.paid;
    const statusLabel = isPaid ? 'Paid' : dueDateIso && dueDateIso < todayIso ? 'Overdue' : 'Unpaid';

    const paidFrom = String(bill.paidFrom || '').trim();
    const paidFromKey = normalizeText(paidFrom);
    const isBoaReserve =
      !paidFromKey || paidFromKey.includes('boa') || paidFromKey.includes('bank of america');

    return {
      id: bill.id,
      billName: bill.name,
      name: bill.name,
      dueDate: dueDateIso || null,
      dueDateLabel: bill.dueDateStr || dueDateIso || '',
      dueDateStr: bill.dueDateStr || dueDateIso || '',
      amount: toNumber(bill.amount, 0),
      category: bill.category || '',
      autopay: !!bill.autopay,
      active: !!bill.active,
      matchWords: Array.isArray(bill.matchWords) ? bill.matchWords : [],
      notes: bill.notes || '',
      paidFrom: paidFrom || 'Unassigned',
      status: bill.status || null,
      statusLabel,
      paidTransactionId: bill.status?.matchTransactionId || null,
      isBoaReserve,
    };
  });

  const dueTotal = recurringRows.reduce((sum, row) => sum + row.amount, 0);
  const paidRows = recurringRows.filter((row) => !!row.status?.paid);
  const unpaidRows = recurringRows.filter((row) => !row.status?.paid);
  const paidTotal = paidRows.reduce((sum, row) => sum + row.amount, 0);
  const unpaidTotal = unpaidRows.reduce((sum, row) => sum + row.amount, 0);

  // ── Expenses ───────────────────────────────────────────────────────────────
  const expenseBudget = calculateExpenseBudget(expenseList);
  const expenseRowsByCategory = new Map();
  const expenseTransactions = periodTransactions.filter(
    (row) => normalizeText(row.type) === 'expense'
  );
  for (const row of expenseTransactions) {
    const key = normalizeText(row.category || 'uncategorized');
    expenseRowsByCategory.set(key, (expenseRowsByCategory.get(key) || 0) + Math.abs(toNumber(row.amount, 0)));
  }

  const categoryRows = (expenseList || [])
    .filter((item) => !!item?.active)
    .map((item) => {
      const key = normalizeText(item.name);
      const budget = toNumber(item.budgetAmount, 0);
      const actual = toNumber(expenseRowsByCategory.get(key), 0);
      return {
        name: item.name,
        budget,
        actual,
        remaining: budget - actual,
        overBudget: budget > 0 && actual > budget,
      };
    });

  const budgetTotal = toNumber(expenseBudget.totalExpenseBudget, 0);
  const actualTotal = expenseTransactions.reduce((sum, row) => sum + Math.abs(toNumber(row.amount, 0)), 0);
  const remaining = budgetTotal - actualTotal;
  const overBudgetCount = categoryRows.filter((row) => row.overBudget).length;

  // ── Wants + transfers ──────────────────────────────────────────────────────
  const wantsActuals = calculateWantsActuals({ transactions: periodTransactions, period });

  const rolloverCalc = calculateBoaRolloverFromLastPrePaycheckTransaction({
    accounts,
    transactions,
    selectedPeriod: period,
  });
  const rolloverAmount = toNumber(rolloverCalc?.amount, 0);

  const rollover = {
    amount: rolloverAmount,
    date: rolloverCalc?.rolloverDate || null,
    source: rolloverCalc?.canCalculate ? 'last-pre-paycheck-running-balance' : 'unavailable',
    warning: rolloverCalc?.warning || null,
    lastTransaction: rolloverCalc?.lastTransactionId
      ? {
          id: rolloverCalc.lastTransactionId,
          date: rolloverCalc.lastTransactionDate,
          description: rolloverCalc.lastTransactionDescription,
          amount: toNumber(rolloverCalc.lastTransactionAmount, 0),
          runningBalance: rolloverCalc.lastTransactionBalance,
        }
      : null,
  };

  const splitSummary = calculateBudgetSplit({
    budgetIncome,
    recurringBillsDue: recurringDue.billsDue,
    splitSettings: getSplitSettings(settings),
  });

  const transferPlan = calculateTransferPlan({
    splitSummary,
    expenseBudget,
    wantsActuals,
    boaReserve: recurringDue.boaReserve,
  });

  // ── Safe money ─────────────────────────────────────────────────────────────
  const boaAccount = findBoaAccount(accounts);
  const pendingBoaSpending = getPendingBoaSpending({
    transactions,
    boaAccount,
    includePendingTransactions,
    period,
  });

  const safeToSpend = calculateSafeToSpend({
    budgetIncome,
    rolloverAmount,
    rolloverWarning: rolloverCalc?.warning,
    recurringBillsLeftToPay: dueTotal,
    expenseBudgetRemaining: expenseBudget.totalExpenseBudget - actualTotal,
    expenseOverrun: Math.max(0, actualTotal - budgetTotal),
    requiredTransfersRemaining:
      Math.max(0, transferPlan.joshTransfer) +
      Math.max(0, transferPlan.taylorTransfer) +
      Math.max(0, transferPlan.discoverTransfer) +
      Math.max(0, transferPlan.debtSavingsTransfer),
    safetyBuffer: safeMoneySettings.safetyBuffer,
    includeBoaRolloverInSafeToSpend: safeMoneySettings.includeBoaRolloverInSafeToSpend,
    includePendingTransactions,
  });

  const safeToTransfer = calculateSafeToTransfer({
    boaAccount,
    boaCurrentBalance: boaAccount ? boaAccount.balanceCurrent : null,
    unpaidBoaBills: recurringDue.unpaidBoaReserveBills.reduce(
      (sum, bill) => sum + toNumber(bill.amount, 0),
      0
    ),
    boaReserve: recurringDue.boaReserve,
    pendingBoaSpending,
    safetyBuffer: safeMoneySettings.safetyBuffer,
    includePendingTransactions,
  });

  // ── Alerts ─────────────────────────────────────────────────────────────────
  const transferAlerts = [];
  if (transferPlan.discoverShortfall > 0) transferAlerts.push('Discover transfer has a shortfall.');
  if (transferPlan.debtSavingsRedirect > 0) transferAlerts.push('Debts/Savings was redirected to Discover.');
  if (transferPlan.joshOverused > 0) transferAlerts.push('Josh wants spending is over share.');
  if (transferPlan.taylorOverused > 0) transferAlerts.push('Taylor wants spending is over share.');

  const alerts = [];
  if (budgetIncome <= 0) alerts.push('No income found for the selected budget period.');
  if (rollover.warning) alerts.push(rollover.warning);
  if (dueTotal > budgetIncome + Math.max(0, rolloverAmount)) {
    alerts.push('Recurring bills due exceed income for this budget period.');
  }
  if (remaining < 0) alerts.push('Expense spending is over budget for this period.');
  alerts.push(...transferAlerts);

  // ── Data health counts ─────────────────────────────────────────────────────
  const allPeriodTransactions = (transactions || []).filter(
    (row) => row && isDateInBudgetPeriod(row.date, period)
  );
  const ignoredInPeriod = allPeriodTransactions.filter((row) => row.ignored).length;
  const pendingIncludedCount = periodTransactions.filter((row) => row.pending).length;
  const uncategorizedCount = periodTransactions.filter(
    (row) => !String(row.category || '').trim()
  ).length;

  return {
    period: toPeriodShape(period),
    income: {
      budgetIncome,
      regularPaycheck,
      bonusIncome,
      otherIncome,
      source: incomeSourceLabel,
      payrollTransactions,
      ciscoPayrollTransactionsFound: detectedPayroll.count || 0,
      regularPaycheckTransactionCount: detectedPayroll.detected ? 1 : 0,
      ignoredDuplicatePayrollTransactionsCount: ignoredDuplicatePayrollTransactions.length,
      bonusTransactionCount: bonusIncomeTransactions.length,
      otherIncomeTransactionCount: otherIncomeTransactions.length,
      excludedIncomeOutsidePeriodCount,
      selectedPayrollTransaction,
      ignoredDuplicatePayrollTransactions,
      payrollWarning: detectedPayroll.warning || null,
    },
    rollover,
    recurringBills: {
      dueTotal,
      paidTotal,
      unpaidTotal,
      dueCount: recurringRows.length,
      paidCount: paidRows.length,
      unpaidCount: unpaidRows.length,
      dueRows: recurringRows,
      paidRows,
      unpaidRows,
    },
    expenses: {
      budgetTotal,
      actualTotal,
      remaining,
      overBudgetCount,
      categoryRows,
      transactions: expenseTransactions,
    },
    wants: {
      remaining: transferPlan.wantsRemaining,
      joshSpent: wantsActuals.joshActual,
      taylorSpent: wantsActuals.taylorActual,
      splitSpent: wantsActuals.splitTotal,
      joshTransfer: transferPlan.joshTransfer,
      taylorTransfer: transferPlan.taylorTransfer,
      joshDirect: wantsActuals.joshDirect,
      taylorDirect: wantsActuals.taylorDirect,
      joshSplitShare: wantsActuals.joshSplitShare,
      taylorSplitShare: wantsActuals.taylorSplitShare,
      transactions: wantsActuals.wantsRows,
    },
    transfers: {
      total: transferPlan.totalPlannedTransfers,
      josh: transferPlan.joshTransfer,
      taylor: transferPlan.taylorTransfer,
      discover: transferPlan.discoverTransfer,
      debtSavings: transferPlan.debtSavingsTransfer,
      boaReserve: transferPlan.boaReserve,
      alerts: transferAlerts,
    },
    safeMoney: {
      safetyBuffer: safeMoneySettings.safetyBuffer,
      includeBoaRolloverInSafeToSpend: safeMoneySettings.includeBoaRolloverInSafeToSpend,
      includePendingTransactions,
      pendingNote: includePendingTransactions
        ? 'Pending transactions included.'
        : 'Pending transactions excluded.',
      safeToSpend,
      safeToTransfer,
    },
    safeToSpend: safeToSpend.amount,
    safeToTransfer: safeToTransfer.amount,
    alerts,
    dataHealth: {
      includePendingTransactions,
      periodTransactionCount: periodTransactions.length,
      ignoredExcludedCount: ignoredInPeriod,
      pendingIncludedCount,
      uncategorizedCount,
    },
  };
}
