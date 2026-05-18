/**
 * shared/transfers.js — Transfer plan and wants-actuals helpers.
 * No DOM, no fetch, no localStorage.
 */

import { isDateInBudgetPeriod } from './budgetPeriods.js';
import { toNumber } from './money.js';
import { normalizeText } from './text.js';

const DEFAULT_BUDGET_SPLIT = { Needs: 60, Wants: 20, 'Debts/Savings': 20 };
const BUDGET_CATEGORIES = ['Needs', 'Wants', 'Debts/Savings'];

export const TRANSFER_TARGET_KIND_OPTIONS = ['person', 'checking', 'savings', 'credit_card', 'debt', 'other'];
export const TRANSFER_BUDGET_GROUP_OPTIONS = ['Needs', 'Wants', 'Debt/Savings', 'Expense Funding'];
export const TRANSFER_ALLOCATION_METHOD_OPTIONS = ['equal_split', 'weighted_split', 'fixed_amount', 'percentage', 'remaining', 'priority_waterfall'];
export const CONNECTED_MODULE_OPTIONS = ['wants', 'expenses', 'debt_savings', 'none'];
export const CONFIRM_ACTION_OPTIONS = [
  'create_transfer_confirmation',
  'create_debt_savings_funding',
  'create_expense_funding',
  'none',
];

export const DEFAULT_TRANSFER_TARGETS = [
  {
    id: 'josh',
    name: 'Josh',
    active: true,
    targetKind: 'person',
    budgetGroup: 'Wants',
    allocationMethod: 'equal_split',
    weight: 1,
    fixedAmount: 0,
    percentage: 0,
    capAmount: 0,
    priority: 10,
    destinationAccountId: '',
    trackSpendingAgainstTarget: true,
    connectedModule: 'wants',
    confirmAction: 'create_transfer_confirmation',
    notes: '',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'taylor',
    name: 'Taylor',
    active: true,
    targetKind: 'person',
    budgetGroup: 'Wants',
    allocationMethod: 'equal_split',
    weight: 1,
    fixedAmount: 0,
    percentage: 0,
    capAmount: 0,
    priority: 20,
    destinationAccountId: '',
    trackSpendingAgainstTarget: true,
    connectedModule: 'wants',
    confirmAction: 'create_transfer_confirmation',
    notes: '',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'discover',
    name: 'Discover',
    active: true,
    targetKind: 'credit_card',
    budgetGroup: 'Expense Funding',
    allocationMethod: 'remaining',
    weight: 0,
    fixedAmount: 0,
    percentage: 0,
    capAmount: 0,
    priority: 1,
    destinationAccountId: '',
    trackSpendingAgainstTarget: false,
    connectedModule: 'expenses',
    confirmAction: 'create_expense_funding',
    notes: '',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'debt-savings',
    name: 'Debt/Savings',
    active: true,
    targetKind: 'savings',
    budgetGroup: 'Debt/Savings',
    allocationMethod: 'remaining',
    weight: 0,
    fixedAmount: 0,
    percentage: 0,
    capAmount: 0,
    priority: 2,
    destinationAccountId: '',
    trackSpendingAgainstTarget: false,
    connectedModule: 'debt_savings',
    confirmAction: 'create_debt_savings_funding',
    notes: '',
    createdAt: '',
    updatedAt: '',
  },
];

function normalizeGroupName(value) {
  const key = normalizeText(value);
  if (key === 'needs') return 'Needs';
  if (key === 'wants') return 'Wants';
  if (key === 'debts/savings' || key === 'debt/savings' || key === 'debtsavings' || key === 'debts' || key === 'savings') {
    return 'Debts/Savings';
  }
  return null;
}

function normalizeTargetBudgetGroup(value, fallback = 'Wants') {
  const key = normalizeText(value);
  if (key === 'needs') return 'Needs';
  if (key === 'wants') return 'Wants';
  if (key === 'debt/savings' || key === 'debts/savings' || key === 'debtsavings' || key === 'debt savings' || key === 'savings') return 'Debt/Savings';
  if (key === 'expense funding' || key === 'expense_funding' || key === 'expenses') return 'Expense Funding';
  return fallback;
}

