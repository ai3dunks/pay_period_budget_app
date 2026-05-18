/**
 * renderApp.js — bootApp() entry point, page routing, global event delegation.
 */

import { renderShell, renderNav, renderBudgetPeriodSelector, PERIOD_AWARE_TABS } from './navigation.js';
import { getAppState, setActiveTab, setSelectedPeriodId, getActivePeriod } from './appState.js';
import { emitAppEvent } from './events.js';
import { getPeriodLabel } from '../utils/formatters.js';

// Page modules
import { renderSettings, handleConnectPlaid, handleSyncTransactions, handleRemovePlaidItem, handleRemovePlaidAccount, handleRestorePlaidAccount, handleCleanupRemovedPlaid, handleRulesAdd, handleRulesEdit, handleRulesToggleEnabled, handleSaveRuleEditor, handleRuleEditorChange, handleRuleEditorInput } from '../ui/settings.js';
import { renderMasterLists } from '../ui/masterLists.js';
import { renderTransactions, setPendingReviewTransactionId } from '../ui/transactions.js';
import { renderExpenses } from '../ui/expenses.js';
import { getRuleEditorState, closeRuleEditor } from '../ui/rulesManager.js';
import { renderPaycheckPlanner } from '../ui/paycheckPlanner.js';
import { renderRecurringBills } from '../ui/recurringBills.js';
import { renderTransfers } from '../ui/transfers.js';
import { renderDashboard as renderDashboardTab } from '../ui/dashboard.js';
import { renderHistory } from '../ui/history.js';
import { renderCloseout } from '../ui/closeout.js';
import { renderDataHealth } from '../ui/dataHealth.js';
import { renderReports } from '../ui/reports.js';
import { renderDebtSnowball } from '../ui/debtSnowball.js';
import { renderCashFlowForecast } from '../ui/cashFlowForecast.js';
import { renderTest } from '../ui/test.js';
import { syncTransactions } from '../api/plaidApi.js';
import { API_BASE } from '../api/client.js';
import { loadCommandCenterSettings, isPageEnabled, PAGE_META } from '../utils/commandCenter.js';

// Map tab IDs to Command Center page keys
const TAB_PAGE_KEY = {
  'dashboard': 'dashboard',
  'transactions': 'transactions',
  'recurring-bills': 'recurringBills',
  'expenses': 'expenses',
  'transfers': 'transfers',
  'debt-snowball': 'debtSnowball',
  'cash-flow': 'cashFlowForecast',
  'reports': 'reports',
  'data-health': 'dataHealth',
  'paycheck-planner': 'paycheckPlanner',
  'history': 'history',
  'closeout': 'closeout',
  'master-lists': 'masterLists',
};


// ── Entry point ─────────────────────────────────────────────────────────────

export function bootApp() {
  const app = document.querySelector('#app');
  if (!app) return;
  renderShell(app);
  _renderNav();
  _renderPeriodSelector();
  renderActivePage();
  _attachGlobalListeners();

  // Re-render on rule editor open/close
  window.addEventListener('app:page-needs-render', () => {
    _renderNav();
    renderActivePage();
  });
  window.addEventListener('app:navigation-needs-render', () => {
    _renderNav();
  });

  // Cross-module navigation events
  window.addEventListener('app:open-transaction-review', (e) => {
    const id = e.detail?.transactionId;
    if (id) setPendingReviewTransactionId(id);
    _navigate('transactions');
  });
}

function _navigate(tabId) {
  setActiveTab(tabId);
  _renderNav();
  _renderPeriodSelector();
  renderActivePage();
}

// ── Internal rendering ───────────────────────────────────────────────────────

function _renderNav() {
  const { activeTab } = getAppState();
  loadCommandCenterSettings().catch(() => null).then((ccSettings) => {
    const disabledTabs = new Set(
      Object.entries(TAB_PAGE_KEY)
        .filter(([, pageKey]) => ccSettings && ccSettings[pageKey]?.pageEnabled === false)
        .map(([tabId]) => tabId)
    );
    renderNav(activeTab, (tabId) => {
      if (getAppState().activeTab === tabId) { renderActivePage(); return; }
      _navigate(tabId);
    }, disabledTabs);
  });
}

function _renderPeriodSelector() {
  const { selectedPeriodId, periods } = getAppState();
  renderBudgetPeriodSelector(periods, selectedPeriodId);
}

