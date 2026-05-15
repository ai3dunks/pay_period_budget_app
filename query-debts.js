import Database from 'better-sqlite3';
const db = new Database('data/budget.db');
db.prepare(`UPDATE debt_snowball_debts SET current_balance = starting_balance, status = 'active' WHERE name = 'Bank of America CC Taylor'`).run();
const result = db.prepare('SELECT id, name, current_balance, starting_balance, status FROM debt_snowball_debts WHERE name = ?').get('Bank of America CC Taylor');
console.log('Updated debt:', JSON.stringify(result, null, 2));
