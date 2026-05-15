import { Router } from 'express';
import { randomUUID } from 'crypto';
import db, { safeSqlValue } from '../db.js';
import { plaidClient, getPlaidProducts, getPlaidCountryCodes } from '../plaidClient.js';

const router = Router();

function savePlaidSyncResult(result) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run('plaid_last_sync_result', JSON.stringify({ ...result, updatedAt: now }), now);
}

function getActiveItems() {
  return db
    .prepare("SELECT * FROM plaid_items WHERE status IS NULL OR status IN ('active', 'connected')")
    .all();
}

function getActiveAccounts() {
  return db.prepare(
    `SELECT a.*
     FROM accounts a
     JOIN plaid_items p ON p.item_id = a.item_id
     WHERE p.status IS NULL OR p.status IN ('active', 'connected')`
  ).all();
}

// GET /api/plaid/status
router.get('/status', (_req, res) => {
  try {
    const items = getActiveItems();
    const accounts = getActiveAccounts();
    const removedItemsCount = db
      .prepare("SELECT COUNT(*) AS count FROM plaid_items WHERE status = 'removed'")
      .get()?.count || 0;
    const staleAccountsCount = db.prepare(
      `SELECT COUNT(*) AS count
       FROM accounts a
       WHERE a.item_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM plaid_items p
           WHERE p.item_id = a.item_id
             AND (p.status IS NULL OR p.status IN ('active', 'connected'))
         )`
    ).get()?.count || 0;

    res.json({
      connected: items.length > 0,
      items: items.map((item) => ({
        itemId: item.item_id,
        institutionName: item.institution_name,
        status: item.status,
        lastSyncedAt: item.last_synced_at,
        hasCursor: !!item.cursor,
      })),
      accounts: accounts.map((acc) => ({
        id: acc.id,
        plaidAccountId: acc.plaid_account_id,
        name: acc.name,
        officialName: acc.official_name,
        mask: acc.mask,
        type: acc.type,
        subtype: acc.subtype,
        institutionName: acc.institution_name,
        balanceCurrent: acc.balance_current,
      })),
      removedItemsCount,
      staleAccountsCount,
    });
  } catch (err) {
    console.error('Error fetching Plaid status:', err.message);
    res.status(500).json({ error: 'Failed to fetch Plaid status.' });
  }
});

// GET /api/plaid/accounts
router.get('/accounts', (_req, res) => {
  try {
    const accounts = getActiveAccounts();
    res.json(accounts.map((acc) => ({
      id: acc.id,
      itemId: acc.item_id,
      plaidAccountId: acc.plaid_account_id,
      name: acc.name,
      officialName: acc.official_name,
      mask: acc.mask,
      type: acc.type,
      subtype: acc.subtype,
      institutionName: acc.institution_name,
      balanceCurrent: acc.balance_current,
    })));
  } catch (err) {
    console.error('Error fetching accounts:', err.message);
    res.status(500).json({ error: 'Failed to fetch accounts.' });
  }
});

// POST /api/plaid/create-link-token
router.post('/create-link-token', async (_req, res) => {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return res.status(400).json({ error: 'Missing Plaid environment variables.' });
  }

  try {
    const response = await plaidClient.linkTokenCreate({
      client_name: 'Budget Dashboard',
      language: 'en',
      products: getPlaidProducts(),
      country_codes: getPlaidCountryCodes(),
      user: { client_user_id: 'local-user' },
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('Error creating link token:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create Plaid link token.' });
  }
});

