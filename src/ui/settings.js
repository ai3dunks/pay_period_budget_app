/**
 * Settings page — Plaid connection, Rules Manager, Safe Money, Data Tools, Backup.
 */

import { escapeHtml } from '../utils/dom.js';
import { renderBackupSection } from './backup.js';
import {
  getPlaidStatus,
  getAccounts,
  createLinkToken,
  exchangePublicToken,
  syncTransactions,
  removePlaidItem,
  cleanupRemovedPlaid,
  loadPlaidScript,
} from '../api/plaidApi.js';
import { getRules, createRule, patchRule, applyRules } from '../api/rulesApi.js';
import { getSetting, updateSetting } from '../api/settingsApi.js';
import { API_BASE } from '../api/client.js';
import {
  getRuleEditorState,
  openRuleEditor,
  closeRuleEditor,
  normalizeRuleDraft,
  renderRuleEditorModalHtml,
  setRuleEditorError,
  updateRuleEditorDraftField,
} from './rulesManager.js';
import { emitAppEvent } from '../app/events.js';

// ── page-level state ────────────────────────────────────────────────────────
let _rulesMessage = '';
let _rulesMessageType = 'success';

export async function renderSettings(container) {
  const body = _renderFrame(container);
  if (!body) return;
  body.innerHTML = '<section class="card"><p class="empty-state">Loading connection status...</p></section>';

  let status;
  let activeAccounts = [];
  let rules = [];
  let safeMoneySettings = {};

  try {
    const [statusData, accountsData, rulesData] = await Promise.all([
      getPlaidStatus(),
      getAccounts().catch(() => null),
      getRules().catch(() => []),
    ]);
    status = statusData;
    activeAccounts = accountsData ?? (Array.isArray(status?.accounts) ? status.accounts : []);
    rules = Array.isArray(rulesData) ? rulesData : [];
    safeMoneySettings = await getSetting('safe_money_settings').catch(() => ({}));
  } catch (err) {
    body.innerHTML =
      '<section class="card"><div class="error-card">Backend not running on ' + API_BASE + '.' +
      '<br><small>' + escapeHtml(err.message) + '</small></div></section>';
    return;
  }

  const connected = !!status?.connected;
  const items = Array.isArray(status?.items) ? status.items : [];
  const removedItemsCount = Number(status?.removedItemsCount || 0);
  const staleAccountsCount = Number(status?.staleAccountsCount || 0);
  const accountCount = activeAccounts.length;

  const itemsHtml = connected && items.length
    ? items.map((item) =>
        '<div class="institution-row" data-item-id="' + escapeHtml(item.itemId) + '">' +
        '<strong>' + escapeHtml(item.institutionName || 'Unknown Bank') + '</strong>' +
        '<span class="status-badge">' + escapeHtml(item.status || 'active') + '</span>' +
        (item.lastSyncedAt
          ? '<small>Last synced: ' + escapeHtml(new Date(item.lastSyncedAt).toLocaleString()) + '</small>'
          : '<small>Not yet synced</small>') +
        '<button class="button button-danger button-sm" data-action="remove-plaid-item" data-item-id="' + escapeHtml(item.itemId) + '">Remove</button>' +
        '</div>'
      ).join('')
    : '';

  const safeMoneyBuffer = Number(safeMoneySettings.safetyBuffer ?? safeMoneySettings.safety_buffer ?? 0) || 0;
  const safeMoneyIncludeRollover = safeMoneySettings.includeBoaRolloverInSafeToSpend !== false;
  const safeMoneyIncludePending = safeMoneySettings.includePendingTransactions === true || safeMoneySettings.include_pending_transactions === true;

  const rulesRows = rules.length
    ? rules.map((rule) =>
        '<tr>' +
        '<td>' + (rule.enabled ? '<span class="status-reviewed">Enabled</span>' : '<span class="status-needs-review">Disabled</span>') + '</td>' +
        '<td>' + escapeHtml(rule.name || '-') + '</td>' +
        '<td>' + escapeHtml(rule.match_type || 'contains') + '</td>' +
        '<td>' + escapeHtml(rule.match_value || '') + '</td>' +
        '<td>' + escapeHtml(rule.set_type || '-') + '</td>' +
        '<td>' + escapeHtml(rule.set_category || '-') + '</td>' +
        '<td class="inline-actions">' +
        '<button class="button button-secondary button-sm" data-action="rules-edit" data-id="' + escapeHtml(rule.id) + '">Edit</button>' +
        '<button class="button button-secondary button-sm" data-action="rules-toggle-enabled" data-id="' + escapeHtml(rule.id) + '" data-enabled="' + (rule.enabled ? '1' : '0') + '">' + (rule.enabled ? 'Disable' : 'Enable') + '</button>' +
        '</td></tr>'
      ).join('')
    : '<tr><td colspan="7">No rules yet.</td></tr>';

  const ruleEditorHtml = renderRuleEditorModalHtml(activeAccounts);

  body.innerHTML =
    '<section class="card settings-section">' +
    '<div class="card-header"><h3 class="card-title">Plaid Connection</h3><p class="card-description">Connect your bank and sync transactions.</p></div>' +
    '<div class="connection-status ' + (connected ? 'connected' : 'not-connected') + '">' +
    (connected ? 'Connected' : 'Not connected') +
    (accountCount > 0 ? ' <span class="account-count">' + accountCount + ' account' + (accountCount !== 1 ? 's' : '') + '</span>' : '') +
    '</div>' +
    '<p class="card-description">Removed items: ' + removedItemsCount + ' | Stale accounts: ' + staleAccountsCount + '</p>' +
    (itemsHtml ? '<div class="institutions-list">' + itemsHtml + '</div>' : '<p class="empty-state">No connected institutions yet.</p>') +
    '<div class="settings-actions">' +
    '<button class="button button-primary" data-action="connect-plaid">Connect Bank</button>' +
    (connected ? '<button class="button button-secondary" data-action="sync-transactions">Sync Transactions</button>' : '') +
    '<button class="button button-secondary" data-action="cleanup-removed-plaid">Clean removed bank data</button>' +
    '</div>' +
    '<div id="settings-message" class="settings-message" aria-live="polite"></div>' +
    '</section>' +

    '<section class="card settings-section">' +
    '<div class="card-header"><h3 class="card-title">Rules Manager</h3><p class="card-description">Manage saved transaction classification rules.</p></div>' +
    (_rulesMessage ? '<p class="settings-message ' + (_rulesMessageType === 'error' ? 'error' : 'success') + '">' + escapeHtml(_rulesMessage) + '</p>' : '') +
    '<div class="settings-actions"><button class="button button-secondary" data-action="rules-add">Add Rule</button></div>' +
    '<div class="table-wrap"><table class="table"><thead><tr><th>Status</th><th>Name</th><th>Match Type</th><th>Match Value</th><th>Type</th><th>Category</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rulesRows + '</tbody></table></div>' +
    '</section>' +

    '<section class="card settings-section">' +
    '<div class="card-header"><h3 class="card-title">Data Tools</h3><p class="card-description">Quick actions for data checks and safety backups.</p></div>' +
    '<div class="settings-actions">' +
    '<button class="button button-secondary" data-action="data-tools-run-health">Run Data Health Check</button>' +
    '<button class="button button-secondary" data-action="data-tools-cleanup-removed-plaid">Clean removed bank data</button>' +
    '<button class="button button-secondary" data-action="data-tools-export-backup">Export Backup</button>' +
    '</div></section>' +

    '<section class="card settings-section">' +
    '<div class="card-header"><h3 class="card-title">Safe Money</h3><p class="card-description">Configure the shared safe-to-spend and safe-to-transfer rules.</p></div>' +
    '<div class="form-grid safe-money-settings-grid">' +
    '<label class="form-field"><span>Safety buffer</span><input id="safe-money-buffer" type="number" step="0.01" value="' + escapeHtml(String(safeMoneyBuffer)) + '"></label>' +
    '<label class="form-field checkbox-field"><span><input id="safe-money-rollover" type="checkbox"' + (safeMoneyIncludeRollover ? ' checked' : '') + '> Include BOA rollover in Safe to Spend</span></label>' +
    '<label class="form-field checkbox-field"><span><input id="safe-money-pending" type="checkbox"' + (safeMoneyIncludePending ? ' checked' : '') + '> Include pending transactions in Safe Money</span></label>' +
    '</div>' +
    '<div class="settings-actions"><button class="button button-primary" data-action="safe-money-save">Save Safe Money Settings</button></div>' +
    '<div id="safe-money-message" class="settings-message" aria-live="polite"></div>' +
    '</section>' +

    ruleEditorHtml;

  // Per-render listeners (safe-money only — Plaid actions handled globally)
  body.querySelector('[data-action="safe-money-save"]')?.addEventListener('click', async () => {
    const messageEl = document.getElementById('safe-money-message');
    try {
      const value = {
        safetyBuffer: Number(document.getElementById('safe-money-buffer')?.value || 0),
        includeBoaRolloverInSafeToSpend: !!document.getElementById('safe-money-rollover')?.checked,
        includePendingTransactions: !!document.getElementById('safe-money-pending')?.checked,
      };
      await updateSetting('safe_money_settings', value);
      if (messageEl) { messageEl.className = 'settings-message success'; messageEl.textContent = 'Safe Money settings saved.'; }
    } catch (err) {
      if (messageEl) { messageEl.className = 'settings-message error'; messageEl.textContent = err.message; }
    }
  });

  renderBackupSection(body);
}

