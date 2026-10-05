// NRS e-invoicing (fiscalisation) — Merchant Buyer Solution (MBS) integration layer.
//
// How it works in Nigeria (2026): every B2B/B2G invoice must be validated ("cleared") on the NRS MBS before it
// is issued; B2C sales must be reported within 24 hours. Taxpayers do NOT connect to NRS directly — they go through
// an NRS-accredited Access Point Provider (APP) / System Integrator, which exposes a REST API (validate → sign →
// transmit / confirm). Cleared invoices carry an IRN (Invoice Reference Number), a CSID (cryptographic stamp) and a QR code.
//
// This module:
//   * maps a portal invoice to the MBS JSON field set (UBL-derived names used by the MBS API),
//   * pre-validates the mandatory fields locally so problems are fixed before submission,
//   * builds the IRN as  <invoice-no (alphanumeric)>-<Service ID>-<YYYYMMDD>,
//   * submits through the APP in `live` mode (endpoint paths + API key/secret are settings, because each APP
//     publishes its own base URL), or through a built-in `simulator` that mimics the clearance flow for training/testing,
//   * logs every request/response in einvoice_submissions (audit trail), and stores IRN / CSID / QR on the invoice.
const crypto = require('crypto');
const { db, getSettings } = require('./db');
const { logAudit } = require('./auth');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function cfg(s = getSettings()) {
  return {
    mode: ['off', 'simulator', 'live'].includes(s.nrs_mode) ? s.nrs_mode : 'off',
    baseUrl: String(s.nrs_base_url || '').replace(/\/+$/, ''), apiKey: s.nrs_api_key || '', apiSecret: s.nrs_api_secret || '',
    businessId: s.nrs_business_id || '', serviceId: String(s.nrs_service_id || '').trim(),
    autoSubmit: s.nrs_auto_submit === '1', defaultServiceCode: s.nrs_default_service_code || '',
    paths: { validate: s.nrs_path_validate, sign: s.nrs_path_sign, confirm: s.nrs_path_confirm, transmit: s.nrs_path_transmit, update: s.nrs_path_update },
    taxStandard: s.nrs_tax_category_standard || 'STANDARD_VAT', taxOutside: s.nrs_tax_category_outside || 'EXEMPTED',
  };
}

function irnFor(inv, serviceId) {
  const id = String(inv.invoice_number).replace(/[^A-Za-z0-9]/g, '');
  const date = String(inv.issue_date || '').replace(/-/g, '').slice(0, 8);
  return `${id}-${serviceId || 'SERVICE0'}-${date}`;
}

function loadFull(invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) return null;
  const items = db.prepare(`SELECT ii.*, cat.nrs_service_code FROM invoice_items ii LEFT JOIN equipment e ON e.id = ii.equipment_id
                             LEFT JOIN equipment_categories cat ON cat.id = e.category_id WHERE ii.invoice_id = ? ORDER BY ii.id`).all(invoiceId);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customer_id) || {};
  return { inv, items, customer };
}

