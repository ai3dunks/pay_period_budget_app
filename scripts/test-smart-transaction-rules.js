import { evaluateRulePreview } from '../shared/transactionRules.js';

const source = {
  id: 'source',
  date: '2026-05-11',
  merchant_name: 'Walmart',
  name: 'Walmart',
  amount: 124.37,
  pending: 0,
  reviewed: 0,
};

const other = {
  id: 'other',
  date: '2026-05-11',
  merchant_name: 'Walmart',
  name: 'Walmart',
  amount: 96.04,
  pending: 0,
  reviewed: 0,
};

const rawOnly = {
  id: 'raw-only',
  date: '2026-05-11',
  merchant_name: '',
  name: 'DEBIT PURCHASE 0516 9998&@#WM SUPERCENTER',
  amount: 23.64,
  pending: 0,
  reviewed: 0,
};

const rule = {
  enabled: 1,
  match_type: 'merchant_contains',
  match_value: 'walmart',
  apply_type: 'Expense',
  apply_category: 'Groceries',
  apply_reviewed: 1,
  apply_to_pending: 0,
  apply_to_unreviewed_only: 1,
  created_from_transaction_id: 'source',
};

const result = evaluateRulePreview(rule, [source, other, rawOnly], {
  excludeTransactionId: 'source',
});

const willApplyById = Object.fromEntries(result.preview.map((row) => [row.transactionId, row.willApply]));

const expectations = [
  ['source excluded', result.sourceTransactionExcluded === true],
  ['matchedCount = 2', result.matchedCount === 2],
  ['unreviewedMatchedCount = 2', result.unreviewedMatchedCount === 2],
  ['applyableCount = 2', result.applyableCount === 2],
  ['other will apply', willApplyById.other === true],
  ['rawOnly will apply', willApplyById['raw-only'] === true],
];

const failed = expectations.filter(([, passed]) => !passed);
console.log(JSON.stringify(result, null, 2));

if (failed.length) {
  console.error('Failed smart rule tests:', failed.map(([label]) => label).join(', '));
  process.exit(1);
}

console.log('Smart transaction rule tests passed.');
