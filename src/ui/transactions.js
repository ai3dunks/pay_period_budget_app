/**
 * Transactions page — server-side paginated transactions with review and rules.
 */

import { escapeHtml } from '../utils/dom.js';
import { getTransactions, getTransactionById, patchTransaction, getTransactionSplits, saveTransactionSplits } from '../api/transactionsApi.js';
import { getMasterLists } from '../api/masterListsApi.js';
import { applyRules, createRule, previewRule, previewRuleDraft, applyRule, getRules } from '../api/rulesApi.js';
import { getSetting } from '../api/settingsApi.js';
import { getActivePeriod } from '../app/appState.js';
import { getPeriodLabel } from '../utils/formatters.js';
import {
  TRANSACTION_TYPES,
  getCategoryOptionsForType,
  getRuleEditorState,
  openRuleEditor,
  closeRuleEditor,
  renderRuleEditorModalHtml,
  setRuleEditorError,
  updateRuleEditorDraftField,
  renderRulePreviewTableHtml,
} from './rulesManager.js';
import { normalizeReviewDraft } from './transactionReviewModal.js';
import { emitAppEvent } from '../app/events.js';
import { timeAsync, logRenderTime } from '../utils/performance.js';
import { getAccounts, getPlaidStatus } from '../api/plaidApi.js';
import { loadCommandCenterSettings, isFeatureEnabled } from '../utils/commandCenter.js';
import { createRuleFromTransaction, previewRuleMatches } from '../utils/transactionRules.js';

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
  startDate: '',
  exclusiveEndDate: '',
  type: '',
  category: '',
  reviewed: '',
  pending: '',
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
let _selectedTransactionIds = new Set();
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
let _txPlaidStatus = null;
let _pendingHiddenBySettings = false;
let _filtersModalOpen = false;
let _smartRules = [];
let _rulePreviewMessage = '';
let _ruleEditorAccounts = [];
let _rulePreviewState = null;
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

function _buildRuleDraftFromEditor() {
  const state = getRuleEditorState();
  if (!state?.draft) return null;
  return {
    name: state.draft.name || state.draft.match_value,
    enabled: state.draft.enabled,
    match_type: state.draft.match_type,
    match_value: state.draft.match_value,
    account_id: state.draft.account_id || null,
    amount_min: state.draft.amount_min === '' ? null : state.draft.amount_min,
    amount_max: state.draft.amount_max === '' ? null : state.draft.amount_max,
    priority: state.draft.priority,
    set_type: state.draft.set_ignored ? 'Ignore' : state.draft.set_type,
    set_category: state.draft.set_ignored ? 'Ignore' : state.draft.set_category,
    apply_type: state.draft.set_ignored ? 'Ignore' : state.draft.set_type,
    apply_category: state.draft.set_ignored ? 'Ignore' : state.draft.set_category,
    apply_reviewed: state.draft.apply_reviewed,
    confidence_mode: state.draft.confidence_mode,
    apply_to_pending: state.draft.apply_to_pending,
    set_ignored: state.draft.set_ignored,
    apply_to_unreviewed_only: state.draft.apply_to_unreviewed_only,
    created_from_transaction_id: state.draft.created_from_transaction_id || null,
  };
}

function _getReviewModalTransaction() {
  if (!_reviewModalTxId) return null;
  const pageRow = _rows.find((row) => row.id === _reviewModalTxId);
  if (pageRow) return pageRow;
  return _reviewModalRow?.id === _reviewModalTxId ? _reviewModalRow : null;
}

function unwrapTransactionRows(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.rows)) return response.rows;
  return [];
}

function isNeedsReview(row) {
  if (!row) return false;
  if (!row.reviewed) return true;
  if (!String(row.type || '').trim()) return true;
  if (!String(row.category || '').trim()) return true;
  return false;
}

function hasSplit(row) {
  return Array.isArray(row?.split_lines) && row.split_lines.length > 0;
}

function getMerchantName(row) {
  return String(row?.merchant_name || row?.name || 'Transaction').trim();
}

function getRawDescription(row) {
  const raw = String(row?.name || '').trim();
  const merchant = String(row?.merchant_name || '').trim();
  return raw && raw !== merchant ? raw : '';
}

function getStatusPills(row) {
  const pills = [];
  pills.push(isNeedsReview(row) ? { label: 'Needs Review', className: 'badge-warning' } : { label: 'Reviewed', className: 'badge-good' });
  pills.push(row?.pending ? { label: 'Pending', className: 'badge-warning' } : { label: 'Posted', className: 'badge-neutral' });
  if (hasSplit(row)) pills.push({ label: 'Split', className: 'badge-neutral' });
  if (row?.ruleSuggestion) pills.push({ label: 'Suggested', className: 'badge-warning' });
  if (row?.ruleApplied) pills.push({ label: 'Rule Applied', className: 'badge-good' });
  if (row?.possibleBillMatch || row?.billMatch || row?.matchStatus === 'Possible match') pills.push({ label: 'Possible Bill Match', className: 'badge-warning' });
  if (row?.transferMatch || row?.possibleTransferMatch) pills.push({ label: 'Transfer Match', className: 'badge-neutral' });
  return pills;
}

