/**
 * Rules Manager — rule editor modal state + HTML builder.
 * Used by settings.js (Rules Manager section) and transactions.js
 * (Create rule from transaction).
 *
 * When openRuleEditor / closeRuleEditor mutate state they dispatch
 * 'app:page-needs-render' so the current page can re-render itself.
 */

import { escapeHtml } from '../utils/dom.js';
import { getMasterListsCache } from '../api/masterListsApi.js';
import { getRuleMatchValueFromTransaction } from '../utils/transactionRules.js';

export const TRANSACTION_TYPES = [
  'Income',
  'Expense',
  'Bills',
  'Wants',
  'Transfer',
  'Debt Payment',
  'Ignore',
];

const FALLBACK_CATEGORY_BY_TYPE = {
  Income: ['Paycheck', 'Bonus', 'Other Income'],
  Expense: ['Groceries', 'Gas', 'Fast Food', 'Kids', 'Diapers/Wipes', 'Home Essentials', 'Car Maintenance', 'School', 'Medical', 'Misc'],
  Bills: ['Needs', 'Wants', 'Debts/Savings'],
  Wants: ['Josh', 'Taylor', 'Split'],
  Transfer: ['In', 'Out'],
  'Debt Payment': ['Additional Payment'],
  Ignore: ['Ignore'],
};

const CONFIDENCE_MODE_LABELS = {
  suggest: 'Suggest',
  auto_apply: 'Auto Apply',
  ignore: 'Block Other Rules',
};

const CONFIDENCE_MODE_HELP = {
  suggest: 'Shows a suggestion only.',
  auto_apply: 'Applies type and category automatically.',
  ignore: 'Prevents lower-priority rules from matching. Use Mark Ignored to set ignored=true.',
};

let ruleEditorState = null;

function requestPageRerender() {
  window.dispatchEvent(new CustomEvent('app:page-needs-render'));
}

export function getRuleEditorState() {
  return ruleEditorState;
}

export function getCategoryOptionsForType(type) {
  const cache = getMasterListsCache();
  if (type === 'Expense') {
    const expenseNames = (cache.expenseList || [])
      .filter((item) => item.active)
      .map((item) => item.name)
      .filter(Boolean);
    return expenseNames.length ? expenseNames : FALLBACK_CATEGORY_BY_TYPE.Expense;
  }
  return FALLBACK_CATEGORY_BY_TYPE[type] || [];
}

export function defaultCategoryForType(type, amount = 0) {
  if (type === 'Expense') return getCategoryOptionsForType('Expense')[0] || 'Misc';
  if (type === 'Wants') return 'Split';
  if (type === 'Transfer') return amount >= 0 ? 'In' : 'Out';
  if (type === 'Income') return 'Other Income';
  if (type === 'Bills') return 'Needs';
  if (type === 'Debt Payment') return 'Additional Payment';
  if (type === 'Ignore') return 'Ignore';
  return '';
}

export function normalizeRuleDraft(draft = {}) {
  const next = {
    id: draft.id || '',
    mode: draft.mode || 'create',
    source: draft.source || 'settings',
    sourceTransactionId: draft.sourceTransactionId || '',
    sourceTransactionLabel: draft.sourceTransactionLabel || '',
    name: String(draft.name || draft.match_value || '').trim(),
    enabled: draft.enabled === undefined ? true : !!draft.enabled,
    priority: draft.priority ?? 100,
    match_type: String(draft.match_type || 'contains').trim(),
    match_value: String(draft.match_value || '').trim(),
    account_id: String(draft.account_id || '').trim(),
    amount_min: draft.amount_min ?? '',
    amount_max: draft.amount_max ?? '',
    set_type: String(draft.set_type || 'Expense').trim(),
    set_category: String(draft.set_category || '').trim(),
    apply_type: String(draft.apply_type || draft.set_type || 'Expense').trim(),
    apply_category: String(draft.apply_category || draft.set_category || '').trim(),
    apply_reviewed: draft.apply_reviewed === undefined ? false : !!draft.apply_reviewed,
    confidence_mode: String(draft.confidence_mode || 'suggest').trim(),
    apply_to_pending: draft.apply_to_pending === undefined ? false : !!draft.apply_to_pending,
    created_from_transaction_id: String(draft.created_from_transaction_id || draft.sourceTransactionId || '').trim(),
    set_ignored: !!draft.set_ignored,
    apply_to_unreviewed_only: draft.apply_to_unreviewed_only === undefined ? true : !!draft.apply_to_unreviewed_only,
  };

  if (next.set_ignored || next.set_type === 'Ignore') {
    next.set_ignored = true;
    next.set_type = 'Ignore';
    next.set_category = 'Ignore';
    return next;
  }

  const categories = getCategoryOptionsForType(next.set_type);
  if (!categories.includes(next.set_category)) {
    next.set_category = defaultCategoryForType(next.set_type, 0);
    if (!categories.includes(next.set_category)) {
      next.set_category = categories[0] || '';
    }
  }
  return next;
}

