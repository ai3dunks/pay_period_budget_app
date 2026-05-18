import { apiGet, apiPost, apiDelete } from './client.js';

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

export function removePlaidAccount(plaidAccountId) {
  return apiDelete('/api/plaid/accounts/' + encodeURIComponent(plaidAccountId));
}

export function restorePlaidAccount(plaidAccountId) {
  return apiPost('/api/plaid/accounts/' + encodeURIComponent(plaidAccountId) + '/restore', {});
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
