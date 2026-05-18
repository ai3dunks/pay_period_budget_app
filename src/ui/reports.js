import { loadCommandCenterSettings, isFeatureEnabled } from '../utils/commandCenter.js';

const BACKEND = '';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toNumber(value, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function money(value) {
  const amount = toNumber(value, 0);
  return (amount < 0 ? '-' : '') + '$' + Math.abs(amount).toFixed(2);
}

function signedMoney(value) {
  const amount = toNumber(value, 0);
  return (amount > 0 ? '+' : amount < 0 ? '-' : '') + '$' + Math.abs(amount).toFixed(2);
}

function pct(value) {
  const amount = toNumber(value, 0);
  return amount.toFixed(1) + '%';
}

function severityClass(severity) {
  const key = String(severity || '').toLowerCase();
  if (key === 'danger' || key === 'error') return 'badge-danger';
  if (key === 'warning') return 'badge-warning';
  if (key === 'good' || key === 'success') return 'badge-good';
  return 'badge-neutral';
}

function deltaClass(amount) {
  if (amount > 0) return 'delta-positive';
  if (amount < 0) return 'delta-negative';
  return 'delta-neutral';
}

function statusClass(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'closed') return 'badge-good';
  if (key === 'open') return 'badge-warning';
  if (key.includes('missing')) return 'badge-danger';
  return 'badge-neutral';
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return '"' + text.replaceAll('"', '""') + '"';
  }
  return text;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((key) => csvEscape(row[key])).join(','));
  }
  return lines.join('\n');
}

function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function readJsonResponseOrThrow(res, fallbackMessage) {
  return res.json().catch(() => {
    throw new Error(fallbackMessage);
  });
}

function renderSummaryCards(totals) {
  return (
    '<section class="reports-summary-grid">' +
    '<article class="card trend-card"><div class="metric-label">Average Budget Income</div><div class="metric-value">' + escapeHtml(money(totals.averageBudgetIncome)) + '</div></article>' +
    '<article class="card trend-card"><div class="metric-label">Average Recurring Bills Due</div><div class="metric-value">' + escapeHtml(money(totals.averageRecurringBillsDue)) + '</div></article>' +
    '<article class="card trend-card"><div class="metric-label">Average Actual Expenses</div><div class="metric-value">' + escapeHtml(money(totals.averageActualExpenses)) + '</div></article>' +
    '<article class="card trend-card"><div class="metric-label">Average Cash Remaining</div><div class="metric-value">' + escapeHtml(money(totals.averageCashRemaining)) + '</div></article>' +
    '<article class="card trend-card"><div class="metric-label">Average Safe to Spend</div><div class="metric-value">' + escapeHtml(money(totals.averageSafeToSpend)) + '</div></article>' +
    '<article class="card trend-card"><div class="metric-label">Periods Over Budget</div><div class="metric-value">' + escapeHtml(String(totals.periodsOverBudget || 0)) + '</div></article>' +
    '</section>'
  );
}

function renderCssBars(rows, field, label) {
  const max = Math.max(1, ...rows.map((row) => Math.abs(toNumber(row[field], 0))));
  return rows.map((row) => {
    const value = toNumber(row[field], 0);
    const width = Math.min(100, Math.abs(value) / max * 100);
    return (
      '<div class="css-bar-row">' +
      '<span>' + escapeHtml(row.periodLabel) + '</span>' +
      '<div class="mini-bar-track"><div class="mini-bar-fill' + (value < 0 ? ' mini-bar-negative' : '') + '" style="width:' + width.toFixed(1) + '%"></div></div>' +
      '<strong title="' + escapeHtml(label) + '">' + escapeHtml(money(value)) + '</strong>' +
      '</div>'
    );
  }).join('');
}

