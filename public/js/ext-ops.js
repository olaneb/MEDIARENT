/* ===================== QUOTES ===================== */
async function renderQuotes(main, params = {}) {
  main.innerHTML = `<div class="page-header"><h2>Quotes</h2>${can('quotes.edit') ? '<button class="btn" id="add-q">+ New quote</button>' : ''}</div>
    <p class="muted" style="margin-top:-6px">Price a job from the rate card before it is confirmed. Accepted quotes convert to a booking in one click (the equipment is then checked for availability).</p>
    <div class="toolbar"><select id="q-st"><option value="">All statuses</option>${['draft', 'sent', 'accepted', 'rejected', 'expired'].map(x => `<option>${x}</option>`).join('')}</select></div>
    <div class="table-wrap"><table><thead><tr><th>Quote</th><th>Customer</th><th>Created</th><th>Valid until</th><th class="num">Excl. VAT</th><th class="num">VAT</th><th class="num">Total</th><th>Status</th></tr></thead><tbody id="q-body"></tbody></table></div>`;
  const load = async () => {
    const st = document.getElementById('q-st').value;
    const rows = (await API.get('/api/quotes')).filter(q => !st || q.status === st);
    document.getElementById('q-body').innerHTML = rows.map(q => `<tr class="drill" data-q="${q.id}"><td>${escapeHtml(q.quote_number)}</td><td>${escapeHtml(q.customer_name)}</td><td>${fmtDate(q.created_at)}</td><td>${fmtDate(q.valid_until)}</td>
      <td class="num">${fmtMoney(q.subtotal)}</td><td class="num">${fmtMoney(q.tax_total)}</td><td class="num">${fmtMoney(q.total)}</td><td>${badge(q.status === 'accepted' ? 'approved' : q.status === 'sent' ? 'pending' : q.status)} <span class="muted" style="font-size:11px">${escapeHtml(q.status)}</span></td></tr>`).join('') || '<tr><td colspan="8" class="empty-state">No quotes yet.</td></tr>';
    document.querySelectorAll('[data-q]').forEach(r => r.addEventListener('click', () => viewQuote(r.dataset.q, load)));
  };
  document.getElementById('q-st').addEventListener('change', load);
  const add = document.getElementById('add-q'); if (add) add.addEventListener('click', () => quoteForm(load));
  await load();
  if (params.new && can('quotes.edit')) quoteForm(load);
  if (params.open) viewQuote(params.open, load);
}

