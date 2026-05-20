import {
  calculateBudgetSplit,
  calculateTransferPlan,
  calculateWantsActuals,
  formatCurrencyValue,
} from '../utils/budgetCalculations.js';
import { buildPayPeriodSummary } from '../utils/payPeriodSummary.js';
import { loadBudgetContext } from '../utils/loadBudgetContext.js';
import { fetchCloseoutRecord } from '../utils/closeoutClient.js';
import { withPreservedRenderState } from '../utils/renderStability.js';
import {
  getTransferConfirmations,
  createTransferConfirmation,
  updateTransferConfirmation,
  deleteTransferConfirmation,
} from '../api/transferConfirmationApi.js';
import {
  getSnowballTransfers,
  createSnowballTransfer,
  updateSnowballTransfer,
  deleteSnowballTransfer,
} from '../api/snowballTransferApi.js';
import {
  getExpenseFundingRecords,
  createExpenseFundingRecord,
  updateExpenseFundingRecord,
  deleteExpenseFundingRecord,
} from '../api/expenseFundingApi.js';
import { loadCommandCenterSettings, isFeatureEnabled } from '../utils/commandCenter.js';
import { getTransactionRowsForPeriod } from '../api/transactionsApi.js';
import { getTransferTargetsConfig } from '../utils/transferTargets.js';

const BACKEND = '';
const DEFAULT_BUDGET_SPLIT = { Needs: 50, Wants: 30, 'Debts/Savings': 20 };

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function parseSettingMap(value) {
  if (!value || typeof value !== 'object') return {};
  return value;
}

async function fetchJson(path) {
  const response = await fetch(BACKEND + path);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}

async function fetchSetting(key) {
  const data = await fetchJson('/api/settings/' + encodeURIComponent(key));
  return parseSettingMap(data.value);
}

async function fetchMasterLists() {
  return await fetchJson('/api/master-lists');
}

async function fetchTransactions(period) {
  return await getTransactionRowsForPeriod(period);
}

async function fetchBillStatus(periodId) {
  try {
    return await fetchJson('/api/recurring-bills/status?periodId=' + encodeURIComponent(periodId));
  } catch (err) {
    console.error('Transfers: failed fetching recurring bill status:', err);
    return [];
  }
}

function getTransferStatus(kind, row) {
  if (row?.budgetGroup === 'Wants') {
    if (row.overused > 0) return 'Overused';
    if (row.transferNeeded > 0) return 'Transfer needed';
    return 'Covered';
  }
  if (row?.budgetGroup === 'Expense Funding') {
    if (row.shortfall > 0) return 'Shortfall';
    if (row.transferNeeded > 0) return 'Funded';
    return 'No transfer needed';
  }
  if (row?.budgetGroup === 'Debt/Savings') {
    if (row.redirected > 0) return 'Partially redirected';
    if (row.transferNeeded > 0) return 'Transfer needed';
    return 'No transfer needed';
  }
  if (row.transferNeeded > 0) return 'Transfer needed';
  return 'No reserve needed';
}

function getTransferStatusClass(status) {
  if (status === 'Shortfall' || status === 'Overused') return 'warn';
  if (status === 'Transfer needed' || status === 'Reserve required' || status === 'Partially redirected') return 'info';
  return 'good';
}

function renderFormulaLines(lines) {
  return lines
    .map((line) => '<div class="formula-line"><span>' + escapeHtml(line.label) + '</span><strong>' + escapeHtml(line.value) + '</strong></div>')
    .join('');
}