function renderStatusPills(row) {
  return getStatusPills(row)
    .map((pill) => '<span class="' + pill.className + '">' + escapeHtml(pill.label) + '</span>')
    .join(' ');
}

function _getRuleSuggestion(row) {
  const rules = (_smartRules || [])
    .filter((rule) => !!rule.enabled)
    .filter((rule) => String(rule.confidence_mode || 'suggest') === 'suggest')
    .sort((a, b) => Number(a.priority ?? 100) - Number(b.priority ?? 100));
  for (const rule of rules) {
    const preview = previewRuleMatches(rule, [row]);
    if (preview.length) return { rule, preview: preview[0] };
  }
  return null;
}

function _decorateRowsWithRuleSuggestions(rows) {
  return (rows || []).map((row) => {
    const suggestion = _getRuleSuggestion(row);
    if (!suggestion) return row;
    return {
      ...row,
      ruleSuggestion: {
        ruleId: suggestion.rule.id,
        ruleName: suggestion.rule.name || suggestion.rule.match_value,
        type: suggestion.preview.updates.type,
        category: suggestion.preview.updates.category,
      },
    };
  });
}

function getLastSyncLabel(status) {
  const timestamps = (Array.isArray(status?.items) ? status.items : [])
    .map((item) => item?.lastSyncedAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (!timestamps.length) return 'Last sync unavailable';
  return 'Last sync ' + new Date(Math.max(...timestamps)).toLocaleString();
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
  let body = document.getElementById('page-body');
  if (!body) return;

  body.innerHTML =
    '<section class="card transactions-loading-card">' +
    '<div class="skeleton-line skeleton-line-lg"></div>' +
    '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>' +
    '</section>';
  _attachDelegation(body);

  const masterLists = await getMasterLists(false);
  _expenseCategoryOptions = Array.isArray(masterLists?.expenseList)
    ? masterLists.expenseList.map((row) => String(row?.name || '').trim()).filter(Boolean)
    : [];
  _txCcSettings = await loadCommandCenterSettings().catch(() => null);
  _txPlaidStatus = await getPlaidStatus().catch(() => null);
  _smartRules = await getRules().catch(() => []);
  const safeMoneySettings = await getSetting('safe_money_settings').catch(() => ({}));
  _pendingHiddenBySettings = safeMoneySettings?.includePendingTransactions === false || safeMoneySettings?.include_pending_transactions === false;
  if (_pendingHiddenBySettings && _filters.pending === '') _filters.pending = 'false';
  _renderFrame(container);
  body = document.getElementById('page-body');
  if (!body) return;
  body.innerHTML =
    '<section class="card transactions-loading-card">' +
    '<div class="skeleton-line skeleton-line-lg"></div>' +
    '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>' +
    '</section>';
  _attachDelegation(body);
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
  const syncConnected = !!_txPlaidStatus?.connected;
  container.innerHTML =
    '<header class="page-header">' +
    '<div class="page-header-main"><h2 class="page-title">Transactions Inbox</h2><p class="page-description">Review, categorize, split, and clear transactions for this pay period.</p></div>' +
    '<div class="page-header-right dashboard-banner-meta"><span class="status-badge">' + escapeHtml(getPeriodLabel(period)) + '</span>' +
    '<span class="badge-neutral">' + escapeHtml(getLastSyncLabel(_txPlaidStatus)) + '</span>' +
    '<span class="' + (syncConnected ? 'badge-good' : 'badge-warning') + '">' + escapeHtml(syncConnected ? 'Connected' : 'Not connected') + '</span></div>' +
    '</header><div id="page-body" class="page-body"></div>';
}

function _buildQueryParams(period, offset) {
  const params = {
    limit: _limit,
    offset,
    sort: _filters.sort,
  };

  if (_viewMode === 'period' && period?.startDate && period?.exclusiveEndDate) {
    params.startDate = _filters.startDate || period.startDate;
    params.exclusiveEndDate = _filters.exclusiveEndDate || period.exclusiveEndDate;
  }
  if (_viewMode !== 'period' && _filters.startDate) params.startDate = _filters.startDate;
  if (_viewMode !== 'period' && _filters.exclusiveEndDate) params.exclusiveEndDate = _filters.exclusiveEndDate;
  if (_filters.search) params.search = _filters.search;
  if (_filters.accountId) params.accountId = _filters.accountId;
  if (_filters.type) params.type = _filters.type;
  if (_filters.category) params.category = _filters.category;
  if (_filters.reviewed !== '') params.reviewed = _filters.reviewed;
  if (_filters.pending !== '') params.pending = _filters.pending;
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

    _rows = _decorateRowsWithRuleSuggestions(unwrapTransactionRows(pageRows));
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
    if (!result || !Array.isArray(result.rows)) {
      _rows = [];
      _pagination = { ..._pagination, total: 0, offset: 0, hasNext: false, hasPrevious: false, nextOffset: null, previousOffset: null };
      _loadError = new Error('Transactions response was not recognized.');
      return;
    }
    _rows = _decorateRowsWithRuleSuggestions(unwrapTransactionRows(result));
    _pagination = result?.pagination || _pagination;
  }
  _selectedTransactionIds = new Set(Array.from(_selectedTransactionIds).filter((id) => _rows.some((row) => row.id === id)));

  _loadError = null;
}

