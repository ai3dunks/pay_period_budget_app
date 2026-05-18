import 'dotenv/config';
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { encryptSecret, isEncryptedSecret } from './secretStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, 'budget.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

function ensureTransactionsColumn(columnName, columnSql) {
  const columns = db.prepare("PRAGMA table_info('transactions')").all();
  if (!columns.some((col) => col.name === columnName)) {
    db.exec('ALTER TABLE transactions ADD COLUMN ' + columnSql);
  }
}

ensureTransactionsColumn('notes', 'notes TEXT');
ensureTransactionsColumn('pending_transaction_id', 'pending_transaction_id TEXT');
ensureTransactionsColumn('bucket_id', 'bucket_id TEXT');
ensureTransactionsColumn('bucket_name', 'bucket_name TEXT');

function ensureDebtSnowballColumn(columnName, columnSql) {
  const columns = db.prepare("PRAGMA table_info('debt_snowball_debts')").all();
  if (!columns.some((col) => col.name === columnName)) {
    db.exec('ALTER TABLE debt_snowball_debts ADD COLUMN ' + columnSql);
  }
}

ensureDebtSnowballColumn('credit_limit', 'credit_limit REAL');

function tableExists(tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return !!row;
}

function ensureIndex(indexName, sql) {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName);
  if (!existing) {
    db.exec(sql);
  }
}

function ensureIndexes() {
  ensureIndex('idx_transactions_date', 'CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)');
  ensureIndex(
    'idx_transactions_period_review',
    'CREATE INDEX IF NOT EXISTS idx_transactions_period_review ON transactions(date, reviewed, ignored, pending)'
  );
  ensureIndex(
    'idx_transactions_type_category',
    'CREATE INDEX IF NOT EXISTS idx_transactions_type_category ON transactions(type, category)'
  );
  ensureIndex(
    'idx_transactions_account',
    'CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id, plaid_account_id)'
  );
  ensureIndex(
    'idx_recurring_status_period',
    'CREATE INDEX IF NOT EXISTS idx_recurring_status_period ON recurring_bill_status(period_id, recurring_bill_id)'
  );
  ensureIndex(
    'idx_transactions_account_date',
    'CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date)'
  );
  ensureIndex(
    'idx_transactions_reviewed_ignored',
    'CREATE INDEX IF NOT EXISTS idx_transactions_reviewed_ignored ON transactions(reviewed, ignored)'
  );
  ensureIndex(
    'idx_transactions_pending',
    'CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(pending)'
  );
  ensureIndex(
    'idx_transactions_plaid_id',
    'CREATE INDEX IF NOT EXISTS idx_transactions_plaid_id ON transactions(plaid_transaction_id)'
  );
  ensureIndex(
    'idx_transactions_item_id',
    'CREATE INDEX IF NOT EXISTS idx_transactions_item_id ON transactions(item_id)'
  );
  ensureIndex(
    'idx_transactions_bucket_id',
    'CREATE INDEX IF NOT EXISTS idx_transactions_bucket_id ON transactions(bucket_id)'
  );
  ensureIndex(
    'idx_transactions_bucket_name',
    'CREATE INDEX IF NOT EXISTS idx_transactions_bucket_name ON transactions(bucket_name)'
  );
  ensureIndex(
    'idx_history_period',
    'CREATE INDEX IF NOT EXISTS idx_history_period ON pay_period_snapshots(period_id)'
  );
  ensureIndex(
    'idx_closeout_period',
    'CREATE INDEX IF NOT EXISTS idx_closeout_period ON pay_period_closeouts(period_id)'
  );
  ensureIndex(
    'idx_rules_enabled',
    'CREATE INDEX IF NOT EXISTS idx_rules_enabled ON transaction_rules(enabled)'
  );
  ensureIndex(
    'idx_debt_snowball_status',
    'CREATE INDEX IF NOT EXISTS idx_debt_snowball_status ON debt_snowball_debts(status)'
  );
  ensureIndex(
    'idx_debt_snowball_due_day',
    'CREATE INDEX IF NOT EXISTS idx_debt_snowball_due_day ON debt_snowball_debts(due_day)'
  );
  ensureIndex(
    'idx_budget_buckets_period',
    'CREATE INDEX IF NOT EXISTS idx_budget_buckets_period ON budget_buckets(pay_period_start, pay_period_end)'
  );
  ensureIndex(
    'idx_budget_buckets_group',
    'CREATE INDEX IF NOT EXISTS idx_budget_buckets_group ON budget_buckets(budget_group)'
  );

  if (tableExists('transfer_checklist_items')) {
    ensureIndex(
      'idx_transfer_checklist_period',
      'CREATE INDEX IF NOT EXISTS idx_transfer_checklist_period ON transfer_checklist_items(period_id)'
    );
  }
}

