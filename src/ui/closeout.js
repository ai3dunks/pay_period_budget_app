import { buildPayPeriodSummary } from '../utils/payPeriodSummary.js';
import { loadBudgetContext } from '../utils/loadBudgetContext.js';
import { isDateInBudgetPeriod } from '../utils/budgetPeriods.js';
import { createCompactCloseoutPayload } from '../utils/closeoutPayload.js';
import {
  closeCloseoutRecord,
  fetchCloseoutRecord,
  patchCloseoutRecord,
  prepareCloseoutRecord,
  reopenCloseoutRecord,
} from '../utils/closeoutClient.js';

const BACKEND = '';

function getCloseoutConfirmations(record = {}) {
  return {
    incomeConfirmed: !!record.income_confirmed,
    billsConfirmed: !!record.bills_confirmed,
    transfersConfirmed: !!record.transfers_confirmed,
    expensesConfirmed: !!record.expenses_confirmed,
  };
}

function buildCloseoutSummaryForPayload(summary = {}, periodTransactions = []) {
  const reviewedTransactions = periodTransactions.filter((row) => !!row.reviewed).length;
  const unreviewedTransactions = periodTransactions.filter((row) => !row.reviewed).length;
  const ignoredTransactions = periodTransactions.filter((row) => !!row.ignored).length;
  return {
    ...summary,
    dataHealth: {
      ...(summary.dataHealth || {}),
      totalTransactions: periodTransactions.length,
      periodTransactionCount: periodTransactions.length,
      reviewedTransactions,
      unreviewedTransactions,
      ignoredTransactions,
    },
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return (amount < 0 ? '-' : '') + '$' + Math.abs(amount).toFixed(2);
}

function statusClass(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'closed') return 'good';
  if (key === 'ready_to_close') return 'warning';
  if (key === 'reopened') return 'info';
  return 'warning';
}

function statusLabel(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'closed') return 'Closed';
  if (key === 'ready_to_close') return 'Ready to Close';
  if (key === 'reopened') return 'Reopened';
  return 'Open';
}

function formatPeriodLabel(period) {
  if (!period) return 'Unavailable';
  return period.label || [period.startDate, period.displayEndDate].filter(Boolean).join(' - ') || period.id || 'Unavailable';
}

function renderMetricCard(label, value, hint, tone = 'neutral') {
  return (
    '<article class="card closeout-card metric-card">' +
    '<div class="metric-card">' +
    '<div class="metric-label">' + escapeHtml(label) + '</div>' +
    '<div class="metric-value ' + (tone ? 'text-' + tone : '') + '">' + escapeHtml(value) + '</div>' +
    (hint ? '<div class="metric-subtext"><div>' + escapeHtml(hint) + '</div></div>' : '') +
    '</div>' +
    '</article>'
  );
}

function renderChecklistCard({ keyName, title, items, confirmed, checkboxLabel, tone = 'neutral', checkboxId, notes }) {
  return (
    '<article class="card closeout-card closeout-checklist-card">' +
    '<div class="card-header">' +
    '<h3 class="card-title">' + escapeHtml(title) + '</h3>' +
    (notes ? '<p class="card-description">' + escapeHtml(notes) + '</p>' : '') +
    '</div>' +
    '<div class="action-list">' +
    items.map((item) => '<div class="action-row"><span>' + escapeHtml(item.label) + '</span><strong class="text-' + tone + '">' + escapeHtml(item.value) + '</strong></div>').join('') +
    '</div>' +
    '<label class="closeout-confirmation"><input type="checkbox" id="' + escapeHtml(checkboxId) + '" data-action="closeout-toggle" data-key="' + escapeHtml(keyName) + '" ' + (confirmed ? 'checked' : '') + '> <span>' + escapeHtml(checkboxLabel) + '</span></label>' +
    '</article>'
  );
}

function renderWarningBox(title, lines, tone = 'warning') {
  if (!lines || !lines.length) return '';
  return (
    '<div class="closeout-' + tone + '">' +
    '<strong>' + escapeHtml(title) + '</strong>' +
    '<div>' + lines.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') + '</div>' +
    '</div>'
  );
}

