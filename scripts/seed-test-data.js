// Seeds the portal for Nexthought Creative Hub from its rate card, driven entirely through the app's own API so every
// business rule (tax, ledger, maker-checker, availability) runs exactly as in production.
//
//   node scripts/seed-test-data.js            (set MEDIRENT_DATA_DIR to seed somewhere other than ./data)
//
// Story: the company migrates from its old system at the end of the month three months ago (legacy upload of the
// opening trial balance, equipment register, customer & supplier open items, stock and crew rates), then trades for
// three months: bookings across the full lifecycle, studio hire with caution fees, crew, consumables, late returns,
// damage, a lost lens with an insurance claim and write-off, a cancellation with the 20% penalty, vendor bills paid
// through two-level vouchers, month-end depreciation / accrual / ECL, a manual journal and NRS e-invoice clearance
// (simulator). Company details, TINs and IDs are TEST VALUES — replace them before go-live.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const PORT = 4321;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.MEDIRENT_DATA_DIR || path.join(__dirname, '..', 'data');
const RATE_CARD = require('./data/nexthought-rate-card.json');
const { toCsv } = require('../lib/csv');

let csrf = null, cookie = null; const sessions = {};
async function api(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${data.error || 'unknown error'}`);
  return data;
}
async function as(email, password = PW) {
  if (!sessions[email]) { cookie = null; csrf = null; const r = await api('POST', '/api/auth/login', { email, password }); sessions[email] = { cookie, csrf: r.csrf_token }; }
  cookie = sessions[email].cookie; csrf = sessions[email].csrf;
}
function waitForServer(tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => fetch(BASE + '/api/health').then(() => resolve()).catch(() => { if (n <= 0) return reject(new Error('Server did not start')); setTimeout(() => attempt(n - 1), 250); });
    attempt(tries);
  });
}

// ---------- dates (everything is relative to today, so the seed works whenever it is run) ----------
const iso = (d) => d.toISOString().slice(0, 10);
const T = new Date(); T.setUTCHours(12, 0, 0, 0);
const TODAY = iso(T);
const daysAgo = (n) => iso(new Date(T.getTime() - n * 86400000));
const daysFromNow = (n) => iso(new Date(T.getTime() + n * 86400000));
const monthStart = (k) => new Date(Date.UTC(T.getUTCFullYear(), T.getUTCMonth() - k, 1));        // k months ago, day 1
const D = (k, day) => iso(new Date(Date.UTC(T.getUTCFullYear(), T.getUTCMonth() - k, day)));    // day N of month k-ago
const ME = (k) => iso(new Date(Date.UTC(T.getUTCFullYear(), T.getUTCMonth() - k + 1, 0)));        // month-end of month k-ago
const YM = (k) => iso(monthStart(k)).slice(0, 7);
const MIG = ME(4);            // migration date (end of month four months back)
const addDays = (s, n) => iso(new Date(new Date(s + 'T12:00:00Z').getTime() + n * 86400000));
const monthsBetween = (a, b) => { const x = new Date(a + 'T00:00:00Z'), y = new Date(b + 'T00:00:00Z'); return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + y.getUTCMonth() - x.getUTCMonth(); };

// Tiny placeholder "condition photo" (PNG, generated) so photo evidence shows in the demo.
function pngDataUrl(w, h, rgb, stripe) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const s = stripe && ((x + y) % 24 < 12); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = s ? stripe[0] : rgb[0]; raw[o + 1] = s ? stripe[1] : rgb[1]; raw[o + 2] = s ? stripe[2] : rgb[2]; } }
  const crc = (b) => { const c = zlib.crc32 ? zlib.crc32(b) : 0; const o = Buffer.alloc(4); o.writeUInt32BE(c >>> 0); return o; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); return Buffer.concat([l, td, crc(td)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

const ADMIN = 'admin@medirent.local', ADMIN_PW = 'Admin@12345', PW = 'Welcome@123';
const STAFF = [
  // existing users from the previous build — roles reassigned to the new segregation-of-duties model
  { full_name: 'Tunde Bakare', email: 'tunde.ops@medirent.local', role: 'Operations', title: 'Operations Manager' },
  { full_name: 'Ifeoma Nwosu', email: 'ifeoma.dispatch@medirent.local', role: 'Dispatch', title: 'Dispatch & QC Lead' },
  { full_name: 'Segun Alabi', email: 'segun.finance@medirent.local', role: 'Accountant', title: 'Accountant (maker)' },
  { full_name: 'Kemi Adewale', email: 'kemi.finance@medirent.local', role: 'Finance Manager', title: 'Finance Manager (level-1 approver)' },
  { full_name: 'Musa Ibrahim', email: 'musa.maintenance@medirent.local', role: 'Maintenance', title: 'Camera & Lighting Technician' },
  { full_name: 'Chiamaka Eze', email: 'chiamaka.sales@medirent.local', role: 'Sales', title: 'Sales Executive' },
  { full_name: 'Bola Adeniran', email: 'bola.viewer@medirent.local', role: 'Viewer', title: 'Board observer (read-only)' },
  // new users needed for the expanded portal
  { full_name: 'Adaeze Okonkwo', email: 'adaeze.md@medirent.local', role: 'Managing Director', title: 'Managing Director (final approver)' },
  { full_name: 'Emeka Obi', email: 'emeka.tax@medirent.local', role: 'Tax & Compliance Officer', title: 'Tax & Compliance Officer' },
  { full_name: 'Sade Lawal', email: 'sade.store@medirent.local', role: 'Store Keeper', title: 'Store Keeper' },
  { full_name: 'Yinka Balogun', email: 'yinka.studio@medirent.local', role: 'Studio Manager', title: 'Studio Manager (Broadway & Olympea)' },
  { full_name: 'Femi Ojo', email: 'femi.audit@medirent.local', role: 'Auditor', title: 'Internal Auditor' },
];
const OPS = 'tunde.ops@medirent.local', DISPATCH = 'ifeoma.dispatch@medirent.local', ACCT = 'segun.finance@medirent.local', FM = 'kemi.finance@medirent.local';
const MD = 'adaeze.md@medirent.local', TAX = 'emeka.tax@medirent.local', STORE = 'sade.store@medirent.local', STUDIO = 'yinka.studio@medirent.local', SALES = 'chiamaka.sales@medirent.local', MAINT = 'musa.maintenance@medirent.local';

const CHECKLISTS = {
  'Camera Bodies': ['Sensor inspected & cleaned', 'Firmware & licences checked', 'Media formatted / cards tested', 'Batteries charged & health checked', 'Timecode & genlock tested', 'Body cap and case complete'],
  'Lenses — PL Mount': ['Front & rear elements clean', 'Focus & iris rings smooth', 'Back-focus / collimation checked', 'Lens caps & support in case'],
  'Lenses — EF Mount': ['Glass clean', 'AF/IS tested', 'Caps & hood present'], 'Lenses — RF Mount': ['Glass clean', 'AF/IS tested', 'Caps & hood present'], 'Lenses — Sony E Mount': ['Glass clean', 'AF tested', 'Caps & hood present'],
  'Gimbals & Stabilisers': ['Motors calibrated', 'Batteries charged', 'Quick-release plates counted', 'Firmware updated'],
  Drones: ['Compass & IMU calibrated', 'Propellers inspected', 'All batteries charged & cycle count logged', 'NCAA permit / pilot licence on file', 'Geo-zone unlock confirmed'],
  'Wireless Video & Monitors': ['Link tested end-to-end', 'Frequencies scanned', 'Sun hoods & mounts present', 'Batteries charged'],
  'Sound & Comms': ['Capsules & cables tested', 'Batteries / chargers present', 'Frequencies coordinated', 'Wind protection packed'],
  'Lighting — LED': ['Fixture powers on all modes', 'DMX / app control tested', 'Ballast & head cable present', 'Diffusion / modifiers packed'],
  'Lighting — HMI & Specialty': ['Ballast strike test', 'Lamp hours logged', 'Safety glass & scrims checked', 'Head-to-ballast cable tested'],
  'Lighting — LED Tubes': ['Tubes charged', 'App control paired', 'Mounts / clips packed'], 'Lighting — Tungsten': ['Lamp tested', 'Barndoors & scrims present', 'Cable PAT-tested'],
  'Grip & Cranes': ['Load test passed', 'Counterweights counted', 'Brakes & locks checked', 'Operator assigned (where included)'],
  'Power & Distribution': ['Oil, coolant & fuel level checked', 'Load test passed', 'Earthing kit present', 'Run hours logged'],
  'Studio Space': ['Walk-through with client', 'Power & AC tested', 'Cyc wall painted / touched up', 'Green room cleaned', 'Caution fee received'],
  Vehicles: ['Fuel & tyres checked', 'Generator & AC tested', 'Driver assigned', 'Interior cleaned'],
};

async function main() {
  console.log('Starting throwaway server on port', PORT, '…');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), MEDIRENT_DATA_DIR: DATA_DIR, MEDIRENT_DISABLE_AUTO_BACKUP: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  process.on('exit', () => { try { server.kill(); } catch {} });
  await waitForServer();
  await as(ADMIN, ADMIN_PW);

  /* ---------------- 1. COMPANY, BRANDING, TAX & NRS (test values) ---------------- */
  console.log('Company profile, branding, tax & NRS (simulator)…');
  await api('PUT', '/api/admin/settings', {
    company_name: 'Nexthought Creative Hub', portal_name: 'Nexthought', portal_tagline: 'Creative Hub — Equipment & Studio Rental',
    company_address: '12 Test Avenue, Lekki Phase 1 (TEST ADDRESS — replace)', company_phone: '0800 000 0000', company_email: 'rentals@nexthought.test',
    company_website: 'www.nexthought.test', company_rc_number: 'RC0000000', company_tin: '12345678-0001', company_vat_number: '12345678-0001', vat_registered: '1',
    brand_primary_color: '#F8D800', brand_secondary_color: '#17171B',
    invoice_bank_name: 'Test Bank Plc', invoice_account_name: 'Nexthought Creative Hub', invoice_account_number: '0000000000', invoice_due_days: '7',
    invoice_notes: 'Rates are per day (studio: per 10-hour shoot day) and exclude VAT. Cancellations and refunds attract a 20% charge. Thank you for creating with Nexthought.',
    login_hint: '', nrs_mode: 'simulator', nrs_business_id: 'TEST-BIZ-0001', nrs_service_id: 'NXTH2026', nrs_default_service_code: 'TEST-SVC-RENT',
    nrs_supplier_city: 'Lagos', nrs_supplier_state: 'Lagos', nrs_supplier_postal_zone: '106104', nrs_app_name: 'Simulator (no APP connected)', cancellation_fee_pct: '20',
  });
  const logo = fs.readFileSync(path.join(__dirname, '..', 'samples', 'nexthought-logo.png'));
  await api('PUT', '/api/admin/branding/logo', { data_url: 'data:image/png;base64,' + logo.toString('base64') });

  /* ---------------- 2. LOCATIONS, USERS ---------------- */
  const locs = await api('GET', '/api/locations');
  await api('PUT', `/api/locations/${locs[0].id}`, { name: 'Main equipment store (Lekki)', address: 'Lekki Phase 1, Lagos' });
  await api('POST', '/api/locations', { code: 'STU', name: 'Studio complex (Broadway & Olympea)', address: 'Studio complex, Lagos' });
  await api('POST', '/api/locations', { code: 'IKJ', name: 'Ikeja satellite store', address: 'Ikeja, Lagos' });

  console.log('Staff users and roles…');
  const roles = await api('GET', '/api/admin/roles');
  for (const u of STAFF) await api('POST', '/api/admin/users', { full_name: u.full_name, email: u.email, title: u.title, role_id: roles.find(r => r.name === u.role).id, password: PW });

  /* ---------------- 3. CATEGORIES (with prep/QC checklists; studio hire to its own revenue GL) ---------------- */
  console.log('Equipment categories from the rate card…');
  const catNames = [...new Set(RATE_CARD.items.map(i => i.category))];
  for (const name of catNames) {
    const c = await api('POST', '/api/equipment/categories', { name, prep_checklist: CHECKLISTS[name] || ['Visual inspection', 'Function test', 'Accessories complete'] });
    if (name === 'Studio Space') await api('PUT', `/api/equipment/categories/${c.id}`, { income_gl_code: '401100' });
  }

  /* ---------------- 4. CUSTOMERS (fictional) ---------------- */
  console.log('Customers…');
  const CUSTOMERS = [
    { customer_type: 'company', full_name: 'Lagoon Pictures Ltd', email: 'production@lagoonpictures.test', phone: '0803 100 2001', address: '4 Ozumba Mbadiwe Ave, Victoria Island', city: 'Lagos', state: 'Lagos', tin: '23456789-0001', rc_number: 'RC1100221', wht_agent: true, credit_limit: 15000000, coi_on_file: true, coi_expiry_date: daysFromNow(200) },
    { customer_type: 'company', full_name: 'Eko Ads & Media Ltd', email: 'accounts@ekoads.test', phone: '0803 100 2002', address: '17 Adeola Hopewell St, Victoria Island', city: 'Lagos', state: 'Lagos', tin: '23456789-0002', rc_number: 'RC1100222', wht_agent: true, credit_limit: 10000000, coi_on_file: true, coi_expiry_date: daysFromNow(90) },
    { customer_type: 'company', full_name: 'NaijaStream TV Ltd', email: 'ops@naijastream.test', phone: '0803 100 2003', address: '9 Kofo Abayomi St, Victoria Island', city: 'Lagos', state: 'Lagos', tin: '23456789-0003', rc_number: 'RC1100223', wht_agent: true, credit_limit: 8000000, coi_on_file: true, coi_expiry_date: daysFromNow(30) },
    { customer_type: 'company', full_name: 'Crimson Film Studios', email: 'finance@crimsonfilm.test', phone: '0803 100 2004', address: '22 Allen Avenue, Ikeja', city: 'Lagos', state: 'Lagos', tin: '23456789-0004', rc_number: 'RC1100224', wht_agent: true, credit_limit: 12000000, coi_on_file: true, coi_expiry_date: daysFromNow(150) },
    { customer_type: 'company', full_name: 'Afrobeats Live Ltd', email: 'tour@afrobeatslive.test', phone: '0803 100 2005', address: '3 Admiralty Way, Lekki', city: 'Lagos', state: 'Lagos', tin: '23456789-0005', rc_number: 'RC1100225', wht_agent: true, credit_limit: 6000000, coi_on_file: false },
    { customer_type: 'company', full_name: 'Lagos State Ministry of Information (TEST)', email: 'procurement@moi.test', phone: '0803 100 2006', address: 'Secretariat, Alausa, Ikeja', city: 'Lagos', state: 'Lagos', tin: '23456789-0006', wht_agent: true, is_government: true, credit_limit: 20000000, coi_on_file: true, coi_expiry_date: daysFromNow(300) },
    { customer_type: 'company', full_name: 'Ibadan Gospel Media', email: 'hello@igm.test', phone: '0803 100 2007', address: '5 Ring Road', city: 'Ibadan', state: 'Oyo', tin: '23456789-0007', wht_agent: true, credit_limit: 3000000, coi_on_file: true, coi_expiry_date: daysFromNow(60) },
    { customer_type: 'company', full_name: 'Sunset Events Co', email: 'bookings@sunsetevents.test', phone: '0803 100 2008', address: '', wht_agent: true, credit_limit: 2000000, coi_on_file: false }, // no TIN / address: NRS pre-validation rejects (shows the fix-and-resubmit flow)
    { customer_type: 'individual', full_name: 'Kemi Okafor (Wedding Filmmaker)', email: 'kemi.okafor@mail.test', phone: '0803 100 2009', address: 'Surulere', city: 'Lagos', state: 'Lagos', wht_agent: false, credit_limit: 0, coi_on_file: true, coi_expiry_date: daysFromNow(120) },
    { customer_type: 'individual', full_name: 'Tobi Fashina (Freelance DP)', email: 'tobi.f@mail.test', phone: '0803 100 2010', address: 'Yaba', city: 'Lagos', state: 'Lagos', wht_agent: false, credit_limit: 0, coi_on_file: true, coi_expiry_date: daysFromNow(45) },
  ];
  for (const c of CUSTOMERS) await api('POST', '/api/customers', c);
  const custs = await api('GET', '/api/customers');
  const cust = (n) => custs.find(c => c.full_name.startsWith(n));

  /* ---------------- 5. LEGACY MIGRATION (as Finance Manager) ---------------- */
  console.log(`Legacy migration as at ${MIG}: equipment register, stock, crew rates, open items, opening trial balance…`);
  await as(FM);
  const upload = async (kind, rows, opts = {}) => {
    const text = toCsv(rows);
    const b = { filename: `${kind}-legacy-export.csv`, content_base64: Buffer.from(text, 'utf8').toString('base64'), as_of_date: MIG, ...opts };
    const pre = await api('POST', `/api/imports/${kind}/preview`, b);
    if (pre.error_rows || pre.blocking) throw new Error(`${kind} preview: ${pre.blocking || JSON.stringify(pre.rows.filter(r => !r.ok).slice(0, 3))}`);
    return api('POST', `/api/imports/${kind}/commit`, b);
  };
  // 5a. Equipment register built from the rate card (cost, life and accumulated depreciation to the migration date)
  const stuLoc = 'Studio complex (Broadway & Olympea)', ikj = 'Ikeja satellite store', main = 'Main equipment store (Lekki)';
  const eqRows = [['asset_code', 'name', 'category', 'brand', 'model', 'serial_number', 'purchase_date', 'purchase_cost', 'accumulated_depreciation', 'useful_life_years', 'salvage_value', 'daily_rate', 'weekly_rate', 'replacement_value', 'location', 'includes_operator']];
  let costTotal = 0, accTotal = 0, n = 0; const unitsByName = {};
  for (const it of RATE_CARD.items) {
    for (let u = 1; u <= it.units; u++) {
      n++;
      const name = it.units > 1 ? `${it.name} #${u}` : it.name;
      const pd = it.purchase_date > MIG ? addDays(MIG, -60) : it.purchase_date;
      const cost = it.purchase_cost, life = it.useful_life_years || 5, salvage = Math.round(cost * 0.1);
      const months = Math.max(0, monthsBetween(pd, MIG));
      const acc = it.depreciable && cost > 0 ? Math.min(cost - salvage, Math.round((cost - salvage) / (life * 12) * months)) : 0;
      costTotal += cost; accTotal += acc;
      const loc = it.category === 'Studio Space' ? stuLoc : (n % 9 === 0 && !['Camera Bodies', 'Drones', 'Lenses — PL Mount'].includes(it.category) ? ikj : main);
      eqRows.push(['', name, it.category, it.brand || '', '', it.category === 'Studio Space' ? '' : `NX-${String(n).padStart(4, '0')}`, it.category === 'Studio Space' ? '' : pd, cost, acc, it.category === 'Studio Space' ? 1 : life, it.category === 'Studio Space' ? 0 : salvage,
        it.daily_rate, it.weekly_rate, it.replacement_value, loc, it.includes_operator ? 'yes' : 'no']);
      (unitsByName[it.name] = unitsByName[it.name] || []).push(name);
    }
  }
  const eqImp = await upload('equipment', eqRows);
  console.log(`  equipment: ${eqImp.imported} units (cost ${costTotal.toLocaleString()}, acc. dep ${accTotal.toLocaleString()})`);
  // Studio spaces: not owned PPE (no depreciation) and carry their rate-card caution fee as the default deposit
  await as(OPS);
  const allEq = await api('GET', '/api/equipment');
  for (const it of RATE_CARD.items.filter(i => i.category === 'Studio Space' || i.default_deposit || i.notes)) {
    const e = allEq.find(x => x.name === it.name); if (!e) continue;
    await api('PUT', `/api/equipment/${e.id}`, { default_deposit: it.default_deposit || 0, depreciable: it.category !== 'Studio Space', notes: it.notes || (it.category === 'Studio Space' ? 'Rate card: per 10-hour shoot day; caution fee refundable after walk-through' : null) });
  }
  await as(FM);
  // 5b. Consumables stock (gels from the rate card; fuel because generators are hired "without diesel/petrol")
  const cons = await upload('consumables', [['item_code', 'name', 'unit', 'unit_cost', 'sale_price', 'quantity_on_hand', 'reorder_level'],
    ...RATE_CARD.consumables.map(c => [c.item_code, c.name, c.unit, c.unit_cost, c.sale_price, c.quantity_on_hand, c.reorder_level]),
    ['AGO-LTR', 'Diesel (AGO) for generators — per litre', 'litre', 1150, 1400, 1200, 400], ['PMS-LTR', 'Petrol (PMS) for 8kVA generator — per litre', 'litre', 860, 1050, 300, 100],
    ['TAPE-GAF', 'Gaffer tape (2", black)', 'roll', 9500, 15000, 30, 10], ['CARD-V90', 'Media card V90 SD 128GB (sold, not rented)', 'card', 42000, 60000, 8, 4]]);
  const stockValue = RATE_CARD.consumables.reduce((a, c) => a + c.unit_cost * c.quantity_on_hand, 0) + 1150 * 1200 + 860 * 300 + 9500 * 30 + 42000 * 8;
  // 5c. Crew rate card (Steadicam priced; other roles "rate on request" as on the card)
  await upload('crew_rates', [['role', 'day_rate', 'notes'], ...RATE_CARD.crew.map(c => [c.role, c.day_rate || '', c.day_rate ? 'Rate card' : 'Rate on request (blank on rate card)']), ['Camera Operator', 60000, 'Market rate — confirm'], ['Drone Pilot (NCAA-certified)', 80000, 'Included in "Inspire 3 with pilot" rate'], ['Generator Technician', 25000, 'Per day']]);
  // 5d. Customer open invoices (receivables subledger) and supplier unpaid bills (payables subledger)
  const AR = [['customer_name', 'customer_email', 'customer_tin', 'invoice_no', 'invoice_date', 'due_date', 'amount_outstanding', 'description'],
    ['Lagoon Pictures Ltd', '', '23456789-0001', 'NX-1188', addDays(MIG, -20), addDays(MIG, -13), 2150000, 'Camera & lens package — legacy'],
    ['Eko Ads & Media Ltd', '', '23456789-0002', 'NX-1194', addDays(MIG, -9), addDays(MIG, -2), 1612500, 'Broadway studio day — legacy'],
    ['NaijaStream TV Ltd', '', '23456789-0003', 'NX-1201', addDays(MIG, -4), addDays(MIG, 3), 860000, 'Broadcast kit — legacy'],
    ['Crimson Film Studios', '', '23456789-0004', 'NX-1142', addDays(MIG, -75), addDays(MIG, -68), 430000, 'Lighting hire — disputed, long overdue']];
  const arTotal = AR.slice(1).reduce((a, r) => a + r[6], 0);
  await upload('customer_balances', AR);
  const AP = [['vendor_name', 'vendor_tin', 'bill_no', 'bill_date', 'due_date', 'amount_outstanding', 'category', 'wht_rate', 'description'],
    ['Ikeja Electric Plc', '34567890-0001', 'IE-55821', addDays(MIG, -10), addDays(MIG, 5), 385000, 'utilities', 0, 'Studio power — legacy'],
    ['Prime Grip Hire Ltd', '34567890-0002', 'PGH-0731', addDays(MIG, -15), addDays(MIG, 15), 540000, 'sub_rental', 10, 'Cross-hire of dolly track — legacy'],
    ['Lekki Camera Clinic', '34567890-0003', 'LCC-3310', addDays(MIG, -6), addDays(MIG, 24), 275000, 'repairs', 5, 'Sensor service — legacy']];
  const apTotal = AP.slice(1).reduce((a, r) => a + r[5], 0);
  await upload('supplier_balances', AP);
  // 5e. Opening trial balance (the GL values; subledgers above reconcile to the control accounts)
  const TB = { '101000': [350000, 0], '102000': [18500000, 0], '102100': [420000, 0], '111000': [arTotal, 0], '114000': [860000, 0], '115000': [1200000, 0], '122000': [stockValue, 0],
    '151000': [costTotal, 0], '151900': [0, accTotal], '201000': [0, apTotal], '211000': [0, 612000], '212000': [0, 118500], '215000': [0, 2400000], '231000': [0, 5000000], '301000': [0, 10000000] };
  const dr = Object.values(TB).reduce((a, v) => a + v[0], 0), cr = Object.values(TB).reduce((a, v) => a + v[1], 0);
  TB['302000'] = dr - cr >= 0 ? [0, dr - cr] : [cr - dr, 0];
  await upload('opening_tb', [['account_code', 'account_name', 'debit', 'credit'], ...Object.entries(TB).map(([k, [d, c]]) => [k, '', d || '', c || ''])]);

  /* ---------------- 6. KITS from rate-card items ---------------- */
  await as(OPS);
  const eqAll = await api('GET', '/api/equipment');
  const E = (name) => { const list = unitsByName[name]; if (!list) throw new Error('No rate-card item ' + name); const e = eqAll.find(x => x.name === list[0]); if (!e) throw new Error('Missing unit ' + name); return e; };
  const EN = (name, k) => eqAll.find(x => x.name === unitsByName[name][k - 1]);
  const kit = async (name, description, items, rate) => api('POST', '/api/kits', { name, description, daily_rate: rate, weekly_rate: rate * 5, equipment_ids: items.map(i => i.id) });
  console.log('Kits…');
  await kit('Alexa Mini LF Cinema Package', 'ARRI Alexa Mini LF + Signature Primes + wireless focus + 7" SmallHD + Teradek', [E('ARRI Alexa Mini LF Body'), E('ARRI Signature Prime 18mm, 25mm, 35mm, 50mm, 95mm'), E('Tilta Nucleus-m Wireless Lens Control System'), E('SmallHD 7" with Inbuilt Receiver'), E('Teradek Bolt 4K / 6K Lt 750 3G-SDI/HMI Wireless Transmitter and Receiver')], 950000);
  await kit('Sony FX6 Documentary Kit', 'FX6 + Sony G Master set + RS III + lav & boom + Zoom H6', [E('Sony FX6 (body only)'), E('Sony FE set of 16-35mm, 24-70mm, 85mm, 70-200mm'), E('DJI Ronin RS III'), EN('Rode Lavalier (lapel)', 1), E('Boom Mic'), EN('Boom Pole', 1), E('H6 Zoom Recorder')], 300000);
  await kit('Wedding & Events Kit', 'A7S III + 24-70 GM II + RS II + DJI Mic + Amaran 200X', [E('Sony A7S III'), E('Sony FE 24-70mm F/2.8 GM II'), E('DJI Ronin RS II'), EN('DJI Mic set', 1), E('Amaran 200X Bicolor LED Light')], 140000);
  await kit('Interview Lighting Kit', 'LS600C Pro key, Nova P300C fill, F22C, softbox and stands', [E('Aputure LS600C Pro'), E('Aputure Nova P300C RGBWW'), E('Amaran F22C 2X2 Mat Light'), E('Softbox/Chimera'), EN('C-stand Complete', 1), EN('C-stand Complete', 2)], 160000);
  await kit('Live Broadcast Kit', 'ATEM 4K switcher, 2 cameras, Hollyland comms, director monitor', [E('Blackmagic Design ATEM Television Studio Pro 4K Live Production Switcher'), E('Canon C300 Mark III'), E('Canon C70'), E('Hollyland Talkies'), E('OSEE 17" Director\'s Monitor')], 380000);

  /* ---------------- helpers for the trading story ---------------- */
  const checklistOf = (it) => { try { return JSON.parse(it.prep_checklist || '[]').map(i => ({ item: i, done: true })); } catch { return []; } };
  const photoOK = pngDataUrl(48, 36, [70, 110, 140]), photoBad = pngDataUrl(48, 36, [150, 60, 50], [230, 200, 40]);
  async function checkoutAll(id, on, photos = false) {
    const d = await api('GET', `/api/agreements/${id}`);
    for (const it of d.items) {
      await api('POST', `/api/agreements/${id}/checkout/${it.id}`, { condition: 'Prepped, tested and confirmed working.', checklist: checklistOf(it), occurred_on: on });
      if (photos) await api('POST', '/api/photos', { entity_type: 'agreement_item', entity_id: it.id, stage: 'checkout', caption: 'Condition at dispatch', data_url: photoOK });
    }
    return d;
  }
  async function checkinAll(id, on, overrides = {}) {
    const d = await api('GET', `/api/agreements/${id}`);
    for (const it of d.items) {
      const o = overrides[it.equipment_id] || {};
      await api('POST', `/api/agreements/${id}/checkin/${it.id}`, { condition: 'Returned clean, no issues.', occurred_on: on, ...o });
      if (o.damage_charge || o.is_lost) await api('POST', '/api/photos', { entity_type: 'agreement_item', entity_id: it.id, stage: 'damage', caption: o.is_lost ? 'Last known (dispatch) condition' : 'Damage on return', data_url: photoBad });
    }
    return d;
  }
  const book = (body) => api('POST', '/api/agreements', body);
  const invoice = (id, date) => api('POST', `/api/invoices/generate/${id}`, { issue_date: date });
  const pay = (inv, amount, on, extra = {}) => api('POST', '/api/payments', { invoice_id: inv.id, amount: Math.round(amount * 100) / 100, received_on: on, method: 'bank_transfer', ...extra });
  const payNetOfWht = (inv, on, cn) => api('POST', '/api/payments', { invoice_id: inv.id, amount: Math.round((inv.grand_total - inv.wht_expected) * 100) / 100, wht_amount: inv.wht_expected, wht_credit_note_no: cn, received_on: on, method: 'bank_transfer', notes: 'Net of WHT deducted at source' });
  const kits = await api('GET', '/api/kits');
  const kitId = (n) => kits.find(k => k.name === n).id;
  const bill = async (b) => { await as(ACCT); return api('POST', '/api/expenses', b); };
  // Pay a bill through the full two-level voucher chain: Accountant raises -> Finance Manager (L1) -> MD (L2, pays)
  async function payBill(expId, on, stopAt) {
    await as(ACCT); const pv = await api('POST', '/api/vouchers', { linked_expense_id: expId });
    if (stopAt === 0) return pv;
    await as(FM); await api('POST', `/api/vouchers/${pv.id}/decide`, { decision: 'approved' });
    if (stopAt === 1) return pv;
    await as(MD); await api('POST', `/api/vouchers/${pv.id}/decide`, { decision: 'approved', payment_date: on });
    return pv;
  }
  async function adhocVoucher(payee, purpose, amount, gl, on) {
    await as(ACCT); const pv = await api('POST', '/api/vouchers', { payee_name: payee, purpose, amount, gl_code: gl });
    await as(FM); await api('POST', `/api/vouchers/${pv.id}/decide`, { decision: 'approved' });
    await as(MD); await api('POST', `/api/vouchers/${pv.id}/decide`, { decision: 'approved', payment_date: on });
  }
  const studio = (n) => eqAll.find(e => e.name.startsWith(n));
  // ---- day-to-day volume: short hires across the catalogue (deterministic pseudo-random so every run is identical) ----
  let seedN = 20260705; const rnd = () => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN / 2147483648; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const VOL_CUSTOMERS = ['Lagoon', 'Eko Ads', 'NaijaStream', 'Crimson', 'Ibadan', 'Kemi Okafor', 'Tobi', 'Lagoon', 'Eko Ads', 'Crimson'];
  const PTYPES = ['Commercial', 'Music Video', 'Film', 'Corporate', 'Wedding', 'Photography', 'Broadcast'];
  const PLACES = ['Lekki', 'Victoria Island', 'Ikoyi', 'Yaba', 'Surulere', 'Ikeja GRA', 'Epe', 'Badagry', 'Ajah'];
  const VOL_CATS = new Set(['Camera Bodies', 'Lenses — PL Mount', 'Lenses — EF Mount', 'Lenses — RF Mount', 'Lenses — Sony E Mount', 'Gimbals & Stabilisers', 'Wireless Video & Monitors', 'Sound & Comms', 'Lighting — LED', 'Lighting — LED Tubes', 'Lighting — HMI & Specialty', 'Lighting — Tungsten', 'Grip & Cranes', 'Filters', 'Textiles, Modifiers & Effects', 'Power & Distribution']);
  async function volume(k, n, firstStart, lastReturn, issueFrom, opts = {}) {
    const made = [];
    for (let i = 0; i < n; i++) {
      const start = opts.onHire ? daysAgo(1 + Math.floor(rnd() * 3)) : D(k, firstStart + Math.floor(rnd() * Math.max(1, lastReturn - firstStart - 4)));
      const days = 1 + Math.floor(rnd() * 4);
      const end = opts.onHire ? daysFromNow(1 + Math.floor(rnd() * 5)) : addDays(start, days);
      await as(OPS);
      const free = (await api('GET', `/api/equipment-availability?start_date=${start}&end_date=${end}`)).filter(e => e.status === 'available' && VOL_CATS.has((eqAll.find(x => x.id === e.id) || {}).category_name || '') && e.daily_rate >= 10000);
      if (free.length < 4) continue;
      const items = []; const want = 3 + Math.floor(rnd() * 4);
      while (items.length < want) { const e = pick(free); if (!items.includes(e.id)) items.push(e.id); }
      const c = cust(pick(VOL_CUSTOMERS));
      const b = await book({ customer_id: c.id, project_name: `${pick(['Brand film', 'TVC', 'Music video', 'Event coverage', 'Documentary', 'Product shoot', 'Web series ep.'])} ${100 + i}`, production_type: pick(PTYPES), shoot_location: pick(PLACES), start_date: start, expected_return_date: opts.onHire ? end : addDays(start, days), items: items.map(id => ({ equipment_id: id })), damage_waiver_opted: rnd() < 0.3, damage_waiver_fee: 10000 });
      await as(DISPATCH); await checkoutAll(b.id, start);
      if (opts.onHire) { made.push({ b }); continue; }
      await checkinAll(b.id, end > TODAY ? TODAY : end);
      made.push({ b, end, c });
    }
    // Invoice in date order (VAT invoice numbers must run chronologically), then collect most of them
    made.sort((a, b) => (a.end || '').localeCompare(b.end || ''));
    let last = D(k, issueFrom);
    for (const m of made.filter(x => x.end)) {
      const when = m.end > last ? m.end : last; last = when;
      await as(ACCT); const inv = await invoice(m.b.id, when > TODAY ? TODAY : when);
      const r = rnd(); const payOn = addDays(when, 3 + Math.floor(rnd() * 12)); if (payOn > TODAY || r < 0.18) continue;
      if (m.c.wht_agent) await payNetOfWht(inv, payOn, `WHT-CN/${m.c.full_name.slice(0, 3).toUpperCase()}/${inv.invoice_number.slice(-4)}`);
      else await pay(inv, inv.grand_total, payOn, { method: rnd() < 0.5 ? 'pos' : 'bank_transfer', deposit_to: rnd() < 0.5 ? '102100' : '102000' });
    }
    return last;
  }

  /* ================= MONTH 1 (three months ago) ================= */
  const M = 3; console.log(`Trading — ${YM(M)}…`);
  // legacy settlements & statutory remittances
  await as(FM);
  const legacy = await api('GET', '/api/invoices?legacy=1');
  const legLagoon = legacy.find(i => i.legacy_ref === 'NX-1188'), legEko = legacy.find(i => i.legacy_ref === 'NX-1194');
  await pay(legLagoon, 2150000, D(M, 3), { notes: 'Legacy invoice settled' });
  await pay(legEko, 1612500, D(M, 6));
  const legBills = await api('GET', '/api/expenses?status=unpaid');
  await payBill(legBills.find(b => b.vendor_name === 'Ikeja Electric Plc').id, D(M, 4));
  await payBill(legBills.find(b => b.vendor_name === 'Prime Grip Hire Ltd').id, D(M, 8));
  await adhocVoucher('Nigeria Revenue Service', 'VAT remittance — prior month (TaxPro-Max)', 612000, '211000', D(M, 19));
  await adhocVoucher('Nigeria Revenue Service', 'WHT remittance — prior month', 118500, '212000', D(M, 19));

  // B1 Lagoon Pictures — Alexa Mini LF package, Steadicam operator (rate card), WHT deducted at source
  await as(OPS);
  const b1 = await book({ customer_id: cust('Lagoon').id, kit_id: kitId('Alexa Mini LF Cinema Package'), project_name: '"Harmattan Hearts" — feature film', production_type: 'Film', shoot_location: 'Epe, Lagos', start_date: D(M, 3), expected_return_date: D(M, 8), damage_waiver_opted: true, damage_waiver_fee: 75000 });
  const crew = await api('GET', '/api/crew-rates');
  await api('POST', `/api/agreements/${b1.id}/crew`, { crew_role_id: crew.find(c => c.role === 'Steadicam Operator').id, crew_name: 'Dapo Akande', days: 5 });
  await api('POST', `/api/agreements/${b1.id}/crew`, { crew_role_id: crew.find(c => c.role === 'Focus Puller').id, crew_name: 'Nneka Udo', day_rate: 45000, days: 5 });
  await as(DISPATCH); await checkoutAll(b1.id, D(M, 3), true); await checkinAll(b1.id, D(M, 8));
  await as(ACCT); const i1 = await invoice(b1.id, D(M, 8)); await payNetOfWht(i1, D(M, 15), 'WHT-CN/LGP/0711');

  // B2 Eko Ads — Broadway studio + lighting + 60 kVA generator with diesel, rush fee; caution fee received & refunded
  await as(STUDIO);
  const broadway = studio('Broadway Studio');
  const b2 = await book({ customer_id: cust('Eko Ads').id, project_name: 'Telco brand TVC', production_type: 'Commercial', shoot_location: 'Broadway Studio', location_id: (await api('GET', '/api/locations')).find(l => l.code === 'STU').id,
    start_date: D(M, 10), expected_return_date: D(M, 12), rush_fee: 50000,
    items: [{ equipment_id: broadway.id }, { equipment_id: E('ARRI M90').id }, { equipment_id: E('Aputure Storm XT52 Point-source Tunable-white LED Monolight (bare Ends Cable)').id }, { equipment_id: E('60 KVA Generator set without Diesel').id }, { equipment_id: E('Distribution Box').id }] });
  await as(FM); await api('POST', `/api/agreements/${b2.id}/deposit`, { amount: 200000, received_on: D(M, 9), method: 'bank_transfer' });
  await as(STORE); const agoId = (await api('GET', '/api/consumables')).find(c => c.item_code === 'AGO-LTR').id;
  await api('POST', `/api/agreements/${b2.id}/consumables`, { consumable_id: agoId, qty: 180 });
  await as(DISPATCH); await checkoutAll(b2.id, D(M, 10)); await checkinAll(b2.id, D(M, 12));
  await as(ACCT); const i2 = await invoice(b2.id, D(M, 12));
  await pay(i2, Math.round(i2.grand_total * 0.5), D(M, 14), { notes: '50% on completion' });
  await as(FM); await api('POST', `/api/agreements/${b2.id}/deposit/refund`, { amount: 200000, paid_on: D(M, 16) });

  // B3 Kemi Okafor (individual, B2C) — wedding kit, waiver covers gimbal damage, paid by POS
  await as(SALES);
  const b3 = await book({ customer_id: cust('Kemi Okafor').id, kit_id: kitId('Wedding & Events Kit'), project_name: 'Adeyemi–Okoro wedding', production_type: 'Wedding', shoot_location: 'Ikoyi, Lagos', start_date: D(M, 13), expected_return_date: D(M, 15), damage_waiver_opted: true, damage_waiver_fee: 15000 });
  await as(DISPATCH); await checkoutAll(b3.id, D(M, 13));
  await checkinAll(b3.id, D(M, 15), { [E('DJI Ronin RS II').id]: { condition: 'Tilt motor grinding after a drop.', damage_notes: 'Dropped on tiles — motor fault (covered by waiver).', damage_charge: 120000 } });
  await as(ACCT); const i3 = await invoice(b3.id, D(M, 15)); await pay(i3, i3.grand_total, D(M, 15), { method: 'pos', deposit_to: '102100' });

  // B4 NaijaStream — broadcast kit, returned 2 days late (late fees) with a damaged monitor; part-paid
  await as(OPS);
  const b4 = await book({ customer_id: cust('NaijaStream').id, kit_id: kitId('Live Broadcast Kit'), project_name: 'Lagos Fashion Week live stream', production_type: 'Broadcast', shoot_location: 'Federal Palace Hotel', start_date: D(M, 18), expected_return_date: D(M, 20) });
  await as(DISPATCH); await checkoutAll(b4.id, D(M, 18), true);
  await checkinAll(b4.id, D(M, 22), { [E('OSEE 17" Director\'s Monitor').id]: { condition: 'Panel cracked in transit.', damage_notes: 'Cracked LCD panel — customer liable.', damage_charge: 180000 } });
  await as(ACCT); const i4 = await invoice(b4.id, D(M, 22)); await pay(i4, 1000000, D(M, 27), { notes: 'Part payment' });

  await volume(M, 26, 2, 27, 22);
  // Month-1 overheads: rent (WHT 10%), power, diesel (WHT-exempt energy product), insurance, crew payouts (WHT 5%)
  const e1 = await bill({ category: 'rent', amount: 2500000, vendor_name: 'Lekki Property Holdings Ltd', vendor_tin: '34567890-0004', vendor_invoice_no: `LPH/${YM(M)}`, description: 'Warehouse & studio rent', expense_date: D(M, 1), wht_apply: true });
  const e2 = await bill({ category: 'utilities', amount: 420000, vendor_name: 'Ikeja Electric Plc', vendor_tin: '34567890-0001', vendor_invoice_no: `IE-${YM(M)}`, description: 'Power — warehouse & studios', expense_date: D(M, 5), vat_applies: true });
  const e3 = await bill({ category: 'fuel', amount: 1150 * 2000, vendor_name: 'Ardova Fuels (TEST)', vendor_tin: '34567890-0005', vendor_invoice_no: `ARD-${D(M, 7)}`, description: 'Diesel restock 2,000 L', expense_date: D(M, 7), vat_applies: true });
  const e4 = await bill({ category: 'equipment_insurance', amount: 650000, vendor_name: 'TEST Insurance Plc', vendor_tin: '34567890-0006', vendor_invoice_no: `INS-${YM(M)}`, description: 'All-risks equipment cover — monthly premium', expense_date: D(M, 10) });
  const e5 = await bill({ category: 'crew', amount: 1225000, vendor_name: 'Dapo Akande & Nneka Udo (freelance)', vendor_invoice_no: `CRW-B1`, description: 'Freelance crew on "Harmattan Hearts"', expense_date: D(M, 9), wht_apply: true }); // no TIN: WHT doubled
  for (const [e, d] of [[e1, D(M, 3)], [e2, D(M, 9)], [e3, D(M, 11)], [e4, D(M, 14)], [e5, D(M, 16)]]) await payBill(e.id, d);
  await as(FM); await api('POST', '/api/accounting/depreciation/run', { period: YM(M) });

  /* ================= MONTH 2 ================= */
  const M2 = 2; console.log(`Trading — ${YM(M2)}…`);
  // B5 Ministry of Information (B2G) — documentary kit, government withholds WHT
  await as(OPS);
  const b5 = await book({ customer_id: cust('Lagos State Ministry').id, kit_id: kitId('Sony FX6 Documentary Kit'), project_name: 'Eko Rising — infrastructure documentary', production_type: 'Corporate', shoot_location: 'Lagos (multiple)', start_date: D(M2, 2), expected_return_date: D(M2, 9) });
  await as(DISPATCH); await checkoutAll(b5.id, D(M2, 2)); await checkinAll(b5.id, D(M2, 9));
  await as(ACCT); const i5 = await invoice(b5.id, D(M2, 9)); await payNetOfWht(i5, D(M2, 24), 'LASG/WHT/2026/0915');

  // B6 Crimson Film Studios — Sigma lens LOST (billed at replacement value, outside VAT); insurance claim; write-off
  await as(OPS);
  const lostLens = E('Sigma 50mm');
  const b6 = await book({ customer_id: cust('Crimson').id, project_name: 'Short film "Third Mainland"', production_type: 'Film', shoot_location: 'Third Mainland Bridge', start_date: D(M2, 5), expected_return_date: D(M2, 7),
    items: [{ equipment_id: E('Canon C70').id }, { equipment_id: lostLens.id }, { equipment_id: E('Canon RF 16-35mm').id }, { equipment_id: E('DJI Transmission Combo').id }] });
  await as(DISPATCH); await checkoutAll(b6.id, D(M2, 5), true);
  await checkinAll(b6.id, D(M2, 8), { [lostLens.id]: { is_lost: true, condition: 'Not returned — reported stolen from the unit car.' } });
  await as(ACCT); const i6 = await invoice(b6.id, D(M2, 10)); await payNetOfWht(i6, D(M2, 28), 'WHT-CN/CFS/0928');
  const claimCand = (await api('GET', '/api/claims/candidates')).find(c => c.equipment_id === lostLens.id);
  const claim = await api('POST', '/api/claims', { equipment_id: lostLens.id, agreement_item_id: claimCand.agreement_item_id, incident_type: 'stolen', incident_date: D(M2, 8), insurer: 'TEST Insurance Plc', policy_number: 'AR-2026-0042', amount_claimed: claimCand.replacement_value, excess: 50000, description: 'Lens stolen from production vehicle; police extract attached.' });
  await api('POST', '/api/photos', { entity_type: 'claim', entity_id: claim.id, stage: 'damage', caption: 'Police extract (scan)', data_url: photoBad });
  await as(FM); await api('POST', `/api/equipment/${lostLens.id}/write-off`, { reason: 'Stolen on hire (booking ' + b6.agreement_number + ') — not recovered', date: D(M2, 12) });

  // B7 Afrobeats Live — Inspire 3 with pilot; invoice issued, not paid (goes overdue)
  await as(OPS);
  const b7 = await book({ customer_id: cust('Afrobeats').id, project_name: 'Stadium concert aerials', production_type: 'Music Video', shoot_location: 'Teslim Balogun Stadium', start_date: D(M2, 14), expected_return_date: D(M2, 15),
    items: [{ equipment_id: E('Inspire 3 DJI Drone with pilot').id }, { equipment_id: E('DJI Director Monitor').id }] });
  await as(DISPATCH); await checkoutAll(b7.id, D(M2, 14)); await checkinAll(b7.id, D(M2, 15));
  await as(ACCT); await invoice(b7.id, D(M2, 15));

  // Quote -> accepted -> converted (Tobi Fashina), deposit applied to the invoice
  await as(SALES);
  const q = await api('POST', '/api/quotes', { customer_id: cust('Tobi').id, valid_until: D(M2, 30), items: [{ equipment_id: E('RED Digital Cinema Komodo 6K DSMC3').id, rate_type: 'daily', rate: 50000, qty: 1, duration: 3 }, { equipment_id: E('DZOFilm Pictor 20-55mm &50-125mm T2.8 SUPER35 Zoom Lens(pl & EF Mount)').id, rate_type: 'daily', rate: 70000, qty: 1, duration: 3 }] });
  await api('PUT', `/api/quotes/${q.id}/status`, { status: 'sent' });
  await api('PUT', `/api/quotes/${q.id}/status`, { status: 'accepted' });
  await api('POST', '/api/quotes', { customer_id: cust('Ibadan').id, valid_until: daysFromNow(10), items: [{ equipment_id: E('Aputure LS600C Pro').id, description: 'Aputure LS600C Pro', rate_type: 'daily', rate: 60000, qty: 1, duration: 2 }] });
  await as(OPS);
  const b8 = await api('POST', `/api/quotes/${q.id}/convert`, { start_date: D(M2, 18), expected_return_date: D(M2, 21), project_name: 'Music video "Lagos Nights"', production_type: 'Music Video', deposit_amount: 100000 });
  await as(FM); await api('POST', `/api/agreements/${b8.id}/deposit`, { amount: 100000, received_on: D(M2, 17), method: 'cash' });
  await as(DISPATCH); await checkoutAll(b8.id, D(M2, 18)); await checkinAll(b8.id, D(M2, 21));
  await as(ACCT); const i8 = await invoice(b8.id, D(M2, 21));
  await as(FM); await api('POST', `/api/agreements/${b8.id}/deposit/apply`, { amount: 100000, applied_on: D(M2, 21) });
  await pay(i8, i8.grand_total - 100000, D(M2, 23), { method: 'bank_transfer' });

  await volume(M2, 26, 2, 27, 21);
  // Damage from B4 -> work order completed with outside labour (bill), parts from stock
  await as(MAINT);
  await api('POST', '/api/maintenance/parts', { part_code: 'LCD-17-OSEE', name: 'Replacement LCD panel 17" (Osee)', quantity_on_hand: 2, reorder_level: 1, unit_cost: 95000 });
  const wos = await api('GET', '/api/maintenance/work-orders');
  const woMon = wos.find(w => w.equipment_name.startsWith('OSEE'));
  const parts = await api('GET', '/api/maintenance/parts');
  await api('POST', `/api/maintenance/work-orders/${woMon.id}/parts`, { part_id: parts[0].id, qty_used: 1 });
  await api('PUT', `/api/maintenance/work-orders/${woMon.id}/complete`, { labor_cost: 35000, vendor_name: 'Lekki Camera Clinic', vendor_tin: '34567890-0003', vendor_invoice_no: 'LCC-3402', wht_apply: true });
  const woGim = wos.find(w => w.equipment_name.startsWith('DJI Ronin RS II'));
  if (woGim) await api('PUT', `/api/maintenance/work-orders/${woGim.id}/complete`, { labor_cost: 60000, vendor_name: 'Gimbal Doctor NG', vendor_invoice_no: 'GD-118', wht_apply: true });
  await api('POST', '/api/maintenance/work-orders', { equipment_id: E('80 KVA Generator set without Diesel').id, wo_type: 'preventive', priority: 'normal', description: '250-hour service: oil, filters, load test' });
  await api('POST', '/api/maintenance/schedules', { equipment_id: E('100KVA Generator set without Diesel').id, schedule_type: 'time_based', interval_days: 90, last_service_date: D(M2, 1), next_due_date: daysFromNow(3), notes: 'Quarterly service' });
  await api('POST', '/api/maintenance/schedules', { equipment_id: E('ARRI Alexa Mini LF Body').id, schedule_type: 'time_based', interval_days: 180, last_service_date: D(M2, 1), next_due_date: daysFromNow(6), notes: 'Sensor & fan service' });

  // Month-2 overheads; one bill from a vendor without a TIN (WHT doubled); a sub-rental; marketing
  const f1 = await bill({ category: 'rent', amount: 2500000, vendor_name: 'Lekki Property Holdings Ltd', vendor_tin: '34567890-0004', vendor_invoice_no: `LPH/${YM(M2)}`, description: 'Warehouse & studio rent', expense_date: D(M2, 1), wht_apply: true });
  const f2 = await bill({ category: 'utilities', amount: 465000, vendor_name: 'Ikeja Electric Plc', vendor_tin: '34567890-0001', vendor_invoice_no: `IE-${YM(M2)}`, description: 'Power — warehouse & studios', expense_date: D(M2, 5), vat_applies: true });
  const f3 = await bill({ category: 'sub_rental', amount: 380000, vendor_name: 'Prime Grip Hire Ltd', vendor_tin: '34567890-0002', vendor_invoice_no: 'PGH-0811', description: 'Cross-hire: second Panther dolly', expense_date: D(M2, 13), vat_applies: true, wht_apply: true });
  const f4 = await bill({ category: 'marketing', amount: 300000, vendor_name: 'Pixel Social Agency', vendor_invoice_no: 'PSA-77', description: 'Instagram rate-card campaign', expense_date: D(M2, 15), wht_apply: true }); // no TIN
  const f5 = await bill({ category: 'professional_fees', amount: 750000, vendor_name: 'TEST & Co Chartered Accountants', vendor_tin: '34567890-0007', vendor_invoice_no: 'TC-2026-31', description: 'Half-year review & tax advisory', expense_date: D(M2, 20), vat_applies: true, wht_apply: true });
  for (const [e, d] of [[f1, D(M2, 3)], [f2, D(M2, 10)], [f3, D(M2, 18)], [f4, D(M2, 20)], [f5, D(M2, 25)]]) await payBill(e.id, d);
  await payBill(legBills.find(b => b.vendor_name === 'Lekki Camera Clinic').id, D(M2, 22));
  await as(FM); await api('POST', '/api/accounting/depreciation/run', { period: YM(M2) });
  // claim approved by the insurer
  await as(FM); await api('PUT', `/api/claims/${claim.id}`, { status: 'submitted', insurer_claim_ref: 'TIP/CLM/88213' });
  await api('PUT', `/api/claims/${claim.id}`, { status: 'approved', amount_approved: claimCand.replacement_value - 50000 });

  /* ================= MONTH 3 (last month) ================= */
  const M1 = 1; console.log(`Trading — ${YM(M1)}…`);
  // B9 Lagoon Pictures — Olympea studio 3 days with caution fee; deposit applied to the invoice
  await as(STUDIO);
  const olympea = studio('Olympea Studio');
  const b9 = await book({ customer_id: cust('Lagoon').id, project_name: '"Harmattan Hearts" — studio scenes', production_type: 'Film', shoot_location: 'Olympea Studio', start_date: D(M1, 2), expected_return_date: D(M1, 5),
    items: [{ equipment_id: olympea.id }, { equipment_id: E('ARRI Sky Panel S60 kit').id }, { equipment_id: E('Aputure 1200D Pro').id }, { equipment_id: E('Haze Machine (box)').id }] });
  await as(FM); await api('POST', `/api/agreements/${b9.id}/deposit`, { amount: 200000, received_on: D(M1, 1) });
  await as(DISPATCH); await checkoutAll(b9.id, D(M1, 2)); await checkinAll(b9.id, D(M1, 5));
  await as(ACCT); const i9 = await invoice(b9.id, D(M1, 5));
  await as(FM); await api('POST', `/api/agreements/${b9.id}/deposit/apply`, { amount: 200000, applied_on: D(M1, 6) });
  await as(ACCT); const i9b = (await api('GET', `/api/invoices/${i9.id}`)); await payNetOfWht({ ...i9, grand_total: i9b.balance + 0 + 0, wht_expected: i9.wht_expected }, D(M1, 20), 'WHT-CN/LGP/1020');

  // B10 Eko Ads — West Wing booking CANCELLED: 20% rate-card penalty invoiced, caution fee applied, balance refunded
  await as(STUDIO);
  const westWing = studio('West Wing');
  const b10 = await book({ customer_id: cust('Eko Ads').id, project_name: 'Bank campaign — stills', production_type: 'Photography', shoot_location: 'West Wing', start_date: D(M1, 22), expected_return_date: D(M1, 24), items: [{ equipment_id: westWing.id }, { equipment_id: E('Godox Liteflow 50').id }] });
  await as(FM); await api('POST', `/api/agreements/${b10.id}/deposit`, { amount: 50000, received_on: D(M1, 8) });
  await as(STUDIO); const cx = await api('PUT', `/api/agreements/${b10.id}/cancel`, { reason: 'Client postponed the campaign', cancel_date: D(M1, 10) });
  await as(FM); await api('POST', `/api/agreements/${b10.id}/deposit/apply`, { amount: Math.min(50000, cx.invoice.grand_total), applied_on: D(M1, 10) });
  const held10 = (await api('GET', `/api/agreements/${b10.id}`)).deposit_available;
  if (held10 > 0) await api('POST', `/api/agreements/${b10.id}/deposit/refund`, { amount: held10, paid_on: D(M1, 11) });
  const cxInv = await api('GET', `/api/invoices/${cx.invoice.id}`);
  if (cxInv.balance > 0) await pay(cxInv, cxInv.balance, D(M1, 12));

  // B11 Ibadan Gospel Media — interview lighting kit; invoiced, unpaid (current)
  await as(OPS);
  const b11 = await book({ customer_id: cust('Ibadan').id, kit_id: kitId('Interview Lighting Kit'), project_name: 'Testimony series S2', production_type: 'Corporate', shoot_location: 'Ibadan', start_date: D(M1, 14), expected_return_date: D(M1, 16) });
  await as(DISPATCH); await checkoutAll(b11.id, D(M1, 14)); await checkinAll(b11.id, D(M1, 16));
  await as(ACCT); await invoice(b11.id, D(M1, 17));

  // B12 Sunset Events (no TIN / address on file) — invoiced; its NRS submission is rejected until the customer is fixed
  await as(SALES);
  const b12 = await book({ customer_id: cust('Sunset').id, project_name: 'Corporate gala', production_type: 'Corporate', shoot_location: 'Eko Hotel', start_date: D(M1, 18), expected_return_date: D(M1, 19), items: [{ equipment_id: E('Sony FX9 (body only)').id }, { equipment_id: EN('Walkie-talkie', 1).id }, { equipment_id: EN('Walkie-talkie', 2).id }] });
  await as(DISPATCH); await checkoutAll(b12.id, D(M1, 18)); await checkinAll(b12.id, D(M1, 19));
  await as(ACCT); const i12 = await invoice(b12.id, D(M1, 20));

  await volume(M1, 24, 2, 25, 20);
  // B13 Lagoon Pictures — long hire spanning month-end (accrued at month-end, invoiced on return)
  await as(OPS);
  const b13 = await book({ customer_id: cust('Lagoon').id, project_name: '"Harmattan Hearts" — second unit', production_type: 'Film', shoot_location: 'Badagry', start_date: D(M1, 24), expected_return_date: daysAgo(3),
    items: [{ equipment_id: E('RED Monstro 8K').id }, { equipment_id: E('Cooke S4 Mini 18mm, 25mm, 32mm, 50mm, 75mm, 100mm').id }, { equipment_id: E('O\'Connor Ultimate 2575D Fluid Head Package with Tall and Baby Legs').id }] });
  await as(DISPATCH); await checkoutAll(b13.id, D(M1, 24));

  // Month-3 overheads, a manual reclass journal, insurer settlement
  const g1 = await bill({ category: 'rent', amount: 2500000, vendor_name: 'Lekki Property Holdings Ltd', vendor_tin: '34567890-0004', vendor_invoice_no: `LPH/${YM(M1)}`, description: 'Warehouse & studio rent', expense_date: D(M1, 1), wht_apply: true });
  const g2 = await bill({ category: 'utilities', amount: 440000, vendor_name: 'Ikeja Electric Plc', vendor_tin: '34567890-0001', vendor_invoice_no: `IE-${YM(M1)}`, description: 'Power — warehouse & studios', expense_date: D(M1, 5), vat_applies: true });
  const g3 = await bill({ category: 'equipment_insurance', amount: 650000, vendor_name: 'TEST Insurance Plc', vendor_tin: '34567890-0006', vendor_invoice_no: `INS-${YM(M1)}`, description: 'All-risks equipment cover — monthly premium', expense_date: D(M1, 10) });
  const g4 = await bill({ category: 'transport', amount: 210000, vendor_name: 'Swift Haulage Ltd', vendor_tin: '34567890-0008', vendor_invoice_no: 'SH-9021', description: 'Truck hire — Badagry location', expense_date: D(M1, 24), vat_applies: true, wht_apply: true });
  for (const [e, d] of [[g1, D(M1, 3)], [g2, D(M1, 9)], [g3, D(M1, 14)]]) await payBill(e.id, d);
  await payBill(g4.id, null, 1); // approved at level 1, awaiting the MD
  await as(ACCT); await api('POST', '/api/manual-journals', { entry_date: D(M1, 25), memo: 'Reclassify bank charges deducted on POS settlements (bank statement)', lines: [{ code: '609000', debit: 18750, description: 'POS charges' }, { code: '102100', credit: 18750, description: 'Deducted by acquirer' }] });
  await as(FM); const mj = (await api('GET', '/api/manual-journals'))[0]; await api('POST', `/api/manual-journals/${mj.id}/decide`, { decision: 'approved' });
  await api('PUT', `/api/claims/${claim.id}`, { status: 'settled', amount_settled: claimCand.replacement_value - 50000 });
  await api('POST', '/api/accounting/depreciation/run', { period: YM(M1) });
  await api('POST', '/api/accounting/accruals/run', { as_of: ME(M1) });
  await api('POST', '/api/accounting/ecl/run', { as_of: ME(M1) });

  /* ================= THIS MONTH (live state) ================= */
  console.log('Current month — live bookings…');
  // B13 returns 3 days late -> invoiced
  await as(DISPATCH); await checkinAll(b13.id, daysAgo(1));
  // B14 returned yesterday, not yet invoiced
  await as(OPS);
  const b14 = await book({ customer_id: cust('NaijaStream').id, project_name: 'Studio talk show — pilot', production_type: 'Broadcast', shoot_location: 'Makeshift Hall', start_date: daysAgo(4), expected_return_date: daysAgo(2), items: [{ equipment_id: studio('Makeshift Hall').id }, { equipment_id: E('Canon C500 Mark II').id }, { equipment_id: EN('Rode Lavalier (lapel)', 2).id }] });
  await as(DISPATCH); await checkoutAll(b14.id, daysAgo(4)); await checkinAll(b14.id, daysAgo(2));
  await as(ACCT); const i13 = await invoice(b13.id, TODAY);
  // B15 on hire now (due back in 2 days) — Crimson, with gels
  await as(OPS);
  const b15 = await book({ customer_id: cust('Crimson').id, project_name: 'Feature "Okada Road"', production_type: 'Film', shoot_location: 'Ikorodu', start_date: daysAgo(2), expected_return_date: daysFromNow(2), damage_waiver_opted: true, damage_waiver_fee: 60000,
    items: [{ equipment_id: E('ARRI Alexa Mini Body').id }, { equipment_id: E('ARRI Ultra Prime Lenses - 16, 24, 32, 50, 85').id }, { equipment_id: E('ARRI M40').id }, { equipment_id: E('45 KVA Generator set without Diesel').id }] });
  await as(STORE); await api('POST', `/api/agreements/${b15.id}/consumables`, { consumable_id: (await api('GET', '/api/consumables')).find(c => c.item_code === 'GEL-OFFCUT').id, qty: 6 });
  await as(DISPATCH); await checkoutAll(b15.id, daysAgo(2), true);
  // B16 overdue (should have come back yesterday)
  await as(OPS);
  const b16 = await book({ customer_id: cust('Afrobeats').id, project_name: 'Behind-the-scenes content', production_type: 'Music Video', shoot_location: 'Lekki', start_date: daysAgo(4), expected_return_date: daysAgo(1), items: [{ equipment_id: E('Sony FX3 (body only)').id }, { equipment_id: E('Sony FE 70-200mm F/2.8 GM').id }] });
  await as(DISPATCH); await checkoutAll(b16.id, daysAgo(4));
  // B17/B18 reserved upcoming pick-ups; B19 studio reserved with caution fee received
  await as(SALES);
  await book({ customer_id: cust('Tobi').id, project_name: 'Fashion lookbook', production_type: 'Photography', shoot_location: 'Ikoyi', start_date: daysFromNow(3), expected_return_date: daysFromNow(4), items: [{ equipment_id: E('Canon R5C').id }, { equipment_id: E('Canon RF Lenses set of 16-35mm, 50mm , 85mm').id }] });
  await as(OPS);
  await book({ customer_id: cust('Lagos State Ministry').id, kit_id: kitId('Live Broadcast Kit'), project_name: 'Governor’s town-hall live stream', production_type: 'Broadcast', shoot_location: 'Alausa', start_date: daysFromNow(6), expected_return_date: daysFromNow(7) });
  await as(STUDIO);
  const b19 = await book({ customer_id: cust('Eko Ads').id, project_name: 'Beverage TVC', production_type: 'Commercial', shoot_location: 'Broadway Studio', start_date: daysFromNow(9), expected_return_date: daysFromNow(10), items: [{ equipment_id: broadway.id }, { equipment_id: E('ARRI 6K HMI').id }] });
  await as(FM); await api('POST', `/api/agreements/${b19.id}/deposit`, { amount: 200000, received_on: TODAY });

  await volume(0, 6, 0, 0, 0, { onHire: true });
  // This month's bills: rent pending L1; one voucher rejected; legacy disputed AR stays open (ECL)
  const h1 = await bill({ category: 'rent', amount: 2500000, vendor_name: 'Lekki Property Holdings Ltd', vendor_tin: '34567890-0004', vendor_invoice_no: `LPH/${YM(0)}`, description: 'Warehouse & studio rent', expense_date: D(0, 1), wht_apply: true });
  await payBill(h1.id, null, 0);
  await as(ACCT); const rj = await api('POST', '/api/vouchers', { payee_name: 'Unknown supplier', purpose: 'Cash advance without invoice', amount: 150000 });
  await as(FM); await api('POST', `/api/vouchers/${rj.id}/decide`, { decision: 'rejected', comment: 'No supporting invoice — resubmit with a vendor bill' });
  // Restock gels through a supplier bill (inventory), and a small parts stock line
  await as(STORE); await api('PUT', `/api/consumables/${(await api('GET', '/api/consumables')).find(c => c.item_code === 'TAPE-GAF').id}/restock`, { qty: 20, unit_cost: 9800, vendor_name: 'Studio Supplies NG', vendor_tin: '34567890-0009', vendor_invoice_no: 'SSN-551', vat_applies: true });

  /* ---------------- NRS e-invoicing (simulator): clear everything except the deliberate problem cases ---------------- */
  console.log('NRS e-invoice clearance (simulator)…');
  await as(TAX);
  await api('POST', '/api/einvoice/submit-pending'); // Sunset Events is rejected (no buyer TIN / address)
  // leave the newest invoice uncleared to show the pending queue
  await as(ACCT); const i14 = await invoice(b14.id, TODAY);
  void i1; void i3; void i4; void i5; void i12; void i13; void i14;

  // Close the books for the month before last
  await as(FM); await api('PUT', '/api/accounting/lock', { locked_until: ME(2) });

  // A saved custom report for the finance team
  await api('POST', '/api/saved-reports', { name: 'Revenue by production type', definition: { source: 'bookings', group_by: ['production_type'], aggregates: [{ fn: 'count', field: 'booking' }, { fn: 'sum', field: 'invoiced' }], sort: [{ field: 'sum_invoiced', dir: 'desc' }] } });
  await api('POST', '/api/saved-reports', { name: 'Open invoices by customer', definition: { source: 'invoices', group_by: ['customer'], aggregates: [{ fn: 'sum', field: 'balance' }, { fn: 'count', field: 'invoice_number' }], filters: [{ field: 'status', op: 'in', value: 'unpaid,partial' }], sort: [{ field: 'sum_balance', dir: 'desc' }] } });

  /* ---------------- summary ---------------- */
  await as(ADMIN, ADMIN_PW);
  const tb = await api('GET', '/api/reports/trial-balance');
  const dsum = tb.reduce((a, r) => a + r.total_debit, 0), csum = tb.reduce((a, r) => a + r.total_credit, 0);
  const bs = await api('GET', '/api/reports/balance-sheet');
  console.log(`\nDone. ${eqImp.imported} units, ${custs.length} customers, ${STAFF.length + 1} users.`);
  console.log(`Trial balance: Dr ${dsum.toFixed(2)} / Cr ${csum.toFixed(2)} — ${Math.abs(dsum - csum) < 0.01 ? 'balanced' : 'NOT BALANCED'}; balance sheet ${bs.totals.balanced ? 'balanced' : 'NOT balanced'}.`);
  server.kill();
  process.exit(0);
}

main().catch((e) => { console.error('Seeding failed:', e); process.exit(1); });
