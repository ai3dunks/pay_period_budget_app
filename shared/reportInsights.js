/**
 * shared/reportInsights.js — Generate human-readable insights from report data.
 * No DOM, no fetch, no localStorage.
 */

function toNumber(value, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function formatMoney(value) {
  const amount = toNumber(value, 0);
  return '$' + Math.abs(amount).toFixed(2);
}

function pluralize(count, single, plural) {
  return count === 1 ? single : plural;
}

export function generateReportInsights(reportData = {}) {
  const periods = Array.isArray(reportData.periods) ? reportData.periods : [];
  const categoryTrends = Array.isArray(reportData.categoryTrends) ? reportData.categoryTrends : [];
  const transferTrends = Array.isArray(reportData.transferTrends) ? reportData.transferTrends : [];
  const billTrends = Array.isArray(reportData.billTrends) ? reportData.billTrends : [];
  const insights = [];

  const categoriesByName = new Map();
  for (const row of categoryTrends) {
    const key = String(row.category || '').trim();
    if (!key) continue;
    const list = categoriesByName.get(key) || [];
    list.push(row);
    categoriesByName.set(key, list);
  }

  for (const [category, rows] of categoriesByName.entries()) {
    const overBudgetCount = rows.filter((item) => toNumber(item.remaining, 0) < 0).length;
    if (overBudgetCount >= 3) {
      insights.push({
        severity: 'warning',
        title: category + ' over budget repeatedly',
        message: category + ' went over budget in ' + overBudgetCount + ' ' + pluralize(overBudgetCount, 'period', 'periods') + '.',
        actionLabel: 'Review Expenses',
        actionTarget: 'expenses',
      });
    }
  }

  const negativeSafeToSpendCount = periods.filter((p) => toNumber(p.safeToSpend, 0) < 0).length;
  if (negativeSafeToSpendCount > 0) {
    insights.push({
      severity: 'danger',
      title: 'Safe to Spend went negative',
      message: 'Safe to Spend was negative in ' + negativeSafeToSpendCount + ' recent ' + pluralize(negativeSafeToSpendCount, 'period', 'periods') + '.',
      actionLabel: 'Open Dashboard',
      actionTarget: 'dashboard',
    });
  }

  const transferByTarget = new Map();
  for (const row of transferTrends) {
    const key = String(row.targetKey || '').trim();
    if (!key) continue;
    const list = transferByTarget.get(key) || [];
    list.push(row);
    transferByTarget.set(key, list);
  }

  for (const [targetKey, rows] of transferByTarget.entries()) {
    const shortRows = rows.filter((item) => toNumber(item.shortfall, 0) > 0);
    if (shortRows.length >= 2) {
      const avgShort = shortRows.reduce((sum, item) => sum + toNumber(item.shortfall, 0), 0) / shortRows.length;
      insights.push({
        severity: 'warning',
        title: (rows[0]?.targetLabel || targetKey) + ' transfer shortfalls',
        message: (rows[0]?.targetLabel || targetKey) + ' transfer was short in ' + shortRows.length + ' ' + pluralize(shortRows.length, 'period', 'periods') + ' (avg short ' + formatMoney(avgShort) + ').',
        actionLabel: 'Open Transfers',
        actionTarget: 'transfers',
      });
    }
  }

  const unpaidAtCloseout = periods.filter((p) => String(p.status || '').toLowerCase() === 'closed' && toNumber(p.recurringBillsLeftToPay, 0) > 0).length;
  if (unpaidAtCloseout > 0) {
    insights.push({
      severity: 'warning',
      title: 'Bills unpaid at closeout',
      message: unpaidAtCloseout + ' closed ' + pluralize(unpaidAtCloseout, 'period', 'periods') + ' still had unpaid bills.',
      actionLabel: 'Review Recurring Bills',
      actionTarget: 'recurring-bills',
    });
  }

  if (periods.length >= 2) {
    const latest = periods[0];
    const previous = periods[1];
    const incomeDelta = toNumber(latest.budgetIncome, 0) - toNumber(previous.budgetIncome, 0);
    if (Math.abs(incomeDelta) >= 25) {
      insights.push({
        severity: 'info',
        title: 'Income changed vs prior period',
        message: 'Budget income changed by ' + formatMoney(incomeDelta) + ' compared with the prior period.',
        actionLabel: 'Open Paycheck Planner',
        actionTarget: 'paycheck-planner',
      });
    }

    const expenseDelta = toNumber(latest.actualExpenseSpending, 0) - toNumber(previous.actualExpenseSpending, 0);
    if (Math.abs(expenseDelta) >= 25) {
      insights.push({
        severity: expenseDelta > 0 ? 'warning' : 'good',
        title: 'Expense trend changed',
        message: 'Actual expense spending changed by ' + formatMoney(expenseDelta) + ' from the prior period.',
        actionLabel: 'Open Reports',
        actionTarget: 'reports',
      });
    }
  }

  const lowHealthCount = periods.filter((p) => toNumber(p.dataHealthScore, 100) < 70).length;
  if (lowHealthCount > 0) {
    insights.push({
      severity: 'warning',
      title: 'Lower confidence report periods',
      message: lowHealthCount + ' ' + pluralize(lowHealthCount, 'period', 'periods') + ' had Data Health score below 70.',
      actionLabel: 'Open Data Health',
      actionTarget: 'data-health',
    });
  }

  const underBudgetStreak = periods.slice(0, 3).filter((p) => toNumber(p.expenseRemaining, 0) >= 0).length;
  if (underBudgetStreak >= 3) {
    insights.push({
      severity: 'good',
      title: 'Strong recent expense control',
      message: 'You stayed under expense budget for 3 periods in a row.',
      actionLabel: 'View Reports',
      actionTarget: 'reports',
    });
  }

  if (!insights.length) {
    insights.push({
      severity: 'info',
      title: 'No major trend alerts',
      message: 'No significant warnings were detected in the selected report range.',
      actionLabel: 'View Dashboard',
      actionTarget: 'dashboard',
    });
  }

  const severityRank = { danger: 4, warning: 3, good: 2, info: 1 };
  return insights
    .sort((a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0))
    .slice(0, 12);
}
