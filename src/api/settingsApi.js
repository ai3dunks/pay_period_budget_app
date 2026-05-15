import { apiGet, apiPatch } from './client.js';

export async function getSetting(key) {
  const data = await apiGet('/api/settings/' + encodeURIComponent(key));
  return data.value && typeof data.value === 'object' ? data.value : {};
}

export function updateSetting(key, value) {
  return apiPatch('/api/settings/' + encodeURIComponent(key), { value });
}
