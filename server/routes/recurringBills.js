import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { getDetectedPayrollIncome, isCiscoPayrollTransaction } from '../../shared/payrollDetection.js';
import { getBillDueDateForPeriod, scoreRecurringBillPaymentMatch } from '../../shared/recurringBills.js';
import { normalizeText, parseMatchWords, parseJsonSafe } from '../../shared/text.js';

const router = Router();

function parseRawJson(rawJson) {
  return parseJsonSafe(rawJson);
}

function buildTransactionSearchText(tx) {
  const raw = parseRawJson(tx.raw_json);
  return normalizeText([
    tx.name,
    tx.description,
    tx.merchant_name,
    tx.raw_json,
    raw?.original_description,
    raw?.name,
    raw?.merchant_name,
  ].filter(Boolean).join(' '));
}

function parseBillMatchWords(value) {
  if (Array.isArray(value)) return parseMatchWords(value);
  const parsed = parseRawJson(value);
  if (Array.isArray(parsed)) return parseMatchWords(parsed);
  return parseMatchWords(value);
}

function isIgnoredIncomeOrTransfer(tx) {
  const typeText = normalizeText(tx.type);
  const categoryText = normalizeText(tx.category);
  const searchText = buildTransactionSearchText(tx);
  if (tx.ignored) return true;
  if (Number(tx.amount || 0) >= 0) return true;
  if (typeText.includes('income')) return true;
  if (typeText.includes('paycheck')) return true;
  if (typeText.includes('transfer')) return true;
  if (typeText.includes('deposit')) return true;
  if (categoryText.includes('income')) return true;
  if (categoryText.includes('transfer')) return true;
  if (categoryText.includes('paycheck')) return true;
  if (searchText.includes('transfer in')) return true;
  if (searchText.includes('xfer in')) return true;
  if (searchText.includes('direct deposit')) return true;
  return false;
}

function getSafeMoneyIncludePendingSetting() {
  try {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('safe_money_settings');
    const parsed = parseJsonSafe(row?.value_json);
    return parsed?.includePendingTransactions === true || parsed?.include_pending_transactions === true;
  } catch {
    return false;
  }
}

function isTransactionCandidateForBill(tx, periodStart, periodEnd, dueDate) {
  const txDate = new Date(tx.date);
  if (txDate >= periodStart && txDate < periodEnd) return true;
  const afterDueLimit = new Date(dueDate);
  afterDueLimit.setDate(afterDueLimit.getDate() + 5);
  return txDate > dueDate && txDate <= afterDueLimit;
}

function upsertStatus(values) {
  db.prepare(
    `INSERT INTO recurring_bill_status (
      id, period_id, recurring_bill_id, paid, paid_date, notes,
      match_transaction_id, match_score, match_method,
      auto_paid, manual_paid, manually_overridden,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(period_id, recurring_bill_id) DO UPDATE SET
      paid = excluded.paid,
      paid_date = excluded.paid_date,
      notes = excluded.notes,
      match_transaction_id = excluded.match_transaction_id,
      match_score = excluded.match_score,
      match_method = excluded.match_method,
      auto_paid = excluded.auto_paid,
      manual_paid = excluded.manual_paid,
      manually_overridden = excluded.manually_overridden,
      updated_at = excluded.updated_at`
  ).run(
    values.id,
    values.periodId,
    values.recurringBillId,
    values.paid,
    values.paidDate,
    values.notes,
    values.matchTransactionId,
    values.matchScore,
    values.matchMethod,
    values.autoPaid,
    values.manualPaid,
    values.manuallyOverridden,
    values.createdAt,
    values.updatedAt
  );
}

/**
 * POST /api/recurring-bills/auto-detect
 * Detect Cisco payroll and auto-match bills to transactions
 */
