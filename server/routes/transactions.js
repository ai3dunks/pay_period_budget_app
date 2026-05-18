import { Router } from 'express';
import { randomUUID } from 'crypto';
import db, { safeSqlValue } from '../db.js';

const router = Router();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const VALID_TYPES = new Set([
  'Income',
  'Expense',
  'Bills',
  'Wants',
  'Transfer',
  'Debt Payment',
  'Ignore',
]);

const SORT_MAP = {
  date_desc: 't.date DESC, t.created_at DESC',
  date_asc: 't.date ASC, t.created_at ASC',
  amount_desc: 'ABS(t.amount) DESC, t.date DESC',
  amount_asc: 'ABS(t.amount) ASC, t.date DESC',
  reviewed_first: 't.reviewed DESC, t.date DESC',
  unreviewed_first: 't.reviewed ASC, t.date DESC',
};

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function normalizeMoney(value) {
  return toCents(value) / 100;
}

function attachSplitData(rows) {
  const nextRows = Array.isArray(rows) ? rows.slice() : [];
  if (!nextRows.length) return nextRows;

  const parentIds = nextRows.map((row) => String(row.id || '')).filter(Boolean);
  if (!parentIds.length) return nextRows;

  const placeholders = parentIds.map(() => '?').join(', ');
  const splitRows = db.prepare(
    'SELECT id, parent_transaction_id, category, subcategory, amount, note, display_order, is_final, created_at, updated_at ' +
    'FROM transaction_splits WHERE parent_transaction_id IN (' + placeholders + ') ORDER BY display_order ASC, created_at ASC'
  ).all(...parentIds);

  const byParentId = new Map();
  for (const split of splitRows) {
    const parentId = String(split.parent_transaction_id || '');
    if (!byParentId.has(parentId)) byParentId.set(parentId, []);
    byParentId.get(parentId).push({
      id: split.id,
      parentTransactionId: parentId,
      category: split.category || '',
      subcategory: split.subcategory || '',
      amount: normalizeMoney(split.amount),
      note: split.note || '',
      displayOrder: Number(split.display_order || 0),
      isFinal: Number(split.is_final || 0) === 1,
      createdAt: split.created_at || null,
      updatedAt: split.updated_at || null,
    });
  }

  return nextRows.map((row) => {
    const parentId = String(row.id || '');
    const splitLines = byParentId.get(parentId) || [];
    const splitTotal = splitLines.reduce((sum, split) => sum + normalizeMoney(split.amount), 0);
    const targetTotal = Math.abs(normalizeMoney(row.amount));
    const splitDelta = normalizeMoney(splitTotal - targetTotal);
    const splitIsFinal = splitLines.length > 0 ? splitLines.every((split) => split.isFinal) : false;

    return {
      ...row,
      split_lines: splitLines,
      has_split_lines: splitLines.length > 0,
      split_is_final: splitIsFinal,
      split_total: normalizeMoney(splitTotal),
      split_target_total: targetTotal,
      split_delta: splitDelta,
    };
  });
}

function normalizeSplitPayload(split, index) {
  const category = String(split?.category || '').trim();
  const subcategory = String(split?.subcategory || '').trim();
  const note = String(split?.note || '').trim();
  const amount = normalizeMoney(split?.amount);

  if (!category) {
    throw new Error('Split line ' + (index + 1) + ': category is required.');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Split line ' + (index + 1) + ': amount must be greater than 0.');
  }

  return {
    category,
    subcategory,
    note,
    amount,
    displayOrder: Number.isFinite(Number(split?.displayOrder)) ? Number(split.displayOrder) : index,
  };
}

function parseBoolParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return 1;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return 0;
  return null;
}