function renderOverviewTable(periods = []) {
  const rows = periods.map((row) => (
    '<tr data-action="reports-open-period" data-period-id="' + escapeHtml(row.periodId) + '">' +
    '<td>' + escapeHtml(row.periodLabel) + '</td>' +
    '<td><span class="' + statusClass(row.status) + '">' + escapeHtml(row.status) + '</span></td>' +
    '<td>' + escapeHtml(money(row.budgetIncome)) + '</td>' +
    '<td>' + escapeHtml(money(row.recurringBillsDue)) + '</td>' +
    '<td>' + escapeHtml(money(row.actualExpenseSpending)) + '</td>' +
    '<td>' + escapeHtml(money(row.plannedTransfersTotal)) + '</td>' +
    '<td>' + escapeHtml(money(row.cashRemaining)) + '</td>' +
    '<td>' + escapeHtml(money(row.safeToSpend)) + '</td>' +
    '<td>' + escapeHtml((row.issues || []).join(', ') || 'None') + '</td>' +
    '</tr>'
  )).join('');

  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Pay Period Overview</h3></div>' +
    '<div class="table-wrap"><table class="table trend-table"><thead><tr>' +
    '<th>Period</th><th>Status</th><th>Income</th><th>Bills Due</th><th>Expenses</th><th>Transfers</th><th>Cash Remaining</th><th>Safe to Spend</th><th>Issues</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '</section>'
  );
}

function renderIncomeTrend(incomeTrends, incomeStats) {
  const avg = toNumber(incomeStats.averageIncome, 0);
  const latest = incomeTrends[0] || null;
  const variance = latest ? toNumber(latest.budgetIncome, 0) - avg : 0;
  const bonusPeriods = incomeTrends.filter((row) => toNumber(row.bonusIncome, 0) > 0).length;
  const prior = incomeTrends[1] || null;
  const paycheckDelta = prior ? toNumber(latest?.regularPaycheck, 0) - toNumber(prior.regularPaycheck, 0) : 0;

  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Income Trend</h3></div>' +
    '<div class="reports-two-col">' +
    '<div>' + renderCssBars(incomeTrends, 'budgetIncome', 'Budget Income') + '</div>' +
    '<div class="action-list">' +
    '<div class="action-row"><span>Average income</span><strong>' + escapeHtml(money(avg)) + '</strong></div>' +
    '<div class="action-row"><span>Highest period</span><strong>' + escapeHtml(incomeStats.highestIncomePeriod?.periodLabel || 'N/A') + '</strong></div>' +
    '<div class="action-row"><span>Lowest period</span><strong>' + escapeHtml(incomeStats.lowestIncomePeriod?.periodLabel || 'N/A') + '</strong></div>' +
    '<div class="action-row"><span>Variance this period</span><strong class="' + deltaClass(variance) + '">' + escapeHtml(signedMoney(variance)) + '</strong></div>' +
    '<div class="action-row"><span>Bonus appeared</span><strong>' + escapeHtml(String(bonusPeriods)) + ' of ' + escapeHtml(String(incomeTrends.length)) + '</strong></div>' +
    '<div class="action-row"><span>Regular paycheck change</span><strong class="' + deltaClass(paycheckDelta) + '">' + escapeHtml(signedMoney(paycheckDelta)) + '</strong></div>' +
    '</div>' +
    '</div>' +
    '</section>'
  );
}

function renderRecurringBillsTrend(rows) {
  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Recurring Bills Trend</h3></div>' +
    '<div class="table-wrap"><table class="table trend-table"><thead><tr><th>Period</th><th>Due</th><th>Paid</th><th>Unpaid</th><th>Bill Count</th><th>Paid Count</th><th>Unpaid Count</th></tr></thead><tbody>' +
    rows.map((row) => (
      '<tr>' +
      '<td>' + escapeHtml(row.periodLabel) + '</td>' +
      '<td>' + escapeHtml(money(row.recurringBillsDue)) + '</td>' +
      '<td>' + escapeHtml(money(row.recurringBillsPaid)) + '</td>' +
      '<td>' + escapeHtml(money(row.recurringBillsLeftToPay)) + '</td>' +
      '<td>' + escapeHtml(String(row.billCount || 0)) + '</td>' +
      '<td>' + escapeHtml(String(row.paidCount || 0)) + '</td>' +
      '<td>' + escapeHtml(String(row.unpaidCount || 0)) + '</td>' +
      '</tr>'
    )).join('') +
    '</tbody></table></div>' +
    '</section>'
  );
}

