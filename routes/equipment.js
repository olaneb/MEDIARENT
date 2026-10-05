const { db } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { tx } = require('../lib/db');
const assets = require('../lib/assets');
const { postedDepreciation } = require('../lib/reports');

function genAssetCode() {
  const m = db.prepare("SELECT MAX(CAST(SUBSTR(asset_code, 5) AS INTEGER)) as m FROM equipment WHERE asset_code LIKE 'EQP-%'").get().m || 0;
  return 'EQP-' + String(m + 1).padStart(5, '0');
}
const MONEY = ['purchase_cost', 'replacement_value', 'salvage_value', 'daily_rate', 'weekly_rate', 'monthly_rate', 'overtime_hourly_rate', 'late_fee_daily', 'default_deposit', 'opening_accumulated_depreciation'];
const STATUSES = ['available', 'reserved', 'on_rent', 'maintenance', 'lost', 'retired'];
function validateEquip(b, partial) {
  if (!partial && !String(b.name || '').trim()) return 'Name is required';
  if (partial && b.name !== undefined && !String(b.name).trim()) return 'Name cannot be blank';
  for (const f of MONEY) if (b[f] !== undefined && b[f] !== '' && b[f] !== null && !(Number(b[f]) >= 0)) return `${f.replace(/_/g, ' ')} cannot be negative`;
  if (b.useful_life_years !== undefined && !(Number(b.useful_life_years) > 0)) return 'Useful life must be greater than zero';
  if (b.status !== undefined && !STATUSES.includes(b.status)) return 'Invalid status';
  return null;
}

