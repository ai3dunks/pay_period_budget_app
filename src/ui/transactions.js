/**
 * Transactions page — server-side paginated transactions with review and rules.
 */

import { escapeHtml } from '../utils/dom.js';
import { getTransactions, getTransactionById, patchTransaction, getTransactionSplits, saveTransactionSplits } from '../api/transactionsApi.js';
import { getMasterLists } from '../api/masterListsApi.js';
import { applyRules } from '../api/rulesApi.js';
import { getSetting } from '../api/settingsApi.js';
import { getActivePeriod } from '../app/appState.js';
import { getPeriodLabel } from '../utils/formatters.js';
import {
  getRuleEditorState,
  openRuleEditor,
  closeRuleEditor,
  renderRuleEditorModalHtml,
  setRuleEditorError,
  updateRuleEditorDraftField,
} from './rulesManager.js';
import { normalizeReviewDraft, renderReviewModalHtml } from './transactionReviewModal.js';
import { emitAppEvent } from '../app/events.js';
import { timeAsync, logRenderTime } from '../utils/performance.js';
import { getAccounts } from '../api/plaidApi.js';
import { loadCommandCenterSettings, isFeatureEnabled } from '../utils/commandCenter.js';

const TRANSACTION_TYPES_FOR_FILTER = ['Income', 'Expense', 'Bills', 'Wants', 'Transfer', 'Debt Payment', 'Ignore'];
const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];
const SEARCH_DEBOUNCE_MS = 300;

let _rows = [];
let _pagination = {
  limit: 100,
  offset: 0,
  total: 0,
  hasNext: false,
  hasPrevious: false,
  nextOffset: null,
  previousOffset: null,
};
let _filters = {
  search: '',
  accountId: '',
  type: '',
  reviewed: '',
  showIgnored: false,
  sort: 'date_desc',
};
let _limit = 100;
let _viewMode = 'period';
let _reviewModalTxId = null;
let _reviewModalRow = null;
let _reviewDraft = null;
let _txMessage = '';
let _txMessageType = 'success';
let _pendingReviewTxId = null;
let _loadError = null;
let _searchDebounceTimer = null;
let _legacyCompatibilityMode = false;
let _legacyWarningLogged = false;
let _accountTabs = [{ id: '', label: 'All accounts' }];
let _splitModalTxId = null;
let _splitDraftLines = [];
let _splitDraftIsFinal = false;
let _expandedSplitParentIds = new Set();
let _splitValidationMessage = '';
let _expenseCategoryOptions = [];
let _txCcSettings = null;
const ACCOUNT_TAB_LABELS_SETTING_KEY = 'account_tab_labels';

export function setPendingReviewTransactionId(id) {
  _pendingReviewTxId = id;
}

function _openReviewModalForTransaction(row) {
  if (!row?.id) return false;
  _reviewModalTxId = row.id;
  _reviewModalRow = row;
  _txMessage = '';
  _reviewDraft = normalizeReviewDraft(row, {
    type: row.type || 'Expense',
    category: row.category || '',
    notes: row.notes || '',
    reviewed: !!row.reviewed,
    ignored: !!row.ignored,
  });
  return true;
}

function _getReviewModalTransaction() {
  if (!_reviewModalTxId) return null;
  const pageRow = _rows.find((row) => row.id === _reviewModalTxId);
  if (pageRow) return pageRow;
  return _reviewModalRow?.id === _reviewModalTxId ? _reviewModalRow : null;
}

async function _openPendingReviewTransaction() {
  const pendingId = _pendingReviewTxId;
  if (!pendingId) return;

  try {
    const pageRow = _rows.find((row) => row.id === pendingId);
    if (pageRow) {
      _openReviewModalForTransaction(pageRow);
      return;
    }

    const fetchedRow = await getTransactionById(pendingId);
    if (fetchedRow?.id) {
      _openReviewModalForTransaction(fetchedRow);
      return;
    }

    _txMessage = 'Transaction could not be opened. It may be outside the current filters or no longer exists.';
    _txMessageType = 'error';
  } catch (_err) {
    _txMessage = 'Transaction could not be opened. It may be outside the current filters or no longer exists.';
    _txMessageType = 'error';
  } finally {
    _pendingReviewTxId = null;
  }
}

export async function renderTransactions(container) {
  _renderFrame(container);
  const body = document.getElementById('page-body');
  if (!body) return;

  body.innerHTML = '<section class="card"><p class="empty-state">Loading transactions...</p></section>';
  _attachDelegation(body);

  const masterLists = await getMasterLists(false);
  _expenseCategoryOptions = Array.isArray(masterLists?.expenseList)
    ? masterLists.expenseList.map((row) => String(row?.name || '').trim()).filter(Boolean)
    : [];
  _txCcSettings = await loadCommandCenterSettings().catch(() => null);
  await _loadAccountTabs();
  const period = getActivePeriod();

  try {
    await _fetchAndStore(period, 0);
  } catch (err) {
    _loadError = err;
    _paint(body, period);
    return;
  }

  if (_pendingReviewTxId) {
    await _openPendingReviewTransaction();
  }

  _paint(body, period);
}

