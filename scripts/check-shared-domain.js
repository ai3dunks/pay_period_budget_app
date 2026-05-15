/**
 * scripts/check-shared-domain.js
 *
 * Quick smoke test for shared/ pure domain functions.
 * Run with: node scripts/check-shared-domain.js
 */

import { generateBudgetPeriods, getCurrentBudgetPeriod, isDateInBudgetPeriod } from '../shared/budgetPeriods.js';
import { getDetectedPayrollIncome, isCiscoPayrollTransaction } from '../shared/payrollDetection.js';
import { getExpenseTransactionsForPeriod } from '../shared/expenses.js';
import { calculateBoaRolloverFromLastPrePaycheckTransaction } from '../shared/boaRollover.js';
import { calculateBudgetSplit, calculateWantsActuals } from '../shared/transfers.js';
import { applyRulesToTransactions } from '../shared/transactionRules.js';
import { isValidPeriod, isValidMoneyAmount, isValidTransactionType } from '../shared/validation.js';

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

// ── 4. BOA rollover unavailable when running balance missing ──────────────
console.log('\n[4] calculateBoaRolloverFromLastPrePaycheckTransaction');
const accounts = [{ id: 'acc1', name: 'Bank of America Checking', subtype: 'checking', balanceCurrent: 500 }];
const txnsNoBalance = [
  { id: 't1', date: '2026-05-07', account_id: 'acc1', amount: -25, type: 'Expense', running_balance: null, pending: false, ignored: false },
  { id: 'p1', date: '2026-05-09', account_id: 'acc1', amount: 3800, name: 'CISCO SYSTEMS DES:PAYROLL', type: 'Income', running_balance: null, pending: false, ignored: false },
];
const rolloverNoBalance = calculateBoaRolloverFromLastPrePaycheckTransaction({
  accounts,
  transactions: txnsNoBalance,
  selectedPeriod: testPeriod,
});
assert('rollover unavailable when running_balance missing', rolloverNoBalance.canCalculate === false);

const txnsWithBalance = [
  { id: 't1', date: '2026-05-07', account_id: 'acc1', amount: -25, type: 'Expense', running_balance: 742.50, pending: false, ignored: false },
  { id: 'p1', date: '2026-05-09', account_id: 'acc1', amount: 3800, name: 'CISCO SYSTEMS DES:PAYROLL', type: 'Income', running_balance: 4542.50, pending: false, ignored: false },
];
const rolloverWithBalance = calculateBoaRolloverFromLastPrePaycheckTransaction({
  accounts,
  transactions: txnsWithBalance,
  selectedPeriod: testPeriod,
});
assert('rollover available when running_balance present', rolloverWithBalance.canCalculate === true);
assert('rollover amount = balance of last pre-paycheck txn', rolloverWithBalance.amount === 742.50);

// ── 5. Wants split divides 50/50 ──────────────────────────────────────────
console.log('\n[5] calculateWantsActuals — 50/50 split');
const wantsTxns = [
  { id: 'w1', date: '2026-05-10', type: 'Wants', category: 'Split', amount: -100, pending: false, ignored: false },
  { id: 'w2', date: '2026-05-11', type: 'Wants', category: 'Josh', amount: -30, pending: false, ignored: false },
];
const wantsResult = calculateWantsActuals({ transactions: wantsTxns, period: testPeriod });
assert('Josh split share = 50', wantsResult.joshSplitShare === 50);
assert('Taylor split share = 50', wantsResult.taylorSplitShare === 50);
assert('Josh actual = 80 (50 split + 30 direct)', wantsResult.joshActual === 80);
assert('Taylor actual = 50', wantsResult.taylorActual === 50);

// ── 6. applyRulesToTransactions ───────────────────────────────────────────
console.log('\n[6] applyRulesToTransactions');
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

// ── 7. Validation ─────────────────────────────────────────────────────────
console.log('\n[7] validation');
assert('valid period', isValidPeriod({ startDate: '2026-05-08', exclusiveEndDate: '2026-05-22' }));
assert('invalid period (missing exclusiveEndDate)', !isValidPeriod({ startDate: '2026-05-08' }));
assert('valid money amount', isValidMoneyAmount(100.5));
assert('invalid money amount (NaN)', !isValidMoneyAmount('abc'));
assert('valid transaction type', isValidTransactionType('Expense'));
assert('invalid transaction type', !isValidTransactionType('Random'));

// ── Summary ───────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All checks passed!');
}
