/* ===================== SHARED HELPERS (v1.3) ===================== */
// Open the source record behind any drill target ({ invoice_id }, { agreement_id }, { account } …).
function drill(d) {
  if (!d) return;
  if (d.invoice_id) return viewInvoice(d.invoice_id);
  if (d.agreement_id) return viewAgreement(d.agreement_id);
  if (d.customer_id) return viewCustomer(d.customer_id);
  if (d.equipment_id) return viewEquipment(d.equipment_id);
  if (d.entry_id) return viewJournalEntry(d.entry_id);
  if (d.account) return viewLedger(d.account);
  if (d.expense_id) return go('#/finance', { tab: 'expenses', open: d.expense_id });
  if (d.voucher_id) return go('#/vouchers');
  if (d.manual_journal_id) return go('#/accounting', { tab: 'journals' });
  if (d.claim_id) return go('#/claims', { open: d.claim_id });
}

const fmtNum = (n, dp = 2) => Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: dp, maximumFractionDigits: dp });
// Compact money for tiles: 1,234,567 -> ₦1.23m
function fmtShort(n) {
  const v = Number(n || 0), a = Math.abs(v), sign = v < 0 ? '−' : '';
  const sym = (BRAND.currency || 'NGN') === 'NGN' ? '₦' : (BRAND.currency || '') + ' ';
  if (a >= 1e9) return `${sign}${sym}${(a / 1e9).toFixed(2)}bn`;
  if (a >= 1e6) return `${sign}${sym}${(a / 1e6).toFixed(2)}m`;
  if (a >= 1e3) return `${sign}${sym}${(a / 1e3).toFixed(0)}k`;
  return `${sign}${sym}${a.toFixed(0)}`;
}
function cellFmt(v, type) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return fmtNum(v);
  if (type === 'integer') return Number(v).toLocaleString('en-NG');
  if (type === 'number') return Number(v).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  return escapeHtml(v);
}
// Renders a report table (columns / rows / totals) with drill-through on rows carrying _drill.
function reportTableHtml(t) {
  const num = (c) => ['money', 'integer', 'number'].includes(c.type);
  const head = `<tr>${t.columns.map(c => `<th class="${num(c) ? 'num' : ''}">${escapeHtml(c.header)}</th>`).join('')}</tr>`;
  const body = t.rows.map((r, i) => {
    const cls = [r._style || '', r._drill ? 'drill' : ''].join(' ').trim();
    return `<tr class="${cls}" ${r._drill ? `data-ri="${i}" title="Open source record"` : ''}>${t.columns.map((c, ci) => {
      let v = r[c.key]; if (ci === 0 && (v === undefined || v === '' || v === null) && r._style) v = r.line || r.section || r.kind || r.memo || '';
      return `<td class="${num(c) ? 'num' : ''}">${cellFmt(v, c.type)}</td>`; }).join('')}</tr>`;
  }).join('');
  const tot = t.totals ? `<tr class="total">${t.columns.map((c, i) => `<td class="${num(c) ? 'num' : ''}">${cellFmt(t.totals[c.key] ?? (i === 0 ? 'TOTAL' : ''), c.type)}</td>`).join('')}</tr>` : '';
  return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body || `<tr><td colspan="${t.columns.length}" class="empty-state">No data for these criteria.</td></tr>`}${tot}</tbody></table></div>`;
}
function bindDrill(container, t) {
  container.querySelectorAll('tr.drill').forEach(tr => tr.addEventListener('click', () => drill(t.rows[Number(tr.dataset.ri)]._drill)));
}
function exportLinks(baseUrl) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `<div class="export-row"><span class="muted" style="font-size:12px;align-self:center">Export:</span>${[['xlsx', 'Excel'], ['pdf', 'PDF'], ['csv', 'CSV'], ['json', 'JSON']].map(([f, l]) => `<a href="${baseUrl}${sep}format=${f}" ${f === 'json' ? 'target="_blank" rel="noopener"' : ''}>${l}</a>`).join('')}</div>`;
}
// Read a file as base64 for the import / photo endpoints.
function fileToBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
}
// Downscale photos in the browser (max 1600px, JPEG) before upload.
function shrinkImage(file, max = 1600) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Not an image')); };
    img.src = url;
  });
}
function photoStrip(list) {
  if (!list || !list.length) return '<span class="muted" style="font-size:12px">No photos yet.</span>';
  return `<div class="photos">${list.map(p => `<a href="/api/photos/${p.id}/raw" target="_blank" rel="noopener" title="${escapeHtml(p.caption || p.stage || '')}"><img src="/api/photos/${p.id}/raw" alt="${escapeHtml(p.caption || 'photo')}" loading="lazy"><span>${escapeHtml(p.stage || '')}</span></a>`).join('')}</div>`;
}
function photoUploadButton(entityType, entityId, stage, onDone, label = '+ Add photo') {
  const id = 'ph-' + Math.random().toString(36).slice(2);
  setTimeout(() => {
    const inp = document.getElementById(id); if (!inp) return;
    inp.addEventListener('change', async () => {
      for (const f of Array.from(inp.files || [])) {
        try { const data_url = await shrinkImage(f); await API.post('/api/photos', { entity_type: entityType, entity_id: entityId, stage, data_url, caption: f.name }); }
        catch (e) { toast(e.message, true); }
      }
      toast('Photo(s) uploaded'); if (onDone) onDone();
    });
  }, 0);
  return `<label class="btn small secondary" style="margin:0">${label}<input type="file" id="${id}" accept="image/*" capture="environment" multiple hidden></label>`;
}

// GL account ledger modal (drill from trial balance / balance sheet / dashboard cash tiles).
async function viewLedger(code, from, to) {
  const y = new Date().getFullYear();
  from = from || `${y}-01-01`; to = to || new Date().toISOString().slice(0, 10);
  const draw = async (ov) => {
    const f = ov.querySelector('#lg-from').value, t = ov.querySelector('#lg-to').value;
    const l = await API.get(`/api/accounts/${code}/ledger?from=${f}&to=${t}`);
    ov.querySelector('#lg-body').innerHTML = `<p class="muted" style="margin:4px 0">${escapeHtml(l.account.account_type)} · opening ${fmtMoney(l.opening_balance)} · closing <strong>${fmtMoney(l.closing_balance)}</strong></p>
      <div class="table-wrap" style="max-height:52vh;overflow:auto"><table><thead><tr><th>Date</th><th>Entry</th><th>Description</th><th>Source</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead><tbody>
      ${l.lines.map(x => `<tr class="drill" data-e="${x.entry_id}"><td>${x.entry_date}</td><td>${escapeHtml(x.entry_number)}</td><td>${escapeHtml(x.description || x.memo || '')}</td><td class="muted">${escapeHtml(x.source_type || '')}</td><td class="num">${x.debit ? fmtNum(x.debit) : ''}</td><td class="num">${x.credit ? fmtNum(x.credit) : ''}</td><td class="num">${fmtNum(x.balance)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-state">No postings in this period.</td></tr>'}
      <tr class="total"><td colspan="4">Period totals</td><td class="num">${fmtNum(l.total_debit)}</td><td class="num">${fmtNum(l.total_credit)}</td><td class="num">${fmtNum(l.closing_balance)}</td></tr></tbody></table></div>
      ${exportLinks(`/api/reports/run/general_ledger?account=${code}&from=${f}&to=${t}`)}`;
    ov.querySelectorAll('tr.drill').forEach(tr => tr.addEventListener('click', () => viewJournalEntry(tr.dataset.e)));
  };
  const acct = (await API.get('/api/accounts')).find(a => a.code === code) || { code, name: '' };
  openModal(`GL ${escapeHtml(code)} — ${escapeHtml(acct.name)}`, `
    <div class="toolbar"><label class="muted">From</label><input type="date" id="lg-from" value="${from}"><label class="muted">To</label><input type="date" id="lg-to" value="${to}"></div>
    <div id="lg-body">Loading…</div>`, (ov) => {
    ov.querySelector('.modal').classList.add('xwide');
    ov.querySelectorAll('input[type=date]').forEach(i => i.addEventListener('change', () => draw(ov)));
    draw(ov).catch(e => { ov.querySelector('#lg-body').innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; });
  });
}

