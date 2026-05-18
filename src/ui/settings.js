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
  removePlaidAccount,
  restorePlaidAccount,
  cleanupRemovedPlaid,
  loadPlaidScript,
} from '../api/plaidApi.js';
import { getRules, createRule, patchRule, applyRules } from '../api/rulesApi.js';
import { getSetting, updateSetting } from '../api/settingsApi.js';
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
import {
  COMMAND_CENTER_SETTING_KEY,
  COMMAND_CENTER_DEFAULTS,
  TOGGLE_META,
  PAGE_META,
  PRESETS,
  loadCommandCenterSettings,
  isFeatureEnabled,
  updateCommandCenterFeature,
  resetCommandCenterPage,
  resetAllCommandCenterDefaults,
  applyCommandCenterPreset,
} from '../utils/commandCenter.js';

// ── page-level state ────────────────────────────────────────────────────────
let _rulesMessage = '';
let _rulesMessageType = 'success';
let _accountTabNamesMessage = '';
let _accountTabNamesMessageType = 'success';
let _ccMessage = '';
let _ccMessageType = 'success';
let _ccSettings = null; // cached command center settings during a render cycle
const ACCOUNT_TAB_LABELS_SETTING_KEY = 'account_tab_labels';

export async function renderSettings(container) {
  const body = _renderFrame(container);
  if (!body) return;
  body.innerHTML = '<section class="card"><p class="empty-state">Loading connection status...</p></section>';

  let status;
  let activeAccounts = [];
  let rules = [];
  let safeMoneySettings = {};
  let accountTabLabels = {};

  try {
    const [statusData, accountsData, rulesData] = await Promise.all([
      getPlaidStatus(),
      getAccounts().catch(() => null),
      getRules().catch(() => []),
    ]);
    status = statusData;
    activeAccounts = accountsData ?? (Array.isArray(status?.accounts) ? status.accounts : []);
    rules = Array.isArray(rulesData) ? rulesData : [];
    let ccSettingsData;
    [safeMoneySettings, accountTabLabels, ccSettingsData] = await Promise.all([
      getSetting('safe_money_settings').catch(() => ({})),
      getSetting(ACCOUNT_TAB_LABELS_SETTING_KEY).catch(() => ({})),
      loadCommandCenterSettings().catch(() => null),
    ]);
    _ccSettings = ccSettingsData;
  } catch (err) {
    body.innerHTML =
      '<section class="card"><div class="error-card">Backend not reachable through the local API proxy.' +
      '<br><small>' + escapeHtml(err.message) + '</small></div></section>';
    return;
  }

  const connected = !!status?.connected;
  const items = Array.isArray(status?.items) ? status.items : [];
  const removedItemsCount = Number(status?.removedItemsCount || 0);
  const staleAccountsCount = Number(status?.staleAccountsCount || 0);
  const accountCount = activeAccounts.length;
  const excludedAccounts = Array.isArray(status?.excludedAccounts) ? status.excludedAccounts : [];

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
  const safeMoneyIncludePending = safeMoneySettings.includePendingTransactions === true || safeMoneySettings.include_pending_transactions === true;
  const normalizedAccountTabLabels = _normalizeAccountTabLabels(accountTabLabels);
  const settingsFeat = (key) => isFeatureEnabled(_ccSettings, 'settings', key);

  const accountLabelRows = activeAccounts.length
    ? activeAccounts.map((account) => {
      const accountId = String(account.id || '');
      const defaultLabel = _buildDefaultAccountTabLabel(account);
      const customLabel = String(normalizedAccountTabLabels[accountId] || '');
      const effectiveLabel = customLabel.trim() || defaultLabel;

      return (
        '<tr>' +
        '<td>' + escapeHtml(defaultLabel) + '</td>' +
        '<td><input class="account-tab-name-input" data-account-tab-input="1" data-account-id="' + escapeHtml(accountId) + '" value="' + escapeHtml(customLabel) + '" placeholder="Use default"></td>' +
        '<td>' + escapeHtml(effectiveLabel) + '</td>' +
        '</tr>'
      );
    }).join('')
    : '<tr><td colspan="3">Connect a bank account to customize tab names.</td></tr>';

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

  const activeAccountsRows = activeAccounts.length
    ? activeAccounts.map((account) => {
      const accountName = String(account.name || account.officialName || 'Account').trim();
      const mask = String(account.mask || '').trim();
      const label = mask ? accountName + ' (' + mask + ')' : accountName;
      return (
        '<tr>' +
        '<td>' + escapeHtml(label) + '</td>' +
        '<td>' + escapeHtml(account.institutionName || '-') + '</td>' +
        '<td>' + escapeHtml(account.subtype || account.type || '-') + '</td>' +
        '<td class="inline-actions">' +
        '<button class="button button-secondary button-sm" data-action="remove-plaid-account" data-plaid-account-id="' + escapeHtml(account.plaidAccountId) + '">Remove Account</button>' +
        '</td>' +
        '</tr>'
      );
    }).join('')
    : '<tr><td colspan="4">No active accounts yet.</td></tr>';

  const excludedAccountsRows = excludedAccounts.length
    ? excludedAccounts.map((account) => {
      const accountName = String(account.name || account.officialName || 'Excluded account').trim();
      const mask = String(account.mask || '').trim();
      const label = mask ? accountName + ' (' + mask + ')' : accountName;
      return (
        '<tr>' +
        '<td>' + escapeHtml(label) + '</td>' +
        '<td>' + escapeHtml(account.institutionName || '-') + '</td>' +
        '<td>' + escapeHtml(account.subtype || account.type || '-') + '</td>' +
        '<td class="inline-actions">' +
        '<button class="button button-secondary button-sm" data-action="restore-plaid-account" data-plaid-account-id="' + escapeHtml(account.plaidAccountId) + '">Restore</button>' +
        '</td>' +
        '</tr>'
      );
    }).join('')
    : '<tr><td colspan="4">No excluded accounts.</td></tr>';

  const ruleEditorHtml = renderRuleEditorModalHtml(activeAccounts);

  body.innerHTML =
    (settingsFeat('showPlaidConnections') ?
      '<section class="card settings-section">' +
      '<div class="card-header"><h3 class="card-title">Plaid Connection</h3><p class="card-description">Connect your bank and sync transactions.</p></div>' +
      '<div class="connection-status ' + (connected ? 'connected' : 'not-connected') + '">' +
      (connected ? 'Connected' : 'Not connected') +
      (accountCount > 0 ? ' <span class="account-count">' + accountCount + ' account' + (accountCount !== 1 ? 's' : '') + '</span>' : '') +
      '</div>' +
      '<p class="card-description">Removed items: ' + removedItemsCount + ' | Stale accounts: ' + staleAccountsCount + '</p>' +
      (itemsHtml ? '<div class="institutions-list">' + itemsHtml + '</div>' : '<p class="empty-state">No connected institutions yet.</p>') +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Account</th><th>Institution</th><th>Type</th><th>Actions</th></tr></thead><tbody>' + activeAccountsRows + '</tbody></table></div>' +
      '<details class="safe-money-disclosure"><summary>Excluded accounts (' + excludedAccounts.length + ')</summary>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Account</th><th>Institution</th><th>Type</th><th>Actions</th></tr></thead><tbody>' + excludedAccountsRows + '</tbody></table></div>' +
      '<p class="card-description">Restoring an account re-allows it for future syncs. Run Sync Transactions after restoring.</p>' +
      '</details>' +
      '<div class="settings-actions">' +
      '<button class="button button-primary" data-action="connect-plaid">Connect Bank</button>' +
      (connected ? '<button class="button button-secondary" data-action="sync-transactions">Sync Transactions</button>' : '') +
      '<button class="button button-secondary" data-action="cleanup-removed-plaid">Clean removed bank data</button>' +
      '</div>' +
      '<div id="settings-message" class="settings-message" aria-live="polite"></div>' +
      '</section>' : '') +

    (settingsFeat('showAccountTabNames') ?
      '<section class="card settings-section">' +
      '<div class="card-header"><h3 class="card-title">Account Tab Names</h3><p class="card-description">Rename account tabs shown on the Transactions page.</p></div>' +
      (_accountTabNamesMessage ? '<p class="settings-message ' + (_accountTabNamesMessageType === 'error' ? 'error' : 'success') + '">' + escapeHtml(_accountTabNamesMessage) + '</p>' : '') +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Default tab name</th><th>Custom tab name</th><th>Current tab label</th></tr></thead><tbody>' + accountLabelRows + '</tbody></table></div>' +
      '<div class="settings-actions">' +
      '<button class="button button-primary" data-action="save-account-tab-names">Save Tab Names</button>' +
      '<button class="button button-secondary" data-action="reset-account-tab-names">Reset to Defaults</button>' +
      '</div>' +
      '</section>' : '') +

    (settingsFeat('showRulesManager') ?
      '<section class="card settings-section">' +
      '<div class="card-header"><h3 class="card-title">Rules Manager</h3><p class="card-description">Manage saved transaction classification rules.</p></div>' +
      (_rulesMessage ? '<p class="settings-message ' + (_rulesMessageType === 'error' ? 'error' : 'success') + '">' + escapeHtml(_rulesMessage) + '</p>' : '') +
      '<div class="settings-actions"><button class="button button-secondary" data-action="rules-add">Add Rule</button></div>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Status</th><th>Name</th><th>Match Type</th><th>Match Value</th><th>Type</th><th>Category</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rulesRows + '</tbody></table></div>' +
      '</section>' : '') +

    (settingsFeat('showDataTools') ?
      '<section class="card settings-section">' +
      '<div class="card-header"><h3 class="card-title">Data Tools</h3><p class="card-description">Quick actions for data checks and safety backups.</p></div>' +
      '<div class="settings-actions">' +
      '<button class="button button-secondary" data-action="data-tools-run-health">Run Data Health Check</button>' +
      '<button class="button button-secondary" data-action="data-tools-cleanup-removed-plaid">Clean removed bank data</button>' +
      '<button class="button button-secondary" data-action="data-tools-export-backup">Export Backup</button>' +
      '</div></section>' : '') +

    (settingsFeat('showSafeMoney') ?
      '<section class="card settings-section">' +
      '<div class="card-header"><h3 class="card-title">Safe Money</h3><p class="card-description">Configure the shared safe-to-spend and safe-to-transfer rules.</p></div>' +
      '<div class="form-grid safe-money-settings-grid">' +
      '<label class="form-field"><span>Safety buffer</span><input id="safe-money-buffer" type="number" step="0.01" value="' + escapeHtml(String(safeMoneyBuffer)) + '"></label>' +
      '<label class="form-field checkbox-field"><span><input id="safe-money-pending" type="checkbox"' + (safeMoneyIncludePending ? ' checked' : '') + '> Include pending transactions in Safe Money</span></label>' +
      '</div>' +
      '<div class="settings-actions"><button class="button button-primary" data-action="safe-money-save">Save Safe Money Settings</button></div>' +
      '<div id="safe-money-message" class="settings-message" aria-live="polite"></div>' +
      '</section>' : '') +

    (settingsFeat('showCommandCenter') ? _renderCommandCenterSection(_ccSettings) : '') +

    ruleEditorHtml;

  // Per-render listeners (safe-money only — Plaid actions handled globally)
  body.querySelector('[data-action="safe-money-save"]')?.addEventListener('click', async () => {
    const messageEl = document.getElementById('safe-money-message');
    try {
      const value = {
        safetyBuffer: Number(document.getElementById('safe-money-buffer')?.value || 0),
        includePendingTransactions: !!document.getElementById('safe-money-pending')?.checked,
      };
      await updateSetting('safe_money_settings', value);
      if (messageEl) { messageEl.className = 'settings-message success'; messageEl.textContent = 'Safe Money settings saved.'; }
    } catch (err) {
      if (messageEl) { messageEl.className = 'settings-message error'; messageEl.textContent = err.message; }
    }
  });

  body.querySelector('[data-action="save-account-tab-names"]')?.addEventListener('click', async () => {
    try {
      const entries = Array.from(body.querySelectorAll('[data-account-tab-input="1"]'));
      const nextLabels = {};

      for (const input of entries) {
        const accountId = String(input?.dataset?.accountId || '').trim();
        if (!accountId) continue;
        const value = String(input.value || '').trim();
        if (value) nextLabels[accountId] = value;
      }

      await updateSetting(ACCOUNT_TAB_LABELS_SETTING_KEY, nextLabels);
      _accountTabNamesMessage = 'Account tab names saved.';
      _accountTabNamesMessageType = 'success';
      emitAppEvent('budget:transactions-updated');
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } catch (err) {
      _accountTabNamesMessage = err.message;
      _accountTabNamesMessageType = 'error';
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    }
  });

  body.querySelector('[data-action="reset-account-tab-names"]')?.addEventListener('click', async () => {
    try {
      await updateSetting(ACCOUNT_TAB_LABELS_SETTING_KEY, {});
      _accountTabNamesMessage = 'Account tab names reset to defaults.';
      _accountTabNamesMessageType = 'success';
      emitAppEvent('budget:transactions-updated');
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } catch (err) {
      _accountTabNamesMessage = err.message;
      _accountTabNamesMessageType = 'error';
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    }
  });

  // Command Center — toggle individual feature
  body.addEventListener('change', async (e) => {
    const btn = e.target.closest('[data-action="cc-toggle"]');
    if (!btn) return;
    const pageKey = btn.dataset.page;
    const featureKey = btn.dataset.feature;
    if (!pageKey || !featureKey) return;
    try {
      _ccSettings = await updateCommandCenterFeature(_ccSettings || {}, pageKey, featureKey, btn.checked);
      _ccMessage = 'Saved.';
      _ccMessageType = 'success';
      window.dispatchEvent(new CustomEvent('app:page-needs-render'));
    } catch (err) {
      const messageEl = document.getElementById('cc-message');
      if (messageEl) { messageEl.className = 'settings-message error'; messageEl.textContent = err.message; }
      // Revert the checkbox
      btn.checked = !btn.checked;
    }
  });

  // Command Center — preset buttons
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="cc-preset"]');
    if (!btn) return;
    const presetKey = btn.dataset.preset;
    if (!presetKey) return;
    btn.disabled = true;
    try {
      _ccSettings = await applyCommandCenterPreset(_ccSettings || {}, presetKey);
      _ccMessage = (PRESETS[presetKey]?.label || presetKey) + ' applied.';
      _ccMessageType = 'success';
      window.dispatchEvent(new CustomEvent('app:navigation-needs-render'));
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } catch (err) {
      _ccMessage = err.message;
      _ccMessageType = 'error';
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } finally {
      btn.disabled = false;
    }
  });

  // Command Center — reset a single page
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="cc-reset-page"]');
    if (!btn) return;
    const pageKey = btn.dataset.page;
    if (!pageKey) return;
    btn.disabled = true;
    try {
      _ccSettings = await resetCommandCenterPage(_ccSettings || {}, pageKey);
      _ccMessage = (PAGE_META[pageKey]?.label || pageKey) + ' reset to defaults.';
      _ccMessageType = 'success';
      window.dispatchEvent(new CustomEvent('app:navigation-needs-render'));
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } catch (err) {
      _ccMessage = err.message;
      _ccMessageType = 'error';
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } finally {
      btn.disabled = false;
    }
  });

  // Command Center — reset all defaults
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="cc-reset-all"]');
    if (!btn) return;
    if (!confirm('Reset ALL Command Center settings to defaults?')) return;
    btn.disabled = true;
    try {
      _ccSettings = await resetAllCommandCenterDefaults();
      _ccMessage = 'All settings reset to defaults.';
      _ccMessageType = 'success';
      window.dispatchEvent(new CustomEvent('app:navigation-needs-render'));
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } catch (err) {
      _ccMessage = err.message;
      _ccMessageType = 'error';
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } finally {
      btn.disabled = false;
    }
  });

  if (settingsFeat('showDataTools')) renderBackupSection(body);
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

