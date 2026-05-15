import { apiGet, apiPost, apiDelete, API_BASE } from './client.js';

export function getPlaidStatus() {
  return apiGet('/api/plaid/status');
}

export function getAccounts() {
  return apiGet('/api/accounts');
}

export function createLinkToken() {
  return apiPost('/api/plaid/create-link-token', {});
}

export function exchangePublicToken(publicToken) {
  return apiPost('/api/plaid/exchange-public-token', { public_token: publicToken });
}

export function syncTransactions() {
  return apiPost('/api/plaid/sync-transactions', {});
}

export function removePlaidItem(itemId) {
  return apiDelete('/api/plaid/items/' + encodeURIComponent(itemId));
}

export function cleanupRemovedPlaid() {
  return apiPost('/api/plaid/cleanup-removed', {});
}

export function loadPlaidScript() {
  return new Promise(function (resolve, reject) {
    if (window.Plaid) return resolve();
    const script = document.createElement('script');
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    script.onload = resolve;
    script.onerror = function () { reject(new Error('Failed to load Plaid Link script.')); };
    document.head.appendChild(script);
  });
}
