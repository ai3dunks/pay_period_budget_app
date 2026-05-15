import { Router } from 'express';
import { randomUUID } from 'crypto';
import db, { safeSqlValue } from '../db.js';
import { applyRulesToTransactions } from '../../shared/transactionRules.js';

const router = Router();
const VALID_MATCH_TYPES = new Set(['contains', 'exact', 'starts_with', 'merchant_contains']);

function parseIsoDate(value) {
  const parts = String(value || '').slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isDateInSelectedPeriod(dateValue, periodId) {
  const start = parseIsoDate(periodId);
  const target = parseIsoDate(dateValue);
  if (!start || !target) return false;
  const endExclusive = addDays(start, 14);
  return target >= start && target < endExclusive;
}

function normalizeRulePayload(body = {}, allowPartial = false) {
  const payload = {};

  if (!allowPartial || body.name !== undefined) payload.name = String(body.name || '').trim();
  if (!allowPartial || body.enabled !== undefined) payload.enabled = body.enabled ? 1 : 0;
  if (!allowPartial || body.match_type !== undefined) payload.match_type = String(body.match_type || 'contains').trim();
  if (!allowPartial || body.match_value !== undefined) payload.match_value = String(body.match_value || '').trim();
  if (!allowPartial || body.account_id !== undefined) payload.account_id = body.account_id ? String(body.account_id).trim() : null;
  if (!allowPartial || body.amount_min !== undefined) payload.amount_min = body.amount_min === '' || body.amount_min === null || body.amount_min === undefined ? null : Number(body.amount_min);
  if (!allowPartial || body.amount_max !== undefined) payload.amount_max = body.amount_max === '' || body.amount_max === null || body.amount_max === undefined ? null : Number(body.amount_max);
  if (!allowPartial || body.set_type !== undefined) payload.set_type = body.set_type ? String(body.set_type).trim() : null;
  if (!allowPartial || body.set_category !== undefined) payload.set_category = body.set_category ? String(body.set_category).trim() : null;
  if (!allowPartial || body.set_ignored !== undefined) payload.set_ignored = body.set_ignored ? 1 : 0;
  if (!allowPartial || body.apply_to_unreviewed_only !== undefined) payload.apply_to_unreviewed_only = body.apply_to_unreviewed_only === false ? 0 : 1;

  if (payload.match_type !== undefined && !VALID_MATCH_TYPES.has(payload.match_type)) {
    throw new Error('Invalid match_type.');
  }
  if (payload.match_value !== undefined && !payload.match_value) {
    throw new Error('match_value is required.');
  }
  if (payload.amount_min !== undefined && payload.amount_min !== null && !Number.isFinite(payload.amount_min)) {
    throw new Error('amount_min must be a number.');
  }
  if (payload.amount_max !== undefined && payload.amount_max !== null && !Number.isFinite(payload.amount_max)) {
    throw new Error('amount_max must be a number.');
  }

  return payload;
}

function listRules(includeDisabled = true) {
  const sql = includeDisabled
    ? 'SELECT * FROM transaction_rules ORDER BY enabled DESC, updated_at DESC, created_at DESC'
    : 'SELECT * FROM transaction_rules WHERE enabled = 1 ORDER BY updated_at DESC, created_at DESC';
  return db.prepare(sql).all();
}

function listTransactionsForRules(periodId) {
  const rows = db.prepare(
    `SELECT
      id,
      plaid_transaction_id,
      account_id,
      plaid_account_id,
      date,
      name,
      merchant_name,
      amount,
      pending,
      type,
      category,
      reviewed,
      ignored,
      notes,
      raw_json
    FROM transactions
    ORDER BY date DESC`
  ).all();

  if (!periodId) return rows;
  return rows.filter((row) => isDateInSelectedPeriod(row.date, periodId));
}

router.get('/', (_req, res) => {
  try {
    res.json(listRules(true));
  } catch (err) {
    console.error('GET /api/rules error:', err);
    res.status(500).json({ error: 'Failed to fetch rules.' });
  }
});

router.post('/', (req, res) => {
  try {
    const payload = normalizeRulePayload(req.body || {}, false);
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO transaction_rules (
        id, name, enabled, match_type, match_value, account_id, amount_min, amount_max,
        set_type, set_category, set_ignored, apply_to_unreviewed_only, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      safeSqlValue(payload.name),
      payload.enabled,
      payload.match_type,
      payload.match_value,
      safeSqlValue(payload.account_id),
      safeSqlValue(payload.amount_min),
      safeSqlValue(payload.amount_max),
      safeSqlValue(payload.set_type),
      safeSqlValue(payload.set_category),
      payload.set_ignored,
      payload.apply_to_unreviewed_only,
      now,
      now
    );

    res.status(201).json(db.prepare('SELECT * FROM transaction_rules WHERE id = ?').get(id));
  } catch (err) {
    console.error('POST /api/rules error:', err);
    res.status(400).json({ error: err.message || 'Failed to create rule.' });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM transaction_rules WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Rule not found.' });

    const payload = normalizeRulePayload(req.body || {}, true);
    const updates = [];
    const values = [];

    Object.entries(payload).forEach(([key, value]) => {
      updates.push(`${key} = ?`);
      values.push(safeSqlValue(value));
    });

    if (!updates.length) {
      return res.status(400).json({ error: 'No editable fields provided.' });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(req.params.id);

    db.prepare(`UPDATE transaction_rules SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json(db.prepare('SELECT * FROM transaction_rules WHERE id = ?').get(req.params.id));
  } catch (err) {
    console.error('PATCH /api/rules/:id error:', err);
    res.status(400).json({ error: err.message || 'Failed to update rule.' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM transaction_rules WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Rule not found.' });

    const now = new Date().toISOString();
    db.prepare('UPDATE transaction_rules SET enabled = 0, updated_at = ? WHERE id = ?').run(now, req.params.id);
    res.json({ ok: true, id: req.params.id, enabled: 0, updated_at: now });
  } catch (err) {
    console.error('DELETE /api/rules/:id error:', err);
    res.status(500).json({ error: 'Failed to disable rule.' });
  }
});

router.post('/apply', (req, res) => {
  try {
    const { periodId = null, dryRun = false } = req.body || {};
    const rules = listRules(false);
    const transactions = listTransactionsForRules(periodId);
    const matches = applyRulesToTransactions(transactions, rules);

    const preview = matches.map((match) => ({
      transactionId: match.transactionId,
      ruleId: match.ruleId,
      ruleName: match.ruleName,
      date: match.transaction.date,
      name: match.transaction.name,
      merchantName: match.transaction.merchant_name,
      currentType: match.transaction.type,
      currentCategory: match.transaction.category,
      newType: match.updates.type ?? match.transaction.type ?? null,
      newCategory: match.updates.category ?? match.transaction.category ?? null,
      newIgnored: match.updates.ignored === true,
    }));

    let updatedCount = 0;
    if (!dryRun) {
      const stmt = db.prepare(
        'UPDATE transactions SET type = ?, category = ?, ignored = ?, reviewed = ?, updated_at = ? WHERE id = ?'
      );
      const now = new Date().toISOString();
      for (const match of matches) {
        const result = stmt.run(
          safeSqlValue(match.updates.type ?? match.transaction.type ?? null),
          safeSqlValue(match.updates.category ?? match.transaction.category ?? null),
          match.updates.ignored ? 1 : 0,
          match.updates.reviewed ? 1 : 0,
          now,
          match.transactionId
        );
        if (result.changes > 0) updatedCount++;
      }

      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      ).run('rules_last_applied_at', JSON.stringify(now), now);
    }

    res.json({
      matchedCount: matches.length,
      updatedCount,
      preview,
    });
  } catch (err) {
    console.error('POST /api/rules/apply error:', err);
    res.status(500).json({ error: 'Failed to apply rules.' });
  }
});

export default router;