function renderExpenseTrend(periods) {
  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Expense Trend</h3></div>' +
    '<div class="table-wrap"><table class="table trend-table"><thead><tr><th>Period</th><th>Expense Budget</th><th>Actual Expenses</th><th>Remaining</th><th>Over Budget Categories</th></tr></thead><tbody>' +
    periods.map((row) => {
      const variance = toNumber(row.expenseBudget, 0) - toNumber(row.actualExpenseSpending, 0);
      return (
        '<tr>' +
        '<td>' + escapeHtml(row.periodLabel) + '</td>' +
        '<td>' + escapeHtml(money(row.expenseBudget)) + '</td>' +
        '<td>' + escapeHtml(money(row.actualExpenseSpending)) + '</td>' +
        '<td class="' + deltaClass(variance) + '">' + escapeHtml(signedMoney(variance)) + '</td>' +
        '<td>' + escapeHtml(String(row.overBudgetCategoryCount || 0)) + '</td>' +
        '</tr>'
      );
    }).join('') +
    '</tbody></table></div>' +
    '</section>'
  );
}

function renderCategoryTrends(summaryRows) {
  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Category Trends</h3></div>' +
    '<div class="table-wrap"><table class="table trend-table"><thead><tr><th>Category</th><th>Average Budget</th><th>Average Actual</th><th>Average Remaining</th><th>Times Over Budget</th><th>Worst Period</th><th>Trend</th></tr></thead><tbody>' +
    summaryRows.map((row) => (
      '<tr>' +
      '<td>' + escapeHtml(row.category) + '</td>' +
      '<td>' + escapeHtml(money(row.averageBudget)) + '</td>' +
      '<td>' + escapeHtml(money(row.averageActual)) + '</td>' +
      '<td class="' + deltaClass(row.averageRemaining) + '">' + escapeHtml(signedMoney(row.averageRemaining)) + '</td>' +
      '<td>' + escapeHtml(String(row.timesOverBudget || 0)) + '</td>' +
      '<td>' + escapeHtml(row.worstPeriod || 'N/A') + '</td>' +
      '<td>' + escapeHtml(row.trend || 'No data') + '</td>' +
      '</tr>'
    )).join('') +
    '</tbody></table></div>' +
    '</section>'
  );
}

function renderTransferTrends(rows) {
  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Transfer Trends</h3></div>' +
    '<div class="table-wrap"><table class="table trend-table"><thead><tr><th>Period</th><th>Target</th><th>Planned</th><th>Completed</th><th>Missing</th><th>Overpaid</th><th>Completion Rate</th></tr></thead><tbody>' +
    rows.map((row) => (
      '<tr>' +
      '<td>' + escapeHtml(row.periodLabel) + '</td>' +
      '<td>' + escapeHtml(row.targetLabel) + '</td>' +
      '<td>' + escapeHtml(money(row.plannedAmount)) + '</td>' +
      '<td>' + escapeHtml(money(row.completedAmount)) + '</td>' +
      '<td class="' + deltaClass(-toNumber(row.shortfall, 0)) + '">' + escapeHtml(money(row.shortfall)) + '</td>' +
      '<td>' + escapeHtml(money(row.overpaid)) + '</td>' +
      '<td>' + escapeHtml(pct(row.completionRate)) + '</td>' +
      '</tr>'
    )).join('') +
    '</tbody></table></div>' +
    '</section>'
  );
}

