/**
 * server/routes/backup.js
 *
 * GET  /api/backup/export           – download full safe backup JSON
 * POST /api/backup/import/preview   – validate backup, return counts/warnings (no write)
 * POST /api/backup/import           – restore backup (modes: merge | replace_safe_data)
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import {
  detectForbiddenSecretFields,
  sanitizeSettingsForBackup,
  sanitizeTransactionReviewsForBackup,
  sanitizeHistorySnapshotForBackup,
  sanitizeCloseoutForBackup,
} from '../backupSanitizer.js';

const router = Router();

const BACKUP_VERSION = 1;
const APP_NAME = 'budget-dashboard';
const MAX_EXPORT_BYTES = 5 * 1024 * 1024;   // 5 MB warn threshold
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;  // 10 MB hard reject
const IMPORTABLE_SETTINGS = new Set([
  'budget_income_by_period',
  'auto_detected_income_by_period',
  'safe_money_settings',
  'include_pending_transactions',
  'transaction_display_settings',
  'budget_split_settings',
  'command_center',
  'command_center_settings',
]);

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_e) { return fallback; }
}

// ─────────────────────────────────────────────
// Build export payload
// ─────────────────────────────────────────────
function buildExportPayload() {
  const settings = sanitizeSettingsForBackup(
    db.prepare('SELECT key, value_json, updated_at FROM settings').all()
  );

  const expenseList = db.prepare(
    `SELECT id, name, budget_amount, active, notes, display_order, created_at, updated_at
     FROM expense_list_items ORDER BY display_order, name`
  ).all();

  const recurringBillsList = db.prepare(
    `SELECT id, name, category, due_day, amount, paid_from, match_words, autopay, active, notes, display_order, created_at, updated_at
     FROM recurring_bills_list_items ORDER BY display_order, name`
  ).all();

  const transactionReviews = sanitizeTransactionReviewsForBackup(
    db.prepare(
      `SELECT plaid_transaction_id, date, name, amount, type, category, reviewed, ignored, notes, updated_at
       FROM transactions ORDER BY date DESC`
    ).all()
  );

  const recurringBillStatuses = db.prepare(
    `SELECT id, period_id, recurring_bill_id, paid, paid_date, notes,
            match_transaction_id, match_score, match_method, auto_paid,
            manual_paid, manually_overridden, created_at, updated_at
     FROM recurring_bill_status ORDER BY period_id, recurring_bill_id`
  ).all();

  const transactionRules = db.prepare(
    `SELECT id, name, enabled, match_type, match_value, account_id,
            amount_min, amount_max, set_type, set_category, set_ignored,
            apply_to_unreviewed_only, created_at, updated_at
     FROM transaction_rules ORDER BY created_at`
  ).all();

  const historySnapshots = db.prepare(
    `SELECT * FROM pay_period_snapshots ORDER BY start_date DESC`
  ).all().map(sanitizeHistorySnapshotForBackup).filter(Boolean);

  const closeouts = db.prepare(
    `SELECT * FROM pay_period_closeouts ORDER BY start_date DESC`
  ).all().map(sanitizeCloseoutForBackup).filter(Boolean);

  // manual_adjustments table may not exist
  let manualAdjustments = [];
  try {
    manualAdjustments = db.prepare('SELECT * FROM manual_adjustments ORDER BY created_at').all();
  } catch (_e) {
    // table does not exist
  }

  return {
    backupVersion: BACKUP_VERSION,
    appName: APP_NAME,
    exportedAt: nowIso(),
    data: {
      settings,
      expenseList,
      recurringBillsList,
      transactionReviews,
      recurringBillStatuses,
      transferChecklist: [],   // no persistent table – computed at runtime
      transactionRules,
      historySnapshots,
      closeouts,
      manualAdjustments,
    },
    excluded: {
      plaidTokens: true,
      rawPlaidJson: true,
      envValues: true,
      databaseFile: true,
    },
  };
}

// ─────────────────────────────────────────────
// GET /api/backup/export
// ─────────────────────────────────────────────
router.get('/export', (_req, res) => {
  try {
    const payload = buildExportPayload();
    const json = JSON.stringify(payload, null, 2);
    const byteSize = Buffer.byteLength(json, 'utf8');

    const warnings = [];
    if (byteSize > MAX_EXPORT_BYTES) {
      warnings.push(`Export is ${(byteSize / 1024 / 1024).toFixed(2)} MB. Check for unexpected data.`);
    }

    // Final paranoia check – should never fire given sanitizers above
    const forbidden = detectForbiddenSecretFields(payload.data);
    if (forbidden.length > 0) {
      console.error('BACKUP EXPORT BLOCKED: forbidden fields detected:', forbidden);
      return res.status(500).json({ error: 'Export blocked: forbidden secret fields detected.', fields: forbidden });
    }

    const filename = `budget-dashboard-backup-${nowIso().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (warnings.length > 0) {
      res.setHeader('X-Backup-Warnings', warnings.join('; '));
    }
    res.send(json);
  } catch (err) {
    console.error('Backup export failed:', err);
    res.status(500).json({ error: 'Backup export failed.' });
  }
});

// ─────────────────────────────────────────────
// Validate a backup payload
// ─────────────────────────────────────────────
function validateBackup(backup) {
  const errors = [];
  const warnings = [];

  if (!backup || typeof backup !== 'object') {
    errors.push('Backup is not a valid object.');
    return { errors, warnings };
  }
  if (!backup.backupVersion) errors.push('backupVersion is missing.');
  if (!backup.data || typeof backup.data !== 'object') errors.push('data object is missing.');

  if (errors.length > 0) return { errors, warnings };

  // Scan for forbidden fields
  const forbidden = detectForbiddenSecretFields(backup.data);
  if (forbidden.length > 0) {
    errors.push(`Backup contains forbidden secret fields: ${forbidden.join(', ')}`);
  }

  const data = backup.data;

  if (data.settings && !Array.isArray(data.settings)) warnings.push('settings is not an array – will be skipped.');
  if (data.expenseList && !Array.isArray(data.expenseList)) warnings.push('expenseList is not an array – will be skipped.');
  if (data.recurringBillsList && !Array.isArray(data.recurringBillsList)) warnings.push('recurringBillsList is not an array – will be skipped.');
  if (data.transactionReviews && !Array.isArray(data.transactionReviews)) warnings.push('transactionReviews is not an array – will be skipped.');

  return { errors, warnings };
}

function buildCounts(data) {
  return {
    settings: Array.isArray(data.settings) ? data.settings.length : 0,
    expenseList: Array.isArray(data.expenseList) ? data.expenseList.length : 0,
    recurringBillsList: Array.isArray(data.recurringBillsList) ? data.recurringBillsList.length : 0,
    transactionReviews: Array.isArray(data.transactionReviews) ? data.transactionReviews.length : 0,
    recurringBillStatuses: Array.isArray(data.recurringBillStatuses) ? data.recurringBillStatuses.length : 0,
    transactionRules: Array.isArray(data.transactionRules) ? data.transactionRules.length : 0,
    historySnapshots: Array.isArray(data.historySnapshots) ? data.historySnapshots.length : 0,
    closeouts: Array.isArray(data.closeouts) ? data.closeouts.length : 0,
    manualAdjustments: Array.isArray(data.manualAdjustments) ? data.manualAdjustments.length : 0,
  };
}

// ─────────────────────────────────────────────
// POST /api/backup/import/preview
// ─────────────────────────────────────────────
router.post('/import/preview', (req, res) => {
  try {
    const rawBody = JSON.stringify(req.body);
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_IMPORT_BYTES) {
      return res.status(413).json({ ok: false, error: 'Backup file is too large.' });
    }

    const backup = req.body;
    const { errors, warnings } = validateBackup(backup);

    if (errors.length > 0) {
      const isForbidden = errors.some((e) => e.includes('forbidden secret fields'));
      return res.status(isForbidden ? 400 : 400).json({ ok: false, errors, warnings });
    }

    const counts = buildCounts(backup.data);

    const actionsPreview = [
      `Import ${counts.settings} settings key(s)`,
      `Import ${counts.expenseList} expense list item(s)`,
      `Import ${counts.recurringBillsList} recurring bill(s)`,
      `Update up to ${counts.transactionReviews} transaction review field(s) (matched by plaid_transaction_id)`,
      `Import ${counts.recurringBillStatuses} recurring bill status record(s)`,
      `Import ${counts.transactionRules} transaction rule(s)`,
      `Import ${counts.historySnapshots} history snapshot(s)`,
      `Import ${counts.closeouts} closeout record(s)`,
    ];

    res.json({
      ok: true,
      backupVersion: backup.backupVersion,
      exportedAt: backup.exportedAt ?? null,
      counts,
      warnings,
      errors: [],
      actionsPreview,
    });
  } catch (err) {
    console.error('Backup preview failed:', err);
    res.status(500).json({ ok: false, error: 'Preview failed.' });
  }
});

// ─────────────────────────────────────────────
// Import helpers
// ─────────────────────────────────────────────

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function importSettings(data) {
  if (!Array.isArray(data.settings)) return { imported: 0 };
  const stmt = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  );
  let imported = 0;
  for (const row of data.settings) {
    if (!row || !row.key) continue;
    if (!IMPORTABLE_SETTINGS.has(row.key)) continue;
    stmt.run(row.key, row.value_json ?? null, row.updated_at ?? nowIso());
    imported++;
  }
  return { imported };
}

function importExpenseList(data, mode) {
  if (!Array.isArray(data.expenseList)) return { imported: 0, skipped: 0 };
  let imported = 0, skipped = 0;

  const existing = db.prepare('SELECT * FROM expense_list_items').all();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const byName = new Map(existing.map((r) => [normalizeName(r.name), r]));

  const upsertById = db.prepare(
    `INSERT INTO expense_list_items (id, name, budget_amount, active, notes, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       budget_amount = excluded.budget_amount,
       active = excluded.active,
       notes = excluded.notes,
       display_order = excluded.display_order,
       updated_at = excluded.updated_at`
  );
  const insertNew = db.prepare(
    `INSERT INTO expense_list_items (id, name, budget_amount, active, notes, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const item of data.expenseList) {
    if (!item || !item.name) { skipped++; continue; }
    const now = nowIso();
    if (item.id && byId.has(item.id)) {
      upsertById.run(item.id, item.name, item.budget_amount ?? 0, item.active ?? 1, item.notes ?? null, item.display_order ?? 0, item.created_at ?? now, item.updated_at ?? now);
      imported++;
    } else {
      const nameKey = normalizeName(item.name);
      const match = byName.get(nameKey);
      if (match) {
        // Update matched by name
        db.prepare(`UPDATE expense_list_items SET budget_amount = ?, active = ?, notes = ?, display_order = ?, updated_at = ? WHERE id = ?`)
          .run(item.budget_amount ?? match.budget_amount, item.active ?? match.active, item.notes ?? match.notes, item.display_order ?? match.display_order, now, match.id);
        imported++;
      } else if (mode === 'replace_safe_data' || !byName.has(nameKey)) {
        const newId = item.id || randomUUID();
        insertNew.run(newId, item.name, item.budget_amount ?? 0, item.active ?? 1, item.notes ?? null, item.display_order ?? 0, item.created_at ?? now, item.updated_at ?? now);
        imported++;
      } else {
        skipped++;
      }
    }
  }
  return { imported, skipped };
}

function importRecurringBillsList(data, mode) {
  if (!Array.isArray(data.recurringBillsList)) return { imported: 0, skipped: 0 };
  let imported = 0, skipped = 0;

  const existing = db.prepare('SELECT * FROM recurring_bills_list_items').all();
  const byId = new Map(existing.map((r) => [r.id, r]));

  // For merge: match by normalized name + due_day + amount (preserve duplicate Debt Snowball rows by id)
  const bySignature = new Map();
  for (const r of existing) {
    const sig = `${normalizeName(r.name)}|${r.due_day ?? ''}|${r.amount ?? ''}`;
    if (!bySignature.has(sig)) bySignature.set(sig, r);
  }

  const upsertById = db.prepare(
    `INSERT INTO recurring_bills_list_items
       (id, name, category, due_day, amount, paid_from, match_words, autopay, active, notes, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, category = excluded.category, due_day = excluded.due_day,
       amount = excluded.amount, paid_from = excluded.paid_from, match_words = excluded.match_words,
       autopay = excluded.autopay, active = excluded.active, notes = excluded.notes,
       display_order = excluded.display_order, updated_at = excluded.updated_at`
  );
  const insertNew = db.prepare(
    `INSERT INTO recurring_bills_list_items
       (id, name, category, due_day, amount, paid_from, match_words, autopay, active, notes, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const item of data.recurringBillsList) {
    if (!item || !item.name) { skipped++; continue; }
    const now = nowIso();
    const matchWords = Array.isArray(item.match_words) ? JSON.stringify(item.match_words) : (item.match_words ?? null);

    if (item.id && byId.has(item.id)) {
      upsertById.run(item.id, item.name, item.category ?? 'Needs', item.due_day ?? null, item.amount ?? 0, item.paid_from ?? null, matchWords, item.autopay ?? 0, item.active ?? 1, item.notes ?? null, item.display_order ?? 0, item.created_at ?? now, item.updated_at ?? now);
      imported++;
    } else {
      const sig = `${normalizeName(item.name)}|${item.due_day ?? ''}|${item.amount ?? ''}`;
      const match = bySignature.get(sig);
      if (match && !item.id) {
        // Update matched row, but only if NOT a different-id duplicate (Debt Snowball)
        db.prepare(
          `UPDATE recurring_bills_list_items SET category = ?, due_day = ?, amount = ?, paid_from = ?, match_words = ?, autopay = ?, active = ?, notes = ?, display_order = ?, updated_at = ? WHERE id = ?`
        ).run(item.category ?? match.category, item.due_day ?? match.due_day, item.amount ?? match.amount, item.paid_from ?? match.paid_from, matchWords ?? match.match_words, item.autopay ?? match.autopay, item.active ?? match.active, item.notes ?? match.notes, item.display_order ?? match.display_order, now, match.id);
        imported++;
      } else {
        // Insert new (preserves duplicate Debt Snowball rows with distinct ids)
        const newId = item.id || randomUUID();
        insertNew.run(newId, item.name, item.category ?? 'Needs', item.due_day ?? null, item.amount ?? 0, item.paid_from ?? null, matchWords, item.autopay ?? 0, item.active ?? 1, item.notes ?? null, item.display_order ?? 0, item.created_at ?? now, item.updated_at ?? now);
        imported++;
      }
    }
  }
  return { imported, skipped };
}

function importTransactionReviews(data) {
  if (!Array.isArray(data.transactionReviews)) return { imported: 0, skipped: 0, skippedMissing: 0 };
  let imported = 0, skipped = 0, skippedMissing = 0;

  const updateStmt = db.prepare(
    `UPDATE transactions
     SET type = COALESCE(?, type),
         category = COALESCE(?, category),
         reviewed = ?,
         ignored = ?,
         notes = COALESCE(?, notes),
         updated_at = ?
     WHERE plaid_transaction_id = ?`
  );

  for (const item of data.transactionReviews) {
    if (!item || !item.plaid_transaction_id) { skipped++; continue; }
    const info = updateStmt.run(
      item.type ?? null,
      item.category ?? null,
      item.reviewed != null ? Number(item.reviewed) : 0,
      item.ignored != null ? Number(item.ignored) : 0,
      item.notes ?? null,
      item.updated_at ?? nowIso(),
      item.plaid_transaction_id
    );
    if (info.changes > 0) {
      imported++;
    } else {
      skippedMissing++;
    }
  }
  return { imported, skipped, skippedMissing };
}

function importRecurringBillStatuses(data) {
  if (!Array.isArray(data.recurringBillStatuses)) return { imported: 0 };
  const stmt = db.prepare(
    `INSERT INTO recurring_bill_status
       (id, period_id, recurring_bill_id, paid, paid_date, notes, match_transaction_id,
        match_score, match_method, auto_paid, manual_paid, manually_overridden, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(period_id, recurring_bill_id) DO UPDATE SET
       paid = excluded.paid, paid_date = excluded.paid_date,
       notes = excluded.notes, match_transaction_id = excluded.match_transaction_id,
       match_score = excluded.match_score, match_method = excluded.match_method,
       auto_paid = excluded.auto_paid, manual_paid = excluded.manual_paid,
       manually_overridden = excluded.manually_overridden, updated_at = excluded.updated_at`
  );
  let imported = 0;
  for (const item of data.recurringBillStatuses) {
    if (!item || !item.period_id || !item.recurring_bill_id) continue;
    const now = nowIso();
    stmt.run(
      item.id || randomUUID(), item.period_id, item.recurring_bill_id,
      item.paid ?? 0, item.paid_date ?? null, item.notes ?? null,
      item.match_transaction_id ?? null, item.match_score ?? 0,
      item.match_method ?? null, item.auto_paid ?? 0,
      item.manual_paid ?? 0, item.manually_overridden ?? 0,
      item.created_at ?? now, item.updated_at ?? now
    );
    imported++;
  }
  return { imported };
}

function importTransactionRules(data) {
  if (!Array.isArray(data.transactionRules)) return { imported: 0 };
  const existing = db.prepare('SELECT * FROM transaction_rules').all();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const bySignature = new Map(existing.map((r) => [`${r.match_type}|${r.match_value}|${r.set_type}|${r.set_category}`, r]));

  const upsert = db.prepare(
    `INSERT INTO transaction_rules
       (id, name, enabled, match_type, match_value, account_id, amount_min, amount_max,
        set_type, set_category, set_ignored, apply_to_unreviewed_only, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, enabled = excluded.enabled, match_type = excluded.match_type,
       match_value = excluded.match_value, set_type = excluded.set_type,
       set_category = excluded.set_category, set_ignored = excluded.set_ignored,
       apply_to_unreviewed_only = excluded.apply_to_unreviewed_only, updated_at = excluded.updated_at`
  );

  let imported = 0;
  for (const item of data.transactionRules) {
    if (!item || !item.match_value) continue;
    const now = nowIso();
    let id = item.id;
    if (!id || !byId.has(id)) {
      const sig = `${item.match_type}|${item.match_value}|${item.set_type}|${item.set_category}`;
      const matched = bySignature.get(sig);
      id = matched ? matched.id : (item.id || randomUUID());
    }
    upsert.run(
      id, item.name ?? null, item.enabled ?? 1, item.match_type ?? 'contains',
      item.match_value, item.account_id ?? null, item.amount_min ?? null, item.amount_max ?? null,
      item.set_type ?? null, item.set_category ?? null, item.set_ignored ?? 0,
      item.apply_to_unreviewed_only ?? 1, item.created_at ?? now, item.updated_at ?? now
    );
    imported++;
  }
  return { imported };
}

function importHistorySnapshots(data) {
  if (!Array.isArray(data.historySnapshots)) return { imported: 0, skipped: 0 };
  let imported = 0, skipped = 0;

  const stmt = db.prepare(
    `INSERT INTO pay_period_snapshots
       (id, period_id, period_label, start_date, display_end_date, exclusive_end_date,
        budget_income, regular_paycheck, bonus_income, other_income, boa_rollover,
        recurring_bills_due, recurring_bills_paid, recurring_bills_left_to_pay,
        expense_budget, actual_expense_spending, expense_remaining, cash_remaining,
        planned_transfers_total, josh_transfer, taylor_transfer, discover_transfer,
        debt_savings_transfer, boa_reserve, total_transactions, reviewed_transactions,
        unreviewed_transactions, ignored_transactions, snapshot_json, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       snapshot_json = excluded.snapshot_json, notes = excluded.notes, updated_at = excluded.updated_at`
  );

  for (const item of data.historySnapshots) {
    if (!item || !item.period_id) { skipped++; continue; }
    // Reject if snapshot_json contains forbidden fields
    if (item.snapshot_json) {
      try {
        const parsed = JSON.parse(item.snapshot_json);
        const forbidden = detectForbiddenSecretFields(parsed);
        if (forbidden.length > 0) { skipped++; continue; }
      } catch (_e) { /* not parseable – allow null */ }
    }
    const now = nowIso();
    stmt.run(
      item.id || randomUUID(), item.period_id, item.period_label ?? '', item.start_date ?? '',
      item.display_end_date ?? '', item.exclusive_end_date ?? '',
      item.budget_income ?? 0, item.regular_paycheck ?? 0, item.bonus_income ?? 0,
      item.other_income ?? 0, item.boa_rollover ?? 0, item.recurring_bills_due ?? 0,
      item.recurring_bills_paid ?? 0, item.recurring_bills_left_to_pay ?? 0,
      item.expense_budget ?? 0, item.actual_expense_spending ?? 0, item.expense_remaining ?? 0,
      item.cash_remaining ?? 0, item.planned_transfers_total ?? 0, item.josh_transfer ?? 0,
      item.taylor_transfer ?? 0, item.discover_transfer ?? 0, item.debt_savings_transfer ?? 0,
      item.boa_reserve ?? 0, item.total_transactions ?? 0, item.reviewed_transactions ?? 0,
      item.unreviewed_transactions ?? 0, item.ignored_transactions ?? 0,
      item.snapshot_json ?? null, item.notes ?? null, item.created_at ?? now, item.updated_at ?? now
    );
    imported++;
  }
  return { imported, skipped };
}

