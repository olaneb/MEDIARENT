const fs = require('fs');
const path = require('path');
const os = require('os');
const { db } = require('./db');
const { listBackups, checkIntegrity, DB_PATH } = require('./backup');

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

const TABLE_COUNTS = [
  'equipment', 'kits', 'customers', 'rental_agreements', 'invoices', 'payments',
  'expenses', 'payment_vouchers', 'work_orders', 'rental_consumables', 'users', 'journal_entries', 'audit_log',
];

function tableCounts() {
  const out = {};
  for (const t of TABLE_COUNTS) out[t] = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c;
  return out;
}

function diskUsage() {
  try {
    const stat = fs.statfsSync(path.dirname(DB_PATH));
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bavail * stat.bsize;
    return { total_bytes: totalBytes, free_bytes: freeBytes, used_pct: Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 };
  } catch (err) {
    return { error: err.message };
  }
}

/* ---------- Data integrity checks ---------- */
function unbalancedJournalEntries() {
  return db.prepare(`
    SELECT e.id, e.entry_number, ROUND(SUM(l.debit) - SUM(l.credit), 2) as diff
    FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
    GROUP BY e.id HAVING ABS(diff) > 0.01
  `).all();
}

function equipmentStatusMismatches() {
  // equipment marked on_rent but has no currently-open (checked out, not checked in) agreement item
  return db.prepare(`
    SELECT e.id, e.asset_code, e.name FROM equipment e
    WHERE e.status = 'on_rent' AND NOT EXISTS (
      SELECT 1 FROM agreement_items ai WHERE ai.equipment_id = e.id
        AND ai.checkout_at IS NOT NULL AND ai.checkin_at IS NULL
    )
  `).all();
}

function negativeStockParts() {
  return db.prepare(`SELECT id, part_code, name, quantity_on_hand FROM spare_parts WHERE quantity_on_hand < 0`).all();
}

function belowReorderParts() {
  return db.prepare(`SELECT id, part_code, name, quantity_on_hand, reorder_level FROM spare_parts
                      WHERE quantity_on_hand <= reorder_level AND reorder_level > 0`).all();
}

function belowReorderConsumables() {
  return db.prepare(`SELECT id, item_code, name, quantity_on_hand, reorder_level FROM rental_consumables
                      WHERE quantity_on_hand <= reorder_level AND reorder_level > 0`).all();
}

function lostEquipmentUnresolved() {
  return db.prepare(`SELECT id, asset_code, name, replacement_value FROM equipment WHERE status = 'lost'`).all();
}

function expiredOrMissingCOI() {
  // customers with an active/upcoming booking but no valid Certificate of Insurance on file
  return db.prepare(`
    SELECT DISTINCT c.id, c.full_name, c.coi_on_file, c.coi_expiry_date FROM customers c
    JOIN rental_agreements ra ON ra.customer_id = c.id
    WHERE ra.status IN ('reserved','active','dispatched','overdue')
      AND (c.coi_on_file = 0 OR c.coi_expiry_date IS NULL OR c.coi_expiry_date < date('now'))
  `).all();
}