/** Builds the MBS invoice payload (field names follow the MBS / UBL-derived JSON schema). */
function buildPayload(invoiceId, { creditNote = false } = {}) {
  const data = loadFull(invoiceId); if (!data) return null;
  const { inv, items, customer } = data;
  const s = getSettings(); const c = cfg(s);
  const irn = inv.einvoice_irn || irnFor(inv, c.serviceId);
  const cur = s.currency || 'NGN';
  const subtotals = {};
  for (const l of items) {
    const key = l.vat_rate > 0 ? c.taxStandard : c.taxOutside;
    subtotals[key] = subtotals[key] || { taxable_amount: 0, tax_amount: 0, tax_category: { id: key, percent: l.vat_rate > 0 ? Number(l.vat_rate) : 0 } };
    subtotals[key].taxable_amount = r2(subtotals[key].taxable_amount + l.amount);
    subtotals[key].tax_amount = r2(subtotals[key].tax_amount + l.vat_amount);
  }
  const party = (o) => ({
    party_name: o.name, tin: o.tin || '', email: o.email || '', telephone: o.phone ? String(o.phone).replace(/\s+/g, '') : '',
    business_description: o.description || '',
    postal_address: { street_name: o.street || '', city_name: o.city || '', postal_zone: o.postal || '', state: o.state || '', country: o.country || 'NG' },
  });
  const issueTime = (inv.created_at || '').slice(11, 19) || '09:00:00';
  return {
    business_id: c.businessId,
    irn,
    issue_date: inv.issue_date,
    issue_time: issueTime,
    due_date: inv.due_date,
    invoice_type_code: creditNote ? '381' : '380',
    payment_status: inv.status === 'paid' ? 'PAID' : inv.status === 'partial' ? 'PARTIAL' : 'PENDING',
    note: inv.invoice_kind === 'cancellation' ? 'Cancellation fee' : undefined,
    tax_point_date: inv.supply_date || inv.issue_date,
    document_currency_code: cur,
    tax_currency_code: cur,
    transaction_model: inv.transaction_model,
    billing_reference: creditNote ? [{ irn: inv.einvoice_irn, issue_date: inv.issue_date }] : undefined,
    accounting_supplier_party: party({
      name: s.company_name, tin: inv.supplier_tin || s.company_tin, email: s.company_email, phone: s.company_phone,
      description: s.nrs_supplier_business_description, street: s.company_address, city: s.nrs_supplier_city, postal: s.nrs_supplier_postal_zone, state: s.nrs_supplier_state,
    }),
    accounting_customer_party: party({
      name: customer.company_name || customer.full_name, tin: inv.customer_tin || customer.tin, email: customer.email, phone: customer.phone,
      description: customer.business_description || (customer.customer_type === 'company' ? 'Corporate customer' : 'Individual'),
      street: customer.address, city: customer.city, state: customer.state, country: customer.country || 'NG',
    }),
    invoice_line: items.map((l) => ({
      hsn_code: l.nrs_service_code || c.defaultServiceCode || '',
      product_category: { rental: 'Equipment rental', fee: 'Rental ancillary charges', service: 'Technical services', goods: 'Goods', recovery: 'Loss / damage compensation' }[l.category] || 'Services',
      invoiced_quantity: Number(l.quantity || 1),
      line_extension_amount: r2(l.amount),
      item: { name: String(l.description).slice(0, 120), description: l.description, sellers_item_identification: l.equipment_id ? `EQ-${l.equipment_id}` : (l.gl_code || '') },
      price: { price_amount: r2(l.unit_price != null ? l.unit_price : l.amount), base_quantity: 1, price_unit: `${cur} per 1` },
      tax_total: [{ tax_amount: r2(l.vat_amount), tax_subtotal: [{ taxable_amount: r2(l.amount), tax_amount: r2(l.vat_amount), tax_category: { id: l.vat_rate > 0 ? c.taxStandard : c.taxOutside, percent: Number(l.vat_rate) } }] }],
    })),
    tax_total: [{ tax_amount: r2(inv.vat_total), tax_subtotal: Object.values(subtotals) }],
    legal_monetary_total: {
      line_extension_amount: r2(inv.subtotal), tax_exclusive_amount: r2(inv.subtotal),
      tax_inclusive_amount: r2(inv.grand_total), payable_amount: r2(inv.grand_total),
    },
  };
}