export function openRuleEditor(options = {}, currentReviewDraft = null) {
  const transaction = options.transaction || null;
  const seed = options.rule
    ? { ...options.rule, mode: 'edit', source: options.source || 'settings' }
    : { mode: 'create', source: options.source || 'settings' };

  if (transaction) {
    seed.sourceTransactionId = transaction.id;
    seed.sourceTransactionLabel = transaction.merchant_name || transaction.name || '';
    const cleanMatch = getRuleMatchValueFromTransaction(transaction);
    seed.name = seed.name || cleanMatch || transaction.merchant_name || transaction.name || '';
    seed.match_value = seed.match_value || cleanMatch || transaction.merchant_name || transaction.name || '';
    seed.match_type = seed.match_type || (transaction.merchant_name ? 'merchant_contains' : 'contains');
    seed.account_id = seed.account_id || transaction.account_id || '';
    seed.created_from_transaction_id = seed.created_from_transaction_id || transaction.id || '';
    if (!options.rule && currentReviewDraft) {
      seed.set_type = currentReviewDraft.type;
      seed.set_category = currentReviewDraft.category;
      seed.apply_type = currentReviewDraft.type;
      seed.apply_category = currentReviewDraft.category;
      seed.set_ignored = !!currentReviewDraft.ignored;
    }
  }

  ruleEditorState = { draft: normalizeRuleDraft(seed), error: '' };
  requestPageRerender();
}

export function closeRuleEditor() {
  ruleEditorState = null;
  requestPageRerender();
}

function getRuleEditorAccountOptions(accounts = []) {
  const unique = new Map();
  for (const account of (accounts || [])) {
    const id = String(account?.id || account?.account_id || '').trim();
    if (!id || unique.has(id)) continue;
    const name = String(account?.name || account?.account_name || 'Account').trim();
    const institution = String(account?.institution_name || '').trim();
    const mask = String(account?.mask || '').trim();
    const label = institution
      ? name + ' - ' + institution + (mask ? ' (' + mask + ')' : '')
      : name + (mask ? ' (' + mask + ')' : '');
    unique.set(id, { id, label });
  }
  return Array.from(unique.values());
}

export function getConfidenceModeLabel(mode) {
  return CONFIDENCE_MODE_LABELS[String(mode || 'suggest')] || String(mode || 'Suggest');
}