function ensureLegacyMasterListItemsTable() {
  // Legacy/deprecated: kept for compatibility; active UI uses expense_list_items and recurring_bills_list_items.
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_list_items (
      id TEXT PRIMARY KEY,
      list_type TEXT NOT NULL,
      name TEXT NOT NULL,
      display_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
}

function ensureExpenseListTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_list_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      budget_amount REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      notes TEXT,
      display_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )
  `);
}

function ensureRecurringBillsListTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_bills_list_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      due_day INTEGER,
      amount REAL DEFAULT 0,
      paid_from TEXT,
      match_words TEXT,
      autopay INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      notes TEXT,
      display_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )
  `);
}

function seedExpenseListIfEmpty() {
  const expenseCount = db.prepare('SELECT COUNT(*) as count FROM expense_list_items').get().count;
  if (expenseCount > 0) return;

  const legacyRows = db
    .prepare("SELECT name, notes, active, display_order FROM master_list_items WHERE list_type = 'expense_category' ORDER BY display_order ASC, name COLLATE NOCASE ASC")
    .all();

  const defaults = legacyRows.length
    ? legacyRows.map((row) => ({
        name: row.name,
        budget_amount: 0,
        active: !!row.active,
        notes: row.notes || null,
        display_order: row.display_order,
      }))
    : [
        'Groceries',
        'Gas',
        'Fast Food',
        'Pizza',
        'Kids',
        'Diapers/Wipes',
        'Home Essentials',
        'Car Maintenance',
        'School',
        'Medical',
        'Penny Care',
        'Riley',
        'Micah',
        'Travel Fund',
        'Misc',
      ].map((name, index) => ({
        name,
        budget_amount: 0,
        active: true,
        notes: null,
        display_order: index,
      }));

  const now = new Date().toISOString();
  const insertStmt = db.prepare(
    'INSERT INTO expense_list_items (id, name, budget_amount, active, notes, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  for (const item of defaults) {
    insertStmt.run(
      randomUUID(),
      item.name,
      item.budget_amount,
      item.active ? 1 : 0,
      item.notes,
      item.display_order,
      now,
      now
    );
  }
}

function seedRecurringBillsListIfEmpty() {
  const recurringCount = db.prepare('SELECT COUNT(*) as count FROM recurring_bills_list_items').get().count;
  if (recurringCount > 0) return;

  const seededRows = [
    ['Mortgage 1', 'Needs', 1, 1274.52, '', true],
    ['Car Insurance', 'Needs', 1, 193.34, '', true],
    ['Sunnyvale Dance Academy', 'Wants', 1, 114.00, '', false],
    ['Amex J', 'Debts/Savings', 4, 103.00, '', false],
    ['Citi CC T', 'Debts/Savings', 6, 52.00, '', false],
    ['Apple Storage (Josh)', 'Wants', 8, 9.99, '', true],
    ['Apple Storage (Taylor)', 'Wants', 8, 9.99, '', true],
    ['Debt Snowball', 'Debts/Savings', 9, 35.00, '', false],
    ['Debt Snowball', 'Debts/Savings', 9, 35.00, '', false],
    ['TVEC (electric)', 'Needs', 10, 138.60, '', false],
    ['Google Photos (Josh)', 'Wants', 10, 1.99, '', false],
    ['ATT (phone)', 'Needs', 10, 154.53, '', true],
    ['Water', 'Needs', 11, 130.25, '', false],
    ['Att (internet)', 'Needs', 12, 75.56, '', true],
    ['Debt Snowball', 'Debts/Savings', 13, 91.00, '', false],
    ['Savings acct. fee', 'Needs', 14, 8.00, '', false],
    ['Mortgage 2', 'Needs', 15, 1274.52, '', true],
    ['Car Note', 'Needs', 18, 487.99, '', false],
    ['Hulu/Disney+', 'Wants', 18, 11.93, '', true],
    ['Chase CC', 'Debts/Savings', 18, 46.00, '', false],
    ['Ring Pro', 'Needs', 19, 21.25, '', true],
    ['AppleCare+(Josh)', 'Needs', 20, 14.84, '', true],
    ['Debt Snowball', 'Debts/Savings', 20, 74.00, '', false],
    ['Paramount+', 'Wants', 21, 14.06, '', true],
    ['Amex J', 'Debts/Savings', 25, 235.00, '', false],
    ['AppleCare+ (Taylor)', 'Needs', 26, 14.84, '', true],
    ['Citi CC T2', 'Debts/Savings', 27, 80.00, '', false],
    ['Atmos (Gas)', 'Needs', 27, 79.28, '', false],
    ['Spotify', 'Wants', 28, 20.56, '', true],
    ['Debt Snowball', 'Debts/Savings', 28, 53.00, '', false],
    ['Citi CC J', 'Debts/Savings', 28, 28.00, '', false],
    ['Debt Snowball', 'Debts/Savings', 28, 100.00, '', false],
    ['Netflix', 'Wants', 29, 36.78, '', true],
    ['Car Wash', 'Wants', 30, 41.98, '', false],
  ];

  const now = new Date().toISOString();

  function defaultMatchWordsForBill(name) {
    const key = String(name || '').toLowerCase();
    if (key.includes('mortgage')) return 'mortgage,rocket,loan';
    if (key.includes('att') && key.includes('phone')) return 'att,phone';
    if (key.includes('att') && key.includes('internet')) return 'att,internet';
    if (key.includes('tvec')) return 'tvec,electric';
    if (key.includes('netflix')) return 'netflix';
    if (key.includes('spotify')) return 'spotify';
    if (key.includes('hulu') || key.includes('disney')) return 'hulu,disney';
    if (key.includes('atmos') || key.includes('gas')) return 'atmos,gas';
    if (key.includes('water')) return 'water';
    if (key.includes('ring')) return 'ring';
    if (key.includes('applecare')) return 'applecare,apple';
    if (key.includes('apple storage')) return 'apple,storage';
    return '';
  }

  const insertStmt = db.prepare(
    'INSERT INTO recurring_bills_list_items (id, name, category, due_day, amount, paid_from, match_words, autopay, active, notes, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  seededRows.forEach((row, index) => {
    const [name, category, dueDay, amount, paidFrom, autopay] = row;
    insertStmt.run(
      randomUUID(),
      name,
      category,
      dueDay,
      amount,
      paidFrom,
      defaultMatchWordsForBill(name),
      autopay ? 1 : 0,
      1,
      null,
      index,
      now,
      now
    );
  });
}

