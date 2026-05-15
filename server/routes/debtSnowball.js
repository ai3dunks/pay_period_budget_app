import { Router } from 'express';
import { randomUUID } from 'crypto';
import db, { safeSqlValue } from '../db.js';

const router = Router();
const STATUS_SET = new Set(['active', 'paused', 'paid']);
const STRATEGY_SET = new Set(['snowball', 'avalanche']);
const CONFIG_KEY = 'debt_snowball_config';

// Use a default starting period (May 8, 2026 in YYYY-MM-DD format)
function getDefaultPeriodId() {
  return '2026-05-08';
}

function toPeriodId(value, fallback = getDefaultPeriodId()) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function readConfig() {
  const nowPeriodId = getDefaultPeriodId();
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(CONFIG_KEY);
  if (!row?.value_json) {
    return {
      strategy: 'snowball',
      extraPayPeriodPayment: 0,
      startingPeriodId: nowPeriodId,
      currentPeriodId: nowPeriodId,
    };
  }
  try {
    const raw = JSON.parse(row.value_json) || {};
    const startingPeriodId = toPeriodId(raw.startingPeriodId, nowPeriodId);
    const currentPeriodId = toPeriodId(raw.currentPeriodId || startingPeriodId, startingPeriodId);
    return {
      strategy: STRATEGY_SET.has(String(raw.strategy || '').toLowerCase()) ? String(raw.strategy).toLowerCase() : 'snowball',
      extraPayPeriodPayment: Math.max(0, Number(raw.extraPayPeriodPayment || 0)),
      startingPeriodId,
      currentPeriodId,
    };
  } catch {
    return {
      strategy: 'snowball',
      extraPayPeriodPayment: 0,
      startingPeriodId: nowPeriodId,
      currentPeriodId: nowPeriodId,
    };
  }
}

