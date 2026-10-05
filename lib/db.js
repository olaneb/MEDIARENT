let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(`MediaRent needs Node.js 22.13 or newer (built-in node:sqlite). This runtime is ${process.version}.`);
}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Where the SQLite database lives. On Fly.io this is the persistent volume mounted at /data
// (MEDIRENT_DATA_DIR=/data in fly.toml); locally it defaults to ./data.
const DATA_DIR = process.env.MEDIRENT_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'medirent.db');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'equiprent.db');

// The data/ directory won't exist on a fresh checkout or after unzipping (empty
// folders aren't reliably preserved in zip archives), and node:sqlite fails with
// ERR_SQLITE_ERROR ("unable to open database file") if its parent folder is missing.
// Ensure it exists before ever opening the database.
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// One-time migration: earlier builds (forked from EquipRent) stored data in equiprent.db.
// Carry it (and any WAL/SHM sidecars) across to medirent.db so no data is lost on upgrade.
if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(LEGACY_DB_PATH + suffix)) fs.renameSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
  }
}

// `db` is a stable proxy over the current connection so the database can be swapped out
// (after a backup restore) without every module re-requiring it.
let handle = new DatabaseSync(DB_PATH);
handle.exec('PRAGMA foreign_keys = ON');
const db = new Proxy({}, {
  get(_, prop) {
    const v = handle[prop];
    return typeof v === 'function' ? v.bind(handle) : v;
  },
});

function close() { try { handle.close(); } catch {} }

function reopen() {
  try { handle.close(); } catch {}
  handle = new DatabaseSync(DB_PATH);
  handle.exec('PRAGMA foreign_keys = ON');
}

function init() {
  db.exec(require('./schema'));
  seedIfEmpty();
  migrate();
}

// Default admin login domain for this portal.
const DEFAULT_ADMIN_EMAIL = 'admin@medirent.local';

