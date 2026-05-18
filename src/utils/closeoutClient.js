const BACKEND = '';

async function fetchJson(path, options = {}) {
  const response = await fetch(BACKEND + path, options);
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_err) {
      data = {};
    }
  }
  if (!response.ok) {
    if (response.status === 413) {
      const error = new Error('Closeout payload was too large. The app tried to save too much detail. Try again after compact summary fix.');
      error.status = 413;
      throw error;
    }
    const error = new Error(data.error || ('HTTP ' + response.status));
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function fetchCloseoutRecord(periodId) {
  return await fetchJson('/api/closeout?periodId=' + encodeURIComponent(periodId));
}

export async function prepareCloseoutRecord(payload) {
  return await fetchJson('/api/closeout/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function patchCloseoutRecord(id, payload) {
  return await fetchJson('/api/closeout/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function closeCloseoutRecord(id) {
  return await fetchJson('/api/closeout/' + encodeURIComponent(id) + '/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function reopenCloseoutRecord(id) {
  return await fetchJson('/api/closeout/' + encodeURIComponent(id) + '/reopen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}
