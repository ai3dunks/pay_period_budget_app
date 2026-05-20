/**
 * src/ui/backup.js
 *
 * Backup & Restore UI component for the Settings page.
 * Exports: renderBackupSection(container)
 */

import { emitAppEvent } from '../app/events.js';
import { clearMasterListsCache } from '../api/masterListsApi.js';
import { clearSettingsCache } from '../api/settingsApi.js';
import { clearTransactionDerivedCaches } from '../api/transactionsApi.js';
import { clearCommandCenterCache } from '../utils/commandCenter.js';

const BACKEND = '';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(iso) {
  if (!iso) return '–';
  try { return new Date(iso).toLocaleString(); } catch (_e) { return iso; }
}

function showMsg(el, text, type) {
  if (!el) return;
  el.className = 'settings-message ' + (type === 'error' ? 'error' : type === 'success' ? 'success' : '');
  el.textContent = text;
}

// ─────────────────────────────────────────────
// Render the full Backup & Restore section HTML
// ─────────────────────────────────────────────
export function renderBackupSection(container) {
  const section = document.createElement('section');
  section.className = 'card settings-section';
  section.id = 'backup-restore-section';
  section.innerHTML = `
    <div class="card-header">
      <h3 class="card-title">Backup &amp; Restore</h3>
      <p class="card-description">
        Export your budget setup to a JSON file or restore from a previous backup.
      </p>
    </div>
    <div class="backup-info-banner">
      <strong>What is included:</strong> settings, expense list, recurring bills, transaction review labels,
      bill statuses, transfer rules, history snapshots, and closeouts.
      <br>
      <strong>What is excluded:</strong> Plaid access tokens, raw Plaid JSON, .env values, and the database file.
      You may need to reconnect your bank on a new machine.
    </div>

    <div class="settings-actions">
      <button type="button" class="button button-primary" id="backup-export-btn">Export Backup</button>
      <label class="button button-secondary" style="cursor:pointer;">
        Select Backup File
        <input type="file" id="backup-file-input" accept=".json" style="display:none">
      </label>
    </div>

    <div id="backup-file-info" style="display:none" class="backup-file-info">
      <div id="backup-preview-panel"></div>
    </div>

    <div id="backup-message" class="settings-message" aria-live="polite"></div>
  `;

  container.appendChild(section);

  const exportBtn = section.querySelector('#backup-export-btn');
  const fileInput = section.querySelector('#backup-file-input');
  const fileInfo = section.querySelector('#backup-file-info');
  const previewPanel = section.querySelector('#backup-preview-panel');
  const msgEl = section.querySelector('#backup-message');

  // ── Export ──────────────────────────────────
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    showMsg(msgEl, 'Exporting…', '');
    try {
      const res = await fetch(BACKEND + '/api/backup/export');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'HTTP ' + res.status);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `budget-dashboard-backup-${today}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showMsg(msgEl, 'Backup downloaded successfully.', 'success');
    } catch (err) {
      const msg = err.message.includes('Failed to fetch')
        ? 'Backend not reachable through the local API proxy.'
        : 'Backup export failed: ' + err.message;
      showMsg(msgEl, msg, 'error');
    } finally {
      exportBtn.disabled = false;
    }
  });

  // ── File picker → preview ───────────────────
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    showMsg(msgEl, 'Reading file…', '');
    fileInfo.style.display = 'none';
    previewPanel.innerHTML = '';

    let backup;
    try {
      const text = await file.text();
      backup = JSON.parse(text);
    } catch (_e) {
      showMsg(msgEl, 'Backup file is not valid JSON.', 'error');
      return;
    }

    // Size guard on client side
    const sizeKb = (file.size / 1024).toFixed(1);
    if (file.size > 10 * 1024 * 1024) {
      showMsg(msgEl, 'Backup file is too large (>' + sizeKb + ' KB). Import rejected.', 'error');
      return;
    }

    showMsg(msgEl, 'Previewing…', '');
    try {
      const res = await fetch(BACKEND + '/api/backup/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(backup),
      });
      const preview = await res.json();
      if (!preview.ok) {
        const errText = preview.errors?.join('; ') || preview.error || 'Preview failed.';
        showMsg(msgEl, errText, 'error');
        if (errText.includes('forbidden')) {
          showMsg(msgEl, 'Backup contains forbidden secret fields and was rejected.', 'error');
        }
        return;
      }
      showMsg(msgEl, '', '');
      renderPreviewPanel(previewPanel, preview, backup, msgEl);
      fileInfo.style.display = 'block';
    } catch (err) {
      const msg = err.message.includes('Failed to fetch')
        ? 'Backend not reachable through the local API proxy.'
        : 'Preview failed: ' + err.message;
      showMsg(msgEl, msg, 'error');
    }
  });
}

// ─────────────────────────────────────────────
// Preview panel
// ─────────────────────────────────────────────
function renderPreviewPanel(container, preview, backup, msgEl) {
  const { counts, warnings, actionsPreview, exportedAt, backupVersion } = preview;

  const warningsHtml = warnings && warnings.length
    ? `<div class="backup-warnings">
        <strong>Warnings:</strong>
        <ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
       </div>`
    : '';

  const countsRows = Object.entries(counts || {})
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
    .join('');

  container.innerHTML = `
    <div class="backup-preview">
      <h4>Backup Details</h4>
      <table class="table backup-counts-table">
        <tbody>
          <tr><td>Exported at</td><td>${escapeHtml(fmtDate(exportedAt))}</td></tr>
          <tr><td>Backup version</td><td>${escapeHtml(String(backupVersion ?? '–'))}</td></tr>
          ${countsRows}
        </tbody>
      </table>
      ${warningsHtml}
      <div class="backup-mode-selector">
        <h4>Import Mode</h4>
        <label class="form-field">
          <select id="backup-mode-select">
            <option value="merge" selected>Merge into current data (safe, recommended)</option>
            <option value="replace_safe_data">Replace safe setup data</option>
          </select>
        </label>
        <div id="backup-replace-confirm" style="display:none" class="backup-replace-confirm">
          <p class="backup-replace-warning">
            <strong>Warning:</strong> This will delete and replace your settings, expense list, recurring bills,
            and transaction rules. Plaid connections, accounts, and raw transactions are never deleted.
          </p>
          <label class="form-field">
            <span>Type <strong>REPLACE SAFE DATA</strong> to confirm:</span>
            <input type="text" id="backup-confirm-text" placeholder="REPLACE SAFE DATA" autocomplete="off">
          </label>
        </div>
      </div>
      <div class="settings-actions">
        <button type="button" class="button button-primary" id="backup-import-btn">Import Backup</button>
      </div>
    </div>
  `;

  const modeSelect = container.querySelector('#backup-mode-select');
  const replaceConfirm = container.querySelector('#backup-replace-confirm');
  const importBtn = container.querySelector('#backup-import-btn');

  modeSelect.addEventListener('change', () => {
    replaceConfirm.style.display = modeSelect.value === 'replace_safe_data' ? 'block' : 'none';
  });

  importBtn.addEventListener('click', async () => {
    const mode = modeSelect.value;
    if (mode === 'replace_safe_data') {
      const confirmText = container.querySelector('#backup-confirm-text')?.value?.trim();
      if (confirmText !== 'REPLACE SAFE DATA') {
        showMsg(msgEl, 'Type REPLACE SAFE DATA exactly to confirm replace mode.', 'error');
        return;
      }
    }

    importBtn.disabled = true;
    showMsg(msgEl, 'Importing…', '');
    try {
      const res = await fetch(BACKEND + '/api/backup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backup,
          mode,
          confirmText: mode === 'replace_safe_data' ? 'REPLACE SAFE DATA' : '',
        }),
      });
      const result = await res.json();
      if (!result.ok) {
        const errMsg = result.message || result.errors?.join('; ') || result.error || 'Import failed.';
        showMsg(msgEl, errMsg, 'error');
        return;
      }

      clearMasterListsCache();
      clearSettingsCache();
      clearCommandCenterCache();
      clearTransactionDerivedCaches();

      emitAppEvent('budget:transactions-updated');
      emitAppEvent('budget:recurring-bills-updated');
      emitAppEvent('budget:income-updated');
      emitAppEvent('budget:planner-refresh');
      emitAppEvent('app:navigation-needs-render');
      emitAppEvent('app:page-needs-render');

      showMsg(msgEl, 'Backup restored. App data has been refreshed.', 'success');
    } catch (err) {
      const msg = err.message.includes('Failed to fetch')
        ? 'Backend not reachable through the local API proxy.'
        : 'Import failed: ' + err.message;
      showMsg(msgEl, msg, 'error');
    } finally {
      importBtn.disabled = false;
    }
  });
}