// POST /api/plaid/exchange-public-token
router.post('/exchange-public-token', async (req, res) => {
  const { public_token } = req.body;
  if (!public_token) {
    return res.status(400).json({ error: 'public_token is required.' });
  }

  try {
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchangeResponse.data;

    let institutionName = null;
    let institutionId = null;

    try {
      const itemResponse = await plaidClient.itemGet({ access_token });
      institutionId = itemResponse.data.item.institution_id;
      if (institutionId) {
        const instResponse = await plaidClient.institutionsGetById({
          institution_id: institutionId,
          country_codes: getPlaidCountryCodes(),
        });
        institutionName = instResponse.data.institution.name;
      }
    } catch (metaErr) {
      console.warn('Could not fetch institution metadata:', metaErr.message);
    }

    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id FROM plaid_items WHERE item_id = ?').get(item_id);

    if (existing) {
      db.prepare(
        'UPDATE plaid_items SET access_token = ?, institution_id = ?, institution_name = ?, status = ?, updated_at = ? WHERE item_id = ?'
      ).run(
        safeSqlValue(access_token),
        safeSqlValue(institutionId),
        safeSqlValue(institutionName),
        'active',
        now,
        item_id
      );
    } else {
      db.prepare(
        'INSERT INTO plaid_items (id, item_id, access_token, institution_id, institution_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        randomUUID(),
        safeSqlValue(item_id),
        safeSqlValue(access_token),
        safeSqlValue(institutionId),
        safeSqlValue(institutionName),
        'active',
        now,
        now
      );
    }

    res.json({ connected: true, itemId: item_id, institutionName });
  } catch (err) {
    console.error('Error exchanging public token:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange public token.' });
  }
});

