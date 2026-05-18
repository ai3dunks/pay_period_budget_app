import {
  formatCurrencyValue,
  calculateFlexibleBudgetSplitEngine,
} from '../utils/budgetCalculations.js';
import { buildPayPeriodSummary } from '../utils/payPeriodSummary.js';
import { getDetectedPayrollIncome } from '../utils/payrollDetection.js';
import { loadCommandCenterSettings, isFeatureEnabled } from '../utils/commandCenter.js';
import {
  getBudgetBuckets,
  createBudgetBucket,
  updateBudgetBucket,
  deleteBudgetBucket,
  assignTransactionToBucket,
} from '../api/budgetBucketsApi.js';
import { getTransactionRowsForPeriod } from '../api/transactionsApi.js';

const BACKEND = '';
const BUDGET_SPLIT_GROUPS = ['Needs', 'Wants', 'Debts/Savings'];

function formatBudgetSplitGroupLabel(group) {
  return group === 'Debts/Savings' ? 'Debt/Savings' : String(group || '');
}

function normalizeBudgetGroup(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'needs') return 'Needs';
  if (raw === 'wants') return 'Wants';
  if (raw === 'debts/savings' || raw === 'debt/savings' || raw === 'debtsavings' || raw === 'debts' || raw === 'savings') {
    return 'Debts/Savings';
  }
  return null;
}

