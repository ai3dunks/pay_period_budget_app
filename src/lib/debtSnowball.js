function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

function toMonthKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return y + '-' + m;
}

function monthFromKey(key) {
  const source = String(key || '').trim();
  if (!/^\d{4}-\d{2}$/.test(source)) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const [yearStr, monthStr] = source.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  return new Date(year, Math.max(0, Math.min(11, month - 1)), 1);
}

function monthLabelFromDate(date) {
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function normalizeDebt(debt) {
  const status = String(debt?.status || 'active').toLowerCase();
  return {
    id: String(debt?.id || ''),
    name: String(debt?.name || ''),
    creditor: String(debt?.creditor || ''),
    type: String(debt?.type || ''),
    currentBalance: roundMoney(Math.max(0, toNumber(debt?.currentBalance, 0))),
    startingBalance: roundMoney(Math.max(0, toNumber(debt?.startingBalance, debt?.currentBalance || 0))),
    interestRate: Math.max(0, toNumber(debt?.interestRate, 0)),
    minimumPayment: roundMoney(Math.max(0, toNumber(debt?.minimumPayment, 0))),
    dueDay: Math.max(1, Math.min(31, Math.round(toNumber(debt?.dueDay, 1)))),
    category: String(debt?.category || ''),
    status: status === 'paused' || status === 'paid' ? status : 'active',
    notes: String(debt?.notes || ''),
    linkedRecurringBillId: debt?.linkedRecurringBillId || null,
    linkedRecurringBillName: debt?.linkedRecurringBillName || null,
    linkedRecurringBillAmount: debt?.linkedRecurringBillAmount === null || debt?.linkedRecurringBillAmount === undefined
      ? null
      : roundMoney(debt.linkedRecurringBillAmount),
  };
}

function compareDebtOrder(a, b, strategy) {
  if (strategy === 'avalanche') {
    if (b.interestRate !== a.interestRate) return b.interestRate - a.interestRate;
    if (a.currentBalance !== b.currentBalance) return a.currentBalance - b.currentBalance;
    return a.name.localeCompare(b.name);
  }
  if (a.currentBalance !== b.currentBalance) return a.currentBalance - b.currentBalance;
  if (b.interestRate !== a.interestRate) return b.interestRate - a.interestRate;
  return a.name.localeCompare(b.name);
}

function findTargetDebt(debts, strategy) {
  const candidates = debts.filter((d) => d.currentBalance > 0 && d.status === 'active');
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => compareDebtOrder(a, b, strategy))[0];
}