// GET /api/transactions
router.get('/', (req, res) => {
  const startedAt = Date.now();
  const {
    startDate,
    exclusiveEndDate,
    accountId,
    type,
    category,
    reviewed,
    ignored,
    pending,
    search,
    sort = 'date_desc',
  } = req.query;

  const rawLimit = Number.parseInt(req.query.limit, 10);
  const rawOffset = Number.parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  const conditions = [];
  const params = [];

  if (startDate) {
    conditions.push('t.date >= ?');
    params.push(String(startDate).trim());
  }
  if (exclusiveEndDate) {
    conditions.push('t.date < ?');
    params.push(String(exclusiveEndDate).trim());
  }
  if (accountId) {
    conditions.push('t.account_id = ?');
    params.push(String(accountId).trim());
  }
  if (type && VALID_TYPES.has(type)) {
    conditions.push('t.type = ?');
    params.push(type);
  }
  if (category && String(category).trim()) {
    conditions.push('t.category = ?');
    params.push(String(category).trim());
  }

  const reviewedBool = parseBoolParam(reviewed);
  if (reviewedBool !== null) {
    conditions.push('t.reviewed = ?');
    params.push(reviewedBool);
  }

  const ignoredBool = parseBoolParam(ignored);
  if (ignoredBool !== null) {
    conditions.push('t.ignored = ?');
    params.push(ignoredBool);
  }

  const pendingBool = parseBoolParam(pending);
  if (pendingBool !== null) {
    conditions.push('t.pending = ?');
    params.push(pendingBool);
  }

  const searchTerm = search ? String(search).trim() : '';
  if (searchTerm) {
    const needle = '%' + searchTerm.toLowerCase() + '%';
    conditions.push(
      '(LOWER(COALESCE(t.name, "")) LIKE ? OR LOWER(COALESCE(t.merchant_name, "")) LIKE ? OR LOWER(COALESCE(t.category, "")) LIKE ? OR LOWER(COALESCE(t.type, "")) LIKE ? OR LOWER(COALESCE(t.notes, "")) LIKE ?)'
    );
    params.push(needle, needle, needle, needle, needle);
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const orderByClause = 'ORDER BY ' + (SORT_MAP[sort] || SORT_MAP.date_desc);
  const rawJsonSelect = '';
  const selectClause =
    'SELECT ' +
    't.id, t.plaid_transaction_id, t.account_id, t.plaid_account_id, t.date, t.name, t.merchant_name, t.amount, t.pending, ' +
    't.pending_transaction_id, t.type, t.category, t.reviewed, t.ignored, t.bucket_id, t.bucket_name, t.notes, t.created_at, t.updated_at' +
    rawJsonSelect +
    ', a.name AS account_name, a.institution_name, a.mask ' +
    'FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id ';

  const isLegacyArrayRequest = Object.keys(req.query || {}).length === 0;

  try {
    const countRow = db.prepare(
      'SELECT COUNT(*) AS total FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id ' + whereClause
    ).get(...params);

    const total = Number(countRow?.total || 0);
    const rows = db.prepare(
      selectClause + whereClause + ' ' + orderByClause + ' LIMIT ? OFFSET ?'
    ).all(...params, limit, offset);
    const rowsWithSplits = attachSplitData(rows);

    const hasNext = offset + rows.length < total;
    const hasPrevious = offset > 0;
    const nextOffset = hasNext ? offset + limit : null;
    const previousOffset = hasPrevious ? Math.max(0, offset - limit) : null;

    const elapsed = Date.now() - startedAt;
    if (elapsed > 500) {
      console.warn('[slow-query] GET /api/transactions took ' + elapsed + 'ms (total=' + total + ', limit=' + limit + ', offset=' + offset + ')');
    }

    return res.json({
      rows: rowsWithSplits,
      pagination: {
        limit,
        offset,
        total,
        nextOffset,
        previousOffset,
        hasNext,
        hasPrevious,
      },
      filters: {
        startDate: startDate || null,
        exclusiveEndDate: exclusiveEndDate || null,
        accountId: accountId || null,
        type: type || null,
        category: category || null,
        reviewed: reviewedBool !== null ? String(reviewed) : null,
        ignored: ignoredBool !== null ? String(ignored) : null,
        pending: pendingBool !== null ? String(pending) : null,
        search: searchTerm || null,
        sort,
      },
    });
  } catch (err) {
    console.error('Error fetching transactions:', err.message);
    res.status(500).json({ error: 'Failed to fetch transactions.' });
  }
});

// GET /api/transactions/:id
router.get('/:id', (req, res) => {
  const { id } = req.params;

  try {
    const row = db.prepare(
      `SELECT
        t.id,
        t.plaid_transaction_id,
        t.account_id,
        t.plaid_account_id,
        t.date,
        t.name,
        t.merchant_name,
        t.amount,
        t.pending,
        t.pending_transaction_id,
        t.type,
        t.category,
        t.reviewed,
        t.ignored,
        t.bucket_id,
        t.bucket_name,
        t.notes,
        t.created_at,
        t.updated_at,
        a.name AS account_name,
        a.institution_name,
        a.mask
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.id = ?`
    ).get(id);

    if (!row) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    return res.json(attachSplitData([row])[0] || row);
  } catch (err) {
    console.error('Error fetching transaction:', err.message);
    return res.status(500).json({ error: 'Failed to fetch transaction.' });
  }
});

// GET /api/transactions/:id/splits
router.get('/:id/splits', (req, res) => {
  const { id } = req.params;

  try {
    const parent = db.prepare('SELECT id, amount FROM transactions WHERE id = ?').get(id);
    if (!parent) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const parentWithSplits = attachSplitData([{ ...parent }])[0] || parent;
    return res.json({
      parentTransactionId: parentWithSplits.id,
      parentAmount: normalizeMoney(parentWithSplits.amount),
      splitTargetTotal: Math.abs(normalizeMoney(parentWithSplits.amount)),
      splitTotal: normalizeMoney(parentWithSplits.split_total || 0),
      splitDelta: normalizeMoney(parentWithSplits.split_delta || 0),
      splitIsFinal: !!parentWithSplits.split_is_final,
      splits: Array.isArray(parentWithSplits.split_lines) ? parentWithSplits.split_lines : [],
    });
  } catch (err) {
    console.error('Error fetching transaction splits:', err.message);
    return res.status(500).json({ error: 'Failed to fetch transaction splits.' });
  }
});

// POST /api/transactions/:id/splits
router.post('/:id/splits', (req, res) => {
  const { id } = req.params;
  const splits = Array.isArray(req.body?.splits) ? req.body.splits : [];
  const isFinal = req.body?.isFinal === true;

  try {
    const parent = db.prepare('SELECT id, amount FROM transactions WHERE id = ?').get(id);
    if (!parent) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const normalizedSplits = splits.map((split, index) => normalizeSplitPayload(split, index));
    const splitTotal = normalizedSplits.reduce((sum, split) => sum + normalizeMoney(split.amount), 0);
    const parentAbsAmount = Math.abs(normalizeMoney(parent.amount));
    const splitDelta = normalizeMoney(splitTotal - parentAbsAmount);

    if (isFinal && normalizedSplits.length > 0 && toCents(splitDelta) !== 0) {
      return res.status(400).json({
        error: 'Split total must match the parent transaction amount before final save.',
        splitTotal,
        splitTargetTotal: parentAbsAmount,
        splitDelta,
      });
    }

    const now = new Date().toISOString();
    const persist = db.transaction(() => {
      db.prepare('DELETE FROM transaction_splits WHERE parent_transaction_id = ?').run(id);

      if (!normalizedSplits.length) return;

      const insert = db.prepare(
        'INSERT INTO transaction_splits (id, parent_transaction_id, category, subcategory, amount, note, display_order, is_final, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      normalizedSplits.forEach((split, index) => {
        insert.run(
          randomUUID(),
          id,
          safeSqlValue(split.category),
          safeSqlValue(split.subcategory || null),
          split.amount,
          safeSqlValue(split.note || null),
          split.displayOrder ?? index,
          isFinal ? 1 : 0,
          now,
          now
        );
      });
    });

    persist();

    const refreshed = attachSplitData([
      db.prepare('SELECT id, amount FROM transactions WHERE id = ?').get(id),
    ])[0];

    return res.json({
      ok: true,
      parentTransactionId: id,
      splitIsFinal: !!refreshed.split_is_final,
      splitTotal: normalizeMoney(refreshed.split_total || 0),
      splitTargetTotal: Math.abs(normalizeMoney(refreshed.amount || 0)),
      splitDelta: normalizeMoney(refreshed.split_delta || 0),
      splits: refreshed.split_lines || [],
    });
  } catch (err) {
    console.error('Error saving transaction splits:', err.message);
    return res.status(400).json({ error: 'Failed to save transaction splits.' });
  }
});

