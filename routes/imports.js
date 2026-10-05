// Legacy data migration: upload CSV or Excel (.xlsx) files exported from the previous system.
// Every import is two-step — PREVIEW (validates every row, posts nothing) then COMMIT (all-or-nothing transaction) —
// and is recorded as an import batch with its journal entry so it can be audited (and opening balances reversed).
const { db, tx, getSettings } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { nextNumber, postJournalEntry, reverseEntry, getAccountByCode, refreshCustomerBalance, round2: r2 } = require('../lib/ledger');
const { ACC, LEGACY_MAP, EXPENSE_GL, validCode, classOf, isHeader } = require('../lib/coa');
const { parseCsv, rowsToObjects, toCsv } = require('../lib/csv');
const { readXlsx, excelDate } = require('../lib/xlsx');
const { validTin } = require('../lib/tax');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z'));
const money = (v) => { if (v === '' || v == null) return 0; const n = Number(String(v).replace(/[₦,\s]/g, '').replace(/^\((.*)\)$/, '-$1')); return Number.isFinite(n) ? r2(n) : NaN; };
// Depreciation brought forward covers the period up to the migration date, so charging resumes the following month.
const firstOfNextMonth = (d) => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); };
const yes = (v) => /^(1|y|yes|true)$/i.test(String(v || '').trim());
const dateOf = (v) => { v = excelDate(v); if (!v) return ''; v = String(v).trim(); const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : v.slice(0, 10); };

const KINDS = {
  opening_tb: {
    label: 'Opening trial balance (GL balances)', perm: 'imports.edit',
    columns: ['account_code', 'account_name', 'debit', 'credit'],
    example: [['102000', 'Bank — operating account', '18500000', ''], ['111000', 'Trade receivables (control)', '6240000', ''], ['151000', 'Rental equipment — cost', '96000000', ''], ['151900', 'Rental equipment — accumulated depreciation', '', '31200000'], ['201000', 'Trade payables (control)', '', '2150000'], ['211000', 'Output VAT payable', '', '612000'], ['301000', 'Share capital', '', '10000000'], ['302000', 'Retained earnings', '', '76778000']],
    help: 'One row per GL account as at the migration date (the day before go-live). 6-digit codes; legacy 4-digit codes of earlier MediaRent builds are mapped automatically. Debits must equal credits (or tick "post difference to opening balance equity"). Receivables/payables control balances here are the GL value — then import the customer and supplier open items as subledger detail without posting.',
  },
  customer_balances: {
    label: 'Customer open invoices (receivables subledger)', perm: 'imports.edit',
    columns: ['customer_name', 'customer_email', 'customer_tin', 'invoice_no', 'invoice_date', 'due_date', 'amount_outstanding', 'description'],
    example: [['Accra Pictures Ltd', 'accounts@accrapictures.com', '20481133-0001', 'NX-2025-1180', '2026-08-28', '2026-09-27', '1450000', 'Camera package — legacy system']],
    help: 'One row per unpaid (or part-paid) invoice from the old system, with the amount still outstanding (VAT-inclusive). Customers are matched by name (created if new). Invoices keep their legacy number prefixed LEG-. They are NOT submitted to NRS (already issued).',
  },
  supplier_balances: {
    label: 'Supplier unpaid bills (payables subledger)', perm: 'imports.edit',
    columns: ['vendor_name', 'vendor_tin', 'bill_no', 'bill_date', 'due_date', 'amount_outstanding', 'category', 'wht_rate', 'description'],
    example: [['Ikeja Electric Plc', '', 'IE-55821', '2026-09-20', '2026-10-05', '385000', 'utilities', '0', 'Studio power — September']],
    help: 'Unpaid vendor bills (gross, VAT-inclusive). They appear under Finance → Expenses and are paid through vouchers like any bill; WHT (if a rate is given) is deducted at payment.',
  },
  equipment: {
    label: 'Equipment / fixed-asset register (with rate card)', perm: 'imports.edit',
    columns: ['asset_code', 'name', 'category', 'brand', 'model', 'serial_number', 'purchase_date', 'purchase_cost', 'accumulated_depreciation', 'useful_life_years', 'salvage_value', 'daily_rate', 'weekly_rate', 'replacement_value', 'location', 'includes_operator'],
    example: [['', 'ARRI ALEXA Mini LF body', 'Camera Bodies', 'ARRI', 'Alexa Mini LF', 'K1.0024567', '2023-03-15', '68000000', '13600000', '6', '6800000', '400000', '2000000', '75000000', 'Main warehouse', 'no']],
    help: 'One row per unit. Leave asset_code blank to auto-number. accumulated_depreciation is the amount brought forward from the old register; monthly depreciation continues from there.',
  },
  customers: {
    label: 'Customers', perm: 'imports.edit',
    columns: ['customer_type', 'full_name', 'company_name', 'email', 'phone', 'address', 'city', 'state', 'tin', 'rc_number', 'wht_agent', 'credit_limit'],
    example: [['company', 'Kunle Afolayan Productions', 'KAP Motion Pictures Ltd', 'production@kap.ng', '0803 000 0000', '12 Adeola Odeku St, Victoria Island', 'Lagos', 'Lagos', '23456789-0001', 'RC 1234567', 'yes', '5000000']],
    help: 'Matched by name — existing customers are skipped (not overwritten).',
  },
  consumables: {
    label: 'Consumables stock', perm: 'imports.edit',
    columns: ['item_code', 'name', 'unit', 'unit_cost', 'sale_price', 'quantity_on_hand', 'reorder_level'],
    example: [['GEL-OFFCUT', 'Off-cut gels (per sheet)', 'sheet', '18000', '30000', '40', '10']],
    help: 'Opening stock. With "post to GL" ticked, stock value (qty × unit cost) is debited to consumables inventory against opening balance equity.',
  },
  crew_rates: {
    label: 'Crew & operator rate card', perm: 'imports.edit',
    columns: ['role', 'day_rate', 'notes'],
    example: [['Steadicam Operator', '200000', 'Per 10-hour day']],
    help: 'Roles and day rates used when adding crew to a booking. A blank rate means "rate on request".',
  },
};

