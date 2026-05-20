/**
 * Expenses page — category spending tracker with budget vs actual.
 */

import { escapeHtml } from '../utils/dom.js';
import { formatCurrency, formatSignedCurrency, getPeriodLabel } from '../utils/formatters.js';
import { isDateInBudgetPeriod } from '../utils/budgetPeriods.js';
import { getTransactionRowsForPeriod } from '../api/transactionsApi.js';
import { getMasterLists, getMasterListsCache } from '../api/masterListsApi.js';
import { getSetting } from '../api/settingsApi.js';
import { fetchCloseoutRecord } from '../utils/closeoutClient.js';
import { getActivePeriod } from '../app/appState.js';
import { emitAppEvent } from '../app/events.js';
import { loadCommandCenterSettings, isFeatureEnabled } from '../utils/commandCenter.js';
import { getExpenseFundingRecords } from '../api/expenseFundingApi.js';

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

function isExpenseTransaction(row, period, includePendingTransactions = false) {
  if ((row.type || '') !== 'Expense') return false;
  if (row.ignored) return false;
  if (!includePendingTransactions && row.pending) return false;
  return isDateInBudgetPeriod(row.date, period);
}

/**
 * Get expense items from a transaction, considering splits.
 * If the transaction has final splits, returns the split items.
 * Otherwise, returns the parent transaction if it's an expense type.
 */
function getExpenseItemsFromTransaction(tx, period, includePendingTransactions = false) {
  const parentEligible = isExpenseTransaction(tx, period, includePendingTransactions);
  if (!parentEligible) return [];

  const hasFinalSplits = Array.isArray(tx.split_lines) && tx.split_lines.length > 0 && tx.split_is_final;

  if (hasFinalSplits) {
    // Return the split lines as expense items
    return tx.split_lines.map((split) => ({
      date: tx.date,
      amount: Number(split.amount || 0),
      category: String(split.category || ''),
      name: tx.name,
      merchant_name: tx.merchant_name,
      account_name: tx.account_name,
      is_split: true,
    }));
  }
  
  // Return the parent transaction if it's an expense type and not ignored
  if (parentEligible) {
    return [{
      date: tx.date,
      amount: Number(tx.amount || 0),
      category: String(tx.category || ''),
      name: tx.name,
      merchant_name: tx.merchant_name,
      account_name: tx.account_name,
      is_split: false,
    }];
  }
  
  return [];
}