// White-label + email defaults. INSERT OR IGNORE so existing installs pick up new keys
// without overwriting anything an admin has already configured.
const WHITE_LABEL_DEFAULTS = {
  portal_name: 'MediaRent',
  portal_tagline: 'Media & Production Equipment Rental Portal',
  company_address: '',
  company_phone: '',
  company_email: '',
  company_website: '',
  company_rc_number: '',
  company_tin: '',
  brand_primary_color: '#E8630A',
  brand_logo: '',            // data URL — kept in the DB so backups/restores carry the logo
  brand_logo_version: '0',
  show_powered_by: '1',
  login_hint: `Default admin: ${DEFAULT_ADMIN_EMAIL} / Admin@12345`,
  invoice_bank_name: '',
  invoice_account_name: '',
  invoice_account_number: '',
  invoice_notes: 'Thank you for your business. Please quote the invoice number when making payment.',
  invoice_due_days: '7',
  invoice_email_subject: 'Invoice {invoice_number} from {company_name}',
  invoice_email_message: 'Dear {customer_name},\n\nPlease find attached invoice {invoice_number} for {amount_due}, due on {due_date}.\n\nKind regards,\n{company_name}',
  smtp_host: '',
  smtp_port: '587',
  smtp_security: 'starttls',   // starttls | tls | none
  smtp_user: '',
  smtp_pass: '',
  smtp_reject_unauthorized: '1',
  mail_from_name: '',
  mail_from_address: '',
  mail_reply_to: '',
  // --- Nigerian tax (Nigeria Tax Act 2025 / Deduction of Tax at Source (Withholding) Regs 2024) ---
  vat_registered: '1',          // 1 = charges VAT; 0 = small-business exempt / not registered (no VAT charged)
  company_vat_number: '',       // VAT registration no. (usually the TIN)
  vat_rate: '7.5',
  wht_rate_rental: '10',        // rent / hire / lease of equipment
  wht_rate_services: '5',       // crew / technical / professional services
  wht_rate_goods: '2',          // supply of goods (consumables)
  wht_no_tin_multiplier: '2',   // vendors without a TIN: rate is doubled (capped at 20%)
  einvoice_enabled: '0',        // NRS Merchant-Buyer-Solution fields shown on invoices
  einvoice_service_id: '',      // Service ID issued by your accredited access-point provider
  brand_secondary_color: '',    // optional: sidebar/header surface colour (blank = default charcoal)
  login_attempt_limit: '5',
  login_lockout_minutes: '15',
  // --- Corporate tax (NTA 2025) — used by the tax-provision estimate; editable ---
  cit_rate: '30',                       // companies income tax (medium & large companies)
  dev_levy_rate: '4',                   // development levy on assessable profits (replaces TET, NITDA, NASENI, Police levies)
  small_company_turnover: '100000000',  // small company: turnover ≤ ₦100m AND fixed assets ≤ ₦250m -> 0% CIT, no dev levy, VAT-exempt
  small_company_assets: '250000000',
  financial_year_start_month: '1',
  books_locked_until: '',               // period lock: no postings dated on/before this date
  // --- Expected credit loss provision matrix (IFRS 9 simplified approach), % of balance per ageing bucket ---
  ecl_rate_current: '1', ecl_rate_1_30: '3', ecl_rate_31_60: '8', ecl_rate_61_90: '20', ecl_rate_over_90: '50',
  // --- Bookings ---
  cancellation_fee_pct: '20',           // rate card: refunds / cancellations attract a 20% penalty
  // --- NRS e-invoicing (Merchant Buyer Solution via an accredited Access Point Provider) ---
  nrs_mode: 'off',                      // off | simulator | live
  nrs_app_name: '',
  nrs_base_url: '',
  nrs_api_key: '',
  nrs_api_secret: '',
  nrs_business_id: '',
  nrs_service_id: '',                   // 8-character Service ID from the NRS dashboard (part of every IRN)
  nrs_auto_submit: '0',                 // 1 = validate + sign automatically when an invoice is generated
  nrs_default_service_code: '',
  nrs_supplier_city: '', nrs_supplier_state: '', nrs_supplier_postal_zone: '', nrs_supplier_business_description: 'Rental of media, film and production equipment and studio space',
  nrs_path_validate: '/api/v1/invoice/validate',
  nrs_path_sign: '/api/v1/invoice/sign',
  nrs_path_confirm: '/api/v1/invoice/confirm/{irn}',
  nrs_path_transmit: '/api/v1/invoice/transmit/{irn}',
  nrs_path_update: '/api/v1/invoice/update/{irn}',
  nrs_tax_category_standard: 'STANDARD_VAT',
  nrs_tax_category_outside: 'EXEMPTED',
  pv_level1_roles: 'Finance Manager,Finance,Admin',
  pv_level2_roles: 'Managing Director,Admin',
};