function importCloseouts(data) {
  if (!Array.isArray(data.closeouts)) return { imported: 0, skipped: 0 };
  let imported = 0, skipped = 0;

  const stmt = db.prepare(
    `INSERT INTO pay_period_closeouts
       (id, period_id, period_label, start_date, display_end_date, exclusive_end_date,
        status, closed_at, reopened_at, snapshot_id, income_confirmed, bills_confirmed,
        transfers_confirmed, expenses_confirmed, rollover_confirmed, notes, carry_forward_notes,
        closeout_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(period_id) DO UPDATE SET
       status = excluded.status, closed_at = excluded.closed_at, reopened_at = excluded.reopened_at,
       snapshot_id = excluded.snapshot_id, income_confirmed = excluded.income_confirmed,
       bills_confirmed = excluded.bills_confirmed, transfers_confirmed = excluded.transfers_confirmed,
       expenses_confirmed = excluded.expenses_confirmed, rollover_confirmed = excluded.rollover_confirmed,
       notes = excluded.notes, carry_forward_notes = excluded.carry_forward_notes,
       closeout_json = excluded.closeout_json, updated_at = excluded.updated_at`
  );

  for (const item of data.closeouts) {
    if (!item || !item.period_id) { skipped++; continue; }
    if (item.closeout_json) {
      try {
        const parsed = JSON.parse(item.closeout_json);
        const forbidden = detectForbiddenSecretFields(parsed);
        if (forbidden.length > 0) { skipped++; continue; }
      } catch (_e) { /* allow */ }
    }
    const now = nowIso();
    stmt.run(
      item.id || randomUUID(), item.period_id, item.period_label ?? '', item.start_date ?? '',
      item.display_end_date ?? '', item.exclusive_end_date ?? '',
      item.status ?? 'open', item.closed_at ?? null, item.reopened_at ?? null,
      item.snapshot_id ?? null, item.income_confirmed ?? 0, item.bills_confirmed ?? 0,
      item.transfers_confirmed ?? 0, item.expenses_confirmed ?? 0, item.rollover_confirmed ?? 0,
      item.notes ?? null, item.carry_forward_notes ?? null, item.closeout_json ?? null,
      item.created_at ?? now, item.updated_at ?? now
    );
    imported++;
  }
  return { imported, skipped };
}

