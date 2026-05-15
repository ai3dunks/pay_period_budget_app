/**
 * shared/budgetPeriods.js — Pure budget period logic. No localStorage, no DOM.
 *
 * Note: getSelectedBudgetPeriod here takes (periods, selectedPeriodId) as pure
 * arguments. The frontend localStorage version lives in src/utils/budgetPeriods.js.
 */

import { parseLocalDate, addDays, toDateKey, isDateInRange } from './dates.js';

export { parseLocalDate, addDays, toDateKey } from './dates.js';

/**
 * Format a period's display label, e.g. "May 8 - May 21".
 * Uses displayEndDate (inclusive end), NOT exclusiveEndDate.
 */
export function formatBudgetPeriodLabel(period) {
  const start = parseLocalDate(period.startDate);
  const end = parseLocalDate(period.displayEndDate);
  const startLabel = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const endLabel = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return startLabel + ' - ' + endLabel;
}

/**
 * Generate an array of 14-day budget periods centered on anchorDate.
 * countBefore periods before the anchor + anchor itself + countAfter periods after.
 *
 * Each period: { id, startDate, displayEndDate, exclusiveEndDate, label }
 *   - startDate: YYYY-MM-DD inclusive
 *   - displayEndDate: YYYY-MM-DD inclusive (startDate + 13 days)
 *   - exclusiveEndDate: YYYY-MM-DD exclusive (startDate + 14 days)
 */
export function generateBudgetPeriods(anchorDate, countBefore, countAfter) {
  const anchor = parseLocalDate(anchorDate);
  const periods = [];
  for (let i = -countBefore; i <= countAfter; i += 1) {
    const start = addDays(anchor, i * 14);
    const displayEnd = addDays(start, 13);
    const exclusiveEnd = addDays(start, 14);
    const period = {
      id: toDateKey(start),
      startDate: toDateKey(start),
      displayEndDate: toDateKey(displayEnd),
      exclusiveEndDate: toDateKey(exclusiveEnd),
    };
    period.label = formatBudgetPeriodLabel(period);
    periods.push(period);
  }
  return periods;
}

/**
 * True if a date falls within a period's [startDate, exclusiveEndDate).
 */
export function isDateInBudgetPeriod(date, period) {
  if (!date || !period) return false;
  try {
    const target =
      typeof date === 'string'
        ? parseLocalDate(date)
        : new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return isDateInRange(target, period.startDate, period.exclusiveEndDate);
  } catch {
    return false;
  }
}

/**
 * Find the budget period that contains today.
 */
export function getCurrentBudgetPeriod(periods, today) {
  const d = today
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
    : (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); })();
  return periods.find((period) => isDateInBudgetPeriod(d, period)) || null;
}

/**
 * Pure: find a period by id from an array.
 * (Unlike the frontend version, does NOT read from localStorage.)
 */
export function getSelectedBudgetPeriod(periods, selectedPeriodId) {
  if (!selectedPeriodId || !Array.isArray(periods)) return null;
  return periods.find((p) => p.id === selectedPeriodId) || null;
}

/**
 * Return the period immediately before the given period (by position in the array).
 */
export function getPreviousBudgetPeriod(periods, period) {
  if (!periods || !period) return null;
  const idx = periods.findIndex((p) => p.id === period.id);
  if (idx <= 0) return null;
  return periods[idx - 1];
}

/**
 * Return the period immediately after the given period (by position in the array).
 */
export function getNextBudgetPeriod(periods, period) {
  if (!periods || !period) return null;
  const idx = periods.findIndex((p) => p.id === period.id);
  if (idx < 0 || idx >= periods.length - 1) return null;
  return periods[idx + 1];
}