function renderSafeMoneyTrend(periods) {
  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Safe Money Trend</h3></div>' +
    '<div class="table-wrap"><table class="table trend-table"><thead><tr><th>Period</th><th>Safe to Spend</th><th>Safe to Transfer</th><th>Safety Buffer Used</th><th>Confidence</th></tr></thead><tbody>' +
    periods.map((row) => (
      '<tr>' +
      '<td>' + escapeHtml(row.periodLabel) + '</td>' +
      '<td class="' + deltaClass(row.safeToSpend) + '">' + escapeHtml(money(row.safeToSpend)) + '</td>' +
      '<td class="' + deltaClass(row.safeToTransfer) + '">' + escapeHtml(money(row.safeToTransfer)) + '</td>' +
      '<td>' + escapeHtml(row.safeToSpend === null ? 'N/A' : 'Included') + '</td>' +
      '<td>' + (row.dataHealthWarning ? '<span class="badge-warning">Low confidence</span>' : '<span class="badge-good">Normal</span>') + '</td>' +
      '</tr>'
    )).join('') +
    '</tbody></table></div>' +
    '</section>'
  );
}

function renderBillReliability(rows) {
  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Bill Reliability</h3></div>' +
    '<div class="table-wrap"><table class="table trend-table"><thead><tr><th>Bill</th><th>Expected Amount</th><th>Paid on Time</th><th>Missed</th><th>Autopay Match Rate</th><th>Avg Amount Difference</th><th>Last Paid</th><th>Status</th></tr></thead><tbody>' +
    rows.map((row) => (
      '<tr>' +
      '<td>' + escapeHtml(row.billName) + '</td>' +
      '<td>' + escapeHtml(money(row.expectedAmount)) + '</td>' +
      '<td>' + escapeHtml(String(row.paidOnTimeCount || 0)) + '</td>' +
      '<td>' + escapeHtml(String(row.missedCount || 0)) + '</td>' +
      '<td>' + escapeHtml(pct(row.autopayMatchRate || 0)) + '</td>' +
      '<td>' + escapeHtml(money(row.averageAmountDifference || 0)) + '</td>' +
      '<td>' + escapeHtml(row.lastPaidDate || 'N/A') + '</td>' +
      '<td>' + escapeHtml(row.status || 'Reliable') + '</td>' +
      '</tr>'
    )).join('') +
    '</tbody></table></div>' +
    '</section>'
  );
}

function renderBiggestChanges(periods) {
  const current = periods[0];
  const previous = periods[1];
  if (!current || !previous) {
    return '<section class="card trend-card"><div class="card-header"><h3 class="card-title">Biggest Changes</h3></div><p class="empty-state">Need at least two periods to compare.</p></section>';
  }

  const candidates = [
    { label: 'Income', key: 'budgetIncome' },
    { label: 'Bills', key: 'recurringBillsDue' },
    { label: 'Expenses', key: 'actualExpenseSpending' },
    { label: 'Safe to Spend', key: 'safeToSpend' },
    { label: 'Transfer plan', key: 'plannedTransfersTotal' },
  ].map((item) => {
    const a = toNumber(current[item.key], 0);
    const b = toNumber(previous[item.key], 0);
    const amount = a - b;
    const pctDiff = Math.abs(b) < 0.0001 ? 0 : Math.abs(amount / b) * 100;
    return {
      label: item.label,
      amount,
      pctDiff,
      meaningful: Math.abs(amount) >= 25 || pctDiff >= 15,
    };
  }).filter((item) => item.meaningful)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Biggest Changes</h3></div>' +
    (candidates.length
      ? '<div class="action-list">' + candidates.map((item) => (
          '<div class="action-row"><span>' + escapeHtml(item.label + ' changed') + '</span><strong class="' + deltaClass(item.amount) + '">' + escapeHtml(signedMoney(item.amount)) + '</strong></div>'
        )).join('') + '</div>'
      : '<p class="empty-state">No meaningful changes met the threshold ($25 or 15%).</p>') +
    '</section>'
  );
}

function renderInsights(insights) {
  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Insights</h3></div>' +
    '<div class="insight-list">' +
    insights.map((insight) => (
      '<article class="insight-card">' +
      '<div><span class="' + severityClass(insight.severity) + '">' + escapeHtml(insight.severity || 'info') + '</span></div>' +
      '<h4>' + escapeHtml(insight.title || 'Insight') + '</h4>' +
      '<p>' + escapeHtml(insight.message || '') + '</p>' +
      '<button class="button button-secondary button-sm" data-action="reports-open-tab" data-tab-id="' + escapeHtml(insight.actionTarget || 'dashboard') + '">' + escapeHtml(insight.actionLabel || 'Open') + '</button>' +
      '</article>'
    )).join('') +
    '</div>' +
    '</section>'
  );
}

