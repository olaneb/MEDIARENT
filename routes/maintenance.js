const { db } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { nextNumber, postJournalEntry } = require('../lib/ledger');
const { tx } = require('../lib/db');
const assets = require('../lib/assets');
const { ACC } = require('../lib/coa');

module.exports = function (router) {
  // ---------- SCHEDULES ----------
  router.get('/api/maintenance/schedules', async (ctx) => {
    if (!ctx.require('maintenance.view')) return;
    ctx.json(200, db.prepare(`
      SELECT ms.*, e.name as equipment_name, e.asset_code FROM maintenance_schedules ms
      JOIN equipment e ON e.id = ms.equipment_id ORDER BY ms.next_due_date ASC`).all());
  });

  router.post('/api/maintenance/schedules', async (ctx) => {
    if (!ctx.require('maintenance.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    if (!db.prepare('SELECT id FROM equipment WHERE id = ?').get(b.equipment_id)) return ctx.json(400, { error: 'Select a valid piece of equipment' });
    const r = db.prepare(`INSERT INTO maintenance_schedules (equipment_id, schedule_type, interval_days, last_service_date, next_due_date, notes)
                           VALUES (?, ?, ?, ?, ?, ?)`)
      .run(b.equipment_id, b.schedule_type || 'time_based', b.interval_days || null, b.last_service_date || null, b.next_due_date || null, b.notes || null);
    ctx.json(201, { id: r.lastInsertRowid });
  });

  router.get('/api/maintenance/due', async (ctx) => {
    if (!ctx.require('maintenance.view')) return;
    ctx.json(200, db.prepare(`
      SELECT ms.*, e.name as equipment_name, e.asset_code FROM maintenance_schedules ms
      JOIN equipment e ON e.id = ms.equipment_id
      WHERE ms.next_due_date <= date('now', '+7 days') ORDER BY ms.next_due_date ASC`).all());
  });

  // ---------- WORK ORDERS ----------
  router.get('/api/maintenance/work-orders', async (ctx) => {
    if (!ctx.require('maintenance.view')) return;
    const { status } = ctx.query;
    let sql = `SELECT wo.*, e.name as equipment_name, e.asset_code, u.full_name as assigned_to_name
               FROM work_orders wo JOIN equipment e ON e.id = wo.equipment_id
               LEFT JOIN users u ON u.id = wo.assigned_to WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND wo.status = ?'; params.push(status); }
    sql += ' ORDER BY wo.opened_at DESC';
    ctx.json(200, db.prepare(sql).all(...params));
  });

  router.post('/api/maintenance/work-orders', async (ctx) => {
    if (!ctx.require('maintenance.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    const eq = db.prepare('SELECT id, status FROM equipment WHERE id = ?').get(b.equipment_id);
    if (!eq) return ctx.json(400, { error: 'Select a valid piece of equipment' });
    if (!['preventive', 'corrective', 'inspection', undefined].includes(b.wo_type)) return ctx.json(400, { error: 'Invalid work order type' });
    const wo_number = nextNumber('WO', 'work_orders', 'wo_number');
    const r = db.prepare(`INSERT INTO work_orders (wo_number, equipment_id, wo_type, priority, description, assigned_to)
                           VALUES (?, ?, ?, ?, ?, ?)`)
      .run(wo_number, b.equipment_id, b.wo_type || 'corrective', b.priority || 'normal', b.description || null, b.assigned_to || null);
    // Never yank a unit that is out with a customer; it goes to maintenance when it comes back.
    if (['available', 'reserved'].includes(eq.status)) db.prepare(`UPDATE equipment SET status = 'maintenance' WHERE id = ?`).run(b.equipment_id);
    logAudit(ctx.user.id, 'work_order_opened', 'work_order', r.lastInsertRowid, { wo_number }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid, wo_number });
  });

  router.post('/api/maintenance/work-orders/:id/parts', async (ctx, { id }) => {
    if (!ctx.require('maintenance.edit')) return;
    if (!ctx.requireCsrf()) return;
    const { part_id } = ctx.body;
    const qty_used = Number(ctx.body.qty_used);
    if (!Number.isInteger(qty_used) || qty_used <= 0) return ctx.json(400, { error: 'Quantity used must be a whole number greater than zero' });
    const woChk = db.prepare('SELECT status FROM work_orders WHERE id = ?').get(id);
    if (!woChk) return ctx.json(404, { error: 'Work order not found' });
    if (['completed', 'cancelled'].includes(woChk.status)) return ctx.json(400, { error: `Work order is ${woChk.status}` });
    const part = db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(part_id);
    if (!part) return ctx.json(404, { error: 'Part not found' });
    if (part.quantity_on_hand < qty_used) return ctx.json(400, { error: 'Insufficient stock' });
    db.prepare('INSERT INTO work_order_parts (work_order_id, part_id, qty_used, unit_cost) VALUES (?, ?, ?, ?)')
      .run(id, part_id, qty_used, part.unit_cost);
    db.prepare('UPDATE spare_parts SET quantity_on_hand = quantity_on_hand - ? WHERE id = ?').run(qty_used, part_id);
    db.prepare('UPDATE work_orders SET parts_cost = parts_cost + ? WHERE id = ?').run(qty_used * part.unit_cost, id);
    ctx.json(200, { ok: true });
  });

  router.put('/api/maintenance/work-orders/:id/complete', async (ctx, { id }) => {
    if (!ctx.require('maintenance.edit')) return;
    if (!ctx.requireCsrf()) return;
    const { return_to_available } = ctx.body;
    const labor_cost = ctx.body.labor_cost === undefined || ctx.body.labor_cost === '' ? 0 : Number(ctx.body.labor_cost);
    if (!Number.isFinite(labor_cost) || labor_cost < 0) return ctx.json(400, { error: 'Labour cost must be zero or positive' });
    const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
    if (!wo) return ctx.json(404, { error: 'Not found' });
    if (wo.status === 'completed') return ctx.json(400, { error: 'Work order is already completed' });
    const eqRow = db.prepare('SELECT asset_code, name FROM equipment WHERE id = ?').get(wo.equipment_id);
    const out = tx(() => {
      db.prepare(`UPDATE work_orders SET status = 'completed', completed_at = datetime('now'), labor_cost = ? WHERE id = ?`).run(labor_cost || 0, id);
      if (return_to_available !== false) db.prepare(`UPDATE equipment SET status = 'available' WHERE id = ? AND status = 'maintenance'`).run(wo.equipment_id);
      // Parts came out of stock already paid for: Dr repairs / Cr spare-parts inventory (no second cash payment).
      if (wo.parts_cost > 0) postJournalEntry({ memo: `Parts used on ${wo.wo_number} (${eqRow.asset_code})`, sourceType: 'stock_issue', sourceId: Number(id), createdBy: ctx.user.id,
        lines: [{ code: ACC.REPAIRS, debit: wo.parts_cost, description: `Spare parts — ${eqRow.name}` }, { code: ACC.SPARES_INVENTORY, credit: wo.parts_cost, description: 'Parts issued from stock' }] });
      // Labour by an outside technician becomes a vendor bill, paid through a voucher.
      let bill = null;
      if (labor_cost > 0) {
        bill = assets.recordBill({ category: 'repairs', gl: ACC.REPAIRS, amount: labor_cost, vatApplies: !!ctx.body.vat_applies, vendorName: ctx.body.vendor_name || 'Repair technician',
          vendorTin: ctx.body.vendor_tin, vendorInvoiceNo: ctx.body.vendor_invoice_no, description: `Work order ${wo.wo_number} labour — ${eqRow.name}`, equipmentId: wo.equipment_id, userId: ctx.user.id, whtKind: ctx.body.wht_apply === false ? null : 'services' });
        db.prepare('UPDATE work_orders SET linked_expense_id = ? WHERE id = ?').run(bill.id, id);
      }
      return { bill };
    });
    const totalCost = (labor_cost || 0) + wo.parts_cost;
    logAudit(ctx.user.id, 'work_order_completed', 'work_order', id, { totalCost, bill: out.bill && out.bill.expense_number }, ctx.ip);
    ctx.json(200, { ok: true, bill: out.bill });
  });

  // ---------- SPARE PARTS ----------
  router.get('/api/maintenance/parts', async (ctx) => {
    if (!ctx.require('maintenance.view')) return;
    ctx.json(200, db.prepare('SELECT * FROM spare_parts ORDER BY name').all());
  });

  router.post('/api/maintenance/parts', async (ctx) => {
    if (!ctx.require('maintenance.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    if (!String(b.part_code || '').trim() || !String(b.name || '').trim()) return ctx.json(400, { error: 'Part code and name are required' });
    if (db.prepare('SELECT id FROM spare_parts WHERE part_code = ?').get(b.part_code)) return ctx.json(409, { error: `Part code ${b.part_code} already exists` });
    const out = tx(() => {
      const r = db.prepare(`INSERT INTO spare_parts (part_code, name, quantity_on_hand, reorder_level, unit_cost)
                             VALUES (?, ?, ?, ?, ?)`)
        .run(b.part_code, b.name, b.quantity_on_hand || 0, b.reorder_level || 0, b.unit_cost || 0);
      const value = Number(b.unit_cost || 0) * Number(b.quantity_on_hand || 0);
      if (value > 0) assets.postOpeningStock({ gl: ACC.SPARES_INVENTORY, value, memo: `Opening stock — ${b.part_code} ${b.name}`, userId: ctx.user.id });
      return { id: r.lastInsertRowid };
    });
    ctx.json(201, out);
  });

  router.put('/api/maintenance/parts/:id/restock', async (ctx, { id }) => {
    if (!ctx.require('maintenance.edit')) return;
    if (!ctx.requireCsrf()) return;
    const qty = Number(ctx.body.qty);
    if (!Number.isInteger(qty) || qty <= 0) return ctx.json(400, { error: 'Restock quantity must be a whole number greater than zero' });
    const part = db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(id);
    if (!part) return ctx.json(404, { error: 'Part not found' });
    const out = tx(() => {
      db.prepare('UPDATE spare_parts SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?').run(qty, id);
      let bill = null;
      if (qty * part.unit_cost > 0 && ctx.body.record_bill !== false) bill = assets.recordBill({ category: 'spare_parts', gl: ACC.SPARES_INVENTORY, amount: qty * part.unit_cost, vatApplies: !!ctx.body.vat_applies,
        vendorName: ctx.body.vendor_name || 'Parts supplier', vendorTin: ctx.body.vendor_tin, vendorInvoiceNo: ctx.body.vendor_invoice_no, description: `Restock ${part.name} × ${qty}`, userId: ctx.user.id, whtKind: ctx.body.wht_apply ? 'goods' : null });
      return { ok: true, bill };
    });
    ctx.json(200, out);
  });
};
