const { db } = require('../lib/db');
const { logAudit } = require('../lib/auth');

function genKitCode() {
  const m = db.prepare("SELECT MAX(CAST(SUBSTR(kit_code, 5) AS INTEGER)) as m FROM kits WHERE kit_code LIKE 'KIT-%'").get().m || 0;
  return 'KIT-' + String(m + 1).padStart(3, '0');
}
function badEquip(ids) {
  if (new Set(ids).size !== ids.length) return 'The same unit is listed twice in the kit';
  for (const e of ids) if (!db.prepare('SELECT id FROM equipment WHERE id = ?').get(e)) return `Equipment #${e} does not exist`;
  return null;
}

module.exports = function (router) {
  router.get('/api/kits', async (ctx) => {
    if (!ctx.require('kits.view')) return;
    const kits = db.prepare('SELECT * FROM kits ORDER BY name').all();
    const itemCount = db.prepare('SELECT kit_id, COUNT(*) as c FROM kit_items GROUP BY kit_id').all();
    const countMap = {}; itemCount.forEach(r => countMap[r.kit_id] = r.c);
    ctx.json(200, kits.map(k => ({ ...k, item_count: countMap[k.id] || 0 })));
  });

  router.get('/api/kits/:id', async (ctx, { id }) => {
    if (!ctx.require('kits.view')) return;
    const kit = db.prepare('SELECT * FROM kits WHERE id = ?').get(id);
    if (!kit) return ctx.json(404, { error: 'Not found' });
    const items = db.prepare(`
      SELECT ki.id as kit_item_id, e.id as equipment_id, e.asset_code, e.name, e.status, e.daily_rate
      FROM kit_items ki JOIN equipment e ON e.id = ki.equipment_id WHERE ki.kit_id = ?`).all(id);
    ctx.json(200, { ...kit, items });
  });

  // Availability: a kit is only bookable if every one of its component units is free for the window
  router.get('/api/kits/:id/availability', async (ctx, { id }) => {
    if (!ctx.require('kits.view')) return;
    const { start_date, end_date } = ctx.query;
    if (!start_date || !end_date) return ctx.json(400, { error: 'start_date and end_date required' });
    const items = db.prepare('SELECT equipment_id FROM kit_items WHERE kit_id = ?').all(id);
    const unavailable = [];
    if (end_date < start_date) return ctx.json(400, { error: 'end_date cannot be before start_date' });
    for (const it of items) {
      const st = db.prepare('SELECT asset_code, name, status FROM equipment WHERE id = ?').get(it.equipment_id);
      if (st && ['lost', 'retired'].includes(st.status)) { unavailable.push({ asset_code: st.asset_code, name: st.name, conflicting_agreement: `unit is ${st.status}` }); continue; }
      const conflict = db.prepare(`
        SELECT ra.agreement_number FROM agreement_items ai
        JOIN rental_agreements ra ON ra.id = ai.agreement_id
        WHERE ai.equipment_id = ? AND ra.status NOT IN ('returned','cancelled')
          AND ra.start_date <= ? AND ra.expected_return_date >= ? LIMIT 1`).get(it.equipment_id, end_date, start_date);
      if (conflict) {
        const eq = db.prepare('SELECT asset_code, name FROM equipment WHERE id = ?').get(it.equipment_id);
        unavailable.push({ ...eq, conflicting_agreement: conflict.agreement_number });
      }
    }
    ctx.json(200, { available: unavailable.length === 0, conflicts: unavailable });
  });

  router.post('/api/kits', async (ctx) => {
    if (!ctx.require('kits.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body; // { name, description, daily_rate, weekly_rate, equipment_ids: [] }
    if (!b.name || !Array.isArray(b.equipment_ids) || b.equipment_ids.length === 0)
      return ctx.json(400, { error: 'name and at least one equipment_id are required' });
    for (const f of ['daily_rate', 'weekly_rate']) if (b[f] !== undefined && b[f] !== '' && !(Number(b[f]) >= 0)) return ctx.json(400, { error: `${f.replace(/_/g, ' ')} cannot be negative` });
    const be = badEquip(b.equipment_ids); if (be) return ctx.json(400, { error: be });
    const kit_code = genKitCode();
    const r = db.prepare(`INSERT INTO kits (kit_code, name, description, daily_rate, weekly_rate) VALUES (?, ?, ?, ?, ?)`)
      .run(kit_code, b.name, b.description || null, b.daily_rate || 0, b.weekly_rate || 0);
    const ins = db.prepare('INSERT INTO kit_items (kit_id, equipment_id) VALUES (?, ?)');
    for (const eid of b.equipment_ids) ins.run(r.lastInsertRowid, eid);
    logAudit(ctx.user.id, 'kit_created', 'kit', r.lastInsertRowid, { kit_code, items: b.equipment_ids.length }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid, kit_code });
  });

  router.put('/api/kits/:id', async (ctx, { id }) => {
    if (!ctx.require('kits.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    if (!db.prepare('SELECT id FROM kits WHERE id = ?').get(id)) return ctx.json(404, { error: 'Not found' });
    if (b.status !== undefined && !['active', 'retired'].includes(b.status)) return ctx.json(400, { error: 'status must be active or retired' });
    for (const f of ['daily_rate', 'weekly_rate']) if (b[f] !== undefined && !(Number(b[f]) >= 0)) return ctx.json(400, { error: `${f.replace(/_/g, ' ')} cannot be negative` });
    if (Array.isArray(b.equipment_ids)) { if (!b.equipment_ids.length) return ctx.json(400, { error: 'A kit needs at least one item' }); const be = badEquip(b.equipment_ids); if (be) return ctx.json(400, { error: be }); }
    const fields = ['name', 'description', 'daily_rate', 'weekly_rate', 'status'];
    const sets = fields.filter(f => b[f] !== undefined);
    if (sets.length) db.prepare(`UPDATE kits SET ${sets.map(f => `${f} = ?`).join(', ')} WHERE id = ?`).run(...sets.map(f => b[f]), id);
    if (Array.isArray(b.equipment_ids)) {
      db.prepare('DELETE FROM kit_items WHERE kit_id = ?').run(id);
      const ins = db.prepare('INSERT INTO kit_items (kit_id, equipment_id) VALUES (?, ?)');
      for (const eid of b.equipment_ids) ins.run(id, eid);
    }
    logAudit(ctx.user.id, 'kit_updated', 'kit', id, null, ctx.ip);
    ctx.json(200, { ok: true });
  });
};