function normalizeTargetKind(value, fallback = 'other') {
  const key = normalizeText(value);
  if (key === 'expense_funding') return 'credit_card';
  const normalized = String(value || '').trim();
  return TRANSFER_TARGET_KIND_OPTIONS.includes(normalized) ? normalized : fallback;
}

function normalizeAllocationMethod(value, fallback = 'remaining') {
  const key = normalizeText(value);
  if (key === 'equal_split_remaining') return 'equal_split';
  if (key === 'expense_budget_funding') return 'remaining';
  if (key === 'remaining_after_redirect') return 'remaining';
  const normalized = String(value || '').trim();
  return TRANSFER_ALLOCATION_METHOD_OPTIONS.includes(normalized) ? normalized : fallback;
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return value === true;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || '').trim();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSplitInput(splitSettings = {}) {
  const source = splitSettings?.default && typeof splitSettings.default === 'object'
    ? splitSettings.default
    : splitSettings;

  const needs = toNumber(source.Needs ?? source.needs_percent ?? DEFAULT_BUDGET_SPLIT.Needs, DEFAULT_BUDGET_SPLIT.Needs);
  const wants = toNumber(source.Wants ?? source.wants_percent ?? DEFAULT_BUDGET_SPLIT.Wants, DEFAULT_BUDGET_SPLIT.Wants);
  const debtsSavings = toNumber(
    source['Debts/Savings'] ?? source.debts_savings_percent ?? DEFAULT_BUDGET_SPLIT['Debts/Savings'],
    DEFAULT_BUDGET_SPLIT['Debts/Savings']
  );

  return {
    Needs: needs,
    Wants: wants,
    'Debts/Savings': debtsSavings,
  };
}

function normalizeTarget(target, fallback = {}) {
  return {
    id: String(target?.id || fallback.id || '').trim(),
    name: String(target?.name || fallback.name || '').trim(),
    active: normalizeBoolean(target?.active, fallback.active !== false),
    targetKind: normalizeTargetKind(target?.targetKind, fallback.targetKind || 'other'),
    budgetGroup: normalizeTargetBudgetGroup(target?.budgetGroup, fallback.budgetGroup || 'Wants'),
    allocationMethod: normalizeAllocationMethod(target?.allocationMethod, fallback.allocationMethod || 'remaining'),
    weight: Math.max(0, normalizeNumber(target?.weight, fallback.weight || 0)),
    fixedAmount: Math.max(0, normalizeNumber(target?.fixedAmount, fallback.fixedAmount || 0)),
    percentage: Math.max(0, normalizeNumber(target?.percentage, fallback.percentage || 0)),
    capAmount: Math.max(0, normalizeNumber(target?.capAmount, fallback.capAmount || 0)),
    priority: normalizeNumber(target?.priority, fallback.priority || 0),
    destinationAccountId: String(target?.destinationAccountId || fallback.destinationAccountId || '').trim(),
    trackSpendingAgainstTarget: normalizeBoolean(target?.trackSpendingAgainstTarget, fallback.trackSpendingAgainstTarget === true),
    connectedModule: normalizeEnum(target?.connectedModule, CONNECTED_MODULE_OPTIONS, fallback.connectedModule || 'none'),
    confirmAction: normalizeEnum(target?.confirmAction, CONFIRM_ACTION_OPTIONS, fallback.confirmAction || 'none'),
    notes: String(target?.notes || fallback.notes || '').trim(),
    createdAt: String(target?.createdAt || fallback.createdAt || '').trim(),
    updatedAt: String(target?.updatedAt || fallback.updatedAt || '').trim(),
  };
}

function getConfiguredTargets(value = {}) {
  if (Array.isArray(value?.targets)) return value.targets;
  if (Array.isArray(value)) return value;
  return [];
}

function sortTargets(targets = []) {
  return targets
    .slice()
    .sort((a, b) => toNumber(a.priority, 0) - toNumber(b.priority, 0) || String(a.name || '').localeCompare(String(b.name || '')));
}

