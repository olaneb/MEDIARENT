const fs = require('fs');
const { db } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { listBackups, createBackup, pruneOldBackups, restoreFromBackup, backupPathFor } = require('../lib/backup');
const { systemHealth, runIntegrityChecks, cleanupStaleSessions } = require('../lib/health');

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = function (router) {
  // ---------- BACKUPS ----------
  router.get('/api/system/backups', async (ctx) => {
    if (!ctx.require('admin.backup')) return;
    ctx.json(200, { backups: listBackups(), retention_days: parseInt(getSetting('backup_retention_days', '30'), 10) });
  });

  router.post('/api/system/backups', async (ctx) => {
    if (!ctx.require('admin.backup')) return;
    if (!ctx.requireCsrf()) return;
    const result = createBackup(db, ctx.body?.label || 'manual');
    logAudit(ctx.user.id, 'backup_created', 'backup', null, result, ctx.ip);
    ctx.json(201, result);
  });

  router.get('/api/system/backups/:filename/download', async (ctx, { filename }) => {
    if (!ctx.require('admin.backup')) return;
    try {
      const filePath = backupPathFor(filename);
      const data = fs.readFileSync(filePath);
      ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"` });
      ctx.res.end(data);
      logAudit(ctx.user.id, 'backup_downloaded', 'backup', null, { filename }, ctx.ip);
    } catch (err) {
      ctx.json(404, { error: err.message });
    }
  });

  router.post('/api/system/backups/:filename/restore', async (ctx, { filename }) => {
    if (!ctx.require('admin.backup')) return;
    if (!ctx.requireCsrf()) return;
    try {
      const result = restoreFromBackup(db, filename);
      logAudit(ctx.user.id, 'backup_restored', 'backup', null, result, ctx.ip);
      ctx.json(200, { ok: true, ...result, message: 'Restore complete. No restart needed.' });
    } catch (err) {
      ctx.json(400, { error: err.message });
    }
  });

  router.put('/api/system/backups/retention', async (ctx) => {
    if (!ctx.require('admin.backup')) return;
    if (!ctx.requireCsrf()) return;
    const days = parseInt(ctx.body.days, 10);
    if (!days || days < 1) return ctx.json(400, { error: 'days must be a positive integer' });
    setSetting('backup_retention_days', days);
    const removed = pruneOldBackups(days);
    logAudit(ctx.user.id, 'backup_retention_updated', null, null, { days, removed }, ctx.ip);
    ctx.json(200, { ok: true, removed });
  });

  // ---------- SYSTEM HEALTH ----------
  router.get('/api/system/health', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    ctx.json(200, systemHealth());
  });

  router.get('/api/system/integrity-checks', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    ctx.json(200, { issues: runIntegrityChecks() });
  });

  router.post('/api/system/cleanup-sessions', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    if (!ctx.requireCsrf()) return;
    const removed = cleanupStaleSessions();
    logAudit(ctx.user.id, 'stale_sessions_cleaned', null, null, { removed }, ctx.ip);
    ctx.json(200, { removed });
  });

  // ---------- MAINTENANCE MODE ----------
  router.get('/api/system/maintenance-mode', async (ctx) => {
    ctx.json(200, {
      enabled: getSetting('maintenance_mode', '0') === '1',
      message: getSetting('maintenance_mode_message', 'The portal is undergoing scheduled maintenance. Please check back shortly.'),
    });
  });

  router.put('/api/system/maintenance-mode', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    if (!ctx.requireCsrf()) return;
    setSetting('maintenance_mode', ctx.body.enabled ? '1' : '0');
    if (ctx.body.message) setSetting('maintenance_mode_message', ctx.body.message);
    logAudit(ctx.user.id, 'maintenance_mode_toggled', null, null, { enabled: !!ctx.body.enabled }, ctx.ip);
    ctx.json(200, { ok: true });
  });
};
