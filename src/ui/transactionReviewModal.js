/**
 * Transaction Review Modal — pure HTML builder. Stateless.
 * State (reviewModalTransactionId, reviewDraft) is owned by transactions.js.
 */

import { escapeHtml } from '../utils/dom.js';
import { TRANSACTION_TYPES, getCategoryOptionsForType, defaultCategoryForType } from './rulesManager.js';

/**
 * normalizeReviewDraft — merge transaction defaults with draft overrides.
 * @param {object} transaction  - the raw transaction row
 * @param {object} draft        - partial draft overrides (may be {})
 * @param {function} getCategoryOptionsFn  - getCategoryOptionsForType
 * @returns {object} normalized draft
 */
export function normalizeReviewDraft(transaction, draft, getCategoryOptionsFn) {
  const getOpts = getCategoryOptionsFn || getCategoryOptionsForType;
  const next = {
    type: draft.type || transaction.type || 'Expense',
    category: draft.category || transaction.category || '',
    notes: draft.notes ?? transaction.notes ?? '',
    reviewed: draft.reviewed === undefined ? !!transaction.reviewed : !!draft.reviewed,
    ignored: draft.ignored === undefined ? !!transaction.ignored : !!draft.ignored,
  };

  const validCategories = getOpts(next.type);
  const shouldCoerce = !!draft.forceCoerceCategory;
  if (!validCategories.includes(next.category) && shouldCoerce) {
    next.category = defaultCategoryForType(next.type, Number(transaction.amount || 0));
    if (!validCategories.includes(next.category)) {
      next.category = validCategories[0] || '';
    }
  }
  if (next.type === 'Ignore') {
    next.category = 'Ignore';
    next.ignored = true;
  }
  return next;
}

/**
 * renderReviewModalHtml — builds the full review modal HTML string.
 * Caller is responsible for injecting this into the page.
 */
export function renderReviewModalHtml(transaction, draft, categoryOptions) {
  const draftCategoryOptions = categoryOptions || getCategoryOptionsForType(draft.type);
  const displayOptions = draftCategoryOptions.includes(draft.category) || !draft.category
    ? draftCategoryOptions
    : [draft.category, ...draftCategoryOptions];

  const fmt = (amount) => {
    const abs = Math.abs(amount).toFixed(2);
    return amount < 0 ? '-$' + abs : '+$' + abs;
  };

  return (
    '<div class="modal-backdrop" data-action="close-review-modal"></div>' +
    '<section class="review-modal" role="dialog" aria-modal="true" aria-label="Review transaction">' +
    '<div class="card-header">' +
    '<h3 class="card-title">Review Transaction</h3>' +
    '<p class="card-description">Edit type and category, then save review.</p>' +
    '</div>' +
    '<div class="form-grid review-details">' +
    '<p><strong>Date:</strong> ' + escapeHtml(transaction.date || '-') + '</p>' +
    '<p><strong>Account:</strong> ' + escapeHtml((transaction.account_name || '') + (transaction.mask ? ' (' + transaction.mask + ')' : '')) + '</p>' +
    '<p><strong>Description:</strong> ' + escapeHtml(transaction.name || '-') + '</p>' +
    '<p><strong>Merchant:</strong> ' + escapeHtml(transaction.merchant_name || '-') + '</p>' +
    '<p><strong>Amount:</strong> ' + escapeHtml(fmt(Number(transaction.amount || 0))) + '</p>' +
    '<p><strong>Pending:</strong> ' + (transaction.pending ? 'Yes' : 'No') + '</p>' +
    '</div>' +
    '<div class="form-grid">' +
    '<label class="form-field"><span>Type</span><select id="review-type">' +
    TRANSACTION_TYPES.map((t) => '<option value="' + t + '"' + (draft.type === t ? ' selected' : '') + '>' + t + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field"><span>Category</span><select id="review-category">' +
    displayOptions.map((c) => '<option value="' + escapeHtml(c) + '"' + (draft.category === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field"><span>Notes</span><textarea id="review-notes" rows="3" placeholder="Optional notes">' + escapeHtml(draft.notes || '') + '</textarea></label>' +
    '<label class="form-field field-checkbox"><input type="checkbox" id="review-reviewed"' + (draft.reviewed ? ' checked' : '') + '> <span>Reviewed</span></label>' +
    '</div>' +
    '<div id="review-error" class="settings-message error"></div>' +
    '<div class="filter-actions">' +
    '<button type="button" class="button button-secondary" data-action="close-review-modal">Close</button>' +
    '<button type="button" class="button button-secondary" data-action="create-rule-from-transaction" data-id="' + escapeHtml(transaction.id) + '">Create rule from this transaction</button>' +
    '<button type="button" class="button button-primary" data-action="save-transaction-review" data-id="' + escapeHtml(transaction.id) + '">Save Review</button>' +
    '</div>' +
    '</section>'
  );
}
