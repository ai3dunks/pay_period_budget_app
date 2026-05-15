import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';

const router = Router();

function parseAmount(value) {
  const n = Number(value || 0);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function toTransferConfirmationRow(row) {
  return {
    id: row.id,
    budgetPeriodId: row.budget_period_id,
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    targetName: row.target_name,
    plannedTransfer: Number(row.planned_transfer || 0),
    alreadyUsedAtConfirmation: Number(row.already_used_at_confirmation || 0),
    confirmedTransferAmount: Number(row.confirmed_transfer_amount || 0),
    status: row.status || 'not_confirmed',
    confirmedAt: row.confirmed_at || null,
    sentToDebtSnowball: row.sent_to_debt_snowball || 0,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/transfers/confirmations
// Query params: budget_period_id, target_name (optional)
router.get('/confirmations', (req, res) => {
  try {
    const { budget_period_id: periodId, target_name: targetName } = req.query;
    if (!periodId) {
      return res.status(400).json({ error: 'budget_period_id is required' });
    }

    let query = 'SELECT * FROM transfer_confirmations WHERE budget_period_id = ?';
    const params = [periodId];

    if (targetName) {
      query += ' AND target_name = ?';
      params.push(targetName);
    }

    const rows = db.prepare(query).all(...params);
    res.json({ confirmations: rows.map(toTransferConfirmationRow) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch transfer confirmations' });
  }
});

// POST /api/transfers/confirmations
// Create a new transfer confirmation
router.post('/confirmations', (req, res) => {
  try {
    const { budgetPeriodId, startDate, endDate, targetName, plannedTransfer, alreadyUsedAtConfirmation, confirmedTransferAmount, status, notes } = req.body;

    if (!budgetPeriodId || !targetName) {
      return res.status(400).json({ error: 'budgetPeriodId and targetName are required' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO transfer_confirmations (
        id, budget_period_id, start_date, end_date, target_name, planned_transfer,
        already_used_at_confirmation, confirmed_transfer_amount, status, confirmed_at, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      budgetPeriodId,
      startDate || '',
      endDate || '',
      targetName,
      parseAmount(plannedTransfer),
      parseAmount(alreadyUsedAtConfirmation),
      parseAmount(confirmedTransferAmount),
      status || 'not_confirmed',
      status === 'confirmed' ? now : null,
      notes || '',
      now,
      now
    );

    const row = db.prepare('SELECT * FROM transfer_confirmations WHERE id = ?').get(id);
    res.json({ confirmation: toTransferConfirmationRow(row) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create transfer confirmation' });
  }
});

// PATCH /api/transfers/confirmations/:id
// Update transfer confirmation status
router.patch('/confirmations/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status, confirmedTransferAmount, notes, sentToDebtSnowball, alreadyUsedAtConfirmation } = req.body;

    const updates = [];
    const values = [];

    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
      if (status === 'confirmed') {
        updates.push('confirmed_at = ?');
        values.push(new Date().toISOString());
      }
    }

    if (confirmedTransferAmount !== undefined) {
      updates.push('confirmed_transfer_amount = ?');
      values.push(parseAmount(confirmedTransferAmount));
    }

    if (alreadyUsedAtConfirmation !== undefined) {
      updates.push('already_used_at_confirmation = ?');
      values.push(parseAmount(alreadyUsedAtConfirmation));
    }

    if (notes !== undefined) {
      updates.push('notes = ?');
      values.push(notes);
    }

    if (sentToDebtSnowball !== undefined) {
      updates.push('sent_to_debt_snowball = ?');
      values.push(sentToDebtSnowball ? 1 : 0);
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE transfer_confirmations SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM transfer_confirmations WHERE id = ?').get(id);
    res.json({ confirmation: toTransferConfirmationRow(row) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update transfer confirmation' });
  }
});

// DELETE /api/transfers/confirmations/:id
// Delete transfer confirmation (reset)
router.delete('/confirmations/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM transfer_confirmations WHERE id = ?').run(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete transfer confirmation' });
  }
});

export default router;
