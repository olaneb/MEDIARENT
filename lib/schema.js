// Schema is embedded as a JS string so it ships with the code and never depends on loose .sql files.
module.exports = `
-- EquipRent Portal — full schema
PRAGMA foreign_keys = ON;

-- ===================== USERS & ROLES =====================
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,           -- Admin, Operations, Dispatch, Finance, Maintenance, Sales, Viewer
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]' -- JSON array of permission keys
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL DEFAULT 'active', -- active, suspended
  must_change_password INTEGER NOT NULL DEFAULT 0,
  signature_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  csrf_token TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== EQUIPMENT / ASSETS =====================
CREATE TABLE IF NOT EXISTS equipment_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  prep_checklist TEXT NOT NULL DEFAULT '[]' -- JSON array of checklist item strings, run at checkout/check-in
);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_code TEXT UNIQUE NOT NULL,      -- barcode/serial
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES equipment_categories(id),
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  year_of_manufacture INTEGER,
  spec_sheet TEXT,                       -- free text / JSON
  purchase_date TEXT,
  purchase_cost REAL NOT NULL DEFAULT 0,
  replacement_value REAL NOT NULL DEFAULT 0, -- what a customer owes if the unit is lost/stolen/destroyed
  salvage_value REAL NOT NULL DEFAULT 0,
  useful_life_years INTEGER NOT NULL DEFAULT 5,
  depreciation_method TEXT NOT NULL DEFAULT 'straight_line',
  condition_grade TEXT NOT NULL DEFAULT 'good', -- excellent, good, fair, poor
  status TEXT NOT NULL DEFAULT 'available', -- available, reserved, on_rent, maintenance, lost, retired
  current_location TEXT,
  daily_rate REAL NOT NULL DEFAULT 0,
  weekly_rate REAL NOT NULL DEFAULT 0,
  monthly_rate REAL NOT NULL DEFAULT 0,
  overtime_hourly_rate REAL NOT NULL DEFAULT 0,
  late_fee_daily REAL NOT NULL DEFAULT 0,
  photo_path TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  doc_type TEXT NOT NULL,   -- insurance, license, inspection_cert, manual
  file_path TEXT NOT NULL,
  expiry_date TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== KITS / PACKAGE BUNDLES =====================
CREATE TABLE IF NOT EXISTS kits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,             -- e.g. "Documentary Kit", "Wedding Kit"
  description TEXT,
  daily_rate REAL NOT NULL DEFAULT 0,   -- package rate, usually discounted vs sum of parts
  weekly_rate REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active, retired
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kit_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id INTEGER NOT NULL REFERENCES kits(id),
  equipment_id INTEGER NOT NULL REFERENCES equipment(id)
);

-- ===================== CUSTOMERS =====================
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_type TEXT NOT NULL DEFAULT 'individual', -- individual, company
  full_name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  id_doc_type TEXT,
  id_doc_number TEXT,
  id_doc_path TEXT,
  credit_limit REAL NOT NULL DEFAULT 0,
  outstanding_balance REAL NOT NULL DEFAULT 0,
  is_blacklisted INTEGER NOT NULL DEFAULT 0,
  blacklist_reason TEXT,
  coi_on_file INTEGER NOT NULL DEFAULT 0,     -- Certificate of Insurance held on file
  coi_expiry_date TEXT,                        -- many rental houses require a valid COI before handing out gear
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== QUOTES / RESERVATIONS / CONTRACTS =====================
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'draft', -- draft, sent, accepted, rejected, expired
  valid_until TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id),
  equipment_id INTEGER REFERENCES equipment(id),
  description TEXT,
  rate_type TEXT NOT NULL DEFAULT 'daily', -- daily, weekly, monthly
  rate REAL NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL DEFAULT 1,
  duration INTEGER NOT NULL DEFAULT 1,
  line_total REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rental_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_number TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  quote_id INTEGER REFERENCES quotes(id),
  kit_id INTEGER REFERENCES kits(id),          -- set if this booking was created from a kit
  project_name TEXT,                            -- production/job name, e.g. "Zenith Bank TVC"
  production_type TEXT,                         -- Film, Commercial, Wedding, Corporate, Music Video, Photography, Broadcast, Other
  shoot_location TEXT,
  start_date TEXT NOT NULL,
  expected_return_date TEXT NOT NULL,
  actual_return_date TEXT,
  status TEXT NOT NULL DEFAULT 'reserved', -- reserved, dispatched, active, overdue, returned, cancelled
  deposit_amount REAL NOT NULL DEFAULT 0,
  deposit_paid INTEGER NOT NULL DEFAULT 0,
  delivery_required INTEGER NOT NULL DEFAULT 0,
  delivery_address TEXT,
  damage_waiver_opted INTEGER NOT NULL DEFAULT 0,  -- customer paid a waiver fee to cap their damage liability
  damage_waiver_fee REAL NOT NULL DEFAULT 0,
  rush_fee REAL NOT NULL DEFAULT 0,                -- same-day / rush booking surcharge
  terms TEXT,
  signature_path TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agreement_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES rental_agreements(id),
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  rate_type TEXT NOT NULL DEFAULT 'daily',
  rate REAL NOT NULL DEFAULT 0,
  checkout_condition TEXT,
  checkout_photos TEXT, -- JSON array of paths
  checkout_checklist TEXT, -- JSON snapshot of the category prep checklist and whether each item was confirmed
  checkout_at TEXT,
  checkin_condition TEXT,
  checkin_photos TEXT,
  checkin_checklist TEXT,
  checkin_at TEXT,
  damage_notes TEXT,
  damage_charge REAL NOT NULL DEFAULT 0,
  is_lost INTEGER NOT NULL DEFAULT 0,        -- item was never returned — billed at replacement value instead
  replacement_charge REAL NOT NULL DEFAULT 0
);

-- Crew/labor booked alongside gear for a production — common in AV/production rental
CREATE TABLE IF NOT EXISTS agreement_crew (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES rental_agreements(id),
  crew_name TEXT NOT NULL,
  role TEXT,                 -- e.g. Camera Operator, Gaffer, Sound Mixer, DIT
  day_rate REAL NOT NULL DEFAULT 0,
  days REAL NOT NULL DEFAULT 1,
  notes TEXT
);

-- ===================== RENTAL CONSUMABLES =====================
-- Items issued with a booking that are billed as used rather than returned (media cards, batteries, tape, cables)
CREATE TABLE IF NOT EXISTS rental_consumables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,   -- what's billed to the customer per unit
  quantity_on_hand INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agreement_consumables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES rental_agreements(id),
  consumable_id INTEGER NOT NULL REFERENCES rental_consumables(id),
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  invoiced INTEGER NOT NULL DEFAULT 0
);

-- ===================== BILLING / INVOICING / PAYMENTS =====================
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE NOT NULL,
  agreement_id INTEGER REFERENCES rental_agreements(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  issue_date TEXT NOT NULL DEFAULT (date('now')),
  due_date TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  late_fee_total REAL NOT NULL DEFAULT 0,
  damage_total REAL NOT NULL DEFAULT 0,
  vat_total REAL NOT NULL DEFAULT 0,
  wht_total REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid', -- unpaid, partial, paid, void
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_ref TEXT UNIQUE NOT NULL,
  invoice_id INTEGER REFERENCES invoices(id),
  customer_id INTEGER REFERENCES customers(id),
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'bank_transfer', -- cash, bank_transfer, card, pos
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  received_by INTEGER REFERENCES users(id),
  notes TEXT
);

-- ===================== FULL FINANCE / ACCOUNTING =====================
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL, -- asset, liability, equity, income, expense
  parent_id INTEGER REFERENCES chart_of_accounts(id)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_number TEXT UNIQUE NOT NULL,
  entry_date TEXT NOT NULL DEFAULT (date('now')),
  memo TEXT,
  source_type TEXT, -- invoice, payment, expense, voucher, manual, depreciation
  source_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id),
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  description TEXT
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_number TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL, -- fuel, spare_parts, salary, rent, utilities, insurance, other
  equipment_id INTEGER REFERENCES equipment(id),
  amount REAL NOT NULL,
  vat_amount REAL NOT NULL DEFAULT 0,
  wht_amount REAL NOT NULL DEFAULT 0,
  expense_date TEXT NOT NULL DEFAULT (date('now')),
  description TEXT,
  vendor_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, paid, rejected
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payment vouchers with maker-checker approval chain
CREATE TABLE IF NOT EXISTS payment_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pv_number TEXT UNIQUE NOT NULL,
  payee_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  amount REAL NOT NULL,
  linked_expense_id INTEGER REFERENCES expenses(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected, paid
  current_level INTEGER NOT NULL DEFAULT 1,
  raised_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pv_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pv_id INTEGER NOT NULL REFERENCES payment_vouchers(id),
  level INTEGER NOT NULL,
  approver_id INTEGER REFERENCES users(id),
  decision TEXT, -- approved, rejected
  comment TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  opening_balance REAL NOT NULL DEFAULT 0,
  gl_account_id INTEGER REFERENCES chart_of_accounts(id)
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  txn_date TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL, -- positive = credit, negative = debit
  is_reconciled INTEGER NOT NULL DEFAULT 0,
  matched_journal_entry_id INTEGER REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS depreciation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL, -- e.g. 2026-09
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  total_amount REAL NOT NULL DEFAULT 0,
  journal_entry_id INTEGER REFERENCES journal_entries(id)
);

-- ===================== MAINTENANCE =====================
CREATE TABLE IF NOT EXISTS maintenance_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  schedule_type TEXT NOT NULL DEFAULT 'time_based', -- time_based, usage_based
  interval_days INTEGER,
  last_service_date TEXT,
  next_due_date TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_number TEXT UNIQUE NOT NULL,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  wo_type TEXT NOT NULL DEFAULT 'corrective', -- preventive, corrective, inspection
  status TEXT NOT NULL DEFAULT 'open', -- open, in_progress, completed, cancelled
  priority TEXT NOT NULL DEFAULT 'normal', -- low, normal, high, urgent
  description TEXT,
  assigned_to INTEGER REFERENCES users(id),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  labor_cost REAL NOT NULL DEFAULT 0,
  parts_cost REAL NOT NULL DEFAULT 0,
  linked_expense_id INTEGER REFERENCES expenses(id)
);

CREATE TABLE IF NOT EXISTS spare_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_order_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  part_id INTEGER NOT NULL REFERENCES spare_parts(id),
  qty_used INTEGER NOT NULL DEFAULT 1,
  unit_cost REAL NOT NULL DEFAULT 0
);

-- ===================== ADMIN / SETTINGS =====================
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_equipment_status ON equipment(status);
CREATE INDEX IF NOT EXISTS idx_agreements_status ON rental_agreements(status);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
`;