// ── Plaid Link orchestration ────────────────────────────────────────────────

export function showSettingsMessage(text, isError = false) {
  const el = document.getElementById('settings-message');
  if (el) {
    el.textContent = text;
    el.className = 'settings-message' + (isError ? ' error' : '');
  }
}

export async function handleConnectPlaid(btn) {
  btn.disabled = true;
  btn.dataset.loading = 'true';
  showSettingsMessage('Requesting link token...');
  try {
    const tokenData = await createLinkToken();
    if (!tokenData.link_token) throw new Error(tokenData.error || 'Failed to get link token.');
    await loadPlaidScript();
    const handler = window.Plaid.create({
      token: tokenData.link_token,
      onSuccess: async function (publicToken) {
        showSettingsMessage('Exchanging token...');
        try {
          const data = await exchangePublicToken(publicToken);
          if (data.error) throw new Error(data.error);
          const contentEl = document.getElementById('page-content');
          if (contentEl) await renderSettings(contentEl);
          showSettingsMessage('Bank connected. Click Sync Transactions.');
        } catch (exchErr) {
          showSettingsMessage('Error: ' + exchErr.message, true);
        } finally {
          btn.disabled = false;
          btn.dataset.loading = '';
        }
      },
      onExit: function (err) {
        if (err) showSettingsMessage('Plaid Link closed: ' + (err.display_message || err.error_message || ''), true);
        else showSettingsMessage('');
        btn.disabled = false;
        btn.dataset.loading = '';
      },
    });
    handler.open();
  } catch (err) {
    showSettingsMessage('Error: ' + err.message, true);
    btn.disabled = false;
    btn.dataset.loading = '';
  }
}

