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
import {
  DEFAULT_TRANSFER_TARGETS,
  TRANSFER_TARGET_KIND_OPTIONS,
  TRANSFER_BUDGET_GROUP_OPTIONS,
  TRANSFER_ALLOCATION_METHOD_OPTIONS,
  CONNECTED_MODULE_OPTIONS,
  CONFIRM_ACTION_OPTIONS,
  getTransferTargetsConfig,
  isTransferTargetsConfigMissing,
} from '../utils/transferTargets.js';

// ── page-level state ────────────────────────────────────────────────────────
let _rulesMessage = '';
let _rulesMessageType = 'success';
let _accountTabNamesMessage = '';
let _accountTabNamesMessageType = 'success';
let _ccMessage = '';
let _ccMessageType = 'success';
let _transferTargetsMessage = '';
let _transferTargetsMessageType = 'success';
let _editingTransferTargetId = '';
let _ccSettings = null; // cached command center settings during a render cycle
const ACCOUNT_TAB_LABELS_SETTING_KEY = 'account_tab_labels';
const TRANSFER_TARGETS_SETTING_KEY = 'transfer_targets';

export async function renderSettings(container) {
  const body = _renderFrame(container);
  if (!body) return;
  body.innerHTML = '<section class="card"><p class="empty-state">Loading connection status...</p></section>';

  let status;
  let activeAccounts = [];
  let rules = [];
  let safeMoneySettings = {};
  let accountTabLabels = {};
  let transferTargetsSetting = {};

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
    [safeMoneySettings, accountTabLabels, transferTargetsSetting, ccSettingsData] = await Promise.all([
      getSetting('safe_money_settings').catch(() => ({})),
      getSetting(ACCOUNT_TAB_LABELS_SETTING_KEY).catch(() => ({})),
      getSetting(TRANSFER_TARGETS_SETTING_KEY).catch(() => ({})),
      loadCommandCenterSettings().catch(() => null),
    ]);
    if (isTransferTargetsConfigMissing(transferTargetsSetting)) {
      await updateSetting(TRANSFER_TARGETS_SETTING_KEY, DEFAULT_TRANSFER_TARGETS);
      transferTargetsSetting = DEFAULT_TRANSFER_TARGETS;
    }
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
  const transferTargets = getTransferTargetsConfig(transferTargetsSetting);
  const editingTransferTarget = transferTargets.find((target) => target.id === _editingTransferTargetId) || _createEmptyTransferTarget();
  if (_editingTransferTargetId && !transferTargets.some((target) => target.id === _editingTransferTargetId)) {
    _editingTransferTargetId = '';
  }
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
      '<div class="card-header"><h3 class="card-title">Bank Connections</h3><p class="card-description">Connect your bank and sync transactions.</p></div>' +
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
      '<div class="card-header"><h3 class="card-title">Account Mapping</h3><p class="card-description">Rename account tabs shown on the Transactions page.</p></div>' +
      (_accountTabNamesMessage ? '<p class="settings-message ' + (_accountTabNamesMessageType === 'error' ? 'error' : 'success') + '">' + escapeHtml(_accountTabNamesMessage) + '</p>' : '') +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Default tab name</th><th>Custom tab name</th><th>Current tab label</th></tr></thead><tbody>' + accountLabelRows + '</tbody></table></div>' +
      '<div class="settings-actions">' +
      '<button class="button button-primary" data-action="save-account-tab-names">Save Tab Names</button>' +
      '<button class="button button-secondary" data-action="reset-account-tab-names">Reset to Defaults</button>' +
      '</div>' +
      '</section>' : '') +

    (settingsFeat('showRulesManager') ?
      '<section class="card settings-section">' +
      '<div class="card-header"><h3 class="card-title">Rules</h3><p class="card-description">Manage saved transaction classification rules.</p></div>' +
      (_rulesMessage ? '<p class="settings-message ' + (_rulesMessageType === 'error' ? 'error' : 'success') + '">' + escapeHtml(_rulesMessage) + '</p>' : '') +
      '<div class="settings-actions"><button class="button button-secondary" data-action="rules-add">Add Rule</button></div>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Status</th><th>Name</th><th>Match Type</th><th>Match Value</th><th>Type</th><th>Category</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rulesRows + '</tbody></table></div>' +
      '</section>' : '') +

    (settingsFeat('showDataTools') ?
      '<section class="card settings-section">' +
      '<div class="card-header"><h3 class="card-title">Privacy / Export / Reset</h3><p class="card-description">Quick actions for data checks, master lists, and safety backups.</p></div>' +
      '<div class="settings-actions">' +
      '<button class="button button-secondary" data-action="data-tools-open-master-lists">Open Master Lists</button>' +
      '<button class="button button-secondary" data-action="data-tools-run-health">Run Data Health Check</button>' +
      '<button class="button button-secondary" data-action="data-tools-cleanup-removed-plaid">Clean removed bank data</button>' +
      '<button class="button button-secondary" data-action="data-tools-export-backup">Export Backup</button>' +
      '</div></section>' : '') +

    (settingsFeat('showSafeMoney') ?
      '<section class="card settings-section">' +
      '<div class="card-header"><h3 class="card-title">Pending Transaction Controls</h3><p class="card-description">Configure safe-to-spend and pending transaction behavior.</p></div>' +
      '<div class="form-grid safe-money-settings-grid">' +
      '<label class="form-field"><span>Safety buffer</span><input id="safe-money-buffer" type="number" step="0.01" value="' + escapeHtml(String(safeMoneyBuffer)) + '"></label>' +
      '<label class="form-field checkbox-field"><span><input id="safe-money-pending" type="checkbox"' + (safeMoneyIncludePending ? ' checked' : '') + '> Include pending transactions in Safe Money</span></label>' +
      '</div>' +
      '<div class="settings-actions"><button class="button button-primary" data-action="safe-money-save">Save Safe Money Settings</button></div>' +
      '<div id="safe-money-message" class="settings-message" aria-live="polite"></div>' +
      '</section>' : '') +

    _renderTransferTargetsSection(transferTargets, editingTransferTarget) +

    '<section class="card settings-section" id="command-center-recovery-section">' +
    '<div class="card-header"><h3 class="card-title">Feature Toggles</h3><p class="card-description">Restore defaults if page visibility was changed by saved settings.</p></div>' +
    '<div class="settings-actions"><button class="button button-secondary" data-action="cc-reset-all">Reset Command Center Defaults</button></div>' +
    '</section>' +

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
      emitAppEvent('budget:safe-money-settings-updated');
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

  body.querySelector('[data-action="transfer-target-save"]')?.addEventListener('click', async () => {
    try {
      const form = body.querySelector('[data-transfer-target-form="1"]');
      const draft = _readTransferTargetForm(form);
      const nextTargets = [...transferTargets];
      const existingIndex = nextTargets.findIndex((target) => target.id === (_editingTransferTargetId || draft.id));
      const previous = existingIndex >= 0 ? nextTargets[existingIndex] : null;
      if (!previous && nextTargets.some((target) => target.id === draft.id)) {
        throw new Error('Transfer target ID must be unique.');
      }
      const merged = {
        ...(previous || {}),
        ...draft,
        createdAt: previous?.createdAt || draft.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (existingIndex >= 0) nextTargets[existingIndex] = merged;
      else nextTargets.push(merged);

      nextTargets.sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0) || String(left.name || '').localeCompare(String(right.name || '')));
      await updateSetting(TRANSFER_TARGETS_SETTING_KEY, nextTargets);
      _transferTargetsMessage = previous ? 'Transfer target updated.' : 'Transfer target added.';
      _transferTargetsMessageType = 'success';
      _editingTransferTargetId = merged.id;
      emitAppEvent('budget:transfer-targets-updated');
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } catch (err) {
      _transferTargetsMessage = err.message;
      _transferTargetsMessageType = 'error';
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    }
  });

  body.querySelector('[data-action="transfer-target-add-new"]')?.addEventListener('click', async () => {
    _editingTransferTargetId = '';
    const contentEl = document.getElementById('page-content');
    if (contentEl) await renderSettings(contentEl);
  });

  body.querySelector('[data-action="transfer-target-cancel"]')?.addEventListener('click', async () => {
    _editingTransferTargetId = '';
    const contentEl = document.getElementById('page-content');
    if (contentEl) await renderSettings(contentEl);
  });

  body.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-action="transfer-target-edit"]');
    if (editBtn) {
      _editingTransferTargetId = String(editBtn.dataset.targetId || '').trim();
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
      return;
    }

    const toggleBtn = e.target.closest('[data-action="transfer-target-toggle"]');
    if (toggleBtn) {
      const targetId = String(toggleBtn.dataset.targetId || '').trim();
      const nextTargets = transferTargets.map((target) => target.id === targetId ? { ...target, active: !target.active, updatedAt: new Date().toISOString() } : target);
      try {
        await updateSetting(TRANSFER_TARGETS_SETTING_KEY, nextTargets);
        _transferTargetsMessage = 'Transfer target updated.';
        _transferTargetsMessageType = 'success';
        emitAppEvent('budget:transfer-targets-updated');
        const contentEl = document.getElementById('page-content');
        if (contentEl) await renderSettings(contentEl);
      } catch (err) {
        _transferTargetsMessage = err.message;
        _transferTargetsMessageType = 'error';
        const contentEl = document.getElementById('page-content');
        if (contentEl) await renderSettings(contentEl);
      }
      return;
    }

    const deleteBtn = e.target.closest('[data-action="transfer-target-delete"]');
    if (!deleteBtn) return;
    const targetId = String(deleteBtn.dataset.targetId || '').trim();
    const target = transferTargets.find((row) => row.id === targetId);
    if (!targetId || !target) return;
    if (!confirm('Delete transfer target "' + target.name + '"?')) return;
    try {
      const nextTargets = transferTargets.filter((row) => row.id !== targetId);
      await updateSetting(TRANSFER_TARGETS_SETTING_KEY, nextTargets);
      _transferTargetsMessage = 'Transfer target deleted.';
      _transferTargetsMessageType = 'success';
      if (_editingTransferTargetId === targetId) _editingTransferTargetId = '';
      emitAppEvent('budget:transfer-targets-updated');
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
    } catch (err) {
      _transferTargetsMessage = err.message;
      _transferTargetsMessageType = 'error';
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
    if (pageKey === 'settings' && featureKey === 'showCommandCenter') {
      btn.checked = true;
      _ccMessage = 'Command Center cannot be hidden because it controls feature recovery.';
      _ccMessageType = 'success';
      const contentEl = document.getElementById('page-content');
      if (contentEl) await renderSettings(contentEl);
      return;
    }
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
    '<div class="page-header-main"><h2 class="page-title">Settings</h2><p class="page-description">A command center for banks, accounts, rules, lists, health, and privacy tools.</p></div>' +
    '<div class="page-header-right"><span class="status-badge">Private local data</span></div>' +
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

function _createEmptyTransferTarget() {
  const now = new Date().toISOString();
  return {
    id: '',
    name: '',
    active: true,
    targetKind: 'other',
    budgetGroup: 'Wants',
    allocationMethod: 'equal_split',
    weight: 1,
    fixedAmount: 0,
    percentage: 0,
    capAmount: 0,
    priority: 0,
    destinationAccountId: '',
    trackSpendingAgainstTarget: true,
    notes: '',
    createdAt: now,
    updatedAt: now,
    connectedModule: 'none',
    confirmAction: 'create_transfer_confirmation',
  };
}

function _renderTransferTargetOptionList(options, selectedValue) {
  return options.map((option) => '<option value="' + escapeHtml(option) + '"' + (option === selectedValue ? ' selected' : '') + '>' + escapeHtml(option) + '</option>').join('');
}

function _renderTransferTargetsSection(targets, editingTarget) {
  const rowsHtml = targets.length
    ? targets.map((target) => (
      '<tr>' +
      '<td>' + escapeHtml(target.name) + '</td>' +
      '<td>' + escapeHtml(target.id) + '</td>' +
      '<td>' + escapeHtml(target.budgetGroup) + '</td>' +
      '<td>' + escapeHtml(target.allocationMethod) + '</td>' +
      '<td>' + escapeHtml(target.destinationAccountId || '-') + '</td>' +
      '<td>' + (target.active ? '<span class="status-reviewed">Enabled</span>' : '<span class="status-needs-review">Disabled</span>') + '</td>' +
      '<td class="inline-actions">' +
      '<button class="button button-secondary button-sm" data-action="transfer-target-edit" data-target-id="' + escapeHtml(target.id) + '">Edit</button>' +
      '<button class="button button-secondary button-sm" data-action="transfer-target-toggle" data-target-id="' + escapeHtml(target.id) + '">' + (target.active ? 'Disable' : 'Enable') + '</button>' +
      '<button class="button button-danger button-sm" data-action="transfer-target-delete" data-target-id="' + escapeHtml(target.id) + '">Delete</button>' +
      '</td>' +
      '</tr>'
    )).join('')
    : '<tr><td colspan="7">No transfer targets configured.</td></tr>';

  return (
    '<section class="card settings-section">' +
    '<div class="card-header"><h3 class="card-title">Transfer Targets</h3><p class="card-description">Configure the accounts and allocation rules used by the Transfers page and shared transfer math.</p></div>' +
    (_transferTargetsMessage ? '<p class="settings-message ' + (_transferTargetsMessageType === 'error' ? 'error' : 'success') + '">' + escapeHtml(_transferTargetsMessage) + '</p>' : '') +
    '<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>ID</th><th>Budget Group</th><th>Allocation Method</th><th>Destination Account</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
    '<div class="card-header" style="margin-top:1rem;"><h4 class="card-title">' + escapeHtml(editingTarget.id ? 'Edit Transfer Target' : 'Add Transfer Target') + '</h4></div>' +
    '<div class="form-grid" data-transfer-target-form="1">' +
    '<label class="form-field"><span>ID</span><input id="transfer-target-id" value="' + escapeHtml(editingTarget.id || '') + '"></label>' +
    '<label class="form-field"><span>Name</span><input id="transfer-target-name" value="' + escapeHtml(editingTarget.name || '') + '"></label>' +
    '<label class="form-field checkbox-field"><span><input id="transfer-target-active" type="checkbox"' + (editingTarget.active ? ' checked' : '') + '> Active</span></label>' +
    '<label class="form-field"><span>Target Kind</span><select id="transfer-target-kind">' + _renderTransferTargetOptionList(TRANSFER_TARGET_KIND_OPTIONS, editingTarget.targetKind) + '</select></label>' +
    '<label class="form-field"><span>Budget Group</span><select id="transfer-target-budget-group">' + _renderTransferTargetOptionList(TRANSFER_BUDGET_GROUP_OPTIONS, editingTarget.budgetGroup) + '</select></label>' +
    '<label class="form-field"><span>Allocation Method</span><select id="transfer-target-allocation-method">' + _renderTransferTargetOptionList(TRANSFER_ALLOCATION_METHOD_OPTIONS, editingTarget.allocationMethod) + '</select></label>' +
    '<label class="form-field"><span>Weight</span><input id="transfer-target-weight" type="number" step="0.01" value="' + escapeHtml(String(editingTarget.weight ?? 1)) + '"></label>' +
    '<label class="form-field"><span>Fixed Amount</span><input id="transfer-target-fixed-amount" type="number" step="0.01" value="' + escapeHtml(String(editingTarget.fixedAmount ?? 0)) + '"></label>' +
    '<label class="form-field"><span>Percentage</span><input id="transfer-target-percentage" type="number" step="0.01" value="' + escapeHtml(String(editingTarget.percentage ?? 0)) + '"></label>' +
    '<label class="form-field"><span>Cap Amount</span><input id="transfer-target-cap-amount" type="number" step="0.01" value="' + escapeHtml(String(editingTarget.capAmount ?? 0)) + '"></label>' +
    '<label class="form-field"><span>Priority</span><input id="transfer-target-priority" type="number" step="1" value="' + escapeHtml(String(editingTarget.priority ?? 0)) + '"></label>' +
    '<label class="form-field"><span>Destination Account ID</span><input id="transfer-target-destination-account-id" value="' + escapeHtml(editingTarget.destinationAccountId || '') + '"></label>' +
    '<label class="form-field checkbox-field"><span><input id="transfer-target-track-spending" type="checkbox"' + (editingTarget.trackSpendingAgainstTarget ? ' checked' : '') + '> Track spending against target</span></label>' +
    '<label class="form-field"><span>Connected Module</span><select id="transfer-target-connected-module">' + _renderTransferTargetOptionList(CONNECTED_MODULE_OPTIONS, editingTarget.connectedModule) + '</select></label>' +
    '<label class="form-field"><span>Confirm Action</span><select id="transfer-target-confirm-action">' + _renderTransferTargetOptionList(CONFIRM_ACTION_OPTIONS, editingTarget.confirmAction) + '</select></label>' +
    '<label class="form-field"><span>Created At</span><input id="transfer-target-created-at" value="' + escapeHtml(editingTarget.createdAt || '') + '"></label>' +
    '<label class="form-field"><span>Updated At</span><input id="transfer-target-updated-at" value="' + escapeHtml(editingTarget.updatedAt || '') + '"></label>' +
    '<label class="form-field" style="grid-column:1 / -1;"><span>Notes</span><textarea id="transfer-target-notes" rows="3">' + escapeHtml(editingTarget.notes || '') + '</textarea></label>' +
    '</div>' +
    '<div class="settings-actions">' +
    '<button class="button button-primary" data-action="transfer-target-save">Save Transfer Target</button>' +
    '<button class="button button-secondary" data-action="transfer-target-add-new">Add New</button>' +
    (editingTarget.id ? '<button class="button button-secondary" data-action="transfer-target-cancel">Cancel Edit</button>' : '') +
    '</div>' +
    '</section>'
  );
}

function _readTransferTargetForm(form) {
  if (!form) throw new Error('Transfer target form not found.');
  const read = (id) => form.querySelector('#' + id);
  const id = String(read('transfer-target-id')?.value || '').trim();
  const name = String(read('transfer-target-name')?.value || '').trim();
  if (!id) throw new Error('Transfer target ID is required.');
  if (!name) throw new Error('Transfer target name is required.');
  return {
    id,
    name,
    active: !!read('transfer-target-active')?.checked,
    targetKind: String(read('transfer-target-kind')?.value || 'other'),
    budgetGroup: String(read('transfer-target-budget-group')?.value || 'Wants'),
    allocationMethod: String(read('transfer-target-allocation-method')?.value || 'equal_split'),
    weight: Number(read('transfer-target-weight')?.value || 0),
    fixedAmount: Number(read('transfer-target-fixed-amount')?.value || 0),
    percentage: Number(read('transfer-target-percentage')?.value || 0),
    capAmount: Number(read('transfer-target-cap-amount')?.value || 0),
    priority: Number(read('transfer-target-priority')?.value || 0),
    destinationAccountId: String(read('transfer-target-destination-account-id')?.value || '').trim(),
    trackSpendingAgainstTarget: !!read('transfer-target-track-spending')?.checked,
    notes: String(read('transfer-target-notes')?.value || '').trim(),
    createdAt: String(read('transfer-target-created-at')?.value || '').trim(),
    updatedAt: String(read('transfer-target-updated-at')?.value || '').trim(),
    connectedModule: String(read('transfer-target-connected-module')?.value || 'none'),
    confirmAction: String(read('transfer-target-confirm-action')?.value || 'create_transfer_confirmation'),
  };
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
        const descriptionText = lockOn
          ? 'Command Center cannot be hidden because it controls feature recovery.'
          : meta.description;
        return (
          '<label class="cc-toggle-row">' +
          '<input type="checkbox" data-action="cc-toggle" data-page="' + escapeHtml(pageKey) + '" data-feature="' + escapeHtml(featureKey) + '"' + (isEnabled ? ' checked' : '') + (pageIsEnabled && !lockOn ? '' : ' disabled') + '>' +
          '<span class="cc-toggle-label">' + escapeHtml(meta.label) + '</span>' +
          '<span class="cc-toggle-desc">' + escapeHtml(descriptionText) + '</span>' +
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
      (pageKey === 'settings'
        ? '<p class="cc-page-desc" style="margin:0 0 0.75rem;">Settings is always available because it contains recovery controls.</p>'
        : '') +
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
