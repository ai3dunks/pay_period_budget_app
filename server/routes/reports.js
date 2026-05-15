import { Router } from 'express';
import db from '../db.js';
import { loadBudgetContext } from '../../src/utils/loadBudgetContext.js';
import { buildPayPeriodSummary } from '../../shared/payPeriodSummary.js';
import { generateReportInsights } from '../../shared/reportInsights.js';

const router = Router();

function toNumber(value, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function toIsoDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function parsePeriodId(periodId) {
  const parts = String(periodId || '').slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const start = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(start.getTime())) return null;
  const displayEnd = new Date(start);
  displayEnd.setDate(displayEnd.getDate() + 13);
  const exclusiveEnd = new Date(start);
  exclusiveEnd.setDate(exclusiveEnd.getDate() + 14);
  return {
    id: toIsoDate(start),
    startDate: toIsoDate(start),
    displayEndDate: toIsoDate(displayEnd),
    exclusiveEndDate: toIsoDate(exclusiveEnd),
    label: toIsoDate(start) + ' - ' + toIsoDate(displayEnd),
  };
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function boolParam(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  return defaultValue;
}

function limitParam(value, defaultValue = 12, maxValue = 36) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.max(1, Math.min(maxValue, Math.floor(parsed)));
}

function compactSample(values = [], max = 5) {
  return values.slice(0, max);
}

function normalizeStatus(status, hasSnapshot) {
  const key = String(status || '').toLowerCase();
  if (key === 'closed') return 'Closed';
  if (key === 'open' && hasSnapshot) return 'Snapshot Saved';
  if (key === 'open') return 'Open';
  if (hasSnapshot) return 'Snapshot Saved';
  return 'Missing Snapshot';
}

function computePeriodIssues(row) {
  const issues = [];
  if (toNumber(row.expenseRemaining, 0) < 0) issues.push('over budget');
  if (toNumber(row.recurringBillsLeftToPay, 0) > 0) issues.push('unpaid bills');
  if (toNumber(row.unreviewedTransactions, 0) > 0) issues.push('unreviewed transactions');
  if (toNumber(row.transferShortfall, 0) > 0) issues.push('transfer shortfall');
  if (row.boaRollover === null || row.boaRollover === undefined) issues.push('rollover unavailable');
  if (toNumber(row.dataHealthScore, 100) < 70) {
    issues.push('low data health');
    row.dataHealthWarning = 'Some report values may be incomplete because this period had data health issues.';
  }
  return compactSample(issues, 5);
}

