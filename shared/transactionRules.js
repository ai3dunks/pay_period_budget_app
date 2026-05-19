/**
 * shared/transactionRules.js — Transaction rule matching and application.
 * No DOM, no fetch, no localStorage.
 */

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeDescription(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeMerchantName(value) {
  return normalizeDescription(value)
    .replace(/\b(store|supercenter|market|inc|llc|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value) {
  return normalizeDescription(value);
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
  if (matchType === 'merchant_contains' || matchType === 'merchant_equals') return [candidates.merchant];
  if (matchType === 'description_contains') return [candidates.name, candidates.description, candidates.originalDescription];
  return [
    candidates.name,
    candidates.merchant,
    candidates.description,
    candidates.originalDescription,
  ];
}

function matchesByType(candidate, matchValue, matchType) {
  const isMerchant = String(matchType || '').startsWith('merchant');
  const haystack = isMerchant ? normalizeMerchantName(candidate) : normalizeText(candidate);
  const needle = isMerchant ? normalizeMerchantName(matchValue) : normalizeText(matchValue);
  if (!needle || !haystack) return false;
  if (matchType === 'exact' || matchType === 'merchant_equals') return haystack === needle;
  if (matchType === 'starts_with') return haystack.startsWith(needle);
  return haystack.includes(needle);
}

export function transactionMatchesRule(transaction, rule) {
  if (!rule || !toBooleanFlag(rule.enabled)) return false;
  if (String(rule.confidence_mode || 'auto_apply') === 'ignore') return false;

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

  const matchType = String(rule.match_type || rule.match_operator || 'contains').trim().toLowerCase();
  if (!String(rule.match_value || '').trim()) return false;
  const candidates = getMatchCandidates(transaction, matchType);
  return candidates.some((candidate) => matchesByType(candidate, rule.match_value, matchType));
}

function buildRuleUpdate(transaction, rule) {
  const updates = {};
  const applyType = rule.apply_type ?? rule.set_type;
  const applyCategory = rule.apply_category ?? rule.set_category;
  if (applyType !== undefined && applyType !== null && applyType !== '') {
    updates.type = applyType;
  }
  if (applyCategory !== undefined && applyCategory !== null && applyCategory !== '') {
    updates.category = applyCategory;
  }
  if (toBooleanFlag(rule.set_ignored)) {
    updates.ignored = true;
    updates.type = 'Ignore';
    updates.category = 'Ignore';
  }
  if (!Object.keys(updates).length) return null;
  const applyReviewed = toBooleanFlag(rule.apply_reviewed);
  return {
    ...updates,
    reviewed: applyReviewed ? true : !!transaction?.reviewed,
    ignored: updates.ignored === true ? true : !!transaction?.ignored,
    ruleApplied: String(rule.confidence_mode || 'auto_apply') === 'auto_apply',
  };
}

export function applyRuleToTransaction(transaction, rule) {
  if (!transactionMatchesRule(transaction, rule)) return null;
  const updates = buildRuleUpdate(transaction, rule);
  if (!updates) return null;
  return { ...transaction, ...updates };
}

export function previewRuleMatches(rule, transactions = []) {
  return (transactions || [])
    .filter((transaction) => transactionMatchesRule(transaction, rule))
    .map((transaction) => ({
      transactionId: transaction.id,
      transaction,
      ruleId: rule.id,
      ruleName: rule.name || rule.match_value,
      updates: buildRuleUpdate(transaction, rule),
    }))
    .filter((row) => row.updates);
}

export function getRuleMatchValueFromTransaction(transaction) {
  const merchant = normalizeMerchantName(transaction?.merchant_name);
  if (merchant) return merchant;
  const name = normalizeMerchantName(transaction?.name);
  if (name) return name;
  return normalizeDescription(getOriginalDescription(transaction));
}

export function createRuleFromTransaction(transaction, type, category) {
  const matchValue = getRuleMatchValueFromTransaction(transaction);
  return {
    name: matchValue ? matchValue.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Transaction rule',
    enabled: true,
    priority: 100,
    match_type: transaction?.merchant_name ? 'merchant_contains' : 'description_contains',
    match_value: matchValue,
    account_id: '',
    amount_min: null,
    amount_max: null,
    set_type: type || transaction?.type || '',
    set_category: category || transaction?.category || '',
    apply_type: type || transaction?.type || '',
    apply_category: category || transaction?.category || '',
    apply_reviewed: false,
    confidence_mode: 'suggest',
    apply_to_unreviewed_only: true,
    apply_to_pending: false,
    created_from_transaction_id: transaction?.id || '',
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
  const enabledRules = (rules || [])
    .filter((rule) => toBooleanFlag(rule.enabled))
    .filter((rule) => String(rule.confidence_mode || 'auto_apply') === 'auto_apply')
    .sort((a, b) => Number(a.priority ?? 100) - Number(b.priority ?? 100));
  const results = [];
  for (const transaction of transactions || []) {
    for (const rule of enabledRules) {
      if (transaction?.pending && !toBooleanFlag(rule.apply_to_pending)) continue;
      if (!transactionMatchesRule(transaction, rule)) continue;
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
