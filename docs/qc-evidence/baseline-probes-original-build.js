// Baseline probes against the ORIGINAL build. Prints PASS/FAIL-style evidence lines.
const { spawn } = require('child_process');
const path = require('path');
const PORT = 4400, BASE = `http://localhost:${PORT}`;
const dir = '<path-to-ORIGINAL-build>';
let cookie = '', csrf = '';
async function call(method, p, body, opts = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h.cookie = cookie; if (csrf) h['x-csrf-token'] = csrf;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && !opts.keep) cookie = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j };
}
const log = (k, v) => console.log(`${k.padEnd(52)} ${v}`);
(async () => {
  const srv = spawn('node', ['server.js'], { cwd: dir, env: { ...process.env, PORT, MEDIRENT_DATA_DIR: '/tmp/orig-data' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500));
  try {
    let r = await call('POST', '/api/auth/login', { email: 'admin@medirent.local', password: 'Admin@12345' });
    csrf = r.j.csrf_token;
    // master data
    const cat = (await call('POST', '/api/equipment/categories', { name: 'Cameras', prep_checklist: ['Clean'] })).j.id;
    const mk = async (n, rate, repl) => (await call('POST', '/api/equipment', { name: n, category_id: cat, daily_rate: rate, replacement_value: repl })).j.id;
    const e1 = await mk('Cam A', 100000, 2000000), e2 = await mk('Cam B', 50000, 500000), e3 = await mk('Cam C', 20000, 100000);
    const cust = (await call('POST', '/api/customers', { full_name: 'Acme Ltd', customer_type: 'company', email: 'a@b.com' })).j.id;
    const cons = (await call('POST', '/api/consumables', { item_code: 'C1', name: 'Card', unit_cost: 1000, sale_price: 2000, quantity_on_hand: 10 })).j.id;

    // 1. Negative consumable qty
    const agN = (await call('POST', '/api/agreements', { customer_id: cust, start_date: '2026-08-01', expected_return_date: '2026-08-02', items: [{ equipment_id: e3, rate: 20000 }] })).j;
    r = await call('POST', `/api/agreements/${agN.id}/consumables`, { consumable_id: cons, qty: -5 });
    const stock = (await call('GET', '/api/consumables')).j[0].quantity_on_hand;
    log('Negative consumable qty accepted (stock 10 -> ?)', `status ${r.s}, stock now ${stock}  => ${r.s === 201 ? 'BUG (free stock inflation)' : 'ok'}`);
    const g = await call('POST', `/api/invoices/generate/${agN.id}`);
    const invs = (await call('GET', '/api/invoices')).j; const jeBefore = (await call('GET', '/api/reports/trial-balance')).j.find(a => a.code === '1100').total_debit;
    log('Invoice generation with bad data', `status ${g.s} ${JSON.stringify(g.j).slice(0,70)}; invoices in DB=${invs.length}, AR debits=${jeBefore} => ${(g.s !== 201 && invs.length > 0) ? 'BUG (orphan invoice, no GL, no transaction)' : 'n/a'}`);
    await call('PUT', `/api/agreements/${agN.id}/cancel`);
    // refill stock for the main test
    await call('PUT', `/api/consumables/${cons}/restock`, { qty: 0 });
    const ag = (await call('POST', '/api/agreements', { customer_id: cust, start_date: '2026-09-01', expected_return_date: '2026-09-03', items: [{ equipment_id: e1, rate: 100000 }, { equipment_id: e2, rate: 50000 }], rush_fee: 10000 })).j;
    await call('POST', `/api/agreements/${ag.id}/consumables`, { consumable_id: cons, qty: 2 });
    await call('POST', `/api/agreements/${ag.id}/crew`, { crew_name: 'Tola', role: 'DoP', day_rate: 80000, days: 2 });

    // 2. Double-booking same equipment overlapping dates
    r = await call('POST', '/api/agreements', { customer_id: cust, start_date: '2026-09-02', expected_return_date: '2026-09-04', items: [{ equipment_id: e1, rate: 100000 }] });
    log('Overlapping booking of same unit accepted', `status ${r.s} => ${r.s === 201 ? 'BUG (double-booking)' : 'ok'}`);
    r = await call('POST', '/api/agreements', { customer_id: cust, start_date: '2026-09-09', expected_return_date: '2026-09-01', items: [{ equipment_id: e3, rate: 1 }] });
    log('Return date before start date accepted', `status ${r.s} => ${r.s === 201 ? 'BUG' : 'ok'}`);

    // 3. checkout/checkin edge cases
    const det = (await call('GET', `/api/agreements/${ag.id}`)).j;
    const it1 = det.items[0].id, it2 = det.items[1].id;
    await call('POST', `/api/agreements/${ag.id}/checkout/${it1}`, { condition: 'good', checklist: [] });
    await call('POST', `/api/agreements/${ag.id}/checkout/${it2}`, { condition: 'good', checklist: [] });
    r = await call('POST', `/api/agreements/${ag.id}/checkout/${it1}`, { condition: 'good' });
    log('Double checkout of same item accepted', `status ${r.s} => ${r.s === 200 ? 'BUG' : 'ok'}`);
    await call('POST', `/api/agreements/${ag.id}/checkin/${it1}`, { condition: 'good', damage_charge: 0 });
    r = await call('POST', `/api/agreements/${ag.id}/checkin/${it1}`, { condition: 'good', damage_charge: 5000 });
    log('Double check-in (rewrites damage charge) accepted', `status ${r.s} => ${r.s === 200 ? 'BUG' : 'ok'}`);
    await call('POST', `/api/agreements/${ag.id}/checkin/${it2}`, { condition: 'good', damage_charge: 0 });

    // 4. Invoice maths
    r = await call('POST', `/api/invoices/generate/${ag.id}`);
    const inv = (await call('GET', `/api/invoices/${r.j.id}`)).j;
    const net = inv.items.reduce((a, i) => a + i.amount, 0);
    log('Invoice line total (net)', net);
    log('VAT charged', `${inv.vat_total}  (7.5% of ALL lines would be ${(net * 0.075).toFixed(2)}) => ${Math.abs(inv.vat_total - net * 0.075) > 1 ? 'BUG: VAT under-charged' : 'ok'}`);
    log('Crew line on invoice', inv.items.some(i => /Tola|crew|DoP/i.test(i.description)) ? 'present' : 'MISSING => BUG (crew never billed)');
    log('WHT expected recorded', inv.wht_total);
    r = await call('POST', `/api/invoices/generate/${ag.id}`);
    log('Second invoice for same booking allowed', `status ${r.s} => ${r.s === 201 ? 'BUG (double billing)' : 'ok'}`);

    // 5. Payments
    r = await call('POST', '/api/payments', { invoice_id: inv.id, amount: -500, method: 'cash' });
    log('Negative payment accepted', `status ${r.s} => ${r.s === 201 ? 'BUG' : 'ok'}`);
    r = await call('POST', '/api/payments', { invoice_id: inv.id, amount: 99999999, method: 'cash' });
    log('Overpayment accepted', `status ${r.s} => ${r.s === 201 ? 'BUG' : 'ok'}`);
    const tb = (await call('GET', '/api/reports/trial-balance')).j;
    const acc = c => tb.find(a => a.code === c);
    log('Cash payment posted to Cash(1000)?', `Cash dr=${acc('1000').total_debit} Bank dr=${acc('1010').total_debit} => ${acc('1000').total_debit === 0 ? 'BUG (cash booked to bank)' : 'ok'}`);
    const bs = (await call('GET', '/api/reports/balance-sheet?as_of=2020-01-01')).j;
    log('Balance sheet as_of 2020 (should be empty)', `assets=${bs.totals.asset} => ${bs.totals.asset !== 0 ? 'BUG (date filter ignored)' : 'ok'}`);
    const bs2 = (await call('GET', '/api/reports/balance-sheet')).j;
    log('Balance sheet balances (A = L + E)?', `A=${bs2.totals.asset} L+E=${bs2.totals.liability + bs2.totals.equity} => ${Math.abs(bs2.totals.asset - bs2.totals.liability - bs2.totals.equity) > 0.01 ? 'BUG (no current-year earnings)' : 'ok'}`);

    // 6. Cancel returned agreement
    r = await call('PUT', `/api/agreements/${ag.id}/cancel`);
    log('Cancel an already-RETURNED booking accepted', `status ${r.s} => ${r.s === 200 ? 'BUG' : 'ok'}`);

    // 7. Users: suspended user keeps session; dup email raw error; weak pw
    r = await call('POST', '/api/admin/users', { full_name: 'T', email: 'admin@medirent.local', role_id: 2, password: 'x' });
    log('Duplicate email / 1-char password on create user', `status ${r.s} ${JSON.stringify(r.j).slice(0, 90)}`);
    const roles = (await call('GET', '/api/admin/roles')).j; const fin = roles.find(x => x.name === 'Finance').id;
    const u = (await call('POST', '/api/admin/users', { full_name: 'Susp', email: 'susp@x.com', role_id: fin, password: 'Passw0rd!x' })).j;
    const adminCookie = cookie, adminCsrf = csrf;
    cookie = ''; const lr = await call('POST', '/api/auth/login', { email: 'susp@x.com', password: 'Passw0rd!x' }); const sCookie = cookie, sCsrf = lr.j.csrf_token;
    cookie = adminCookie; csrf = adminCsrf;
    await call('PUT', `/api/admin/users/${u.id}`, { status: 'suspended' });
    cookie = sCookie; csrf = sCsrf;
    r = await call('GET', '/api/invoices');
    log('Suspended user can still call API with old session', `status ${r.s} => ${r.s === 200 ? 'BUG' : 'ok'}`);
    r = await call('POST', '/api/auth/change-password', { new_password: 'abcdefgh' });
    log('Change password w/o current password', `status ${r.s} => ${r.s === 200 ? 'BUG (no current-password check)' : 'ok'}`);
    cookie = adminCookie; csrf = adminCsrf;

    // 8. Voucher maker-checker
    const pv = (await call('POST', '/api/vouchers', { payee_name: 'X', purpose: 'p', amount: 1000 })).j;
    const a1 = await call('POST', `/api/vouchers/${pv.id}/decide`, { decision: 'approved' });
    const a2 = await call('POST', `/api/vouchers/${pv.id}/decide`, { decision: 'approved' });
    log('Same admin raised + approved L1 + approved L2', `${a1.s}/${a2.s} => ${a2.s === 200 ? 'BUG (maker-checker bypass)' : 'ok'}`);

    // 9. Security headers
    const hr = await fetch(BASE + '/');
    log('Security headers (CSP/XFO/nosniff)', ['content-security-policy', 'x-frame-options', 'x-content-type-options'].map(h => hr.headers.get(h) ? 'Y' : 'n').join(' '));
    // 10. brute force
    let last; for (let i = 0; i < 15; i++) last = await call('POST', '/api/auth/login', { email: 'admin@medirent.local', password: 'wrong' + i }, { keep: true });
    log('15 wrong logins in a row - any lockout/429?', `last status ${last.s} => ${last.s === 429 ? 'ok' : 'BUG (no throttling)'}`);
  } catch (e) { console.error('PROBE ERROR', e); }
  srv.kill();
})();