function buildCloseoutAnalysis({ period, summary, transactions, record }) {
  const periodTransactions = (transactions || []).filter((row) => row && isDateInBudgetPeriod(row.date, period) && !row.ignored);
  const unreviewedTransactionsCount = periodTransactions.filter((row) => !row.reviewed).length;
  const pendingTransactionsCount = periodTransactions.filter((row) => !!row.pending).length;
  const unpaidRecurringBillsCount = Number(summary.recurringBills?.unpaidCount || 0);
  const pendingTransfersCount = Number(summary.transfers?.total || 0) > 0 ? 1 : 0;
  const overBudgetCategoryCount = Number(summary.expenses?.overBudgetCount || 0);
  const safeSpend = summary.safeMoney?.safeToSpend || { amount: summary.safeToSpend };
  const safeTransfer = summary.safeMoney?.safeToTransfer || { amount: summary.safeToTransfer };

  const checklist = {
    income: {
      label: 'Income',
      budgetIncome: Number(summary.income?.budgetIncome || 0),
      source: summary.income?.source || 'Unavailable',
      confirmed: !!record?.income_confirmed,
    },
    recurringBills: {
      label: 'Recurring Bills',
      dueTotal: Number(summary.recurringBills?.dueTotal || 0),
      paidTotal: Number(summary.recurringBills?.paidTotal || 0),
      unpaidTotal: Number(summary.recurringBills?.unpaidTotal || 0),
      unpaidCount: unpaidRecurringBillsCount,
      confirmed: !!record?.bills_confirmed,
    },
    transfers: {
      label: 'Transfers',
      plannedTotal: Number(summary.transfers?.total || 0),
      completedTransfers: Number(summary.transfers?.total || 0),
      pendingTransfersCount,
      confirmed: !!record?.transfers_confirmed,
    },
    expenses: {
      label: 'Expenses',
      budgetTotal: Number(summary.expenses?.budgetTotal || 0),
      actualTotal: Number(summary.expenses?.actualTotal || 0),
      remaining: Number(summary.expenses?.remaining || 0),
      overBudgetCategoryCount,
      unreviewedTransactionsCount,
      confirmed: !!record?.expenses_confirmed,
    },
    history: {
      label: 'History Snapshot',
      snapshotId: record?.snapshot_id || null,
      saved: !!record?.snapshot_id,
    },
  };

  const blockers = [];
  const warnings = [];
  if (Number(summary.income?.budgetIncome || 0) <= 0) blockers.push('Budget Income is missing.');
  if (unreviewedTransactionsCount > 0 && !checklist.expenses.confirmed) blockers.push('Unreviewed transactions remain and Expenses are not confirmed.');
  if (unpaidRecurringBillsCount > 0 && !checklist.recurringBills.confirmed) blockers.push('Unpaid recurring bills remain and Bills are not confirmed.');
  if (pendingTransfersCount > 0 && !checklist.transfers.confirmed) blockers.push('Transfer checklist still has pending items.');
  if (overBudgetCategoryCount > 0) warnings.push('Expense categories are over budget.');
  if (Number(safeSpend.amount || 0) < 0) warnings.push('Safe to Spend is negative.');
  if (Number(safeTransfer.amount || 0) < 0) warnings.push('Safe to Transfer is negative.');
  if (pendingTransactionsCount > 0) warnings.push('Pending transactions exist.');
  if (summary.safeMoney?.includePendingTransactions) {
    warnings.push('Pending transactions are included in closeout totals.');
  } else {
    warnings.push('Pending transactions are excluded from closeout totals.');
  }

  const readyToClose = checklist.income.confirmed && checklist.recurringBills.confirmed && checklist.transfers.confirmed && checklist.expenses.confirmed && blockers.length === 0;

  return {
    checklist,
    blockers,
    warnings,
    readyToClose,
    pendingTransactionsCount,
    unreviewedTransactionsCount,
    unpaidRecurringBillsCount,
    overBudgetCategoryCount,
    safeSpend,
    safeTransfer,
  };
}

