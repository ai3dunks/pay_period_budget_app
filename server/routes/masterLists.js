import { Router } from 'express';
import { randomUUID } from 'crypto';
import db, { safeSqlValue } from '../db.js';

const router = Router();
const RECURRING_BILL_CATEGORIES = new Set(['Needs', 'Wants', 'Debts/Savings']);

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function normalizePaidFrom(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return Boolean(value);
}

function parseNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeMatchWords(value) {
  let rawWords = [];
  if (Array.isArray(value)) {
    rawWords = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        rawWords = Array.isArray(parsed) ? parsed : [];
      } catch {
        rawWords = value.split(',');
      }
    } else {
      rawWords = value.split(',');
    }
  }

  const seen = new Set();
  const normalized = [];
  for (const word of rawWords) {
    const trimmed = String(word || '').trim();
    if (!trimmed) continue;
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }
  return normalized;
}

function parseStoredMatchWords(value) {
  if (!value) return [];
  if (Array.isArray(value)) return normalizeMatchWords(value);
  const str = String(value).trim();
  if (!str) return [];
  if (str.startsWith('[') && str.endsWith(']')) {
    try {
      const parsed = JSON.parse(str);
      return normalizeMatchWords(parsed);
    } catch (_err) {
      return normalizeMatchWords(str);
    }
  }
  return normalizeMatchWords(str);
}

function toExpenseItem(row) {
  return {
    id: row.id,
    name: row.name,
    budgetAmount: Number(row.budget_amount ?? 0),
    active: !!row.active,
    notes: row.notes || '',
    displayOrder: row.display_order ?? 0,
  };
}

function toRecurringBillItem(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    dueDay: row.due_day,
    amount: Number(row.amount ?? 0),
    paidFrom: row.paid_from || '',
    matchWords: parseStoredMatchWords(row.match_words),
    match_words: row.match_words || '',
    autopay: !!row.autopay,
    active: !!row.active,
    notes: row.notes || '',
    displayOrder: row.display_order ?? 0,
  };
}

function nextDisplayOrder(tableName) {
  return db.prepare(`SELECT COALESCE(MAX(display_order), -1) as maxOrder FROM ${tableName}`).get().maxOrder + 1;
}

function getRow(tableName, id) {
  return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) || null;
}

router.get('/', (_req, res) => {
  try {
    const expenseList = db
      .prepare('SELECT * FROM expense_list_items ORDER BY display_order ASC, name COLLATE NOCASE ASC')
      .all()
      .map(toExpenseItem);

    const recurringBillsList = db
      .prepare('SELECT * FROM recurring_bills_list_items ORDER BY display_order ASC, due_day ASC, name COLLATE NOCASE ASC, amount ASC')
      .all()
      .map(toRecurringBillItem);

    res.json({ expenseList, recurringBillsList });
  } catch (err) {
    console.error('Error fetching master lists:', err.message);
    res.status(500).json({ error: 'Failed to fetch master lists.' });
  }
});

router.post('/expenses', (req, res) => {
  const name = normalizeName(req.body?.name);
  if (!name) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  try {
    const now = new Date().toISOString();
    const id = randomUUID();
    const displayOrder = req.body?.displayOrder !== undefined ? parseInteger(req.body.displayOrder, nextDisplayOrder('expense_list_items')) : nextDisplayOrder('expense_list_items');

    db.prepare(
      'INSERT INTO expense_list_items (id, name, budget_amount, active, notes, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      safeSqlValue(name),
      safeSqlValue(parseNumber(req.body?.budgetAmount, 0)),
      parseBoolean(req.body?.active, true) ? 1 : 0,
      safeSqlValue(req.body?.notes ?? ''),
      safeSqlValue(displayOrder),
      now,
      now
    );

    res.status(201).json(toExpenseItem(getRow('expense_list_items', id)));
  } catch (err) {
    console.error('Error creating expense item:', err.message);
    res.status(500).json({ error: 'Failed to create expense item.' });
  }
});

