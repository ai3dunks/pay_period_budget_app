/**
 * shared/validation.js — Input validation helpers for budget domain entities.
 * No DOM, no fetch, no localStorage.
 */

export const VALID_TRANSACTION_TYPES = [
  'Income',
  'Expense',
  'Bills',
  'Wants',
  'Transfer',
  'Debt Payment',
  'Ignore',
];

export const VALID_RECURRING_BILL_CATEGORIES = ['Needs', 'Wants', 'Debts/Savings'];

const VALID_CATEGORIES_BY_TYPE = {
  Income: ['Paycheck', 'Bonus', 'Other Income'],
  Bills: ['Needs', 'Wants', 'Debts/Savings'],
  Wants: ['Josh', 'Taylor', 'Split'],
  Transfer: ['In', 'Out'],
  'Debt Payment': ['Additional Payment'],
  Ignore: ['Ignore'],
  // Expense categories are dynamic (from expense list) — not validated here
};

/**
 * Returns true if the period object has the required date fields.
 */
export function isValidPeriod(period) {
  if (!period || typeof period !== 'object') return false;
  return (
    typeof period.startDate === 'string' &&
    period.startDate.length >= 10 &&
    typeof period.exclusiveEndDate === 'string' &&
    period.exclusiveEndDate.length >= 10
  );
}

/**
 * Returns true if the value is a finite number (or numeric string).
 */
export function isValidMoneyAmount(value) {
  const n = Number(value);
  return Number.isFinite(n);
}

/**
 * Returns true if the value represents a non-negative finite number.
 * Used for budget assignment amounts (can be zero).
 */
export function isValidAssignmentAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

/**
 * Returns true if the value is one of the allowed recurring bill categories.
 */
export function isValidRecurringBillCategory(value) {
  return VALID_RECURRING_BILL_CATEGORIES.includes(value);
}

/**
 * Returns true if the value is one of the valid transaction types.
 */
export function isValidTransactionType(value) {
  return VALID_TRANSACTION_TYPES.includes(value);
}

/**
 * Returns true if the category is valid for the given transaction type.
 * Note: Expense categories are dynamic (from the expense list), so all
 * non-empty strings are accepted for type "Expense".
 */
export function isValidTransactionCategoryForType(type, category) {
  if (!isValidTransactionType(type)) return false;
  if (!category || typeof category !== 'string' || !category.trim()) return false;
  if (type === 'Expense') return true; // dynamic list
  const allowed = VALID_CATEGORIES_BY_TYPE[type];
  if (!allowed) return true; // unknown type — allow any non-empty category
  return allowed.includes(category);
}
