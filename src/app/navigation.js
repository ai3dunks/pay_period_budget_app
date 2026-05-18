/**
 * navigation.js — shell HTML, nav rendering, budget period selector.
 */

import { escapeHtml } from '../utils/dom.js';
import { getPeriodLabel } from '../utils/formatters.js';

export const PERIOD_AWARE_TABS = new Set([
  'dashboard',
  'cash-flow',
  'reports',
  'data-health',
  'debt-snowball',
  'transactions',
  'paycheck-planner',
  'recurring-bills',
  'expenses',
  'transfers',
  'history',
  'closeout',
]);

export const tabs = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'cash-flow', label: 'Cash Flow' },
  { id: 'reports', label: 'Reports' },
  { id: 'data-health', label: 'Data Health' },
  { id: 'debt-snowball', label: 'Debt Snowball' },
  { id: 'paycheck-planner', label: 'Paycheck Planner' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'recurring-bills', label: 'Recurring Bills' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'history', label: 'History' },
  { id: 'closeout', label: 'Closeout' },
  { id: 'master-lists', label: 'Master Lists' },
  { id: 'settings', label: 'Settings' },
];

/**
 * renderShell — injects the full app chrome into #app.
 * Returns the page-content element.
 */
export function renderShell(app) {
  app.innerHTML =
    '<div class="app-layout">' +
    '<aside class="sidebar">' +
    '<div class="sidebar-brand">' +
    '<h1>Budget Dashboard</h1>' +
    '<p class="sidebar-subtitle">Local Personal Finance</p>' +
    '</div>' +
    '<nav class="nav" id="main-nav" aria-label="Primary"></nav>' +
    '</aside>' +
    '<main class="content">' +
    '<section class="card budget-period-selector">' +
    '<label for="budget-period-select">Budget Period</label>' +
    '<select id="budget-period-select"></select>' +
    '</section>' +
    '<section id="page-content"></section>' +
    '</main>' +
    '</div>';
  return document.getElementById('page-content');
}

/**
 * renderNav — populates #main-nav with tab buttons.
 * @param {string} activeTab
 * @param {function} onTabClick  (tabId) => void
 * @param {Set<string>} disabledTabs  optional set of disabled tab IDs
 */
export function renderNav(activeTab, onTabClick, disabledTabs = new Set()) {
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  nav.innerHTML = '';
  for (const tab of tabs) {
    if (disabledTabs.has(tab.id)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-btn' + (tab.id === activeTab ? ' active' : '');
    button.textContent = tab.label;
    button.title = tab.label;
    button.addEventListener('click', () => onTabClick(tab.id));
    nav.appendChild(button);
  }
}

/**
 * renderBudgetPeriodSelector — populates #budget-period-select.
 * @param {Array}  periods
 * @param {string} selectedId
 */
export function renderBudgetPeriodSelector(periods, selectedId) {
  const select = document.getElementById('budget-period-select');
  if (!select) return;
  select.innerHTML = periods
    .slice()
    .reverse()
    .map((p) => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(getPeriodLabel(p)) + '</option>')
    .join('');
  select.value = selectedId;
}
