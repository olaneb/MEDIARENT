const { db } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { tx } = require('../lib/db');
const assets = require('../lib/assets');
const { ACC } = require('../lib/coa');

module.exports = function (router) {
  router.get('/api/consumables', async (ctx) => {
    if (!ctx.require('consumables.view')) return;
    ctx.json(200, db.prepare('SELECT * FROM rental_consumables ORDER BY name').all());
  });

  router.post('/api/consumables', async (ctx) => {
    if (!ctx.require('consumables.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    if (!String(b.item_code || '').trim() || !String(b.name || '').trim()) return ctx.json(400, { error: 'Item code and name are required' });
    for (const f of ['unit_cost', 'sale_price', 'quantity_on_hand', 'reorder_level']) if (b[f] !== undefined && b[f] !== '' && !(Number(b[f]) >= 0)) return ctx.json(400, { error: `${f.replace(/_/g, ' ')} cannot be negative` });
    if (db.prepare('SELECT id FROM rental_consumables WHERE item_code = ?').get(b.item_code)) return ctx.json(409, { error: `Item code ${b.item_code} already exists` });
    if (b.quantity_on_hand !== undefined && !Number.isInteger(Number(b.quantity_on_hand))) return ctx.json(400, { error: 'Starting stock must be a whole number' });
    const out = tx(() => {
      const r = db.prepare(`INSERT INTO rental_consumables (item_code, name, unit_cost, sale_price, quantity_on_hand, reorder_level, unit, wht_exempt)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(b.item_code, b.name, b.unit_cost || 0, b.sale_price || 0, b.quantity_on_hand || 0, b.reorder_level || 0, b.unit || 'each', b.wht_exempt ? 1 : 0);
      // Starting stock is valued at cost onto the balance sheet (IAS 2) against opening balance equity.
      const value = Number(b.unit_cost || 0) * Number(b.quantity_on_hand || 0);
      if (value > 0 && b.post_opening_stock !== false) assets.postOpeningStock({ gl: ACC.CONSUMABLES_INVENTORY, value, memo: `Opening stock — ${b.item_code} ${b.name}`, userId: ctx.user.id });
      return { id: r.lastInsertRowid };
    });
    ctx.json(201, out);
  });

  router.put('/api/consumables/:id/restock', async (ctx, { id }) => {
    if (!ctx.require('consumables.edit')) return;
    if (!ctx.requireCsrf()) return;
    const qty = Number(ctx.body.qty);
    if (!Number.isInteger(qty) || qty <= 0) return ctx.json(400, { error: 'Restock quantity must be a whole number greater than zero' });
    const item = db.prepare('SELECT * FROM rental_consumables WHERE id = ?').get(id);
    if (!item) return ctx.json(404, { error: 'Not found' });
    const unitCost = ctx.body.unit_cost !== undefined && ctx.body.unit_cost !== '' ? Number(ctx.body.unit_cost) : item.unit_cost;
    if (!(unitCost >= 0)) return ctx.json(400, { error: 'Unit cost must be zero or positive' });
    const out = tx(() => {
      // Weighted-average cost
      const newCost = item.quantity_on_hand + qty > 0 ? Math.round(((item.quantity_on_hand * item.unit_cost) + qty * unitCost) / (item.quantity_on_hand + qty) * 100) / 100 : unitCost;
      db.prepare('UPDATE rental_consumables SET quantity_on_hand = quantity_on_hand + ?, unit_cost = ? WHERE id = ?').run(qty, newCost, id);
      let bill = null;
      if (qty * unitCost > 0 && ctx.body.record_bill !== false) bill = assets.recordBill({ category: 'consumables', gl: ACC.CONSUMABLES_INVENTORY, amount: qty * unitCost, vatApplies: !!ctx.body.vat_applies,
        vendorName: ctx.body.vendor_name || 'Stock supplier', vendorTin: ctx.body.vendor_tin, vendorInvoiceNo: ctx.body.vendor_invoice_no, description: `Restock ${item.name} × ${qty}`, userId: ctx.user.id, whtKind: ctx.body.wht_apply ? 'goods' : null });
      logAudit(ctx.user.id, 'consumable_restocked', 'consumable', Number(id), { qty, unitCost, bill: bill && bill.expense_number }, ctx.ip);
      return { ok: true, bill };
    });
    ctx.json(200, out);
  });

  // Issue consumables against a booking — decrements stock immediately, billed on the next invoice
  router.post('/api/agreements/:agreementId/consumables', async (ctx, { agreementId }) => {
    if (!ctx.require('consumables.edit')) return;
    if (!ctx.requireCsrf()) return;
    const { consumable_id } = ctx.body;
    const qty = Number(ctx.body.qty);
    if (!Number.isInteger(qty) || qty <= 0) return ctx.json(400, { error: 'Quantity must be a whole number greater than zero' });
    const ag = db.prepare('SELECT status FROM rental_agreements WHERE id = ?').get(agreementId);
    if (!ag) return ctx.json(404, { error: 'Booking not found' });
    if (['cancelled', 'returned'].includes(ag.status) && db.prepare("SELECT 1 FROM invoices WHERE agreement_id = ? AND status != 'void'").get(agreementId)) return ctx.json(409, { error: 'This booking is already invoiced — void the invoice before adding consumables' });
    if (ag.status === 'cancelled') return ctx.json(400, { error: 'Booking is cancelled' });
    const item = db.prepare('SELECT * FROM rental_consumables WHERE id = ?').get(consumable_id);
    if (!item) return ctx.json(404, { error: 'Consumable not found' });
    if (item.quantity_on_hand < qty) return ctx.json(400, { error: `Only ${item.quantity_on_hand} in stock` });
    const agr = db.prepare('SELECT agreement_number FROM rental_agreements WHERE id = ?').get(agreementId);
    const out = tx(() => {
      db.prepare('UPDATE rental_consumables SET quantity_on_hand = quantity_on_hand - ? WHERE id = ?').run(qty, consumable_id);
      const r = db.prepare(`INSERT INTO agreement_consumables (agreement_id, consumable_id, qty, unit_price) VALUES (?, ?, ?, ?)`)
        .run(agreementId, consumable_id, qty, item.sale_price);
      assets.postConsumableIssue({ item, qty, agreementNumber: agr.agreement_number, userId: ctx.user.id });
      logAudit(ctx.user.id, 'consumable_issued', 'agreement', agreementId, { consumable: item.name, qty }, ctx.ip);
      return { id: r.lastInsertRowid };
    });
    ctx.json(201, out);
  });

  router.get('/api/agreements/:agreementId/consumables', async (ctx, { agreementId }) => {
    if (!ctx.require('consumables.view')) return;
    ctx.json(200, db.prepare(`
      SELECT ac.*, rc.name, rc.item_code FROM agreement_consumables ac
      JOIN rental_consumables rc ON rc.id = ac.consumable_id WHERE ac.agreement_id = ?`).all(agreementId));
  });

  // Crew/labor booked against a production
  router.post('/api/agreements/:agreementId/crew', async (ctx, { agreementId }) => {
    if (!ctx.require('rentals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body; // { crew_name, role, day_rate, days, notes }
    const ag = db.prepare('SELECT status FROM rental_agreements WHERE id = ?').get(agreementId);
    if (!ag) return ctx.json(404, { error: 'Booking not found' });
    if (ag.status === 'cancelled') return ctx.json(400, { error: 'Booking is cancelled' });
    if (db.prepare("SELECT 1 FROM invoices WHERE agreement_id = ? AND status != 'void'").get(agreementId)) return ctx.json(409, { error: 'This booking is already invoiced — void the invoice before adding crew' });
    if (b.crew_role_id) {
      const cr = db.prepare('SELECT * FROM crew_rate_card WHERE id = ?').get(b.crew_role_id);
      if (!cr) return ctx.json(400, { error: 'Unknown crew role' });
      b.role = b.role || cr.role;
      if (b.day_rate === undefined || b.day_rate === '' || Number(b.day_rate) === 0) { if (cr.rate_on_request) return ctx.json(400, { error: `${cr.role} is "rate on request" — enter the agreed day rate` }); b.day_rate = cr.day_rate; }
    }
    if (!String(b.crew_name || '').trim()) return ctx.json(400, { error: 'Crew member name is required' });
    if (!(Number(b.day_rate) >= 0) || !(Number(b.days || 1) > 0)) return ctx.json(400, { error: 'Day rate must be ≥ 0 and days must be greater than zero' });
    const r = db.prepare(`INSERT INTO agreement_crew (agreement_id, crew_name, role, day_rate, days, notes, crew_role_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(agreementId, b.crew_name, b.role || null, b.day_rate || 0, b.days || 1, b.notes || null, b.crew_role_id || null);
    ctx.json(201, { id: r.lastInsertRowid });
  });

  router.get('/api/agreements/:agreementId/crew', async (ctx, { agreementId }) => {
    if (!ctx.require('rentals.view')) return;
    ctx.json(200, db.prepare('SELECT * FROM agreement_crew WHERE agreement_id = ?').all(agreementId));
  });
};