function saveConfig(value) {
  const now = new Date().toISOString();
  const valueJson = JSON.stringify(value || {});
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = ?, updated_at = ?`
  ).run(CONFIG_KEY, valueJson, now, valueJson, now);
}

function toDebtRow(row) {
  return {
    id: row.id,
    name: row.name,
    creditor: row.creditor || '',
    type: row.type || '',
    currentBalance: Number(row.current_balance || 0),
    startingBalance: Number(row.starting_balance || 0),
    interestRate: Number(row.interest_rate || 0),
    minimumPayment: Number(row.minimum_payment || 0),
    creditLimit: row.credit_limit === null || row.credit_limit === undefined ? null : Number(row.credit_limit),
    dueDay: Number(row.due_day || 1),
    category: row.category || '',
    status: row.status || 'active',
    notes: row.notes || '',
    linkedRecurringBillId: row.linked_recurring_bill_id || null,
    linkedRecurringBillName: row.linked_recurring_bill_name || null,
    linkedRecurringBillAmount: row.linked_recurring_bill_amount !== null && row.linked_recurring_bill_amount !== undefined
      ? Number(row.linked_recurring_bill_amount)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listDebts() {
  const rows = db.prepare(
    `SELECT
      d.*,
      (
        SELECT r.id FROM recurring_bills_list_items r
        WHERE LOWER(COALESCE(r.notes, '')) LIKE '%debt:' || LOWER(d.id) || '%'
        ORDER BY r.updated_at DESC, r.created_at DESC
        LIMIT 1
      ) AS linked_recurring_bill_id,
      (
        SELECT r.name FROM recurring_bills_list_items r
        WHERE LOWER(COALESCE(r.notes, '')) LIKE '%debt:' || LOWER(d.id) || '%'
        ORDER BY r.updated_at DESC, r.created_at DESC
        LIMIT 1
      ) AS linked_recurring_bill_name,
      (
        SELECT r.amount FROM recurring_bills_list_items r
        WHERE LOWER(COALESCE(r.notes, '')) LIKE '%debt:' || LOWER(d.id) || '%'
        ORDER BY r.updated_at DESC, r.created_at DESC
        LIMIT 1
      ) AS linked_recurring_bill_amount
     FROM debt_snowball_debts d
     ORDER BY
      CASE d.status
        WHEN 'active' THEN 1
        WHEN 'paused' THEN 2
        WHEN 'paid' THEN 3
        ELSE 9
      END,
      LOWER(d.name) ASC`
  ).all();
  return rows.map(toDebtRow);
}

function normalizeStatus(value, fallback = 'active') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return STATUS_SET.has(normalized) ? normalized : fallback;
}

function parseAmount(value, fieldName) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(fieldName + ' must be a non-negative number.');
  }
  return parsed;
}

function parseNullableAmount(value, fieldName) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(fieldName + ' must be blank or a non-negative number.');
  }
  return parsed;
}

function parseDueDay(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 31) return 1;
  return parsed;
}

function validateDebtPayload(payload, { partial = false } = {}) {
  const body = payload || {};
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) throw new Error('Debt name is required.');
    out.name = name;
  }
  if (!partial || body.creditor !== undefined) out.creditor = String(body.creditor || '').trim();
  if (!partial || body.type !== undefined) out.type = String(body.type || '').trim();
  if (!partial || body.currentBalance !== undefined) out.currentBalance = parseAmount(body.currentBalance, 'Current balance');
  if (!partial || body.startingBalance !== undefined) out.startingBalance = parseAmount(body.startingBalance, 'Starting balance');
  if (!partial || body.interestRate !== undefined) out.interestRate = parseAmount(body.interestRate, 'APR');
  if (!partial || body.minimumPayment !== undefined) out.minimumPayment = parseAmount(body.minimumPayment, 'Minimum payment');
  if (!partial || body.creditLimit !== undefined) out.creditLimit = parseNullableAmount(body.creditLimit, 'Credit limit');
  if (!partial || body.dueDay !== undefined) out.dueDay = parseDueDay(body.dueDay);
  if (!partial || body.category !== undefined) out.category = String(body.category || '').trim();
  if (!partial || body.status !== undefined) out.status = normalizeStatus(body.status, 'active');
  if (!partial || body.notes !== undefined) out.notes = String(body.notes || '').trim();

  return out;
}

router.get('/', (_req, res) => {
  try {
    const debts = listDebts();
    const config = readConfig();
    res.json({ debts, config });
  } catch (err) {
    console.error('Error loading debt snowball data:', err.message);
    res.status(500).json({ error: 'Failed to load debt snowball data.' });
  }
});

router.patch('/config', (req, res) => {
  try {
    const existing = readConfig();
    const strategy = req.body?.strategy !== undefined
      ? String(req.body.strategy || '').toLowerCase()
      : existing.strategy;
    const extraPayPeriodPayment = req.body?.extraPayPeriodPayment !== undefined
      ? parseAmount(req.body.extraPayPeriodPayment, 'Extra pay period payment')
      : existing.extraPayPeriodPayment;
    const startingPeriodId = req.body?.startingPeriodId !== undefined
      ? toPeriodId(req.body.startingPeriodId, existing.startingPeriodId)
      : existing.startingPeriodId;
    const currentPeriodId = req.body?.currentPeriodId !== undefined
      ? toPeriodId(req.body.currentPeriodId, existing.currentPeriodId)
      : existing.currentPeriodId;

    if (!STRATEGY_SET.has(strategy)) {
      return res.status(400).json({ error: 'Strategy must be snowball or avalanche.' });
    }

    const next = { strategy, extraPayPeriodPayment, startingPeriodId, currentPeriodId };
    saveConfig(next);
    res.json(next);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid debt snowball config.' });
  }
});

router.post('/debts', (req, res) => {
  try {
    const now = new Date().toISOString();
    const id = randomUUID();
    const input = validateDebtPayload(req.body, { partial: false });

    db.prepare(
      `INSERT INTO debt_snowball_debts (
        id, name, creditor, type, current_balance, starting_balance, interest_rate,
        minimum_payment, credit_limit, due_day, category, status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      safeSqlValue(input.name),
      safeSqlValue(input.creditor),
      safeSqlValue(input.type),
      safeSqlValue(input.currentBalance),
      safeSqlValue(input.startingBalance),
      safeSqlValue(input.interestRate),
      safeSqlValue(input.minimumPayment),
      input.creditLimit === null ? null : safeSqlValue(input.creditLimit),
      safeSqlValue(input.dueDay),
      safeSqlValue(input.category),
      safeSqlValue(input.status),
      safeSqlValue(input.notes),
      now,
      now
    );

    const debt = listDebts().find((row) => row.id === id);
    res.status(201).json(debt);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create debt.' });
  }
});

