import { isDateInBudgetPeriod, parseLocalDate } from '../utils/budgetPeriods.js';
import {
  getBudgetIncome,
  calculateExpenseBudget,
  calculateRecurringBillsDue,
} from '../utils/budgetCalculations.js';

const DAY_TO_DAY_DISCOVER_CATEGORIES = new Set([
  'gas',
  'groceries',
  'fast food',
  'kids',
  'diapers/wipes',
  'home essentials',
  'car maintenance',
  'school',
  'misc',
]);

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isPendingAllowed(state) {
  return !!state?.includePending;
}

function isTransferTransaction(tx) {
  if (!tx) return false;
  const type = normalizeKey(tx.type);
  const category = normalizeKey(tx.category);
  return type === 'transfer' || category === 'in' || category === 'out' || category.includes('transfer');
}

function isIncomeTransaction(tx) {
  if (!tx) return false;
  const type = normalizeKey(tx.type);
  return type === 'income' || toNumber(tx.amount, 0) > 0;
}

function isSpendingTransaction(tx, includePending) {
  if (!tx || tx.ignored) return false;
  if (!includePending && tx.pending) return false;
  if (!isDateInBudgetPeriod(tx.date, tx.__period)) return false;
  if (isTransferTransaction(tx)) return false;
  if (isIncomeTransaction(tx)) return false;
  const type = normalizeKey(tx.type);
  return type === 'expense' || type === 'bills' || type === 'debt payment' || type === 'wants';
}

function bankNameForAccount(account) {
  return String(account?.name || account?.officialName || account?.institutionName || 'Unknown bank').trim();
}

function transactionBankName(tx) {
  return String(tx?.account_name || tx?.institution_name || '').trim();
}

function transactionAccountId(tx) {
  return tx?.account_id || tx?.plaid_account_id || null;
}

function matchPaidFromBank(paidFrom, accounts) {
  const label = normalizeKey(paidFrom);
  if (!label) return null;
  const exact = accounts.find((acc) => normalizeKey(bankNameForAccount(acc)).includes(label) || label.includes(normalizeKey(bankNameForAccount(acc))));
  return exact || null;
}

function getPeriodTransactions(state) {
  const period = state?.payPeriod;
  const includePending = isPendingAllowed(state);
  return (state?.transactions || [])
    .map((tx) => ({ ...tx, __period: period }))
    .filter((tx) => !tx.ignored)
    .filter((tx) => includePending || !tx.pending)
    .filter((tx) => isDateInBudgetPeriod(tx.date, period));
}

function getIncomeSummary(state) {
  const periodTx = getPeriodTransactions(state);
  const periodId = state?.payPeriod?.id;
  const incomeInfo = getBudgetIncome({
    periodId,
    manualIncomeByPeriod: state?.manualIncomeByPeriod || {},
    autoDetectedIncomeByPeriod: state?.autoDetectedIncomeByPeriod || {},
  });

  const bonusIncome = periodTx.reduce((sum, tx) => {
    if (normalizeKey(tx.type) !== 'income') return sum;
    if (normalizeKey(tx.category) !== 'bonus') return sum;
    return sum + Math.max(0, toNumber(tx.amount, 0));
  }, 0);

  const otherIncome = periodTx.reduce((sum, tx) => {
    if (normalizeKey(tx.type) !== 'income') return sum;
    if (normalizeKey(tx.category) !== 'other income') return sum;
    return sum + Math.max(0, toNumber(tx.amount, 0));
  }, 0);

  const recurringDue = calculateRecurringBillsDue({
    recurringBillsList: state?.masterList?.recurringBillsList || [],
    period: state?.payPeriod,
    billStatusRows: state?.billStatusRows || [],
  });

  const expenseBudget = calculateExpenseBudget(state?.masterList?.expenseList || []);
  const recurringBillsDue = recurringDue.billsDue.reduce((sum, bill) => sum + toNumber(bill.amount, 0), 0);

  const budgetTotal = toNumber(incomeInfo.value, 0) + bonusIncome + otherIncome;
  const moneyNeededForBills = recurringBillsDue;
  const alreadyPaid = recurringDue.billsDueWithStatus
    .filter((bill) => bill.status?.paid)
    .reduce((sum, bill) => sum + toNumber(bill.amount, 0), 0);
  const leftToPay = moneyNeededForBills - alreadyPaid;
  const cashRemainingAfterBills = budgetTotal - moneyNeededForBills;
  const cashRemaining = budgetTotal - moneyNeededForBills - toNumber(expenseBudget.totalExpenseBudget, 0);

  return {
    budgetTotal,
    regularPaycheck: toNumber(incomeInfo.value, 0),
    bonusIncome,
    otherIncome,
    recurringBillsDue,
    moneyNeededForBills,
    alreadyPaid,
    amountLeftToPay: leftToPay,
    leftToPay,
    expenseBudget: toNumber(expenseBudget.totalExpenseBudget, 0),
    cashRemainingAfterBills,
    cashRemaining,
    recurringDue,
  };
}