export function renderRuleEditorModalHtml(accounts = [], options = {}) {
  if (!ruleEditorState || !ruleEditorState.draft) return '';

  const draft = ruleEditorState.draft;
  const accountOptions = getRuleEditorAccountOptions(accounts);
  const categoryOptions = getCategoryOptionsForType(draft.set_type);
  const displayCategoryOptions = draft.set_category && !categoryOptions.includes(draft.set_category)
    ? [draft.set_category, ...categoryOptions]
    : categoryOptions;
  const title = draft.mode === 'edit' ? 'Edit Rule' : 'Create Rule';
  const description = draft.sourceTransactionLabel
    ? 'Create a reusable rule from this transaction pattern.'
    : 'Manage how future transactions should be classified.';
  const confidenceModeLabel = getConfidenceModeLabel(draft.confidence_mode);
  const confidenceHelp = CONFIDENCE_MODE_HELP[draft.confidence_mode] || CONFIDENCE_MODE_HELP.suggest;

  return (
    '<div class="modal-backdrop" data-action="close-rule-editor"></div>' +
    '<section class="review-modal" role="dialog" aria-modal="true" aria-label="' + escapeHtml(title) + '">' +
    '<div class="card-header">' +
    '<h3 class="card-title">' + escapeHtml(title) + '</h3>' +
    '<p class="card-description">' + escapeHtml(description) + '</p>' +
    '</div>' +
    (draft.sourceTransactionLabel
      ? '<div class="card" style="margin-bottom: 16px;"><p class="card-description">Source transaction</p><p style="margin: 6px 0 0;">' + escapeHtml(draft.sourceTransactionLabel) + '</p></div>'
      : '') +
    '<div class="form-grid">' +
    '<label class="form-field"><span>Rule Name</span><input type="text" id="rule-name" value="' + escapeHtml(draft.name) + '" placeholder="Amazon purchases"></label>' +
    '<label class="form-field"><span>Confidence</span><select id="rule-confidence-mode">' +
    ['suggest', 'auto_apply', 'ignore'].map((mode) => '<option value="' + mode + '"' + (draft.confidence_mode === mode ? ' selected' : '') + '>' + escapeHtml(CONFIDENCE_MODE_LABELS[mode] || mode) + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field"><span>Priority</span><input type="number" step="1" id="rule-priority" value="' + escapeHtml(String(draft.priority)) + '" placeholder="100"></label>' +
    '<label class="form-field"><span>Match Type</span><select id="rule-match-type">' +
    ['merchant_contains', 'merchant_equals', 'description_contains', 'contains', 'exact', 'starts_with'].map((mt) => '<option value="' + mt + '"' + (draft.match_type === mt ? ' selected' : '') + '>' + mt.replaceAll('_', ' ') + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field"><span>Match Value</span><input type="text" id="rule-match-value" value="' + escapeHtml(draft.match_value) + '" placeholder="merchant or description text"></label>' +
    '<label class="form-field"><span>Account</span><select id="rule-account-id"><option value="">All accounts</option>' +
    accountOptions.map((a) => '<option value="' + escapeHtml(a.id) + '"' + (draft.account_id === a.id ? ' selected' : '') + '>' + escapeHtml(a.label) + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field"><span>Amount Min</span><input type="number" step="0.01" id="rule-amount-min" value="' + escapeHtml(String(draft.amount_min)) + '" placeholder="Optional"></label>' +
    '<label class="form-field"><span>Amount Max</span><input type="number" step="0.01" id="rule-amount-max" value="' + escapeHtml(String(draft.amount_max)) + '" placeholder="Optional"></label>' +
    '<label class="form-field"><span>Set Type</span><select id="rule-set-type"' + (draft.set_ignored ? ' disabled' : '') + '>' +
    TRANSACTION_TYPES.map((t) => '<option value="' + t + '"' + (draft.set_type === t ? ' selected' : '') + '>' + t + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field"><span>Set Category</span><select id="rule-set-category"' + (draft.set_ignored ? ' disabled' : '') + '>' +
    displayCategoryOptions.map((c) => '<option value="' + escapeHtml(c) + '"' + (draft.set_category === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field field-checkbox"><input type="checkbox" id="rule-enabled"' + (draft.enabled ? ' checked' : '') + '> <span>Enabled</span></label>' +
    '<label class="form-field field-checkbox"><input type="checkbox" id="rule-unreviewed-only"' + (draft.apply_to_unreviewed_only ? ' checked' : '') + '> <span>Only apply to unreviewed transactions</span></label>' +
    '<label class="form-field field-checkbox"><input type="checkbox" id="rule-apply-reviewed"' + (draft.apply_reviewed ? ' checked' : '') + '> <span>Mark matched transactions reviewed</span></label>' +
    '<label class="form-field field-checkbox"><input type="checkbox" id="rule-apply-pending"' + (draft.apply_to_pending ? ' checked' : '') + '> <span>Auto-apply to pending transactions</span></label>' +
    '<label class="form-field field-checkbox"><input type="checkbox" id="rule-set-ignored"' + (draft.set_ignored ? ' checked' : '') + '> <span>Mark matching transactions as ignored</span></label>' +
    '</div>' +
    '<p class="card-description" style="margin-top: 0;">' + escapeHtml(confidenceModeLabel) + ': ' + escapeHtml(confidenceHelp) + '</p>' +
    '<div id="rule-editor-error" class="settings-message error">' + escapeHtml(ruleEditorState.error || '') + '</div>' +
    '<div class="filter-actions">' +
    '<button type="button" class="button button-secondary" data-action="close-rule-editor">Close</button>' +
    (options.showDraftPreviewButton === false ? '' : '<button type="button" class="button button-secondary" data-action="preview-rule-draft">Preview matches</button>') +
    '<button type="button" class="button button-primary" data-action="save-rule-editor">' + (draft.mode === 'edit' ? 'Save Rule' : 'Create Rule') + '</button>' +
    '</div>' +
    '</section>'
  );
}

export function renderRulePreviewTableHtml(result, options = {}) {
  const rows = Array.isArray(result?.preview) ? result.preview : Array.isArray(result) ? result : [];
  const matchedCount = Number(result?.matchedCount ?? rows.length ?? 0);
  const updatedCount = Number(result?.updatedCount ?? rows.filter((row) => row?.willApply !== false).length ?? 0);
  const skippedPendingCount = Number(result?.skippedPendingCount ?? rows.filter((row) => row?.skipReason === 'pending').length ?? 0);
  const skippedReviewedCount = Number(result?.skippedReviewedCount ?? rows.filter((row) => row?.skipReason === 'reviewed').length ?? 0);
  const title = options.title || 'Rule Preview';

  const rowsHtml = rows.length
    ? rows.map((row) => (
      '<tr>' +
      '<td>' + escapeHtml(row.ruleName || '-') + '</td>' +
      '<td>' + escapeHtml(row.date || '-') + '</td>' +
      '<td>' + escapeHtml(row.merchantName || row.name || '-') + '</td>' +
      '<td>' + escapeHtml(row.accountName || row.accountId || '-') + '</td>' +
      '<td>' + escapeHtml(row.currentType || '-') + '</td>' +
      '<td>' + escapeHtml(row.currentCategory || '-') + '</td>' +
      '<td>' + escapeHtml(row.newType || '-') + '</td>' +
      '<td>' + escapeHtml(row.newCategory || '-') + '</td>' +
      '<td><span class="' + (row.pending ? 'status-needs-review' : 'status-reviewed') + '">' + escapeHtml(row.pending ? 'Pending' : 'Posted') + '</span></td>' +
      '<td>' + escapeHtml(row.reviewed ? 'Reviewed' : 'Needs Review') + '</td>' +
      '</tr>'
    )).join('')
    : '<tr><td colspan="10"><div class="empty-state">No matches found.</div></td></tr>';

  return (
    '<div class="modal-backdrop" data-action="close-rule-preview"></div>' +
    '<section class="review-modal rule-preview-modal" role="dialog" aria-modal="true" aria-label="' + escapeHtml(title) + '">' +
    '<div class="card-header"><h3 class="card-title">' + escapeHtml(title) + '</h3><p class="card-description">' + escapeHtml(matchedCount + ' matched, ' + updatedCount + ' would update' + (skippedPendingCount || skippedReviewedCount ? ', ' + skippedPendingCount + ' pending skipped, ' + skippedReviewedCount + ' reviewed skipped' : '')) + '</p></div>' +
    '<div class="table-wrap"><table class="table table-compact"><thead><tr><th>Rule</th><th>Date</th><th>Merchant</th><th>Account</th><th>Current Type</th><th>Current Category</th><th>New Type</th><th>New Category</th><th>Pending</th><th>Reviewed</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
    '<div class="filter-actions"><button type="button" class="button button-secondary" data-action="close-rule-preview">Close</button></div>' +
    '</section>'
  );
}

/** Update draft field and emit re-render (called from change/input handlers). */
export function updateRuleEditorDraftField(field, value) {
  if (!ruleEditorState) return;
  const updated = normalizeRuleDraft({ ...ruleEditorState.draft, [field]: value });
  ruleEditorState = { ...ruleEditorState, draft: updated, error: '' };
  const needsRerender = ['set_type', 'set_ignored', 'rule-set-type', 'rule-set-ignored'].includes(field);
  if (needsRerender) requestPageRerender();
}

export function setRuleEditorError(msg) {
  if (ruleEditorState) {
    ruleEditorState = { ...ruleEditorState, error: msg };
  }
}