function staleSessions() {
  return db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE expires_at < datetime('now')`).get().c;
}

function overdueAgreementsUnflagged() {
  // agreements past due date that are still marked 'active' instead of 'overdue'
  return db.prepare(`SELECT id, agreement_number FROM rental_agreements
                      WHERE status = 'active' AND expected_return_date < date('now')`).all();
}

function pendingVouchersAge() {
  return db.prepare(`SELECT pv_number, julianday('now') - julianday(created_at) as days_pending
                      FROM payment_vouchers WHERE status = 'pending' AND
                      julianday('now') - julianday(created_at) > 3`).all();
}

function runIntegrityChecks() {
  const unbalanced = unbalancedJournalEntries();
  const statusMismatch = equipmentStatusMismatches();
  const negStock = negativeStockParts();
  const lowStock = belowReorderParts();
  const lowConsumables = belowReorderConsumables();
  const lostItems = lostEquipmentUnresolved();
  const missingCOI = expiredOrMissingCOI();
  const stale = staleSessions();
  const unflaggedOverdue = overdueAgreementsUnflagged();
  const agingVouchers = pendingVouchersAge();

  const issues = [];
  if (unbalanced.length) issues.push({ severity: 'critical', check: 'ledger_balance', message: `${unbalanced.length} journal entr${unbalanced.length === 1 ? 'y' : 'ies'} do not balance`, details: unbalanced });
  if (statusMismatch.length) issues.push({ severity: 'warning', check: 'equipment_status', message: `${statusMismatch.length} asset(s) marked on_rent with no open checkout`, details: statusMismatch });
  if (negStock.length) issues.push({ severity: 'critical', check: 'spare_parts_stock', message: `${negStock.length} spare part(s) have negative stock`, details: negStock });
  if (lowStock.length) issues.push({ severity: 'info', check: 'spare_parts_reorder', message: `${lowStock.length} spare part(s) at or below reorder level`, details: lowStock });
  if (lowConsumables.length) issues.push({ severity: 'info', check: 'consumables_reorder', message: `${lowConsumables.length} rental consumable(s) at or below reorder level`, details: lowConsumables });
  if (lostItems.length) issues.push({ severity: 'warning', check: 'lost_equipment', message: `${lostItems.length} item(s) marked lost, awaiting write-off or insurance resolution`, details: lostItems });
  if (missingCOI.length) issues.push({ severity: 'warning', check: 'coi_missing', message: `${missingCOI.length} customer(s) with an active or upcoming booking have no valid Certificate of Insurance on file`, details: missingCOI });
  if (unflaggedOverdue.length) issues.push({ severity: 'warning', check: 'overdue_agreements', message: `${unflaggedOverdue.length} agreement(s) past due date not yet flagged overdue — run the overdue scan`, details: unflaggedOverdue });
  if (agingVouchers.length) issues.push({ severity: 'warning', check: 'voucher_aging', message: `${agingVouchers.length} voucher(s) pending approval for more than 3 days`, details: agingVouchers });
  if (stale > 0) issues.push({ severity: 'info', check: 'stale_sessions', message: `${stale} expired session(s) can be cleaned up` });

  return issues;
}

function cleanupStaleSessions() {
  const r = db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  return r.changes;
}

function systemHealth() {
  const dbIntegrity = checkIntegrity(DB_PATH);
  const backups = listBackups();
  const retentionDays = parseInt(getSetting('backup_retention_days', '30'), 10);
  const lastBackup = backups[0];
  const lastBackupAgeHours = lastBackup ? (Date.now() - new Date(lastBackup.created_at).getTime()) / 3600000 : null;
  const issues = runIntegrityChecks();

  if (!lastBackup) issues.unshift({ severity: 'warning', check: 'backup_freshness', message: 'No backups have been taken yet' });
  else if (lastBackupAgeHours > 48) issues.unshift({ severity: 'warning', check: 'backup_freshness', message: `Last backup is ${Math.round(lastBackupAgeHours / 24)} day(s) old` });

  const disk = diskUsage();
  if (disk.free_bytes !== undefined && disk.free_bytes < 200 * 1024 * 1024) {
    issues.unshift({ severity: 'critical', check: 'disk_space', message: 'Less than 200MB free disk space remaining' });
  }
  if (!dbIntegrity.ok) issues.unshift({ severity: 'critical', check: 'db_integrity', message: `Database integrity check failed: ${dbIntegrity.detail}` });

  const hasCritical = issues.some(i => i.severity === 'critical');
  const hasWarning = issues.some(i => i.severity === 'warning');
  const status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

  return {
    status,
    checked_at: new Date().toISOString(),
    process: {
      node_version: process.version,
      platform: `${os.type()} ${os.release()}`,
      uptime_seconds: Math.round(process.uptime()),
      memory_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      pid: process.pid,
    },
    database: {
      integrity: dbIntegrity,
      file_size_bytes: fs.statSync(DB_PATH).size,
      table_counts: tableCounts(),
    },
    disk,
    backups: { count: backups.length, latest: lastBackup || null, retention_days: retentionDays },
    issues,
  };
}

module.exports = { systemHealth, runIntegrityChecks, cleanupStaleSessions, tableCounts, diskUsage };
