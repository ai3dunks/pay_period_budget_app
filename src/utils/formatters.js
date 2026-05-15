/**
 * Shared formatting helpers.
 */

export function formatCurrency(value) {
  return '$' + Math.abs(Number(value || 0)).toFixed(2);
}

export function formatSignedCurrency(value) {
  const amount = Number(value || 0);
  const prefix = amount < 0 ? '-' : amount > 0 ? '+' : '';
  return prefix + '$' + Math.abs(amount).toFixed(2);
}

export function formatDate(value) {
  if (!value) return '-';
  return String(value).slice(0, 10);
}

export function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Trim and collapse inner whitespace. */
export function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

/**
 * Normalise a comma-separated match-words string or array into a
 * deduplicated array of non-empty trimmed strings.
 */
export function normalizeMatchWordsInput(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const out = [];
  for (const word of source) {
    const trimmed = String(word || '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function getPeriodLabel(period) {
  if (!period) return 'Unavailable';
  return period.label;
}