function formatAllocationMethodLabel(value) {
  const key = String(value || '').trim();
  if (!key) return 'Unassigned';
  return key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function renderTargetRows(rows, confirmations, options = {}) {
  const showTransferMatching = options.showTransferMatching !== false;
  const showAdvancedTransferMath = options.showAdvancedTransferMath === true;
  const confirmationMap = {};
  confirmations.forEach(c => {
    confirmationMap[c.targetName] = c;
  });

  return rows
    .map((row) => {
      const statusClass = getTransferStatusClass(row.status);
      const confirmation = confirmationMap[row.target] || confirmationMap[row.id] || null;
      const isConfirmed = confirmation && confirmation.status === 'confirmed';

      const transferNeededAmount = Number(row.transferNeeded || 0);
      const displayTransferAmount = isConfirmed
        ? Number(confirmation.confirmedTransferAmount ?? transferNeededAmount)
        : transferNeededAmount;
      
      const displayAlreadyUsed = isConfirmed 
        ? confirmation.alreadyUsedAtConfirmation
        : row.alreadyUsed;

      const statusBadge = isConfirmed 
        ? '<span class="transfer-status-badge good">Complete</span>'
        : '<span class="transfer-status-badge info">Not Confirmed</span>';

      const confirmButtonId = 'confirm-' + escapeHtml(row.id);
      const resetButtonId = 'reset-' + escapeHtml(row.id);

      const actionButtons = isConfirmed
        ? '<button type="button" class="button button-secondary button-sm" id="' + resetButtonId + '" data-action="reset-transfer-confirmation" data-target="' + escapeHtml(row.id) + '">Reset</button>'
        : '<button type="button" class="button button-primary button-sm" id="' + confirmButtonId + '" data-action="confirm-transfer" data-target="' + escapeHtml(row.id) + '" data-amount="' + escapeHtml(String(transferNeededAmount)) + '">Confirm</button>';

      return (
        '<tr>' +
        '<td>' + escapeHtml(row.target) + '</td>' +
        '<td>' + escapeHtml(row.budgetGroup || '') + '</td>' +
        '<td>' + escapeHtml(formatAllocationMethodLabel(row.allocationMethod)) + '</td>' +
        '<td>' + escapeHtml(formatCurrencyValue(row.plannedAmount)) + '</td>' +
        '<td>' + escapeHtml(formatCurrencyValue(displayAlreadyUsed)) + '</td>' +
        '<td>' + escapeHtml(formatCurrencyValue(displayTransferAmount)) + '</td>' +
        '<td>' + statusBadge + '</td>' +
        (showTransferMatching ? '<td>' + actionButtons + '</td>' : '') +
        (showAdvancedTransferMath ? '<td><button type="button" class="button button-secondary button-sm" data-action="transfer-toggle-details" data-target="' + escapeHtml(row.id) + '">Details</button></td>' : '') +
        '</tr>' +
        (showAdvancedTransferMath
          ? '<tr class="transfer-detail-row" data-detail-row="' + escapeHtml(row.id) + '" hidden>' +
            '<td colspan="' + String(5 + (showTransferMatching ? 1 : 0) + 1) + '"><div class="transfer-detail-panel">' + renderFormulaLines(row.detailLines) + '</div></td>' +
            '</tr>'
          : '')
      );
    })
    .join('');
}

function renderWantsTargetCards(targets = []) {
  if (!targets.length) return '<p class="empty-state">No active Wants targets configured.</p>';
  return '<div class="transfer-summary-grid wants-summary-grid">' +
    targets.map((target) => (
      '<article class="card">' +
      '<p>' + escapeHtml(target.name) + '</p>' +
      '<h3>' + escapeHtml(formatCurrencyValue(target.actualSpent || 0)) + '</h3>' +
      '<p class="muted-note">Direct ' + escapeHtml(formatCurrencyValue(target.directSpent || 0)) + ' | Shared ' + escapeHtml(formatCurrencyValue(target.splitShare || 0)) + '</p>' +
      '</article>'
    )).join('') +
  '</div>';
}

function renderWantsTable(rows) {
  if (!rows.length) {
    return '<p class="empty-state">No Wants transactions found in this budget period.</p>';
  }

  const body = rows
    .map((row) => {
      const amount = Math.abs(Number(row.amount || 0));
      const account = row.account_name || row.institution_name || '';
      return (
        '<tr>' +
        '<td>' + escapeHtml(row.date || '') + '</td>' +
        '<td>' + escapeHtml(row.name || row.merchant_name || '') + '</td>' +
        '<td>' + escapeHtml(account) + '</td>' +
        '<td>' + escapeHtml(row.category || '') + '</td>' +
        '<td>' + escapeHtml(formatCurrencyValue(amount)) + '</td>' +
        '<td>' + escapeHtml(row.pending ? 'Yes' : 'No') + '</td>' +
        '</tr>'
      );
    })
    .join('');

  return (
    '<div class="table-wrap">' +
    '<table class="table transfer-table wants-table">' +
    '<thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th>Amount</th><th>Pending</th></tr></thead>' +
    '<tbody>' + body + '</tbody>' +
    '</table>' +
    '</div>'
  );
}


export async function renderTransfers(container, period, periodLabel) {
  const alreadyRendered = container.dataset.renderedPage === 'transfers';
  const run = async () => {
    const result = await renderTransfersInner(container, period, periodLabel);
    container.dataset.renderedPage = 'transfers';
    return result;
  };
  return alreadyRendered ? withPreservedRenderState(run) : run();
}

async function renderTransfersInner(container, period, periodLabel) {
  container.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'transfers-page';
  page.innerHTML =
    '<div class="page-header">' +
    '<div>' +
    '<h2 class="page-title">Transfers</h2>' +
    '<p class="page-description">Plan where this paycheck needs to move.</p>' +
    '<div class="period-label">Budget Period: ' + escapeHtml(periodLabel) + '</div>' +
    '</div>' +
    '</div>' +
    '<section class="card"><p class="empty-state">Loading transfers...</p></section>';

  container.appendChild(page);

  let backendDown = false;
  let masterListsError = '';
  let transactionsError = '';

  let accounts = [];
  let expenseList = [];
  let recurringBillsList = [];
  let transactions = [];
  let billStatusRows = [];
  let manualIncomeByPeriod = {};
  let autoDetectedIncomeByPeriod = {};
  let splitSettingValue = {};
  let safeMoneySettings = {};
  let transferTargetsSetting = {};

  try {
    const budgetContext = await loadBudgetContext({ period });
    accounts = Array.isArray(budgetContext?.accounts) ? budgetContext.accounts : [];
    transactions = Array.isArray(budgetContext?.transactions) ? budgetContext.transactions : [];
    expenseList = Array.isArray(budgetContext?.expenseList) ? budgetContext.expenseList : [];
    recurringBillsList = Array.isArray(budgetContext?.recurringBillsList) ? budgetContext.recurringBillsList : [];
    billStatusRows = Array.isArray(budgetContext?.recurringBillStatuses) ? budgetContext.recurringBillStatuses : [];
    manualIncomeByPeriod = budgetContext?.settings?.manualIncomeByPeriod || budgetContext?.settings?.budget_income_by_period || {};
    autoDetectedIncomeByPeriod = budgetContext?.settings?.autoDetectedIncomeByPeriod || budgetContext?.settings?.auto_detected_income_by_period || {};
    splitSettingValue = budgetContext?.settings?.splitSettings || {};
    safeMoneySettings = budgetContext?.settings?.safeMoneySettings || {};
    transferTargetsSetting = budgetContext?.settings?.transferTargets || budgetContext?.settings?.transfer_targets || {};
  } catch (err) {
    console.error('Transfers: failed loading budget context:', err);
    backendDown = String(err.message || '').includes('Failed to fetch');
    masterListsError = 'Master Lists could not be loaded.';
    transactionsError = 'Transactions could not be loaded.';
  }

  const splitSettings = splitSettingValue?.default || DEFAULT_BUDGET_SPLIT;
  const sharedSummary = buildPayPeriodSummary({
    period,
    accounts,
    transactions,
    expenseList,
    recurringBillsList,
    recurringBillStatuses: billStatusRows,
    settings: {
      budget_income_by_period: manualIncomeByPeriod,
      auto_detected_income_by_period: autoDetectedIncomeByPeriod,
      manualIncomeByPeriod,
      autoDetectedIncomeByPeriod,
      splitSettings,
      safeMoneySettings,
      transferTargets: transferTargetsSetting,
    },
  });
  const safeMoney = sharedSummary.safeMoney || {
    safeToTransfer: { amount: sharedSummary.safeToTransfer, status: 'warning', blockers: [], warnings: [], breakdown: {} },
  };

  const splitSummary = calculateBudgetSplit({
    budgetIncome: sharedSummary.income.budgetIncome,
    recurringBillsDue: sharedSummary.recurringBills.dueRows,
    splitSettings,
  });

  const wantsActuals = {
    wantsRows: sharedSummary.wants.transactions,
    splitTotal: Number(sharedSummary.wants.splitSpent || 0),
    targets: Array.isArray(sharedSummary.wants.targets) ? sharedSummary.wants.targets : [],
    joshDirect: Number(sharedSummary.wants.joshDirect || 0),
    taylorDirect: Number(sharedSummary.wants.taylorDirect || 0),
    joshSplitShare: Number(sharedSummary.wants.joshSplitShare || 0),
    taylorSplitShare: Number(sharedSummary.wants.taylorSplitShare || 0),
    joshActual: Number(sharedSummary.wants.joshSpent || 0),
    taylorActual: Number(sharedSummary.wants.taylorSpent || 0),
  };


  const transferPlan = calculateTransferPlan({
    splitSummary,
    expenseBudget: { totalExpenseBudget: sharedSummary.expenses.budgetTotal },
    wantsActuals,
    transferTargets: transferTargetsSetting,
    budgetIncome: sharedSummary.income.budgetIncome,
  });

  const alerts = [];
  if (backendDown) {
    alerts.push('Backend not reachable through the local API proxy.');
  }
  if (masterListsError) {
    alerts.push(masterListsError);
  }
  if (transactionsError) {
    alerts.push(transactionsError);
  }
  if (sharedSummary.income.budgetIncome <= 0) {
    alerts.push('Enter income or sync Cisco payroll before planning transfers.');
  }
  if (transferPlan.discoverShortfall > 0) {
    alerts.push('Discover transfer is short by ' + formatCurrencyValue(transferPlan.discoverShortfall) + '.');
  }
  if (transferPlan.debtSavingsRedirect > 0) {
    alerts.push('Debts/Savings remaining was redirected to Discover because Needs remaining did not cover the Expense Budget.');
  }
  if (transferPlan.joshOverused > 0) {
    alerts.push('Josh has used ' + formatCurrencyValue(transferPlan.joshOverused) + ' more than his Wants share.');
  }
  if (transferPlan.taylorOverused > 0) {
    alerts.push('Taylor has used ' + formatCurrencyValue(transferPlan.taylorOverused) + ' more than her Wants share.');
  }
  if (sharedSummary.expenses.budgetTotal <= 0) {
    alerts.push('Add expense budgets in Master Lists > Expense List.');
  }
  const safeTransfer = safeMoney.safeToTransfer || { amount: sharedSummary.safeToTransfer, blockers: [], warnings: [], status: 'warning' };
  const totalPlannedTransfers = Number(transferPlan.totalPlannedTransfers || 0);
  if (Number.isFinite(Number(safeTransfer.amount)) && totalPlannedTransfers > Number(safeTransfer.amount || 0)) {
    alerts.push('Planned transfers exceed safe transfer amount by ' + formatCurrencyValue(totalPlannedTransfers - Number(safeTransfer.amount || 0)) + '.');
  }
  if (safeTransfer.blockers?.length) {
    alerts.push(safeTransfer.blockers[0]);
  }

  let closeoutRecord = null;
  try {
    closeoutRecord = await fetchCloseoutRecord(period.id);
  } catch (err) {
    console.error('Transfers: failed loading closeout record:', err);
  }

  let transferConfirmations = [];
  let debtSavingsFundingRecords = [];
  let expenseFundingRecords = [];
  try {
    const confData = await getTransferConfirmations(period.id);
    transferConfirmations = Array.isArray(confData?.confirmations) ? confData.confirmations : [];
  } catch (err) {
    console.error('Transfers: failed loading transfer confirmations:', err);
  }

  try {
    const fundingData = await getSnowballTransfers(period.id);
    debtSavingsFundingRecords = Array.isArray(fundingData?.transfers) ? fundingData.transfers : [];
  } catch (err) {
    console.error('Transfers: failed loading debt/savings funding records:', err);
  }

  try {
    const fundingData = await getExpenseFundingRecords(period.id);
    expenseFundingRecords = Array.isArray(fundingData?.records) ? fundingData.records : [];
  } catch (err) {
    console.error('Transfers: failed loading expense funding records:', err);
  }

  const transferTargets = getTransferTargetsConfig(transferTargetsSetting);
  const transferTargetById = new Map(transferTargets.map((target) => [target.id, target]));
  const applyTargetMeta = (targetId, row) => {
    const target = transferTargetById.get(targetId) || null;
    return {
      id: target?.id || targetId,
      name: target?.name || row.target || targetId,
      target: target?.name || row.target || targetId,
      active: target?.active !== false,
      budgetGroup: target?.budgetGroup || '',
      targetKind: target?.targetKind || '',
      allocationMethod: target?.allocationMethod || '',
      connectedModule: target?.connectedModule || 'none',
      confirmAction: target?.confirmAction || 'create_transfer_confirmation',
      priority: target?.priority || 0,
      notes: target?.notes || '',
      ...row,
    };
  };
  const shouldShowTarget = (target) => {
    if (!target) return false;
    if (target.budgetGroup === 'Wants') return trFeat('showJoshTaylorSplit');
    if (target.budgetGroup === 'Expense Funding') return trFeat('showDiscoverTransferPlan');
    if (target.budgetGroup === 'Debt/Savings') return trFeat('showDebtSavingsTransferPlan');
    return true;
  };

  const ccSettings = await loadCommandCenterSettings().catch(() => null);
  const trFeat = (key) => isFeatureEnabled(ccSettings, 'transfers', key);

  const closeoutWarningHtml = closeoutRecord && closeoutRecord.status === 'closed'
    ? '<div class="closeout-warning">This period is closed. Reopen it before changing closeout-related data.</div>'
    : '';

  const rowsToShow = (transferPlan.targetRows || [])
    .map((row) => applyTargetMeta(row.id, {
      ...row,
      formulaSource: row.budgetGroup === 'Wants'
        ? 'Configured Wants target allocation minus already used spending'
        : row.budgetGroup === 'Expense Funding'
          ? 'Expense funding target allocation from Needs and redirected Debt/Savings'
          : row.budgetGroup === 'Debt/Savings'
            ? 'Debt/Savings remaining after Expense Funding redirect'
            : 'Configured transfer target allocation',
      redirected: row.id === 'debt-savings' ? transferPlan.debtSavingsRedirect : 0,
      shortfall: row.id === 'discover' ? transferPlan.discoverShortfall : 0,
      alreadyUsed: row.id === 'discover'
        ? transferPlan.needsToDiscover + transferPlan.debtSavingsRedirect
        : row.id === 'debt-savings'
          ? transferPlan.debtSavingsRedirect
          : row.alreadyUsed,
      detailLines: [
        { label: 'Budget Group', value: row.budgetGroup || '' },
        { label: 'Allocation Method', value: formatAllocationMethodLabel(row.allocationMethod) },
        { label: 'Planned Transfer', value: formatCurrencyValue(row.plannedAmount || 0) },
        { label: 'Already Used', value: formatCurrencyValue(row.alreadyUsed || 0) },
        { label: 'New Planned Transfer', value: formatCurrencyValue(row.transferNeeded || 0) },
      ],
    }))
    .filter((row) => shouldShowTarget(row))
    .map((row) => ({ ...row, status: getTransferStatus(row.id, row) }));

  const rows = rowsToShow;
  const showTransferMatching = trFeat('showTransferMatching');
  const showAdvancedTransferMath = trFeat('showAdvancedTransferMath');

  const html =

    '<section class="transfer-summary-grid">' +
    '<article class="card"><p>Total Planned Transfers</p><h3>' + escapeHtml(formatCurrencyValue(transferPlan.totalPlannedTransfers)) + '</h3></article>' +
    rows.map((row) => '<article class="card"><p>' + escapeHtml(row.target) + '</p><h3>' + escapeHtml(formatCurrencyValue(row.transferNeeded || 0)) + '</h3><p class="muted-note">' + escapeHtml(row.budgetGroup || '') + '</p></article>').join('') +
    '</section>' +
    '<section class="card planner-safe-money-card">' +
    '<div class="card-header"><h3 class="card-title">Safe to Transfer</h3><p class="card-description">Shared safe transfer amount from the summary engine.</p></div>' +
    '<div class="planner-safe-money-grid">' +
    '<article class="card stat-card compact"><p class="label">Amount</p><h3 class="value">' + escapeHtml(formatCurrencyValue(safeTransfer.amount || 0)) + '</h3><p class="hint"><span class="dashboard-pill status-' + escapeHtml(safeTransfer.status || 'warning') + '">' + escapeHtml(safeTransfer.label || (safeTransfer.status || 'warning')) + '</span></p></article>' +
    '<article class="card stat-card compact"><p class="label">Safety Buffer</p><h3 class="value">' + escapeHtml(formatCurrencyValue(sharedSummary.safeMoney?.safetyBuffer || 0)) + '</h3><p class="hint">' + escapeHtml(sharedSummary.safeMoney?.pendingNote || '') + '</p></article>' +
    '</div>' +
    '<details class="safe-money-disclosure"><summary>Calculation details</summary>' +
    '<div class="safe-money-breakdown">' +
    (safeTransfer.warnings?.length ? '<div class="dashboard-alert warning"><strong>Transfer notes</strong><div>' + safeTransfer.warnings.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') + '</div></div>' : '') +
    Object.entries(safeTransfer.breakdown || {}).map(([key, value]) => '<div class="action-row"><span>' + escapeHtml(key) + '</span><strong>' + escapeHtml(typeof value === 'number' ? formatCurrencyValue(value) : String(value)) + '</strong></div>').join('') +
    (safeTransfer.blockers?.length ? '<div class="dashboard-alert danger"><strong>Blockers</strong><div>' + safeTransfer.blockers.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') + '</div></div>' : '') +
    '</div></details>' +
    '</section>' +
    (alerts.length
      ? '<section class="card alert-list">' + alerts.map((alert) => '<div class="warning-message">' + escapeHtml(alert) + '</div>').join('') + '</section>'
      : '') +
    '<section class="card">' +
    '<div class="table-wrap"><table class="table transfer-table">' +
    '<thead><tr><th>Target</th><th>Budget Group</th><th>Allocation Method</th><th>Planned Transfer</th><th>Already Used</th><th>New Planned Transfer</th><th>Status</th>' + (showTransferMatching ? '<th>Action</th>' : '') + (showAdvancedTransferMath ? '<th>Details</th>' : '') + '</tr></thead>' +
    '<tbody>' + renderTargetRows(rows, transferConfirmations, { showTransferMatching, showAdvancedTransferMath }) + '</tbody>' +
    '</table></div>' +
    '<p class="muted-note">Debt/Savings transfer excludes bills paid directly from Bank of America.</p>' +
    '</section>' +
    (trFeat('showJoshTaylorSplit') ?
      '<section class="card wants-activity-card">' +
      '<div class="card-header"><h3 class="card-title">Wants Activity</h3><p class="card-description">Transactions already counted against active Wants targets.</p></div>' +
      '<article class="card"><p>Split wants spent</p><h3>' + escapeHtml(formatCurrencyValue(wantsActuals.splitTotal)) + '</h3></article>' +
      renderWantsTargetCards(wantsActuals.targets || []) +
      renderWantsTable(wantsActuals.wantsRows) +
      '</section>'
      : '');

  page.innerHTML =
    '<div class="page-header">' +
    '<div>' +
    '<h2 class="page-title">Transfers</h2>' +
    '<p class="page-description">Plan where this paycheck needs to move.</p>' +
    '<div class="period-label">Budget Period: ' + escapeHtml(periodLabel) + '</div>' +
    '</div>' +
    '</div>' +
    closeoutWarningHtml +
    html;

  page.querySelectorAll('[data-action="transfer-toggle-details"]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.getAttribute('data-target');
      const row = page.querySelector('[data-detail-row="' + target + '"]');
      if (!row) return;
      row.hidden = !row.hidden;
      button.textContent = row.hidden ? 'Details' : 'Hide';
    });
  });

  // Target name map
  const targetNameMap = Object.fromEntries(rows.map((row) => [row.id, row.target]));

  function backendErrMsg(err) {
    return String(err.message || '').includes('Failed to fetch')
      ? 'Backend not reachable through the local API proxy.'
      : err.message;
  }

  // ─── Per-target Transfer Confirmation listeners ────────────────────────────
  page.querySelectorAll('[data-action="confirm-transfer"]').forEach((button) => {
    button.addEventListener('click', async (e) => {
      const targetId = e.currentTarget.getAttribute('data-target');
      const amount = parseFloat(e.currentTarget.getAttribute('data-amount') || '0');
      const targetRow = rows.find(r => r.id === targetId);
      
      if (!targetRow || !Number.isFinite(amount)) {
        return;
      }

      const confirmedAmount = Math.max(0, Number(targetRow.transferNeeded || amount || 0));

      try {
        // Check if confirmation already exists
        const existing = transferConfirmations.find(c => c.targetName === targetNameMap[targetId]);
        const existingDebtSavingsFundingRecord = debtSavingsFundingRecords.find((row) => row.sourceTargetId === targetId || row.sourceTargetName === targetRow.target);
        const existingExpenseFundingRecord = expenseFundingRecords.find((row) => row.sourceTargetId === targetId || row.sourceTargetName === targetRow.target);
        
        if (existing) {
          // Update existing confirmation
          await updateTransferConfirmation(existing.id, {
            status: 'confirmed',
            confirmedTransferAmount: confirmedAmount,
            alreadyUsedAtConfirmation: targetRow.alreadyUsed,
          });
        } else {
          // Create new confirmation
          await createTransferConfirmation({
            budgetPeriodId: period.id,
            startDate: period.startDate || '',
            endDate: period.displayEndDate || period.exclusiveEndDate || '',
            targetName: targetNameMap[targetId],
            plannedTransfer: targetRow.plannedAmount,
            alreadyUsedAtConfirmation: targetRow.alreadyUsed,
            confirmedTransferAmount: confirmedAmount,
            status: 'confirmed',
            notes: 'Confirmed via Transfer page for period: ' + periodLabel,
          });
        }

        if (targetRow.confirmAction === 'create_debt_savings_funding') {
          const fundingPayload = {
            budgetPeriodId: period.id,
            startDate: period.startDate || '',
            endDate: period.displayEndDate || period.exclusiveEndDate || '',
            sourceTargetId: targetRow.id,
            sourceTargetName: targetRow.target,
            confirmedAmount,
            status: 'transfer_confirmed',
            notes: 'Confirmed from Transfers page for period: ' + periodLabel,
          };
          if (existingDebtSavingsFundingRecord?.id) {
            await updateSnowballTransfer(existingDebtSavingsFundingRecord.id, fundingPayload);
          } else {
            await createSnowballTransfer(fundingPayload);
          }
        }

        if (targetRow.confirmAction === 'create_expense_funding') {
          const fundingPayload = {
            budgetPeriodId: period.id,
            startDate: period.startDate || '',
            endDate: period.displayEndDate || period.exclusiveEndDate || '',
            sourceTargetId: targetRow.id,
            sourceTargetName: targetRow.target,
            confirmedAmount,
            status: 'transfer_confirmed',
            notes: 'Confirmed from Transfers page for period: ' + periodLabel,
          };
          if (existingExpenseFundingRecord?.id) {
            await updateExpenseFundingRecord(existingExpenseFundingRecord.id, fundingPayload);
          } else {
            await createExpenseFundingRecord(fundingPayload);
          }
        }

        await renderTransfers(container, period, periodLabel);
      } catch (err) {
        alert('Failed to confirm transfer: ' + backendErrMsg(err));
      }
    });
  });

  page.querySelectorAll('[data-action="reset-transfer-confirmation"]').forEach((button) => {
    button.addEventListener('click', async (e) => {
      const targetId = e.currentTarget.getAttribute('data-target');
      const targetName = targetNameMap[targetId];
      const existing = transferConfirmations.find(c => c.targetName === targetName);
      const targetRow = rows.find((row) => row.id === targetId);
      const existingDebtSavingsFundingRecord = debtSavingsFundingRecords.find((row) => row.sourceTargetId === targetId || row.sourceTargetName === targetName);
      const existingExpenseFundingRecord = expenseFundingRecords.find((row) => row.sourceTargetId === targetId || row.sourceTargetName === targetName);

      if (!existing) return;

      if (!window.confirm('Reset transfer confirmation for ' + targetName + '?')) return;

      try {
        await deleteTransferConfirmation(existing.id);
        if (targetRow?.confirmAction === 'create_debt_savings_funding' && existingDebtSavingsFundingRecord?.id) {
          await deleteSnowballTransfer(existingDebtSavingsFundingRecord.id);
        }
        if (targetRow?.confirmAction === 'create_expense_funding' && existingExpenseFundingRecord?.id) {
          await deleteExpenseFundingRecord(existingExpenseFundingRecord.id);
        }
        await renderTransfers(container, period, periodLabel);
      } catch (err) {
        alert('Failed to reset transfer confirmation: ' + backendErrMsg(err));
      }
    });
  });
}