function seedMasterListsIfEmpty() {
  seedExpenseListIfEmpty();
  seedRecurringBillsListIfEmpty();
}

function ensureRecurringBillStatusTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_bill_status (
      id TEXT PRIMARY KEY,
      period_id TEXT NOT NULL,
      recurring_bill_id TEXT NOT NULL,
      paid INTEGER DEFAULT 0,
      paid_date TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(period_id, recurring_bill_id)
    )
  `);

  // Safely add match tracking columns
  const columns = db.prepare("PRAGMA table_info('recurring_bill_status')").all();
  const columnNames = columns.map((c) => c.name);

  if (!columnNames.includes('match_transaction_id')) {
    db.exec('ALTER TABLE recurring_bill_status ADD COLUMN match_transaction_id TEXT');
  }
  if (!columnNames.includes('match_score')) {
    db.exec('ALTER TABLE recurring_bill_status ADD COLUMN match_score REAL DEFAULT 0');
  }
  if (!columnNames.includes('match_method')) {
    db.exec('ALTER TABLE recurring_bill_status ADD COLUMN match_method TEXT');
  }
  if (!columnNames.includes('auto_paid')) {
    db.exec('ALTER TABLE recurring_bill_status ADD COLUMN auto_paid INTEGER DEFAULT 0');
  }
  if (!columnNames.includes('manual_paid')) {
    db.exec('ALTER TABLE recurring_bill_status ADD COLUMN manual_paid INTEGER DEFAULT 0');
  }
  if (!columnNames.includes('manually_overridden')) {
    db.exec('ALTER TABLE recurring_bill_status ADD COLUMN manually_overridden INTEGER DEFAULT 0');
  }
}

function ensureRecurringBillsListColumns() {
  const columns = db.prepare("PRAGMA table_info('recurring_bills_list_items')").all();
  const columnNames = columns.map((c) => c.name);

  if (!columnNames.includes('match_words')) {
    db.exec('ALTER TABLE recurring_bills_list_items ADD COLUMN match_words TEXT');
  }
}

function ensureTransactionRulesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transaction_rules (
      id TEXT PRIMARY KEY,
      name TEXT,
      enabled INTEGER DEFAULT 1,
      match_type TEXT DEFAULT 'contains',
      match_value TEXT NOT NULL,
      account_id TEXT,
      amount_min REAL,
      amount_max REAL,
      set_type TEXT,
      set_category TEXT,
      set_ignored INTEGER DEFAULT 0,
      apply_to_unreviewed_only INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    )
  `);
}

ensureLegacyMasterListItemsTable();
ensureExpenseListTable();
ensureRecurringBillsListTable();
ensureRecurringBillsListColumns();
ensureRecurringBillStatusTable();
ensureTransactionRulesTable();
ensureIndexes();
seedMasterListsIfEmpty();

function migratePlaintextPlaidTokens() {
  const rows = db.prepare('SELECT id, access_token FROM plaid_items').all();
  const update = db.prepare('UPDATE plaid_items SET access_token = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();

  for (const row of rows) {
    if (!row.access_token || isEncryptedSecret(row.access_token)) continue;
    update.run(encryptSecret(row.access_token), now, row.id);
  }
}

migratePlaintextPlaidTokens();

/**
 * Safely convert a value for SQLite binding.
 * Handles undefined, null, boolean, Date, Buffer, arrays, objects, and primitives.
 */
export function safeSqlValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  return String(value);
}

export default db;
