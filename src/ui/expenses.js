/**
 * Expenses page — category spending tracker with budget vs actual.
 */

import { escapeHtml } from '../utils/dom.js';
import { formatCurrency, formatSignedCurrency, getPeriodLabel } from '../utils/formatters.js';
import { isDateInBudgetPeriod } from '../utils/budgetPeriods.js';
import { getTransactions } from '../api/transactionsApi.js';
import { getMasterLists, getMasterListsCache } from '../api/masterListsApi.js';
import { fetchCloseoutRecord } from '../utils/closeoutClient.js';
import { getActivePeriod } from '../app/appState.js';
import { emitAppEvent } from '../app/events.js';
import { API_BASE } from '../api/client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeExpenseCategoryKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getActiveExpenseCategories(cache) {
  return (cache.expenseList || [])
    .filter((item) => item.active)
    .map((item) => ({
      ...item,
      budgetAmount: Number(item.budgetAmount || 0),
      key: normalizeExpenseCategoryKey(item.name),
    }))
    .filter((item) => item.key);
}

function buildExpenseCategoryLookup(categories) {
  const lookup = new Map();
  for (const item of categories) lookup.set(item.key, item);
  return lookup;
}

function isExpenseTransaction(row, period) {
  return (row.type || '') === 'Expense' && !row.ignored && isDateInBudgetPeriod(row.date, period);
}

function isTransactionNeedsReview(row) {
  return !(row.type || '').trim() && !row.reviewed && !row.ignored;
}

function isTransactionUncategorizedExpense(row, activeCategoryLookup) {
  if ((row.type || '') !== 'Expense' || row.ignored) return false;
  const key = normalizeExpenseCategoryKey(row.category);
  if (!key || key === 'uncategorized') return true;
  return !activeCategoryLookup.has(key);
}

