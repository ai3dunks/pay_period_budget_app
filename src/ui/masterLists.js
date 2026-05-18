/**
 * Master Lists page — Expense List + Recurring Bills List.
 */

import { escapeHtml } from '../utils/dom.js';
import { formatCurrency, normalizeMatchWordsInput } from '../utils/formatters.js';
import {
  getMasterLists,
  createExpenseItem,
  updateExpenseItem,
  toggleExpenseItemActive,
  createRecurringBill,
  updateRecurringBill,
  toggleRecurringBillActive,
} from '../api/masterListsApi.js';

// ── page-level state ────────────────────────────────────────────────────────
let _uiState = {
  activeTab: 'expense',
  editingId: null,
  editingType: '',
  message: '',
  error: '',
};
let _delegationBody = null;

// ── Public render ────────────────────────────────────────────────────────────
export async function renderMasterLists(container) {
  _renderFrame(container);
  const body = document.getElementById('page-body');
  if (!body) return;
  body.innerHTML = '<section class="card"><p class="empty-state">Loading master lists...</p></section>';

  const data = await getMasterLists(false);

  if (!data.loaded) {
    body.innerHTML = '<section class="card"><div class="error-card">' + escapeHtml(data.error || 'Backend not reachable through the local API proxy.') + '</div></section>';
    return;
  }

  _paint(body, data);
  _attachDelegation(body, container);
}

// ── Private helpers ──────────────────────────────────────────────────────────
function _renderFrame(container) {
  container.innerHTML =
    '<header class="page-header">' +
    '<div class="page-header-main"><h2 class="page-title">Master Lists</h2><p class="page-description">Manage expense and recurring bill templates that power planning views.</p></div>' +
    '<div class="page-header-right"><span class="status-badge">Editable</span></div>' +
    '</header><div id="page-body" class="page-body"></div>';
}

function _paint(body, data) {
  const isExpense = _uiState.activeTab === 'expense';
  const rows = isExpense ? data.expenseList : data.recurringBillsList;
  const tableRows = rows.length
    ? rows.map((row) => {
        if (_uiState.editingId === row.id && _uiState.editingType === _uiState.activeTab) {
          return isExpense ? _expenseEditRow(row) : _billEditRow(row);
        }
        return isExpense ? _expenseRow(row) : _billRow(row);
      }).join('')
    : (isExpense ? '<tr><td colspan="5">No expenses yet.</td></tr>' : '<tr><td colspan="10">No recurring bills yet.</td></tr>');

  body.innerHTML =
    '<section class="card">' +
    '<div class="master-tabs">' + _tabsHtml() + '</div>' +
    (_uiState.error ? '<p class="message message-error">' + escapeHtml(_uiState.error) + '</p>' : '') +
    (_uiState.message ? '<p class="message message-success">' + escapeHtml(_uiState.message) + '</p>' : '') +
    (isExpense ? _expenseAddForm() : _billAddForm()) +
    '<div class="table-wrap"><table class="table master-table">' +
    (isExpense
      ? '<thead><tr><th>Name</th><th>Budget Amount</th><th>Active</th><th>Notes</th><th>Actions</th></tr></thead>'
      : '<thead><tr><th>Name</th><th>Category</th><th>Due</th><th>Amount</th><th>Paid From</th><th>Match Words</th><th>Autopay</th><th>Active</th><th>Notes</th><th>Actions</th></tr></thead>') +
    '<tbody>' + tableRows + '</tbody></table></div></section>';
}

function _tabsHtml() {
  return [
    { id: 'expense', label: 'Expense List' },
    { id: 'recurring-bills', label: 'Recurring Bills List' },
  ].map((tab) =>
    '<button class="master-tab' + (_uiState.activeTab === tab.id ? ' active' : '') + '" data-action="master-list-tab" data-list-type="' + tab.id + '">' +
    tab.label + '</button>'
  ).join('');
}

function _expenseAddForm() {
  return '<div class="master-form"><div class="form-grid">' +
    '<label class="form-field"><span>Name</span><input id="expense-add-name" placeholder="Item name"></label>' +
    '<label class="form-field"><span>Budget Amount</span><input id="expense-add-budget-amount" type="number" step="0.01" value="0"></label>' +
    '<label class="form-field field-checkbox"><input id="expense-add-active" type="checkbox" checked> <span>Active</span></label>' +
    '<label class="form-field"><span>Notes</span><textarea id="expense-add-notes" rows="2" placeholder="Optional notes"></textarea></label>' +
    '</div><div class="inline-actions"><button class="button button-primary" data-action="master-expense-add">Add expense</button></div></div>';
}

