// Report catalogue, runner, report builder and file exports (CSV · Excel · PDF · JSON).
const { db, getSettings } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const reports = require('../lib/reports');
const { toCsv } = require('../lib/csv');
const { buildXlsx } = require('../lib/xlsx');
const { buildPdf } = require('../lib/pdf');

const FORMATS = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', json: 'application/json; charset=utf-8' };
const slug = (s) => String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function cellsOf(table) {
  // Section / total rows put their label in the first column so exports read like the screen.
  const first = table.columns[0] && table.columns[0].key;
  const rowArr = (r) => table.columns.map((c, i) => {
    let v = r[c.key];
    if (i === 0 && (v === undefined || v === '' || v === null) && r._style) v = r.line || r.section || r.kind || r.memo || '';
    return v === undefined ? '' : v;
  });
  const rows = table.rows.map(rowArr);
  const totals = table.totals ? table.columns.map(c => table.totals[c.key] ?? '') : null;
  if (totals && first && (totals[0] === '' || totals[0] == null)) totals[0] = 'TOTAL';
  return { rows, totals };
}

function sendTable(ctx, table, format, userId) {
  const s = getSettings();
  const fname = `${slug(table.title)}-${new Date().toISOString().slice(0, 10)}`;
  if (!FORMATS[format]) return ctx.json(400, { error: 'format must be json, csv, xlsx or pdf' });
  if (format === 'json') return ctx.json(200, table);
  const { rows, totals } = cellsOf(table);
  let body;
  if (format === 'csv') {
    body = Buffer.from(toCsv([[table.title], [table.subtitle || ''], [], table.columns.map(c => c.header), ...rows, ...(totals ? [totals] : []), ...(table.notes || []).map(n => [n])]), 'utf8');
  } else if (format === 'xlsx') {
    body = buildXlsx([{ name: table.title.slice(0, 31), title: `${s.company_name || ''} — ${table.title}`, subtitle: table.subtitle, columns: table.columns.map(c => ({ header: c.header, type: c.type })), rows, totals }]);
  } else {
    body = buildPdf({ title: table.title, subtitle: table.subtitle, company: [s.company_name, s.company_tin ? `TIN ${s.company_tin}` : ''].filter(Boolean).join(' · '), columns: table.columns, rows, totals, notes: table.notes, accent: s.brand_primary_color });
  }
  ctx.res.writeHead(200, { 'Content-Type': FORMATS[format], 'Content-Disposition': `attachment; filename="${fname}.${format}"`, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  ctx.res.end(body);
  if (userId) logAudit(userId, 'report_exported', 'report', null, { title: table.title, format }, ctx.ip);
}

module.exports = function (router) {
  router.get('/api/reports/catalog', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    ctx.json(200, reports.catalog());
  });

  router.get('/api/reports/run/:key', async (ctx, { key }) => {
    if (!ctx.require('reports.view')) return;
    const params = { ...ctx.query }; const format = params.format || 'json'; delete params.format;
    let t;
    try { t = reports.runReport(key, params); } catch (e) { return ctx.json(e.status || 500, { error: e.message }); }
    if (!t) return ctx.json(404, { error: 'Unknown report' });
    sendTable(ctx, t, format, format === 'json' ? null : ctx.user.id);
  });

  // ---------- builder ----------
  router.get('/api/report-builder/sources', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    ctx.json(200, reports.builderSources());
  });

  router.post('/api/report-builder/run', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    if (!ctx.requireCsrf()) return;
    let t; try { t = reports.runBuilder(ctx.body.definition || ctx.body); } catch (e) { return ctx.json(e.status || 500, { error: e.message }); }
    ctx.json(200, t);
  });

  // Export uses GET so the browser can download directly: definition is base64url JSON in ?d=
  router.get('/api/report-builder/export', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    let def;
    try { def = ctx.query.saved ? JSON.parse(db.prepare('SELECT definition FROM saved_reports WHERE id = ?').get(ctx.query.saved).definition) : JSON.parse(Buffer.from(String(ctx.query.d || ''), 'base64url').toString('utf8')); }
    catch { return ctx.json(400, { error: 'Invalid report definition' }); }
    let t; try { t = reports.runBuilder(def); } catch (e) { return ctx.json(e.status || 500, { error: e.message }); }
    sendTable(ctx, t, ctx.query.format || 'csv', ctx.user.id);
  });

  router.get('/api/saved-reports', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    ctx.json(200, db.prepare(`SELECT s.*, u.full_name as created_by_name FROM saved_reports s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.shared = 1 OR s.created_by = ? ORDER BY s.name`).all(ctx.user.id).map(r => ({ ...r, definition: JSON.parse(r.definition) })));
  });

  router.post('/api/saved-reports', async (ctx) => {
    if (!ctx.require('reports.view')) return;
    if (!ctx.requireCsrf()) return;
    const name = String(ctx.body.name || '').trim(); const def = ctx.body.definition;
    if (def && typeof def === 'object') for (const k of ['columns', 'filters', 'group_by', 'aggregates', 'sort']) if (!Array.isArray(def[k])) def[k] = [];
    if (name.length < 3) return ctx.json(400, { error: 'Give the report a name' });
    try { reports.runBuilder({ ...def, limit: 1 }); } catch (e) { return ctx.json(400, { error: e.message }); }
    const r = db.prepare('INSERT INTO saved_reports (name, source, definition, shared, created_by) VALUES (?, ?, ?, ?, ?)').run(name, def.source, JSON.stringify({ ...def, name }), ctx.body.shared === false ? 0 : 1, ctx.user.id);
    logAudit(ctx.user.id, 'report_saved', 'saved_report', r.lastInsertRowid, { name }, ctx.ip);
    ctx.json(201, { id: r.lastInsertRowid });
  });

  router.put('/api/saved-reports/:id', async (ctx, { id }) => {
    if (!ctx.require('reports.view')) return;
    if (!ctx.requireCsrf()) return;
    const row = db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(id);
    if (!row) return ctx.json(404, { error: 'Not found' });
    if (row.created_by !== ctx.user.id && ctx.user.role_name !== 'Admin') return ctx.json(403, { error: 'Only the author or an admin can change this report' });
    const def = ctx.body.definition || JSON.parse(row.definition); const name = String(ctx.body.name || row.name).trim();
    try { reports.runBuilder({ ...def, limit: 1 }); } catch (e) { return ctx.json(400, { error: e.message }); }
    db.prepare("UPDATE saved_reports SET name = ?, source = ?, definition = ?, updated_at = datetime('now') WHERE id = ?").run(name, def.source, JSON.stringify({ ...def, name }), id);
    ctx.json(200, { ok: true });
  });

  router.del('/api/saved-reports/:id', async (ctx, { id }) => {
    if (!ctx.require('reports.view')) return;
    if (!ctx.requireCsrf()) return;
    const row = db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(id);
    if (!row) return ctx.json(404, { error: 'Not found' });
    if (row.created_by !== ctx.user.id && ctx.user.role_name !== 'Admin') return ctx.json(403, { error: 'Only the author or an admin can delete this report' });
    db.prepare('DELETE FROM saved_reports WHERE id = ?').run(id);
    ctx.json(200, { ok: true });
  });
};

module.exports.sendTable = sendTable;
