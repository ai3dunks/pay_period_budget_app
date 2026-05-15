import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET /api/accounts
router.get('/', (_req, res) => {
  try {
    const rows = db.prepare(
      `SELECT a.*
       FROM accounts a
       LEFT JOIN plaid_items p ON p.item_id = a.item_id
       WHERE a.item_id IS NULL
          OR p.status IS NULL
          OR p.status IN ('active', 'connected')`
    ).all();

    res.json(rows.map((acc) => ({
      id: acc.id,
      itemId: acc.item_id,
      plaidAccountId: acc.plaid_account_id,
      institutionName: acc.institution_name,
      name: acc.name,
      officialName: acc.official_name,
      mask: acc.mask,
      type: acc.type,
      subtype: acc.subtype,
      balanceCurrent: acc.balance_current,
      balanceAvailable: acc.balance_available,
      isoCurrencyCode: acc.iso_currency_code,
      lastSyncedAt: acc.last_synced_at,
    })));
  } catch (err) {
    console.error('Error fetching accounts:', err.message);
    res.status(500).json({ error: 'Failed to fetch accounts.' });
  }
});

export default router;