async function viewJournalEntry(id) {
  const e = await API.get('/api/journal-entries/' + id);
  const td = e.lines.reduce((a, l) => a + l.debit, 0), tc = e.lines.reduce((a, l) => a + l.credit, 0);
  openModal(`Journal ${escapeHtml(e.entry_number)}`, `
    <p>${escapeHtml(e.entry_date)} · <span class="muted">${escapeHtml(e.source_type || 'manual')}</span> · by ${escapeHtml(e.created_by_name || 'system')}${e.reversed_by ? ' · <span class="badge reversed">reversed</span>' : ''}</p>
    <p>${escapeHtml(e.memo || '')}</p>
    <div class="table-wrap"><table><thead><tr><th>Account</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
    ${e.lines.map(l => `<tr class="drill" data-acct="${l.code}"><td>${escapeHtml(l.code)} ${escapeHtml(l.name)}</td><td class="muted">${escapeHtml(l.description || '')}</td><td class="num">${l.debit ? fmtNum(l.debit) : ''}</td><td class="num">${l.credit ? fmtNum(l.credit) : ''}</td></tr>`).join('')}
    <tr class="total"><td colspan="2">Total</td><td class="num">${fmtNum(td)}</td><td class="num">${fmtNum(tc)}</td></tr></tbody></table></div>
    ${e.link ? '<div class="btn-row" style="margin-top:12px"><button class="btn small secondary" id="je-src">Open source document</button></div>' : ''}`, (ov) => {
    ov.querySelector('.modal').classList.add('wide');
    ov.querySelectorAll('tr.drill').forEach(tr => tr.addEventListener('click', () => { ov.remove(); viewLedger(tr.dataset.acct); }));
    const s = ov.querySelector('#je-src'); if (s) s.addEventListener('click', () => { ov.remove(); drill(e.link); });
  });
}

