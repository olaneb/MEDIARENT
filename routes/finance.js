const { db, tx, getSettings } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { nextNumber, postJournalEntry, reverseEntry, entriesForSource, trialBalance, profitAndLoss, balanceSheet, refreshCustomerBalance, getAccountByCode } = require('../lib/ledger');
const taxlib = require('../lib/tax');
const nrs = require('../lib/nrs');
const { ACC, EXPENSE_GL } = require('../lib/coa');
const { createInvoice, bookingLines } = require('../lib/billing');
const { r2, CATEGORIES } = taxlib;

const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'pos', 'cheque'];
const EXPENSE_CATEGORIES = Object.keys(EXPENSE_GL);
// What kind of payment is it for WHT purposes when WE pay a vendor? (fuel/energy products are WHT-exempt under the 2024 Regulations)
const EXPENSE_WHT_KIND = { rent: 'rent', sub_rental: 'hire', spare_parts: 'goods', repairs: 'services', consumables: 'goods', crew: 'services', transport: 'services', professional_fees: 'services', marketing: 'services', office: 'goods', travel: null, fuel: null, utilities: null, salary: null, insurance: null, equipment_insurance: null, bank_charges: null, equipment_purchase: 'goods', other: 'services' };

const today = () => new Date().toISOString().slice(0, 10);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (v === '' || v == null ? NaN : Number(v));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function levelRoles(level) {
  const s = getSettings();
  const raw = level === 1 ? (s.pv_level1_roles || 'Finance Manager,Finance,Admin') : (s.pv_level2_roles || 'Managing Director,Admin');
  return raw.split(',').map(x => x.trim()).filter(Boolean);
}
const APPROVAL_LEVELS = 2;

// A bank / cash account money can be received into or paid from: a posting asset account in the 10xxxx range.
function cashAccount(code, fallback) {
  const c = String(code || fallback);
  const a = getAccountByCode(c);
  if (!a || a.is_header || a.account_type !== 'asset' || !c.startsWith('10')) return null;
  return a.code;
}

