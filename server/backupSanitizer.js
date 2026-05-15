/**
 * server/backupSanitizer.js
 *
 * Helpers for scrubbing sensitive fields before backup export
 * and validating payloads on import.
 */

// Keys that must never appear in exported data.
const FORBIDDEN_KEYS = new Set([
  'access_token',
  'accessToken',
  'public_token',
  'publicToken',
  'link_token',
  'linkToken',
  'PLAID_SECRET',
  'plaid_secret',
  'secret',
  'raw_json',
  'rawJson',
]);

/**
 * Recursively scan an object for forbidden keys.
 * Returns an array of found key paths.
 */
export function detectForbiddenSecretFields(obj, _path = '') {
  if (!obj || typeof obj !== 'object') return [];
  const found = [];
  for (const key of Object.keys(obj)) {
    const keyPath = _path ? `${_path}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key)) {
      found.push(keyPath);
    } else if (obj[key] && typeof obj[key] === 'object') {
      found.push(...detectForbiddenSecretFields(obj[key], keyPath));
    }
  }
  return found;
}

/**
 * Sanitize settings rows for backup.
 * Keys that contain 'token' or 'secret' in any case are excluded.
 */
export function sanitizeSettingsForBackup(rows) {
  if (!Array.isArray(rows)) return [];
  const blockedKeyPatterns = [/token/i, /secret/i, /access_token/i, /plaid_item/i];
  return rows
    .filter((row) => {
      if (!row || !row.key) return false;
      return !blockedKeyPatterns.some((pat) => pat.test(row.key));
    })
    .map((row) => ({
      key: row.key,
      value_json: row.value_json ?? null,
      updated_at: row.updated_at ?? null,
    }));
}

/**
 * Sanitize transaction rows for backup.
 * Exports only user-editable review fields.
 */
export function sanitizeTransactionReviewsForBackup(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    plaid_transaction_id: row.plaid_transaction_id ?? null,
    date: row.date ?? null,
    name: row.name ?? null,
    amount: row.amount != null ? Number(row.amount) : null,
    type: row.type ?? null,
    category: row.category ?? null,
    reviewed: row.reviewed != null ? Number(row.reviewed) : 0,
    ignored: row.ignored != null ? Number(row.ignored) : 0,
    notes: row.notes ?? null,
    updated_at: row.updated_at ?? null,
  }));
}

/**
 * Sanitize a single history snapshot for backup.
 * Strips raw_json and access tokens from snapshot_json.
 */
export function sanitizeHistorySnapshotForBackup(row) {
  if (!row || typeof row !== 'object') return null;
  let snapshotJson = null;
  if (row.snapshot_json) {
    try {
      const parsed = typeof row.snapshot_json === 'string'
        ? JSON.parse(row.snapshot_json)
        : row.snapshot_json;
      snapshotJson = scrubForbiddenKeys(parsed);
      snapshotJson = JSON.stringify(snapshotJson);
    } catch (_e) {
      snapshotJson = null;
    }
  }
  return {
    id: row.id ?? null,
    period_id: row.period_id ?? null,
    period_label: row.period_label ?? null,
    start_date: row.start_date ?? null,
    display_end_date: row.display_end_date ?? null,
    exclusive_end_date: row.exclusive_end_date ?? null,
    budget_income: row.budget_income != null ? Number(row.budget_income) : null,
    regular_paycheck: row.regular_paycheck != null ? Number(row.regular_paycheck) : null,
    bonus_income: row.bonus_income != null ? Number(row.bonus_income) : null,
    other_income: row.other_income != null ? Number(row.other_income) : null,
    boa_rollover: row.boa_rollover != null ? Number(row.boa_rollover) : null,
    recurring_bills_due: row.recurring_bills_due != null ? Number(row.recurring_bills_due) : null,
    recurring_bills_paid: row.recurring_bills_paid != null ? Number(row.recurring_bills_paid) : null,
    expense_budget: row.expense_budget != null ? Number(row.expense_budget) : null,
    actual_expense_spending: row.actual_expense_spending != null ? Number(row.actual_expense_spending) : null,
    cash_remaining: row.cash_remaining != null ? Number(row.cash_remaining) : null,
    total_transactions: row.total_transactions != null ? Number(row.total_transactions) : null,
    reviewed_transactions: row.reviewed_transactions != null ? Number(row.reviewed_transactions) : null,
    snapshot_json: snapshotJson,
    notes: row.notes ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * Sanitize a single closeout record for backup.
 * Strips raw_json and access tokens from closeout_json.
 */
export function sanitizeCloseoutForBackup(row) {
  if (!row || typeof row !== 'object') return null;
  let closeoutJson = null;
  if (row.closeout_json) {
    try {
      const parsed = typeof row.closeout_json === 'string'
        ? JSON.parse(row.closeout_json)
        : row.closeout_json;
      closeoutJson = scrubForbiddenKeys(parsed);
      closeoutJson = JSON.stringify(closeoutJson);
    } catch (_e) {
      closeoutJson = null;
    }
  }
  return {
    id: row.id ?? null,
    period_id: row.period_id ?? null,
    period_label: row.period_label ?? null,
    start_date: row.start_date ?? null,
    display_end_date: row.display_end_date ?? null,
    exclusive_end_date: row.exclusive_end_date ?? null,
    status: row.status ?? 'open',
    closed_at: row.closed_at ?? null,
    reopened_at: row.reopened_at ?? null,
    snapshot_id: row.snapshot_id ?? null,
    income_confirmed: row.income_confirmed != null ? Number(row.income_confirmed) : 0,
    bills_confirmed: row.bills_confirmed != null ? Number(row.bills_confirmed) : 0,
    transfers_confirmed: row.transfers_confirmed != null ? Number(row.transfers_confirmed) : 0,
    expenses_confirmed: row.expenses_confirmed != null ? Number(row.expenses_confirmed) : 0,
    rollover_confirmed: row.rollover_confirmed != null ? Number(row.rollover_confirmed) : 0,
    notes: row.notes ?? null,
    carry_forward_notes: row.carry_forward_notes ?? null,
    closeout_json: closeoutJson,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * Recursively remove forbidden keys from any object/array.
 */
function scrubForbiddenKeys(obj) {
  if (Array.isArray(obj)) return obj.map(scrubForbiddenKeys);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[key] = scrubForbiddenKeys(obj[key]);
  }
  return out;
}
