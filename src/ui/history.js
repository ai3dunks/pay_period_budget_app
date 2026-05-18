import { isDateInBudgetPeriod } from '../utils/budgetPeriods.js';
import {
  formatCurrencyValue,
} from '../utils/budgetCalculations.js';
import { buildPayPeriodSummary } from '../utils/payPeriodSummary.js';
import { loadCommandCenterSettings, isFeatureEnabled } from '../utils/commandCenter.js';
import { getTransactionRowsForPeriod } from '../api/transactionsApi.js';

const BACKEND = '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmt(value) {
  return formatCurrencyValue(value);
}

function fmtDate(isoString) {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch (_e) {
    return isoString;
  }
}

function fmtDateTime(isoString) {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch (_e) {
    return isoString;
  }
}

function parseSettingMap(value) {
  if (!value || typeof value !== 'object') return {};
  return value;
}

async function fetchJson(path) {
  const res = await fetch(BACKEND + path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchSetting(key) {
  try {
    const data = await fetchJson('/api/settings/' + encodeURIComponent(key));
    return parseSettingMap(data.value);
  } catch (_e) {
    return {};
  }
}

// ─── Snapshot value calculation ───────────────────────────────────────────────

async function buildSnapshotSummary(period) {
  const [
    masterLists,
    transactions,
    billStatusRows,
    manualIncomeMap,
    autoIncomeMap,
    splitSettings,
    transferTargets,
    plaidStatus,
  ] = await Promise.all([
    fetchJson('/api/master-lists'),
    getTransactionRowsForPeriod(period),
    fetchJson('/api/recurring-bills/status?periodId=' + encodeURIComponent(period.id)).catch(() => []),
    fetchSetting('budget_income_by_period'),
    fetchSetting('auto_detected_income_by_period'),
    fetchSetting('budget_split_settings'),
    fetchSetting('transfer_targets'),
    fetchJson('/api/plaid/status').catch(() => ({ accounts: [] })),
  ]);

  const expenseList = (masterLists.expenseList || []).map((item) => ({
    ...item,
    budgetAmount: Number(item.budgetAmount || 0),
    active: !!item.active,
  }));
  const recurringBillsList = masterLists.recurringBillsList || [];
  const summary = buildPayPeriodSummary({
    period,
    accounts: Array.isArray(plaidStatus.accounts) ? plaidStatus.accounts : [],
    transactions: Array.isArray(transactions) ? transactions : [],
    expenseList,
    recurringBillsList,
    recurringBillStatuses: billStatusRows,
    settings: {
      budget_income_by_period: manualIncomeMap,
      auto_detected_income_by_period: autoIncomeMap,
      manualIncomeByPeriod: manualIncomeMap,
      autoDetectedIncomeByPeriod: autoIncomeMap,
      splitSettings,
      transferTargets,
    },
  });

  const periodTransactions = (transactions || []).filter((row) => {
    if (!row || row.ignored) return false;
    return isDateInBudgetPeriod(row.date, period);
  });

  const paidBills = summary.recurringBills.paidRows;
  const unpaidBills = summary.recurringBills.unpaidRows;

  const expenseTransactions = (transactions || []).filter((row) => {
    if (!row || row.ignored) return false;
    if (String(row.type || '').trim() !== 'Expense') return false;
    return isDateInBudgetPeriod(row.date, period);
  });
  const actualExpenseSpending = Number(summary.expenses.actualTotal || 0);
  const expenseRemaining = Number(summary.expenses.remaining || 0);

  // ── Category breakdown ──────────────────────────────────────
  const expenseCategorySummary = summary.expenses.categoryRows;
  const categoriesOverBudget = expenseCategorySummary.filter((c) => c.overBudget).map((c) => c.name);
  const cashRemaining = Number(summary.safeToSpend || 0);

  // ── Transaction review counts ───────────────────────────────
  const periodTxns = (transactions || []).filter((row) => {
    return row && isDateInBudgetPeriod(row.date, period);
  });
  const totalTransactions = periodTxns.length;
  const ignoredTransactions = periodTxns.filter((r) => r.ignored).length;
  const reviewedTransactions = periodTxns.filter((r) => !r.ignored && r.reviewed).length;
  const unreviewedTransactions = periodTxns.filter((r) => !r.ignored && !r.reviewed).length;

  // ── Alerts ──────────────────────────────────────────────────
  const alerts = [];
  if (unreviewedTransactions > 0) alerts.push(`${unreviewedTransactions} unreviewed transaction(s) in this period.`);
  if (categoriesOverBudget.length > 0) alerts.push(`Over budget in: ${categoriesOverBudget.join(', ')}.`);
  if (cashRemaining < 0) alerts.push(`Cash remaining is negative (${fmt(cashRemaining)}).`);
  if (summary.alerts.some((line) => String(line).toLowerCase().includes('shortfall'))) {
    alerts.push(`Discover shortfall: ${fmt(summary.transfers.discover)}.`);
  }

  const snapshotJson = {
    createdAt: new Date().toISOString(),
    period: {
      id: period.id,
      label: period.label,
      startDate: period.startDate,
      displayEndDate: period.displayEndDate,
      exclusiveEndDate: period.exclusiveEndDate,
    },
    income: {
      budgetIncome: summary.income.budgetIncome,
      regularPaycheck: summary.income.regularPaycheck,
      bonusIncome: summary.income.bonusIncome,
      otherIncome: summary.income.otherIncome,
      manualOverrideActive: summary.income.source === 'Manual override',
      source: summary.income.source,
    },
    recurringBills: {
      countDue: summary.recurringBills.dueCount,
      countPaid: paidBills.length,
      countUnpaid: unpaidBills.length,
      totalDue: summary.recurringBills.dueTotal,
      totalPaid: summary.recurringBills.paidTotal,
      leftToPay: summary.recurringBills.unpaidTotal,
    },
    paidBills: paidBills.map((b) => ({ name: b.name, amount: b.amount, category: b.category })),
    unpaidBills: unpaidBills.map((b) => ({ name: b.name, amount: b.amount, category: b.category })),
    expenses: {
      budget: summary.expenses.budgetTotal,
      actual: actualExpenseSpending,
      remaining: expenseRemaining,
      categoriesOverBudget,
    },
    expenseCategorySummary,
    expenseTransactions: expenseTransactions.map((r) => ({
      date: r.date, name: r.name || r.merchant_name, category: r.category, amount: r.amount,
    })),
    transferPlan: {
      josh: summary.transfers.josh,
      taylor: summary.transfers.taylor,
      discover: summary.transfers.discover,
      debtSavings: summary.transfers.debtSavings,
      total: summary.transfers.total,
    },
    transactionReview: {
      total: totalTransactions,
      reviewed: reviewedTransactions,
      unreviewed: unreviewedTransactions,
      ignored: ignoredTransactions,
    },
    alerts,
  };

  return {
    // Flat fields for DB columns
    budgetIncome: summary.income.budgetIncome,
    regularPaycheck: summary.income.regularPaycheck,
    bonusIncome: summary.income.bonusIncome,
    otherIncome: summary.income.otherIncome,
    recurringBillsDue: summary.recurringBills.dueTotal,
    recurringBillsPaid: summary.recurringBills.paidTotal,
    recurringBillsLeftToPay: summary.recurringBills.unpaidTotal,
    expenseBudget: summary.expenses.budgetTotal,
    actualExpenseSpending,
    expenseRemaining,
    cashRemaining,
    plannedTransfersTotal: summary.transfers.total,
    joshTransfer: summary.transfers.josh,
    taylorTransfer: summary.transfers.taylor,
    discoverTransfer: summary.transfers.discover,
    debtSavingsTransfer: summary.transfers.debtSavings,
    totalTransactions,
    reviewedTransactions,
    unreviewedTransactions,
    ignoredTransactions,
    snapshotJson,
  };
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderSummaryCards(snapshots) {
  const count = snapshots.length;
  if (!count) {
    return '<section class="history-summary-grid"><article class="card stat-card"><p class="card-description">Snapshots Saved</p><h3 class="card-title">0</h3></article></section>';
  }

  const latestSnap = snapshots[0];
  const cashValues = snapshots.map((s) => Number(s.cash_remaining || 0));
  const bestCash = Math.max(...cashValues);
  const worstCash = Math.min(...cashValues);
  const avgExpense = snapshots.reduce((sum, s) => sum + Number(s.actual_expense_spending || 0), 0) / count;

  return (
    '<section class="history-summary-grid">' +
    '<article class="card stat-card"><p class="card-description">Snapshots Saved</p><h3 class="card-title">' + count + '</h3></article>' +
    '<article class="card stat-card"><p class="card-description">Latest Snapshot</p><h3 class="card-title">' + escapeHtml(latestSnap.period_label) + '</h3><p class="card-description">' + escapeHtml(fmtDateTime(latestSnap.created_at)) + '</p></article>' +
    '<article class="card stat-card"><p class="card-description">Best Cash Remaining</p><h3 class="card-title">' + escapeHtml(fmt(bestCash)) + '</h3></article>' +
    '<article class="card stat-card"><p class="card-description">Worst Cash Remaining</p><h3 class="card-title">' + escapeHtml(fmt(worstCash)) + '</h3></article>' +
    '<article class="card stat-card"><p class="card-description">Avg Expense Spending</p><h3 class="card-title">' + escapeHtml(fmt(avgExpense)) + '</h3></article>' +
    '</section>'
  );
}

function renderSnapshotTable(snapshots, selectedId) {
  if (!snapshots.length) {
    return (
      '<section class="card history-empty-state">' +
      '<p class="empty-state">No pay period snapshots saved yet. Save the current period to start history tracking.</p>' +
      '</section>'
    );
  }

  const rows = snapshots.map((s) => {
    const isSelected = s.id === selectedId;
    return (
      '<tr class="snapshot-row' + (isSelected ? ' snapshot-row-selected' : '') + '" data-snapshot-id="' + escapeHtml(s.id) + '">' +
        '<td>' + escapeHtml(s.period_label) + (s.isLatestForPeriod ? ' <span class="badge-latest">Latest</span>' : '') + (s.closeout_status ? ' <span class="closeout-status-badge ' + escapeHtml(String(s.closeout_status).toLowerCase()) + '">' + escapeHtml(String(s.closeout_status).replaceAll('_', ' ')) + '</span>' : '') + '</td>' +
      '<td>' + escapeHtml(fmtDateTime(s.created_at)) + '</td>' +
      '<td>' + escapeHtml(fmt(s.budget_income)) + '</td>' +
      '<td>' + escapeHtml(fmt(s.recurring_bills_due)) + '</td>' +
      '<td>' + escapeHtml(fmt(s.expense_budget)) + '</td>' +
      '<td>' + escapeHtml(fmt(s.actual_expense_spending)) + '</td>' +
      '<td>' + escapeHtml(fmt(s.cash_remaining)) + '</td>' +
      '<td>' + escapeHtml(fmt(s.planned_transfers_total)) + '</td>' +
      '<td class="inline-actions">' +
      '<button class="button button-secondary button-sm" data-action="history-view" data-id="' + escapeHtml(s.id) + '">' + (isSelected ? 'Close' : 'View') + '</button>' +
      '<button class="button button-danger button-sm" data-action="history-delete" data-id="' + escapeHtml(s.id) + '">Delete</button>' +
      '</td>' +
      '</tr>'
    );
  }).join('');

  return (
    '<section class="card snapshot-table-card">' +
    '<div class="card-header"><h3 class="card-title">Saved Snapshots</h3></div>' +
    '<div class="table-wrap"><table class="table snapshot-table">' +
    '<thead><tr>' +
    '<th>Period</th><th>Created</th><th>Budget Income</th><th>Bills Due</th>' +
    '<th>Expense Budget</th><th>Actual Expenses</th><th>Cash Remaining</th>' +
    '<th>Transfers</th><th>Actions</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div>' +
    '</section>'
  );
}

function renderSnapshotDetail(snapshot) {
  if (!snapshot) return '';

  let detail = null;
  try {
    detail = typeof snapshot.snapshot_json === 'object' && snapshot.snapshot_json !== null
      ? snapshot.snapshot_json
      : JSON.parse(snapshot.snapshot_json || '{}');
  } catch (_e) {
    detail = {};
  }

  const alerts = detail.alerts || [];
  const alertsHtml = alerts.length
    ? '<ul>' + alerts.map((a) => '<li>' + escapeHtml(a) + '</li>').join('') + '</ul>'
    : '<p class="muted-note">No alerts.</p>';

  const paidBills = detail.paidBills || [];
  const unpaidBills = detail.unpaidBills || [];
  const categorySummary = detail.expenseCategorySummary || [];
  const overBudgetCategories = categorySummary.filter((c) => c.overBudget);

  const incomeSource = detail.income?.manualOverrideActive ? 'Manual override' : 'Auto-detected';

  const html =
    '<section class="card snapshot-detail" id="snapshot-detail">' +
    '<div class="card-header">' +
    '<h3 class="card-title">Snapshot: ' + escapeHtml(snapshot.period_label) + '</h3>' +
    '<p class="card-description">Saved ' + escapeHtml(fmtDateTime(snapshot.created_at)) + '</p>' +
    '</div>' +

    // Income
    '<div class="snapshot-section">' +
    '<h4>Income</h4>' +
    '<div class="snapshot-grid">' +
    '<div><span>Budget Income</span><strong>' + escapeHtml(fmt(snapshot.budget_income)) + '</strong></div>' +
    '<div><span>Regular Paycheck</span><strong>' + escapeHtml(fmt(snapshot.regular_paycheck)) + '</strong></div>' +
    '<div><span>Bonus Income</span><strong>' + escapeHtml(fmt(snapshot.bonus_income)) + '</strong></div>' +
    '<div><span>Other Income</span><strong>' + escapeHtml(fmt(snapshot.other_income)) + '</strong></div>' +
    '<div><span>Source</span><strong>' + escapeHtml(incomeSource) + '</strong></div>' +
    '</div>' +
    '</div>' +

    // Recurring Bills
    '<div class="snapshot-section">' +
    '<h4>Recurring Bills</h4>' +
    '<div class="snapshot-grid">' +
    '<div><span>Bills Due Total</span><strong>' + escapeHtml(fmt(snapshot.recurring_bills_due)) + '</strong></div>' +
    '<div><span>Paid</span><strong>' + escapeHtml(fmt(snapshot.recurring_bills_paid)) + '</strong></div>' +
    '<div><span>Left To Pay</span><strong>' + escapeHtml(fmt(snapshot.recurring_bills_left_to_pay)) + '</strong></div>' +
    '<div><span>Bills Counted</span><strong>' + escapeHtml(String(detail.recurringBills?.countDue ?? '—')) + '</strong></div>' +
    '<div><span>Paid Count</span><strong>' + escapeHtml(String(detail.recurringBills?.countPaid ?? '—')) + '</strong></div>' +
    '<div><span>Unpaid Count</span><strong>' + escapeHtml(String(detail.recurringBills?.countUnpaid ?? '—')) + '</strong></div>' +
    '</div>' +
    (paidBills.length
      ? '<details class="snapshot-collapse"><summary>' + paidBills.length + ' paid bill(s)</summary><ul>' +
        paidBills.map((b) => '<li>' + escapeHtml(b.name) + ' — ' + escapeHtml(fmt(b.amount)) + '</li>').join('') +
        '</ul></details>'
      : '') +
    (unpaidBills.length
      ? '<details class="snapshot-collapse"><summary>' + unpaidBills.length + ' unpaid bill(s)</summary><ul>' +
        unpaidBills.map((b) => '<li>' + escapeHtml(b.name) + ' — ' + escapeHtml(fmt(b.amount)) + '</li>').join('') +
        '</ul></details>'
      : '') +
    '</div>' +

    // Expenses
    '<div class="snapshot-section">' +
    '<h4>Expenses</h4>' +
    '<div class="snapshot-grid">' +
    '<div><span>Expense Budget</span><strong>' + escapeHtml(fmt(snapshot.expense_budget)) + '</strong></div>' +
    '<div><span>Actual Spending</span><strong>' + escapeHtml(fmt(snapshot.actual_expense_spending)) + '</strong></div>' +
    '<div><span>Remaining</span><strong>' + escapeHtml(fmt(snapshot.expense_remaining)) + '</strong></div>' +
    '<div><span>Cash Remaining</span><strong>' + escapeHtml(fmt(snapshot.cash_remaining)) + '</strong></div>' +
    '</div>' +
    (overBudgetCategories.length
      ? '<p class="snapshot-alert">Over budget: ' + escapeHtml(overBudgetCategories.map((c) => c.name).join(', ')) + '</p>'
      : '') +
    '</div>' +

    // Transfers
    '<div class="snapshot-section">' +
    '<h4>Transfers</h4>' +
    '<div class="snapshot-grid">' +
    '<div><span>Josh</span><strong>' + escapeHtml(fmt(snapshot.josh_transfer)) + '</strong></div>' +
    '<div><span>Taylor</span><strong>' + escapeHtml(fmt(snapshot.taylor_transfer)) + '</strong></div>' +
    '<div><span>Discover</span><strong>' + escapeHtml(fmt(snapshot.discover_transfer)) + '</strong></div>' +
    '<div><span>Debt/Savings</span><strong>' + escapeHtml(fmt(snapshot.debt_savings_transfer)) + '</strong></div>' +
    '<div><span>Total Planned</span><strong>' + escapeHtml(fmt(snapshot.planned_transfers_total)) + '</strong></div>' +
    '</div>' +
    '</div>' +

    // Transaction Review
    '<div class="snapshot-section">' +
    '<h4>Transaction Review</h4>' +
    '<div class="snapshot-grid">' +
    '<div><span>Total</span><strong>' + escapeHtml(String(snapshot.total_transactions)) + '</strong></div>' +
    '<div><span>Reviewed</span><strong>' + escapeHtml(String(snapshot.reviewed_transactions)) + '</strong></div>' +
    '<div><span>Unreviewed</span><strong>' + escapeHtml(String(snapshot.unreviewed_transactions)) + '</strong></div>' +
    '<div><span>Ignored</span><strong>' + escapeHtml(String(snapshot.ignored_transactions)) + '</strong></div>' +
    '</div>' +
    '</div>' +

    // Alerts
    '<div class="snapshot-section">' +
    '<h4>Alerts</h4>' +
    alertsHtml +
    '</div>' +

    // Notes
    '<div class="snapshot-section snapshot-note">' +
    '<h4>Notes</h4>' +
    '<textarea id="snapshot-notes-input" class="snapshot-notes-textarea" rows="3" placeholder="Add notes about this period...">' + escapeHtml(snapshot.notes || '') + '</textarea>' +
    '<div class="inline-actions" style="margin-top:8px;">' +
    '<button class="button button-secondary button-sm" data-action="history-save-notes" data-id="' + escapeHtml(snapshot.id) + '">Save Notes</button>' +
    '</div>' +
    '<p id="snapshot-notes-message" class="muted-note" style="min-height:16px;margin-top:4px;"></p>' +
    '</div>' +

    '</section>';

  return html;
}

function renderCompareSection(snapshots, compareA, compareB) {
  const options = snapshots.map((s) =>
    '<option value="' + escapeHtml(s.id) + '"' + (s.id === compareA ? ' selected' : '') + '>' +
    escapeHtml(s.period_label) + ' — ' + escapeHtml(fmtDateTime(s.created_at)) +
    '</option>'
  ).join('');

  const optionsB = snapshots.map((s) =>
    '<option value="' + escapeHtml(s.id) + '"' + (s.id === compareB ? ' selected' : '') + '>' +
    escapeHtml(s.period_label) + ' — ' + escapeHtml(fmtDateTime(s.created_at)) +
    '</option>'
  ).join('');

  let comparisonHtml = '';
  if (compareA && compareB && compareA !== compareB) {
    const snapA = snapshots.find((s) => s.id === compareA);
    const snapB = snapshots.find((s) => s.id === compareB);
    if (snapA && snapB) {
      const diff = (field) => Number(snapB[field] || 0) - Number(snapA[field] || 0);
      const sign = (n) => (n > 0 ? '+' : '') + fmt(n);

      const rows = [
        { label: 'Budget Income', fieldA: snapA.budget_income, fieldB: snapB.budget_income, d: diff('budget_income') },
        { label: 'Bills Due', fieldA: snapA.recurring_bills_due, fieldB: snapB.recurring_bills_due, d: diff('recurring_bills_due') },
        { label: 'Expense Budget', fieldA: snapA.expense_budget, fieldB: snapB.expense_budget, d: diff('expense_budget') },
        { label: 'Actual Expenses', fieldA: snapA.actual_expense_spending, fieldB: snapB.actual_expense_spending, d: diff('actual_expense_spending') },
        { label: 'Cash Remaining', fieldA: snapA.cash_remaining, fieldB: snapB.cash_remaining, d: diff('cash_remaining') },
        { label: 'Total Transfers', fieldA: snapA.planned_transfers_total, fieldB: snapB.planned_transfers_total, d: diff('planned_transfers_total') },
      ];

      const maxCashA = Math.max(...[snapA, snapB].map((s) => Math.abs(Number(s.cash_remaining || 0)))) || 1;
      const maxExpA = Math.max(...[snapA, snapB].map((s) => Math.abs(Number(s.actual_expense_spending || 0)))) || 1;

      const compareRows = rows.map((r) => {
        const dirClass = r.d > 0 ? 'compare-positive' : r.d < 0 ? 'compare-negative' : '';
        return (
          '<tr>' +
          '<td>' + escapeHtml(r.label) + '</td>' +
          '<td>' + escapeHtml(fmt(r.fieldA)) + '</td>' +
          '<td>' + escapeHtml(fmt(r.fieldB)) + '</td>' +
          '<td class="' + dirClass + '">' + escapeHtml(sign(r.d)) + '</td>' +
          '</tr>'
        );
      }).join('');

      // Mini bar chart: cash remaining + actual expenses
      const barHtml =
        '<div class="mini-bar-chart">' +
        '<h5>Cash Remaining</h5>' +
        renderBar(snapA.period_label, Number(snapA.cash_remaining || 0), maxCashA) +
        renderBar(snapB.period_label, Number(snapB.cash_remaining || 0), maxCashA) +
        '<h5 style="margin-top:12px;">Actual Expense Spending</h5>' +
        renderBar(snapA.period_label, Number(snapA.actual_expense_spending || 0), maxExpA) +
        renderBar(snapB.period_label, Number(snapB.actual_expense_spending || 0), maxExpA) +
        '</div>';

      comparisonHtml =
        '<div class="compare-grid">' +
        '<div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Metric</th><th>' + escapeHtml(snapA.period_label) + '</th><th>' + escapeHtml(snapB.period_label) + '</th><th>Difference (B − A)</th></tr></thead>' +
        '<tbody>' + compareRows + '</tbody>' +
        '</table></div>' +
        barHtml +
        '</div>';
    }
  }

  return (
    '<section class="card">' +
    '<div class="card-header"><h3 class="card-title">Compare Snapshots</h3></div>' +
    '<div class="form-grid compare-selectors">' +
    '<label class="form-field"><span>Snapshot A</span><select id="compare-a">' +
    '<option value="">— Select —</option>' + options + '</select></label>' +
    '<label class="form-field"><span>Snapshot B</span><select id="compare-b">' +
    '<option value="">— Select —</option>' + optionsB + '</select></label>' +
    '</div>' +
    comparisonHtml +
    '</section>'
  );
}

function renderBar(label, value, max) {
  const pct = max > 0 ? Math.min(Math.abs(value) / max, 1) * 100 : 0;
  const isNeg = value < 0;
  return (
    '<div class="mini-bar-row">' +
    '<span class="mini-bar-label">' + escapeHtml(label) + '</span>' +
    '<div class="mini-bar-track">' +
    '<div class="mini-bar-fill' + (isNeg ? ' mini-bar-negative' : '') + '" style="width:' + pct.toFixed(1) + '%"></div>' +
    '</div>' +
    '<span class="mini-bar-value">' + escapeHtml(fmt(value)) + '</span>' +
    '</div>'
  );
}

// ─── Main render ──────────────────────────────────────────────────────────────

let _historyState = {
  snapshots: [],
  selectedId: null,
  compareA: null,
  compareB: null,
  saving: false,
  message: '',
  messageError: false,
};

export async function renderHistory(container, period, periodLabel, options = {}) {
  container.innerHTML = '';

  const pageWrap = document.createElement('div');
  pageWrap.className = 'history-page';
  container.appendChild(pageWrap);

  // Page header
  const header = document.createElement('header');
  header.className = 'page-header';
  header.innerHTML =
    '<div class="page-header-main">' +
    '<h2 class="page-title">History</h2>' +
    '<p class="page-description">Review saved pay period snapshots.</p>' +
    '</div>' +
    '<div class="page-header-right"><span class="status-badge">' + escapeHtml(periodLabel) + '</span> <button class="button button-secondary button-sm" data-action="history-view-trends">View Trends</button></div>';
  pageWrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'page-body';
  body.innerHTML = '<section class="card"><p class="empty-state">Loading history...</p></section>';
  pageWrap.appendChild(body);

  // Load snapshots
  let snapshots = [];
  let histCcSettings = null;
  try {
    [snapshots, histCcSettings] = await Promise.all([
      fetchJson('/api/history'),
      loadCommandCenterSettings().catch(() => null),
    ]);
    _historyState.snapshots = snapshots;
  } catch (err) {
    body.innerHTML =
      '<section class="card"><div class="error-card">Backend not reachable through the local API proxy.<br><small>' +
      escapeHtml(String(err.message || '')) + '</small></div></section>';
    return;
  }

  function reRender() {
    body.innerHTML = buildBodyHtml();
    attachEvents();
  }

  function buildBodyHtml() {
    const { snapshots, selectedId, compareA, compareB, saving, message, messageError } = _historyState;
    const selected = selectedId ? snapshots.find((s) => s.id === selectedId) : null;

    const saveCard =
      '<section class="card">' +
      '<div class="card-header">' +
      '<h3 class="card-title">Save Current Period Snapshot</h3>' +
      '<p class="card-description">Capture a snapshot of <strong>' + escapeHtml(periodLabel) + '</strong> at this moment.</p>' +
      '</div>' +
      (message ? '<p class="settings-message ' + (messageError ? 'error' : 'success') + '">' + escapeHtml(message) + '</p>' : '') +
      '<div class="inline-actions">' +
      '<button class="button button-primary" data-action="history-save-snapshot" ' + (saving ? 'disabled' : '') + '>' +
      (saving ? 'Saving...' : 'Save Current Period Snapshot') + '</button>' +
      '</div>' +
      '</section>';

    const summaryCards = renderSummaryCards(snapshots);
    const table = isFeatureEnabled(histCcSettings, 'history', 'showPayPeriodHistory') ? renderSnapshotTable(snapshots, selectedId) : '';
    const detail = selected ? renderSnapshotDetail(selected) : '';
    const compare = (snapshots.length >= 2 && isFeatureEnabled(histCcSettings, 'history', 'showSnapshotComparison')) ? renderCompareSection(snapshots, compareA, compareB) : '';

    return summaryCards + saveCard + table + detail + compare;
  }

  function attachEvents() {
    const bodyEl = body;

    pageWrap.querySelector('[data-action="history-view-trends"]')?.addEventListener('click', () => {
      if (typeof options.onOpenTab === 'function') {
        options.onOpenTab('reports');
      }
    });

    // Save snapshot
    const saveBtn = bodyEl.querySelector('[data-action="history-save-snapshot"]');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        _historyState.saving = true;
        _historyState.message = '';
        reRender();
        try {
          const summary = await buildSnapshotSummary(period);
          const res = await fetch(BACKEND + '/api/history/snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              periodId: period.id,
              periodLabel: period.label,
              startDate: period.startDate,
              displayEndDate: period.displayEndDate,
              exclusiveEndDate: period.exclusiveEndDate,
              summary,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to save snapshot.');
          _historyState.snapshots = await fetchJson('/api/history');
          _historyState.selectedId = data.id;
          _historyState.message = 'Snapshot saved for ' + period.label + '.';
          _historyState.messageError = false;
        } catch (err) {
          _historyState.message = 'Failed to save snapshot: ' + (err.message || 'Unknown error.');
          _historyState.messageError = true;
        } finally {
          _historyState.saving = false;
          reRender();
        }
      });
    }

    // View snapshot
    bodyEl.querySelectorAll('[data-action="history-view"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        _historyState.selectedId = _historyState.selectedId === id ? null : id;
        reRender();
        if (_historyState.selectedId) {
          const detailEl = document.getElementById('snapshot-detail');
          if (detailEl) detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    // Delete snapshot
    bodyEl.querySelectorAll('[data-action="history-delete"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const snap = _historyState.snapshots.find((s) => s.id === id);
        const label = snap ? snap.period_label : 'this snapshot';
        if (!confirm('Delete snapshot for ' + label + '? This cannot be undone.')) return;
        btn.disabled = true;
        try {
          const res = await fetch(BACKEND + '/api/history/' + encodeURIComponent(id), {
            method: 'DELETE',
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Delete failed.');
          }
          _historyState.snapshots = await fetchJson('/api/history');
          if (_historyState.selectedId === id) _historyState.selectedId = null;
          if (_historyState.compareA === id) _historyState.compareA = null;
          if (_historyState.compareB === id) _historyState.compareB = null;
          _historyState.message = 'Snapshot deleted.';
          _historyState.messageError = false;
          reRender();
        } catch (err) {
          _historyState.message = 'Failed to delete: ' + (err.message || 'Unknown error.');
          _historyState.messageError = true;
          reRender();
        }
      });
    });

    // Save notes
    const saveNotesBtn = bodyEl.querySelector('[data-action="history-save-notes"]');
    if (saveNotesBtn) {
      saveNotesBtn.addEventListener('click', async () => {
        const id = saveNotesBtn.dataset.id;
        const textarea = document.getElementById('snapshot-notes-input');
        const msgEl = document.getElementById('snapshot-notes-message');
        const notes = textarea ? textarea.value : '';
        saveNotesBtn.disabled = true;
        if (msgEl) msgEl.textContent = 'Saving...';
        try {
          const res = await fetch(BACKEND + '/api/history/' + encodeURIComponent(id) + '/notes', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Failed to save notes.');
          // Update local snapshot
          const idx = _historyState.snapshots.findIndex((s) => s.id === id);
          if (idx !== -1) _historyState.snapshots[idx].notes = notes;
          if (msgEl) { msgEl.textContent = 'Notes saved.'; msgEl.style.color = 'var(--success)'; }
        } catch (err) {
          if (msgEl) { msgEl.textContent = 'Failed: ' + (err.message || 'Unknown error.'); msgEl.style.color = 'var(--danger)'; }
        } finally {
          saveNotesBtn.disabled = false;
        }
      });
    }

    // Compare selectors
    const compareAEl = bodyEl.querySelector('#compare-a');
    const compareBEl = bodyEl.querySelector('#compare-b');
    if (compareAEl) {
      compareAEl.addEventListener('change', () => {
        _historyState.compareA = compareAEl.value || null;
        reRender();
      });
    }
    if (compareBEl) {
      compareBEl.addEventListener('change', () => {
        _historyState.compareB = compareBEl.value || null;
        reRender();
      });
    }
  }

  reRender();
}
