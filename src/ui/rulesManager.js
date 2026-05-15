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
    match_type: String(draft.match_type || 'contains').trim(),
    match_value: String(draft.match_value || '').trim(),
    account_id: String(draft.account_id || '').trim(),
    amount_min: draft.amount_min ?? '',
    amount_max: draft.amount_max ?? '',
    set_type: String(draft.set_type || 'Expense').trim(),
    set_category: String(draft.set_category || '').trim(),
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
    seed.name = seed.name || transaction.merchant_name || transaction.name || '';
    seed.match_value = seed.match_value || transaction.merchant_name || transaction.name || '';
    seed.match_type = seed.match_type || (transaction.merchant_name ? 'merchant_contains' : 'contains');
    seed.account_id = seed.account_id || transaction.account_id || '';
    if (!options.rule && currentReviewDraft) {
      seed.set_type = currentReviewDraft.type;
      seed.set_category = currentReviewDraft.category;
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

export function renderRuleEditorModalHtml(accounts = []) {
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
    '<label class="form-field"><span>Match Type</span><select id="rule-match-type">' +
    ['contains', 'exact', 'starts_with', 'merchant_contains'].map((mt) => '<option value="' + mt + '"' + (draft.match_type === mt ? ' selected' : '') + '>' + mt + '</option>').join('') +
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
    '<label class="form-field field-checkbox"><input type="checkbox" id="rule-set-ignored"' + (draft.set_ignored ? ' checked' : '') + '> <span>Mark matching transactions as ignored</span></label>' +
    '</div>' +
    '<div id="rule-editor-error" class="settings-message error">' + escapeHtml(ruleEditorState.error || '') + '</div>' +
    '<div class="filter-actions">' +
    '<button class="button button-secondary" data-action="close-rule-editor">Close</button>' +
    '<button class="button button-primary" data-action="save-rule-editor">' + (draft.mode === 'edit' ? 'Save Rule' : 'Create Rule') + '</button>' +
    '</div>' +
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
