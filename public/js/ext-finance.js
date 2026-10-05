/* ===================== REPORT PANEL (shared by Finance & Reports) ===================== */
let REPORT_CATALOG = null;
async function reportPanel(container, key, params = {}) {
  REPORT_CATALOG = REPORT_CATALOG || await API.get('/api/reports/catalog');
  const def = REPORT_CATALOG.find(r => r.key === key); if (!def) { container.innerHTML = '<p class="error-msg">Unknown report</p>'; return; }
  const accounts = def.params.some(p => p.type === 'account') ? await API.get('/api/accounts') : [];
  const input = (p) => {
    const v = params[p.key] || '';
    if (p.type === 'select') return `<select data-p="${p.key}">${p.options.map(o => `<option value="${o}" ${v === o ? 'selected' : ''}>${o || 'All'}</option>`).join('')}</select>`;
    if (p.type === 'account') return `<select data-p="${p.key}">${accounts.filter(a => !a.is_header).map(a => `<option value="${a.code}" ${(v || '102000') === a.code ? 'selected' : ''}>${a.code} ${escapeHtml(a.name)}</option>`).join('')}</select>`;
    return `<input type="${p.type === 'month' ? 'month' : 'date'}" data-p="${p.key}" value="${escapeHtml(v)}">`;
  };
  container.innerHTML = `<div class="toolbar">${def.params.map(p => `<label class="muted">${escapeHtml(p.label)}</label>${input(p)}`).join('')}
      <button class="btn small" id="rp-run">Run</button><span style="margin-left:auto" id="rp-exp"></span></div><div id="rp-out"><p class="muted">Loading…</p></div>`;
  const run = async () => {
    const qs = new URLSearchParams();
    container.querySelectorAll('[data-p]').forEach(el => { if (el.value) qs.set(el.dataset.p, el.value); });
    const t = await API.get(`/api/reports/run/${key}?${qs.toString()}`);
    container.querySelector('#rp-exp').innerHTML = exportLinks(`/api/reports/run/${key}?${qs.toString()}`);
    const out = container.querySelector('#rp-out');
    out.innerHTML = `<h3 style="margin:4px 0 2px">${escapeHtml(t.title)}</h3><p class="muted" style="margin:0 0 10px">${escapeHtml(t.subtitle || '')}</p>${reportTableHtml(t)}
      ${(t.notes || []).map(n => `<div class="help muted">• ${escapeHtml(n)}</div>`).join('')}
      ${t.meta && t.meta.balanced !== undefined ? `<div class="notice ${t.meta.balanced ? 'ok' : 'bad'}">Assets ${fmtMoney(t.meta.assets)} = Equity ${fmtMoney(t.meta.equity)} + Liabilities ${fmtMoney(t.meta.liabilities)} — ${t.meta.balanced ? 'balanced' : 'OUT OF BALANCE'}</div>` : ''}`;
    bindDrill(out, t);
  };
  container.querySelector('#rp-run').addEventListener('click', () => run().catch(e => toast(e.message, true)));
  container.querySelectorAll('[data-p]').forEach(el => el.addEventListener('change', () => run().catch(e => toast(e.message, true))));
  await run().catch(e => { container.querySelector('#rp-out').innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; });
}

/* ===================== REPORTS PAGE ===================== */
async function renderReports(main, params = {}) {
  REPORT_CATALOG = REPORT_CATALOG || await API.get('/api/reports/catalog');
  const saved = await API.get('/api/saved-reports');
  const current = params.r || (params.builder || params.saved ? null : 'profit_and_loss');
  const groups = {}; for (const r of REPORT_CATALOG) (groups[r.group] = groups[r.group] || []).push(r);
  main.innerHTML = `<div class="page-header"><h2>Reports</h2><div class="btn-row"><button class="btn" id="rb-new">+ Report builder</button></div></div>
    <div class="split"><div class="list-nav card" style="padding:6px 0">
      ${Object.entries(groups).map(([g, list]) => `<div class="grp">${escapeHtml(g)}</div>${list.map(r => `<button data-r="${r.key}" class="${r.key === current ? 'active' : ''}">${escapeHtml(r.title)}</button>`).join('')}`).join('')}
      <div class="grp">Saved custom reports</div>${saved.map(s => `<button data-saved="${s.id}" class="${String(params.saved) === String(s.id) ? 'active' : ''}">${escapeHtml(s.name)}</button>`).join('') || '<p class="muted" style="padding:0 10px;font-size:12px">None yet — build one.</p>'}
    </div><div class="card" id="rep-body" style="min-width:0"></div></div>`;
  main.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => go('#/reports', { r: b.dataset.r })));
  main.querySelectorAll('[data-saved]').forEach(b => b.addEventListener('click', () => go('#/reports', { saved: b.dataset.saved })));
  document.getElementById('rb-new').addEventListener('click', () => go('#/reports', { builder: 1 }));
  const body = document.getElementById('rep-body');
  if (params.builder || params.saved) return reportBuilder(body, params.saved ? saved.find(s => String(s.id) === String(params.saved)) : null);
  const p = { ...params }; delete p.r;
  return reportPanel(body, current, p);
}

