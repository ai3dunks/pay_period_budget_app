import { apiGet } from '../api/client.js';
import { getPlaidStatus, syncTransactions } from '../api/plaidApi.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

let started = false;
let inFlight = false;
let lastLocalAttemptAt = 0;

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestTimestamp(...values) {
  return values.reduce((latest, value) => Math.max(latest, parseTimestamp(value)), 0);
}

async function getLastSyncAttemptAt() {
  try {
    const data = await apiGet('/api/settings/plaid_last_sync_result');
    const value = data?.value || {};
    return newestTimestamp(value.lastSyncedAt, value.updatedAt);
  } catch {
    return 0;
  }
}

async function hasConnectedPlaidItem() {
  try {
    const status = await getPlaidStatus();
    return Array.isArray(status?.items) && status.items.some((item) => {
      const state = String(item?.status || 'connected').toLowerCase();
      return state === 'active' || state === 'connected' || state === '';
    });
  } catch {
    return false;
  }
}

async function maybeSyncTransactions(onSynced) {
  if (inFlight) return;
  if (document.visibilityState === 'hidden') return;

  const now = Date.now();
  if (lastLocalAttemptAt && now - lastLocalAttemptAt < ONE_HOUR_MS) return;

  const lastBackendAttemptAt = await getLastSyncAttemptAt();
  if (lastBackendAttemptAt && now - lastBackendAttemptAt < ONE_HOUR_MS) {
    lastLocalAttemptAt = lastBackendAttemptAt;
    return;
  }

  if (!(await hasConnectedPlaidItem())) return;

  inFlight = true;
  lastLocalAttemptAt = now;
  try {
    const result = await syncTransactions();
    onSynced?.(result);
  } catch (err) {
    console.warn('[auto-sync] Transaction sync attempt failed:', err?.message || err);
  } finally {
    inFlight = false;
  }
}

export function startHourlyTransactionAutoSync({ onSynced } = {}) {
  if (started || typeof window === 'undefined') return;
  started = true;

  window.setTimeout(() => {
    maybeSyncTransactions(onSynced);
  }, 10000);

  window.setInterval(() => {
    maybeSyncTransactions(onSynced);
  }, CHECK_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeSyncTransactions(onSynced);
  });

  window.addEventListener('online', () => {
    maybeSyncTransactions(onSynced);
  });
}