function _renderFrame(container) {
  const period = getActivePeriod();
  container.innerHTML =
    '<header class="page-header">' +
    '<div class="page-header-main"><h2 class="page-title">Transactions</h2><p class="page-description">Review synced Plaid transactions.</p></div>' +
    '<div class="page-header-right"><span class="status-badge">' + escapeHtml(getPeriodLabel(period)) + '</span></div>' +
    '</header><div id="page-body" class="page-body"></div>';
}

function _buildQueryParams(period, offset) {
  const params = {
    limit: _limit,
    offset,
    sort: _filters.sort,
  };

  if (_viewMode === 'period' && period?.startDate && period?.exclusiveEndDate) {
    params.startDate = period.startDate;
    params.exclusiveEndDate = period.exclusiveEndDate;
  }
  if (_filters.search) params.search = _filters.search;
  if (_filters.accountId) params.accountId = _filters.accountId;
  if (_filters.type) params.type = _filters.type;
  if (_filters.reviewed !== '') params.reviewed = _filters.reviewed;
  if (!_filters.showIgnored) params.ignored = 'false';

  return params;
}

async function _fetchAndStore(period, offset) {
  const params = _buildQueryParams(period, offset);
  const result = await timeAsync('transactions.fetch', () => getTransactions(params));

  if (Array.isArray(result)) {
    if (!_legacyWarningLogged) {
      console.warn('Transactions API returned legacy array response. Restart backend or update server route.');
      _legacyWarningLogged = true;
    }

    _legacyCompatibilityMode = true;
    const filteredRows = _filterLegacyRows(result, period);
    const maxOffset = Math.max(0, Math.floor(Math.max(0, filteredRows.length - 1) / _limit) * _limit);
    const boundedOffset = Math.max(0, Math.min(offset, maxOffset));
    const pageRows = filteredRows.slice(boundedOffset, boundedOffset + _limit);

    _rows = pageRows;
    _pagination = {
      limit: _limit,
      offset: boundedOffset,
      total: filteredRows.length,
      hasNext: boundedOffset + _limit < filteredRows.length,
      hasPrevious: boundedOffset > 0,
      nextOffset: boundedOffset + _limit < filteredRows.length ? boundedOffset + _limit : null,
      previousOffset: boundedOffset > 0 ? Math.max(0, boundedOffset - _limit) : null,
    };
  } else {
    _legacyCompatibilityMode = false;
    _rows = Array.isArray(result?.rows) ? result.rows : [];
    _pagination = result?.pagination || _pagination;
  }

  _loadError = null;
}

function _filterLegacyRows(rows, period) {
  const searchNeedle = String(_filters.search || '').trim().toLowerCase();
  const next = rows
    .filter((row) => _viewMode !== 'period' || _isRowInPeriod(row, period))
    .filter((row) => !_filters.accountId || String(row.account_id || '') === _filters.accountId)
    .filter((row) => _filters.showIgnored || !row.ignored)
    .filter((row) => !_filters.type || String(row.type || '') === _filters.type)
    .filter((row) => {
      if (_filters.reviewed === 'true') return !!row.reviewed;
      if (_filters.reviewed === 'false') return !row.reviewed;
      return true;
    })
    .filter((row) => {
      if (!searchNeedle) return true;
      const haystack = [row.name, row.merchant_name, row.category, row.type, row.notes]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
      return haystack.includes(searchNeedle);
    });

  return next.sort((a, b) => _compareRowsBySort(a, b, _filters.sort));
}

function _isRowInPeriod(row, period) {
  if (!period?.startDate || !period?.exclusiveEndDate) return true;
  const date = String(row?.date || '').slice(0, 10);
  return date >= period.startDate && date < period.exclusiveEndDate;
}

function _compareRowsBySort(a, b, sort) {
  const aDate = String(a?.date || '');
  const bDate = String(b?.date || '');
  const aAmount = Math.abs(Number(a?.amount || 0));
  const bAmount = Math.abs(Number(b?.amount || 0));
  const aReviewed = a?.reviewed ? 1 : 0;
  const bReviewed = b?.reviewed ? 1 : 0;

  if (sort === 'date_asc') return aDate.localeCompare(bDate);
  if (sort === 'amount_desc') return bAmount - aAmount || bDate.localeCompare(aDate);
  if (sort === 'amount_asc') return aAmount - bAmount || bDate.localeCompare(aDate);
  if (sort === 'reviewed_first') return bReviewed - aReviewed || bDate.localeCompare(aDate);
  if (sort === 'unreviewed_first') return aReviewed - bReviewed || bDate.localeCompare(aDate);
  return bDate.localeCompare(aDate);
}

async function _fetchAndRender(period, offset) {
  const body = document.getElementById('page-body');
  if (!body) return;

  body.innerHTML = '<section class="card"><p class="empty-state">Loading transactions...</p></section>';

  try {
    await _fetchAndStore(period, offset);
  } catch (err) {
    _loadError = err;
  }

  _paint(body, period);
}

