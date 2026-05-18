import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';

const router = Router();
const MAX_CLOSEOUT_BYTES = 512 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function toNumber(value, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function toNullableNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function emptyCloseout(periodId = '', periodLabel = '', startDate = '', displayEndDate = '', exclusiveEndDate = '') {
  return {
    id: null,
    period_id: periodId,
    period_label: periodLabel,
    start_date: startDate,
    display_end_date: displayEndDate,
    exclusive_end_date: exclusiveEndDate,
    status: 'open',
    closed_at: null,
    reopened_at: null,
    snapshot_id: null,
    income_confirmed: 0,
    bills_confirmed: 0,
    transfers_confirmed: 0,
    expenses_confirmed: 0,
    rollover_confirmed: 0,
    notes: '',
    carry_forward_notes: '',
    closeout_json: null,
    created_at: null,
    updated_at: null,
    readyToClose: false,
    blockers: [],
    warnings: [],
  };
}

function sanitizeBillRow(row, fallbackStatus = 'unpaid') {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id || null,
    name: String(row.name || row.billName || '').trim(),
    category: String(row.category || '').trim(),
    dueDate: row.dueDate || row.dueDateStr || null,
    amount: toNumber(row.amount, 0),
    status: String(row.status || fallbackStatus || 'unpaid').trim() || fallbackStatus,
  };
}

function sanitizeExpenseRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    name: String(row.name || '').trim(),
    budgetAmount: toNumber(row.budgetAmount ?? row.budget, 0),
    actualAmount: toNumber(row.actualAmount ?? row.actual, 0),
    remaining: toNumber(row.remaining, 0),
    status: String(row.status || (row.overBudget ? 'over-budget' : 'ok')).trim() || 'ok',
  };
}

function sanitizeTransferRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    targetKey: String(row.targetKey || '').trim(),
    targetLabel: String(row.targetLabel || '').trim(),
    plannedAmount: toNumber(row.plannedAmount, 0),
    completedAmount: toNumber(row.completedAmount, 0),
    remainingAmount: toNumber(row.remainingAmount, 0),
    status: String(row.status || 'pending').trim() || 'pending',
  };
}

function sanitizeAlertRow(row) {
  if (!row) return null;
  if (typeof row === 'string') {
    const message = row.trim();
    return message ? { severity: 'warning', message } : null;
  }
  if (typeof row !== 'object') return null;
  const message = String(row.message || row.text || '').trim();
  if (!message) return null;
  return {
    severity: String(row.severity || 'warning').trim() || 'warning',
    message,
  };
}

