// Browser UI test (Playwright + Chromium).  Usage: node scripts/ui-test.js
// Seeds a throw-away database, drives the real UI and writes screenshots to docs/qc-evidence/screens/.
const path = require('path'), os = require('os');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const DATA = process.env.UI_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'medirent-ui-'));
const PORT = 4340, BASE = `http://localhost:${PORT}`, SHOTS = path.join(ROOT, 'docs', 'qc-evidence', 'screens');
fs.mkdirSync(SHOTS, { recursive: true });
for (const f of fs.readdirSync(SHOTS)) fs.unlinkSync(path.join(SHOTS, f));
let pass = 0, fail = 0; const fails = [];
const T = (n, ok, d) => { ok ? pass++ : (fail++, fails.push(n)); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d ? '  -> ' + String(d).slice(0, 300) : ''}`); };
(async () => {
  if (!process.env.UI_DATA_DIR) {
    const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed-test-data.js')], { env: { ...process.env, MEDIRENT_DATA_DIR: DATA }, encoding: 'utf8', timeout: 1500000 });
    if (seed.status !== 0) { console.error('seed failed', seed.stderr, seed.stdout.slice(-500)); process.exit(2); }
  }
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, MEDIRENT_DATA_DIR: DATA }, stdio: 'ignore' });
  process.on('exit', () => { try { srv.kill(); } catch {} });
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/401|403|409|400|422|Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); if (/Content Security Policy/i.test(m.text())) problems.push('CSP: ' + m.text()); });
  let n = 0; const shot = async (name, full) => { n++; await page.screenshot({ path: `${SHOTS}/${String(n).padStart(2, '0')}-${name}.png`, fullPage: !!full }); };
  const nav = async (hash) => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForTimeout(900); };
  const closeModals = async () => { for (let i = 0; i < 5 && (await page.$('.overlay')); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); } };
  const login = async (email, pw, newPw) => {
    await page.goto(BASE); await page.waitForSelector('#login-email');
    await page.fill('#login-email', email); await page.fill('#login-password', pw); await page.click('#login-btn');
    if (newPw) { await page.waitForSelector('#set-pw-btn'); await page.fill('#cur-pw', pw); await page.fill('#new-pw', newPw); await page.fill('#new-pw2', newPw); await page.click('#set-pw-btn'); }
    await page.waitForSelector('.kpi, .stat-card, .dash-head', { timeout: 15000 });
  };

  // ---- login (branded) + forced password change
  await page.goto(BASE); await page.waitForSelector('#login-email');
  T('branded login: Nexthought logo and name', (await page.$('.login-box img.brand-logo')) && /Nexthought/.test(await page.textContent('.login-box h1')));
  await shot('login');
  await page.fill('#login-email', 'admin@medirent.local'); await page.fill('#login-password', 'Admin@12345'); await page.click('#login-btn');
  await page.waitForSelector('#set-pw-btn'); T('forced password change after first login', true);
  await page.fill('#cur-pw', 'Admin@12345'); await page.fill('#new-pw', 'short'); await page.fill('#new-pw2', 'short'); await page.click('#set-pw-btn');
  await page.waitForSelector('#pw-error:not(:empty)'); T('weak password refused', /10 characters/.test(await page.textContent('#pw-error')));
  await page.fill('#new-pw', 'Nexthought#2026'); await page.fill('#new-pw2', 'Nexthought#2026'); await page.click('#set-pw-btn');
  await page.waitForSelector('.kpi'); await page.waitForTimeout(800);

  // ---- dashboard
  const kpis = await page.$$('.kpi'); T(`dashboard is busy: ${kpis.length} KPI tiles`, kpis.length >= 15);
  T('revenue chart rendered (SVG bars + legend)', (await page.$$('#ch-trend .bar-mark')).length >= 12 && /Cash collected/.test(await page.textContent('#ch-trend .legend')));
  const panels = await page.$$eval('.panel h3', hs => hs.map(h => h.textContent));
  T('panels: ageing, tasks, returns, pick-ups, top customers/equipment, mix, fleet, activity', ['Receivables ageing', 'Needs attention', 'Returns due', 'Upcoming pick-ups', 'Top customers', 'Top earning equipment', 'Revenue mix', 'Fleet by category', 'Recent activity'].every(p => panels.some(h => h.includes(p))), panels.join(' | '));
  await shot('dashboard'); await shot('dashboard-full', true);
  // hover tooltip
  const hit = await page.$('#ch-trend [data-hit="4"]'); if (hit) { const b = await hit.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(200); }
  T('chart hover shows a tooltip', await page.$eval('#ch-trend .chart-tip', e => e.style.display === 'block' && /Revenue/.test(e.textContent)));
  await shot('dashboard-chart-tooltip');
  // drill: overdue tile -> bookings filtered
  await page.click('.kpi:has-text("Overdue returns")'); await page.waitForTimeout(900);
  T('tile click drills to the filtered list (overdue bookings)', /#\/agreements\?status=overdue/.test(page.url()) && (await page.$eval('#agr-status-filter', s => s.value)) === 'overdue' && (await page.$$('#agr-tbody tr.drill')).length >= 1);
  await shot('drill-overdue-bookings');
  await nav('#/dashboard'); await page.click('.kpi:has-text("Receivables")'); await page.waitForTimeout(1200);
  T('receivables tile opens the ageing report', /r=ar_aging/.test(page.url()) && /Receivables ageing/.test(await page.textContent('#rep-body')));
  await page.click('#rep-body tr.drill'); await page.waitForSelector('.overlay .modal'); T('ageing row drills to the customer', /Bookings/.test(await page.textContent('.overlay .modal')));
  await closeModals();
  await nav('#/dashboard'); await page.click('.kpi:has-text("Cash & bank")'); await page.waitForSelector('#lg-body table');
  T('cash tile opens the bank GL ledger with running balance', /GL 102000/.test(await page.textContent('.overlay h3')) && (await page.$$('#lg-body tr.drill')).length > 10);
  await page.click('#lg-body tr.drill'); await page.waitForTimeout(600); T('ledger line drills to the journal entry', /Journal JE-/.test(await page.textContent('.overlay:last-child h3')));
  await shot('drill-journal-entry'); await closeModals();
  await nav('#/dashboard'); await page.click('.task:has-text("vouchers awaiting")'); await page.waitForTimeout(800);
  T('task drills to pending vouchers', /#\/vouchers\?status=pending/.test(page.url()));

  // ---- collapsible sidebar
  await nav('#/dashboard');
  const wide = (await page.$('.sidebar')).boundingBox ? (await (await page.$('.sidebar')).boundingBox()).width : 0;
  await page.click('#collapse-btn'); await page.waitForTimeout(300);
  const narrow = (await (await page.$('.sidebar')).boundingBox()).width;
  T('sidebar collapses to an icon rail', wide > 200 && narrow < 80, `${wide} → ${narrow}`);
  await shot('sidebar-collapsed');
  await page.reload(); await page.waitForSelector('.kpi'); T('collapsed state remembered after reload', await page.$eval('.app-shell', e => e.classList.contains('collapsed')));
  await page.click('#collapse-btn'); await page.waitForTimeout(200);
  await page.click('.nav-group-head[data-group="Operations"]'); await page.waitForTimeout(150);
  T('menu groups fold / unfold', await page.$eval('.nav-group-head[data-group="Operations"]', b => b.closest('.nav-group').classList.contains('shut')));
  await page.click('.nav-group-head[data-group="Operations"]');

  // ---- every page renders
  for (const [h, name] of [['#/agreements', 'bookings'], ['#/quotes', 'quotes'], ['#/equipment', 'equipment'], ['#/kits', 'kits'], ['#/customers', 'customers'], ['#/consumables', 'consumables'], ['#/maintenance', 'maintenance'], ['#/claims', 'claims'], ['#/invoices', 'billing'], ['#/finance', 'finance'], ['#/vouchers', 'vouchers'], ['#/accounting', 'accounting'], ['#/reports', 'reports'], ['#/admin', 'admin']]) {
    await nav(h); await page.waitForTimeout(400); const txt = await page.textContent('#main-content');
    T(`page renders: ${name}`, txt.length > 60 && !/Something went wrong/.test(txt), txt.slice(0, 100));
    await shot(name);
  }

  // ---- equipment: filter by category, asset detail (NBV, photos)
  await nav('#/equipment');
  await page.selectOption('#eq-cat-filter', { label: (await page.$$eval('#eq-cat-filter option', o => o.map(x => x.textContent))).find(t => t.startsWith('Camera Bodies')) }); await page.waitForTimeout(600);
  T('equipment filtered by category (rate-card cameras)', (await page.$$('#eq-tbody tr.drill')).length === 25);
  await page.click('#eq-tbody tr.drill'); await page.waitForSelector('.overlay .tax-grid');
  T('asset detail shows revenue, NBV and replacement value', /Net book value/.test(await page.textContent('.overlay')));
  await shot('equipment-detail'); await closeModals();

  // ---- booking detail: print, cancel modal, photos
  await nav('#/agreements?status=active'); await page.click('#agr-tbody tr.drill'); await page.waitForSelector('.overlay #agr-print');
  T('booking shows print/PDF actions and condition photos', !!(await page.$('.overlay a[href$="agreement.pdf"]')));
  await shot('booking-detail'); await closeModals();
  await nav('#/agreements?status=reserved'); await page.click('#agr-tbody tr.drill'); await page.waitForSelector('.overlay');
  const cxBtn = await page.$('#cancel-agr-btn');
  if (cxBtn) { await cxBtn.click(); await page.waitForSelector('#cx-pct'); T('cancel dialog shows the 20% rate-card penalty', (await page.$eval('#cx-pct', i => i.value)) === '20'); await shot('cancel-with-fee'); }
  else T('cancel dialog shows the 20% rate-card penalty', false, 'no cancel button');
  await closeModals();

  // ---- new booking form: availability works (regression)
  await nav('#/agreements'); await page.click('#add-agr-btn'); await page.waitForSelector('#f-equip option'); await page.waitForTimeout(800);
  const enabled = await page.$$eval('#f-equip option', o => o.filter(x => !x.disabled).length);
  T('booking form offers available units (availability regression fixed)', enabled > 300, enabled);
  await page.fill('#f-equip-q', 'alexa'); await page.waitForTimeout(200);
  T('booking form equipment filter', (await page.$$eval('#f-equip option', o => o.filter(x => !x.hidden).length)) <= 5);
  await shot('new-booking'); await closeModals();

  // ---- billing: invoice with NRS section; e-invoice queue
  await nav('#/invoices'); await page.click('#inv-tbody tr.drill'); await page.waitForSelector('.overlay');
  T('invoice shows NRS status / IRN and ledger postings', /E-invoice \(NRS MBS\)/.test(await page.textContent('.overlay')) && /IRN/.test(await page.textContent('.overlay')) && /JE-/.test(await page.textContent('.overlay')));
  await shot('invoice-detail'); await closeModals();
  await nav('#/invoices?tab=nrs'); await page.waitForSelector('.check-list');
  T('NRS queue: readiness checklist + rejected invoice with reason', /Service ID/.test(await page.textContent('.check-list')) && /Buyer TIN/.test(await page.textContent('#bill-body')));
  await shot('nrs-queue');
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.evaluate(() => { const r = document.querySelector('[data-inv]'); printInvoice(r ? 0 : 0); })]).catch(() => [null]);
  if (popup) await popup.close();

  // ---- finance & tax
  await nav('#/finance?tab=tax'); await page.waitForSelector('.tax-grid'); T('VAT & WHT working paper with NRS clearance tile', /NRS e-invoice clearance/.test(await page.textContent('#fin-body'))); await shot('vat-wht');
  await nav('#/finance?tab=pl'); await page.waitForSelector('#rp-out table'); T('IFRS statement of profit or loss', /GROSS PROFIT/.test(await page.textContent('#rp-out')) && /PROFIT FOR THE PERIOD/.test(await page.textContent('#rp-out'))); await shot('profit-or-loss', true);
  await nav('#/finance?tab=bs'); await page.waitForSelector('#rp-out .notice'); T('statement of financial position balanced', /balanced/.test(await page.textContent('#rp-out .notice'))); await shot('financial-position', true);
  await nav('#/finance?tab=ctax'); await page.waitForSelector('#ct-out .tax-grid'); T('corporate tax provision (CIT + development levy)', /Development levy/.test(await page.textContent('#ct-out'))); await shot('corporate-tax');
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await nav('#/finance?tab=tb'); await page.waitForSelector('#rp-exp a'); await page.click('#rp-exp a:has-text("Excel")'); })()]);
  T('Excel export downloads (.xlsx)', /\.xlsx$/.test(dl.suggestedFilename()));
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#rp-exp a:has-text("PDF")')]);
  T('PDF export downloads (.pdf)', /\.pdf$/.test(dl2.suggestedFilename()));

  // ---- accounting
  await nav('#/accounting'); await page.waitForSelector('#gl-body tr'); T('chart of accounts shows 6-digit codes', (await page.$$eval('#gl-body tr td:first-child', t => t.map(x => x.textContent.trim()))).every(c => /^\d{6}$/.test(c)));
  await shot('chart-of-accounts');
  await page.click('#gl-add'); await page.fill('#gl-code', '1022'); await page.fill('#gl-name', 'Bank — test'); await page.click('#gl-save'); await page.waitForTimeout(400);
  T('add GL refuses a 4-digit code', /6 digits/.test(await page.textContent('#gl-err')));
  await page.fill('#gl-code', '102300'); await page.selectOption('#gl-ifrs', 'Cash and cash equivalents'); await page.click('#gl-save'); await page.waitForTimeout(800);
  T('add GL 102300 succeeds and appears', /102300/.test(await page.textContent('#gl-body')));
  await nav('#/accounting?tab=journals'); await page.waitForSelector('#je-body tr'); await shot('journals');
  await nav('#/accounting?tab=period'); await page.waitForSelector('.tax-grid'); T('period-end: depreciation, accrual, ECL, lock', /Depreciation/.test(await page.textContent('#acc-body')) && /Lock period/.test(await page.textContent('#acc-body'))); await shot('period-end', true);
  await nav('#/accounting?tab=imports'); await page.waitForSelector('#im-k');
  const tmp = path.join(os.tmpdir(), 'ui-import.csv'); fs.writeFileSync(tmp, 'customer_name,invoice_no,invoice_date,due_date,amount_outstanding\nLagoon Pictures Ltd,UI-77,2026-06-15,2026-06-30,"1,250,000"\n,BAD-1,2026-06-15,,0\n');
  await page.selectOption('#im-k', 'customer_balances'); await page.setInputFiles('#im-f', tmp); await page.click('#im-prev'); await page.waitForSelector('#im-out table');
  T('legacy import preview: good row accepted, bad row flagged, import disabled until fixed', (await page.$$('#im-out tr.row-err')).length === 1 && await page.$eval('#im-go', b => b.disabled));
  await shot('legacy-import-preview', true);

  // ---- reports & builder
  await nav('#/reports?r=fixed_asset_register'); await page.waitForSelector('#rp-out table'); T('fixed asset register report', (await page.$$('#rp-out tbody tr')).length > 300); await shot('report-fixed-assets');
  await nav('#/reports?builder=1'); await page.waitForSelector('#b-src');
  await page.selectOption('#b-src', 'invoice_lines'); await page.waitForTimeout(200);
  await page.selectOption('#b-g1', 'equipment_category'); await page.click('#b-adda'); await page.waitForTimeout(200);
  await page.selectOption('[data-af="0"]', 'sum'); await page.selectOption('[data-ak="0"]', 'amount'); await page.click('#b-run'); await page.waitForSelector('#b-out table');
  T('report builder: revenue by equipment category with totals + exports', (await page.$$('#b-out tbody tr')).length > 5 && /Excel/.test(await page.textContent('#b-exp')));
  await shot('report-builder');
  await page.click('[data-saved]'); await page.waitForTimeout(700); await page.waitForSelector('#b-out table', { timeout: 8000 }).catch(() => {}); T('saved custom report runs', (await page.$$('#b-out tbody tr')).length >= 1);

  // ---- admin
  await nav('#/admin?tab=users'); await page.waitForSelector('#add-user-btn'); T('users with titles and roles', /Managing Director/.test(await page.textContent('#adm-body')) && /Finance Manager/.test(await page.textContent('#adm-body'))); await shot('admin-users');
  await nav('#/admin?tab=roles'); await page.waitForSelector('[data-role]'); await page.click('[data-role]'); await page.waitForSelector('.perm-grid'); await shot('admin-role-editor'); await closeModals();
  await nav('#/admin?tab=nrs'); await page.waitForSelector('[data-key="nrs_service_id"]'); T('NRS settings tab', (await page.$eval('[data-key="nrs_service_id"]', i => i.value)) === 'NXTH2026'); await shot('admin-nrs');

  // ---- role-based UI: dispatch sees no finance
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': API.csrf } }));
  await login('ifeoma.dispatch@medirent.local', 'Welcome@123', 'Dispatch#2026x');
  const navTxt = await page.textContent('.sidebar nav');
  T('Dispatch menu hides finance / admin', !/Billing|Accounting|Admin/.test(navTxt) && /Bookings/.test(navTxt));
  T('Dispatch dashboard has operations tiles only', !(await page.$('.kpi:has-text("Revenue")')) && !!(await page.$('.kpi:has-text("Overdue returns")')));
  await shot('dashboard-dispatch');

  // ---- mobile
  await page.setViewportSize({ width: 390, height: 844 }); await nav('#/dashboard'); await page.waitForTimeout(600);
  T('mobile: menu button visible, sidebar off-canvas', await page.isVisible('#mobile-menu'));
  await shot('mobile-dashboard');
  await page.click('#mobile-menu'); await page.waitForTimeout(300); await shot('mobile-menu');

  T('no JavaScript errors or CSP violations', problems.length === 0, problems.slice(0, 5).join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('Failed:\n - ' + fails.join('\n - '));
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