function parseUpload(b) {
  const name = String(b.filename || '').toLowerCase();
  if (b.content_base64) {
    const buf = Buffer.from(String(b.content_base64), 'base64');
    if (name.endsWith('.xlsx') || (buf[0] === 0x50 && buf[1] === 0x4b)) return readXlsx(buf);
    return parseCsv(buf.toString('utf8'));
  }
  if (b.text) return parseCsv(String(b.text));
  throw Object.assign(new Error('Attach a CSV or Excel (.xlsx) file'), { status: 400 });
}

// ---------- validators: return { rows: [{row, ok, errors[], warnings[], data}], summary, apply(ctx, opts) } ----------
function check(kind, objs, opts) {
  const out = []; const W = (o) => out.push(o);
  if (kind === 'opening_tb') {
    let dr = 0, cr = 0; const seen = new Set();
    for (const o of objs) {
      const errors = [], warnings = [];
      let code = String(o.account_code || o.code || o.gl_code || '').trim();
      if (/^\d{4}$/.test(code) && LEGACY_MAP[code]) { warnings.push(`Legacy code ${code} mapped to ${LEGACY_MAP[code]}`); code = LEGACY_MAP[code]; }
      const d = money(o.debit), c = money(o.credit);
      if (!validCode(code)) errors.push('Account code must be 6 digits (1xxxxx–8xxxxx)');
      else if (isHeader(code)) errors.push('Header accounts cannot hold balances');
      const acct = validCode(code) ? getAccountByCode(code) : null;
      if (validCode(code) && !acct) { if (opts.create_missing && String(o.account_name || '').trim()) warnings.push(`New ${classOf(code).type} account will be created: ${o.account_name}`); else errors.push('Unknown GL code (tick "create missing accounts" and give a name, or add it under Accounting → Chart of accounts)'); }
      if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0) errors.push('Debit/credit must be positive numbers');
      if (d > 0 && c > 0) errors.push('Use either a debit or a credit, not both');
      if (d === 0 && c === 0) warnings.push('Zero balance — skipped');
      if (seen.has(code)) errors.push('Account listed twice'); seen.add(code);
      if (acct && ['income', 'expense'].includes(acct.account_type)) warnings.push('Income/expense balance — only correct if migrating mid-year (otherwise roll it into retained earnings)');
      if (!errors.length) { dr += d || 0; cr += c || 0; }
      W({ row: o._row, ok: !errors.length, errors, warnings, data: { code, name: acct ? acct.name : o.account_name, debit: d || 0, credit: c || 0 } });
    }
    const diff = r2(dr - cr);
    return { rows: out, summary: { debit: r2(dr), credit: r2(cr), difference: diff, balanced: Math.abs(diff) < 0.01, plug: Math.abs(diff) >= 0.01 && opts.plug_to_obe ? diff : 0 },
      blocking: Math.abs(diff) >= 0.01 && !opts.plug_to_obe ? `Debits (${r2(dr)}) and credits (${r2(cr)}) differ by ${diff}. Fix the file or tick "post difference to opening balance equity (303000)".` : null };
  }
  if (kind === 'customer_balances') {
    let total = 0; const seen = new Set();
    for (const o of objs) {
      const errors = [], warnings = [];
      const name = String(o.customer_name || o.customer || '').trim(); const no = String(o.invoice_no || o.invoice_number || '').trim();
      const amt = money(o.amount_outstanding || o.amount || o.balance); const idate = dateOf(o.invoice_date), due = dateOf(o.due_date) || idate;
      if (!name) errors.push('customer_name is required');
      if (!no) errors.push('invoice_no is required');
      if (no && (seen.has(no) || db.prepare('SELECT 1 FROM invoices WHERE invoice_number = ? OR legacy_ref = ?').get('LEG-' + no, no))) errors.push('Invoice number already imported / duplicated');
      seen.add(no);
      if (!(amt > 0)) errors.push('amount_outstanding must be greater than zero');
      if (!isDate(idate)) errors.push('invoice_date must be a date (YYYY-MM-DD or DD/MM/YYYY)');
      if (o.customer_tin && !validTin(o.customer_tin)) warnings.push('TIN format looks unusual — kept as is');
      const exists = name ? db.prepare('SELECT id FROM customers WHERE lower(full_name) = lower(?) OR lower(company_name) = lower(?)').get(name, name) : null;
      if (name && !exists) warnings.push('New customer will be created');
      if (!errors.length) total += amt;
      W({ row: o._row, ok: !errors.length, errors, warnings, data: { name, email: o.customer_email || null, tin: o.customer_tin || null, no, idate, due, amt, description: o.description || 'Balance brought forward from previous system' } });
    }
    const arGl = getAccountByCode(ACC.AR);
    const arBal = r2(db.prepare('SELECT COALESCE(SUM(debit-credit),0) b FROM journal_lines WHERE account_id = ?').get(arGl.id).b);
    return { rows: out, summary: { total: r2(total), gl_receivables_balance: arBal, posts_to_gl: !!opts.post_to_gl } };
  }
  if (kind === 'supplier_balances') {
    let total = 0;
    for (const o of objs) {
      const errors = [], warnings = [];
      const name = String(o.vendor_name || o.vendor || '').trim(); const no = String(o.bill_no || o.invoice_no || '').trim();
      const amt = money(o.amount_outstanding || o.amount); const bdate = dateOf(o.bill_date || o.date); const cat = String(o.category || 'other').trim().toLowerCase().replace(/\s+/g, '_');
      const whtRate = o.wht_rate === '' || o.wht_rate == null ? 0 : Number(o.wht_rate);
      if (!name) errors.push('vendor_name is required');
      if (!(amt > 0)) errors.push('amount_outstanding must be greater than zero');
      if (!isDate(bdate)) errors.push('bill_date must be a date');
      if (!EXPENSE_GL[cat]) errors.push(`category must be one of: ${Object.keys(EXPENSE_GL).join(', ')}`);
      if (!(whtRate >= 0 && whtRate <= 20)) errors.push('wht_rate must be between 0 and 20');
      if (o.vendor_tin && !validTin(o.vendor_tin)) errors.push('vendor_tin looks invalid');
      if (!errors.length) total += amt;
      W({ row: o._row, ok: !errors.length, errors, warnings, data: { name, tin: o.vendor_tin || null, no, bdate, due: dateOf(o.due_date) || null, amt, cat, whtRate, description: o.description || `Legacy bill ${no}` } });
    }
    const ap = getAccountByCode(ACC.AP);
    return { rows: out, summary: { total: r2(total), gl_payables_balance: r2(-db.prepare('SELECT COALESCE(SUM(debit-credit),0) b FROM journal_lines WHERE account_id = ?').get(ap.id).b), posts_to_gl: !!opts.post_to_gl } };
  }
  if (kind === 'equipment') {
    let cost = 0, acc = 0; const codes = new Set();
    for (const o of objs) {
      const errors = [], warnings = [];
      const name = String(o.name || '').trim(); const code = String(o.asset_code || '').trim();
      const pc = money(o.purchase_cost), ad = money(o.accumulated_depreciation), dr = money(o.daily_rate), wr = money(o.weekly_rate), rv = money(o.replacement_value), sv = money(o.salvage_value);
      const life = o.useful_life_years ? Number(o.useful_life_years) : 5; const pd = dateOf(o.purchase_date);
      if (!name) errors.push('name is required');
      if (code && (codes.has(code) || db.prepare('SELECT 1 FROM equipment WHERE asset_code = ?').get(code))) errors.push(`Asset code ${code} already exists`);
      if (code) codes.add(code);
      for (const [k, v] of [['purchase_cost', pc], ['accumulated_depreciation', ad], ['daily_rate', dr], ['weekly_rate', wr], ['replacement_value', rv], ['salvage_value', sv]]) if (!Number.isFinite(v) || v < 0) errors.push(`${k} must be zero or a positive number`);
      if (ad > pc) errors.push('Accumulated depreciation cannot exceed cost');
      if (!(life > 0 && life <= 50)) errors.push('useful_life_years must be 1–50');
      if (o.purchase_date && !isDate(pd)) errors.push('purchase_date must be a date');
      if (!(dr > 0)) warnings.push('No daily rate — the unit will not price on bookings until one is set');
      if (!(rv > 0)) warnings.push('No replacement value — loss billing will be blocked until one is set');
      const catName = String(o.category || 'Uncategorised').trim();
      if (!db.prepare('SELECT 1 FROM equipment_categories WHERE lower(name) = lower(?)').get(catName)) warnings.push(`New category "${catName}" will be created`);
      if (!errors.length) { cost += pc || 0; acc += ad || 0; }
      W({ row: o._row, ok: !errors.length, errors, warnings, data: { code, name, catName, brand: o.brand || null, model: o.model || null, serial: o.serial_number || null, pd: pd || null, pc: pc || 0, ad: ad || 0, life, sv: sv || 0, dr: dr || 0, wr: wr || 0, rv: rv || 0, location: o.location || null, op: yes(o.includes_operator) } });
    }
    return { rows: out, summary: { units: out.filter(r => r.ok).length, cost: r2(cost), accumulated_depreciation: r2(acc), nbv: r2(cost - acc), posts_to_gl: !!opts.post_to_gl } };
  }
  if (kind === 'customers') {
    for (const o of objs) {
      const errors = [], warnings = [];
      const name = String(o.full_name || o.name || '').trim();
      if (!name) errors.push('full_name is required');
      const type = String(o.customer_type || (o.company_name ? 'company' : 'individual')).toLowerCase();
      if (!['individual', 'company'].includes(type)) errors.push('customer_type must be individual or company');
      if (o.tin && !validTin(o.tin)) errors.push('TIN looks invalid');
      if (name && db.prepare('SELECT 1 FROM customers WHERE lower(full_name) = lower(?)').get(name)) warnings.push('Already exists — will be skipped');
      W({ row: o._row, ok: !errors.length, errors, warnings, data: { ...o, name, type } });
    }
    return { rows: out, summary: { new_customers: out.filter(r => r.ok && !r.warnings.length).length } };
  }
  if (kind === 'consumables') {
    let value = 0;
    for (const o of objs) {
      const errors = [], warnings = [];
      const code = String(o.item_code || '').trim(), name = String(o.name || '').trim();
      const uc = money(o.unit_cost), sp = money(o.sale_price), q = Number(o.quantity_on_hand || 0), rl = Number(o.reorder_level || 0);
      if (!code || !name) errors.push('item_code and name are required');
      if (code && db.prepare('SELECT 1 FROM rental_consumables WHERE item_code = ?').get(code)) errors.push(`Item ${code} already exists`);
      if (!(uc >= 0) || !(sp >= 0) || !Number.isInteger(q) || q < 0 || !Number.isInteger(rl) || rl < 0) errors.push('Costs must be ≥ 0 and quantities whole numbers ≥ 0');
      if (!errors.length) value += uc * q;
      W({ row: o._row, ok: !errors.length, errors, warnings, data: { code, name, unit: o.unit || 'each', uc, sp, q, rl } });
    }
    return { rows: out, summary: { stock_value: r2(value), posts_to_gl: !!opts.post_to_gl } };
  }
  if (kind === 'crew_rates') {
    for (const o of objs) {
      const errors = []; const role = String(o.role || '').trim(); const rate = money(o.day_rate);
      if (!role) errors.push('role is required');
      if (!(rate >= 0)) errors.push('day_rate must be zero or positive');
      W({ row: o._row, ok: !errors.length, errors, warnings: db.prepare('SELECT 1 FROM crew_rate_card WHERE lower(role) = lower(?)').get(role) ? ['Exists — rate will be updated'] : [], data: { role, rate: rate || 0, notes: o.notes || null } });
    }
    return { rows: out, summary: {} };
  }
  throw Object.assign(new Error('Unknown import type'), { status: 400 });
}

