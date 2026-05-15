import { buildPayPeriodSummary } from '../utils/payPeriodSummary.js';
import { loadBudgetContext } from '../utils/loadBudgetContext.js';
import { fetchCloseoutRecord } from '../utils/closeoutClient.js';
import { calculateFlexibleBudgetSplitEngine } from '../utils/budgetCalculations.js';
import { loadCashFlowForecast } from '../utils/cashFlowForecast.js';

const BACKEND = 'http://localhost:8787';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return (amount < 0 ? '-' : '') + '$' + Math.abs(amount).toFixed(2);
}

function formatDateTime(value) {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}

function getLastSyncLabel(plaidStatus) {
  const timestamps = (Array.isArray(plaidStatus?.items) ? plaidStatus.items : [])
    .map((item) => item?.lastSyncedAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (!timestamps.length) return 'Last sync unavailable';
  return 'Last sync ' + formatDateTime(new Date(Math.max(...timestamps)).toISOString());
}

function statusClass(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'good') return 'status-good';
  if (key === 'needs_review') return 'status-warning';
  if (key === 'needs review') return 'status-warning';
  if (key === 'tight') return 'status-warning';
  if (key === 'warning') return 'status-warning';
  if (key === 'error') return 'status-danger';
  if (key === 'unavailable') return 'status-warning';
  return 'status-warning';
}

function formatPeriodLabel(period) {
  if (!period) return 'Unavailable';
  return period.label || [period.startDate, period.displayEndDate].filter(Boolean).join(' - ') || period.id || 'Unavailable';
}

function renderTopBar({ period, dataHealthLabel, dataHealthStatus, lastSyncLabel, syncState, closeoutStatus }) {
  return (
    '<section class="dashboard-banner card">' +
    '<div class="dashboard-banner-copy">' +
    '<p class="dashboard-eyebrow">Dashboard Command Center</p>' +
    '<h2 class="card-title">' + escapeHtml(formatPeriodLabel(period)) + '</h2>' +
    '<p class="card-description">Command center for the current pay period.</p>' +
    '</div>' +
    '<div class="dashboard-banner-meta">' +
    '<span class="badge-' + statusClass(dataHealthStatus).replace('status-', '') + '">' + escapeHtml(dataHealthLabel) + '</span>' +
    (closeoutStatus ? '<span class="closeout-status-badge ' + escapeHtml(closeoutStatus.className || 'warning') + '">' + escapeHtml(closeoutStatus.label) + '</span>' : '') +
    '<span class="badge-neutral">' + escapeHtml(lastSyncLabel) + '</span>' +
    '<span class="badge-neutral">' + escapeHtml(syncState || 'Connected') + '</span>' +
    '</div>' +
    '</section>'
  );
}

function renderCommandStrip() {
  const buttons = [
    ['Transactions', 'transactions'],
    ['Recurring Bills', 'recurring-bills'],
    ['Expenses', 'expenses'],
    ['Transfers', 'transfers'],
    ['History', 'history'],
  ];

  return (
    '<section class="dashboard-shortcuts">' +
    buttons.map(([label, tabId]) => (
      '<button type="button" class="button button-secondary dashboard-shortcut" data-action="dashboard-open-tab" data-tab-id="' + tabId + '">' + escapeHtml(label) + '</button>'
    )).join('') +
    '</section>'
  );
}