router.get('/:id/debug', (req, res) => {
  if (process.env.ENABLE_TRANSACTION_DEBUG !== 'true') {
    return res.status(404).json({ error: 'Not found.' });
  }

  const { id } = req.params;

  try {
    const row = db.prepare(
      `SELECT
        t.id,
        t.plaid_transaction_id,
        t.account_id,
        t.plaid_account_id,
        t.date,
        t.name,
        t.merchant_name,
        t.amount,
        t.pending,
        t.pending_transaction_id,
        t.type,
        t.category,
        t.reviewed,
        t.ignored,
        t.bucket_id,
        t.bucket_name,
        t.notes,
        t.created_at,
        t.updated_at,
        t.raw_json,
        a.name AS account_name,
        a.institution_name,
        a.mask
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.id = ?`
    ).get(id);

    if (!row) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    let debugRawJson = null;
    if (row.raw_json) {
      try {
        debugRawJson = JSON.parse(row.raw_json);
        debugRawJson = null;
      } catch {
        debugRawJson = null;
      }
    }

    return res.json({ ...row, raw_json: debugRawJson });
  } catch (err) {
    console.error('Error fetching transaction debug:', err.message);
    res.status(500).json({ error: 'Failed to fetch transaction.' });
  }
});

// PATCH /api/transactions/:id
router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const { type, category, reviewed, ignored, notes, bucketId, bucketName, bucket_id, bucket_name } = req.body || {};

  try {
    const existing = db.prepare('SELECT id FROM transactions WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const updates = [];
    const values = [];

    if (type !== undefined) {
      if (type !== null && !VALID_TYPES.has(type)) {
        return res.status(400).json({ error: 'Invalid transaction type.' });
      }
      updates.push('type = ?');
      values.push(safeSqlValue(type));
    }

    if (category !== undefined) {
      updates.push('category = ?');
      values.push(safeSqlValue(category));
    }

    if (reviewed !== undefined) {
      updates.push('reviewed = ?');
      values.push(reviewed ? 1 : 0);
    }

    if (ignored !== undefined) {
      updates.push('ignored = ?');
      values.push(ignored ? 1 : 0);
    }

    if (notes !== undefined) {
      updates.push('notes = ?');
      values.push(safeSqlValue(notes));
    }

    const nextBucketId = bucketId !== undefined ? bucketId : bucket_id;
    const nextBucketName = bucketName !== undefined ? bucketName : bucket_name;

    if (nextBucketId !== undefined || nextBucketName !== undefined) {
      let resolvedBucketId = nextBucketId;
      let resolvedBucketName = nextBucketName;

      if (resolvedBucketId) {
        const bucketRow = db.prepare('SELECT id, name FROM budget_buckets WHERE id = ?').get(String(resolvedBucketId));
        if (!bucketRow) {
          return res.status(400).json({ error: 'Selected bucket does not exist.' });
        }
        resolvedBucketId = bucketRow.id;
        resolvedBucketName = bucketRow.name;
      }

      if (!resolvedBucketId) {
        resolvedBucketId = null;
        resolvedBucketName = null;
      }

      updates.push('bucket_id = ?');
      values.push(safeSqlValue(resolvedBucketId));
      updates.push('bucket_name = ?');
      values.push(safeSqlValue(resolvedBucketName));
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No editable fields provided.' });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db
      .prepare(
        `SELECT
          t.id,
          t.plaid_transaction_id,
          t.account_id,
          t.plaid_account_id,
          t.date,
          t.name,
          t.merchant_name,
          t.amount,
          t.pending,
          t.pending_transaction_id,
          t.type,
          t.category,
          t.reviewed,
          t.ignored,
          t.bucket_id,
          t.bucket_name,
          t.notes,
          t.created_at,
          t.updated_at,
          a.name AS account_name,
          a.institution_name,
          a.mask
        FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
        WHERE t.id = ?`
      )
      .get(id);

    res.json(attachSplitData([updated])[0] || updated);
  } catch (err) {
    console.error('Error updating transaction:', err.message);
    res.status(500).json({ error: 'Failed to update transaction.' });
  }
});

export default router;
