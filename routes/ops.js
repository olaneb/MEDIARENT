// Operations extensions: locations & transfers, crew rate card, condition photos, insurance claims,
// fixed-asset actions (capitalise / write-off) and printable / PDF rental agreements.
const { db, tx, getSettings } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { nextNumber, postJournalEntry, round2: r2 } = require('../lib/ledger');
const { ACC } = require('../lib/coa');
const assets = require('../lib/assets');
const { buildPdf } = require('../lib/pdf');
const { getLogo, isHexColor } = require('../lib/branding');

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = 'NGN') => `${cur} ${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PHOTO_PERM = { agreement_item: ['rentals.view', 'dispatch.edit'], equipment: ['equipment.view', 'equipment.edit'], claim: ['claims.view', 'claims.edit'], work_order: ['maintenance.view', 'maintenance.edit'] };

module.exports = function (router) {
  // ===================== LOCATIONS =====================
  router.get('/api/locations', async (ctx) => {
    if (!ctx.user) return ctx.json(401, { error: 'Not authenticated' });
    ctx.json(200, db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM equipment e WHERE e.location_id = l.id AND e.disposed_at IS NULL) as units,
      (SELECT COUNT(*) FROM equipment e WHERE e.location_id = l.id AND e.status = 'available') as available FROM locations l ORDER BY l.is_default DESC, l.name`).all());
  });
  router.post('/api/locations', async (ctx) => {
    if (!ctx.require('locations.edit')) return;
    if (!ctx.requireCsrf()) return;
    const code = String(ctx.body.code || '').trim().toUpperCase(), name = String(ctx.body.name || '').trim();
    if (!/^[A-Z0-9-]{2,10}$/.test(code) || name.length < 3) return ctx.json(400, { error: 'Code (2–10 letters/digits) and a name are required' });
    if (db.prepare('SELECT 1 FROM locations WHERE code = ?').get(code)) return ctx.json(409, { error: `Location ${code} exists` });
    const r = db.prepare('INSERT INTO locations (code, name, address) VALUES (?, ?, ?)').run(code, name, ctx.body.address || null);
    logAudit(ctx.user.id, 'location_created', 'location', r.lastInsertRowid, { code, name }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid });
  });
  router.put('/api/locations/:id', async (ctx, { id }) => {
    if (!ctx.require('locations.edit')) return;
    if (!ctx.requireCsrf()) return;
    const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(id); if (!l) return ctx.json(404, { error: 'Not found' });
    const b = ctx.body;
    if (b.active === false && db.prepare('SELECT COUNT(*) c FROM equipment WHERE location_id = ? AND disposed_at IS NULL').get(id).c) return ctx.json(400, { error: 'Move the equipment out before deactivating this location' });
    db.prepare('UPDATE locations SET name = COALESCE(?, name), address = COALESCE(?, address), active = COALESCE(?, active) WHERE id = ?').run(b.name || null, b.address || null, b.active === undefined ? null : (b.active ? 1 : 0), id);
    if (b.is_default) { db.exec('UPDATE locations SET is_default = 0'); db.prepare('UPDATE locations SET is_default = 1 WHERE id = ?').run(id); }
    ctx.json(200, { ok: true });
  });
  router.post('/api/equipment/:id/transfer', async (ctx, { id }) => {
    if (!ctx.require('locations.edit')) return;
    if (!ctx.requireCsrf()) return;
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id); if (!eq) return ctx.json(404, { error: 'Equipment not found' });
    const to = db.prepare('SELECT * FROM locations WHERE id = ? AND active = 1').get(ctx.body.to_location_id); if (!to) return ctx.json(400, { error: 'Choose an active destination location' });
    if (eq.location_id === to.id) return ctx.json(400, { error: 'Unit is already at that location' });
    if (['on_rent', 'lost', 'retired'].includes(eq.status)) return ctx.json(400, { error: `A ${eq.status.replace('_', ' ')} unit cannot be transferred` });
    tx(() => {
      db.prepare('INSERT INTO equipment_transfers (equipment_id, from_location_id, to_location_id, notes, transferred_by) VALUES (?, ?, ?, ?, ?)').run(id, eq.location_id, to.id, ctx.body.notes || null, ctx.user.id);
      db.prepare("UPDATE equipment SET location_id = ?, current_location = ?, updated_at = datetime('now') WHERE id = ?").run(to.id, to.name, id);
      logAudit(ctx.user.id, 'equipment_transferred', 'equipment', Number(id), { to: to.code }, ctx.ip);
    });
    ctx.json(200, { ok: true });
  });
  router.get('/api/equipment/:id/transfers', async (ctx, { id }) => {
    if (!ctx.require('equipment.view')) return;
    ctx.json(200, db.prepare(`SELECT t.*, f.name as from_name, l.name as to_name, u.full_name as by_name FROM equipment_transfers t LEFT JOIN locations f ON f.id = t.from_location_id
      JOIN locations l ON l.id = t.to_location_id LEFT JOIN users u ON u.id = t.transferred_by WHERE t.equipment_id = ? ORDER BY t.id DESC`).all(id));
  });

  // ===================== CREW RATE CARD =====================
  router.get('/api/crew-rates', async (ctx) => {
    if (!ctx.user) return ctx.json(401, { error: 'Not authenticated' });
    ctx.json(200, db.prepare('SELECT * FROM crew_rate_card ORDER BY active DESC, role').all());
  });
  router.post('/api/crew-rates', async (ctx) => {
    if (!ctx.require('rentals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const role = String(ctx.body.role || '').trim(); const rate = Number(ctx.body.day_rate || 0);
    if (role.length < 2 || !(rate >= 0)) return ctx.json(400, { error: 'Role and a day rate ≥ 0 are required' });
    const r = db.prepare('INSERT INTO crew_rate_card (role, day_rate, rate_on_request, notes) VALUES (?, ?, ?, ?)').run(role, rate, rate > 0 ? 0 : 1, ctx.body.notes || null);
    ctx.json(201, { id: r.lastInsertRowid });
  });
  router.put('/api/crew-rates/:id', async (ctx, { id }) => {
    if (!ctx.require('rentals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body; if (b.day_rate !== undefined && !(Number(b.day_rate) >= 0)) return ctx.json(400, { error: 'Day rate must be ≥ 0' });
    db.prepare('UPDATE crew_rate_card SET role = COALESCE(?, role), day_rate = COALESCE(?, day_rate), rate_on_request = CASE WHEN ? IS NULL THEN rate_on_request WHEN ? > 0 THEN 0 ELSE 1 END, notes = COALESCE(?, notes), active = COALESCE(?, active) WHERE id = ?')
      .run(b.role || null, b.day_rate === undefined ? null : Number(b.day_rate), b.day_rate === undefined ? null : 1, Number(b.day_rate || 0), b.notes || null, b.active === undefined ? null : (b.active ? 1 : 0), id);
    ctx.json(200, { ok: true });
  });

  // ===================== PHOTOS (condition evidence) =====================
  router.post('/api/photos', async (ctx) => {
    const b = ctx.body; const perms = PHOTO_PERM[b.entity_type];
    if (!perms) return ctx.json(400, { error: 'Unknown photo subject' });
    if (!ctx.require(perms[1])) return;
    if (!ctx.requireCsrf()) return;
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data_url || ''));
    if (!m) return ctx.json(400, { error: 'Upload a JPG, PNG or WEBP image' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 3 * 1024 * 1024) return ctx.json(400, { error: 'Photo is larger than 3 MB — it is resized automatically in the browser; try again' });
    const table = { agreement_item: 'agreement_items', equipment: 'equipment', claim: 'insurance_claims', work_order: 'work_orders' }[b.entity_type];
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(b.entity_id)) return ctx.json(404, { error: 'Record not found' });
    if (db.prepare('SELECT COUNT(*) c FROM photos WHERE entity_type = ? AND entity_id = ?').get(b.entity_type, b.entity_id).c >= 12) return ctx.json(400, { error: 'Maximum 12 photos per record' });
    const r = db.prepare('INSERT INTO photos (entity_type, entity_id, stage, caption, mime, data, bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.entity_type, b.entity_id, ['checkout', 'checkin', 'damage', 'general'].includes(b.stage) ? b.stage : 'general', String(b.caption || '').slice(0, 200) || null, m[1], buf, buf.length, ctx.user.id);
    logAudit(ctx.user.id, 'photo_uploaded', b.entity_type, Number(b.entity_id), { stage: b.stage, bytes: buf.length }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid });
  });
  router.get('/api/photos', async (ctx) => {
    const { entity_type, entity_id, agreement_id } = ctx.query;
    if (agreement_id) {
      if (!ctx.require('rentals.view')) return;
      return ctx.json(200, db.prepare(`SELECT p.id, p.entity_id, p.stage, p.caption, p.bytes, p.created_at, u.full_name as by_name, e.name as equipment_name FROM photos p
        JOIN agreement_items ai ON ai.id = p.entity_id JOIN equipment e ON e.id = ai.equipment_id LEFT JOIN users u ON u.id = p.uploaded_by
        WHERE p.entity_type = 'agreement_item' AND ai.agreement_id = ? ORDER BY p.id`).all(agreement_id));
    }
    const perms = PHOTO_PERM[entity_type]; if (!perms) return ctx.json(400, { error: 'Unknown photo subject' });
    if (!ctx.require(perms[0])) return;
    ctx.json(200, db.prepare(`SELECT p.id, p.entity_id, p.stage, p.caption, p.bytes, p.created_at, u.full_name as by_name FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by
      WHERE p.entity_type = ? AND p.entity_id = ? ORDER BY p.id`).all(entity_type, entity_id));
  });
  router.get('/api/photos/:id/raw', async (ctx, { id }) => {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(id); if (!p) return ctx.json(404, { error: 'Not found' });
    if (!ctx.require(PHOTO_PERM[p.entity_type][0])) return;
    ctx.res.writeHead(200, { 'Content-Type': p.mime, 'Content-Length': p.bytes, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end(Buffer.from(p.data));
  });
  router.del('/api/photos/:id', async (ctx, { id }) => {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(id); if (!p) return ctx.json(404, { error: 'Not found' });
    if (!ctx.require(PHOTO_PERM[p.entity_type][1])) return;
    if (!ctx.requireCsrf()) return;
    db.prepare('DELETE FROM photos WHERE id = ?').run(id);
    logAudit(ctx.user.id, 'photo_deleted', p.entity_type, p.entity_id, { photo: Number(id) }, ctx.ip);
    ctx.json(200, { ok: true });
  });

  // ===================== INSURANCE CLAIMS =====================
  router.get('/api/claims', async (ctx) => {
    if (!ctx.require('claims.view')) return;
    const { status } = ctx.query;
    ctx.json(200, db.prepare(`SELECT ic.*, e.asset_code, e.name as equipment_name, ra.agreement_number, (SELECT COUNT(*) FROM photos p WHERE p.entity_type = 'claim' AND p.entity_id = ic.id) as photos
      FROM insurance_claims ic JOIN equipment e ON e.id = ic.equipment_id LEFT JOIN rental_agreements ra ON ra.id = ic.agreement_id ${status ? 'WHERE ic.status = ?' : ''} ORDER BY ic.id DESC`).all(...(status ? [status] : [])));
  });
  router.get('/api/claims/candidates', async (ctx) => {
    if (!ctx.require('claims.view')) return;
    ctx.json(200, db.prepare(`SELECT ai.id as agreement_item_id, ai.agreement_id, ra.agreement_number, e.id as equipment_id, e.asset_code, e.name, e.replacement_value, ai.is_lost, ai.damage_charge, ai.damage_notes, substr(ai.checkin_at,1,10) as incident_date
      FROM agreement_items ai JOIN equipment e ON e.id = ai.equipment_id JOIN rental_agreements ra ON ra.id = ai.agreement_id
      WHERE (ai.is_lost = 1 OR ai.damage_charge > 0) AND NOT EXISTS (SELECT 1 FROM insurance_claims ic WHERE ic.agreement_item_id = ai.id AND ic.status NOT IN ('rejected','closed')) ORDER BY ai.id DESC`).all());
  });
  router.post('/api/claims', async (ctx) => {
    if (!ctx.require('claims.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(b.equipment_id); if (!eq) return ctx.json(400, { error: 'Choose the equipment' });
    if (!['lost', 'stolen', 'damaged', 'destroyed'].includes(b.incident_type)) return ctx.json(400, { error: 'Incident type must be lost, stolen, damaged or destroyed' });
    const amt = r2(Number(b.amount_claimed || 0)), excess = r2(Number(b.excess || 0));
    if (!(amt > 0) || excess < 0 || excess > amt) return ctx.json(400, { error: 'Amount claimed must be > 0 and the excess between 0 and the amount' });
    if (b.incident_date && !isDate(b.incident_date)) return ctx.json(400, { error: 'Incident date must be YYYY-MM-DD' });
    let item = null; if (b.agreement_item_id) { item = db.prepare('SELECT * FROM agreement_items WHERE id = ? AND equipment_id = ?').get(b.agreement_item_id, eq.id); if (!item) return ctx.json(400, { error: 'Booking line does not match the equipment' }); }
    const no = nextNumber('CLM', 'insurance_claims', 'claim_number');
    const r = db.prepare(`INSERT INTO insurance_claims (claim_number, equipment_id, agreement_id, agreement_item_id, incident_type, incident_date, description, insurer, policy_number, amount_claimed, excess, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(no, eq.id, item ? item.agreement_id : null, item ? item.id : null, b.incident_type, b.incident_date || today(), b.description || null, b.insurer || null, b.policy_number || null, amt, excess, ctx.user.id);
    logAudit(ctx.user.id, 'claim_opened', 'claim', r.lastInsertRowid, { claim_number: no, amount: amt }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid, claim_number: no });
  });
  // Workflow: draft -> submitted -> approved | rejected ; approved -> settled ; any -> closed
  router.put('/api/claims/:id', async (ctx, { id }) => {
    if (!ctx.require('claims.edit')) return;
    if (!ctx.requireCsrf()) return;
    const c = db.prepare('SELECT * FROM insurance_claims WHERE id = ?').get(id); if (!c) return ctx.json(404, { error: 'Not found' });
    const b = ctx.body; const to = b.status;
    const allowed = { draft: ['submitted', 'closed'], submitted: ['approved', 'rejected', 'closed'], approved: ['settled'], rejected: ['closed'], settled: ['closed'], closed: [] };
    if (to && to !== c.status && !(allowed[c.status] || []).includes(to)) return ctx.json(400, { error: `A ${c.status} claim cannot move to ${to}` });
    const out = tx(() => {
      let je = null;
      if (to === 'approved') {
        const approved = r2(Number(b.amount_approved || (c.amount_claimed - c.excess)));
        if (!(approved > 0) || approved > c.amount_claimed) throw Object.assign(new Error('Approved amount must be between 0 and the amount claimed'), { status: 400 });
        je = postJournalEntry({ memo: `Insurance claim ${c.claim_number} approved by ${c.insurer || 'insurer'}`, sourceType: 'claim', sourceId: c.id, createdBy: ctx.user.id,
          lines: [{ code: ACC.INSURANCE_CLAIMS_RECEIVABLE, debit: approved, description: c.claim_number }, { code: ACC.INSURANCE_RECOVERY, credit: approved, description: 'Insurance recovery' }] });
        db.prepare('UPDATE insurance_claims SET amount_approved = ? WHERE id = ?').run(approved, id);
      }
      if (to === 'settled') {
        const settled = r2(Number(b.amount_settled || c.amount_approved));
        if (!(settled > 0)) throw Object.assign(new Error('Enter the amount received'), { status: 400 });
        const lines = [{ code: ACC.BANK, debit: settled, description: `Insurer settlement ${c.claim_number}` }, { code: ACC.INSURANCE_CLAIMS_RECEIVABLE, credit: c.amount_approved, description: c.claim_number }];
        const diff = r2(settled - c.amount_approved);
        if (Math.abs(diff) >= 0.01) lines.push({ code: ACC.INSURANCE_RECOVERY, debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, description: 'Settlement difference' });
        je = postJournalEntry({ memo: `Insurance claim ${c.claim_number} settled`, sourceType: 'claim', sourceId: c.id, createdBy: ctx.user.id, lines });
        db.prepare("UPDATE insurance_claims SET amount_settled = ?, settled_at = datetime('now') WHERE id = ?").run(settled, id);
      }
      db.prepare(`UPDATE insurance_claims SET status = COALESCE(?, status), insurer = COALESCE(?, insurer), policy_number = COALESCE(?, policy_number), insurer_claim_ref = COALESCE(?, insurer_claim_ref),
        notes = COALESCE(?, notes), journal_entry_id = COALESCE(?, journal_entry_id), updated_at = datetime('now') WHERE id = ?`)
        .run(to || null, b.insurer || null, b.policy_number || null, b.insurer_claim_ref || null, b.notes || null, je ? je.entryId : null, id);
      logAudit(ctx.user.id, 'claim_updated', 'claim', Number(id), { status: to, journal_entry: je && je.entryNumber }, ctx.ip);
      return { ok: true, journal_entry: je && je.entryNumber };
    });
    ctx.json(200, out);
  });

  // ===================== FIXED-ASSET ACTIONS =====================
  router.post('/api/equipment/:id/capitalise', async (ctx, { id }) => {
    if (!ctx.require('journals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id); if (!eq) return ctx.json(404, { error: 'Not found' });
    const b = ctx.body; if (!['bill', 'cash', 'opening'].includes(b.method)) return ctx.json(400, { error: 'method must be bill, cash or opening' });
    if (b.date && !isDate(b.date)) return ctx.json(400, { error: 'Date must be YYYY-MM-DD' });
    ctx.json(201, tx(() => assets.capitalise(eq, { method: b.method, vendorName: b.vendor_name, vendorTin: b.vendor_tin, vendorInvoiceNo: b.vendor_invoice_no, vatApplies: !!b.vat_applies, date: b.date, userId: ctx.user.id, ip: ctx.ip })));
  });
  router.post('/api/equipment/:id/write-off', async (ctx, { id }) => {
    if (!ctx.require('journals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id); if (!eq) return ctx.json(404, { error: 'Not found' });
    const reason = String(ctx.body.reason || '').trim(); if (reason.length < 5) return ctx.json(400, { error: 'Give the reason (at least 5 characters)' });
    if (eq.status === 'on_rent') return ctx.json(400, { error: 'Check the unit in (as lost if it was not returned) before writing it off' });
    ctx.json(200, tx(() => assets.writeOff(eq, { reason, date: ctx.body.date, userId: ctx.user.id, ip: ctx.ip })));
  });

  // ===================== RENTAL AGREEMENT — printable & PDF =====================
  function loadAgreement(id) {
    const ra = db.prepare(`SELECT ra.*, c.full_name, c.company_name, c.address, c.phone, c.email, c.tin, l.name as location_name FROM rental_agreements ra JOIN customers c ON c.id = ra.customer_id
                           LEFT JOIN locations l ON l.id = ra.location_id WHERE ra.id = ?`).get(id);
    if (!ra) return null;
    const items = db.prepare(`SELECT ai.*, e.asset_code, e.name, e.serial_number, e.replacement_value FROM agreement_items ai JOIN equipment e ON e.id = ai.equipment_id WHERE ai.agreement_id = ?`).all(id);
    const crew = db.prepare('SELECT * FROM agreement_crew WHERE agreement_id = ?').all(id);
    return { ra, items, crew };
  }
  const TERMS = (s) => [
    `The hirer takes the equipment listed in good working order and returns it in the same condition, fair wear and tear excepted.`,
    `Hire is charged per day from collection to return. Late returns are charged at the late-fee rate for each extra day.`,
    `A damage waiver (where taken) caps liability for ACCIDENTAL damage only; it never covers loss or theft. Lost or stolen units are charged at the replacement value shown.`,
    `The security / caution deposit is refundable after return and inspection, less any amounts owed.`,
    `Cancellations and refunds attract a ${s.cancellation_fee_pct || 20}% charge on the booking value.`,
    `Prices exclude VAT (${s.vat_rate || 7.5}%). Corporate hirers deducting WHT must forward the WHT credit note.`,
    `Equipment may not be sub-hired, taken outside the agreed shoot location without consent, or operated by untrained persons.`,
  ];
  router.get('/api/agreements/:id/print', async (ctx, { id }) => {
    if (!ctx.require('rentals.view')) return;
    const d = loadAgreement(id); if (!d) return ctx.json(404, { error: 'Not found' });
    const s = getSettings(); const cur = s.currency || 'NGN'; const accent = isHexColor(s.brand_primary_color) ? s.brand_primary_color : '#E8630A';
    const logo = getLogo(); const logoSrc = logo ? `data:${logo.contentType};base64,${logo.buffer.toString('base64')}` : null;
    const { ra, items, crew } = d;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(ra.agreement_number)} — Rental agreement</title>
<style>body{font-family:Calibri,Carlito,Arial,sans-serif;color:#222;margin:0;background:#eee}.sheet{max-width:800px;margin:20px auto;background:#fff;padding:32px 36px;border-top:6px solid ${accent}}
h1{color:${accent};margin:0;font-size:26px;letter-spacing:.04em}table{width:100%;border-collapse:collapse;margin-top:10px}th{background:${accent};color:#fff;text-align:left;padding:7px;font-size:13px}td{border-bottom:1px solid #ddd;padding:7px;font-size:13px}
.r{text-align:right}.muted{color:#666;font-size:12px}.bar{position:sticky;top:0;background:#222;padding:8px;text-align:center}.bar button{padding:7px 16px;margin:0 4px;border:0;cursor:pointer}
.sig{display:flex;gap:40px;margin-top:40px}.sig div{flex:1;border-top:1px solid #333;padding-top:6px;font-size:12px}@media print{.bar{display:none}body{background:#fff}.sheet{margin:0;box-shadow:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>
<div class="bar"><button onclick="window.print()">Print / Save as PDF</button><a href="/api/agreements/${ra.id}/agreement.pdf"><button>Download PDF</button></a></div>
<div class="sheet"><table style="margin:0"><tr><td style="border:0;padding:0">${logoSrc ? `<img src="${logoSrc}" style="max-height:60px">` : `<strong style="font-size:22px">${esc(s.company_name)}</strong>`}<div class="muted">${esc(s.company_name)}<br>${esc(s.company_address || '')}<br>${esc([s.company_phone, s.company_email].filter(Boolean).join(' · '))}</div></td>
<td style="border:0;padding:0;text-align:right;vertical-align:top"><h1>RENTAL AGREEMENT</h1><strong>${esc(ra.agreement_number)}</strong><div class="muted">Status: ${esc(ra.status)}<br>Period: ${esc(ra.start_date)} → ${esc(ra.expected_return_date)}${ra.location_name ? `<br>Pick-up: ${esc(ra.location_name)}` : ''}</div></td></tr></table>
<p><strong>Hirer:</strong> ${esc(ra.company_name || ra.full_name)} ${ra.tin ? '· TIN ' + esc(ra.tin) : ''}<br><span class="muted">${esc(ra.address || '')} ${esc(ra.phone || '')} ${esc(ra.email || '')}</span></p>
${ra.project_name ? `<p><strong>Production:</strong> ${esc(ra.project_name)} ${ra.production_type ? '(' + esc(ra.production_type) + ')' : ''} ${ra.shoot_location ? '· Location: ' + esc(ra.shoot_location) : ''}</p>` : ''}
<table><thead><tr><th>Asset</th><th>Item</th><th>Serial</th><th class="r">Rate</th><th class="r">Replacement value</th></tr></thead><tbody>
${items.map(i => `<tr><td>${esc(i.asset_code)}</td><td>${esc(i.name)}</td><td>${esc(i.serial_number || '—')}</td><td class="r">${money(i.rate, cur)} / ${esc(i.rate_type.replace('ly', '').replace('dai', 'day'))}</td><td class="r">${money(i.replacement_value, cur)}</td></tr>`).join('')}</tbody></table>
${crew.length ? `<table><thead><tr><th>Crew</th><th>Role</th><th class="r">Day rate</th><th class="r">Days</th></tr></thead><tbody>${crew.map(c => `<tr><td>${esc(c.crew_name)}</td><td>${esc(c.role || '')}</td><td class="r">${money(c.day_rate, cur)}</td><td class="r">${c.days}</td></tr>`).join('')}</tbody></table>` : ''}
<p>Security / caution deposit: <strong>${money(ra.deposit_amount, cur)}</strong> · Damage waiver: <strong>${ra.damage_waiver_opted ? money(ra.damage_waiver_fee, cur) : 'declined'}</strong>${ra.rush_fee > 0 ? ` · Rush fee: <strong>${money(ra.rush_fee, cur)}</strong>` : ''}</p>
<h3 style="color:${accent}">Terms</h3><ol class="muted">${TERMS(s).map(t => `<li>${esc(t)}</li>`).join('')}</ol>
<div class="sig"><div>For ${esc(s.company_name)} — name, signature & date</div><div>Hirer — name, signature & date</div></div></div>
${ctx.query.autoprint ? '<script>addEventListener("load",function(){setTimeout(function(){print()},300)})</script>' : ''}</body></html>`;
    ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
    ctx.res.end(html);
  });
  router.get('/api/agreements/:id/agreement.pdf', async (ctx, { id }) => {
    if (!ctx.require('rentals.view')) return;
    const d = loadAgreement(id); if (!d) return ctx.json(404, { error: 'Not found' });
    const s = getSettings(); const { ra, items, crew } = d;
    const rows = items.map(i => [i.asset_code, i.name, i.serial_number || '-', i.rate_type, i.rate, i.replacement_value]);
    for (const c of crew) rows.push(['CREW', `${c.crew_name} (${c.role || ''}) x ${c.days} day(s)`, '-', 'day', c.day_rate, '']);
    const pdf = buildPdf({ title: `Rental agreement ${ra.agreement_number}`, company: `${s.company_name || ''} · ${s.company_address || ''}`,
      subtitle: `Hirer: ${ra.company_name || ra.full_name}${ra.tin ? ' (TIN ' + ra.tin + ')' : ''} · ${ra.start_date} to ${ra.expected_return_date}${ra.project_name ? ' · ' + ra.project_name : ''}`,
      columns: [{ header: 'Asset', type: 'text' }, { header: 'Item', type: 'text' }, { header: 'Serial', type: 'text' }, { header: 'Rate basis', type: 'text' }, { header: 'Rate', type: 'money' }, { header: 'Replacement value', type: 'money' }],
      rows, orientation: 'portrait', accent: s.brand_primary_color,
      notes: [`Deposit: ${ra.deposit_amount} · Damage waiver: ${ra.damage_waiver_opted ? ra.damage_waiver_fee : 'declined'}`, ...TERMS(s).map((t, i) => `${i + 1}. ${t}`), '', 'For the company: ____________________________      Hirer: ____________________________      Date: __________'] });
    ctx.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${ra.agreement_number}.pdf"`, 'Content-Length': pdf.length });
    ctx.res.end(pdf);
  });
};
