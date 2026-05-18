/**
 * Base API client.
 * All fetch calls go through here for consistent error handling.
 */

export const API_BASE = '';

/**
 * Build a query string from a params object, omitting null/undefined/empty values.
 * Returns '' if params is empty, otherwise '?key=value&...'
 */
export function buildQueryString(params) {
  if (!params || typeof params !== 'object') return '';
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(API_BASE + path, options);
  } catch (_err) {
    const err = new Error('Backend not reachable through the local API proxy.');
    err.offline = true;
    throw err;
  }

  let data = {};
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_e) {
      // non-JSON response
    }
  }

  if (!response.ok) {
    if (response.status === 413) {
      const err = new Error('Request payload is too large.');
      err.status = 413;
      throw err;
    }
    const err = new Error(data.error || ('HTTP ' + response.status));
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

export function apiGet(path, params) {
  const qs = params && typeof params === 'object' ? buildQueryString(params) : '';
  return request(path + qs);
}

export function apiPost(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export function apiPatch(path, body) {
  return request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export function apiDelete(path) {
  return request(path, { method: 'DELETE' });
}