router.patch('/debts/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT id FROM debt_snowball_debts WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Debt not found.' });
    }

    const input = validateDebtPayload(req.body, { partial: true });
    const updates = [];
    const values = [];

    if (input.name !== undefined) { updates.push('name = ?'); values.push(safeSqlValue(input.name)); }
    if (input.creditor !== undefined) { updates.push('creditor = ?'); values.push(safeSqlValue(input.creditor)); }
    if (input.type !== undefined) { updates.push('type = ?'); values.push(safeSqlValue(input.type)); }
    if (input.currentBalance !== undefined) { updates.push('current_balance = ?'); values.push(safeSqlValue(input.currentBalance)); }
    if (input.startingBalance !== undefined) { updates.push('starting_balance = ?'); values.push(safeSqlValue(input.startingBalance)); }
    if (input.interestRate !== undefined) { updates.push('interest_rate = ?'); values.push(safeSqlValue(input.interestRate)); }
    if (input.minimumPayment !== undefined) { updates.push('minimum_payment = ?'); values.push(safeSqlValue(input.minimumPayment)); }
    if (input.creditLimit !== undefined) { updates.push('credit_limit = ?'); values.push(input.creditLimit === null ? null : safeSqlValue(input.creditLimit)); }
    if (input.dueDay !== undefined) { updates.push('due_day = ?'); values.push(safeSqlValue(input.dueDay)); }
    if (input.category !== undefined) { updates.push('category = ?'); values.push(safeSqlValue(input.category)); }
    if (input.status !== undefined) { updates.push('status = ?'); values.push(safeSqlValue(input.status)); }
    if (input.notes !== undefined) { updates.push('notes = ?'); values.push(safeSqlValue(input.notes)); }

    if (!updates.length) {
      return res.status(400).json({ error: 'No updatable fields provided.' });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE debt_snowball_debts SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const debt = listDebts().find((row) => row.id === id);
    res.json(debt);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to update debt.' });
  }
});

router.delete('/debts/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT id FROM debt_snowball_debts WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Debt not found.' });
    }
    db.prepare('DELETE FROM debt_snowball_debts WHERE id = ?').run(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete debt.' });
  }
});

