// General-ledger administration and period-end routines.
const { db, tx, getSettings } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { nextNumber, postJournalEntry, reverseEntry, accountLedger, getAccountByCode, round2: r2 } = require('../lib/ledger');
const { ACC, CLASSES, validCode, classOf, isHeader } = require('../lib/coa');
const reports = require('../lib/reports');

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z'));
const monthEnd = (ym) => reports.monthEnd(ym);
const nextDay = (d) => new Date(new Date(d + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
function setSetting(k, v) { db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)); }

module.exports = function (router) {
  // ===================== CHART OF ACCOUNTS =====================
  router.get('/api/accounts', async (ctx) => {
    if (!ctx.require('accounts.view')) return;
    const asOf = ctx.query.as_of || null;
    const rows = db.prepare(`SELECT a.*, p.code as parent_code,
        (SELECT COUNT(*) FROM journal_lines l WHERE l.account_id = a.id) as postings,
        COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = a.id AND (? IS NULL OR e.entry_date <= ?)), 0) as dr_balance
      FROM chart_of_accounts a LEFT JOIN chart_of_accounts p ON p.id = a.parent_id ORDER BY a.code`).all(asOf, asOf);
    // Natural-sign balance; header accounts roll up their class.
    const natural = (t) => ['asset', 'expense'].includes(t) ? 1 : -1;
    const out = rows.map(a => ({ ...a, balance: r2(a.dr_balance * natural(a.account_type)) }));
    for (const h of out.filter(a => a.is_header)) h.balance = r2(out.filter(a => !a.is_header && a.code[0] === h.code[0]).reduce((s, a) => s + a.dr_balance, 0) * natural(h.account_type));
    ctx.json(200, out);
  });

  router.post('/api/accounts', async (ctx) => {
    if (!ctx.require('accounts.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    const code = String(b.code || '').trim();
    if (!validCode(code)) return ctx.json(400, { error: 'GL code must be exactly 6 digits, starting 1–8 (1 assets · 2 liabilities · 3 equity · 4 income · 5 direct costs · 6 operating expenses · 7 other / finance · 8 tax)' });
    if (isHeader(code)) return ctx.json(400, { error: `${code} is a class header — choose a detail code, e.g. ${code[0]}05000` });
    if (getAccountByCode(code)) return ctx.json(409, { error: `GL ${code} already exists` });
    const name = String(b.name || '').trim();
    if (name.length < 3) return ctx.json(400, { error: 'Give the account a descriptive name' });
    const cls = classOf(code);
    const type = b.account_type || cls.type;
    if (type !== cls.type) return ctx.json(400, { error: `Codes starting ${code[0]} are ${cls.type} accounts (${cls.name}); the type must match` });
    const parent = db.prepare('SELECT id FROM chart_of_accounts WHERE code = ?').get(`${code[0]}00000`);
    const r = db.prepare(`INSERT INTO chart_of_accounts (code, name, account_type, parent_id, ifrs_line, description, allow_manual, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(code, name, type, parent ? parent.id : null, String(b.ifrs_line || '').trim() || null, String(b.description || '').trim() || null, b.allow_manual === false ? 0 : 1);
    logAudit(ctx.user.id, 'gl_account_created', 'gl_account', r.lastInsertRowid, { code, name, type }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid, code });
  });

  router.put('/api/accounts/:code', async (ctx, { code }) => {
    if (!ctx.require('accounts.edit')) return;
    if (!ctx.requireCsrf()) return;
    const a = getAccountByCode(code);
    if (!a) return ctx.json(404, { error: 'Account not found' });
    const b = ctx.body; const sets = [], vals = [];
    if (b.name !== undefined) { if (String(b.name).trim().length < 3) return ctx.json(400, { error: 'Name too short' }); sets.push('name = ?'); vals.push(String(b.name).trim()); }
    if (b.description !== undefined) { sets.push('description = ?'); vals.push(String(b.description || '').trim() || null); }
    if (b.ifrs_line !== undefined) { sets.push('ifrs_line = ?'); vals.push(String(b.ifrs_line || '').trim() || null); }
    if (b.allow_manual !== undefined && !a.is_header) { sets.push('allow_manual = ?'); vals.push(b.allow_manual ? 1 : 0); }
    if (b.is_active !== undefined) {
      if (!b.is_active && a.is_system) return ctx.json(400, { error: 'System accounts are used by automatic postings and cannot be deactivated' });
      if (!b.is_active) { const bal = db.prepare('SELECT COALESCE(SUM(debit-credit),0) b FROM journal_lines WHERE account_id = ?').get(a.id).b; if (Math.abs(bal) > 0.004) return ctx.json(400, { error: `Account still has a balance of ${r2(bal)} — journal it to zero first` }); }
      sets.push('is_active = ?'); vals.push(b.is_active ? 1 : 0);
    }
    if (!sets.length) return ctx.json(400, { error: 'Nothing to update' });
    db.prepare(`UPDATE chart_of_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, a.id);
    logAudit(ctx.user.id, 'gl_account_updated', 'gl_account', a.id, { code, fields: Object.keys(b) }, ctx.ip);
    ctx.json(200, { ok: true });
  });

  router.del('/api/accounts/:code', async (ctx, { code }) => {
    if (!ctx.require('accounts.edit')) return;
    if (!ctx.requireCsrf()) return;
    const a = getAccountByCode(code);
    if (!a) return ctx.json(404, { error: 'Account not found' });
    if (a.is_system || a.is_header) return ctx.json(400, { error: 'System and header accounts cannot be deleted' });
    if (db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE account_id = ?').get(a.id).c) return ctx.json(400, { error: 'This account has postings — deactivate it instead of deleting' });
    db.prepare('DELETE FROM chart_of_accounts WHERE id = ?').run(a.id);
    logAudit(ctx.user.id, 'gl_account_deleted', 'gl_account', a.id, { code }, ctx.ip);
    ctx.json(200, { ok: true });
  });

  router.get('/api/accounts/:code/ledger', async (ctx, { code }) => {
    if (!ctx.require('reports.view')) return;
    const l = accountLedger(code, ctx.query.from || null, ctx.query.to || null);
    if (!l) return ctx.json(404, { error: 'Account not found' });
    ctx.json(200, l);
  });

  // ===================== JOURNAL ENTRIES =====================
  router.get('/api/journal-entries', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    const { from, to, source, q } = ctx.query;
    let sql = `SELECT e.*, u.full_name as created_by_name, (SELECT ROUND(SUM(debit),2) FROM journal_lines WHERE entry_id = e.id) as total FROM journal_entries e LEFT JOIN users u ON u.id = e.created_by WHERE 1=1`;
    const p = [];
    if (from) { sql += ' AND e.entry_date >= ?'; p.push(from); }
    if (to) { sql += ' AND e.entry_date <= ?'; p.push(to); }
    if (source) { sql += ' AND e.source_type = ?'; p.push(source); }
    if (q) { sql += ' AND (e.entry_number LIKE ? OR e.memo LIKE ?)'; p.push(`%${q}%`, `%${q}%`); }
    ctx.json(200, db.prepare(sql + ' ORDER BY e.id DESC LIMIT 500').all(...p));
  });

  router.get('/api/journal-entries/:id', async (ctx, { id }) => {
    if (!ctx.require('reports.view')) return;
    const e = db.prepare('SELECT e.*, u.full_name as created_by_name FROM journal_entries e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?').get(id);
    if (!e) return ctx.json(404, { error: 'Not found' });
    const lines = db.prepare('SELECT l.*, a.code, a.name FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.id').all(id);
    // Where to drill back to in the UI
    let link = null;
    const s = e.source_type, sid = e.source_id;
    if (['invoice', 'invoice_void'].includes(s)) link = { invoice_id: sid };
    else if (['payment', 'payment_reversal'].includes(s)) { const p = db.prepare('SELECT invoice_id FROM payments WHERE id = ?').get(sid); if (p) link = { invoice_id: p.invoice_id }; }
    else if (['deposit', 'deposit_refund'].includes(s)) link = { agreement_id: sid };
    else if (['expense', 'expense_void'].includes(s)) link = { expense_id: sid };
    else if (s === 'voucher') link = { voucher_id: sid };
    else if (s === 'manual') link = { manual_journal_id: sid };
    else if (s === 'write_off' || s === 'capitalisation') link = { equipment_id: sid };
    else if (s === 'claim') link = { claim_id: sid };
    ctx.json(200, { ...e, lines, link });
  });

  // ===================== MANUAL JOURNALS (maker-checker) =====================
  function validateLines(lines) {
    if (!Array.isArray(lines) || lines.length < 2) return 'A journal needs at least two lines';
    let dr = 0, cr = 0;
    for (const l of lines) {
      const a = getAccountByCode(String(l.code || ''));
      if (!a) return `Unknown GL code ${l.code}`;
      if (a.is_header) return `${a.code} is a header account and cannot be posted to`;
      if (!a.is_active) return `${a.code} ${a.name} is inactive`;
      if (!a.allow_manual) return `${a.code} ${a.name} does not accept manual journals`;
      const d = Number(l.debit || 0), c = Number(l.credit || 0);
      if (!(d >= 0) || !(c >= 0) || (d > 0 && c > 0) || (d === 0 && c === 0)) return `Each line needs either a debit or a credit (${a.code})`;
      dr += d; cr += c;
    }
    if (Math.abs(r2(dr) - r2(cr)) > 0.005) return `Debits (${r2(dr)}) must equal credits (${r2(cr)})`;
    return null;
  }

  router.get('/api/manual-journals', async (ctx) => {
    if (!ctx.require('journals.view')) return;
    ctx.json(200, db.prepare(`SELECT m.*, u.full_name as created_by_name, a.full_name as approved_by_name, je.entry_number FROM manual_journals m
      LEFT JOIN users u ON u.id = m.created_by LEFT JOIN users a ON a.id = m.approved_by LEFT JOIN journal_entries je ON je.id = m.journal_entry_id ORDER BY m.id DESC`).all()
      .map(m => ({ ...m, lines: JSON.parse(m.lines) })));
  });

  router.post('/api/manual-journals', async (ctx) => {
    if (!ctx.require('journals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const b = ctx.body;
    if (!isDate(b.entry_date)) return ctx.json(400, { error: 'Entry date must be YYYY-MM-DD' });
    const lock = getSettings().books_locked_until;
    if (lock && b.entry_date <= lock) return ctx.json(400, { error: `The books are locked up to ${lock}` });
    if (String(b.memo || '').trim().length < 5) return ctx.json(400, { error: 'Give the journal a narration (at least 5 characters)' });
    const lines = (b.lines || []).map(l => ({ code: String(l.code || '').trim(), debit: r2(Number(l.debit || 0)), credit: r2(Number(l.credit || 0)), description: String(l.description || '').trim() || null }));
    const err = validateLines(lines); if (err) return ctx.json(400, { error: err });
    const ref = nextNumber('MJ', 'manual_journals', 'ref');
    const total = r2(lines.reduce((a, l) => a + l.debit, 0));
    const r = db.prepare('INSERT INTO manual_journals (ref, entry_date, memo, lines, total, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(ref, b.entry_date, String(b.memo).trim(), JSON.stringify(lines), total, ctx.user.id);
    logAudit(ctx.user.id, 'manual_journal_drafted', 'manual_journal', r.lastInsertRowid, { ref, total }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid, ref, status: 'pending' });
  });

  router.post('/api/manual-journals/:id/decide', async (ctx, { id }) => {
    if (!ctx.require('journals.approve')) return;
    if (!ctx.requireCsrf()) return;
    const m = db.prepare('SELECT * FROM manual_journals WHERE id = ?').get(id);
    if (!m) return ctx.json(404, { error: 'Not found' });
    if (m.status !== 'pending') return ctx.json(400, { error: `Journal is already ${m.status}` });
    if (m.created_by === ctx.user.id) return ctx.json(403, { error: 'You prepared this journal, so a different person must approve it (maker-checker).' });
    const decision = ctx.body.decision;
    if (!['approved', 'rejected'].includes(decision)) return ctx.json(400, { error: 'decision must be approved or rejected' });
    if (decision === 'rejected') {
      const reason = String(ctx.body.reason || '').trim(); if (!reason) return ctx.json(400, { error: 'Give a reason for rejecting' });
      db.prepare("UPDATE manual_journals SET status = 'rejected', reject_reason = ?, approved_by = ?, decided_at = datetime('now') WHERE id = ?").run(reason, ctx.user.id, id);
      logAudit(ctx.user.id, 'manual_journal_rejected', 'manual_journal', Number(id), { reason }, ctx.ip);
      return ctx.json(200, { ok: true });
    }
    const lines = JSON.parse(m.lines); const err = validateLines(lines); if (err) return ctx.json(400, { error: err });
    const out = tx(() => {
      const je = postJournalEntry({ memo: `${m.ref} — ${m.memo}`, sourceType: 'manual', sourceId: m.id, createdBy: ctx.user.id, lines, entryDate: m.entry_date });
      db.prepare("UPDATE manual_journals SET status = 'posted', approved_by = ?, decided_at = datetime('now'), journal_entry_id = ? WHERE id = ?").run(ctx.user.id, je.entryId, id);
      logAudit(ctx.user.id, 'manual_journal_posted', 'manual_journal', Number(id), { journal_entry: je.entryNumber }, ctx.ip);
      return je;
    });
    ctx.json(200, { ok: true, entry_number: out.entryNumber });
  });

  // ===================== DEPRECIATION (IAS 16, straight-line, monthly) =====================
  function depreciationPreview(period) {
    const end = monthEnd(period); const start = `${period}-01`;
    const posted = reports.postedDepreciation(end);
    const eq = db.prepare(`SELECT id, asset_code, name, purchase_cost, salvage_value, useful_life_years, purchase_date, depreciation_start_date, opening_accumulated_depreciation, disposed_at, status
                           FROM equipment WHERE depreciable = 1 AND purchase_cost > 0`).all();
    const lines = [];
    for (const e of eq) {
      const startDate = e.depreciation_start_date || e.purchase_date;
      if (!startDate || startDate > end) continue;
      if (e.disposed_at && e.disposed_at <= end) continue; // IAS 16.55: depreciation stops at derecognition (no charge in the disposal month)
      const base = Math.max(0, e.purchase_cost - (e.salvage_value || 0));
      const monthly = r2(base / (Math.max(1, e.useful_life_years || 5) * 12));
      const acc = (e.opening_accumulated_depreciation || 0) + (posted[e.id] || 0);
      const amount = r2(Math.min(monthly, Math.max(0, base - acc)));
      if (amount > 0) lines.push({ equipment_id: e.id, asset_code: e.asset_code, name: e.name, amount, accumulated_after: r2(acc + amount), nbv_after: r2(e.purchase_cost - acc - amount) });
    }
    return { period, entry_date: end, total: r2(lines.reduce((a, l) => a + l.amount, 0)), lines };
  }

  router.get('/api/accounting/depreciation', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    const runs = db.prepare(`SELECT dr.*, je.entry_number, (SELECT COUNT(*) FROM depreciation_lines WHERE run_id = dr.id) as assets FROM depreciation_runs dr LEFT JOIN journal_entries je ON je.id = dr.journal_entry_id ORDER BY dr.period DESC`).all();
    const period = ctx.query.period || today().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return ctx.json(400, { error: 'period must be YYYY-MM' });
    ctx.json(200, { runs, preview: depreciationPreview(period) });
  });

  router.post('/api/accounting/depreciation/run', async (ctx) => {
    if (!ctx.require('journals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const period = String(ctx.body.period || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return ctx.json(400, { error: 'period must be YYYY-MM' });
    if (period > today().slice(0, 7)) return ctx.json(400, { error: 'Depreciation cannot be run for a future month' });
    if (db.prepare("SELECT id FROM depreciation_runs WHERE period = ? AND status = 'posted'").get(period)) return ctx.json(409, { error: `Depreciation for ${period} has already been posted` });
    const p = depreciationPreview(period);
    if (!p.lines.length) return ctx.json(400, { error: 'Nothing to depreciate for this period (no depreciable assets with cost and an in-service date)' });
    const out = tx(() => {
      const je = postJournalEntry({ memo: `Depreciation ${period} (${p.lines.length} assets)`, sourceType: 'depreciation', sourceId: null, createdBy: ctx.user.id, entryDate: p.entry_date,
        lines: [{ code: ACC.DEPRECIATION, debit: p.total, description: `Depreciation — rental equipment ${period}` }, { code: ACC.EQUIPMENT_ACC_DEP, credit: p.total, description: `Accumulated depreciation ${period}` }] });
      const r = db.prepare('INSERT INTO depreciation_runs (period, total_amount, journal_entry_id) VALUES (?, ?, ?)').run(period, p.total, je.entryId);
      db.prepare('UPDATE journal_entries SET source_id = ? WHERE id = ?').run(r.lastInsertRowid, je.entryId);
      const ins = db.prepare('INSERT INTO depreciation_lines (run_id, equipment_id, amount) VALUES (?, ?, ?)');
      for (const l of p.lines) ins.run(r.lastInsertRowid, l.equipment_id, l.amount);
      logAudit(ctx.user.id, 'depreciation_run', 'depreciation_run', r.lastInsertRowid, { period, total: p.total, journal_entry: je.entryNumber }, ctx.ip);
      return { id: r.lastInsertRowid, period, total: p.total, assets: p.lines.length, entry_number: je.entryNumber };
    });
    ctx.json(201, out);
  });

  router.post('/api/accounting/depreciation/:id/reverse', async (ctx, { id }) => {
    if (!ctx.require('journals.approve')) return;
    if (!ctx.requireCsrf()) return;
    const run = db.prepare("SELECT * FROM depreciation_runs WHERE id = ? AND status = 'posted'").get(id);
    if (!run) return ctx.json(404, { error: 'Posted run not found' });
    const later = db.prepare("SELECT period FROM depreciation_runs WHERE status = 'posted' AND period > ? ORDER BY period DESC").get(run.period);
    if (later) return ctx.json(400, { error: `Reverse the later run (${later.period}) first` });
    tx(() => {
      reverseEntry(run.journal_entry_id, { memo: `Reversal of depreciation ${run.period}`, createdBy: ctx.user.id, sourceType: 'depreciation_reversal', sourceId: run.id, entryDate: monthEnd(run.period) });
      db.prepare("UPDATE depreciation_runs SET status = 'reversed' WHERE id = ?").run(id);
      logAudit(ctx.user.id, 'depreciation_reversed', 'depreciation_run', Number(id), { period: run.period }, ctx.ip);
    });
    ctx.json(200, { ok: true });
  });

  // ===================== EXPECTED CREDIT LOSS (IFRS 9 simplified approach) =====================
  router.post('/api/accounting/ecl/run', async (ctx) => {
    if (!ctx.require('journals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const asOf = ctx.body.as_of || today();
    if (!isDate(asOf)) return ctx.json(400, { error: 'as_of must be YYYY-MM-DD' });
    const aging = reports.arAging(asOf);
    const required = aging.totals.ecl || 0;
    const allowance = getAccountByCode(ACC.ECL_ALLOWANCE);
    const current = -(db.prepare('SELECT COALESCE(SUM(l.debit - l.credit),0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.entry_date <= ?').get(allowance.id, asOf).b);
    const delta = r2(required - current);
    if (Math.abs(delta) < 0.01) return ctx.json(200, { ok: true, required, current: r2(current), adjustment: 0, message: 'Allowance already matches the provision matrix — no entry needed' });
    const je = tx(() => postJournalEntry({ memo: `ECL allowance true-up as at ${asOf} (required ${required}, held ${r2(current)})`, sourceType: 'ecl', createdBy: ctx.user.id, entryDate: asOf,
      lines: delta > 0 ? [{ code: ACC.ECL_EXPENSE, debit: delta, description: 'Increase in expected credit loss allowance' }, { code: ACC.ECL_ALLOWANCE, credit: delta, description: 'ECL allowance' }]
        : [{ code: ACC.ECL_ALLOWANCE, debit: -delta, description: 'Release of ECL allowance' }, { code: ACC.ECL_EXPENSE, credit: -delta, description: 'Reversal of impairment loss' }] }));
    logAudit(ctx.user.id, 'ecl_posted', 'journal_entry', je.entryId, { as_of: asOf, required, delta }, ctx.ip);
    ctx.json(201, { ok: true, required, current: r2(current), adjustment: delta, entry_number: je.entryNumber });
  });

  // ===================== UNBILLED RENTAL ACCRUAL (IFRS 16 straight-line income) =====================
  // Bookings on hire across a month-end are invoiced on return; accrue the days earned to the month-end and
  // reverse automatically on the 1st of the next month (when the real invoice will carry the income).
  function accrualPreview(asOf) {
    const { bookingLines } = require('../lib/billing');
    const rows = db.prepare(`SELECT ra.* FROM rental_agreements ra WHERE ra.start_date <= ? AND ra.status IN ('active','overdue','dispatched','returned')
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.agreement_id = ra.id AND i.status != 'void' AND i.issue_date <= ?)
        AND EXISTS (SELECT 1 FROM agreement_items ai WHERE ai.agreement_id = ra.id AND ai.checkout_at IS NOT NULL AND substr(ai.checkout_at,1,10) <= ?)`).all(asOf, asOf, asOf);
    const lines = [];
    for (const ra of rows) {
      const end = ra.actual_return_date && ra.actual_return_date < asOf ? ra.actual_return_date : asOf;
      const b = bookingLines(ra, { asOf: end });
      const amt = r2(b.raw.filter(l => l.category === 'rental').reduce((a, l) => a + l.net, 0));
      if (amt > 0) lines.push({ agreement_id: ra.id, agreement_number: ra.agreement_number, days: b.days, amount: amt });
    }
    return { as_of: asOf, total: r2(lines.reduce((a, l) => a + l.amount, 0)), lines };
  }
  router.get('/api/accounting/accruals', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    const asOf = ctx.query.as_of || monthEnd(today().slice(0, 7));
    if (!isDate(asOf)) return ctx.json(400, { error: 'as_of must be YYYY-MM-DD' });
    const history = db.prepare("SELECT id, entry_number, entry_date, memo, (SELECT SUM(debit) FROM journal_lines WHERE entry_id = e.id) as total FROM journal_entries e WHERE source_type IN ('accrual','accrual_reversal') ORDER BY id DESC LIMIT 24").all();
    ctx.json(200, { preview: accrualPreview(asOf), history });
  });
  router.post('/api/accounting/accruals/run', async (ctx) => {
    if (!ctx.require('journals.edit')) return;
    if (!ctx.requireCsrf()) return;
    const asOf = ctx.body.as_of;
    if (!isDate(asOf)) return ctx.json(400, { error: 'as_of must be YYYY-MM-DD (normally a month-end)' });
    if (db.prepare("SELECT id FROM journal_entries WHERE source_type = 'accrual' AND entry_date = ?").get(asOf)) return ctx.json(409, { error: `An accrual for ${asOf} has already been posted` });
    const p = accrualPreview(asOf);
    if (!p.total) return ctx.json(400, { error: 'No unbilled rental days to accrue at that date' });
    const out = tx(() => {
      const je = postJournalEntry({ memo: `Unbilled rental income accrual at ${asOf} (${p.lines.length} bookings: ${p.lines.map(l => l.agreement_number).join(', ')})`, sourceType: 'accrual', createdBy: ctx.user.id, entryDate: asOf,
        lines: [{ code: ACC.UNBILLED, debit: p.total, description: 'Accrued (unbilled) rental income' }, { code: ACC.RENTAL_INCOME, credit: p.total, description: 'Rental income earned, not yet invoiced' }] });
      const rev = reverseEntry(je.entryId, { memo: `Auto-reversal of accrual at ${asOf}`, createdBy: ctx.user.id, sourceType: 'accrual_reversal', sourceId: je.entryId, entryDate: nextDay(asOf) });
      logAudit(ctx.user.id, 'accrual_posted', 'journal_entry', je.entryId, { as_of: asOf, total: p.total }, ctx.ip);
      return { entry_number: je.entryNumber, reversal_entry: rev.entryNumber, total: p.total, bookings: p.lines.length };
    });
    ctx.json(201, out);
  });

  // ===================== CORPORATE TAX PROVISION (NTA 2025) =====================
  function taxProvision(from, to, capitalAllowances) {
    const s = getSettings();
    const is = reports.incomeStatement(from, to, { excludeClose: true });
    const sumCodes = (codes) => r2(db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id
        WHERE a.code IN (${codes.map(() => '?').join(',')}) AND e.entry_date BETWEEN ? AND ? AND e.source_type != 'year_end_close'`).get(...codes, from, to).v);
    const turnover = r2(is.revenue);
    const pbt = is.subtotals['PROFIT BEFORE TAX'] ?? is.profit;
    const taxAlreadyBooked = sumCodes([ACC.CIT_EXPENSE, ACC.DEV_LEVY_EXPENSE]);
    const pbtBeforeTax = r2(pbt);
    const depreciation = sumCodes([ACC.DEPRECIATION, ACC.DEPRECIATION_OTHER]);
    const penalties = sumCodes([ACC.PENALTIES]);
    const ecl = sumCodes([ACC.ECL_EXPENSE]);
    const ca = r2(Number(capitalAllowances || 0));
    const assessable = r2(Math.max(0, pbtBeforeTax + depreciation + penalties + ecl - ca));
    const fixedAssets = r2(db.prepare("SELECT COALESCE(SUM(purchase_cost),0) v FROM equipment WHERE disposed_at IS NULL").get().v);
    const small = turnover <= Number(s.small_company_turnover || 100000000) && fixedAssets <= Number(s.small_company_assets || 250000000);
    const citRate = small ? 0 : Number(s.cit_rate || 30), levyRate = small ? 0 : Number(s.dev_levy_rate || 4);
    const cit = r2(assessable * citRate / 100), levy = r2(assessable * levyRate / 100);
    const whtCredits = r2(-(db.prepare('SELECT COALESCE(SUM(l.credit - l.debit),0) v FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.code = ?').get(ACC.WHT_RECEIVABLE).v));
    return {
      period: { from, to }, turnover, fixed_assets_cost: fixedAssets, small_company: small,
      thresholds: { turnover: Number(s.small_company_turnover), fixed_assets: Number(s.small_company_assets) },
      profit_before_tax: pbtBeforeTax, add_backs: { depreciation, penalties_non_deductible: penalties, ecl_general_provision: ecl }, capital_allowances: ca,
      assessable_profit: assessable, cit_rate: citRate, cit, dev_levy_rate: levyRate, dev_levy: levy, total_tax: r2(cit + levy),
      wht_credits_available: whtCredits, net_payable_after_wht_credits: r2(Math.max(0, cit - whtCredits) + levy), tax_already_booked: taxAlreadyBooked,
      notes: [
        'Estimate only — prepare the final computation with your tax adviser (capital allowances per the NTA 2025 schedule, exempt income, loss relief).',
        small ? 'Small company (turnover and fixed assets within the thresholds): 0% CIT and exempt from the development levy.' : `CIT at ${citRate}% and development levy at ${levyRate}% of assessable profit.`,
        'WHT credit notes held (114000) can be set off against CIT; they cannot be set off against the development levy.',
        'The 15% minimum effective tax rate applies only to very large companies / MNE groups and is not computed here.',
      ],
    };
  }
  router.get('/api/accounting/tax-provision', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    const from = ctx.query.from || reports.yearStart(), to = ctx.query.to || today();
    if (!isDate(from) || !isDate(to)) return ctx.json(400, { error: 'from/to must be YYYY-MM-DD' });
    ctx.json(200, taxProvision(from, to, ctx.query.capital_allowances));
  });
  router.post('/api/accounting/tax-provision/post', async (ctx) => {
    if (!ctx.require('journals.approve')) return;
    if (!ctx.requireCsrf()) return;
    const from = ctx.body.from, to = ctx.body.to;
    if (!isDate(from) || !isDate(to)) return ctx.json(400, { error: 'from/to must be YYYY-MM-DD' });
    const t = taxProvision(from, to, ctx.body.capital_allowances);
    const cit = r2(t.cit - Math.max(0, t.tax_already_booked)), levy = t.dev_levy;
    if (t.total_tax <= 0) return ctx.json(400, { error: 'No tax to provide for this period' });
    if (t.tax_already_booked > 0.005) return ctx.json(409, { error: `Tax of ${t.tax_already_booked} has already been booked for this period — reverse it before re-posting` });
    const je = tx(() => postJournalEntry({ memo: `Income tax provision ${from} to ${to} (CIT ${t.cit_rate}%, development levy ${t.dev_levy_rate}%)`, sourceType: 'tax_provision', createdBy: ctx.user.id, entryDate: to,
      lines: [{ code: ACC.CIT_EXPENSE, debit: t.cit }, { code: ACC.CIT_PAYABLE, credit: t.cit }, { code: ACC.DEV_LEVY_EXPENSE, debit: levy }, { code: ACC.DEV_LEVY_PAYABLE, credit: levy }] }));
    logAudit(ctx.user.id, 'tax_provision_posted', 'journal_entry', je.entryId, { cit: t.cit, levy, cit_unused: cit }, ctx.ip);
    ctx.json(201, { ok: true, entry_number: je.entryNumber, cit: t.cit, dev_levy: levy });
  });

  // ===================== YEAR-END CLOSE & PERIOD LOCK =====================
  router.post('/api/accounting/year-end-close', async (ctx) => {
    if (!ctx.require('journals.approve')) return;
    if (!ctx.requireCsrf()) return;
    const date = ctx.body.year_end_date;
    if (!isDate(date)) return ctx.json(400, { error: 'year_end_date must be YYYY-MM-DD' });
    if (db.prepare("SELECT id FROM journal_entries WHERE source_type = 'year_end_close' AND entry_date = ?").get(date)) return ctx.json(409, { error: `The year ending ${date} is already closed` });
    const rows = db.prepare(`SELECT a.code, ROUND(SUM(l.debit - l.credit), 2) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id
        WHERE a.account_type IN ('income','expense') AND e.entry_date <= ? GROUP BY a.id HAVING ABS(b) > 0.004`).all(date);
    if (!rows.length) return ctx.json(400, { error: 'Nothing to close' });
    const lines = rows.map(r => ({ code: r.code, debit: r.b < 0 ? -r.b : 0, credit: r.b > 0 ? r.b : 0, description: 'Close to retained earnings' }));
    const net = r2(rows.reduce((a, r) => a + r.b, 0)); // >0 = loss
    lines.push({ code: ACC.RETAINED_EARNINGS, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0, description: net < 0 ? 'Profit for the year' : 'Loss for the year' });
    const je = tx(() => {
      const j = postJournalEntry({ memo: `Year-end close ${date}: income & expenses to retained earnings`, sourceType: 'year_end_close', createdBy: ctx.user.id, entryDate: date, lines });
      setSetting('books_locked_until', date);
      return j;
    });
    logAudit(ctx.user.id, 'year_end_closed', 'journal_entry', je.entryId, { date, profit: -net }, ctx.ip);
    ctx.json(201, { ok: true, entry_number: je.entryNumber, profit: r2(-net), books_locked_until: date });
  });

  router.put('/api/accounting/lock', async (ctx) => {
    if (!ctx.require('journals.approve')) return;
    if (!ctx.requireCsrf()) return;
    const d = ctx.body.locked_until;
    if (d && !isDate(d)) return ctx.json(400, { error: 'Lock date must be YYYY-MM-DD (blank to unlock)' });
    if (d && d > today()) return ctx.json(400, { error: 'You cannot lock a future date' });
    setSetting('books_locked_until', d || '');
    logAudit(ctx.user.id, d ? 'period_locked' : 'period_unlocked', 'settings', null, { locked_until: d || null }, ctx.ip);
    ctx.json(200, { ok: true, locked_until: d || '' });
  });

  router.get('/api/accounting/status', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    const s = getSettings();
    const lastDep = db.prepare("SELECT period FROM depreciation_runs WHERE status = 'posted' ORDER BY period DESC LIMIT 1").get();
    const lastAccrual = db.prepare("SELECT entry_date FROM journal_entries WHERE source_type = 'accrual' ORDER BY entry_date DESC LIMIT 1").get();
    const lastEcl = db.prepare("SELECT entry_date FROM journal_entries WHERE source_type = 'ecl' ORDER BY entry_date DESC LIMIT 1").get();
    const pendingMj = db.prepare("SELECT COUNT(*) c FROM manual_journals WHERE status = 'pending'").get().c;
    const ob = db.prepare("SELECT batch_number, as_of_date FROM import_batches WHERE kind = 'opening_tb' AND status = 'posted' ORDER BY id DESC LIMIT 1").get();
    ctx.json(200, { books_locked_until: s.books_locked_until || '', last_depreciation: lastDep ? lastDep.period : null, last_accrual: lastAccrual ? lastAccrual.entry_date : null,
      last_ecl: lastEcl ? lastEcl.entry_date : null, pending_manual_journals: pendingMj, opening_balances: ob || null, classes: CLASSES });
  });
};