function periodFromSnapshotRow(snapshot, closeout) {
  const snapshotJson = parseJson(snapshot.snapshot_json, {}) || {};
  const closeoutJson = parseJson(closeout?.closeout_json, {}) || {};
  const sourceTotals = closeoutJson.totals || snapshotJson.totals || {};
  const sourceCounts = closeoutJson.counts || snapshotJson.counts || {};
  const transferRows = (closeoutJson.rows?.transfers || snapshotJson.rows?.transfers || []).filter(Boolean);

  let completedTransfersTotal = transferRows.reduce((sum, row) => sum + toNumber(row.completedAmount, 0), 0);
  if (completedTransfersTotal <= 0) {
    completedTransfersTotal =
      toNumber(snapshot.josh_transfer, 0)
      + toNumber(snapshot.taylor_transfer, 0)
      + toNumber(snapshot.discover_transfer, 0)
      + toNumber(snapshot.debt_savings_transfer, 0)
      + toNumber(snapshot.boa_reserve, 0);
  }

  const row = {
    periodId: snapshot.period_id,
    periodLabel: snapshot.period_label,
    startDate: snapshot.start_date,
    displayEndDate: snapshot.display_end_date,
    status: normalizeStatus(closeout?.status, true),
    snapshotId: snapshot.id,
    closedAt: closeout?.closed_at || null,

    budgetIncome: toNumber(snapshot.budget_income, 0),
    regularPaycheck: toNumber(snapshot.regular_paycheck, 0),
    bonusIncome: toNumber(snapshot.bonus_income, 0),
    otherIncome: toNumber(snapshot.other_income, 0),

    recurringBillsDue: toNumber(snapshot.recurring_bills_due, 0),
    recurringBillsPaid: toNumber(snapshot.recurring_bills_paid, 0),
    recurringBillsLeftToPay: toNumber(snapshot.recurring_bills_left_to_pay, 0),

    expenseBudget: toNumber(snapshot.expense_budget, 0),
    actualExpenseSpending: toNumber(snapshot.actual_expense_spending, 0),
    expenseRemaining: toNumber(snapshot.expense_remaining, 0),
    overBudgetCategoryCount: toNumber(sourceCounts.overBudgetCategoryCount, 0),

    plannedTransfersTotal: toNumber(snapshot.planned_transfers_total, 0),
    completedTransfersTotal,
    transferShortfall: Math.max(0, toNumber(snapshot.planned_transfers_total, 0) - completedTransfersTotal),

    safeToSpend: sourceTotals.safeToSpend === null || sourceTotals.safeToSpend === undefined ? null : toNumber(sourceTotals.safeToSpend, 0),
    safeToTransfer: sourceTotals.safeToTransfer === null || sourceTotals.safeToTransfer === undefined ? null : toNumber(sourceTotals.safeToTransfer, 0),
    boaRollover: snapshot.boa_rollover === null || snapshot.boa_rollover === undefined ? null : toNumber(snapshot.boa_rollover, 0),

    reviewedTransactions: toNumber(snapshot.reviewed_transactions, 0),
    unreviewedTransactions: toNumber(snapshot.unreviewed_transactions, 0),
    pendingTransactions: toNumber(sourceCounts.pendingTransactions, 0),

    cashRemaining: toNumber(snapshot.cash_remaining, 0),
    _snapshotJson: snapshotJson,
    _closeoutJson: closeoutJson,
    _transferRows: transferRows,
  };

  row.issues = computePeriodIssues(row);
  return row;
}

function periodFromCloseoutOnly(closeout) {
  const closeoutJson = parseJson(closeout.closeout_json, {}) || {};
  const totals = closeoutJson.totals || {};
  const counts = closeoutJson.counts || {};
  const transferRows = (closeoutJson.rows?.transfers || []).filter(Boolean);
  const completedTransfersTotal = transferRows.reduce((sum, row) => sum + toNumber(row.completedAmount, 0), 0);
  const plannedTransfersTotal = toNumber(totals.plannedTransfersTotal, 0);

  const row = {
    periodId: closeout.period_id,
    periodLabel: closeout.period_label,
    startDate: closeout.start_date,
    displayEndDate: closeout.display_end_date,
    status: 'Missing Snapshot',
    snapshotId: null,
    closedAt: closeout.closed_at || null,

    budgetIncome: toNumber(totals.budgetIncome, 0),
    regularPaycheck: toNumber(totals.regularPaycheck, 0),
    bonusIncome: toNumber(totals.bonusIncome, 0),
    otherIncome: toNumber(totals.otherIncome, 0),

    recurringBillsDue: toNumber(totals.recurringBillsDue, 0),
    recurringBillsPaid: toNumber(totals.recurringBillsPaid, 0),
    recurringBillsLeftToPay: toNumber(totals.recurringBillsLeftToPay, 0),

    expenseBudget: toNumber(totals.expenseBudget, 0),
    actualExpenseSpending: toNumber(totals.actualExpenseSpending, 0),
    expenseRemaining: toNumber(totals.expenseRemaining, 0),
    overBudgetCategoryCount: toNumber(counts.overBudgetCategoryCount, 0),

    plannedTransfersTotal,
    completedTransfersTotal,
    transferShortfall: Math.max(0, plannedTransfersTotal - completedTransfersTotal),

    safeToSpend: totals.safeToSpend === null || totals.safeToSpend === undefined ? null : toNumber(totals.safeToSpend, 0),
    safeToTransfer: totals.safeToTransfer === null || totals.safeToTransfer === undefined ? null : toNumber(totals.safeToTransfer, 0),
    boaRollover: totals.boaRollover === null || totals.boaRollover === undefined ? null : toNumber(totals.boaRollover, 0),

    reviewedTransactions: toNumber(counts.reviewedTransactions, 0),
    unreviewedTransactions: toNumber(counts.unreviewedTransactions, 0),
    pendingTransactions: toNumber(counts.pendingTransactions, 0),

    cashRemaining: toNumber(totals.cashRemaining, 0),
    _snapshotJson: {},
    _closeoutJson: closeoutJson,
    _transferRows: transferRows,
  };

  row.issues = computePeriodIssues(row);
  return row;
}

