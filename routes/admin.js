const fs = require('fs');
const path = require('path');
const { db, hashPassword, DB_PATH } = require('../lib/db');
const { logAudit, passwordProblem, destroyUserSessions } = require('../lib/auth');
const { isValidEmail } = require('../lib/mailer');

module.exports = function (router) {
  // ---------- USERS ----------
  router.get('/api/admin/users', async (ctx) => {
    if (!ctx.require('admin.users')) return;
    ctx.json(200, db.prepare(`SELECT u.id, u.full_name, u.email, u.phone, u.title, u.status, u.last_login_at, u.must_change_password, r.name as role_name, u.role_id, u.created_at
                               FROM users u JOIN roles r ON r.id = u.role_id ORDER BY r.name, u.full_name`).all());
  });

  router.post('/api/admin/users', async (ctx) => {
    if (!ctx.require('admin.users')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    if (!b.full_name || !b.email || !b.role_id || !b.password) return ctx.json(400, { error: 'full_name, email, role_id, password required' });
    if (!isValidEmail(String(b.email).trim())) return ctx.json(400, { error: 'Email address is not valid' });
    if (!db.prepare('SELECT id FROM roles WHERE id = ?').get(b.role_id)) return ctx.json(400, { error: 'Unknown role' });
    if (db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(String(b.email).trim())) return ctx.json(409, { error: 'A user with that email already exists' });
    const pw = passwordProblem(b.password); if (pw) return ctx.json(400, { error: pw });
    const { hash, salt } = hashPassword(b.password);
    const r = db.prepare(`INSERT INTO users (full_name, email, phone, password_hash, password_salt, role_id, must_change_password, title)
                           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(b.full_name, String(b.email).trim(), b.phone || null, hash, salt, b.role_id, b.title || null);
    logAudit(ctx.user.id, 'user_created', 'user', r.lastInsertRowid, { email: b.email }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid });
  });

  router.put('/api/admin/users/:id', async (ctx, { id }) => {
    if (!ctx.require('admin.users')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    const target = db.prepare('SELECT u.*, r.name as role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(id);
    if (!target) return ctx.json(404, { error: 'User not found' });
    if (b.status !== undefined && !['active', 'suspended'].includes(b.status)) return ctx.json(400, { error: 'status must be active or suspended' });
    if (b.role_id !== undefined && !db.prepare('SELECT id FROM roles WHERE id = ?').get(b.role_id)) return ctx.json(400, { error: 'Unknown role' });
    // Never let the system be left without an active administrator, and never let admins lock themselves out.
    const demoting = (b.status === 'suspended') || (b.role_id !== undefined && Number(b.role_id) !== target.role_id);
    if (demoting && target.role_name === 'Admin') {
      const others = db.prepare("SELECT COUNT(*) as c FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Admin' AND u.status = 'active' AND u.id != ?").get(id).c;
      if (!others) return ctx.json(400, { error: 'This is the only active administrator and cannot be suspended or changed' });
    }
    if (Number(id) === ctx.user.id && b.status === 'suspended') return ctx.json(400, { error: 'You cannot suspend your own account' });
    const fields = ['full_name', 'phone', 'role_id', 'status', 'title'];
    const sets = fields.filter(f => b[f] !== undefined);
    if (sets.length) db.prepare(`UPDATE users SET ${sets.map(f => `${f} = ?`).join(', ')} WHERE id = ?`).run(...sets.map(f => b[f]), id);
    if (b.status === 'suspended' || b.role_id !== undefined) destroyUserSessions(Number(id));
    if (b.status === 'active') db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(id);
    if (b.reset_password) {
      const pwp = passwordProblem(b.reset_password); if (pwp) return ctx.json(400, { error: pwp });
      destroyUserSessions(Number(id));
      const { hash, salt } = hashPassword(b.reset_password);
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 1 WHERE id = ?').run(hash, salt, id);
    }
    logAudit(ctx.user.id, 'user_updated', 'user', id, { fields: sets }, ctx.ip);
    ctx.json(200, { ok: true });
  });

  // ---------- ROLES ----------
  router.get('/api/admin/roles', async (ctx) => {
    if (!ctx.require('admin.users')) return;
    ctx.json(200, db.prepare('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) as users FROM roles r ORDER BY r.is_system DESC, r.name').all()
      .map(r => ({ ...r, permissions: JSON.parse(r.permissions || '[]') })));
  });

  // Permission catalogue for the role editor (module.action; ".*" = everything in the module, "*.view" = read-only everywhere).
  const PERMISSIONS = {
    equipment: ['view', 'edit'], kits: ['view', 'edit'], customers: ['view', 'edit'], quotes: ['view', 'edit'], rentals: ['view', 'edit'], dispatch: ['view', 'edit'],
    consumables: ['view', 'edit'], maintenance: ['view', 'edit'], locations: ['view', 'edit'], claims: ['view', 'edit'],
    invoices: ['view', 'edit'], payments: ['view', 'edit'], expenses: ['view', 'edit'], vouchers: ['view', 'edit', 'approve'], finance: ['view'],
    accounts: ['view', 'edit'], journals: ['view', 'edit', 'approve'], imports: ['edit'], reports: ['view'], tax: ['view'], einvoice: ['view', 'edit'],
    admin: ['users', 'settings', 'audit', 'backup'],
  };
  router.get('/api/admin/permissions', async (ctx) => {
    if (!ctx.require('admin.users')) return;
    ctx.json(200, PERMISSIONS);
  });
  const validPerms = (list) => Array.isArray(list) && list.every(p => p === '*' || p === '*.view' || /^[a-z]+\.(\*|[a-z]+)$/.test(p) && PERMISSIONS[p.split('.')[0]] && (p.endsWith('.*') || PERMISSIONS[p.split('.')[0]].includes(p.split('.')[1])));
  router.post('/api/admin/roles', async (ctx) => {
    if (!ctx.require('admin.users')) return;
    if (!ctx.requireCsrf()) return;
    const name = String(ctx.body.name || '').trim(); const perms = ctx.body.permissions || [];
    if (name.length < 3) return ctx.json(400, { error: 'Role name is required' });
    if (!validPerms(perms)) return ctx.json(400, { error: 'Unknown permission in the list' });
    if (perms.includes('*')) return ctx.json(400, { error: 'Only the built-in Admin role has full access' });
    if (db.prepare('SELECT 1 FROM roles WHERE lower(name) = lower(?)').get(name)) return ctx.json(409, { error: 'A role with that name exists' });
    const r = db.prepare('INSERT INTO roles (name, description, permissions, is_system) VALUES (?, ?, ?, 0)').run(name, ctx.body.description || null, JSON.stringify(perms));
    logAudit(ctx.user.id, 'role_created', 'role', r.lastInsertRowid, { name, perms }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid });
  });
  router.put('/api/admin/roles/:id', async (ctx, { id }) => {
    if (!ctx.require('admin.users')) return;
    if (!ctx.requireCsrf()) return;
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id); if (!role) return ctx.json(404, { error: 'Role not found' });
    if (role.name === 'Admin') return ctx.json(400, { error: 'The Admin role cannot be changed' });
    const perms = ctx.body.permissions;
    if (perms !== undefined && (!validPerms(perms) || perms.includes('*'))) return ctx.json(400, { error: 'Unknown or disallowed permission in the list' });
    db.prepare('UPDATE roles SET description = COALESCE(?, description), permissions = COALESCE(?, permissions) WHERE id = ?').run(ctx.body.description ?? null, perms ? JSON.stringify(perms) : null, id);
    // Changed permissions apply at the users' next request (permissions are read per request).
    logAudit(ctx.user.id, 'role_updated', 'role', Number(id), { perms }, ctx.ip);
    ctx.json(200, { ok: true });
  });
  router.del('/api/admin/roles/:id', async (ctx, { id }) => {
    if (!ctx.require('admin.users')) return;
    if (!ctx.requireCsrf()) return;
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id); if (!role) return ctx.json(404, { error: 'Role not found' });
    if (role.is_system) return ctx.json(400, { error: 'Built-in roles cannot be deleted' });
    if (db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ?').get(id).c) return ctx.json(400, { error: 'Move the users to another role first' });
    db.prepare('DELETE FROM roles WHERE id = ?').run(id);
    ctx.json(200, { ok: true });
  });

  // ---------- AUDIT LOG ----------
  router.get('/api/admin/audit-log', async (ctx) => {
    if (!ctx.require('admin.audit')) return;
    const limit = Math.min(parseInt(ctx.query.limit) || 100, 500);
    ctx.json(200, db.prepare(`SELECT al.*, u.full_name as user_name FROM audit_log al
                               LEFT JOIN users u ON u.id = al.user_id
                               ORDER BY al.created_at DESC LIMIT ?`).all(limit));
  });

  // ---------- SETTINGS ----------
  router.get('/api/admin/settings', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    const rows = db.prepare('SELECT * FROM settings').all();
    const obj = {};
    for (const r of rows) obj[r.key] = r.value;
    // Never send the logo blob or the SMTP password back to the browser.
    delete obj.brand_logo;
    obj.smtp_pass_set = !!obj.smtp_pass;
    delete obj.smtp_pass;
    obj.nrs_api_key_set = !!obj.nrs_api_key; obj.nrs_api_secret_set = !!obj.nrs_api_secret;
    delete obj.nrs_api_key; delete obj.nrs_api_secret;
    ctx.json(200, obj);
  });

  router.put('/api/admin/settings', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    if (!ctx.requireCsrf()) return;
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const body = { ...ctx.body };
    // Logo has its own upload endpoint; these are system-managed.
    for (const k of ['brand_logo', 'brand_logo_version', 'smtp_pass_set', 'nrs_api_key_set', 'nrs_api_secret_set', 'roles_version', 'coa_migrated_from_4_digit', 'books_locked_until']) delete body[k];
    for (const k of ['nrs_api_key', 'nrs_api_secret']) { if (body['clear_' + k]) body[k] = ''; else if (!body[k]) delete body[k]; delete body['clear_' + k]; }
    if (body.nrs_mode !== undefined && !['off', 'simulator', 'live'].includes(body.nrs_mode)) return ctx.json(400, { error: 'NRS mode must be off, simulator or live' });
    if (body.nrs_service_id && !/^[A-Za-z0-9]{8}$/.test(String(body.nrs_service_id).trim())) return ctx.json(400, { error: 'NRS Service ID must be exactly 8 letters/digits (from your NRS dashboard)' });
    if (body.nrs_base_url && !/^https:\/\/[^\s]+$/i.test(String(body.nrs_base_url).trim())) return ctx.json(400, { error: 'Access Point Provider URL must start with https://' });
    if (body.nrs_mode === 'live') {
      const cur = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
      const m = { ...cur, ...body };
      if (!m.nrs_base_url || !m.nrs_api_key || !m.nrs_api_secret) return ctx.json(400, { error: 'Live mode needs the Access Point Provider URL, API key and API secret' });
    }
    for (const k of ['pv_level1_roles', 'pv_level2_roles']) if (body[k] !== undefined) {
      const names = String(body[k]).split(',').map(x => x.trim()).filter(Boolean);
      if (!names.length) return ctx.json(400, { error: 'Each approval level needs at least one role' });
      for (const n of names) if (!db.prepare('SELECT 1 FROM roles WHERE name = ?').get(n)) return ctx.json(400, { error: `Unknown role "${n}" in approval levels` });
    }
    if (body.brand_primary_color !== undefined && !/^#[0-9a-f]{6}$/i.test(body.brand_primary_color)) {
      return ctx.json(400, { error: 'Brand colour must be a hex value like #E8630A' });
    }
    const numChecks = { cit_rate: [0, 100], dev_levy_rate: [0, 100], cancellation_fee_pct: [0, 100], ecl_rate_current: [0, 100], ecl_rate_1_30: [0, 100], ecl_rate_31_60: [0, 100], ecl_rate_61_90: [0, 100], ecl_rate_over_90: [0, 100], financial_year_start_month: [1, 12], small_company_turnover: [0, 1e13], small_company_assets: [0, 1e13], vat_rate: [0, 100], wht_rate_rental: [0, 100], wht_rate_services: [0, 100], wht_rate_goods: [0, 100], session_timeout_minutes: [5, 10080], invoice_due_days: [0, 365], login_attempt_limit: [3, 50], login_lockout_minutes: [1, 1440] };
    for (const [k, [lo, hi]] of Object.entries(numChecks)) {
      if (body[k] !== undefined && !(Number(body[k]) >= lo && Number(body[k]) <= hi && String(body[k]).trim() !== '')) return ctx.json(400, { error: `${k.replace(/_/g, ' ')} must be a number between ${lo} and ${hi}` });
    }
    if (body.brand_secondary_color && !/^#[0-9a-f]{6}$/i.test(body.brand_secondary_color)) return ctx.json(400, { error: 'Secondary colour must be a hex value like #1B1E23' });
    for (const k of ['vat_registered', 'einvoice_enabled', 'show_powered_by', 'nrs_auto_submit']) if (body[k] !== undefined && !['0', '1'].includes(String(body[k]))) return ctx.json(400, { error: `${k} must be 0 or 1` });
    if (body.company_tin && !/^[0-9]{8,14}(-[0-9]{4})?$/.test(String(body.company_tin).trim())) return ctx.json(400, { error: 'Company TIN looks invalid — expected 8–14 digits (e.g. 12345678-0001)' });
    if (body.currency !== undefined && !/^[A-Z]{3}$/.test(String(body.currency).trim())) return ctx.json(400, { error: 'Currency must be a 3-letter code such as NGN' });
    // These are managed by dedicated endpoints / the system; block overwriting via the generic settings call.
    for (const k of ['maintenance_mode', 'maintenance_mode_message', 'backup_retention_days']) delete body[k];
    if (body.smtp_security !== undefined && !['starttls', 'tls', 'none'].includes(body.smtp_security)) {
      return ctx.json(400, { error: 'SMTP security must be starttls, tls or none' });
    }
    // Blank password field means "keep the saved one"; clear_smtp_pass explicitly removes it.
    if (body.clear_smtp_pass) body.smtp_pass = '';
    else if (!body.smtp_pass) delete body.smtp_pass;
    delete body.clear_smtp_pass;
    for (const [k, v] of Object.entries(body)) {
      if (!/^[a-z0-9_]+$/.test(k)) continue;
      upsert.run(k, String(v == null ? '' : v));
    }
    const auditDetails = { ...body };
    for (const k of ['smtp_pass', 'nrs_api_key', 'nrs_api_secret']) if (k in auditDetails) auditDetails[k] = '(changed)';
    logAudit(ctx.user.id, 'settings_updated', 'settings', null, auditDetails, ctx.ip);
    ctx.json(200, { ok: true });
  });

  // ---------- BACKUP / EXPORT ----------
  router.get('/api/admin/backup', async (ctx) => {
    if (!ctx.require('admin.backup')) return;
    const dbPath = DB_PATH;
    const data = fs.readFileSync(dbPath);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="medirent-backup-${new Date().toISOString().slice(0, 10)}.db"`,
    });
    ctx.res.end(data);
    logAudit(ctx.user.id, 'backup_downloaded', null, null, null, ctx.ip);
  });
};
