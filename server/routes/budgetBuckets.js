import { Router } from 'express';
import { randomUUID } from 'crypto';
import db, { safeSqlValue } from '../db.js';

const router = Router();
const VALID_GROUPS = new Set(['Needs', 'Wants', 'Debts/Savings']);

function normalizeBudgetGroup(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'needs') return 'Needs';
  if (raw === 'wants') return 'Wants';
  if (raw === 'debts/savings' || raw === 'debt/savings' || raw === 'debtsavings' || raw === 'debts' || raw === 'savings') {
    return 'Debts/Savings';
  }
  return null;
}

function readSettingJson(key) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  if (!row || row.value_json === null || row.value_json === undefined) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

function getIncludePendingTransactionsSetting() {
  const safeMoney = readSettingJson('safe_money_settings');
  if (safeMoney && typeof safeMoney === 'object') {
    const include = safeMoney.includePendingTransactions ?? safeMoney.include_pending_transactions;
    if (include === true) return true;
    if (include === false) return false;
  }

  const legacy = readSettingJson('include_pending_transactions');
  return legacy === true;
}

function getPeriodParams(req) {
  const payPeriodStart = String(req.query.payPeriodStart || req.body?.payPeriodStart || '').trim();
  const payPeriodEnd = String(req.query.payPeriodEnd || req.body?.payPeriodEnd || '').trim();
  if (!payPeriodStart || !payPeriodEnd) {
    return null;
  }
  return { payPeriodStart, payPeriodEnd };
}

function getBuckets(payPeriodStart, payPeriodEnd) {
  return db.prepare(
    `SELECT id, name, budget_group, pay_period_start, pay_period_end, planned_amount, notes, created_at, updated_at
     FROM budget_buckets
     WHERE pay_period_start = ? AND pay_period_end = ?
     ORDER BY
       CASE budget_group
         WHEN 'Needs' THEN 1
         WHEN 'Wants' THEN 2
         WHEN 'Debts/Savings' THEN 3
         ELSE 99
       END,
       LOWER(name) ASC`
  ).all(payPeriodStart, payPeriodEnd);
}

function getSpendingRows(payPeriodStart, payPeriodEnd, includePendingTransactions) {
  const rows = db.prepare(
    `SELECT id, date, name, merchant_name, amount, pending, ignored, bucket_id, bucket_name
     FROM transactions
     WHERE date >= ? AND date < ? AND ignored = 0 AND amount < 0`
  ).all(payPeriodStart, payPeriodEnd);

  return rows.filter((row) => includePendingTransactions || !row.pending);
}

function buildBucketsPayload({ payPeriodStart, payPeriodEnd }) {
  const includePendingTransactions = getIncludePendingTransactionsSetting();
  const buckets = getBuckets(payPeriodStart, payPeriodEnd);
  const spendingRows = getSpendingRows(payPeriodStart, payPeriodEnd, includePendingTransactions);

  const spentByBucket = new Map();
  for (const row of spendingRows) {
    if (!row.bucket_id) continue;
    const current = Number(spentByBucket.get(row.bucket_id) || 0);
    spentByBucket.set(row.bucket_id, current + Math.abs(Number(row.amount || 0)));
  }

  const groupTotals = {
    Needs: 0,
    Wants: 0,
    'Debts/Savings': 0,
  };

  const rows = buckets.map((bucket) => {
    const group = normalizeBudgetGroup(bucket.budget_group) || bucket.budget_group;
    const planned = Number(bucket.planned_amount || 0);
    const spent = Number(spentByBucket.get(bucket.id) || 0);
    const remaining = planned - spent;
    if (VALID_GROUPS.has(group)) {
      groupTotals[group] += planned;
    }
    return {
      ...bucket,
      budget_group: group,
      planned_amount: planned,
      spent_amount: spent,
      remaining_amount: remaining,
      progress_ratio: planned > 0 ? Math.min(1, spent / planned) : 0,
      overspent: remaining < 0,
    };
  });

  const unassignedRows = spendingRows
    .filter((row) => !String(row.bucket_id || '').trim())
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 100)
    .map((row) => ({
      id: row.id,
      date: row.date,
      name: row.name || row.merchant_name || 'Transaction',
      amount: Math.abs(Number(row.amount || 0)),
      pending: !!row.pending,
    }));

  const unassignedTotal = unassignedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return {
    payPeriodStart,
    payPeriodEnd,
    includePendingTransactions,
    rows,
    groupTotals,
    unassignedSpending: {
      count: unassignedRows.length,
      total: unassignedTotal,
      transactions: unassignedRows,
    },
  };
}

// GET /api/budget-buckets?payPeriodStart=YYYY-MM-DD&payPeriodEnd=YYYY-MM-DD
router.get('/', (req, res) => {
  try {
    const period = getPeriodParams(req);
    if (!period) {
      return res.status(400).json({ error: 'payPeriodStart and payPeriodEnd are required.' });
    }
    return res.json(buildBucketsPayload(period));
  } catch (err) {
    console.error('Error fetching budget buckets:', err.message);
    return res.status(500).json({ error: 'Failed to fetch budget buckets.' });
  }
});