async function periodFromLiveCurrent(currentPeriodId) {
  const period = parsePeriodId(currentPeriodId);
  if (!period) return null;

  const context = await loadBudgetContext({ period });
  const summary = buildPayPeriodSummary(context);

  const transferRows = [
    { targetKey: 'josh', targetLabel: 'Josh', plannedAmount: toNumber(summary.transfers.josh, 0), completedAmount: 0 },
    { targetKey: 'taylor', targetLabel: 'Taylor', plannedAmount: toNumber(summary.transfers.taylor, 0), completedAmount: 0 },
    { targetKey: 'discover', targetLabel: 'Discover', plannedAmount: toNumber(summary.transfers.discover, 0), completedAmount: 0 },
    { targetKey: 'debtSavings', targetLabel: 'Debt/Savings', plannedAmount: toNumber(summary.transfers.debtSavings, 0), completedAmount: 0 },
    { targetKey: 'boaReserve', targetLabel: 'BOA Reserve', plannedAmount: toNumber(summary.transfers.boaReserve, 0), completedAmount: 0 },
  ];

  const row = {
    periodId: period.id,
    periodLabel: period.label,
    startDate: period.startDate,
    displayEndDate: period.displayEndDate,
    status: 'Open',
    snapshotId: null,
    closedAt: null,

    budgetIncome: toNumber(summary.income.budgetIncome, 0),
    regularPaycheck: toNumber(summary.income.regularPaycheck, 0),
    bonusIncome: toNumber(summary.income.bonusIncome, 0),
    otherIncome: toNumber(summary.income.otherIncome, 0),

    recurringBillsDue: toNumber(summary.recurringBills.dueTotal, 0),
    recurringBillsPaid: toNumber(summary.recurringBills.paidTotal, 0),
    recurringBillsLeftToPay: toNumber(summary.recurringBills.unpaidTotal, 0),

    expenseBudget: toNumber(summary.expenses.budgetTotal, 0),
    actualExpenseSpending: toNumber(summary.expenses.actualTotal, 0),
    expenseRemaining: toNumber(summary.expenses.remaining, 0),
    overBudgetCategoryCount: toNumber(summary.expenses.overBudgetCount, 0),

    plannedTransfersTotal: toNumber(summary.transfers.total, 0),
    completedTransfersTotal: 0,
    transferShortfall: Math.max(0, toNumber(summary.transfers.total, 0)),

    safeToSpend: summary.safeMoney?.safeToSpend?.amount ?? null,
    safeToTransfer: summary.safeMoney?.safeToTransfer?.amount ?? null,
    boaRollover: summary.rollover?.amount ?? null,

    reviewedTransactions: context.transactions.filter((row) => !row.ignored && !!row.reviewed).length,
    unreviewedTransactions: context.transactions.filter((row) => !row.ignored && !row.reviewed).length,
    pendingTransactions: context.transactions.filter((row) => !!row.pending && !row.ignored).length,

    cashRemaining: toNumber(summary.safeToSpend, 0),
    _snapshotJson: {
      rows: {
        expenseCategories: summary.expenses.categoryRows || [],
      },
      totals: {
        safeToSpend: summary.safeMoney?.safeToSpend?.amount ?? null,
        safeToTransfer: summary.safeMoney?.safeToTransfer?.amount ?? null,
      },
      counts: {
        overBudgetCategoryCount: toNumber(summary.expenses.overBudgetCount, 0),
      },
    },
    _closeoutJson: {},
    _transferRows: transferRows,
  };

  row.issues = computePeriodIssues(row);
  return row;
}