function sanitizeCloseoutPayload(payload = {}) {
  const confirmationsSource = payload.confirmations && typeof payload.confirmations === 'object' ? payload.confirmations : payload;
  const totalsSource = payload.totals && typeof payload.totals === 'object' ? payload.totals : {};
  const countsSource = payload.counts && typeof payload.counts === 'object' ? payload.counts : {};
  const rowsSource = payload.rows && typeof payload.rows === 'object' ? payload.rows : {};

  const safeToSpend = totalsSource.safeToSpend === null || totalsSource.safeToSpend === undefined
    ? null
    : toNullableNumber(totalsSource.safeToSpend);
  const safeToTransfer = totalsSource.safeToTransfer === null || totalsSource.safeToTransfer === undefined
    ? null
    : toNullableNumber(totalsSource.safeToTransfer);

  return {
    periodId: String(payload.periodId || '').trim(),
    periodLabel: String(payload.periodLabel || '').trim(),
    startDate: String(payload.startDate || '').trim(),
    displayEndDate: String(payload.displayEndDate || '').trim(),
    exclusiveEndDate: String(payload.exclusiveEndDate || '').trim(),
    confirmations: {
      incomeConfirmed: !!confirmationsSource.incomeConfirmed,
      billsConfirmed: !!confirmationsSource.billsConfirmed,
      transfersConfirmed: !!confirmationsSource.transfersConfirmed,
      expensesConfirmed: !!confirmationsSource.expensesConfirmed,
    },
    notes: String(payload.notes || ''),
    carryForwardNotes: String(payload.carryForwardNotes || ''),
    totals: {
      budgetIncome: toNumber(totalsSource.budgetIncome, 0),
      regularPaycheck: toNumber(totalsSource.regularPaycheck, 0),
      bonusIncome: toNumber(totalsSource.bonusIncome, 0),
      otherIncome: toNumber(totalsSource.otherIncome, 0),
      recurringBillsDue: toNumber(totalsSource.recurringBillsDue, 0),
      recurringBillsPaid: toNumber(totalsSource.recurringBillsPaid, 0),
      recurringBillsLeftToPay: toNumber(totalsSource.recurringBillsLeftToPay, 0),
      expenseBudget: toNumber(totalsSource.expenseBudget, 0),
      actualExpenseSpending: toNumber(totalsSource.actualExpenseSpending, 0),
      expenseRemaining: toNumber(totalsSource.expenseRemaining, 0),
      cashRemaining: toNumber(totalsSource.cashRemaining, 0),
      safeToSpend,
      safeToTransfer,
      plannedTransfersTotal: toNumber(totalsSource.plannedTransfersTotal, 0),
    },
    counts: {
      totalTransactions: toNumber(countsSource.totalTransactions, 0),
      reviewedTransactions: toNumber(countsSource.reviewedTransactions, 0),
      unreviewedTransactions: toNumber(countsSource.unreviewedTransactions, 0),
      ignoredTransactions: toNumber(countsSource.ignoredTransactions, 0),
      recurringBillsDueCount: toNumber(countsSource.recurringBillsDueCount, 0),
      paidBillsCount: toNumber(countsSource.paidBillsCount, 0),
      unpaidBillsCount: toNumber(countsSource.unpaidBillsCount, 0),
      overBudgetCategoryCount: toNumber(countsSource.overBudgetCategoryCount, 0),
      transferPendingCount: toNumber(countsSource.transferPendingCount, 0),
      transferCompleteCount: toNumber(countsSource.transferCompleteCount, 0),
    },
    rows: {
      unpaidBills: Array.isArray(rowsSource.unpaidBills) ? rowsSource.unpaidBills.map((row) => sanitizeBillRow(row, 'unpaid')).filter(Boolean) : [],
      paidBills: Array.isArray(rowsSource.paidBills) ? rowsSource.paidBills.map((row) => sanitizeBillRow(row, 'paid')).filter(Boolean) : [],
      expenseCategories: Array.isArray(rowsSource.expenseCategories) ? rowsSource.expenseCategories.map(sanitizeExpenseRow).filter(Boolean) : [],
      transfers: Array.isArray(rowsSource.transfers) ? rowsSource.transfers.map(sanitizeTransferRow).filter(Boolean) : [],
      alerts: Array.isArray(rowsSource.alerts) ? rowsSource.alerts.map(sanitizeAlertRow).filter(Boolean) : [],
    },
  };
}

function normalizeCloseoutRow(row, fallback = {}) {
  if (!row) {
    return emptyCloseout(fallback.periodId, fallback.periodLabel, fallback.startDate, fallback.displayEndDate, fallback.exclusiveEndDate);
  }

  const closeoutJson = sanitizeCloseoutPayload(parseJson(row.closeout_json, {}) || {});
  const analysis = getCompactCloseoutAnalysis(closeoutJson);

  return {
    ...row,
    closeout_json: closeoutJson,
    checklist: {
      income: { confirmed: !!closeoutJson.confirmations.incomeConfirmed },
      recurringBills: { confirmed: !!closeoutJson.confirmations.billsConfirmed },
      transfers: { confirmed: !!closeoutJson.confirmations.transfersConfirmed },
      expenses: { confirmed: !!closeoutJson.confirmations.expensesConfirmed },
    },
    analysis,
    readyToClose: !!analysis.readyToClose,
    blockers: Array.isArray(analysis.blockers) ? analysis.blockers : [],
    warnings: Array.isArray(analysis.warnings) ? analysis.warnings : [],
  };
}

