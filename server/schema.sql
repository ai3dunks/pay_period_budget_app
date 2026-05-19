CREATE TABLE IF NOT EXISTS plaid_items (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  cursor TEXT,
  status TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  plaid_account_id TEXT UNIQUE NOT NULL,
  institution_name TEXT,
  name TEXT,
  official_name TEXT,
  mask TEXT,
  type TEXT,
  subtype TEXT,
  balance_current REAL,
  balance_available REAL,
  iso_currency_code TEXT,
  raw_json TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  plaid_transaction_id TEXT UNIQUE NOT NULL,
  item_id TEXT,
  plaid_account_id TEXT,
  account_id TEXT,
  date TEXT,
  authorized_date TEXT,
  name TEXT,
  merchant_name TEXT,
  amount REAL,
  pending INTEGER,
  type TEXT,
  category TEXT,
  reviewed INTEGER DEFAULT 0,
  ignored INTEGER DEFAULT 0,
  pending_transaction_id TEXT,
  bucket_id TEXT,
  bucket_name TEXT,
  notes TEXT,
  raw_json TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS transaction_splits (
  id TEXT PRIMARY KEY,
  parent_transaction_id TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  amount REAL NOT NULL,
  note TEXT,
  display_order INTEGER DEFAULT 0,
  is_final INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS budget_buckets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  budget_group TEXT NOT NULL,
  pay_period_start TEXT NOT NULL,
  pay_period_end TEXT NOT NULL,
  planned_amount REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS transaction_rules (
  id TEXT PRIMARY KEY,
  name TEXT,
  enabled INTEGER DEFAULT 1,
  match_type TEXT DEFAULT 'contains',
  match_value TEXT NOT NULL,
  account_id TEXT,
  amount_min REAL,
  amount_max REAL,
  priority INTEGER DEFAULT 100,
  match_field TEXT DEFAULT 'merchant_or_description',
  match_operator TEXT DEFAULT 'contains',
  set_type TEXT,
  set_category TEXT,
  apply_type TEXT,
  apply_category TEXT,
  apply_subcategory TEXT,
  apply_reviewed INTEGER DEFAULT 0,
  confidence_mode TEXT DEFAULT 'suggest',
  apply_to_pending INTEGER DEFAULT 0,
  set_ignored INTEGER DEFAULT 0,
  apply_to_unreviewed_only INTEGER DEFAULT 1,
  created_from_transaction_id TEXT,
  last_applied_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS expense_list_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  budget_amount REAL DEFAULT 0,
  active INTEGER DEFAULT 1,
  notes TEXT,
  display_order INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

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
);

CREATE TABLE IF NOT EXISTS debt_snowball_debts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creditor TEXT,
  type TEXT,
  current_balance REAL DEFAULT 0,
  starting_balance REAL DEFAULT 0,
  interest_rate REAL DEFAULT 0,
  minimum_payment REAL DEFAULT 0,
  credit_limit REAL,
  due_day INTEGER,
  category TEXT,
  status TEXT DEFAULT 'active',
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- Legacy/deprecated table kept for compatibility with prior migrations.
-- Active UI and calculations use expense_list_items and recurring_bills_list_items.
CREATE TABLE IF NOT EXISTS master_list_items (
  id TEXT PRIMARY KEY,
  list_type TEXT NOT NULL,
  name TEXT NOT NULL,
  display_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS pay_period_snapshots (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL,
  period_label TEXT NOT NULL,
  start_date TEXT NOT NULL,
  display_end_date TEXT NOT NULL,
  exclusive_end_date TEXT NOT NULL,
  budget_income REAL DEFAULT 0,
  regular_paycheck REAL DEFAULT 0,
  bonus_income REAL DEFAULT 0,
  other_income REAL DEFAULT 0,
  boa_rollover REAL DEFAULT 0,
  recurring_bills_due REAL DEFAULT 0,
  recurring_bills_paid REAL DEFAULT 0,
  recurring_bills_left_to_pay REAL DEFAULT 0,
  expense_budget REAL DEFAULT 0,
  actual_expense_spending REAL DEFAULT 0,
  expense_remaining REAL DEFAULT 0,
  cash_remaining REAL DEFAULT 0,
  planned_transfers_total REAL DEFAULT 0,
  josh_transfer REAL DEFAULT 0,
  taylor_transfer REAL DEFAULT 0,
  discover_transfer REAL DEFAULT 0,
  debt_savings_transfer REAL DEFAULT 0,
  boa_reserve REAL DEFAULT 0,
  total_transactions INTEGER DEFAULT 0,
  reviewed_transactions INTEGER DEFAULT 0,
  unreviewed_transactions INTEGER DEFAULT 0,
  ignored_transactions INTEGER DEFAULT 0,
  snapshot_json TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS pay_period_closeouts (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL UNIQUE,
  period_label TEXT NOT NULL,
  start_date TEXT NOT NULL,
  display_end_date TEXT NOT NULL,
  exclusive_end_date TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  closed_at TEXT,
  reopened_at TEXT,
  snapshot_id TEXT,
  income_confirmed INTEGER DEFAULT 0,
  bills_confirmed INTEGER DEFAULT 0,
  transfers_confirmed INTEGER DEFAULT 0,
  expenses_confirmed INTEGER DEFAULT 0,
  rollover_confirmed INTEGER DEFAULT 0,
  notes TEXT,
  carry_forward_notes TEXT,
  closeout_json TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS recurring_bill_status (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL,
  recurring_bill_id TEXT NOT NULL,
  paid INTEGER DEFAULT 0,
  paid_date TEXT,
  notes TEXT,
  match_transaction_id TEXT,
  match_score REAL DEFAULT 0,
  match_method TEXT,
  auto_paid INTEGER DEFAULT 0,
  manual_paid INTEGER DEFAULT 0,
  manually_overridden INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(period_id, recurring_bill_id)
);

CREATE TABLE IF NOT EXISTS backup_import_logs (
  id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  backup_version INTEGER DEFAULT 1,
  mode TEXT NOT NULL,
  counts_json TEXT,
  warnings_json TEXT,
  errors_json TEXT
);

CREATE TABLE IF NOT EXISTS debt_savings_transfer_confirmations (
  id TEXT PRIMARY KEY,
  budget_period_id TEXT NOT NULL,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  source_target_id TEXT DEFAULT '',
  source_target_name TEXT DEFAULT '',
  source_account TEXT DEFAULT '',
  destination_account TEXT DEFAULT '',
  status TEXT DEFAULT 'transfer_confirmed',
  confirmed_at TEXT,
  notes TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS expense_funding_records (
  id TEXT PRIMARY KEY,
  budget_period_id TEXT NOT NULL,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  source_target_id TEXT DEFAULT '',
  source_target_name TEXT DEFAULT '',
  confirmed_amount REAL DEFAULT 0,
  status TEXT DEFAULT 'transfer_confirmed',
  confirmed_at TEXT,
  notes TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS debt_snowball_payment_plans (
  id TEXT PRIMARY KEY,
  budget_period_id TEXT NOT NULL,
  transfer_confirmation_id TEXT,
  target_debt_id TEXT,
  target_debt_name TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  applied_amount REAL DEFAULT 0,
  strategy TEXT DEFAULT 'snowball',
  status TEXT DEFAULT 'planned',
  applied_at TEXT,
  notes TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS transfer_confirmations (
  id TEXT PRIMARY KEY,
  budget_period_id TEXT NOT NULL,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  target_name TEXT NOT NULL,
  planned_transfer REAL DEFAULT 0,
  already_used_at_confirmation REAL DEFAULT 0,
  confirmed_transfer_amount REAL DEFAULT 0,
  status TEXT DEFAULT 'not_confirmed',
  confirmed_at TEXT,
  sent_to_debt_snowball INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS cash_flow_forecast_adjustments (
  id TEXT PRIMARY KEY,
  budget_period_id TEXT NOT NULL,
  date TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT DEFAULT 'adjustment',
  amount REAL DEFAULT 0,
  account TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cash_flow_adjustments_period
ON cash_flow_forecast_adjustments(budget_period_id, date);

CREATE INDEX IF NOT EXISTS idx_transfer_confirmations_period_target 
ON transfer_confirmations(budget_period_id, target_name);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_period_review ON transactions(date, reviewed, ignored, pending);
CREATE INDEX IF NOT EXISTS idx_transactions_type_category ON transactions(type, category);
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id, plaid_account_id);

CREATE INDEX IF NOT EXISTS idx_transactions_account_date
ON transactions(account_id, date);

CREATE INDEX IF NOT EXISTS idx_transactions_reviewed_ignored
ON transactions(reviewed, ignored);

CREATE INDEX IF NOT EXISTS idx_transactions_pending
ON transactions(pending);

CREATE INDEX IF NOT EXISTS idx_transactions_plaid_id
ON transactions(plaid_transaction_id);

CREATE INDEX IF NOT EXISTS idx_transactions_item_id
ON transactions(item_id);

CREATE INDEX IF NOT EXISTS idx_transaction_splits_parent
ON transaction_splits(parent_transaction_id, display_order);

CREATE INDEX IF NOT EXISTS idx_transaction_splits_parent_final
ON transaction_splits(parent_transaction_id, is_final);

CREATE INDEX IF NOT EXISTS idx_history_period
ON pay_period_snapshots(period_id);

CREATE INDEX IF NOT EXISTS idx_closeout_period
ON pay_period_closeouts(period_id);

CREATE INDEX IF NOT EXISTS idx_rules_enabled
ON transaction_rules(enabled);

CREATE INDEX IF NOT EXISTS idx_debt_snowball_status
ON debt_snowball_debts(status);

CREATE INDEX IF NOT EXISTS idx_debt_snowball_due_day
ON debt_snowball_debts(due_day);

CREATE INDEX IF NOT EXISTS idx_budget_buckets_period
ON budget_buckets(pay_period_start, pay_period_end);

CREATE INDEX IF NOT EXISTS idx_budget_buckets_group
ON budget_buckets(budget_group);