async function fetchDataHealthScore(periodId, req) {
  try {
    const host = req.get('host') || 'localhost:8787';
    const protocol = req.protocol || 'http';
    const response = await fetch(protocol + '://' + host + '/api/data-health?periodId=' + encodeURIComponent(periodId));
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return toNumber(data.score, null);
  } catch {
    return null;
  }
}

function summarizeTotals(periods = []) {
  const count = periods.length || 1;
  const sum = (field) => periods.reduce((acc, row) => acc + toNumber(row[field], 0), 0);
  return {
    periodCount: periods.length,
    averageBudgetIncome: sum('budgetIncome') / count,
    averageRecurringBillsDue: sum('recurringBillsDue') / count,
    averageActualExpenses: sum('actualExpenseSpending') / count,
    averageCashRemaining: sum('cashRemaining') / count,
    averageSafeToSpend: periods.reduce((acc, row) => acc + (row.safeToSpend === null ? 0 : toNumber(row.safeToSpend, 0)), 0) / count,
    periodsOverBudget: periods.filter((row) => toNumber(row.expenseRemaining, 0) < 0).length,
  };
}

function summarizeTrends(periods = []) {
  const latest = periods[0] || null;
  const previous = periods[1] || null;

  const delta = (field) => {
    if (!latest || !previous) return null;
    const a = toNumber(latest[field], 0);
    const b = toNumber(previous[field], 0);
    const amount = a - b;
    const pct = Math.abs(b) < 0.0001 ? null : (amount / Math.abs(b)) * 100;
    return { amount, pct };
  };

  return {
    safeToSpendDelta: delta('safeToSpend'),
    expensesDelta: delta('actualExpenseSpending'),
    recurringBillsDelta: delta('recurringBillsDue'),
    incomeDelta: delta('budgetIncome'),
    transferShortfallDelta: delta('transferShortfall'),
  };
}

function buildCategoryTrendRows(periods = []) {
  const rows = [];
  for (const period of periods) {
    const categoryRows = period._snapshotJson?.rows?.expenseCategories || period._closeoutJson?.rows?.expenseCategories || [];
    for (const category of categoryRows) {
      const budget = toNumber(category.budgetAmount ?? category.budget, 0);
      const actual = toNumber(category.actualAmount ?? category.actual, 0);
      const remaining = toNumber(category.remaining, budget - actual);
      rows.push({
        periodId: period.periodId,
        periodLabel: period.periodLabel,
        category: String(category.name || '').trim(),
        budget,
        actual,
        remaining,
        overBudget: remaining < 0,
      });
    }
  }
  return rows;
}

function buildCategorySummary(categoryRows = []) {
  const byCategory = new Map();
  for (const row of categoryRows) {
    const key = String(row.category || '').trim();
    if (!key) continue;
    const bucket = byCategory.get(key) || [];
    bucket.push(row);
    byCategory.set(key, bucket);
  }

  return Array.from(byCategory.entries()).map(([category, rows]) => {
    const averageBudget = rows.reduce((sum, row) => sum + toNumber(row.budget, 0), 0) / rows.length;
    const averageActual = rows.reduce((sum, row) => sum + toNumber(row.actual, 0), 0) / rows.length;
    const averageRemaining = rows.reduce((sum, row) => sum + toNumber(row.remaining, 0), 0) / rows.length;
    const timesOverBudget = rows.filter((row) => row.overBudget).length;
    const sortedWorst = rows.slice().sort((a, b) => toNumber(a.remaining, 0) - toNumber(b.remaining, 0));
    const worstPeriod = sortedWorst[0]?.periodLabel || null;

    let trend = 'Stable';
    if (rows.length >= 2) {
      const first = rows[rows.length - 1];
      const latest = rows[0];
      const delta = toNumber(latest.actual, 0) - toNumber(first.actual, 0);
      if (timesOverBudget >= Math.max(2, Math.ceil(rows.length / 2))) trend = 'Over budget often';
      else if (Math.abs(delta) < 10) trend = 'Stable';
      else if (delta > 0) trend = 'Increasing';
      else trend = 'Decreasing';
    } else if (!rows.length) {
      trend = 'No data';
    }

    return {
      category,
      averageBudget,
      averageActual,
      averageRemaining,
      timesOverBudget,
      worstPeriod,
      trend,
    };
  });
}

