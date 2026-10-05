/* ===================== DASHBOARD (every figure drills to its source) ===================== */
async function renderDashboard(main) {
  main.innerHTML = `<div class="dash-head"><div><h2>Dashboard</h2><div class="sub" id="dash-sub">Loading…</div></div><div class="btn-row" id="dash-actions"></div></div><div id="dash-body"></div>`;
  const d = await API.get('/api/dashboard/summary');
  const S = d.sections, f = S.finance, fl = S.fleet, bk = S.bookings, tk = S.tasks || {};
  const hr = new Date().getHours();
  document.getElementById('dash-sub').textContent = `${hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'}, ${CURRENT_USER.full_name.split(' ')[0]} · ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${d.company ? ' · ' + d.company : ''}`;
  const acts = [];
  if (can('rentals.edit')) acts.push('<button class="btn small" data-act="booking">+ New booking</button>');
  if (can('quotes.edit')) acts.push('<button class="btn small secondary" data-act="quote">+ Quote</button>');
  if (can('expenses.edit')) acts.push('<button class="btn small secondary" data-act="expense">+ Vendor bill</button>');
  if (can('reports.view')) acts.push('<button class="btn small secondary" data-act="reports">Reports</button>');
  document.getElementById('dash-actions').innerHTML = acts.join('');
  document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'booking') agreementForm(() => go('#/agreements'));
    if (a === 'quote') go('#/quotes', { new: 1 });
    if (a === 'expense') expenseForm(() => go('#/finance', { tab: 'expenses' }));
    if (a === 'reports') go('#/reports');
  }));

  const tile = (k, v, s, target, cls = '') => ({ k, v, s, target, cls });
  const tiles1 = [], tiles2 = [];
  if (f) {
    const delta = f.revenue_last_month ? ((f.revenue_mtd - f.revenue_last_month) / Math.abs(f.revenue_last_month)) * 100 : null;
    tiles1.push(
      tile('Revenue this month (excl. VAT)', fmtShort(f.revenue_mtd), delta === null ? 'No revenue last month' : `<span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)}%</span> vs last month (${fmtShort(f.revenue_last_month)})`, ['#/reports', { r: 'revenue_disaggregation', from: new Date().toISOString().slice(0, 8) + '01' }]),
      tile('Revenue year to date', fmtShort(f.revenue_ytd), `Since ${f.year_start}`, ['#/reports', { r: 'profit_and_loss' }]),
      tile('Profit year to date', fmtShort(f.profit_ytd), `This month ${fmtShort(f.profit_mtd)}`, ['#/reports', { r: 'profit_and_loss' }], f.profit_ytd < 0 ? 'bad' : 'ok'),
      tile('Cash & bank', fmtShort(f.cash_total), f.cash_accounts.map(c => `${c.name.split('—')[0].trim()}: ${fmtShort(c.bal)}`).slice(0, 2).join(' · '), ['ledger', f.cash_accounts.find(c => c.code === '102000') ? '102000' : (f.cash_accounts[0] || {}).code]),
      tile('Receivables', fmtShort(f.receivables), `${fmtShort(f.overdue_receivables)} overdue · ${f.open_invoices} open invoices`, ['#/reports', { r: 'ar_aging' }], f.overdue_receivables > 0 ? 'warn' : ''),
      tile('Payables (unpaid bills)', fmtShort(f.payables), tk.unpaid_bills !== undefined ? `${tk.unpaid_bills} bill(s) · cash to pay ${fmtShort(tk.unpaid_bill_amount)}` : '', ['#/reports', { r: 'ap_aging' }], 'neutral'),
      tile('VAT payable (GL)', fmtShort(f.vat_payable), `Net VAT this month ${fmtShort(f.net_vat_this_month)} · due ${f.vat_due}`, ['#/finance', { tab: 'tax' }], 'warn'),
      tile('WHT credit notes held', fmtShort(f.wht_credits), `WHT to remit ${fmtShort(f.wht_payable)}`, ['#/reports', { r: 'wht_schedule' }], 'neutral'),
      tile('Deposits & caution fees held', fmtShort(f.deposits_held), 'Refundable — a liability, not income', ['#/reports', { r: 'deposits_held' }], 'neutral'),
    );
  }
  if (fl) {
    const by = fl.by_status;
    tiles2.push(
      tile('Fleet utilisation now', `${fl.utilisation_now}%`, `${by.on_rent || 0} of ${fl.total} units on rent`, ['#/equipment', { status: 'on_rent' }], fl.utilisation_now >= 40 ? 'ok' : ''),
      tile('Available to rent', by.available || 0, `${by.reserved || 0} reserved for upcoming jobs`, ['#/equipment', { status: 'available' }], 'ok'),
      tile('In maintenance', by.maintenance || 0, `${tk.open_work_orders ?? 0} open work order(s)`, ['#/maintenance'], (by.maintenance || 0) ? 'warn' : 'neutral'),
      tile('Lost / unresolved', by.lost || 0, `${tk.open_claims ?? 0} open insurance claim(s)`, ['#/equipment', { status: 'lost' }], (by.lost || 0) ? 'bad' : 'neutral'),
      tile('Fleet replacement value', fmtShort(fl.fleet_value), `${fl.total} units across ${fl.categories.length}+ categories`, ['#/reports', { r: 'fixed_asset_register' }], 'neutral'),
    );
  }
  if (bk) {
    tiles2.push(
      tile('Bookings on hire', bk.active, `${bk.due_today} due back today`, ['#/agreements', { status: 'active' }]),
      tile('Overdue returns', bk.overdue, bk.overdue ? 'Chase customers / late fees accrue' : 'None — good', ['#/agreements', { status: 'overdue' }], bk.overdue ? 'bad' : 'ok'),
      tile('Pick-ups next 7 days', bk.pickups_week, `${bk.reserved} reserved in total`, ['#/agreements', { due: 'pickups' }]),
      tile('Returned, not invoiced', bk.uninvoiced, bk.uninvoiced ? 'Raise invoices' : 'All billed', ['#/agreements', { status: 'uninvoiced' }], bk.uninvoiced ? 'warn' : 'ok'),
    );
  }
  const tileHtml = (arr) => arr.length ? `<div class="kpi-grid">${arr.map((t, i) => `<button class="kpi ${t.cls}" data-ti="${i}"><span class="go">open →</span><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="s">${t.s || ''}</div></button>`).join('')}</div>` : '';

  const panels = [];
  if (f) panels.push(`<div class="panel span-8"><h3>Revenue vs cash collected — monthly <a href="#" data-nav="pl">Statement of profit or loss →</a></h3><div id="ch-trend"></div><div class="muted" style="font-size:11px">Click a month to open its revenue breakdown.</div></div>`);
  if (f) panels.push(`<div class="panel span-4"><h3>Receivables ageing <a href="#" data-nav="aging">Ageing report →</a></h3>
    <div class="stack" id="age-stack"></div><div id="age-list"></div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">ECL allowance required ${fmtMoney(f.ecl_required)} · held ${fmtMoney(f.ecl_held)}${Math.abs(f.ecl_required - f.ecl_held) > 1 && can('journals.edit') ? ' — <a href="#" data-nav="ecl">true up</a>' : ''}</p></div>`);
  panels.push(`<div class="panel span-4"><h3>Needs attention</h3><div id="tasks"></div></div>`);
  if (bk) panels.push(`<div class="panel span-4"><h3>Returns due <a href="#" data-nav="returns">All on hire →</a></h3><div id="returns"></div></div>`);
  if (bk) panels.push(`<div class="panel span-4"><h3>Upcoming pick-ups <a href="#" data-nav="pickups">All reserved →</a></h3><div id="pickups"></div></div>`);
  if (f) panels.push(`<div class="panel span-4"><h3>Top customers (YTD) <a href="#" data-nav="custrev">Report →</a></h3><div id="topcust"></div></div>`);
  if (f) panels.push(`<div class="panel span-4"><h3>Top earning equipment (YTD) <a href="#" data-nav="util">Utilisation →</a></h3><div id="topeq"></div></div>`);
  if (f) panels.push(`<div class="panel span-4"><h3>Revenue mix (YTD) <a href="#" data-nav="mix">Disaggregation →</a></h3><div id="mix"></div></div>`);
  if (fl) panels.push(`<div class="panel span-6"><h3>Fleet by category — units on rent / total <a href="#" data-nav="equipment">Equipment →</a></h3><div id="cats"></div></div>`);
  if (bk) panels.push(`<div class="panel span-6"><h3>Bookings by production type (YTD)</h3><div id="ptypes"></div>${bk.coi_issues.length ? `<p class="muted" style="font-size:12px;margin-top:10px">Insurance (COI) missing or expiring for live bookings: ${bk.coi_issues.map(c => `<a href="#" data-cust="${c.id}">${escapeHtml(c.full_name)}</a>`).join(', ')}</p>` : ''}</div>`);
  if (fl && fl.locations.length > 1) panels.push(`<div class="panel span-6"><h3>Units by location</h3><div class="fleet-chips">${fl.locations.map(l => `<button class="chip" data-loc="${l.id}"><b>${l.units}</b>${escapeHtml(l.name)}</button>`).join('')}</div></div>`);
  if (S.activity) panels.push(`<div class="panel span-${fl && fl.locations.length > 1 ? 6 : 12}"><h3>Recent activity <a href="#" data-nav="audit">Audit log →</a></h3><div>${S.activity.map(a => `<div class="rowlink" data-audit="${escapeHtml(a.entity_type || '')}:${a.entity_id || ''}"><span>${escapeHtml(a.action.replace(/_/g, ' '))} <span class="muted">${escapeHtml(a.entity_type || '')}${a.entity_id ? ' #' + a.entity_id : ''}</span></span><span class="r">${escapeHtml(a.full_name || 'system')} · ${escapeHtml(String(a.created_at).slice(5, 16))}</span></div>`).join('')}</div></div>`);

  const body = document.getElementById('dash-body');
  body.innerHTML = `${tileHtml(tiles1)}${tileHtml(tiles2)}<div class="dash-grid">${panels.join('')}</div>`;
  const allTiles = [...tiles1, ...tiles2];
  body.querySelectorAll('.kpi-grid').forEach((grid, gi) => grid.querySelectorAll('[data-ti]').forEach(b => b.addEventListener('click', () => {
    const t = (gi === 0 && tiles1.length ? tiles1 : tiles2)[Number(b.dataset.ti)];
    if (t.target[0] === 'ledger') return viewLedger(t.target[1]);
    go(t.target[0], t.target[1]);
  })));
  void allTiles;

  if (f) {
    { const first = f.trend.findIndex(m => m.revenue || m.collected); if (first > 0) f.trend = f.trend.slice(Math.min(first, f.trend.length - 6)); }
    barChart(document.getElementById('ch-trend'), {
      labels: f.trend.map(m => new Date(m.month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short' })),
      series: [{ name: 'Revenue (excl. VAT)', color: CHART_COLORS[0], values: f.trend.map(m => m.revenue) }, { name: 'Cash collected', color: CHART_COLORS[1], values: f.trend.map(m => m.collected) }],
      onClick: (i) => { const m = f.trend[i].month; const [y, mo] = m.split('-').map(Number); go('#/reports', { r: 'revenue_disaggregation', from: m + '-01', to: new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10) }); },
    });
    const ag = f.aging, total = Object.values(ag).reduce((a, b) => a + b, 0) || 1;
    const AG = [['current', 'Not yet due', '#9bc4f2'], ['b1', '1–30 days', '#5a9ee9'], ['b2', '31–60 days', '#3987e5'], ['b3', '61–90 days', '#2263b4'], ['b4', 'Over 90 days', '#184f95']];
    document.getElementById('age-stack').innerHTML = AG.filter(([k]) => ag[k] > 0).map(([k, l, c]) => `<div style="flex:${ag[k] / total};background:${c}" title="${l}: ${fmtMoney(ag[k])}" data-nav="aging"></div>`).join('') || '<div style="flex:1;background:var(--line)"></div>';
    const al = hBars(AG.map(([k, l, c]) => ({ label: l, value: ag[k], color: c })), { onClick: () => go('#/reports', { r: 'ar_aging' }) });
    document.getElementById('age-list').innerHTML = al.html; al.bind(document.getElementById('age-list'));
    const tc = hBars(f.top_customers.map(c => ({ label: c.name, value: c.net, id: c.id })), { onClick: (it) => viewCustomer(it.id) });
    document.getElementById('topcust').innerHTML = tc.html; tc.bind(document.getElementById('topcust'));
    const te = hBars(f.top_equipment.map(c => ({ label: c.name, value: c.net, id: c.id, color: CHART_COLORS[2] })), { onClick: (it) => viewEquipment(it.id) });
    document.getElementById('topeq').innerHTML = te.html; te.bind(document.getElementById('topeq'));
    const mx = hBars(f.revenue_mix.map(c => ({ label: c.name, value: c.net, color: CHART_COLORS[3] })), { onClick: () => go('#/reports', { r: 'revenue_disaggregation' }) });
    document.getElementById('mix').innerHTML = mx.html; mx.bind(document.getElementById('mix'));
  }
  // tasks
  const T = [];
  const task = (n, label, hint, fn, heat) => { if (n !== undefined && n !== null) T.push({ n, label, hint, fn, heat }); };
  task(tk.pending_vouchers, 'Payment vouchers awaiting approval', tk.pending_voucher_amount ? fmtShort(tk.pending_voucher_amount) : '', () => go('#/vouchers', { status: 'pending' }), tk.pending_vouchers ? 'warm' : '');
  task(tk.pending_journals, 'Manual journals awaiting approval', '', () => go('#/accounting', { tab: 'journals' }), tk.pending_journals ? 'warm' : '');
  task(tk.einvoice_pending, 'Invoices not yet cleared on NRS', tk.nrs_mode === 'off' ? 'e-invoicing off' : (tk.einvoice_rejected ? `${tk.einvoice_rejected} rejected` : tk.nrs_mode), () => go('#/invoices', { einvoice: 'pending' }), tk.einvoice_rejected ? 'hot' : (tk.einvoice_pending ? 'warm' : ''));
  task(tk.unpaid_bills, 'Unpaid vendor bills', tk.unpaid_bill_amount ? fmtShort(tk.unpaid_bill_amount) : '', () => go('#/finance', { tab: 'expenses', status: 'unpaid' }), '');
  task(tk.low_stock, 'Consumables at / below reorder level', '', () => go('#/consumables', { low: 1 }), tk.low_stock ? 'warm' : '');
  task(tk.open_work_orders, 'Open work orders', tk.maintenance_due ? `${tk.maintenance_due} service(s) due this week` : '', () => go('#/maintenance'), '');
  task(tk.open_claims, 'Open insurance claims', '', () => go('#/claims'), '');
  task(tk.lost_units, 'Lost units to resolve (claim / write-off)', '', () => go('#/equipment', { status: 'lost' }), tk.lost_units ? 'hot' : '');
  if (bk) task(bk.overdue, 'Overdue returns', '', () => go('#/agreements', { status: 'overdue' }), bk.overdue ? 'hot' : '');
  T.sort((a, b) => (b.n > 0) - (a.n > 0));
  const tEl = document.getElementById('tasks');
  tEl.innerHTML = T.map((t, i) => `<div class="task" data-tk="${i}"><span class="n ${t.n > 0 ? t.heat : ''}">${t.n}</span><span class="t">${escapeHtml(t.label)}</span><span class="a">${escapeHtml(t.hint || '')} →</span></div>`).join('') || '<p class="muted">Nothing outstanding.</p>';
  tEl.querySelectorAll('[data-tk]').forEach(r => r.addEventListener('click', () => T[Number(r.dataset.tk)].fn()));
  if (bk) {
    const today = new Date().toISOString().slice(0, 10);
    const list = (id, rows, dateKey) => { const el = document.getElementById(id); el.innerHTML = rows.map(r => `<div class="rowlink" data-agr="${r.id}"><span><strong>${escapeHtml(r.agreement_number)}</strong> ${escapeHtml(r.customer)}<br><span class="muted" style="font-size:12px">${escapeHtml(r.project_name || '')}</span></span><span class="r">${r[dateKey] < today ? '<span style="color:var(--red)">' + escapeHtml(r[dateKey]) + '</span>' : escapeHtml(r[dateKey])}<br>${badge(r.status)}</span></div>`).join('') || '<p class="muted">None.</p>'; el.querySelectorAll('[data-agr]').forEach(x => x.addEventListener('click', () => viewAgreement(x.dataset.agr))); };
    list('returns', bk.returns, 'expected_return_date'); list('pickups', bk.pickups, 'start_date');
    const pt = hBars(bk.by_production_type.map(p => ({ label: p.t, value: p.c, color: CHART_COLORS[0] })), { valueFmt: (v) => `${v} booking${v === 1 ? '' : 's'}`, onClick: () => go('#/agreements') });
    document.getElementById('ptypes').insertAdjacentHTML('afterbegin', pt.html); pt.bind(document.getElementById('ptypes'));
  }
  if (fl) {
    const ce = hBars(fl.categories.map(c => ({ label: `${c.name} (${c.on_rent}/${c.units})`, value: c.units ? c.on_rent * 100 / c.units : 0, id: c.id })), { valueFmt: (v) => `${v.toFixed(0)}% out`, onClick: (it) => go('#/equipment', { category_id: it.id }) });
    document.getElementById('cats').innerHTML = ce.html; ce.bind(document.getElementById('cats'));
  }
  body.querySelectorAll('[data-loc]').forEach(b => b.addEventListener('click', () => go('#/equipment', { location_id: b.dataset.loc })));
  body.querySelectorAll('[data-cust]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); viewCustomer(a.dataset.cust); }));
  body.querySelectorAll('[data-audit]').forEach(r => r.addEventListener('click', () => {
    const [t, id] = r.dataset.audit.split(':');
    const m = { invoice: 'invoice_id', rental_agreement: 'agreement_id', agreement: 'agreement_id', customer: 'customer_id', equipment: 'equipment_id', expense: 'expense_id', claim: 'claim_id', payment_voucher: 'voucher_id', journal_entry: 'entry_id' }[t];
    if (m && id) drill({ [m]: id }); else go('#/admin', { tab: 'audit' });
  }));
  const NAVS = { pl: ['#/reports', { r: 'profit_and_loss' }], aging: ['#/reports', { r: 'ar_aging' }], returns: ['#/agreements', { status: 'live' }], pickups: ['#/agreements', { status: 'reserved' }], custrev: ['#/reports', { r: 'revenue_by_customer' }],
    util: ['#/reports', { r: 'equipment_utilisation' }], mix: ['#/reports', { r: 'revenue_disaggregation' }], equipment: ['#/equipment'], audit: ['#/admin', { tab: 'audit' }], ecl: ['#/accounting', { tab: 'period' }] };
  body.querySelectorAll('[data-nav]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); const n = NAVS[a.dataset.nav]; go(n[0], n[1]); }));
}
