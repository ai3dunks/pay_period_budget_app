/**
 * Recurring Bills page renderer
 * Displays recurring bills for the selected budget period
 */

import { buildPayPeriodSummary } from '../utils/payPeriodSummary.js';
import { fetchCloseoutRecord } from '../utils/closeoutClient.js';
import { loadCommandCenterSettings, isFeatureEnabled } from '../utils/commandCenter.js';
import { getTransactionRowsForPeriod } from '../api/transactionsApi.js';
import { withPreservedRenderState } from '../utils/renderStability.js';

const BACKEND = '';
const _billFilters = {
  paid: '',
  autopay: '',
  category: '',
};

/**
 * Fetch recurring bills from master lists API
 */
async function fetchRecurringBills() {
  try {
    const response = await fetch(BACKEND + '/api/master-lists');
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    return data.recurringBillsList || [];
  } catch (err) {
    console.error('Error fetching recurring bills:', err);
    throw err;
  }
}

async function fetchTransactions(period) {
  try {
    return await getTransactionRowsForPeriod(period);
  } catch (err) {
    console.error('Error fetching transactions:', err);
    return [];
  }
}

async function fetchSetting(key, fallback = {}) {
  try {
    const response = await fetch(BACKEND + '/api/settings/' + encodeURIComponent(key));
    if (!response.ok) return fallback;
    const data = await response.json();
    return data?.value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Fetch paid status for bills in a period
 */
async function fetchBillStatus(periodId) {
  const response = await fetch(BACKEND + '/api/recurring-bills/status?periodId=' + encodeURIComponent(periodId));
  if (!response.ok) {
    if (response.status === 400) return [];
    throw new Error(`API error: ${response.status}`);
  }
  return await response.json();
}

async function saveBillStatus(periodId, recurringBillId, paid, paidDate) {
  const response = await fetch(BACKEND + '/api/recurring-bills/status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      periodId,
      recurringBillId,
      paid,
      paidDate,
      manuallyOverridden: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to save bill status: ${response.status}`);
  }

  return await response.json();
}

async function clearBillManualOverride(periodId, recurringBillId) {
  const response = await fetch(BACKEND + '/api/recurring-bills/status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      periodId,
      recurringBillId,
      paid: false,
      paidDate: null,
      clearManualOverride: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to clear manual override: ${response.status}`);
  }

  return await response.json();
}

async function runAutoDetect(periodId, period) {
  const response = await fetch(BACKEND + '/api/recurring-bills/auto-detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      periodId,
      startDate: period.startDate,
      exclusiveEndDate: period.exclusiveEndDate,
    }),
  });

  if (!response.ok) {
    throw new Error(`Auto-detect failed: ${response.status}`);
  }

  return await response.json();
}

function formatCurrency(value) {
  return '$' + (Number(value) || 0).toFixed(2);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function daysUntilDue(dueDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate.getTime());
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due - today) / (1000 * 60 * 60 * 24));
}

function buildTransactionPopupHtml(bill, status) {
  const hasTransaction = Boolean(status && status.matchTransactionId);
  const matchScore = Number(status?.matchScore || 0);

  return (
    '<div class="modal-backdrop" data-action="close-transaction-popup"></div>' +
    '<section class="review-modal recurring-transaction-modal" role="dialog" aria-modal="true" aria-label="Recurring bill transaction">' +
    '<div class="card-header">' +
    '<h3 class="card-title">' + escapeHtml(bill.name) + '</h3>' +
    '<p class="card-description">' + escapeHtml(status?.matchStatus || (status?.paid ? 'Paid' : 'Unpaid')) + '</p>' +
    '</div>' +
    '<div class="form-grid review-details recurring-transaction-details">' +
    '<p><strong>Category:</strong> ' + escapeHtml(bill.category || '-') + '</p>' +
    '<p><strong>Amount:</strong> ' + escapeHtml(formatCurrency(bill.amount)) + '</p>' +
    '<p><strong>Due Date:</strong> ' + escapeHtml(bill.dueDateStr || '-') + '</p>' +
    '<p><strong>Match Words:</strong> ' + escapeHtml((bill.matchWords || []).join(', ') || '-') + '</p>' +
    '<p><strong>Status:</strong> ' + escapeHtml(status?.matchStatus || (status?.paid ? 'Paid' : 'Unpaid')) + '</p>' +
    '<p><strong>Score:</strong> ' + escapeHtml(matchScore ? String(Math.round(matchScore)) : '-') + '</p>' +
    '</div>' +
    (hasTransaction
      ? '<div class="transaction-popup-card">' +
        '<p><strong>Transaction Date:</strong> ' + escapeHtml(status.matchedTransactionDate || '-') + '</p>' +
        '<p><strong>Description:</strong> ' + escapeHtml(status.matchedTransactionDescription || '-') + '</p>' +
        '<p><strong>Amount:</strong> ' + escapeHtml(formatCurrency(Number(status.matchedTransactionAmount || 0))) + '</p>' +
        '<p><strong>Transaction ID:</strong> ' + escapeHtml(status.matchTransactionId || '-') + '</p>' +
        '</div>'
      : '<div class="transaction-popup-card"><p class="empty-state">No linked transaction is available for this paid item.</p></div>') +
    '<div class="filter-actions">' +
    '<button type="button" class="button button-secondary" data-action="close-transaction-popup">Close</button>' +
    '</div>' +
    '</section>'
  );
}