function commit(kind, result, opts, ctx, filename) {
  const ok = result.rows.filter(r => r.ok).map(r => r.data);
  const asOf = opts.as_of_date;
  const batchNo = nextNumber('IMP', 'import_batches', 'batch_number');
  let je = null; const created = {};
  if (kind === 'opening_tb') {
    for (const r of ok) if (!getAccountByCode(r.code) && opts.create_missing) {
      const parent = db.prepare('SELECT id FROM chart_of_accounts WHERE code = ?').get(`${r.code[0]}00000`);
      db.prepare("INSERT INTO chart_of_accounts (code, name, account_type, parent_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(r.code, r.name, classOf(r.code).type, parent ? parent.id : null);
    }
    const lines = ok.filter(r => r.debit || r.credit).map(r => ({ code: r.code, debit: r.debit, credit: r.credit, description: 'Opening balance' }));
    const diff = result.summary.difference;
    if (Math.abs(diff) >= 0.01) lines.push({ code: ACC.OPENING_BALANCE_EQUITY, debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, description: 'Opening balance difference' });
    je = postJournalEntry({ memo: `Opening balances as at ${asOf} (${batchNo})`, sourceType: 'opening_balance', createdBy: ctx.user.id, entryDate: asOf, lines });
    created.lines = lines.length;
  } else if (kind === 'customer_balances') {
    let total = 0; created.invoices = 0; created.customers = 0;
    for (const r of ok) {
      let c = db.prepare('SELECT * FROM customers WHERE lower(full_name) = lower(?) OR lower(company_name) = lower(?)').get(r.name, r.name);
      if (!c) { const ins = db.prepare("INSERT INTO customers (customer_type, full_name, email, tin, wht_agent) VALUES ('company', ?, ?, ?, 1)").run(r.name, r.email, r.tin); c = { id: ins.lastInsertRowid }; created.customers++; }
      db.prepare(`INSERT INTO invoices (invoice_number, customer_id, issue_date, supply_date, due_date, subtotal, grand_total, status, is_legacy, legacy_ref, invoice_kind, einvoice_status, customer_tin)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'unpaid', 1, ?, 'legacy', 'not_applicable', ?)`).run('LEG-' + r.no, c.id, r.idate, r.idate, r.due, r.amt, r.amt, r.no, r.tin);
      const invId = db.prepare('SELECT last_insert_rowid() id').get().id;
      db.prepare("INSERT INTO invoice_items (invoice_id, description, amount, category) VALUES (?, ?, ?, 'rental')").run(invId, r.description, r.amt);
      refreshCustomerBalance(c.id); total += r.amt; created.invoices++;
    }
    if (opts.post_to_gl && total > 0) je = postJournalEntry({ memo: `Legacy receivables brought forward (${batchNo})`, sourceType: 'opening_balance', createdBy: ctx.user.id, entryDate: asOf,
      lines: [{ code: ACC.AR, debit: r2(total), description: 'Customer balances b/f' }, { code: ACC.OPENING_BALANCE_EQUITY, credit: r2(total), description: 'Customer balances b/f' }] });
  } else if (kind === 'supplier_balances') {
    let total = 0; created.bills = 0;
    for (const r of ok) {
      const no = nextNumber('EXP', 'expenses', 'expense_number');
      const wht = r2(r.amt * r.whtRate / 100); // applied to the amount outstanding as given
      db.prepare(`INSERT INTO expenses (expense_number, category, amount, vat_amount, wht_amount, wht_rate, expense_date, due_date, description, vendor_name, vendor_tin, vendor_invoice_no, status, is_legacy, gl_code, created_by)
                  VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`).run(no, r.cat, r.amt, wht, r.whtRate, r.bdate, r.due, r.description, r.name, r.tin, r.no || null, EXPENSE_GL[r.cat], ctx.user.id);
      total += r.amt; created.bills++;
    }
    if (opts.post_to_gl && total > 0) je = postJournalEntry({ memo: `Legacy payables brought forward (${batchNo})`, sourceType: 'opening_balance', createdBy: ctx.user.id, entryDate: asOf,
      lines: [{ code: ACC.OPENING_BALANCE_EQUITY, debit: r2(total), description: 'Supplier balances b/f' }, { code: ACC.AP, credit: r2(total), description: 'Supplier balances b/f' }] });
  } else if (kind === 'equipment') {
    created.units = 0; let cost = 0, acc = 0;
    const defLoc = db.prepare('SELECT id FROM locations WHERE is_default = 1 ORDER BY id LIMIT 1').get();
    for (const r of ok) {
      let cat = db.prepare('SELECT id FROM equipment_categories WHERE lower(name) = lower(?)').get(r.catName);
      if (!cat) { const ins = db.prepare("INSERT INTO equipment_categories (name, prep_checklist) VALUES (?, '[]')").run(r.catName); cat = { id: ins.lastInsertRowid }; }
      let loc = r.location ? db.prepare('SELECT id FROM locations WHERE lower(name) = lower(?) OR lower(code) = lower(?)').get(r.location, r.location) : null;
      if (!loc && r.location) { const code = r.location.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'LOC'; const ins = db.prepare('INSERT OR IGNORE INTO locations (code, name) VALUES (?, ?)').run(code + db.prepare('SELECT COUNT(*) c FROM locations').get().c, r.location); loc = { id: ins.lastInsertRowid }; }
      const code = r.code || ('EQP-' + String((db.prepare("SELECT MAX(CAST(SUBSTR(asset_code, 5) AS INTEGER)) as m FROM equipment WHERE asset_code LIKE 'EQP-%'").get().m || 0) + 1).padStart(5, '0'));
      db.prepare(`INSERT INTO equipment (asset_code, name, category_id, brand, model, serial_number, purchase_date, purchase_cost, opening_accumulated_depreciation, useful_life_years, salvage_value,
                  daily_rate, weekly_rate, replacement_value, location_id, includes_operator, depreciation_start_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(code, r.name, cat.id, r.brand, r.model, r.serial, r.pd, r.pc, r.ad, r.life, r.sv, r.dr, r.wr, r.rv, (loc || defLoc || {}).id || null, r.op ? 1 : 0, r.pd ? (asOf >= r.pd ? firstOfNextMonth(asOf) : r.pd) : null);
      created.units++; cost += r.pc; acc += r.ad;
    }
    if (opts.post_to_gl && cost > 0) je = postJournalEntry({ memo: `Fixed-asset register brought forward (${batchNo})`, sourceType: 'opening_balance', createdBy: ctx.user.id, entryDate: asOf,
      lines: [{ code: ACC.EQUIPMENT_COST, debit: r2(cost), description: 'Equipment at cost b/f' }, { code: ACC.EQUIPMENT_ACC_DEP, credit: r2(acc), description: 'Accumulated depreciation b/f' }, { code: ACC.OPENING_BALANCE_EQUITY, credit: r2(cost - acc), description: 'Net book value b/f' }] });
  } else if (kind === 'customers') {
    created.customers = 0;
    for (const r of ok) {
      if (db.prepare('SELECT 1 FROM customers WHERE lower(full_name) = lower(?)').get(r.name)) continue;
      db.prepare(`INSERT INTO customers (customer_type, full_name, company_name, email, phone, address, city, state, tin, rc_number, wht_agent, credit_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.type, r.name, r.company_name || null, r.email || null, r.phone || null, r.address || null, r.city || null, r.state || null, r.tin || null, r.rc_number || null, r.wht_agent === '' || r.wht_agent == null ? (r.type === 'company' ? 1 : 0) : (yes(r.wht_agent) ? 1 : 0), money(r.credit_limit) || 0);
      created.customers++;
    }
  } else if (kind === 'consumables') {
    created.items = 0; let value = 0;
    for (const r of ok) { db.prepare('INSERT INTO rental_consumables (item_code, name, unit, unit_cost, sale_price, quantity_on_hand, reorder_level) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.code, r.name, r.unit, r.uc, r.sp, r.q, r.rl); created.items++; value += r.uc * r.q; }
    if (opts.post_to_gl && value > 0) je = postJournalEntry({ memo: `Consumables stock brought forward (${batchNo})`, sourceType: 'opening_balance', createdBy: ctx.user.id, entryDate: asOf,
      lines: [{ code: ACC.CONSUMABLES_INVENTORY, debit: r2(value), description: 'Consumables stock b/f' }, { code: ACC.OPENING_BALANCE_EQUITY, credit: r2(value), description: 'Consumables stock b/f' }] });
  } else if (kind === 'crew_rates') {
    created.roles = 0;
    for (const r of ok) { db.prepare('INSERT INTO crew_rate_card (role, day_rate, rate_on_request, notes) VALUES (?, ?, ?, ?) ON CONFLICT(role) DO UPDATE SET day_rate = excluded.day_rate, rate_on_request = excluded.rate_on_request, notes = excluded.notes').run(r.role, r.rate, r.rate > 0 ? 0 : 1, r.notes); created.roles++; }
  }
  const r = db.prepare('INSERT INTO import_batches (batch_number, kind, filename, as_of_date, rows_total, rows_ok, journal_entry_id, summary, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(batchNo, kind, filename || null, asOf, result.rows.length, ok.length, je ? je.entryId : null, JSON.stringify({ ...result.summary, created }), ctx.user.id);
  logAudit(ctx.user.id, 'legacy_import', 'import_batch', r.lastInsertRowid, { kind, batch: batchNo, rows: ok.length, journal_entry: je ? je.entryNumber : null }, ctx.ip);
  return { batch_number: batchNo, id: r.lastInsertRowid, imported: ok.length, created, journal_entry: je ? je.entryNumber : null };
}

module.exports = function (router) {
  router.get('/api/imports/kinds', async (ctx) => {
    if (!ctx.require('imports.edit')) return;
    ctx.json(200, Object.entries(KINDS).map(([key, k]) => ({ key, label: k.label, columns: k.columns, help: k.help })));
  });

  router.get('/api/imports/templates/:kind', async (ctx, { kind }) => {
    if (!ctx.require('imports.edit')) return;
    const k = KINDS[String(kind).replace(/\.(csv|xlsx)$/, '')];
    if (!k) return ctx.json(404, { error: 'Unknown template' });
    if (String(kind).endsWith('.xlsx')) {
      const { buildXlsx } = require('../lib/xlsx');
      const body = buildXlsx([{ name: 'Import', columns: k.columns.map(c => ({ header: c, type: 'text' })), rows: k.example }]);
      ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="template-${kind}"` });
      return ctx.res.end(body);
    }
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="template-${String(kind).replace(/\.csv$/, '')}.csv"` });
    ctx.res.end(toCsv([k.columns, ...k.example]));
  });

  const handle = (doCommit) => async (ctx, { kind }) => {
    if (!ctx.require('imports.edit')) return;
    if (!ctx.requireCsrf()) return;
    if (!KINDS[kind]) return ctx.json(404, { error: 'Unknown import type' });
    const b = ctx.body;
    const opts = { as_of_date: b.as_of_date, post_to_gl: !!b.post_to_gl, plug_to_obe: !!b.plug_to_obe, create_missing: !!b.create_missing };
    let lockMsg = null;
    if (['opening_tb', 'customer_balances', 'supplier_balances', 'equipment', 'consumables'].includes(kind)) {
      if (!isDate(opts.as_of_date)) return ctx.json(400, { error: 'Choose the migration (as-at) date — normally the day before go-live' });
      const lock = getSettings().books_locked_until;
      if ((kind === 'opening_tb' || opts.post_to_gl) && lock && opts.as_of_date <= lock) lockMsg = `The books are locked up to ${lock}; unlock the period (Accounting → Period-end) to post opening balances`;
    }
    let objs;
    try { objs = rowsToObjects(parseUpload(b)); } catch (e) { return ctx.json(e.status || 400, { error: 'Could not read the file: ' + e.message }); }
    if (!objs.length) return ctx.json(400, { error: 'The file has a header row but no data rows' });
    if (objs.length > 20000) return ctx.json(400, { error: 'Maximum 20,000 rows per import — split the file' });
    const result = check(kind, objs, opts);
    const errorRows = result.rows.filter(r => !r.ok).length;
    const blocking = [result.blocking, lockMsg].filter(Boolean).join(' ') || null;
    if (!doCommit) return ctx.json(200, { kind, rows: result.rows, summary: result.summary, blocking, error_rows: errorRows, ok_rows: result.rows.length - errorRows });
    if (result.blocking) return ctx.json(400, { error: result.blocking });
    if (kind === 'opening_tb' && db.prepare("SELECT 1 FROM import_batches WHERE kind = 'opening_tb' AND status = 'posted'").get() && !b.confirm_additional) return ctx.json(409, { error: 'Opening balances have already been imported. Reverse that batch first, or tick "this is an additional opening-balance batch".' });
    if (blocking) return ctx.json(400, { error: blocking });
    if (errorRows && !b.skip_errors) return ctx.json(400, { error: `${errorRows} row(s) have errors. Fix them, or tick "skip rows with errors" to import the rest.` });
    const out = tx(() => commit(kind, result, opts, ctx, b.filename));
    ctx.json(201, out);
  };
  router.post('/api/imports/:kind/preview', handle(false));
  router.post('/api/imports/:kind/commit', handle(true));

  router.get('/api/imports', async (ctx) => {
    if (!ctx.require('imports.edit')) return;
    ctx.json(200, db.prepare(`SELECT b.*, u.full_name as created_by_name, je.entry_number FROM import_batches b LEFT JOIN users u ON u.id = b.created_by
      LEFT JOIN journal_entries je ON je.id = b.journal_entry_id ORDER BY b.id DESC`).all().map(r => ({ ...r, summary: JSON.parse(r.summary || '{}'), label: (KINDS[r.kind] || {}).label })));
  });

  // Reversing a GL-posting batch backs out its journal; the records it created stay (delete or adjust them individually).
  router.post('/api/imports/:id/reverse', async (ctx, { id }) => {
    if (!ctx.require('imports.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
    if (!b) return ctx.json(404, { error: 'Not found' });
    if (b.status !== 'posted') return ctx.json(400, { error: 'Batch already reversed' });
    if (!b.journal_entry_id) return ctx.json(400, { error: 'This batch did not post to the ledger, so there is nothing to reverse' });
    tx(() => {
      reverseEntry(b.journal_entry_id, { memo: `Reversal of import ${b.batch_number}`, createdBy: ctx.user.id, sourceType: 'opening_balance_reversal', sourceId: b.id, entryDate: b.as_of_date });
      db.prepare("UPDATE import_batches SET status = 'reversed' WHERE id = ?").run(id);
      logAudit(ctx.user.id, 'legacy_import_reversed', 'import_batch', Number(id), { batch: b.batch_number }, ctx.ip);
    });
    ctx.json(200, { ok: true });
  });
};