export function calculateBillsSummary(state) {
  const recurringDue = calculateRecurringBillsDue({
    recurringBillsList: state?.masterList?.recurringBillsList || [],
    period: state?.payPeriod,
    billStatusRows: state?.billStatusRows || [],
  });

  const today = parseLocalDate((state?.todayIso || new Date().toISOString().slice(0, 10)).slice(0, 10));

  const rows = recurringDue.billsDueWithStatus.map((bill) => {
    const dueDate = parseLocalDate(bill.dueDateStr ? bill.dueDate.toISOString().slice(0, 10) : bill.dueDate?.toISOString?.().slice(0, 10) || state?.payPeriod?.startDate);
    const isPaid = !!bill.status?.paid;
    const paidTxId = bill.status?.matchTransactionId || null;
    const status = isPaid
      ? 'Paid'
      : dueDate < today
        ? 'Overdue'
        : 'Unpaid';

    return {
      recurringBillId: bill.id,
      dueDate: bill.dueDate?.toISOString?.().slice(0, 10) || null,
      dueDateLabel: bill.dueDateStr || bill.dueDate?.toLocaleDateString?.() || '',
      billName: bill.name,
      amount: toNumber(bill.amount, 0),
      paidFrom: bill.paidFrom || 'Unassigned',
      status,
      paidTransactionId: paidTxId,
    };
  });

  const totalBills = rows.length;
  const paidRows = rows.filter((row) => row.status === 'Paid');
  const unpaidRows = rows.filter((row) => row.status !== 'Paid');
  const paidAmount = paidRows.reduce((sum, row) => sum + row.amount, 0);
  const unpaidAmount = unpaidRows.reduce((sum, row) => sum + row.amount, 0);

  const nowTs = today.getTime();
  const in3Days = nowTs + 3 * 24 * 60 * 60 * 1000;
  const in7Days = nowTs + 7 * 24 * 60 * 60 * 1000;

  const upcoming3 = unpaidRows.filter((row) => {
    if (!row.dueDate) return false;
    const ts = parseLocalDate(row.dueDate).getTime();
    return ts >= nowTs && ts <= in3Days;
  });

  const upcoming7 = unpaidRows.filter((row) => {
    if (!row.dueDate) return false;
    const ts = parseLocalDate(row.dueDate).getTime();
    return ts >= nowTs && ts <= in7Days;
  });

  const overdue = unpaidRows.filter((row) => row.dueDate && parseLocalDate(row.dueDate) < today);

  return {
    totalBills,
    paidBillsCount: paidRows.length,
    unpaidBillsCount: unpaidRows.length,
    paidAmount,
    unpaidAmount,
    upcomingBills3Days: upcoming3.length,
    upcomingBills7Days: upcoming7.length,
    overdueUnpaidBills: overdue.length,
    rows,
  };
}