function buildIncomeTrendRows(periods = []) {
  return periods.map((row) => ({
    periodId: row.periodId,
    periodLabel: row.periodLabel,
    budgetIncome: toNumber(row.budgetIncome, 0),
    regularPaycheck: toNumber(row.regularPaycheck, 0),
    bonusIncome: toNumber(row.bonusIncome, 0),
    otherIncome: toNumber(row.otherIncome, 0),
  }));
}

function buildBillTrendRows(periods = []) {
  const rows = [];
  const billReliabilityByName = new Map();

  for (const period of periods) {
    const closeoutJson = period._closeoutJson || {};
    const snapshotJson = period._snapshotJson || {};
    const paidRows = (closeoutJson.rows?.paidBills || snapshotJson.rows?.paidBills || []).filter(Boolean);
    const unpaidRows = (closeoutJson.rows?.unpaidBills || snapshotJson.rows?.unpaidBills || []).filter(Boolean);

    rows.push({
      periodId: period.periodId,
      periodLabel: period.periodLabel,
      recurringBillsDue: toNumber(period.recurringBillsDue, 0),
      recurringBillsPaid: toNumber(period.recurringBillsPaid, 0),
      recurringBillsLeftToPay: toNumber(period.recurringBillsLeftToPay, 0),
      billCount: paidRows.length + unpaidRows.length,
      paidCount: paidRows.length,
      unpaidCount: unpaidRows.length,
    });

    for (const bill of paidRows) {
      const key = String(bill.name || '').trim();
      if (!key) continue;
      const bucket = billReliabilityByName.get(key) || [];
      bucket.push({ period, bill, paid: true });
      billReliabilityByName.set(key, bucket);
    }
    for (const bill of unpaidRows) {
      const key = String(bill.name || '').trim();
      if (!key) continue;
      const bucket = billReliabilityByName.get(key) || [];
      bucket.push({ period, bill, paid: false });
      billReliabilityByName.set(key, bucket);
    }
  }

  const reliability = Array.from(billReliabilityByName.entries()).map(([billName, values]) => {
    const expectedAmount = values.reduce((sum, row) => sum + toNumber(row.bill.amount, 0), 0) / Math.max(1, values.length);
    const paidCount = values.filter((row) => row.paid).length;
    const missedCount = values.length - paidCount;
    const autoPaidCount = values.filter((row) => row.paid && /autopay|auto/i.test(String(row.bill.status || ''))).length;
    const autopayMatchRate = paidCount > 0 ? (autoPaidCount / paidCount) * 100 : 0;
    const averageAmountDifference = values.reduce((sum, row) => sum + Math.abs(toNumber(row.bill.amount, 0) - expectedAmount), 0) / Math.max(1, values.length);
    const lastPaid = values
      .filter((row) => row.paid)
      .map((row) => row.period.displayEndDate)
      .sort()
      .reverse()[0] || null;

    let status = 'Reliable';
    if (missedCount >= 2) status = 'Often missed';
    else if (averageAmountDifference >= 15) status = 'Amount changed';
    else if (autopayMatchRate < 40) status = 'Needs match words';

    return {
      billName,
      expectedAmount,
      paidOnTimeCount: paidCount,
      missedCount,
      autopayMatchRate,
      averageAmountDifference,
      lastPaidDate: lastPaid,
      status,
    };
  });

  return { rows, reliability };
}

