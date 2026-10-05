// Automatic backups. A volume on Fly.io is not off-site, so the app protects itself: once a day (configurable)
// it takes an integrity-checked snapshot into <data>/backups and prunes old ones per the retention setting
// (Admin > System). Restores and manual backups are unaffected.
//   BACKUP_INTERVAL_HOURS   default 24   (0 disables automatic backups)
//   BACKUP_CHECK_MINUTES    default 60   how often to check whether a backup is due
const { db, getSetting } = require('./db');
const { listBackups, createBackup, pruneOldBackups } = require('./backup');

const intervalHours = () => { const v = Number(process.env.BACKUP_INTERVAL_HOURS); return Number.isFinite(v) && v >= 0 ? v : 24; };

// Creates an "auto" backup if the newest one is older than the interval. Returns the result, or null if not due.
function runScheduledBackup(now = Date.now()) {
  const hours = intervalHours();
  if (hours === 0) return null;
  const newestAuto = listBackups().find(b => /-auto\.db$/.test(b.filename));
  if (newestAuto && now - new Date(newestAuto.created_at).getTime() < hours * 3600 * 1000) return null;
  const result = createBackup(db, 'auto');
  const days = parseInt(getSetting('backup_retention_days', '30'), 10) || 30;
  const removed = pruneOldBackups(Math.max(days, 7)); // never prune to less than a week of history
  console.log(`Automatic backup ${result.filename} (integrity ${result.integrity && result.integrity.ok === false ? 'FAILED' : 'ok'}); pruned ${removed} old.`);
  return result;
}

function start() {
  if (intervalHours() === 0) { console.log('Automatic backups disabled (BACKUP_INTERVAL_HOURS=0).'); return; }
  const safe = () => { try { runScheduledBackup(); } catch (e) { console.error('Automatic backup failed:', e.message); } };
  setTimeout(safe, 30 * 1000).unref();                                   // soon after boot (covers restarts/deploys)
  const mins = Math.max(1, Number(process.env.BACKUP_CHECK_MINUTES) || 60);
  setInterval(safe, mins * 60 * 1000).unref();
}

module.exports = { start, runScheduledBackup };