async function quoteForm(onSave) {
  const [customers, equipment, cfg] = await Promise.all([API.get('/api/customers'), API.get('/api/equipment'), API.get('/api/tax/config')]);
  const lines = [];
  const m = openModal('New quote', `
    <div class="grid-2"><div class="field"><label>Customer</label><select id="qf-c">${customers.filter(c => !c.is_blacklisted).map(c => `<option value="${c.id}">${escapeHtml(c.full_name)}</option>`).join('')}</select></div>
    <div class="field"><label>Valid until</label><input type="date" id="qf-v" value="${new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)}"></div></div>
    <div class="grid-2"><div class="field"><label>Add item from the rate card</label><input type="search" id="qf-q" placeholder="Type to filter (e.g. Alexa, Aputure, studio)…"><select id="qf-e" size="6" style="margin-top:6px">${equipment.map(e => `<option value="${e.id}">${escapeHtml(e.name)} — ${fmtMoney(e.daily_rate)}/day</option>`).join('')}</select></div>
    <div><div class="field"><label>Days</label><input type="number" id="qf-d" min="1" value="1"></div><div class="field"><label>Qty</label><input type="number" id="qf-n" min="1" value="1"></div><button class="btn small secondary" id="qf-add">Add line</button></div></div>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Rate</th><th class="num">Qty</th><th class="num">Days</th><th class="num">Line total</th><th></th></tr></thead><tbody id="qf-lines"></tbody></table></div>
    <p id="qf-tot" class="muted"></p>
    <button class="btn" id="qf-save">Save quote</button><div class="error-msg" id="qf-err"></div>`, (ov) => ov.querySelector('.modal').classList.add('wide'));
  const $ = (s) => m.querySelector(s);
  const draw = () => {
    $('#qf-lines').innerHTML = lines.map((l, i) => `<tr><td>${escapeHtml(l.description)}</td><td class="num"><input type="number" data-r="${i}" value="${l.rate}" style="width:110px;padding:4px;background:var(--charcoal);border:1px solid var(--line);color:var(--text)"></td><td class="num">${l.qty}</td><td class="num">${l.duration}</td><td class="num">${fmtMoney(l.rate * l.qty * l.duration)}</td><td><a href="#" data-x="${i}">×</a></td></tr>`).join('') || '<tr><td colspan="6" class="empty-state">Add items above.</td></tr>';
    const net = lines.reduce((a, l) => a + l.rate * l.qty * l.duration, 0); const vat = cfg.vat_registered ? net * cfg.vat_rate / 100 : 0;
    $('#qf-tot').innerHTML = `Excl. VAT ${fmtMoney(net)} · VAT ${fmtMoney(vat)} · <strong>Total ${fmtMoney(net + vat)}</strong>`;
    m.querySelectorAll('[data-x]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); lines.splice(Number(a.dataset.x), 1); draw(); }));
    m.querySelectorAll('[data-r]').forEach(inp => inp.addEventListener('change', () => { lines[Number(inp.dataset.r)].rate = Number(inp.value || 0); draw(); }));
  };
  $('#qf-q').addEventListener('input', () => { const q = $('#qf-q').value.toLowerCase(); Array.from($('#qf-e').options).forEach(o => { o.hidden = q && !o.textContent.toLowerCase().includes(q); }); });
  $('#qf-add').addEventListener('click', () => {
    const e = equipment.find(x => String(x.id) === $('#qf-e').value); if (!e) return;
    lines.push({ equipment_id: e.id, description: e.name, rate_type: 'daily', rate: e.daily_rate, qty: Number($('#qf-n').value || 1), duration: Number($('#qf-d').value || 1) }); draw();
  });
  $('#qf-save').addEventListener('click', async () => {
    try { const r = await API.post('/api/quotes', { customer_id: Number($('#qf-c').value), valid_until: $('#qf-v').value, items: lines }); m.remove(); toast(`Quote ${r.quote_number} — ${fmtMoney(r.total)}`); onSave(); }
    catch (e) { $('#qf-err').textContent = e.message; }
  });
  draw();
}

async function viewQuote(id, reload) {
  const q = await API.get('/api/quotes/' + id);
  openModal(`${escapeHtml(q.quote_number)} — ${escapeHtml(q.customer_name)}`, `
    <p>${badge(q.status)} <span class="muted">valid until ${fmtDate(q.valid_until)}</span></p>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Rate</th><th class="num">Qty</th><th class="num">Days</th><th class="num">Total</th></tr></thead><tbody>
    ${q.items.map(i => `<tr><td>${escapeHtml(i.description || i.equipment_name || '')}</td><td class="num">${fmtMoney(i.rate)}</td><td class="num">${i.qty}</td><td class="num">${i.duration}</td><td class="num">${fmtMoney(i.line_total)}</td></tr>`).join('')}
    <tr class="total"><td colspan="4">Excl. VAT / VAT / Total</td><td class="num">${fmtMoney(q.subtotal)} / ${fmtMoney(q.tax_total)} / ${fmtMoney(q.total)}</td></tr></tbody></table></div>
    <div class="btn-row" style="margin-top:12px">
      ${can('quotes.edit') && ['draft', 'sent'].includes(q.status) ? '<button class="btn small secondary" data-s="sent">Mark sent</button><button class="btn small" data-s="accepted">Accepted</button><button class="btn small secondary" data-s="rejected">Rejected</button>' : ''}
      ${can('rentals.edit') && q.status === 'accepted' ? '<button class="btn small" id="qc">Convert to booking…</button>' : ''}
    </div><div class="error-msg" id="qv-err"></div>`, (ov) => {
    ov.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', async () => { try { await API.put(`/api/quotes/${id}/status`, { status: b.dataset.s }); ov.remove(); viewQuote(id, reload); reload && reload(); } catch (e) { ov.querySelector('#qv-err').textContent = e.message; } }));
    const qc = ov.querySelector('#qc'); if (qc) qc.addEventListener('click', () => openModal('Convert to booking', `<div class="grid-2"><div class="field"><label>Start</label><input type="date" id="cv-s" value="${new Date().toISOString().slice(0, 10)}"></div><div class="field"><label>Return</label><input type="date" id="cv-e" value="${new Date(Date.now() + (q.items[0]?.duration || 1) * 86400000).toISOString().slice(0, 10)}"></div></div>
      <div class="field"><label>Production name</label><input id="cv-p"></div><button class="btn" id="cv-go">Create booking</button><div class="error-msg" id="cv-err"></div>`, (m) => {
      m.querySelector('#cv-go').addEventListener('click', async () => { try { const r = await API.post(`/api/quotes/${id}/convert`, { start_date: m.querySelector('#cv-s').value, expected_return_date: m.querySelector('#cv-e').value, project_name: m.querySelector('#cv-p').value }); m.remove(); ov.remove(); toast(`Booking ${r.agreement_number} created`); viewAgreement(r.id); } catch (e) { m.querySelector('#cv-err').textContent = e.message; } });
    }));
  });
}

/* ===================== INSURANCE CLAIMS ===================== */
async function renderClaims(main, params = {}) {
  const [rows, cands] = await Promise.all([API.get('/api/claims'), can('claims.edit') ? API.get('/api/claims/candidates') : Promise.resolve([])]);
  main.innerHTML = `<div class="page-header"><h2>Insurance claims</h2>${can('claims.edit') ? '<button class="btn" id="add-claim">+ New claim</button>' : ''}</div>
    <p class="muted" style="margin-top:-6px">Track lost, stolen or damaged equipment through to the insurer's settlement. Approval books a claims receivable (117000 → 413000 insurance recoveries); settlement clears it to the bank.</p>
    ${cands.length ? `<div class="notice">${cands.length} lost / damaged item(s) without a claim: ${cands.slice(0, 6).map((c, i) => `<a href="#" data-cand="${i}">${escapeHtml(c.asset_code)} ${escapeHtml(c.name)} (${escapeHtml(c.agreement_number)})</a>`).join(', ')}</div>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Claim</th><th>Equipment</th><th>Booking</th><th>Incident</th><th>Insurer</th><th class="num">Claimed</th><th class="num">Approved</th><th class="num">Settled</th><th>Status</th></tr></thead><tbody>
    ${rows.map(c => `<tr class="drill" data-c="${c.id}"><td>${escapeHtml(c.claim_number)}</td><td>${escapeHtml(c.asset_code)} ${escapeHtml(c.equipment_name)}</td><td>${escapeHtml(c.agreement_number || '—')}</td><td>${escapeHtml(c.incident_type)} · ${fmtDate(c.incident_date)}</td><td>${escapeHtml(c.insurer || '—')}</td>
      <td class="num">${fmtMoney(c.amount_claimed)}</td><td class="num">${c.amount_approved ? fmtMoney(c.amount_approved) : '—'}</td><td class="num">${c.amount_settled ? fmtMoney(c.amount_settled) : '—'}</td><td>${badge(c.status)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty-state">No claims.</td></tr>'}</tbody></table></div>`;
  const reload = () => renderClaims(main, {});
  const add = document.getElementById('add-claim'); if (add) add.addEventListener('click', () => claimForm({}, reload));
  main.querySelectorAll('[data-cand]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); const c = cands[Number(a.dataset.cand)]; claimForm({ equipment_id: c.equipment_id, agreement_item_id: c.agreement_item_id, incident_type: c.is_lost ? 'lost' : 'damaged', amount_claimed: c.is_lost ? c.replacement_value : c.damage_charge, incident_date: c.incident_date, description: c.damage_notes || '' }, reload); }));
  main.querySelectorAll('[data-c]').forEach(r => r.addEventListener('click', () => viewClaim(rows.find(c => String(c.id) === r.dataset.c), reload)));
  if (params.open) { const c = rows.find(x => String(x.id) === String(params.open)); if (c) viewClaim(c, reload); }
}

async function claimForm(pre, onSave) {
  const equipment = await API.get('/api/equipment?include_disposed=1');
  openModal('New insurance claim', `
    <div class="field"><label>Equipment</label><select id="cl-e">${equipment.map(e => `<option value="${e.id}" ${String(pre.equipment_id) === String(e.id) ? 'selected' : ''}>${escapeHtml(e.asset_code)} — ${escapeHtml(e.name)}</option>`).join('')}</select></div>
    <div class="grid-2"><div class="field"><label>Incident</label><select id="cl-t">${['lost', 'stolen', 'damaged', 'destroyed'].map(t => `<option ${pre.incident_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="field"><label>Incident date</label><input type="date" id="cl-d" value="${pre.incident_date || new Date().toISOString().slice(0, 10)}"></div>
    <div class="field"><label>Insurer</label><input id="cl-i" placeholder="e.g. AIICO Insurance"></div><div class="field"><label>Policy no.</label><input id="cl-p"></div>
    <div class="field"><label>Amount claimed</label><input type="number" id="cl-a" value="${pre.amount_claimed || 0}"></div><div class="field"><label>Policy excess</label><input type="number" id="cl-x" value="0"></div></div>
    <div class="field"><label>Description</label><textarea id="cl-desc" rows="2">${escapeHtml(pre.description || '')}</textarea></div>
    <button class="btn" id="cl-go">Open claim</button><div class="error-msg" id="cl-err"></div>`, (m) => {
    m.querySelector('#cl-go').addEventListener('click', async () => {
      try { const r = await API.post('/api/claims', { equipment_id: Number(m.querySelector('#cl-e').value), agreement_item_id: pre.agreement_item_id, incident_type: m.querySelector('#cl-t').value, incident_date: m.querySelector('#cl-d').value, insurer: m.querySelector('#cl-i').value, policy_number: m.querySelector('#cl-p').value, amount_claimed: Number(m.querySelector('#cl-a').value), excess: Number(m.querySelector('#cl-x').value), description: m.querySelector('#cl-desc').value });
        m.remove(); toast(`Claim ${r.claim_number} opened`); if (onSave) onSave(); }
      catch (e) { m.querySelector('#cl-err').textContent = e.message; }
    });
  });
}

async function viewClaim(c, reload) {
  const photos = await API.get(`/api/photos?entity_type=claim&entity_id=${c.id}`);
  const next = { draft: ['submitted', 'closed'], submitted: ['approved', 'rejected'], approved: ['settled'], rejected: ['closed'], settled: ['closed'] }[c.status] || [];
  openModal(`${escapeHtml(c.claim_number)} — ${escapeHtml(c.equipment_name)}`, `
    <p>${badge(c.status)} <span class="muted">${escapeHtml(c.incident_type)} on ${fmtDate(c.incident_date)}${c.agreement_number ? ' · booking ' + escapeHtml(c.agreement_number) : ''}</span></p>
    <p>Insurer: ${escapeHtml(c.insurer || '—')} · policy ${escapeHtml(c.policy_number || '—')} · insurer ref ${escapeHtml(c.insurer_claim_ref || '—')}</p>
    <p>Claimed ${fmtMoney(c.amount_claimed)} · excess ${fmtMoney(c.excess)} · approved ${fmtMoney(c.amount_approved)} · settled ${fmtMoney(c.amount_settled)}</p>
    <p class="muted">${escapeHtml(c.description || '')}</p>
    <h3 style="border:none;padding:0;margin:10px 0 4px">Evidence photos</h3>${photoStrip(photos)}
    ${can('claims.edit') ? `<div style="margin:8px 0">${photoUploadButton('claim', c.id, 'damage', () => { document.querySelector('.overlay:last-child')?.remove(); viewClaim(c, reload); })}</div>` : ''}
    ${can('claims.edit') && next.length ? `<div class="section-divider"></div><div class="grid-2"><div class="field"><label>Insurer claim ref</label><input id="vc-ref" value="${escapeHtml(c.insurer_claim_ref || '')}"></div>
      <div class="field"><label>Amount (approved / received)</label><input type="number" id="vc-amt" value="${c.status === 'approved' ? c.amount_approved : (c.amount_claimed - c.excess)}"></div></div>
      <div class="btn-row">${next.map(n => `<button class="btn small ${n === 'rejected' || n === 'closed' ? 'secondary' : ''}" data-n="${n}">Mark ${n}</button>`).join('')}</div>` : ''}
    <div class="error-msg" id="vc-err"></div>`, (m) => {
    m.querySelectorAll('[data-n]').forEach(b => b.addEventListener('click', async () => {
      const amt = Number(m.querySelector('#vc-amt')?.value || 0);
      try { const r = await API.put('/api/claims/' + c.id, { status: b.dataset.n, insurer_claim_ref: m.querySelector('#vc-ref')?.value, amount_approved: amt, amount_settled: amt }); m.remove(); toast(`Claim ${b.dataset.n}${r.journal_entry ? ' · posted ' + r.journal_entry : ''}`); reload(); }
      catch (e) { m.querySelector('#vc-err').textContent = e.message; }
    }));
  });
}