router.post('/debts/replace', (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO debt_snowball_debts (
        id, name, creditor, type, current_balance, starting_balance, interest_rate,
        minimum_payment, credit_limit, due_day, category, status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const normalized = rows
      .map((row) => {
        const name = String(row?.name || '').trim();
        if (!name) return null;
        const startingBalance = parseAmount(row.startingBalance, 'Starting balance');
        const minimumPayment = parseAmount(row.minimumPayment, 'Minimum payment');
        const interestRate = parseAmount(row.interestRate, 'APR');
        const creditLimit = parseNullableAmount(row.creditLimit, 'Credit limit');
        return {
          id: randomUUID(),
          name,
          creditor: String(row?.creditor || '').trim(),
          type: String(row?.type || 'Debt').trim() || 'Debt',
          currentBalance: parseAmount(
            row?.currentBalance === undefined || row?.currentBalance === null || String(row.currentBalance).trim() === ''
              ? startingBalance
              : row.currentBalance,
            'Current balance'
          ),
          startingBalance,
          interestRate,
          minimumPayment,
          creditLimit,
          dueDay: parseDueDay(row?.dueDay),
          category: 'Debts/Savings',
          status: normalizeStatus(row?.status, 'active'),
          notes: String(row?.notes || '').trim(),
        };
      })
      .filter(Boolean);

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM debt_snowball_debts').run();
      for (const row of normalized) {
        insert.run(
          row.id,
          safeSqlValue(row.name),
          safeSqlValue(row.creditor),
          safeSqlValue(row.type),
          safeSqlValue(row.currentBalance),
          safeSqlValue(row.startingBalance),
          safeSqlValue(row.interestRate),
          safeSqlValue(row.minimumPayment),
          row.creditLimit === null ? null : safeSqlValue(row.creditLimit),
          safeSqlValue(row.dueDay),
          safeSqlValue(row.category),
          safeSqlValue(row.status),
          safeSqlValue(row.notes),
          now,
          now
        );
      }
    });

    tx();
    res.json({ debts: listDebts() });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to replace debts.' });
  }
});

router.post('/debts/:id/create-recurring-bill', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const debt = db.prepare('SELECT * FROM debt_snowball_debts WHERE id = ?').get(id);
    if (!debt) {
      return res.status(404).json({ error: 'Debt not found.' });
    }

    const existingLink = db.prepare(
      `SELECT id, name, amount, category, due_day, notes
       FROM recurring_bills_list_items
       WHERE LOWER(COALESCE(notes, '')) LIKE '%debt:' || LOWER(?) || '%'`
    ).get(id);

    if (existingLink) {
      return res.json({ linked: true, recurringBill: existingLink });
    }

    const now = new Date().toISOString();
    const recurringId = randomUUID();
    const maxOrderRow = db.prepare('SELECT COALESCE(MAX(display_order), -1) AS maxOrder FROM recurring_bills_list_items').get();
    const displayOrder = Number(maxOrderRow?.maxOrder || -1) + 1;

    db.prepare(
      `INSERT INTO recurring_bills_list_items (
        id, name, category, due_day, amount, paid_from, match_words, autopay, active, notes, display_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      recurringId,
      safeSqlValue(debt.name),
      'Debts/Savings',
      safeSqlValue(Number(debt.due_day || 1)),
      safeSqlValue(Number(debt.minimum_payment || 0)),
      safeSqlValue(''),
      safeSqlValue(JSON.stringify([])),
      0,
      1,
      safeSqlValue('[debt:' + debt.id + '] ' + String(debt.notes || '')), 
      safeSqlValue(displayOrder),
      now,
      now
    );

    const recurringBill = db.prepare(
      'SELECT id, name, amount, category, due_day, notes FROM recurring_bills_list_items WHERE id = ?'
    ).get(recurringId);

    res.status(201).json({ linked: true, recurringBill });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create recurring bill link.' });
  }
});

// ─── Snowball Transfer Confirmations ─────────────────────────────────────────

const TRANSFER_STATUS_SET = new Set(['transfer_confirmed', 'held_in_savings', 'applied_to_debt', 'cancelled', 'not_needed']);

function validateTransferStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  return TRANSFER_STATUS_SET.has(v) ? v : 'transfer_confirmed';
}

function toTransferRow(row) {
  return {
    id: row.id,
    budgetPeriodId: row.budget_period_id,
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    amount: Number(row.amount || 0),
    sourceAccount: row.source_account || '',
    destinationAccount: row.destination_account || '',
    status: row.status || 'transfer_confirmed',
    confirmedAt: row.confirmed_at || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPaymentPlanRow(row) {
  return {
    id: row.id,
    budgetPeriodId: row.budget_period_id,
    transferConfirmationId: row.transfer_confirmation_id || null,
    targetDebtId: row.target_debt_id || null,
    targetDebtName: row.target_debt_name || '',
    amount: Number(row.amount || 0),
    appliedAmount: Number(row.applied_amount || 0),
    strategy: row.strategy || 'snowball',
    status: row.status || 'planned',
    appliedAt: row.applied_at || null,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/snowball-transfers', (req, res) => {
  try {
    const periodId = String(req.query?.periodId || '').trim();
    if (!periodId) return res.json({ transfers: [] });
    const rows = db.prepare(
      'SELECT * FROM debt_savings_transfer_confirmations WHERE budget_period_id = ? ORDER BY confirmed_at DESC, created_at DESC'
    ).all(periodId);
    res.json({ transfers: rows.map(toTransferRow) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load transfer confirmations.' });
  }
});

router.post('/snowball-transfers', (req, res) => {
  try {
    const now = new Date().toISOString();
    const id = randomUUID();
    const periodId = String(req.body?.budgetPeriodId || '').trim();
    if (!periodId) return res.status(400).json({ error: 'Budget period ID is required.' });
    const amount = parseAmount(req.body?.amount ?? 0, 'Amount');
    const status = validateTransferStatus(req.body?.status || 'transfer_confirmed');
    db.prepare(
      `INSERT INTO debt_savings_transfer_confirmations
       (id, budget_period_id, start_date, end_date, amount, source_account, destination_account, status, confirmed_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, periodId,
      String(req.body?.startDate || ''), String(req.body?.endDate || ''),
      amount,
      String(req.body?.sourceAccount || ''), String(req.body?.destinationAccount || ''),
      status, now,
      String(req.body?.notes || ''), now, now
    );
    const row = db.prepare('SELECT * FROM debt_savings_transfer_confirmations WHERE id = ?').get(id);
    res.status(201).json(toTransferRow(row));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create transfer confirmation.' });
  }
});