function _paint(body, period) {
  const renderStartedAt = performance.now();

  if (_loadError) {
    body.innerHTML =
      '<section class="card"><div class="error-card">' +
      (_loadError.offline ? 'Backend not reachable through the local API proxy.' : 'Transactions could not be loaded.') +
      '<br><small>' + escapeHtml(_loadError.message) + '</small></div></section>';
    logRenderTime('transactions.paint.error', renderStartedAt);
    return;
  }

  const modeLabel = _viewMode === 'period'
    ? 'Showing transactions for: ' + getPeriodLabel(period)
    : 'Showing all synced transactions.';
  const selectedAccountTab = _accountTabs.find((tab) => tab.id === _filters.accountId) || _accountTabs[0];
  const accountScopeLabel = selectedAccountTab && selectedAccountTab.id
    ? 'Account: ' + selectedAccountTab.label + '.'
    : 'Account: all accounts.';
  const reviewedCount = _rows.filter((row) => !!row.reviewed).length;
  const needsReviewCount = _rows.filter((row) => !row.reviewed).length;
  const txFeat = (key) => isFeatureEnabled(_txCcSettings, 'transactions', key);

  const headerHtml =
    '<section class="card">' +
    (_legacyCompatibilityMode
      ? '<p class="settings-message error">Transactions loaded in compatibility mode. Restart backend to use pagination.</p>'
      : '') +
    (_txMessage ? '<p class="settings-message ' + (_txMessageType === 'error' ? 'error' : 'success') + '">' + escapeHtml(_txMessage) + '</p>' : '') +
    '<div class="card-header"><h3 class="card-title">Synced Transactions</h3><p class="card-description transaction-count">' +
    _pagination.total + ' total transaction' + (_pagination.total !== 1 ? 's' : '') + '</p></div>' +
    (txFeat('showReviewQueue') ?
      '<div class="dashboard-grid transaction-stats">' +
      '<article class="card stat-card"><p class="card-description">Total</p><h3 class="card-title">' + _pagination.total + '</h3></article>' +
      '<article class="card stat-card"><p class="card-description">This Page</p><h3 class="card-title">' + _rows.length + '</h3></article>' +
      '<article class="card stat-card"><p class="card-description">Needs Review</p><h3 class="card-title">' + needsReviewCount + '</h3></article>' +
      '<article class="card stat-card"><p class="card-description">Reviewed</p><h3 class="card-title">' + reviewedCount + '</h3></article>' +
      '</div>' : '') +
    (txFeat('showBankTabs') ? _renderAccountTabs() : '') +
    '<div class="form-grid">' +
    '<label class="form-field"><span>Search</span><input type="text" id="tx-search" value="' + escapeHtml(_filters.search) + '" placeholder="Description, merchant, category..."></label>' +
    (txFeat('showAdvancedFilters') ?
      '<label class="form-field"><span>Type</span><select id="tx-type-filter"><option value="">All</option>' +
      TRANSACTION_TYPES_FOR_FILTER.map((type) => '<option value="' + escapeHtml(type) + '"' + (_filters.type === type ? ' selected' : '') + '>' + type + '</option>').join('') +
      '</select></label>' +
      '<label class="form-field"><span>Reviewed</span><select id="tx-reviewed-filter">' +
      '<option value="">All</option>' +
      '<option value="true"' + (_filters.reviewed === 'true' ? ' selected' : '') + '>Reviewed</option>' +
      '<option value="false"' + (_filters.reviewed === 'false' ? ' selected' : '') + '>Needs Review</option>' +
      '</select></label>' +
      '<label class="form-field field-checkbox"><input type="checkbox" id="tx-show-ignored"' + (_filters.showIgnored ? ' checked' : '') + '> <span>Show ignored</span></label>'
      : '') +
    '</div>' +
    '<div class="filter-actions">' +
    '<span class="muted-note">' + escapeHtml(modeLabel + ' ' + accountScopeLabel) + '</span>' +
    '<button class="button button-secondary" data-action="preview-rules">Preview Rules</button>' +
    '<button class="button button-secondary" data-action="apply-rules">Apply Rules</button>' +
    '<button class="button button-secondary" data-action="show-all-synced">Show all synced</button>' +
    '<button class="button button-secondary" data-action="use-budget-period">Use budget period</button>' +
    '</div>' +
    _renderPaginationControls();

  const tableHtml = _rows.length ? _renderTable() : '<p class="empty-state">No transactions found for this view.</p>';
  const modalTx = _getReviewModalTransaction();
  const modalDraft = modalTx ? normalizeReviewDraft(modalTx, _reviewDraft || {}) : null;
  const modalHtml = modalTx && modalDraft ? renderReviewModalHtml(modalTx, modalDraft) : '';
  const splitModalTx = (txFeat('showSplitTransactionTools') && _splitModalTxId) ? _rows.find((row) => row.id === _splitModalTxId) : null;
  const splitModalHtml = splitModalTx ? _renderSplitModalHtml(splitModalTx) : '';

  body.innerHTML = headerHtml + tableHtml + _renderPaginationControls('pagination-bottom') + '</section>' + modalHtml + splitModalHtml + renderRuleEditorModalHtml(_rows);
  logRenderTime('transactions.paint', renderStartedAt);
}