export async function renderActivePage() {
  const { activeTab } = getAppState();
  const content = document.getElementById('page-content');
  if (!content) return;
  try {
    await _renderPage(activeTab, content);
  } catch (err) {
    console.error('Page render failed:', err);
    content.innerHTML = '<div class="card"><div class="error-card">Page failed to render. Check console for details.</div></div>';
  }
}

async function _renderPage(tabId, content) {
  const period = getActivePeriod();
  const periodLabel = getPeriodLabel(period);

  // Check if the page is disabled in the Command Center
  const pageKey = TAB_PAGE_KEY[tabId];
  if (pageKey) {
    const ccSettings = await loadCommandCenterSettings().catch(() => null);
    if (!isPageEnabled(ccSettings, pageKey)) {
      const label = (PAGE_META[pageKey] || {}).label || tabId;
      content.innerHTML =
        '<div class="card" style="margin-top:2rem;text-align:center;padding:2rem 1rem;">' +
        '<p style="font-size:1.5rem;margin-bottom:0.5rem;">🚫</p>' +
        '<h3 style="margin:0 0 0.5rem">' + label + ' is disabled</h3>' +
        '<p style="color:var(--text-muted);margin:0 0 1rem">This page has been turned off in the Command Center.</p>' +
        '<button type="button" class="button button-secondary" data-action="open-settings">Go to Settings</button>' +
        '</div>';
      return;
    }
  }

  const _openTab = (nextTab) => {
    if (getAppState().activeTab === nextTab) { renderActivePage(); return; }
    _navigate(nextTab);
  };

  if (tabId === 'settings') { await renderSettings(content); return; }
  if (tabId === 'test') { await renderTest(content); return; }
  if (tabId === 'transactions') { await renderTransactions(content); return; }
  if (tabId === 'master-lists') { await renderMasterLists(content); return; }
  if (tabId === 'expenses') { await renderExpenses(content); return; }
  if (tabId === 'debt-snowball') {
    await renderDebtSnowball(content, period, periodLabel, getAppState().periods);
    return;
  }

  if (tabId === 'cash-flow') {
    await renderCashFlowForecast(content, period, periodLabel);
    return;
  }

  if (tabId === 'paycheck-planner') {
    await renderPaycheckPlanner(content, period, periodLabel);
    return;
  }
  if (tabId === 'recurring-bills') {
    await renderRecurringBills(content, period, periodLabel);
    return;
  }
  if (tabId === 'transfers') {
    await renderTransfers(content, period, periodLabel);
    return;
  }
  if (tabId === 'closeout') {
    await renderCloseout(content, period, periodLabel);
    return;
  }
  if (tabId === 'history') {
    await renderHistory(content, period, periodLabel, { onOpenTab: _openTab });
    return;
  }
  if (tabId === 'data-health') {
    await renderDataHealth(content, period, { onOpenTab: _openTab });
    return;
  }
  if (tabId === 'reports') {
    await renderReports(content, period, {
      onOpenTab: _openTab,
      onSelectPeriod: (periodId) => {
        setSelectedPeriodId(periodId);
        _renderPeriodSelector();
        renderActivePage();
      },
    });
    return;
  }
  if (tabId === 'dashboard') {
    await renderDashboardTab(content, {
      period,
      periodLabel,
      onOpenTab: _openTab,
      onSyncTransactions: () => _syncTransactionsNow(),
      onReRunAutoMatch: (p) => _runRecurringBillsAutoDetect(p),
      onOpenPaidTransaction: (transactionId) => {
        setPendingReviewTransactionId(transactionId);
        _navigate('transactions');
      },
    });
    return;
  }

  // Fallback placeholder
  content.innerHTML =
    '<header class="page-header"><div class="page-header-main"><h2 class="page-title">' + tabId + '</h2></div></header>' +
    '<div class="page-body"><section class="card empty-state-card"><p class="empty-state">Page not found.</p></section></div>';
}

// ── Sync helpers ─────────────────────────────────────────────────────────────

async function _syncTransactionsNow() {
  const data = await syncTransactions();
  emitAppEvent('budget:transactions-updated');
  return data;
}