function _filterLegacyRows(rows, period) {
  const searchNeedle = String(_filters.search || '').trim().toLowerCase();
  const next = rows
    .filter((row) => _viewMode !== 'period' || _isRowInPeriod(row, {
      ...period,
      startDate: _filters.startDate || period?.startDate,
      exclusiveEndDate: _filters.exclusiveEndDate || period?.exclusiveEndDate,
    }))
    .filter((row) => _viewMode === 'period' || !_filters.startDate || String(row.date || '').slice(0, 10) >= _filters.startDate)
    .filter((row) => _viewMode === 'period' || !_filters.exclusiveEndDate || String(row.date || '').slice(0, 10) < _filters.exclusiveEndDate)
    .filter((row) => !_filters.accountId || String(row.account_id || '') === _filters.accountId)
    .filter((row) => _filters.showIgnored || !row.ignored)
    .filter((row) => !_filters.type || String(row.type || '') === _filters.type)
    .filter((row) => !_filters.category || String(row.category || '') === _filters.category)
    .filter((row) => _filters.pending === '' || (_filters.pending === 'true' ? !!row.pending : !row.pending))
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
      '<section class="card"><div class="error-card">Transactions could not load. Try syncing again.</div>' +
      '<div class="filter-actions"><button class="button button-secondary" data-action="sync-transactions">Sync Transactions</button></div></section>';
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
  const needsReviewCount = _rows.filter(isNeedsReview).length;
  const pendingCount = _rows.filter((row) => !!row.pending).length;
  const splitCount = _rows.filter(hasSplit).length;
  const txFeat = (key) => isFeatureEnabled(_txCcSettings, 'transactions', key);
  const selectedCount = _selectedTransactionIds.size;
  const categoryFilterOptions = Array.from(new Set([
    ..._expenseCategoryOptions,
    ..._rows.map((row) => String(row.category || '').trim()).filter(Boolean),
  ])).sort((a, b) => a.localeCompare(b));

  const headerHtml =
    '<section class="transactions-inbox-page">' +
    (_legacyCompatibilityMode
      ? '<p class="settings-message error">Transactions loaded in compatibility mode. Restart backend to use pagination.</p>'
      : '') +
    (_txMessage ? '<p class="settings-message ' + (_txMessageType === 'error' ? 'error' : 'success') + '">' + escapeHtml(_txMessage) + '</p>' : '') +
    '<section class="dashboard-kpi-grid transaction-inbox-summary">' +
    '<article class="card fintech-kpi fintech-kpi--' + (needsReviewCount ? 'warning' : 'good') + '"><p class="metric-label">Needs Review</p><h3>' + needsReviewCount + '</h3><p>Missing review, type, or category</p></article>' +
    '<article class="card fintech-kpi fintech-kpi--' + (pendingCount ? 'warning' : 'good') + '"><p class="metric-label">Pending</p><h3>' + pendingCount + '</h3><p>May change when posted</p></article>' +
    '<article class="card fintech-kpi"><p class="metric-label">Split</p><h3>' + splitCount + '</h3><p>Parent transactions with split lines</p></article>' +
    '<article class="card fintech-kpi fintech-kpi--good"><p class="metric-label">Reviewed</p><h3>' + reviewedCount + '</h3><p>Cleared in this view</p></article>' +
    '</section>' +
    (txFeat('showBankTabs') ? _renderAccountTabs() : '') +
    '<section class="card transaction-filter-toolbar">' +
    '<div><strong>Transaction filters</strong><p class="card-description">' + escapeHtml(modeLabel + ' ' + accountScopeLabel) + '</p></div>' +
    '<div class="filter-actions">' +
    '<button class="button button-secondary" data-action="open-transaction-filters">Filters</button>' +
    '<button class="button button-secondary" data-action="preview-rules">Preview Rules</button>' +
    '<button class="button button-secondary" data-action="apply-rules">Apply Rules</button>' +
    '<button class="button button-secondary" data-action="show-all-synced">Show all synced</button>' +
    '<button class="button button-secondary" data-action="use-budget-period">Use budget period</button>' +
    '</div>' +
    '</section>' +
    (_rows.length && needsReviewCount === 0 ? '<section class="dashboard-alert success"><strong>Inbox clear</strong><div>All visible transactions are reviewed for this pay period.</div></section>' : '') +
    (selectedCount > 0 ? _renderBulkActionBar(selectedCount) : '') +
    _renderPaginationControls();

  const hasActiveFilters = Boolean(_filters.search || _filters.accountId || _filters.startDate || _filters.exclusiveEndDate || _filters.type || _filters.category || _filters.reviewed || _filters.pending || _filters.showIgnored || _viewMode !== 'period');
  const tableHtml = _rows.length
    ? _renderTable()
    : '<section class="card empty-state-card"><h3>' + (hasActiveFilters ? 'No matching transactions' : 'No transactions found') + '</h3><p class="empty-state">' + (hasActiveFilters ? 'Try clearing filters or changing the date range.' : 'Sync your bank or adjust your filters.') + '</p><div class="filter-actions">' + (hasActiveFilters ? '<button class="button button-primary" data-action="clear-transaction-filters">Clear filters</button>' : '<button class="button button-primary" data-action="sync-transactions">Sync Transactions</button>') + '</div></section>';
  const modalTx = _getReviewModalTransaction();
  const modalDraft = modalTx ? normalizeReviewDraft(modalTx, _reviewDraft || {}) : null;
  const modalHtml = modalTx && modalDraft ? _renderTransactionDrawerHtml(modalTx, modalDraft) : '';
  const splitModalTx = (txFeat('showSplitTransactionTools') && _splitModalTxId) ? _rows.find((row) => row.id === _splitModalTxId) : null;
  const splitModalHtml = splitModalTx ? _renderSplitModalHtml(splitModalTx) : '';

  const filterModalHtml = _filtersModalOpen ? _renderFiltersModalHtml({ categoryFilterOptions, txFeat }) : '';
  const ruleEditorHtml = renderRuleEditorModalHtml(_ruleEditorAccounts, { showDraftPreviewButton: true });
  const rulePreviewHtml = _rulePreviewState ? renderRulePreviewTableHtml(_rulePreviewState, { title: _rulePreviewState.title || 'Rule Preview' }) : '';
  body.innerHTML = headerHtml + tableHtml + _renderPaginationControls('pagination-bottom') + '</section>' + filterModalHtml + modalHtml + splitModalHtml + ruleEditorHtml + rulePreviewHtml;
  logRenderTime('transactions.paint', renderStartedAt);
}