function getBillStatusLabel(status, bill) {
  if (!status) return bill.autopay ? 'Autopay not found' : 'Unpaid';
  if (status.manuallyOverridden && status.paid) return 'Manual';
  if (status.autoPaid && status.paid) return 'Auto-paid';
  if ((status.matchScore || 0) >= 50 && (status.matchScore || 0) < 75) return 'Possible match';
  if (status.matchStatus) return status.matchStatus;
  if (status.paid) return 'Manual';
  return bill.autopay ? 'Autopay not found' : 'Unpaid';
}

function renderBillMatchDetails(status) {
  if (!status) return '';
  const items = [];
  if (status.matchedTransactionDate) items.push('Date: ' + escapeHtml(status.matchedTransactionDate));
  if (status.matchedTransactionDescription) items.push('Desc: ' + escapeHtml(status.matchedTransactionDescription));
  if (status.matchedTransactionAmount !== null && status.matchedTransactionAmount !== undefined) {
    items.push('Amount: ' + escapeHtml(formatCurrency(Math.abs(Number(status.matchedTransactionAmount)))));
  }
  if (status.matchScore !== null && status.matchScore !== undefined) {
    items.push('Score: ' + escapeHtml(String(Math.round(Number(status.matchScore || 0)))));
  }
  return items.length ? '<div class="match-detail">' + items.map((item) => '<div>' + item + '</div>').join('') + '</div>' : '';
}

export async function renderRecurringBills(container, period, periodLabel) {
  const alreadyRendered = container.dataset.renderedPage === 'recurring-bills';
  const run = async () => {
    const result = await renderRecurringBillsInner(container, period, periodLabel);
    container.dataset.renderedPage = 'recurring-bills';
    return result;
  };
  return alreadyRendered ? withPreservedRenderState(run) : run();
}

