import {
  createCashFlowAdjustment,
  updateCashFlowAdjustment,
  deleteCashFlowAdjustment,
} from '../api/cashFlowApi.js';
import { loadCashFlowForecast } from '../utils/cashFlowForecast.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatCurrency(value) {
  const amount = Number(value || 0);
  return (amount < 0 ? '-' : '') + '$' + Math.abs(amount).toFixed(2);
}

function formatDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '-';
  const d = new Date(text + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return text;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderSummaryCard(label, value, tone = '') {
  return (
    '<article class="card command-card compact">' +
    '<div class="metric-card">' +
    '<div class="metric-label">' + escapeHtml(label) + '</div>' +
    '<div class="metric-value ' + (tone ? 'text-' + tone : '') + '">' + escapeHtml(formatCurrency(value)) + '</div>' +
    '</div>' +
    '</article>'
  );
}

function renderForecastTable(groupedRows) {
  if (!groupedRows.length) {
    return '<p class="empty-state">No forecast items for this period.</p>';
  }

  return (
    '<div class="table-wrap">' +
    '<table class="table cash-flow-table">' +
    '<thead><tr><th>Date</th><th>Item</th><th>Type</th><th>Category</th><th>Account</th><th>Amount</th><th>Projected Balance</th><th>Status</th></tr></thead>' +
    '<tbody>' +
    groupedRows.map((entry) => {
      if (entry.type === 'group') {
        return '<tr class="cash-flow-group-row"><td colspan="8">' + escapeHtml(formatDate(entry.date)) + '</td></tr>';
      }
      const row = entry.row;
      return (
        '<tr>' +
        '<td>' + escapeHtml(formatDate(row.date)) + '</td>' +
        '<td>' + escapeHtml(row.item) + '</td>' +
        '<td>' + escapeHtml(row.type) + '</td>' +
        '<td>' + escapeHtml(row.category || '-') + '</td>' +
        '<td>' + escapeHtml(row.account || '-') + '</td>' +
        '<td class="' + (Number(row.amount || 0) < 0 ? 'text-danger' : 'text-good') + '">' + escapeHtml(formatCurrency(row.amount)) + '</td>' +
        '<td class="' + (Number(row.projectedBalance || 0) < 0 ? 'text-danger' : 'text-good') + '">' + escapeHtml(formatCurrency(row.projectedBalance)) + '</td>' +
        '<td><span class="badge-neutral">' + escapeHtml(row.status || 'Expected') + '</span></td>' +
        '</tr>'
      );
    }).join('') +
    '</tbody></table></div>'
  );
}

function renderAdjustmentsSection(adjustments, period, messageText = '', messageType = 'success') {
  const rows = (adjustments || []).map((adj) => (
    '<tr>' +
    '<td>' + escapeHtml(formatDate(adj.date)) + '</td>' +
    '<td>' + escapeHtml(adj.label || '') + '</td>' +
    '<td>' + escapeHtml(adj.type || 'adjustment') + '</td>' +
    '<td>' + escapeHtml(formatCurrency(adj.amount || 0)) + '</td>' +
    '<td>' + escapeHtml(adj.account || '-') + '</td>' +
    '<td>' + escapeHtml(adj.notes || '-') + '</td>' +
    '<td class="inline-actions">' +
    '<button class="button button-secondary button-sm" data-action="forecast-edit-adjustment" data-id="' + escapeHtml(adj.id) + '">Edit</button>' +
    '<button class="button button-danger button-sm" data-action="forecast-delete-adjustment" data-id="' + escapeHtml(adj.id) + '">Delete</button>' +
    '</td>' +
    '</tr>'
  )).join('') || '<tr><td colspan="7">No manual adjustments yet.</td></tr>';

  return (
    '<section class="card">' +
    '<div class="card-header"><h3 class="card-title">Manual Forecast Adjustments</h3><p class="card-description">Add one-off adjustments to this period forecast.</p></div>' +
    '<div class="form-grid cash-flow-adjustment-grid">' +
    '<label class="form-field"><span>Date</span><input id="forecast-adjustment-date" type="date" value="' + escapeHtml(period.startDate || '') + '"></label>' +
    '<label class="form-field"><span>Label</span><input id="forecast-adjustment-label" type="text" placeholder="Adjustment label"></label>' +
    '<label class="form-field"><span>Type</span><input id="forecast-adjustment-type" type="text" value="adjustment"></label>' +
    '<label class="form-field"><span>Amount</span><input id="forecast-adjustment-amount" type="number" step="0.01" value="0"></label>' +
    '<label class="form-field"><span>Account</span><input id="forecast-adjustment-account" type="text" placeholder="Account"></label>' +
    '<label class="form-field"><span>Notes</span><input id="forecast-adjustment-notes" type="text" placeholder="Notes"></label>' +
    '</div>' +
    '<div class="settings-actions"><button class="button button-primary" data-action="forecast-add-adjustment">Add Adjustment</button></div>' +
    '<div id="forecast-adjustment-message" class="settings-message ' + (messageText ? escapeHtml(messageType) : '') + '">' + (messageText ? escapeHtml(messageText) : '') + '</div>' +
    '<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Label</th><th>Type</th><th>Amount</th><th>Account</th><th>Notes</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '</section>'
  );
}

export async function renderCashFlowForecast(container, period, periodLabel, options = {}) {
  if (!period) {
    container.innerHTML = '<section class="card"><p class="empty-state">Select a budget period.</p></section>';
    return;
  }

  container.innerHTML = '<section class="card"><p class="empty-state">Loading cash flow forecast...</p></section>';

  try {
    const forecast = await loadCashFlowForecast(period);
    const summary = forecast.summary;

    container.innerHTML =
      '<div class="page-header"><div class="page-header-main"><h2 class="page-title">Cash Flow Forecast</h2><p class="page-description">Forecast for ' + escapeHtml(periodLabel || period.id) + '.</p></div></div>' +
      '<section class="dashboard-primary-grid">' +
      renderSummaryCard('Starting Cash', summary.startingCash) +
      renderSummaryCard('Expected Income', summary.expectedIncome, 'good') +
      renderSummaryCard('Bills Due', -Math.abs(summary.billsDue), 'danger') +
      renderSummaryCard('Planned Transfers', -Math.abs(summary.plannedTransfers), 'danger') +
      renderSummaryCard('Confirmed Transfers', -Math.abs(summary.confirmedTransfers), 'danger') +
      renderSummaryCard('Expected Spending', -Math.abs(summary.expectedSpending), 'danger') +
      renderSummaryCard('Projected Ending Cash', summary.projectedEndingCash, summary.projectedEndingCash < 0 ? 'danger' : 'good') +
      renderSummaryCard('Lowest Projected Cash Balance', summary.lowestProjectedCashBalance, summary.lowestProjectedCashBalance < 0 ? 'danger' : 'warning') +
      '</section>' +
      '<section class="card command-card compact">' +
      '<div class="card-header"><h3 class="card-title">Forecast Snapshot</h3><p class="card-description">Primary account: ' + escapeHtml(forecast.primaryAccount ? (forecast.primaryAccount.institutionName || '') + ' ' + (forecast.primaryAccount.name || '') : 'Unavailable') + '</p></div>' +
      '<div class="action-list">' +
      '<div class="action-row"><span>Next Cash Risk Date</span><strong class="' + (summary.nextCashRiskDate ? 'text-danger' : 'text-good') + '">' + escapeHtml(summary.nextCashRiskDate ? formatDate(summary.nextCashRiskDate) : 'None') + '</strong></div>' +
      '</div>' +
      '</section>' +
      (forecast.warnings.length
        ? '<section class="card">' +
          '<div class="card-header"><h3 class="card-title">Warnings</h3></div>' +
          '<div class="action-list">' + forecast.warnings.map((warning) => '<div class="dashboard-alert warning">' + escapeHtml(warning) + '</div>').join('') + '</div>' +
          '</section>'
        : '') +
      renderAdjustmentsSection(forecast.adjustments, period) +
      '<section class="card">' +
      '<div class="card-header"><h3 class="card-title">Pay-Period Forecast Table</h3></div>' +
      renderForecastTable(forecast.groupedRows) +
      '</section>';

    const setAdjustmentMessage = (text, type = 'success') => {
      const el = container.querySelector('#forecast-adjustment-message');
      if (!el) return;
      el.className = 'settings-message ' + type;
      el.textContent = text;
    };

    container.querySelector('[data-action="forecast-add-adjustment"]')?.addEventListener('click', async () => {
      const date = String(container.querySelector('#forecast-adjustment-date')?.value || '').trim();
      const label = String(container.querySelector('#forecast-adjustment-label')?.value || '').trim();
      const type = String(container.querySelector('#forecast-adjustment-type')?.value || 'adjustment').trim();
      const amount = Number(container.querySelector('#forecast-adjustment-amount')?.value || 0);
      const account = String(container.querySelector('#forecast-adjustment-account')?.value || '').trim();
      const notes = String(container.querySelector('#forecast-adjustment-notes')?.value || '').trim();

      if (!date || !label) {
        setAdjustmentMessage('Date and label are required.', 'error');
        return;
      }

      try {
        await createCashFlowAdjustment({
          budgetPeriodId: period.id,
          date,
          label,
          type,
          amount,
          account,
          notes,
        });
        await renderCashFlowForecast(container, period, periodLabel, options);
      } catch (err) {
        setAdjustmentMessage(err.message || 'Failed to add adjustment.', 'error');
      }
    });

    container.querySelectorAll('[data-action="forecast-edit-adjustment"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-id');
        const row = (forecast.adjustments || []).find((adj) => adj.id === id);
        if (!row) return;

        const nextDate = window.prompt('Adjustment date (YYYY-MM-DD)', row.date || '');
        if (nextDate === null) return;
        const nextLabel = window.prompt('Adjustment label', row.label || '');
        if (nextLabel === null) return;
        const nextType = window.prompt('Adjustment type', row.type || 'adjustment');
        if (nextType === null) return;
        const nextAmount = window.prompt('Adjustment amount', String(row.amount ?? 0));
        if (nextAmount === null) return;
        const nextAccount = window.prompt('Account', row.account || '');
        if (nextAccount === null) return;
        const nextNotes = window.prompt('Notes', row.notes || '');
        if (nextNotes === null) return;

        try {
          await updateCashFlowAdjustment(id, {
            date: nextDate,
            label: nextLabel,
            type: nextType,
            amount: Number(nextAmount || 0),
            account: nextAccount,
            notes: nextNotes,
          });
          await renderCashFlowForecast(container, period, periodLabel, options);
        } catch (err) {
          setAdjustmentMessage(err.message || 'Failed to update adjustment.', 'error');
        }
      });
    });

    container.querySelectorAll('[data-action="forecast-delete-adjustment"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-id');
        if (!id) return;
        if (!window.confirm('Delete this adjustment?')) return;

        try {
          await deleteCashFlowAdjustment(id);
          await renderCashFlowForecast(container, period, periodLabel, options);
        } catch (err) {
          setAdjustmentMessage(err.message || 'Failed to delete adjustment.', 'error');
        }
      });
    });
  } catch (err) {
    console.error('Cash Flow Forecast render failed:', err);
    container.innerHTML = '<section class="card"><div class="error-card">Cash Flow Forecast could not be loaded.<br><small>' + escapeHtml(err.message || 'Unknown error') + '</small></div></section>';
  }
}
