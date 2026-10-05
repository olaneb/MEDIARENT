const { db } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { validTin } = require('../lib/tax');
const { isValidEmail } = require('../lib/mailer');

function validate(b, partial) {
  if (!partial || b.full_name !== undefined) if (!String(b.full_name || '').trim()) return 'full_name is required';
  if (b.email && !isValidEmail(String(b.email).trim())) return 'Email address is not valid';
  if (b.tin && !validTin(b.tin)) return 'TIN looks invalid — expected 8–14 digits (e.g. 12345678-0001)';
  if (b.credit_limit !== undefined && b.credit_limit !== '' && !(Number(b.credit_limit) >= 0)) return 'Credit limit cannot be negative';
  if (b.customer_type && !['individual', 'company'].includes(b.customer_type)) return 'customer_type must be individual or company';
  return null;
}

module.exports = function (router) {
  router.get('/api/customers', async (ctx) => {
    if (!ctx.require('customers.view')) return;
    const { q } = ctx.query;
    let sql = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    if (q) { sql += ' AND (full_name LIKE ? OR company_name LIKE ? OR phone LIKE ? OR email LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY created_at DESC';
    ctx.json(200, db.prepare(sql).all(...params));
  });

  router.get('/api/customers/:id', async (ctx, { id }) => {
    if (!ctx.require('customers.view')) return;
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) return ctx.json(404, { error: 'Not found' });
    const agreements = db.prepare('SELECT id, agreement_number, status, start_date, expected_return_date FROM rental_agreements WHERE customer_id = ? ORDER BY id DESC').all(id);
    const invoices = db.prepare('SELECT id, invoice_number, grand_total, amount_paid, status, issue_date FROM invoices WHERE customer_id = ? ORDER BY id DESC').all(id);
    ctx.json(200, { ...c, agreements, invoices });
  });

  router.post('/api/customers', async (ctx) => {
    if (!ctx.require('customers.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    const err = validate(b, false); if (err) return ctx.json(400, { error: err });
    const type = b.customer_type || 'individual';
    // Companies and government bodies normally deduct WHT at source; individuals normally do not.
    const whtAgent = b.wht_agent !== undefined ? (b.wht_agent ? 1 : 0) : (type === 'company' ? 1 : 0);
    const r = db.prepare(`INSERT INTO customers
      (customer_type, full_name, company_name, email, phone, address, id_doc_type, id_doc_number, credit_limit, coi_on_file, coi_expiry_date, tin, rc_number, wht_agent, city, state, business_description, is_government)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      type, String(b.full_name).trim(), b.company_name || null, b.email ? String(b.email).trim() : null, b.phone || null,
      b.address || null, b.id_doc_type || null, b.id_doc_number || null, Number(b.credit_limit || 0),
      b.coi_on_file ? 1 : 0, b.coi_expiry_date || null, b.tin ? String(b.tin).trim() : null, b.rc_number || null, whtAgent, b.city || null, b.state || null, b.business_description || null, b.is_government ? 1 : 0);
    logAudit(ctx.user.id, 'customer_created', 'customer', r.lastInsertRowid, null, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid });
  });

  router.put('/api/customers/:id', async (ctx, { id }) => {
    if (!ctx.require('customers.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    const fields = ['customer_type', 'full_name', 'company_name', 'email', 'phone', 'address',
      'id_doc_type', 'id_doc_number', 'credit_limit', 'is_blacklisted', 'blacklist_reason', 'coi_on_file', 'coi_expiry_date', 'tin', 'rc_number', 'wht_agent', 'city', 'state', 'business_description', 'is_government'];
    if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(id)) return ctx.json(404, { error: 'Not found' });
    const err = validate(b, true); if (err) return ctx.json(400, { error: err });
    for (const f of ['is_blacklisted', 'coi_on_file', 'wht_agent', 'is_government']) if (b[f] !== undefined) b[f] = b[f] ? 1 : 0;
    const sets = fields.filter(f => b[f] !== undefined);
    if (sets.length === 0) return ctx.json(400, { error: 'No fields to update' });
    db.prepare(`UPDATE customers SET ${sets.map(f => `${f} = ?`).join(', ')} WHERE id = ?`).run(...sets.map(f => b[f]), id);
    logAudit(ctx.user.id, 'customer_updated', 'customer', id, { fields: sets }, ctx.ip);
    ctx.json(200, { ok: true });
  });
};