export async function handleSyncTransactions(btn) {
  btn.disabled = true;
  btn.dataset.loading = 'true';
  showSettingsMessage('Syncing transactions...');
  try {
    const data = await syncTransactions();
    emitAppEvent('budget:transactions-updated');
    showSettingsMessage(
      'Sync complete: ' + (data.addedNew ?? 0) + ' new, ' + (data.updatedExisting ?? 0) + ' updated, ' +
      (data.modified ?? 0) + ' modified, ' + (data.removed ?? 0) + ' removed. Total: ' + data.totalTransactions + '.'
    );
  } catch (err) {
    showSettingsMessage('Error: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.dataset.loading = '';
  }
}

export async function handleRemovePlaidItem(btn) {
  const itemId = btn.dataset.itemId;
  if (!itemId) return;
  if (!confirm('Remove this bank connection? This cannot be undone.')) return;
  btn.disabled = true;
  btn.dataset.loading = 'true';
  showSettingsMessage('Removing bank...');
  try {
    await removePlaidItem(itemId);
    await cleanupRemovedPlaid().catch(() => null);
    const contentEl = document.getElementById('page-content');
    if (contentEl) await renderSettings(contentEl);
    emitAppEvent('budget:transactions-updated');
    showSettingsMessage('Bank removed.');
  } catch (err) {
    showSettingsMessage('Error: ' + err.message, true);
    btn.disabled = false;
    btn.dataset.loading = '';
  }
}

export async function handleCleanupRemovedPlaid(btn) {
  btn.disabled = true;
  btn.dataset.loading = 'true';
  showSettingsMessage('Cleaning removed bank data...');
  try {
    const data = await cleanupRemovedPlaid();
    const contentEl = document.getElementById('page-content');
    if (contentEl) await renderSettings(contentEl);
    const stale = Number(data.staleAccountsDeleted ?? data.deletedAccounts ?? 0);
    const removed = Number(data.removedItemsDeleted ?? data.deletedRemovedItems ?? 0);
    showSettingsMessage('Cleanup complete: ' + stale + ' stale account(s) and ' + removed + ' removed item(s) deleted.');
  } catch (err) {
    showSettingsMessage('Error: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.dataset.loading = '';
  }
}

// ── Rules actions (shared with transactions page) ───────────────────────────

export async function handleRulesAdd() {
  openRuleEditor({ source: 'settings' });
}

export async function handleRulesEdit(btn) {
  btn.disabled = true;
  btn.dataset.loading = 'true';
  try {
    const rules = await getRules();
    const rule = rules.find((r) => r.id === btn.dataset.id);
    if (!rule) throw new Error('Rule not found.');
    openRuleEditor({ source: 'settings', rule });
  } catch (err) {
    if (String(err.message || '') !== 'Rule not found.') {
      _rulesMessage = err.message;
      _rulesMessageType = 'error';
      const content = document.getElementById('page-content');
      if (content) await renderSettings(content);
    }
  } finally {
    btn.disabled = false;
    btn.dataset.loading = '';
  }
}

export async function handleRulesToggleEnabled(btn) {
  const isEnabled = btn.dataset.enabled === '1';
  btn.disabled = true;
  btn.dataset.loading = 'true';
  try {
    await patchRule(btn.dataset.id, { enabled: !isEnabled });
    _rulesMessage = isEnabled ? 'Rule disabled.' : 'Rule enabled.';
    _rulesMessageType = 'success';
    const content = document.getElementById('page-content');
    if (content) await renderSettings(content);
  } catch (err) {
    _rulesMessage = err.message;
    _rulesMessageType = 'error';
    const content = document.getElementById('page-content');
    if (content) await renderSettings(content);
  } finally {
    btn.disabled = false;
    btn.dataset.loading = '';
  }
}

export async function handleSaveRuleEditor() {
  const state = getRuleEditorState();
  if (!state || !state.draft) return;
  const draft = normalizeRuleDraft(state.draft);
  if (!draft.match_value) {
    setRuleEditorError('Match value is required.');
    window.dispatchEvent(new CustomEvent('app:page-needs-render'));
    return;
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
    if (draft.mode === 'edit' && draft.id) {
      await patchRule(draft.id, payload);
      _rulesMessage = 'Rule updated.';
    } else {
      await createRule(payload);
      _rulesMessage = 'Rule added.';
    }
    _rulesMessageType = 'success';
    closeRuleEditor();
    return { success: true, source: draft.source, matchValue: draft.match_value };
  } catch (err) {
    setRuleEditorError(err.message);
    window.dispatchEvent(new CustomEvent('app:page-needs-render'));
    return { success: false };
  }
}

// ── Shared rule change/input handler ──────────────────────────────────────

export function handleRuleEditorChange(e) {
  if (!getRuleEditorState()) return false;
  const id = e.target?.id;
  if (id === 'rule-match-type') { updateRuleEditorDraftField('match_type', e.target.value); return true; }
  if (id === 'rule-account-id') { updateRuleEditorDraftField('account_id', e.target.value); return true; }
  if (id === 'rule-set-type') {
    updateRuleEditorDraftField('set_type', e.target.value);
    updateRuleEditorDraftField('set_ignored', e.target.value === 'Ignore');
    return true;
  }
  if (id === 'rule-set-category') { updateRuleEditorDraftField('set_category', e.target.value); return true; }
  if (id === 'rule-enabled') { updateRuleEditorDraftField('enabled', !!e.target.checked); return true; }
  if (id === 'rule-unreviewed-only') { updateRuleEditorDraftField('apply_to_unreviewed_only', !!e.target.checked); return true; }
  if (id === 'rule-set-ignored') {
    const nowIgnored = !!e.target.checked;
    updateRuleEditorDraftField('set_ignored', nowIgnored);
    if (!nowIgnored) {
      const state = getRuleEditorState();
      if (state?.draft?.set_type === 'Ignore') updateRuleEditorDraftField('set_type', 'Expense');
    }
    return true;
  }
  return false;
}

export function handleRuleEditorInput(e) {
  if (!getRuleEditorState()) return false;
  const id = e.target?.id;
  if (id === 'rule-name') { updateRuleEditorDraftField('name', e.target.value); return true; }
  if (id === 'rule-match-value') { updateRuleEditorDraftField('match_value', e.target.value); return true; }
  if (id === 'rule-amount-min') { updateRuleEditorDraftField('amount_min', e.target.value); return true; }
  if (id === 'rule-amount-max') { updateRuleEditorDraftField('amount_max', e.target.value); return true; }
  return false;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function _renderFrame(container) {
  container.innerHTML =
    '<header class="page-header">' +
    '<div class="page-header-main"><h2 class="page-title">Settings</h2><p class="page-description">Connect Plaid and manage app setup.</p></div>' +
    '<div class="page-header-right"><span class="status-badge">Local</span></div>' +
    '</header>' +
    '<div id="page-body" class="page-body"></div>';
  return document.getElementById('page-body');
}