function getCompactCloseoutAnalysis(payload) {
  const confirmations = payload.confirmations || {};
  const totals = payload.totals || {};
  const counts = payload.counts || {};
  const rows = payload.rows || {};
  const blockers = [];
  const warnings = [];

  if (toNumber(totals.budgetIncome, 0) <= 0) blockers.push('Budget Income is missing.');
  if (toNumber(counts.unreviewedTransactions, 0) > 0 && !confirmations.expensesConfirmed) blockers.push('Unreviewed transactions remain and Expenses are not confirmed.');
  if (toNumber(counts.unpaidBillsCount, 0) > 0 && !confirmations.billsConfirmed) blockers.push('Unpaid recurring bills remain and Bills are not confirmed.');
  if (toNumber(counts.transferPendingCount, 0) > 0 && !confirmations.transfersConfirmed) blockers.push('Transfer checklist still has pending items.');

  if (toNumber(counts.overBudgetCategoryCount, 0) > 0) warnings.push('Expense categories are over budget.');
  if (Number.isFinite(Number(totals.safeToSpend)) && Number(totals.safeToSpend) < 0) warnings.push('Safe to Spend is negative.');
  if (Number.isFinite(Number(totals.safeToTransfer)) && Number(totals.safeToTransfer) < 0) warnings.push('Safe to Transfer is negative.');
  if (rows.alerts.some((row) => String(row.severity || '').toLowerCase() === 'danger')) warnings.push('One or more closeout alerts are marked danger.');

  const readyToClose = !!confirmations.incomeConfirmed && !!confirmations.billsConfirmed && !!confirmations.transfersConfirmed && !!confirmations.expensesConfirmed && blockers.length === 0;
  return {
    readyToClose,
    blockers,
    warnings,
    status: readyToClose ? 'ready_to_close' : 'open',
  };
}

function buildCloseoutJson(payload) {
  return JSON.stringify(sanitizeCloseoutPayload(payload));
}

function loadCloseoutByPeriod(periodId) {
  return db.prepare('SELECT * FROM pay_period_closeouts WHERE period_id = ?').get(periodId);
}

function buildSnapshotTotals(payload) {
  const totals = payload.totals || {};
  const rows = payload.rows || {};
  const transferByKey = new Map((rows.transfers || []).map((row) => [row.targetKey, row]));
  return {
    budget_income: Number(totals.budgetIncome || 0),
    regular_paycheck: Number(totals.regularPaycheck || 0),
    bonus_income: Number(totals.bonusIncome || 0),
    other_income: Number(totals.otherIncome || 0),
    boa_rollover: 0,
    recurring_bills_due: Number(totals.recurringBillsDue || 0),
    recurring_bills_paid: Number(totals.recurringBillsPaid || 0),
    recurring_bills_left_to_pay: Number(totals.recurringBillsLeftToPay || 0),
    expense_budget: Number(totals.expenseBudget || 0),
    actual_expense_spending: Number(totals.actualExpenseSpending || 0),
    expense_remaining: Number(totals.expenseRemaining || 0),
    cash_remaining: Number(totals.cashRemaining || 0),
    planned_transfers_total: Number(totals.plannedTransfersTotal || 0),
    josh_transfer: Number(transferByKey.get('josh')?.completedAmount || 0),
    taylor_transfer: Number(transferByKey.get('taylor')?.completedAmount || 0),
    discover_transfer: Number(transferByKey.get('discover')?.completedAmount || 0),
    debt_savings_transfer: Number(transferByKey.get('debtSavings')?.completedAmount || 0),
    boa_reserve: 0,
    total_transactions: Number(payload.counts?.totalTransactions || 0),
    reviewed_transactions: Number(payload.counts?.reviewedTransactions || 0),
    unreviewed_transactions: Number(payload.counts?.unreviewedTransactions || 0),
    ignored_transactions: Number(payload.counts?.ignoredTransactions || 0),
  };
}