async function saveSnapshotForCloseout({ payload, existingSnapshotId }) {
  if (existingSnapshotId) {
    return { id: existingSnapshotId, linked: true };
  }
  const response = await fetch(BACKEND + '/api/history/snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 413) {
      throw new Error('Closeout payload was too large. The app tried to save too much detail. Try again after compact summary fix.');
    }
    throw new Error(data.error || 'Failed to save snapshot.');
  }
  return data;
}

export async function renderCloseout(container, period, periodLabel) {
  container.innerHTML = '<section class="card"><p class="empty-state">Loading closeout...</p></section>';

  if (!period) {
    container.innerHTML = '<section class="card"><p class="empty-state">Select a budget period first.</p></section>';
    return;
  }

  let context;
  let summary;
  let record;

  try {
    context = await loadBudgetContext({ period });
    summary = buildPayPeriodSummary({
      period,
      accounts: context.accounts || [],
      transactions: context.transactions || [],
      expenseList: context.expenseList || [],
      recurringBillsList: context.recurringBillsList || [],
      recurringBillStatuses: context.recurringBillStatuses || [],
      settings: context.settings || {},
    });
    const periodTransactions = (context.transactions || []).filter((row) => row && isDateInBudgetPeriod(row.date, period) && !row.ignored);
    const compactSummary = buildCloseoutSummaryForPayload(summary, periodTransactions);
    const existing = await fetchCloseoutRecord(period.id).catch(() => null);
    buildCloseoutAnalysis({
      period,
      summary,
      transactions: context.transactions || [],
      record: existing || {},
    });
    const compactPayload = createCompactCloseoutPayload({
      period,
      summary: compactSummary,
      notes: existing?.notes || '',
      carryForwardNotes: existing?.carry_forward_notes || '',
      confirmations: getCloseoutConfirmations(existing || {}),
    });
    record = await prepareCloseoutRecord(compactPayload);
  } catch (err) {
    container.innerHTML = '<section class="card"><div class="error-card">' + escapeHtml(err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message || 'Closeout summary could not be built.') + '</div></section>';
    return;
  }

  const periodTransactions = (context.transactions || []).filter((row) => row && isDateInBudgetPeriod(row.date, period) && !row.ignored);
  const unreviewedTransactionsCount = periodTransactions.filter((row) => !row.reviewed).length;
  const pendingTransactionsCount = periodTransactions.filter((row) => !!row.pending).length;
  const summaryCards =
    '<section class="closeout-grid">' +
    renderMetricCard('Budget Income', formatMoney(summary.income?.budgetIncome || 0), summary.income?.source || 'Unavailable', 'good') +
    renderMetricCard('Recurring Bills Due', formatMoney(summary.recurringBills?.dueTotal || 0), (summary.recurringBills?.unpaidCount || 0) + ' unpaid bill' + ((summary.recurringBills?.unpaidCount || 0) === 1 ? '' : 's'), 'warning') +
    renderMetricCard('Bills Paid', formatMoney(summary.recurringBills?.paidTotal || 0), 'Bills already confirmed or auto-paid', 'good') +
    renderMetricCard('Expenses Actual', formatMoney(summary.expenses?.actualTotal || 0), (summary.expenses?.overBudgetCount || 0) + ' over-budget categor' + ((summary.expenses?.overBudgetCount || 0) === 1 ? 'y' : 'ies'), summary.expenses?.overBudgetCount ? 'warning' : 'good') +
    renderMetricCard('Transfers Completed', formatMoney(summary.transfers?.total || 0), 'Planned transfer amount from the shared summary', 'good') +
    renderMetricCard('Cash Remaining', formatMoney(summary.expenses?.remaining || 0), 'After recurring bills and expenses', summary.expenses?.remaining < 0 ? 'danger' : 'good') +
    renderMetricCard('Safe to Spend', formatMoney((summary.safeMoney?.safeToSpend?.amount ?? summary.safeToSpend) || 0), summary.safeMoney?.safeToSpend?.label || 'Shared safe-money result', summary.safeMoney?.safeToSpend?.status === 'danger' ? 'danger' : 'good') +
    '</section>';

  const checklist = record.checklist || {};
  const incomeCard = renderChecklistCard({
    keyName: 'income',
    title: 'Income',
    checkboxId: 'closeout-income',
    confirmed: !!record.income_confirmed,
    checkboxLabel: 'Income is correct',
    tone: summary.income?.budgetIncome > 0 ? 'good' : 'warning',
    notes: 'Confirm the final income used for this period.',
    items: [
      { label: 'Budget Income', value: formatMoney(summary.income?.budgetIncome || 0) },
      { label: 'Payroll source', value: summary.income?.source || 'Unavailable' },
      { label: 'Detected payroll', value: summary.income?.payrollTransactions?.length ? 'Yes' : 'No' },
    ],
  });

  const billsCard = renderChecklistCard({
    keyName: 'bills',
    title: 'Recurring Bills',
    checkboxId: 'closeout-bills',
    confirmed: !!record.bills_confirmed,
    checkboxLabel: 'Bills are correct',
    tone: unreviewedTransactionsCount || pendingTransactionsCount ? 'warning' : 'good',
    notes: 'Confirm all recurring bills were paid or intentionally left unpaid.',
    items: [
      { label: 'Bills due', value: formatMoney(summary.recurringBills?.dueTotal || 0) },
      { label: 'Bills paid', value: formatMoney(summary.recurringBills?.paidTotal || 0) },
      { label: 'Bills unpaid', value: formatMoney(summary.recurringBills?.unpaidTotal || 0) },
    ],
  });

  const transfersCard = renderChecklistCard({
    keyName: 'transfers',
    title: 'Transfers',
    checkboxId: 'closeout-transfers',
    confirmed: !!record.transfers_confirmed,
    checkboxLabel: 'Transfers are correct',
    tone: Number(summary.transfers?.total || 0) > 0 ? 'warning' : 'good',
    notes: 'Confirm the planned transfer checklist matches what happened.',
    items: [
      { label: 'Planned transfers', value: formatMoney(summary.transfers?.total || 0) },
      { label: 'Completed transfers', value: formatMoney(summary.transfers?.total || 0) },
      { label: 'Pending transfers', value: formatMoney(Number(summary.transfers?.total || 0) > 0 ? summary.transfers?.total || 0 : 0) },
    ],
  });

  const expensesCard = renderChecklistCard({
    keyName: 'expenses',
    title: 'Expenses',
    checkboxId: 'closeout-expenses',
    confirmed: !!record.expenses_confirmed,
    checkboxLabel: 'Expenses are correct',
    tone: summary.expenses?.overBudgetCount ? 'warning' : 'good',
    notes: 'Confirm expense review and categorization are finished.',
    items: [
      { label: 'Expense budget', value: formatMoney(summary.expenses?.budgetTotal || 0) },
      { label: 'Actual spending', value: formatMoney(summary.expenses?.actualTotal || 0) },
      { label: 'Over-budget categories', value: String(summary.expenses?.overBudgetCount || 0) },
      { label: 'Unreviewed transactions', value: String(unreviewedTransactionsCount) },
    ],
  });

  const historyCard =
    '<article class="card closeout-card closeout-history-card">' +
    '<div class="card-header"><h3 class="card-title">History Snapshot</h3><p class="card-description">Save or link the snapshot that will represent this closed period.</p></div>' +
    '<div class="action-list">' +
    '<div class="action-row"><span>Snapshot status</span><strong>' + escapeHtml(record.snapshot_id ? 'Saved' : 'Not saved') + '</strong></div>' +
    '<div class="action-row"><span>Snapshot link</span><strong>' + escapeHtml(record.snapshot_id || 'None yet') + '</strong></div>' +
    '</div>' +
    '<div class="closeout-actions">' +
    '<button type="button" class="button button-secondary" data-action="closeout-save-snapshot">Save Snapshot</button>' +
    '</div>' +
    '<label class="closeout-confirmation"><input type="checkbox" id="closeout-history" data-action="closeout-toggle" data-key="history" ' + (record.snapshot_id ? 'checked' : '') + ' disabled> <span>Snapshot saved or will be saved at close</span></label>' +
    '</article>';

  const checklistWarnings = [];
  if (record.blockers?.length) checklistWarnings.push(...record.blockers);
  if (record.warnings?.length) checklistWarnings.push(...record.warnings);

  const notesHtml =
    '<section class="card closeout-card closeout-notes">' +
    '<div class="card-header"><h3 class="card-title">Notes</h3><p class="card-description">Capture anything that should carry into the next period.</p></div>' +
    '<div class="form-grid">' +
    '<label class="form-field"><span>Closeout Notes</span><textarea id="closeout-notes" rows="4" placeholder="Used for this period.">' + escapeHtml(record.notes || '') + '</textarea></label>' +
    '<label class="form-field"><span>Carry Forward Notes</span><textarea id="closeout-carry-forward-notes" rows="4" placeholder="Shown next period as reminders.">' + escapeHtml(record.carry_forward_notes || '') + '</textarea></label>' +
    '</div>' +
    '<div class="closeout-actions">' +
    '<button type="button" class="button button-primary" data-action="closeout-save-notes">Save Notes</button>' +
    '</div>' +
    '<div id="closeout-message" class="settings-message" aria-live="polite"></div>' +
    '</section>';

  const statusBadge = '<span class="closeout-status-badge ' + escapeHtml(statusClass(record.status)) + '">' + escapeHtml(statusLabel(record.status)) + '</span>';
  const blockersHtml = renderWarningBox('Blocking issues', record.blockers || [], 'blocker');
  const warningsHtml = renderWarningBox('Warnings', record.warnings || [], 'warning');
  const pendingHtml = pendingTransactionsCount > 0 ? '<div class="closeout-warning">Pending transactions exist. Closeout may change after they post.</div>' : '';
  const closeoutBanner = record.status === 'closed'
    ? '<div class="closeout-warning">This period is closed. Reopen it before changing closeout-related data.</div>'
    : '';
  const readyHtml = record.readyToClose
    ? '<div class="closeout-warning">Ready to close. All confirmations are complete and no hard blockers remain.</div>'
    : '<div class="closeout-warning">Complete every confirmation and clear any blockers before closing.</div>';

  container.innerHTML =
    '<div class="closeout-page">' +
    '<header class="page-header">' +
    '<div class="page-header-main">' +
    '<h2 class="page-title">Pay Period Closeout</h2>' +
    '<p class="page-description">Review and close the current budget period.</p>' +
    '</div>' +
    '<div class="page-header-right">' +
    '<span class="status-badge">' + escapeHtml(formatPeriodLabel(period)) + '</span>' +
    statusBadge +
    '</div>' +
    '</header>' +
    closeoutBanner +
    pendingHtml +
    readyHtml +
    blockersHtml +
    warningsHtml +
    summaryCards +
    '<section class="closeout-grid">' +
    incomeCard +
    billsCard +
    transfersCard +
    expensesCard +
    historyCard +
    '</section>' +
    notesHtml +
    '<section class="card closeout-card closeout-actions">' +
    '<div class="closeout-actions">' +
    '<button type="button" class="button button-primary" data-action="closeout-close" ' + (!record.readyToClose || record.status === 'closed' ? 'disabled' : '') + '>Close Pay Period</button>' +
    '<button type="button" class="button button-secondary" data-action="closeout-reopen" ' + (record.status === 'closed' ? '' : 'disabled') + '>Reopen Period</button>' +
    '</div>' +
    '</section>' +
    '</div>';

  async function rerenderWithMessage(message, isError = false) {
    const updated = await renderCloseout(container, period, periodLabel);
    if (message) {
      const messageEl = document.getElementById('closeout-message');
      if (messageEl) {
        messageEl.className = 'settings-message ' + (isError ? 'error' : 'success');
        messageEl.textContent = message;
      }
    }
    return updated;
  }

  container.querySelectorAll('[data-action="closeout-toggle"]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      try {
        const key = checkbox.dataset.key;
        const payload = {
          incomeConfirmed: undefined,
          billsConfirmed: undefined,
          transfersConfirmed: undefined,
          expensesConfirmed: undefined,
        };
        if (key === 'income') payload.incomeConfirmed = checkbox.checked;
        if (key === 'bills') payload.billsConfirmed = checkbox.checked;
        if (key === 'transfers') payload.transfersConfirmed = checkbox.checked;
        if (key === 'expenses') payload.expensesConfirmed = checkbox.checked;
        await patchCloseoutRecord(record.id, payload);
        await renderCloseout(container, period, periodLabel);
      } catch (err) {
        const messageEl = document.getElementById('closeout-message');
        if (messageEl) {
          messageEl.className = 'settings-message error';
          messageEl.textContent = err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message;
        }
      }
    });
  });

  container.querySelector('[data-action="closeout-save-notes"]')?.addEventListener('click', async () => {
    try {
      const notes = container.querySelector('#closeout-notes')?.value || '';
      const carryForwardNotes = container.querySelector('#closeout-carry-forward-notes')?.value || '';
      await patchCloseoutRecord(record.id, {
        notes,
        carryForwardNotes,
      });
      await renderCloseout(container, period, periodLabel);
      const messageEl = document.getElementById('closeout-message');
      if (messageEl) {
        messageEl.className = 'settings-message success';
        messageEl.textContent = 'Notes saved.';
      }
    } catch (err) {
      const messageEl = document.getElementById('closeout-message');
      if (messageEl) {
        messageEl.className = 'settings-message error';
        messageEl.textContent = err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message;
      }
    }
  });

  container.querySelector('[data-action="closeout-save-snapshot"]')?.addEventListener('click', async () => {
    try {
      const periodTransactions = (context.transactions || []).filter((row) => row && isDateInBudgetPeriod(row.date, period) && !row.ignored);
      const compactSummary = buildCloseoutSummaryForPayload(summary, periodTransactions);
      const snapshotPayload = createCompactCloseoutPayload({
        period,
        summary: compactSummary,
        notes: record.notes || '',
        carryForwardNotes: record.carry_forward_notes || '',
        confirmations: getCloseoutConfirmations(record),
      });
      const snapshot = await saveSnapshotForCloseout({
        payload: snapshotPayload,
        existingSnapshotId: record.snapshot_id,
      });
      await patchCloseoutRecord(record.id, { notes: record.notes || '', carryForwardNotes: record.carry_forward_notes || '', snapshotId: snapshot.id });
      await renderCloseout(container, period, periodLabel);
      const messageEl = document.getElementById('closeout-message');
      if (messageEl) {
        messageEl.className = 'settings-message success';
        messageEl.textContent = 'Snapshot saved.';
      }
    } catch (err) {
      const messageEl = document.getElementById('closeout-message');
      if (messageEl) {
        messageEl.className = 'settings-message error';
        messageEl.textContent = err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message;
      }
    }
  });

  container.querySelector('[data-action="closeout-close"]')?.addEventListener('click', async () => {
    try {
      await closeCloseoutRecord(record.id);
      await renderCloseout(container, period, periodLabel);
      const messageEl = document.getElementById('closeout-message');
      if (messageEl) {
        messageEl.className = 'settings-message success';
        messageEl.textContent = 'Pay period closed.';
      }
    } catch (err) {
      const messageEl = document.getElementById('closeout-message');
      if (messageEl) {
        messageEl.className = 'settings-message error';
        messageEl.textContent = err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message;
      }
    }
  });

  container.querySelector('[data-action="closeout-reopen"]')?.addEventListener('click', async () => {
    try {
      await reopenCloseoutRecord(record.id);
      await renderCloseout(container, period, periodLabel);
      const messageEl = document.getElementById('closeout-message');
      if (messageEl) {
        messageEl.className = 'settings-message success';
        messageEl.textContent = 'Pay period reopened.';
      }
    } catch (err) {
      const messageEl = document.getElementById('closeout-message');
      if (messageEl) {
        messageEl.className = 'settings-message error';
        messageEl.textContent = err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message;
      }
    }
  });
}
