import { Router } from 'express';
import db from '../db.js';

const router = Router();

/**
 * GET /api/settings/:key
 * Retrieve a setting by key from the settings table.
 * Returns: { key, value }
 */
router.get('/:key', (req, res) => {
  try {
    const { key } = req.params;
    if (!key || typeof key !== 'string' || key.trim() === '') {
      return res.status(400).json({ error: 'key is required' });
    }

    const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
    if (!row) {
      return res.json({ key, value: null });
    }

    let value = null;
    try {
      value = row.value_json ? JSON.parse(row.value_json) : null;
    } catch (_e) {
      value = row.value_json;
    }

    res.json({ key, value });
  } catch (err) {
    console.error('Error retrieving setting:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/settings/:key
 * Update or create a setting.
 * Body: { value } - can be any JSON-serializable value
 * Returns: { key, value, updated_at }
 */
router.patch('/:key', (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (!key || typeof key !== 'string' || key.trim() === '') {
      return res.status(400).json({ error: 'key is required' });
    }

    const valueJson = value !== undefined ? JSON.stringify(value) : null;
    const now = new Date().toISOString();

    // Insert or replace
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = ?, updated_at = ?`
    ).run(key, valueJson, now, valueJson, now);

    res.json({ key, value, updated_at: now });
  } catch (err) {
    console.error('Error updating setting:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
