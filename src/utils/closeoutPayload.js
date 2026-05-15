function toNumber(value, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function toNullableNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function normalizeStatus(value, fallback = 'unknown') {
  const status = String(value || '').trim();
  return status || fallback;
}

function mapBillRow(row, fallbackStatus) {
  if (!row) return null;
  return {
    id: row.id || null,
    name: row.name || row.billName || '',
    category: row.category || '',
    dueDate: row.dueDate || row.dueDateStr || null,
    amount: toNumber(row.amount, 0),
    status: normalizeStatus(row.statusLabel || row.status?.status || fallbackStatus, fallbackStatus),
  };
}

function mapExpenseRow(row) {
  if (!row) return null;
  return {
    name: row.name || '',
    budgetAmount: toNumber(row.budget, row.budgetAmount),
    actualAmount: toNumber(row.actual, row.actualAmount),
    remaining: toNumber(row.remaining, 0),
    status: row.overBudget ? 'over-budget' : (toNumber(row.remaining, 0) < 0 ? 'negative' : 'ok'),
  };
}

function mapTransferRow(targetKey, targetLabel, plannedAmount, completedAmount) {
  const planned = toNumber(plannedAmount, 0);
  const completed = toNumber(completedAmount, 0);
  return {
    targetKey,
    targetLabel,
    plannedAmount: planned,
    completedAmount: completed,
    remainingAmount: planned - completed,
    status: completed >= planned && planned > 0 ? 'complete' : (planned > 0 ? 'pending' : 'complete'),
  };
}

function normalizeAlerts(alerts = []) {
  return (Array.isArray(alerts) ? alerts : [])
    .filter(Boolean)
    .map((alert) => {
      if (typeof alert === 'string') {
        return { severity: 'warning', message: alert };
      }
      return {
        severity: normalizeStatus(alert.severity, 'warning'),
        message: String(alert.message || alert.text || '').trim(),
      };
    })
    .filter((alert) => alert.message);
}

export function createCompactCloseoutPayload({ period, summary, notes, carryForwardNotes, confirmations }) {
  const confirmationsValue = confirmations || {};
  const recurringBills = summary?.recurringBills || {};
  const expenses = summary?.expenses || {};
  const transfers = summary?.transfers || {};
  const safeMoney = summary?.safeMoney || {};
  const totals = {
    budgetIncome: toNumber(summary?.income?.budgetIncome, 0),
    regularPaycheck: toNumber(summary?.income?.regularPaycheck, 0),
    bonusIncome: toNumber(summary?.income?.bonusIncome, 0),
    otherIncome: toNumber(summary?.income?.otherIncome, 0),
    boaRollover: toNullableNumber(summary?.rollover?.amount ?? summary?.rollover?.boaRollover),
    recurringBillsDue: toNumber(recurringBills.dueTotal, 0),
    recurringBillsPaid: toNumber(recurringBills.paidTotal, 0),
    recurringBillsLeftToPay: toNumber(recurringBills.unpaidTotal, 0),
    expenseBudget: toNumber(expenses.budgetTotal, 0),
    actualExpenseSpending: toNumber(expenses.actualTotal, 0),
    expenseRemaining: toNumber(expenses.remaining, 0),
    cashRemaining: toNumber(expenses.remaining, 0),
    safeToSpend: toNullableNumber(safeMoney.safeToSpend?.amount ?? summary?.safeToSpend),
    safeToTransfer: toNullableNumber(safeMoney.safeToTransfer?.amount ?? summary?.safeToTransfer),
    plannedTransfersTotal: toNumber(transfers.total, 0),
  };

  const paidBills = Array.isArray(recurringBills.paidRows)
    ? recurringBills.paidRows.map((row) => mapBillRow(row, 'paid')).filter(Boolean)
    : [];
  const unpaidBills = Array.isArray(recurringBills.unpaidRows)
    ? recurringBills.unpaidRows.map((row) => mapBillRow(row, 'unpaid')).filter(Boolean)
    : [];
  const expenseCategories = Array.isArray(expenses.categoryRows)
    ? expenses.categoryRows.map(mapExpenseRow).filter(Boolean)
    : [];
  const transferPlanRows = [
    mapTransferRow('josh', 'Josh', transfers.josh, confirmationsValue.transfersConfirmed ? transfers.josh : 0),
    mapTransferRow('taylor', 'Taylor', transfers.taylor, confirmationsValue.transfersConfirmed ? transfers.taylor : 0),
    mapTransferRow('discover', 'Discover', transfers.discover, confirmationsValue.transfersConfirmed ? transfers.discover : 0),
    mapTransferRow('debtSavings', 'Debts/Savings', transfers.debtSavings, confirmationsValue.transfersConfirmed ? transfers.debtSavings : 0),
  ];

  const counts = {
    totalTransactions: toNumber(summary?.dataHealth?.totalTransactions ?? summary?.dataHealth?.periodTransactionCount, 0),
    reviewedTransactions: toNumber(summary?.dataHealth?.reviewedTransactions, 0),
    unreviewedTransactions: toNumber(summary?.dataHealth?.unreviewedTransactions, 0),
    ignoredTransactions: toNumber(summary?.dataHealth?.ignoredTransactions ?? summary?.dataHealth?.ignoredExcludedCount, 0),
    recurringBillsDueCount: unpaidBills.length + paidBills.length,
    paidBillsCount: paidBills.length,
    unpaidBillsCount: unpaidBills.length,
    overBudgetCategoryCount: expenseCategories.filter((row) => row.status === 'over-budget').length,
    transferPendingCount: transferPlanRows.filter((row) => row.status === 'pending').length,
    transferCompleteCount: transferPlanRows.filter((row) => row.status === 'complete').length,
  };

  const alerts = normalizeAlerts([
    ...(Array.isArray(summary?.alerts) ? summary.alerts : []),
    ...(Array.isArray(transfers.alerts) ? transfers.alerts : []),
    ...(Array.isArray(safeMoney.safeToSpend?.warnings) ? safeMoney.safeToSpend.warnings : []),
    ...(Array.isArray(safeMoney.safeToTransfer?.warnings) ? safeMoney.safeToTransfer.warnings : []),
    ...(Array.isArray(safeMoney.safeToSpend?.blockers) ? safeMoney.safeToSpend.blockers : []),
    ...(Array.isArray(safeMoney.safeToTransfer?.blockers) ? safeMoney.safeToTransfer.blockers : []),
  ]);

  return {
    periodId: period?.id || '',
    periodLabel: period?.label || '',
    startDate: period?.startDate || '',
    displayEndDate: period?.displayEndDate || '',
    exclusiveEndDate: period?.exclusiveEndDate || '',
    confirmations: {
      incomeConfirmed: !!confirmationsValue.incomeConfirmed,
      billsConfirmed: !!confirmationsValue.billsConfirmed,
      transfersConfirmed: !!confirmationsValue.transfersConfirmed,
      expensesConfirmed: !!confirmationsValue.expensesConfirmed,
      rolloverConfirmed: !!confirmationsValue.rolloverConfirmed,
    },
    notes: String(notes || ''),
    carryForwardNotes: String(carryForwardNotes || ''),
    totals,
    counts,
    rows: {
      unpaidBills,
      paidBills,
      expenseCategories,
      transfers: transferPlanRows,
      alerts,
    },
  };
}