module.exports = function (router) {
  router.get('/api/tax/config', async (ctx) => {
    if (!ctx.user) return ctx.json(401, { error: 'Not authenticated' });
    const s = getSettings();
    const cfg = taxlib.taxConfig(s);
    ctx.json(200, {
      vat_registered: cfg.vatRegistered, vat_rate: cfg.vatRate, wht: cfg.wht, no_tin_multiplier: cfg.noTinMultiplier,
      einvoice_enabled: s.einvoice_enabled === '1' || (s.nrs_mode && s.nrs_mode !== 'off'), nrs_mode: s.nrs_mode || 'off',
      cancellation_fee_pct: Number(s.cancellation_fee_pct || 0),
      categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, { label: v.label, vat: v.vat }])),
      expense_categories: EXPENSE_CATEGORIES, expense_wht_kind: EXPENSE_WHT_KIND, expense_gl: EXPENSE_GL,
    });
  });

  // Money accounts for receipts / payments pickers.
  router.get('/api/cash-accounts', async (ctx) => {
    if (!ctx.user) return ctx.json(401, { error: 'Not authenticated' });
    ctx.json(200, db.prepare("SELECT code, name FROM chart_of_accounts WHERE account_type = 'asset' AND is_header = 0 AND is_active = 1 AND substr(code,1,2) = '10' ORDER BY code").all());
  });

  // ---------- INVOICING ----------
  router.post('/api/invoices/generate/:agreementId', async (ctx, { agreementId }) => {
    if (!ctx.require('invoices.edit')) return;
    if (!ctx.requireCsrf()) return;
    const ra = db.prepare('SELECT * FROM rental_agreements WHERE id = ?').get(agreementId);
    if (!ra) return ctx.json(404, { error: 'Agreement not found' });
    if (ra.status === 'cancelled') return ctx.json(400, { error: 'A cancelled booking cannot be invoiced' });
    const existing = db.prepare("SELECT invoice_number FROM invoices WHERE agreement_id = ? AND status != 'void'").get(agreementId);
    if (existing) return ctx.json(409, { error: `This booking already has invoice ${existing.invoice_number}. Void it first if it needs to be re-issued.` });
    if (!db.prepare('SELECT COUNT(*) c FROM agreement_items WHERE agreement_id = ?').get(agreementId).c) return ctx.json(400, { error: 'Booking has no equipment to bill' });
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(ra.customer_id);
    // Optional issue date (e.g. invoice raised on the return date). Must not be in the future, in a locked period,
    // or earlier than the last invoice issued — VAT invoice numbers must run in date order.
    const issueDate = ctx.body.issue_date || null;
    if (issueDate) {
      if (!isDate(issueDate) || issueDate > today()) return ctx.json(400, { error: 'Issue date must be a valid date, not in the future' });
      const last = db.prepare("SELECT MAX(issue_date) d FROM invoices WHERE is_legacy = 0").get().d;
      if (last && issueDate < last) return ctx.json(400, { error: `Issue date cannot be earlier than the last invoice issued (${last}) — invoice numbers must run in date order` });
      if (ra.start_date > issueDate) return ctx.json(400, { error: 'Issue date cannot be before the booking starts' });
    }
    const { raw, consumables, endStr } = bookingLines(ra);
    if (!raw.some(l => l.net > 0)) return ctx.json(400, { error: 'Nothing to bill on this booking' });
    const result = tx(() => {
      const out = createInvoice({ customer, agreementId: ra.id, raw, kind: 'rental', createdBy: ctx.user.id, ip: ctx.ip, supplyDate: endStr, issueDate });
      if (consumables.length) db.prepare('UPDATE agreement_consumables SET invoiced = 1 WHERE agreement_id = ? AND invoiced = 0').run(agreementId);
      return out;
    });
    if (nrs.cfg().autoSubmit && nrs.cfg().mode !== 'off') {
      const sub = await nrs.submitInvoice(result.id, ctx.user.id);
      result.einvoice = { status: sub.status, irn: sub.irn, errors: sub.errors };
    }
    ctx.json(201, result);
  });

  router.get('/api/invoices', async (ctx) => {
    if (!ctx.require('invoices.view')) return;
    const { status, customer_id, from, to, einvoice_status, q, overdue, legacy, kind } = ctx.query;
    let sql = `SELECT i.*, ROUND(i.grand_total - i.amount_paid, 2) as balance, c.full_name as customer_name, c.company_name,
               CAST(julianday('now') - julianday(i.due_date) AS INTEGER) as days_overdue
               FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE 1=1`;
    const params = [];
    if (status === 'open') sql += " AND i.status IN ('unpaid','partial')";
    else if (status) { sql += ' AND i.status = ?'; params.push(status); }
    if (customer_id) { sql += ' AND i.customer_id = ?'; params.push(customer_id); }
    if (from) { sql += ' AND i.issue_date >= ?'; params.push(from); }
    if (to) { sql += ' AND i.issue_date <= ?'; params.push(to); }
    if (einvoice_status === 'pending') sql += " AND i.status != 'void' AND i.is_legacy = 0 AND i.einvoice_status IN ('not_submitted','rejected','submitted')";
    else if (einvoice_status) { sql += ' AND i.einvoice_status = ?'; params.push(einvoice_status); }
    if (overdue === '1') sql += " AND i.status IN ('unpaid','partial') AND i.due_date < date('now')";
    if (legacy === '1') sql += ' AND i.is_legacy = 1';
    if (kind) { sql += ' AND i.invoice_kind = ?'; params.push(kind); }
    if (q) { sql += ' AND (i.invoice_number LIKE ? OR c.full_name LIKE ? OR c.company_name LIKE ? OR i.einvoice_irn LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY i.id DESC';
    ctx.json(200, db.prepare(sql).all(...params));
  });

  router.get('/api/invoices/:id', async (ctx, { id }) => {
    if (!ctx.require('invoices.view')) return;
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) return ctx.json(404, { error: 'Not found' });
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(id);
    const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id').all(id);
    const customer = db.prepare('SELECT id, full_name, company_name, email, tin, wht_agent, customer_type FROM customers WHERE id = ?').get(inv.customer_id) || {};
    const emails = db.prepare(`SELECT ie.*, u.full_name as sent_by_name FROM invoice_emails ie
                               LEFT JOIN users u ON u.id = ie.sent_by WHERE ie.invoice_id = ? ORDER BY ie.id DESC`).all(id);
    const journals = db.prepare(`SELECT id, entry_number, entry_date, memo, source_type FROM journal_entries
                                 WHERE (source_type IN ('invoice','invoice_void') AND source_id = ?)
                                    OR (source_type IN ('payment','payment_reversal') AND source_id IN (SELECT id FROM payments WHERE invoice_id = ?)) ORDER BY id`).all(id, id);
    const submissions = db.prepare(`SELECT s.id, s.action, s.mode, s.status, s.http_status, s.error, s.created_at, u.full_name as by_name FROM einvoice_submissions s
                                    LEFT JOIN users u ON u.id = s.created_by WHERE s.invoice_id = ? ORDER BY s.id DESC LIMIT 30`).all(id);
    const agreement = inv.agreement_id ? db.prepare('SELECT id, agreement_number FROM rental_agreements WHERE id = ?').get(inv.agreement_id) : null;
    ctx.json(200, { ...inv, balance: r2(inv.grand_total - inv.amount_paid), items, payments, journals, submissions, agreement,
      customer_name: customer.company_name || customer.full_name, customer_email: customer.email, customer_id: customer.id,
      customer_tin: inv.customer_tin || customer.tin || null, customer_wht_agent: !!customer.wht_agent, emails, nrs_mode: nrs.cfg().mode });
  });

  // Void an unpaid invoice: reversing journal; consumables freed for re-billing; number retained. If the invoice was
  // already cleared on the NRS MBS, a credit note (type 381) referencing the IRN is issued and reported instead.
  router.post('/api/invoices/:id/void', async (ctx, { id }) => {
    if (!ctx.require('invoices.edit')) return;
    if (!ctx.requireCsrf()) return;
    const reason = String(ctx.body.reason || '').trim();
    if (reason.length < 5) return ctx.json(400, { error: 'Please give a reason (at least 5 characters) for voiding this invoice' });
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) return ctx.json(404, { error: 'Not found' });
    if (inv.status === 'void') return ctx.json(400, { error: 'Invoice is already void' });
    const live = db.prepare('SELECT COUNT(*) as c FROM payments WHERE invoice_id = ? AND reversed_at IS NULL').get(id).c;
    if (inv.amount_paid > 0.005 || live > 0) return ctx.json(400, { error: 'This invoice has payments recorded. Reverse the payments first, then void the invoice.' });
    let creditNote = null;
    tx(() => {
      for (const e of entriesForSource('invoice', Number(id))) reverseEntry(e.id, { memo: `Void of ${inv.invoice_number}: ${reason}`, createdBy: ctx.user.id, sourceType: 'invoice_void', sourceId: Number(id) });
      if (inv.is_legacy && !entriesForSource('invoice', Number(id)).length) { /* subledger-only legacy invoice: nothing posted */ }
      if (inv.einvoice_status === 'cleared') creditNote = nextNumber('CN', 'invoices', 'credit_note_number');
      db.prepare("UPDATE invoices SET status = 'void', void_reason = ?, voided_at = datetime('now'), credit_note_number = COALESCE(?, credit_note_number) WHERE id = ?").run(reason, creditNote, id);
      if (inv.agreement_id) db.prepare('UPDATE agreement_consumables SET invoiced = 0 WHERE agreement_id = ?').run(inv.agreement_id);
      refreshCustomerBalance(inv.customer_id);
      logAudit(ctx.user.id, 'invoice_voided', 'invoice', Number(id), { invoice_number: inv.invoice_number, reason, credit_note: creditNote }, ctx.ip);
    });
    let einv = null;
    if (creditNote && nrs.cfg().mode !== 'off') einv = await nrs.submitInvoice(Number(id), ctx.user.id, { creditNote: true });
    ctx.json(200, { ok: true, credit_note_number: creditNote, einvoice: einv });
  });

  // Manual record of IRN / CSID (for invoices cleared outside the portal, e.g. on the APP's own web portal).
  router.put('/api/invoices/:id/einvoice', async (ctx, { id }) => {
    if (!ctx.require('invoices.edit')) return;
    if (!ctx.requireCsrf()) return;
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) return ctx.json(404, { error: 'Not found' });
    const { status, irn, csid } = ctx.body;
    if (!['not_submitted', 'submitted', 'cleared', 'rejected'].includes(status)) return ctx.json(400, { error: 'Invalid e-invoice status' });
    if (status === 'cleared' && !String(irn || '').trim()) return ctx.json(400, { error: 'An IRN is required once an invoice is cleared' });
    db.prepare(`UPDATE invoices SET einvoice_status = ?, einvoice_irn = ?, einvoice_csid = ?, einvoice_cleared_at = CASE WHEN ? = 'cleared' THEN COALESCE(einvoice_cleared_at, datetime('now')) ELSE einvoice_cleared_at END WHERE id = ?`)
      .run(status, String(irn || '').trim() || null, String(csid || '').trim() || null, status, id);
    logAudit(ctx.user.id, 'einvoice_status_updated', 'invoice', Number(id), { status, irn, manual: true }, ctx.ip);
    ctx.json(200, { ok: true });
  });

  router.get('/api/invoices/:id/einvoice.json', async (ctx, { id }) => {
    if (!ctx.require('invoices.view')) return;
    const payload = nrs.buildPayload(Number(id));
    if (!payload) return ctx.json(404, { error: 'Not found' });
    const check = nrs.validateLocal(Number(id));
    const body = JSON.stringify({ _note: 'NRS Merchant Buyer Solution invoice payload. Submit via an NRS-accredited Access Point Provider; IRN is <invoice no>-<Service ID>-<YYYYMMDD>.', _validation: check, ...payload }, null, 2);
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="einvoice-${id}.json"`, 'Cache-Control': 'no-store' });
    ctx.res.end(body);
  });

  // ---------- PAYMENTS ----------
  router.get('/api/payments', async (ctx) => {
    if (!ctx.require('payments.view')) return;
    const { from, to, customer_id, method } = ctx.query;
    let sql = `SELECT p.*, i.invoice_number, c.full_name as customer_name FROM payments p
               LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN customers c ON c.id = p.customer_id WHERE 1=1`;
    const params = [];
    if (from) { sql += ' AND date(p.received_at) >= ?'; params.push(from); }
    if (to) { sql += ' AND date(p.received_at) <= ?'; params.push(to); }
    if (customer_id) { sql += ' AND p.customer_id = ?'; params.push(customer_id); }
    if (method) { sql += ' AND p.method = ?'; params.push(method); }
    ctx.json(200, db.prepare(sql + ' ORDER BY p.id DESC LIMIT 1000').all(...params));
  });

  // A payment can be part cash/bank and part WHT deducted at source by the customer. Both settle the invoice;
  // the WHT part is a tax credit we hold (114000) and is evidenced by the customer's WHT credit note.
  router.post('/api/payments', async (ctx) => {
    if (!ctx.require('payments.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(b.invoice_id);
    if (!invoice) return ctx.json(404, { error: 'Invoice not found' });
    if (invoice.status === 'void') return ctx.json(400, { error: 'Cannot record a payment against a void invoice' });
    if (invoice.status === 'paid') return ctx.json(400, { error: 'Invoice is already fully paid' });
    const cash = r2(b.amount === undefined || b.amount === '' ? 0 : Number(b.amount));
    const wht = r2(b.wht_amount === undefined || b.wht_amount === '' ? 0 : Number(b.wht_amount));
    if (!isNum(cash) || !isNum(wht) || cash < 0 || wht < 0) return ctx.json(400, { error: 'Amounts must be zero or positive numbers' });
    if (cash + wht <= 0) return ctx.json(400, { error: 'Enter the amount received (and/or the WHT deducted)' });
    const method = b.method || 'bank_transfer';
    if (!PAYMENT_METHODS.includes(method)) return ctx.json(400, { error: `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}` });
    const into = cashAccount(b.deposit_to, method === 'cash' ? ACC.CASH : ACC.BANK);
    if (!into) return ctx.json(400, { error: 'Received-into must be a cash or bank account (10xxxx)' });
    if (b.received_on && (!isDate(b.received_on) || b.received_on > today())) return ctx.json(400, { error: 'Receipt date must be a valid date, not in the future' });
    const balance = r2(invoice.grand_total - invoice.amount_paid);
    const settle = r2(cash + wht);
    if (settle > balance + 0.005) return ctx.json(400, { error: `Payment of ${settle.toFixed(2)} exceeds the invoice balance of ${balance.toFixed(2)}` });
    if (wht > 0 && !invoice.is_legacy) {
      const cfg = taxlib.taxConfig();
      const items = db.prepare('SELECT amount, category FROM invoice_items WHERE invoice_id = ?').all(invoice.id);
      const maxWht = r2(items.reduce((a, l) => a + taxlib.priceLine({ category: l.category, net: l.amount }, cfg, { whtAgent: true }).wht_amount, 0));
      if (wht > maxWht + 0.01) return ctx.json(400, { error: `WHT of ${wht.toFixed(2)} exceeds the statutory maximum of ${maxWht.toFixed(2)} for this invoice (WHT applies to the VAT-exclusive amount at ${cfg.wht.wht_rate_rental}% for hire, ${cfg.wht.wht_rate_services}% services, ${cfg.wht.wht_rate_goods}% goods)` });
    }
    const out = tx(() => {
      const payment_ref = nextNumber('PMT', 'payments', 'payment_ref');
      const when = b.received_on ? b.received_on + ' 12:00:00' : null;
      const r = db.prepare(`INSERT INTO payments (payment_ref, invoice_id, customer_id, amount, wht_amount, wht_credit_note_no, method, received_by, notes, received_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`)
        .run(payment_ref, invoice.id, invoice.customer_id, cash, wht, String(b.wht_credit_note_no || '').trim() || null, method, ctx.user.id, b.notes || null, when);
      const newPaid = r2(invoice.amount_paid + settle);
      const newStatus = newPaid >= invoice.grand_total - 0.005 ? 'paid' : 'partial';
      db.prepare('UPDATE invoices SET amount_paid = ?, wht_credited = ?, status = ? WHERE id = ?').run(newPaid, r2(invoice.wht_credited + wht), newStatus, invoice.id);
      const lines = [];
      if (cash > 0) lines.push({ code: into, debit: cash, credit: 0, description: method === 'cash' ? 'Cash receipt' : 'Bank receipt' });
      if (wht > 0) lines.push({ code: ACC.WHT_RECEIVABLE, debit: wht, credit: 0, description: 'WHT deducted at source by customer' });
      lines.push({ code: ACC.AR, debit: 0, credit: settle, description: `AR settled — ${invoice.invoice_number}` });
      const je = postJournalEntry({ memo: `Payment ${payment_ref} for invoice ${invoice.invoice_number}`, sourceType: 'payment', sourceId: r.lastInsertRowid, createdBy: ctx.user.id, lines, entryDate: b.received_on || today() });
      refreshCustomerBalance(invoice.customer_id);
      logAudit(ctx.user.id, 'payment_recorded', 'payment', r.lastInsertRowid, { payment_ref, cash, wht, into, journal_entry: je.entryNumber }, ctx.ip);
      return { id: r.lastInsertRowid, payment_ref, status: newStatus, balance: r2(invoice.grand_total - newPaid) };
    });
    nrs.pushPaymentStatus(invoice.id, ctx.user.id).catch(() => {});
    ctx.json(201, out);
  });

  router.post('/api/payments/:id/reverse', async (ctx, { id }) => {
    if (!ctx.require('payments.edit')) return;
    if (!ctx.requireCsrf()) return;
    const reason = String(ctx.body.reason || '').trim();
    if (reason.length < 5) return ctx.json(400, { error: 'Please give a reason (at least 5 characters)' });
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    if (!p) return ctx.json(404, { error: 'Payment not found' });
    if (p.reversed_at) return ctx.json(400, { error: 'Payment is already reversed' });
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(p.invoice_id);
    tx(() => {
      for (const e of entriesForSource('payment', Number(id))) reverseEntry(e.id, { memo: `Reversal of ${p.payment_ref}: ${reason}`, createdBy: ctx.user.id, sourceType: 'payment_reversal', sourceId: Number(id) });
      db.prepare("UPDATE payments SET reversed_at = datetime('now'), reversal_reason = ? WHERE id = ?").run(reason, id);
      if (inv) {
        const settle = r2(p.amount + (p.wht_amount || 0));
        const paid = Math.max(0, r2(inv.amount_paid - settle));
        db.prepare('UPDATE invoices SET amount_paid = ?, wht_credited = ?, status = ? WHERE id = ?')
          .run(paid, Math.max(0, r2(inv.wht_credited - (p.wht_amount || 0))), inv.status === 'void' ? 'void' : (paid <= 0.005 ? 'unpaid' : 'partial'), inv.id);
        // A reversed deposit application puts the money back into the deposit held for the booking.
        if (p.method === 'deposit_applied' && inv.agreement_id) db.prepare('UPDATE rental_agreements SET deposit_applied = MAX(0, deposit_applied - ?) WHERE id = ?').run(p.amount, inv.agreement_id);
        refreshCustomerBalance(inv.customer_id);
      }
      logAudit(ctx.user.id, 'payment_reversed', 'payment', Number(id), { payment_ref: p.payment_ref, reason }, ctx.ip);
    });
    ctx.json(200, { ok: true });
  });

  // ---------- EXPENSES (vendor bills — accrual basis) ----------
  router.get('/api/expenses', async (ctx) => {
    if (!ctx.require('expenses.view')) return;
    const { status, from, to, category, vendor } = ctx.query;
    let sql = `SELECT e.*, ROUND(e.amount + e.vat_amount - e.wht_amount, 2) as payable, a.name as gl_name,
                 COALESCE(e.gl_code, '') as gl_code,
                 (SELECT pv.pv_number FROM payment_vouchers pv WHERE pv.linked_expense_id = e.id AND pv.status != 'rejected' ORDER BY pv.id DESC LIMIT 1) as voucher_number
               FROM expenses e LEFT JOIN chart_of_accounts a ON a.code = e.gl_code WHERE 1=1`;
    const params = [];
    if (status === 'unpaid') sql += " AND e.status = 'pending'";
    else if (status) { sql += ' AND e.status = ?'; params.push(status); }
    if (from) { sql += ' AND e.expense_date >= ?'; params.push(from); }
    if (to) { sql += ' AND e.expense_date <= ?'; params.push(to); }
    if (category) { sql += ' AND e.category = ?'; params.push(category); }
    if (vendor) { sql += ' AND e.vendor_name LIKE ?'; params.push(`%${vendor}%`); }
    ctx.json(200, db.prepare(sql + ' ORDER BY e.id DESC').all(...params));
  });

  // `amount` is the VAT-EXCLUSIVE cost. Recording the bill posts it to the ledger straight away (accrual basis, IAS 1):
  //   Dr expense / asset GL (net + any irrecoverable VAT)   Dr 113000 Input VAT (claimable)   Cr 201000 Trade payables (gross)
  // WHT is deducted when the bill is PAID (deduction at source), so it is posted with the payment voucher.
  router.post('/api/expenses', async (ctx) => {
    if (!ctx.require('expenses.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    if (!EXPENSE_CATEGORIES.includes(b.category)) return ctx.json(400, { error: `Category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` });
    const amount = r2(num(b.amount));
    if (!isNum(amount) || amount <= 0) return ctx.json(400, { error: 'Amount (VAT-exclusive) must be greater than zero' });
    if (b.expense_date && !isDate(b.expense_date)) return ctx.json(400, { error: 'Expense date must be YYYY-MM-DD' });
    const cfg = taxlib.taxConfig();
    const vendorTin = String(b.vendor_tin || '').trim();
    if (vendorTin && !taxlib.validTin(vendorTin)) return ctx.json(400, { error: 'Vendor TIN looks invalid — expected 8–14 digits (e.g. 12345678-0001)' });
    if (b.equipment_id && !db.prepare('SELECT id FROM equipment WHERE id = ?').get(b.equipment_id)) return ctx.json(400, { error: 'Unknown equipment' });
    let gl = EXPENSE_GL[b.category];
    if (b.gl_code) {
      const a = getAccountByCode(String(b.gl_code));
      if (!a || a.is_header || !a.is_active || !['expense', 'asset'].includes(a.account_type)) return ctx.json(400, { error: 'GL account must be an active expense or asset posting account' });
      gl = a.code;
    }
    let vat = 0;
    if (b.vat_applies) vat = r2(amount * cfg.vatRate / 100);
    else if (b.vat_amount !== undefined && b.vat_amount !== '') vat = r2(num(b.vat_amount));
    if (!isNum(vat) || vat < 0 || vat > amount) return ctx.json(400, { error: 'VAT amount must be between 0 and the expense amount' });
    let whtRate = 0, wht = 0;
    const kind = b.wht_kind !== undefined ? (b.wht_kind || null) : (b.wht_apply ? EXPENSE_WHT_KIND[b.category] : null);
    if (kind) { whtRate = taxlib.vendorWhtRate(kind, !!vendorTin, cfg); wht = r2(amount * whtRate / 100); }
    else if (b.wht_amount !== undefined && b.wht_amount !== '') wht = r2(num(b.wht_amount));
    if (!isNum(wht) || wht < 0 || wht > amount) return ctx.json(400, { error: 'WHT amount must be between 0 and the expense amount' });
    const date = b.expense_date || today();
    const out = tx(() => {
      const expense_number = nextNumber('EXP', 'expenses', 'expense_number');
      const claimable = cfg.vatRegistered && vat > 0 && !!String(b.vendor_invoice_no || '').trim();
      const claimed = claimable ? vat : 0;
      const r = db.prepare(`INSERT INTO expenses
        (expense_number, category, equipment_id, amount, vat_amount, wht_amount, wht_rate, expense_date, description, vendor_name, vendor_tin, vendor_invoice_no, created_by, gl_code, input_vat_claimed, due_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        expense_number, b.category, b.equipment_id || null, amount, vat, wht, whtRate, date,
        b.description || null, b.vendor_name || null, vendorTin || null, String(b.vendor_invoice_no || '').trim() || null, ctx.user.id, gl, claimed, b.due_date || null);
      const id = Number(r.lastInsertRowid);
      const lines = [{ code: gl, debit: r2(amount + vat - claimed), description: b.description || `${b.category.replace(/_/g, ' ')} — ${b.vendor_name || ''}`.trim() }];
      if (claimed > 0) lines.push({ code: ACC.INPUT_VAT, debit: claimed, description: `Input VAT — ${b.vendor_invoice_no}` });
      lines.push({ code: ACC.AP, credit: r2(amount + vat), description: `Bill ${expense_number} — ${b.vendor_name || 'vendor'}` });
      const je = postJournalEntry({ memo: `Vendor bill ${expense_number}${b.vendor_name ? ' — ' + b.vendor_name : ''}`, sourceType: 'expense', sourceId: id, createdBy: ctx.user.id, lines, entryDate: date });
      logAudit(ctx.user.id, 'expense_created', 'expense', id, { expense_number, amount, vat, wht, gl, journal_entry: je.entryNumber }, ctx.ip);
      return { id, expense_number, payable: r2(amount + vat - wht), vat_amount: vat, wht_amount: wht, wht_rate: whtRate, gl_code: gl };
    });
    ctx.json(201, out);
  });

  router.post('/api/expenses/:id/void', async (ctx, { id }) => {
    if (!ctx.require('expenses.edit')) return;
    if (!ctx.requireCsrf()) return;
    const reason = String(ctx.body.reason || '').trim();
    if (reason.length < 5) return ctx.json(400, { error: 'Give a reason (at least 5 characters)' });
    const ex = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!ex) return ctx.json(404, { error: 'Not found' });
    if (ex.status !== 'pending') return ctx.json(400, { error: `A ${ex.status} expense cannot be voided` });
    const pv = db.prepare("SELECT pv_number FROM payment_vouchers WHERE linked_expense_id = ? AND status IN ('pending','approved')").get(id);
    if (pv) return ctx.json(400, { error: `Voucher ${pv.pv_number} is in progress for this bill — reject it first` });
    tx(() => {
      for (const e of entriesForSource('expense', Number(id))) reverseEntry(e.id, { memo: `Void of ${ex.expense_number}: ${reason}`, createdBy: ctx.user.id, sourceType: 'expense_void', sourceId: Number(id) });
      db.prepare("UPDATE expenses SET status = 'void', description = COALESCE(description,'') || ? WHERE id = ?").run(` [VOID: ${reason}]`, id);
      logAudit(ctx.user.id, 'expense_voided', 'expense', Number(id), { reason }, ctx.ip);
    });
    ctx.json(200, { ok: true });
  });

  // ---------- PAYMENT VOUCHERS (maker-checker) ----------
  router.get('/api/vouchers', async (ctx) => {
    if (!ctx.require('vouchers.view')) return;
    const { status } = ctx.query;
    const rows = db.prepare(`SELECT pv.*, u.full_name as raised_by_name, ex.expense_number,
        (SELECT GROUP_CONCAT(a.level || ':' || COALESCE(au.full_name,'?') || ':' || a.decision, ' | ') FROM pv_approvals a LEFT JOIN users au ON au.id = a.approver_id WHERE a.pv_id = pv.id) as approvals
      FROM payment_vouchers pv LEFT JOIN users u ON u.id = pv.raised_by LEFT JOIN expenses ex ON ex.id = pv.linked_expense_id
      ${status ? 'WHERE pv.status = ?' : ''} ORDER BY pv.id DESC`).all(...(status ? [status] : []));
    const l1 = levelRoles(1), l2 = levelRoles(2);
    ctx.json(200, rows.map(r => ({ ...r, level_roles: r.current_level === 1 ? l1 : l2 })));
  });

  router.post('/api/vouchers', async (ctx) => {
    if (!ctx.require('vouchers.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    let payee = String(b.payee_name || '').trim(), purpose = String(b.purpose || '').trim(), amount = r2(num(b.amount));
    let linked = null; let gl = null;
    if (b.linked_expense_id) {
      linked = db.prepare('SELECT * FROM expenses WHERE id = ?').get(b.linked_expense_id);
      if (!linked) return ctx.json(404, { error: 'Linked expense not found' });
      if (linked.status !== 'pending') return ctx.json(400, { error: `Expense ${linked.expense_number} is already ${linked.status}` });
      const dup = db.prepare("SELECT pv_number FROM payment_vouchers WHERE linked_expense_id = ? AND status IN ('pending','approved','paid')").get(linked.id);
      if (dup) return ctx.json(409, { error: `Expense ${linked.expense_number} already has voucher ${dup.pv_number}` });
      amount = r2(linked.amount + linked.vat_amount - linked.wht_amount); // cash actually paid to the vendor
      payee = payee || linked.vendor_name || 'Vendor';
      purpose = purpose || linked.description || `Payment for ${linked.expense_number}`;
    } else if (b.gl_code) {
      const a = getAccountByCode(String(b.gl_code));
      if (!a || a.is_header || !a.is_active) return ctx.json(400, { error: 'Choose an active posting GL account for this payment' });
      gl = a.code;
    }
    if (!payee || !purpose) return ctx.json(400, { error: 'Payee name and purpose are required' });
    if (!isNum(amount) || amount <= 0) return ctx.json(400, { error: 'Amount must be greater than zero' });
    const payFrom = cashAccount(b.pay_from, ACC.BANK);
    if (!payFrom) return ctx.json(400, { error: 'Pay-from must be a cash or bank account (10xxxx)' });
    const pv_number = nextNumber('PV', 'payment_vouchers', 'pv_number');
    const r = db.prepare(`INSERT INTO payment_vouchers (pv_number, payee_name, purpose, amount, linked_expense_id, raised_by, gl_code, pay_from)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(pv_number, payee, purpose, amount, linked ? linked.id : null, ctx.user.id, gl, payFrom);
    logAudit(ctx.user.id, 'voucher_raised', 'payment_voucher', r.lastInsertRowid, { pv_number, amount }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid, pv_number, amount });
  });

  router.post('/api/vouchers/:id/decide', async (ctx, { id }) => {
    if (!ctx.require('vouchers.approve')) return;
    if (!ctx.requireCsrf()) return;
    const { decision } = ctx.body;
    const comment = String(ctx.body.comment || '').trim();
    if (!['approved', 'rejected'].includes(decision)) return ctx.json(400, { error: 'decision must be approved or rejected' });
    const pv = db.prepare('SELECT * FROM payment_vouchers WHERE id = ?').get(id);
    if (!pv) return ctx.json(404, { error: 'Not found' });
    if (pv.status !== 'pending') return ctx.json(400, { error: 'Voucher already decided' });
    if (pv.raised_by === ctx.user.id) return ctx.json(403, { error: 'You raised this voucher, so you cannot approve or reject it (maker-checker).' });
    const roles = levelRoles(pv.current_level);
    if (!roles.includes(ctx.user.role_name)) return ctx.json(403, { error: `Level ${pv.current_level} approval requires the ${roles.join(' or ')} role` });
    const prior = db.prepare("SELECT approver_id FROM pv_approvals WHERE pv_id = ? AND decision = 'approved'").all(id).map(r => r.approver_id);
    if (prior.includes(ctx.user.id)) return ctx.json(403, { error: 'You already approved an earlier level of this voucher; a different person must give the next approval.' });
    if (decision === 'rejected' && !comment) return ctx.json(400, { error: 'A reason is required to reject a voucher' });
    const payDate = ctx.body.payment_date || today();
    if (!isDate(payDate) || payDate > today()) return ctx.json(400, { error: 'Payment date must be a valid date, not in the future' });

    tx(() => {
      db.prepare(`INSERT INTO pv_approvals (pv_id, level, approver_id, decision, comment, decided_at)
                  VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(id, pv.current_level, ctx.user.id, decision, comment || null);
      if (decision === 'rejected') {
        db.prepare("UPDATE payment_vouchers SET status = 'rejected' WHERE id = ?").run(id);
        return logAudit(ctx.user.id, 'voucher_rejected', 'payment_voucher', Number(id), { comment }, ctx.ip);
      }
      if (pv.current_level < APPROVAL_LEVELS) {
        db.prepare('UPDATE payment_vouchers SET current_level = current_level + 1 WHERE id = ?').run(id);
        return logAudit(ctx.user.id, 'voucher_approved_l1', 'payment_voucher', Number(id), null, ctx.ip);
      }
      // Final approval -> pay and post to the ledger.
      const ex = pv.linked_expense_id ? db.prepare('SELECT * FROM expenses WHERE id = ?').get(pv.linked_expense_id) : null;
      const bank = pv.pay_from || ACC.BANK;
      let lines;
      if (ex) {
        const billed = entriesForSource('expense', ex.id).length > 0 || ex.is_legacy;
        const gross = r2(ex.amount + ex.vat_amount);
        if (billed) {
          // Settle the payable; WHT is withheld from the vendor now and becomes a liability to the NRS until remitted.
          lines = [{ code: ACC.AP, debit: gross, description: `Settle ${ex.expense_number} — ${pv.payee_name}` }];
        } else {
          // Bills captured before v1.3 were never posted to the ledger: recognise expense + input VAT at payment.
          const cfg = taxlib.taxConfig();
          const claimed = cfg.vatRegistered && ex.vat_amount > 0 && ex.vendor_invoice_no ? ex.vat_amount : 0;
          lines = [{ code: ex.gl_code || EXPENSE_GL[ex.category] || ACC.OTHER_EXPENSE, debit: r2(ex.amount + ex.vat_amount - claimed), description: ex.description || pv.purpose }];
          if (claimed > 0) lines.push({ code: ACC.INPUT_VAT, debit: claimed, description: `Input VAT — ${ex.vendor_invoice_no}` });
          db.prepare('UPDATE expenses SET input_vat_claimed = ? WHERE id = ?').run(claimed, ex.id);
        }
        if (ex.wht_amount > 0) lines.push({ code: ACC.WHT_PAYABLE, credit: ex.wht_amount, description: `WHT deducted from ${pv.payee_name} (${ex.wht_rate}%)` });
        lines.push({ code: bank, credit: r2(gross - ex.wht_amount), description: `Payment to ${pv.payee_name}` });
        db.prepare("UPDATE expenses SET status = 'paid' WHERE id = ?").run(ex.id);
      } else {
        lines = [{ code: pv.gl_code || ACC.OTHER_EXPENSE, debit: pv.amount, description: pv.purpose }, { code: bank, credit: pv.amount, description: `Payment to ${pv.payee_name}` }];
      }
      if (ex && payDate < ex.expense_date) throw Object.assign(new Error('Payment date cannot be before the bill date'), { status: 400 });
      const je = postJournalEntry({ memo: `PV ${pv.pv_number} — ${pv.purpose}`, sourceType: 'voucher', sourceId: pv.id, createdBy: ctx.user.id, lines, entryDate: payDate });
      db.prepare("UPDATE payment_vouchers SET status = 'paid' WHERE id = ?").run(id);
      logAudit(ctx.user.id, 'voucher_paid', 'payment_voucher', Number(id), { journal_entry: je.entryNumber }, ctx.ip);
    });
    ctx.json(200, { ok: true });
  });

  // ---------- CORE REPORTS (JSON; exports live under /api/reports/run/:key) ----------
  router.get('/api/reports/trial-balance', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    ctx.json(200, trialBalance(ctx.query.as_of));
  });
  router.get('/api/reports/profit-and-loss', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    ctx.json(200, profitAndLoss(ctx.query.from, ctx.query.to, true));
  });
  router.get('/api/reports/balance-sheet', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    ctx.json(200, balanceSheet(ctx.query.as_of));
  });

  router.get('/api/reports/utilization', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    const rows = db.prepare(`
      SELECT e.id, e.asset_code, e.name, e.status,
        (SELECT COUNT(*) FROM agreement_items ai WHERE ai.equipment_id = e.id AND ai.checkout_at IS NOT NULL) as times_rented,
        (SELECT COALESCE(SUM(ii.amount),0) FROM invoice_items ii JOIN invoices inv ON inv.id = ii.invoice_id AND inv.status != 'void'
           WHERE ii.equipment_id = e.id AND ii.category IN ('rental','fee')) as revenue_estimate
      FROM equipment e ORDER BY times_rented DESC`).all();
    ctx.json(200, rows);
  });

  router.get('/api/reports/tax', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    const month = ctx.query.month || today().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return ctx.json(400, { error: 'month must be YYYY-MM' });
    ctx.json(200, require('../lib/reports').taxReport(month));
  });

  router.get('/api/reports/tax.csv', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    const month = ctx.query.month || today().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return ctx.json(400, { error: 'month must be YYYY-MM' });
    const csv = require('../lib/reports').taxReportCsv(month);
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tax-working-paper-${month}.csv"` });
    ctx.res.end(csv);
  });
};
