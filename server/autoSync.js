import db from './db.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;

let inFlight = false;
let lastLocalAttemptAt = 0;

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLastSyncAttemptAt() {
  const row = db.prepare('SELECT value_json, updated_at FROM settings WHERE key = ?').get('plaid_last_sync_result');
  if (!row) return 0;
  let value = {};
  try {
    value = row.value_json ? JSON.parse(row.value_json) : {};
  } catch {
    value = {};
  }
  return Math.max(parseTimestamp(value.lastSyncedAt), parseTimestamp(value.updatedAt), parseTimestamp(row.updated_at));
}

function hasConnectedPlaidItem() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM plaid_items WHERE status IS NULL OR status IN ('active', 'connected')").get();
  return Number(row?.count || 0) > 0;
}

async function maybeSync({ host, port }) {
  if (inFlight) return;
  if (!process.env.LOCAL_API_TOKEN) return;
  if (!hasConnectedPlaidItem()) return;

  const now = Date.now();
  if (lastLocalAttemptAt && now - lastLocalAttemptAt < ONE_HOUR_MS) return;

  const lastStoredAttemptAt = getLastSyncAttemptAt();
  if (lastStoredAttemptAt && now - lastStoredAttemptAt < ONE_HOUR_MS) {
    lastLocalAttemptAt = lastStoredAttemptAt;
    return;
  }

  inFlight = true;
  lastLocalAttemptAt = now;
  try {
    const response = await fetch(`http://${host}:${port}/api/plaid/sync-transactions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.LOCAL_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok) {
      console.warn('[auto-sync] Hourly transaction sync failed with HTTP ' + response.status + '.');
    }
  } catch (err) {
    console.warn('[auto-sync] Hourly transaction sync failed:', err?.message || err);
  } finally {
    inFlight = false;
  }
}

export function startHourlyTransactionAutoSync({ host, port }) {
  if (process.env.DISABLE_AUTO_TRANSACTION_SYNC === '1') return;
  windowlessSetTimeout(() => maybeSync({ host, port }), STARTUP_DELAY_MS);
  setInterval(() => maybeSync({ host, port }), CHECK_INTERVAL_MS);
}

function windowlessSetTimeout(callback, delay) {
  setTimeout(callback, delay);
}