export async function handleRemovePlaidAccount(btn) {
  const plaidAccountId = btn.dataset.plaidAccountId;
  if (!plaidAccountId) return;
  if (!confirm('Remove this account from the app and exclude it from future syncs?')) return;
  btn.disabled = true;
  btn.dataset.loading = 'true';
  showSettingsMessage('Removing account...');
  try {
    await removePlaidAccount(plaidAccountId);
    const contentEl = document.getElementById('page-content');
    if (contentEl) await renderSettings(contentEl);
    emitAppEvent('budget:transactions-updated');
    showSettingsMessage('Account removed and excluded from sync.');
  } catch (err) {
    showSettingsMessage('Error: ' + err.message, true);
    btn.disabled = false;
    btn.dataset.loading = '';
  }
}

export async function handleRestorePlaidAccount(btn) {
  const plaidAccountId = btn.dataset.plaidAccountId;
  if (!plaidAccountId) return;
  btn.disabled = true;
  btn.dataset.loading = 'true';
  showSettingsMessage('Restoring account...');
  try {
    await restorePlaidAccount(plaidAccountId);
    const contentEl = document.getElementById('page-content');
    if (contentEl) await renderSettings(contentEl);
    showSettingsMessage('Account restored. Click Sync Transactions to import it again.');
  } catch (err) {
    showSettingsMessage('Error: ' + err.message, true);
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

function _buildDefaultAccountTabLabel(account) {
  const accountName = String(account?.name || account?.officialName || 'Account').trim();
  const accountMask = String(account?.mask || '').trim();
  return accountMask ? accountName + ' (' + accountMask + ')' : accountName;
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

function _renderCommandCenterSection(ccSettings) {
  const cc = ccSettings || {};

  const pageGroupsHtml = Object.keys(COMMAND_CENTER_DEFAULTS).map((pageKey) => {
    const pageMeta = PAGE_META[pageKey] || { label: pageKey, description: '' };
    const pageDefaults = COMMAND_CENTER_DEFAULTS[pageKey] || {};
    const pageStored = cc[pageKey] || {};
    const allowPageToggle = pageKey !== 'settings';

    const pageIsEnabled = allowPageToggle
      ? ('pageEnabled' in pageStored ? !!pageStored.pageEnabled : !!pageDefaults.pageEnabled)
      : true;

    const togglesHtml = Object.keys(pageDefaults)
      .filter((featureKey) => featureKey !== 'pageEnabled')
      .map((featureKey) => {
        const meta = (TOGGLE_META[pageKey] || {})[featureKey] || { label: featureKey, description: '' };
        const lockOn = pageKey === 'settings' && featureKey === 'showCommandCenter';
        const isEnabled = lockOn
          ? true
          : (featureKey in pageStored ? !!pageStored[featureKey] : !!pageDefaults[featureKey]);
        return (
          '<label class="cc-toggle-row">' +
          '<input type="checkbox" data-action="cc-toggle" data-page="' + escapeHtml(pageKey) + '" data-feature="' + escapeHtml(featureKey) + '"' + (isEnabled ? ' checked' : '') + (pageIsEnabled && !lockOn ? '' : ' disabled') + '>' +
          '<span class="cc-toggle-label">' + escapeHtml(meta.label) + '</span>' +
          '<span class="cc-toggle-desc">' + escapeHtml(lockOn ? (meta.description + ' (Always enabled)') : meta.description) + '</span>' +
          '</label>'
        );
      }).join('');

    return (
      '<div class="cc-page-group' + (pageIsEnabled ? '' : ' cc-page-group--disabled') + '">' +
      '<div class="cc-page-group-header">' +
      '<div class="cc-page-group-title">' +
      '<span class="cc-page-label">' + escapeHtml(pageMeta.label) + '</span>' +
      '<span class="cc-page-desc">' + escapeHtml(pageMeta.description) + '</span>' +
      '</div>' +
      '<div class="cc-page-group-actions">' +
      (allowPageToggle
        ? '<label class="cc-page-pill-toggle" title="' + (pageIsEnabled ? 'Disable' : 'Enable') + ' this page">' +
          '<input type="checkbox" class="cc-page-pill-input" data-action="cc-toggle" data-page="' + escapeHtml(pageKey) + '" data-feature="pageEnabled"' + (pageIsEnabled ? ' checked' : '') + '>' +
          '<span class="cc-page-pill-track"><span class="cc-page-pill-thumb"></span></span>' +
          '<span class="cc-page-pill-label">' + (pageIsEnabled ? 'On' : 'Off') + '</span>' +
          '</label>'
        : '') +
      '<button class="button button-ghost button-xs" data-action="cc-reset-page" data-page="' + escapeHtml(pageKey) + '">Reset</button>' +
      '</div>' +
      '</div>' +
      '<div class="cc-toggles">' + togglesHtml + '</div>' +
      '</div>'
    );
  }).join('');

  const presetButtonsHtml = Object.keys(PRESETS).map((key) => {
    const p = PRESETS[key];
    return '<button class="button button-secondary button-sm" data-action="cc-preset" data-preset="' + escapeHtml(key) + '" title="' + escapeHtml(p.description) + '">' + escapeHtml(p.label) + '</button>';
  }).join('');

  const messageHtml = _ccMessage
    ? '<p id="cc-message" class="settings-message ' + (_ccMessageType === 'error' ? 'error' : 'success') + '">' + escapeHtml(_ccMessage) + '</p>'
    : '<div id="cc-message" class="settings-message" aria-live="polite"></div>';

  // Clear after render
  _ccMessage = '';

  return (
    '<section class="card settings-section" id="command-center-section">' +
    '<div class="card-header"><h3 class="card-title">Command Center</h3><p class="card-description">Control which features and sections are visible on each page.</p></div>' +
    '<div class="cc-presets-bar">' +
    '<span class="cc-presets-label">Presets:</span>' +
    presetButtonsHtml +
    '<button class="button button-ghost button-sm" data-action="cc-reset-all">Reset All Defaults</button>' +
    '</div>' +
    '<div class="cc-page-groups">' + pageGroupsHtml + '</div>' +
    messageHtml +
    '</section>'
  );
}