function _renderPaginationControls(extraClass = '') {
  const rangeStart = _pagination.total > 0 ? _pagination.offset + 1 : 0;
  const rangeEnd = Math.min(_pagination.offset + _rows.length, _pagination.total);
  const currentPage = _pagination.total > 0 ? Math.floor(_pagination.offset / _limit) + 1 : 1;
  const totalPages = Math.max(1, Math.ceil(_pagination.total / _limit));

  return (
    '<div class="pagination-controls' + (extraClass ? ' ' + extraClass : '') + '">' +
    '<div class="pagination-info">' +
    '<span>' + (_pagination.total === 0 ? '0 results' : rangeStart + '\u2013' + rangeEnd + ' of ' + _pagination.total) + '</span>' +
    '<span class="muted-note">Page ' + currentPage + ' of ' + totalPages + '</span>' +
    '</div>' +
    '<div class="pagination-actions">' +
    '<select class="pagination-page-size" id="tx-page-size">' +
    PAGE_SIZE_OPTIONS.map((size) => '<option value="' + size + '"' + (_limit === size ? ' selected' : '') + '>' + size + ' per page</option>').join('') +
    '</select>' +
    '<button class="button button-secondary button-sm" data-action="page-prev"' + (_pagination.hasPrevious ? '' : ' disabled') + '>\u2190 Previous</button>' +
    '<button class="button button-secondary button-sm" data-action="page-next"' + (_pagination.hasNext ? '' : ' disabled') + '>Next \u2192</button>' +
    '</div></div>'
  );
}

function _renderAccountTabs() {
  const tabs = (_accountTabs.length ? _accountTabs : [{ id: '', label: 'All accounts' }]).map((tab) => {
    const isActive = String(tab.id || '') === String(_filters.accountId || '');
    return (
      '<button class="button button-secondary account-tab-button' + (isActive ? ' active' : '') + '" data-action="select-account-tab" data-account-id="' + escapeHtml(tab.id || '') + '">' +
      escapeHtml(tab.label) +
      '</button>'
    );
  }).join('');

  return '<div class="account-tabs" role="tablist" aria-label="Filter transactions by account">' + tabs + '</div>';
}