/** Local pre-validation of the mandatory fields. Returns { ok, errors[], warnings[] }. */
function validateLocal(invoiceId) {
  const data = loadFull(invoiceId); if (!data) return { ok: false, errors: ['Invoice not found'], warnings: [] };
  const { inv, items, customer } = data; const s = getSettings(); const c = cfg(s);
  const errors = [], warnings = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(inv.status !== 'void', 'A void invoice cannot be submitted');
  need(!inv.is_legacy, 'Legacy (migrated) invoices were issued in the previous system and are not submitted');
  need(c.serviceId && /^[A-Za-z0-9]{8}$/.test(c.serviceId), 'NRS Service ID (8 characters, from your NRS dashboard) is not set — Admin → NRS e-invoicing');
  need(c.businessId, 'NRS Business ID is not set — Admin → NRS e-invoicing');
  need(s.company_name, 'Supplier (company) name is missing');
  need(inv.supplier_tin || s.company_tin, 'Supplier TIN is missing — Admin → Tax');
  need(s.company_address, 'Supplier street address is missing — Admin → Company');
  need(s.nrs_supplier_city && s.nrs_supplier_state, 'Supplier city and state are missing — Admin → NRS e-invoicing');
  need(s.company_email || s.company_phone, 'Supplier email or telephone is required');
  need(customer.full_name || customer.company_name, 'Buyer name is missing');
  if (inv.transaction_model !== 'B2C') {
    need(inv.customer_tin || customer.tin, `Buyer TIN is required for ${inv.transaction_model} invoices — edit the customer`);
    need(customer.address, 'Buyer street address is required for B2B/B2G invoices — edit the customer');
    if (!customer.city || !customer.state) warnings.push('Buyer city/state not set — recommended for the postal address block');
  }
  need(items.length > 0, 'Invoice has no lines');
  if (items.some(l => !(l.nrs_service_code || c.defaultServiceCode))) warnings.push('Some lines have no NRS service/HSN code — set a default code (Admin → NRS) or one per equipment category');
  const lineSum = r2(items.reduce((a, l) => a + l.amount, 0)), vatSum = r2(items.reduce((a, l) => a + l.vat_amount, 0));
  need(Math.abs(lineSum - inv.subtotal) < 0.011, `Line totals (${lineSum}) do not equal the invoice subtotal (${inv.subtotal})`);
  need(Math.abs(vatSum - inv.vat_total) < 0.011, `Line VAT (${vatSum}) does not equal the invoice VAT (${inv.vat_total})`);
  need(Math.abs(r2(inv.subtotal + inv.vat_total) - inv.grand_total) < 0.011, 'Invoice total is not net + VAT');
  return { ok: errors.length === 0, errors, warnings };
}