function migrate() {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(WHITE_LABEL_DEFAULTS)) ins.run(k, v);

  // Login details now use the @medirent domain.
  const legacy = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@equiprent.local');
  const taken = db.prepare('SELECT id FROM users WHERE email = ?').get(DEFAULT_ADMIN_EMAIL);
  if (legacy && !taken) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(DEFAULT_ADMIN_EMAIL, legacy.id);
  db.prepare(`UPDATE settings SET value = ? WHERE key = 'login_hint' AND value LIKE '%admin@equiprent.local%'`)
    .run(WHITE_LABEL_DEFAULTS.login_hint);

  // Email log for invoices sent from the portal.
  db.exec(`CREATE TABLE IF NOT EXISTS invoice_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    to_address TEXT NOT NULL,
    cc_address TEXT,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,          -- sent | failed
    error TEXT,
    sent_by INTEGER REFERENCES users(id),
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  migrateTax();
  migrateCoa();
  migrateV13();
}

// ---- 6-digit chart of accounts (renumbers legacy 4-digit codes in place; journal lines keep their account ids) ----
function migrateCoa() {
  addColumn('chart_of_accounts', 'is_header', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('chart_of_accounts', 'is_system', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('chart_of_accounts', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('chart_of_accounts', 'allow_manual', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('chart_of_accounts', 'ifrs_line', 'TEXT');
  addColumn('chart_of_accounts', 'description', 'TEXT');
  addColumn('chart_of_accounts', 'created_at', 'TEXT');
  const legacy = db.prepare("SELECT id, code FROM chart_of_accounts WHERE length(code) = 4").all();
  if (legacy.length) {
    const upd = db.prepare('UPDATE chart_of_accounts SET code = ? WHERE id = ?');
    for (const a of legacy) {
      const to = LEGACY_MAP[a.code];
      if (!to) { upd.run('69' + a.code.padStart(4, '0'), a.id); continue; } // unknown custom 4-digit -> 69xxxx bucket
      if (!db.prepare('SELECT id FROM chart_of_accounts WHERE code = ?').get(to)) upd.run(to, a.id);
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('coa_migrated_from_4_digit', datetime('now'))").run();
  }
  const ins = db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code, name, account_type) VALUES (?, ?, ?)');
  const flag = db.prepare('UPDATE chart_of_accounts SET is_system = ?, ifrs_line = COALESCE(ifrs_line, ?), is_header = ? WHERE code = ?');
  for (const [code, name, type, sys, ifrs, header] of ACCOUNTS) { ins.run(code, name, type); flag.run(sys ? 1 : 0, ifrs || null, header ? 1 : 0, code); }
  db.exec("UPDATE chart_of_accounts SET allow_manual = 0 WHERE is_header = 1");
  // parent = class header
  for (const d of Object.keys(CLASSES)) {
    const h = db.prepare('SELECT id FROM chart_of_accounts WHERE code = ?').get(`${d}00000`);
    if (h) db.prepare("UPDATE chart_of_accounts SET parent_id = ? WHERE substr(code,1,1) = ? AND id != ? AND parent_id IS NULL").run(h.id, d, h.id);
  }
}

// ---- v1.3: e-invoicing, imports, report builder, claims, locations, photos, crew rate card, roles ----
function migrateV13() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS saved_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, source TEXT NOT NULL, definition TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
  CREATE TABLE IF NOT EXISTS einvoice_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL REFERENCES invoices(id), action TEXT NOT NULL,
    mode TEXT NOT NULL, status TEXT NOT NULL, http_status INTEGER, request_json TEXT, response_json TEXT, error TEXT,
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_number TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, filename TEXT, as_of_date TEXT,
    rows_total INTEGER NOT NULL DEFAULT 0, rows_ok INTEGER NOT NULL DEFAULT 0, journal_entry_id INTEGER REFERENCES journal_entries(id),
    summary TEXT, status TEXT NOT NULL DEFAULT 'posted', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS crew_rate_card (
    id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT UNIQUE NOT NULL, day_rate REAL NOT NULL DEFAULT 0, rate_on_request INTEGER NOT NULL DEFAULT 0,
    notes TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, address TEXT, is_default INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS equipment_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, equipment_id INTEGER NOT NULL REFERENCES equipment(id), from_location_id INTEGER REFERENCES locations(id),
    to_location_id INTEGER NOT NULL REFERENCES locations(id), notes TEXT, transferred_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS insurance_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT, claim_number TEXT UNIQUE NOT NULL, equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    agreement_id INTEGER REFERENCES rental_agreements(id), agreement_item_id INTEGER REFERENCES agreement_items(id),
    incident_type TEXT NOT NULL, incident_date TEXT, description TEXT, insurer TEXT, policy_number TEXT, insurer_claim_ref TEXT,
    amount_claimed REAL NOT NULL DEFAULT 0, excess REAL NOT NULL DEFAULT 0, amount_settled REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft',
    settled_at TEXT, journal_entry_id INTEGER REFERENCES journal_entries(id), created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, stage TEXT, caption TEXT,
    mime TEXT NOT NULL, data BLOB NOT NULL, bytes INTEGER NOT NULL, uploaded_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS manual_journals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE NOT NULL, entry_date TEXT NOT NULL, memo TEXT NOT NULL, lines TEXT NOT NULL,
    total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT, journal_entry_id INTEGER REFERENCES journal_entries(id),
    created_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT);
  CREATE TABLE IF NOT EXISTS depreciation_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES depreciation_runs(id), equipment_id INTEGER NOT NULL REFERENCES equipment(id), amount REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_photos_entity ON photos(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);
  CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_je_date ON journal_entries(entry_date);
  CREATE INDEX IF NOT EXISTS idx_einv_sub ON einvoice_submissions(invoice_id);
  `);
  // Equipment / categories
  addColumn('equipment', 'location_id', 'INTEGER REFERENCES locations(id)');
  addColumn('equipment', 'opening_accumulated_depreciation', 'REAL NOT NULL DEFAULT 0');
  addColumn('equipment', 'depreciation_start_date', 'TEXT');
  addColumn('equipment', 'disposed_at', 'TEXT');
  addColumn('equipment', 'disposal_reason', 'TEXT');
  addColumn('equipment', 'rate_card_ref', 'TEXT');
  addColumn('equipment', 'includes_operator', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('equipment', 'default_deposit', 'REAL NOT NULL DEFAULT 0');
  addColumn('equipment', 'depreciable', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('equipment', 'capitalised_at', 'TEXT');
  addColumn('equipment', 'capitalisation_method', 'TEXT');
  addColumn('insurance_claims', 'amount_approved', 'REAL NOT NULL DEFAULT 0');
  addColumn('insurance_claims', 'notes', 'TEXT');
  addColumn('equipment_categories', 'income_gl_code', 'TEXT');
  addColumn('equipment_categories', 'nrs_service_code', 'TEXT');
  addColumn('equipment_categories', 'useful_life_years', 'INTEGER');
  addColumn('equipment_categories', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  // Customers: address detail needed by the NRS e-invoice (party postal address)
  addColumn('customers', 'city', 'TEXT');
  addColumn('customers', 'state', 'TEXT');
  addColumn('customers', 'country', "TEXT NOT NULL DEFAULT 'NG'");
  addColumn('customers', 'business_description', 'TEXT');
  addColumn('customers', 'is_government', 'INTEGER NOT NULL DEFAULT 0');
  // Invoices: legacy imports, NRS lifecycle
  addColumn('invoices', 'is_legacy', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('invoices', 'legacy_ref', 'TEXT');
  addColumn('invoices', 'invoice_kind', "TEXT NOT NULL DEFAULT 'rental'");
  addColumn('invoices', 'einvoice_qr', 'TEXT');
  addColumn('invoices', 'einvoice_submitted_at', 'TEXT');
  addColumn('invoices', 'einvoice_cleared_at', 'TEXT');
  addColumn('invoices', 'einvoice_error', 'TEXT');
  addColumn('invoices', 'credit_note_number', 'TEXT');
  addColumn('invoices', 'transaction_model', "TEXT NOT NULL DEFAULT 'B2B'");
  addColumn('invoice_items', 'gl_code', 'TEXT');
  addColumn('invoice_items', 'quantity', 'REAL NOT NULL DEFAULT 1');
  addColumn('invoice_items', 'unit_price', 'REAL');
  // Expenses: GL override + legacy payables
  addColumn('expenses', 'gl_code', 'TEXT');
  addColumn('expenses', 'is_legacy', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('expenses', 'due_date', 'TEXT');
  // Bookings: location, cancellation fee
  addColumn('rental_agreements', 'location_id', 'INTEGER REFERENCES locations(id)');
  addColumn('rental_agreements', 'cancellation_fee', 'REAL NOT NULL DEFAULT 0');
  addColumn('rental_agreements', 'cancelled_at', 'TEXT');
  addColumn('rental_agreements', 'cancel_reason', 'TEXT');
  addColumn('agreement_crew', 'crew_role_id', 'INTEGER REFERENCES crew_rate_card(id)');
  addColumn('rental_consumables', 'unit', "TEXT NOT NULL DEFAULT 'each'");
  addColumn('rental_consumables', 'wht_exempt', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('depreciation_runs', 'status', "TEXT NOT NULL DEFAULT 'posted'");
  addColumn('payment_vouchers', 'gl_code', 'TEXT');
  addColumn('payment_vouchers', 'pay_from', 'TEXT');
  addColumn('journal_entries', 'reversed_by', 'INTEGER');
  addColumn('roles', 'is_system', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'title', 'TEXT');
  addColumn('users', 'default_location_id', 'INTEGER REFERENCES locations(id)');

  // Default location so every unit has a home
  if (!db.prepare('SELECT COUNT(*) c FROM locations').get().c) {
    db.prepare("INSERT INTO locations (code, name, address, is_default) VALUES ('HQ', 'Main warehouse', NULL, 1)").run();
  }
  const hq = db.prepare('SELECT id FROM locations WHERE is_default = 1 ORDER BY id LIMIT 1').get();
  if (hq) db.prepare('UPDATE equipment SET location_id = ? WHERE location_id IS NULL').run(hq.id);

  // Roles: add new built-ins; refresh permissions of built-ins once per roles version (custom roles untouched).
  const ROLES_VERSION = '4';
  const insRole = db.prepare('INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES (?, ?, ?, 1)');
  for (const r of DEFAULT_ROLES) insRole.run(r.name, r.description, JSON.stringify(r.permissions));
  const rv = db.prepare("SELECT value FROM settings WHERE key = 'roles_version'").get();
  if (!rv || rv.value !== ROLES_VERSION) {
    const upd = db.prepare('UPDATE roles SET description = ?, permissions = ?, is_system = 1 WHERE name = ?');
    for (const r of DEFAULT_ROLES) upd.run(r.description, JSON.stringify(r.permissions), r.name);
    // Legacy "Finance" role (pre-1.3) keeps working: it maps to the Accountant + level-1 approval permissions.
    db.prepare("UPDATE roles SET permissions = ?, description = ? WHERE name = 'Finance'")
      .run(JSON.stringify(['finance.*', 'invoices.*', 'payments.*', 'expenses.*', 'vouchers.*', 'reports.*', 'accounts.view', 'journals.view', 'journals.edit', 'einvoice.*', 'tax.*', 'claims.*', 'consumables.view', 'customers.view', 'rentals.view', 'equipment.view']), 'Legacy finance role (pre-1.3) — prefer Finance Manager / Accountant');
    db.prepare("INSERT INTO settings (key, value) VALUES ('roles_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ROLES_VERSION);
  }
  // One-time: split users of the legacy "Finance" role by what they actually do — anyone who has approved
  // vouchers becomes Finance Manager (checker); the rest become Accountant (maker). Keeps maker-checker intact.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'users_remapped_v13'").get()) {
    const fin = db.prepare("SELECT id FROM roles WHERE name = 'Finance'").get();
    const fm = db.prepare("SELECT id FROM roles WHERE name = 'Finance Manager'").get(), acct = db.prepare("SELECT id FROM roles WHERE name = 'Accountant'").get();
    if (fin && fm && acct) {
      for (const u of db.prepare('SELECT id FROM users WHERE role_id = ?').all(fin.id)) {
        const approver = db.prepare("SELECT 1 FROM pv_approvals WHERE approver_id = ? AND decision = 'approved'").get(u.id);
        db.prepare('UPDATE users SET role_id = ?, title = COALESCE(title, ?) WHERE id = ?').run(approver ? fm.id : acct.id, approver ? 'Finance Manager' : 'Accountant', u.id);
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('users_remapped_v13', datetime('now'))").run();
  }
}

function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
function addColumn(table, col, ddl) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

// Idempotent upgrade of an existing database to the tax-compliant schema.
function migrateTax() {
  // Customers: tax identity + whether they deduct WHT at source when paying us
  addColumn('customers', 'tin', 'TEXT');
  addColumn('customers', 'rc_number', 'TEXT');
  addColumn('customers', 'wht_agent', 'INTEGER NOT NULL DEFAULT 0');
  // Invoice lines carry their own tax treatment
  addColumn('invoice_items', 'category', "TEXT NOT NULL DEFAULT 'rental'");
  addColumn('invoice_items', 'vat_rate', 'REAL NOT NULL DEFAULT 0');
  addColumn('invoice_items', 'vat_amount', 'REAL NOT NULL DEFAULT 0');
  addColumn('invoice_items', 'wht_rate', 'REAL NOT NULL DEFAULT 0');
  addColumn('invoice_items', 'wht_amount', 'REAL NOT NULL DEFAULT 0');
  // Invoice-level tax snapshot (so later setting changes never alter issued invoices)
  addColumn('invoices', 'taxable_total', 'REAL NOT NULL DEFAULT 0');
  addColumn('invoices', 'exempt_total', 'REAL NOT NULL DEFAULT 0');
  addColumn('invoices', 'wht_credited', 'REAL NOT NULL DEFAULT 0');
  addColumn('invoices', 'supply_date', 'TEXT');
  addColumn('invoices', 'supplier_tin', 'TEXT');
  addColumn('invoices', 'supplier_rc', 'TEXT');
  addColumn('invoices', 'customer_tin', 'TEXT');
  addColumn('invoices', 'vat_rate', 'REAL NOT NULL DEFAULT 0');
  addColumn('invoices', 'einvoice_status', "TEXT NOT NULL DEFAULT 'not_submitted'");
  addColumn('invoices', 'einvoice_irn', 'TEXT');
  addColumn('invoices', 'einvoice_csid', 'TEXT');
  addColumn('invoices', 'void_reason', 'TEXT');
  addColumn('invoices', 'voided_at', 'TEXT');
  addColumn('invoice_items', 'equipment_id', 'INTEGER');
  // Payments can be part cash, part WHT deducted at source by the customer
  addColumn('payments', 'reversed_at', 'TEXT');
  addColumn('payments', 'reversal_reason', 'TEXT');
  addColumn('payments', 'wht_amount', 'REAL NOT NULL DEFAULT 0');
  addColumn('payments', 'wht_credit_note_no', 'TEXT');
  // Expenses: vendor tax identity and invoice reference (needed to claim input VAT)
  addColumn('expenses', 'vendor_tin', 'TEXT');
  addColumn('expenses', 'vendor_invoice_no', 'TEXT');
  addColumn('expenses', 'wht_rate', 'REAL NOT NULL DEFAULT 0');
  addColumn('expenses', 'input_vat_claimed', 'REAL NOT NULL DEFAULT 0');
  // Deposits
  addColumn('rental_agreements', 'deposit_received', 'REAL NOT NULL DEFAULT 0');
  addColumn('rental_agreements', 'deposit_refunded', 'REAL NOT NULL DEFAULT 0');
  addColumn('rental_agreements', 'deposit_applied', 'REAL NOT NULL DEFAULT 0');
  // Voucher approvers are recorded for segregation-of-duties checks
  addColumn('users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'locked_until', 'TEXT');

}

// Run `fn` inside a transaction: all-or-nothing (prevents orphan invoices / half-posted journals).
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value !== null ? row.value : fallback;
}

function getSettings() {
  const obj = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) obj[r.key] = r.value;
  return obj;
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, hash) {
  const { hash: computed } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
}

const { ACCOUNTS, LEGACY_MAP, CLASSES } = require('./coa');

// Built-in roles. Voucher approval: level 1 = Finance Manager (or legacy Finance) / Admin, level 2 = Managing Director / Admin.
const DEFAULT_ROLES = [
  { name: 'Admin', description: 'Full system access (IT / system owner)', permissions: ['*'] },
  { name: 'Managing Director', description: 'Final (level-2) approver for payment vouchers and manual journals; read-only everywhere else', permissions: ['*.view', 'vouchers.approve', 'journals.approve', 'reports.*', 'admin.audit'] },
  { name: 'Finance Manager', description: 'Owns the books: level-1 voucher approver, chart of accounts, journals, legacy imports, tax & e-invoicing', permissions: ['finance.*', 'invoices.*', 'payments.*', 'expenses.*', 'vouchers.*', 'reports.*', 'accounts.*', 'journals.*', 'imports.*', 'einvoice.*', 'tax.*', 'claims.*', 'customers.view', 'rentals.view', 'equipment.view', 'consumables.view', 'kits.view', 'quotes.view', 'maintenance.view', 'locations.view', 'dispatch.view'] },
  { name: 'Accountant', description: 'Day-to-day bookkeeping: invoices, receipts, expenses, raises vouchers and draft journals (cannot approve)', permissions: ['finance.*', 'invoices.*', 'payments.*', 'expenses.*', 'vouchers.view', 'vouchers.edit', 'reports.*', 'accounts.view', 'journals.view', 'journals.edit', 'einvoice.view', 'einvoice.edit', 'tax.view', 'claims.*', 'customers.view', 'rentals.view', 'equipment.view', 'consumables.view', 'kits.view'] },
  { name: 'Tax & Compliance Officer', description: 'VAT/WHT returns, NRS e-invoice submissions, tax reports', permissions: ['tax.*', 'einvoice.*', 'reports.*', 'invoices.view', 'payments.view', 'expenses.view', 'customers.view', 'accounts.view', 'vouchers.view', 'journals.view'] },
  { name: 'Operations', description: 'Equipment, kits, customers, quotes, bookings, dispatch, crew, locations', permissions: ['equipment.*', 'kits.*', 'customers.*', 'rentals.*', 'dispatch.*', 'consumables.*', 'quotes.*', 'locations.*', 'claims.view', 'maintenance.view', 'reports.view'] },
  { name: 'Studio Manager', description: 'Studio-space bookings, caution fees, walk-throughs and studio crew', permissions: ['rentals.*', 'customers.*', 'quotes.*', 'dispatch.*', 'equipment.view', 'kits.view', 'consumables.view', 'locations.view'] },
  { name: 'Dispatch', description: 'Checkout / check-in, prep checklists and condition photos', permissions: ['dispatch.*', 'rentals.view', 'equipment.view', 'kits.view', 'consumables.*', 'locations.view'] },
  { name: 'Store Keeper', description: 'Consumables & spare-parts stock, location transfers', permissions: ['consumables.*', 'equipment.view', 'kits.view', 'rentals.view', 'maintenance.view', 'locations.*'] },
  { name: 'Maintenance', description: 'Work orders, spare parts, damage assessment', permissions: ['maintenance.*', 'equipment.view', 'claims.view', 'locations.view'] },
  { name: 'Sales', description: 'Quotes, customers and bookings (no dispatch, no finance)', permissions: ['quotes.*', 'customers.*', 'equipment.view', 'kits.view', 'rentals.*', 'locations.view'] },
  { name: 'Auditor', description: 'Read-only access to everything including the audit trail (external / internal audit)', permissions: ['*.view', 'admin.audit', 'reports.view'] },
  { name: 'Viewer', description: 'Read-only dashboards and lists', permissions: ['*.view'] },
];

function seedIfEmpty() {
  const roleCount = db.prepare('SELECT COUNT(*) as c FROM roles').get().c;
  if (roleCount === 0) {
    const ins = db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)');
    for (const r of DEFAULT_ROLES) ins.run(r.name, r.description, JSON.stringify(r.permissions));
  }

  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    const adminRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('Admin');
    const { hash, salt } = hashPassword('Admin@12345');
    db.prepare(`INSERT INTO users (full_name, email, phone, password_hash, password_salt, role_id, must_change_password)
                VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run('System Administrator', DEFAULT_ADMIN_EMAIL, '0000000000', hash, salt, adminRole.id);
  }

  const acctCount = db.prepare('SELECT COUNT(*) as c FROM chart_of_accounts').get().c;
  if (acctCount === 0) {
    const ins = db.prepare('INSERT INTO chart_of_accounts (code, name, account_type) VALUES (?, ?, ?)');
    for (const a of ACCOUNTS) ins.run(a[0], a[1], a[2]);
  }

  const settingsCount = db.prepare('SELECT COUNT(*) as c FROM settings').get().c;
  if (settingsCount === 0) {
    const defaults = {
      company_name: 'Olans FIXZIT Concept',
      vat_rate: '7.5',
      wht_rate_rental: '10',
      currency: 'NGN',
      session_timeout_minutes: '60',
      backup_retention_days: '30',
      maintenance_mode: '0',
      maintenance_mode_message: 'The portal is undergoing scheduled maintenance. Please check back shortly.',
    };
    const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(defaults)) ins.run(k, v);
  }
}

module.exports = { db, init, migrate, tx, reopen, close, hashPassword, verifyPassword, getSetting, getSettings, DB_PATH, DATA_DIR, DEFAULT_ADMIN_EMAIL };