async function renderRecurringBillsInner(container, period, periodLabel) {
  const renderContainer = container?.closest?.('#page-content') || container;
  renderContainer.innerHTML = '';

  try {
    const [
      bills,
      transactions,
      billStatus,
      includePending,
    ] = await Promise.all([
      fetchRecurringBills(),
      fetchTransactions(period),
      fetchBillStatus(period.id),
      fetchSetting('include_pending_transactions', false),
    ]);

    const summary = buildPayPeriodSummary({
      period,
      accounts: [],
      transactions: Array.isArray(transactions) ? transactions : [],
      expenseList: [],
      recurringBillsList: Array.isArray(bills) ? bills : [],
      recurringBillStatuses: billStatus,
      settings: {
        includePendingTransactions: includePending === true || includePending?.value === true,
      },
    });

    const billsDue = summary.recurringBills.dueRows;
    const billCategories = Array.from(new Set(billsDue.map((bill) => String(bill.category || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const visibleBills = billsDue.filter((bill) => {
      const paid = !!bill.status?.paid;
      if (_billFilters.paid === 'paid' && !paid) return false;
      if (_billFilters.paid === 'unpaid' && paid) return false;
      if (_billFilters.autopay === 'autopay' && !bill.autopay) return false;
      if (_billFilters.autopay === 'manual' && bill.autopay) return false;
      if (_billFilters.category && String(bill.category || '') !== _billFilters.category) return false;
      return true;
    });
    const totalDue = summary.recurringBills.dueTotal;
    const totalPaid = summary.recurringBills.paidTotal;
    const totalUnpaid = summary.recurringBills.unpaidTotal;
    const nextDueBill = billsDue.find((bill) => !bill.status || !bill.status.paid);

    const statusMap = {};
    billStatus.forEach((status) => {
      statusMap[status.recurringBillId] = status;
    });

    const ccSettings = await loadCommandCenterSettings().catch(() => null);
    const rbFeat = (key) => isFeatureEnabled(ccSettings, 'recurringBills', key);

    const page = document.createElement('div');
    page.className = 'recurring-bills-page';

    const header = document.createElement('div');
    header.className = 'page-header';
    header.innerHTML =
      '<div><h2 class="page-title">Bills</h2>' +
      '<p class="page-description">A due-date checklist for this pay period.</p></div>' +
      '<div class="period-label">Budget Period: ' + escapeHtml(periodLabel) + '</div>';
    page.appendChild(header);

    let closeoutRecord = null;
    try {
      closeoutRecord = await fetchCloseoutRecord(period.id);
    } catch (_err) {
      closeoutRecord = null;
    }

    if (closeoutRecord && closeoutRecord.status === 'closed') {
      const warning = document.createElement('div');
      warning.className = 'closeout-warning';
      warning.textContent = 'This period is closed. Reopen it before changing closeout-related data.';
      page.appendChild(warning);
    }

    const summaryCards = document.createElement('div');
    summaryCards.className = 'recurring-summary-grid';
    summaryCards.innerHTML =
      '<article><p>Assigned Bills</p><h3>' + escapeHtml(formatCurrency(totalDue)) + '</h3></article>' +
      '<article><p>Total Paid</p><h3>' + escapeHtml(formatCurrency(totalPaid)) + '</h3></article>' +
      '<article><p>Total Unpaid</p><h3>' + escapeHtml(formatCurrency(totalUnpaid)) + '</h3></article>' +
      '<article><p>Bills Due</p><h3>' + escapeHtml(String(billsDue.length)) + '</h3></article>' +
      '<article><p>Next Due Bill</p><h3>' + escapeHtml(nextDueBill ? nextDueBill.name : 'None') + '</h3></article>';
    page.appendChild(summaryCards);

    const tools = document.createElement('div');
    tools.className = 'budget-split-card';
    tools.innerHTML =
      '<div>' +
      '<button type="button" class="button" id="auto-detect-btn">Re-run auto-paid detection</button>' +
      '<div id="auto-detect-note" class="info-message"></div>' +
      '<div id="auto-detect-error" class="error-message"></div>' +
      '</div>';
    if (rbFeat('showAutoPaidDetection') || rbFeat('showAdvancedBillRules')) page.appendChild(tools);

    const billsSection = document.createElement('div');
    billsSection.className = 'bills-section';
    const filters = document.createElement('div');
    filters.className = 'card bills-filter-card form-grid';
    filters.innerHTML =
      '<label class="form-field"><span>Status</span><select id="bill-paid-filter"><option value="">All</option><option value="paid"' + (_billFilters.paid === 'paid' ? ' selected' : '') + '>Paid</option><option value="unpaid"' + (_billFilters.paid === 'unpaid' ? ' selected' : '') + '>Unpaid</option></select></label>' +
      '<label class="form-field"><span>Autopay</span><select id="bill-autopay-filter"><option value="">All</option><option value="autopay"' + (_billFilters.autopay === 'autopay' ? ' selected' : '') + '>Autopay</option><option value="manual"' + (_billFilters.autopay === 'manual' ? ' selected' : '') + '>Manual</option></select></label>' +
      '<label class="form-field"><span>Category</span><select id="bill-category-filter"><option value="">All</option>' + billCategories.map((category) => '<option value="' + escapeHtml(category) + '"' + (_billFilters.category === category ? ' selected' : '') + '>' + escapeHtml(category) + '</option>').join('') + '</select></label>';
    page.appendChild(filters);

    if (visibleBills.length === 0) {
      billsSection.innerHTML = '<section class="card"><p class="empty-state">No bills match these filters.</p></section>';
    } else {
      const billsTable = document.createElement('table');
      billsTable.className = 'bills-table';
      const thead = document.createElement('thead');
      thead.innerHTML =
        '<tr>' +
        '<th>Due</th>' +
        '<th>Bill</th>' +
        '<th>Category</th>' +
        '<th>Amount</th>' +
        '<th>Paid From</th>' +
        '<th>Autopay</th>' +
        '<th>Status</th>' +
        '<th>Actions</th>' +
        '</tr>';
      billsTable.appendChild(thead);

      const tbody = document.createElement('tbody');

      visibleBills.forEach((bill) => {
        const status = bill.status;
        const isPaid = Boolean(status && status.paid);
        const isManual = Boolean(status && status.manuallyOverridden);
        const statusLabel = getBillStatusLabel(status, bill);
        const dueDate = bill.dueDate instanceof Date ? bill.dueDate : new Date(bill.dueDate || Date.now());
        const daysLeft = daysUntilDue(dueDate);
        let dueBadge = '';
        let autoPaidBadge = '';

        if (status && status.autoPaid && rbFeat('showAutoPaidDetection')) {
          autoPaidBadge = ' <span class="badge-auto-paid" title="Auto-detected and paid">Auto-paid</span>';
        }

        if (!isPaid) {
          if (daysLeft <= 0) {
            dueBadge = ' <span class="badge-overdue">Overdue</span>';
          } else if (daysLeft <= 3) {
            dueBadge = ' <span class="badge-due-soon">Due soon</span>';
          }
        }

        let matchStatusHtml = '<span class="badge-unpaid">Unpaid</span>';
        if (rbFeat('showBillMatchingTools')) {
          if (statusLabel === 'Auto-paid') {
            matchStatusHtml =
              '<button type="button" class="status-pill-button transaction-popup-trigger" data-bill-id="' + escapeHtml(bill.id) + '"><span class="badge-auto-paid">Auto-paid</span></button>' +
              renderBillMatchDetails(status);
          } else if (statusLabel === 'Manual' || isManual) {
            matchStatusHtml =
              '<button type="button" class="status-pill-button transaction-popup-trigger" data-bill-id="' + escapeHtml(bill.id) + '"><span class="badge-manual">Manual</span></button>' +
              '<button type="button" class="button button-secondary button-sm clear-override-btn" data-bill-id="' + escapeHtml(bill.id) + '">Clear manual override</button>';
          } else if (statusLabel === 'Possible match') {
            matchStatusHtml =
              '<span class="badge-possible">Possible match</span>' +
              renderBillMatchDetails(status);
          } else if (statusLabel === 'Autopay not found') {
            matchStatusHtml = '<span class="badge-autopay-missing">Autopay not found yet</span>';
          }
        }

        const row = document.createElement('tr');
        row.innerHTML =
          '<td>' + escapeHtml(bill.dueDateStr || '') + dueBadge + '</td>' +
          '<td><strong>' + escapeHtml(bill.name) + '</strong>' + autoPaidBadge + '</td>' +
          '<td>' + escapeHtml(bill.category) + '</td>' +
          '<td class="amount-column">' + escapeHtml(formatCurrency(bill.amount)) + '</td>' +
          '<td>' + escapeHtml(bill.paidFrom || '') + '</td>' +
          '<td>' + (bill.autopay ? '<span class="badge-autopay">Yes</span>' : '-') + '</td>' +
          '<td>' + (isPaid ? '<span class="badge-good">Paid</span>' : matchStatusHtml) + '</td>' +
          '<td class="inline-actions"><label class="bill-check-action"><input type="checkbox" class="bill-paid-toggle" data-bill-id="' + escapeHtml(bill.id) + '" ' + (isPaid ? 'checked' : '') + ' /> Paid</label>' +
          (isManual ? '<button type="button" class="button button-secondary button-sm clear-override-btn" data-bill-id="' + escapeHtml(bill.id) + '">Clear</button>' : '') +
          '</td>';
        tbody.appendChild(row);
      });

      billsTable.appendChild(tbody);
      billsSection.appendChild(billsTable);
    }

    page.appendChild(billsSection);
    renderContainer.appendChild(page);

    const existingPopup = document.getElementById('recurring-transaction-popup');
    if (existingPopup) existingPopup.remove();

    const popupWrap = document.createElement('div');
    popupWrap.id = 'recurring-transaction-popup';
    popupWrap.hidden = true;
    popupWrap.innerHTML = buildTransactionPopupHtml(billsDue[0] || { name: '', category: '', amount: 0, dueDateStr: '' }, null);
    document.body.appendChild(popupWrap);

    function openTransactionPopup(billId) {
      const bill = billsDue.find((item) => item.id === billId);
      if (!bill) return;
      const status = statusMap[billId] || null;
      popupWrap.hidden = false;
      popupWrap.innerHTML = buildTransactionPopupHtml(bill, status);
      popupWrap.querySelectorAll('[data-action="close-transaction-popup"]').forEach((closeButton) => {
        closeButton.addEventListener('click', () => {
          popupWrap.hidden = true;
        });
      });
    }

    page.querySelector('#auto-detect-btn')?.addEventListener('click', async () => {
      const noteDiv = page.querySelector('#auto-detect-note');
      const errorDiv = page.querySelector('#auto-detect-error');
      const button = page.querySelector('#auto-detect-btn');

      try {
        button.disabled = true;
        button.textContent = 'Detecting...';
        noteDiv.textContent = '';
        errorDiv.textContent = '';

        const result = await runAutoDetect(period.id, period);

        if (result?.payroll?.detected) {
          const summaryText =
            'Payroll detected: ' + result.payroll.count + ' deposit(s), ' + formatCurrency(result.payroll.amount) +
            '. Auto-paid: ' + result.bills.matched + ', possible: ' + result.bills.possible + ', unpaid: ' + result.bills.unpaid + '.';
          noteDiv.innerHTML = '<strong>✓ Auto-detect complete.</strong> ' + escapeHtml(summaryText);
        } else {
          errorDiv.textContent = 'No Cisco payroll found for this period.';
        }

        await renderRecurringBills(renderContainer, period, periodLabel);
      } catch (err) {
        console.error('Auto-detect failed:', err);
        errorDiv.textContent = 'Auto-detect failed: ' + err.message;
      } finally {
        button.disabled = false;
        button.textContent = 'Re-run auto-paid detection';
      }
    });

    page.querySelector('#bill-paid-filter')?.addEventListener('change', async (event) => {
      _billFilters.paid = event.target.value;
      await renderRecurringBills(renderContainer, period, periodLabel);
    });

    page.querySelector('#bill-autopay-filter')?.addEventListener('change', async (event) => {
      _billFilters.autopay = event.target.value;
      await renderRecurringBills(renderContainer, period, periodLabel);
    });

    page.querySelector('#bill-category-filter')?.addEventListener('change', async (event) => {
      _billFilters.category = event.target.value;
      await renderRecurringBills(renderContainer, period, periodLabel);
    });

    page.querySelectorAll('.bill-paid-toggle').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        try {
          const billId = checkbox.getAttribute('data-bill-id');
          const isPaid = checkbox.checked;
          const paidDate = isPaid ? new Date().toISOString().slice(0, 10) : null;
          await saveBillStatus(period.id, billId, isPaid, paidDate);
          await renderRecurringBills(renderContainer, period, periodLabel);
        } catch (err) {
          console.error('Failed to save bill status:', err);
          alert('Failed to update bill status');
          checkbox.checked = !checkbox.checked;
        }
      });
    });

    page.querySelectorAll('.clear-override-btn').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const billId = button.getAttribute('data-bill-id');
          await clearBillManualOverride(period.id, billId);
          await renderRecurringBills(renderContainer, period, periodLabel);
        } catch (err) {
          console.error('Failed to clear manual override:', err);
          alert('Failed to clear manual override');
        }
      });
    });

    page.querySelectorAll('.transaction-popup-trigger').forEach((button) => {
      button.addEventListener('click', () => {
        const billId = button.getAttribute('data-bill-id');
        openTransactionPopup(billId);
      });
    });
  } catch (err) {
    console.error('Error rendering recurring bills:', err);
    renderContainer.innerHTML = '<p class="error-message">Failed to load recurring bills</p>';
  }
}