function _renderTable() {
  const showRawPlaidDetails = isFeatureEnabled(_txCcSettings, 'transactions', 'showRawPlaidDetails');
  const formatAmount = (amount) => {
    const absolute = Math.abs(Number(amount || 0)).toFixed(2);
    return Number(amount || 0) < 0 ? '-$' + absolute : '+$' + absolute;
  };

  const rowsHtml = _rows.map((row) => {
    const hasSplits = Array.isArray(row.split_lines) && row.split_lines.length > 0;
    const hasFinalSplits = hasSplits && !!row.split_is_final;
    const isExpanded = hasSplits && _expandedSplitParentIds.has(String(row.id || ''));
    const splitBadge = hasSplits
      ? '<span class="split-badge">Split' + (row.split_is_final ? '' : ' (Draft)') + '</span>'
      : '';
    const splitToggle = hasSplits
      ? '<button class="button button-secondary button-sm" data-action="toggle-split-details" data-id="' + escapeHtml(row.id) + '">' + (isExpanded ? 'Hide Splits' : 'Show Splits') + '</button>'
      : '';

    const parentRow = (
      '<tr>' +
      '<td>' + escapeHtml(row.date || '') + '</td>' +
      '<td>' + escapeHtml(row.account_name || '') + (row.mask ? ' (\u2022' + escapeHtml(row.mask) + ')' : '') + (showRawPlaidDetails ? '<br><small>' + escapeHtml(row.institution_name || '') + '</small>' : '') + '</td>' +
      '<td>' + escapeHtml(row.name || '') + (splitBadge ? '<br>' + splitBadge : '') + '</td>' +
      '<td>' + escapeHtml(row.merchant_name || '') + '</td>' +
      '<td class="' + (Number(row.amount || 0) < 0 ? 'amount-negative' : 'amount-positive') + '">' + escapeHtml(formatAmount(row.amount)) + '</td>' +
      '<td>' + (row.pending ? 'Pending' : '') + '</td>' +
      '<td>' + (hasFinalSplits ? '<span class="muted-note">-</span>' : (row.type ? '<span class="type-badge">' + escapeHtml(row.type) + '</span>' : '<span class="muted-note">-</span>')) + '</td>' +
      '<td>' + (hasFinalSplits ? '<span class="muted-note">-</span>' : (row.category ? '<span class="category-badge">' + escapeHtml(row.category) + '</span>' : '<span class="muted-note">-</span>')) + '</td>' +
      '<td>' + (row.reviewed ? '<span class="status-reviewed">Reviewed</span>' : '<span class="status-needs-review">Needs Review</span>') + '</td>' +
      '<td class="transaction-actions">' +
      (isFeatureEnabled(_txCcSettings, 'transactions', 'showSplitTransactionTools') ? '<button class="button button-secondary button-sm" data-action="open-split-editor" data-id="' + escapeHtml(row.id) + '">Split</button>' : '') +
      splitToggle +
      '<button class="button button-secondary button-sm" data-action="review-transaction" data-id="' + escapeHtml(row.id) + '">Review</button>' +
      '<button class="button button-secondary button-sm" data-action="toggle-ignore-transaction" data-id="' + escapeHtml(row.id) + '">' + (row.ignored ? 'Restore' : 'Ignore') + '</button>' +
      '</td>' +
      '</tr>'
    );

    if (!hasSplits || !isExpanded) return parentRow;

    const splitRowsHtml = row.split_lines.map((split) => (
      '<tr>' +
      '<td>' + escapeHtml(split.category || '') + '</td>' +
      '<td>' + (split.subcategory ? escapeHtml(split.subcategory) : '<span class="muted-note">-</span>') + '</td>' +
      '<td>' + (split.note ? escapeHtml(split.note) : '<span class="muted-note">-</span>') + '</td>' +
      '<td class="amount-negative">-$' + escapeHtml(Math.abs(Number(split.amount || 0)).toFixed(2)) + '</td>' +
      '</tr>'
    )).join('');

    return parentRow +
      '<tr class="split-detail-row"><td colspan="10">' +
      '<div class="split-detail-shell">' +
      '<div class="split-detail-summary">Split total: $' + escapeHtml(Number(row.split_total || 0).toFixed(2)) + ' / Parent: $' + escapeHtml(Math.abs(Number(row.amount || 0)).toFixed(2)) + '</div>' +
      '<div class="table-wrap"><table class="table table-compact"><thead><tr><th>Category</th><th>Subcategory</th><th>Note</th><th>Amount</th></tr></thead><tbody>' + splitRowsHtml + '</tbody></table></div>' +
      '</div></td></tr>';
  }).join('');

  return '<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Account</th><th>Description</th><th>Merchant</th><th>Amount</th><th>Pending</th><th>Type</th><th>Category</th><th>Reviewed</th><th>Actions</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}

function _calculateSplitTotals(parentAmount, splitLines) {
  const target = Math.abs(Number(parentAmount || 0));
  const total = (splitLines || []).reduce((sum, line) => sum + Math.abs(Number(line?.amount || 0)), 0);
  const delta = Number((total - target).toFixed(2));
  return {
    target: Number(target.toFixed(2)),
    total: Number(total.toFixed(2)),
    delta,
    balanced: Math.abs(delta) < 0.005,
  };
}

function _renderSplitModalHtml(row) {
  const lines = Array.isArray(_splitDraftLines) ? _splitDraftLines : [];
  const totals = _calculateSplitTotals(row.amount, lines);
  const categoryOptions = Array.from(new Set([
    ..._expenseCategoryOptions,
    ...lines.map((line) => String(line?.category || '').trim()).filter(Boolean),
  ])).sort((a, b) => a.localeCompare(b));

  const rowsHtml = lines.length
    ? lines.map((line, index) => {
      return (
        '<tr>' +
        '<td><input type="text" data-split-field="category" data-split-index="' + index + '" value="' + escapeHtml(line.category || '') + '" list="split-category-options" placeholder="Category"></td>' +
        '<td><input type="text" data-split-field="subcategory" data-split-index="' + index + '" value="' + escapeHtml(line.subcategory || '') + '" placeholder="Optional"></td>' +
        '<td><input type="number" step="0.01" min="0" data-split-field="amount" data-split-index="' + index + '" value="' + escapeHtml(String(Number(line.amount || 0).toFixed(2))) + '"></td>' +
        '<td><input type="text" data-split-field="note" data-split-index="' + index + '" value="' + escapeHtml(line.note || '') + '" placeholder="Optional"></td>' +
        '<td><button class="button button-secondary button-sm" data-action="remove-split-line" data-index="' + index + '">Remove</button></td>' +
        '</tr>'
      );
    }).join('')
    : '<tr><td colspan="5">No split lines yet.</td></tr>';

  const deltaClass = totals.balanced ? 'success' : 'error';
  const deltaLabel = totals.balanced
    ? 'Balanced'
    : (totals.delta > 0 ? 'Over by $' + totals.delta.toFixed(2) : 'Under by $' + Math.abs(totals.delta).toFixed(2));

  return (
    '<div class="modal-overlay" data-action="close-split-modal">' +
    '<div class="modal-card split-modal" role="dialog" aria-modal="true" aria-label="Split transaction">' +
    '<header class="modal-header"><h3 class="modal-title">Split Transaction</h3><button class="button button-secondary button-sm" data-action="close-split-modal">Close</button></header>' +
    '<p class="card-description">' + escapeHtml(row.name || row.merchant_name || 'Transaction') + ' | Parent amount: $' + escapeHtml(Math.abs(Number(row.amount || 0)).toFixed(2)) + '</p>' +
    '<datalist id="split-category-options">' + categoryOptions.map((name) => '<option value="' + escapeHtml(name) + '"></option>').join('') + '</datalist>' +
    '<div class="table-wrap"><table class="table table-compact"><thead><tr><th>Category</th><th>Subcategory</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
    '<div class="settings-actions"><button class="button button-secondary" data-action="add-split-line">Add Line</button></div>' +
    '<p class="settings-message ' + deltaClass + '">Split total: $' + totals.total.toFixed(2) + ' / Target: $' + totals.target.toFixed(2) + ' (' + deltaLabel + ')</p>' +
    (_splitValidationMessage ? '<p class="settings-message error">' + escapeHtml(_splitValidationMessage) + '</p>' : '') +
    '<div class="settings-actions">' +
    '<button class="button button-secondary" data-action="save-split-draft" data-id="' + escapeHtml(row.id) + '">Save Draft</button>' +
    '<button class="button button-primary" data-action="save-split-final" data-id="' + escapeHtml(row.id) + '"' + (totals.balanced && lines.length > 0 ? '' : ' disabled') + '>Save Final</button>' +
    '</div>' +
    '</div></div>'
  );
}

function _attachDelegation(body) {
  if (body.dataset.transactionsBound === '1') return;
  body.dataset.transactionsBound = '1';

  body.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    const period = getActivePeriod();

    if (action === 'show-all-synced') {
      _viewMode = 'all';
      await _fetchAndRender(period, 0);
      return;
    }
    if (action === 'select-account-tab') {
      _filters.accountId = String(button.dataset.accountId || '');
      await _fetchAndRender(period, 0);
      return;
    }
    if (action === 'toggle-split-details') {
      const id = String(button.dataset.id || '');
      if (!id) return;
      if (_expandedSplitParentIds.has(id)) _expandedSplitParentIds.delete(id);
      else _expandedSplitParentIds.add(id);
      _repaint();
      return;
    }
    if (action === 'open-split-editor') {
      await _openSplitEditor(String(button.dataset.id || ''));
      return;
    }
    if (action === 'close-split-modal') {
      // Only close if clicking directly on the overlay, not on the modal card or its contents
      if (event.target !== button) return;
      _closeSplitEditor();
      _repaint();
      return;
    }
    if (action === 'add-split-line') {
      _splitDraftLines = [...(_splitDraftLines || []), { category: '', subcategory: '', amount: 0, note: '' }];
      _repaint();
      return;
    }
    if (action === 'remove-split-line') {
      const index = Number.parseInt(button.dataset.index, 10);
      if (!Number.isFinite(index)) return;
      _splitDraftLines = (_splitDraftLines || []).filter((_, rowIndex) => rowIndex !== index);
      _repaint();
      return;
    }
    if (action === 'save-split-draft') {
      await _saveSplitLines(String(button.dataset.id || ''), false, button);
      return;
    }
    if (action === 'save-split-final') {
      await _saveSplitLines(String(button.dataset.id || ''), true, button);
      return;
    }
    if (action === 'use-budget-period') {
      _viewMode = 'period';
      await _fetchAndRender(period, 0);
      return;
    }
    if (action === 'page-prev' && _pagination.previousOffset !== null) {
      await _fetchAndRender(period, _pagination.previousOffset);
      return;
    }
    if (action === 'page-next' && _pagination.nextOffset !== null) {
      await _fetchAndRender(period, _pagination.nextOffset);
      return;
    }
    if (action === 'review-transaction') {
      const row = _rows.find((item) => item.id === button.dataset.id);
      if (!row) return;
      _openReviewModalForTransaction(row);
      _repaint();
      return;
    }
    if (action === 'close-review-modal') {
      // Only close if clicking on the backdrop itself or the Close button
      if (button.className && button.className.includes('modal-backdrop')) {
        // Only close if clicking directly on backdrop (not a child of it)
        if (event.target !== button) return;
      }
      _reviewModalTxId = null;
      _reviewModalRow = null;
      _reviewDraft = null;
      _repaint();
      return;
    }
    if (action === 'save-transaction-review') {
      button.disabled = true;
      const id = button.dataset.id;
      const errorEl = document.getElementById('review-error');
      const type = document.getElementById('review-type')?.value;
      const category = document.getElementById('review-category')?.value;
      const notes = document.getElementById('review-notes')?.value;
      const reviewed = !!document.getElementById('review-reviewed')?.checked;
      const ignored = type === 'Ignore';
      try {
        const updatedRow = await patchTransaction(id, { type, category, notes, reviewed, ignored });
        const index = _rows.findIndex((item) => item.id === id);
        if (index !== -1) _rows[index] = { ..._rows[index], ...updatedRow };
        if (_reviewModalRow?.id === id) _reviewModalRow = { ..._reviewModalRow, ...updatedRow };
        _reviewModalTxId = null;
        _reviewModalRow = null;
        _reviewDraft = null;
        _txMessage = 'Transaction updated.';
        _txMessageType = 'success';
        emitAppEvent('budget:transactions-updated');
        _repaint();
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message;
        else {
          _txMessage = err.message;
          _txMessageType = 'error';
          _repaint();
        }
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'toggle-ignore-transaction') {
      button.disabled = true;
      const row = _rows.find((item) => item.id === button.dataset.id);
      if (!row) {
        button.disabled = false;
        return;
      }
      const ignored = !row.ignored;
      try {
        const updatedRow = await patchTransaction(row.id, {
          ignored,
          type: ignored ? 'Ignore' : row.type,
          category: ignored ? 'Ignore' : row.category,
        });
        const index = _rows.findIndex((item) => item.id === row.id);
        if (index !== -1) _rows[index] = { ..._rows[index], ...updatedRow };
        emitAppEvent('budget:transactions-updated');
        _repaint();
      } catch (err) {
        _txMessage = err.message;
        _txMessageType = 'error';
        _repaint();
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'create-rule-from-transaction') {
      const row = _rows.find((item) => item.id === button.dataset.id) || (_reviewModalRow?.id === button.dataset.id ? _reviewModalRow : null);
      if (!row) return;
      openRuleEditor({ source: 'transactions', transaction: row }, _reviewDraft);
      return;
    }
    if (action === 'close-rule-editor') {
      closeRuleEditor();
      return;
    }
    if (action === 'save-rule-editor') {
      button.disabled = true;
      const result = await _saveRuleEditor();
      button.disabled = false;
      if (result?.success) {
        _txMessage = 'Rule saved.';
        _txMessageType = 'success';
        _repaint();
      }
      return;
    }
    if (action === 'preview-rules') {
      button.disabled = true;
      try {
        const result = await applyRules(true);
        const count = result.applied ?? result.count ?? 0;
        _txMessage = 'Preview: ' + count + ' transaction(s) would be updated.';
        _txMessageType = 'success';
        _repaint();
      } catch (err) {
        _txMessage = err.message;
        _txMessageType = 'error';
        _repaint();
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'apply-rules') {
      button.disabled = true;
      try {
        const result = await applyRules(false);
        const count = result.applied ?? result.count ?? 0;
        await _fetchAndRender(period, _pagination.offset);
        emitAppEvent('budget:transactions-updated');
        _txMessage = 'Rules applied: ' + count + ' transaction(s) updated.';
        _txMessageType = 'success';
        _repaint();
      } catch (err) {
        _txMessage = err.message;
        _txMessageType = 'error';
        _repaint();
      } finally {
        button.disabled = false;
      }
    }
  });

  body.addEventListener('change', async (event) => {
    if (getRuleEditorState() && _handleRuleEditorChange(event)) return;

    const id = event.target?.id;
    const period = getActivePeriod();
    if (id === 'tx-page-size') {
      _limit = Number.parseInt(event.target.value, 10) || 100;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-type-filter') {
      _filters.type = event.target.value;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-reviewed-filter') {
      _filters.reviewed = event.target.value;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-show-ignored') {
      _filters.showIgnored = !!event.target.checked;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'review-type') {
      const row = _getReviewModalTransaction();
      if (!row || !_reviewDraft) return;
      _reviewDraft = normalizeReviewDraft(row, { ..._reviewDraft, type: event.target.value, category: '' });
      _repaint();
      return;
    }
    if (id === 'review-category' && _reviewDraft) {
      _reviewDraft = { ..._reviewDraft, category: event.target.value };
    }
  });

  body.addEventListener('input', (event) => {
    if (getRuleEditorState() && _handleRuleEditorInput(event)) return;
    if (event.target?.dataset?.splitField) {
      const field = String(event.target.dataset.splitField || '');
      const index = Number.parseInt(event.target.dataset.splitIndex, 10);
      if (!Number.isFinite(index) || index < 0) return;
      const current = _splitDraftLines[index] || { category: '', subcategory: '', amount: 0, note: '' };
      const nextLine = { ...current };
      if (field === 'amount') {
        nextLine.amount = Number(event.target.value || 0);
      } else if (field === 'category') {
        nextLine.category = event.target.value;
      } else if (field === 'subcategory') {
        nextLine.subcategory = event.target.value;
      } else if (field === 'note') {
        nextLine.note = event.target.value;
      }
      _splitDraftLines[index] = nextLine;
      _splitValidationMessage = '';
      // Don't repaint on input - just update state. This preserves focus.
      return;
    }
    if (event.target?.id !== 'tx-search') return;

    _filters.search = event.target.value;
    if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => {
      _fetchAndRender(getActivePeriod(), 0);
    }, SEARCH_DEBOUNCE_MS);
  });
}

function _repaint() {
  const body = document.getElementById('page-body');
  if (!body) return;
  _paint(body, getActivePeriod());
}

async function _openSplitEditor(id) {
  const row = _rows.find((item) => item.id === id);
  if (!row) return;

  _splitModalTxId = id;
  _splitValidationMessage = '';
  _splitDraftLines = [];
  _splitDraftIsFinal = false;

  try {
    const splitData = await getTransactionSplits(id);
    _splitDraftIsFinal = splitData?.splitIsFinal === true;
    _splitDraftLines = Array.isArray(splitData?.splits)
      ? splitData.splits.map((line) => ({
        category: String(line?.category || ''),
        subcategory: String(line?.subcategory || ''),
        amount: Number(line?.amount || 0),
        note: String(line?.note || ''),
      }))
      : [];
  } catch (err) {
    _splitValidationMessage = err.message;
    _splitDraftLines = Array.isArray(row.split_lines)
      ? row.split_lines.map((line) => ({
        category: String(line?.category || ''),
        subcategory: String(line?.subcategory || ''),
        amount: Number(line?.amount || 0),
        note: String(line?.note || ''),
      }))
      : [];
  }

  _repaint();
}

function _closeSplitEditor() {
  _splitModalTxId = null;
  _splitDraftLines = [];
  _splitDraftIsFinal = false;
  _splitValidationMessage = '';
}

function _normalizeSplitLinesForSave(lines) {
  return (lines || [])
    .map((line) => ({
      category: String(line?.category || '').trim(),
      subcategory: String(line?.subcategory || '').trim(),
      note: String(line?.note || '').trim(),
      amount: Number(line?.amount || 0),
    }))
    .filter((line) => line.category || Math.abs(line.amount) > 0 || line.subcategory || line.note)
    .map((line) => ({
      category: line.category,
      subcategory: line.subcategory,
      note: line.note,
      amount: Number(Math.abs(line.amount).toFixed(2)),
    }));
}

async function _saveSplitLines(id, isFinal, button) {
  const row = _rows.find((item) => item.id === id);
  if (!row) return;

  const splits = _normalizeSplitLinesForSave(_splitDraftLines);
  const totals = _calculateSplitTotals(row.amount, splits);

  if (isFinal && (!splits.length || !totals.balanced)) {
    _splitValidationMessage = 'Final save requires at least one split line and an exact total match.';
    _repaint();
    return;
  }

  button.disabled = true;
  try {
    await saveTransactionSplits(id, { splits, isFinal });

    _splitValidationMessage = '';
    _txMessage = isFinal ? 'Split saved.' : 'Split draft saved.';
    _txMessageType = 'success';
    _closeSplitEditor();
    await _fetchAndRender(getActivePeriod(), _pagination.offset);
    emitAppEvent('budget:transactions-updated');
  } catch (err) {
    _splitValidationMessage = err.message;
    _repaint();
  } finally {
    button.disabled = false;
  }
}

async function _loadAccountTabs() {
  try {
    const [accounts, rawLabels] = await Promise.all([
      getAccounts(),
      getSetting(ACCOUNT_TAB_LABELS_SETTING_KEY).catch(() => ({})),
    ]);
    const customLabels = _normalizeAccountTabLabels(rawLabels);
    const mapped = Array.isArray(accounts)
      ? accounts.map((account) => {
        const accountId = String(account?.id || '');
        const accountName = String(account?.name || account?.officialName || 'Account').trim();
        const accountMask = String(account?.mask || '').trim();
        const defaultLabel = accountMask ? accountName + ' (' + accountMask + ')' : accountName;
        const customLabel = String(customLabels[accountId] || '').trim();
        return {
          id: accountId,
          label: customLabel || defaultLabel,
        };
      }).filter((account) => account.id)
      : [];

    mapped.sort((a, b) => a.label.localeCompare(b.label));
    _accountTabs = [{ id: '', label: 'All accounts' }, ...mapped];
    if (_filters.accountId && !_accountTabs.some((tab) => tab.id === _filters.accountId)) {
      _filters.accountId = '';
    }
  } catch (_err) {
    _accountTabs = [{ id: '', label: 'All accounts' }];
  }
}

function _normalizeAccountTabLabels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [accountId, label] of Object.entries(value)) {
    const key = String(accountId || '').trim();
    const name = String(label || '').trim();
    if (key && name) normalized[key] = name;
  }
  return normalized;
}

