/**
 * shared/boaRollover.js — BOA pre-paycheck rollover calculation.
 * No DOM, no fetch, no localStorage.
 *
 * BOA Rollover = the running balance of the last BOA transaction BEFORE the
 * Cisco paycheck posts. Only uses transaction-level running balance when present.
 * Returns unavailable if running balance data is missing.
 */

import { isDateInBudgetPeriod } from './budgetPeriods.js';

const BOA_NAME_PATTERNS = ['bank of america', 'boa', 'bofa'];
const CISCO_PAYROLL_PATTERN = /cisco\s+systems|des:payroll/i;

function isBankOfAmericaAccount(account) {
  if (!account) return false;
  const name = String(account.name || account.officialName || '').toLowerCase();
  const inst = String(account.institutionName || '').toLowerCase();
  return BOA_NAME_PATTERNS.some((p) => name.includes(p) || inst.includes(p));
}

function isCiscoPayrollText(text) {
  return CISCO_PAYROLL_PATTERN.test(String(text || ''));
}

function isCiscoPayrollTransaction(txn) {
  if (!txn) return false;
  if (isCiscoPayrollText(txn.name) || isCiscoPayrollText(txn.merchant_name) || isCiscoPayrollText(txn.description)) {
    return true;
  }
  if (txn.raw_json) {
    try {
      const raw = typeof txn.raw_json === 'string' ? JSON.parse(txn.raw_json) : txn.raw_json;
      if (isCiscoPayrollText(raw?.original_description)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

function isBoaTransaction(txn, boaAccount) {
  if (!txn || !boaAccount) return false;
  const txnAccountId = String(txn.account_id || '').trim();
  const txnPlaidAccountId = String(txn.plaid_account_id || '').trim();
  if (boaAccount.id && txnAccountId && boaAccount.id === txnAccountId) return true;
  if (boaAccount.plaidAccountId && txnPlaidAccountId && boaAccount.plaidAccountId === txnPlaidAccountId) return true;

  const txnMask = String(txn.mask || '').trim();
  const txnInst = String(txn.institution_name || '').toLowerCase().trim();
  const txnName = String(txn.account_name || '').toLowerCase().trim();
  const accMask = String(boaAccount.mask || '').trim();
  const accInst = String(boaAccount.institutionName || '').toLowerCase().trim();
  const accName = String(boaAccount.name || '').toLowerCase().trim();

  if (accMask && txnMask && accMask === txnMask) return true;
  if (accName && txnName && accName === txnName) return true;
  if (accInst && txnInst && accInst === txnInst) return true;
  return BOA_NAME_PATTERNS.some((p) => txnInst.includes(p) || txnName.includes(p));
}

const BALANCE_FIELDS = [
  'balance', 'running_balance', 'runningBalance',
  'account_balance', 'accountBalance', 'balance_after', 'balanceAfter',
];

function getTransactionRunningBalance(txn) {
  if (!txn) return null;
  for (const field of BALANCE_FIELDS) {
    const val = txn[field];
    if (val !== null && val !== undefined && typeof val === 'number') return val;
  }
  if (txn.raw_json) {
    try {
      const raw = typeof txn.raw_json === 'string' ? JSON.parse(txn.raw_json) : txn.raw_json;
      if (raw) {
        for (const field of BALANCE_FIELDS) {
          const val = raw[field];
          if (val !== null && val !== undefined && typeof val === 'number') return val;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

const BASE_RETURN = {
  canCalculate: false,
  amount: null,
  rolloverDate: null,
  displayDate: null,
  source: 'unavailable',
  boaAccountId: null,
  boaAccountName: null,
  paycheckTransactionId: null,
  paycheckDate: null,
  paycheckDescription: null,
  paycheckAmount: null,
  lastTransactionId: null,
  lastTransactionDate: null,
  lastTransactionDescription: null,
  lastTransactionAmount: null,
  lastTransactionBalance: null,
  warning: null,
};

/**
 * Calculate the BOA rollover from the last pre-paycheck transaction's running balance.
 *
 * @param {{ accounts, transactions, selectedPeriod, settings }} opts
 * @returns {object} Result shape with canCalculate, amount, warning, and details
 */
export function calculateBoaRolloverFromLastPrePaycheckTransaction({
  accounts = [],
  transactions = [],
  selectedPeriod,
}) {
  const boaAccount = (accounts || []).find(isBankOfAmericaAccount);
  if (!boaAccount) {
    return { ...BASE_RETURN, warning: 'Bank of America account could not be identified.' };
  }

  const paycheckTxns = (transactions || []).filter((txn) => {
    if (!txn || txn.ignored) return false;
    if (!isCiscoPayrollTransaction(txn)) return false;
    if (!isBoaTransaction(txn, boaAccount)) return false;
    if (Number(txn.amount || 0) <= 0) return false;
    if (!isDateInBudgetPeriod(txn.date, selectedPeriod)) return false;
    return true;
  });

  if (paycheckTxns.length === 0) {
    return {
      ...BASE_RETURN,
      boaAccountId: boaAccount.id,
      boaAccountName: boaAccount.name,
      warning: 'Cisco paycheck was not found for this budget period.',
    };
  }

  const sortedPaychecks = [...paycheckTxns].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || ''))
  );
  const paycheckTxn = sortedPaychecks[0];
  const paycheckDate = String(paycheckTxn.date || '').slice(0, 10);

  const prePaycheckTxns = (transactions || []).filter((txn) => {
    if (!txn || txn.ignored) return false;
    if (!isBoaTransaction(txn, boaAccount)) return false;
    const txnDate = String(txn.date || '').slice(0, 10);
    if (txnDate >= paycheckDate) return false;
    return true;
  });

  if (prePaycheckTxns.length === 0) {
    return {
      ...BASE_RETURN,
      boaAccountId: boaAccount.id,
      boaAccountName: boaAccount.name,
      paycheckTransactionId: paycheckTxn.id,
      paycheckDate,
      paycheckDescription: paycheckTxn.name,
      paycheckAmount: Number(paycheckTxn.amount || 0),
      warning: 'No Bank of America transaction was found before the paycheck.',
    };
  }

  const sorted = [...prePaycheckTxns].sort((a, b) => {
    const dateCompare = String(b.date || '').localeCompare(String(a.date || ''));
    if (dateCompare !== 0) return dateCompare;
    return String(b.created_at || b.id || '').localeCompare(String(a.created_at || a.id || ''));
  });
  const lastTxn = sorted[0];
  const balance = getTransactionRunningBalance(lastTxn);

  if (balance === null || balance === undefined) {
    return {
      ...BASE_RETURN,
      boaAccountId: boaAccount.id,
      boaAccountName: boaAccount.name,
      paycheckTransactionId: paycheckTxn.id,
      paycheckDate,
      paycheckDescription: paycheckTxn.name,
      paycheckAmount: Number(paycheckTxn.amount || 0),
      lastTransactionId: lastTxn.id,
      lastTransactionDate: String(lastTxn.date || '').slice(0, 10),
      lastTransactionDescription: lastTxn.name,
      lastTransactionAmount: Number(lastTxn.amount || 0),
      warning: 'Last transaction before paycheck does not include a running balance.',
    };
  }

  return {
    canCalculate: true,
    amount: Number(balance),
    rolloverDate: String(lastTxn.date || '').slice(0, 10),
    displayDate: String(lastTxn.date || '').slice(0, 10),
    source: 'last-pre-paycheck-running-balance',
    boaAccountId: boaAccount.id,
    boaAccountName: boaAccount.name,
    paycheckTransactionId: paycheckTxn.id,
    paycheckDate,
    paycheckDescription: paycheckTxn.name,
    paycheckAmount: Number(paycheckTxn.amount || 0),
    lastTransactionId: lastTxn.id,
    lastTransactionDate: String(lastTxn.date || '').slice(0, 10),
    lastTransactionDescription: lastTxn.name,
    lastTransactionAmount: Number(lastTxn.amount || 0),
    lastTransactionBalance: Number(balance),
    warning: null,
  };
}
