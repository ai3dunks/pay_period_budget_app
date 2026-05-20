import { loadCommandCenterSettings, isFeatureEnabled } from '../utils/commandCenter.js';

const BACKEND = '';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sectionTitle(sectionKey) {
  const map = {
    plaid: 'Plaid',
    transactions: 'Transactions',
    income: 'Income',
    recurringBills: 'Recurring Bills',
    transfers: 'Transfers',
    expenses: 'Expenses',
    rules: 'Rules',
    backups: 'Backups',
    database: 'Database',
  };
  return map[sectionKey] || sectionKey;
}

function statusLabel(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'good') return 'Good';
  if (key === 'warning') return 'Warning';
  if (key === 'error') return 'Error';
  return 'Needs Review';
}

function severityRank(severity) {
  if (severity === 'error') return 3;
  if (severity === 'warning') return 2;
  return 1;
}

function statusClass(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'error') return 'health-status-error';
  if (key === 'warning') return 'health-status-warning';
  if (key === 'good') return 'health-status-good';
  return 'health-status-needs-review';
}

function mapActionTargetToTab(target) {
  const value = String(target || '').trim();
  if (!value) return 'dashboard';
  if (value === 'recurringBills') return 'recurring-bills';
  return value;
}

async function readJsonResponseOrThrow(res) {
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const rawText = await res.text();

  if (!contentType.includes('application/json')) {
    const hint = rawText.trim().startsWith('<!DOCTYPE') || rawText.trim().startsWith('<html')
      ? 'Received HTML instead of JSON. Ensure backend is running and restarted with /api/data-health mounted.'
      : 'Unexpected response format from backend.';
    throw new Error(hint);
  }

  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error('Backend returned invalid JSON for data health report.');
  }
}

function renderSummary(report) {
  const generatedAt = report.generatedAt ? new Date(report.generatedAt).toLocaleString() : 'Unavailable';
  return (
    '<section class="card data-health-summary-card">' +
    '<div class="data-health-score-wrap">' +
    '<div class="data-health-score">' + escapeHtml(String(report.score ?? 0)) + '</div>' +
    '<div><div class="metric-label">Data Health Score</div><div class="metric-subtext">Generated ' + escapeHtml(generatedAt) + '</div></div>' +
    '</div>' +
    '<div class="data-health-summary-meta">' +
    '<span class="data-health-pill ' + statusClass(report.status) + '">' + escapeHtml(statusLabel(report.status)) + '</span>' +
    '<button type="button" class="button button-secondary button-sm" data-action="data-health-refresh">Run Data Health Check</button>' +
    '</div>' +
    '</section>'
  );
}

function renderSectionCards(sections = {}) {
  const keys = ['plaid', 'transactions', 'income', 'recurringBills', 'transfers', 'expenses', 'rules', 'backups', 'database'];
  return (
    '<section class="data-health-sections-grid">' +
    keys.map((key) => {
      const section = sections[key] || {};
      const entries = Object.entries(section)
        .filter(([name, value]) => name !== 'status' && (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'))
        .slice(0, 4)
        .map(([name, value]) => (
          '<div class="action-row"><span>' + escapeHtml(name) + '</span><strong>' + escapeHtml(String(value)) + '</strong></div>'
        )).join('');

      return (
        '<article class="card command-card compact">' +
        '<div class="card-header">' +
        '<h3 class="card-title">' + escapeHtml(sectionTitle(key)) + '</h3>' +
        '<span class="data-health-pill ' + statusClass(section.status) + '">' + escapeHtml(statusLabel(section.status)) + '</span>' +
        '</div>' +
        '<div class="action-list">' + (entries || '<div class="metric-subtext">No metrics available.</div>') + '</div>' +
        '</article>'
      );
    }).join('') +
    '</section>'
  );
}

function renderIssues(issues = []) {
  const sorted = issues.slice().sort((a, b) => {
    const severityDiff = severityRank(b.severity) - severityRank(a.severity);
    if (severityDiff !== 0) return severityDiff;
    return Number(b.count || 0) - Number(a.count || 0);
  });

  return (
    '<section class="card">' +
    '<div class="card-header"><h3 class="card-title">Issues</h3><p class="card-description">Sorted by severity and impact.</p></div>' +
    (sorted.length
      ? '<div class="table-wrap"><table class="table table-compact"><thead><tr><th>Severity</th><th>Section</th><th>Issue</th><th>Count</th><th>Action</th></tr></thead><tbody>' +
        sorted.map((issue) => (
          '<tr>' +
          '<td><span class="data-health-pill health-status-' + escapeHtml(issue.severity || 'needs-review') + '">' + escapeHtml(String(issue.severity || 'info')) + '</span></td>' +
          '<td>' + escapeHtml(sectionTitle(issue.section)) + '</td>' +
          '<td><strong>' + escapeHtml(issue.title || 'Issue') + '</strong><div class="metric-subtext">' + escapeHtml(issue.message || '') + '</div></td>' +
          '<td>' + escapeHtml(String(issue.count || 0)) + '</td>' +
          '<td><button type="button" class="button button-secondary button-sm" data-action="data-health-open" data-target="' + escapeHtml(mapActionTargetToTab(issue.actionTarget)) + '">' + escapeHtml(issue.actionLabel || 'Open') + '</button></td>' +
          '</tr>'
        )).join('') +
        '</tbody></table></div>'
      : '<p class="empty-state">No issues found. Data health is clear.</p>') +
    '</section>'
  );
}

export async function renderDataHealth(container, period, options = {}) {
  if (!period || !period.id) {
    container.innerHTML = '<section class="card"><p class="empty-state">Select a budget period to run Data Health Check.</p></section>';
    return;
  }

  container.innerHTML = '<section class="card"><p class="empty-state">Running Data Health Check...</p></section>';

  try {
    const res = await fetch(BACKEND + '/api/data-health?periodId=' + encodeURIComponent(period.id));
    const report = await readJsonResponseOrThrow(res);
    if (!res.ok) throw new Error(report.error || 'Failed to load data health report.');

    const ccSettings = await loadCommandCenterSettings().catch(() => null);
    const dhFeat = (key) => isFeatureEnabled(ccSettings, 'dataHealth', key);

    // Filter sections based on feature flags
    const filteredSections = { ...report.sections };
    if (!dhFeat('showPlaidHealth')) delete filteredSections.plaid;
    if (!dhFeat('showClassificationHealth')) { delete filteredSections.transactions; delete filteredSections.income; }
    if (!dhFeat('showSplitHealth')) delete filteredSections.splits;
    if (!dhFeat('showBillMatchHealth')) delete filteredSections.recurringBills;
    if (!dhFeat('showTransferHealth')) delete filteredSections.transfers;

    container.innerHTML =
      '<div class="dashboard-page data-health-page">' +
      renderSummary(report) +
      renderSectionCards(filteredSections) +
      renderIssues(report.issues || []) +
      '</div>';

    container.querySelector('[data-action="data-health-refresh"]')?.addEventListener('click', () => {
      renderDataHealth(container, period, options);
    });

    container.querySelectorAll('[data-action="data-health-open"]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.getAttribute('data-target');
        if (target && typeof options.onOpenTab === 'function') {
          options.onOpenTab(target);
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<section class="card"><div class="error-card">Data Health failed.<br><small>' + escapeHtml(err.message || 'Unknown error') + '</small></div></section>';
  }
}