function deleteSafeSetupTables() {
  db.prepare('DELETE FROM settings').run();
  db.prepare('DELETE FROM expense_list_items').run();
  db.prepare('DELETE FROM recurring_bills_list_items').run();
  db.prepare('DELETE FROM transaction_rules').run();
}

// ─────────────────────────────────────────────
// POST /api/backup/import
// ─────────────────────────────────────────────
router.post('/import', (req, res) => {
  try {
    const rawBody = JSON.stringify(req.body);
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_IMPORT_BYTES) {
      return res.status(413).json({ ok: false, error: 'Backup file is too large.' });
    }

    const { backup, mode = 'merge' } = req.body;
    if (!backup || typeof backup !== 'object') {
      return res.status(400).json({ ok: false, error: 'Backup file is not valid JSON.' });
    }
    if (!['merge', 'replace_safe_data'].includes(mode)) {
      return res.status(400).json({ ok: false, error: `Unknown import mode: ${mode}` });
    }
    if (mode === 'replace_safe_data' && req.body.confirmText !== 'REPLACE SAFE DATA') {
      return res.status(400).json({ ok: false, error: 'Replace confirmation is required.' });
    }

    const { errors, warnings } = validateBackup(backup);
    if (errors.length > 0) {
      const isForbidden = errors.some((e) => e.includes('forbidden secret fields'));
      return res.status(400).json({
        ok: false,
        errors,
        warnings,
        message: isForbidden
          ? 'Backup contains forbidden secret fields and was rejected.'
          : errors[0],
      });
    }

    const data = backup.data;
    const importedCounts = {};
    const importWarnings = [...warnings];

    // For replace_safe_data: clear safe setup tables before import
    if (mode === 'replace_safe_data') {
      deleteSafeSetupTables();
    }

    const settingsResult = importSettings(data);
    importedCounts.settings = settingsResult.imported;

    const expenseResult = importExpenseList(data, mode);
    importedCounts.expenseList = expenseResult.imported;
    if (expenseResult.skipped > 0) importWarnings.push(`${expenseResult.skipped} expense list item(s) skipped.`);

    const billsResult = importRecurringBillsList(data, mode);
    importedCounts.recurringBillsList = billsResult.imported;
    if (billsResult.skipped > 0) importWarnings.push(`${billsResult.skipped} recurring bill(s) skipped.`);

    const reviewsResult = importTransactionReviews(data);
    importedCounts.transactionReviews = reviewsResult.imported;
    if (reviewsResult.skippedMissing > 0) {
      importWarnings.push(`${reviewsResult.skippedMissing} transaction review(s) skipped – Plaid transaction not found locally.`);
    }

    const billStatusResult = importRecurringBillStatuses(data);
    importedCounts.recurringBillStatuses = billStatusResult.imported;

    const rulesResult = importTransactionRules(data);
    importedCounts.transactionRules = rulesResult.imported;

    const snapshotsResult = importHistorySnapshots(data);
    importedCounts.historySnapshots = snapshotsResult.imported;
    if (snapshotsResult.skipped > 0) importWarnings.push(`${snapshotsResult.skipped} history snapshot(s) skipped (forbidden data detected).`);

    const closeoutsResult = importCloseouts(data);
    importedCounts.closeouts = closeoutsResult.imported;
    if (closeoutsResult.skipped > 0) importWarnings.push(`${closeoutsResult.skipped} closeout(s) skipped (forbidden data detected).`);

    // Log the import
    try {
      db.prepare(
        `INSERT INTO backup_import_logs (id, imported_at, backup_version, mode, counts_json, warnings_json, errors_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(), nowIso(), backup.backupVersion ?? 0, mode,
        JSON.stringify(importedCounts), JSON.stringify(importWarnings), JSON.stringify([])
      );
    } catch (_logErr) {
      // logging is best-effort
    }

    res.json({
      ok: true,
      mode,
      counts: importedCounts,
      warnings: importWarnings,
    });
  } catch (err) {
    console.error('Backup import failed:', err);
    res.status(500).json({ ok: false, error: 'Import failed.' });
  }
});

export default router;