function buildTransferTrendRows(periods = []) {
  const output = [];

  for (const period of periods) {
    const transferRows = period._transferRows || [];
    if (transferRows.length) {
      for (const row of transferRows) {
        const plannedAmount = toNumber(row.plannedAmount, 0);
        const completedAmount = toNumber(row.completedAmount, 0);
        const shortfall = Math.max(0, plannedAmount - completedAmount);
        const overpaid = Math.max(0, completedAmount - plannedAmount);
        const completionRate = plannedAmount > 0 ? (completedAmount / plannedAmount) * 100 : 100;
        output.push({
          periodId: period.periodId,
          periodLabel: period.periodLabel,
          targetKey: String(row.targetKey || '').trim(),
          targetLabel: String(row.targetLabel || row.targetKey || '').trim(),
          plannedAmount,
          completedAmount,
          shortfall,
          overpaid,
          completionRate,
        });
      }
      continue;
    }

    const fallbackRows = [
      { targetKey: 'josh', targetLabel: 'Josh', plannedAmount: toNumber(period.completedTransfersTotal, 0), completedAmount: toNumber(period.completedTransfersTotal, 0) },
    ];

    for (const row of fallbackRows) {
      output.push({
        periodId: period.periodId,
        periodLabel: period.periodLabel,
        targetKey: row.targetKey,
        targetLabel: row.targetLabel,
        plannedAmount: toNumber(row.plannedAmount, 0),
        completedAmount: toNumber(row.completedAmount, 0),
        shortfall: 0,
        overpaid: 0,
        completionRate: 100,
      });
    }
  }

  return output;
}

function buildComparison(periodA, periodB) {
  const metric = (key) => {
    const a = toNumber(periodA?.[key], 0);
    const b = toNumber(periodB?.[key], 0);
    const amount = a - b;
    const percent = Math.abs(b) < 0.0001 ? null : (amount / Math.abs(b)) * 100;
    return { a, b, amount, percent };
  };

  return {
    budgetIncome: metric('budgetIncome'),
    recurringBillsDue: metric('recurringBillsDue'),
    expenseBudget: metric('expenseBudget'),
    actualExpenseSpending: metric('actualExpenseSpending'),
    cashRemaining: metric('cashRemaining'),
    safeToSpend: metric('safeToSpend'),
    plannedTransfersTotal: metric('plannedTransfersTotal'),
    completedTransfersTotal: metric('completedTransfersTotal'),
    unreviewedTransactions: metric('unreviewedTransactions'),
    boaRollover: metric('boaRollover'),
  };
}

async function getReportPeriods({ limit = 12, includeCurrent = true, currentPeriodId = null, req }) {
  const snapshotRows = db.prepare(
    `SELECT s.*, c.status AS closeout_status, c.closed_at, c.closeout_json
     FROM pay_period_snapshots s
     LEFT JOIN pay_period_closeouts c ON c.period_id = s.period_id
     ORDER BY s.start_date DESC, s.created_at DESC`
  ).all();

  const latestByPeriod = new Map();
  for (const row of snapshotRows) {
    if (!latestByPeriod.has(row.period_id)) {
      latestByPeriod.set(row.period_id, row);
    }
  }

  const periods = [];
  for (const snapshot of latestByPeriod.values()) {
    const closeout = {
      status: snapshot.closeout_status,
      closed_at: snapshot.closed_at,
      closeout_json: snapshot.closeout_json,
    };
    periods.push(periodFromSnapshotRow(snapshot, closeout));
  }

  const closeoutsWithoutSnapshots = db.prepare(
    `SELECT c.*
     FROM pay_period_closeouts c
     LEFT JOIN pay_period_snapshots s ON s.id = c.snapshot_id
     WHERE c.snapshot_id IS NULL OR s.id IS NULL`
  ).all();

  for (const closeout of closeoutsWithoutSnapshots) {
    if (periods.some((row) => row.periodId === closeout.period_id)) continue;
    periods.push(periodFromCloseoutOnly(closeout));
  }

  if (includeCurrent && currentPeriodId) {
    const hasCurrent = periods.some((row) => row.periodId === currentPeriodId);
    if (!hasCurrent) {
      const live = await periodFromLiveCurrent(currentPeriodId);
      if (live) periods.push(live);
    }
  }

  periods.sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));

  const limited = periods.slice(0, limit);
  for (const row of limited) {
    row.dataHealthScore = await fetchDataHealthScore(row.periodId, req);
    row.issues = computePeriodIssues(row);
  }

  return limited;
}