async function fetchBudgetBucketsForPeriod(period) {
  return await getBudgetBuckets({
    payPeriodStart: period.startDate,
    payPeriodEnd: period.exclusiveEndDate,
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeMatchWordsInput(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const output = [];
  source.forEach((word) => {
    const trimmed = String(word || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(trimmed);
  });
  return output;
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

async function fetchMasterLists() {
  const data = await fetchJson('/api/master-lists');
  return {
    loaded: true,
    expenseList: Array.isArray(data.expenseList)
      ? data.expenseList.map((item) => ({
          ...item,
          matchWords: normalizeMatchWordsInput(item.matchWords || []),
        }))
      : [],
    recurringBillsList: Array.isArray(data.recurringBillsList)
      ? data.recurringBillsList.map((item) => ({
          ...item,
          matchWords: normalizeMatchWordsInput(item.matchWords || []),
        }))
      : [],
  };
}

async function fetchTransactions(period) {
  return await getTransactionRowsForPeriod(period);
}

function splitInputId(groupName) {
  return 'planner-split-' + String(groupName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function normalizeSplitSettings(raw = {}) {
  const source = raw && raw.default && typeof raw.default === 'object' ? raw.default : raw;
  const needs = Number(source.Needs ?? source.needs_percent ?? 60);
  const wants = Number(source.Wants ?? source.wants_percent ?? 20);
  const debtSavings = Number(source['Debts/Savings'] ?? source.debts_savings_percent ?? 20);
  return {
    Needs: Number.isFinite(needs) ? needs : 60,
    Wants: Number.isFinite(wants) ? wants : 20,
    'Debts/Savings': Number.isFinite(debtSavings) ? debtSavings : 20,
  };
}

async function saveBudgetSplitSettings(nextSplit) {
  const payload = {
    id: 'default',
    needs_percent: Number(nextSplit.Needs || 0),
    wants_percent: Number(nextSplit.Wants || 0),
    debts_savings_percent: Number(nextSplit['Debts/Savings'] || 0),
    default: {
      Needs: Number(nextSplit.Needs || 0),
      Wants: Number(nextSplit.Wants || 0),
      'Debts/Savings': Number(nextSplit['Debts/Savings'] || 0),
    },
    Needs: Number(nextSplit.Needs || 0),
    Wants: Number(nextSplit.Wants || 0),
    'Debts/Savings': Number(nextSplit['Debts/Savings'] || 0),
    updated_at: new Date().toISOString(),
  };
  await saveSetting('budget_split_settings', payload);
}

async function fetchBillStatus(periodId) {
  try {
    return await fetchJson('/api/recurring-bills/status?periodId=' + encodeURIComponent(periodId));
  } catch (err) {
    console.error('Error fetching recurring bill status:', err);
    return [];
  }
}

async function fetchSetting(key) {
  try {
    const data = await fetchJson('/api/settings/' + encodeURIComponent(key));
    return parseSettingMap(data.value);
  } catch (err) {
    console.error('Error fetching setting:', key, err);
    return {};
  }
}

async function saveSetting(key, value) {
  const response = await fetch(BACKEND + '/api/settings/' + encodeURIComponent(key), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save setting: ${response.status}`);
  }
}

async function saveBudgetIncome(periodId, income) {
  const current = parseSettingMap(await fetchSetting('budget_income_by_period'));
  current[periodId] = Number(income || 0);
  await saveSetting('budget_income_by_period', current);
}

async function clearBudgetIncome(periodId) {
  const current = parseSettingMap(await fetchSetting('budget_income_by_period'));
  delete current[periodId];
  await saveSetting('budget_income_by_period', current);
}

async function saveAutoDetectedIncome(periodId, income) {
  const current = parseSettingMap(await fetchSetting('auto_detected_income_by_period'));
  current[periodId] = Number(income || 0);
  await saveSetting('auto_detected_income_by_period', current);
}

async function fetchAutoDetectSummary(period) {
  try {
    const response = await fetch(BACKEND + '/api/recurring-bills/auto-detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        periodId: period.id,
        startDate: period.startDate,
        exclusiveEndDate: period.exclusiveEndDate,
      }),
    });
    if (!response.ok) {
      throw new Error(`Auto-detect failed: ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    console.error('Paycheck planner auto-detect error:', err);
    throw err;
  }
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

function buildStatusMap(rows) {
  const map = {};
  (rows || []).forEach((row) => {
    map[row.recurringBillId] = row;
  });
  return map;
}

function getMatchStatusLabel(status, bill) {
  if (!status) return bill.autopay ? 'Autopay not found' : 'Unpaid';
  if (status.manuallyOverridden && status.paid) return 'Manual';
  if (status.autoPaid && status.paid) return 'Auto-paid';
  if ((status.matchScore || 0) >= 50 && (status.matchScore || 0) < 75) return 'Possible match';
  if (status.matchMethod === 'autopay_not_found') return 'Autopay not found';
  if (status.paid) return 'Manual';
  return bill.autopay ? 'Autopay not found' : 'Unpaid';
}

function renderStatusBadge(label) {
  const key = String(label || 'Unpaid').toLowerCase();
  if (key === 'auto-paid') return '<span class="badge-auto-paid match-status-badge">Auto-paid</span>';
  if (key === 'manual') return '<span class="badge-manual match-status-badge">Manual</span>';
  if (key === 'possible match') return '<span class="badge-possible match-status-badge">Possible match</span>';
  if (key === 'autopay not found') return '<span class="badge-autopay-missing match-status-badge">Autopay not found</span>';
  return '<span class="badge-unpaid match-status-badge">Unpaid</span>';
}

function renderBillMatchDetails(status) {
  if (!status) return '';
  const items = [];
  if (status.matchedTransactionDate) items.push('Date: ' + escapeHtml(status.matchedTransactionDate));
  if (status.matchedTransactionDescription) items.push('Desc: ' + escapeHtml(status.matchedTransactionDescription));
  if (status.matchedTransactionAmount !== null && status.matchedTransactionAmount !== undefined) {
    items.push('Amount: ' + escapeHtml(formatCurrencyValue(Math.abs(Number(status.matchedTransactionAmount)))));
  }
  if (status.matchScore !== null && status.matchScore !== undefined) {
    items.push('Score: ' + escapeHtml(String(Math.round(Number(status.matchScore || 0)))));
  }
  return items.length
    ? '<div class="match-detail">' + items.map((item) => '<div>' + item + '</div>').join('') + '</div>'
    : '';
}

function renderSectionCard(title, description, bodyHtml, className = '') {
  return (
    '<article class="card ' + className + '">' +
    '<div class="card-header"><h3 class="card-title">' + escapeHtml(title) + '</h3>' +
    (description ? '<p class="card-description">' + escapeHtml(description) + '</p>' : '') +
    '</div>' +
    bodyHtml +
    '</article>'
  );
}

function formatShortDate(value) {
  if (!value) return 'Unknown date';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export async function renderPaycheckPlanner(container, period, periodLabel) {
  container.innerHTML = '';

  const pageWrap = document.createElement('div');
  pageWrap.className = 'planner-grid';

  try {
    const [
      masterLists,
      transactions,
      billStatus,
      manualIncomeMap,
      autoIncomeMap,
      splitSettingsRaw,
      safeMoneySettings,
      bucketsPayload,
      ccSettings,
    ] = await Promise.all([
      fetchMasterLists(),
      fetchTransactions(period),
      fetchBillStatus(period.id),
      fetchSetting('budget_income_by_period'),
      fetchSetting('auto_detected_income_by_period'),
      fetchSetting('budget_split_settings'),
      fetchSetting('safe_money_settings'),
      fetchBudgetBucketsForPeriod(period).catch(() => ({ rows: [], groupTotals: {}, unassignedSpending: { count: 0, total: 0, transactions: [] } })),
      loadCommandCenterSettings().catch(() => null),
    ]);
    const ppFeat = (key) => isFeatureEnabled(ccSettings, 'paycheckPlanner', key);

    const expenseList = masterLists.expenseList || [];
    const recurringBillsList = masterLists.recurringBillsList || [];
    const detectedPayroll = getDetectedPayrollIncome(transactions, period);
    const effectiveAutoIncomeMap = {
      ...autoIncomeMap,
    };
    if (detectedPayroll.detected) {
      effectiveAutoIncomeMap[period.id] = Number(detectedPayroll.amount || 0);
    }
    const summary = buildPayPeriodSummary({
      period,
      accounts: [],
      transactions,
      expenseList,
      recurringBillsList,
      recurringBillStatuses: billStatus,
      settings: {
        budget_income_by_period: manualIncomeMap,
        auto_detected_income_by_period: effectiveAutoIncomeMap,
        manualIncomeByPeriod: manualIncomeMap,
        autoDetectedIncomeByPeriod: effectiveAutoIncomeMap,
        splitSettings: splitSettingsRaw,
        safeMoneySettings,
      },
    });
    const safeMoney = summary.safeMoney || {
      safetyBuffer: 0,
      includePendingTransactions: false,
      pendingNote: 'Pending transactions excluded.',
      safeToSpend: { amount: summary.safeToSpend, status: 'warning', blockers: [], warnings: [], breakdown: {} },
      safeToTransfer: { amount: summary.safeToTransfer, status: 'warning', blockers: [], warnings: [], breakdown: {} },
    };
    const billsDue = summary.recurringBills.dueRows;

    const manualIncome = manualIncomeMap[period.id] ?? null;
    const autoIncome = detectedPayroll.detected
      ? Number(detectedPayroll.amount || 0)
      : (autoIncomeMap[period.id] ?? null);
    const budgetIncome = Number(summary.income.budgetIncome || 0);
    const regularPaycheck = Number(summary.income.regularPaycheck || 0);
    const budgetTotal = Number(summary.income.budgetIncome || 0);
    const recurringBillsDue = Number(summary.recurringBills.dueTotal || 0);
    const alreadyPaid = Number(summary.recurringBills.paidTotal || 0);
    const leftToPay = Number(summary.recurringBills.unpaidTotal || 0);
    const expenseBudgetTotal = Number(summary.expenses.budgetTotal || 0);
    const cashRemaining = Number((safeMoney.safeToSpend?.amount ?? summary.safeToSpend) || 0);

    const splitSettings = normalizeSplitSettings(splitSettingsRaw);
    const splitEngine = calculateFlexibleBudgetSplitEngine({
      budgetIncome,
      recurringBillsDue: summary.recurringBills?.dueRows || [],
      splitSettings,
    });

    const hasManualIncome = manualIncome !== null && manualIncome !== undefined;
    const sourceLabel = summary.income.source;

    const selectedPayrollDateLabel = summary.income.selectedPayrollTransaction?.date
      ? formatShortDate(summary.income.selectedPayrollTransaction.date)
      : null;

    const detectedPayrollLine = (!ppFeat('showDetectedPayrollIncome') ? '' : detectedPayroll.detected
      ? '<p><strong>Detected Cisco payroll:</strong> ' + escapeHtml(formatCurrencyValue(autoIncome)) + '</p>'
      : '<p><strong>No Cisco payroll found for this budget period.</strong></p>');

    const detectedPayrollWarningLine = summary.income.payrollWarning
      ? '<p class="muted-note"><strong>' + escapeHtml(summary.income.payrollWarning + (selectedPayrollDateLabel ? ' Using latest paycheck dated ' + selectedPayrollDateLabel + '.' : '')) + '</strong></p>'
      : '';

    const manualOverrideLine = (!ppFeat('showManualOverride') ? '' : hasManualIncome
      ? '<p><strong>Manual income override active.</strong></p>'
      : '<p class="muted-note">Manual override is not active.</p>');

    const incomeBreakdownDetails = !ppFeat('showIncomeBreakdown') ? '' :
      '<details class="safe-money-disclosure"><summary>How calculated</summary>' +
      '<div class="safe-money-breakdown">' +
      '<div class="action-row"><span>Selected Budget Period</span><strong>' + escapeHtml(periodLabel) + '</strong></div>' +
      '<div class="action-row"><span>Cisco payroll transactions found</span><strong>' + escapeHtml(String(summary.income.ciscoPayrollTransactionsFound || 0)) + '</strong></div>' +
      '<div class="action-row"><span>Regular paycheck used</span><strong>' + escapeHtml(String(summary.income.regularPaycheckTransactionCount || 0)) + '</strong></div>' +
      '<div class="action-row"><span>Ignored duplicate payroll transactions</span><strong>' + escapeHtml(String(summary.income.ignoredDuplicatePayrollTransactionsCount || 0)) + '</strong></div>' +
      '<div class="action-row"><span>Bonus transactions counted</span><strong>' + escapeHtml(String(summary.income.bonusTransactionCount || 0)) + '</strong></div>' +
      '<div class="action-row"><span>Other Income transactions counted</span><strong>' + escapeHtml(String(summary.income.otherIncomeTransactionCount || 0)) + '</strong></div>' +
      '<div class="action-row"><span>Excluded income transactions outside period</span><strong>' + escapeHtml(String(summary.income.excludedIncomeOutsidePeriodCount || 0)) + '</strong></div>' +
      (summary.income.selectedPayrollTransaction
        ? '<div class="action-row"><span>Payroll used</span><strong>' + escapeHtml((summary.income.selectedPayrollTransaction.date || '') + ' | ' + formatCurrencyValue(summary.income.selectedPayrollTransaction.amount || 0)) + '</strong></div>'
        : '') +
      ((summary.income.ignoredDuplicatePayrollTransactions || []).length
        ? '<div class="action-row"><span>Duplicate payroll ignored</span><strong>' + escapeHtml((summary.income.ignoredDuplicatePayrollTransactions || []).map((row) => (row.date || '') + ' | ' + formatCurrencyValue(row.amount || 0)).join(' ; ')) + '</strong></div>'
        : '') +
      '</div>' +
      '</details>';

    const summaryCards =
      '<section class="summary-grid compact planner-summary-grid">' +
      '<article class="card stat-card compact" title="Income detected or entered for this budget period."><p class="label">Budget Total</p><h3 class="value">' + escapeHtml(formatCurrencyValue(budgetTotal)) + '</h3><p class="hint">Regular + Bonus + Other Income</p></article>' +
      '<article class="card stat-card compact" title="Detected Cisco payroll or manual override for this budget period."><p class="label">Regular Paycheck</p><h3 class="value">' + escapeHtml(formatCurrencyValue(regularPaycheck)) + '</h3><p class="hint">Source: ' + escapeHtml(sourceLabel) + '</p></article>' +
      '<article class="card stat-card compact" title="Active recurring bills due inside ' + escapeHtml(periodLabel) + '."><p class="label">Recurring Bills Due</p><h3 class="value">' + escapeHtml(formatCurrencyValue(recurringBillsDue)) + '</h3><p class="hint">Counted bills: ' + escapeHtml(String(billsDue.length)) + '</p></article>' +
      '<article class="card stat-card compact" title="Bills marked paid or auto-paid for this budget period."><p class="label">Already Paid</p><h3 class="value">' + escapeHtml(formatCurrencyValue(alreadyPaid)) + '</h3><p class="hint">Paid bills only</p></article>' +
      '<article class="card stat-card compact" title="Recurring Bills Due minus Already Paid."><p class="label">Left To Pay</p><h3 class="value">' + escapeHtml(formatCurrencyValue(leftToPay)) + '</h3><p class="hint">Remaining recurring bills</p></article>' +
      '<article class="card stat-card compact" title="Sum of active Expense List budget amounts."><p class="label">Expense Budget</p><h3 class="value">' + escapeHtml(formatCurrencyValue(expenseBudgetTotal)) + '</h3><p class="hint">Active categories: ' + escapeHtml(String(summary.expenses.categoryRows.length)) + '</p></article>' +
      '<article class="card stat-card compact" title="Budget Total minus Recurring Bills Due and Expense Budget."><p class="label">Cash Remaining</p><h3 class="value">' + escapeHtml(formatCurrencyValue(cashRemaining)) + '</h3><p class="hint">After bills + expenses</p></article>' +
      '</section>';

    const safeSpend = safeMoney.safeToSpend || { amount: summary.safeToSpend, status: 'warning', blockers: [], warnings: [], breakdown: {} };
    const safeTransfer = safeMoney.safeToTransfer || { amount: summary.safeToTransfer, status: 'warning', blockers: [], warnings: [], breakdown: {} };
    const safeMoneySection =
      '<section class="card planner-safe-money-card">' +
      '<div class="card-header"><h3 class="card-title">Safe Money</h3><p class="card-description">Shared safe-to-spend and safe-to-transfer results from the summary engine.</p></div>' +
      '<div class="planner-safe-money-grid">' +
      '<article class="card stat-card compact"><p class="label">Safe to Spend</p><h3 class="value">' + escapeHtml(formatCurrencyValue(safeSpend.amount)) + '</h3><p class="hint"><span class="dashboard-pill status-' + escapeHtml(safeSpend.status || 'warning') + '">' + escapeHtml(safeSpend.label || (safeSpend.status || 'warning')) + '</span></p></article>' +
      '<article class="card stat-card compact"><p class="label">Safe to Transfer</p><h3 class="value">' + escapeHtml(formatCurrencyValue(safeTransfer.amount)) + '</h3><p class="hint"><span class="dashboard-pill status-' + escapeHtml(safeTransfer.status || 'warning') + '">' + escapeHtml(safeTransfer.label || (safeTransfer.status || 'warning')) + '</span></p></article>' +
      '<article class="card stat-card compact"><p class="label">Safety Buffer</p><h3 class="value">' + escapeHtml(formatCurrencyValue(safeMoney.safetyBuffer || 0)) + '</h3><p class="hint">' + escapeHtml(safeMoney.pendingNote || '') + '</p></article>' +
      '</div>' +
      '<details class="safe-money-disclosure"><summary>Calculation details</summary>' +
      '<div class="safe-money-breakdown">' +
      '<div class="action-row"><span>Include pending transactions</span><strong>' + escapeHtml(safeMoney.includePendingTransactions ? 'Yes' : 'No') + '</strong></div>' +
      (safeSpend.warnings?.length ? '<div class="dashboard-alert warning"><strong>Spend notes</strong><div>' + safeSpend.warnings.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') + '</div></div>' : '') +
      (safeSpend.blockers?.length ? '<div class="dashboard-alert danger"><strong>Spend blockers</strong><div>' + safeSpend.blockers.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') + '</div></div>' : '') +
      (safeTransfer.warnings?.length ? '<div class="dashboard-alert warning"><strong>Transfer notes</strong><div>' + safeTransfer.warnings.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') + '</div></div>' : '') +
      (safeTransfer.blockers?.length ? '<div class="dashboard-alert danger"><strong>Transfer blockers</strong><div>' + safeTransfer.blockers.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') + '</div></div>' : '') +
      '</div></details>' +
      '</section>';

    const breakdownRows = billsDue
      .map((bill) => {
        const paid = bill.status && bill.status.paid;
        const paidLabel = paid ? (bill.status.autoPaid ? 'Auto-paid' : 'Paid') : 'Unpaid';
        return '<tr>' +
          '<td>' + escapeHtml(bill.name) + '</td>' +
          '<td>' + escapeHtml(bill.dueDateStr || '') + '</td>' +
          '<td>' + escapeHtml(formatCurrencyValue(bill.amount)) + '</td>' +
          '<td>' + escapeHtml(bill.category || '') + '</td>' +
          '<td>' + escapeHtml(paidLabel) + '</td>' +
          '</tr>';
      })
      .join('');

    const breakdownCard =
      '<section class="card planner-breakdown-card">' +
      '<div class="card-header"><h3 class="card-title">Calculation Breakdown</h3></div>' +
      '<div class="planner-breakdown-grid">' +
      '<div><strong>Selected Budget Period:</strong> ' + escapeHtml(periodLabel) + '</div>' +
      '<div><strong>Recurring bills counted:</strong> ' + escapeHtml(String(billsDue.length)) + '</div>' +
      '<div><strong>Recurring bills total:</strong> ' + escapeHtml(formatCurrencyValue(recurringBillsDue)) + '</div>' +
      '<div><strong>Paid bills counted:</strong> ' + escapeHtml(String(summary.recurringBills.paidCount)) + '</div>' +
      '<div><strong>Paid bills total:</strong> ' + escapeHtml(formatCurrencyValue(alreadyPaid)) + '</div>' +
      '<div><strong>Expense budget:</strong> ' + escapeHtml(formatCurrencyValue(expenseBudgetTotal)) + '</div>' +
      '</div>' +
      '<div class="inline-actions"><button class="button button-secondary button-sm" data-action="planner-toggle-counted-bills">Show counted bills</button></div>' +
      '<div id="planner-counted-bills" hidden>' +
      (billsDue.length
        ? '<div class="table-wrap"><table class="table planner-table"><thead><tr><th>Name</th><th>Due date</th><th>Amount</th><th>Category</th><th>Paid status</th></tr></thead><tbody>' + breakdownRows + '</tbody></table></div>'
        : '<p class="empty-state">No recurring bills counted for this period.</p>') +
      '</div>' +
      '</section>';

    const incomeCard = renderSectionCard(
      'Income',
      'Manage detected and manual income for this budget period',
      '<div class="income-source-card">' +
      detectedPayrollLine +
      detectedPayrollWarningLine +
      manualOverrideLine +
      '<p><strong>Final Budget Income used:</strong> ' + escapeHtml(formatCurrencyValue(budgetIncome)) + '</p>' +
      '<p><strong>Source label:</strong> ' + escapeHtml(sourceLabel) + '</p>' +
      incomeBreakdownDetails +
      '<div class="form-grid">' +
      '<label class="form-field"><span>Manual income override</span><input id="planner-income-input" type="number" step="0.01" value="' + escapeHtml(String(hasManualIncome ? manualIncome : budgetIncome || '')) + '" placeholder="Enter income"></label>' +
      '</div>' +
      '<div class="inline-actions">' +
      '<button class="button button-primary" data-action="planner-save-income">Save manual income</button>' +
      '<button class="button button-secondary" data-action="planner-use-detected-income" ' + (detectedPayroll.detected ? '' : 'disabled') + '>Use detected payroll income</button>' +
      '<button class="button button-secondary" data-action="planner-clear-income" ' + (hasManualIncome ? '' : 'disabled') + '>Clear manual override</button>' +
      '<button class="button button-secondary" data-action="planner-run-auto-detect">Re-run auto-paid detection</button>' +
      '</div>' +
      '<div id="planner-income-message" class="settings-message"></div>' +
      '</div>',
      'income-source-card'
    );

    const splitInputRowsHtml = BUDGET_SPLIT_GROUPS.map((group) => (
      '<tr>' +
      '<td>' + escapeHtml(formatBudgetSplitGroupLabel(group)) + '</td>' +
      '<td><input id="' + splitInputId(group) + '" class="planner-alloc-input" type="number" step="0.01" value="' + escapeHtml(String(splitSettings[group] || 0)) + '"></td>' +
      '</tr>'
    )).join('');

    const splitResultRowsHtml = splitEngine.rows.map((row) => (
      '<tr>' +
      '<td>' + escapeHtml(formatBudgetSplitGroupLabel(row.group)) + '</td>' +
      '<td>' + escapeHtml(formatCurrencyValue(row.allotted)) + '</td>' +
      '<td>' + escapeHtml(formatCurrencyValue(row.actual)) + '</td>' +
      '<td>' + escapeHtml(formatCurrencyValue(row.remaining)) + '</td>' +
      '</tr>'
    )).join('');

    const splitValidationClass = splitEngine.validation.isValid ? 'settings-message success' : 'settings-message error';
    const splitValidationMessage = splitEngine.validation.isValid
      ? 'Budget percentages are valid (100.00%).'
      : splitEngine.validation.message;

    const allocationCard = renderSectionCard(
      'Budget Split Engine',
      'Budget split by recurring bills due in the selected pay period.',
      '<div class="planner-allocation-grid">' +
      '<article class="card stat-card compact"><p class="label">Budget Income</p><h3 class="value">' + escapeHtml(formatCurrencyValue(splitEngine.income || 0)) + '</h3><p class="hint">Current pay-period budget income</p></article>' +
      '<article class="card stat-card compact"><p class="label">Total Actual</p><h3 class="value">' + escapeHtml(formatCurrencyValue(splitEngine.totals.actual || 0)) + '</h3><p class="hint">Needs + Wants + Debt/Savings actual</p></article>' +
      '<article class="card stat-card compact"><p class="label">Total Remaining Budget</p><h3 class="value">' + escapeHtml(formatCurrencyValue(splitEngine.totals.remaining || 0)) + '</h3><p class="hint">Budget income - total actual</p></article>' +
      '<article class="card stat-card compact"><p class="label">Split Total</p><h3 class="value">' + escapeHtml(splitEngine.validation.percentTotal.toFixed(2) + '%') + '</h3><p class="hint">Must equal 100%</p></article>' +
      '</div>' +
      '<p class="' + splitValidationClass + '">' + escapeHtml(splitValidationMessage) + '</p>' +
      '<div class="planner-allocation-layout">' +
      '<div class="table-wrap"><table class="table planner-table"><thead><tr><th>Group</th><th>Percentage</th></tr></thead><tbody>' + splitInputRowsHtml + '</tbody></table></div>' +
      '<div class="table-wrap"><table class="table planner-table"><thead><tr><th>Group</th><th>Allotted Budget</th><th>Actual</th><th>Remaining Budget</th></tr></thead><tbody>' + splitResultRowsHtml + '<tr class="planner-total-row"><td>Total</td><td>' + escapeHtml(formatCurrencyValue(splitEngine.totals.allotted || 0)) + '</td><td>' + escapeHtml(formatCurrencyValue(splitEngine.totals.actual || 0)) + '</td><td>' + escapeHtml(formatCurrencyValue(splitEngine.totals.remaining || 0)) + '</td></tr></tbody></table></div>' +
      '</div>' +
      '<div class="inline-actions">' +
      '<button class="button button-primary" data-action="planner-save-budget-split" ' + (splitEngine.validation.isValid ? '' : 'disabled') + '>Save Budget Split</button>' +
      '</div>' +
      '<div id="planner-allocation-message" class="settings-message"></div>',
      'planner-allocation-card'
    );

    const bucketRows = Array.isArray(bucketsPayload?.rows) ? bucketsPayload.rows : [];
    const bucketGroups = {
      Needs: [],
      Wants: [],
      'Debts/Savings': [],
    };

    bucketRows.forEach((row) => {
      const normalized = normalizeBudgetGroup(row.budget_group) || 'Needs';
      if (!bucketGroups[normalized]) bucketGroups[normalized] = [];
      bucketGroups[normalized].push(row);
    });

    const buildBucketTable = (group) => {
      const rows = bucketGroups[group] || [];
      const splitRow = splitEngine.rows.find((row) => row.group === group) || { remaining: 0 };
      const groupRemaining = Number(splitRow.remaining || 0);
      const groupBucketTotal = rows.reduce((sum, row) => sum + Number(row.planned_amount || 0), 0);
      const groupUnassigned = groupRemaining - groupBucketTotal;
      const overBy = Math.abs(Math.min(0, groupUnassigned));

      const warningHtml = groupUnassigned < 0
        ? '<p class="settings-message error">' + escapeHtml(formatBudgetSplitGroupLabel(group)) + ' buckets are over budget by ' + escapeHtml(formatCurrencyValue(overBy)) + '.</p>'
        : '<p class="settings-message success">' + escapeHtml(formatBudgetSplitGroupLabel(group)) + ' has ' + escapeHtml(formatCurrencyValue(groupUnassigned)) + ' left to assign.</p>';

      const bodyRows = rows.length
        ? rows.map((bucket) => {
          const planned = Number(bucket.planned_amount || 0);
          const spent = Number(bucket.spent_amount || 0);
          const remaining = Number(bucket.remaining_amount || (planned - spent));
          const progressRatio = planned > 0 ? Math.min(1, spent / planned) : 0;
          const progressPercent = Math.round(progressRatio * 100);
          return '<tr>' +
            '<td>' + escapeHtml(bucket.name || '') + '</td>' +
            '<td>' + escapeHtml(formatBudgetSplitGroupLabel(group)) + '</td>' +
            '<td>' + escapeHtml(formatCurrencyValue(planned)) + '</td>' +
            '<td>' + escapeHtml(formatCurrencyValue(spent)) + '</td>' +
            '<td>' + escapeHtml(formatCurrencyValue(remaining)) + '</td>' +
            '<td><div class="planner-progress-track"><div class="planner-progress-fill" style="width:' + Math.min(100, Math.max(0, progressPercent)) + '%"></div></div><span class="muted-note">' + escapeHtml(String(progressPercent)) + '%</span></td>' +
            '<td class="planner-bucket-actions">' +
            '<button class="button button-secondary button-sm" data-action="planner-edit-bucket" data-bucket-id="' + escapeHtml(bucket.id) + '">Edit</button>' +
            '<button class="button button-secondary button-sm" data-action="planner-delete-bucket" data-bucket-id="' + escapeHtml(bucket.id) + '">Delete</button>' +
            '<button class="button button-secondary button-sm" data-action="planner-assign-transaction" data-bucket-id="' + escapeHtml(bucket.id) + '">Assign Transaction</button>' +
            '</td>' +
            '</tr>';
        }).join('')
        : '<tr><td colspan="7"><span class="muted-note">No buckets created for this group.</span></td></tr>';

      return (
        '<section class="card planner-bucket-group-card">' +
        '<div class="card-header"><h4 class="card-title">' + escapeHtml(formatBudgetSplitGroupLabel(group) + ' Buckets') + '</h4></div>' +
        '<div class="action-row"><span>Group Remaining Budget</span><strong>' + escapeHtml(formatCurrencyValue(groupRemaining)) + '</strong></div>' +
        '<div class="action-row"><span>Group Bucket Total</span><strong>' + escapeHtml(formatCurrencyValue(groupBucketTotal)) + '</strong></div>' +
        '<div class="action-row"><span>Group Unassigned</span><strong>' + escapeHtml(formatCurrencyValue(groupUnassigned)) + '</strong></div>' +
        warningHtml +
        '<div class="inline-actions"><button class="button button-primary button-sm" data-action="planner-add-bucket" data-group="' + escapeHtml(group) + '">Add Bucket</button></div>' +
        '<div class="table-wrap"><table class="table planner-table"><thead><tr><th>Bucket Name</th><th>Budget Group</th><th>Planned</th><th>Spent</th><th>Remaining</th><th>Progress</th><th>Actions</th></tr></thead><tbody>' + bodyRows + '</tbody></table></div>' +
        '</section>'
      );
    };

    const unassignedSpending = bucketsPayload?.unassignedSpending || { count: 0, total: 0, transactions: [] };
    const unassignedPreview = (unassignedSpending.transactions || []).slice(0, 5)
      .map((row) => '<div class="action-row"><span>' + escapeHtml((row.date || '') + ' - ' + (row.name || 'Transaction')) + '</span><strong>' + escapeHtml(formatCurrencyValue(row.amount || 0)) + '</strong></div>')
      .join('');

    const envelopeBucketsCard = renderSectionCard(
      'Envelope Buckets',
      'Assign remaining group budgets to pay-period buckets.',
      '<div class="planner-allocation-grid">' +
      '<article class="card stat-card compact"><p class="label">Unassigned Spending</p><h3 class="value">' + escapeHtml(formatCurrencyValue(unassignedSpending.total || 0)) + '</h3><p class="hint">Transactions without a bucket: ' + escapeHtml(String(unassignedSpending.count || 0)) + '</p></article>' +
      '</div>' +
      '<div class="planner-bucket-group-grid">' +
      buildBucketTable('Needs') +
      buildBucketTable('Wants') +
      buildBucketTable('Debts/Savings') +
      '</div>' +
      (unassignedPreview
        ? '<details class="safe-money-disclosure"><summary>Unassigned Spending Preview</summary><div class="safe-money-breakdown">' + unassignedPreview + '</div></details>'
        : '<p class="muted-note">No unassigned spending for this pay period.</p>') +
      '<div id="planner-buckets-message" class="settings-message"></div>',
      'planner-envelope-buckets-card'
    );

    const billsTable = billsDue.length
      ? '<div class="table-wrap"><table class="table planner-table"><thead><tr><th>Paid</th><th>Name</th><th>Category</th><th>Due Date</th><th>Amount</th><th>Autopay</th><th>Match Status</th><th>Paid From</th></tr></thead><tbody>' +
        billsDue.map((bill) => {
          const status = bill.status;
          const checked = status && status.paid;
          const matchStatus = getMatchStatusLabel(status, bill);
          return '<tr>' +
            '<td><input type="checkbox" class="planner-paid-toggle" data-bill-id="' + escapeHtml(bill.id) + '" ' + (checked ? 'checked' : '') + '></td>' +
            '<td>' + escapeHtml(bill.name) + '</td>' +
            '<td>' + escapeHtml(bill.category) + '</td>' +
            '<td>' + escapeHtml(bill.dueDateStr) + '</td>' +
            '<td class="amount-column">' + escapeHtml(formatCurrencyValue(bill.amount)) + '</td>' +
            '<td>' + (bill.autopay ? '<span class="badge-autopay">Yes</span>' : '-') + '</td>' +
            '<td>' + renderStatusBadge(matchStatus) + renderBillMatchDetails(status) + '</td>' +
            '<td>' + escapeHtml(bill.paidFrom || '') + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>'
      : '<p class="empty-state">No recurring bills are due in this budget period.</p>';

    const billsCard = renderSectionCard(
      'Recurring Bills Due',
      'Bills due in the selected budget period',
      billsTable
    );

    const headerHtml =
      '<header class="page-header">' +
      '<div class="page-header-main">' +
      '<h2 class="page-title">Paycheck Planner</h2>' +
      '<p class="page-description">Plan this paycheck before money leaves the account.</p>' +
      '</div>' +
      '<div class="page-header-right"><span class="status-badge">Budget Period: ' + escapeHtml(periodLabel) + '</span></div>' +
      '</header>';

    pageWrap.innerHTML =
      headerHtml +
      '<div class="planner-summary-grid-wrap">' + summaryCards + '</div>' +
      allocationCard +
      envelopeBucketsCard +
      safeMoneySection +
      breakdownCard +
      '<section class="planner-grid-columns">' +
      incomeCard +
      billsCard +
      '</section>';

    container.appendChild(pageWrap);

    document.getElementById('planner-income-input')?.addEventListener('focus', (event) => event.target.select());

    document.querySelector('[data-action="planner-save-income"]')?.addEventListener('click', async () => {
      const messageEl = document.getElementById('planner-income-message');
      try {
        const input = document.getElementById('planner-income-input');
        const income = parseFloat(input.value) || 0;
        await saveBudgetIncome(period.id, income);
        window.dispatchEvent(new CustomEvent('budget:income-updated', { detail: { periodId: period.id } }));
        if (messageEl) {
          messageEl.className = 'settings-message success';
          messageEl.textContent = 'Manual income override saved.';
        }
        await renderPaycheckPlanner(container, period, periodLabel);
      } catch (err) {
        console.error('Failed to save planner income:', err);
        if (messageEl) {
          messageEl.className = 'settings-message error';
          messageEl.textContent = err.message.includes('Failed to fetch')
            ? 'Backend not reachable through the local API proxy.'
            : err.message;
        }
      }
    });

    document.querySelector('[data-action="planner-use-detected-income"]')?.addEventListener('click', async () => {
      const messageEl = document.getElementById('planner-income-message');
      if (!detectedPayroll.detected) return;
      try {
        await saveAutoDetectedIncome(period.id, Number(detectedPayroll.amount || 0));
        await clearBudgetIncome(period.id);
        window.dispatchEvent(new CustomEvent('budget:income-updated', { detail: { periodId: period.id } }));
        if (messageEl) {
          messageEl.className = 'settings-message success';
          messageEl.textContent = 'Detected payroll saved and manual override cleared.';
        }
        await renderPaycheckPlanner(container, period, periodLabel);
      } catch (err) {
        console.error('Failed to use detected income:', err);
        if (messageEl) {
          messageEl.className = 'settings-message error';
          messageEl.textContent = err.message;
        }
      }
    });

    document.querySelector('[data-action="planner-clear-income"]')?.addEventListener('click', async () => {
      const messageEl = document.getElementById('planner-income-message');
      try {
        await clearBudgetIncome(period.id);
        window.dispatchEvent(new CustomEvent('budget:income-updated', { detail: { periodId: period.id } }));
        if (messageEl) {
          messageEl.className = 'settings-message success';
          messageEl.textContent = 'Manual income override cleared.';
        }
        await renderPaycheckPlanner(container, period, periodLabel);
      } catch (err) {
        console.error('Failed to clear planner income:', err);
        if (messageEl) {
          messageEl.className = 'settings-message error';
          messageEl.textContent = err.message;
        }
      }
    });

    document.querySelector('[data-action="planner-run-auto-detect"]')?.addEventListener('click', async () => {
      const messageEl = document.getElementById('planner-income-message');
      const button = document.querySelector('[data-action="planner-run-auto-detect"]');
      try {
        button.disabled = true;
        button.textContent = 'Detecting...';
        const result = await fetchAutoDetectSummary(period);
        if (result.payroll?.detected) {
          await saveAutoDetectedIncome(period.id, result.payroll.amount);
          if (!hasManualIncome) {
            await clearBudgetIncome(period.id);
          }
          window.dispatchEvent(new CustomEvent('budget:recurring-bills-updated', { detail: { periodId: period.id, summary: result } }));
          window.dispatchEvent(new CustomEvent('budget:income-updated', { detail: { periodId: period.id, summary: result } }));
          if (messageEl) {
            messageEl.className = 'settings-message success';
            messageEl.textContent = 'Auto-detect complete: ' + result.bills.matched + ' auto-paid, ' + result.bills.possible + ' possible matches.';
          }
        } else if (messageEl) {
          messageEl.className = 'settings-message error';
          messageEl.textContent = 'No Cisco payroll found for this budget period.';
        }
        await renderPaycheckPlanner(container, period, periodLabel);
      } catch (err) {
        console.error('Failed to run auto-detect from planner:', err);
        if (messageEl) {
          messageEl.className = 'settings-message error';
          messageEl.textContent = err.message.includes('Failed to fetch')
            ? 'Backend not reachable through the local API proxy.'
            : err.message;
        }
      } finally {
        button.disabled = false;
        button.textContent = 'Re-run auto-paid detection';
      }
    });

    document.querySelector('[data-action="planner-save-budget-split"]')?.addEventListener('click', async () => {
      const messageEl = document.getElementById('planner-allocation-message');
      const nextSplit = {};
      BUDGET_SPLIT_GROUPS.forEach((group) => {
        const input = document.getElementById(splitInputId(group));
        nextSplit[group] = Number.parseFloat(input?.value || '0') || 0;
      });

      const nextTotal = BUDGET_SPLIT_GROUPS.reduce((sum, group) => sum + Number(nextSplit[group] || 0), 0);
      const isValid = Math.abs(nextTotal - 100) < 0.0001;
      try {
        if (!isValid) {
          throw new Error('Percentages must equal 100% before saving.');
        }
        await saveBudgetSplitSettings(nextSplit);
        window.dispatchEvent(new CustomEvent('budget:split-settings-updated', { detail: { periodId: period.id } }));
        if (messageEl) {
          messageEl.className = 'settings-message success';
          messageEl.textContent = 'Budget split settings saved.';
        }
        await renderPaycheckPlanner(container, period, periodLabel);
      } catch (err) {
        if (messageEl) {
          messageEl.className = 'settings-message error';
          messageEl.textContent = err.message.includes('Failed to fetch')
            ? 'Backend not reachable through the local API proxy.'
            : err.message;
        }
      }
    });

    const saveSplitButton = document.querySelector('[data-action="planner-save-budget-split"]');
    const splitInputs = BUDGET_SPLIT_GROUPS
      .map((group) => document.getElementById(splitInputId(group)))
      .filter(Boolean);

    const updateSplitValidationUi = () => {
      const total = BUDGET_SPLIT_GROUPS.reduce((sum, group) => {
        const input = document.getElementById(splitInputId(group));
        return sum + (Number.parseFloat(input?.value || '0') || 0);
      }, 0);
      const valid = Math.abs(total - 100) < 0.0001;
      if (saveSplitButton) saveSplitButton.disabled = !valid;
      const messageEl = document.getElementById('planner-allocation-message');
      if (!messageEl) return;
      messageEl.className = valid ? 'settings-message success' : 'settings-message error';
      messageEl.textContent = valid
        ? 'Percent total is 100%. Save is enabled.'
        : 'Percent total is ' + total.toFixed(2) + '%. It must equal 100%.';
    };

    splitInputs.forEach((input) => {
      input.addEventListener('input', updateSplitValidationUi);
    });
    updateSplitValidationUi();

    const bucketMessageEl = document.getElementById('planner-buckets-message');
    const setBucketMessage = (isError, text) => {
      if (!bucketMessageEl) return;
      bucketMessageEl.className = isError ? 'settings-message error' : 'settings-message success';
      bucketMessageEl.textContent = text;
    };

    const getGroupRemaining = (group) => {
      const splitRow = splitEngine.rows.find((row) => row.group === group);
      return Number(splitRow?.remaining || 0);
    };

    const getGroupPlannedTotalExcluding = (group, excludeBucketId = null) => {
      return bucketRows.reduce((sum, row) => {
        const rowGroup = normalizeBudgetGroup(row.budget_group);
        if (rowGroup !== group) return sum;
        if (excludeBucketId && row.id === excludeBucketId) return sum;
        return sum + Number(row.planned_amount || 0);
      }, 0);
    };

    const promptForBucketData = ({ mode, initial = {}, forcedGroup = null }) => {
      const defaultName = initial.name || '';
      const defaultGroup = forcedGroup || normalizeBudgetGroup(initial.budget_group) || 'Needs';
      const defaultPlanned = String(Number(initial.planned_amount || 0));
      const defaultNotes = initial.notes || '';

      const name = window.prompt('Bucket name', defaultName);
      if (name === null) return null;

      const groupPrompt = window.prompt('Bucket group (Needs, Wants, Debt/Savings)', formatBudgetSplitGroupLabel(defaultGroup));
      if (groupPrompt === null) return null;
      const group = normalizeBudgetGroup(groupPrompt);
      if (!group) {
        throw new Error('Bucket group must be Needs, Wants, or Debt/Savings.');
      }

      const plannedInput = window.prompt('Planned amount for this pay period', defaultPlanned);
      if (plannedInput === null) return null;
      const planned = Number(plannedInput);
      if (!Number.isFinite(planned) || planned < 0) {
        throw new Error('Planned amount must be a non-negative number.');
      }

      const notes = window.prompt('Notes (optional)', defaultNotes);
      if (notes === null) return null;

      return {
        mode,
        name: String(name || '').trim(),
        budgetGroup: group,
        plannedAmount: planned,
        notes,
      };
    };

    document.querySelectorAll('[data-action="planner-add-bucket"]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const group = normalizeBudgetGroup(button.getAttribute('data-group'));
          const form = promptForBucketData({ mode: 'create', forcedGroup: group });
          if (!form) return;
          if (!form.name) throw new Error('Bucket name is required.');

          const groupRemaining = getGroupRemaining(form.budgetGroup);
          const existingGroupPlanned = getGroupPlannedTotalExcluding(form.budgetGroup);
          const availableToAssign = groupRemaining - existingGroupPlanned;
          if (form.plannedAmount > availableToAssign + 0.0001) {
            throw new Error(formatBudgetSplitGroupLabel(form.budgetGroup) + ' buckets exceed remaining budget by ' + formatCurrencyValue(form.plannedAmount - availableToAssign) + '.');
          }

          await createBudgetBucket({
            name: form.name,
            budgetGroup: form.budgetGroup,
            payPeriodStart: period.startDate,
            payPeriodEnd: period.exclusiveEndDate,
            plannedAmount: form.plannedAmount,
            notes: form.notes,
          });
          setBucketMessage(false, 'Bucket created.');
          await renderPaycheckPlanner(container, period, periodLabel);
        } catch (err) {
          setBucketMessage(true, err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message);
        }
      });
    });

    document.querySelectorAll('[data-action="planner-edit-bucket"]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const bucketId = button.getAttribute('data-bucket-id');
          const existing = bucketRows.find((row) => row.id === bucketId);
          if (!existing) throw new Error('Bucket not found.');
          const form = promptForBucketData({ mode: 'edit', initial: existing });
          if (!form) return;
          if (!form.name) throw new Error('Bucket name is required.');

          const groupRemaining = getGroupRemaining(form.budgetGroup);
          const existingGroupPlanned = getGroupPlannedTotalExcluding(form.budgetGroup, bucketId);
          const availableToAssign = groupRemaining - existingGroupPlanned;
          if (form.plannedAmount > availableToAssign + 0.0001) {
            throw new Error(formatBudgetSplitGroupLabel(form.budgetGroup) + ' buckets exceed remaining budget by ' + formatCurrencyValue(form.plannedAmount - availableToAssign) + '.');
          }

          await updateBudgetBucket(bucketId, {
            name: form.name,
            budgetGroup: form.budgetGroup,
            plannedAmount: form.plannedAmount,
            notes: form.notes,
          });
          setBucketMessage(false, 'Bucket updated.');
          await renderPaycheckPlanner(container, period, periodLabel);
        } catch (err) {
          setBucketMessage(true, err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message);
        }
      });
    });

    document.querySelectorAll('[data-action="planner-delete-bucket"]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const bucketId = button.getAttribute('data-bucket-id');
          const existing = bucketRows.find((row) => row.id === bucketId);
          if (!existing) throw new Error('Bucket not found.');
          const confirmed = window.confirm('Delete bucket "' + (existing.name || 'Unnamed bucket') + '"? Assigned transactions will become unassigned.');
          if (!confirmed) return;
          await deleteBudgetBucket(bucketId);
          setBucketMessage(false, 'Bucket deleted. Assigned transactions are now unassigned.');
          await renderPaycheckPlanner(container, period, periodLabel);
        } catch (err) {
          setBucketMessage(true, err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message);
        }
      });
    });

    document.querySelectorAll('[data-action="planner-assign-transaction"]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const bucketId = button.getAttribute('data-bucket-id');
          const existing = bucketRows.find((row) => row.id === bucketId);
          if (!existing) throw new Error('Bucket not found.');
          const candidates = Array.isArray(unassignedSpending.transactions) ? unassignedSpending.transactions : [];
          if (!candidates.length) {
            throw new Error('No unassigned transactions are available in this pay period.');
          }

          const optionsText = candidates
            .slice(0, 12)
            .map((tx) => tx.id + ' | ' + (tx.date || '') + ' | ' + (tx.name || 'Transaction') + ' | ' + formatCurrencyValue(tx.amount || 0))
            .join('\n');

          const chosenId = window.prompt('Enter transaction ID to assign to "' + existing.name + '":\n\n' + optionsText, candidates[0].id);
          if (!chosenId) return;

          await assignTransactionToBucket(bucketId, chosenId.trim());
          setBucketMessage(false, 'Transaction assigned to bucket.');
          await renderPaycheckPlanner(container, period, periodLabel);
        } catch (err) {
          setBucketMessage(true, err.message.includes('Failed to fetch') ? 'Backend not reachable through the local API proxy.' : err.message);
        }
      });
    });

    document.querySelectorAll('.planner-paid-toggle').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        try {
          const billId = checkbox.getAttribute('data-bill-id');
          const paid = checkbox.checked;
          const paidDate = paid ? new Date().toISOString().slice(0, 10) : null;
          await saveBillStatus(period.id, billId, paid, paidDate);
          window.dispatchEvent(new CustomEvent('budget:recurring-bills-updated', { detail: { periodId: period.id } }));
          await renderPaycheckPlanner(container, period, periodLabel);
        } catch (err) {
          console.error('Failed to update planner bill status:', err);
          checkbox.checked = !checkbox.checked;
        }
      });
    });

    document.querySelector('[data-action="planner-toggle-counted-bills"]')?.addEventListener('click', (event) => {
      const wrap = document.getElementById('planner-counted-bills');
      if (!wrap) return;
      const isHidden = wrap.hasAttribute('hidden');
      if (isHidden) {
        wrap.removeAttribute('hidden');
        event.currentTarget.textContent = 'Hide counted bills';
      } else {
        wrap.setAttribute('hidden', 'hidden');
        event.currentTarget.textContent = 'Show counted bills';
      }
    });
  } catch (err) {
    console.error('Error rendering paycheck planner:', err);
    container.innerHTML =
      '<section class="card"><div class="error-card">' +
      (String(err.message || '').includes('Failed to fetch')
        ? 'Backend not reachable through the local API proxy.'
        : 'Paycheck Planner could not be loaded.') +
      '</div></section>';
  }
}