function sortByDateDesc(a, b) {
  const aTime = new Date(a.date || 0).getTime();
  const bTime = new Date(b.date || 0).getTime();
  if (aTime !== bTime) return bTime - aTime;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function renderBadge(label, className) {
  return '<span class="' + className + '">' + escapeHtml(label) + '</span>';
}

// ── Public render ────────────────────────────────────────────────────────────

export async function renderExpenses(container) {
  const period = getActivePeriod();
  const periodLabel = getPeriodLabel(period);

  container.innerHTML =
    '<header class="page-header">' +
    '<div class="page-header-main"><h2 class="page-title">Expenses</h2>' +
    '<p class="page-description">Compare actual Plaid spending against expense category targets for the selected period.</p></div>' +
    '<div class="page-header-right"><span class="status-badge">' + escapeHtml(periodLabel) + '</span></div>' +
    '</header>' +
    '<div id="page-body" class="page-body"><section class="card"><p class="empty-state">Loading expenses...</p></section></div>';

  const body = document.getElementById('page-body');
  if (!body) return;

  let closeoutRecord = null;
  try { closeoutRecord = await fetchCloseoutRecord(period.id); } catch { closeoutRecord = null; }

  const listsData = await getMasterLists(false);
  if (!listsData.loaded) {
    const msg = (listsData.error || '').includes('Backend not running')
      ? 'Backend not running on ' + API_BASE + '.'
      : 'Expense categories could not be loaded.';
    body.innerHTML = '<section class="card"><div class="error-card">' + escapeHtml(msg) + '</div></section>';
    return;
  }

  let transactions;
  try {
    transactions = await getTransactions();
  } catch (err) {
    const msg = String(err.message || '').includes('Failed to fetch')
      ? 'Backend not running on ' + API_BASE + '.'
      : 'Transactions could not be loaded.';
    body.innerHTML =
      '<section class="card"><div class="error-card">' + escapeHtml(msg) +
      '<br><small>' + escapeHtml(err.message) + '</small></div></section>';
    return;
  }

  const cache = getMasterListsCache();
  const expenseCategories = getActiveExpenseCategories(cache);
  const categoryLookup = buildExpenseCategoryLookup(expenseCategories);
  const expenseTransactions = transactions.filter((row) => isExpenseTransaction(row, period));

  const categoryTotals = new Map();
  for (const tx of expenseTransactions) {
    const key = normalizeExpenseCategoryKey(tx.category);
    if (!categoryLookup.has(key)) continue;
    categoryTotals.set(key, (categoryTotals.get(key) || 0) + Math.abs(Number(tx.amount || 0)));
  }

  const categoryRows = expenseCategories.map((cat) => {
    const actualSpent = categoryTotals.get(cat.key) || 0;
    const budgetAmount = cat.budgetAmount;
    const remaining = budgetAmount - actualSpent;
    const progress = budgetAmount > 0 ? Math.min(actualSpent / budgetAmount, 1) : 0;
    const status = budgetAmount <= 0
      ? 'No budget'
      : remaining < 0
        ? 'Over by ' + formatCurrency(Math.abs(remaining))
        : 'Left ' + formatCurrency(remaining);
    return { ...cat, actualSpent, remaining, progress, status };
  });

  const totalExpenseBudget = expenseCategories.reduce((sum, c) => sum + c.budgetAmount, 0);
  const totalActualSpent = expenseTransactions.reduce((sum, r) => sum + Math.abs(Number(r.amount || 0)), 0);
  const totalRemaining = totalExpenseBudget - totalActualSpent;
  const categoriesOverBudget = categoryRows.filter((r) => r.budgetAmount > 0 && r.actualSpent > r.budgetAmount).length;

  const uncategorized = transactions
    .filter((r) => isDateInBudgetPeriod(r.date, period) && !r.ignored)
    .filter((r) => isTransactionNeedsReview(r) || isTransactionUncategorizedExpense(r, categoryLookup))
    .sort(sortByDateDesc);
  const uniqueUncategorized = [];
  const seen = new Set();
  for (const r of uncategorized) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    uniqueUncategorized.push(r);
  }

  const expenseLogRows = expenseTransactions.slice().sort(sortByDateDesc);

  const summaryHtml = [
    { label: 'Total Expense Budget', value: formatCurrency(totalExpenseBudget) },
    { label: 'Actual Spent', value: formatCurrency(totalActualSpent) },
    { label: 'Remaining', value: formatSignedCurrency(totalRemaining) },
    { label: 'Categories Over Budget', value: String(categoriesOverBudget) },
  ].map((item) =>
    '<article class="card stat-card"><p class="card-description">' + escapeHtml(item.label) +
    '</p><h3 class="card-title">' + escapeHtml(item.value) + '</h3></article>'
  ).join('');

  const categoryRowsHtml = categoryRows.length
    ? categoryRows.map((cat) =>
        '<div class="expense-category-row">' +
        '<div class="expense-category-main">' +
        '<div class="expense-category-head">' +
        '<strong>' + escapeHtml(cat.name) + '</strong>' +
        '<span>' + escapeHtml(formatCurrency(cat.budgetAmount)) + ' budget</span>' +
        '</div>' +
        '<div class="expense-progress-bar"><span class="expense-progress-fill" style="width:' +
        (cat.budgetAmount > 0 ? Math.min(cat.progress * 100, 100) : 0) + '%"></span></div>' +
        '<div class="expense-category-meta">' +
        '<span>Actual ' + escapeHtml(formatCurrency(cat.actualSpent)) + '</span>' +
        '<span>Remaining ' + escapeHtml(formatSignedCurrency(cat.remaining)) + '</span>' +
        '</div></div>' +
        '<div class="expense-category-status">' + escapeHtml(cat.status) + '</div>' +
        '</div>'
      ).join('')
    : '<p class="empty-state">No active expense categories have been created yet.</p>';

  const reviewRowsHtml = uniqueUncategorized.length
    ? uniqueUncategorized.map((row) =>
        '<div class="expense-review-item">' +
        '<div><strong>' + escapeHtml(row.date || '-') + '</strong><br><span>' + escapeHtml(row.name || '-') + '</span></div>' +
        '<div class="expense-review-amount">' + escapeHtml(formatSignedCurrency(row.amount)) + '</div>' +
        '<div class="inline-actions"><button class="button button-secondary button-sm" data-action="expense-review-transaction" data-id="' + escapeHtml(row.id) + '">Review</button></div>' +
        '</div>'
      ).join('')
    : '<p class="empty-state">No uncategorized transactions in this period.</p>';

  const expenseLogHtml = expenseLogRows.length
    ? '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>Date</th><th>Description</th><th>Merchant</th><th>Category</th><th>Account</th><th>Amount</th><th>Pending</th><th>Reviewed</th>' +
      '</tr></thead><tbody>' +
      expenseLogRows.map((row) =>
        '<tr>' +
        '<td>' + escapeHtml(row.date || '') + '</td>' +
        '<td>' + escapeHtml(row.name || '') + '</td>' +
        '<td>' + escapeHtml(row.merchant_name || '') + '</td>' +
        '<td>' + escapeHtml(row.category || 'Uncategorized') + '</td>' +
        '<td>' + escapeHtml(row.account_name || '') + '</td>' +
        '<td class="amount-positive">' + escapeHtml(formatCurrency(row.amount)) + '</td>' +
        '<td>' + (row.pending ? renderBadge('Pending', 'badge-pending') : '') + '</td>' +
        '<td>' + (row.reviewed ? renderBadge('Reviewed', 'badge-reviewed') : renderBadge('Needs Review', 'badge-warning')) + '</td>' +
        '</tr>'
      ).join('') +
      '</tbody></table></div>'
    : '<p class="empty-state">No reviewed expenses for this budget period.</p>';

  body.innerHTML =
    (closeoutRecord?.status === 'closed' ? '<div class="closeout-warning">This period is closed. Reopen it before changing closeout-related data.</div>' : '') +
    '<div class="summary-grid">' + summaryHtml + '</div>' +
    '<section class="expenses-grid">' +
    '<article class="card expenses-category-card">' +
    '<div class="card-header"><h3 class="card-title">Category Spending Tracker</h3>' +
    '<p class="card-description">Selected budget period: ' + escapeHtml(periodLabel) + '</p></div>' +
    categoryRowsHtml +
    '</article>' +
    '<article class="card expenses-review-card">' +
    '<div class="card-header"><h3 class="card-title">Uncategorized / Review Needed</h3>' +
    '<p class="card-description">' + uniqueUncategorized.length + ' transaction' + (uniqueUncategorized.length === 1 ? '' : 's') + '</p></div>' +
    reviewRowsHtml +
    '</article>' +
    '<article class="card expenses-log-card">' +
    '<div class="card-header"><h3 class="card-title">Expense Log for Selected Period</h3>' +
    '<p class="card-description">Type = Expense, ignored = false, within the selected budget period.</p></div>' +
    expenseLogHtml +
    '</article>' +
    '</section>';

  // Delegate expense-review-transaction → navigate to Transactions with pending review
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="expense-review-transaction"]');
    if (!btn) return;
    emitAppEvent('app:open-transaction-review', { transactionId: btn.dataset.id });
  });
}