function _billAddForm() {
  return '<div class="master-form"><div class="form-grid">' +
    '<label class="form-field"><span>Name</span><input id="recurring-add-name" placeholder="Bill name"></label>' +
    '<label class="form-field"><span>Category</span><select id="recurring-add-category"><option>Needs</option><option>Wants</option><option>Debts/Savings</option></select></label>' +
    '<label class="form-field"><span>Due</span><input id="recurring-add-due-day" type="number" min="1" max="31" value="1"></label>' +
    '<label class="form-field"><span>Amount</span><input id="recurring-add-amount" type="number" step="0.01" value="0"></label>' +
    '<label class="form-field"><span>Paid From</span><input id="recurring-add-paid-from" type="text" placeholder="Optional"></label>' +
    '<label class="form-field"><span>Match Words</span><input id="recurring-add-match-words" type="text" placeholder="Example: netflix, streaming, autopay"><small class="muted-note">Use words that appear in the bank transaction description. Separate multiple words with commas.</small></label>' +
    '<label class="form-field"><span>Autopay</span><select id="recurring-add-autopay"><option value="1">Yes</option><option value="0">No</option></select></label>' +
    '<label class="form-field field-checkbox"><input id="recurring-add-active" type="checkbox" checked> <span>Active</span></label>' +
    '<label class="form-field"><span>Notes</span><textarea id="recurring-add-notes" rows="2" placeholder="Optional notes"></textarea></label>' +
    '</div><div class="inline-actions"><button class="button button-primary" data-action="master-recurring-add">Add recurring bill</button></div></div>';
}

function _expenseRow(row) {
  return '<tr>' +
    '<td>' + escapeHtml(row.name) + '</td>' +
    '<td>' + escapeHtml(formatCurrency(row.budgetAmount)) + '</td>' +
    '<td>' + _activeBadge(row.active) + '</td>' +
    '<td>' + escapeHtml(row.notes || '') + '</td>' +
    '<td class="inline-actions">' +
    '<button class="button button-secondary button-sm" data-action="master-expense-edit" data-id="' + escapeHtml(row.id) + '">Edit</button>' +
    '<button class="button button-secondary button-sm" data-action="master-expense-toggle-active" data-id="' + escapeHtml(row.id) + '" data-active="' + (row.active ? '1' : '0') + '">' + (row.active ? 'Deactivate' : 'Reactivate') + '</button>' +
    '</td></tr>';
}

function _billRow(row) {
  return '<tr>' +
    '<td>' + escapeHtml(row.name) + '</td>' +
    '<td>' + escapeHtml(row.category || '') + '</td>' +
    '<td>' + escapeHtml(String(row.dueDay ?? '')) + '</td>' +
    '<td>' + escapeHtml(formatCurrency(row.amount)) + '</td>' +
    '<td>' + escapeHtml(row.paidFrom || '') + '</td>' +
    '<td>' + escapeHtml((row.matchWords || []).join(', ')) + '</td>' +
    '<td>' + escapeHtml(row.autopay ? 'Yes' : 'No') + '</td>' +
    '<td>' + _activeBadge(row.active) + '</td>' +
    '<td>' + escapeHtml(row.notes || '') + '</td>' +
    '<td class="inline-actions">' +
    '<button class="button button-secondary button-sm" data-action="master-recurring-edit" data-id="' + escapeHtml(row.id) + '">Edit</button>' +
    '<button class="button button-secondary button-sm" data-action="master-recurring-toggle-active" data-id="' + escapeHtml(row.id) + '" data-active="' + (row.active ? '1' : '0') + '">' + (row.active ? 'Deactivate' : 'Reactivate') + '</button>' +
    '</td></tr>';
}

