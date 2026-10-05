// Invoice creation shared by bookings, cancellations and imports. Callers wrap it in tx().
const { db, getSettings } = require('./db');
const { nextNumber, postJournalEntry, refreshCustomerBalance } = require('./ledger');
const { logAudit } = require('./auth');
const taxlib = require('./tax');
const { ACC } = require('./coa');
const { r2 } = taxlib;

const today = () => new Date().toISOString().slice(0, 10);

const GL_NAMES = {
  [ACC.RENTAL_INCOME]: 'Equipment rental income', [ACC.STUDIO_INCOME]: 'Studio hire income', [ACC.LATE_FEES]: 'Late return fees',
  [ACC.DAMAGE_RECOVERY]: 'Damage recovery', [ACC.WAIVER_INCOME]: 'Damage waiver fee', [ACC.CONSUMABLES_INCOME]: 'Consumables billed',
  [ACC.RUSH_FEES]: 'Rush fee', [ACC.REPLACEMENT_RECOVERY]: 'Lost-item replacement recovery', [ACC.CREW_INCOME]: 'Crew & technical services',
  [ACC.DELIVERY_INCOME]: 'Delivery & logistics', [ACC.CANCELLATION_INCOME]: 'Cancellation fee',
};

function transactionModel(customer) {
  if (customer.is_government) return 'B2G';
  return customer.customer_type === 'company' ? 'B2B' : 'B2C';
}

/**
 * raw: [{ description, net, category, gl, equipment_id?, quantity?, unit_price? }]
 * Returns { id, invoice_number, grand_total, vat_total, net_total, wht_expected }
 */
function createInvoice({ customer, agreementId = null, raw, kind = 'rental', createdBy, ip, supplyDate, issueDate }) {
  const settings = getSettings();
  const cfg = taxlib.taxConfig(settings);
  const whtAgent = !!customer.wht_agent;
  const priced = raw.filter(l => l.net > 0).map(l => ({ ...l, ...taxlib.priceLine(l, cfg, { whtAgent }) }));
  if (!priced.length) { const e = new Error('Nothing to bill'); e.status = 400; throw e; }
  const t = taxlib.totals(priced);
  const issue = issueDate || today();
  const invoice_number = nextNumber('INV', 'invoices', 'invoice_number');
  const dueDays = parseInt(settings.invoice_due_days, 10) || 7;
  const sum = (pred) => r2(priced.filter(pred).reduce((a, l) => a + l.net, 0));
  const r = db.prepare(`INSERT INTO invoices
    (created_at, invoice_number, agreement_id, customer_id, issue_date, supply_date, due_date, subtotal, late_fee_total, damage_total,
     vat_total, wht_total, grand_total, taxable_total, exempt_total, vat_rate, supplier_tin, supplier_rc, customer_tin, invoice_kind, transaction_model)
    VALUES (?, ?, ?, ?, ?, ?, date(?, ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    issue === today() ? new Date().toISOString().replace('T', ' ').slice(0, 19) : issue + ' 10:00:00', invoice_number, agreementId, customer.id, issue, supplyDate && supplyDate < issue ? supplyDate : issue, issue, `+${dueDays} days`,
    t.net, sum(l => l.gl === ACC.LATE_FEES), sum(l => l.gl === ACC.DAMAGE_RECOVERY || l.gl === ACC.REPLACEMENT_RECOVERY),
    t.vat, t.wht, t.gross, t.taxable, t.outside, cfg.vatRegistered ? cfg.vatRate : 0,
    settings.company_vat_number || settings.company_tin || null, settings.company_rc_number || null, customer.tin || null, kind, transactionModel(customer));
  const invoiceId = Number(r.lastInsertRowid);
  const ins = db.prepare(`INSERT INTO invoice_items (invoice_id, description, amount, category, vat_rate, vat_amount, wht_rate, wht_amount, equipment_id, gl_code, quantity, unit_price)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const l of priced) ins.run(invoiceId, l.description, l.net, l.category, l.vat_rate, l.vat_amount, l.wht_rate, l.wht_amount, l.equipment_id || null, l.gl, l.quantity || 1, l.unit_price != null ? r2(l.unit_price) : l.net);

  // GL: Dr Trade receivables (gross) / Cr each income account (net) / Cr Output VAT
  const byGl = {};
  for (const l of priced) byGl[l.gl] = r2((byGl[l.gl] || 0) + l.net);
  const lines = [{ code: ACC.AR, debit: t.gross, credit: 0, description: `Invoice ${invoice_number}` }];
  for (const [code, amt] of Object.entries(byGl)) lines.push({ code, debit: 0, credit: amt, description: GL_NAMES[code] || 'Income' });
  if (t.vat > 0) lines.push({ code: ACC.VAT_PAYABLE, debit: 0, credit: t.vat, description: `Output VAT ${invoice_number}` });
  const je = postJournalEntry({ memo: `Invoice ${invoice_number}`, sourceType: 'invoice', sourceId: invoiceId, createdBy, lines, entryDate: issue });
  refreshCustomerBalance(customer.id);
  logAudit(createdBy, 'invoice_generated', 'invoice', invoiceId, { invoice_number, kind, journal_entry: je.entryNumber, net: t.net, vat: t.vat, gross: t.gross }, ip);
  return { id: invoiceId, invoice_number, grand_total: t.gross, vat_total: t.vat, net_total: t.net, wht_expected: t.wht };
}