// POST /api/budget-buckets
router.post('/', (req, res) => {
  try {
    const { name, budgetGroup, budget_group, payPeriodStart, payPeriodEnd, plannedAmount, planned_amount, notes } = req.body || {};

    const trimmedName = String(name || '').trim();
    const group = normalizeBudgetGroup(budgetGroup || budget_group);
    const start = String(payPeriodStart || '').trim();
    const end = String(payPeriodEnd || '').trim();
    const planned = Number(plannedAmount ?? planned_amount ?? 0);

    if (!trimmedName) {
      return res.status(400).json({ error: 'Bucket name is required.' });
    }
    if (!group) {
      return res.status(400).json({ error: 'Invalid bucket group.' });
    }
    if (!start || !end) {
      return res.status(400).json({ error: 'payPeriodStart and payPeriodEnd are required.' });
    }
    if (!Number.isFinite(planned) || planned < 0) {
      return res.status(400).json({ error: 'plannedAmount must be a non-negative number.' });
    }

    const now = new Date().toISOString();
    const id = randomUUID();

    db.prepare(
      `INSERT INTO budget_buckets (
        id, name, budget_group, pay_period_start, pay_period_end, planned_amount, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, trimmedName, group, start, end, planned, safeSqlValue(notes), now, now);

    const created = db.prepare(
      `SELECT id, name, budget_group, pay_period_start, pay_period_end, planned_amount, notes, created_at, updated_at
       FROM budget_buckets WHERE id = ?`
    ).get(id);

    return res.status(201).json({ ...created, spent_amount: 0, remaining_amount: Number(created.planned_amount || 0), progress_ratio: 0, overspent: false });
  } catch (err) {
    console.error('Error creating budget bucket:', err.message);
    return res.status(500).json({ error: 'Failed to create budget bucket.' });
  }
});

// PATCH /api/budget-buckets/:id
router.patch('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM budget_buckets WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Bucket not found.' });
    }

    const updates = [];
    const values = [];

    if (req.body?.name !== undefined) {
      const trimmedName = String(req.body.name || '').trim();
      if (!trimmedName) return res.status(400).json({ error: 'Bucket name cannot be empty.' });
      updates.push('name = ?');
      values.push(trimmedName);
    }

    if (req.body?.budgetGroup !== undefined || req.body?.budget_group !== undefined) {
      const group = normalizeBudgetGroup(req.body.budgetGroup ?? req.body.budget_group);
      if (!group) return res.status(400).json({ error: 'Invalid bucket group.' });
      updates.push('budget_group = ?');
      values.push(group);
    }

    if (req.body?.plannedAmount !== undefined || req.body?.planned_amount !== undefined) {
      const planned = Number(req.body.plannedAmount ?? req.body.planned_amount);
      if (!Number.isFinite(planned) || planned < 0) {
        return res.status(400).json({ error: 'plannedAmount must be a non-negative number.' });
      }
      updates.push('planned_amount = ?');
      values.push(planned);
    }

    if (req.body?.notes !== undefined) {
      updates.push('notes = ?');
      values.push(safeSqlValue(req.body.notes));
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No editable fields provided.' });
    }

    const now = new Date().toISOString();
    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.prepare(`UPDATE budget_buckets SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare(
      `SELECT id, name, budget_group, pay_period_start, pay_period_end, planned_amount, notes, created_at, updated_at
       FROM budget_buckets WHERE id = ?`
    ).get(id);

    db.prepare('UPDATE transactions SET bucket_name = ? WHERE bucket_id = ?').run(updated.name, updated.id);

    return res.json(updated);
  } catch (err) {
    console.error('Error updating budget bucket:', err.message);
    return res.status(500).json({ error: 'Failed to update budget bucket.' });
  }
});

// DELETE /api/budget-buckets/:id
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT id FROM budget_buckets WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Bucket not found.' });
    }

    const tx = db.transaction(() => {
      db.prepare('UPDATE transactions SET bucket_id = NULL, bucket_name = NULL WHERE bucket_id = ?').run(id);
      db.prepare('DELETE FROM budget_buckets WHERE id = ?').run(id);
    });

    tx();
    return res.json({ ok: true, id });
  } catch (err) {
    console.error('Error deleting budget bucket:', err.message);
    return res.status(500).json({ error: 'Failed to delete budget bucket.' });
  }
});

// POST /api/budget-buckets/:id/assign-transaction
router.post('/:id/assign-transaction', (req, res) => {
  try {
    const { id } = req.params;
    const transactionId = String(req.body?.transactionId || '').trim();
    if (!transactionId) {
      return res.status(400).json({ error: 'transactionId is required.' });
    }

    const bucket = db.prepare(
      'SELECT id, name, budget_group, pay_period_start, pay_period_end FROM budget_buckets WHERE id = ?'
    ).get(id);
    if (!bucket) {
      return res.status(404).json({ error: 'Bucket not found.' });
    }

    const transaction = db.prepare(
      'SELECT id, date FROM transactions WHERE id = ?'
    ).get(transactionId);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    if (String(transaction.date || '') < String(bucket.pay_period_start) || String(transaction.date || '') >= String(bucket.pay_period_end)) {
      return res.status(400).json({ error: 'Transaction is outside the bucket pay period.' });
    }

    db.prepare('UPDATE transactions SET bucket_id = ?, bucket_name = ?, updated_at = ? WHERE id = ?').run(
      bucket.id,
      bucket.name,
      new Date().toISOString(),
      transactionId
    );

    const updated = db.prepare(
      `SELECT id, date, name, merchant_name, amount, pending, ignored, bucket_id, bucket_name
       FROM transactions
       WHERE id = ?`
    ).get(transactionId);

    return res.json(updated);
  } catch (err) {
    console.error('Error assigning transaction to bucket:', err.message);
    return res.status(500).json({ error: 'Failed to assign transaction to bucket.' });
  }
});

export default router;
