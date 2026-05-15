/**
 * shared/text.js — Pure text/string helpers. No DOM, no fetch, no localStorage.
 */

/**
 * Normalize a value for comparison: trim and lowercase.
 */
export function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Case-insensitive substring check (both strings normalized).
 */
export function includesNormalized(haystack, needle) {
  if (!needle || !haystack) return false;
  return normalizeText(haystack).includes(normalizeText(needle));
}

/**
 * Safely parse a JSON string. Returns fallback on error.
 * If the value is already an object, return it directly.
 */
export function parseJsonSafe(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Build a concatenated search string from all relevant transaction text fields,
 * including raw_json.original_description when available.
 */
export function extractSearchTextFromTransaction(transaction) {
  if (!transaction) return '';
  const raw = parseJsonSafe(transaction.raw_json);
  const fields = [
    transaction.name,
    transaction.description,
    transaction.merchant_name,
    typeof transaction.raw_json === 'string' ? transaction.raw_json : null,
    raw?.original_description,
    raw?.name,
    raw?.merchant_name,
  ];
  return fields.filter(Boolean).map((f) => String(f)).join(' ');
}

/**
 * Parse a match-words value into an array of normalized strings.
 * Input may be a string (space/comma separated), array, or null.
 */
export function parseMatchWords(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  return String(value)
    .split(/[\s,]+/)
    .map(normalizeText)
    .filter(Boolean);
}
