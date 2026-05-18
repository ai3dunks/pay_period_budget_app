/**
 * scripts/check-shared-domain.js
 *
 * Quick smoke test for shared/ pure domain functions.
 * Run with: node scripts/check-shared-domain.js
 */

import { generateBudgetPeriods, getCurrentBudgetPeriod, isDateInBudgetPeriod } from '../shared/budgetPeriods.js';
import { getDetectedPayrollIncome, isCiscoPayrollTransaction } from '../shared/payrollDetection.js';
import { getExpenseTransactionsForPeriod, calculateExpenseActuals } from '../shared/expenses.js';
import { calculateBudgetSplit, calculateWantsActuals, calculateTransferPlan, DEFAULT_TRANSFER_TARGETS } from '../shared/transfers.js';
import { applyRulesToTransactions } from '../shared/transactionRules.js';
import { isValidPeriod, isValidMoneyAmount, isValidTransactionType } from '../shared/validation.js';
import { parseMatchWords } from '../shared/text.js';
import { buildPayPeriodSummary } from '../shared/payPeriodSummary.js';

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log('  ✓', label);
    passed++;
  } else {
    console.error('  ✗', label, detail ? '— ' + detail : '');
    failed++;
  }
}

// ── 1. Budget periods ──────────────────────────────────────────────────────
console.log('\n[1] generateBudgetPeriods / isDateInBudgetPeriod');
const anchor = '2026-05-08';
const periods = generateBudgetPeriods(anchor, 2, 2);
assert('generates periods', Array.isArray(periods) && periods.length === 5);

const may8Period = periods.find((p) => p.startDate === '2026-05-08');
assert('May 8-21 period found', !!may8Period);
if (may8Period) {
  assert('May 8 in period', isDateInBudgetPeriod('2026-05-08', may8Period));
  assert('May 21 in period', isDateInBudgetPeriod('2026-05-21', may8Period));
  assert('May 22 NOT in period', !isDateInBudgetPeriod('2026-05-22', may8Period));
  assert('May 7 NOT in period', !isDateInBudgetPeriod('2026-05-07', may8Period));
}

const may22Period = periods.find((p) => p.startDate === '2026-05-22');
assert('May 22-June 4 period found', !!may22Period);
if (may22Period) {
  assert('May 22 in cross-month period', isDateInBudgetPeriod('2026-05-22', may22Period));
  assert('June 4 in cross-month period', isDateInBudgetPeriod('2026-06-04', may22Period));
  assert('June 5 NOT in cross-month period', !isDateInBudgetPeriod('2026-06-05', may22Period));
}

// ── 2. Payroll detection ──────────────────────────────────────────────────
console.log('\n[2] getDetectedPayrollIncome');
const testPeriod = { startDate: '2026-05-08', exclusiveEndDate: '2026-05-22', displayEndDate: '2026-05-21', id: 'test' };

const payrollTxns = [
  { id: 'p1', date: '2026-05-09', name: 'CISCO SYSTEMS DES:PAYROLL', amount: 3800, type: 'Income', category: 'Paycheck', pending: false, ignored: false },
];
const detected = getDetectedPayrollIncome(payrollTxns, testPeriod, {});
assert('single payroll detected', detected.detected === true, JSON.stringify(detected));
assert('payroll amount', detected.amount === 3800);
assert('no warning for single payroll', !detected.warning);

const multiPayrollTxns = [
  { id: 'p1', date: '2026-05-09', name: 'CISCO SYSTEMS DES:PAYROLL', amount: 3800, type: 'Income', category: 'Paycheck', pending: false, ignored: false },
  { id: 'p2', date: '2026-05-14', name: 'CISCO SYSTEMS DES:PAYROLL', amount: 3800, type: 'Income', category: 'Paycheck', pending: false, ignored: false },
];
const multiDetected = getDetectedPayrollIncome(multiPayrollTxns, testPeriod, {});
assert('multiple payrolls returns warning', !!multiDetected.warning, JSON.stringify(multiDetected));

const pendingPayrollOnly = [
  { id: 'pp1', date: '2026-05-10', name: 'CISCO SYSTEMS DES:PAYROLL', amount: 3800, type: 'Income', category: 'Paycheck', pending: true, ignored: false },
];
const pendingExcludedByDefault = getDetectedPayrollIncome(pendingPayrollOnly, testPeriod, {});
assert('pending payroll excluded by default', pendingExcludedByDefault.detected === false, JSON.stringify(pendingExcludedByDefault));
const pendingIncluded = getDetectedPayrollIncome(pendingPayrollOnly, testPeriod, { includePendingTransactions: true });
assert('pending payroll included when enabled', pendingIncluded.detected === true, JSON.stringify(pendingIncluded));

