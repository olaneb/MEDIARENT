// NRS e-invoicing endpoints (validate / submit / confirm / queue / connection test).
const { db, getSettings } = require('../lib/db');
const nrs = require('../lib/nrs');
const { logAudit } = require('../lib/auth');

module.exports = function (router) {
  router.get('/api/einvoice/status', async (ctx) => {
    if (!ctx.require('einvoice.view')) return;
    const s = getSettings(); const c = nrs.cfg(s);
    const counts = {};
    for (const r of db.prepare(`SELECT einvoice_status s, COUNT(*) c FROM invoices WHERE status != 'void' AND is_legacy = 0 GROUP BY einvoice_status`).all()) counts[r.s] = r.c;
    const overdueB2c = db.prepare(`SELECT COUNT(*) c FROM invoices WHERE status != 'void' AND is_legacy = 0 AND transaction_model = 'B2C' AND einvoice_status != 'cleared' AND julianday('now') - julianday(created_at) > 1`).get().c;
    const readiness = [
      ['Mode switched on (simulator or live)', c.mode !== 'off'],
      ['Service ID (8 characters) set', /^[A-Za-z0-9]{8}$/.test(c.serviceId)],
      ['Business ID set', !!c.businessId],
      ['Company TIN set', !!(s.company_tin)],
      ['Company address, city & state set', !!(s.company_address && s.nrs_supplier_city && s.nrs_supplier_state)],
      ['Default NRS service code set', !!c.defaultServiceCode],
      ['Access Point Provider URL & API keys (live mode)', c.mode !== 'live' || !!(c.baseUrl && c.apiKey && c.apiSecret)],
    ].map(([label, ok]) => ({ label, ok }));
    ctx.json(200, { mode: c.mode, app_name: s.nrs_app_name || '', auto_submit: c.autoSubmit, counts, b2c_over_24h: overdueB2c, readiness, ready: readiness.every(r => r.ok) });
  });

  router.post('/api/invoices/:id/einvoice/validate', async (ctx, { id }) => {
    if (!ctx.require('einvoice.view')) return;
    if (!ctx.requireCsrf()) return;
    const check = nrs.validateLocal(Number(id));
    ctx.json(200, { ...check, payload: nrs.buildPayload(Number(id)) });
  });

  router.post('/api/invoices/:id/einvoice/submit', async (ctx, { id }) => {
    if (!ctx.require('einvoice.edit')) return;
    if (!ctx.requireCsrf()) return;
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) return ctx.json(404, { error: 'Invoice not found' });
    if (inv.einvoice_status === 'cleared') return ctx.json(400, { error: `Already cleared — IRN ${inv.einvoice_irn}` });
    const r = await nrs.submitInvoice(Number(id), ctx.user.id);
    ctx.json(r.ok ? 200 : 422, r.ok ? r : { ...r, error: (r.errors || []).join('; ') });
  });

  router.post('/api/invoices/:id/einvoice/confirm', async (ctx, { id }) => {
    if (!ctx.require('einvoice.edit')) return;
    if (!ctx.requireCsrf()) return;
    const r = await nrs.confirmInvoice(Number(id), ctx.user.id);
    ctx.json(r.ok ? 200 : 422, r.ok ? r : { ...r, error: (r.errors || []).join('; ') });
  });

  router.post('/api/einvoice/submit-pending', async (ctx) => {
    if (!ctx.require('einvoice.edit')) return;
    if (!ctx.requireCsrf()) return;
    if (nrs.cfg().mode === 'off') return ctx.json(400, { error: 'E-invoicing is switched off — Admin → NRS e-invoicing' });
    const ids = db.prepare(`SELECT id FROM invoices WHERE status != 'void' AND is_legacy = 0 AND einvoice_status IN ('not_submitted','rejected') ORDER BY id LIMIT 200`).all().map(r => r.id);
    const results = [];
    for (const id of ids) { const r = await nrs.submitInvoice(id, ctx.user.id); results.push({ id, status: r.status, errors: r.errors || [] }); }
    logAudit(ctx.user.id, 'einvoice_batch_submit', 'invoice', null, { count: ids.length, cleared: results.filter(r => r.status === 'cleared').length }, ctx.ip);
    ctx.json(200, { attempted: ids.length, cleared: results.filter(r => r.status === 'cleared').length, failed: results.filter(r => r.status !== 'cleared'), results });
  });

  router.post('/api/einvoice/test-connection', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    if (!ctx.requireCsrf()) return;
    ctx.json(200, await nrs.testConnection());
  });

  router.get('/api/einvoice/submissions', async (ctx) => {
    if (!ctx.require('einvoice.view')) return;
    const id = ctx.query.invoice_id;
    ctx.json(200, db.prepare(`SELECT s.*, i.invoice_number, u.full_name as by_name FROM einvoice_submissions s JOIN invoices i ON i.id = s.invoice_id LEFT JOIN users u ON u.id = s.created_by
      ${id ? 'WHERE s.invoice_id = ?' : ''} ORDER BY s.id DESC LIMIT 200`).all(...(id ? [id] : [])));
  });
};