let BUILDER_SOURCES = null;
async function reportBuilder(body, savedReport) {
  BUILDER_SOURCES = BUILDER_SOURCES || await API.get('/api/report-builder/sources');
  const def = savedReport ? JSON.parse(JSON.stringify(savedReport.definition)) : { source: 'invoices', columns: [], filters: [], group_by: [], aggregates: [], sort: [], limit: 5000 };
  const OPS = [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['not_contains', 'excludes'], ['starts', 'starts with'], ['between', 'between'], ['in', 'in list'], ['is_empty', 'is empty'], ['not_empty', 'not empty']];
  for (const k of ['columns', 'filters', 'group_by', 'aggregates', 'sort']) if (!Array.isArray(def[k])) def[k] = [];
  if (!BUILDER_SOURCES.find(s => s.key === def.source)) def.source = 'invoices';
  const src = () => BUILDER_SOURCES.find(s => s.key === def.source);
  const draw = () => {
    const S = src(); const fopts = (sel, filter) => S.fields.filter(filter || (() => true)).map(f => `<option value="${f.key}" ${sel === f.key ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('');
    const numeric = (f) => ['money', 'number', 'integer'].includes(f.type);
    body.innerHTML = `<h3 style="margin-top:0">${savedReport ? 'Saved report — ' + escapeHtml(savedReport.name) : 'Report builder'}</h3>
      <div class="builder-grid"><div>
        <div class="field"><label>1 · Data source</label><select id="b-src">${BUILDER_SOURCES.map(s => `<option value="${s.key}" ${s.key === def.source ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}</select></div>
        <div class="field"><label>2 · Columns <span class="muted">(ignored when grouping)</span></label><div class="cols-box">${S.fields.map(f => `<label><input type="checkbox" data-col="${f.key}" ${def.columns.includes(f.key) ? 'checked' : ''}>${escapeHtml(f.label)} <span class="muted" style="font-size:11px">${f.type}</span></label>`).join('')}</div></div>
        <div class="field"><label>3 · Filters</label><div id="b-flt">${def.filters.map((f, i) => `<div class="flt-row"><select data-ff="${i}">${fopts(f.field)}</select><select data-fo="${i}">${OPS.map(([k, l]) => `<option value="${k}" ${f.op === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span style="display:flex;gap:2px"><input data-fv="${i}" value="${escapeHtml(f.value ?? '')}" placeholder="value">${f.op === 'between' ? `<input data-fv2="${i}" value="${escapeHtml(f.value2 ?? '')}" placeholder="and">` : ''}</span><a href="#" data-fx="${i}">×</a></div>`).join('')}</div>
          <button class="btn small secondary" id="b-addf">+ Filter</button></div>
        <div class="field"><label>4 · Group by (optional)</label><select id="b-g1"><option value="">— no grouping —</option>${fopts(def.group_by[0])}</select><select id="b-g2" style="margin-top:4px"><option value="">— second level —</option>${fopts(def.group_by[1])}</select></div>
        <div class="field"><label>5 · Totals when grouped</label><div id="b-agg">${(def.aggregates.length ? def.aggregates : []).map((a, i) => `<div class="flt-row" style="grid-template-columns:90px 1fr 26px"><select data-af="${i}">${['sum', 'count', 'avg', 'min', 'max', 'count_distinct'].map(x => `<option ${a.fn === x ? 'selected' : ''}>${x}</option>`).join('')}</select><select data-ak="${i}">${fopts(a.field)}</select><a href="#" data-ax="${i}">×</a></div>`).join('')}</div>
          <button class="btn small secondary" id="b-adda">+ Total</button></div>
        <div class="grid-2"><div class="field"><label>Sort by</label><select id="b-sort"><option value="">—</option>${fopts(def.sort[0] && def.sort[0].field)}${def.group_by.length ? def.aggregates.map(a => `<option value="${a.fn}_${a.field}" ${def.sort[0] && def.sort[0].field === `${a.fn}_${a.field}` ? 'selected' : ''}>${a.fn} of ${a.field}</option>`).join('') : ''}</select></div>
          <div class="field"><label>Direction</label><select id="b-dir"><option value="asc">Ascending</option><option value="desc" ${def.sort[0] && def.sort[0].dir === 'desc' ? 'selected' : ''}>Descending</option></select></div></div>
        <div class="btn-row"><button class="btn" id="b-run">Run</button><button class="btn secondary" id="b-save">${savedReport ? 'Save changes' : 'Save as…'}</button>${savedReport ? '<button class="btn small danger" id="b-del">Delete</button>' : ''}</div>
      </div><div style="min-width:0"><div id="b-exp" style="margin-bottom:8px"></div><div id="b-out"><p class="muted">Choose columns / filters and press Run. Rows with a link open the source record.</p></div></div></div>`;
    const $ = (s) => body.querySelector(s);
    const sync = () => {
      def.columns = Array.from(body.querySelectorAll('[data-col]:checked')).map(c => c.dataset.col);
      def.filters = def.filters.map((f, i) => ({ field: $(`[data-ff="${i}"]`).value, op: $(`[data-fo="${i}"]`).value, value: $(`[data-fv="${i}"]`).value, value2: $(`[data-fv2="${i}"]`)?.value }));
      def.group_by = [$('#b-g1').value, $('#b-g2').value].filter(Boolean);
      def.aggregates = def.aggregates.map((a, i) => ({ fn: $(`[data-af="${i}"]`).value, field: $(`[data-ak="${i}"]`).value }));
      def.sort = $('#b-sort').value ? [{ field: $('#b-sort').value, dir: $('#b-dir').value }] : [];
    };
    $('#b-src').addEventListener('change', () => { def.source = $('#b-src').value; def.columns = []; def.filters = []; def.group_by = []; def.aggregates = []; def.sort = []; draw(); });
    $('#b-addf').addEventListener('click', () => { sync(); def.filters.push({ field: S.fields[0].key, op: 'eq', value: '' }); draw(); });
    $('#b-adda').addEventListener('click', () => { sync(); const f = S.fields.find(numeric) || S.fields[0]; def.aggregates.push({ fn: numeric(f) ? 'sum' : 'count', field: f.key }); draw(); });
    body.querySelectorAll('[data-fx]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); sync(); def.filters.splice(Number(a.dataset.fx), 1); draw(); }));
    body.querySelectorAll('[data-ax]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); sync(); def.aggregates.splice(Number(a.dataset.ax), 1); draw(); }));
    body.querySelectorAll('[data-fo]').forEach(s => s.addEventListener('change', () => { sync(); draw(); }));
    const runIt = async () => {
      sync();
      const t = await API.post('/api/report-builder/run', { definition: def });
      const d = btoa(unescape(encodeURIComponent(JSON.stringify({ ...def, name: savedReport ? savedReport.name : undefined })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      $('#b-exp').innerHTML = exportLinks(`/api/report-builder/export?d=${d}`);
      $('#b-out').innerHTML = `<p class="muted" style="margin:0 0 6px">${escapeHtml(t.subtitle)}</p>${reportTableHtml(t)}`; bindDrill($('#b-out'), t);
    };
    $('#b-run').addEventListener('click', () => runIt().catch(e => toast(e.message, true)));
    $('#b-save').addEventListener('click', async () => {
      sync();
      try {
        if (savedReport) { await API.put('/api/saved-reports/' + savedReport.id, { definition: def }); toast('Saved'); }
        else { const name = prompt('Report name:'); if (!name) return; const r = await API.post('/api/saved-reports', { name, definition: def }); toast('Report saved'); go('#/reports', { saved: r.id }); }
      } catch (e) { toast(e.message, true); }
    });
    const del = body.querySelector('#b-del'); if (del) del.addEventListener('click', async () => { if (!confirm('Delete this saved report?')) return; await API.del('/api/saved-reports/' + savedReport.id); go('#/reports', { builder: 1 }); });
    if (savedReport) runIt().catch(e => toast(e.message, true));
  };
  draw();
}

/* ===================== ACCOUNTING ===================== */
async function renderAccounting(main, params = {}) {
  const tab = params.tab || 'coa';
  const T = [['coa', 'Chart of accounts'], ['journals', 'Journals'], ['period', 'Period-end'], ['imports', 'Legacy data import']].filter(([k]) => k !== 'imports' || can('imports.edit'));
  main.innerHTML = `<div class="page-header"><h2>Accounting</h2></div>
    <div class="tabs" id="acc-tabs">${T.map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="acc-body"></div>`;
  main.querySelectorAll('#acc-tabs .tab').forEach(t => t.addEventListener('click', () => go('#/accounting', { tab: t.dataset.tab })));
  const body = document.getElementById('acc-body');
  if (tab === 'journals') return accJournals(body);
  if (tab === 'period') return accPeriod(body);
  if (tab === 'imports') return accImports(body);
  return accCoa(body);
}

async function accCoa(body) {
  const accts = await API.get('/api/accounts');
  body.innerHTML = `<div class="toolbar">${can('accounts.edit') ? '<button class="btn small" id="gl-add">+ Add GL account</button>' : ''}
      <input type="text" id="gl-q" placeholder="Search code or name…"><label class="muted"><input type="checkbox" id="gl-zero" style="width:auto"> hide zero balances</label>
      <span class="muted">6-digit codes: 1 assets · 2 liabilities · 3 equity · 4 revenue · 5 direct costs · 6 operating expenses · 7 other / finance · 8 tax</span>
      <span style="margin-left:auto">${exportLinks('/api/reports/run/trial_balance')}</span></div>
    <div class="table-wrap"><table class="gl-tree"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th>IFRS line</th><th class="num">Postings</th><th class="num">Balance</th><th></th></tr></thead><tbody id="gl-body"></tbody></table></div>`;
  const draw = () => {
    const q = body.querySelector('#gl-q').value.toLowerCase(), hz = body.querySelector('#gl-zero').checked;
    body.querySelector('#gl-body').innerHTML = accts.filter(a => (!q || a.code.includes(q) || a.name.toLowerCase().includes(q)) && (!hz || a.is_header || Math.abs(a.balance) > 0.004)).map(a => `<tr class="${a.is_header ? 'hdr' : 'drill'}${a.is_active ? '' : ' inactive'}" data-code="${a.code}">
      <td>${a.is_header ? '' : '&nbsp;&nbsp;'}${escapeHtml(a.code)}</td><td>${escapeHtml(a.name)}${a.is_system ? ' <span class="muted" style="font-size:10px" title="Used by automatic postings">●</span>' : ''}${a.is_active ? '' : ' <span class="muted">(inactive)</span>'}</td>
      <td class="muted">${escapeHtml(a.account_type)}</td><td class="muted" style="font-size:12px">${escapeHtml(a.ifrs_line || '')}</td><td class="num">${a.is_header ? '' : a.postings}</td><td class="num">${fmtNum(a.balance)}</td>
      <td>${!a.is_header && can('accounts.edit') ? `<a href="#" data-edit="${a.code}">edit</a>` : ''}</td></tr>`).join('');
    body.querySelectorAll('tr.drill').forEach(tr => tr.addEventListener('click', (e) => { if (e.target.closest('a')) return; viewLedger(tr.dataset.code); }));
    body.querySelectorAll('[data-edit]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); glForm(accts.find(x => x.code === a.dataset.edit), () => accCoa(body)); }));
  };
  body.querySelector('#gl-q').addEventListener('input', draw); body.querySelector('#gl-zero').addEventListener('change', draw);
  const add = body.querySelector('#gl-add'); if (add) add.addEventListener('click', () => glForm(null, () => accCoa(body)));
  draw();
}

function glForm(a, onSave) {
  const LINES = ['Cash and cash equivalents', 'Trade and other receivables', 'Inventories', 'Current tax assets', 'Property, plant and equipment', 'Trade and other payables', 'Other taxes payable', 'Current tax liabilities', 'Customer deposits', 'Contract liabilities', 'Borrowings', 'Share capital', 'Retained earnings',
    'Revenue — rental income (IFRS 16)', 'Revenue — services (IFRS 15)', 'Revenue — sale of goods (IFRS 15)', 'Other operating income', 'Cost of sales', 'Selling & distribution expenses', 'Administrative expenses', 'Impairment of financial assets', 'Other operating expenses', 'Finance costs', 'Income tax expense'];
  openModal(a ? `GL ${escapeHtml(a.code)}` : 'Add GL account', `
    ${a ? '' : `<div class="grid-2"><div class="field"><label>6-digit code</label><input id="gl-code" maxlength="6" placeholder="e.g. 102200"><div class="help" id="gl-cls"></div></div>
      <div class="field"><label>Type</label><input id="gl-type" disabled></div></div>`}
    <div class="field"><label>Name</label><input id="gl-name" value="${escapeHtml(a ? a.name : '')}" placeholder="e.g. Bank — Zenith (USD domiciliary)"></div>
    <div class="field"><label>Financial-statement line (IFRS presentation)</label><select id="gl-ifrs"><option value="">— choose —</option>${LINES.map(l => `<option ${a && a.ifrs_line === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Description</label><input id="gl-desc" value="${escapeHtml(a ? a.description || '' : '')}"></div>
    <div class="field"><label><input type="checkbox" id="gl-man" style="width:auto;margin-right:6px" ${!a || a.allow_manual ? 'checked' : ''}>Allow manual journals</label></div>
    ${a && !a.is_system ? `<div class="field"><label><input type="checkbox" id="gl-act" style="width:auto;margin-right:6px" ${a.is_active ? 'checked' : ''}>Active</label></div>` : ''}
    <button class="btn" id="gl-save">Save</button>${a && !a.is_system && !a.postings ? ' <button class="btn secondary" id="gl-del">Delete</button>' : ''}<div class="error-msg" id="gl-err"></div>`, (m) => {
    const CL = { 1: 'asset', 2: 'liability', 3: 'equity', 4: 'income', 5: 'expense', 6: 'expense', 7: 'expense', 8: 'expense' };
    const c = m.querySelector('#gl-code'); if (c) c.addEventListener('input', () => { m.querySelector('#gl-type').value = CL[c.value[0]] || ''; m.querySelector('#gl-cls').textContent = /^\d{6}$/.test(c.value) ? '' : 'Exactly 6 digits'; });
    m.querySelector('#gl-save').addEventListener('click', async () => {
      const body = { name: m.querySelector('#gl-name').value, ifrs_line: m.querySelector('#gl-ifrs').value, description: m.querySelector('#gl-desc').value, allow_manual: m.querySelector('#gl-man').checked };
      try {
        if (a) { if (m.querySelector('#gl-act')) body.is_active = m.querySelector('#gl-act').checked; await API.put('/api/accounts/' + a.code, body); }
        else await API.post('/api/accounts', { ...body, code: c.value.trim() });
        m.remove(); toast('GL account saved'); onSave();
      } catch (e) { m.querySelector('#gl-err').textContent = e.message; }
    });
    const d = m.querySelector('#gl-del'); if (d) d.addEventListener('click', async () => { try { await API.del('/api/accounts/' + a.code); m.remove(); onSave(); } catch (e) { m.querySelector('#gl-err').textContent = e.message; } });
  });
}

async function accJournals(body) {
  const [mj, recent] = await Promise.all([can('journals.view') ? API.get('/api/manual-journals') : Promise.resolve([]), API.get('/api/journal-entries')]);
  body.innerHTML = `${can('journals.view') ? `<div class="card"><h3>Manual journals (maker-checker) ${can('journals.edit') ? '<button class="btn small" id="mj-new" style="float:right">+ New journal</button>' : ''}</h3>
    <div class="table-wrap"><table><thead><tr><th>Ref</th><th>Date</th><th>Narration</th><th class="num">Amount</th><th>Prepared by</th><th>Status</th><th>Entry</th><th></th></tr></thead><tbody>
    ${mj.map(j => `<tr><td>${escapeHtml(j.ref)}</td><td>${j.entry_date}</td><td>${escapeHtml(j.memo)}<div class="muted" style="font-size:11px">${j.lines.map(l => `${l.code} ${l.debit ? 'Dr ' + fmtNum(l.debit) : 'Cr ' + fmtNum(l.credit)}`).join(' · ')}</div></td><td class="num">${fmtMoney(j.total)}</td>
      <td>${escapeHtml(j.created_by_name || '')}</td><td>${badge(j.status)}${j.reject_reason ? ' <span class="muted">' + escapeHtml(j.reject_reason) + '</span>' : ''}</td><td>${j.entry_number ? `<a href="#" data-je="${j.journal_entry_id}">${escapeHtml(j.entry_number)}</a>` : ''}</td>
      <td class="row-actions">${j.status === 'pending' && can('journals.approve') && j.created_by !== CURRENT_USER.id ? `<a href="#" data-ok="${j.id}">Approve &amp; post</a> · <a href="#" data-no="${j.id}">Reject</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-state">No manual journals.</td></tr>'}</tbody></table></div></div>` : ''}
    <div class="card"><h3>General journal (latest 500)</h3><div class="toolbar"><input type="text" id="je-q" placeholder="Entry no. or memo…"><span style="margin-left:auto">${exportLinks('/api/reports/run/journal_register?from=2000-01-01')}</span></div>
    <div class="table-wrap"><table><thead><tr><th>Entry</th><th>Date</th><th>Memo</th><th>Source</th><th class="num">Amount</th><th>By</th></tr></thead><tbody id="je-body"></tbody></table></div></div>`;
  const drawJe = () => { const q = body.querySelector('#je-q').value.toLowerCase(); body.querySelector('#je-body').innerHTML = recent.filter(e => !q || e.entry_number.toLowerCase().includes(q) || (e.memo || '').toLowerCase().includes(q)).map(e => `<tr class="drill" data-e="${e.id}"><td>${escapeHtml(e.entry_number)}</td><td>${e.entry_date}</td><td>${escapeHtml(e.memo || '')}</td><td class="muted">${escapeHtml(e.source_type || '')}</td><td class="num">${fmtNum(e.total)}</td><td class="muted">${escapeHtml(e.created_by_name || '')}</td></tr>`).join(''); body.querySelectorAll('[data-e]').forEach(r => r.addEventListener('click', () => viewJournalEntry(r.dataset.e))); };
  body.querySelector('#je-q').addEventListener('input', drawJe); drawJe();
  body.querySelectorAll('[data-je]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); viewJournalEntry(a.dataset.je); }));
  body.querySelectorAll('[data-ok]').forEach(a => a.addEventListener('click', async (e) => { e.preventDefault(); try { const r = await API.post(`/api/manual-journals/${a.dataset.ok}/decide`, { decision: 'approved' }); toast('Posted ' + r.entry_number); accJournals(body); } catch (x) { toast(x.message, true); } }));
  body.querySelectorAll('[data-no]').forEach(a => a.addEventListener('click', async (e) => { e.preventDefault(); const reason = prompt('Reason for rejecting:'); if (!reason) return; try { await API.post(`/api/manual-journals/${a.dataset.no}/decide`, { decision: 'rejected', reason }); accJournals(body); } catch (x) { toast(x.message, true); } }));
  const nb = body.querySelector('#mj-new'); if (nb) nb.addEventListener('click', () => manualJournalForm(() => accJournals(body)));
}

async function manualJournalForm(onSave) {
  const accts = (await API.get('/api/accounts')).filter(a => !a.is_header && a.is_active && a.allow_manual);
  const opts = accts.map(a => `<option value="${a.code}">${a.code} ${escapeHtml(a.name)}</option>`).join('');
  const row = () => `<div class="le-row"><select class="le-a"><option value="">Account…</option>${opts}</select><input class="le-d" type="number" min="0" step="0.01" placeholder="Debit"><input class="le-c" type="number" min="0" step="0.01" placeholder="Credit"><input class="le-n" placeholder="Line note"><a href="#" class="le-x">×</a></div>`;
  openModal('New manual journal', `<div class="grid-2"><div class="field"><label>Date</label><input type="date" id="mj-d" value="${new Date().toISOString().slice(0, 10)}"></div><div class="field"><label>Narration</label><input id="mj-m" placeholder="e.g. Reclassify Q3 insurance prepayment"></div></div>
    <div class="lines-editor" id="mj-lines">${row()}${row()}</div><button class="btn small secondary" id="mj-add">+ Line</button>
    <p id="mj-tot" class="muted"></p><p class="help muted">A different user with approval rights must approve before it posts.</p><button class="btn" id="mj-go">Submit for approval</button><div class="error-msg" id="mj-err"></div>`, (m) => {
    m.querySelector('.modal').classList.add('wide');
    const tot = () => { let d = 0, c = 0; m.querySelectorAll('.le-row').forEach(r => { d += Number(r.querySelector('.le-d').value || 0); c += Number(r.querySelector('.le-c').value || 0); }); m.querySelector('#mj-tot').innerHTML = `Debits ${fmtMoney(d)} · Credits ${fmtMoney(c)} ${Math.abs(d - c) < 0.005 && d > 0 ? '<span style="color:var(--green)">balanced</span>' : '<span style="color:var(--red)">difference ' + fmtMoney(d - c) + '</span>'}`; };
    const bind = () => { m.querySelectorAll('.le-x').forEach(x => x.onclick = (e) => { e.preventDefault(); x.parentElement.remove(); tot(); }); m.querySelectorAll('input').forEach(i => i.oninput = tot); };
    m.querySelector('#mj-add').addEventListener('click', () => { m.querySelector('#mj-lines').insertAdjacentHTML('beforeend', row()); bind(); });
    bind(); tot();
    m.querySelector('#mj-go').addEventListener('click', async () => {
      const lines = Array.from(m.querySelectorAll('.le-row')).map(r => ({ code: r.querySelector('.le-a').value, debit: Number(r.querySelector('.le-d').value || 0), credit: Number(r.querySelector('.le-c').value || 0), description: r.querySelector('.le-n').value })).filter(l => l.code);
      try { const r = await API.post('/api/manual-journals', { entry_date: m.querySelector('#mj-d').value, memo: m.querySelector('#mj-m').value, lines }); m.remove(); toast(`${r.ref} submitted for approval`); onSave(); } catch (e) { m.querySelector('#mj-err').textContent = e.message; }
    });
  });
}

async function accPeriod(body) {
  const st = await API.get('/api/accounting/status');
  const lastMonth = new Date(); lastMonth.setDate(0);
  const pm = lastMonth.toISOString().slice(0, 7), pme = lastMonth.toISOString().slice(0, 10);
  const [dep, acc] = await Promise.all([API.get('/api/accounting/depreciation?period=' + pm), API.get('/api/accounting/accruals?as_of=' + pme)]);
  const canPost = can('journals.edit'), canApprove = can('journals.approve');
  body.innerHTML = `
    <div class="tax-grid">
      <div class="tax-box"><div class="k">Books locked up to</div><div class="v">${st.books_locked_until || 'Open'}</div><div class="s">No postings on/before this date</div></div>
      <div class="tax-box"><div class="k">Last depreciation run</div><div class="v">${st.last_depreciation || '—'}</div><div class="s">IAS 16 straight-line, monthly</div></div>
      <div class="tax-box"><div class="k">Last unbilled-rental accrual</div><div class="v">${st.last_accrual || '—'}</div><div class="s">Auto-reverses next day</div></div>
      <div class="tax-box"><div class="k">Last ECL true-up</div><div class="v">${st.last_ecl || '—'}</div><div class="s">IFRS 9 provision matrix</div></div>
      <div class="tax-box"><div class="k">Opening balances</div><div class="v">${st.opening_balances ? st.opening_balances.as_of_date : 'Not imported'}</div><div class="s">${st.opening_balances ? st.opening_balances.batch_number : 'Accounting → Legacy data import'}</div></div>
    </div>
    <p class="muted">Month-end checklist: ① record all bills and receipts → ② run depreciation → ③ accrue unbilled rentals → ④ true-up the ECL allowance → ⑤ review the trial balance & VAT/WHT working paper → ⑥ lock the month.</p>
    <div class="grid-2">
      <div class="card"><h3>② Depreciation</h3><div class="toolbar"><input type="month" id="dp-m" value="${pm}"><span class="muted" id="dp-sum">${dep.preview.lines.length} asset(s) · ${fmtMoney(dep.preview.total)}</span></div>
        ${canPost ? '<button class="btn small" id="dp-run">Post depreciation</button>' : ''}
        <div style="max-height:200px;overflow:auto;margin-top:8px;font-size:12px">${dep.runs.map(r => `<div>${r.period} · ${fmtMoney(r.total_amount)} · ${r.assets} assets · ${badge(r.status)} ${r.entry_number ? `<a href="#" data-je="${r.journal_entry_id}">${escapeHtml(r.entry_number)}</a>` : ''} ${r.status === 'posted' && canApprove ? `<a href="#" data-rev="${r.id}">reverse</a>` : ''}</div>`).join('') || '<span class="muted">No runs yet.</span>'}</div></div>
      <div class="card"><h3>③ Unbilled rental accrual</h3><div class="toolbar"><input type="date" id="ac-d" value="${pme}"><span class="muted" id="ac-sum">${acc.preview.lines.length} booking(s) · ${fmtMoney(acc.preview.total)}</span></div>
        ${canPost ? '<button class="btn small" id="ac-run">Post accrual (auto-reversing)</button>' : ''}
        <div style="max-height:200px;overflow:auto;margin-top:8px;font-size:12px" id="ac-list">${acc.preview.lines.map(l => `<div><a href="#" data-agr="${l.agreement_id}">${escapeHtml(l.agreement_number)}</a> · ${l.days} day(s) · ${fmtMoney(l.amount)}</div>`).join('')}</div></div>
      <div class="card"><h3>④ Expected credit loss (IFRS 9)</h3><div class="toolbar"><input type="date" id="ecl-d" value="${new Date().toISOString().slice(0, 10)}"></div>
        <p class="muted" style="font-size:13px">Recomputes the allowance from the receivables ageing and the provision matrix (Admin → Settings → Accounting) and posts the difference.</p>
        ${canPost ? '<button class="btn small" id="ecl-run">True-up ECL allowance</button>' : ''} <a href="#" id="ecl-aging">View ageing →</a></div>
      <div class="card"><h3>⑥ Lock period / year-end</h3>
        <div class="toolbar"><label class="muted">Lock books up to</label><input type="date" id="lk-d" value="${st.books_locked_until || pme}">${canApprove ? '<button class="btn small" id="lk-go">Lock</button><button class="btn small secondary" id="lk-open">Unlock</button>' : ''}</div>
        <div class="toolbar"><label class="muted">Year-end close at</label><input type="date" id="ye-d" value="${new Date().getFullYear() - 1}-12-31">${canApprove ? '<button class="btn small danger" id="ye-go">Close year</button>' : ''}</div>
        <p class="muted" style="font-size:12px">Year-end close moves the year's income and expenses into retained earnings (302000) and locks the year.</p></div>
    </div>`;
  const $ = (s) => body.querySelector(s);
  const act = async (fn, msg) => { try { const r = await fn(); toast(msg(r)); accPeriod(body); } catch (e) { toast(e.message, true); } };
  $('#dp-m').addEventListener('change', async () => { const d = await API.get('/api/accounting/depreciation?period=' + $('#dp-m').value); $('#dp-sum').textContent = `${d.preview.lines.length} asset(s) · ${fmtMoney(d.preview.total)}`; });
  $('#ac-d').addEventListener('change', async () => { const d = await API.get('/api/accounting/accruals?as_of=' + $('#ac-d').value); $('#ac-sum').textContent = `${d.preview.lines.length} booking(s) · ${fmtMoney(d.preview.total)}`; });
  const b = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
  b('#dp-run', () => act(() => API.post('/api/accounting/depreciation/run', { period: $('#dp-m').value }), r => `Depreciation ${r.period}: ${fmtMoney(r.total)} on ${r.assets} assets (${r.entry_number})`));
  b('#ac-run', () => act(() => API.post('/api/accounting/accruals/run', { as_of: $('#ac-d').value }), r => `Accrued ${fmtMoney(r.total)} (${r.entry_number}, reversal ${r.reversal_entry})`));
  b('#ecl-run', () => act(() => API.post('/api/accounting/ecl/run', { as_of: $('#ecl-d').value }), r => r.adjustment ? `ECL adjusted by ${fmtMoney(r.adjustment)} (${r.entry_number})` : r.message));
  b('#lk-go', () => act(() => API.put('/api/accounting/lock', { locked_until: $('#lk-d').value }), () => 'Period locked'));
  b('#lk-open', () => act(() => API.put('/api/accounting/lock', { locked_until: '' }), () => 'Books unlocked'));
  b('#ye-go', () => { if (confirm('Close the financial year? Income and expenses are moved to retained earnings and the year is locked.')) act(() => API.post('/api/accounting/year-end-close', { year_end_date: $('#ye-d').value }), r => `Year closed — profit ${fmtMoney(r.profit)} to retained earnings`); });
  b('#ecl-aging', (e) => { e.preventDefault(); go('#/reports', { r: 'ar_aging' }); });
  body.querySelectorAll('[data-rev]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); if (confirm('Reverse this depreciation run?')) act(() => API.post(`/api/accounting/depreciation/${a.dataset.rev}/reverse`), () => 'Run reversed'); }));
  body.querySelectorAll('[data-je]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); viewJournalEntry(a.dataset.je); }));
  body.querySelectorAll('[data-agr]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); viewAgreement(a.dataset.agr); }));
}

async function accImports(body) {
  const [kinds, batches] = await Promise.all([API.get('/api/imports/kinds'), API.get('/api/imports')]);
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  body.innerHTML = `<div class="grid-2"><div class="card import-steps"><h3>Migrate balances from your previous system</h3>
      <div><strong>Choose what you are importing</strong><select id="im-k" style="width:100%;margin-top:6px;padding:8px;background:var(--charcoal);border:1px solid var(--line);color:var(--text)">${kinds.map(k => `<option value="${k.key}">${escapeHtml(k.label)}</option>`).join('')}</select><p class="muted" id="im-help" style="font-size:12px"></p>
        <div class="export-row">Template: <a id="im-tc" href="#">CSV</a><a id="im-tx" href="#">Excel</a></div></div>
      <div><strong>Migration date</strong> <span class="muted">(balances "as at" — normally the day before go-live)</span><br><input type="date" id="im-d" value="${yday}" style="margin-top:6px"></div>
      <div><strong>Upload the file</strong> <span class="muted">(.csv or .xlsx, first row = column headers)</span><br><input type="file" id="im-f" accept=".csv,.xlsx,text/csv" style="margin-top:6px"></div>
      <div><strong>Options</strong>
        <label class="muted" style="display:block"><input type="checkbox" id="im-gl" style="width:auto"> Post to the general ledger against opening-balance equity (303000) — <em>only if these balances are NOT in your opening trial balance</em></label>
        <label class="muted" style="display:block"><input type="checkbox" id="im-plug" style="width:auto"> Opening TB: post any difference to opening-balance equity</label>
        <label class="muted" style="display:block"><input type="checkbox" id="im-create" style="width:auto"> Opening TB: create GL accounts that do not exist yet</label>
        <label class="muted" style="display:block"><input type="checkbox" id="im-skip" style="width:auto"> Skip rows with errors</label>
        <label class="muted" style="display:block"><input type="checkbox" id="im-add" style="width:auto"> This is an additional opening-balance batch</label></div>
      <div><button class="btn" id="im-prev">Validate (nothing is saved)</button> <button class="btn secondary" id="im-go" disabled>Import</button></div>
    </div>
    <div class="card"><h3>Recommended order</h3><ol class="muted" style="font-size:13px;line-height:1.7;margin:0;padding-left:18px">
      <li><strong>Opening trial balance</strong> as at the migration date — this carries the GL values (bank, receivables & payables control, fixed assets, VAT, equity).</li>
      <li><strong>Customer open invoices</strong> and <strong>supplier unpaid bills</strong> — subledger detail that reconciles to the control accounts (leave "post to GL" unticked).</li>
      <li><strong>Equipment register</strong> with cost and accumulated depreciation — monthly depreciation continues from there.</li>
      <li><strong>Consumables stock</strong>, <strong>customers</strong> and the <strong>crew rate card</strong>.</li>
      <li>Check Reports → Trial balance and Receivables ageing against the old system, then lock the migration date (Accounting → Period-end).</li></ol></div></div>
    <div id="im-out"></div>
    <div class="card"><h3>Import history</h3><div class="table-wrap"><table><thead><tr><th>Batch</th><th>Type</th><th>File</th><th>As at</th><th class="num">Rows</th><th>Journal</th><th>Status</th><th>By</th><th></th></tr></thead><tbody>
      ${batches.map(b => `<tr><td>${escapeHtml(b.batch_number)}</td><td>${escapeHtml(b.label || b.kind)}</td><td class="muted">${escapeHtml(b.filename || '')}</td><td>${escapeHtml(b.as_of_date || '')}</td><td class="num">${b.rows_ok}/${b.rows_total}</td>
        <td>${b.entry_number ? `<a href="#" data-je="${b.journal_entry_id}">${escapeHtml(b.entry_number)}</a>` : '<span class="muted">subledger only</span>'}</td><td>${badge(b.status)}</td><td class="muted">${escapeHtml(b.created_by_name || '')}</td>
        <td>${b.status === 'posted' && b.journal_entry_id ? `<a href="#" data-rev="${b.id}">reverse</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty-state">No imports yet.</td></tr>'}</tbody></table></div></div>`;
  const $ = (s) => body.querySelector(s);
  const setK = () => { const k = kinds.find(x => x.key === $('#im-k').value); $('#im-help').textContent = k.help + ' Columns: ' + k.columns.join(', '); $('#im-tc').href = `/api/imports/templates/${k.key}.csv`; $('#im-tx').href = `/api/imports/templates/${k.key}.xlsx`; $('#im-go').disabled = true; };
  $('#im-k').addEventListener('change', setK); setK();
  const payload = async () => {
    const f = $('#im-f').files[0]; if (!f) throw new Error('Choose a file to upload');
    return { filename: f.name, content_base64: await fileToBase64(f), as_of_date: $('#im-d').value, post_to_gl: $('#im-gl').checked, plug_to_obe: $('#im-plug').checked, create_missing: $('#im-create').checked, skip_errors: $('#im-skip').checked, confirm_additional: $('#im-add').checked };
  };
  $('#im-f').addEventListener('change', () => { $('#im-go').disabled = true; });
  $('#im-prev').addEventListener('click', async () => {
    try {
      const r = await API.post(`/api/imports/${$('#im-k').value}/preview`, await payload());
      const cols = Object.keys(r.rows[0] ? r.rows[0].data : {});
      $('#im-out').innerHTML = `<div class="card"><h3>Validation — ${r.ok_rows} ok · ${r.error_rows} with errors</h3>
        <p class="muted">${Object.entries(r.summary).map(([k, v]) => `${escapeHtml(k.replace(/_/g, ' '))}: <strong>${typeof v === 'number' ? fmtNum(v) : escapeHtml(String(v))}</strong>`).join(' · ')}</p>
        ${r.blocking ? `<div class="notice bad">${escapeHtml(r.blocking)}</div>` : ''}
        <div class="table-wrap" style="max-height:360px;overflow:auto"><table><thead><tr><th>Row</th>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}<th>Messages</th></tr></thead><tbody>
        ${r.rows.slice(0, 500).map(x => `<tr class="${x.ok ? '' : 'row-err'}"><td>${x.row}</td>${cols.map(c => `<td>${escapeHtml(typeof x.data[c] === 'number' ? fmtNum(x.data[c]) : (x.data[c] ?? ''))}</td>`).join('')}<td style="font-size:12px">${x.errors.map(e => `<div style="color:var(--red)">✖ ${escapeHtml(e)}</div>`).join('')}${x.warnings.map(e => `<div class="muted">⚠ ${escapeHtml(e)}</div>`).join('')}</td></tr>`).join('')}</tbody></table></div></div>`;
      $('#im-go').disabled = !!r.blocking || (r.error_rows > 0 && !$('#im-skip').checked) || r.ok_rows === 0;
    } catch (e) { toast(e.message, true); }
  });
  $('#im-go').addEventListener('click', async () => {
    if (!confirm('Import these rows now? This is saved as one batch.')) return;
    try { const r = await API.post(`/api/imports/${$('#im-k').value}/commit`, await payload()); toast(`${r.batch_number}: ${r.imported} row(s) imported${r.journal_entry ? ' · posted ' + r.journal_entry : ''}`); accImports(body); }
    catch (e) { toast(e.message, true); }
  });
  body.querySelectorAll('[data-je]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); viewJournalEntry(a.dataset.je); }));
  body.querySelectorAll('[data-rev]').forEach(a => a.addEventListener('click', async (e) => { e.preventDefault(); if (!confirm('Reverse this batch’s ledger posting?')) return; try { await API.post(`/api/imports/${a.dataset.rev}/reverse`); toast('Reversed'); accImports(body); } catch (x) { toast(x.message, true); } }));
}
