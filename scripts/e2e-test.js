// End-to-end test suite.  Usage:  node scripts/e2e-test.js
// 1. Seeds a throw-away database through the real API (scripts/seed-test-data.js — Nexthought rate card)
// 2. Starts the server on it and verifies — independently of the app's own totals — that the ledger, control
//    accounts, tax, NRS e-invoicing, imports, reports & exports, roles, security, white-labelling and backups behave.
// 3. Upgrades a real v1.2.1 database (4-digit chart of accounts) and checks the migration.
// Exit code is non-zero if any check fails.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'medirent-e2e-'));
const PORT = 4330, BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const failures = [];
const T = (name, ok, detail) => { if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : ''}`); } };
const section = (s) => console.log(`\n== ${s}`);
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const sessions = {}; let cur = null;
async function raw(method, p, body, who) {
  const s = sessions[who || cur] || {};
  const h = { 'Content-Type': 'application/json' };
  if (s.cookie) h.cookie = s.cookie; if (s.csrf && method !== 'GET') h['x-csrf-token'] = s.csrf;
  const res = await fetch(BASE + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer()); const text = buf.toString('utf8'); let j = null; try { j = JSON.parse(text); } catch {}
  return { s: res.status, j, text, buf, headers: res.headers };
}
async function login(email, pw) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
  const j = await r.json(); if (!r.ok) return { s: r.status, j };
  sessions[email] = { cookie: r.headers.get('set-cookie').split(';')[0], csrf: j.csrf_token }; cur = email; return { s: r.status, j };
}
const as = (e) => { cur = e; };
const get = (p) => raw('GET', p); const post = (p, b) => raw('POST', p, b || {}); const put = (p, b) => raw('PUT', p, b || {}); const del = (p) => raw('DELETE', p);
const ADMIN = 'admin@medirent.local', APW = 'Admin@12345', PW = 'Welcome@123';
const U = { acct: 'segun.finance@medirent.local', fm: 'kemi.finance@medirent.local', md: 'adaeze.md@medirent.local', ops: 'tunde.ops@medirent.local', dispatch: 'ifeoma.dispatch@medirent.local', sales: 'chiamaka.sales@medirent.local', viewer: 'bola.viewer@medirent.local', auditor: 'femi.audit@medirent.local', tax: 'emeka.tax@medirent.local', maint: 'musa.maintenance@medirent.local', store: 'sade.store@medirent.local', studio: 'yinka.studio@medirent.local' };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  section('Seed (Nexthought rate card + 3 months of trading, through the real API)');
  const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed-test-data.js')], { env: { ...process.env, MEDIRENT_DATA_DIR: DATA_DIR }, encoding: 'utf8', timeout: 1500000 });
  T('seed script completes without error', seed.status === 0, (seed.stderr || '').split('\n').filter(l => !/Warning|trace-warnings/.test(l)).join(' ').slice(0, 400) + seed.stdout.slice(-300));
  if (seed.status !== 0) { console.log(seed.stdout); process.exit(1); }
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(PORT), MEDIRENT_DATA_DIR: DATA_DIR }, stdio: 'ignore' });
  process.on('exit', () => { try { server.kill(); } catch {} });
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  const db = new DatabaseSync(path.join(DATA_DIR, 'medirent.db'), { readOnly: true });
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const q1 = (sql, ...a) => db.prepare(sql).get(...a);
  const bal = (code) => { const r = q1(`SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c FROM journal_lines l JOIN chart_of_accounts a ON a.id=l.account_id WHERE a.code=?`, code); return r2(r.d - r.c); };
  for (const e of [ADMIN, ...Object.values(U)]) await login(e, e === ADMIN ? APW : PW);
  as(ADMIN);

  section('Rate card → catalogue');
  const rc = require('./data/nexthought-rate-card.json');
  const units = q1('SELECT COUNT(*) c FROM equipment').c;
  T(`every rate-card line became equipment (${rc.items.length} lines → ${units} units)`, units === rc.items.reduce((a, i) => a + i.units, 0));
  T('daily rates match the rate card (spot check: ARRI Alexa Mini LF ₦400,000; Broadway studio ₦850,000; Inspire 3 with pilot ₦1.8m)',
    q1("SELECT daily_rate r FROM equipment WHERE name = 'ARRI Alexa Mini LF Body'").r === 400000 && q1("SELECT daily_rate r FROM equipment WHERE name LIKE 'Broadway Studio%'").r === 850000 && q1("SELECT daily_rate r FROM equipment WHERE name LIKE 'Inspire 3%'").r === 1800000);
  T('studio caution fees from the rate card are the default deposit (₦200k Broadway/Olympea, ₦50k West Wing/Makeshift)', q1("SELECT default_deposit d FROM equipment WHERE name LIKE 'Olympea%'").d === 200000 && q1("SELECT default_deposit d FROM equipment WHERE name LIKE 'West Wing%'").d === 50000);
  T('studio hire posts to its own revenue GL (401100)', q1("SELECT income_gl_code g FROM equipment_categories WHERE name='Studio Space'").g === '401100' && q1("SELECT COUNT(*) c FROM invoice_items WHERE gl_code='401100'").c > 0);
  T('items "with operator / pilot" are flagged', q1('SELECT COUNT(*) c FROM equipment WHERE includes_operator = 1').c >= 4);
  T('crew rate card loaded (Steadicam operator ₦200k; unpriced roles = rate on request)', q1("SELECT day_rate d FROM crew_rate_card WHERE role='Steadicam Operator'").d === 200000 && q1("SELECT rate_on_request r FROM crew_rate_card WHERE role='Gaffer'").r === 1);
  T('rate-card cancellation penalty (20%) configured', q1("SELECT value v FROM settings WHERE key='cancellation_fee_pct'").v === '20');
  T('24 equipment categories with prep checklists', q1('SELECT COUNT(*) c FROM equipment_categories').c === 24 && q1("SELECT COUNT(*) c FROM equipment_categories WHERE prep_checklist = '[]'").c === 0);

  section('Chart of accounts — 6-digit');
  T('every GL code is 6 digits', q1("SELECT COUNT(*) c FROM chart_of_accounts WHERE length(code) != 6 OR code GLOB '*[^0-9]*'").c === 0);
  T('class headers present and non-posting', q1("SELECT COUNT(*) c FROM chart_of_accounts WHERE is_header = 1").c === 8 && q1("SELECT COUNT(*) c FROM journal_lines l JOIN chart_of_accounts a ON a.id=l.account_id WHERE a.is_header=1").c === 0);
  T('account type agrees with the code class', q1(`SELECT COUNT(*) c FROM chart_of_accounts WHERE NOT ((substr(code,1,1)='1' AND account_type='asset') OR (substr(code,1,1)='2' AND account_type='liability') OR (substr(code,1,1)='3' AND account_type='equity') OR (substr(code,1,1)='4' AND account_type='income') OR (substr(code,1,1) IN ('5','6','7','8') AND account_type='expense'))`).c === 0);
  as(U.fm);
  let r = await post('/api/accounts', { code: '102200', name: 'Bank — Zenith USD domiciliary', ifrs_line: 'Cash and cash equivalents' }); T('Finance Manager adds a GL account (102200)', r.s === 201, r.text);
  r = await post('/api/accounts', { code: '1022', name: 'Short code' }); T('non-6-digit code rejected', r.s === 400);
  r = await post('/api/accounts', { code: '402000', name: 'Duplicate' }); T('duplicate code rejected (409)', r.s === 409);
  r = await post('/api/accounts', { code: '500000', name: 'Header' }); T('class header code rejected', r.s === 400);
  r = await post('/api/accounts', { code: '419500', name: 'Wrong type', account_type: 'expense' }); T('type must match the code class', r.s === 400);
  r = await put('/api/accounts/111000', { is_active: false }); T('system control account cannot be deactivated', r.s === 400);
  r = await del('/api/accounts/102200'); T('unused custom account can be deleted', r.s === 200);
  r = await del('/api/accounts/401000'); T('system account cannot be deleted', r.s === 400);
  as(U.acct); r = await post('/api/accounts', { code: '699100', name: 'Should fail' }); T('Accountant cannot change the chart (403)', r.s === 403);

  section('Ledger invariants (independent recomputation)');
  const unbal = q(`SELECT e.entry_number, ROUND(SUM(l.debit)-SUM(l.credit),2) diff FROM journal_entries e JOIN journal_lines l ON l.entry_id=e.id GROUP BY e.id HAVING ABS(diff)>0.005`);
  T('every journal entry balances (Dr = Cr)', unbal.length === 0, JSON.stringify(unbal));
  const tbTot = q1('SELECT ROUND(SUM(debit),2) d, ROUND(SUM(credit),2) c FROM journal_lines'); T('trial balance totals agree', near(tbTot.d, tbTot.c), JSON.stringify(tbTot));
  as(ADMIN);
  const bs = (await get('/api/reports/balance-sheet')).j; T('balance sheet balances (A = L + E)', bs.totals.balanced, JSON.stringify(bs.totals));
  const sfp = (await get('/api/reports/run/balance_sheet')).j; T('IFRS statement of financial position balances', sfp.meta && sfp.meta.balanced, JSON.stringify(sfp.meta));
  const openAR = r2(q1("SELECT COALESCE(SUM(grand_total - amount_paid),0) v FROM invoices WHERE status != 'void'").v);
  T('trade receivables 111000 = open invoices incl. migrated legacy items', near(bal('111000'), openAR), `${bal('111000')} vs ${openAR}`);
  const custBal = r2(q1('SELECT SUM(outstanding_balance) v FROM customers').v); T('customer outstanding balances = receivables', near(custBal, openAR));
  const openAP = r2(q1("SELECT COALESCE(SUM(amount + vat_amount),0) v FROM expenses WHERE status = 'pending'").v);
  T('trade payables 201000 = unpaid vendor bills (gross) incl. legacy', near(-bal('201000'), openAP), `${-bal('201000')} vs ${openAP}`);
  const held = r2(q1('SELECT COALESCE(SUM(deposit_received - deposit_applied - deposit_refunded),0) v FROM rental_agreements').v);
  T('deposits held 221000 = deposits received − applied − refunded', near(-bal('221000'), held));
  const whtCr = r2(860000 + q1('SELECT COALESCE(SUM(wht_amount),0) v FROM payments WHERE reversed_at IS NULL').v);
  T('WHT credits 114000 = opening + WHT deducted by customers', near(bal('114000'), whtCr), `${bal('114000')} vs ${whtCr}`);
  const outVat = r2(q1("SELECT COALESCE(SUM(vat_total),0) v FROM invoices WHERE status != 'void' AND is_legacy = 0").v);
  T('output VAT 211000 = VAT on issued invoices (opening VAT remitted)', near(-bal('211000'), outVat), `${-bal('211000')} vs ${outVat}`);
  const inVat = r2(q1("SELECT COALESCE(SUM(input_vat_claimed),0) v FROM expenses WHERE status != 'void'").v);
  T('input VAT 113000 = input VAT claimed on bills', near(bal('113000'), inVat));
  const whtPay = r2(q1("SELECT COALESCE(SUM(wht_amount),0) v FROM expenses WHERE status = 'paid'").v);
  T('WHT payable 212000 = WHT withheld on paid bills (opening remitted)', near(-bal('212000'), whtPay), `${-bal('212000')} vs ${whtPay}`);
  const stock = r2(q1('SELECT SUM(quantity_on_hand * unit_cost) v FROM rental_consumables').v);
  T('consumables inventory 122000 ≈ stock on hand at average cost', Math.abs(bal('122000') - stock) < 5, `${bal('122000')} vs ${stock}`);
  T('spare-parts inventory 121000 = parts on hand at cost', near(bal('121000'), r2(q1('SELECT SUM(quantity_on_hand*unit_cost) v FROM spare_parts').v)));
  const cost = r2(q1('SELECT SUM(purchase_cost) v FROM equipment WHERE disposed_at IS NULL').v);
  T('equipment at cost 151000 = register (written-off unit removed)', near(bal('151000'), cost), `${bal('151000')} vs ${cost}`);
  const accDep = r2(q1("SELECT (SELECT SUM(opening_accumulated_depreciation) FROM equipment WHERE disposed_at IS NULL) + (SELECT COALESCE(SUM(dl.amount),0) FROM depreciation_lines dl JOIN depreciation_runs dr ON dr.id=dl.run_id JOIN equipment e ON e.id=dl.equipment_id WHERE dr.status='posted' AND e.disposed_at IS NULL) v").v);
  T('accumulated depreciation 151900 = register', near(-bal('151900'), accDep, 0.05), `${-bal('151900')} vs ${accDep}`);
  T('unbilled-rental accrual reversed (112000 = 0) and claims receivable settled (117000 = 0)', near(bal('112000'), 0) && near(bal('117000'), 0));

  section('Invoices — tax arithmetic recomputed from the lines');
  const invs = q(`SELECT * FROM invoices WHERE is_legacy = 0`);
  let bad = [];
  for (const i of invs) {
    const L = q('SELECT * FROM invoice_items WHERE invoice_id=?', i.id);
    const net = r2(L.reduce((a, l) => a + l.amount, 0)), vat = r2(L.reduce((a, l) => a + l.vat_amount, 0));
    const vatOk = L.every(l => near(l.vat_amount, r2(l.amount * l.vat_rate / 100)));
    const recov = L.filter(l => l.category === 'recovery').every(l => l.vat_rate === 0);
    if (!near(net, i.subtotal) || !near(vat, i.vat_total) || !near(r2(net + vat), i.grand_total) || !vatOk || !recov) bad.push(i.invoice_number);
  }
  T(`all ${invs.length} invoices foot: lines → net, 7.5% VAT per line, gross; loss/damage recoveries outside VAT`, bad.length === 0, bad.join(','));
  const seqBad = q(`SELECT a.invoice_number FROM invoices a JOIN invoices b ON b.id = a.id + 1 WHERE a.is_legacy = 0 AND b.is_legacy = 0 AND b.issue_date < a.issue_date`);
  T('invoice numbers run in date order (sequential VAT invoicing)', seqBad.length === 0, JSON.stringify(seqBad));
  T('lost lens billed at replacement value, outside VAT (412000)', q1("SELECT COUNT(*) c FROM invoice_items WHERE gl_code='412000' AND vat_rate=0").c === 1);
  T('crew billed as a taxable service (404000)', q1("SELECT COUNT(*) c FROM invoice_items WHERE gl_code='404000' AND vat_rate=7.5").c >= 2);
  const cx = q1("SELECT * FROM invoices WHERE invoice_kind='cancellation'");
  const cxRa = q1('SELECT * FROM rental_agreements WHERE id=?', cx.agreement_id);
  T('cancellation invoiced at the 20% rate-card penalty and booking cancelled', cx && cxRa.status === 'cancelled' && near(cx.subtotal, cxRa.cancellation_fee) && q1("SELECT gl_code g FROM invoice_items WHERE invoice_id=?", cx.id).g === '407000');

  section('NRS e-invoicing (MBS, simulator)');
  const cleared = q("SELECT * FROM invoices WHERE einvoice_status='cleared'");
  T(`${cleared.length} invoices cleared with IRN <invoice-no>-<ServiceID>-<YYYYMMDD>`, cleared.length > 50 && cleared.every(i => new RegExp(`^${i.invoice_number.replace(/[^A-Za-z0-9]/g, '')}-NXTH2026-${i.issue_date.replace(/-/g, '')}$`).test(i.einvoice_irn) && i.einvoice_csid && i.einvoice_qr));
  const rej = q1("SELECT * FROM invoices WHERE einvoice_status='rejected'");
  T('B2B invoice to a buyer with no TIN/address rejected by pre-validation with a clear reason', rej && /Buyer TIN/.test(rej.einvoice_error), rej && rej.einvoice_error);
  T('legacy (migrated) invoices are not submitted', q1("SELECT COUNT(*) c FROM invoices WHERE is_legacy=1 AND einvoice_status='cleared'").c === 0);
  T('every submission is logged', q1('SELECT COUNT(*) c FROM einvoice_submissions').c >= cleared.length * 2);
  as(U.tax);
  r = await raw('GET', `/api/invoices/${cleared[0].id}/einvoice.json`);
  const pl = r.j || {};
  T('MBS payload has the mandatory blocks (business_id, irn, parties with TIN, lines, tax_total, legal_monetary_total)', pl.business_id && pl.irn && pl.accounting_supplier_party.tin && pl.accounting_customer_party.party_name && pl.invoice_line.length && pl.tax_total && pl.legal_monetary_total.payable_amount === cleared[0].grand_total, r.text.slice(0, 200));
  T('payload uses STANDARD_VAT 7.5% and invoice type 380', pl.invoice_type_code === '380' && pl.invoice_line.some(l => l.tax_total[0].tax_subtotal[0].tax_category.id === 'STANDARD_VAT' && l.tax_total[0].tax_subtotal[0].tax_category.percent === 7.5));
  r = await post(`/api/invoices/${rej.id}/einvoice/submit`); T('resubmitting before fixing the customer is rejected again (422)', r.s === 422, r.s);
  as(U.ops); await put(`/api/customers/${rej.customer_id}`, { tin: '23456789-0099', address: '1 Ozumba Mbadiwe', city: 'Lagos', state: 'Lagos' });
  as(U.acct);
  // the invoice snapshots the buyer TIN at issue: void + re-issue is the correct fix; here we check the customer path validates
  const pre = (await post(`/api/invoices/${rej.id}/einvoice/validate`)).j;
  T('pre-validation reports remaining issues precisely', pre && Array.isArray(pre.errors));
  const pending = q1("SELECT * FROM invoices WHERE einvoice_status='not_submitted' AND is_legacy=0 ORDER BY id DESC");
  r = await post(`/api/invoices/${pending.id}/einvoice/submit`); T('pending invoice clears on submit', r.s === 200 && r.j.status === 'cleared', r.text);
  const ph = (await get(`/api/invoices/${pending.id}/print`)).text;
  T('printed invoice shows IRN, CSID and the NRS QR code', ph.includes(r.j.irn) && /<svg[^>]+viewBox/.test(ph) && /CSID/.test(ph));
  as(U.dispatch); r = await post(`/api/invoices/${pending.id}/einvoice/submit`); T('Dispatch cannot submit e-invoices (403)', r.s === 403);
  as(ADMIN); r = await put('/api/admin/settings', { nrs_service_id: 'BAD' }); T('invalid NRS Service ID rejected', r.s === 400);
  r = await put('/api/admin/settings', { nrs_mode: 'live' }); T('live mode refused without APP URL / key / secret', r.s === 400);
  r = await get('/api/admin/settings'); T('APP secrets are never returned to the browser', !('nrs_api_secret' in r.j) && 'nrs_api_secret_set' in r.j);
  r = await get('/api/einvoice/status'); T('readiness checklist reported', r.s === 200 && r.j.readiness.length >= 6);

  section('VAT & WHT working paper');
  const months = q("SELECT DISTINCT substr(issue_date,1,7) m FROM invoices WHERE is_legacy=0 ORDER BY m");
  let taxOk = true;
  for (const { m } of months) {
    const t = (await get('/api/reports/tax?month=' + m)).j;
    const vat = r2(q1("SELECT COALESCE(SUM(vat_total),0) v FROM invoices WHERE status!='void' AND is_legacy=0 AND substr(issue_date,1,7)=?", m).v);
    if (!near(t.output_vat.vat_charged, vat)) taxOk = false;
    const [yy, mm] = m.split('-').map(Number);
    if (t.period.vat_return_due !== new Date(Date.UTC(yy, mm, 21)).toISOString().slice(0, 10)) taxOk = false;
  }
  T('monthly output VAT agrees with invoices; returns due on the 21st of the following month', taxOk);
  const m2 = months[1].m; const t2 = (await get('/api/reports/tax?month=' + m2)).j;
  T('vendor without a TIN suffers doubled WHT (10% services → 20% cap logic)', q1("SELECT COUNT(*) c FROM expenses WHERE vendor_tin IS NULL AND wht_rate >= 10").c >= 1);
  T('fuel (energy product) carries no WHT; rent carries 10%', q1("SELECT MAX(wht_rate) m FROM expenses WHERE category='fuel'").m === 0 && q1("SELECT MIN(wht_rate) m FROM expenses WHERE category='rent'").m === 10);
  T('WHT credit notes tracked on customer payments', t2.wht_deducted_by_customers.total > 0);

  section('Reports & exports');
  const cat = (await get('/api/reports/catalog')).j; T(`${cat.length} standard reports in the catalogue`, cat.length >= 15);
  let exportsOk = true; const broken = [];
  for (const rep of cat) {
    const params = rep.params.some(p => p.key === 'account') ? '?account=102000' : '';
    const j = await get(`/api/reports/run/${rep.key}${params}`);
    if (j.s !== 200 || !Array.isArray(j.j.rows)) { exportsOk = false; broken.push(rep.key + ':json'); continue; }
    for (const f of ['csv', 'xlsx', 'pdf']) {
      const x = await get(`/api/reports/run/${rep.key}${params ? params + '&' : '?'}format=${f}`);
      const sig = f === 'xlsx' ? x.buf.slice(0, 2).toString() === 'PK' : f === 'pdf' ? x.buf.slice(0, 5).toString() === '%PDF-' : x.buf.length > 20;
      if (x.s !== 200 || !sig) { exportsOk = false; broken.push(rep.key + ':' + f); }
    }
  }
  T('every report runs and exports to CSV, Excel (.xlsx) and PDF', exportsOk, broken.join(', '));
  const xl = await get('/api/reports/run/trial_balance?format=xlsx');
  const { readXlsx } = require('../lib/xlsx');
  const sheet = readXlsx(xl.buf);
  T('Excel export re-opens with numeric cells (round-trip)', sheet.length > 10 && typeof sheet[4][3] === 'number', JSON.stringify(sheet[4]));
  const plr = (await get('/api/reports/run/profit_and_loss?from=2000-01-01')).j;
  const plProfit = plr.rows.find(x => x.line === 'PROFIT FOR THE PERIOD').amount;
  const ledgerProfit = r2(q1("SELECT SUM(l.credit - l.debit) v FROM journal_lines l JOIN chart_of_accounts a ON a.id=l.account_id WHERE a.account_type IN ('income','expense')").v);
  T('IFRS profit or loss = ledger income − expenses', near(plProfit, ledgerProfit), `${plProfit} vs ${ledgerProfit}`);
  const ar = (await get('/api/reports/run/ar_aging')).j; T('receivables ageing total = AR control', near(ar.totals.total, bal('111000')), `${ar.totals.total} vs ${bal('111000')}`);
  const far = (await get('/api/reports/run/fixed_asset_register')).j; T('fixed asset register NBV = cost − accumulated depreciation (GL)', near(far.totals.nbv, r2(bal('151000') + bal('151900')), 0.05), `${far.totals.nbv} vs ${bal('151000') + bal('151900')}`);
  r = await get('/api/reports/run/general_ledger?account=999999'); T('general ledger on an unknown account handled', r.s === 200 && r.j.rows.length === 0);
  r = await get('/api/reports/run/vat_schedule?month=2026-13'); T('bad report parameter rejected (400)', r.s === 400);

  section('Report builder');
  r = await post('/api/report-builder/run', { definition: { source: 'invoices', group_by: ['customer'], aggregates: [{ fn: 'sum', field: 'gross' }, { fn: 'count', field: 'invoice_number' }], sort: [{ field: 'sum_gross', dir: 'desc' }] } });
  T('grouped report with totals', r.s === 200 && r.j.rows.length > 3 && r.j.totals && r.j.columns.length === 3, r.text.slice(0, 200));
  r = await post('/api/report-builder/run', { definition: { source: 'journal_lines', columns: ['entry', 'date', 'code', 'debit', 'credit'], filters: [{ field: 'code', op: 'starts', value: '40' }, { field: 'date', op: 'between', value: '2000-01-01', value2: today() }] } });
  T('filtered GL lines (revenue accounts) with drill targets', r.s === 200 && r.j.rows.length > 10 && r.j.rows.every(x => String(x.code).startsWith('40')) && r.j.rows[0]._drill.entry_id);
  r = await post('/api/report-builder/run', { definition: { source: 'invoices', columns: ['invoice_number; DROP TABLE invoices'] } }); T('unknown / injected field names rejected', r.s === 400);
  r = await post('/api/report-builder/run', { definition: { source: 'invoices', filters: [{ field: 'customer', op: 'eq', value: "x' OR '1'='1" }] } }); T('filter values are bound parameters (no injection)', r.s === 200 && r.j.rows.length === 0);
  r = await post('/api/report-builder/run', { definition: { source: 'users' } }); T('non-whitelisted source rejected', r.s === 400);
  const saved = (await get('/api/saved-reports')).j; T('saved reports listed', saved.length >= 2);
  const d = Buffer.from(JSON.stringify(saved[0].definition)).toString('base64url');
  r = await get(`/api/report-builder/export?d=${d}&format=xlsx`); T('builder report exports to Excel', r.s === 200 && r.buf.slice(0, 2).toString() === 'PK');
  r = await get(`/api/report-builder/export?saved=${saved[0].id}&format=pdf`); T('saved report exports to PDF', r.s === 200 && r.buf.slice(0, 5).toString() === '%PDF-');

  section('Legacy data import');
  as(U.fm);
  r = await get('/api/imports/templates/opening_tb.csv'); T('CSV template downloads', r.s === 200 && /account_code,account_name,debit,credit/.test(r.text));
  r = await get('/api/imports/templates/customer_balances.xlsx'); T('Excel template downloads', r.s === 200 && r.buf.slice(0, 2).toString() === 'PK');
  const csv = (rows) => ({ filename: 't.csv', content_base64: Buffer.from(rows.map(x => x.join(',')).join('\n')).toString('base64'), as_of_date: '2026-06-30' });
  r = await post('/api/imports/opening_tb/preview', csv([['account_code', 'debit', 'credit'], ['102000', '100', ''], ['1100', '', '50'], ['999', '1', '']]));
  T('preview flags bad codes, maps legacy 4-digit codes and reports the imbalance', r.s === 200 && r.j.error_rows === 1 && r.j.rows[1].warnings.some(w => /mapped to 111000/.test(w)) && /differ/.test(r.j.blocking), r.text.slice(0, 300));
  r = await post('/api/imports/opening_tb/commit', csv([['account_code', 'debit', 'credit'], ['102000', '100', ''], ['111000', '', '50']])); T('unbalanced opening TB cannot be committed', r.s === 400);
  r = await post('/api/imports/opening_tb/commit', csv([['account_code', 'debit', 'credit'], ['102000', '100', ''], ['301000', '', '100']])); T('a second opening-balance batch needs explicit confirmation (409)', r.s === 409);
  r = await post('/api/imports/opening_tb/commit', { ...csv([['account_code', 'debit', 'credit'], ['102000', '100', ''], ['301000', '', '100']]), as_of_date: '2026-01-31', confirm_additional: true });
  T('…and is refused inside the locked period', r.s === 400 && /locked/.test(r.j.error), r.text);
  const { buildXlsx } = require('../lib/xlsx');
  const xbuf = buildXlsx([{ name: 'S', columns: ['customer_name', 'invoice_no', 'invoice_date', 'amount_outstanding'].map(h => ({ header: h, type: 'text' })), rows: [['Lagoon Pictures Ltd', 'XL-1', '30/06/2026', '10,000.00']] }]);
  r = await post('/api/imports/customer_balances/preview', { filename: 'ar.xlsx', content_base64: xbuf.toString('base64'), as_of_date: '2026-06-30' });
  T('Excel upload parsed (DD/MM/YYYY dates and ₦ formatted amounts understood)', r.s === 200 && r.j.ok_rows === 1 && r.j.rows[0].data.idate === '2026-06-30' && r.j.rows[0].data.amt === 10000, r.text.slice(0, 300));
  const batches = (await get('/api/imports')).j; T('import history shows every batch with its journal', batches.length >= 6 && batches.some(b => b.kind === 'opening_tb' && b.entry_number));
  as(U.acct); r = await get('/api/imports'); T('Accountant cannot import legacy data (403)', r.s === 403);

  section('Manual journals, period-end and period lock');
  as(U.acct);
  r = await post('/api/manual-journals', { entry_date: today(), memo: 'Unbalanced test', lines: [{ code: '609000', debit: 100 }, { code: '102000', credit: 90 }] }); T('unbalanced manual journal rejected', r.s === 400);
  r = await post('/api/manual-journals', { entry_date: today(), memo: 'Header test', lines: [{ code: '600000', debit: 100 }, { code: '102000', credit: 100 }] }); T('posting to a header account rejected', r.s === 400);
  const mj = await post('/api/manual-journals', { entry_date: today(), memo: 'Petty cash top-up from bank', lines: [{ code: '101000', debit: 50000 }, { code: '102000', credit: 50000 }] });
  T('Accountant drafts a manual journal (pending, nothing posted)', mj.s === 201 && !q1('SELECT journal_entry_id j FROM manual_journals WHERE id=?', mj.j.id).j);
  r = await post(`/api/manual-journals/${mj.j.id}/decide`, { decision: 'approved' }); T('maker cannot approve own journal', r.s === 403);
  as(U.fm); r = await post(`/api/manual-journals/${mj.j.id}/decide`, { decision: 'approved' }); T('Finance Manager approves → posted', r.s === 200 && /^JE-/.test(r.j.entry_number));
  const lock = q1("SELECT value v FROM settings WHERE key='books_locked_until'").v;
  T('books locked to the end of the month before last', /^\d{4}-\d{2}-\d{2}$/.test(lock));
  as(U.acct); const someOpen = q1("SELECT id FROM invoices WHERE status IN ('unpaid','partial') AND is_legacy=0 ORDER BY id DESC");
  r = await post('/api/payments', { invoice_id: someOpen.id, amount: 1, received_on: lock }); T('posting into a locked period is refused', r.s === 400 && /locked/i.test(r.j.error), r.text);
  as(U.fm);
  const lastDep = q1("SELECT period FROM depreciation_runs WHERE status='posted' ORDER BY period DESC").period;
  r = await post('/api/accounting/depreciation/run', { period: lastDep }); T('depreciation cannot be run twice for a month (409)', r.s === 409);
  r = await post('/api/accounting/depreciation/run', { period: '2099-01' }); T('future-month depreciation refused', r.s === 400);
  const prev = (await get(`/api/accounting/depreciation?period=${today().slice(0, 7)}`)).j.preview;
  const lf = q1("SELECT * FROM equipment WHERE name='ARRI Alexa Mini LF Body'"); const lfl = prev.lines.find(l => l.equipment_id === lf.id);
  T('monthly straight-line charge = (cost − residual) ÷ (life × 12)', lfl && near(lfl.amount, r2((lf.purchase_cost - lf.salvage_value) / (lf.useful_life_years * 12))), JSON.stringify(lfl));
  T('studio space (not owned PPE) is not depreciated', !prev.lines.some(l => /^(Broadway|Olympea|West Wing|Makeshift|All Blacklot)/.test(l.name)));
  T('written-off asset not depreciated after disposal', !prev.lines.some(l => l.name === 'Sigma 50mm'));
  const tp = (await get('/api/accounting/tax-provision')).j;
  T('tax provision: CIT 30% + development levy 4% on assessable profit (medium/large company)', !tp.small_company && near(tp.cit, r2(tp.assessable_profit * 0.30)) && near(tp.dev_levy, r2(tp.assessable_profit * 0.04)), JSON.stringify({ a: tp.assessable_profit, c: tp.cit, d: tp.dev_levy }));
  T('accounting status summarises the close', (await get('/api/accounting/status')).j.books_locked_until === lock);

  section('Operations: availability, cancellation, photos, claims, write-off, capitalisation, agreements');
  as(U.ops);
  r = await get(`/api/equipment-availability?start_date=${addDays(400)}&end_date=${addDays(402)}`);
  const busyNow = q1("SELECT COUNT(DISTINCT ai.equipment_id) c FROM agreement_items ai JOIN rental_agreements ra ON ra.id=ai.agreement_id WHERE ai.checkin_at IS NULL AND ra.status IN ('active','overdue','dispatched')").c;
  const rentable = q1("SELECT COUNT(*) c FROM equipment WHERE status NOT IN ('retired','lost') AND disposed_at IS NULL").c;
  T('regression: availability returns every free unit (only units still out are excluded)', r.s === 200 && r.j.length === rentable - busyNow, `${r.j && r.j.length} vs ${rentable - busyNow}`);
  const onHire = q1("SELECT ra.id, ai.equipment_id FROM rental_agreements ra JOIN agreement_items ai ON ai.agreement_id=ra.id WHERE ra.status='active' AND ai.checkin_at IS NULL LIMIT 1");
  const lagoon = q1("SELECT id FROM customers WHERE full_name='Lagoon Pictures Ltd'").id;
  r = await post('/api/agreements', { customer_id: lagoon, start_date: today(), expected_return_date: addDays(1), items: [{ equipment_id: onHire.equipment_id }] });
  T('overlapping booking of a unit on hire rejected (409)', r.s === 409 && /not available/i.test(r.j.error), r.text);
  const broadway = q1("SELECT id FROM equipment WHERE name LIKE 'Broadway Studio%'").id;
  const sb = await post('/api/agreements', { customer_id: lagoon, start_date: addDays(30), expected_return_date: addDays(31), items: [{ equipment_id: broadway }] });
  T('studio booking picks up the ₦200k caution fee automatically', sb.s === 201 && q1('SELECT deposit_amount d FROM rental_agreements WHERE id=?', sb.j.id).d === 200000);
  const det = (await get(`/api/agreements/${sb.j.id}`)).j;
  T('booking shows its value and the 20% cancellation policy', det.estimated_value === 850000 && det.cancellation_fee_pct === 20);
  r = await put(`/api/agreements/${sb.j.id}/cancel`, { waive_fee: true }); T('waiving the fee needs a reason', r.s === 400);
  r = await put(`/api/agreements/${sb.j.id}/cancel`, {});
  T('cancellation raises a 20% fee invoice (₦170,000 + VAT)', r.s === 200 && near(r.j.cancellation_fee, 170000) && near(r.j.invoice.grand_total, 182750), r.text);
  r = await get(`/api/agreements/${sb.j.id}/print`); T('printable rental agreement (terms, replacement values, signatures)', r.s === 200 && /RENTAL AGREEMENT/.test(r.text) && /20% charge/.test(r.text));
  r = await get(`/api/agreements/${sb.j.id}/agreement.pdf`); T('rental agreement downloads as PDF', r.s === 200 && r.buf.slice(0, 5).toString() === '%PDF-');
  as(U.dispatch);
  const item = q1('SELECT id FROM agreement_items WHERE agreement_id=?', onHire.id).id;
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await post('/api/photos', { entity_type: 'agreement_item', entity_id: item, stage: 'checkout', data_url: PNG }); T('dispatch uploads a condition photo', r.s === 201);
  r = await raw('GET', `/api/photos/${r.j.id}/raw`); T('photo served back as an image', r.s === 200 && r.headers.get('content-type') === 'image/png');
  r = await post('/api/photos', { entity_type: 'agreement_item', entity_id: item, data_url: 'data:text/html;base64,PGgxPg==' }); T('non-image upload rejected', r.s === 400);
  T('seeded condition/damage photos present', q1("SELECT COUNT(*) c FROM photos WHERE entity_type='agreement_item'").c > 5);
  const claim = q1("SELECT * FROM insurance_claims LIMIT 1");
  T('insurance claim settled: receivable booked on approval, cleared on settlement', claim.status === 'settled' && q1("SELECT COUNT(*) c FROM journal_entries WHERE source_type='claim' AND source_id=?", claim.id).c === 2);
  const lens = q1('SELECT * FROM equipment WHERE id=?', claim.equipment_id);
  T('stolen lens derecognised (IAS 16): retired, cost & acc. dep. removed, loss to 702000', lens.status === 'retired' && lens.disposed_at && q1("SELECT COUNT(*) c FROM journal_entries WHERE source_type='write_off' AND source_id=?", lens.id).c === 1 && bal('702000') > 0);
  as(U.fm); r = await post(`/api/equipment/${lens.id}/write-off`, { reason: 'second write off' }); T('cannot write off twice', r.s === 400);
  as(U.ops); const neq = await post('/api/equipment', { name: 'Test DJI RS 4 Pro', daily_rate: 65000, purchase_cost: 1200000, replacement_value: 1450000, purchase_date: today() });
  T('Operations adds equipment (no capitalisation rights needed)', neq.s === 201);
  r = await post('/api/equipment', { name: 'Should fail', purchase_cost: 1000, capitalise: 'bill' }); T('capitalising requires Finance (journals.edit) (403)', r.s === 403);
  as(U.fm); r = await post(`/api/equipment/${neq.j.id}/capitalise`, { method: 'bill', vendor_name: 'Camera Store NG', vendor_invoice_no: 'CS-1', vat_applies: true });
  T('Finance capitalises it via a supplier bill (Dr 151000 + input VAT / Cr payables)', r.s === 201 && r.j.bill && q1('SELECT gl_code g FROM expenses WHERE id=?', r.j.bill.id).g === '151000');
  r = await post(`/api/equipment/${neq.j.id}/capitalise`, { method: 'cash' }); T('cannot capitalise twice (409)', r.s === 409);
  as(U.ops); const locs = (await get('/api/locations')).j;
  r = await post(`/api/equipment/${neq.j.id}/transfer`, { to_location_id: locs.find(l => l.code === 'IKJ').id, notes: 'Satellite stock' }); T('unit transferred between locations (logged)', r.s === 200 && (await get(`/api/equipment/${neq.j.id}/transfers`)).j.length === 1);
  r = await post(`/api/equipment/${onHire.equipment_id}/transfer`, { to_location_id: locs[0].id }); T('a unit on hire cannot be transferred', r.s === 400);

  section('Regression: defects found in earlier QC stay fixed');
  as(U.ops);
  const live = q1("SELECT * FROM rental_agreements WHERE status='active' ORDER BY id DESC");
  const cons = q1("SELECT id FROM rental_consumables LIMIT 1").id;
  r = await post(`/api/agreements/${live.id}/consumables`, { consumable_id: cons, qty: -5 }); T('negative consumable quantity rejected', r.s === 400);
  r = await post('/api/agreements', { customer_id: lagoon, start_date: addDays(40), expected_return_date: addDays(38), items: [{ equipment_id: neq.j.id }] }); T('return date before start rejected', r.s === 400);
  r = await post('/api/agreements', { customer_id: lagoon, start_date: addDays(40), expected_return_date: addDays(41), items: [{ equipment_id: lens.id }] }); T('retired / written-off unit cannot be booked', r.s === 400);
  const ld = (await get(`/api/agreements/${live.id}`)).j;
  r = await post(`/api/agreements/${live.id}/checkout/${ld.items[0].id}`, { condition: 'x', checklist: [] }); T('double checkout rejected', r.s === 400);
  const ret = q1("SELECT * FROM rental_agreements WHERE status='returned' ORDER BY id LIMIT 1"); const rd = (await get(`/api/agreements/${ret.id}`)).j;
  r = await post(`/api/agreements/${ret.id}/checkin/${rd.items[0].id}`, { condition: 'x' }); T('double check-in rejected', r.s === 400);
  r = await post(`/api/agreements/${live.id}/checkout/${rd.items[0].id}`, { condition: 'x' }); T('cannot touch an item from a different booking', r.s === 404);
  r = await put(`/api/agreements/${ret.id}/cancel`); T('cannot cancel a returned booking', r.s === 400);
  as(U.acct);
  r = await post(`/api/invoices/generate/${ret.id}`); T('second live invoice for the same booking rejected (409)', r.s === 409);
  const open = q1(`SELECT * FROM invoices WHERE status IN ('unpaid','partial') AND is_legacy=0 ORDER BY id LIMIT 1`);
  r = await post('/api/payments', { invoice_id: open.id, amount: -500 }); T('negative payment rejected', r.s === 400);
  r = await post('/api/payments', { invoice_id: open.id, amount: 999999999 }); T('overpayment rejected', r.s === 400 && /exceeds/.test(r.j.error));
  r = await post('/api/payments', { invoice_id: open.id, amount: 100, method: 'bitcoin' }); T('unknown payment method rejected', r.s === 400);
  r = await post('/api/payments', { invoice_id: open.id, amount: 100, wht_amount: 99999999 }); T('WHT above the statutory maximum rejected', r.s === 400);
  r = await post('/api/payments', { invoice_id: open.id, amount: 100, deposit_to: '401000' }); T('receipt into a non-cash account rejected', r.s === 400);
  r = await post(`/api/invoices/${open.id}/void`, { reason: 'x' }); T('void requires a proper reason', r.s === 400);
  const paidInv = q1(`SELECT * FROM invoices WHERE status='paid' AND is_legacy=0 ORDER BY id LIMIT 1`);
  r = await post(`/api/invoices/${paidInv.id}/void`, { reason: 'testing void of paid invoice' }); T('cannot void an invoice that has payments', r.s === 400);
  r = await post(`/api/invoices/generate/${q1("SELECT id FROM rental_agreements WHERE status='returned' AND id NOT IN (SELECT agreement_id FROM invoices WHERE agreement_id IS NOT NULL AND status!='void') LIMIT 1")?.id || 0}`, { issue_date: '2020-01-01' });
  T('back-dating an invoice before the last issued one is refused', r.s === 400 || r.s === 404);
  as(ADMIN);
  r = await post('/api/admin/users', { full_name: 'T', email: ADMIN, role_id: 2, password: 'Abcdefghi1' }); T('duplicate user email → clean 409', r.s === 409 && !/UNIQUE/.test(r.j.error));
  r = await post('/api/admin/users', { full_name: 'T', email: 'weak@x.com', role_id: 2, password: 'abc' }); T('weak password rejected', r.s === 400);
  as(U.ops);
  r = await post('/api/customers', { full_name: 'Bad TIN Ltd', tin: '123' }); T('invalid customer TIN rejected', r.s === 400);
  r = await post('/api/customers', { full_name: 'Bad Mail', email: 'nope' }); T('invalid customer email rejected', r.s === 400);

  section('Roles & segregation of duties');
  const roleOf = (e) => q1('SELECT r.name n FROM users u JOIN roles r ON r.id=u.role_id WHERE u.email=?', e).n;
  T('existing users re-assigned: Segun → Accountant (maker), Kemi → Finance Manager (checker)', roleOf(U.acct) === 'Accountant' && roleOf(U.fm) === 'Finance Manager');
  T('new users added for MD, tax, stores, studio and audit', roleOf(U.md) === 'Managing Director' && roleOf(U.tax) === 'Tax & Compliance Officer' && roleOf(U.store) === 'Store Keeper' && roleOf(U.studio) === 'Studio Manager' && roleOf(U.auditor) === 'Auditor');
  T('vouchers seeded at every stage (pending L1, pending L2, rejected, paid)', q1("SELECT COUNT(DISTINCT status || current_level) c FROM payment_vouchers").c >= 4);
  as(U.acct); const exp = await post('/api/expenses', { category: 'office', amount: 10000, vendor_name: 'Stationery Hub', vendor_tin: '34567890-0010', vendor_invoice_no: 'SH-1', description: 'SoD test', vat_applies: true });
  T('bill posts immediately (accrual basis): Dr 608000 + input VAT / Cr payables', exp.s === 201 && q1("SELECT COUNT(*) c FROM journal_entries WHERE source_type='expense' AND source_id=?", exp.j.id).c === 1);
  const pv = (await post('/api/vouchers', { linked_expense_id: exp.j.id })).j;
  r = await post(`/api/vouchers/${pv.id}/decide`, { decision: 'approved' }); T('Accountant cannot approve (no permission / raiser)', r.s === 403);
  as(U.md); r = await post(`/api/vouchers/${pv.id}/decide`, { decision: 'approved' }); T('MD cannot give level-1 approval', r.s === 403);
  as(U.fm); r = await post(`/api/vouchers/${pv.id}/decide`, { decision: 'approved' }); T('Finance Manager gives level-1 approval', r.s === 200);
  r = await post(`/api/vouchers/${pv.id}/decide`, { decision: 'approved' }); T('Finance Manager cannot also give level 2', r.s === 403);
  as(U.md); r = await post(`/api/vouchers/${pv.id}/decide`, { decision: 'approved', payment_date: today() }); T('MD gives final approval → paid & posted (Dr payables / Cr bank)', r.s === 200 && q1('SELECT status s FROM expenses WHERE id=?', exp.j.id).s === 'paid');
  as(U.sales); r = await post('/api/agreements', { customer_id: lagoon, start_date: addDays(50), expected_return_date: addDays(51), items: [{ equipment_id: neq.j.id }] }); T('Sales can create bookings', r.s === 201, r.text);
  r = await post(`/api/agreements/${r.j.id}/checkout/1`, {}); T('Sales cannot dispatch (403)', r.s === 403);
  as(U.dispatch); const dd = (await get('/api/dashboard/summary')).j; T('Dispatch dashboard hides finance figures', !dd.sections.finance && dd.sections.bookings && dd.sections.fleet);
  as(U.auditor); r = await get('/api/admin/audit-log'); T('Auditor reads the audit trail', r.s === 200);
  r = await post('/api/customers', { full_name: 'Nope' }); T('Auditor is read-only (403)', r.s === 403);
  as(U.viewer); r = await get('/api/admin/users'); T('Viewer cannot read admin data (403)', r.s === 403);
  as(ADMIN); const roles = (await get('/api/admin/roles')).j;
  r = await post('/api/admin/roles', { name: 'Bookings clerk', permissions: ['rentals.view', 'rentals.edit', 'customers.view'] }); T('custom role created', r.s === 201);
  r = await post('/api/admin/roles', { name: 'Evil', permissions: ['*'] }); T('custom role cannot be granted full access', r.s === 400);
  r = await put(`/api/admin/roles/${roles.find(x => x.name === 'Admin').id}`, { permissions: [] }); T('Admin role cannot be changed', r.s === 400);
  r = await del(`/api/admin/roles/${roles.find(x => x.name === 'Accountant').id}`); T('built-in role cannot be deleted', r.s === 400);

  section('Dashboard drill-through data');
  as(ADMIN); const dash = (await get('/api/dashboard/summary')).j; const F = dash.sections.finance;
  T('revenue YTD equals the ledger revenue lines', near(F.revenue_ytd, r2(q1(`SELECT SUM(l.credit - l.debit) v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN chart_of_accounts a ON a.id=l.account_id WHERE a.ifrs_line LIKE 'Revenue%' AND e.entry_date >= ?`, F.year_start).v)));
  T('cash tile = sum of cash & bank accounts', near(F.cash_total, r2(['101000', '102000', '102100'].reduce((a, c) => a + bal(c), 0))));
  T('receivables tile = AR control; ageing buckets add up', near(F.receivables, bal('111000')) && near(Object.values(F.aging).reduce((a, b) => a + b, 0), F.receivables));
  T('12-month trend, top customers/equipment, revenue mix and tasks present', F.trend.length === 12 && F.top_customers.length && F.top_equipment.length && F.revenue_mix.length && dash.sections.tasks.pending_vouchers >= 1);
  T('fleet & bookings figures match the database', dash.sections.fleet.by_status.on_rent === q1("SELECT COUNT(*) c FROM equipment WHERE status='on_rent'").c && dash.sections.bookings.overdue === q1("SELECT COUNT(*) c FROM rental_agreements WHERE status='overdue'").c);

  section('Access control & sessions');
  r = await raw('POST', '/api/customers', { full_name: 'x' }, 'nobody'); T('unauthenticated request → 401', r.s === 401);
  r = await fetch(BASE + '/api/customers', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: sessions[ADMIN].cookie }, body: JSON.stringify({ full_name: 'csrf' }) }); T('missing CSRF token rejected (403)', r.status === 403);
  const users = (await get('/api/admin/users')).j; const musa = users.find(u => u.email.startsWith('musa'));
  await put(`/api/admin/users/${musa.id}`, { status: 'suspended' });
  r = await raw('GET', '/api/maintenance/work-orders', undefined, U.maint); T('suspended user’s session stops working immediately', r.s === 401);
  r = await put(`/api/admin/users/${users.find(u => u.email === ADMIN).id}`, { status: 'suspended' }); T('admin cannot suspend themselves / the last admin', r.s === 400);
  r = await put(`/api/admin/users/${users.find(u => u.email === U.viewer).id}`, { role_id: roles.find(x => x.name === 'Auditor').id, title: 'Board observer' }); T('admin re-assigns a user’s role', r.s === 200 && roleOf(U.viewer) === 'Auditor');
  await login(U.store, PW);
  r = await post('/api/auth/change-password', { new_password: 'NewPassw0rdX' }); T('password change requires the current password', r.s === 400);
  r = await post('/api/auth/change-password', { current_password: PW, new_password: 'NewPassw0rdX' }); T('password change with correct current password works', r.s === 200);
  let lastL; for (let i = 0; i < 6; i++) lastL = await login(U.ops, 'wrongpass' + i);
  T('account locks after repeated failed logins (429)', lastL.s === 429);
  const h = (await fetch(BASE + '/')).headers;
  T('security headers present (CSP, X-Frame-Options, nosniff)', !!h.get('content-security-policy') && h.get('x-frame-options') === 'DENY' && h.get('x-content-type-options') === 'nosniff');
  r = await fetch(BASE + '/..%2f..%2fetc/passwd'); T('path traversal blocked', r.status !== 200);
  for (const f of ['app.js', 'ext-core.js', 'ext-dashboard.js', 'ext-ops.js', 'ext-finance.js', 'main.js']) { r = await fetch(BASE + '/js/' + f); if (r.status !== 200) T('static front-end served: ' + f, false); }
  T('all front-end modules served', true);

  section('Tax settings & white-label');
  as(ADMIN);
  r = await put('/api/admin/settings', { vat_rate: '150' }); T('absurd VAT rate rejected', r.s === 400);
  r = await put('/api/admin/settings', { pv_level2_roles: 'Nobody' }); T('unknown role in approval levels rejected', r.s === 400);
  r = await put('/api/admin/settings', { cit_rate: '101' }); T('CIT rate bounds enforced', r.s === 400);
  r = await get('/api/branding'); T('Nexthought branding (name, yellow, logo) is public for the login page', r.j.portal_name === 'Nexthought' && r.j.primary_color === '#F8D800' && r.j.has_logo);
  const ph2 = (await get(`/api/invoices/${paidInv.id}/print`)).text;
  T('printed invoice: TAX INVOICE, logo, dark text on the yellow header', /TAX INVOICE/.test(ph2) && /data:image\/png;base64/.test(ph2) && /background:#F8D800;color:#111111/.test(ph2));
  as(U.acct); r = await put('/api/admin/settings', { brand_primary_color: '#000000' }); T('non-admin cannot change branding', r.s === 403);

  section('Backup & restore');
  as(ADMIN);
  r = await post('/api/system/backups', { label: 'e2e' }); T('backup created', r.s === 201);
  const list = (await get('/api/system/backups')).j.backups; T('backup listed', list.length >= 1);
  const health = (await get('/api/system/health')).j; T('integrity check OK', health.database.integrity.ok === true);
  r = await post(`/api/system/backups/${encodeURIComponent(list[0].filename)}/restore`); T('restore works', r.s === 200, r.text);

  section('Upgrade of a v1.2.1 database (4-digit chart of accounts)');
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirent-mig-'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'v1.2.1-sample.db'), path.join(mdir, 'medirent.db'));
  const before = new DatabaseSync(path.join(mdir, 'medirent.db'), { readOnly: true });
  const tbBefore = before.prepare("SELECT a.code, ROUND(SUM(l.debit-l.credit),2) b FROM journal_lines l JOIN chart_of_accounts a ON a.id=l.account_id GROUP BY a.id").all(); before.close();
  const mig = spawnSync(process.execPath, ['-e', "require('./lib/db').init(); const {db}=require('./lib/db'); console.log(JSON.stringify({ short: db.prepare('SELECT COUNT(*) c FROM chart_of_accounts WHERE length(code)!=6').get().c, tb: db.prepare('SELECT a.code, ROUND(SUM(l.debit-l.credit),2) b FROM journal_lines l JOIN chart_of_accounts a ON a.id=l.account_id GROUP BY a.id').all(), fin: db.prepare(\"SELECT u.email, r.name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.email LIKE '%finance%'\").all() }))"], { cwd: ROOT, env: { ...process.env, MEDIRENT_DATA_DIR: mdir }, encoding: 'utf8' });
  let mj2 = {}; try { mj2 = JSON.parse(mig.stdout.trim().split('\n').pop()); } catch {}
  T('all legacy 4-digit codes renumbered to 6 digits', mj2.short === 0, mig.stderr.slice(0, 300));
  const map = require('../lib/coa').LEGACY_MAP;
  T('every balance carried to its new 6-digit account unchanged', tbBefore.every(b => { const n = (mj2.tb || []).find(x => x.code === (map[b.code] || b.code)); return n && near(n.b, b.b); }), JSON.stringify(tbBefore.slice(0, 3)));
  T('legacy Finance users split into Finance Manager (approver) and Accountant (maker)', (mj2.fin || []).some(u => u.name === 'Finance Manager') && (mj2.fin || []).some(u => u.name === 'Accountant'), JSON.stringify(mj2.fin));
  try { fs.rmSync(mdir, { recursive: true, force: true }); } catch {}

  console.log(`\n==================================\n${pass} passed, ${fail} failed`);
  if (fail) console.log('Failed:\n - ' + failures.join('\n - '));
  server.kill(); try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
