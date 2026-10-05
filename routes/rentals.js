const { db, tx } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { nextNumber, postJournalEntry, refreshCustomerBalance } = require('../lib/ledger');
const { ACC } = require('../lib/coa');
const { createInvoice, bookingLines } = require('../lib/billing');
const { getSettings } = require('../lib/db');
const taxlib = require('../lib/tax');
const { r2 } = taxlib;

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z'));
const nonNeg = (v) => Number.isFinite(Number(v)) && Number(v) >= 0;
const RATE_TYPES = ['daily', 'weekly', 'monthly'];

// Equipment units (by id) that are committed to another live booking overlapping [start, end].
// A unit that is out and overdue still occupies the window until it is checked in.
function conflictsFor(equipmentIds, start, end, ignoreAgreementId) {
  const out = [];
  const q = db.prepare(`
    SELECT ra.agreement_number FROM agreement_items ai
    JOIN rental_agreements ra ON ra.id = ai.agreement_id
    WHERE ai.equipment_id = ? AND ra.id != ? AND ra.status NOT IN ('returned','cancelled') AND ai.checkin_at IS NULL
      AND ra.start_date <= ? AND (ra.expected_return_date >= ? OR ra.status IN ('active','overdue','dispatched'))
    LIMIT 1`);
  for (const id of equipmentIds) {
    const c = q.get(id, ignoreAgreementId || 0, end, start);
    if (c) { const eq = db.prepare('SELECT asset_code, name FROM equipment WHERE id = ?').get(id); out.push({ ...eq, conflicting_agreement: c.agreement_number }); }
  }
  return out;
}

function scanOverdue() {
  return db.prepare(`UPDATE rental_agreements SET status = 'overdue'
                       WHERE status IN ('active','dispatched') AND expected_return_date < date('now')`).run().changes;
}