// Rental days between two dates (minimum one).
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

// Builds the billable lines of a booking (used for invoicing, the cancellation fee base and accruals).
function bookingLines(ra, { asOf } = {}) {
  const items = db.prepare(`SELECT ai.*, e.name as equipment_name, e.late_fee_daily, cat.income_gl_code FROM agreement_items ai
                             JOIN equipment e ON e.id = ai.equipment_id LEFT JOIN equipment_categories cat ON cat.id = e.category_id
                             WHERE ai.agreement_id = ?`).all(ra.id);
  const endStr = asOf || ra.actual_return_date || ra.expected_return_date;
  const days = Math.max(1, dayDiff(ra.start_date, endStr));
  const lateDays = !asOf && ra.actual_return_date && ra.actual_return_date > ra.expected_return_date ? dayDiff(ra.expected_return_date, ra.actual_return_date) : 0;
  const raw = [];
  for (const it of items) {
    let dailyEq = it.rate;
    if (it.rate_type === 'weekly') dailyEq = it.rate / 7;
    if (it.rate_type === 'monthly') dailyEq = it.rate / 30;
    raw.push({ description: `${it.equipment_name} — ${days} day(s) @ ${it.rate_type} rate`, net: dailyEq * days, category: 'rental', gl: it.income_gl_code || ACC.RENTAL_INCOME, equipment_id: it.equipment_id, quantity: days, unit_price: dailyEq });
    if (lateDays > 0) {
      const perDay = it.late_fee_daily > 0 ? it.late_fee_daily : dailyEq * 0.5;
      raw.push({ description: `${it.equipment_name} — late return fee (${lateDays} day(s))`, net: perDay * lateDays, category: 'fee', gl: ACC.LATE_FEES, equipment_id: it.equipment_id, quantity: lateDays, unit_price: perDay });
    }
    if (it.is_lost && it.replacement_charge > 0) {
      raw.push({ description: `${it.equipment_name} — LOST, billed at replacement value`, net: it.replacement_charge, category: 'recovery', gl: ACC.REPLACEMENT_RECOVERY, equipment_id: it.equipment_id });
    } else if (it.damage_charge > 0 && !ra.damage_waiver_opted) {
      raw.push({ description: `${it.equipment_name} — damage charge`, net: it.damage_charge, category: 'recovery', gl: ACC.DAMAGE_RECOVERY, equipment_id: it.equipment_id });
    }
  }
  const crew = db.prepare('SELECT * FROM agreement_crew WHERE agreement_id = ?').all(ra.id);
  for (const c of crew) raw.push({ description: `Crew: ${c.crew_name}${c.role ? ' (' + c.role + ')' : ''} — ${c.days} day(s) @ ${c.day_rate}/day`, net: c.day_rate * c.days, category: 'service', gl: ACC.CREW_INCOME, quantity: c.days, unit_price: c.day_rate });
  const consumables = db.prepare(`SELECT ac.*, rc.name FROM agreement_consumables ac JOIN rental_consumables rc ON rc.id = ac.consumable_id
                                    WHERE ac.agreement_id = ? AND ac.invoiced = 0`).all(ra.id);
  for (const c of consumables) raw.push({ description: `${c.name} × ${c.qty} (consumable)`, net: c.unit_price * c.qty, category: 'goods', gl: ACC.CONSUMABLES_INCOME, quantity: c.qty, unit_price: c.unit_price });
  if (ra.damage_waiver_opted && ra.damage_waiver_fee > 0) raw.push({ description: 'Damage waiver fee', net: ra.damage_waiver_fee, category: 'fee', gl: ACC.WAIVER_INCOME });
  if (ra.rush_fee > 0) raw.push({ description: 'Rush booking fee', net: ra.rush_fee, category: 'fee', gl: ACC.RUSH_FEES });
  return { raw, consumables, days, lateDays, endStr };
}

module.exports = { createInvoice, bookingLines, transactionModel, dayDiff, GL_NAMES };