async function _saveRuleEditor() {
  const { getRuleEditorState: getState, normalizeRuleDraft: normalizeRuleEditorDraft, closeRuleEditor: closeActiveRuleEditor } = await import('./rulesManager.js');
  const { createRule, patchRule } = await import('../api/rulesApi.js');
  const state = getState();
  if (!state?.draft) return { success: false };

  const draft = normalizeRuleEditorDraft(state.draft);
  if (!draft.match_value) {
    setRuleEditorError('Match value is required.');
    window.dispatchEvent(new CustomEvent('app:page-needs-render'));
    return { success: false };
  }

  const payload = {
    name: draft.name || draft.match_value,
    enabled: draft.enabled,
    match_type: draft.match_type,
    match_value: draft.match_value,
    account_id: draft.account_id || null,
    amount_min: draft.amount_min === '' ? null : draft.amount_min,
    amount_max: draft.amount_max === '' ? null : draft.amount_max,
    set_type: draft.set_ignored ? 'Ignore' : draft.set_type,
    set_category: draft.set_ignored ? 'Ignore' : draft.set_category,
    set_ignored: draft.set_ignored,
    apply_to_unreviewed_only: draft.apply_to_unreviewed_only,
  };

  try {
    if (draft.mode === 'edit' && draft.id) await patchRule(draft.id, payload);
    else await createRule(payload);
    closeActiveRuleEditor();
    return { success: true };
  } catch (err) {
    setRuleEditorError(err.message);
    window.dispatchEvent(new CustomEvent('app:page-needs-render'));
    return { success: false };
  }
}

