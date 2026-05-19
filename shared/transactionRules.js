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

function normalizeComparisonText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
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

export function getRuleComparisonKey(rule = {}) {
  return [
    normalizeComparisonText(rule.match_type || rule.match_operator || 'contains'),
    normalizeComparisonText(rule.match_value),
    normalizeComparisonText(rule.account_id),
    normalizeComparisonText(rule.apply_type ?? rule.set_type),
    normalizeComparisonText(rule.apply_category ?? rule.set_category),
    normalizeComparisonText(rule.set_type),
    normalizeComparisonText(rule.set_category),
  ].join('|');
}

export function detectRuleConflicts(rules = []) {
  const activeRules = (rules || []).filter((rule) => toBooleanFlag(rule.enabled));
  const groups = new Map();
  const conflictsByRuleId = new Map();

  for (const rule of activeRules) {
    const key = getRuleComparisonKey(rule);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const samePriority = group.every((rule) => Number(rule.priority ?? 100) === Number(group[0].priority ?? 100));
    const hasIgnore = group.some((rule) => toBooleanFlag(rule.set_ignored));
    const hasAutoApply = group.some((rule) => String(rule.confidence_mode || 'suggest') === 'auto_apply');
    const actionSignature = new Set(group.map((rule) => [
      normalizeComparisonText(rule.apply_type ?? rule.set_type),
      normalizeComparisonText(rule.apply_category ?? rule.set_category),
      toBooleanFlag(rule.set_ignored) ? 'ignored' : 'categorized',
    ].join('|')));

    if (actionSignature.size > 1 || hasIgnore || (samePriority && hasAutoApply)) {
      for (const rule of group) {
        conflictsByRuleId.set(rule.id, {
          conflictCount: group.length - 1,
          samePriority,
          hasIgnore,
        });
      }
    }
  }

  return conflictsByRuleId;
}

export function evaluateRulePreview(rule, transactions = [], options = {}) {
  const rows = [];
  let matchedCount = 0;
  let updatedCount = 0;
  let skippedPendingCount = 0;
  let skippedReviewedCount = 0;

  for (const transaction of transactions || []) {
    if (!transactionMatchesRule(transaction, rule)) continue;
    matchedCount += 1;
    const updates = buildRuleUpdate(transaction, rule);
    const pendingBlocked = !!transaction?.pending && !toBooleanFlag(rule.apply_to_pending);
    const reviewedBlocked = !!transaction?.reviewed && rule.apply_to_unreviewed_only !== false;
    const skipped = pendingBlocked || reviewedBlocked;

    if (pendingBlocked) skippedPendingCount += 1;
    if (reviewedBlocked) skippedReviewedCount += 1;

    rows.push({
      transactionId: transaction.id,
      transaction,
      ruleId: rule.id,
      ruleName: rule.name || rule.match_value,
      updates,
      pending: !!transaction?.pending,
      reviewed: !!transaction?.reviewed,
      pendingLabel: transaction?.pending ? 'Pending' : 'Posted',
      reviewedLabel: transaction?.reviewed ? 'Reviewed' : 'Needs review',
      currentType: transaction?.type ?? null,
      currentCategory: transaction?.category ?? null,
      newType: updates?.type ?? transaction?.type ?? null,
      newCategory: updates?.category ?? transaction?.category ?? null,
      newReviewed: updates?.reviewed === true,
      applyToPending: toBooleanFlag(rule.apply_to_pending),
      applyReviewed: toBooleanFlag(rule.apply_reviewed),
      willApply: !skipped,
      skipReason: pendingBlocked ? 'pending' : (reviewedBlocked ? 'reviewed' : null),
      confidenceMode: rule.confidence_mode || 'suggest',
      accountId: transaction?.account_id || transaction?.plaid_account_id || null,
      merchantName: transaction?.merchant_name || transaction?.name || '',
      date: transaction?.date || null,
    });

    if (!skipped && updates) updatedCount += 1;
  }

  return {
    matchedCount,
    updatedCount,
    skippedPendingCount,
    skippedReviewedCount,
    skippedConflictCount: 0,
    preview: rows,
  };
}

export function applyRuleToTransaction(transaction, rule) {
  if (!transactionMatchesRule(transaction, rule)) return null;
  const updates = buildRuleUpdate(transaction, rule);
  if (!updates) return null;
  return { ...transaction, ...updates };
}

export function previewRuleMatches(rule, transactions = []) {
  return evaluateRulePreview(rule, transactions).preview;
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
