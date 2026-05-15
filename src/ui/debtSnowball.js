import {
  getDebtSnowballData,
  updateDebtSnowballConfig,
  replaceDebts,
  getDebtSnowballPaymentPlans,
  createDebtSnowballPaymentPlan,
  confirmDebtSnowballPaymentPlan,
} from '../api/debtSnowballApi.js';
import {
  getTransferConfirmations,
} from '../api/transferConfirmationApi.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatCurrency(value) {
  return '$' + Number(value || 0).toFixed(2);
}

function formatMonthKey(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}$/.test(text)) {
    return new Date().toISOString().slice(0, 7);
  }
  return text;
}

function normalizeStatus(value) {
  const status = String(value || '').toLowerCase().trim();
  if (status === 'paused' || status === 'paid') return status;
  return 'active';
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDebtFormInput(raw = {}, fallback = {}) {
  const name = String(raw.name ?? fallback.name ?? '').trim();
  if (!name) throw new Error('Debt name is required.');

  const currentBalance = toNumber(raw.currentBalance ?? fallback.currentBalance ?? 0);
  const startingBalance = toNumber(raw.startingBalance ?? fallback.startingBalance ?? currentBalance);
  const interestRate = toNumber(raw.interestRate ?? fallback.interestRate ?? 0);
  const minimumPayment = toNumber(raw.minimumPayment ?? fallback.minimumPayment ?? 0);
  const dueDay = Math.max(1, Math.min(31, Math.round(toNumber(raw.dueDay ?? fallback.dueDay ?? 1))));

  if (currentBalance < 0) throw new Error('Balance cannot be negative.');
  if (startingBalance < 0) throw new Error('Starting balance cannot be negative.');
  if (interestRate < 0) throw new Error('APR cannot be negative.');
  if (minimumPayment < 0) throw new Error('Minimum payment cannot be negative.');

  return {
    name,
    creditor: String(raw.creditor ?? fallback.creditor ?? '').trim(),
    type: String(raw.type ?? fallback.type ?? '').trim(),
    currentBalance,
    startingBalance,
    interestRate,
    minimumPayment,
    dueDay,
    category: String(raw.category ?? fallback.category ?? 'Debts/Savings').trim() || 'Debts/Savings',
    status: normalizeStatus(raw.status ?? fallback.status ?? 'active'),
    notes: String(raw.notes ?? fallback.notes ?? '').trim(),
  };
}

function promptForDebt(initial = {}) {
  const name = window.prompt('Debt name', initial.name || '');
  if (name === null) return null;
  const creditor = window.prompt('Creditor', initial.creditor || '');
  if (creditor === null) return null;
  const type = window.prompt('Type (Credit Card, Loan, etc.)', initial.type || 'Credit Card');
  if (type === null) return null;
  const currentBalance = window.prompt('Current balance', String(initial.currentBalance ?? 0));
  if (currentBalance === null) return null;
  const startingBalance = window.prompt('Starting balance', String(initial.startingBalance ?? initial.currentBalance ?? 0));
  if (startingBalance === null) return null;
  const interestRate = window.prompt('APR %', String(initial.interestRate ?? 0));
  if (interestRate === null) return null;
  const minimumPayment = window.prompt('Minimum monthly payment', String(initial.minimumPayment ?? 0));
  if (minimumPayment === null) return null;
  const dueDay = window.prompt('Due day (1-31)', String(initial.dueDay ?? 1));
  if (dueDay === null) return null;
  const status = window.prompt('Status (active, paused, paid)', String(initial.status || 'active'));
  if (status === null) return null;
  const notes = window.prompt('Notes (optional)', initial.notes || '');
  if (notes === null) return null;

  return parseDebtFormInput({
    name,
    creditor,
    type,
    currentBalance,
    startingBalance,
    interestRate,
    minimumPayment,
    dueDay,
    status,
    notes,
    category: initial.category || 'Debts/Savings',
  });
}

function roundMoney(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

function monthFromKey(key) {
  const value = formatMonthKey(key);
  const [yearStr, monthStr] = value.split('-');
  return new Date(Number(yearStr), Number(monthStr) - 1, 1);
}

function monthKeyFromDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return y + '-' + m;
}

function monthLabel(monthKey) {
  return monthFromKey(monthKey).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function monthDateLabel(monthKey) {
  const d = monthFromKey(monthKey);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return mm + '/01/' + d.getFullYear();
}

function normalizeDebt(raw) {
  const status = String(raw?.status || 'active').toLowerCase();
  return {
    id: String(raw?.id || ''),
    name: String(raw?.name || ''),
    startingBalance: roundMoney(Math.max(0, toNumber(raw?.startingBalance, raw?.currentBalance || 0))),
    currentBalance: roundMoney(Math.max(0, toNumber(raw?.currentBalance, 0))),
    minimumPayment: roundMoney(Math.max(0, toNumber(raw?.minimumPayment, 0))),
    interestRate: Math.max(0, toNumber(raw?.interestRate, 0)),
    creditLimit: raw?.creditLimit === null || raw?.creditLimit === undefined || String(raw?.creditLimit).trim() === ''
      ? null
      : Math.max(0, toNumber(raw?.creditLimit, 0)),
    status: status === 'paid' || status === 'paused' ? status : 'active',
  };
}

function compareOrder(a, b, strategy) {
  if (strategy === 'avalanche') {
    if (b.interestRate !== a.interestRate) return b.interestRate - a.interestRate;
    if (a.balance !== b.balance) return a.balance - b.balance;
    if ((a.originalOrder ?? 0) !== (b.originalOrder ?? 0)) return (a.originalOrder ?? 0) - (b.originalOrder ?? 0);
    return a.name.localeCompare(b.name);
  }
  if (a.balance !== b.balance) return a.balance - b.balance;
  if ((a.originalOrder ?? 0) !== (b.originalOrder ?? 0)) return (a.originalOrder ?? 0) - (b.originalOrder ?? 0);
  return a.name.localeCompare(b.name);
}

function getNextSnowballTarget(debts, strategy) {
  const activeUnpaid = (debts || []).filter((debt) => debt.status === 'active' && debt.balance > 0.00001);
  if (!activeUnpaid.length) return null;
  activeUnpaid.sort((a, b) => compareOrder(a, b, strategy));
  return activeUnpaid[0];
}

function getNextStrictSnowballTarget(debts, snowballRankById) {
  const activeUnpaid = (debts || []).filter((debt) => debt.status === 'active' && debt.balance > 0.00001);
  if (!activeUnpaid.length) return null;
  activeUnpaid.sort((a, b) => {
    const rankA = snowballRankById.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rankB = snowballRankById.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return a.name.localeCompare(b.name);
  });
  return activeUnpaid[0];
}

function calculateTrackerPlan({ debts = [], strategy = 'snowball', startingPeriodId, currentPeriodId, extraPayPeriodPayment = 0 }) {
  const strategyKey = String(strategy || 'snowball').toLowerCase() === 'avalanche' ? 'avalanche' : 'snowball';
  const startMonth = formatMonthKey((startingPeriodId || '').slice(0, 7));
  const selectedMonth = formatMonthKey((currentPeriodId || startingPeriodId || '').slice(0, 7) || startMonth);
  const baseExtra = roundMoney(Math.max(0, toNumber(extraPayPeriodPayment, 0)));

  const normalized = debts.map((rawDebt, idx) => ({
    ...normalizeDebt(rawDebt),
    originalOrder: idx,
  }));
  const state = normalized.map((debt) => ({
    ...debt,
    balance: roundMoney(debt.currentBalance),
    paidOffMonth: debt.status === 'paid' || debt.currentBalance <= 0 ? startMonth : null,
    history: [],
  }));

  // Strict snowball queue is fixed from the starting-month balances.
  const strictSnowballOrder = state
    .filter((debt) => debt.status === 'active' && debt.balance > 0.00001)
    .slice()
    .sort((a, b) => compareOrder(a, b, 'snowball'));
  const strictSnowballRankById = new Map(strictSnowballOrder.map((debt, idx) => [debt.id, idx + 1]));

  const schedule = [];
  let rolledOverMinimums = 0;
  let totalInterest = 0;
  let monthDate = monthFromKey(startMonth);
  let iterations = 0;

  function activeDebts() {
    return state.filter((debt) => debt.status === 'active' && debt.balance > 0);
  }

  while (activeDebts().length && iterations < 600) {
    iterations += 1;
    const monthKey = monthKeyFromDate(monthDate);
    const live = activeDebts();
    let minimumTotal = 0;
    let paidThisMonth = 0;
    let interestThisMonth = 0;
    let newlyFreed = 0;
    let targetedDebtId = null;

    const monthState = live.map((debt) => {
      const startBalance = roundMoney(debt.balance);
      const interest = roundMoney(startBalance * (debt.interestRate / 100 / 12));
      const withInterest = roundMoney(startBalance + interest);
      const minimumDue = roundMoney(debt.minimumPayment);
      const minimumPaid = roundMoney(Math.min(withInterest, minimumDue));
      const balanceAfterMinimum = roundMoney(Math.max(0, withInterest - minimumPaid));
      debt.balance = balanceAfterMinimum;

      minimumTotal = roundMoney(minimumTotal + minimumPaid);
      interestThisMonth = roundMoney(interestThisMonth + interest);
      paidThisMonth = roundMoney(paidThisMonth + minimumPaid);

      return {
        debt,
        minimumPaid,
        extraPaid: 0,
      };
    });

    let availableSnowball = roundMoney(Math.max(0, baseExtra + rolledOverMinimums));
    while (availableSnowball > 0.00001) {
      const poolDebts = monthState.map((entry) => entry.debt);
      const target = strategyKey === 'snowball'
        ? getNextStrictSnowballTarget(poolDebts, strictSnowballRankById)
        : getNextSnowballTarget(poolDebts, strategyKey);
      if (!target) break;

      if (!targetedDebtId) targetedDebtId = target.id;

      const targetEntry = monthState.find((entry) => entry.debt.id === target.id);
      const extraPayment = roundMoney(Math.min(target.balance, availableSnowball));
      if (extraPayment <= 0) break;

      target.balance = roundMoney(Math.max(0, target.balance - extraPayment));
      targetEntry.extraPaid = roundMoney(targetEntry.extraPaid + extraPayment);
      paidThisMonth = roundMoney(paidThisMonth + extraPayment);
      availableSnowball = roundMoney(availableSnowball - extraPayment);
    }

    for (const entry of monthState) {
      const debt = entry.debt;
      const payment = roundMoney(entry.minimumPaid + entry.extraPaid);
      const endBalance = roundMoney(Math.max(0, debt.balance));
      debt.history.push({ monthKey, payment, balance: endBalance });
      if (endBalance <= 0.00001 && !debt.paidOffMonth) {
        debt.paidOffMonth = monthKey;
        newlyFreed = roundMoney(newlyFreed + debt.minimumPayment);
      }
    }

    rolledOverMinimums = roundMoney(rolledOverMinimums + newlyFreed);
    totalInterest = roundMoney(totalInterest + interestThisMonth);
    schedule.push({
      monthKey,
      monthLabel: monthLabel(monthKey),
      dateLabel: monthDateLabel(monthKey),
      targetedDebtId,
      remainingBalance: roundMoney(state.reduce((sum, debt) => sum + Math.max(0, debt.balance), 0)),
      minimumPayments: minimumTotal,
      totalPayment: paidThisMonth,
    });
    monthDate = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1);
  }

  const snapshot = schedule.find((row) => row.monthKey === selectedMonth) || schedule[schedule.length - 1] || {
    monthKey: selectedMonth,
    targetedDebtId: null,
    remainingBalance: roundMoney(state.reduce((sum, debt) => sum + Math.max(0, debt.balance), 0)),
    minimumPayments: 0,
    totalPayment: 0,
  };

  const withDerived = state.map((debt) => {
    const point = debt.history.find((row) => row.monthKey === selectedMonth) || debt.history[debt.history.length - 1] || { balance: debt.balance };
    const currentProjectedBalance = roundMoney(point.balance);
    const startBase = debt.startingBalance > 0 ? debt.startingBalance : debt.currentBalance;
    const percentPaid = startBase > 0 ? Math.max(0, Math.min(100, ((startBase - currentProjectedBalance) / startBase) * 100)) : 100;
    const utilizationRate = debt.creditLimit && debt.creditLimit > 0 ? (currentProjectedBalance / debt.creditLimit) * 100 : null;
    return {
      ...debt,
      currentProjectedBalance,
      percentPaid,
      utilizationRate,
      paidOffByLabel: debt.paidOffMonth ? monthLabel(debt.paidOffMonth) : '-',
      isPaid: currentProjectedBalance <= 0.00001 || debt.status === 'paid',
    };
  });

  const activeForOrder = withDerived
    .filter((debt) => debt.status === 'active' && debt.currentProjectedBalance > 0.00001)
    .map((debt) => ({
      ...debt,
      balance: roundMoney(debt.currentProjectedBalance),
    }))
    .sort((a, b) => {
      if (strategyKey === 'snowball') {
        const rankA = strictSnowballRankById.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rankB = strictSnowballRankById.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (rankA !== rankB) return rankA - rankB;
        return a.name.localeCompare(b.name);
      }
      return compareOrder(a, b, strategyKey);
    });
  const rankById = new Map();
  activeForOrder.forEach((debt, idx) => rankById.set(debt.id, idx + 1));

  const orderedDebts = withDerived
    .map((debt) => ({ ...debt, targetRank: rankById.get(debt.id) || null }))
    .sort((a, b) => {
      if ((a.targetRank || 999) !== (b.targetRank || 999)) return (a.targetRank || 999) - (b.targetRank || 999);
      return a.name.localeCompare(b.name);
    });

  const totalStartingBalance = roundMoney(orderedDebts.reduce((sum, debt) => sum + debt.startingBalance, 0));
  const remainingBalance = roundMoney(orderedDebts.reduce((sum, debt) => sum + debt.currentProjectedBalance, 0));
  const debtsPaid = orderedDebts.filter((debt) => debt.isPaid).length;
  const debtsRemaining = Math.max(0, orderedDebts.length - debtsPaid);
  const totalMinimumPayments = roundMoney(orderedDebts.reduce((sum, debt) => sum + (!debt.isPaid ? debt.minimumPayment : 0), 0));
  const totalMonthlyPayment = roundMoney(Math.max(0, totalMinimumPayments + baseExtra));
  const totalCreditBalance = roundMoney(orderedDebts.reduce((sum, debt) => sum + (debt.creditLimit ? debt.currentProjectedBalance : 0), 0));
  const totalCreditLimit = roundMoney(orderedDebts.reduce((sum, debt) => sum + (debt.creditLimit || 0), 0));
  const totalCreditUtilizationRate = totalCreditLimit > 0 ? (totalCreditBalance / totalCreditLimit) * 100 : null;
  const projectedDebtFreeMonth = schedule.length ? schedule[schedule.length - 1].monthKey : startMonth;
  const payoffProgress = totalStartingBalance > 0 ? Math.max(0, Math.min(100, ((totalStartingBalance - remainingBalance) / totalStartingBalance) * 100)) : 100;
  const distributionTotal = roundMoney(orderedDebts.reduce((sum, debt) => sum + (!debt.isPaid ? debt.currentProjectedBalance : 0), 0));

  return {
    strategy: strategyKey,
    startingPeriodId: startingPeriodId || null,
    currentPeriodId: currentPeriodId || null,
    extraPayPeriodPayment: baseExtra,
    debts: orderedDebts,
    schedule,
    projectedDebtFreeMonthLabel: monthLabel(projectedDebtFreeMonth),
    summary: {
      debtsPaid,
      debtsRemaining,
      debtFreeDate: monthLabel(projectedDebtFreeMonth),
      payoffProgress,
      remainingBalance,
      totalStartingBalance,
      totalMonthlyPayment,
      totalInterest,
      totalCreditUtilizationRate,
    },
    distribution: orderedDebts
      .filter((debt) => !debt.isPaid && debt.currentProjectedBalance > 0)
      .map((debt) => ({
        ...debt,
        isTarget: snapshot.targetedDebtId === debt.id,
        percent: distributionTotal > 0 ? (debt.currentProjectedBalance / distributionTotal) * 100 : 0,
      })),
  };
}

function renderDonut(distribution) {
  if (!distribution.length) {
    return '<div class="debt-donut-empty">No active balances to chart</div>';
  }
  const palette = ['#0f766e', '#0ea5e9', '#f59e0b', '#ef4444', '#7c3aed', '#14b8a6', '#f97316', '#10b981'];
  let offset = 0;
  const segments = distribution.map((slice, idx) => {
    const start = offset;
    offset += slice.percent;
    const end = Math.min(100, offset);
    return palette[idx % palette.length] + ' ' + start.toFixed(2) + '% ' + end.toFixed(2) + '%';
  });
  const legend = distribution.map((slice, idx) => (
    '<div class="debt-donut-legend-row"><span class="debt-donut-dot" style="background:' + palette[idx % palette.length] + '"></span><span>' +
    escapeHtml(slice.name) + '</span><span>' + escapeHtml(slice.percent.toFixed(1)) + '%</span></div>'
  )).join('');
  return '<div class="debt-donut-wrap"><div class="debt-donut" style="background:conic-gradient(' + segments.join(', ') + ')"><div class="debt-donut-hole">Current Balance<br>Distribution</div></div><div class="debt-donut-legend">' + legend + '</div></div>';
}

function renderDebtCards(plan) {
  const months = Array.isArray(plan.schedule) ? plan.schedule : [];
  return plan.debts.map((debt) => {
    const cardClass = debt.isPaid
      ? 'debt-column debt-column-paid'
      : debt.targetRank === 1
        ? 'debt-column debt-column-target'
        : debt.interestRate >= 20
          ? 'debt-column debt-column-alert'
          : 'debt-column';
    const historyByMonth = new Map((debt.history || []).map((row) => [row.monthKey, row]));
    const payoffIndex = debt.paidOffMonth ? months.findIndex((row) => row.monthKey === debt.paidOffMonth) : -1;
    const miniRows = months.map((month, index) => {
      const entry = historyByMonth.get(month.monthKey);
      const muted = payoffIndex >= 0 && index > payoffIndex;
      return '<tr class="' + (muted ? 'debt-mini-row-muted' : '') + '"><td>' + escapeHtml(month.monthLabel) + '</td><td>' + escapeHtml(formatCurrency(entry ? entry.payment : 0)) + '</td><td>' + escapeHtml(formatCurrency(entry ? entry.balance : 0)) + '</td></tr>';
    }).join('');
    return '<article class="' + cardClass + '"><div class="debt-card-head"><div class="debt-column-order">' + escapeHtml(String(debt.targetRank || 0)) + '</div><h4 class="debt-column-name">' +
      escapeHtml(debt.name) + '</h4></div><div class="debt-card-progress"><div class="debt-percent-paid">' + escapeHtml(debt.percentPaid.toFixed(0)) + '%</div><div class="debt-paid-by">Paid off by ' +
      escapeHtml(debt.paidOffByLabel || '-') + '</div></div><div class="debt-column-metrics"><div><span>Start Balance</span><strong>' + escapeHtml(formatCurrency(debt.startingBalance)) +
      '</strong></div><div><span>Min Payment</span><strong>' + escapeHtml(formatCurrency(debt.minimumPayment)) + '</strong></div><div><span>Interest Rate</span><strong>' +
      escapeHtml(debt.interestRate.toFixed(2)) + '%</strong></div><div class="debt-current-row"><span>Current Balance</span><strong>' + escapeHtml(formatCurrency(debt.currentProjectedBalance)) +
      '</strong></div><div><span>Credit Limit</span><strong>' + escapeHtml(debt.creditLimit ? formatCurrency(debt.creditLimit) : '-') + '</strong></div><div><span>Utilization</span><strong>' +
      escapeHtml(debt.utilizationRate === null ? '-' : debt.utilizationRate.toFixed(1) + '%') + '</strong></div></div><div class="debt-mini-table-wrap"><table class="table debt-mini-table"><thead><tr><th>Pay Period</th><th>Payment</th><th>Balance</th></tr></thead><tbody>' +
      (miniRows || '<tr><td colspan="3">No rows yet</td></tr>') + '</tbody></table></div></article>';
  }).join('');
}

function buildSuggestedDebtPayments({ debts = [], strategy = 'snowball', confirmedAmount = 0 }) {
  const activeDebts = (debts || [])
    .map(normalizeDebt)
    .filter((debt) => debt.status === 'active' && debt.currentBalance > 0.00001);

  if (!activeDebts.length || confirmedAmount <= 0) {
    return [];
  }

  const ordered = activeDebts.slice().sort((a, b) => {
    if (strategy === 'avalanche') {
      if (b.interestRate !== a.interestRate) return b.interestRate - a.interestRate;
      if (a.currentBalance !== b.currentBalance) return a.currentBalance - b.currentBalance;
      return a.name.localeCompare(b.name);
    }
    if (a.currentBalance !== b.currentBalance) return a.currentBalance - b.currentBalance;
    return a.name.localeCompare(b.name);
  });

  let remaining = roundMoney(Math.max(0, confirmedAmount));
  const rows = [];
  for (const debt of ordered) {
    if (remaining <= 0.00001) break;
    const payment = roundMoney(Math.min(remaining, debt.currentBalance));
    if (payment <= 0) continue;
    const balanceAfter = roundMoney(Math.max(0, debt.currentBalance - payment));
    rows.push({
      debtId: debt.id,
      debtName: debt.name,
      currentBalance: debt.currentBalance,
      suggestedPayment: payment,
      balanceAfter,
      paidOff: balanceAfter <= 0.00001,
    });
    remaining = roundMoney(remaining - payment);
  }
  return rows;
}

function renderAvailableExtraPaymentShell({ strategy, periodLabel, confirmedTransferAmount, hasConfirmedTransfer, suggestedRows }) {
  const hasAmount = hasConfirmedTransfer && confirmedTransferAmount > 0.00001;
  const confirmedAmountDisplay = hasConfirmedTransfer
    ? formatCurrency(confirmedTransferAmount)
    : 'No Confirmed Transfer Amount';
  const tableHtml = suggestedRows.length
    ? '<div class="table-wrap debt-extra-shell-table-wrap"><table class="table debt-extra-shell-table"><thead><tr><th>Debt Account</th><th>Current Balance</th><th>Suggested Payment</th><th>Action</th></tr></thead><tbody>' +
      suggestedRows.map((row) => '<tr' + (row.paidOff ? ' class="debt-extra-shell-row-paid"' : '') + '><td>' + escapeHtml(row.debtName) + '</td><td>' + escapeHtml(formatCurrency(row.currentBalance)) + '</td><td>' + escapeHtml(formatCurrency(row.suggestedPayment)) + '</td><td><button class="button button-primary button-sm" data-action="confirm-suggested-payment" data-debt-id="' + escapeHtml(String(row.debtId || '')) + '" data-debt-name="' + escapeHtml(row.debtName) + '" data-amount="' + escapeHtml(String(row.suggestedPayment || 0)) + '">Confirm</button></td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="debt-extra-shell-empty">No confirmed extra debt payment available for this budget period.</div>';
  return (
    '<section class="card debt-extra-shell-card"><div class="card-header"><h3 class="card-title">Available Extra Debt Payment</h3></div>' +
    '<div class="debt-extra-shell-list">' +
    '<div class="action-row"><span>Source</span><strong>Debt/Savings Transfer</strong></div>' +
    '<div class="action-row"><span>Budget Period</span><strong>' + escapeHtml(periodLabel || 'Not available') + '</strong></div>' +
    '<div class="action-row"><span>Confirmed Transferred Amount</span><strong>' + escapeHtml(confirmedAmountDisplay) + '</strong></div>' +
    '</div>' +
    '<div class="debt-extra-shell-subtitle">Suggested Debt Payments</div>' +
    (hasAmount ? tableHtml : '<div class="debt-extra-shell-empty">No confirmed extra debt payment available for this budget period.</div>') +
    '</section>'
  );
}

function buildMonthRows(startingMonth, schedule) {
  const rows = [];
  const start = monthFromKey(startingMonth);
  const horizon = Math.max(24, schedule.length + 1);
  for (let i = 0; i < horizon; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = monthKeyFromDate(d);
    const sched = schedule.find((row) => row.monthKey === key);
    rows.push({
      monthKey: key,
      monthLabel: monthLabel(key),
      dateLabel: monthDateLabel(key),
      remainingBalance: sched ? sched.remainingBalance : 0,
    });
  }
  return rows;
}

function parseSourceRows(container) {
  const rows = [];
  const tableRows = container.querySelectorAll('[data-debt-source-row]');
  for (const tr of tableRows) {
    const name = String(tr.querySelector('[data-field="name"]')?.value || '').trim();
    const startBalanceText = String(tr.querySelector('[data-field="startingBalance"]')?.value || '').trim();
    const minPaymentText = String(tr.querySelector('[data-field="minimumPayment"]')?.value || '').trim();
    const interestText = String(tr.querySelector('[data-field="interestRate"]')?.value || '').trim();
    const creditLimitText = String(tr.querySelector('[data-field="creditLimit"]')?.value || '').trim();
    const hasAny = Boolean(name || startBalanceText || minPaymentText || interestText || creditLimitText);
    if (!hasAny) continue;
    if (!name) throw new Error('Debt Name is required for filled rows.');
    const startingBalance = toNumber(startBalanceText, NaN);
    const minimumPayment = toNumber(minPaymentText, NaN);
    const interestRate = interestText === '' ? 0 : toNumber(interestText, NaN);
    if (!Number.isFinite(startingBalance) || startingBalance < 0) throw new Error('Start Balance must be a non-negative number.');
    if (!Number.isFinite(minimumPayment) || minimumPayment < 0) throw new Error('Min. Payment must be a non-negative number.');
    if (!Number.isFinite(interestRate) || interestRate < 0) throw new Error('Interest Rate must be a non-negative number.');
    rows.push({
      name,
      startingBalance: roundMoney(startingBalance),
      currentBalance: roundMoney(startingBalance),
      minimumPayment: roundMoney(minimumPayment),
      interestRate: roundMoney(interestRate),
      creditLimit: creditLimitText === '' ? null : roundMoney(Math.max(0, toNumber(creditLimitText, 0))),
      dueDay: 1,
      category: 'Debts/Savings',
      status: 'active',
      type: 'Debt',
      notes: '',
    });
  }
  return rows;
}

export async function renderDebtSnowball(container, period, periodLabel, periods = []) {
  container.innerHTML = '<section class="card"><p class="empty-state">Loading Debt Snowball Tracker...</p></section>';

  try {
    let data = await getDebtSnowballData();
    const debts = Array.isArray(data?.debts) ? data.debts : [];

    let transferConfirmations = [];
    try {
      const confData = await getTransferConfirmations(period.id, 'Debt/Savings');
      transferConfirmations = Array.isArray(confData?.confirmations) ? confData.confirmations : [];
    } catch (err) {
      console.error('Debt Snowball: failed loading transfer confirmations:', err);
    }

    const config = data?.config || {};
    const strategy = String(config.strategy || 'snowball').toLowerCase() === 'avalanche' ? 'avalanche' : 'snowball';
    const startingPeriodId = String(config.startingPeriodId || period.id);
    const currentPeriodId = String(period.id || startingPeriodId);
    const extraPayPeriodPayment = Math.max(0, toNumber(config.extraPayPeriodPayment || 0));

    let paymentPlans = [];
    try {
      const plansData = await getDebtSnowballPaymentPlans(period.id);
      paymentPlans = Array.isArray(plansData?.plans) ? plansData.plans : [];
    } catch (err) {
      console.error('Debt Snowball: failed loading payment plans:', err);
    }

    const confirmedDebtSavingsTransfer = transferConfirmations.find((c) => c.targetName === 'Debt/Savings' && c.status === 'confirmed');
    const confirmedTransferAmount = roundMoney(confirmedDebtSavingsTransfer?.confirmedTransferAmount || 0);
    const appliedTransferAmount = roundMoney(
      paymentPlans
        .filter((planRow) => planRow.status === 'applied')
        .reduce((sum, planRow) => sum + Number(planRow.appliedAmount || planRow.amount || 0), 0)
    );
    const remainingTransferAmount = roundMoney(Math.max(0, confirmedTransferAmount - appliedTransferAmount));
    const suggestedDebtPayments = buildSuggestedDebtPayments({
      debts,
      strategy,
      confirmedAmount: remainingTransferAmount,
    });

    const plan = calculateTrackerPlan({ debts, strategy, startingPeriodId, currentPeriodId, extraPayPeriodPayment });
    const summary = plan.summary;
    const monthRows = buildMonthRows((plan.startingPeriodId || period.id).slice(0, 7), plan.schedule);
    const sourceRows = plan.debts.concat(Array.from({ length: 5 }).map(() => ({ name: '', startingBalance: '', minimumPayment: '', interestRate: '', creditLimit: '' })));

    // Create period selector HTML
    const startingPeriodOptions = (periods || [])
      .map((p) => '<option value="' + escapeHtml(p.id) + '" ' + (p.id === startingPeriodId ? 'selected' : '') + '>' + escapeHtml(p.label || 'Unknown') + '</option>')
      .join('');

    container.innerHTML =
      '<div class="debt-tracker-page"><header class="page-header"><div class="page-header-main"><h2 class="page-title">Debt Snowball Tracker</h2><p class="page-description">Pay Period: ' + escapeHtml(periodLabel || 'N/A') +
      '</p></div></header><div class="debt-tracker-layout"><aside class="debt-tracker-left"><section class="card debt-tracker-left-card"><h3 class="card-title">Debt Snowball Tracker</h3>' +
      '<div class="debt-control-grid"><label class="form-field"><span>Strategy</span><select id="debt-strategy"><option value="snowball"' + (plan.strategy === 'snowball' ? ' selected' : '') + '>Snowball</option><option value="avalanche"' +
      (plan.strategy === 'avalanche' ? ' selected' : '') + '>Avalanche</option></select></label><label class="form-field"><span>Starting Pay Period</span><select id="debt-starting-period">' + startingPeriodOptions + '</select></label><label class="form-field"><span>Extra per Pay Period</span><input id="debt-extra-payment" type="number" step="0.01" min="0" value="' + escapeHtml(String(extraPayPeriodPayment || 0)) +
      '"></label></div><div id="debt-message" class="settings-message"></div>' +
      '</section><section class="card debt-kpi-card"><div class="card-header"><h3 class="card-title">Debt Summary Metrics</h3></div><div class="debt-kpi-list"><div><span># Debts Paid</span><strong>' + escapeHtml(String(summary.debtsPaid)) + '</strong></div><div><span># Debts Remaining</span><strong>' + escapeHtml(String(summary.debtsRemaining)) +
      '</strong></div><div><span>Debt Free Date</span><strong>' + escapeHtml(summary.debtFreeDate) + '</strong></div><div><span>Overall Payoff Progress</span><strong>' + escapeHtml(summary.payoffProgress.toFixed(1)) +
      '%</strong></div><div><span>Remaining Balance</span><strong>' + escapeHtml(formatCurrency(summary.remainingBalance)) + '</strong></div><div><span>Total Starting Balance</span><strong>' + escapeHtml(formatCurrency(summary.totalStartingBalance)) +
      '</strong></div><div><span>Total Per-Period Payment</span><strong>' + escapeHtml(formatCurrency(summary.totalMonthlyPayment)) + '</strong></div><div class="muted-note">Debt minimum payments should match Recurring Bills categorized as Debt/Savings.</div>' +
      '<div><span>Total Interest</span><strong>' + escapeHtml(formatCurrency(summary.totalInterest)) + '</strong></div><div><span>Total Credit Utilization Rate</span><strong>' + escapeHtml(summary.totalCreditUtilizationRate === null ? '-' : summary.totalCreditUtilizationRate.toFixed(1) + '%') +
      '</strong></div></div></section></section><section class="card debt-monthly-card"><div class="card-header"><h3 class="card-title">Payoff Schedule</h3></div><div class="table-wrap"><table class="table debt-monthly-table"><thead><tr><th>Pay Period</th><th>Date</th><th>Remaining Balance</th></tr></thead><tbody>' +
      monthRows.map((row) => '<tr><td>' + escapeHtml(row.monthLabel) + '</td><td>' + escapeHtml(row.dateLabel) + '</td><td>' + escapeHtml(formatCurrency(row.remainingBalance)) + '</td></tr>').join('') +
      '</tbody></table></div></section></aside><main class="debt-tracker-main"><section class="debt-main-top-row"><section class="card debt-distribution-card"><div class="card-header"><h3 class="card-title">Current Balance Distribution</h3></div>' +
      renderDonut(plan.distribution) + '</section>' +
      renderAvailableExtraPaymentShell({
        strategy: plan.strategy,
        periodLabel,
        confirmedTransferAmount,
        hasConfirmedTransfer: Boolean(confirmedDebtSavingsTransfer),
        suggestedRows: suggestedDebtPayments,
      }) +
      '</section><section class="card debt-grid-card"><div class="card-header"><h3 class="card-title">Debt Tracker Grid</h3></div><div class="debt-columns-scroll">' + renderDebtCards(plan) +
      '</div></section></main></div><details class="card debt-source-card" open><summary>Fill out your debt info in the table below. This page will automatically sort your debts from the smallest to highest balance.</summary><div class="table-wrap"><table class="table debt-source-table"><thead><tr><th>#</th><th>Debt Name</th><th>Start Balance</th><th>Min. Payment</th><th>Interest Rate</th><th>Credit Limit</th></tr></thead><tbody>' +
      sourceRows.map((row, idx) => '<tr data-debt-source-row><td>' + escapeHtml(String(idx + 1)) + '</td><td><input data-field="name" type="text" value="' + escapeHtml(row.name || '') + '"></td><td><input data-field="startingBalance" type="number" step="0.01" value="' + escapeHtml(String(row.startingBalance ?? '')) + '"></td><td><input data-field="minimumPayment" type="number" step="0.01" value="' + escapeHtml(String(row.minimumPayment ?? '')) + '"></td><td><input data-field="interestRate" type="number" step="0.01" value="' + escapeHtml(String(row.interestRate ?? '')) + '"></td><td><input data-field="creditLimit" type="number" step="0.01" value="' + escapeHtml(row.creditLimit === null || row.creditLimit === undefined ? '' : String(row.creditLimit)) + '"></td></tr>').join('') +
      '</tbody></table></div><div class="inline-actions"><button class="button button-primary" data-action="debt-save-table">Save Debt Table</button></div></details></div>';

    const messageNode = container.querySelector('#debt-message');
    const setMessage = (type, text) => {
      if (!messageNode) return;
      messageNode.className = 'settings-message ' + type;
      messageNode.textContent = text;
    };

    container.querySelectorAll('[data-action="confirm-suggested-payment"]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        const target = event.currentTarget;
        const debtId = String(target.getAttribute('data-debt-id') || '').trim();
        const debtName = String(target.getAttribute('data-debt-name') || '').trim();
        const amount = roundMoney(Number(target.getAttribute('data-amount') || 0));

        if (!debtId || !debtName || !Number.isFinite(amount) || amount <= 0) {
          setMessage('error', 'Unable to confirm suggested payment.');
          return;
        }

        target.disabled = true;
        try {
          const planRow = await createDebtSnowballPaymentPlan({
            budgetPeriodId: period.id,
            transferConfirmationId: confirmedDebtSavingsTransfer?.id || null,
            targetDebtId: debtId,
            targetDebtName: debtName,
            amount,
            strategy: plan.strategy,
            notes: 'Confirmed from Suggested Debt Payments',
          });

          await confirmDebtSnowballPaymentPlan(planRow.id);
          await renderDebtSnowball(container, period, periodLabel);
        } catch (err) {
          target.disabled = false;
          setMessage('error', err.message || 'Failed to confirm suggested payment.');
        }
      });
    });

    const autoSaveControls = async () => {
      try {
        const nextStrategy = String(container.querySelector('#debt-strategy')?.value || 'snowball').toLowerCase();
        const nextStartingPeriodId = String(container.querySelector('#debt-starting-period')?.value || startingPeriodId || period.id);
        const nextExtraPayPeriodPayment = roundMoney(Math.max(0, toNumber(container.querySelector('#debt-extra-payment')?.value ?? extraPayPeriodPayment, 0)));
        await updateDebtSnowballConfig({
          strategy: nextStrategy,
          currentPeriodId: period.id,
          startingPeriodId: nextStartingPeriodId,
          extraPayPeriodPayment: nextExtraPayPeriodPayment,
        });
        await renderDebtSnowball(container, period, periodLabel);
      } catch (err) {
        setMessage('error', err.message || 'Failed to save tracker settings.');
      }
    };

    container.querySelector('#debt-strategy')?.addEventListener('change', autoSaveControls);
    container.querySelector('#debt-starting-period')?.addEventListener('change', autoSaveControls);
    container.querySelector('#debt-extra-payment')?.addEventListener('change', autoSaveControls);

    container.querySelector('[data-action="debt-save-table"]')?.addEventListener('click', async () => {
      try {
        const rows = parseSourceRows(container);
        await replaceDebts({ rows });
        setMessage('success', 'Debt source table saved.');
        await renderDebtSnowball(container, period, periodLabel);
      } catch (err) {
        setMessage('error', err.message || 'Failed to save debt source table.');
      }
    });

  } catch (err) {
    console.error('Failed to render Debt Snowball page:', err);
    container.innerHTML = '<section class="card"><div class="error-card">Debt Snowball could not be loaded.</div></section>';
  }
}
