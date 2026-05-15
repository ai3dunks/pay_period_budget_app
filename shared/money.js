/**
 * shared/money.js — Pure money/number helpers. No DOM, no fetch, no localStorage.
 */

/**
 * Parse a value to a finite number, returning fallback if not parseable.
 */
export function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Round a money value to 2 decimal places.
 */
export function roundMoney(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

/**
 * Sum an array of money values.
 */
export function sumMoney(values = []) {
  return (values || []).reduce((sum, v) => sum + toNumber(v, 0), 0);
}

/**
 * Convert a signed spending amount to a positive display amount.
 * App convention: spending = negative, income = positive.
 * This returns Math.abs so the UI can display "you spent $X".
 */
export function toSpendingAmount(amount) {
  return Math.abs(toNumber(amount, 0));
}

/**
 * True if amount > 0 (income or credit).
 */
export function isPositiveAmount(amount) {
  return toNumber(amount, 0) > 0;
}

/**
 * True if amount < 0 (spending or debit).
 */
export function isNegativeAmount(amount) {
  return toNumber(amount, 0) < 0;
}