router.patch('/snowball-transfers/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT id FROM debt_savings_transfer_confirmations WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Transfer confirmation not found.' });
    const now = new Date().toISOString();
    const updates = [];
    const values = [];
    if (req.body?.status !== undefined) {
      updates.push('status = ?');
      values.push(validateTransferStatus(req.body.status));
    }
    if (req.body?.amount !== undefined) {
      updates.push('amount = ?');
      values.push(parseAmount(req.body.amount, 'Amount'));
    }
    if (req.body?.notes !== undefined) {
      updates.push('notes = ?');
      values.push(String(req.body.notes || '').trim());
    }
    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);
    if (updates.length > 1) {
      db.prepare(`UPDATE debt_savings_transfer_confirmations SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
    const row = db.prepare('SELECT * FROM debt_savings_transfer_confirmations WHERE id = ?').get(id);
    res.json(toTransferRow(row));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to update transfer confirmation.' });
  }
});

router.delete('/snowball-transfers/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT id FROM debt_savings_transfer_confirmations WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Transfer confirmation not found.' });
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE debt_snowball_payment_plans SET status = 'cancelled', updated_at = ? WHERE transfer_confirmation_id = ? AND status = 'planned'"
    ).run(now, id);
    db.prepare('DELETE FROM debt_savings_transfer_confirmations WHERE id = ?').run(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete transfer confirmation.' });
  }
});

// ─── Snowball Payment Plans ───────────────────────────────────────────────────

router.get('/payment-plans', (req, res) => {
  try {
    const periodId = String(req.query?.periodId || '').trim();
    if (!periodId) return res.json({ plans: [] });
    const rows = db.prepare(
      'SELECT * FROM debt_snowball_payment_plans WHERE budget_period_id = ? ORDER BY created_at DESC'
    ).all(periodId);
    res.json({ plans: rows.map(toPaymentPlanRow) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load payment plans.' });
  }
});

router.post('/payment-plans', (req, res) => {
  try {
    const now = new Date().toISOString();
    const id = randomUUID();
    const periodId = String(req.body?.budgetPeriodId || '').trim();
    if (!periodId) return res.status(400).json({ error: 'Budget period ID is required.' });
    const amount = parseAmount(req.body?.amount ?? 0, 'Amount');
    if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });
    const strategy = STRATEGY_SET.has(String(req.body?.strategy || '').toLowerCase())
      ? String(req.body.strategy).toLowerCase()
      : 'snowball';
    db.prepare(
      `INSERT INTO debt_snowball_payment_plans
       (id, budget_period_id, transfer_confirmation_id, target_debt_id, target_debt_name, amount, applied_amount, strategy, status, applied_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'planned', null, ?, ?, ?)`
    ).run(
      id, periodId,
      String(req.body?.transferConfirmationId || '') || null,
      String(req.body?.targetDebtId || '') || null,
      String(req.body?.targetDebtName || ''),
      amount, strategy,
      String(req.body?.notes || ''), now, now
    );
    const row = db.prepare('SELECT * FROM debt_snowball_payment_plans WHERE id = ?').get(id);
    res.status(201).json(toPaymentPlanRow(row));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create payment plan.' });
  }
});

router.patch('/payment-plans/:id/confirm', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const plan = db.prepare('SELECT * FROM debt_snowball_payment_plans WHERE id = ?').get(id);
    if (!plan) return res.status(404).json({ error: 'Payment plan not found.' });
    if (plan.status === 'applied') return res.status(400).json({ error: 'Payment already applied.' });
    const now = new Date().toISOString();
    let appliedAmount = Number(plan.amount || 0);
    let leftover = 0;
    if (plan.target_debt_id) {
      const debtRow = db.prepare('SELECT * FROM debt_snowball_debts WHERE id = ?').get(plan.target_debt_id);
      if (debtRow) {
        const currentBalance = Number(debtRow.current_balance || 0);
        appliedAmount = Math.min(appliedAmount, currentBalance);
        leftover = Math.max(0, Math.round((Number(plan.amount) - appliedAmount) * 100) / 100);
        const newBalance = Math.max(0, Math.round((currentBalance - appliedAmount) * 100) / 100);
        db.prepare('UPDATE debt_snowball_debts SET current_balance = ?, updated_at = ? WHERE id = ?').run(newBalance, now, plan.target_debt_id);
        if (newBalance <= 0) {
          db.prepare("UPDATE debt_snowball_debts SET status = 'paid', current_balance = 0, updated_at = ? WHERE id = ?").run(now, plan.target_debt_id);
        }
      }
    }
    db.prepare(
      'UPDATE debt_snowball_payment_plans SET status = ?, applied_at = ?, applied_amount = ?, updated_at = ? WHERE id = ?'
    ).run('applied', now, appliedAmount, now, id);
    const updatedPlan = db.prepare('SELECT * FROM debt_snowball_payment_plans WHERE id = ?').get(id);
    res.json({ plan: toPaymentPlanRow(updatedPlan), leftover });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to confirm payment.' });
  }
});

router.patch('/payment-plans/:id/hold', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const plan = db.prepare('SELECT * FROM debt_snowball_payment_plans WHERE id = ?').get(id);
    if (!plan) return res.status(404).json({ error: 'Payment plan not found.' });
    const now = new Date().toISOString();
    db.prepare("UPDATE debt_snowball_payment_plans SET status = 'held_in_savings', updated_at = ? WHERE id = ?").run(now, id);
    const updatedPlan = db.prepare('SELECT * FROM debt_snowball_payment_plans WHERE id = ?').get(id);
    res.json(toPaymentPlanRow(updatedPlan));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to update payment plan.' });
  }
});

router.delete('/payment-plans/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const plan = db.prepare('SELECT * FROM debt_snowball_payment_plans WHERE id = ?').get(id);
    if (!plan) return res.status(404).json({ error: 'Payment plan not found.' });
    if (plan.status === 'applied') return res.status(400).json({ error: 'Cannot cancel an applied payment.' });
    db.prepare('DELETE FROM debt_snowball_payment_plans WHERE id = ?').run(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete payment plan.' });
  }
});

export default router;
