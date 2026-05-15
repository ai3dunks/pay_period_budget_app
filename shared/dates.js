/**
 * shared/dates.js — Pure date helpers. No DOM, no fetch, no localStorage.
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Parse a YYYY-MM-DD string to a local Date without timezone bugs.
 */
export function parseLocalDate(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('Invalid date value. Expected YYYY-MM-DD string.');
  }
  const trimmed = value.slice(0, 10);
  const parts = trimmed.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error('Invalid date format. Expected YYYY-MM-DD.');
  }
  const [year, month, day] = parts;
  return new Date(year, month - 1, day);
}

/**
 * Add N days to a date (accepts Date or YYYY-MM-DD string).
 */
export function addDays(dateOrString, days) {
  const base = typeof dateOrString === 'string' ? parseLocalDate(dateOrString) : dateOrString;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/**
 * Convert a Date (or YYYY-MM-DD string) to a YYYY-MM-DD key string.
 */
export function toDateKey(date) {
  const d = typeof date === 'string' ? parseLocalDate(date) : date;
  return [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join('-');
}

/**
 * Format a date value as a short human-readable string (e.g. "May 8, 2026").
 */
export function formatDate(value) {
  try {
    const d = typeof value === 'string' ? parseLocalDate(value) : value;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return String(value || '');
  }
}

/**
 * Format a date value as a very short string (e.g. "May 8").
 */
export function formatShortDate(value) {
  try {
    const d = typeof value === 'string' ? parseLocalDate(value) : value;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return String(value || '');
  }
}

/**
 * Test whether a date falls within [startDate, exclusiveEndDate).
 * All arguments may be Date objects or YYYY-MM-DD strings.
 */
export function isDateInRange(date, startDate, exclusiveEndDate) {
  try {
    const target =
      typeof date === 'string'
        ? parseLocalDate(date)
        : new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const start =
      typeof startDate === 'string' ? parseLocalDate(startDate) : startDate;
    const end =
      typeof exclusiveEndDate === 'string'
        ? parseLocalDate(exclusiveEndDate)
        : exclusiveEndDate;
    return target >= start && target < end;
  } catch {
    return false;
  }
}

/**
 * Lexicographic comparison of YYYY-MM-DD key strings (a before b → negative).
 */
export function compareDateKeys(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

/**
 * Return today's date as a YYYY-MM-DD string (local time).
 */
export function getTodayDateKey() {
  return toDateKey(new Date());
}