router.post('/auto-detect', (req, res) => {
  try {
    const { periodId, startDate, exclusiveEndDate } = req.body;
    const includePendingTransactions = getSafeMoneyIncludePendingSetting();

    if (!periodId || !startDate || !exclusiveEndDate) {
      return res.status(400).json({
        error: 'periodId, startDate, and exclusiveEndDate are required'
      });
    }

    // Fetch recurring bills for this period
    const bills = db
      .prepare('SELECT * FROM recurring_bills_list_items WHERE active = 1 ORDER BY due_day ASC')
      .all();

    const queryEndDate = new Date(exclusiveEndDate);
    queryEndDate.setDate(queryEndDate.getDate() + 5);
    const queryEndIso = queryEndDate.toISOString().slice(0, 10);

    // Fetch transactions for this period plus 5-day trailing window
    const transactions = db
      .prepare(
        `SELECT * FROM transactions
         WHERE date >= ? AND date < ?
         ORDER BY date DESC`
      )
      .all(startDate, queryEndIso)
      .map((tx) => ({
        ...tx,
        _searchText: buildTransactionSearchText(tx),
        _isIgnoredIncomeOrTransfer: isIgnoredIncomeOrTransfer(tx),
        _isCiscoPayroll: isCiscoPayrollTransaction(tx),
      }));

    const period = {
      id: periodId,
      startDate,
      exclusiveEndDate
    };

    // Detect Cisco payroll
    const payrollDetection = getDetectedPayrollIncome(transactions, period, {
      includePendingTransactions,
    });

    const periodStartDate = new Date(startDate);
    const periodEndDate = new Date(exclusiveEndDate);

    const existingStatuses = db
      .prepare('SELECT * FROM recurring_bill_status WHERE period_id = ?')
      .all(periodId);
    const existingByBillId = new Map(existingStatuses.map((row) => [row.recurring_bill_id, row]));

    // Perform bill matching
    const matches = [];
    const possibleMatches = [];
    const unmatched = [];
    const matchedTransactionIds = new Set();
    const now = new Date().toISOString();

    for (const bill of bills) {
      const dueDate = getBillDueDateForPeriod(bill, period);
      if (!dueDate || dueDate >= periodEndDate) continue;

      const existing = existingByBillId.get(bill.id);
      if (existing?.manually_overridden) {
        continue;
      }

      // Find best matching transaction
      let bestMatch = null;
      let bestScore = 0;
      let bestMethod = '';

      for (const tx of transactions) {
        if (!isTransactionCandidateForBill(tx, periodStartDate, periodEndDate, dueDate)) continue;
        if (!includePendingTransactions && tx.pending) continue;
        if (matchedTransactionIds.has(tx.id)) continue;
        if (tx._isIgnoredIncomeOrTransfer ?? isIgnoredIncomeOrTransfer(tx)) continue;
        if (tx._isCiscoPayroll ?? isCiscoPayrollTransaction(tx)) continue;

        const result = scoreRecurringBillPaymentMatch(
          {
            ...bill,
            matchWords: parseBillMatchWords(bill.match_words ?? bill.matchWords),
          },
          tx,
          dueDate
        );
        if (result.score >= 50 && result.score > bestScore) {
          bestScore = result.score;
          bestMethod = (result.reasons || []).join(',') || 'possible_match';
          bestMatch = { tx, score: result.score };
        }
      }

      if (bestMatch && bestMatch.score >= 75) {
        const statusId = existing?.id || randomUUID();
        upsertStatus({
          id: statusId,
          periodId,
          recurringBillId: bill.id,
          paid: 1,
          paidDate: bestMatch.tx.date || null,
          notes: existing?.notes || '',
          matchTransactionId: bestMatch.tx.id,
          matchScore: bestMatch.score,
          matchMethod: bestMethod || 'auto_paid',
          autoPaid: 1,
          manualPaid: 0,
          manuallyOverridden: 0,
          createdAt: existing?.created_at || now,
          updatedAt: now,
        });

        matches.push({
          billId: bill.id,
          billName: bill.name,
          billMatchWords: parseBillMatchWords(bill.match_words ?? bill.matchWords),
          matchWords: parseBillMatchWords(bill.match_words ?? bill.matchWords),
          transactionId: bestMatch.tx.id,
          transactionDate: bestMatch.tx.date,
          transactionDescription: bestMatch.tx.name || bestMatch.tx.description || bestMatch.tx.merchant_name || '',
          transactionAmount: bestMatch.tx.amount,
          score: bestMatch.score,
          method: bestMethod || 'auto_paid',
          matchStatus: 'Auto-paid',
          autoPaid: true
        });
        matchedTransactionIds.add(bestMatch.tx.id);
      } else if (bestMatch && bestMatch.score >= 50) {
        const statusId = existing?.id || randomUUID();
        upsertStatus({
          id: statusId,
          periodId,
          recurringBillId: bill.id,
          paid: 0,
          paidDate: null,
          notes: existing?.notes || '',
          matchTransactionId: bestMatch.tx.id,
          matchScore: bestMatch.score,
          matchMethod: bestMethod || 'possible_match',
          autoPaid: 0,
          manualPaid: 0,
          manuallyOverridden: 0,
          createdAt: existing?.created_at || now,
          updatedAt: now,
        });

        possibleMatches.push({
          billId: bill.id,
          billName: bill.name,
          billMatchWords: parseBillMatchWords(bill.match_words ?? bill.matchWords),
          matchWords: parseBillMatchWords(bill.match_words ?? bill.matchWords),
          transactionId: bestMatch.tx.id,
          transactionDate: bestMatch.tx.date,
          transactionDescription: bestMatch.tx.name || bestMatch.tx.description || bestMatch.tx.merchant_name || '',
          transactionAmount: bestMatch.tx.amount,
          score: bestMatch.score,
          method: bestMethod || 'possible_match',
          matchStatus: 'Possible match',
        });
      } else {
        const statusId = existing?.id || randomUUID();
        const matchMethod = bill.autopay ? 'autopay_not_found' : 'unpaid';
        upsertStatus({
          id: statusId,
          periodId,
          recurringBillId: bill.id,
          paid: 0,
          paidDate: null,
          notes: existing?.notes || '',
          matchTransactionId: null,
          matchScore: 0,
          matchMethod,
          autoPaid: 0,
          manualPaid: 0,
          manuallyOverridden: 0,
          createdAt: existing?.created_at || now,
          updatedAt: now,
        });

        unmatched.push({
          billId: bill.id,
          billName: bill.name,
          matchStatus: bill.autopay ? 'Autopay not found' : 'Unpaid',
        });
      }
    }

    res.json({
      payroll: payrollDetection,
      bills: {
        checked: bills.length,
        matched: matches.length,
        possible: possibleMatches.length,
        unpaid: unmatched.length,
      },
      matches: {
        autoPaid: matches.length,
        possible: possibleMatches.length,
        total: matches.length + possibleMatches.length,
      },
      details: [...matches, ...possibleMatches, ...unmatched],
    });
  } catch (err) {
    console.error('Error in auto-detect:', err);
    res.status(500).json({ error: 'Failed to auto-detect recurring bills.' });
  }
});