/* ---------- tiny SVG charts (single axis, thin marks, hover tooltips) ---------- */
const CHART_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'];
function barChart(el, { labels, series, height = 220, onClick, fmt = fmtShort }) {
  const W = Math.max(320, el.clientWidth || 640), H = height, padL = 52, padB = 26, padT = 10, padR = 8;
  const max = Math.max(1, ...series.flatMap(s => s.values)) * 1.08;
  const n = labels.length, groupW = (W - padL - padR) / n, bw = Math.min(26, (groupW - 8) / series.length - 2);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max / 1.08 * f);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(series.map(s => s.name).join(' and '))} by month">`;
  for (const t of ticks) svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1" opacity=".6"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" font-size="10" fill="var(--text-dim)">${escapeHtml(fmtShort(t))}</text>`;
  labels.forEach((lb, i) => {
    const gx = padL + i * groupW + (groupW - series.length * (bw + 2)) / 2;
    series.forEach((s, si) => {
      const v = s.values[i] || 0, x = gx + si * (bw + 2), top = y(v), h = Math.max(0, y(0) - top);
      svg += `<path d="M${x},${y(0)} V${top + Math.min(4, h)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${y(0)} Z" fill="${s.color}" data-i="${i}" data-s="${si}" class="bar-mark"/>`;
    });
    svg += `<rect x="${padL + i * groupW}" y="${padT}" width="${groupW}" height="${H - padT - padB}" fill="transparent" data-hit="${i}" style="cursor:${onClick ? 'pointer' : 'default'}"/>`;
    svg += `<text x="${padL + i * groupW + groupW / 2}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-dim)">${escapeHtml(lb)}</text>`;
  });
  svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--text-dim)" stroke-width="1"/></svg>`;
  el.innerHTML = `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${escapeHtml(s.name)}</span>`).join('')}</div><div class="chart-wrap">${svg}<div class="chart-tip"></div></div>`;
  const tip = el.querySelector('.chart-tip'), wrap = el.querySelector('.chart-wrap');
  el.querySelectorAll('[data-hit]').forEach(r => {
    r.addEventListener('mousemove', (e) => {
      const i = Number(r.dataset.hit); const b = wrap.getBoundingClientRect();
      tip.innerHTML = `<strong>${escapeHtml(labels[i])}</strong>${series.map(s => `<div><i style="display:inline-block;width:8px;height:8px;background:${s.color};margin-right:5px"></i>${escapeHtml(s.name)}: ${escapeHtml(fmtMoney(s.values[i]))}</div>`).join('')}`;
      tip.style.display = 'block'; tip.style.left = Math.min(b.width - 190, e.clientX - b.left + 12) + 'px'; tip.style.top = (e.clientY - b.top - 10) + 'px';
      el.querySelectorAll(`.bar-mark`).forEach(m => m.setAttribute('opacity', m.dataset.i === String(i) ? '1' : '.45'));
    });
    r.addEventListener('mouseleave', () => { tip.style.display = 'none'; el.querySelectorAll('.bar-mark').forEach(m => m.setAttribute('opacity', '1')); });
    if (onClick) r.addEventListener('click', () => onClick(Number(r.dataset.hit)));
  });
}
function hBars(items, { valueFmt = fmtShort, onClick } = {}) {
  const max = Math.max(1, ...items.map(i => i.value));
  const html = items.map((it, i) => `<div class="bar-row" data-bi="${i}" title="${escapeHtml(it.label)}: ${escapeHtml(valueFmt(it.value))}"><span class="nm">${escapeHtml(it.label)}</span><span class="track"><span class="fill" style="display:block;width:${Math.max(1, it.value * 100 / max)}%;${it.color ? 'background:' + it.color : ''}"></span></span><span class="val">${escapeHtml(valueFmt(it.value))}</span></div>`).join('');
  return { html: html || '<p class="muted">No data yet.</p>', bind: (root) => { if (onClick) root.querySelectorAll('[data-bi]').forEach(r => r.addEventListener('click', () => onClick(items[Number(r.dataset.bi)]))); } };
}