// POST /api/plaid/sync-transactions
router.post('/sync-transactions', async (_req, res) => {
  try {
    const items = db.prepare("SELECT * FROM plaid_items WHERE status IS NULL OR status IN ('active', 'connected')").all();

    let addedNew = 0;
    let updatedExisting = 0;
    let modifiedCount = 0;
    let removedCount = 0;
    let unchanged = 0;
    let accountsInserted = 0;
    let accountsUpdated = 0;
    const now = new Date().toISOString();

    for (const item of items) {
      let cursor = item.cursor || null;
      let hasMore = true;

      while (hasMore) {
        const syncParams = { access_token: item.access_token };
        if (cursor) syncParams.cursor = cursor;

        const syncResponse = await plaidClient.transactionsSync(syncParams);
        const {
          added,
          modified: modifiedTxns,
          removed: removedTxns,
          next_cursor,
          has_more,
          accounts,
        } = syncResponse.data;

        // Upsert accounts
        for (const acc of accounts) {
          const existingAcc = db
            .prepare('SELECT id FROM accounts WHERE plaid_account_id = ?')
            .get(acc.account_id);

          if (existingAcc) {
            db.prepare(
              'UPDATE accounts SET item_id = ?, institution_name = ?, name = ?, official_name = ?, mask = ?, type = ?, subtype = ?, balance_current = ?, balance_available = ?, iso_currency_code = ?, raw_json = ?, updated_at = ?, last_synced_at = ? WHERE plaid_account_id = ?'
            ).run(
              safeSqlValue(item.item_id),
              safeSqlValue(item.institution_name),
              safeSqlValue(acc.name),
              safeSqlValue(acc.official_name),
              safeSqlValue(acc.mask),
              safeSqlValue(acc.type),
              safeSqlValue(acc.subtype),
              safeSqlValue(acc.balances?.current),
              safeSqlValue(acc.balances?.available),
              safeSqlValue(acc.balances?.iso_currency_code),
              JSON.stringify(acc),
              now,
              now,
              acc.account_id
            );
            accountsUpdated++;
          } else {
            db.prepare(
              'INSERT INTO accounts (id, item_id, plaid_account_id, institution_name, name, official_name, mask, type, subtype, balance_current, balance_available, iso_currency_code, raw_json, created_at, updated_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
              randomUUID(),
              safeSqlValue(item.item_id),
              safeSqlValue(acc.account_id),
              safeSqlValue(item.institution_name),
              safeSqlValue(acc.name),
              safeSqlValue(acc.official_name),
              safeSqlValue(acc.mask),
              safeSqlValue(acc.type),
              safeSqlValue(acc.subtype),
              safeSqlValue(acc.balances?.current),
              safeSqlValue(acc.balances?.available),
              safeSqlValue(acc.balances?.iso_currency_code),
              JSON.stringify(acc),
              now,
              now,
              now
            );
            accountsInserted++;
          }
        }

        // Upsert added transactions
        // Amount convention: Plaid positive = spending = store as negative; Plaid negative = income = positive
        for (const txn of added) {
          const appAmount = txn.amount > 0 ? -txn.amount : Math.abs(txn.amount);
          const accountRow = db
            .prepare('SELECT id FROM accounts WHERE plaid_account_id = ?')
            .get(txn.account_id);
          const existingTxn = db
            .prepare('SELECT id FROM transactions WHERE plaid_transaction_id = ?')
            .get(txn.transaction_id);

          if (!existingTxn) {
            db.prepare(
              `INSERT INTO transactions
                (id, plaid_transaction_id, item_id, plaid_account_id, account_id, date, authorized_date, name, merchant_name, amount, pending, pending_transaction_id, type, category, reviewed, ignored, notes, raw_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              randomUUID(),
              safeSqlValue(txn.transaction_id),
              safeSqlValue(item.item_id),
              safeSqlValue(txn.account_id),
              safeSqlValue(accountRow?.id ?? null),
              safeSqlValue(txn.date),
              safeSqlValue(txn.authorized_date),
              safeSqlValue(txn.name),
              safeSqlValue(txn.merchant_name),
              safeSqlValue(appAmount),
              safeSqlValue(txn.pending ? 1 : 0),
              safeSqlValue(txn.pending_transaction_id || null),
              null,
              null,
              0,
              0,
              null,
              JSON.stringify(txn),
              now,
              now
            );
            addedNew++;
          } else {
            db.prepare(
              'UPDATE transactions SET item_id = ?, plaid_account_id = ?, account_id = ?, date = ?, authorized_date = ?, name = ?, merchant_name = ?, amount = ?, pending = ?, pending_transaction_id = ?, raw_json = ?, updated_at = ? WHERE plaid_transaction_id = ?'
            ).run(
              safeSqlValue(item.item_id),
              safeSqlValue(txn.account_id),
              safeSqlValue(accountRow?.id ?? null),
              safeSqlValue(txn.date),
              safeSqlValue(txn.authorized_date),
              safeSqlValue(txn.name),
              safeSqlValue(txn.merchant_name),
              safeSqlValue(appAmount),
              safeSqlValue(txn.pending ? 1 : 0),
              safeSqlValue(txn.pending_transaction_id || null),
              JSON.stringify(txn),
              now,
              txn.transaction_id
            );
            updatedExisting++;
          }
        }

        // Update modified transactions
        for (const txn of modifiedTxns) {
          const appAmount = txn.amount > 0 ? -txn.amount : Math.abs(txn.amount);
          const result = db.prepare(
            'UPDATE transactions SET date = ?, authorized_date = ?, name = ?, merchant_name = ?, amount = ?, pending = ?, pending_transaction_id = ?, raw_json = ?, updated_at = ? WHERE plaid_transaction_id = ?'
          ).run(
            safeSqlValue(txn.date),
            safeSqlValue(txn.authorized_date),
            safeSqlValue(txn.name),
            safeSqlValue(txn.merchant_name),
            safeSqlValue(appAmount),
            safeSqlValue(txn.pending ? 1 : 0),
            safeSqlValue(txn.pending_transaction_id || null),
            JSON.stringify(txn),
            now,
            txn.transaction_id
          );
          if (result.changes > 0) modifiedCount++;
          else unchanged++;
        }

        // Mark removed transactions as ignored
        for (const txn of removedTxns) {
          const result = db.prepare(
            'UPDATE transactions SET ignored = 1, updated_at = ? WHERE plaid_transaction_id = ?'
          ).run(now, txn.transaction_id);
          if (result.changes > 0) removedCount++;
          else unchanged++;
        }

        cursor = next_cursor;
        hasMore = has_more;
      }

      // Save cursor and update last_synced_at
      db.prepare(
        'UPDATE plaid_items SET cursor = ?, last_synced_at = ?, updated_at = ? WHERE item_id = ?'
      ).run(safeSqlValue(cursor), now, now, item.item_id);
    }

    const totalTransactions = db
      .prepare('SELECT COUNT(*) as count FROM transactions WHERE ignored = 0')
      .get().count;

    savePlaidSyncResult({
      status: 'success',
      itemsSynced: items.length,
      addedNew,
      updatedExisting,
      modified: modifiedCount,
      removed: removedCount,
      unchanged,
      totalTransactions,
      lastSyncedAt: now,
    });

    res.json({
      itemsSynced: items.length,
      accountsInserted,
      accountsUpdated,
      addedNew,
      updatedExisting,
      modified: modifiedCount,
      removed: removedCount,
      unchanged,
      totalTransactions,
      lastSyncedAt: now,
    });
  } catch (err) {
    console.error('Error syncing transactions:', err.response?.data || err.message);
    savePlaidSyncResult({
      status: 'failed',
      error: err.message,
      details: err.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : null,
    });
    res.status(500).json({ error: 'Failed to sync transactions: ' + err.message });
  }
});

// DELETE /api/plaid/items/:itemId
router.delete('/items/:itemId', async (req, res) => {
  const { itemId } = req.params;

  try {
    const item = db.prepare('SELECT * FROM plaid_items WHERE item_id = ?').get(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    // Optionally call Plaid item/remove
    try {
      await plaidClient.itemRemove({ access_token: item.access_token });
    } catch (plaidErr) {
      console.warn('Could not remove item from Plaid (continuing):', plaidErr.message);
    }

    const cleanup = db.transaction((targetItemId) => {
      const deletedAccounts = db.prepare('DELETE FROM accounts WHERE item_id = ?').run(targetItemId).changes;
      const deletedUnreviewedTransactions = db
        .prepare('DELETE FROM transactions WHERE item_id = ? AND reviewed = 0')
        .run(targetItemId).changes;
      const detachedReviewedTransactions = db
        .prepare('UPDATE transactions SET item_id = NULL WHERE item_id = ? AND reviewed = 1')
        .run(targetItemId).changes;
      const deletedItems = db.prepare('DELETE FROM plaid_items WHERE item_id = ?').run(targetItemId).changes;

      return {
        deletedAccounts,
        deletedUnreviewedTransactions,
        detachedReviewedTransactions,
        deletedItems,
      };
    });

    const stats = cleanup(itemId);
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error('Error removing Plaid item:', err.message);
    res.status(500).json({ error: 'Failed to remove Plaid item.' });
  }
});

// POST /api/plaid/cleanup-removed
router.post('/cleanup-removed', (_req, res) => {
  try {
    const cleanup = db.transaction(() => {
      const deletedAccounts = db.prepare(
        `DELETE FROM accounts
         WHERE item_id IS NOT NULL
           AND (
             EXISTS (
               SELECT 1
               FROM plaid_items p
               WHERE p.item_id = accounts.item_id
                 AND p.status = 'removed'
             )
             OR NOT EXISTS (
               SELECT 1
               FROM plaid_items p
               WHERE p.item_id = accounts.item_id
                 AND (p.status IS NULL OR p.status IN ('active', 'connected'))
             )
           )`
      ).run().changes;

      const deletedRemovedItems = db
        .prepare("DELETE FROM plaid_items WHERE status = 'removed'")
        .run().changes;

      return {
        deletedAccounts,
        deletedRemovedItems,
        staleAccountsDeleted: deletedAccounts,
        removedItemsDeleted: deletedRemovedItems,
      };
    });

    const results = cleanup();
    res.json({ ok: true, ...results });
  } catch (err) {
    console.error('Error cleaning removed Plaid data:', err.message);
    res.status(500).json({ error: 'Failed to clean removed Plaid data.' });
  }
});

export default router;
