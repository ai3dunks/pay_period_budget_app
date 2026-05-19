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
  { id: 'dashboard', label: 'Dashboard', mobileLabel: 'Home', mobile: true },
  { id: 'transactions', label: 'Transactions', mobile: true },
  { id: 'paycheck-planner', label: 'Budget Plan' },
  { id: 'recurring-bills', label: 'Bills', mobile: true },
  { id: 'transfers', label: 'Transfers' },
  { id: 'debt-snowball', label: 'Debt' },
  { id: 'reports', label: 'Reports' },
  { id: 'settings', label: 'Settings', mobile: true },
];

/**
 * renderShell — injects the full app chrome into #app.
 * Returns the page-content element.
 */
export function renderShell(app) {
  app.innerHTML =
    '<div class="app-layout">' +
    '<header class="mobile-topbar"><div><strong>Pay Period Budget</strong><span>Plan this paycheck.</span></div><select id="budget-period-select-mobile" aria-label="Budget Period"></select></header>' +
    '<aside class="sidebar">' +
    '<div class="sidebar-brand">' +
    '<h1>Pay Period Budget</h1>' +
    '<p class="sidebar-subtitle">Plan this paycheck before it disappears.</p>' +
    '</div>' +
    '<section class="budget-period-selector">' +
    '<label for="budget-period-select">Budget Period</label>' +
    '<select id="budget-period-select"></select>' +
    '</section>' +
    '<nav class="nav" id="main-nav" aria-label="Primary"></nav>' +
    '<section class="sidebar-sync-card"><span>Sync Status</span><strong>Ready</strong><small>Use Settings to connect or sync banks.</small></section>' +
    '</aside>' +
    '<main class="content">' +
    '<section id="page-content"></section>' +
    '</main>' +
    '<nav class="mobile-bottom-nav" id="mobile-nav" aria-label="Mobile primary"></nav>' +
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
  const mobileNav = document.getElementById('mobile-nav');
  if (nav) nav.innerHTML = '';
  if (mobileNav) mobileNav.innerHTML = '';
  for (const tab of tabs) {
    if (disabledTabs.has(tab.id)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-btn' + (tab.id === activeTab ? ' active' : '');
    button.textContent = tab.label;
    button.title = tab.label;
    button.addEventListener('click', () => onTabClick(tab.id));
    if (nav) nav.appendChild(button);

    if (mobileNav && tab.mobile) {
      const mobileButton = document.createElement('button');
      mobileButton.type = 'button';
      mobileButton.className = 'mobile-nav-btn' + (tab.id === activeTab ? ' active' : '');
      mobileButton.textContent = tab.mobileLabel || tab.label;
      mobileButton.title = tab.label;
      mobileButton.addEventListener('click', () => onTabClick(tab.id));
      mobileNav.appendChild(mobileButton);
    }
  }
}

/**
 * renderBudgetPeriodSelector — populates #budget-period-select.
 * @param {Array}  periods
 * @param {string} selectedId
 */
export function renderBudgetPeriodSelector(periods, selectedId) {
  const optionsHtml = periods
    .slice()
    .reverse()
    .map((p) => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(getPeriodLabel(p)) + '</option>')
    .join('');
  ['budget-period-select', 'budget-period-select-mobile'].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = optionsHtml;
    select.value = selectedId;
  });
}