function renderComparison(periods, comparisonData) {
  const options = periods.map((row) => '<option value="' + escapeHtml(row.periodId) + '">' + escapeHtml(row.periodLabel) + '</option>').join('');
  const deltas = comparisonData?.deltas || null;

  return (
    '<section class="card trend-card">' +
    '<div class="card-header"><h3 class="card-title">Period Comparison</h3></div>' +
    '<div class="reports-filter-bar">' +
    '<label>Period A <select id="reports-compare-a">' + options + '</select></label>' +
    '<label>Period B <select id="reports-compare-b">' + options + '</select></label>' +
    '<button class="button button-secondary" data-action="reports-compare-run">Compare</button>' +
    '</div>' +
    (deltas
      ? '<div class="table-wrap"><table class="table comparison-table"><thead><tr><th>Metric</th><th>Period A</th><th>Period B</th><th>Delta</th><th>%</th></tr></thead><tbody>' +
        Object.entries(deltas).map(([key, value]) => (
          '<tr>' +
          '<td>' + escapeHtml(key) + '</td>' +
          '<td>' + escapeHtml(money(value.a)) + '</td>' +
          '<td>' + escapeHtml(money(value.b)) + '</td>' +
          '<td class="' + deltaClass(value.amount) + '">' + escapeHtml(signedMoney(value.amount)) + '</td>' +
          '<td>' + escapeHtml(value.percent === null ? 'N/A' : pct(value.percent)) + '</td>' +
          '</tr>'
        )).join('') +
        '</tbody></table></div>'
      : '<p class="empty-state">Select two periods and run comparison.</p>') +
    '</section>'
  );
}

function mapActionTab(tabId) {
  const value = String(tabId || '').trim();
  if (!value) return 'dashboard';
  if (value === 'recurringBills') return 'recurring-bills';
  if (value === 'reports') return 'reports';
  return value;
}

function createOverviewCsv(periods) {
  return periods.map((row) => ({
    period: row.periodLabel,
    status: row.status,
    income: row.budgetIncome,
    billsDue: row.recurringBillsDue,
    expenses: row.actualExpenseSpending,
    transfers: row.plannedTransfersTotal,
    cashRemaining: row.cashRemaining,
    safeToSpend: row.safeToSpend,
    issues: (row.issues || []).join('; '),
  }));
}

function createCategoryCsv(rows) {
  return rows.map((row) => ({
    period: row.periodLabel,
    category: row.category,
    budget: row.budget,
    actual: row.actual,
    remaining: row.remaining,
    overBudget: row.overBudget ? 'yes' : 'no',
  }));
}

function createBillCsv(rows) {
  return rows.map((row) => ({
    period: row.periodLabel,
    due: row.recurringBillsDue,
    paid: row.recurringBillsPaid,
    unpaid: row.recurringBillsLeftToPay,
    billCount: row.billCount,
    paidCount: row.paidCount,
    unpaidCount: row.unpaidCount,
  }));
}

function createTransferCsv(rows) {
  return rows.map((row) => ({
    period: row.periodLabel,
    target: row.targetLabel,
    planned: row.plannedAmount,
    completed: row.completedAmount,
    shortfall: row.shortfall,
    overpaid: row.overpaid,
    completionRate: row.completionRate,
  }));
}