function _renderBulkActionBar(selectedCount) {
  return (
    '<section class="card bulk-action-bar">' +
    '<strong>' + escapeHtml(String(selectedCount)) + ' selected</strong>' +
    '<button class="button button-secondary button-sm" data-action="bulk-mark-reviewed">Mark Reviewed</button>' +
    '<button class="button button-secondary button-sm" data-action="bulk-mark-needs-review">Mark Needs Review</button>' +
    '<label class="form-field bulk-field"><span>Set Type</span><select id="bulk-type-select"><option value="">Choose</option>' +
    TRANSACTION_TYPES.map((type) => '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field bulk-field"><span>Set Category</span><select id="bulk-category-select"><option value="">Choose</option>' +
    _expenseCategoryOptions.map((category) => '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + '</option>').join('') +
    '</select></label>' +
    '<button class="button button-secondary button-sm" data-action="bulk-clear-selection">Clear Selection</button>' +
    '</section>'
  );
}

function _renderFiltersModalHtml({ categoryFilterOptions, txFeat }) {
  return (
    '<div class="modal-backdrop" data-action="close-transaction-filters"></div>' +
    '<section class="review-modal transaction-filter-modal" role="dialog" aria-modal="true" aria-label="Transaction filters">' +
    '<div class="card-header"><h3 class="card-title">Filters</h3><p class="card-description">Pending transactions may change when the bank posts the final charge.</p></div>' +
    (_pendingHiddenBySettings ? '<div class="dashboard-alert info">Some pending transactions are hidden by your Settings.</div>' : '') +
    '<div class="form-grid">' +
    '<label class="form-field"><span>Search</span><input type="text" id="tx-search" value="' + escapeHtml(_filters.search) + '" placeholder="Description, merchant, category..."></label>' +
    '<label class="form-field"><span>Account</span><select id="tx-account-filter">' +
    _accountTabs.map((tab) => '<option value="' + escapeHtml(tab.id || '') + '"' + (String(_filters.accountId || '') === String(tab.id || '') ? ' selected' : '') + '>' + escapeHtml(tab.label || 'All accounts') + '</option>').join('') +
    '</select></label>' +
    (txFeat('showAdvancedFilters') ?
      '<label class="form-field"><span>Start</span><input type="date" id="tx-start-date" value="' + escapeHtml(_filters.startDate || '') + '"></label>' +
      '<label class="form-field"><span>End</span><input type="date" id="tx-end-date" value="' + escapeHtml(_filters.exclusiveEndDate || '') + '"></label>' +
      '<label class="form-field"><span>Type</span><select id="tx-type-filter"><option value="">All</option>' +
      TRANSACTION_TYPES_FOR_FILTER.map((type) => '<option value="' + escapeHtml(type) + '"' + (_filters.type === type ? ' selected' : '') + '>' + type + '</option>').join('') +
      '</select></label>' +
      '<label class="form-field"><span>Category</span><select id="tx-category-filter"><option value="">All</option>' +
      categoryFilterOptions.map((category) => '<option value="' + escapeHtml(category) + '"' + (_filters.category === category ? ' selected' : '') + '>' + escapeHtml(category) + '</option>').join('') +
      '</select></label>' +
      '<label class="form-field"><span>Reviewed</span><select id="tx-reviewed-filter">' +
      '<option value="">All</option>' +
      '<option value="true"' + (_filters.reviewed === 'true' ? ' selected' : '') + '>Reviewed</option>' +
      '<option value="false"' + (_filters.reviewed === 'false' ? ' selected' : '') + '>Needs Review</option>' +
      '</select></label>' +
      '<label class="form-field"><span>Pending</span><select id="tx-pending-filter">' +
      '<option value="">All</option>' +
      '<option value="true"' + (_filters.pending === 'true' ? ' selected' : '') + '>Pending</option>' +
      '<option value="false"' + (_filters.pending === 'false' ? ' selected' : '') + '>Posted</option>' +
      '</select></label>' +
      '<label class="form-field field-checkbox"><input type="checkbox" id="tx-show-ignored"' + (_filters.showIgnored ? ' checked' : '') + '> <span>Show ignored</span></label>'
      : '') +
    '</div>' +
    '<div class="filter-actions">' +
    '<button class="button button-secondary" data-action="clear-transaction-filters">Clear filters</button>' +
    '<button class="button button-primary" data-action="close-transaction-filters">Done</button>' +
    '</div>' +
    '</section>'
  );
}

function _renderTransactionDrawerHtml(transaction, draft) {
  const categories = getCategoryOptionsForType(draft.type);
  const categoryOptions = categories.includes(draft.category) || !draft.category ? categories : [draft.category, ...categories];
  const fmt = (amount) => {
    const n = Number(amount || 0);
    return (n < 0 ? '-' : '+') + '$' + Math.abs(n).toFixed(2);
  };
  const rawDescription = getRawDescription(transaction);
  const splitTotal = Array.isArray(transaction.split_lines)
    ? transaction.split_lines.reduce((sum, line) => sum + Math.abs(Number(line?.amount || 0)), 0)
    : 0;
  const originalAmount = Math.abs(Number(transaction.amount || 0));
  const splitRemaining = originalAmount - splitTotal;

  return (
    '<div class="transaction-drawer-backdrop" data-action="close-review-modal"></div>' +
    '<aside class="transaction-drawer" role="dialog" aria-modal="true" aria-label="Review transaction">' +
    '<header class="transaction-drawer-header">' +
    '<div><p class="metric-label">Review/Edit</p><h3>' + escapeHtml(getMerchantName(transaction)) + '</h3></div>' +
    '<button class="button button-secondary button-sm" data-action="close-review-modal">Close</button>' +
    '</header>' +
    '<section class="transaction-drawer-section">' +
    '<h4>Transaction Details</h4>' +
    '<div class="drawer-detail-grid">' +
    '<div><span>Merchant</span><strong>' + escapeHtml(getMerchantName(transaction)) + '</strong></div>' +
    '<div><span>Raw description</span><strong>' + escapeHtml(rawDescription || '-') + '</strong></div>' +
    '<div><span>Date</span><strong>' + escapeHtml(transaction.date || '-') + '</strong></div>' +
    '<div><span>Account</span><strong>' + escapeHtml((transaction.account_name || '-') + (transaction.mask ? ' (' + transaction.mask + ')' : '')) + '</strong></div>' +
    '<div><span>Amount</span><strong>' + escapeHtml(fmt(transaction.amount)) + '</strong></div>' +
    '<div><span>Status</span><strong>' + escapeHtml(transaction.pending ? 'Pending' : 'Posted') + '</strong></div>' +
    '</div>' +
    '</section>' +
    '<section class="transaction-drawer-section">' +
    '<h4>Classification</h4>' +
    '<div class="form-grid">' +
    '<label class="form-field"><span>Type</span><select id="review-type">' +
    TRANSACTION_TYPES.map((type) => '<option value="' + escapeHtml(type) + '"' + (draft.type === type ? ' selected' : '') + '>' + escapeHtml(type) + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field"><span>Category</span><select id="review-category">' +
    categoryOptions.map((category) => '<option value="' + escapeHtml(category) + '"' + (draft.category === category ? ' selected' : '') + '>' + escapeHtml(category) + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field field-checkbox"><input type="checkbox" id="review-reviewed"' + (draft.reviewed ? ' checked' : '') + '> <span>Reviewed</span></label>' +
    '</div>' +
    (transaction.ruleSuggestion ? '<div class="smart-rule-suggestion"><strong>Suggested by rule:</strong> ' + escapeHtml(transaction.ruleSuggestion.ruleName) + ' -> ' + escapeHtml(transaction.ruleSuggestion.type || '-') + ' / ' + escapeHtml(transaction.ruleSuggestion.category || '-') + '</div>' : '') +
    '<label class="form-field field-checkbox smart-rule-remember"><input type="checkbox" id="review-create-rule"> <span>Remember this choice for similar transactions</span></label>' +
    '<div id="review-smart-rule-options" class="smart-rule-options" hidden>' +
    '<div class="form-grid">' +
    '<label class="form-field"><span>Rule name</span><input id="review-rule-name" value="' + escapeHtml(getMerchantName(transaction)) + '"></label>' +
    '<label class="form-field"><span>Match field</span><select id="review-rule-match-type"><option value="merchant_contains">Merchant contains</option><option value="description_contains">Raw description contains</option></select></label>' +
    '<label class="form-field"><span>Match value</span><input id="review-rule-match-value" value="' + escapeHtml((transaction.merchant_name || getMerchantName(transaction)).trim()) + '"></label>' +
    '<label class="form-field"><span>Confidence</span><select id="review-rule-confidence"><option value="suggest">Suggest only</option><option value="auto_apply">Auto apply type/category</option></select></label>' +
    '</div>' +
    '<label class="form-field field-checkbox"><input type="checkbox" id="review-rule-apply-current"> <span>Apply to current matching unreviewed transactions too</span></label>' +
    '<label class="form-field field-checkbox"><input type="checkbox" id="review-rule-apply-reviewed"> <span>Mark matched transactions reviewed</span></label>' +
    '<div class="filter-actions"><button class="button button-secondary button-sm" data-action="preview-review-rule">Preview matches</button></div>' +
    '<div id="review-rule-preview" class="settings-message"></div>' +
    '</div>' +
    '<label class="form-field"><span>Notes</span><textarea id="review-notes" rows="3" placeholder="Optional notes">' + escapeHtml(draft.notes || '') + '</textarea></label>' +
    '</section>' +
    '<section class="transaction-drawer-section">' +
    '<h4>Split Transaction</h4>' +
    '<div class="drawer-detail-grid">' +
    '<div><span>Original amount</span><strong>' + escapeHtml('$' + originalAmount.toFixed(2)) + '</strong></div>' +
    '<div><span>Split total</span><strong>' + escapeHtml('$' + splitTotal.toFixed(2)) + '</strong></div>' +
    '<div><span>Remaining</span><strong class="' + (Math.abs(splitRemaining) < 0.005 ? 'text-good' : 'text-warning') + '">' + escapeHtml('$' + Math.abs(splitRemaining).toFixed(2)) + '</strong></div>' +
    '</div>' +
    '<p class="card-description">Use split rows when one bank transaction needs to count toward multiple categories. Final save is blocked until split totals match.</p>' +
    '<button class="button button-secondary" data-action="open-split-editor" data-id="' + escapeHtml(transaction.id) + '">Edit Split</button>' +
    '</section>' +
    '<section class="transaction-drawer-section">' +
    '<h4>Match Hints</h4>' +
    '<p class="empty-state">' + (transaction.possibleBillMatch || transaction.billMatch || transaction.transferMatch || transaction.possibleTransferMatch ? 'Review the available match status in the row.' : 'No supported bill or transfer match hint is available for this transaction.') + '</p>' +
    '</section>' +
    '<div id="review-error" class="settings-message error"></div>' +
    '<footer class="transaction-drawer-actions">' +
    '<button class="button button-secondary" data-action="create-rule-from-transaction" data-id="' + escapeHtml(transaction.id) + '">Create Rule</button>' +
    '<button class="button button-primary" data-action="save-transaction-review" data-id="' + escapeHtml(transaction.id) + '">Save</button>' +
    '</footer>' +
    '</aside>'
  );
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
    const hasSplits = hasSplit(row);
    const hasFinalSplits = hasSplits && !!row.split_is_final;
    const isExpanded = hasSplits && _expandedSplitParentIds.has(String(row.id || ''));
    const splitBadge = hasSplits
      ? '<span class="split-badge">Split' + (row.split_is_final ? '' : ' (Draft)') + '</span>'
      : '';
    const splitToggle = hasSplits
      ? '<button class="button button-secondary button-sm" data-action="toggle-split-details" data-id="' + escapeHtml(row.id) + '">' + (isExpanded ? 'Hide Splits' : 'Show Splits') + '</button>'
      : '';

    const parentRow = (
      '<tr class="transaction-row" data-action="review-transaction" data-id="' + escapeHtml(row.id) + '">' +
      '<td><input type="checkbox" class="transaction-select-checkbox" data-action="toggle-transaction-selection" data-id="' + escapeHtml(row.id) + '"' + (_selectedTransactionIds.has(row.id) ? ' checked' : '') + ' aria-label="Select transaction"></td>' +
      '<td>' + escapeHtml(row.date || '') + '</td>' +
      '<td><strong>' + escapeHtml(getMerchantName(row)) + '</strong>' + (getRawDescription(row) ? '<br><small>' + escapeHtml(getRawDescription(row)) + '</small>' : '') + (splitBadge ? '<br>' + splitBadge : '') + '</td>' +
      '<td>' + escapeHtml(row.account_name || '') + (row.mask ? ' (\u2022' + escapeHtml(row.mask) + ')' : '') + (showRawPlaidDetails ? '<br><small>' + escapeHtml(row.institution_name || '') + '</small>' : '') + '</td>' +
      '<td class="amount-cell ' + (Number(row.amount || 0) < 0 ? 'amount-expense' : 'amount-income') + '">' + escapeHtml(formatAmount(row.amount)) + '</td>' +
      '<td>' + (hasFinalSplits ? '<span class="muted-note">-</span>' : (row.type ? '<span class="type-badge">' + escapeHtml(row.type) + '</span>' : '<span class="muted-note">-</span>')) + '</td>' +
      '<td>' + (hasFinalSplits ? '<span class="muted-note">-</span>' : (row.category ? '<span class="category-badge">' + escapeHtml(row.category) + '</span>' : '<span class="muted-note">-</span>')) + '</td>' +
      '<td class="transaction-status-cell">' + renderStatusPills(row) + '</td>' +
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
      '<tr class="split-detail-row"><td colspan="9">' +
      '<div class="split-detail-shell">' +
      '<div class="split-detail-summary">Split total: $' + escapeHtml(Number(row.split_total || 0).toFixed(2)) + ' / Parent: $' + escapeHtml(Math.abs(Number(row.amount || 0)).toFixed(2)) + '</div>' +
      '<div class="table-wrap"><table class="table table-compact"><thead><tr><th>Category</th><th>Subcategory</th><th>Note</th><th>Amount</th></tr></thead><tbody>' + splitRowsHtml + '</tbody></table></div>' +
      '</div></td></tr>';
  }).join('');

  return '<div class="table-wrap transaction-table-wrap"><table class="table transaction-inbox-table"><thead><tr><th><input type="checkbox" data-action="toggle-all-transaction-selection" aria-label="Select all transactions"' + (_rows.length && _selectedTransactionIds.size === _rows.length ? ' checked' : '') + '></th><th>Date</th><th>Merchant</th><th>Account</th><th>Amount</th><th>Type</th><th>Category</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
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

    if (action === 'toggle-transaction-selection') {
      const id = String(button.dataset.id || '');
      if (button.checked) _selectedTransactionIds.add(id);
      else _selectedTransactionIds.delete(id);
      _repaint();
      return;
    }
    if (action === 'toggle-all-transaction-selection') {
      if (button.checked) _selectedTransactionIds = new Set(_rows.map((row) => row.id).filter(Boolean));
      else _selectedTransactionIds = new Set();
      _repaint();
      return;
    }
    if (action === 'bulk-clear-selection') {
      _selectedTransactionIds = new Set();
      _repaint();
      return;
    }
    if (action === 'bulk-mark-reviewed' || action === 'bulk-mark-needs-review') {
      await _bulkPatchSelected({ reviewed: action === 'bulk-mark-reviewed' });
      return;
    }
    if (action === 'clear-transaction-filters') {
      _filters = { search: '', accountId: '', startDate: '', exclusiveEndDate: '', type: '', category: '', reviewed: '', pending: _pendingHiddenBySettings ? 'false' : '', showIgnored: false, sort: _filters.sort || 'date_desc' };
      _viewMode = 'period';
      _selectedTransactionIds = new Set();
      await _fetchAndRender(period, 0);
      return;
    }
    if (action === 'open-transaction-filters') {
      _filtersModalOpen = true;
      _repaint();
      return;
    }
    if (action === 'close-transaction-filters') {
      if (button.className && button.className.includes('modal-backdrop') && event.target !== button) return;
      _filtersModalOpen = false;
      _repaint();
      return;
    }
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
        const shouldCreateRule = !!document.getElementById('review-create-rule')?.checked;
        if (shouldCreateRule) {
          const sourceRow = { ...(_rows.find((item) => item.id === id) || _reviewModalRow || {}), ...updatedRow };
          const payload = createRuleFromTransaction(sourceRow, type, category);
          payload.name = document.getElementById('review-rule-name')?.value || payload.name;
          payload.match_type = document.getElementById('review-rule-match-type')?.value || payload.match_type;
          payload.match_value = document.getElementById('review-rule-match-value')?.value || payload.match_value;
          payload.confidence_mode = document.getElementById('review-rule-confidence')?.value || 'suggest';
          payload.apply_reviewed = !!document.getElementById('review-rule-apply-reviewed')?.checked;
          payload.apply_to_pending = false;
          payload.apply_to_unreviewed_only = true;
          const createdRule = await createRule(payload);
          if (document.getElementById('review-rule-apply-current')?.checked && createdRule?.id) {
            await applyRule(createdRule.id, {
              periodId: getActivePeriod()?.id,
              unreviewedOnly: true,
              excludeTransactionId: id,
            });
          }
          _smartRules = await getRules().catch(() => _smartRules);
        }
        const index = _rows.findIndex((item) => item.id === id);
        if (index !== -1) _rows[index] = { ..._rows[index], ...updatedRow };
        if (_reviewModalRow?.id === id) _reviewModalRow = { ..._reviewModalRow, ...updatedRow };
        _reviewModalTxId = null;
        _reviewModalRow = null;
        _reviewDraft = null;
        _txMessage = shouldCreateRule
          ? 'Rule created. Future matching transactions will use this category.'
          : 'Transaction updated.';
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
    if (action === 'preview-review-rule') {
      const row = _getReviewModalTransaction();
      const messageEl = document.getElementById('review-rule-preview');
      if (!row || !messageEl) return;
      const payload = createRuleFromTransaction(row, document.getElementById('review-type')?.value, document.getElementById('review-category')?.value);
      payload.match_type = document.getElementById('review-rule-match-type')?.value || payload.match_type;
      payload.match_value = document.getElementById('review-rule-match-value')?.value || payload.match_value;
      const result = await previewRuleDraft({
        ...payload,
        excludeTransactionId: row.id,
      }, getActivePeriod()?.id);
      messageEl.className = 'settings-message success';
      messageEl.textContent =
        'This rule matches ' + String(result.unreviewedMatchedCount || 0) + ' unreviewed transaction(s), ' +
        String(result.reviewedMatchedCount || 0) + ' reviewed transaction(s), and ' +
        String(result.pendingMatchedCount || 0) + ' pending transaction(s).' +
        (Number(result.sourceExcludedCount || 0) > 0 ? ' Source transaction excluded.' : '');
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
    if (action === 'rules-preview-one') {
      button.disabled = true;
      try {
        const result = await previewRule(button.dataset.id, getActivePeriod()?.id);
        _rulePreviewState = { title: 'Rule Preview', ...result };
        _txMessage = 'Preview ready: ' + String(result.matchedCount || 0) + ' matching transaction(s).';
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
    if (action === 'preview-rule-draft') {
      button.disabled = true;
      try {
        const draft = _buildRuleDraftFromEditor();
        if (!draft) throw new Error('Rule draft is not available.');
        const result = await previewRuleDraft(draft, getActivePeriod()?.id);
        _rulePreviewState = { title: 'Draft Rule Preview', ...result };
        _txMessage = 'Preview ready: ' + String(result.matchedCount || 0) + ' matching transaction(s).';
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
    if (action === 'close-rule-preview') {
      _rulePreviewState = null;
      _repaint();
      return;
    }
    if (action === 'preview-rules') {
      button.disabled = true;
      try {
        const result = await applyRules(true);
        const count = result.matchedCount ?? result.applied ?? result.count ?? 0;
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
        const count = result.updatedCount ?? result.applied ?? result.count ?? 0;
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
    if (id === 'review-create-rule') {
      const options = document.getElementById('review-smart-rule-options');
      if (options) options.hidden = !event.target.checked;
      return;
    }
    if (id === 'bulk-type-select' && event.target.value) {
      await _bulkPatchSelected({ type: event.target.value, category: event.target.value === 'Ignore' ? 'Ignore' : undefined, ignored: event.target.value === 'Ignore' });
      return;
    }
    if (id === 'bulk-category-select' && event.target.value) {
      await _bulkPatchSelected({ category: event.target.value });
      return;
    }
    if (id === 'tx-page-size') {
      _limit = Number.parseInt(event.target.value, 10) || 100;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-account-filter') {
      _filters.accountId = event.target.value;
      _filtersModalOpen = true;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-start-date') {
      _filters.startDate = event.target.value;
      _filtersModalOpen = true;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-end-date') {
      _filters.exclusiveEndDate = event.target.value;
      _filtersModalOpen = true;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-type-filter') {
      _filters.type = event.target.value;
      _filtersModalOpen = true;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-category-filter') {
      _filters.category = event.target.value;
      _filtersModalOpen = true;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-reviewed-filter') {
      _filters.reviewed = event.target.value;
      _filtersModalOpen = true;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-pending-filter') {
      _filters.pending = _pendingHiddenBySettings && event.target.value === '' ? 'false' : event.target.value;
      _filtersModalOpen = true;
      await _fetchAndRender(period, 0);
      return;
    }
    if (id === 'tx-show-ignored') {
      _filters.showIgnored = !!event.target.checked;
      _filtersModalOpen = true;
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
      _filtersModalOpen = true;
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

async function _bulkPatchSelected(updates) {
  const ids = Array.from(_selectedTransactionIds).filter(Boolean);
  if (!ids.length) return;

  let successCount = 0;
  let failureCount = 0;
  for (const id of ids) {
    const payload = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined));
    try {
      const updatedRow = await patchTransaction(id, payload);
      const index = _rows.findIndex((row) => row.id === id);
      if (index !== -1) _rows[index] = { ..._rows[index], ...updatedRow };
      successCount += 1;
    } catch (_err) {
      failureCount += 1;
    }
  }

  _selectedTransactionIds = new Set();
  _txMessage = failureCount
    ? successCount + ' transaction(s) updated. ' + failureCount + ' could not be updated.'
    : successCount + ' transaction(s) updated.';
  _txMessageType = failureCount ? 'error' : 'success';
  emitAppEvent('budget:transactions-updated');
  _repaint();
}

async function _loadAccountTabs() {
  try {
    const [accounts, rawLabels] = await Promise.all([
      getAccounts(),
      getSetting(ACCOUNT_TAB_LABELS_SETTING_KEY).catch(() => ({})),
    ]);
    _ruleEditorAccounts = Array.isArray(accounts) ? accounts : [];
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
    _ruleEditorAccounts = [];
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
    priority: draft.priority,
    set_type: draft.set_ignored ? 'Ignore' : draft.set_type,
    set_category: draft.set_ignored ? 'Ignore' : draft.set_category,
    apply_type: draft.set_ignored ? 'Ignore' : draft.set_type,
    apply_category: draft.set_ignored ? 'Ignore' : draft.set_category,
    apply_reviewed: draft.apply_reviewed,
    confidence_mode: draft.confidence_mode,
    apply_to_pending: draft.apply_to_pending,
    set_ignored: draft.set_ignored,
    apply_to_unreviewed_only: draft.apply_to_unreviewed_only,
    created_from_transaction_id: draft.created_from_transaction_id || null,
  };

  try {
    if (draft.mode === 'edit' && draft.id) await patchRule(draft.id, payload);
    else await createRule(payload);
    _smartRules = await getRules().catch(() => _smartRules);
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
  if (id === 'rule-confidence-mode') {
    updateRuleEditorDraftField('confidence_mode', event.target.value);
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
  if (id === 'rule-apply-reviewed') {
    updateRuleEditorDraftField('apply_reviewed', !!event.target.checked);
    return true;
  }
  if (id === 'rule-apply-pending') {
    updateRuleEditorDraftField('apply_to_pending', !!event.target.checked);
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
  if (id === 'rule-priority') {
    updateRuleEditorDraftField('priority', event.target.value);
    return true;
  }
  return false;
}