// ── 3. Expense transactions (pending excluded by default) ─────────────────
console.log('\n[3] getExpenseTransactionsForPeriod — pending excluded');
const expenseTxns = [
  { id: 'e1', date: '2026-05-10', type: 'Expense', category: 'Groceries', amount: -45, pending: false, ignored: false },
  { id: 'e2', date: '2026-05-11', type: 'Expense', category: 'Gas', amount: -60, pending: true, ignored: false },
];
const settings = { includePendingTransactions: false };
const expenseResult = getExpenseTransactionsForPeriod(expenseTxns, testPeriod, settings);
assert('non-pending expense included', expenseResult.some((t) => t.id === 'e1'));
assert('pending expense excluded by default', !expenseResult.some((t) => t.id === 'e2'));

const settingsWithPending = { includePendingTransactions: true };
const withPending = getExpenseTransactionsForPeriod(expenseTxns, testPeriod, settingsWithPending);
assert('pending expense included when setting is true', withPending.some((t) => t.id === 'e2'));

// ── 4. Wants split divides 50/50 ──────────────────────────────────────────
console.log('\n[4] calculateWantsActuals — 50/50 split');
const wantsTxns = [
  { id: 'w1', date: '2026-05-10', type: 'Wants', category: 'Split', amount: -100, pending: false, ignored: false },
  { id: 'w2', date: '2026-05-11', type: 'Wants', category: 'Josh', amount: -30, pending: false, ignored: false },
];
const wantsResult = calculateWantsActuals({ transactions: wantsTxns, period: testPeriod });
assert('Josh split share = 50', wantsResult.joshSplitShare === 50);
assert('Taylor split share = 50', wantsResult.taylorSplitShare === 50);
assert('Josh actual = 80 (50 split + 30 direct)', wantsResult.joshActual === 80);
assert('Taylor actual = 50', wantsResult.taylorActual === 50);

// ── 5. applyRulesToTransactions ───────────────────────────────────────────
console.log('\n[5] applyRulesToTransactions');
const rulesTestTxns = [
  { id: 'r1', name: 'Walmart Grocery', type: '', category: '', amount: -55, reviewed: false, ignored: false },
  { id: 'r2', name: 'Netflix', type: '', category: '', amount: -15, reviewed: false, ignored: false },
];
const rules = [
  { id: 1, enabled: true, match_value: 'walmart', match_type: 'contains', set_type: 'Expense', set_category: 'Groceries', apply_to_unreviewed_only: true },
  { id: 2, enabled: false, match_value: 'netflix', match_type: 'contains', set_type: 'Wants', set_category: 'Josh', apply_to_unreviewed_only: true },
];
const ruleResults = applyRulesToTransactions(rulesTestTxns, rules);
assert('Walmart rule applied', ruleResults.some((r) => r.transactionId === 'r1' && r.updates.type === 'Expense'));
assert('disabled Netflix rule not applied', !ruleResults.some((r) => r.transactionId === 'r2'));

// ── 6. Validation ─────────────────────────────────────────────────────────
console.log('\n[6] validation');
assert('valid period', isValidPeriod({ startDate: '2026-05-08', exclusiveEndDate: '2026-05-22' }));
assert('invalid period (missing exclusiveEndDate)', !isValidPeriod({ startDate: '2026-05-08' }));
assert('valid money amount', isValidMoneyAmount(100.5));
assert('invalid money amount (NaN)', !isValidMoneyAmount('abc'));
assert('valid transaction type', isValidTransactionType('Expense'));
assert('invalid transaction type', !isValidTransactionType('Random'));

// ── 7. parseMatchWords ───────────────────────────────────────────────────
console.log('\n[7] parseMatchWords');
const jsonWords = parseMatchWords('["capital one","cap one"]');
assert('JSON array string keeps phrases', JSON.stringify(jsonWords) === JSON.stringify(['capital one', 'cap one']), JSON.stringify(jsonWords));

const csvWords = parseMatchWords('capital one, cap one');
assert('comma-separated string keeps phrases', JSON.stringify(csvWords) === JSON.stringify(['capital one', 'cap one']), JSON.stringify(csvWords));

