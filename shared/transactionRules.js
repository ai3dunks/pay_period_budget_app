/**
 * shared/transactionRules.js — Transaction rule matching and application.
 * No DOM, no fetch, no localStorage.
 */

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function toBooleanFlag(value) {
  return value === true || value === 1 || value === '1';
}

function getOriginalDescription(transaction) {
  if (!transaction?.raw_json) return '';
  try {
    const raw =
      typeof transaction.raw_json === 'string'
        ? JSON.parse(transaction.raw_json)
        : transaction.raw_json;
    return String(raw?.original_description || raw?.payment_meta?.reference_number || '').trim();
  } catch {
    return '';
  }
}

function getMatchCandidates(transaction, matchType) {
  const candidates = {
    name: String(transaction?.name || '').trim(),
    merchant: String(transaction?.merchant_name || '').trim(),
    description: String(transaction?.description || '').trim(),
    originalDescription: getOriginalDescription(transaction),
  };
  if (matchType === 'merchant_contains') return [candidates.merchant];
  return [
    candidates.name,
    candidates.merchant,
    candidates.description,
    candidates.originalDescription,
  ];
}

function matchesByType(candidate, matchValue, matchType) {
  const haystack = normalizeText(candidate);
  const needle = normalizeText(matchValue);
  if (!needle || !haystack) return false;
  if (matchType === 'exact') return haystack === needle;
  if (matchType === 'starts_with') return haystack.startsWith(needle);
  return haystack.includes(needle);
}

function matchesRule(transaction, rule) {
  if (!rule || !toBooleanFlag(rule.enabled)) return false;

  const applyToUnreviewedOnly =
    rule.apply_to_unreviewed_only === undefined
      ? true
      : toBooleanFlag(rule.apply_to_unreviewed_only);

  if (applyToUnreviewedOnly && toBooleanFlag(transaction?.reviewed)) return false;

  const setsIgnored = toBooleanFlag(rule.set_ignored);
  if (toBooleanFlag(transaction?.ignored) && !setsIgnored) return false;

  if (
    rule.account_id &&
    transaction?.account_id !== rule.account_id &&
    transaction?.plaid_account_id !== rule.account_id
  ) {
    return false;
  }

  const amountAbs = Math.abs(Number(transaction?.amount || 0));
  const amountMin = toNumber(rule.amount_min);
  const amountMax = toNumber(rule.amount_max);
  if (amountMin !== null && amountAbs < amountMin) return false;
  if (amountMax !== null && amountAbs > amountMax) return false;

  const matchType = String(rule.match_type || 'contains').trim().toLowerCase();
  const candidates = getMatchCandidates(transaction, matchType);
  return candidates.some((candidate) => matchesByType(candidate, rule.match_value, matchType));
}

function buildRuleUpdate(transaction, rule) {
  const updates = {};
  if (rule.set_type !== undefined && rule.set_type !== null && rule.set_type !== '') {
    updates.type = rule.set_type;
  }
  if (rule.set_category !== undefined && rule.set_category !== null && rule.set_category !== '') {
    updates.category = rule.set_category;
  }
  if (toBooleanFlag(rule.set_ignored)) {
    updates.ignored = true;
    updates.type = 'Ignore';
    updates.category = 'Ignore';
  }
  if (!Object.keys(updates).length) return null;
  return {
    ...updates,
    reviewed: true,
    ignored: updates.ignored === true ? true : !!transaction?.ignored,
  };
}

/**
 * Apply all enabled rules to a list of transactions.
 * Each transaction gets at most one rule applied (first match wins).
 *
 * @param {Array} transactions
 * @param {Array} rules
 * @returns {Array} Array of { transactionId, transaction, ruleId, ruleName, updates, result }
 */
export function applyRulesToTransactions(transactions = [], rules = []) {
  const enabledRules = (rules || []).filter((rule) => toBooleanFlag(rule.enabled));
  const results = [];
  for (const transaction of transactions || []) {
    for (const rule of enabledRules) {
      if (!matchesRule(transaction, rule)) continue;
      const updates = buildRuleUpdate(transaction, rule);
      if (!updates) continue;
      results.push({
        transactionId: transaction.id,
        transaction,
        ruleId: rule.id,
        ruleName: rule.name || rule.match_value,
        updates,
        result: { ...transaction, ...updates },
      });
      break;
    }
  }
  return results;
}
