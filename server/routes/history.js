import { Router } from 'express';
import db from '../db.js';
import { randomUUID } from 'crypto';

const router = Router();
const MAX_HISTORY_BYTES = 512 * 1024;

function toNumber(value, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
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
    status: String(row.status || 'ok').trim() || 'ok',
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

function sanitizeHistorySnapshotPayload(payload = {}) {
  const confirmationsSource = payload.confirmations && typeof payload.confirmations === 'object' ? payload.confirmations : payload;
  const totalsSource = payload.totals && typeof payload.totals === 'object' ? payload.totals : {};
  const countsSource = payload.counts && typeof payload.counts === 'object' ? payload.counts : {};
  const rowsSource = payload.rows && typeof payload.rows === 'object' ? payload.rows : {};

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
      safeToSpend: totalsSource.safeToSpend === null || totalsSource.safeToSpend === undefined ? null : toNumber(totalsSource.safeToSpend, 0),
      safeToTransfer: totalsSource.safeToTransfer === null || totalsSource.safeToTransfer === undefined ? null : toNumber(totalsSource.safeToTransfer, 0),
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

// Ensure the table exists (idempotent, schema.sql handles it on startup)
// GET /api/history — all snapshots ordered by created_at desc
router.get('/', (_req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT
          s.id, s.period_id, s.period_label, s.start_date, s.display_end_date, s.exclusive_end_date,
          s.budget_income, s.regular_paycheck, s.bonus_income, s.other_income, s.boa_rollover,
          s.recurring_bills_due, s.recurring_bills_paid, s.recurring_bills_left_to_pay,
          s.expense_budget, s.actual_expense_spending, s.expense_remaining, s.cash_remaining,
          s.planned_transfers_total, s.josh_transfer, s.taylor_transfer, s.discover_transfer,
          s.debt_savings_transfer, s.boa_reserve,
          s.total_transactions, s.reviewed_transactions, s.unreviewed_transactions, s.ignored_transactions,
          s.notes, s.created_at, s.updated_at,
          c.id AS closeout_id,
          c.status AS closeout_status,
          c.closed_at AS closeout_closed_at
         FROM pay_period_snapshots s
         LEFT JOIN pay_period_closeouts c ON c.snapshot_id = s.id
         ORDER BY s.created_at DESC`
      )
      .all();

    // Mark latest per period_id
    const latestByPeriod = {};
    for (const row of rows) {
      if (!latestByPeriod[row.period_id]) {
        latestByPeriod[row.period_id] = row.id;
      }
    }

    const result = rows.map((row) => ({
      ...row,
      isLatestForPeriod: latestByPeriod[row.period_id] === row.id,
    }));

    res.json(result);
  } catch (err) {
    console.error('GET /api/history error:', err);
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
});

// GET /api/history/:id — single snapshot with parsed snapshot_json
router.get('/:id', (req, res) => {
  try {
    const row = db
      .prepare('SELECT * FROM pay_period_snapshots WHERE id = ?')
      .get(req.params.id);

    if (!row) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }

    let parsedJson = null;
    if (row.snapshot_json) {
      try {
        parsedJson = JSON.parse(row.snapshot_json);
      } catch (_e) {
        parsedJson = null;
      }
    }

    const latestForPeriod = db
      .prepare(
        'SELECT id FROM pay_period_snapshots WHERE period_id = ? ORDER BY created_at DESC LIMIT 1'
      )
      .get(row.period_id);

    const closeout = db
      .prepare('SELECT id, status, closed_at, reopened_at FROM pay_period_closeouts WHERE snapshot_id = ? LIMIT 1')
      .get(row.id);

    res.json({
      ...row,
      snapshot_json: parsedJson,
      isLatestForPeriod: latestForPeriod?.id === row.id,
      closeoutId: closeout?.id || null,
      closeoutStatus: closeout?.status || null,
      closeoutClosedAt: closeout?.closed_at || null,
    });
  } catch (err) {
    console.error('GET /api/history/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch history snapshot.' });
  }
});

// POST /api/history/snapshot — create new snapshot
router.post('/snapshot', (req, res) => {
  try {
    const payload = req.body || {};
    if (JSON.stringify(payload).length > MAX_HISTORY_BYTES) {
      return res.status(413).json({ error: 'Closeout payload is too large. Save compact summary only.' });
    }

    const compact = sanitizeHistorySnapshotPayload(payload);

    if (!compact.periodId || !compact.periodLabel || !compact.startDate || !compact.displayEndDate || !compact.exclusiveEndDate) {
      return res.status(400).json({ error: 'Missing required fields: periodId, periodLabel, startDate, displayEndDate, exclusiveEndDate' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const transferByKey = new Map((compact.rows.transfers || []).map((row) => [row.targetKey, row]));

    const stmt = db.prepare(`
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
    `);

    stmt.run(
      id, compact.periodId, compact.periodLabel, compact.startDate, compact.displayEndDate, compact.exclusiveEndDate,
      Number(compact.totals.budgetIncome || 0),
      Number(compact.totals.regularPaycheck || 0),
      Number(compact.totals.bonusIncome || 0),
      Number(compact.totals.otherIncome || 0),
      0,
      Number(compact.totals.recurringBillsDue || 0),
      Number(compact.totals.recurringBillsPaid || 0),
      Number(compact.totals.recurringBillsLeftToPay || 0),
      Number(compact.totals.expenseBudget || 0),
      Number(compact.totals.actualExpenseSpending || 0),
      Number(compact.totals.expenseRemaining || 0),
      Number(compact.totals.cashRemaining || 0),
      Number(compact.totals.plannedTransfersTotal || 0),
      Number(transferByKey.get('josh')?.completedAmount || 0),
      Number(transferByKey.get('taylor')?.completedAmount || 0),
      Number(transferByKey.get('discover')?.completedAmount || 0),
      Number(transferByKey.get('debtSavings')?.completedAmount || 0),
      0,
      Number(compact.counts.totalTransactions || 0),
      Number(compact.counts.reviewedTransactions || 0),
      Number(compact.counts.unreviewedTransactions || 0),
      Number(compact.counts.ignoredTransactions || 0),
      JSON.stringify(compact),
      String(compact.notes || ''),
      now,
      now
    );

    const created = db.prepare('SELECT * FROM pay_period_snapshots WHERE id = ?').get(id);
    res.status(201).json(created);
  } catch (err) {
    console.error('POST /api/history/snapshot error:', err);
    res.status(500).json({ error: 'Failed to create history snapshot.' });
  }
});

// DELETE /api/history/:id
router.delete('/:id', (req, res) => {
  try {
    const existing = db
      .prepare('SELECT id FROM pay_period_snapshots WHERE id = ?')
      .get(req.params.id);

    if (!existing) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }

    db.prepare('DELETE FROM pay_period_snapshots WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/history/:id error:', err);
    res.status(500).json({ error: 'Failed to delete history snapshot.' });
  }
});

// PATCH /api/history/:id/notes — update notes only
router.patch('/:id/notes', (req, res) => {
  try {
    const { notes = '' } = req.body;
    const now = new Date().toISOString();

    const existing = db
      .prepare('SELECT id FROM pay_period_snapshots WHERE id = ?')
      .get(req.params.id);

    if (!existing) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }

    db.prepare('UPDATE pay_period_snapshots SET notes = ?, updated_at = ? WHERE id = ?').run(
      String(notes || ''),
      now,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM pay_period_snapshots WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('PATCH /api/history/:id/notes error:', err);
    res.status(500).json({ error: 'Failed to update snapshot notes.' });
  }
});

export default router;
