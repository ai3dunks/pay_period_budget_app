import { loadBudgetContext } from './loadBudgetContext.js';
import { buildPayPeriodSummary } from './payPeriodSummary.js';
import { calculateBudgetSplit, calculateTransferPlan, calculateWantsActuals } from './budgetCalculations.js';
import { getTransferConfirmations } from '../api/transferConfirmationApi.js';
import { getDebtSnowballPaymentPlans } from '../api/debtSnowballApi.js';
import { getCashFlowAdjustments } from '../api/cashFlowApi.js';

const BACKEND = 'http://localhost:8787';

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

function toDateKey(value, fallback = '') {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function isInPeriod(isoDate, period) {
  const date = toDateKey(isoDate);
  if (!date || !period?.startDate || !period?.exclusiveEndDate) return false;
  return date >= period.startDate && date < period.exclusiveEndDate;
}

function formatAccountLabel(account) {
  if (!account) return 'Unknown account';
  const bank = String(account.institutionName || '').trim();
  const name = String(account.name || account.officialName || '').trim();
  if (bank && name) return bank + ' - ' + name;
  return bank || name || 'Unknown account';
}

function normalizeType(value) {
  return String(value || '').trim().toLowerCase();
}

function findByAnyId(accounts, value) {
  if (!value) return null;
  const target = String(value).trim();
  if (!target) return null;
  return accounts.find((account) => (
    String(account.id || '') === target ||
    String(account.account_id || '') === target ||
    String(account.plaidAccountId || account.plaid_account_id || '') === target
  )) || null;
}

function resolvePrimaryCashAccount(accounts, mappedIds = []) {
  for (const id of mappedIds) {
    const found = findByAnyId(accounts, id);
    if (found) return found;
  }

  const boaCandidates = accounts.filter((account) => {
    const inst = String(account.institutionName || account.institution_name || '').toLowerCase();
    const name = String(account.name || account.officialName || account.official_name || '').toLowerCase();
    const subtype = String(account.subtype || '').toLowerCase();
    const isBoa = inst.includes('bank of america') || inst.includes('boa') || name.includes('bank of america') || name.includes('boa');
    const isCashLike = !subtype || subtype.includes('checking') || subtype.includes('cash') || subtype.includes('savings');
    return isBoa && isCashLike;
  });

  const pool = boaCandidates.length ? boaCandidates : accounts;
  if (!pool.length) return null;

  return pool
    .slice()
    .sort((a, b) => toNumber(b.balanceCurrent ?? b.balance_current, -Infinity) - toNumber(a.balanceCurrent ?? a.balance_current, -Infinity))[0] || null;
}

async function getRawSettingValue(key) {
  try {
    const response = await fetch(BACKEND + '/api/settings/' + encodeURIComponent(key));
    if (!response.ok) return null;
    const data = await response.json();
    return data?.value ?? null;
  } catch {
    return null;
  }
}

function toForecastRow(input) {
  return {
    date: toDateKey(input.date, ''),
    item: String(input.item || '').trim(),
    type: String(input.type || 'adjustment').trim(),
    category: String(input.category || '').trim(),
    account: String(input.account || '').trim(),
    amount: roundMoney(input.amount || 0),
    status: String(input.status || 'Expected').trim(),
    note: String(input.note || '').trim(),
  };
}

function sortForecastRows(rows) {
  const typeOrder = {
    income: 1,
    'recurring bill': 2,
    transaction: 3,
    'planned transfer': 4,
    'confirmed transfer': 5,
    'debt payment': 6,
    adjustment: 7,
  };

  return rows.slice().sort((a, b) => {
    if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
    const ta = typeOrder[normalizeType(a.type)] ?? 99;
    const tb = typeOrder[normalizeType(b.type)] ?? 99;
    if (ta !== tb) return ta - tb;
    return String(a.item).localeCompare(String(b.item));
  });
}

export async function loadCashFlowForecast(period) {
  if (!period?.id) {
    return {
      summary: {
        startingCash: 0,
        expectedIncome: 0,
        billsDue: 0,
        plannedTransfers: 0,
        confirmedTransfers: 0,
        expectedSpending: 0,
        debtSavingsPayments: 0,
        projectedEndingCash: 0,
        lowestProjectedCashBalance: 0,
        nextCashRiskDate: '',
      },
      rows: [],
      warnings: ['Budget period is required.'],
      primaryAccount: null,
      groupedRows: [],
      adjustments: [],
    };
  }

  const context = await loadBudgetContext({ period });
  const summary = buildPayPeriodSummary(context);

  const [transferData, plansData, adjustmentsData, primaryCashId, bank1Id, payrollId, billsId] = await Promise.all([
    getTransferConfirmations(period.id).catch(() => ({ confirmations: [] })),
    getDebtSnowballPaymentPlans(period.id).catch(() => ({ plans: [] })),
    getCashFlowAdjustments(period.id).catch(() => ({ adjustments: [] })),
    getRawSettingValue('primary_cash_account_id'),
    getRawSettingValue('bank_1_account_id'),
    getRawSettingValue('payroll_account_id'),
    getRawSettingValue('bills_account_id'),
  ]);

  const accounts = Array.isArray(context.accounts) ? context.accounts : [];
  const transferConfirmations = Array.isArray(transferData?.confirmations) ? transferData.confirmations : [];
  const paymentPlans = Array.isArray(plansData?.plans) ? plansData.plans : [];
  const adjustments = Array.isArray(adjustmentsData?.adjustments) ? adjustmentsData.adjustments : [];

  const mappedIds = [primaryCashId, bank1Id, payrollId, billsId].filter(Boolean);
  const primaryAccount = resolvePrimaryCashAccount(accounts, mappedIds);

  const warnings = [];
  if (!primaryAccount) {
    warnings.push('Primary cash account could not be identified.');
  }

  const startingCash = roundMoney(
    toNumber(primaryAccount?.balanceCurrent ?? primaryAccount?.balance_current,
      toNumber(primaryAccount?.balanceAvailable ?? primaryAccount?.balance_available, 0))
  );

  const splitSummary = calculateBudgetSplit({
    budgetIncome: summary.income.budgetIncome,
    recurringBillsDue: summary.recurringBills.dueRows || [],
    splitSettings: context.settings?.splitSettings || {},
  });
  const wantsActuals = calculateWantsActuals({ transactions: context.transactions || [], period });
  const transferPlan = calculateTransferPlan({
    splitSummary,
    expenseBudget: { totalExpenseBudget: summary.expenses.budgetTotal },
    wantsActuals,
    boaReserve: summary.transfers.boaReserve,
  });

  const transferTargets = [
    {
      id: 'josh',
      targetName: 'Josh',
      plannedAmount: transferPlan.joshBaseShare,
      alreadyUsed: wantsActuals.joshActual,
    },
    {
      id: 'taylor',
      targetName: 'Taylor',
      plannedAmount: transferPlan.taylorBaseShare,
      alreadyUsed: wantsActuals.taylorActual,
    },
    {
      id: 'discover',
      targetName: 'Discover',
      plannedAmount: transferPlan.discoverTarget,
      alreadyUsed: transferPlan.needsToDiscover + transferPlan.debtSavingsRedirect,
    },
    {
      id: 'debt-savings',
      targetName: 'Debt/Savings',
      plannedAmount: Math.max(0, transferPlan.debtSavingsRemaining),
      alreadyUsed: transferPlan.debtSavingsRedirect,
    },
    {
      id: 'boa-reserve',
      targetName: 'Bank of America Reserve',
      plannedAmount: transferPlan.boaReserve,
      alreadyUsed: Math.max(0, (summary.recurringBills.unpaidTotal || 0) - transferPlan.boaReserve),
    },
  ];

  const confirmationByTarget = new Map();
  transferConfirmations.forEach((row) => {
    confirmationByTarget.set(String(row.targetName || '').trim(), row);
  });

  const rows = [];

  // Posted income rows (already received)
  const postedTransactions = (context.transactions || []).filter((txn) => {
    if (!txn || txn.ignored || txn.pending) return false;
    return isInPeriod(txn.date, period);
  });

  const postedIncomeRows = postedTransactions
    .filter((txn) => normalizeType(txn.type) === 'income' && toNumber(txn.amount, 0) > 0)
    .map((txn) => toForecastRow({
      date: toDateKey(txn.date, period.startDate),
      item: txn.name || txn.merchant_name || 'Posted income',
      type: 'income',
      category: txn.category || 'Income',
      account: txn.account_name || txn.institution_name || formatAccountLabel(primaryAccount),
      amount: Math.abs(toNumber(txn.amount, 0)),
      status: 'Posted',
    }));
  rows.push(...postedIncomeRows);

  const postedIncomeTotal = postedIncomeRows.reduce((sum, row) => sum + row.amount, 0);
  const expectedIncomeAmount = roundMoney(Math.max(0, toNumber(summary.income.budgetIncome, 0) - postedIncomeTotal));
  if (expectedIncomeAmount > 0.00001) {
    rows.push(toForecastRow({
      date: period.startDate,
      item: 'Expected income for period',
      type: 'income',
      category: 'Income',
      account: formatAccountLabel(primaryAccount),
      amount: expectedIncomeAmount,
      status: 'Expected',
    }));
  }

  // Recurring bills due in period.
  const recurringDueRows = Array.isArray(summary.recurringBills.dueRows) ? summary.recurringBills.dueRows : [];
  recurringDueRows.forEach((bill) => {
    const dueDate = toDateKey(bill.dueDate || bill.dueDateLabel || '', period.startDate);
    if (!toDateKey(bill.dueDate || '', '')) {
      warnings.push('A bill due date is missing.');
    }
    rows.push(toForecastRow({
      date: dueDate || period.startDate,
      item: bill.billName || bill.name || 'Recurring bill',
      type: 'recurring bill',
      category: bill.category || 'Recurring Bill',
      account: bill.paidFrom || formatAccountLabel(primaryAccount),
      amount: -Math.abs(toNumber(bill.amount, 0)),
      status: bill.status?.paid ? 'Paid' : 'Expected',
    }));
  });

  // Posted transactions (exclude income/transfer/debt-payment/bills to prevent double count).
  postedTransactions
    .filter((txn) => {
      const type = normalizeType(txn.type);
      return !['income', 'transfer', 'debt payment', 'bills'].includes(type);
    })
    .forEach((txn) => {
      rows.push(toForecastRow({
        date: toDateKey(txn.date, period.startDate),
        item: txn.name || txn.merchant_name || txn.description || 'Posted transaction',
        type: 'transaction',
        category: txn.category || txn.type || 'Transaction',
        account: txn.account_name || txn.institution_name || formatAccountLabel(primaryAccount),
        amount: toNumber(txn.amount, 0),
        status: 'Posted',
      }));
    });

  // Planned vs confirmed transfers (never double-count same target).
  let plannedTransferTotal = 0;
  let confirmedTransferTotal = 0;

  transferTargets.forEach((target) => {
    const confirmation = confirmationByTarget.get(target.targetName);
    const newPlannedTransfer = roundMoney(Math.max(0, toNumber(target.plannedAmount, 0) - toNumber(target.alreadyUsed, 0)));

    if (confirmation && normalizeType(confirmation.status) === 'confirmed') {
      const confirmedAmount = roundMoney(Math.max(0, toNumber(confirmation.confirmedTransferAmount, 0)));
      if (confirmedAmount > 0.00001) {
        confirmedTransferTotal += confirmedAmount;
        rows.push(toForecastRow({
          date: toDateKey(confirmation.confirmedAt, period.startDate),
          item: target.targetName + ' transfer',
          type: 'confirmed transfer',
          category: 'Transfer',
          account: formatAccountLabel(primaryAccount),
          amount: -confirmedAmount,
          status: 'Confirmed',
        }));
      }
      return;
    }

    if (newPlannedTransfer > 0.00001) {
      plannedTransferTotal += newPlannedTransfer;
      rows.push(toForecastRow({
        date: period.startDate,
        item: target.targetName + ' transfer',
        type: 'planned transfer',
        category: 'Transfer',
        account: formatAccountLabel(primaryAccount),
        amount: -newPlannedTransfer,
        status: 'Planned',
      }));
      warnings.push('A transfer is planned but not confirmed.');
    }
  });

  const safeTransferAmount = toNumber(summary.safeMoney?.safeToTransfer?.amount, toNumber(summary.safeToTransfer, 0));
  if (plannedTransferTotal > safeTransferAmount) {
    warnings.push('Planned transfers exceed safe transfer amount.');
  }

  // Expected spending left this period (budget minus posted expense-like spending).
  const postedSpending = postedTransactions
    .filter((txn) => {
      const type = normalizeType(txn.type);
      return ['expense', 'wants'].includes(type);
    })
    .reduce((sum, txn) => sum + Math.max(0, Math.abs(toNumber(txn.amount, 0))), 0);

  const expectedSpending = roundMoney(Math.max(0, toNumber(summary.expenses.budgetTotal, 0) - postedSpending));
  if (expectedSpending > 0.00001) {
    rows.push(toForecastRow({
      date: period.displayEndDate || period.startDate,
      item: 'Expected remaining spending',
      type: 'transaction',
      category: 'Expected Spending',
      account: formatAccountLabel(primaryAccount),
      amount: -expectedSpending,
      status: 'Expected',
    }));
  }

  // Debt payment rows from confirmed/applied debt snowball payments only.
  const appliedPlans = paymentPlans.filter((plan) => normalizeType(plan.status) === 'applied');
  const debtSavingsPayments = roundMoney(
    appliedPlans.reduce((sum, plan) => sum + Math.max(0, toNumber(plan.appliedAmount || plan.amount, 0)), 0)
  );
  appliedPlans.forEach((plan) => {
    const amount = Math.max(0, toNumber(plan.appliedAmount || plan.amount, 0));
    if (amount <= 0.00001) return;
    rows.push(toForecastRow({
      date: toDateKey(plan.appliedAt, period.startDate),
      item: plan.targetDebtName || 'Debt payment',
      type: 'debt payment',
      category: 'Debt/Savings',
      account: formatAccountLabel(primaryAccount),
      amount: -amount,
      status: 'Paid',
    }));
  });

  // Manual adjustments.
  adjustments.forEach((adj) => {
    rows.push(toForecastRow({
      date: toDateKey(adj.date, period.startDate),
      item: adj.label || 'Adjustment',
      type: adj.type || 'adjustment',
      category: 'Adjustment',
      account: adj.account || formatAccountLabel(primaryAccount),
      amount: toNumber(adj.amount, 0),
      status: 'Expected',
      note: adj.notes || '',
    }));
  });

  const sortedRows = sortForecastRows(rows);
  let running = startingCash;
  let lowest = startingCash;
  let nextCashRiskDate = '';

  const withBalances = sortedRows.map((row) => {
    running = roundMoney(running + row.amount);
    if (running < lowest) lowest = running;
    if (!nextCashRiskDate && running < 0) {
      nextCashRiskDate = row.date;
    }
    return {
      ...row,
      projectedBalance: running,
    };
  });

  const projectedEndingCash = roundMoney(running);
  const lowestProjectedCashBalance = roundMoney(lowest);

  if (projectedEndingCash < 0) {
    warnings.push('Projected Ending Cash is negative.');
  }
  if (lowestProjectedCashBalance < 0) {
    warnings.push('Lowest Projected Cash Balance is negative.');
  }

  const grouped = [];
  let lastDate = null;
  withBalances.forEach((row) => {
    if (row.date !== lastDate) {
      grouped.push({ type: 'group', date: row.date });
      lastDate = row.date;
    }
    grouped.push({ type: 'row', row });
  });

  return {
    summary: {
      startingCash,
      expectedIncome: roundMoney(toNumber(summary.income.budgetIncome, 0)),
      billsDue: roundMoney(Math.max(0, toNumber(summary.recurringBills.dueTotal, 0))),
      plannedTransfers: roundMoney(plannedTransferTotal),
      confirmedTransfers: roundMoney(confirmedTransferTotal),
      expectedSpending,
      debtSavingsPayments,
      projectedEndingCash,
      lowestProjectedCashBalance,
      nextCashRiskDate,
    },
    rows: withBalances,
    groupedRows: grouped,
    warnings: Array.from(new Set(warnings)),
    primaryAccount,
    adjustments,
  };
}