function renderPrimaryCards(summary) {
  const safeSpend = summary.safeMoney?.safeToSpend || { amount: summary.safeToSpend, status: 'warning', blockers: [], warnings: [], breakdown: {} };
  const safeTransfer = summary.safeMoney?.safeToTransfer || { amount: summary.safeToTransfer, status: 'warning', blockers: [], warnings: [], breakdown: {} };
  const incomeSource = summary.income.source === 'No income found' ? 'Unavailable' : (summary.income.source || 'Unavailable');
  const payrollLines = [
    summary.income.regularPaycheck ? 'Paycheck ' + formatMoney(summary.income.regularPaycheck) : null,
    summary.income.bonusIncome ? 'Bonus ' + formatMoney(summary.income.bonusIncome) : null,
    summary.income.otherIncome ? 'Other income ' + formatMoney(summary.income.otherIncome) : null,
  ].filter(Boolean);

  const recurringNext = summary.recurringBills.unpaidRows?.[0] || null;
  const expenseRows = Array.isArray(summary.expenses.categoryRows) ? summary.expenses.categoryRows : [];
  const expenseOverBudgetCount = expenseRows.filter((row) => row.overBudget).length;

  const cards = [
    { label: 'Budget Income', value: summary.income.budgetIncome, tone: 'good', subtext: ['Source: ' + incomeSource, ...payrollLines] },
    {
      label: 'Safe to Spend',
      value: safeSpend.amount,
      tone: safeSpend.status === 'danger' ? 'danger' : safeSpend.status === 'warning' || safeSpend.status === 'tight' ? 'warning' : 'good',
      unavailable: safeSpend.status === 'unavailable',
      status: safeSpend,
    },
    {
      label: 'Safe to Transfer',
      value: safeTransfer.amount,
      tone: safeTransfer.status === 'danger' ? 'danger' : safeTransfer.status === 'warning' || safeTransfer.status === 'tight' ? 'warning' : 'good',
      unavailable: safeTransfer.status === 'unavailable',
      status: safeTransfer,
    },
    { label: 'Bills Left', value: summary.recurringBills.unpaidTotal, tone: Number(summary.recurringBills.unpaidTotal || 0) > Number(summary.income.budgetIncome || 0) ? 'warning' : 'good', subtext: [summary.recurringBills.unpaidCount + ' unpaid bill' + (summary.recurringBills.unpaidCount === 1 ? '' : 's'), recurringNext ? 'Next unpaid: ' + recurringNext.billName + ' ' + (recurringNext.dueDateLabel || recurringNext.dueDate || '') : 'No unpaid bills left'] },
    { label: 'Expense Remaining', value: summary.expenses.remaining, tone: Number(summary.expenses.remaining || 0) < 0 ? 'danger' : 'good', subtext: ['Actual ' + formatMoney(summary.expenses.actualTotal), 'Budget ' + formatMoney(summary.expenses.budgetTotal), expenseOverBudgetCount ? expenseOverBudgetCount + ' category' + (expenseOverBudgetCount === 1 ? '' : 'ies') + ' over budget' : 'No categories over budget'] },
    { label: 'BOA Rollover', value: summary.rollover.amount, tone: !Number.isFinite(Number(summary.rollover.amount)) || !!summary.rollover.warning ? 'warning' : 'good', unavailable: !Number.isFinite(Number(summary.rollover.amount)) || !!summary.rollover.warning, subtext: summary.rollover.warning ? [summary.rollover.warning] : ['Shared rollover from last BOA transaction before paycheck.'] },
  ];

  return (
    '<section class="dashboard-primary-grid">' +
    cards.map((card) => (
      '<article class="card command-card compact">' +
      '<div class="metric-card">' +
      '<div class="metric-label">' + escapeHtml(card.label) + '</div>' +
      ((card.unavailable || card.status)
        ? '<div class="metric-value metric-value-unavailable">Unavailable</div>'
        : '<div class="metric-value ' + (card.tone ? 'text-' + card.tone : '') + '">' + escapeHtml(formatMoney(card.value)) + '</div>') +
      '<div class="metric-subtext">' + (card.subtext ? card.subtext.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') : '') + '</div>' +
      (card.status ? '<details class="safe-money-disclosure"><summary>' + escapeHtml((card.status.label || card.label) + ' details') + '</summary>' +
        '<div class="safe-money-breakdown">' +
        (card.status.blockers?.length ? '<div class="dashboard-alert danger"><strong>Blockers</strong><div>' + card.status.blockers.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') + '</div></div>' : '') +
        (card.status.warnings?.length ? '<div class="dashboard-alert warning"><strong>Warnings</strong><div>' + card.status.warnings.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') + '</div></div>' : '') +
        '<div class="action-list">' +
        Object.entries(card.status.breakdown || {}).map(([key, value]) => '<div class="action-row"><span>' + escapeHtml(key) + '</span><strong>' + escapeHtml(typeof value === 'number' ? formatMoney(value) : String(value)) + '</strong></div>').join('') +
        '</div>' +
        '</div></details>' : '') +
      '</div>' +
      '</article>'
    )).join('') +
    '</section>'
  );
}

function renderReviewQueue(reviewStats, hasRulesEngine) {
  return (
    '<article class="card command-card compact">' +
    '<div class="card-header"><h3 class="card-title">Review Queue</h3><p class="card-description">Transactions and bill matches needing attention.</p></div>' +
    '<div class="action-list">' +
    '<div class="action-row"><span>Unreviewed transactions</span><strong class="text-warning">' + escapeHtml(String(reviewStats.unreviewedCount)) + '</strong></div>' +
    '<div class="action-row"><span>Ignored transactions</span><strong class="text-muted">' + escapeHtml(String(reviewStats.ignoredCount)) + '</strong></div>' +
    '<div class="action-row"><span>Possible bill matches</span><strong class="text-warning">' + escapeHtml(String(reviewStats.possibleBillMatches)) + '</strong></div>' +
    '<div class="action-row"><span>Unmatched recurring bills</span><strong class="text-warning">' + escapeHtml(String(reviewStats.unmatchedRecurringBills)) + '</strong></div>' +
    (hasRulesEngine ? '<div class="action-row"><span>Rules ready to apply</span><strong class="text-muted">' + escapeHtml(String(reviewStats.rulesAvailableButNotApplied)) + '</strong></div>' : '') +
    '</div>' +
    '<div class="dashboard-secondary-actions">' +
    '<button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="transactions">Review Transactions</button>' +
    (hasRulesEngine ? '<button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="settings">Apply Rules</button>' : '') +
    '</div>' +
    '</article>'
  );
}

function renderTransferActions(summary) {
  const rows = [
    { label: 'Josh transfer needed', value: summary.transfers.josh },
    { label: 'Taylor transfer needed', value: summary.transfers.taylor },
    { label: 'Discover transfer needed', value: summary.transfers.discover },
    { label: 'Debt/Savings transfer needed', value: summary.transfers.debtSavings },
    { label: 'BOA reserve', value: summary.transfers.boaReserve },
  ];

  return (
    '<article class="card command-card compact">' +
    '<div class="card-header"><h3 class="card-title">Transfer Actions</h3><p class="card-description">Planned moves for this pay period.</p></div>' +
    '<div class="action-list">' +
    rows.map((row) => {
      const amount = Number(row.value || 0);
      const stateClass = amount < 0 ? 'text-danger' : amount === 0 ? 'text-good' : 'text-warning';
      const label = amount === 0 ? 'Complete' : formatMoney(amount);
      return '<div class="action-row"><span>' + escapeHtml(row.label) + '</span><strong class="' + stateClass + '">' + escapeHtml(label) + '</strong></div>';
    }).join('') +
    '</div>' +
    (Number(summary.transfers.discover || 0) < 0 ? '<div class="dashboard-alert warning">Discover transfer is short.</div>' : '') +
    '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="transfers">Go to Transfers</button></div>' +
    '</article>'
  );
}

function renderCashFlowForecastCard(forecast) {
  if (!forecast || !forecast.summary) {
    return (
      '<article class="card command-card compact">' +
      '<div class="card-header"><h3 class="card-title">Cash Flow Forecast</h3><p class="card-description">Preview unavailable for this period.</p></div>' +
      '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="cash-flow">View Forecast</button></div>' +
      '</article>'
    );
  }

  const nextRisk = forecast.summary.nextCashRiskDate
    ? new Date(forecast.summary.nextCashRiskDate + 'T00:00:00').toLocaleDateString()
    : 'None';

  return (
    '<article class="card command-card compact">' +
    '<div class="card-header"><h3 class="card-title">Cash Flow Forecast</h3><p class="card-description">Cash outlook for the selected budget period.</p></div>' +
    '<div class="action-list">' +
    '<div class="action-row"><span>Projected Ending Cash</span><strong class="' + (Number(forecast.summary.projectedEndingCash || 0) < 0 ? 'text-danger' : 'text-good') + '">' + escapeHtml(formatMoney(forecast.summary.projectedEndingCash || 0)) + '</strong></div>' +
    '<div class="action-row"><span>Lowest Projected Cash</span><strong class="' + (Number(forecast.summary.lowestProjectedCashBalance || 0) < 0 ? 'text-danger' : 'text-warning') + '">' + escapeHtml(formatMoney(forecast.summary.lowestProjectedCashBalance || 0)) + '</strong></div>' +
    '<div class="action-row"><span>Next Cash Risk Date</span><strong class="' + (forecast.summary.nextCashRiskDate ? 'text-danger' : 'text-good') + '">' + escapeHtml(nextRisk) + '</strong></div>' +
    '</div>' +
    '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="cash-flow">View Forecast</button></div>' +
    '</article>'
  );
}

function renderBillsAttention(summary) {
  const rows = [...(summary.recurringBills.unpaidRows || [])]
    .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))
    .slice(0, 5)
    .map((row) => (
      '<tr>' +
      '<td>' + escapeHtml(row.billName || row.name || '-') + '</td>' +
      '<td>' + escapeHtml(row.dueDateLabel || row.dueDate || '-') + '</td>' +
      '<td>' + escapeHtml(formatMoney(row.amount || 0)) + '</td>' +
      '<td><span class="' + (row.statusLabel === 'Overdue' ? 'badge-danger' : row.autopay && !row.paidTransactionId ? 'badge-warning' : 'badge-good') + '">' + escapeHtml(row.autopay && !row.paidTransactionId ? 'Autopay not found' : row.statusLabel || 'Unpaid') + '</span></td>' +
      '</tr>'
    ));

  return (
    '<article class="card command-card compact">' +
    '<div class="card-header"><h3 class="card-title">Bills Needing Attention</h3><p class="card-description">Unpaid, overdue, and unmatched recurring bills.</p></div>' +
    '<div class="action-list">' +
    '<div class="action-row"><span>Due soon / unpaid</span><strong>' + escapeHtml(String(summary.recurringBills.unpaidCount || 0)) + '</strong></div>' +
    '<div class="action-row"><span>Overdue bills</span><strong>' + escapeHtml(String((summary.recurringBills.unpaidRows || []).filter((row) => row.statusLabel === 'Overdue').length)) + '</strong></div>' +
    '<div class="action-row"><span>Autopay bills not found</span><strong>' + escapeHtml(String((summary.recurringBills.unpaidRows || []).filter((row) => row.autopay && !row.paidTransactionId).length)) + '</strong></div>' +
    '<div class="action-row"><span>Possible matches</span><strong>' + escapeHtml(String((summary.recurringBills.dueRows || []).filter((row) => !!row.paidTransactionId).length)) + '</strong></div>' +
    '<div class="action-row"><span>Amount left to pay</span><strong>' + escapeHtml(formatMoney(summary.recurringBills.unpaidTotal || 0)) + '</strong></div>' +
    '</div>' +
    (rows.length
      ? '<div class="table-wrap"><table class="table table-compact"><thead><tr><th>Bill</th><th>Due</th><th>Amount</th><th>Status</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'
      : '<p class="empty-state">No unpaid recurring bills left.</p>') +
    '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="recurring-bills">Go to Recurring Bills</button></div>' +
    '</article>'
  );
}

function renderSpendingWatchlists(summary) {
  const rows = Array.isArray(summary.expenses.categoryRows) ? summary.expenses.categoryRows : [];
  const budgetTotal = Number(summary.expenses.budgetTotal || 0);
  if (budgetTotal <= 0) {
    return (
      '<article class="card command-card compact">' +
      '<div class="card-header"><h3 class="card-title">Spending Watchlists / Over Budget</h3><p class="card-description">Add budgets in Master Lists &gt; Expense List.</p></div>' +
      '<p class="empty-state">Add budgets in Master Lists &gt; Expense List.</p>' +
      '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="expenses">Go to Expenses</button></div>' +
      '</article>'
    );
  }

  const ranked = rows
    .map((row) => ({ ...row, ratio: row.budget > 0 ? row.actual / row.budget : 0 }))
    .sort((a, b) => {
      const aScore = a.overBudget ? 0 : a.ratio >= 0.8 ? 1 : 2;
      const bScore = b.overBudget ? 0 : b.ratio >= 0.8 ? 1 : 2;
      if (aScore !== bScore) return aScore - bScore;
      return Number(b.actual || 0) - Number(a.actual || 0);
    })
    .slice(0, 5);

  return (
    '<article class="card command-card compact">' +
    '<div class="card-header"><h3 class="card-title">Spending Watchlists / Over Budget</h3><p class="card-description">Categories near or above budget.</p></div>' +
    '<div class="action-list">' +
    ranked.map((row) => {
      const state = row.overBudget ? 'Over budget' : row.ratio >= 0.8 ? 'Close to budget' : 'Top spending';
      const badgeClass = row.overBudget ? 'badge-danger' : row.ratio >= 0.8 ? 'badge-warning' : 'badge-good';
      return '<div class="action-row"><span>' + escapeHtml(row.name) + '</span><strong class="' + badgeClass + '">' + escapeHtml(state) + '</strong></div>';
    }).join('') +
    '</div>' +
    '<div class="table-wrap"><table class="table table-compact"><thead><tr><th>Category</th><th>Budget</th><th>Actual</th><th>Remaining</th><th>Status</th></tr></thead><tbody>' +
    ranked.map((row) => {
      const state = row.overBudget ? 'Over budget' : row.ratio >= 0.8 ? 'Close to budget' : 'Top spending';
      const badgeClass = row.overBudget ? 'badge-danger' : row.ratio >= 0.8 ? 'badge-warning' : 'badge-good';
      return (
        '<tr>' +
        '<td>' + escapeHtml(row.name) + '</td>' +
        '<td>' + escapeHtml(formatMoney(row.budget)) + '</td>' +
        '<td>' + escapeHtml(formatMoney(row.actual)) + '</td>' +
        '<td>' + escapeHtml(formatMoney(row.remaining)) + '</td>' +
        '<td><span class="' + badgeClass + '">' + escapeHtml(state) + '</span></td>' +
        '</tr>'
      );
    }).join('') +
    '</tbody></table></div>' +
    '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="expenses">Go to Expenses</button></div>' +
    '</article>'
  );
}

function renderBudgetSplitSummary(splitSummary) {
  const rows = Array.isArray(splitSummary?.rows) ? splitSummary.rows : [];
  const totals = splitSummary?.totals || { remaining: 0 };
  const formatGroupLabel = (group) => group === 'Debts/Savings' ? 'Debt/Savings' : String(group || '');

  return (
    '<article class="card command-card compact">' +
    '<div class="card-header"><h3 class="card-title">Budget Split Summary</h3><p class="card-description">Remaining budget after recurring bills due in this pay period.</p></div>' +
    '<div class="dashboard-mini-grid">' +
    '<div class="metric-card compact"><div class="metric-label">Budget Income</div><div class="metric-value text-good">' + escapeHtml(formatMoney(splitSummary?.income || 0)) + '</div></div>' +
    rows.map((row) => (
      '<div class="metric-card compact"><div class="metric-label">' + escapeHtml(formatGroupLabel(row.group) + ' Remaining') + '</div><div class="metric-value text-' + (Number(row.remaining || 0) >= 0 ? 'good' : 'danger') + '">' + escapeHtml(formatMoney(row.remaining || 0)) + '</div></div>'
    )).join('') +
    '<div class="metric-card compact"><div class="metric-label">Total Remaining</div><div class="metric-value text-' + (Number(totals.remaining || 0) >= 0 ? 'good' : 'danger') + '">' + escapeHtml(formatMoney(totals.remaining || 0)) + '</div></div>' +
    '</div>' +
    '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="paycheck-planner">Open Paycheck Planner</button></div>' +
    '</article>'
  );
}

function renderEnvelopeSummary({ splitSummary, bucketSummary }) {
  const groupTotals = bucketSummary?.groupTotals || {};
  const rows = Array.isArray(splitSummary?.rows) ? splitSummary.rows : [];
  const remainingByGroup = {
    Needs: Number(rows.find((row) => row.group === 'Needs')?.remaining || 0),
    Wants: Number(rows.find((row) => row.group === 'Wants')?.remaining || 0),
    'Debts/Savings': Number(rows.find((row) => row.group === 'Debts/Savings')?.remaining || 0),
  };

  const bucketedNeeds = Number(groupTotals.Needs || 0);
  const bucketedWants = Number(groupTotals.Wants || 0);
  const bucketedDebtSavings = Number(groupTotals['Debts/Savings'] || 0);
  const totalBucketed = bucketedNeeds + bucketedWants + bucketedDebtSavings;

  const groupUnassignedNeeds = remainingByGroup.Needs - bucketedNeeds;
  const groupUnassignedWants = remainingByGroup.Wants - bucketedWants;
  const groupUnassignedDebtSavings = remainingByGroup['Debts/Savings'] - bucketedDebtSavings;
  const totalUnassignedRemaining = Number(splitSummary?.totals?.remaining || 0) - totalBucketed;

  const warningLines = [];
  if (groupUnassignedNeeds < 0) {
    warningLines.push('Needs buckets are over budget by ' + formatMoney(Math.abs(groupUnassignedNeeds)) + '.');
  } else {
    warningLines.push('Needs has ' + formatMoney(groupUnassignedNeeds) + ' left to assign.');
  }
  if (groupUnassignedWants < 0) {
    warningLines.push('Wants buckets are over budget by ' + formatMoney(Math.abs(groupUnassignedWants)) + '.');
  } else {
    warningLines.push('Wants has ' + formatMoney(groupUnassignedWants) + ' left to assign.');
  }
  if (groupUnassignedDebtSavings < 0) {
    warningLines.push('Debt/Savings buckets are over budget by ' + formatMoney(Math.abs(groupUnassignedDebtSavings)) + '.');
  } else {
    warningLines.push('Debt/Savings has ' + formatMoney(groupUnassignedDebtSavings) + ' left to assign.');
  }

  return (
    '<article class="card command-card compact">' +
    '<div class="card-header"><h3 class="card-title">Envelope Summary</h3><p class="card-description">Bucket assignments for this pay period.</p></div>' +
    '<div class="dashboard-mini-grid">' +
    '<div class="metric-card compact"><div class="metric-label">Needs Bucketed</div><div class="metric-value">' + escapeHtml(formatMoney(bucketedNeeds)) + '</div></div>' +
    '<div class="metric-card compact"><div class="metric-label">Wants Bucketed</div><div class="metric-value">' + escapeHtml(formatMoney(bucketedWants)) + '</div></div>' +
    '<div class="metric-card compact"><div class="metric-label">Debt/Savings Bucketed</div><div class="metric-value">' + escapeHtml(formatMoney(bucketedDebtSavings)) + '</div></div>' +
    '<div class="metric-card compact"><div class="metric-label">Total Unassigned Remaining</div><div class="metric-value text-' + (totalUnassignedRemaining < 0 ? 'danger' : 'warning') + '">' + escapeHtml(formatMoney(totalUnassignedRemaining)) + '</div></div>' +
    '</div>' +
    '<div class="action-list">' + warningLines.map((line) => '<div class="action-row"><span>' + escapeHtml(line) + '</span></div>').join('') + '</div>' +
    '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="paycheck-planner">Manage Buckets</button></div>' +
    '</article>'
  );
}

function formatHealthLabel(report) {
  if (!report) return 'Data Health: Unavailable';
  const score = Number(report.score || 0);
  const status = String(report.status || 'needs_review').replaceAll('_', ' ');
  return 'Data Health: ' + status.charAt(0).toUpperCase() + status.slice(1) + ' (' + score + ')';
}

function toIssueRank(issue) {
  const sev = String(issue?.severity || '').toLowerCase();
  const severity = sev === 'error' ? 3 : sev === 'warning' ? 2 : 1;
  return severity * 1000 + Number(issue?.count || 0);
}

function mapHealthIssueToAction(issue) {
  const rawTarget = issue.actionTarget || 'data-health';
  const destination = rawTarget === 'recurringBills' ? 'recurring-bills' : rawTarget;
  return {
    label: issue.title || 'Data health issue',
    reason: issue.message || 'Review this issue in Data Health Center.',
    buttonText: issue.actionLabel || 'Open Data Health',
    destination,
  };
}

function buildNextActions({ summary, reviewStats, historySnapshots, loadError, closeoutRecord, period, healthReport }) {
  const actions = [];
  const safeTransfer = summary.safeMoney?.safeToTransfer || { amount: summary.safeToTransfer, blockers: [], status: 'warning' };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const closeoutEnd = new Date(period?.displayEndDate || period?.endDate || period?.startDate || today);
  closeoutEnd.setHours(0, 0, 0, 0);
  const daysUntilClose = Math.round((closeoutEnd.getTime() - today.getTime()) / 86400000);
  const nearClose = Number.isFinite(daysUntilClose) && daysUntilClose <= 2;

  if (loadError) {
    actions.push({ label: 'Backend unavailable', reason: 'Could not load dashboard data.', buttonText: 'Try Settings', destination: 'settings' });
  }

  const topHealthIssues = Array.isArray(healthReport?.issues)
    ? healthReport.issues
        .slice()
        .sort((a, b) => toIssueRank(b) - toIssueRank(a))
        .slice(0, 3)
    : [];
  topHealthIssues.forEach((issue) => {
    actions.push(mapHealthIssueToAction(issue));
  });

  const payrollMissing = Number(summary.income.budgetIncome || 0) > 0 && (summary.income.payrollTransactions || []).length === 0 && String(summary.income.source || '').toLowerCase() !== 'manual override';
  if (payrollMissing) {
    actions.push({ label: 'Cisco payroll missing', reason: 'No Cisco payroll transaction was detected for this period.', buttonText: 'Review Transactions', destination: 'transactions' });
  }

  if (Number(summary.income.budgetIncome || 0) <= 0) {
    actions.push({ label: 'Budget income missing', reason: 'No budget income has been set for this period.', buttonText: 'Open Paycheck Planner', destination: 'paycheck-planner' });
  }

  if (Number(summary.recurringBills.unpaidTotal || 0) > 0) {
    actions.push({ label: 'Recurring bills left to pay', reason: 'Pay or confirm ' + formatMoney(summary.recurringBills.unpaidTotal) + ' in unpaid recurring bills.', buttonText: 'Go to Recurring Bills', destination: 'recurring-bills' });
  }

  const autopayMissing = (summary.recurringBills.unpaidRows || []).filter((row) => row.autopay && !row.paidTransactionId).length;
  if (autopayMissing > 0) {
    actions.push({ label: 'Autopay bill not matched', reason: String(autopayMissing) + ' autopay bill' + (autopayMissing === 1 ? ' is' : 's are') + ' not matched.', buttonText: 'Review Bills', destination: 'recurring-bills' });
  }

  if (reviewStats.unreviewedCount > 0) {
    actions.push({ label: 'Review unreviewed transactions before closeout', reason: 'Review ' + reviewStats.unreviewedCount + ' unreviewed transaction' + (reviewStats.unreviewedCount === 1 ? '' : 's') + '.', buttonText: 'Open Transactions', destination: 'transactions' });
  }

  const overBudgetRow = (summary.expenses.categoryRows || []).filter((row) => row.overBudget).sort((a, b) => Number(b.remaining || 0) - Number(a.remaining || 0))[0];
  if (overBudgetRow) {
    actions.push({ label: 'Expense category over budget', reason: overBudgetRow.name + ' is over budget by ' + formatMoney(Math.abs(overBudgetRow.remaining || 0)) + '.', buttonText: 'Go to Expenses', destination: 'expenses' });
  }

  if (Number(summary.recurringBills.unpaidTotal || 0) > 0) {
    actions.push({ label: 'Confirm unpaid bills', reason: 'Confirm ' + formatMoney(summary.recurringBills.unpaidTotal) + ' in unpaid recurring bills before closing.', buttonText: 'Go to Recurring Bills', destination: 'recurring-bills' });
  }

  if (Number(summary.transfers.total || 0) > 0) {
    actions.push({ label: 'Confirm transfers', reason: 'Review ' + formatMoney(summary.transfers.total) + ' in planned transfers before closing.', buttonText: 'Go to Transfers', destination: 'transfers' });
  }

  if (nearClose && (!closeoutRecord || String(closeoutRecord.status || 'open') !== 'closed')) {
    actions.push({ label: 'Close this pay period', reason: 'The current budget period ends soon.', buttonText: 'Open Closeout', destination: 'closeout' });
  }

  if (Number(safeTransfer.amount || 0) < 0 || (safeTransfer.blockers || []).length) {
    actions.push({ label: 'Transfer shortfall', reason: (safeTransfer.blockers || []).length ? safeTransfer.blockers[0] : 'Safe to transfer is short by ' + formatMoney(Math.abs(safeTransfer.amount || 0)) + '.', buttonText: 'Go to Transfers', destination: 'transfers' });
  }

  const hasCurrentSnapshot = Array.isArray(historySnapshots) && historySnapshots.some((snapshot) => snapshot.period_id === summary.period.id && snapshot.isLatestForPeriod);
  if (!hasCurrentSnapshot) {
    actions.push({ label: 'Save closeout snapshot', reason: 'Save a History snapshot for this period before closing.', buttonText: 'Open Closeout', destination: 'closeout' });
  }

  if (!actions.length) {
    actions.push({ label: 'Everything looks good', reason: 'No urgent actions for this pay period.', buttonText: 'Stay on Dashboard', destination: 'dashboard' });
  }

  return actions.slice(0, 4);
}

function renderNextBestActions(actions) {
  return (
    '<article class="card command-card compact">' +
    '<div class="card-header"><h3 class="card-title">Next Best Action</h3><p class="card-description">Highest priority things to do now.</p></div>' +
    '<div class="action-list">' +
    actions.map((action) => (
      '<div class="action-row">' +
      '<div><strong>' + escapeHtml(action.label) + '</strong><div class="card-description">' + escapeHtml(action.reason) + '</div></div>' +
      '<button class="button button-secondary button-sm dashboard-cta" data-action="dashboard-open-tab" data-tab-id="' + escapeHtml(action.destination) + '">' + escapeHtml(action.buttonText) + '</button>' +
      '</div>'
    )).join('') +
    '</div>' +
    '</article>'
  );
}

function renderReportsPreview(reportsSummary) {
  const periods = Array.isArray(reportsSummary?.periods) ? reportsSummary.periods : [];
  const current = periods[0] || null;
  const previous = periods[1] || null;

  if (!current || !previous) {
    return (
      '<article class="card command-card compact">' +
      '<div class="card-header"><h3 class="card-title">Reports Preview</h3><p class="card-description">Trend direction for the latest periods.</p></div>' +
      '<p class="empty-state">Not enough report history yet.</p>' +
      '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="reports">View Reports</button></div>' +
      '</article>'
    );
  }

  const expensesDelta = Number(current.actualExpenseSpending || 0) - Number(previous.actualExpenseSpending || 0);
  const safeDelta = Number(current.safeToSpend || 0) - Number(previous.safeToSpend || 0);
  const billsDelta = Number(current.recurringBillsDue || 0) - Number(previous.recurringBillsDue || 0);

  const line = (label, value) => {
    const stateClass = value > 0 ? 'text-warning' : value < 0 ? 'text-good' : 'text-muted';
    const directionWord = value > 0 ? 'higher' : value < 0 ? 'lower' : 'unchanged';
    const amount = '$' + Math.abs(Number(value || 0)).toFixed(2);
    return '<div class="action-row"><span>' + escapeHtml(label + ' are ' + directionWord + ' than last period.') + '</span><strong class="' + stateClass + '">' + escapeHtml(amount) + '</strong></div>';
  };

  return (
    '<article class="card command-card compact">' +
    '<div class="card-header"><h3 class="card-title">Reports Preview</h3><p class="card-description">Quick trend check vs prior period.</p></div>' +
    '<div class="action-list">' +
    line('Expenses', expensesDelta) +
    line('Safe to Spend', safeDelta) +
    line('Recurring bills', billsDelta) +
    '</div>' +
    '<div class="dashboard-secondary-actions"><button class="button button-secondary dashboard-cta" data-action="dashboard-open-tab" data-tab-id="reports">View Reports</button></div>' +
    '</article>'
  );
}

function deriveDataHealth({ summary, reviewStats, hasBackendIssue, payrollMissing }) {
  if (hasBackendIssue) return 'Error';
  const urgentOverdueBills = (summary.recurringBills.unpaidRows || []).some((row) => row.statusLabel === 'Overdue');
  const safeSpend = summary.safeMoney?.safeToSpend || { amount: summary.safeToSpend, status: 'warning' };
  const safeTransfer = summary.safeMoney?.safeToTransfer || { amount: summary.safeToTransfer, status: 'warning' };
  if (payrollMissing || Number(safeSpend.amount || 0) < 0 || Number(safeTransfer.amount || 0) < 0 || Number(summary.expenses.overBudgetCount || 0) > 0 || urgentOverdueBills) {
    return 'Warning';
  }
  if (reviewStats.unreviewedCount > 0 || reviewStats.possibleBillMatches > 0 || reviewStats.rulesAvailableButNotApplied > 0) {
    return 'Needs Review';
  }
  return Number(summary.income.budgetIncome || 0) > 0 && reviewStats.unreviewedCount < 5 ? 'Good' : 'Needs Review';
}

export async function renderDashboard(container, options = {}) {
  const period = options.period;
  if (!period) {
    container.innerHTML = '<section class="card"><p class="empty-state">Select or create a pay period.</p></section>';
    return;
  }

  container.innerHTML = '<section class="card"><p class="empty-state">Loading dashboard...</p></section>';

  try {
    const context = await loadBudgetContext({ period });
    const [plaidStatus, rules, rulesPreviewRes, historySnapshots, closeoutRecord, healthReport, reportsSummary, bucketSummary, cashFlowForecast] = await Promise.all([
      fetch(BACKEND + '/api/plaid/status').then(async (res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      }),
      fetch(BACKEND + '/api/rules').then(async (res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      }).catch(() => []),
      fetch(BACKEND + '/api/rules/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, periodId: period.id }),
      }).catch(() => null),
      fetch(BACKEND + '/api/history').then(async (res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      }).catch(() => []),
      fetchCloseoutRecord(period.id).catch(() => null),
      fetch(BACKEND + '/api/data-health?periodId=' + encodeURIComponent(period.id))
        .then(async (res) => {
          const data = await res.json().catch(() => null);
          if (!res.ok) return null;
          return data;
        })
        .catch(() => null),
      fetch(BACKEND + '/api/reports/summary?limit=2&includeCurrent=true&currentPeriodId=' + encodeURIComponent(period.id))
        .then(async (res) => {
          const data = await res.json().catch(() => null);
          if (!res.ok) return null;
          return data;
        })
        .catch(() => null),
      fetch(
        BACKEND + '/api/budget-buckets?payPeriodStart=' + encodeURIComponent(period.startDate) +
        '&payPeriodEnd=' + encodeURIComponent(period.exclusiveEndDate)
      )
        .then(async (res) => {
          const data = await res.json().catch(() => null);
          if (!res.ok) return null;
          return data;
        })
        .catch(() => null),
      loadCashFlowForecast(period).catch(() => null),
    ]);

    const rulesPreview = rulesPreviewRes ? await rulesPreviewRes.json().catch(() => ({ matchedCount: 0 })) : { matchedCount: 0 };
    const summary = buildPayPeriodSummary(context);
    const reviewStats = {
      unreviewedCount: context.transactions.filter((row) => !row.reviewed && !row.ignored).length,
      ignoredCount: context.transactions.filter((row) => !!row.ignored).length,
      possibleBillMatches: (summary.recurringBills.dueRows || []).filter((row) => !!row.paidTransactionId).length,
      unmatchedRecurringBills: (summary.recurringBills.unpaidRows || []).filter((row) => !row.paidTransactionId).length,
      rulesAvailableButNotApplied: Number(rulesPreview?.matchedCount || 0),
    };

    const payrollMissing = Number(summary.income.budgetIncome || 0) > 0 && (summary.income.payrollTransactions || []).length === 0 && String(summary.income.source || '').toLowerCase() !== 'manual override';
    const fallbackHealth = deriveDataHealth({ summary, reviewStats, hasBackendIssue: false, payrollMissing });
    const dataHealthStatus = healthReport?.status || String(fallbackHealth || 'needs_review').toLowerCase().replaceAll(' ', '_');
    const dataHealthLabel = healthReport ? formatHealthLabel(healthReport) : 'Data Health: ' + fallbackHealth;
    const lastSyncLabel = getLastSyncLabel(plaidStatus);
    const syncState = Array.isArray(plaidStatus?.items) && plaidStatus.items.length ? 'Connected' : 'No synced items';
    const nextActions = buildNextActions({ summary, reviewStats, historySnapshots, closeoutRecord, period, healthReport });
    const splitSummary = calculateFlexibleBudgetSplitEngine({
      budgetIncome: summary.income.budgetIncome,
      recurringBillsDue: summary.recurringBills?.dueRows || [],
      splitSettings: context.settings?.splitSettings || {},
    });
    const hasRulesEngine = Array.isArray(rules);
    const closeoutStatus = closeoutRecord && String(closeoutRecord.status || '').toLowerCase() === 'closed'
      ? { label: 'Pay period closed', className: 'good' }
      : closeoutRecord && String(closeoutRecord.status || '').toLowerCase() === 'ready_to_close'
        ? { label: 'Closeout ready', className: 'warning' }
        : closeoutRecord && String(closeoutRecord.status || '').toLowerCase() === 'reopened'
          ? { label: 'Reopened', className: 'info' }
          : null;

    container.innerHTML =
      '<div class="dashboard-page">' +
      renderTopBar({ period: summary.period, dataHealthLabel, dataHealthStatus, lastSyncLabel, syncState, closeoutStatus }) +
      renderCommandStrip() +
      '<section class="dashboard-primary-grid">' + renderPrimaryCards(summary) + '</section>' +
      '<section class="dashboard-secondary-grid">' +
      '<div class="dashboard-secondary-column">' +
      renderBudgetSplitSummary(splitSummary) +
      renderEnvelopeSummary({ splitSummary, bucketSummary }) +
      renderReviewQueue(reviewStats, hasRulesEngine) +
      renderBillsAttention(summary) +
      '</div>' +
      '<div class="dashboard-secondary-column">' + renderCashFlowForecastCard(cashFlowForecast) + renderTransferActions(summary) + renderSpendingWatchlists(summary) + renderReportsPreview(reportsSummary) + renderNextBestActions(nextActions) + '</div>' +
      '</section>' +
      '</div>' +
      (closeoutRecord && String(closeoutRecord.status || '').toLowerCase() === 'closed' ? '<div class="closeout-warning">Pay period closed.</div>' : '') +
      (String(dataHealthStatus).toLowerCase() === 'warning' ? '<div class="dashboard-alert warning">Review flagged items before moving money.</div>' : '') +
      (String(dataHealthStatus).toLowerCase() === 'needs_review' ? '<div class="dashboard-alert info">Some transactions or bills still need review.</div>' : '') +
      (String(dataHealthStatus).toLowerCase() === 'error' ? '<div class="dashboard-alert danger">Data health has critical issues that need immediate attention.</div>' : '');

    container.querySelectorAll('[data-action="dashboard-open-tab"]').forEach((button) => {
      button.addEventListener('click', () => {
        const tabId = button.getAttribute('data-tab-id');
        if (tabId && typeof options.onOpenTab === 'function') {
          options.onOpenTab(tabId);
        }
      });
    });
  } catch (err) {
    console.error('Dashboard render failed:', err);
    container.innerHTML = '<section class="card"><div class="error-card">Backend not running on http://localhost:8787.<br><small>' + escapeHtml(err.message || 'Unknown error') + '</small></div></section>';
  }
}