const arrayWords = parseMatchWords(['Capital One', 'cap one']);
assert('array input normalizes and dedupes', JSON.stringify(arrayWords) === JSON.stringify(['capital one', 'cap one']), JSON.stringify(arrayWords));

// ── 8. Safe Money math — unpaid/paid bills + BOA reserve ─────────────────
console.log('\n[8] safe money math');
const summaryPeriod = { id: 'p-safe', startDate: '2026-05-08', displayEndDate: '2026-05-21', exclusiveEndDate: '2026-05-22' };
const boaAccount = {
  id: 'acct-boa',
  name: 'Bank of America Checking',
  institutionName: 'Bank of America',
  subtype: 'checking',
  balanceCurrent: 1000,
};
const baseSummaryInput = {
  period: summaryPeriod,
  accounts: [boaAccount],
  transactions: [],
  expenseList: [],
  settings: {
    budget_income_by_period: { 'p-safe': 1000 },
    auto_detected_income_by_period: {},
    splitSettings: { Needs: 60, Wants: 20, 'Debts/Savings': 20 },
    safeMoneySettings: { safetyBuffer: 0, includePendingTransactions: false },
  },
};

const recurringBillsBoa = [
  { id: 'bill-boa', name: 'Credit Card', active: true, dueDay: 10, amount: 200, category: 'Needs', paidFrom: 'Checking - BOA' },
];
const summaryUnpaidBoa = buildPayPeriodSummary({
  ...baseSummaryInput,
  recurringBillsList: recurringBillsBoa,
  recurringBillStatuses: [],
});
const summaryPaidBoa = buildPayPeriodSummary({
  ...baseSummaryInput,
  recurringBillsList: recurringBillsBoa,
  recurringBillStatuses: [{ recurringBillId: 'bill-boa', paid: true }],
});
assert('unpaid bills reduce Safe to Spend', summaryUnpaidBoa.safeToSpend < summaryPaidBoa.safeToSpend, JSON.stringify({ unpaid: summaryUnpaidBoa.safeToSpend, paid: summaryPaidBoa.safeToSpend }));
assert('paid bills removed from unpaid total', summaryUnpaidBoa.recurringBills.unpaidTotal === 200 && summaryPaidBoa.recurringBills.unpaidTotal === 0, JSON.stringify({ unpaid: summaryUnpaidBoa.recurringBills.unpaidTotal, paid: summaryPaidBoa.recurringBills.unpaidTotal }));

const recurringBillsNonBoa = [
  { id: 'bill-non', name: 'Credit Card', active: true, dueDay: 10, amount: 200, category: 'Needs', paidFrom: 'Wells Checking' },
];
const summaryUnpaidNonBoa = buildPayPeriodSummary({
  ...baseSummaryInput,
  recurringBillsList: recurringBillsNonBoa,
  recurringBillStatuses: [],
});
assert('BOA unpaid bills reduce Safe to Transfer reserve', summaryUnpaidBoa.safeToTransfer < summaryUnpaidNonBoa.safeToTransfer, JSON.stringify({ boa: summaryUnpaidBoa.safeToTransfer, nonBoa: summaryUnpaidNonBoa.safeToTransfer }));

// ── 9. Final split expense expansion math ─────────────────────────────────
console.log('\n[9] final split expansion');
const splitExpensePeriod = { id: 'p-exp', startDate: '2026-05-08', exclusiveEndDate: '2026-05-22' };
const splitExpenseTxns = [
  {
    id: 'parent-1',
    date: '2026-05-10',
    type: 'Expense',
    category: 'Dining',
    amount: -100,
    ignored: false,
    pending: false,
    split_is_final: true,
    split_lines: [
      { category: 'Groceries', amount: 60 },
      { category: 'Gas', amount: 40 },
    ],
  },
];
const splitActuals = calculateExpenseActuals(splitExpenseTxns, [], splitExpensePeriod, { includePendingTransactions: true });
assert('final split parent does not double count', splitActuals.totalActual === 100, JSON.stringify({ totalActual: splitActuals.totalActual }));
assert('final split lines count by line category', splitActuals.byCategory.get('groceries') === 60 && splitActuals.byCategory.get('gas') === 40, JSON.stringify({ groceries: splitActuals.byCategory.get('groceries'), gas: splitActuals.byCategory.get('gas') }));

