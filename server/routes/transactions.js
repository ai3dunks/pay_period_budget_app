import { Router } from 'express';
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
    includeRawJson,
  } = req.query;

  const rawLimit = Number.parseInt(req.query.limit, 10);
  const rawOffset = Number.parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const wantRawJson = includeRawJson === 'true' || includeRawJson === '1';

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
  const rawJsonSelect = wantRawJson ? ', t.raw_json' : '';
  const selectClause =
    'SELECT ' +
    't.id, t.plaid_transaction_id, t.account_id, t.plaid_account_id, t.date, t.name, t.merchant_name, t.amount, t.pending, ' +
    't.pending_transaction_id, t.type, t.category, t.reviewed, t.ignored, t.bucket_id, t.bucket_name, t.notes, t.created_at, t.updated_at' +
    rawJsonSelect +
    ', a.name AS account_name, a.institution_name, a.mask ' +
    'FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id ';

  const isLegacyArrayRequest = Object.keys(req.query || {}).length === 0;

  try {
    if (isLegacyArrayRequest) {
      const rows = db.prepare(selectClause + orderByClause).all();
      return res.json(rows);
    }

    const countRow = db.prepare(
      'SELECT COUNT(*) AS total FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id ' + whereClause
    ).get(...params);

    const total = Number(countRow?.total || 0);
    const rows = db.prepare(
      selectClause + whereClause + ' ' + orderByClause + ' LIMIT ? OFFSET ?'
    ).all(...params, limit, offset);

    const hasNext = offset + rows.length < total;
    const hasPrevious = offset > 0;
    const nextOffset = hasNext ? offset + limit : null;
    const previousOffset = hasPrevious ? Math.max(0, offset - limit) : null;

    const elapsed = Date.now() - startedAt;
    if (elapsed > 500) {
      console.warn('[slow-query] GET /api/transactions took ' + elapsed + 'ms (total=' + total + ', limit=' + limit + ', offset=' + offset + ')');
    }

    return res.json({
      rows,
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

router.get('/:id/debug', (req, res) => {
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
        delete debugRawJson.access_token;
        delete debugRawJson.public_token;
        delete debugRawJson.secret;
        delete debugRawJson.link_token;
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

    res.json(updated);
  } catch (err) {
    console.error('Error updating transaction:', err.message);
    res.status(500).json({ error: 'Failed to update transaction.' });
  }
});

export default router;