function _handleRuleEditorChange(event) {
  const id = event.target?.id;
  if (id === 'rule-match-type') {
    updateRuleEditorDraftField('match_type', event.target.value);
    return true;
  }
  if (id === 'rule-account-id') {
    updateRuleEditorDraftField('account_id', event.target.value);
    return true;
  }
  if (id === 'rule-set-type') {
    updateRuleEditorDraftField('set_type', event.target.value);
    updateRuleEditorDraftField('set_ignored', event.target.value === 'Ignore');
    return true;
  }
  if (id === 'rule-set-category') {
    updateRuleEditorDraftField('set_category', event.target.value);
    return true;
  }
  if (id === 'rule-enabled') {
    updateRuleEditorDraftField('enabled', !!event.target.checked);
    return true;
  }
  if (id === 'rule-unreviewed-only') {
    updateRuleEditorDraftField('apply_to_unreviewed_only', !!event.target.checked);
    return true;
  }
  if (id === 'rule-set-ignored') {
    const setIgnored = !!event.target.checked;
    updateRuleEditorDraftField('set_ignored', setIgnored);
    if (!setIgnored && getRuleEditorState()?.draft?.set_type === 'Ignore') {
      updateRuleEditorDraftField('set_type', 'Expense');
    }
    return true;
  }
  return false;
}

function _handleRuleEditorInput(event) {
  const id = event.target?.id;
  if (id === 'rule-name') {
    updateRuleEditorDraftField('name', event.target.value);
    return true;
  }
  if (id === 'rule-match-value') {
    updateRuleEditorDraftField('match_value', event.target.value);
    return true;
  }
  if (id === 'rule-amount-min') {
    updateRuleEditorDraftField('amount_min', event.target.value);
    return true;
  }
  if (id === 'rule-amount-max') {
    updateRuleEditorDraftField('amount_max', event.target.value);
    return true;
  }
  return false;
}