module.exports = function (router) {
  router.get('/api/equipment/categories', async (ctx) => {
    if (!ctx.require('equipment.view')) return;
    ctx.json(200, db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM equipment e WHERE e.category_id = c.id AND e.disposed_at IS NULL) as units FROM equipment_categories c ORDER BY c.sort_order, c.name`).all());
  });

  router.post('/api/equipment/categories', async (ctx) => {
    if (!ctx.require('equipment.edit')) return;
    if (!ctx.requireCsrf()) return;
    const { name, description, prep_checklist } = ctx.body;
    if (!String(name || '').trim()) return ctx.json(400, { error: 'Category name is required' });
    if (db.prepare('SELECT id FROM equipment_categories WHERE name = ?').get(name)) return ctx.json(409, { error: `Category "${name}" already exists` });
    const r = db.prepare('INSERT INTO equipment_categories (name, description, prep_checklist) VALUES (?, ?, ?)')
      .run(name, description || null, JSON.stringify(prep_checklist || []));
    ctx.json(201, { id: r.lastInsertRowid });
  });

  router.put('/api/equipment/categories/:id', async (ctx, { id }) => {
    if (!ctx.require('equipment.edit')) return;
    if (!ctx.requireCsrf()) return;
    const { name, description, prep_checklist, income_gl_code, nrs_service_code, useful_life_years } = ctx.body;
    const sets = [], vals = [];
    if (income_gl_code !== undefined) { if (income_gl_code && !/^4\d{5}$/.test(income_gl_code)) return ctx.json(400, { error: 'Income GL must be a 4xxxxx revenue account' }); sets.push('income_gl_code = ?'); vals.push(income_gl_code || null); }
    if (nrs_service_code !== undefined) { sets.push('nrs_service_code = ?'); vals.push(String(nrs_service_code || '').trim() || null); }
    if (useful_life_years !== undefined) { sets.push('useful_life_years = ?'); vals.push(Number(useful_life_years) || null); }
    if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
    if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
    if (prep_checklist !== undefined) { sets.push('prep_checklist = ?'); vals.push(JSON.stringify(prep_checklist)); }
    if (!sets.length) return ctx.json(400, { error: 'No fields to update' });
    db.prepare(`UPDATE equipment_categories SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    ctx.json(200, { ok: true });
  });

  router.get('/api/equipment', async (ctx) => {
    if (!ctx.require('equipment.view')) return;
    const { status, category_id, q, location_id, include_disposed } = ctx.query;
    let sql = `SELECT e.*, c.name as category_name, l.name as location_name FROM equipment e
               LEFT JOIN equipment_categories c ON c.id = e.category_id LEFT JOIN locations l ON l.id = e.location_id WHERE 1=1`;
    const params = [];
    if (!include_disposed && status !== 'retired') sql += ' AND e.disposed_at IS NULL';
    if (status === 'due_back') sql += " AND e.status = 'on_rent' AND e.id IN (SELECT ai.equipment_id FROM agreement_items ai JOIN rental_agreements ra ON ra.id = ai.agreement_id WHERE ai.checkin_at IS NULL AND ra.expected_return_date <= date('now','+1 day'))";
    else if (status) { sql += ' AND e.status = ?'; params.push(status); }
    if (category_id) { sql += ' AND e.category_id = ?'; params.push(category_id); }
    if (location_id) { sql += ' AND e.location_id = ?'; params.push(location_id); }
    if (q) { sql += ' AND (e.name LIKE ? OR e.asset_code LIKE ? OR e.brand LIKE ? OR e.serial_number LIKE ? OR e.model LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY c.sort_order, c.name, e.name';
    ctx.json(200, db.prepare(sql).all(...params));
  });

  router.get('/api/equipment/:id', async (ctx, { id }) => {
    if (!ctx.require('equipment.view')) return;
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
    if (!eq) return ctx.json(404, { error: 'Not found' });
    const docs = db.prepare('SELECT * FROM equipment_documents WHERE equipment_id = ?').all(id);
    const history = db.prepare(`
      SELECT ra.id as agreement_id, ra.agreement_number, ra.status, ra.start_date, ai.checkout_at, ai.checkin_at, c.full_name as customer_name
      FROM agreement_items ai
      JOIN rental_agreements ra ON ra.id = ai.agreement_id
      JOIN customers c ON c.id = ra.customer_id
      WHERE ai.equipment_id = ? ORDER BY ai.id DESC LIMIT 20`).all(id);
    const dep = postedDepreciation()[eq.id] || 0;
    const acc = Math.round(((eq.opening_accumulated_depreciation || 0) + dep) * 100) / 100;
    const cat = eq.category_id ? db.prepare('SELECT name FROM equipment_categories WHERE id = ?').get(eq.category_id) : null;
    const loc = eq.location_id ? db.prepare('SELECT name FROM locations WHERE id = ?').get(eq.location_id) : null;
    const workOrders = db.prepare('SELECT id, wo_number, wo_type, status, opened_at FROM work_orders WHERE equipment_id = ? ORDER BY id DESC LIMIT 10').all(id);
    const claims = db.prepare('SELECT id, claim_number, status, amount_claimed FROM insurance_claims WHERE equipment_id = ? ORDER BY id DESC').all(id);
    const revenue = db.prepare("SELECT COALESCE(SUM(ii.amount),0) r FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id AND i.status != 'void' WHERE ii.equipment_id = ? AND ii.category IN ('rental','fee')").get(id).r;
    const photos = db.prepare("SELECT id, stage, caption FROM photos WHERE entity_type = 'equipment' AND entity_id = ?").all(id);
    ctx.json(200, { ...eq, category_name: cat && cat.name, location_name: loc && loc.name, documents: docs, rental_history: history, work_orders: workOrders, claims, photos,
      accumulated_depreciation: acc, net_book_value: Math.round((eq.purchase_cost - acc) * 100) / 100, revenue_to_date: revenue });
  });

  router.post('/api/equipment', async (ctx) => {
    if (!ctx.require('equipment.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    const verr = validateEquip(b, false); if (verr) return ctx.json(400, { error: verr });
    const asset_code = b.asset_code || genAssetCode();
    if (db.prepare('SELECT id FROM equipment WHERE asset_code = ?').get(asset_code)) return ctx.json(409, { error: `Asset code ${asset_code} already exists` });
    if (b.capitalise && !['bill', 'cash', 'opening'].includes(b.capitalise)) return ctx.json(400, { error: 'capitalise must be bill, cash or opening' });
    if (b.capitalise && !require('../lib/auth').hasPermission(ctx.user, 'journals.edit')) return ctx.json(403, { error: 'Capitalising an asset needs the journals.edit permission (Finance)' });
    const defLoc = db.prepare('SELECT id, name FROM locations WHERE is_default = 1 ORDER BY id LIMIT 1').get();
    const locId = b.location_id || (defLoc && defLoc.id) || null;
    const out = tx(() => {
      const r = db.prepare(`INSERT INTO equipment
        (asset_code, name, category_id, brand, model, serial_number, year_of_manufacture, spec_sheet, purchase_date,
         purchase_cost, replacement_value, salvage_value, useful_life_years, depreciation_method, condition_grade, status,
         current_location, daily_rate, weekly_rate, monthly_rate, overtime_hourly_rate, late_fee_daily, notes,
         location_id, default_deposit, includes_operator, depreciable, rate_card_ref, opening_accumulated_depreciation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        asset_code, b.name, b.category_id || null, b.brand || null, b.model || null, b.serial_number || null, b.year_of_manufacture || null,
        b.spec_sheet || null, b.purchase_date || null, b.purchase_cost || 0, b.replacement_value || 0, b.salvage_value || 0,
        b.useful_life_years || 5, b.depreciation_method || 'straight_line', b.condition_grade || 'good',
        b.status || 'available', b.current_location || null, b.daily_rate || 0, b.weekly_rate || 0,
        b.monthly_rate || 0, b.overtime_hourly_rate || 0, b.late_fee_daily || 0, b.notes || null,
        locId, b.default_deposit || 0, b.includes_operator ? 1 : 0, b.depreciable === false ? 0 : 1, b.rate_card_ref || null, b.opening_accumulated_depreciation || 0);
      const id = Number(r.lastInsertRowid);
      let cap = null;
      if (b.capitalise && Number(b.purchase_cost) > 0) cap = assets.capitalise(db.prepare('SELECT * FROM equipment WHERE id = ?').get(id), { method: b.capitalise, vendorName: b.vendor_name, vendorTin: b.vendor_tin, vendorInvoiceNo: b.vendor_invoice_no, vatApplies: !!b.vat_applies, date: b.purchase_date, userId: ctx.user.id, ip: ctx.ip });
      logAudit(ctx.user.id, 'equipment_created', 'equipment', id, { asset_code, capitalised: b.capitalise || null }, ctx.ip);
      return { id, asset_code, bill: cap && cap.bill };
    });
    ctx.json(201, out);
  });

  router.put('/api/equipment/:id', async (ctx, { id }) => {
    if (!ctx.require('equipment.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    const fields = ['name', 'category_id', 'brand', 'model', 'serial_number', 'year_of_manufacture', 'spec_sheet', 'purchase_date',
      'purchase_cost', 'replacement_value', 'salvage_value', 'useful_life_years', 'depreciation_method', 'condition_grade', 'status',
      'current_location', 'daily_rate', 'weekly_rate', 'monthly_rate', 'overtime_hourly_rate', 'late_fee_daily', 'notes',
      'default_deposit', 'includes_operator', 'depreciable', 'rate_card_ref'];
    if (b.includes_operator !== undefined) b.includes_operator = b.includes_operator ? 1 : 0;
    if (b.depreciable !== undefined) b.depreciable = b.depreciable ? 1 : 0;
    if (b.status !== undefined && ['on_rent', 'reserved', 'lost'].includes(b.status)) return ctx.json(400, { error: 'Status changes to reserved / on rent / lost happen through bookings and check-in, not by editing' });
    const verr = validateEquip(b, true); if (verr) return ctx.json(400, { error: verr });
    if (!db.prepare('SELECT id FROM equipment WHERE id = ?').get(id)) return ctx.json(404, { error: 'Not found' });
    const sets = fields.filter(f => b[f] !== undefined);
    if (sets.length === 0) return ctx.json(400, { error: 'No fields to update' });
    const sql = `UPDATE equipment SET ${sets.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;
    db.prepare(sql).run(...sets.map(f => b[f]), id);
    logAudit(ctx.user.id, 'equipment_updated', 'equipment', id, { fields: sets }, ctx.ip);
    ctx.json(200, { ok: true });
  });

  router.get('/api/equipment-availability', async (ctx) => {
    if (!ctx.require('equipment.view')) return;
    const { start_date, end_date } = ctx.query;
    if (!start_date || !end_date) return ctx.json(400, { error: 'start_date and end_date required' });
    if (end_date < start_date) return ctx.json(400, { error: 'end_date cannot be before start_date' });
    // Units committed to a live booking overlapping the window. Units still out (active/overdue) stay busy until checked in.
    const booked = db.prepare(`
      SELECT DISTINCT ai.equipment_id FROM agreement_items ai
      JOIN rental_agreements ra ON ra.id = ai.agreement_id
      WHERE ra.status NOT IN ('returned','cancelled') AND ai.checkin_at IS NULL
        AND ra.start_date <= ? AND (ra.expected_return_date >= ? OR ra.status IN ('active','overdue','dispatched'))
    `).all(end_date, start_date).map(r => r.equipment_id);
    const placeholders = booked.length ? booked.map(() => '?').join(',') : '-1'; // NOT IN (NULL) would match nothing
    const available = db.prepare(`SELECT * FROM equipment WHERE status NOT IN ('retired','lost') AND disposed_at IS NULL AND id NOT IN (${placeholders})`).all(...booked);
    ctx.json(200, available);
  });
};
