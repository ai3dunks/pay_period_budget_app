import { apiGet, apiPatch } from './client.js';

export function clearSettingsCache() {
  // Settings are read through live API requests.
  // This hook keeps restore refresh flows explicit and centralized.
}

export async function getSetting(key) {
  const data = await apiGet('/api/settings/' + encodeURIComponent(key));
  return data.value && typeof data.value === 'object' ? data.value : {};
}

export function updateSetting(key, value) {
  return apiPatch('/api/settings/' + encodeURIComponent(key), { value });
}
