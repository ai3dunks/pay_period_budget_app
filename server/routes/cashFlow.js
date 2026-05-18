import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';

const router = Router();

function toAmount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) throw new Error('Amount must be a number.');
  return Math.round(n * 100) / 100;
}

function toText(value) {
  return String(value || '').trim();
}

function toAdjustmentRow(row) {
  return {
    id: row.id,
    budgetPeriodId: row.budget_period_id,
    date: row.date || '',
    label: row.label || '',
    type: row.type || 'adjustment',
    amount: Number(row.amount || 0),
    account: row.account || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/adjustments', (req, res) => {
  try {
    const periodId = toText(req.query?.budgetPeriodId || req.query?.budget_period_id || '');
    if (!periodId) {
      return res.status(400).json({ error: 'budgetPeriodId is required.' });
    }

    const rows = db.prepare(
      `SELECT *
       FROM cash_flow_forecast_adjustments
       WHERE budget_period_id = ?
       ORDER BY date ASC, created_at ASC`
    ).all(periodId);

    res.json({ adjustments: rows.map(toAdjustmentRow) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cash flow adjustments.' });
  }
});

router.post('/adjustments', (req, res) => {
  try {
    const periodId = toText(req.body?.budgetPeriodId || req.body?.budget_period_id || '');
    const date = toText(req.body?.date || '');
    const label = toText(req.body?.label || '');
    const type = toText(req.body?.type || 'adjustment') || 'adjustment';
    const amount = toAmount(req.body?.amount || 0);
    const account = toText(req.body?.account || '');
    const notes = toText(req.body?.notes || '');

    if (!periodId) return res.status(400).json({ error: 'budgetPeriodId is required.' });
    if (!date) return res.status(400).json({ error: 'date is required.' });
    if (!label) return res.status(400).json({ error: 'label is required.' });

    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO cash_flow_forecast_adjustments
       (id, budget_period_id, date, label, type, amount, account, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, periodId, date, label, type, amount, account, notes, now, now);

    const row = db.prepare('SELECT * FROM cash_flow_forecast_adjustments WHERE id = ?').get(id);
    res.status(201).json({ adjustment: toAdjustmentRow(row) });
  } catch (err) {
    res.status(400).json({ error: 'Failed to create adjustment.' });
  }
});

router.patch('/adjustments/:id', (req, res) => {
  try {
    const id = toText(req.params?.id || '');
    const existing = db.prepare('SELECT id FROM cash_flow_forecast_adjustments WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Adjustment not found.' });

    const updates = [];
    const values = [];

    if (req.body?.date !== undefined) {
      updates.push('date = ?');
      values.push(toText(req.body.date));
    }
    if (req.body?.label !== undefined) {
      updates.push('label = ?');
      values.push(toText(req.body.label));
    }
    if (req.body?.type !== undefined) {
      updates.push('type = ?');
      values.push(toText(req.body.type) || 'adjustment');
    }
    if (req.body?.amount !== undefined) {
      updates.push('amount = ?');
      values.push(toAmount(req.body.amount));
    }
    if (req.body?.account !== undefined) {
      updates.push('account = ?');
      values.push(toText(req.body.account));
    }
    if (req.body?.notes !== undefined) {
      updates.push('notes = ?');
      values.push(toText(req.body.notes));
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update.' });

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE cash_flow_forecast_adjustments SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM cash_flow_forecast_adjustments WHERE id = ?').get(id);
    res.json({ adjustment: toAdjustmentRow(row) });
  } catch (err) {
    res.status(400).json({ error: 'Failed to update adjustment.' });
  }
});

router.delete('/adjustments/:id', (req, res) => {
  try {
    const id = toText(req.params?.id || '');
    const existing = db.prepare('SELECT id FROM cash_flow_forecast_adjustments WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Adjustment not found.' });

    db.prepare('DELETE FROM cash_flow_forecast_adjustments WHERE id = ?').run(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete adjustment.' });
  }
});

export default router;