// ── 10. Transfer needed output math ───────────────────────────────────────
console.log('\n[10] transfer needed outputs');
const splitSummaryForPlan = calculateBudgetSplit({
  budgetIncome: 1000,
  recurringBillsDue: [
    { category: 'Needs', amount: 300 },
    { category: 'Wants', amount: 50 },
    { category: 'Debts/Savings', amount: 100 },
  ],
  splitSettings: { Needs: 60, Wants: 20, 'Debts/Savings': 20 },
});
const transferPlan = calculateTransferPlan({
  splitSummary: splitSummaryForPlan,
  expenseBudget: { totalExpenseBudget: 400 },
  wantsActuals: {
    joshActual: 20,
    taylorActual: 50,
  },
});
assert('Josh transfer expected', transferPlan.joshTransfer === 55, JSON.stringify(transferPlan));
assert('Taylor transfer expected', transferPlan.taylorTransfer === 25, JSON.stringify(transferPlan));
assert('Discover transfer expected', transferPlan.discoverTransfer === 400, JSON.stringify(transferPlan));
assert('Debt/Savings transfer expected', transferPlan.debtSavingsTransfer === 0, JSON.stringify(transferPlan));

const transferTargetsWithRiley = [
  ...DEFAULT_TRANSFER_TARGETS.filter((target) => target.id !== 'discover' && target.id !== 'debt-savings'),
  {
    id: 'riley',
    name: 'Riley',
    active: true,
    targetKind: 'person',
    budgetGroup: 'Wants',
    allocationMethod: 'equal_split',
    weight: 1,
    fixedAmount: 0,
    percentage: 0,
    capAmount: 0,
    priority: 30,
    destinationAccountId: '',
    trackSpendingAgainstTarget: true,
    connectedModule: 'wants',
    confirmAction: 'create_transfer_confirmation',
    notes: '',
    createdAt: '',
    updatedAt: '',
  },
  ...DEFAULT_TRANSFER_TARGETS.filter((target) => target.id === 'discover' || target.id === 'debt-savings'),
];

const rileyPlan = calculateTransferPlan({
  splitSummary: splitSummaryForPlan,
  expenseBudget: { totalExpenseBudget: 400 },
  wantsActuals: {
    targets: [
      { targetId: 'josh', actualSpent: 20, directSpent: 20, splitShare: 0 },
      { targetId: 'taylor', actualSpent: 50, directSpent: 50, splitShare: 0 },
      { targetId: 'riley', actualSpent: 10, directSpent: 10, splitShare: 0 },
    ],
  },
  transferTargets: transferTargetsWithRiley,
});
assert('Riley equal split adds third Wants target', rileyPlan.targetRows.filter((row) => row.budgetGroup === 'Wants').length === 3, JSON.stringify(rileyPlan.targetRows));
assert('Josh transfer becomes 30 with Riley active', rileyPlan.joshTransfer === 30, JSON.stringify(rileyPlan));
assert('Taylor transfer becomes 0 with Riley active', rileyPlan.taylorTransfer === 0, JSON.stringify(rileyPlan));
assert('Riley transfer becomes 40 with Riley active', (rileyPlan.targetRows.find((row) => row.id === 'riley')?.transferNeeded || 0) === 40, JSON.stringify(rileyPlan));

const rileyDisabledPlan = calculateTransferPlan({
  splitSummary: splitSummaryForPlan,
  expenseBudget: { totalExpenseBudget: 400 },
  wantsActuals: {
    targets: [
      { targetId: 'josh', actualSpent: 20, directSpent: 20, splitShare: 0 },
      { targetId: 'taylor', actualSpent: 50, directSpent: 50, splitShare: 0 },
      { targetId: 'riley', actualSpent: 10, directSpent: 10, splitShare: 0 },
    ],
  },
  transferTargets: transferTargetsWithRiley.map((target) => target.id === 'riley' ? { ...target, active: false } : target),
});
assert('Disabling Riley returns Josh transfer to 55', rileyDisabledPlan.joshTransfer === 55, JSON.stringify(rileyDisabledPlan));
assert('Disabling Riley returns Taylor transfer to 25', rileyDisabledPlan.taylorTransfer === 25, JSON.stringify(rileyDisabledPlan));
assert('Disabled Riley is removed from Wants target rows', !rileyDisabledPlan.targetRows.some((row) => row.id === 'riley'), JSON.stringify(rileyDisabledPlan.targetRows));

// ── Summary ───────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All checks passed!');
}