function logSubmission(invoiceId, action, mode, status, { http, request, response, error, userId } = {}) {
  db.prepare(`INSERT INTO einvoice_submissions (invoice_id, action, mode, status, http_status, request_json, response_json, error, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(invoiceId, action, mode, status, http || null,
    request ? JSON.stringify(request).slice(0, 200000) : null, response ? JSON.stringify(response).slice(0, 200000) : null, error || null, userId || null);
}

async function callApp(c, method, pathTpl, irn, body) {
  if (!c.baseUrl) throw new Error('NRS / Access Point Provider base URL is not set');
  const url = c.baseUrl + String(pathTpl || '').replace('{irn}', encodeURIComponent(irn || ''));
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { method, signal: ctl.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': c.apiKey, 'x-api-secret': c.apiSecret }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 2000) }; }
    return { ok: res.ok, status: res.status, json };
  } finally { clearTimeout(timer); }
}

// Pull IRN / CSID / QR out of an APP response whatever its exact envelope.
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) if (obj[k]) return obj[k];
  for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const f = pick(v, keys); if (f) return f; } }
  return null;
}

/** Validate + sign (clear) an invoice. Returns { ok, status, irn, csid, errors }. */
async function submitInvoice(invoiceId, userId, { creditNote = false } = {}) {
  const c = cfg();
  if (c.mode === 'off') return { ok: false, errors: ['E-invoicing is switched off — Admin → NRS e-invoicing'] };
  const pre = validateLocal(invoiceId);
  if (!pre.ok && !creditNote) {
    db.prepare("UPDATE invoices SET einvoice_status = 'rejected', einvoice_error = ? WHERE id = ?").run(pre.errors.join('; '), invoiceId);
    logSubmission(invoiceId, 'prevalidate', c.mode, 'rejected', { error: pre.errors.join('; '), userId });
    return { ok: false, status: 'rejected', errors: pre.errors, warnings: pre.warnings };
  }
  const payload = buildPayload(invoiceId, { creditNote });
  const now = new Date().toISOString();
  if (c.mode === 'simulator') {
    const csid = crypto.createHash('sha256').update(payload.irn + now + (c.serviceId || '')).digest('base64').slice(0, 44);
    const qr = Buffer.from(JSON.stringify({ irn: payload.irn, csid: csid.slice(0, 16), ts: now, sim: true })).toString('base64');
    logSubmission(invoiceId, creditNote ? 'credit_note' : 'validate', 'simulator', 'ok', { http: 200, request: payload, response: { code: 200, message: 'Invoice validated (simulated)' }, userId });
    logSubmission(invoiceId, 'sign', 'simulator', 'ok', { http: 200, response: { irn: payload.irn, csid, qr_code: qr }, userId });
    if (!creditNote) {
      db.prepare(`UPDATE invoices SET einvoice_status = 'cleared', einvoice_irn = ?, einvoice_csid = ?, einvoice_qr = ?, einvoice_submitted_at = ?, einvoice_cleared_at = ?, einvoice_error = NULL WHERE id = ?`)
        .run(payload.irn, csid, qr, now, now, invoiceId);
    }
    logAudit(userId, creditNote ? 'einvoice_credit_note_cleared' : 'einvoice_cleared', 'invoice', invoiceId, { irn: payload.irn, mode: 'simulator' });
    return { ok: true, status: 'cleared', irn: payload.irn, csid, warnings: pre.warnings };
  }
  // ---- live (through the Access Point Provider) ----
  try {
    db.prepare("UPDATE invoices SET einvoice_status = 'submitted', einvoice_submitted_at = ? WHERE id = ?").run(now, invoiceId);
    const v = await callApp(c, 'POST', c.paths.validate, payload.irn, payload);
    logSubmission(invoiceId, creditNote ? 'credit_note' : 'validate', 'live', v.ok ? 'ok' : 'rejected', { http: v.status, request: payload, response: v.json, userId });
    if (!v.ok) {
      const msg = pick(v.json, ['message', 'error', 'errors', 'detail']) || `HTTP ${v.status}`;
      db.prepare("UPDATE invoices SET einvoice_status = 'rejected', einvoice_error = ? WHERE id = ?").run(typeof msg === 'string' ? msg : JSON.stringify(msg), invoiceId);
      return { ok: false, status: 'rejected', errors: [typeof msg === 'string' ? msg : JSON.stringify(msg)] };
    }
    const sgn = await callApp(c, 'POST', c.paths.sign, payload.irn, payload);
    logSubmission(invoiceId, 'sign', 'live', sgn.ok ? 'ok' : 'rejected', { http: sgn.status, response: sgn.json, userId });
    if (!sgn.ok) {
      const msg = pick(sgn.json, ['message', 'error', 'errors', 'detail']) || `HTTP ${sgn.status}`;
      db.prepare("UPDATE invoices SET einvoice_status = 'rejected', einvoice_error = ? WHERE id = ?").run(typeof msg === 'string' ? msg : JSON.stringify(msg), invoiceId);
      return { ok: false, status: 'rejected', errors: [String(typeof msg === 'string' ? msg : JSON.stringify(msg))] };
    }
    const irn = pick(sgn.json, ['irn', 'IRN']) || payload.irn;
    const csid = pick(sgn.json, ['csid', 'CSID', 'cryptographic_stamp']) || null;
    const qr = pick(sgn.json, ['qr_code', 'qrCode', 'qr', 'encrypted_data']) || null;
    if (!creditNote) db.prepare(`UPDATE invoices SET einvoice_status = 'cleared', einvoice_irn = ?, einvoice_csid = ?, einvoice_qr = ?, einvoice_cleared_at = ?, einvoice_error = NULL WHERE id = ?`).run(irn, csid, qr, new Date().toISOString(), invoiceId);
    try { const t = await callApp(c, 'POST', c.paths.transmit, irn); logSubmission(invoiceId, 'transmit', 'live', t.ok ? 'ok' : 'warning', { http: t.status, response: t.json, userId }); } catch (e) { logSubmission(invoiceId, 'transmit', 'live', 'warning', { error: e.message, userId }); }
    logAudit(userId, 'einvoice_cleared', 'invoice', invoiceId, { irn, mode: 'live' });
    return { ok: true, status: 'cleared', irn, csid, warnings: pre.warnings };
  } catch (e) {
    db.prepare("UPDATE invoices SET einvoice_status = 'not_submitted', einvoice_error = ? WHERE id = ?").run('Could not reach the Access Point Provider: ' + e.message, invoiceId);
    logSubmission(invoiceId, 'validate', 'live', 'error', { error: e.message, userId });
    return { ok: false, status: 'not_submitted', errors: ['Could not reach the Access Point Provider: ' + e.message + '. It stays queued — retry from Billing → E-invoice queue.'] };
  }
}

async function confirmInvoice(invoiceId, userId) {
  const c = cfg(); const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv || !inv.einvoice_irn) return { ok: false, errors: ['Invoice has no IRN yet'] };
  if (c.mode === 'simulator') { logSubmission(invoiceId, 'confirm', 'simulator', 'ok', { http: 200, response: { irn: inv.einvoice_irn, status: 'TRANSMITTED' }, userId }); return { ok: true, status: 'TRANSMITTED (simulated)' }; }
  if (c.mode !== 'live') return { ok: false, errors: ['E-invoicing is switched off'] };
  try { const r = await callApp(c, 'GET', c.paths.confirm, inv.einvoice_irn); logSubmission(invoiceId, 'confirm', 'live', r.ok ? 'ok' : 'error', { http: r.status, response: r.json, userId }); return { ok: r.ok, status: pick(r.json, ['status', 'message']) || r.status }; }
  catch (e) { logSubmission(invoiceId, 'confirm', 'live', 'error', { error: e.message, userId }); return { ok: false, errors: [e.message] }; }
}

// Best-effort payment-status update after a receipt (MBS lets the supplier mark an invoice PAID/PARTIAL).
async function pushPaymentStatus(invoiceId, userId) {
  const c = cfg(); const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv || inv.einvoice_status !== 'cleared' || c.mode === 'off') return;
  const body = { payment_status: inv.status === 'paid' ? 'PAID' : inv.status === 'partial' ? 'PARTIAL' : 'PENDING', reference: inv.invoice_number };
  if (c.mode === 'simulator') return logSubmission(invoiceId, 'update_payment', 'simulator', 'ok', { http: 200, request: body, response: { ok: true }, userId });
  try { const r = await callApp(c, 'PATCH', c.paths.update, inv.einvoice_irn, body); logSubmission(invoiceId, 'update_payment', 'live', r.ok ? 'ok' : 'warning', { http: r.status, request: body, response: r.json, userId }); }
  catch (e) { logSubmission(invoiceId, 'update_payment', 'live', 'warning', { error: e.message, userId }); }
}

async function testConnection() {
  const c = cfg();
  if (c.mode === 'simulator') return { ok: true, message: 'Simulator mode — no external call made. Switch to Live and enter your APP details to test a real connection.' };
  if (c.mode !== 'live') return { ok: false, message: 'E-invoicing is off' };
  try { const r = await callApp(c, 'GET', String(c.paths.confirm || '/').replace('{irn}', 'CONNECTION-TEST'), ''); return { ok: r.status < 500 && r.status !== 401 && r.status !== 403, message: `APP answered HTTP ${r.status}${r.status === 401 || r.status === 403 ? ' — check the API key / secret' : ''}` }; }
  catch (e) { return { ok: false, message: 'Could not reach the APP: ' + e.message }; }
}

module.exports = { cfg, irnFor, buildPayload, validateLocal, submitInvoice, confirmInvoice, pushPaymentStatus, testConnection };