export function calculateSpendingSummary(state) {
  const includePending = isPendingAllowed(state);
  const periodTx = (state?.transactions || []).map((tx) => ({ ...tx, __period: state?.payPeriod }));

  const eligible = periodTx.filter((tx) => isSpendingTransaction(tx, includePending));
  const categoryMap = new Map();
  const expenseLookup = new Map(
    (state?.masterList?.expenseList || [])
      .filter((item) => item?.active)
      .map((item) => [normalizeKey(item.name), toNumber(item.budgetAmount, 0)])
  );

  let discoverDayToDayActual = 0;
  let discoverDayToDayBudget = 0;

  eligible.forEach((tx) => {
    const category = String(tx.category || 'Uncategorized').trim() || 'Uncategorized';
    const key = normalizeKey(category);
    const existing = categoryMap.get(key) || {
      category,
      budgetAmount: toNumber(expenseLookup.get(key), 0),
      actualSpent: 0,
      transactionCount: 0,
    };

    const amount = Math.abs(toNumber(tx.amount, 0));
    existing.actualSpent += amount;
    existing.transactionCount += 1;
    categoryMap.set(key, existing);

    const bank = normalizeKey(transactionBankName(tx));
    if (bank.includes('discover') && DAY_TO_DAY_DISCOVER_CATEGORIES.has(key)) {
      discoverDayToDayActual += amount;
      discoverDayToDayBudget += toNumber(expenseLookup.get(key), 0);
    }
  });

  const rows = Array.from(categoryMap.values())
    .map((row) => {
      const remaining = row.budgetAmount - row.actualSpent;
      return {
        ...row,
        remaining,
        status: row.budgetAmount <= 0
          ? 'No budget'
          : remaining < 0
            ? 'Over budget'
            : 'Under budget',
      };
    })
    .sort((a, b) => b.actualSpent - a.actualSpent);

  return {
    rows,
    totalActualSpent: rows.reduce((sum, row) => sum + row.actualSpent, 0),
    totalBudget: rows.reduce((sum, row) => sum + row.budgetAmount, 0),
    discoverDayToDayActual,
    discoverDayToDayBudget,
    discoverDayToDayOverBy: Math.max(0, discoverDayToDayActual - discoverDayToDayBudget),
  };
}

export function calculateTransferSummary(state) {
  const periodTx = getPeriodTransactions(state);
  const transferTransactions = periodTx.filter((tx) => !tx.ignored && isTransferTransaction(tx));

  const fromSettings = Array.isArray(state?.masterList?.transferRules)
    ? state.masterList.transferRules
    : [];

  const incomeSummary = getIncomeSummary(state);
  const planned = fromSettings.length
    ? fromSettings.map((rule) => ({
        id: rule.id || `${rule.fromBankId || ''}-${rule.toBankId || ''}-${rule.name || ''}`,
        name: rule.name || 'Planned transfer',
        fromBank: rule.fromBankName || rule.fromBankId || 'Unknown',
        toBank: rule.toBankName || rule.toBankId || 'Unknown',
        plannedAmount: toNumber(rule.amount, 0),
      }))
    : [];

  const rows = planned.map((plan) => {
    const fromNeedle = normalizeKey(plan.fromBank);
    const toNeedle = normalizeKey(plan.toBank);

    const outCandidates = transferTransactions.filter((tx) => {
      const bank = normalizeKey(transactionBankName(tx));
      const amount = Math.abs(toNumber(tx.amount, 0));
      return (fromNeedle ? bank.includes(fromNeedle) : true)
        && normalizeKey(tx.category) === 'out'
        && Math.abs(amount - plan.plannedAmount) <= Math.max(1, plan.plannedAmount * 0.1);
    });

    const inCandidates = transferTransactions.filter((tx) => {
      const bank = normalizeKey(transactionBankName(tx));
      const amount = Math.abs(toNumber(tx.amount, 0));
      return (toNeedle ? bank.includes(toNeedle) : true)
        && normalizeKey(tx.category) === 'in'
        && Math.abs(amount - plan.plannedAmount) <= Math.max(1, plan.plannedAmount * 0.1);
    });

    const outAmount = outCandidates.reduce((sum, tx) => sum + Math.abs(toNumber(tx.amount, 0)), 0);
    const inAmount = inCandidates.reduce((sum, tx) => sum + Math.abs(toNumber(tx.amount, 0)), 0);
    const actualAmount = Math.min(outAmount, inAmount);

    let status = 'Not found';
    if (outCandidates.length && inCandidates.length) {
      if (actualAmount > plan.plannedAmount * 1.1) status = 'Over-transferred';
      else if (Math.abs(actualAmount - plan.plannedAmount) <= Math.max(1, plan.plannedAmount * 0.05)) status = 'Found';
      else status = 'Partial';
    } else if (outCandidates.length || inCandidates.length) {
      status = 'Needs review';
    }

    return {
      ...plan,
      actualTransferFound: actualAmount,
      status,
    };
  });

  return {
    rows,
    totalPlanned: rows.reduce((sum, row) => sum + row.plannedAmount, 0),
    totalActual: rows.reduce((sum, row) => sum + row.actualTransferFound, 0),
  };
}

