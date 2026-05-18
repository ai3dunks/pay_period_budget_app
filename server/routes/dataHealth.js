import { Router } from 'express';
import db from '../db.js';
import { buildPayPeriodSummary } from '../../shared/payPeriodSummary.js';
import { applyRulesToTransactions } from '../../shared/transactionRules.js';

const router = Router();

const REQUIRED_TABLES = [
  'plaid_items',
  'accounts',
  'transactions',
  'settings',
  'expense_list_items',
  'recurring_bills_list_items',
  'recurring_bill_status',
  'transaction_rules',
  'pay_period_snapshots',
  'pay_period_closeouts',
];

function toIsoDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function subtractDays(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() - days);
  return toIsoDate(date);
}

function parsePeriodFromId(periodId) {
  const parts = String(periodId || '').slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const start = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(start.getTime())) return null;
  const displayEnd = addDays(start, 13);
  const exclusiveEnd = addDays(start, 14);
  return {
    id: toIsoDate(start),
    startDate: toIsoDate(start),
    displayEndDate: toIsoDate(displayEnd),
    exclusiveEndDate: toIsoDate(exclusiveEnd),
    label: toIsoDate(start) + ' - ' + toIsoDate(displayEnd),
  };
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function severityWeight(severity) {
  if (severity === 'error') return 3;
  if (severity === 'warning') return 2;
  return 1;
}

function toSectionStatus(issues, section) {
  const scoped = issues.filter((issue) => issue.section === section);
  if (scoped.some((issue) => issue.severity === 'error')) return 'error';
  if (scoped.some((issue) => issue.severity === 'warning')) return 'warning';
  if (scoped.length) return 'needs_review';
  return 'good';
}

function pushIssue(issues, issue) {
  issues.push({
    id: issue.id,
    severity: issue.severity,
    section: issue.section,
    title: issue.title,
    message: issue.message,
    count: Number(issue.count || 0),
    actionLabel: issue.actionLabel || 'Review',
    actionTarget: issue.actionTarget || 'dashboard',
  });
}