router.patch('/expenses/:id', (req, res) => {
  const { id } = req.params;

  try {
    const existing = getRow('expense_list_items', id);
    if (!existing) {
      return res.status(404).json({ error: 'Expense item not found.' });
    }

    const updates = [];
    const values = [];

    if (req.body?.name !== undefined) {
      const name = normalizeName(req.body.name);
      if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
      updates.push('name = ?');
      values.push(safeSqlValue(name));
    }

    if (req.body?.budgetAmount !== undefined) {
      updates.push('budget_amount = ?');
      values.push(safeSqlValue(parseNumber(req.body.budgetAmount, 0)));
    }

    if (req.body?.active !== undefined) {
      updates.push('active = ?');
      values.push(parseBoolean(req.body.active) ? 1 : 0);
    }

    if (req.body?.notes !== undefined) {
      updates.push('notes = ?');
      values.push(safeSqlValue(req.body.notes));
    }

    if (req.body?.displayOrder !== undefined) {
      updates.push('display_order = ?');
      values.push(safeSqlValue(parseInteger(req.body.displayOrder, existing.display_order ?? 0)));
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE expense_list_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json(toExpenseItem(getRow('expense_list_items', id)));
  } catch (err) {
    console.error('Error updating expense item:', err.message);
    res.status(500).json({ error: 'Failed to update expense item.' });
  }
});

router.delete('/expenses/:id', (req, res) => {
  const { id } = req.params;

  try {
    const existing = getRow('expense_list_items', id);
    if (!existing) {
      return res.status(404).json({ error: 'Expense item not found.' });
    }

    db.prepare('UPDATE expense_list_items SET active = 0, updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      id
    );

    res.json(toExpenseItem(getRow('expense_list_items', id)));
  } catch (err) {
    console.error('Error deleting expense item:', err.message);
    res.status(500).json({ error: 'Failed to delete expense item.' });
  }
});

router.post('/recurring-bills', (req, res) => {
  const name = normalizeName(req.body?.name);
  const category = String(req.body?.category || 'Needs').trim();
  if (!name) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (!RECURRING_BILL_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Invalid category.' });
  }

  try {
    const now = new Date().toISOString();
    const id = randomUUID();
    const displayOrder = req.body?.displayOrder !== undefined ? parseInteger(req.body.displayOrder, nextDisplayOrder('recurring_bills_list_items')) : nextDisplayOrder('recurring_bills_list_items');

    const matchWords = normalizeMatchWords(req.body?.matchWords ?? req.body?.match_words ?? []);

    db.prepare(
      'INSERT INTO recurring_bills_list_items (id, name, category, due_day, amount, paid_from, match_words, autopay, active, notes, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      safeSqlValue(name),
      safeSqlValue(category),
      safeSqlValue(Math.min(31, Math.max(1, parseInteger(req.body?.dueDay, 1)))),
      safeSqlValue(parseNumber(req.body?.amount, 0)),
      safeSqlValue(normalizePaidFrom(req.body?.paidFrom)),
      safeSqlValue(JSON.stringify(matchWords)),
      parseBoolean(req.body?.autopay, false) ? 1 : 0,
      parseBoolean(req.body?.active, true) ? 1 : 0,
      safeSqlValue(req.body?.notes ?? ''),
      safeSqlValue(displayOrder),
      now,
      now
    );

    res.status(201).json(toRecurringBillItem(getRow('recurring_bills_list_items', id)));
  } catch (err) {
    console.error('Error creating recurring bill:', err.message);
    res.status(500).json({ error: 'Failed to create recurring bill.' });
  }
});

router.patch('/recurring-bills/:id', (req, res) => {
  const { id } = req.params;

  try {
    const existing = getRow('recurring_bills_list_items', id);
    if (!existing) {
      return res.status(404).json({ error: 'Recurring bill not found.' });
    }

    const updates = [];
    const values = [];

    if (req.body?.name !== undefined) {
      const name = normalizeName(req.body.name);
      if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
      updates.push('name = ?');
      values.push(safeSqlValue(name));
    }

    if (req.body?.category !== undefined) {
      const nextCategory = String(req.body.category || '').trim();
      if (!RECURRING_BILL_CATEGORIES.has(nextCategory)) {
        return res.status(400).json({ error: 'Invalid category.' });
      }
      updates.push('category = ?');
      values.push(safeSqlValue(nextCategory));
    }

    if (req.body?.dueDay !== undefined) {
      updates.push('due_day = ?');
      values.push(safeSqlValue(Math.min(31, Math.max(1, parseInteger(req.body.dueDay, existing.due_day || 1)))));
    }

    if (req.body?.amount !== undefined) {
      updates.push('amount = ?');
      values.push(safeSqlValue(parseNumber(req.body.amount, existing.amount || 0)));
    }

    if (req.body?.paidFrom !== undefined) {
      updates.push('paid_from = ?');
      values.push(safeSqlValue(normalizePaidFrom(req.body.paidFrom)));
    }

    if (req.body?.matchWords !== undefined || req.body?.match_words !== undefined) {
      updates.push('match_words = ?');
      values.push(safeSqlValue(JSON.stringify(normalizeMatchWords(req.body.matchWords ?? req.body.match_words))));
    }

    if (req.body?.autopay !== undefined) {
      updates.push('autopay = ?');
      values.push(parseBoolean(req.body.autopay) ? 1 : 0);
    }

    if (req.body?.active !== undefined) {
      updates.push('active = ?');
      values.push(parseBoolean(req.body.active) ? 1 : 0);
    }

    if (req.body?.notes !== undefined) {
      updates.push('notes = ?');
      values.push(safeSqlValue(req.body.notes));
    }

    if (req.body?.displayOrder !== undefined) {
      updates.push('display_order = ?');
      values.push(safeSqlValue(parseInteger(req.body.displayOrder, existing.display_order ?? 0)));
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE recurring_bills_list_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json(toRecurringBillItem(getRow('recurring_bills_list_items', id)));
  } catch (err) {
    console.error('Error updating recurring bill:', err.message);
    res.status(500).json({ error: 'Failed to update recurring bill.' });
  }
});

router.delete('/recurring-bills/:id', (req, res) => {
  const { id } = req.params;

  try {
    const existing = getRow('recurring_bills_list_items', id);
    if (!existing) {
      return res.status(404).json({ error: 'Recurring bill not found.' });
    }

    db.prepare('UPDATE recurring_bills_list_items SET active = 0, updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      id
    );

    res.json(toRecurringBillItem(getRow('recurring_bills_list_items', id)));
  } catch (err) {
    console.error('Error deleting recurring bill:', err.message);
    res.status(500).json({ error: 'Failed to delete recurring bill.' });
  }
});

export default router;