export function calculateBankSummary(state) {
  const accounts = state?.accounts || [];
  const periodTx = getPeriodTransactions(state);
  const billsSummary = calculateBillsSummary(state);

  const byBank = accounts.map((account) => {
    const accountName = bankNameForAccount(account);
    const accountKey = normalizeKey(accountName);

    const bankTransactions = periodTx.filter((tx) => {
      const txBank = normalizeKey(transactionBankName(tx));
      const txAccountId = transactionAccountId(tx);
      return txAccountId === account.id || (accountKey && txBank.includes(accountKey));
    });

    const spending = bankTransactions
      .filter((tx) => isSpendingTransaction(tx, isPendingAllowed(state)))
      .reduce((sum, tx) => sum + Math.abs(toNumber(tx.amount, 0)), 0);

    const transfersIn = bankTransactions
      .filter((tx) => normalizeKey(tx.category) === 'in' && isTransferTransaction(tx))
      .reduce((sum, tx) => sum + Math.abs(toNumber(tx.amount, 0)), 0);

    const transfersOut = bankTransactions
      .filter((tx) => normalizeKey(tx.category) === 'out' && isTransferTransaction(tx))
      .reduce((sum, tx) => sum + Math.abs(toNumber(tx.amount, 0)), 0);

    const plannedRows = billsSummary.rows.filter((row) => normalizeKey(row.paidFrom).includes(accountKey));
    const plannedNeededFromBank = plannedRows.reduce((sum, row) => sum + row.amount, 0);
    const alreadyPaidFromBank = plannedRows.filter((row) => row.status === 'Paid').reduce((sum, row) => sum + row.amount, 0);

    return {
      bankId: account.id,
      accountName,
      currentBalance: toNumber(account.balanceCurrent, 0),
      plannedNeededFromBank,
      alreadyPaidFromBank,
      amountLeftToPayFromBank: plannedNeededFromBank - alreadyPaidFromBank,
      actualSpending: spending,
      transfersIn,
      transfersOut,
    };
  });

  return {
    rows: byBank,
  };
}