function _expenseEditRow(row) {
  return '<tr><td colspan="5"><div class="master-form"><div class="form-grid">' +
    '<label class="form-field"><span>Name</span><input id="expense-edit-name" value="' + escapeHtml(row.name) + '"></label>' +
    '<label class="form-field"><span>Budget Amount</span><input id="expense-edit-budget-amount" type="number" step="0.01" value="' + escapeHtml(String(row.budgetAmount ?? 0)) + '"></label>' +
    '<label class="form-field field-checkbox"><input id="expense-edit-active" type="checkbox"' + (row.active ? ' checked' : '') + '> <span>Active</span></label>' +
    '<label class="form-field"><span>Notes</span><textarea id="expense-edit-notes" rows="2">' + escapeHtml(row.notes || '') + '</textarea></label>' +
    '</div><div class="inline-actions">' +
    '<button class="button button-primary" data-action="master-expense-save" data-id="' + escapeHtml(row.id) + '">Save</button>' +
    '<button class="button button-secondary" data-action="master-expense-cancel">Cancel</button>' +
    '</div></div></td></tr>';
}

function _billEditRow(row) {
  return '<tr><td colspan="10"><div class="master-form"><div class="form-grid">' +
    '<label class="form-field"><span>Name</span><input id="recurring-edit-name" value="' + escapeHtml(row.name) + '"></label>' +
    '<label class="form-field"><span>Category</span><select id="recurring-edit-category">' +
    ['Needs', 'Wants', 'Debts/Savings'].map((o) => '<option' + (row.category === o ? ' selected' : '') + '>' + o + '</option>').join('') +
    '</select></label>' +
    '<label class="form-field"><span>Due</span><input id="recurring-edit-due-day" type="number" min="1" max="31" value="' + escapeHtml(String(row.dueDay ?? 1)) + '"></label>' +
    '<label class="form-field"><span>Amount</span><input id="recurring-edit-amount" type="number" step="0.01" value="' + escapeHtml(String(row.amount ?? 0)) + '"></label>' +
    '<label class="form-field"><span>Paid From</span><input id="recurring-edit-paid-from" type="text" value="' + escapeHtml(row.paidFrom || '') + '"></label>' +
    '<label class="form-field"><span>Match Words</span><input id="recurring-edit-match-words" type="text" value="' + escapeHtml((row.matchWords || []).join(', ')) + '" placeholder="Example: netflix, streaming, autopay"><small class="muted-note">Comma separated words from bank description.</small></label>' +
    '<label class="form-field"><span>Autopay</span><select id="recurring-edit-autopay"><option value="1"' + (row.autopay ? ' selected' : '') + '>Yes</option><option value="0"' + (!row.autopay ? ' selected' : '') + '>No</option></select></label>' +
    '<label class="form-field field-checkbox"><input id="recurring-edit-active" type="checkbox"' + (row.active ? ' checked' : '') + '> <span>Active</span></label>' +
    '<label class="form-field"><span>Notes</span><textarea id="recurring-edit-notes" rows="2">' + escapeHtml(row.notes || '') + '</textarea></label>' +
    '</div><div class="inline-actions">' +
    '<button class="button button-primary" data-action="master-recurring-save" data-id="' + escapeHtml(row.id) + '">Save</button>' +
    '<button class="button button-secondary" data-action="master-recurring-cancel">Cancel</button>' +
    '</div></div></td></tr>';
}

function _activeBadge(active) {
  return active ? '<span class="status-active">Active</span>' : '<span class="status-inactive">Inactive</span>';
}

function _readExpenseForm(prefix) {
  return {
    name: document.getElementById(prefix + '-name')?.value || '',
    budgetAmount: document.getElementById(prefix + '-budget-amount')?.value || 0,
    active: !!document.getElementById(prefix + '-active')?.checked,
    notes: document.getElementById(prefix + '-notes')?.value || '',
  };
}

function _readBillForm(prefix) {
  return {
    name: document.getElementById(prefix + '-name')?.value || '',
    category: document.getElementById(prefix + '-category')?.value || 'Needs',
    dueDay: document.getElementById(prefix + '-due-day')?.value || 1,
    amount: document.getElementById(prefix + '-amount')?.value || 0,
    paidFrom: document.getElementById(prefix + '-paid-from')?.value || '',
    matchWords: normalizeMatchWordsInput(document.getElementById(prefix + '-match-words')?.value || ''),
    autopay: document.getElementById(prefix + '-autopay')?.value || '0',
    active: !!document.getElementById(prefix + '-active')?.checked,
    notes: document.getElementById(prefix + '-notes')?.value || '',
  };
}

async function _repaint(container) {
  const data = await getMasterLists(false);
  const body = document.getElementById('page-body');
  if (body) _paint(body, data);
}