function roundMoney(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

function buildLegacyTargetAliases(targets = []) {
  const map = new Map();
  for (const target of targets) {
    map.set(normalizeText(target.id), target);
    map.set(normalizeText(target.name), target);
  }
  return map;
}

function buildWantsActualAliases(targetRows = []) {
  const aliases = buildLegacyTargetAliases(targetRows);
  const josh = aliases.get('josh');
  const taylor = aliases.get('taylor');
  return {
    joshDirect: toNumber(josh?.directSpent, 0),
    taylorDirect: toNumber(taylor?.directSpent, 0),
    joshSplitShare: toNumber(josh?.splitShare, 0),
    taylorSplitShare: toNumber(taylor?.splitShare, 0),
    joshActual: toNumber(josh?.actualSpent, 0),
    taylorActual: toNumber(taylor?.actualSpent, 0),
  };
}

function buildTransferAliases(targetRows = []) {
  const aliases = buildLegacyTargetAliases(targetRows);
  const josh = aliases.get('josh');
  const taylor = aliases.get('taylor');
  const discover = aliases.get('discover');
  const debtSavings = aliases.get('debt/savings') || aliases.get('debt-savings');
  return {
    joshTarget: josh,
    taylorTarget: taylor,
    discoverTargetRow: discover,
    debtSavingsTargetRow: debtSavings,
  };
}

function buildLegacyWantsActualRows(wantsTargets = [], wantsActuals = {}) {
  const aliases = {
    josh: {
      targetId: 'josh',
      actualSpent: toNumber(wantsActuals?.joshActual, 0),
      directSpent: toNumber(wantsActuals?.joshDirect, 0),
      splitShare: toNumber(wantsActuals?.joshSplitShare, 0),
    },
    taylor: {
      targetId: 'taylor',
      actualSpent: toNumber(wantsActuals?.taylorActual, 0),
      directSpent: toNumber(wantsActuals?.taylorDirect, 0),
      splitShare: toNumber(wantsActuals?.taylorSplitShare, 0),
    },
  };

  return wantsTargets
    .map((target) => aliases[normalizeText(target.id)] || aliases[normalizeText(target.name)])
    .filter(Boolean);
}

function allocateProportionalPool(targets = [], availableAmount = 0, weightResolver) {
  const totalAvailable = Math.max(0, toNumber(availableAmount, 0));
  if (!targets.length || totalAvailable <= 0) return new Map();
  const resolvedWeights = targets.map((target) => Math.max(0, toNumber(weightResolver(target), 0)));
  const totalWeight = resolvedWeights.reduce((sum, value) => sum + value, 0);
  const fallbackWeight = totalWeight > 0 ? null : 1;
  const effectiveTotalWeight = totalWeight > 0 ? totalWeight : targets.length;
  const allocations = new Map();
  let allocatedSoFar = 0;

  targets.forEach((target, index) => {
    const weight = fallbackWeight === null ? resolvedWeights[index] : fallbackWeight;
    const rawAllocation = index === targets.length - 1
      ? totalAvailable - allocatedSoFar
      : (totalAvailable * weight) / effectiveTotalWeight;
    const roundedAllocation = roundMoney(rawAllocation);
    const maxAllocation = target.capAmount > 0 ? Math.min(roundedAllocation, target.capAmount) : roundedAllocation;
    allocations.set(target.id, Math.max(0, maxAllocation));
    allocatedSoFar += Math.max(0, maxAllocation);
  });

  return allocations;
}

function allocateTargetGroup(targets = [], availableAmount = 0, options = {}) {
  const normalizedTargets = sortTargets(targets);
  const totalAvailable = Math.max(0, toNumber(availableAmount, 0));
  const baseAmount = Math.max(0, toNumber(options.baseAmount, totalAvailable));
  const percentageBaseAmount = Math.max(0, toNumber(options.percentageBaseAmount, baseAmount));
  let remainingPool = totalAvailable;
  const resultById = new Map();

  normalizedTargets.forEach((target) => {
    resultById.set(target.id, {
      targetId: target.id,
      requestedAmount: 0,
      allocatedAmount: 0,
      remainingPoolAfter: totalAvailable,
    });
  });

  const proportionalTargets = [];
  const remainingTargets = [];

  for (const target of normalizedTargets) {
    if (target.allocationMethod === 'equal_split' || target.allocationMethod === 'weighted_split') {
      proportionalTargets.push(target);
      continue;
    }
    if (target.allocationMethod === 'remaining') {
      remainingTargets.push(target);
      continue;
    }

    const row = resultById.get(target.id);
    let requestedAmount = 0;
    if (target.allocationMethod === 'fixed_amount') {
      requestedAmount = target.fixedAmount;
    } else if (target.allocationMethod === 'percentage') {
      requestedAmount = percentageBaseAmount * (target.percentage / 100);
    } else if (target.allocationMethod === 'priority_waterfall') {
      requestedAmount = target.capAmount > 0
        ? target.capAmount
        : target.fixedAmount > 0
          ? target.fixedAmount
          : target.percentage > 0
            ? percentageBaseAmount * (target.percentage / 100)
            : remainingPool;
    }

    requestedAmount = roundMoney(Math.max(0, requestedAmount));
    const cappedRequest = target.capAmount > 0 ? Math.min(requestedAmount, target.capAmount) : requestedAmount;
    const allocatedAmount = roundMoney(Math.max(0, Math.min(remainingPool, cappedRequest)));
    row.requestedAmount = requestedAmount;
    row.allocatedAmount = allocatedAmount;
    remainingPool = roundMoney(Math.max(0, remainingPool - allocatedAmount));
    row.remainingPoolAfter = remainingPool;
  }

  if (proportionalTargets.length) {
    const proportionalPool = remainingPool;
    const allocations = allocateProportionalPool(
      proportionalTargets,
      proportionalPool,
      (target) => (target.allocationMethod === 'weighted_split' ? Math.max(0, target.weight || 0) : 1)
    );
    let proportionalAllocated = 0;
    for (const target of proportionalTargets) {
      const allocatedAmount = roundMoney(Math.max(0, allocations.get(target.id) || 0));
      const row = resultById.get(target.id);
      row.requestedAmount = allocatedAmount;
      row.allocatedAmount = allocatedAmount;
      proportionalAllocated += allocatedAmount;
    }
    remainingPool = roundMoney(Math.max(0, remainingPool - proportionalAllocated));
    proportionalTargets.forEach((target) => {
      resultById.get(target.id).remainingPoolAfter = remainingPool;
    });
  }

  for (const target of remainingTargets) {
    const row = resultById.get(target.id);
    const requestedAmount = roundMoney(Math.max(0, remainingPool));
    const cappedRequest = target.capAmount > 0 ? Math.min(requestedAmount, target.capAmount) : requestedAmount;
    const allocatedAmount = roundMoney(Math.max(0, Math.min(remainingPool, cappedRequest)));
    row.requestedAmount = requestedAmount;
    row.allocatedAmount = allocatedAmount;
    remainingPool = roundMoney(Math.max(0, remainingPool - allocatedAmount));
    row.remainingPoolAfter = remainingPool;
  }

  return {
    rows: normalizedTargets.map((target) => ({ ...resultById.get(target.id) })),
    remainingPool,
  };
}

function findWantsTargetForCategory(targets = [], category) {
  const key = normalizeText(category);
  return targets.find((target) => normalizeText(target.name) === key || normalizeText(target.id) === key) || null;
}

export function isTransferTargetsConfigMissing(value = {}) {
  return getConfiguredTargets(value).length === 0;
}

export function getTransferTargetsConfig(value = {}) {
  const configuredTargets = getConfiguredTargets(value);
  const sourceTargets = configuredTargets.length ? configuredTargets : DEFAULT_TRANSFER_TARGETS;
  return sortTargets(
    sourceTargets
      .map((target) => normalizeTarget(target))
      .filter((target) => target.id && target.name)
  );
}

export function getTransferTargetById(targetId, value = {}) {
  return getTransferTargetsConfig(value).find((target) => target.id === targetId) || null;
}

/**
 * Calculate how the budget income is split across Needs / Wants / Debts/Savings
 * categories, taking recurring bills as actuals for each category.
 */
export function calculateBudgetSplit({ budgetIncome, recurringBillsDue = [], splitSettings = {} }) {
  const income = toNumber(budgetIncome, 0);
  const percents = normalizeSplitInput(splitSettings);
  const percentTotal =
    toNumber(percents.Needs, 0) +
    toNumber(percents.Wants, 0) +
    toNumber(percents['Debts/Savings'], 0);

  const actualByGroup = {
    Needs: 0,
    Wants: 0,
    'Debts/Savings': 0,
  };

  for (const bill of recurringBillsDue || []) {
    if (!bill) continue;
    const group = normalizeGroupName(bill.budget_group ?? bill.category);
    if (!group) continue;
    actualByGroup[group] += Math.abs(toNumber(bill.amount, 0));
  }

  const rows = BUDGET_CATEGORIES.map((category) => {
    const percent = toNumber(percents[category], 0);
    const allotted = (income * percent) / 100;
    const actual = actualByGroup[category] || 0;
    return {
      category,
      percent,
      allotted,
      actual,
      remaining: allotted - actual,
    };
  });

  const totalActual = rows.reduce((sum, row) => sum + toNumber(row.actual, 0), 0);
  const isValid = Math.abs(percentTotal - 100) < 0.0001;

  return {
    rows,
    total: {
      percent: percentTotal,
      allotted: income,
      actual: totalActual,
      remaining: income - totalActual,
    },
    validation: {
      percentTotal,
      isValid,
    },
  };
}

/**
 * Return Wants-type transactions in the period with per-target spending.
 */
export function calculateWantsActuals({ transactions = [], period, transferTargets = {} }) {
  const wantsRows = (transactions || []).filter((row) => {
    if (!row || row.ignored) return false;
    if (normalizeText(row.type) !== 'wants') return false;
    return isDateInBudgetPeriod(row.date, period);
  });

  const allTargets = getTransferTargetsConfig(transferTargets);
  const wantsTargets = allTargets.filter((target) => target.active !== false && target.budgetGroup === 'Wants');
  const trackingTargets = wantsTargets.filter((target) => target.trackSpendingAgainstTarget);
  const targetRows = wantsTargets.map((target) => ({
    targetId: target.id,
    name: target.name,
    allocationMethod: target.allocationMethod,
    weight: target.weight,
    trackSpendingAgainstTarget: target.trackSpendingAgainstTarget === true,
    directSpent: 0,
    splitShare: 0,
    actualSpent: 0,
  }));
  const targetRowById = new Map(targetRows.map((row) => [row.targetId, row]));
  let splitTotal = 0;

  for (const row of wantsRows) {
    const amount = Math.abs(toNumber(row.amount, 0));
    const directTarget = findWantsTargetForCategory(wantsTargets, row.category || '');
    if (directTarget && targetRowById.has(directTarget.id)) {
      targetRowById.get(directTarget.id).directSpent += amount;
      continue;
    }
    if (normalizeText(row.category || '') === 'split') {
      splitTotal += amount;
    }
  }

  const splitTargets = trackingTargets.length ? trackingTargets : wantsTargets;
  const splitAllocations = allocateProportionalPool(
    splitTargets,
    splitTotal,
    (target) => (target.allocationMethod === 'weighted_split' ? Math.max(0, target.weight || 0) : 1)
  );

  for (const target of splitTargets) {
    const targetRow = targetRowById.get(target.id);
    if (!targetRow) continue;
    targetRow.splitShare = roundMoney(splitAllocations.get(target.id) || 0);
  }

  targetRows.forEach((row) => {
    row.directSpent = roundMoney(row.directSpent);
    row.actualSpent = roundMoney(row.directSpent + row.splitShare);
  });

  const aliases = buildWantsActualAliases(targetRows);

  return {
    wantsRows,
    targets: targetRows,
    splitTotal: roundMoney(splitTotal),
    ...aliases,
  };
}

/**
 * Calculate transfer amounts from budget split, expense funding, and transfer targets.
 */
export function calculateTransferPlan({ splitSummary, expenseBudget, wantsActuals, transferTargets = {}, budgetIncome = 0 }) {
  const splitRowByCategory = {};
  for (const row of splitSummary?.rows || []) {
    splitRowByCategory[row.category] = row;
  }

  const allTargets = getTransferTargetsConfig(transferTargets);
  const wantsTargets = allTargets.filter((target) => target.active !== false && target.budgetGroup === 'Wants');
  const needsTargets = allTargets.filter((target) => target.active !== false && target.budgetGroup === 'Needs');
  const expenseFundingTargets = allTargets.filter((target) => target.active !== false && target.budgetGroup === 'Expense Funding');
  const debtSavingsTargets = allTargets.filter((target) => target.active !== false && target.budgetGroup === 'Debt/Savings');

  const wantsRemaining = toNumber(splitRowByCategory.Wants?.remaining, 0);
  const needsRemaining = toNumber(splitRowByCategory.Needs?.remaining, 0);
  const debtSavingsRemaining = toNumber(splitRowByCategory['Debts/Savings']?.remaining, 0);

  const wantsActualRows = Array.isArray(wantsActuals?.targets) && wantsActuals.targets.length
    ? wantsActuals.targets
    : buildLegacyWantsActualRows(wantsTargets, wantsActuals);
  const wantsTargetById = new Map(wantsActualRows.map((row) => [row.targetId, row]));
  const wantsAllocation = allocateTargetGroup(wantsTargets, Math.max(0, wantsRemaining), {
    baseAmount: Math.max(0, wantsRemaining),
    percentageBaseAmount: Math.max(0, wantsRemaining),
  });

  const wantsRows = wantsTargets.map((target) => {
    const allocationRow = wantsAllocation.rows.find((row) => row.targetId === target.id) || { requestedAmount: 0, allocatedAmount: 0 };
    const spendingRow = wantsTargetById.get(target.id) || { directSpent: 0, splitShare: 0, actualSpent: 0 };
    const plannedAmount = roundMoney(allocationRow.requestedAmount || allocationRow.allocatedAmount || 0);
    const alreadyUsed = roundMoney(spendingRow.actualSpent || 0);
    return {
      targetId: target.id,
      targetName: target.name,
      budgetGroup: target.budgetGroup,
      allocationMethod: target.allocationMethod,
      priority: target.priority,
      weight: target.weight,
      plannedAmount,
      alreadyUsed,
      transferNeeded: roundMoney(Math.max(0, toNumber(allocationRow.allocatedAmount, 0) - alreadyUsed)),
      overused: roundMoney(Math.max(0, alreadyUsed - toNumber(allocationRow.allocatedAmount, 0))),
      spendingTracked: target.trackSpendingAgainstTarget === true,
      directSpent: roundMoney(spendingRow.directSpent || 0),
      splitShare: roundMoney(spendingRow.splitShare || 0),
      actualSpent: roundMoney(spendingRow.actualSpent || 0),
    };
  });

  const needsAllocation = allocateTargetGroup(needsTargets, Math.max(0, needsRemaining), {
    baseAmount: Math.max(0, needsRemaining),
    percentageBaseAmount: Math.max(0, needsRemaining),
  });
  const needsTransferAllocated = needsAllocation.rows.reduce((sum, row) => sum + toNumber(row.allocatedAmount, 0), 0);
  const needsAvailableForExpenseFunding = roundMoney(Math.max(0, Math.max(0, needsRemaining) - needsTransferAllocated));

  const expenseFundingDemand = Math.max(0, toNumber(expenseBudget?.totalExpenseBudget, 0));
  const needsToExpenseFunding = Math.min(needsAvailableForExpenseFunding, expenseFundingDemand);
  const shortfallAfterNeeds = roundMoney(Math.max(0, expenseFundingDemand - needsToExpenseFunding));
  const debtSavingsRedirect = roundMoney(Math.min(Math.max(0, debtSavingsRemaining), shortfallAfterNeeds));
  const discoverTarget = expenseFundingDemand;
  const expenseFundingAvailable = roundMoney(needsToExpenseFunding + debtSavingsRedirect);
  const expenseFundingAllocation = allocateTargetGroup(expenseFundingTargets, expenseFundingAvailable, {
    baseAmount: expenseFundingDemand,
    percentageBaseAmount: Math.max(0, budgetIncome || splitSummary?.total?.allotted || 0),
  });

  const expenseFundingRows = expenseFundingTargets.map((target) => {
    const allocationRow = expenseFundingAllocation.rows.find((row) => row.targetId === target.id) || { requestedAmount: 0, allocatedAmount: 0 };
    return {
      targetId: target.id,
      targetName: target.name,
      budgetGroup: target.budgetGroup,
      allocationMethod: target.allocationMethod,
      priority: target.priority,
      plannedAmount: roundMoney(allocationRow.requestedAmount || 0),
      alreadyUsed: 0,
      transferNeeded: roundMoney(allocationRow.allocatedAmount || 0),
      overused: 0,
    };
  });
  const expenseFundingTransferTotal = expenseFundingRows.reduce((sum, row) => sum + toNumber(row.transferNeeded, 0), 0);
  const discoverShortfall = roundMoney(Math.max(0, expenseFundingDemand - expenseFundingTransferTotal));

  const debtSavingsAvailableAfterRedirect = roundMoney(Math.max(0, Math.max(0, debtSavingsRemaining) - debtSavingsRedirect));
  const debtSavingsAllocation = allocateTargetGroup(debtSavingsTargets, debtSavingsAvailableAfterRedirect, {
    baseAmount: debtSavingsAvailableAfterRedirect,
    percentageBaseAmount: Math.max(0, budgetIncome || splitSummary?.total?.allotted || 0),
  });

  const debtSavingsRows = debtSavingsTargets.map((target) => {
    const allocationRow = debtSavingsAllocation.rows.find((row) => row.targetId === target.id) || { requestedAmount: 0, allocatedAmount: 0 };
    return {
      targetId: target.id,
      targetName: target.name,
      budgetGroup: target.budgetGroup,
      allocationMethod: target.allocationMethod,
      priority: target.priority,
      plannedAmount: roundMoney(allocationRow.requestedAmount || allocationRow.allocatedAmount || 0),
      alreadyUsed: 0,
      transferNeeded: roundMoney(allocationRow.allocatedAmount || 0),
      overused: 0,
    };
  });

  const needsRows = needsTargets.map((target) => {
    const allocationRow = needsAllocation.rows.find((row) => row.targetId === target.id) || { requestedAmount: 0, allocatedAmount: 0 };
    return {
      targetId: target.id,
      targetName: target.name,
      budgetGroup: target.budgetGroup,
      allocationMethod: target.allocationMethod,
      priority: target.priority,
      plannedAmount: roundMoney(allocationRow.requestedAmount || allocationRow.allocatedAmount || 0),
      alreadyUsed: 0,
      transferNeeded: roundMoney(allocationRow.allocatedAmount || 0),
      overused: 0,
    };
  });

  const targetRows = [...wantsRows, ...needsRows, ...expenseFundingRows, ...debtSavingsRows]
    .map((row) => ({
      ...row,
      id: row.targetId,
      target: row.targetName,
      status: row.transferNeeded > 0 ? 'Transfer needed' : 'Covered',
    }));

  const totalPlannedTransfers = roundMoney(targetRows.reduce((sum, row) => sum + Math.max(0, toNumber(row.transferNeeded, 0)), 0));
  const aliases = buildTransferAliases(targetRows);
  const joshBaseShare = roundMoney(aliases.joshTarget?.plannedAmount || 0);
  const taylorBaseShare = roundMoney(aliases.taylorTarget?.plannedAmount || 0);
  const joshTransfer = roundMoney(aliases.joshTarget?.transferNeeded || 0);
  const taylorTransfer = roundMoney(aliases.taylorTarget?.transferNeeded || 0);
  const joshOverused = roundMoney(aliases.joshTarget?.overused || 0);
  const taylorOverused = roundMoney(aliases.taylorTarget?.overused || 0);
  const discoverTransfer = roundMoney(aliases.discoverTargetRow?.transferNeeded || 0);
  const debtSavingsTransfer = roundMoney(aliases.debtSavingsTargetRow?.transferNeeded || 0);

  return {
    transferTargets: allTargets,
    targetRows,
    wantsRemaining,
    needsRemaining,
    debtSavingsRemaining,
    joshBaseShare,
    taylorBaseShare,
    joshTransfer,
    taylorTransfer,
    joshOverused,
    taylorOverused,
    discoverTarget,
    needsToDiscover: roundMoney(needsToExpenseFunding),
    debtSavingsRedirect,
    discoverTransfer,
    discoverShortfall,
    debtSavingsTransfer,
    totalPlannedTransfers,
  };
}

/**
 * Score how well a transaction matches a transfer checklist item.
 * Returns { score: 0-100, reasons: string[] }.
 */
export function scoreTransferMatch(checklistItem, transaction, options = {}) {
  if (!checklistItem || !transaction) return { score: 0, reasons: [] };

  const reasons = [];
  let score = 0;

  const expectedAmount = Math.abs(toNumber(checklistItem.amount, 0));
  const txnAmount = Math.abs(toNumber(transaction.amount, 0));

  if (expectedAmount > 0 && Math.abs(expectedAmount - txnAmount) < 0.01) {
    score += 50;
    reasons.push('Exact amount match');
  } else if (expectedAmount > 0 && Math.abs(expectedAmount - txnAmount) / expectedAmount < 0.05) {
    score += 25;
    reasons.push('Close amount match');
  }

  const targetKey = normalizeText(checklistItem.targetKey || checklistItem.target || '');
  const txnText = normalizeText(
    [transaction.name, transaction.merchant_name, transaction.description].filter(Boolean).join(' ')
  );
  if (targetKey && txnText.includes(targetKey)) {
    score += 30;
    reasons.push('Target name in transaction');
  }

  return { score: Math.min(100, score), reasons };
}

/**
 * Evaluate completion status of a transfer checklist (array of { targetKey, amount, ... })
 * against actual transactions in the period.
 */
export function calculateTransferChecklistStatus(checklistItems = [], transactions = [], period, settings = {}) {
  const includePending =
    settings?.includePendingTransactions === true || settings?.includePending === true;

  const periodTxns = (transactions || []).filter((row) => {
    if (!row || row.ignored) return false;
    if (!includePending && row.pending) return false;
    return isDateInBudgetPeriod(row.date, period);
  });

  return (checklistItems || []).map((item) => {
    let bestMatch = null;
    let bestScore = 0;
    let bestReasons = [];

    for (const txn of periodTxns) {
      const { score, reasons } = scoreTransferMatch(item, txn, settings);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = txn;
        bestReasons = reasons;
      }
    }

    return {
      ...item,
      matchTransaction: bestMatch,
      matchScore: bestScore,
      matchReasons: bestReasons,
      completed: bestScore >= 50,
      completedAmount: bestMatch ? Math.abs(toNumber(bestMatch.amount, 0)) : 0,
    };
  });
}