module.exports = function (router) {
  // ---------- QUOTES ----------
  router.get('/api/quotes', async (ctx) => {
    if (!ctx.require('quotes.view')) return;
    ctx.json(200, db.prepare(`
      SELECT q.*, c.full_name as customer_name FROM quotes q
      JOIN customers c ON c.id = q.customer_id ORDER BY q.id DESC`).all());
  });

  router.post('/api/quotes', async (ctx) => {
    if (!ctx.require('quotes.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    if (!b.customer_id || !Array.isArray(b.items) || b.items.length === 0) return ctx.json(400, { error: 'customer_id and items required' });
    if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(b.customer_id)) return ctx.json(404, { error: 'Customer not found' });
    if (b.valid_until && !isDate(b.valid_until)) return ctx.json(400, { error: 'valid_until must be a date (YYYY-MM-DD)' });
    const cfg = taxlib.taxConfig();
    let subtotal = 0;
    const lines = [];
    for (const it of b.items) {
      const rate = Number(it.rate), qty = Number(it.qty ?? 1), duration = Number(it.duration ?? 1);
      if (!Number.isFinite(rate) || rate < 0 || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(duration) || duration <= 0)
        return ctx.json(400, { error: 'Each line needs a rate ≥ 0, a whole-number quantity ≥ 1 and a duration > 0' });
      if (it.rate_type && !RATE_TYPES.includes(it.rate_type)) return ctx.json(400, { error: 'rate_type must be daily, weekly or monthly' });
      if (it.equipment_id && !db.prepare('SELECT id FROM equipment WHERE id = ?').get(it.equipment_id)) return ctx.json(400, { error: 'Unknown equipment on quote line' });
      const line_total = r2(rate * qty * duration);
      subtotal += line_total;
      lines.push({ ...it, rate, qty, duration, line_total });
    }
    subtotal = r2(subtotal);
    const tax_total = cfg.vatRegistered ? r2(subtotal * cfg.vatRate / 100) : 0;
    const total = r2(subtotal + tax_total);
    const out = tx(() => {
      const quote_number = nextNumber('QT', 'quotes', 'quote_number');
      const r = db.prepare(`INSERT INTO quotes (quote_number, customer_id, valid_until, subtotal, tax_total, total, created_by)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`).run(quote_number, b.customer_id, b.valid_until || null, subtotal, tax_total, total, ctx.user.id);
      const ins = db.prepare(`INSERT INTO quote_items (quote_id, equipment_id, description, rate_type, rate, qty, duration, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const it of lines) ins.run(r.lastInsertRowid, it.equipment_id || null, it.description || null, it.rate_type || 'daily', it.rate, it.qty, it.duration, it.line_total);
      logAudit(ctx.user.id, 'quote_created', 'quote', r.lastInsertRowid, { quote_number }, ctx.ip);
      return { id: r.lastInsertRowid, quote_number, subtotal, tax_total, total };
    });
    ctx.json(201, out);
  });

  router.get('/api/quotes/:id', async (ctx, { id }) => {
    if (!ctx.require('quotes.view')) return;
    const q = db.prepare('SELECT q.*, c.full_name as customer_name FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE q.id = ?').get(id);
    if (!q) return ctx.json(404, { error: 'Not found' });
    const items = db.prepare(`SELECT qi.*, e.name as equipment_name FROM quote_items qi LEFT JOIN equipment e ON e.id = qi.equipment_id WHERE qi.quote_id = ?`).all(id);
    ctx.json(200, { ...q, items });
  });

  router.put('/api/quotes/:id/status', async (ctx, { id }) => {
    if (!ctx.require('quotes.edit')) return;
    if (!ctx.requireCsrf()) return;
    const { status } = ctx.body;
    if (!['draft', 'sent', 'accepted', 'rejected', 'expired'].includes(status)) return ctx.json(400, { error: 'Invalid status' });
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
    if (!q) return ctx.json(404, { error: 'Not found' });
    if (db.prepare('SELECT id FROM rental_agreements WHERE quote_id = ?').get(id)) return ctx.json(400, { error: 'This quote has already been converted to a booking' });
    db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(status, id);
    ctx.json(200, { ok: true });
  });

  // Turn an accepted quote into a booking (equipment lines only).
  router.post('/api/quotes/:id/convert', async (ctx, { id }) => {
    if (!ctx.require('rentals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
    if (!q) return ctx.json(404, { error: 'Not found' });
    if (q.status !== 'accepted') return ctx.json(400, { error: 'Only an accepted quote can be converted to a booking' });
    if (db.prepare('SELECT id FROM rental_agreements WHERE quote_id = ?').get(id)) return ctx.json(409, { error: 'This quote has already been converted' });
    const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? AND equipment_id IS NOT NULL').all(id)
      .map(i => ({ equipment_id: i.equipment_id, rate_type: i.rate_type, rate: i.rate }));
    ctx.body = { ...ctx.body, customer_id: q.customer_id, quote_id: q.id, items };
    return createAgreement(ctx);
  });

  // ---------- RENTAL AGREEMENTS ----------
  router.get('/api/agreements', async (ctx) => {
    if (!ctx.require('rentals.view')) return;
    scanOverdue();
    const { status, customer_id, due, q, location_id, from, to } = ctx.query;
    let sql = `SELECT ra.*, c.full_name as customer_name, l.name as location_name,
               (SELECT COUNT(*) FROM agreement_items ai WHERE ai.agreement_id = ra.id) as item_count,
               (SELECT invoice_number FROM invoices i WHERE i.agreement_id = ra.id AND i.status != 'void' LIMIT 1) as invoice_number
               FROM rental_agreements ra JOIN customers c ON c.id = ra.customer_id LEFT JOIN locations l ON l.id = ra.location_id WHERE 1=1`;
    const params = [];
    if (status === 'live') sql += " AND ra.status IN ('reserved','active','overdue','dispatched')";
    else if (status === 'uninvoiced') sql += " AND ra.status = 'returned' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.agreement_id = ra.id AND i.status != 'void')";
    else if (status) { sql += ' AND ra.status = ?'; params.push(status); }
    if (customer_id) { sql += ' AND ra.customer_id = ?'; params.push(customer_id); }
    if (location_id) { sql += ' AND ra.location_id = ?'; params.push(location_id); }
    if (from) { sql += ' AND ra.start_date >= ?'; params.push(from); }
    if (to) { sql += ' AND ra.start_date <= ?'; params.push(to); }
    if (due === 'today') sql += " AND ra.status IN ('active','dispatched','overdue') AND ra.expected_return_date = date('now')";
    if (due === 'week') sql += " AND ra.status IN ('active','dispatched','overdue') AND ra.expected_return_date BETWEEN date('now') AND date('now','+7 days')";
    if (due === 'pickups') sql += " AND ra.status = 'reserved' AND ra.start_date BETWEEN date('now') AND date('now','+7 days')";
    if (q) { sql += ' AND (ra.agreement_number LIKE ? OR ra.project_name LIKE ? OR c.full_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY ra.id DESC';
    ctx.json(200, db.prepare(sql).all(...params));
  });

  router.get('/api/agreements/:id', async (ctx, { id }) => {
    if (!ctx.require('rentals.view')) return;
    const ra = db.prepare(`SELECT ra.*, c.full_name as customer_name, c.phone as customer_phone,
                            c.coi_on_file, c.coi_expiry_date, k.name as kit_name, l.name as location_name
                            FROM rental_agreements ra JOIN customers c ON c.id = ra.customer_id
                            LEFT JOIN kits k ON k.id = ra.kit_id LEFT JOIN locations l ON l.id = ra.location_id WHERE ra.id = ?`).get(id);
    if (!ra) return ctx.json(404, { error: 'Not found' });
    const items = db.prepare(`SELECT ai.*, e.name as equipment_name, e.asset_code, e.replacement_value,
                               e.category_id, cat.prep_checklist FROM agreement_items ai
                               JOIN equipment e ON e.id = ai.equipment_id
                               LEFT JOIN equipment_categories cat ON cat.id = e.category_id
                               WHERE ai.agreement_id = ?`).all(id);
    const invoices = db.prepare('SELECT id, invoice_number, grand_total, amount_paid, status FROM invoices WHERE agreement_id = ?').all(id);
    const crew = db.prepare('SELECT * FROM agreement_crew WHERE agreement_id = ?').all(id);
    const consumables = db.prepare(`SELECT ac.*, rc.name, rc.item_code FROM agreement_consumables ac
                                     JOIN rental_consumables rc ON rc.id = ac.consumable_id WHERE ac.agreement_id = ?`).all(id);
    const photos = db.prepare(`SELECT p.id, p.entity_id, p.stage, p.caption FROM photos p JOIN agreement_items ai ON ai.id = p.entity_id
                               WHERE p.entity_type = 'agreement_item' AND ai.agreement_id = ? ORDER BY p.id`).all(id);
    const claims = db.prepare('SELECT id, claim_number, status, amount_claimed, agreement_item_id FROM insurance_claims WHERE agreement_id = ?').all(id);
    // Booking value (for the cancellation-fee preview)
    let est = 0; try { est = r2(bookingLines(ra).raw.filter(l => l.category !== 'recovery').reduce((a, l) => a + l.net, 0)); } catch {}
    ctx.json(200, { ...ra, items, invoices, crew, consumables, photos, claims, estimated_value: est, cancellation_fee_pct: Number(getSettings().cancellation_fee_pct || 0),
      deposit_available: r2(ra.deposit_received - ra.deposit_refunded - ra.deposit_applied) });
  });

  async function createAgreement(ctx) {
    const b = ctx.body;
    if (!b.customer_id || !b.start_date || !b.expected_return_date)
      return ctx.json(400, { error: 'customer_id, start_date, expected_return_date and items (or a kit_id) are required' });
    if (!isDate(b.start_date) || !isDate(b.expected_return_date)) return ctx.json(400, { error: 'Dates must be valid (YYYY-MM-DD)' });
    if (b.expected_return_date < b.start_date) return ctx.json(400, { error: 'The return date cannot be before the start date' });
    for (const f of ['deposit_amount', 'damage_waiver_fee', 'rush_fee']) if (b[f] !== undefined && b[f] !== '' && !nonNeg(b[f])) return ctx.json(400, { error: `${f.replace(/_/g, ' ')} cannot be negative` });

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id);
    if (!customer) return ctx.json(404, { error: 'Customer not found' });
    if (customer.is_blacklisted) return ctx.json(400, { error: 'Customer is blacklisted' + (customer.blacklist_reason ? `: ${customer.blacklist_reason}` : '') });
    if (customer.credit_limit > 0 && customer.outstanding_balance > customer.credit_limit)
      return ctx.json(400, { error: `Customer is over their credit limit (outstanding ${customer.outstanding_balance.toFixed(2)} vs limit ${customer.credit_limit.toFixed(2)}). Collect payment first.` });

    let items = Array.isArray(b.items) ? b.items : [];
    let kit = null;
    if (b.kit_id) {
      kit = db.prepare('SELECT * FROM kits WHERE id = ?').get(b.kit_id);
      if (!kit) return ctx.json(404, { error: 'Kit not found' });
      if (kit.status !== 'active') return ctx.json(400, { error: 'This kit is retired' });
      const comps = db.prepare('SELECT ki.equipment_id, e.daily_rate FROM kit_items ki JOIN equipment e ON e.id = ki.equipment_id WHERE ki.kit_id = ?').all(b.kit_id);
      const listTotal = comps.reduce((a, c) => a + c.daily_rate, 0);
      // The kit's package rate is spread across its components in proportion to their list rates, so the
      // customer is billed the discounted package price, not the sum of the parts.
      items = comps.map(c => ({ equipment_id: c.equipment_id, rate_type: 'daily',
        rate: kit.daily_rate > 0 && listTotal > 0 ? r2(kit.daily_rate * c.daily_rate / listTotal) : c.daily_rate }));
    }
    if (!items.length) return ctx.json(400, { error: 'customer_id, start_date, expected_return_date and items (or a kit_id) are required' });
    const ids = items.map(i => Number(i.equipment_id));
    if (new Set(ids).size !== ids.length) return ctx.json(400, { error: 'The same unit is listed more than once' });

    const eqRows = ids.map(id => db.prepare('SELECT * FROM equipment WHERE id = ?').get(id));
    if (eqRows.some(e => !e)) return ctx.json(400, { error: 'One of the selected equipment items does not exist' });
    for (const e of eqRows) {
      if (['retired', 'lost'].includes(e.status)) return ctx.json(400, { error: `${e.asset_code} ${e.name} is ${e.status} and cannot be booked` });
      if (e.status === 'maintenance' && b.start_date <= today()) return ctx.json(400, { error: `${e.asset_code} ${e.name} is in maintenance` });
    }
    const conflicts = conflictsFor(ids, b.start_date, b.expected_return_date);
    if (conflicts.length) return ctx.json(409, { error: `Not available for those dates: ${conflicts.map(c => `${c.asset_code} ${c.name} (booked on ${c.conflicting_agreement})`).join('; ')}`, conflicts });

    const priced = items.map((it, i) => {
      const rt = RATE_TYPES.includes(it.rate_type) ? it.rate_type : 'daily';
      const catalog = eqRows[i][rt + '_rate'];
      const rate = Number(it.rate) > 0 ? Number(it.rate) : catalog;
      return { equipment_id: ids[i], rate_type: rt, rate: r2(rate) };
    });
    if (priced.some(p => !nonNeg(p.rate))) return ctx.json(400, { error: 'Rates cannot be negative' });

    let locationId = b.location_id ? Number(b.location_id) : null;
    if (locationId && !db.prepare('SELECT 1 FROM locations WHERE id = ? AND active = 1').get(locationId)) return ctx.json(400, { error: 'Unknown pick-up location' });
    if (!locationId) { const l = db.prepare('SELECT id FROM locations WHERE is_default = 1 ORDER BY id LIMIT 1').get(); locationId = l ? l.id : null; }
    // Studio spaces and similar carry a default refundable caution fee — used when no deposit was entered.
    if (b.deposit_amount === undefined || b.deposit_amount === '' || Number(b.deposit_amount) === 0) {
      const caution = r2(eqRows.reduce((a, e) => a + (e.default_deposit || 0), 0));
      if (caution > 0) b.deposit_amount = caution;
    }
    const warnings = [];
    if (!customer.coi_on_file || !customer.coi_expiry_date || customer.coi_expiry_date < b.start_date) warnings.push('Customer has no valid Certificate of Insurance on file for the rental start date');

    const out = tx(() => {
      const agreement_number = nextNumber('RA', 'rental_agreements', 'agreement_number');
      const r = db.prepare(`INSERT INTO rental_agreements
        (agreement_number, customer_id, quote_id, kit_id, project_name, production_type, shoot_location,
         start_date, expected_return_date, deposit_amount, delivery_required, delivery_address,
         damage_waiver_opted, damage_waiver_fee, rush_fee, terms, created_by, location_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        agreement_number, b.customer_id, b.quote_id || null, b.kit_id || null, b.project_name || null,
        b.production_type || null, b.shoot_location || null, b.start_date, b.expected_return_date,
        r2(Number(b.deposit_amount || 0)), b.delivery_required ? 1 : 0, b.delivery_address || null,
        b.damage_waiver_opted ? 1 : 0, b.damage_waiver_opted ? r2(Number(b.damage_waiver_fee || 0)) : 0, r2(Number(b.rush_fee || 0)), b.terms || null, ctx.user.id, locationId);
      const insItem = db.prepare('INSERT INTO agreement_items (agreement_id, equipment_id, rate_type, rate) VALUES (?, ?, ?, ?)');
      const markReserved = db.prepare("UPDATE equipment SET status = 'reserved' WHERE id = ? AND status = 'available'");
      for (const p of priced) { insItem.run(r.lastInsertRowid, p.equipment_id, p.rate_type, p.rate); markReserved.run(p.equipment_id); }
      if (b.quote_id) db.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").run(b.quote_id);
      logAudit(ctx.user.id, 'agreement_created', 'rental_agreement', r.lastInsertRowid, { agreement_number }, ctx.ip);
      return { id: r.lastInsertRowid, agreement_number, warnings };
    });
    ctx.json(201, out);
  }
  router.post('/api/agreements', async (ctx) => {
    if (!ctx.require('rentals.edit')) return;
    if (!ctx.requireCsrf()) return;
    return createAgreement(ctx);
  });

  // Dispatch: checkout an item (equipment leaves the yard) — records the prep checklist confirmation
  router.post('/api/agreements/:id/checkout/:itemId', async (ctx, { id, itemId }) => {
    if (!ctx.require('dispatch.edit')) return;
    if (!ctx.requireCsrf()) return;
    const { condition, photos, checklist, override_reason, occurred_on } = ctx.body;
    if (occurred_on && (!isDate(occurred_on) || occurred_on > today())) return ctx.json(400, { error: 'The checkout date must be a valid date that is not in the future' });
    const ra = db.prepare('SELECT * FROM rental_agreements WHERE id = ?').get(id);
    if (!ra) return ctx.json(404, { error: 'Booking not found' });
    if (!['reserved', 'dispatched', 'active'].includes(ra.status)) return ctx.json(400, { error: `A ${ra.status} booking cannot have items checked out` });
    const item = db.prepare(`SELECT ai.*, e.status as equipment_status, e.name, cat.prep_checklist FROM agreement_items ai
                               JOIN equipment e ON e.id = ai.equipment_id LEFT JOIN equipment_categories cat ON cat.id = e.category_id
                               WHERE ai.id = ? AND ai.agreement_id = ?`).get(itemId, id);
    if (!item) return ctx.json(404, { error: 'That item is not part of this booking' });
    if (item.checkout_at) return ctx.json(400, { error: 'This item has already been checked out' });
    if (!['reserved', 'available'].includes(item.equipment_status)) return ctx.json(400, { error: `${item.name} is ${item.equipment_status} and cannot be checked out` });
    let required = []; try { required = JSON.parse(item.prep_checklist || '[]'); } catch {}
    if (required.length) {
      if (!Array.isArray(checklist) || !checklist.length) return ctx.json(400, { error: 'Complete the prep / QC checklist before checkout' });
      if (checklist.some(c => !c.done) && !String(override_reason || '').trim()) return ctx.json(400, { error: 'Some checklist items are unchecked — tick them, or enter a reason to proceed' });
    }
    tx(() => {
      db.prepare(`UPDATE agreement_items SET checkout_condition = ?, checkout_photos = ?, checkout_checklist = ?, checkout_at = COALESCE(?, datetime('now')) WHERE id = ?`)
        .run(condition || null, JSON.stringify(photos || []), JSON.stringify(checklist || []), occurred_on ? occurred_on + ' 09:00:00' : null, itemId);
      db.prepare("UPDATE equipment SET status = 'on_rent' WHERE id = ?").run(item.equipment_id);
      db.prepare("UPDATE rental_agreements SET status = 'active' WHERE id = ? AND status IN ('reserved','dispatched')").run(id);
      logAudit(ctx.user.id, 'equipment_checked_out', 'agreement_item', Number(itemId), { override_reason: override_reason || null }, ctx.ip);
    });
    ctx.json(200, { ok: true });
  });

  // Dispatch: check-in. A lost item is billed at full replacement value; damage opens a corrective work order.
  router.post('/api/agreements/:id/checkin/:itemId', async (ctx, { id, itemId }) => {
    if (!ctx.require('dispatch.edit')) return;
    if (!ctx.requireCsrf()) return;
    const { condition, photos, checklist, damage_notes, is_lost, occurred_on } = ctx.body;
    if (occurred_on && (!isDate(occurred_on) || occurred_on > today())) return ctx.json(400, { error: 'The return date must be a valid date that is not in the future' });
    const damage = ctx.body.damage_charge === undefined || ctx.body.damage_charge === '' ? 0 : Number(ctx.body.damage_charge);
    if (!Number.isFinite(damage) || damage < 0) return ctx.json(400, { error: 'Damage charge must be zero or a positive number' });
    if (damage > 0 && !String(damage_notes || condition || '').trim()) return ctx.json(400, { error: 'Describe the damage when charging for it' });
    const item = db.prepare(`SELECT ai.*, e.replacement_value, e.name FROM agreement_items ai JOIN equipment e ON e.id = ai.equipment_id
                               WHERE ai.id = ? AND ai.agreement_id = ?`).get(itemId, id);
    if (!item) return ctx.json(404, { error: 'That item is not part of this booking' });
    if (!item.checkout_at) return ctx.json(400, { error: 'This item was never checked out' });
    if (item.checkin_at) return ctx.json(400, { error: 'This item has already been checked in' });
    if (occurred_on && occurred_on < item.checkout_at.slice(0, 10)) return ctx.json(400, { error: 'The return date cannot be before the checkout date' });
    if (is_lost && !(item.replacement_value > 0)) return ctx.json(400, { error: `${item.name} has no replacement value set, so a loss cannot be billed. Set it on the equipment record first.` });
    const live = db.prepare("SELECT invoice_number FROM invoices WHERE agreement_id = ? AND status != 'void'").get(id);
    if (live && (damage > 0 || is_lost)) return ctx.json(409, { error: `Invoice ${live.invoice_number} has already been issued. Void it, record the check-in, then re-issue so the damage/loss is billed.` });
    tx(() => {
      const replacementCharge = is_lost ? item.replacement_value : 0;
      db.prepare(`UPDATE agreement_items SET checkin_condition = ?, checkin_photos = ?, checkin_checklist = ?, checkin_at = COALESCE(?, datetime('now')),
                  damage_notes = ?, damage_charge = ?, is_lost = ?, replacement_charge = ? WHERE id = ?`)
        .run(condition || null, JSON.stringify(photos || []), JSON.stringify(checklist || []), occurred_on ? occurred_on + ' 17:00:00' : null, damage_notes || null,
             is_lost ? 0 : r2(damage), is_lost ? 1 : 0, replacementCharge, itemId);
      const newStatus = is_lost ? 'lost' : damage > 0 ? 'maintenance' : 'available';
      db.prepare('UPDATE equipment SET status = ? WHERE id = ?').run(newStatus, item.equipment_id);
      if (!is_lost && damage > 0) {
        const wo = nextNumber('WO', 'work_orders', 'wo_number');
        db.prepare(`INSERT INTO work_orders (wo_number, equipment_id, wo_type, priority, description) VALUES (?, ?, 'corrective', 'high', ?)`)
          .run(wo, item.equipment_id, `Damage on return (booking ${id}): ${damage_notes || condition}`);
      }
      const remaining = db.prepare('SELECT COUNT(*) as c FROM agreement_items WHERE agreement_id = ? AND checkin_at IS NULL').get(id).c;
      if (remaining === 0) {
        // The booking's return date is the latest check-in date across its items.
        const last = db.prepare('SELECT MAX(substr(checkin_at, 1, 10)) as d FROM agreement_items WHERE agreement_id = ?').get(id).d;
        db.prepare("UPDATE rental_agreements SET status = 'returned', actual_return_date = ? WHERE id = ?").run(last || today(), id);
      }
      logAudit(ctx.user.id, 'equipment_checked_in', 'agreement_item', Number(itemId), { damage_charge: damage, is_lost: !!is_lost }, ctx.ip);
    });
    ctx.json(200, { ok: true });
  });

  // Cancel a reserved booking. Per the rate card, cancellations attract a penalty (default 20% of the booking value),
  // billed on a cancellation invoice; a held deposit / caution fee can then be applied to it and the rest refunded.
  router.put('/api/agreements/:id/cancel', async (ctx, { id }) => {
    if (!ctx.require('rentals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const ra = db.prepare('SELECT * FROM rental_agreements WHERE id = ?').get(id);
    if (!ra) return ctx.json(404, { error: 'Not found' });
    if (ra.status !== 'reserved') return ctx.json(400, { error: ra.status === 'cancelled' ? 'Booking is already cancelled' : `A ${ra.status} booking cannot be cancelled — only reserved bookings with nothing checked out` });
    if (db.prepare('SELECT COUNT(*) as c FROM agreement_items WHERE agreement_id = ? AND checkout_at IS NOT NULL').get(id).c) return ctx.json(400, { error: 'Items have already been checked out' });
    const live = db.prepare("SELECT invoice_number FROM invoices WHERE agreement_id = ? AND status != 'void'").get(id);
    if (live) return ctx.json(400, { error: `Void invoice ${live.invoice_number} before cancelling this booking` });
    const b = ctx.body || {};
    const reason = String(b.reason || '').trim();
    const pct = b.waive_fee ? 0 : (b.fee_pct !== undefined && b.fee_pct !== '' ? Number(b.fee_pct) : Number(getSettings().cancellation_fee_pct || 0));
    if (!(pct >= 0 && pct <= 100)) return ctx.json(400, { error: 'Cancellation fee % must be between 0 and 100' });
    if (b.waive_fee && reason.length < 5) return ctx.json(400, { error: 'Give a reason for waiving the cancellation fee' });
    const base = r2(bookingLines(ra).raw.filter(l => l.category !== 'recovery').reduce((a, l) => a + l.net, 0));
    const fee = r2(base * pct / 100);
    const cancelDate = b.cancel_date || today();
    if (!isDate(cancelDate) || cancelDate > today()) return ctx.json(400, { error: 'Cancellation date must be a valid date, not in the future' });
    if (fee > 0) { const last = db.prepare('SELECT MAX(issue_date) d FROM invoices WHERE is_legacy = 0').get().d; if (last && cancelDate < last) return ctx.json(400, { error: `Cancellation date cannot be earlier than the last invoice issued (${last})` }); }
    const held = r2(ra.deposit_received - ra.deposit_refunded - ra.deposit_applied);
    if (held > 0.005 && fee <= 0) return ctx.json(400, { error: 'A deposit is still held for this booking. Refund it first.' });
    const out = tx(() => {
      let inv = null;
      if (fee > 0) {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(ra.customer_id);
        inv = createInvoice({ customer, agreementId: ra.id, kind: 'cancellation', createdBy: ctx.user.id, ip: ctx.ip, issueDate: cancelDate,
          raw: [{ description: `Cancellation fee — ${pct}% of booking ${ra.agreement_number} (value ${base.toFixed(2)})`, net: fee, category: 'fee', gl: ACC.CANCELLATION_INCOME }] });
      }
      const items = db.prepare('SELECT equipment_id FROM agreement_items WHERE agreement_id = ?').all(id);
      db.prepare("UPDATE rental_agreements SET status = 'cancelled', cancellation_fee = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(fee, cancelDate, reason || null, id);
      for (const it of items) {
        const other = db.prepare(`SELECT 1 FROM agreement_items ai JOIN rental_agreements r ON r.id = ai.agreement_id
                                   WHERE ai.equipment_id = ? AND r.status IN ('reserved','active','overdue','dispatched') LIMIT 1`).get(it.equipment_id);
        if (!other) db.prepare("UPDATE equipment SET status = 'available' WHERE id = ? AND status = 'reserved'").run(it.equipment_id);
      }
      logAudit(ctx.user.id, 'agreement_cancelled', 'rental_agreement', Number(id), { fee, pct, waived: !!b.waive_fee, reason, invoice: inv && inv.invoice_number }, ctx.ip);
      return { ok: true, cancellation_fee: fee, invoice: inv, deposit_held: held };
    });
    ctx.json(200, out);
  });

  router.post('/api/agreements/scan-overdue', async (ctx) => {
    if (!ctx.require('rentals.edit')) return;
    if (!ctx.requireCsrf()) return;
    ctx.json(200, { updated: scanOverdue() });
  });

  // ---------- DEPOSITS (refundable security deposit — a liability, not income, and outside VAT) ----------
  const depositAmount = (ctx) => { const a = r2(Number(ctx.body.amount)); return Number.isFinite(a) && a > 0 ? a : null; };

  router.post('/api/agreements/:id/deposit', async (ctx, { id }) => {
    if (!ctx.require('payments.edit')) return;
    if (!ctx.requireCsrf()) return;
    const ra = db.prepare('SELECT * FROM rental_agreements WHERE id = ?').get(id);
    if (!ra) return ctx.json(404, { error: 'Not found' });
    if (ra.status === 'cancelled') return ctx.json(400, { error: 'Booking is cancelled' });
    const amount = depositAmount(ctx);
    if (!amount) return ctx.json(400, { error: 'Enter a deposit amount greater than zero' });
    if (amount > r2(ra.deposit_amount - ra.deposit_received) + 0.005) return ctx.json(400, { error: `Only ${r2(ra.deposit_amount - ra.deposit_received).toFixed(2)} of the agreed deposit is still outstanding` });
    const method = ctx.body.method === 'cash' ? 'cash' : 'bank_transfer';
    const on = ctx.body.received_on || today();
    if (!isDate(on) || on > today()) return ctx.json(400, { error: 'Receipt date must be a valid date, not in the future' });
    tx(() => {
      db.prepare('UPDATE rental_agreements SET deposit_received = deposit_received + ?, deposit_paid = CASE WHEN deposit_received + ? >= deposit_amount - 0.005 THEN 1 ELSE 0 END WHERE id = ?').run(amount, amount, id);
      postJournalEntry({ memo: `Deposit received — ${ra.agreement_number}`, sourceType: 'deposit', sourceId: Number(id), createdBy: ctx.user.id, entryDate: on,
        lines: [{ code: method === 'cash' ? ACC.CASH : ACC.BANK, debit: amount, description: 'Deposit received' }, { code: ACC.DEPOSITS_HELD, credit: amount, description: 'Customer deposit held' }] });
      logAudit(ctx.user.id, 'deposit_received', 'rental_agreement', Number(id), { amount }, ctx.ip);
    });
    ctx.json(201, { ok: true });
  });

  router.post('/api/agreements/:id/deposit/refund', async (ctx, { id }) => {
    if (!ctx.require('payments.edit')) return;
    if (!ctx.requireCsrf()) return;
    const ra = db.prepare('SELECT * FROM rental_agreements WHERE id = ?').get(id);
    if (!ra) return ctx.json(404, { error: 'Not found' });
    const amount = depositAmount(ctx);
    if (!amount) return ctx.json(400, { error: 'Enter a refund amount greater than zero' });
    const avail = r2(ra.deposit_received - ra.deposit_refunded - ra.deposit_applied);
    if (amount > avail + 0.005) return ctx.json(400, { error: `Only ${avail.toFixed(2)} of the deposit is available to refund` });
    const on = ctx.body.paid_on || today();
    if (!isDate(on) || on > today()) return ctx.json(400, { error: 'Refund date must be a valid date, not in the future' });
    tx(() => {
      db.prepare('UPDATE rental_agreements SET deposit_refunded = deposit_refunded + ? WHERE id = ?').run(amount, id);
      postJournalEntry({ memo: `Deposit refunded — ${ra.agreement_number}`, sourceType: 'deposit_refund', sourceId: Number(id), createdBy: ctx.user.id, entryDate: on,
        lines: [{ code: ACC.DEPOSITS_HELD, debit: amount, description: 'Deposit released' }, { code: ACC.BANK, credit: amount, description: 'Deposit refund paid' }] });
      logAudit(ctx.user.id, 'deposit_refunded', 'rental_agreement', Number(id), { amount }, ctx.ip);
    });
    ctx.json(200, { ok: true });
  });

  router.post('/api/agreements/:id/deposit/apply', async (ctx, { id }) => {
    if (!ctx.require('payments.edit')) return;
    if (!ctx.requireCsrf()) return;
    const ra = db.prepare('SELECT * FROM rental_agreements WHERE id = ?').get(id);
    if (!ra) return ctx.json(404, { error: 'Not found' });
    const inv = db.prepare("SELECT * FROM invoices WHERE agreement_id = ? AND status IN ('unpaid','partial') ORDER BY id DESC").get(id);
    if (!inv) return ctx.json(400, { error: 'There is no open invoice on this booking to apply the deposit to' });
    const avail = r2(ra.deposit_received - ra.deposit_refunded - ra.deposit_applied);
    const balance = r2(inv.grand_total - inv.amount_paid);
    const amount = depositAmount(ctx) || Math.min(avail, balance);
    const on = ctx.body.applied_on || today();
    if (!isDate(on) || on > today() || on < inv.issue_date) return ctx.json(400, { error: 'Application date must be between the invoice date and today' });
    if (!(amount > 0)) return ctx.json(400, { error: 'No deposit available to apply' });
    if (amount > avail + 0.005) return ctx.json(400, { error: `Only ${avail.toFixed(2)} of the deposit is available` });
    if (amount > balance + 0.005) return ctx.json(400, { error: `The invoice balance is only ${balance.toFixed(2)}` });
    const out = tx(() => {
      const ref = nextNumber('PMT', 'payments', 'payment_ref');
      const p = db.prepare(`INSERT INTO payments (payment_ref, invoice_id, customer_id, amount, method, received_by, notes, received_at) VALUES (?, ?, ?, ?, 'deposit_applied', ?, ?, ?)`)
        .run(ref, inv.id, inv.customer_id, amount, ctx.user.id, `Deposit applied from ${ra.agreement_number}`, on + ' 12:00:00');
      const paid = r2(inv.amount_paid + amount);
      db.prepare('UPDATE invoices SET amount_paid = ?, status = ? WHERE id = ?').run(paid, paid >= inv.grand_total - 0.005 ? 'paid' : 'partial', inv.id);
      db.prepare('UPDATE rental_agreements SET deposit_applied = deposit_applied + ? WHERE id = ?').run(amount, id);
      postJournalEntry({ memo: `Deposit applied to ${inv.invoice_number}`, sourceType: 'payment', sourceId: p.lastInsertRowid, createdBy: ctx.user.id, entryDate: on,
        lines: [{ code: ACC.DEPOSITS_HELD, debit: amount, description: 'Deposit applied' }, { code: ACC.AR, credit: amount, description: `AR settled — ${inv.invoice_number}` }] });
      refreshCustomerBalance(inv.customer_id);
      logAudit(ctx.user.id, 'deposit_applied', 'invoice', inv.id, { amount }, ctx.ip);
      return { payment_ref: ref, invoice_number: inv.invoice_number, applied: amount };
    });
    ctx.json(200, out);
  });
};