function _attachDelegation(body, container) {
  if (!body) return;
  if (_delegationBody === body) return;
  _delegationBody = body;
  if (import.meta.env?.DEV) {
    console.debug('[master-lists] delegation attached');
  }

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'master-list-tab') {
      _uiState = { ..._uiState, activeTab: btn.dataset.listType, editingId: null, editingType: '', error: '', message: '' };
      const data = await getMasterLists(false);
      _paint(body, data);
      return;
    }

    _uiState = { ..._uiState, error: '', message: '' };

    if (action === 'master-expense-add') {
      btn.disabled = true;
      try {
        const form = _readExpenseForm('expense-add');
        await createExpenseItem(form);
        await getMasterLists(true);
        _uiState.message = 'Expense added.';
        await _repaint(container);
      } catch (err) {
        _uiState.error = err.offline ? 'Backend not reachable through the local API proxy.' : err.message;
        await _repaint(container);
      } finally { btn.disabled = false; }
      return;
    }
    if (action === 'master-expense-edit') {
      _uiState = { ..._uiState, editingId: btn.dataset.id, editingType: 'expense' };
      const data = await getMasterLists(false);
      _paint(body, data);
      return;
    }
    if (action === 'master-expense-cancel') {
      _uiState = { ..._uiState, editingId: null, editingType: '' };
      const data = await getMasterLists(false);
      _paint(body, data);
      return;
    }
    if (action === 'master-expense-save') {
      btn.disabled = true;
      try {
        const form = _readExpenseForm('expense-edit');
        await updateExpenseItem(btn.dataset.id, form);
        _uiState = { ..._uiState, editingId: null, editingType: '' };
        await getMasterLists(true);
        _uiState.message = 'Expense updated.';
        await _repaint(container);
      } catch (err) {
        _uiState.error = err.offline ? 'Backend not reachable through the local API proxy.' : err.message;
        await _repaint(container);
      } finally { btn.disabled = false; }
      return;
    }
    if (action === 'master-expense-toggle-active') {
      btn.disabled = true;
      try {
        await toggleExpenseItemActive(btn.dataset.id, btn.dataset.active === '1');
        await getMasterLists(true);
        _uiState.message = btn.dataset.active === '1' ? 'Expense deactivated.' : 'Expense reactivated.';
        await _repaint(container);
      } catch (err) {
        _uiState.error = err.offline ? 'Backend not reachable through the local API proxy.' : err.message;
        await _repaint(container);
      } finally { btn.disabled = false; }
      return;
    }

    if (action === 'master-recurring-add') {
      btn.disabled = true;
      try {
        const form = _readBillForm('recurring-add');
        await createRecurringBill(form);
        await getMasterLists(true);
        _uiState.message = 'Recurring bill added.';
        await _repaint(container);
      } catch (err) {
        _uiState.error = err.offline ? 'Backend not reachable through the local API proxy.' : err.message;
        await _repaint(container);
      } finally { btn.disabled = false; }
      return;
    }
    if (action === 'master-recurring-edit') {
      _uiState = { ..._uiState, editingId: btn.dataset.id, editingType: 'recurring-bills' };
      const data = await getMasterLists(false);
      _paint(body, data);
      return;
    }
    if (action === 'master-recurring-cancel') {
      _uiState = { ..._uiState, editingId: null, editingType: '' };
      const data = await getMasterLists(false);
      _paint(body, data);
      return;
    }
    if (action === 'master-recurring-save') {
      btn.disabled = true;
      try {
        const form = _readBillForm('recurring-edit');
        await updateRecurringBill(btn.dataset.id, form);
        _uiState = { ..._uiState, editingId: null, editingType: '' };
        await getMasterLists(true);
        _uiState.message = 'Recurring bill updated.';
        await _repaint(container);
      } catch (err) {
        _uiState.error = err.offline ? 'Backend not reachable through the local API proxy.' : err.message;
        await _repaint(container);
      } finally { btn.disabled = false; }
      return;
    }
    if (action === 'master-recurring-toggle-active') {
      btn.disabled = true;
      try {
        await toggleRecurringBillActive(btn.dataset.id, btn.dataset.active === '1');
        await getMasterLists(true);
        _uiState.message = btn.dataset.active === '1' ? 'Recurring bill deactivated.' : 'Recurring bill reactivated.';
        await _repaint(container);
      } catch (err) {
        _uiState.error = err.offline ? 'Backend not reachable through the local API proxy.' : err.message;
        await _repaint(container);
      } finally { btn.disabled = false; }
      return;
    }
  });
}