/**
 * Flexible percentage-based budget split engine (Needs / Wants / Debts/Savings).
 * Actuals come from recurring bills due in the selected pay period.
 */
export function calculateFlexibleBudgetSplitEngine({
  budgetIncome = 0,
  recurringBillsDue = [],
  splitSettings = {},
}) {
  const income = toNumber(budgetIncome, 0);
  const percents = normalizeSplitInput(splitSettings);
  const percentTotal = toNumber(percents.Needs, 0) + toNumber(percents.Wants, 0) + toNumber(percents['Debts/Savings'], 0);

  const actualByGroup = {
    Needs: 0,
    Wants: 0,
    'Debts/Savings': 0,
  };

  for (const row of recurringBillsDue || []) {
    if (!row) continue;
    const group = normalizeGroupName(row.budget_group ?? row.category);
    if (!group) continue;
    actualByGroup[group] += Math.abs(toNumber(row.amount, 0));
  }

  const rows = BUDGET_CATEGORIES.map((group) => {
    const percent = toNumber(percents[group], 0);
    const allotted = income * percent / 100;
    const actual = actualByGroup[group] || 0;
    return {
      group,
      percent,
      allotted,
      actual,
      remaining: allotted - actual,
    };
  });

  const totalActual = rows.reduce((sum, row) => sum + toNumber(row.actual, 0), 0);
  const totalRemaining = income - totalActual;
  const deltaTo100 = 100 - percentTotal;
  const validation = {
    isValid: Math.abs(deltaTo100) < 0.0001,
    percentTotal,
    message:
      deltaTo100 > 0.0001
        ? 'Budget percentages must equal 100%. You still have ' + deltaTo100.toFixed(2) + '% unassigned.'
        : deltaTo100 < -0.0001
          ? 'Budget percentages exceed 100%. Reduce by ' + Math.abs(deltaTo100).toFixed(2) + '%. '
          : '',
  };

  return {
    income,
    rows,
    totals: {
      allotted: income,
      actual: totalActual,
      remaining: totalRemaining,
    },
    validation,
  };
}