/**
 * GET /api/recurring-bills/status?periodId=...
 * Retrieve paid status for all recurring bills in a period.
 * Returns: array of { id, periodId, recurringBillId, paid, paidDate, notes }
 */
router.get('/status', (req, res) => {
  try {
    const { periodId } = req.query;
    if (!periodId) {
      return res.status(400).json({ error: 'periodId is required' });
    }

    const rows = db
      .prepare('SELECT * FROM recurring_bill_status WHERE period_id = ?')
      .all(periodId);

    const txById = new Map();
    const getTransaction = db.prepare('SELECT id, date, name, merchant_name, amount FROM transactions WHERE id = ?');

    const status = rows.map((row) => {
      const txId = row.match_transaction_id || null;
      let tx = null;
      if (txId) {
        if (!txById.has(txId)) txById.set(txId, getTransaction.get(txId) || null);
        tx = txById.get(txId);
      }

      let matchStatus = 'Unpaid';
      if (row.manually_overridden) matchStatus = 'Manual';
      else if (row.auto_paid && row.paid) matchStatus = 'Auto-paid';
      else if ((row.match_score || 0) >= 50 && (row.match_score || 0) < 75) matchStatus = 'Possible match';
      else if (row.match_method === 'autopay_not_found') matchStatus = 'Autopay not found';

      return {
      id: row.id,
      periodId: row.period_id,
      recurringBillId: row.recurring_bill_id,
      paid: !!row.paid,
      paidDate: row.paid_date || null,
      notes: row.notes || '',
      autoPaid: !!row.auto_paid,
      matchTransactionId: row.match_transaction_id || null,
      matchScore: row.match_score || 0,
      matchMethod: row.match_method || null,
      manuallyOverridden: !!row.manually_overridden,
      matchStatus,
      matchedTransactionDate: tx?.date || null,
      matchedTransactionDescription: tx?.name || tx?.merchant_name || null,
      matchedTransactionAmount: tx?.amount ?? null,
    };
    });

    res.json(status);
  } catch (err) {
    console.error('Error fetching recurring bill status:', err);
    res.status(500).json({ error: 'Failed to fetch recurring bill status.' });
  }
});

/**
 * PATCH /api/recurring-bills/status
 * Update or create paid status for a recurring bill in a period.
 * Body: { periodId, recurringBillId, paid, paidDate, notes, manuallyOverridden }
 * Returns: { id, periodId, recurringBillId, paid, paidDate, notes, updatedAt }
 */
router.patch('/status', (req, res) => {
  try {
    const { periodId, recurringBillId, paid, paidDate, notes, manuallyOverridden, clearManualOverride } = req.body;

    if (!periodId || !recurringBillId) {
      return res.status(400).json({ error: 'periodId and recurringBillId are required' });
    }

    const now = new Date().toISOString();
    const existing = db
      .prepare('SELECT * FROM recurring_bill_status WHERE period_id = ? AND recurring_bill_id = ?')
      .get(periodId, recurringBillId);
    const statusId = existing?.id || randomUUID();
    const paidValue = paid ? 1 : 0;
    const overriddenValue = clearManualOverride ? 0 : (manuallyOverridden === undefined ? 1 : (manuallyOverridden ? 1 : 0));

    upsertStatus({
      id: statusId,
      periodId,
      recurringBillId,
      paid: paidValue,
      paidDate: paidDate || null,
      notes: notes || '',
      matchTransactionId: existing?.match_transaction_id || null,
      matchScore: existing?.match_score || 0,
      matchMethod: existing?.match_method || 'manual',
      autoPaid: existing?.auto_paid || 0,
      manualPaid: paidValue,
      manuallyOverridden: overriddenValue,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });

    const result = db
      .prepare('SELECT * FROM recurring_bill_status WHERE period_id = ? AND recurring_bill_id = ?')
      .get(periodId, recurringBillId);

    res.json({
      id: result.id,
      periodId: result.period_id,
      recurringBillId: result.recurring_bill_id,
      paid: !!result.paid,
      paidDate: result.paid_date || null,
      notes: result.notes || '',
      autoPaid: !!result.auto_paid,
      manuallyOverridden: !!result.manually_overridden,
      updatedAt: result.updated_at
    });
  } catch (err) {
    console.error('Error updating recurring bill status:', err);
    res.status(500).json({ error: 'Failed to update recurring bill status.' });
  }
});

export default router;
