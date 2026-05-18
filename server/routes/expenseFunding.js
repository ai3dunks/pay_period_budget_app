import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';

const router = Router();
const STATUS_SET = new Set(['transfer_confirmed', 'cancelled', 'not_needed']);

function parseAmount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function validateStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  return STATUS_SET.has(text) ? text : 'transfer_confirmed';
}

function toExpenseFundingRecord(row) {
  return {
    id: row.id,
    budgetPeriodId: row.budget_period_id,
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    sourceTargetId: row.source_target_id || '',
    sourceTargetName: row.source_target_name || '',
    confirmedAmount: Number(row.confirmed_amount || 0),
    status: row.status || 'transfer_confirmed',
    confirmedAt: row.confirmed_at || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/records', (req, res) => {
  try {
    const periodId = String(req.query?.periodId || '').trim();
    if (!periodId) return res.json({ records: [] });
    const rows = db.prepare(
      'SELECT * FROM expense_funding_records WHERE budget_period_id = ? ORDER BY confirmed_at DESC, created_at DESC'
    ).all(periodId);
    res.json({ records: rows.map(toExpenseFundingRecord) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load expense funding records.' });
  }
});

router.post('/records', (req, res) => {
  try {
    const now = new Date().toISOString();
    const id = randomUUID();
    const periodId = String(req.body?.budgetPeriodId || '').trim();
    if (!periodId) return res.status(400).json({ error: 'Budget period ID is required.' });

    db.prepare(
      `INSERT INTO expense_funding_records
       (id, budget_period_id, start_date, end_date, source_target_id, source_target_name, confirmed_amount, status, confirmed_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      periodId,
      String(req.body?.startDate || ''),
      String(req.body?.endDate || ''),
      String(req.body?.sourceTargetId || ''),
      String(req.body?.sourceTargetName || ''),
      parseAmount(req.body?.confirmedAmount),
      validateStatus(req.body?.status),
      now,
      String(req.body?.notes || ''),
      now,
      now
    );

    const row = db.prepare('SELECT * FROM expense_funding_records WHERE id = ?').get(id);
    res.status(201).json(toExpenseFundingRecord(row));
  } catch (err) {
    res.status(400).json({ error: 'Failed to create expense funding record.' });
  }
});

router.patch('/records/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT id FROM expense_funding_records WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Expense funding record not found.' });

    const now = new Date().toISOString();
    const updates = [];
    const values = [];

    if (req.body?.budgetPeriodId !== undefined) {
      updates.push('budget_period_id = ?');
      values.push(String(req.body.budgetPeriodId || '').trim());
    }
    if (req.body?.startDate !== undefined) {
      updates.push('start_date = ?');
      values.push(String(req.body.startDate || ''));
    }
    if (req.body?.endDate !== undefined) {
      updates.push('end_date = ?');
      values.push(String(req.body.endDate || ''));
    }
    if (req.body?.sourceTargetId !== undefined) {
      updates.push('source_target_id = ?');
      values.push(String(req.body.sourceTargetId || '').trim());
    }
    if (req.body?.sourceTargetName !== undefined) {
      updates.push('source_target_name = ?');
      values.push(String(req.body.sourceTargetName || '').trim());
    }
    if (req.body?.confirmedAmount !== undefined) {
      updates.push('confirmed_amount = ?');
      values.push(parseAmount(req.body.confirmedAmount));
      updates.push('confirmed_at = ?');
      values.push(now);
    }
    if (req.body?.status !== undefined) {
      updates.push('status = ?');
      values.push(validateStatus(req.body.status));
    }
    if (req.body?.notes !== undefined) {
      updates.push('notes = ?');
      values.push(String(req.body.notes || '').trim());
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.prepare(`UPDATE expense_funding_records SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM expense_funding_records WHERE id = ?').get(id);
    res.json(toExpenseFundingRecord(row));
  } catch (err) {
    res.status(400).json({ error: 'Failed to update expense funding record.' });
  }
});

router.delete('/records/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT id FROM expense_funding_records WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Expense funding record not found.' });
    db.prepare('DELETE FROM expense_funding_records WHERE id = ?').run(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete expense funding record.' });
  }
});

export default router;