router.get('/summary', async (req, res) => {
  try {
    const limit = limitParam(req.query.limit, 12, 36);
    const includeCurrent = boolParam(req.query.includeCurrent, true);
    const currentPeriodId = req.query.currentPeriodId ? String(req.query.currentPeriodId) : null;

    const periods = await getReportPeriods({ limit, includeCurrent, currentPeriodId, req });
    const categoryTrends = buildCategoryTrendRows(periods);
    const transferTrends = buildTransferTrendRows(periods);
    const billTrends = buildBillTrendRows(periods).rows;
    const incomeTrends = buildIncomeTrendRows(periods);

    const totals = summarizeTotals(periods);
    const trends = {
      ...summarizeTrends(periods),
      categorySummary: buildCategorySummary(categoryTrends),
    };
    const insights = generateReportInsights({ periods, categoryTrends, transferTrends, billTrends, incomeTrends });

    res.json({
      periods: periods.map((row) => ({
        periodId: row.periodId,
        periodLabel: row.periodLabel,
        startDate: row.startDate,
        displayEndDate: row.displayEndDate,
        status: row.status,
        snapshotId: row.snapshotId,
        closedAt: row.closedAt,
        budgetIncome: row.budgetIncome,
        regularPaycheck: row.regularPaycheck,
        bonusIncome: row.bonusIncome,
        otherIncome: row.otherIncome,
        recurringBillsDue: row.recurringBillsDue,
        recurringBillsPaid: row.recurringBillsPaid,
        recurringBillsLeftToPay: row.recurringBillsLeftToPay,
        expenseBudget: row.expenseBudget,
        actualExpenseSpending: row.actualExpenseSpending,
        expenseRemaining: row.expenseRemaining,
        overBudgetCategoryCount: row.overBudgetCategoryCount,
        plannedTransfersTotal: row.plannedTransfersTotal,
        completedTransfersTotal: row.completedTransfersTotal,
        transferShortfall: row.transferShortfall,
        safeToSpend: row.safeToSpend,
        safeToTransfer: row.safeToTransfer,
        boaRollover: row.boaRollover,
        reviewedTransactions: row.reviewedTransactions,
        unreviewedTransactions: row.unreviewedTransactions,
        pendingTransactions: row.pendingTransactions,
        cashRemaining: row.cashRemaining,
        dataHealthScore: row.dataHealthScore,
        dataHealthWarning: row.dataHealthWarning || null,
        issues: row.issues || [],
      })),
      totals,
      trends,
      insights,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/reports/summary error:', err);
    res.status(500).json({ error: 'Reports could not be loaded.' });
  }
});

router.get('/period-comparison', async (req, res) => {
  try {
    const periodAId = String(req.query.periodA || '').trim();
    const periodBId = String(req.query.periodB || '').trim();
    if (!periodAId || !periodBId) {
      return res.status(400).json({ error: 'periodA and periodB are required.' });
    }

    const periods = await getReportPeriods({ limit: 36, includeCurrent: true, currentPeriodId: periodAId, req });
    const byId = new Map(periods.map((row) => [row.periodId, row]));
    if (!byId.has(periodBId)) {
      const extra = await getReportPeriods({ limit: 36, includeCurrent: true, currentPeriodId: periodBId, req });
      extra.forEach((row) => byId.set(row.periodId, row));
    }

    const periodA = byId.get(periodAId);
    const periodB = byId.get(periodBId);
    if (!periodA || !periodB) {
      return res.status(404).json({ error: 'Could not find one or both periods.' });
    }

    const deltas = buildComparison(periodA, periodB);
    const insights = generateReportInsights({ periods: [periodA, periodB] });

    res.json({
      periodA,
      periodB,
      deltas,
      insights,
    });
  } catch (err) {
    console.error('GET /api/reports/period-comparison error:', err);
    res.status(500).json({ error: 'Reports could not be loaded.' });
  }
});

router.get('/category-trends', async (req, res) => {
  try {
    const limit = limitParam(req.query.limit, 12, 36);
    const includeCurrent = boolParam(req.query.includeCurrent, true);
    const currentPeriodId = req.query.currentPeriodId ? String(req.query.currentPeriodId) : null;
    const periods = await getReportPeriods({ limit, includeCurrent, currentPeriodId, req });
    const rows = buildCategoryTrendRows(periods);
    const summary = buildCategorySummary(rows);

    res.json({
      rows,
      summary,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/reports/category-trends error:', err);
    res.status(500).json({ error: 'Reports could not be loaded.' });
  }
});

router.get('/bill-trends', async (req, res) => {
  try {
    const limit = limitParam(req.query.limit, 12, 36);
    const includeCurrent = boolParam(req.query.includeCurrent, true);
    const currentPeriodId = req.query.currentPeriodId ? String(req.query.currentPeriodId) : null;
    const periods = await getReportPeriods({ limit, includeCurrent, currentPeriodId, req });
    const billTrends = buildBillTrendRows(periods);

    res.json({
      rows: billTrends.rows,
      reliability: billTrends.reliability,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/reports/bill-trends error:', err);
    res.status(500).json({ error: 'Reports could not be loaded.' });
  }
});

router.get('/transfer-trends', async (req, res) => {
  try {
    const limit = limitParam(req.query.limit, 12, 36);
    const includeCurrent = boolParam(req.query.includeCurrent, true);
    const currentPeriodId = req.query.currentPeriodId ? String(req.query.currentPeriodId) : null;
    const periods = await getReportPeriods({ limit, includeCurrent, currentPeriodId, req });
    const rows = buildTransferTrendRows(periods);

    res.json({
      rows,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/reports/transfer-trends error:', err);
    res.status(500).json({ error: 'Reports could not be loaded.' });
  }
});

router.get('/income-trends', async (req, res) => {
  try {
    const limit = limitParam(req.query.limit, 12, 36);
    const includeCurrent = boolParam(req.query.includeCurrent, true);
    const currentPeriodId = req.query.currentPeriodId ? String(req.query.currentPeriodId) : null;
    const periods = await getReportPeriods({ limit, includeCurrent, currentPeriodId, req });
    const rows = buildIncomeTrendRows(periods);

    const incomes = rows.map((row) => toNumber(row.budgetIncome, 0));
    const averageIncome = incomes.length ? incomes.reduce((sum, value) => sum + value, 0) / incomes.length : 0;
    const highest = rows.slice().sort((a, b) => toNumber(b.budgetIncome, 0) - toNumber(a.budgetIncome, 0))[0] || null;
    const lowest = rows.slice().sort((a, b) => toNumber(a.budgetIncome, 0) - toNumber(b.budgetIncome, 0))[0] || null;

    res.json({
      rows,
      stats: {
        averageIncome,
        highestIncomePeriod: highest,
        lowestIncomePeriod: lowest,
        varianceFromAverage: rows.map((row) => ({
          periodId: row.periodId,
          periodLabel: row.periodLabel,
          delta: toNumber(row.budgetIncome, 0) - averageIncome,
        })),
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/reports/income-trends error:', err);
    res.status(500).json({ error: 'Reports could not be loaded.' });
  }
});

export default router;