export async function renderReports(container, period, options = {}) {
  container.innerHTML = '<section class="card"><p class="empty-state">Loading reports...</p></section>';

  const ccSettings = await loadCommandCenterSettings().catch(() => null);
  const rptFeat = (key) => isFeatureEnabled(ccSettings, 'reports', key);

  const state = {
    filter: '12',
    includeCurrent: true,
    customLimit: 12,
    summary: null,
    category: null,
    bills: null,
    transfers: null,
    income: null,
    comparison: null,
    error: '',
  };

  async function loadReports() {
    const limit = state.filter === '6' ? 6 : state.filter === '12' ? 12 : state.filter === 'ytd' ? 24 : Math.max(1, Math.min(36, toNumber(state.customLimit, 12)));
    const query = '?limit=' + encodeURIComponent(limit) + '&includeCurrent=' + encodeURIComponent(state.includeCurrent ? 'true' : 'false') + '&currentPeriodId=' + encodeURIComponent(period?.id || '');

    const [summaryRes, categoryRes, billsRes, transferRes, incomeRes] = await Promise.all([
      fetch(BACKEND + '/api/reports/summary' + query),
      fetch(BACKEND + '/api/reports/category-trends' + query),
      fetch(BACKEND + '/api/reports/bill-trends' + query),
      fetch(BACKEND + '/api/reports/transfer-trends' + query),
      fetch(BACKEND + '/api/reports/income-trends' + query),
    ]);

    const summary = await readJsonResponseOrThrow(summaryRes, 'Reports could not be loaded.');
    const category = await readJsonResponseOrThrow(categoryRes, 'Reports could not be loaded.');
    const bills = await readJsonResponseOrThrow(billsRes, 'Reports could not be loaded.');
    const transfers = await readJsonResponseOrThrow(transferRes, 'Reports could not be loaded.');
    const income = await readJsonResponseOrThrow(incomeRes, 'Reports could not be loaded.');

    if (!summaryRes.ok || !categoryRes.ok || !billsRes.ok || !transferRes.ok || !incomeRes.ok) {
      throw new Error(summary.error || category.error || bills.error || transfers.error || income.error || 'Reports could not be loaded.');
    }

    state.summary = summary;
    state.category = category;
    state.bills = bills;
    state.transfers = transfers;
    state.income = income;
  }

  async function runComparison() {
    const a = document.getElementById('reports-compare-a')?.value;
    const b = document.getElementById('reports-compare-b')?.value;
    if (!a || !b) return;
    const response = await fetch(BACKEND + '/api/reports/period-comparison?periodA=' + encodeURIComponent(a) + '&periodB=' + encodeURIComponent(b));
    const data = await readJsonResponseOrThrow(response, 'Reports could not be loaded.');
    if (!response.ok) throw new Error(data.error || 'Reports could not be loaded.');
    state.comparison = data;
  }

  function renderBody() {
    if (state.error) {
      container.innerHTML = '<section class="card"><div class="error-card">' + escapeHtml(state.error) + '</div></section>';
      return;
    }

    const summary = state.summary;
    const periods = summary?.periods || [];

    if (!periods.length) {
      container.innerHTML = '<section class="card reports-page"><p class="empty-state">No saved pay period snapshots yet. Close or save a period to start reports.</p></section>';
      return;
    }

    const content =
      '<div class="reports-page">' +
      '<section class="card reports-filter-bar">' +
      '<label>Range <select id="reports-range-filter">' +
      '<option value="6" ' + (state.filter === '6' ? 'selected' : '') + '>Last 6 pay periods</option>' +
      '<option value="12" ' + (state.filter === '12' ? 'selected' : '') + '>Last 12 pay periods</option>' +
      '<option value="ytd" ' + (state.filter === 'ytd' ? 'selected' : '') + '>Year to date</option>' +
      '<option value="custom" ' + (state.filter === 'custom' ? 'selected' : '') + '>Custom range</option>' +
      '</select></label>' +
      '<label>Custom count <input id="reports-custom-limit" type="number" min="1" max="36" value="' + escapeHtml(String(state.customLimit)) + '"></label>' +
      '<label><input id="reports-include-current" type="checkbox" ' + (state.includeCurrent ? 'checked' : '') + '> Include current open period</label>' +
      '<button class="button button-secondary" data-action="reports-refresh">Refresh</button>' +
      (rptFeat('showExportTools') ? '<button class="button button-secondary" data-action="reports-export-json">Export Report JSON</button>' : '') +
      (rptFeat('showExportTools') ? '<button class="button button-secondary" data-action="reports-export-csv">Export Report CSV</button>' : '') +
      '</section>' +
      renderSummaryCards(summary.totals || {}) +
      renderOverviewTable(periods) +
      (rptFeat('showIncomeReports') ? renderIncomeTrend(state.income?.rows || [], state.income?.stats || {}) : '') +
      renderRecurringBillsTrend(state.bills?.rows || []) +
      (rptFeat('showSpendingTrends') ? renderExpenseTrend(periods) : '') +
      (rptFeat('showCategoryReports') ? renderCategoryTrends(state.category?.summary || []) : '') +
      renderTransferTrends(state.transfers?.rows || []) +
      renderSafeMoneyTrend(periods) +
      renderBillReliability(state.bills?.reliability || []) +
      renderBiggestChanges(periods) +
      renderInsights(summary.insights || []) +
      renderComparison(periods, state.comparison) +
      '</div>';

    container.innerHTML = content;

    container.querySelector('[data-action="reports-refresh"]')?.addEventListener('click', async () => {
      state.filter = document.getElementById('reports-range-filter')?.value || '12';
      state.includeCurrent = !!document.getElementById('reports-include-current')?.checked;
      state.customLimit = toNumber(document.getElementById('reports-custom-limit')?.value, 12);
      state.error = '';
      container.innerHTML = '<section class="card"><p class="empty-state">Loading reports...</p></section>';
      try {
        await loadReports();
        renderBody();
      } catch (err) {
        state.error = err.message.includes('Failed to fetch')
          ? 'Backend not reachable through the local API proxy.'
          : 'Reports could not be loaded.';
        renderBody();
      }
    });

    container.querySelector('[data-action="reports-export-json"]')?.addEventListener('click', () => {
      const payload = {
        summary: state.summary,
        category: state.category,
        bills: state.bills,
        transfers: state.transfers,
        income: state.income,
        comparison: state.comparison,
        generatedAt: new Date().toISOString(),
      };
      downloadText('reports.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    });

    container.querySelector('[data-action="reports-export-csv"]')?.addEventListener('click', () => {
      const overviewCsv = toCsv(createOverviewCsv(state.summary?.periods || []));
      const categoryCsv = toCsv(createCategoryCsv(state.category?.rows || []));
      const billCsv = toCsv(createBillCsv(state.bills?.rows || []));
      const transferCsv = toCsv(createTransferCsv(state.transfers?.rows || []));

      downloadText('pay-period-overview.csv', overviewCsv, 'text/csv;charset=utf-8');
      downloadText('category-trends.csv', categoryCsv, 'text/csv;charset=utf-8');
      downloadText('bill-trends.csv', billCsv, 'text/csv;charset=utf-8');
      downloadText('transfer-trends.csv', transferCsv, 'text/csv;charset=utf-8');
    });

    container.querySelectorAll('[data-action="reports-open-tab"]').forEach((button) => {
      button.addEventListener('click', () => {
        const tabId = mapActionTab(button.getAttribute('data-tab-id'));
        if (tabId && typeof options.onOpenTab === 'function') {
          options.onOpenTab(tabId);
        }
      });
    });

    container.querySelectorAll('[data-action="reports-open-period"]').forEach((rowEl) => {
      rowEl.addEventListener('click', () => {
        const periodId = rowEl.getAttribute('data-period-id');
        if (!periodId) return;
        if (typeof options.onSelectPeriod === 'function') {
          options.onSelectPeriod(periodId);
        }
      });
    });

    container.querySelector('[data-action="reports-compare-run"]')?.addEventListener('click', async () => {
      try {
        await runComparison();
        renderBody();
      } catch (err) {
        state.error = err.message.includes('Failed to fetch')
          ? 'Backend not reachable through the local API proxy.'
          : 'Reports could not be loaded.';
        renderBody();
      }
    });
  }

  try {
    await loadReports();
    renderBody();
  } catch (err) {
    state.error = err.message.includes('Failed to fetch')
      ? 'Backend not reachable through the local API proxy.'
      : 'Reports could not be loaded.';
    renderBody();
  }
}