function insertHistorySnapshot({ payload }) {
  const compact = sanitizeCloseoutPayload(payload || {});
  const existing = db.prepare('SELECT * FROM pay_period_snapshots WHERE period_id = ? ORDER BY created_at DESC LIMIT 1').get(compact.periodId);
  if (existing) return existing;

  const id = randomUUID();
  const now = nowIso();
  const totals = buildSnapshotTotals(compact);
  db.prepare(`
    INSERT INTO pay_period_snapshots (
      id, period_id, period_label, start_date, display_end_date, exclusive_end_date,
      budget_income, regular_paycheck, bonus_income, other_income, boa_rollover,
      recurring_bills_due, recurring_bills_paid, recurring_bills_left_to_pay,
      expense_budget, actual_expense_spending, expense_remaining, cash_remaining,
      planned_transfers_total, josh_transfer, taylor_transfer, discover_transfer,
      debt_savings_transfer, boa_reserve,
      total_transactions, reviewed_transactions, unreviewed_transactions, ignored_transactions,
      snapshot_json, notes, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `).run(
    id,
    compact.periodId,
    compact.periodLabel,
    compact.startDate,
    compact.displayEndDate,
    compact.exclusiveEndDate,
    totals.budget_income,
    totals.regular_paycheck,
    totals.bonus_income,
    totals.other_income,
    totals.boa_rollover,
    totals.recurring_bills_due,
    totals.recurring_bills_paid,
    totals.recurring_bills_left_to_pay,
    totals.expense_budget,
    totals.actual_expense_spending,
    totals.expense_remaining,
    totals.cash_remaining,
    totals.planned_transfers_total,
    totals.josh_transfer,
    totals.taylor_transfer,
    totals.discover_transfer,
    totals.debt_savings_transfer,
    totals.boa_reserve,
    totals.total_transactions,
    totals.reviewed_transactions,
    totals.unreviewed_transactions,
    totals.ignored_transactions,
    JSON.stringify(compact),
    compact.notes || '',
    now,
    now
  );

  return db.prepare('SELECT * FROM pay_period_snapshots WHERE id = ?').get(id);
}

function upsertCloseout({ payload, statusOverrides = {} }) {
  const compact = sanitizeCloseoutPayload(payload || {});
  const existing = loadCloseoutByPeriod(compact.periodId);
  const existingRecord = existing ? normalizeCloseoutRow(existing, compact) : emptyCloseout(compact.periodId, compact.periodLabel, compact.startDate, compact.displayEndDate, compact.exclusiveEndDate);
  const evaluation = getCompactCloseoutAnalysis(compact);
  const status = statusOverrides.status || evaluation.status;
  const now = nowIso();
  const createdAt = existing?.created_at || now;
  const closedAt = statusOverrides.closed_at !== undefined ? statusOverrides.closed_at : existing?.closed_at || null;
  const reopenedAt = statusOverrides.reopened_at !== undefined ? statusOverrides.reopened_at : existing?.reopened_at || null;

  db.prepare(
    `INSERT INTO pay_period_closeouts (
      id, period_id, period_label, start_date, display_end_date, exclusive_end_date,
      status, closed_at, reopened_at, snapshot_id,
      income_confirmed, bills_confirmed, transfers_confirmed, expenses_confirmed, rollover_confirmed,
      notes, carry_forward_notes, closeout_json, created_at, updated_at
    ) VALUES (
      @id, @period_id, @period_label, @start_date, @display_end_date, @exclusive_end_date,
      @status, @closed_at, @reopened_at, @snapshot_id,
      @income_confirmed, @bills_confirmed, @transfers_confirmed, @expenses_confirmed, @rollover_confirmed,
      @notes, @carry_forward_notes, @closeout_json, @created_at, @updated_at
    )
    ON CONFLICT(period_id) DO UPDATE SET
      period_label = excluded.period_label,
      start_date = excluded.start_date,
      display_end_date = excluded.display_end_date,
      exclusive_end_date = excluded.exclusive_end_date,
      status = excluded.status,
      closed_at = excluded.closed_at,
      reopened_at = excluded.reopened_at,
      snapshot_id = COALESCE(excluded.snapshot_id, pay_period_closeouts.snapshot_id),
      income_confirmed = excluded.income_confirmed,
      bills_confirmed = excluded.bills_confirmed,
      transfers_confirmed = excluded.transfers_confirmed,
      expenses_confirmed = excluded.expenses_confirmed,
      rollover_confirmed = excluded.rollover_confirmed,
      notes = excluded.notes,
      carry_forward_notes = excluded.carry_forward_notes,
      closeout_json = excluded.closeout_json,
      updated_at = excluded.updated_at`
  ).run({
    id: existing?.id || randomUUID(),
    period_id: compact.periodId,
    period_label: compact.periodLabel,
    start_date: compact.startDate,
    display_end_date: compact.displayEndDate,
    exclusive_end_date: compact.exclusiveEndDate,
    status,
    closed_at: closedAt,
    reopened_at: reopenedAt,
    snapshot_id: existing?.snapshot_id || null,
    income_confirmed: compact.confirmations.incomeConfirmed ? 1 : 0,
    bills_confirmed: compact.confirmations.billsConfirmed ? 1 : 0,
    transfers_confirmed: compact.confirmations.transfersConfirmed ? 1 : 0,
    expenses_confirmed: compact.confirmations.expensesConfirmed ? 1 : 0,
    rollover_confirmed: 0,
    notes: compact.notes || '',
    carry_forward_notes: compact.carryForwardNotes || '',
    closeout_json: buildCloseoutJson(compact),
    created_at: createdAt,
    updated_at: now,
  });

  const row = loadCloseoutByPeriod(compact.periodId);
  return normalizeCloseoutRow(row, compact);
}

