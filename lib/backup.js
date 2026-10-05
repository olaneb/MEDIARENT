const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { DATA_DIR, DB_PATH } = require('./db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Runs PRAGMA integrity_check against a database file WITHOUT touching the live connection.
// Opens it as its own short-lived handle and closes it immediately after.
function checkIntegrity(filePath) {
  let handle;
  try {
    handle = new DatabaseSync(filePath, { readOnly: true });
    const rows = handle.prepare('PRAGMA integrity_check').all();
    const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
    return { ok, detail: ok ? 'ok' : rows.map(r => r.integrity_check).join('; ') };
  } catch (err) {
    return { ok: false, detail: err.message };
  } finally {
    if (handle) { try { handle.close(); } catch {} }
  }
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size_bytes: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Creates a consistent snapshot of the LIVE db by asking SQLite to checkpoint the WAL
// (if any) first, then copying the file. `label` is an optional human note (e.g. "pre-restore", "manual").
function createBackup(db, label) {
  ensureBackupDir();
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  const name = `medirent-${timestamp()}${label ? '-' + label : ''}.db`;
  const dest = path.join(BACKUP_DIR, name);
  fs.copyFileSync(DB_PATH, dest);
  const integrity = checkIntegrity(dest);
  return { filename: name, size_bytes: fs.statSync(dest).size, integrity };
}

function pruneOldBackups(retentionDays) {
  ensureBackupDir();
  const cutoff = Date.now() - retentionDays * 86400000;
  let removed = 0;
  for (const b of listBackups()) {
    if (new Date(b.created_at).getTime() < cutoff) {
      fs.unlinkSync(path.join(BACKUP_DIR, b.filename));
      removed++;
    }
  }
  return removed;
}

function backupPathFor(filename) {
  // guard against path traversal — filename must resolve to a file directly inside BACKUP_DIR
  const resolved = path.join(BACKUP_DIR, filename);
  if (path.dirname(resolved) !== BACKUP_DIR) throw new Error('Invalid backup filename');
  if (!fs.existsSync(resolved)) throw new Error('Backup not found');
  return resolved;
}

// Restores the live database from a backup file — WITHOUT closing the live connection or
// restarting the process. Verifies the backup's integrity first, snapshots the current live
// db as a safety net, then uses SQLite's ATTACH DATABASE to copy every table's contents across
// inside a single transaction. This keeps every route module's existing `db` handle valid;
// nothing needs to reconnect.
function restoreFromBackup(db, filename) {
  const src = backupPathFor(filename);
  const integrity = checkIntegrity(src);
  if (!integrity.ok) throw new Error(`Backup failed integrity check: ${integrity.detail}`);

  const safety = createBackup(db, 'pre-restore-safety');

  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all().map(r => r.name);

  const escapedSrc = src.replace(/'/g, "''");
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`ATTACH DATABASE '${escapedSrc}' AS restore_src`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const srcTables = new Set(db.prepare(`SELECT name FROM restore_src.sqlite_master WHERE type = 'table'`).all().map(r => r.name));
      for (const t of tables) {
        db.exec(`DELETE FROM main."${t}"`);
        // Older backups may predate newer tables (e.g. invoice_emails) — leave those empty.
        if (!srcTables.has(t)) continue;
        const cols = db.prepare(`PRAGMA restore_src.table_info("${t}")`).all().map(c => `"${c.name}"`).join(', ');
        db.exec(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM restore_src."${t}"`);
      }
      // keep AUTOINCREMENT high-water marks consistent with the restored data
      const hasSeqMain = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`).get();
      const hasSeqSrc = db.prepare(`SELECT 1 FROM restore_src.sqlite_master WHERE type='table' AND name='sqlite_sequence'`).get();
      if (hasSeqMain && hasSeqSrc) {
        db.exec(`DELETE FROM main.sqlite_sequence`);
        db.exec(`INSERT INTO main.sqlite_sequence SELECT * FROM restore_src.sqlite_sequence`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    db.exec('DETACH DATABASE restore_src');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  // Re-apply defaults/migrations (white-label keys, @medirent admin login) on top of older backups.
  require('./db').migrate();

  return { restoredFrom: filename, safetyBackup: safety.filename, tablesRestored: tables.length };
}

module.exports = { listBackups, createBackup, pruneOldBackups, restoreFromBackup, checkIntegrity, backupPathFor, BACKUP_DIR, DB_PATH };