async function _runRecurringBillsAutoDetect(period) {
  const res = await fetch(API_BASE + '/api/recurring-bills/auto-detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      periodId: period.id,
      startDate: period.startDate,
      exclusiveEndDate: period.exclusiveEndDate,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Auto-detect failed.');
  emitAppEvent('budget:recurring-bills-updated');
  return data;
}

async function _downloadBackup() {
  const res = await fetch(API_BASE + '/api/backup/export');
  const data = await res.blob();
  if (!res.ok) {
    throw new Error('Backup export failed.');
  }

  const url = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'budget-dashboard-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ── Global event delegation ──────────────────────────────────────────────────

function _attachGlobalListeners() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    // Plaid + Settings
    if (action === 'connect-plaid') { await handleConnectPlaid(btn); return; }
    if (action === 'sync-transactions') { await handleSyncTransactions(btn); return; }
    if (action === 'remove-plaid-item') { await handleRemovePlaidItem(btn); return; }
    if (action === 'remove-plaid-account') { await handleRemovePlaidAccount(btn); return; }
    if (action === 'restore-plaid-account') { await handleRestorePlaidAccount(btn); return; }
    if (action === 'cleanup-removed-plaid') { await handleCleanupRemovedPlaid(btn); return; }
    if (action === 'data-tools-cleanup-removed-plaid') { await handleCleanupRemovedPlaid(btn); return; }
    if (action === 'data-tools-run-health') { setActiveTab('data-health'); _renderNav(); renderActivePage(); return; }
    if (action === 'data-tools-export-backup') { await _downloadBackup(); return; }
    if (action === 'open-settings') { setActiveTab('settings'); _renderNav(); renderActivePage(); return; }

    // Rules manager (settings source — transactions.js handles these for its own page)
    if (action === 'rules-add') { await handleRulesAdd(); return; }
    if (action === 'rules-edit') { await handleRulesEdit(btn); return; }
    if (action === 'rules-toggle-enabled') { await handleRulesToggleEnabled(btn); return; }
    if (action === 'close-rule-editor') { closeRuleEditor(); return; }
    if (action === 'save-rule-editor') {
      // Only handle from settings context (transactions.js handles its own)
      const state = getRuleEditorState();
      if (state?.draft?.source === 'settings') {
        btn.disabled = true;
        const result = await handleSaveRuleEditor();
        btn.disabled = false;
        if (result?.success) renderActivePage();
        return;
      }
    }
  });

  document.addEventListener('change', (e) => {
    // Budget period selector
    if (e.target?.id === 'budget-period-select') {
      const periodId = e.target.value;
      setSelectedPeriodId(periodId); // persists to localStorage internally
      window.dispatchEvent(new CustomEvent('budget:period-changed', { detail: { periodId } }));
      return;
    }

    // Rule editor field changes (global — for settings page rule editor)
    if (handleRuleEditorChange(e)) return;
  });

  document.addEventListener('input', (e) => {
    if (handleRuleEditorInput(e)) return;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && getRuleEditorState()) { closeRuleEditor(); return; }
  });

  // Window events
  window.addEventListener('budget:transactions-updated', () => {
    const { activeTab } = getAppState();
    const reloadTabs = new Set(['transactions', 'dashboard', 'cash-flow', 'paycheck-planner', 'recurring-bills', 'transfers', 'closeout', 'data-health', 'reports', 'expenses', 'debt-snowball']);
    if (reloadTabs.has(activeTab)) renderActivePage();
  });

  window.addEventListener('budget:recurring-bills-updated', () => {
    const { activeTab } = getAppState();
    if (['dashboard', 'cash-flow', 'paycheck-planner', 'recurring-bills', 'transfers', 'closeout'].includes(activeTab)) renderActivePage();
  });

  window.addEventListener('budget:income-updated', () => {
    const { activeTab } = getAppState();
    if (['cash-flow', 'paycheck-planner', 'recurring-bills', 'transfers', 'closeout'].includes(activeTab)) renderActivePage();
  });

  window.addEventListener('budget:period-changed', () => {
    if (PERIOD_AWARE_TABS.has(getAppState().activeTab)) renderActivePage();
  });

  window.addEventListener('budget:planner-refresh', () => {
    const { activeTab } = getAppState();
    if (['paycheck-planner', 'transfers', 'closeout'].includes(activeTab)) renderActivePage();
  });
}