export function calculateDebtSnowballPlan({ debts = [], strategy = 'snowball', extraMonthlyPayment = 0, startingMonth }) {
  const normalizedDebts = (debts || []).map(normalizeDebt);
  const startMonthDate = monthFromKey(startingMonth);
  const strategyKey = String(strategy || 'snowball').toLowerCase() === 'avalanche' ? 'avalanche' : 'snowball';
  const extraPayment = roundMoney(Math.max(0, toNumber(extraMonthlyPayment, 0)));

  const activeDebts = normalizedDebts.filter((debt) => debt.status === 'active' && debt.currentBalance > 0);
  const pausedDebts = normalizedDebts.filter((debt) => debt.status === 'paused' && debt.currentBalance > 0);
  const paidDebts = normalizedDebts.filter((debt) => debt.status === 'paid' || debt.currentBalance <= 0);

  const debtsState = activeDebts.map((debt) => ({
    ...debt,
    remainingBalance: roundMoney(debt.currentBalance),
    payoffMonth: null,
  }));

  let monthDate = new Date(startMonthDate.getFullYear(), startMonthDate.getMonth(), 1);
  let rolledOverPayments = 0;
  let totalInterestPaid = 0;
  const schedule = [];
  const payoffByDebtId = new Map();
  let monthCount = 0;

  while (debtsState.some((d) => d.remainingBalance > 0) && monthCount < 600) {
    monthCount += 1;
    const activeThisMonth = debtsState.filter((debt) => debt.remainingBalance > 0);
    if (!activeThisMonth.length) break;

    const targetDebt = findTargetDebt(
      activeThisMonth.map((d) => ({ ...d, currentBalance: d.remainingBalance })),
      strategyKey
    );

    const startingTotalDebt = roundMoney(activeThisMonth.reduce((sum, debt) => sum + debt.remainingBalance, 0));

    let minimumPayments = 0;
    let extraApplied = 0;
    let interestCharged = 0;
    let principalPaid = 0;
    let paidOffThisMonth = [];
    let newlyFreedMinimum = 0;

    for (const debt of activeThisMonth) {
      const beginningBalance = debt.remainingBalance;
      const monthlyInterest = roundMoney(beginningBalance * (debt.interestRate / 100 / 12));
      const balanceAfterInterest = roundMoney(beginningBalance + monthlyInterest);

      interestCharged += monthlyInterest;

      let paymentBudget = roundMoney(debt.minimumPayment);
      minimumPayments += roundMoney(debt.minimumPayment);

      if (targetDebt && debt.id === targetDebt.id) {
        paymentBudget = roundMoney(paymentBudget + extraPayment + rolledOverPayments);
        extraApplied = roundMoney(extraApplied + extraPayment + rolledOverPayments);
      }

      const actualPayment = roundMoney(Math.min(balanceAfterInterest, paymentBudget));
      const nextBalance = roundMoney(Math.max(0, balanceAfterInterest - actualPayment));

      principalPaid += roundMoney(actualPayment - monthlyInterest);
      debt.remainingBalance = nextBalance;

      if (nextBalance <= 0.00001) {
        debt.remainingBalance = 0;
        if (!payoffByDebtId.has(debt.id)) {
          payoffByDebtId.set(debt.id, toMonthKey(monthDate));
          paidOffThisMonth.push(debt.name);
          newlyFreedMinimum = roundMoney(newlyFreedMinimum + debt.minimumPayment);
        }
      }
    }

    totalInterestPaid = roundMoney(totalInterestPaid + interestCharged);
    const endingTotalDebt = roundMoney(debtsState.reduce((sum, debt) => sum + debt.remainingBalance, 0));

    schedule.push({
      monthKey: toMonthKey(monthDate),
      monthLabel: monthLabelFromDate(monthDate),
      targetedDebtId: targetDebt?.id || null,
      targetedDebtName: targetDebt?.name || '-',
      startingTotalDebt,
      minimumPayments: roundMoney(minimumPayments),
      extraPayment: roundMoney(extraApplied),
      interestCharged: roundMoney(interestCharged),
      principalPaid: roundMoney(Math.max(0, principalPaid)),
      endingTotalDebt,
      debtsPaidOff: paidOffThisMonth,
    });

    rolledOverPayments = roundMoney(rolledOverPayments + newlyFreedMinimum);
    monthDate = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1);
  }

  const projectedDebtFreeMonth = schedule.length
    ? schedule[schedule.length - 1].monthKey
    : toMonthKey(startMonthDate);

  const debtsWithProjection = normalizedDebts.map((debt) => {
    const payoffMonth = payoffByDebtId.get(debt.id) || (debt.status === 'paid' || debt.currentBalance <= 0 ? toMonthKey(startMonthDate) : null);
    return {
      ...debt,
      payoffMonth,
      payoffMonthLabel: payoffMonth ? monthLabelFromDate(monthFromKey(payoffMonth)) : '-',
      projectedRemainingBalance: debt.status === 'active'
        ? roundMoney(debtsState.find((d) => d.id === debt.id)?.remainingBalance ?? debt.currentBalance)
        : debt.currentBalance,
      targetRank: debt.status === 'active'
        ? (() => {
            const activeSorted = normalizedDebts
              .filter((d) => d.status === 'active' && d.currentBalance > 0)
              .slice()
              .sort((a, b) => compareDebtOrder(a, b, strategyKey));
            const idx = activeSorted.findIndex((d) => d.id === debt.id);
            return idx >= 0 ? idx + 1 : null;
          })()
        : null,
    };
  });

  const totalDebtBalance = roundMoney(activeDebts.reduce((sum, debt) => sum + debt.currentBalance, 0));
  const totalMinimumPayments = roundMoney(activeDebts.reduce((sum, debt) => sum + debt.minimumPayment, 0));

  return {
    strategy: strategyKey,
    extraMonthlyPayment: extraPayment,
    startingMonth: toMonthKey(startMonthDate),
    projectedDebtFreeMonth,
    projectedDebtFreeMonthLabel: monthLabelFromDate(monthFromKey(projectedDebtFreeMonth)),
    projectedInterestPaid: roundMoney(totalInterestPaid),
    totalDebtBalance,
    totalMinimumPayments,
    activeDebtCount: activeDebts.length,
    pausedDebtCount: pausedDebts.length,
    paidDebtCount: paidDebts.length,
    debts: debtsWithProjection,
    schedule,
  };
}
