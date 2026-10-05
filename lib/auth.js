const crypto = require('crypto');
const { db, verifyPassword } = require('./db');

const { getSetting } = require('./db');

// Session length comes from Admin > General > Session timeout (minutes); default 8h.
function sessionMinutes() {
  const m = parseInt(getSetting('session_timeout_minutes', '480'), 10);
  return Number.isFinite(m) && m >= 5 ? m : 480;
}

// Password policy: 10+ chars, upper, lower, digit.
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs an upper-case letter, a lower-case letter and a number';
  return null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + sessionMinutes() * 60000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, csrf_token) VALUES (?, ?, ?, ?)')
    .run(token, userId, expires, csrf);
  return { token, csrf };
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Suspended users are treated as signed out immediately — their old sessions stop working.
function getUserWithRole(userId) {
  return db.prepare(`
    SELECT u.*, r.name as role_name, r.permissions as role_permissions
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.id = ? AND u.status = 'active'
  `).get(userId);
}

function destroyUserSessions(userId, exceptToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, exceptToken || '');
}

// Returns { user } on success, { locked: minutes } when throttled, or {} on bad credentials.
function authenticate(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND status = ?').get(String(email || '').trim(), 'active');
  if (!user) { verifyPassword(String(password), '00'.repeat(16), '00'.repeat(64)); return {}; } // equalise timing
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { locked: Math.max(1, Math.ceil((new Date(user.locked_until) - new Date()) / 60000)) };
  }
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    const limit = parseInt(getSetting('login_attempt_limit', '5'), 10) || 5;
    const fails = (user.failed_logins || 0) + 1;
    if (fails >= limit) {
      const mins = parseInt(getSetting('login_lockout_minutes', '15'), 10) || 15;
      db.prepare("UPDATE users SET failed_logins = 0, locked_until = datetime('now', ?) WHERE id = ?").run(`+${mins} minutes`, user.id);
      return { locked: mins };
    }
    db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(fails, user.id);
    return {};
  }
  db.prepare("UPDATE users SET last_login_at = datetime('now'), failed_logins = 0, locked_until = NULL WHERE id = ?").run(user.id);
  return { user };
}

function hasPermission(user, permKey) {
  let perms;
  try { perms = JSON.parse(user.role_permissions || '[]'); } catch { perms = []; }
  if (perms.includes('*')) return true;
  if (perms.includes(permKey)) return true;
  // wildcard module match e.g. "equipment.*" covers "equipment.view"
  const [module] = permKey.split('.');
  if (perms.includes(`${module}.*`)) return true;
  // "*.view" pattern covers any ".view" action
  const [, action] = permKey.split('.');
  if (action && perms.includes(`*.${action}`)) return true;
  return false;
}

function logAudit(userId, action, entityType, entityId, details, ip) {
  db.prepare(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId || null, action, entityType || null, entityId || null,
         details ? JSON.stringify(details) : null, ip || null);
}

module.exports = { passwordProblem, destroyUserSessions, createSession, getSession, destroySession, getUserWithRole, authenticate, hasPermission, logAudit };