function getUncategorizedSplitReviewItems(tx, period, includePendingTransactions, activeCategoryLookup) {
  if (!isExpenseTransaction(tx, period, includePendingTransactions)) return [];
  if (!tx.split_is_final || !Array.isArray(tx.split_lines) || tx.split_lines.length === 0) return [];

  return tx.split_lines
    .map((split, index) => {
      const category = String(split?.category || '').trim();
      const key = normalizeExpenseCategoryKey(category);
      const uncategorized = !key || key === 'uncategorized' || !activeCategoryLookup.has(key);
      if (!uncategorized) return null;
      return {
        id: String(tx.id || '') + '::split::' + String(index),
        reviewTransactionId: tx.id,
        date: tx.date,
        name: (tx.name || tx.merchant_name || 'Split expense') + ' (Split)',
        amount: -Math.abs(Number(split?.amount || 0)),
        category: category || '',
        is_split: true,
      };
    })
    .filter(Boolean);
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

function renderSummaryCard(item) {
  const toneClass = item.tone ? ' stat-card--' + item.tone : '';
  return (
    '<article class="card stat-card' + toneClass + '"><p class="card-description">' + escapeHtml(item.label) +
    '</p><h3 class="card-title">' + escapeHtml(item.value) + '</h3></article>'
  );
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
  const ccSettings = await loadCommandCenterSettings().catch(() => null);
  const expFeat = (key) => isFeatureEnabled(ccSettings, 'expenses', key);
  const safeMoneySettings = await getSetting('safe_money_settings').catch(() => ({}));
  const includePendingTransactions =
    safeMoneySettings?.includePendingTransactions === true || safeMoneySettings?.include_pending_transactions === true;

  const listsData = await getMasterLists(false);
  if (!listsData.loaded) {
    const msg = (listsData.error || '').includes('Backend not running')
      ? 'Backend not reachable through the local API proxy.'
      : 'Expense categories could not be loaded.';
    body.innerHTML = '<section class="card"><div class="error-card">' + escapeHtml(msg) + '</div></section>';
    return;
  }

  let transactions;
  try {
    transactions = await getTransactionRowsForPeriod(period);
  } catch (err) {
    const msg = String(err.message || '').includes('Failed to fetch')
      ? 'Backend not reachable through the local API proxy.'
      : 'Transactions could not be loaded.';
    body.innerHTML =
      '<section class="card"><div class="error-card">' + escapeHtml(msg) +
      '<br><small>' + escapeHtml(err.message) + '</small></div></section>';
    return;
  }

  let expenseFundingRecords = [];
  let expenseFundingError = '';
  try {
    const fundingData = await getExpenseFundingRecords(period.id);
    expenseFundingRecords = Array.isArray(fundingData?.records) ? fundingData.records : [];
  } catch (err) {
    console.error('Expenses: failed loading expense funding records:', err);
    expenseFundingError = String(err.message || '').includes('Failed to fetch')
      ? 'Backend not reachable through the local API proxy.'
      : 'Expense funding records could not be loaded.';
  }

  const cache = getMasterListsCache();
  const expenseCategories = getActiveExpenseCategories(cache);
  const categoryLookup = buildExpenseCategoryLookup(expenseCategories);

  // Build category totals considering both regular and split transactions
  const categoryTotals = new Map();
  let totalActualSpent = 0;
  
  for (const tx of transactions) {
    const expenseItems = getExpenseItemsFromTransaction(tx, period, includePendingTransactions);
    for (const item of expenseItems) {
      const key = normalizeExpenseCategoryKey(item.category);
      if (!categoryLookup.has(key)) continue;
      const amount = Math.abs(item.amount);
      categoryTotals.set(key, (categoryTotals.get(key) || 0) + amount);
      totalActualSpent += amount;
    }
  }

  const categoryRows = expenseCategories.map((cat) => {
    const actualSpent = categoryTotals.get(cat.key) || 0;
    const budgetAmount = cat.budgetAmount;
    const remaining = budgetAmount - actualSpent;
    const usageRatio = budgetAmount > 0 ? (actualSpent / budgetAmount) : (actualSpent > 0 ? 999 : 0);
    const progress = budgetAmount > 0 ? Math.min(usageRatio, 1) : (actualSpent > 0 ? 1 : 0);
    const status = budgetAmount <= 0
      ? 'No budget'
      : remaining < 0
        ? 'Over by ' + formatCurrency(Math.abs(remaining))
        : 'Left ' + formatCurrency(remaining);
    return { ...cat, actualSpent, remaining, progress, usageRatio, status };
  });

  const sortedCategoryRows = [...categoryRows].sort((a, b) => {
    if (b.usageRatio !== a.usageRatio) return b.usageRatio - a.usageRatio;
    if (b.actualSpent !== a.actualSpent) return b.actualSpent - a.actualSpent;
    return a.name.localeCompare(b.name);
  });

  const totalExpenseBudget = expenseCategories.reduce((sum, c) => sum + c.budgetAmount, 0);
  const totalRemaining = totalExpenseBudget - totalActualSpent;
  const categoriesOverBudget = categoryRows.filter((r) => r.budgetAmount > 0 && r.actualSpent > r.budgetAmount).length;
  const activeExpenseFundingRecords = expenseFundingRecords.filter((record) => !['cancelled', 'not_needed'].includes(String(record.status || '').toLowerCase()));
  const confirmedFundingTotal = activeExpenseFundingRecords.reduce((sum, record) => sum + Number(record.confirmedAmount || 0), 0);
  const fundingRemaining = confirmedFundingTotal - totalActualSpent;
  const fundingShortfall = Math.max(0, totalExpenseBudget - confirmedFundingTotal);

  // For uncategorized, skip transactions that have final splits (they're now represented by split lines)
  const expenseTransactions = transactions.filter((row) => {
    const hasFinalSplits = Array.isArray(row.split_lines) && row.split_lines.length > 0 && row.split_is_final;
    return !hasFinalSplits && isExpenseTransaction(row, period, includePendingTransactions);
  });

  const uncategorizedBase = transactions
    .filter((r) => isDateInBudgetPeriod(r.date, period) && !r.ignored)
    .filter((r) => includePendingTransactions || !r.pending)
    .filter((r) => !(Array.isArray(r.split_lines) && r.split_lines.length > 0 && r.split_is_final))
    .filter((r) => isTransactionNeedsReview(r) || isTransactionUncategorizedExpense(r, categoryLookup))
    .sort(sortByDateDesc);

  const uncategorizedSplitItems = transactions
    .flatMap((tx) => getUncategorizedSplitReviewItems(tx, period, includePendingTransactions, categoryLookup))
    .sort(sortByDateDesc);

  const uncategorized = [...uncategorizedBase, ...uncategorizedSplitItems];
  const uniqueUncategorized = [];
  const seen = new Set();
  for (const r of uncategorized) {
    const reviewKey = String(r.id || '') + '::' + String(r.reviewTransactionId || '');
    if (seen.has(reviewKey)) continue;
    seen.add(reviewKey);
    uniqueUncategorized.push(r);
  }

  const expenseLogRows = [];
  for (const tx of expenseTransactions) {
    expenseLogRows.push(tx);
  }
  // Also add split transactions as individual entries
  for (const tx of transactions) {
    const hasFinalSplits = Array.isArray(tx.split_lines) && tx.split_lines.length > 0 && tx.split_is_final;
    if (hasFinalSplits && isExpenseTransaction(tx, period, includePendingTransactions)) {
      for (const split of tx.split_lines) {
        expenseLogRows.push({
          date: tx.date,
          name: tx.name + ' (Split)',
          merchant_name: tx.merchant_name,
          category: split.category || 'Uncategorized',
          account_name: tx.account_name,
          amount: -Math.abs(Number(split.amount || 0)), // Negative to indicate expense
          pending: tx.pending,
          reviewed: true, // Splits are considered reviewed since they're finalized
          is_split: true,
        });
      }
    }
  }
  expenseLogRows.sort(sortByDateDesc);

  const summaryHtml = [
    { label: 'Total Expense Budget', value: formatCurrency(totalExpenseBudget) },
    {
      label: 'Available Funding',
      value: formatCurrency(confirmedFundingTotal),
      tone: confirmedFundingTotal >= totalExpenseBudget && totalExpenseBudget > 0 ? 'good' : '',
    },
    { label: 'Budget Remaining', value: formatSignedCurrency(totalRemaining) },
    { label: 'Funding Remaining', value: formatSignedCurrency(fundingRemaining) },
    { label: 'Actual Spent', value: formatCurrency(totalActualSpent) },
    {
      label: 'Funding Shortfall',
      value: fundingShortfall > 0 ? formatCurrency(fundingShortfall) : '$0.00',
      tone: fundingShortfall > 0 ? 'warning' : 'good',
    },
    { label: 'Categories Over Budget', value: String(categoriesOverBudget) },
  ].map(renderSummaryCard).join('');

  const fundingRecordRowsHtml = activeExpenseFundingRecords.length
    ? '<div class="expense-funding-records">' + activeExpenseFundingRecords.map((record) => (
        '<div class="expense-funding-record">' +
        '<strong>' + escapeHtml(record.sourceTargetName || record.sourceTargetId || 'Expense funding') + '</strong>' +
        '<span>' + escapeHtml(formatCurrency(record.confirmedAmount || 0)) + '</span>' +
        '<span>' + escapeHtml(record.status || 'transfer_confirmed') + '</span>' +
        '</div>'
      )).join('') + '</div>'
    : '<p class="empty-state">No confirmed expense funding records for this period.</p>';

  const expenseFundingHtml =
    '<section class="card expense-funding-card">' +
    '<div class="card-header"><h3 class="card-title">Expense Funding Records</h3>' +
    '<p class="card-description">' + escapeHtml(activeExpenseFundingRecords.length + ' confirmed funding record' + (activeExpenseFundingRecords.length === 1 ? '' : 's')) + '</p></div>' +
    (expenseFundingError ? '<div class="warning-message">' + escapeHtml(expenseFundingError) + '</div>' : '') +
    fundingRecordRowsHtml +
    '</section>';

  const categoryRowsHtml = sortedCategoryRows.length
    ? '<div class="expense-category-widgets">' + sortedCategoryRows.map((cat) => {
        const usagePercent = cat.budgetAmount > 0 ? (cat.usageRatio * 100) : 0;
        const usageLabel = cat.budgetAmount > 0
          ? (Math.round(usagePercent) + '% used')
          : 'No budget';
        const overBudget = cat.budgetAmount > 0 && cat.actualSpent > cat.budgetAmount;
        const nearlyFull = !overBudget && cat.budgetAmount > 0 && cat.usageRatio >= 0.85;
        const widgetTone = overBudget ? 'over' : (cat.budgetAmount <= 0 ? 'unbudgeted' : (nearlyFull ? 'watch' : 'healthy'));
        const statusLabel = overBudget
          ? 'Over budget'
          : (cat.budgetAmount <= 0 ? 'Unbudgeted' : (nearlyFull ? 'Almost full' : 'On track'));
        const balanceLabel = overBudget
          ? 'Over ' + formatCurrency(Math.abs(cat.remaining))
          : 'Left ' + formatCurrency(Math.abs(cat.remaining));
        return (
          '<article class="card expense-category-widget expense-category-widget--' + widgetTone + '">' +
          '<div class="expense-category-head">' +
          '<strong>' + escapeHtml(cat.name) + '</strong>' +
          '<span class="expense-status-pill expense-status-pill--' + widgetTone + '">' + escapeHtml(statusLabel) + '</span>' +
          '</div>' +
          '<div class="expense-widget-highlight">' +
          '<span class="expense-usage-pill">' + escapeHtml(usageLabel) + '</span>' +
          '<strong class="expense-balance-amount">' + escapeHtml(balanceLabel) + '</strong>' +
          '</div>' +
          '<div class="expense-progress-bar"><span class="expense-progress-fill" style="width:' +
          Math.max(0, Math.min(cat.progress * 100, 100)) + '%"></span></div>' +
          '<div class="expense-widget-stats">' +
          '<div class="expense-mini-stat"><span>Budget</span><strong>' + escapeHtml(formatCurrency(cat.budgetAmount)) + '</strong></div>' +
          '<div class="expense-mini-stat"><span>Actual</span><strong>' + escapeHtml(formatCurrency(cat.actualSpent)) + '</strong></div>' +
          '<div class="expense-mini-stat"><span>Remaining</span><strong>' + escapeHtml(formatSignedCurrency(cat.remaining)) + '</strong></div>' +
          '<div class="expense-mini-stat"><span>Usage</span><strong>' + escapeHtml(usageLabel) + '</strong></div>' +
          '</div>' +
          '<div class="expense-category-meta">' +
          '<span>' + escapeHtml(cat.status) + '</span>' +
          '</div>' +
          '</article>'
        );
      }).join('') + '</div>'
    : '<p class="empty-state">No active expense categories have been created yet.</p>';

  const reviewRowsHtml = uniqueUncategorized.length
    ? '<div class="expenses-review-list">' + uniqueUncategorized.map((row) =>
        '<div class="expense-review-item">' +
        '<div><strong>' + escapeHtml(row.date || '-') + '</strong><br><span>' + escapeHtml(row.name || '-') + '</span></div>' +
        '<div class="expense-review-amount">' + escapeHtml(formatSignedCurrency(row.amount)) + '</div>' +
          '<div class="inline-actions"><button type="button" class="button button-secondary button-sm" data-action="expense-review-transaction" data-id="' + escapeHtml(row.reviewTransactionId || row.id) + '">Review</button></div>' +
        '</div>'
      ).join('') + '</div>'
    : '<div class="expenses-review-list"><p class="empty-state">No uncategorized transactions in this period.</p></div>';

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
    expenseFundingHtml +
    '<section class="expenses-layout">' +
    (expFeat('showExpenseCategoryManager') ?
      '<div class="expenses-category-panel">' +
      '<article class="card expenses-category-header-card">' +
      '<div class="card-header"><h3 class="card-title">Category Spending Tracker</h3>' +
      '<p class="card-description">Selected budget period: ' + escapeHtml(periodLabel) + '</p></div>' +
      '</article>' +
      categoryRowsHtml +
      '</div>' : '') +
    '<div class="expenses-bottom-row">' +
    '<article class="card expenses-log-card">' +
    '<div class="card-header"><h3 class="card-title">Expense Log for Selected Period</h3>' +
    '<p class="card-description">Type = Expense, ignored = false, within the selected budget period.</p></div>' +
    expenseLogHtml +
    '</article>' +
    (expFeat('showUncategorizedWarnings') ?
      '<aside class="expenses-side-column">' +
      '<article class="card expenses-review-card">' +
      '<div class="card-header"><h3 class="card-title">Uncategorized / Review Needed</h3>' +
      '<p class="card-description">' + uniqueUncategorized.length + ' transaction' + (uniqueUncategorized.length === 1 ? '' : 's') + '</p></div>' +
      reviewRowsHtml +
      '</article>' +
      '</aside>' : '') +
    '</div>' +
    '</section>';

  // Delegate expense-review-transaction → navigate to Transactions with pending review
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="expense-review-transaction"]');
    if (!btn) return;
    emitAppEvent('app:open-transaction-review', { transactionId: btn.dataset.id });
  });
}