function getCloseoutResponse(row, fallback = {}) {
  const normalized = normalizeCloseoutRow(row, fallback);
  return {
    ...normalized,
    readyToClose: !!normalized.readyToClose,
    blockers: normalized.blockers || [],
    warnings: normalized.warnings || [],
  };
}

router.get('/', (req, res) => {
  try {
    const periodId = String(req.query.periodId || '').trim();
    if (!periodId) {
      return res.status(400).json({ error: 'Missing periodId.' });
    }

    const row = loadCloseoutByPeriod(periodId);
    if (!row) {
      return res.json(emptyCloseout(periodId));
    }

    res.json(getCloseoutResponse(row));
  } catch (err) {
    console.error('GET /api/closeout error:', err);
    res.status(500).json({ error: 'Failed to fetch closeout.' });
  }
});

router.post('/prepare', (req, res) => {
  try {
    const payload = req.body || {};
    if (JSON.stringify(payload).length > MAX_CLOSEOUT_BYTES) {
      return res.status(413).json({ error: 'Closeout payload is too large. Save compact summary only.' });
    }
    const compact = sanitizeCloseoutPayload(payload);

    if (!compact.periodId || !compact.periodLabel || !compact.startDate || !compact.displayEndDate || !compact.exclusiveEndDate) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const record = upsertCloseout({
      payload: compact,
    });

    res.json(getCloseoutResponse(record));
  } catch (err) {
    console.error('POST /api/closeout/prepare error:', err);
    res.status(500).json({ error: 'Failed to prepare closeout.' });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM pay_period_closeouts WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Closeout not found.' });
    }

    const payload = req.body || {};
    const existingCompact = sanitizeCloseoutPayload(parseJson(existing.closeout_json, {}) || {});
    const compact = sanitizeCloseoutPayload({
      ...existingCompact,
      confirmations: {
        ...existingCompact.confirmations,
        incomeConfirmed: payload.incomeConfirmed !== undefined ? !!payload.incomeConfirmed : existingCompact.confirmations.incomeConfirmed,
        billsConfirmed: payload.billsConfirmed !== undefined ? !!payload.billsConfirmed : existingCompact.confirmations.billsConfirmed,
        transfersConfirmed: payload.transfersConfirmed !== undefined ? !!payload.transfersConfirmed : existingCompact.confirmations.transfersConfirmed,
        expensesConfirmed: payload.expensesConfirmed !== undefined ? !!payload.expensesConfirmed : existingCompact.confirmations.expensesConfirmed,
      },
      notes: payload.notes !== undefined ? String(payload.notes || '') : existingCompact.notes,
      carryForwardNotes: payload.carryForwardNotes !== undefined ? String(payload.carryForwardNotes || '') : existingCompact.carryForwardNotes,
    });
    const evaluation = getCompactCloseoutAnalysis(compact);

    db.prepare(
      `UPDATE pay_period_closeouts SET
        status = ?,
        income_confirmed = ?, bills_confirmed = ?, transfers_confirmed = ?, expenses_confirmed = ?, rollover_confirmed = ?,
        snapshot_id = ?, notes = ?, carry_forward_notes = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      evaluation.status,
      compact.confirmations.incomeConfirmed ? 1 : 0,
      compact.confirmations.billsConfirmed ? 1 : 0,
      compact.confirmations.transfersConfirmed ? 1 : 0,
      compact.confirmations.expensesConfirmed ? 1 : 0,
      0,
      payload.snapshotId !== undefined ? (payload.snapshotId || null) : existing.snapshot_id,
      compact.notes,
      compact.carryForwardNotes,
      nowIso(),
      existing.id
    );

    db.prepare('UPDATE pay_period_closeouts SET closeout_json = ? WHERE id = ?').run(buildCloseoutJson(compact), existing.id);

    const row = db.prepare('SELECT * FROM pay_period_closeouts WHERE id = ?').get(existing.id);
    res.json(getCloseoutResponse(row));
  } catch (err) {
    console.error('PATCH /api/closeout/:id error:', err);
    res.status(500).json({ error: 'Failed to update closeout.' });
  }
});

router.post('/:id/close', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM pay_period_closeouts WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Closeout not found.' });
    }

    const compact = sanitizeCloseoutPayload(parseJson(existing.closeout_json, {}) || {});
    const evaluation = getCompactCloseoutAnalysis(compact);
    if (!evaluation.readyToClose) {
      return res.status(400).json({ error: 'Closeout is not ready to close.' });
    }

    let snapshot = existing.snapshot_id
      ? db.prepare('SELECT * FROM pay_period_snapshots WHERE id = ?').get(existing.snapshot_id)
      : null;
    if (!snapshot) {
      snapshot = insertHistorySnapshot({ payload: compact });
    }

    const closedAt = nowIso();
    db.prepare('UPDATE pay_period_closeouts SET status = ?, closed_at = ?, reopened_at = NULL, snapshot_id = ?, updated_at = ? WHERE id = ?').run(
      'closed',
      closedAt,
      snapshot?.id || existing.snapshot_id || null,
      closedAt,
      existing.id
    );

    const row = db.prepare('SELECT * FROM pay_period_closeouts WHERE id = ?').get(existing.id);
    res.json({
      ...getCloseoutResponse(row),
      snapshot_id: snapshot?.id || existing.snapshot_id || null,
    });
  } catch (err) {
    console.error('POST /api/closeout/:id/close error:', err);
    res.status(500).json({ error: 'Failed to close period.' });
  }
});

router.post('/:id/reopen', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM pay_period_closeouts WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Closeout not found.' });
    }

    const reopenedAt = nowIso();
    db.prepare('UPDATE pay_period_closeouts SET status = ?, reopened_at = ?, updated_at = ? WHERE id = ?').run(
      'reopened',
      reopenedAt,
      reopenedAt,
      existing.id
    );

    const row = db.prepare('SELECT * FROM pay_period_closeouts WHERE id = ?').get(existing.id);
    res.json(getCloseoutResponse(row));
  } catch (err) {
    console.error('POST /api/closeout/:id/reopen error:', err);
    res.status(500).json({ error: 'Failed to reopen period.' });
  }
});

export default router;