export function getDashboardAlerts(state) {
  const alerts = [];
  const incomeSummary = getIncomeSummary(state);
  const billsSummary = calculateBillsSummary(state);
  const spendingSummary = calculateSpendingSummary(state);
  const transferSummary = calculateTransferSummary(state);
  const bankSummary = calculateBankSummary(state);

  if (incomeSummary.regularPaycheck <= 0) {
    alerts.push({ type: 'danger', message: 'Paycheck not found for this pay period.' });
  }

  if (incomeSummary.budgetTotal < incomeSummary.recurringBillsDue) {
    alerts.push({
      type: 'danger',
      message: `This paycheck is short by $${Math.abs(incomeSummary.budgetTotal - incomeSummary.recurringBillsDue).toFixed(2)}.`,
    });
  }

  if (incomeSummary.budgetTotal > incomeSummary.recurringBillsDue) {
    alerts.push({
      type: 'success',
      message: `You have $${(incomeSummary.budgetTotal - incomeSummary.recurringBillsDue).toFixed(2)} left after planned bills.`,
    });
  }

  if (billsSummary.unpaidAmount > 0) {
    alerts.push({
      type: 'warning',
      message: `You still have $${billsSummary.unpaidAmount.toFixed(2)} left to pay across ${billsSummary.unpaidBillsCount} bills.`,
    });
  }

  if (billsSummary.overdueUnpaidBills > 0) {
    alerts.push({
      type: 'danger',
      message: `${billsSummary.overdueUnpaidBills} bills are overdue.`,
    });
  }

  const missingPaidFrom = (state?.masterList?.recurringBillsList || []).filter((bill) => bill.active && !String(bill.paidFrom || '').trim()).length;
  if (missingPaidFrom > 0) {
    alerts.push({ type: 'warning', message: `${missingPaidFrom} items need a Paid From bank selected.` });
  }

  const uncategorized = getPeriodTransactions(state).filter((tx) => !tx.ignored && (!String(tx.category || '').trim() || normalizeKey(tx.category) === 'uncategorized')).length;
  if (uncategorized > 0) {
    alerts.push({ type: 'warning', message: `${uncategorized} transactions need categories.` });
  }

  const possibleMatches = (state?.billStatusRows || []).filter((row) => normalizeKey(row.matchStatus) === 'possible match').length;
  if (possibleMatches > 0) {
    alerts.push({ type: 'info', message: `${possibleMatches} possible bill matches need review.` });
  }

  const missingBoaDiscover = transferSummary.rows.some((row) => {
    const fromBoa = normalizeKey(row.fromBank).includes('bank of america') || normalizeKey(row.fromBank) === 'boa';
    const toDiscover = normalizeKey(row.toBank).includes('discover');
    return fromBoa && toDiscover && row.status !== 'Found';
  });
  if (missingBoaDiscover) {
    alerts.push({ type: 'warning', message: 'Planned transfer to Discover not found.' });
  }

  if (spendingSummary.discoverDayToDayOverBy > 0) {
    alerts.push({
      type: 'warning',
      message: `Discover spending is over budget by $${spendingSummary.discoverDayToDayOverBy.toFixed(2)}.`,
    });
  }

  bankSummary.rows.forEach((row) => {
    if (row.amountLeftToPayFromBank > 0 && row.currentBalance < row.amountLeftToPayFromBank) {
      const shortBy = row.amountLeftToPayFromBank - row.currentBalance;
      alerts.push({
        type: 'warning',
        message: `Bank balance may be short by $${shortBy.toFixed(2)} for remaining planned payments.`,
      });
    }
  });

  const latestSyncMs = (state?.plaidItems || [])
    .map((item) => item.lastSyncedAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];

  if (latestSyncMs && (Date.now() - latestSyncMs) > 24 * 60 * 60 * 1000) {
    alerts.push({ type: 'warning', message: 'Bank data has not synced in over 24 hours.' });
  }

  return alerts;
}

export function calculateDashboard(state) {
  const incomeSummary = getIncomeSummary(state);
  const billsSummary = calculateBillsSummary(state);
  const bankSummary = calculateBankSummary(state);
  const spendingSummary = calculateSpendingSummary(state);
  const transferSummary = calculateTransferSummary(state);
  const alerts = getDashboardAlerts(state);

  return {
    payPeriod: state?.payPeriod || null,
    incomeSummary,
    billsSummary,
    bankSummary,
    spendingSummary,
    transferSummary,
    alerts,
    quickStats: {
      banksConnected: (state?.accounts || []).length,
      transactionsInPeriod: getPeriodTransactions(state).length,
      uncategorizedTransactions: getPeriodTransactions(state).filter((tx) => !tx.ignored && (!String(tx.category || '').trim() || normalizeKey(tx.category) === 'uncategorized')).length,
      possibleBillMatches: (state?.billStatusRows || []).filter((row) => normalizeKey(row.matchStatus) === 'possible match').length,
    },
  };
}