function detectDuplicateAccountCount(accounts = []) {
  const buckets = new Map();
  for (const account of accounts) {
    const key = [
      String(account.name || '').toLowerCase().trim(),
      String(account.mask || '').trim(),
      String(account.institution_name || '').toLowerCase().trim(),
    ].join('|');
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  let duplicateCount = 0;
  buckets.forEach((count) => {
    if (count > 1) duplicateCount += count - 1;
  });
  return duplicateCount;
}

function detectDuplicateTransactions(startDate, exclusiveEndDate) {
  const rows = db.prepare(
    `SELECT
      date,
      ROUND(amount, 2) AS amount,
      LOWER(TRIM(COALESCE(name, ''))) AS name,
      COUNT(*) AS count
     FROM transactions
     WHERE date >= ?
       AND date < ?
       AND ignored = 0
     GROUP BY COALESCE(account_id, ''), date, ROUND(amount, 2), LOWER(TRIM(COALESCE(name, '')))
     HAVING COUNT(*) > 1
     ORDER BY count DESC, date DESC
     LIMIT 10`
  ).all(startDate, exclusiveEndDate);

  return {
    duplicateCount: rows.reduce((sum, row) => sum + (Number(row.count || 0) - 1), 0),
    samples: rows.slice(0, 5).map((row) => ({
      date: row.date,
      amount: row.amount,
      name: row.name,
      count: Number(row.count || 0),
    })),
  };
}

function buildActionsFromIssues(issues = []) {
  return issues
    .slice()
    .sort((a, b) => {
      const severityCompare = severityWeight(b.severity) - severityWeight(a.severity);
      if (severityCompare !== 0) return severityCompare;
      return Number(b.count || 0) - Number(a.count || 0);
    })
    .slice(0, 6)
    .map((issue) => ({
      id: issue.id,
      label: issue.actionLabel,
      target: issue.actionTarget,
      severity: issue.severity,
      title: issue.title,
      message: issue.message,
      count: issue.count,
    }));
}

router.get('/', (req, res) => {
  const generatedAt = new Date().toISOString();
  const { periodId } = req.query;

  if (!periodId) {
    return res.status(400).json({
      status: 'error',
      score: 0,
      generatedAt,
      periodId: null,
      sections: {},
      issues: [
        {
          id: 'missing-period',
          severity: 'error',
          section: 'transactions',
          title: 'Period is required',
          message: 'periodId query parameter is required.',
          count: 0,
          actionLabel: 'Open Dashboard',
          actionTarget: 'dashboard',
        },
      ],
      actions: [],
    });
  }

  const period = parsePeriodFromId(periodId);
  if (!period) {
    return res.status(400).json({
      status: 'error',
      score: 0,
      generatedAt,
      periodId,
      sections: {},
      issues: [
        {
          id: 'invalid-period',
          severity: 'error',
          section: 'transactions',
          title: 'Invalid periodId',
          message: 'periodId must be a YYYY-MM-DD value.',
          count: 0,
          actionLabel: 'Open Dashboard',
          actionTarget: 'dashboard',
        },
      ],
      actions: [],
    });
  }

  try {
    let score = 100;
    const issues = [];

    const activeItems = db.prepare(
      "SELECT item_id, institution_name, status, last_synced_at FROM plaid_items WHERE status IS NULL OR status IN ('active', 'connected')"
    ).all();
    const removedItemsCount = db.prepare("SELECT COUNT(*) AS count FROM plaid_items WHERE status = 'removed'").get()?.count || 0;

    const activeAccounts = db.prepare(
      `SELECT a.id, a.item_id, a.plaid_account_id, a.institution_name, a.name, a.mask
       FROM accounts a
       LEFT JOIN plaid_items p ON p.item_id = a.item_id
       WHERE a.item_id IS NULL OR p.status IS NULL OR p.status IN ('active', 'connected')`
    ).all();

    const staleAccountsCount = db.prepare(
      `SELECT COUNT(*) AS count
       FROM accounts a
       WHERE a.item_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM plaid_items p
           WHERE p.item_id = a.item_id
             AND p.status = 'removed'
         )`
    ).get()?.count || 0;

    const duplicateActiveAccounts = detectDuplicateAccountCount(activeAccounts);

    const summaryWindowStart = subtractDays(period.startDate, 90);

    const allTransactions = db.prepare(
      `SELECT id, account_id, plaid_account_id, item_id, date, name, merchant_name, amount, pending, type, category, reviewed, ignored, notes, created_at, updated_at
       FROM transactions
       WHERE date >= ? AND date < ?
       ORDER BY date DESC`
    ).all(period.startDate, period.exclusiveEndDate);

    const allTransactionsForSummary = db.prepare(
      `SELECT id, account_id, plaid_account_id, item_id, date, name, merchant_name, amount, pending, type, category, reviewed, ignored, notes, created_at, updated_at
       FROM transactions
       WHERE date >= ? AND date < ?
       ORDER BY date DESC`
    ).all(summaryWindowStart, period.exclusiveEndDate);

    const transactionCounts = db.prepare(
      `SELECT
        SUM(CASE WHEN reviewed = 1 AND ignored = 0 THEN 1 ELSE 0 END) AS reviewed_count,
        SUM(CASE WHEN reviewed = 0 AND ignored = 0 THEN 1 ELSE 0 END) AS unreviewed_count,
        SUM(CASE WHEN ignored = 1 THEN 1 ELSE 0 END) AS ignored_count,
        SUM(CASE WHEN pending = 1 THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN ignored = 0 AND (category IS NULL OR TRIM(category) = '') THEN 1 ELSE 0 END) AS uncategorized_count
       FROM transactions
       WHERE date >= ? AND date < ?`
    ).get(period.startDate, period.exclusiveEndDate) || {};

    const recurringBillsList = db.prepare('SELECT * FROM recurring_bills_list_items WHERE active = 1 ORDER BY due_day ASC').all();
    const recurringBillStatuses = db.prepare('SELECT * FROM recurring_bill_status WHERE period_id = ?').all(period.id);
    const expenseList = db.prepare('SELECT * FROM expense_list_items WHERE active = 1 ORDER BY display_order ASC, name COLLATE NOCASE ASC').all();

    const settingsRows = db.prepare(
      `SELECT key, value_json
       FROM settings
       WHERE key IN (
         'budget_income_by_period',
         'auto_detected_income_by_period',
         'safe_money_settings',
         'include_pending_transactions',
         'transaction_display_settings',
          'rules_last_applied_at',
          'plaid_last_sync_result'
       )`
    ).all();

    const settingsMap = new Map(settingsRows.map((row) => [row.key, safeJsonParse(row.value_json, null)]));

    const safeMoneySettings = settingsMap.get('safe_money_settings') || {};
    const includePendingFromSafeMoney = safeMoneySettings.includePendingTransactions === true || safeMoneySettings.include_pending_transactions === true;
    const includePendingLegacy = settingsMap.get('include_pending_transactions') === true;
    const transactionDisplaySettings = settingsMap.get('transaction_display_settings') || {};

    const pendingVisible = transactionDisplaySettings.showPendingTransactions !== false;
    const pendingInBudgetTotals = transactionDisplaySettings.includePendingInBudgetTotals ?? includePendingFromSafeMoney ?? includePendingLegacy;
    const pendingInBillMatching = transactionDisplaySettings.includePendingInBillMatching === true;
    const pendingInTransferMatching = transactionDisplaySettings.includePendingInTransferMatching === true;
    const plaidLastSyncResult = settingsMap.get('plaid_last_sync_result') || null;

    const summary = buildPayPeriodSummary({
      period,
      accounts: activeAccounts.map((acc) => ({
        id: acc.id,
        itemId: acc.item_id,
        plaidAccountId: acc.plaid_account_id,
        institutionName: acc.institution_name,
        name: acc.name,
        mask: acc.mask,
      })),
      transactions: allTransactionsForSummary,
      expenseList: expenseList.map((row) => ({
        id: row.id,
        name: row.name,
        budgetAmount: Number(row.budget_amount || 0),
        active: !!row.active,
        notes: row.notes || '',
        displayOrder: row.display_order || 0,
      })),
      recurringBillsList: recurringBillsList.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        dueDay: row.due_day,
        amount: Number(row.amount || 0),
        paidFrom: row.paid_from || '',
        matchWords: safeJsonParse(row.match_words, null) || String(row.match_words || '').split(',').map((w) => String(w || '').trim()).filter(Boolean),
        autopay: !!row.autopay,
        active: !!row.active,
        notes: row.notes || '',
        displayOrder: row.display_order || 0,
      })),
      recurringBillStatuses: recurringBillStatuses.map((row) => ({
        recurringBillId: row.recurring_bill_id,
        paid: !!row.paid,
        autoPaid: !!row.auto_paid,
        manuallyOverridden: !!row.manually_overridden,
        matchTransactionId: row.match_transaction_id,
        matchScore: Number(row.match_score || 0),
        matchMethod: row.match_method,
      })),
      settings: {
        budget_income_by_period: settingsMap.get('budget_income_by_period') || {},
        auto_detected_income_by_period: settingsMap.get('auto_detected_income_by_period') || {},
        manualIncomeByPeriod: settingsMap.get('budget_income_by_period') || {},
        autoDetectedIncomeByPeriod: settingsMap.get('auto_detected_income_by_period') || {},
        safeMoneySettings,
        includePendingTransactions: pendingInBudgetTotals === true,
        includePending: pendingInBudgetTotals === true,
      },
    });

    const enabledRules = db.prepare('SELECT * FROM transaction_rules WHERE enabled = 1').all();
    const disabledRulesCount = db.prepare('SELECT COUNT(*) AS count FROM transaction_rules WHERE enabled = 0').get()?.count || 0;
    const unreviewedRows = allTransactions.filter((row) => !row.reviewed && !row.ignored);
    const rulesPreview = applyRulesToTransactions(unreviewedRows, enabledRules);

    const duplicateTx = detectDuplicateTransactions(period.startDate, period.exclusiveEndDate);

    const reviewedCount = Number(transactionCounts.reviewed_count || 0);
    const unreviewedCount = Number(transactionCounts.unreviewed_count || 0);
    const ignoredCount = Number(transactionCounts.ignored_count || 0);
    const pendingCount = Number(transactionCounts.pending_count || 0);
    const uncategorizedCount = Number(transactionCounts.uncategorized_count || 0);

    const unmatchedRecurringBillsCount = Number(summary.recurringBills.unpaidCount || 0);
    const autopayNotFoundCount = (summary.recurringBills.unpaidRows || []).filter((row) => row.autopay && !row.paidTransactionId).length;
    const possibleMatchesCount = (summary.recurringBills.dueRows || []).filter((row) => Number(row.status?.matchScore || 0) >= 50 && Number(row.status?.matchScore || 0) < 75).length;

    const missingMatchWordsCount = recurringBillsList.filter((row) => {
      const words = safeJsonParse(row.match_words, null) || String(row.match_words || '').split(',').map((w) => String(w || '').trim()).filter(Boolean);
      return !words.length;
    }).length;
    const missingDueDayCount = recurringBillsList.filter((row) => !Number.isFinite(Number(row.due_day || 0)) || Number(row.due_day || 0) <= 0).length;
    const missingAmountCount = recurringBillsList.filter((row) => Number(row.amount || 0) <= 0).length;

    const transferRequiredRemaining = Number(summary.safeMoney?.safeToSpend?.breakdown?.requiredTransfersRemaining || 0);
    const transferChecklistGenerated = Number(summary.transfers.total || 0) > 0 || transferRequiredRemaining > 0;

    const noActivePlaid = activeItems.length === 0;
    const noPeriodTransactions = allTransactions.length === 0;
    const missingBudgetIncome = Number(summary.income.budgetIncome || 0) <= 0;

    const nowTs = Date.now();
    const latestSyncTs = activeItems
      .map((item) => Date.parse(item.last_synced_at || 0))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0] || null;
    const syncOlderThanDay = latestSyncTs ? (nowTs - latestSyncTs) > 24 * 60 * 60 * 1000 : false;

    if (noActivePlaid) {
      score -= 30;
      pushIssue(issues, {
        id: 'no-connected-bank',
        severity: 'error',
        section: 'plaid',
        title: 'No connected bank',
        message: 'No active Plaid item is connected.',
        count: 0,
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      });
    }

    if (noPeriodTransactions) {
      score -= 25;
      pushIssue(issues, {
        id: 'no-period-transactions',
        severity: 'error',
        section: 'transactions',
        title: 'No transactions in period',
        message: 'No transactions were found for the selected budget period.',
        count: 0,
        actionLabel: 'Sync Transactions',
        actionTarget: 'settings',
      });
    }

    if (missingBudgetIncome) {
      score -= 25;
      pushIssue(issues, {
        id: 'missing-budget-income',
        severity: 'error',
        section: 'income',
        title: 'Budget income missing',
        message: 'Budget Income is zero for this period.',
        count: 0,
        actionLabel: 'Open Paycheck Planner',
        actionTarget: 'paycheck-planner',
      });
    }

    if (duplicateActiveAccounts > 0) {
      score -= 20;
      pushIssue(issues, {
        id: 'duplicate-active-accounts',
        severity: 'error',
        section: 'plaid',
        title: 'Duplicate active accounts',
        message: duplicateActiveAccounts + ' possible duplicate active account(s) were detected.',
        count: duplicateActiveAccounts,
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      });
    }

    if (unreviewedCount > 10) score -= 20;
    else if (unreviewedCount > 0) score -= 10;
    if (unreviewedCount > 0) {
      pushIssue(issues, {
        id: 'unreviewed-transactions',
        severity: 'warning',
        section: 'transactions',
        title: 'Unreviewed transactions',
        message: unreviewedCount + ' transaction(s) need review in this budget period.',
        count: unreviewedCount,
        actionLabel: 'Review Transactions',
        actionTarget: 'transactions',
      });
    }

    if (pendingCount > 0 && !pendingVisible) {
      score -= 5;
      pushIssue(issues, {
        id: 'pending-hidden',
        severity: 'info',
        section: 'transactions',
        title: 'Pending transactions hidden',
        message: pendingCount + ' pending transaction(s) are hidden.',
        count: pendingCount,
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      });
    }

    if (pendingInBudgetTotals) {
      score -= 5;
      pushIssue(issues, {
        id: 'pending-in-budget',
        severity: 'info',
        section: 'transactions',
        title: 'Pending included in budget totals',
        message: 'Pending transactions are included in budget totals.',
        count: pendingCount,
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      });
    }

    if (unmatchedRecurringBillsCount > 0) {
      score -= 10;
      pushIssue(issues, {
        id: 'unmatched-recurring-bills',
        severity: 'warning',
        section: 'recurringBills',
        title: 'Unpaid recurring bills',
        message: unmatchedRecurringBillsCount + ' recurring bill(s) remain unpaid in this period.',
        count: unmatchedRecurringBillsCount,
        actionLabel: 'Review Recurring Bills',
        actionTarget: 'recurring-bills',
      });
    }

    if (autopayNotFoundCount > 0) {
      score -= 10;
      pushIssue(issues, {
        id: 'autopay-not-found',
        severity: 'warning',
        section: 'recurringBills',
        title: 'Autopay bill not matched',
        message: autopayNotFoundCount + ' autopay bill(s) have no matching transaction.',
        count: autopayNotFoundCount,
        actionLabel: 'Review Recurring Bills',
        actionTarget: 'recurring-bills',
      });
    }

    if (transferRequiredRemaining > 0) {
      score -= 10;
      pushIssue(issues, {
        id: 'transfer-checklist-incomplete',
        severity: 'warning',
        section: 'transfers',
        title: 'Transfer checklist incomplete',
        message: 'Transfer checklist still has pending required amount: $' + transferRequiredRemaining.toFixed(2) + '.',
        count: 1,
        actionLabel: 'Open Transfers',
        actionTarget: 'transfers',
      });
    }

    if (Number(summary.expenses.overBudgetCount || 0) > 0) {
      score -= 5;
      pushIssue(issues, {
        id: 'expense-over-budget',
        severity: 'warning',
        section: 'expenses',
        title: 'Expense categories over budget',
        message: Number(summary.expenses.overBudgetCount || 0) + ' expense category(ies) are over budget.',
        count: Number(summary.expenses.overBudgetCount || 0),
        actionLabel: 'Open Expenses',
        actionTarget: 'expenses',
      });
    }

    const rulesLastAppliedAt = settingsMap.get('rules_last_applied_at') || null;
    if (enabledRules.length > 0 && !rulesLastAppliedAt) {
      score -= 5;
      pushIssue(issues, {
        id: 'rules-not-applied-recently',
        severity: 'info',
        section: 'rules',
        title: 'Rules not applied recently',
        message: 'Rules exist but no recent rule-apply timestamp was found.',
        count: enabledRules.length,
        actionLabel: 'Open Rules',
        actionTarget: 'settings',
      });
    }

    if (uncategorizedCount > 0) {
      pushIssue(issues, {
        id: 'uncategorized-transactions',
        severity: 'warning',
        section: 'transactions',
        title: 'Uncategorized transactions',
        message: uncategorizedCount + ' transaction(s) have no category.',
        count: uncategorizedCount,
        actionLabel: 'Review Transactions',
        actionTarget: 'transactions',
      });
    }

    if (duplicateTx.duplicateCount > 0) {
      pushIssue(issues, {
        id: 'duplicate-like-transactions',
        severity: 'warning',
        section: 'transactions',
        title: 'Possible duplicate transactions',
        message: duplicateTx.duplicateCount + ' possible duplicate transaction(s) detected.',
        count: duplicateTx.duplicateCount,
        actionLabel: 'Review Transactions',
        actionTarget: 'transactions',
      });
    }

    if (staleAccountsCount > 0) {
      pushIssue(issues, {
        id: 'stale-accounts',
        severity: 'warning',
        section: 'plaid',
        title: 'Removed Plaid item still has accounts',
        message: staleAccountsCount + ' stale account(s) are linked to removed Plaid items.',
        count: staleAccountsCount,
        actionLabel: 'Clean Removed Data',
        actionTarget: 'settings',
      });
    }

    if (syncOlderThanDay) {
      pushIssue(issues, {
        id: 'sync-stale',
        severity: 'warning',
        section: 'plaid',
        title: 'Last sync is stale',
        message: 'Last Plaid sync is older than 24 hours.',
        count: 1,
        actionLabel: 'Sync Transactions',
        actionTarget: 'settings',
      });
    }

    if (plaidLastSyncResult && String(plaidLastSyncResult.status || '').toLowerCase() === 'failed') {
      score -= 20;
      pushIssue(issues, {
        id: 'sync-last-failed',
        severity: 'error',
        section: 'plaid',
        title: 'Last Plaid sync failed',
        message: String(plaidLastSyncResult.error || 'Previous sync attempt failed.').slice(0, 180),
        count: 1,
        actionLabel: 'Sync Transactions',
        actionTarget: 'settings',
      });
    }

    if ((summary.income.ciscoPayrollTransactionsFound || 0) > 1) {
      pushIssue(issues, {
        id: 'multiple-payroll-found',
        severity: 'info',
        section: 'income',
        title: 'Multiple Cisco payroll deposits found',
        message: summary.income.payrollWarning || 'Latest payroll was selected for Budget Income.',
        count: Number(summary.income.ciscoPayrollTransactionsFound || 0),
        actionLabel: 'Open Paycheck Planner',
        actionTarget: 'paycheck-planner',
      });
    }

    if (summary.income.source === 'Manual override') {
      pushIssue(issues, {
        id: 'manual-income-override',
        severity: 'info',
        section: 'income',
        title: 'Manual income override active',
        message: 'Manual override is currently used for Regular Paycheck.',
        count: 1,
        actionLabel: 'Open Paycheck Planner',
        actionTarget: 'paycheck-planner',
      });
    }

    if (missingMatchWordsCount > 0) {
      pushIssue(issues, {
        id: 'bills-missing-match-words',
        severity: 'warning',
        section: 'recurringBills',
        title: 'Bills missing match words',
        message: missingMatchWordsCount + ' recurring bill(s) have no match words.',
        count: missingMatchWordsCount,
        actionLabel: 'Open Master Lists',
        actionTarget: 'master-lists',
      });
    }

    if (missingAmountCount > 0) {
      pushIssue(issues, {
        id: 'bills-missing-amount',
        severity: 'warning',
        section: 'recurringBills',
        title: 'Bills missing amount',
        message: missingAmountCount + ' recurring bill(s) have missing or zero amount.',
        count: missingAmountCount,
        actionLabel: 'Open Master Lists',
        actionTarget: 'master-lists',
      });
    }

    if (missingDueDayCount > 0) {
      pushIssue(issues, {
        id: 'bills-missing-due-day',
        severity: 'warning',
        section: 'recurringBills',
        title: 'Bills missing due day',
        message: missingDueDayCount + ' recurring bill(s) have missing due day.',
        count: missingDueDayCount,
        actionLabel: 'Open Master Lists',
        actionTarget: 'master-lists',
      });
    }

    if (enabledRules.length === 0) {
      pushIssue(issues, {
        id: 'no-rules',
        severity: 'info',
        section: 'rules',
        title: 'No rules exist',
        message: 'No enabled transaction rules were found.',
        count: 0,
        actionLabel: 'Open Rules',
        actionTarget: 'settings',
      });
    } else if (unreviewedCount > 0 && rulesPreview.length === 0) {
      pushIssue(issues, {
        id: 'rules-not-classifying',
        severity: 'warning',
        section: 'rules',
        title: 'Rules may be missing coverage',
        message: 'Unreviewed transactions remain and enabled rules did not match any in dry-run.',
        count: unreviewedCount,
        actionLabel: 'Open Rules',
        actionTarget: 'settings',
      });
    }

    const importLog = db.prepare('SELECT imported_at FROM backup_import_logs ORDER BY imported_at DESC LIMIT 1').get() || null;
    if (!importLog) {
      pushIssue(issues, {
        id: 'no-backup-recorded',
        severity: 'info',
        section: 'backups',
        title: 'No backup recorded',
        message: 'No backup import record found. Export a backup for safety.',
        count: 0,
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      });
    }

    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const existingTables = new Set(tableRows.map((row) => row.name));
    const missingTables = REQUIRED_TABLES.filter((tableName) => !existingTables.has(tableName));
    if (missingTables.length > 0) {
      score -= 50;
      pushIssue(issues, {
        id: 'missing-required-table',
        severity: 'error',
        section: 'database',
        title: 'Missing expected table',
        message: 'Missing tables: ' + missingTables.join(', '),
        count: missingTables.length,
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      });
    }

    score = Math.max(0, Math.min(100, score));

    let status = 'good';
    if (score < 40) status = 'error';
    else if (score < 70) status = 'warning';
    else if (score < 90) status = 'needs_review';

    const sections = {
      plaid: {
        status: toSectionStatus(issues, 'plaid'),
        activeItems: activeItems.length,
        connectedInstitutions: activeItems.length,
        activeAccounts: activeAccounts.length,
        removedItemsCount,
        staleAccountsCount,
        duplicateActiveAccounts,
        lastSyncedAt: latestSyncTs ? new Date(latestSyncTs).toISOString() : null,
        lastSyncStatus: plaidLastSyncResult?.status || null,
        lastSyncError: plaidLastSyncResult?.error || null,
      },
      transactions: {
        status: toSectionStatus(issues, 'transactions'),
        total: allTransactions.length,
        reviewed: reviewedCount,
        unreviewed: unreviewedCount,
        ignored: ignoredCount,
        pending: pendingCount,
        uncategorized: uncategorizedCount,
        duplicateLooking: duplicateTx.duplicateCount,
        duplicateSamples: duplicateTx.samples,
        pendingVisible,
        pendingInBudgetTotals,
        pendingInBillMatching,
        pendingInTransferMatching,
      },
      income: {
        status: toSectionStatus(issues, 'income'),
        detectedCiscoPayroll: !!summary.income.selectedPayrollTransaction,
        ciscoPayrollTransactionsFound: Number(summary.income.ciscoPayrollTransactionsFound || 0),
        latestPayrollSelected: summary.income.selectedPayrollTransaction || null,
        manualOverrideActive: summary.income.source === 'Manual override',
        budgetIncome: Number(summary.income.budgetIncome || 0),
        regularPaycheck: Number(summary.income.regularPaycheck || 0),
        bonusIncome: Number(summary.income.bonusIncome || 0),
        otherIncome: Number(summary.income.otherIncome || 0),
        excludedOutsidePeriod: Number(summary.income.excludedIncomeOutsidePeriodCount || 0),
      },
      recurringBills: {
        status: toSectionStatus(issues, 'recurringBills'),
        dueCount: Number(summary.recurringBills.dueCount || 0),
        paidCount: Number(summary.recurringBills.paidCount || 0),
        unpaidCount: Number(summary.recurringBills.unpaidCount || 0),
        autoPaidCount: recurringBillStatuses.filter((row) => !!row.auto_paid && !!row.paid).length,
        manualPaidCount: recurringBillStatuses.filter((row) => !!row.manual_paid && !!row.paid).length,
        possibleMatches: possibleMatchesCount,
        autopayMissing: autopayNotFoundCount,
        missingMatchWords: missingMatchWordsCount,
        missingDueDay: missingDueDayCount,
        missingAmount: missingAmountCount,
      },
      transfers: {
        status: toSectionStatus(issues, 'transfers'),
        transferChecklistGenerated,
        pendingCount: transferRequiredRemaining > 0 ? 1 : 0,
        partialCount: transferRequiredRemaining > 0 ? 1 : 0,
        overpaidCount: Number(summary.transfers.discover || 0) < 0 ? 1 : 0,
        missingAmount: transferRequiredRemaining,
        safeToTransfer: Number(summary.safeMoney?.safeToTransfer?.amount || 0),
      },
      expenses: {
        status: toSectionStatus(issues, 'expenses'),
        expenseBudgetTotal: Number(summary.expenses.budgetTotal || 0),
        actualExpenseSpending: Number(summary.expenses.actualTotal || 0),
        remaining: Number(summary.expenses.remaining || 0),
        overBudgetCategoryCount: Number(summary.expenses.overBudgetCount || 0),
        categoriesWithNoBudget: (summary.expenses.categoryRows || []).filter((row) => Number(row.budget || 0) <= 0).length,
        uncategorizedExpenseTransactions: uncategorizedCount,
      },
      rollover: {
        status: toSectionStatus(issues, 'rollover'),
        available: !summary.rollover?.warning && summary.rollover?.source !== 'unavailable',
        source: summary.rollover?.source || 'unavailable',
        lastPrePaycheckTransaction: summary.rollover?.lastTransaction || null,
        warning: summary.rollover?.warning || null,
      },
      rules: {
        status: toSectionStatus(issues, 'rules'),
        enabledRules: enabledRules.length,
        disabledRules: disabledRulesCount,
        lastAppliedAt: rulesLastAppliedAt,
        dryRunMatchesOnUnreviewed: rulesPreview.length,
      },
      backups: {
        status: toSectionStatus(issues, 'backups'),
        lastImportAt: importLog?.imported_at || null,
        backupRoutesAvailable: true,
      },
      database: {
        status: toSectionStatus(issues, 'database'),
        dbReachable: true,
        missingTables,
        rowCounts: {
          plaid_items: db.prepare('SELECT COUNT(*) AS count FROM plaid_items').get()?.count || 0,
          accounts: db.prepare('SELECT COUNT(*) AS count FROM accounts').get()?.count || 0,
          transactions: db.prepare('SELECT COUNT(*) AS count FROM transactions').get()?.count || 0,
          settings: db.prepare('SELECT COUNT(*) AS count FROM settings').get()?.count || 0,
          expense_list_items: db.prepare('SELECT COUNT(*) AS count FROM expense_list_items').get()?.count || 0,
          recurring_bills_list_items: db.prepare('SELECT COUNT(*) AS count FROM recurring_bills_list_items').get()?.count || 0,
          recurring_bill_status: db.prepare('SELECT COUNT(*) AS count FROM recurring_bill_status').get()?.count || 0,
          transaction_rules: db.prepare('SELECT COUNT(*) AS count FROM transaction_rules').get()?.count || 0,
          pay_period_snapshots: db.prepare('SELECT COUNT(*) AS count FROM pay_period_snapshots').get()?.count || 0,
          pay_period_closeouts: db.prepare('SELECT COUNT(*) AS count FROM pay_period_closeouts').get()?.count || 0,
        },
      },
    };

    const actions = buildActionsFromIssues(issues);

    res.json({
      status,
      score,
      generatedAt,
      periodId: period.id,
      sections,
      issues,
      actions,
    });
  } catch (err) {
    console.error('GET /api/data-health error:', err);
    return res.status(500).json({
      status: 'error',
      score: 0,
      generatedAt,
      periodId,
      sections: {
        database: {
          status: 'error',
          dbReachable: false,
          error: 'Data health check failed.',
        },
      },
      issues: [
        {
          id: 'database-error',
          severity: 'error',
          section: 'database',
          title: 'Backend/database error',
          message: 'Data health check failed.',
          count: 1,
          actionLabel: 'Open Settings',
          actionTarget: 'settings',
        },
      ],
      actions: [
        {
          id: 'database-error',
          label: 'Open Settings',
          target: 'settings',
          severity: 'error',
          title: 'Backend/database error',
          message: 'Data health check failed.',
          count: 1,
        },
      ],
    });
  }
});

export default router;
