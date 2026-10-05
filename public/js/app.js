/* ===================== API CLIENT ===================== */
const API = {
  csrf: null,
  async call(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (this.csrf && method !== 'GET') opts.headers['X-CSRF-Token'] = this.csrf;
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    if (res.status === 503 && data.maintenance) {
      const err = new Error(data.error);
      err.maintenance = true;
      throw err;
    }
    if (res.status === 401 && CURRENT_USER && !path.startsWith('/api/auth/')) {
      CURRENT_USER = null; API.csrf = null;
      renderLogin();
      setTimeout(() => { const e = document.getElementById('login-error'); if (e) e.textContent = 'Your session has ended. Please sign in again.'; }, 0);
      throw new Error('Your session has ended. Please sign in again.');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },
  get(p) { return this.call('GET', p); },
  post(p, b) { return this.call('POST', p, b); },
  put(p, b) { return this.call('PUT', p, b); },
  del(p) { return this.call('DELETE', p); },
};

let CURRENT_USER = null;

/* ===================== WHITE-LABEL BRANDING ===================== */
let BRAND = { portal_name: 'MediaRent', portal_tagline: '', company_name: '', primary_color: '#E8630A', logo_url: null, show_powered_by: true, login_hint: '' };

function shadeHex(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(pct >= 0 ? c + (255 - c) * pct : c * (1 + pct))));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}
function relLum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
// Black or white text — whichever has the better WCAG contrast on the given colour.
function readableOn(hex) {
  const L = relLum(hex);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#111111' : '#FFFFFF';
}
function contrastRatio(a, b) { const x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const isHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');

function applyBranding() {
  const root = document.documentElement.style;
  const c = isHex(BRAND.primary_color) ? BRAND.primary_color : '#E8630A';
  root.setProperty('--orange', c);
  root.setProperty('--orange-dim', shadeHex(c, -0.22));
  root.setProperty('--on-accent', readableOn(c));
  // Brand-coloured text/links sit on the dark surfaces: lighten the colour if it would be hard to read there.
  let link = c; for (let i = 0; i < 6 && contrastRatio(link, '#262A31') < 4.5; i++) link = shadeHex(link, 0.2);
  root.setProperty('--accent-text', link);
  root.setProperty('--accent-soft', c + '22');
  const s = isHex(BRAND.secondary_color) ? BRAND.secondary_color : null;
  const dark = s || '#1B1E23';
  root.setProperty('--charcoal', dark);
  root.setProperty('--surface', s ? shadeHex(s, 0.08) : '#262A31');
  root.setProperty('--surface-2', s ? shadeHex(s, 0.16) : '#30353D');
  root.setProperty('--line', s ? shadeHex(s, 0.28) : '#3C424B');
  const onDark = readableOn(dark) === '#FFFFFF';
  root.setProperty('--text', onDark ? '#E9E7E1' : '#1B1E23');
  root.setProperty('--paper', onDark ? '#F3F1EC' : '#000000');
  root.setProperty('--text-dim', onDark ? '#9AA0A9' : '#555B64');
  document.title = BRAND.company_name ? `${BRAND.portal_name} — ${BRAND.company_name}` : BRAND.portal_name;
  let tc = document.querySelector('meta[name="theme-color"]');
  if (!tc) { tc = document.createElement('meta'); tc.name = 'theme-color'; document.head.appendChild(tc); }
  tc.content = dark;
  let fav = document.querySelector('link[rel="icon"]');
  if (BRAND.logo_url) {
    if (!fav) { fav = document.createElement('link'); fav.rel = 'icon'; document.head.appendChild(fav); }
    fav.href = BRAND.logo_url;
  } else if (fav) fav.remove();
}

async function loadBranding() {
  try { BRAND = { ...BRAND, ...(await API.get('/api/branding')) }; } catch {}
  applyBranding();
}

// Renders the portal name with the last word accented, e.g. "Media<span>Rent</span>" style.
function brandWordmark(name) {
  const n = String(name || '');
  const m = n.match(/^(.*?)([A-Z][a-z]+)$/);
  if (m && m[1] && !/\s$/.test(m[1])) return `${escapeHtml(m[1])}<span>${escapeHtml(m[2])}</span>`;
  const parts = n.split(' ');
  if (parts.length > 1) return `${escapeHtml(parts.slice(0, -1).join(' '))} <span>${escapeHtml(parts[parts.length - 1])}</span>`;
  return escapeHtml(n);
}

function fmtMoney(n) {
  n = Number(n || 0);
  return (BRAND.currency || 'NGN') + ' ' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s) { return s ? s.slice(0, 10) : '—'; }
function badge(status) { return `<span class="badge ${status}">${(status || '').replace(/_/g, ' ')}</span>`; }
function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function can(permKey) {
  if (!CURRENT_USER) return false;
  const perms = CURRENT_USER.permissions || [];
  if (perms.includes('*')) return true;
  if (perms.includes(permKey)) return true;
  const [mod, action] = permKey.split('.');
  if (perms.includes(`${mod}.*`)) return true;
  if (action && perms.includes(`*.${action}`)) return true;
  return false;
}

/* ===================== MODAL HELPER ===================== */
function openModal(title, innerHtml, onMount) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button type="button" class="modal-close" aria-label="Close">&times;</button><h3>${title}</h3>${innerHtml}</div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
  if (onMount) onMount(overlay);
  const first = overlay.querySelector('input:not([type=hidden]), select, textarea');
  if (first) first.focus({ preventScroll: true });
  return overlay;
}
// Escape closes the top-most dialog.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const all = document.querySelectorAll('.overlay');
  if (all.length) all[all.length - 1].remove();
});

/* ===================== ROUTER ===================== */
// Each route renders into #main-content and receives the hash query params (e.g. #/invoices?status=open&open=12),
// which is how dashboard tiles and report rows drill straight to the source record.
const ICONS = {
  dashboard: 'M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z',
  equipment: 'M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  kits: 'M3 7l9-4 9 4-9 4zm0 5l9 4 9-4M3 17l9 4 9-4',
  customers: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6',
  quotes: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
  bookings: 'M4 5h16v16H4zM4 9h16M8 3v4M16 3v4M8 13h3v3H8z',
  consumables: 'M5 8h14l-1 13H6zM9 8V5a3 3 0 0 1 6 0v3',
  maintenance: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  claims: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  billing: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6',
  finance: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  vouchers: 'M3 6h18v12H3zM3 10h18M7 15h4',
  accounting: 'M4 4h16v16H4zM4 9h16M9 4v16',
  reports: 'M4 4h10l6 6v10H4zM8 16v-3M12 16v-6M16 16v-4',
  admin: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.5 4a8.4 8.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2.2-1.3L15.4 3h-4l-.4 2.4A8 8 0 0 0 8.8 6.7l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a8 8 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z',
  collapse: 'M15 6l-6 6 6 6', menu: 'M4 6h16M4 12h16M4 18h16',
};
const icon = (k, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[k] || ''}"/></svg>`;

const NAV = [
  { group: null, items: [{ path: '#/dashboard', label: 'Dashboard', icon: 'dashboard', perm: null, render: (m, p) => renderDashboard(m, p) }] },
  { group: 'Operations', items: [
    { path: '#/agreements', label: 'Bookings', icon: 'bookings', perm: 'rentals.view', render: (m, p) => renderAgreements(m, p) },
    { path: '#/quotes', label: 'Quotes', icon: 'quotes', perm: 'quotes.view', render: (m, p) => renderQuotes(m, p) },
    { path: '#/equipment', label: 'Equipment', icon: 'equipment', perm: 'equipment.view', render: (m, p) => renderEquipment(m, p) },
    { path: '#/kits', label: 'Kits', icon: 'kits', perm: 'kits.view', render: (m, p) => renderKits(m, p) },
    { path: '#/customers', label: 'Customers', icon: 'customers', perm: 'customers.view', render: (m, p) => renderCustomers(m, p) },
    { path: '#/consumables', label: 'Consumables', icon: 'consumables', perm: 'consumables.view', render: (m, p) => renderConsumables(m, p) },
    { path: '#/maintenance', label: 'Maintenance', icon: 'maintenance', perm: 'maintenance.view', render: (m, p) => renderMaintenance(m, p) },
    { path: '#/claims', label: 'Insurance claims', icon: 'claims', perm: 'claims.view', render: (m, p) => renderClaims(m, p) },
  ] },
  { group: 'Finance', items: [
    { path: '#/invoices', label: 'Billing', icon: 'billing', perm: 'invoices.view', render: (m, p) => renderInvoices(m, p) },
    { path: '#/finance', label: 'Finance & tax', icon: 'finance', perm: 'reports.view', render: (m, p) => renderFinance(m, p) },
    { path: '#/vouchers', label: 'Vouchers', icon: 'vouchers', perm: 'vouchers.view', render: (m, p) => renderVouchers(m, p) },
    { path: '#/accounting', label: 'Accounting', icon: 'accounting', perm: 'accounts.view', render: (m, p) => renderAccounting(m, p) },
    { path: '#/reports', label: 'Reports', icon: 'reports', perm: 'reports.view', render: (m, p) => renderReports(m, p) },
  ] },
  { group: 'System', items: [{ path: '#/admin', label: 'Admin', icon: 'admin', perm: ['admin.users', 'admin.audit'], render: (m, p) => renderAdmin(m, p) }] },
];
const ROUTES = NAV.flatMap(g => g.items);

function parseHash() {
  const h = location.hash || '#/dashboard';
  const i = h.indexOf('?');
  return { path: i < 0 ? h : h.slice(0, i), params: Object.fromEntries(new URLSearchParams(i < 0 ? '' : h.slice(i + 1))) };
}
// Navigate (optionally with filters / a record to open).
function go(path, params) {
  const q = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  const target = path + (q ? '?' + q : '');
  if (location.hash === target) renderShell(); else location.hash = target;
}
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

async function boot() {
  await loadBranding();
  try {
    const me = await API.get('/api/auth/me');
    CURRENT_USER = me;
    API.csrf = me.csrf_token;
    renderShell();
  } catch {
    renderLogin();
  }
}

window.addEventListener('hashchange', () => { if (CURRENT_USER) renderShell(); });

/* ===================== LOGIN ===================== */
function renderLogin() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-box">
        <div class="login-brand">
          ${BRAND.logo_url ? `<img class="brand-logo" src="${BRAND.logo_url}" alt="${escapeHtml(BRAND.company_name || BRAND.portal_name)}">` : ''}
          <h1>${escapeHtml(BRAND.portal_name)}</h1>
          <div class="tagline">${escapeHtml([BRAND.company_name, BRAND.portal_tagline].filter(Boolean).join(' — '))}</div>
        </div>
        <div class="field"><label>Email</label><input type="email" id="login-email" autocomplete="username" placeholder="you@medirent.local"></div>
        <div class="field"><label>Password</label><input type="password" id="login-password" autocomplete="current-password"></div>
        <button class="btn" id="login-btn" style="width:100%">Sign in</button>
        <div class="error-msg" id="login-error"></div>
        ${BRAND.login_hint ? `<div class="hint">${escapeHtml(BRAND.login_hint)}</div>` : ''}
        ${BRAND.show_powered_by ? '<div class="login-foot">Powered by Olans FIXZIT Concept</div>' : ''}
      </div>
    </div>`;
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const data = await API.post('/api/auth/login', { email, password });
    API.csrf = data.csrf_token;
    const me = await API.get('/api/auth/me');
    CURRENT_USER = me;
    location.hash = '#/dashboard';
    renderShell();
  } catch (e) {
    errEl.textContent = e.message;
  }
}

async function doLogout() {
  await API.post('/api/auth/logout');
  CURRENT_USER = null;
  location.hash = '';
  renderLogin();
}

/* ===================== APP SHELL ===================== */
function renderShell() {
  const app = document.getElementById('app');
  const visible = ROUTES.filter(r => !r.perm || [].concat(r.perm).some(p => can(p)));
  let { path: current, params } = parseHash();
  if (!visible.find(r => r.path === current)) { current = visible[0].path; params = {}; }
  const collapsed = store.get('mr.sidebar') === 'collapsed';
  const closedGroups = JSON.parse(store.get('mr.groups') || '[]');
  const navHtml = NAV.map(g => {
    const items = g.items.filter(r => !r.perm || [].concat(r.perm).some(p => can(p)));
    if (!items.length) return '';
    const shut = g.group && closedGroups.includes(g.group) && !items.some(r => r.path === current);
    return `<div class="nav-group${shut ? ' shut' : ''}">${g.group ? `<button class="nav-group-head" data-group="${g.group}" aria-expanded="${!shut}"><span>${g.group}</span><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>` : ''}
      <div class="nav-items">${items.map(r => `<a href="${r.path}" class="${r.path === current ? 'active' : ''}" data-route="${r.path}" title="${r.label}">${icon(r.icon)}<span class="lbl">${r.label}</span></a>`).join('')}</div></div>`;
  }).join('');
  app.innerHTML = `
    <div class="app-shell${collapsed ? ' collapsed' : ''}">
      <aside class="sidebar" aria-label="Main navigation">
        <div class="brand">
          ${BRAND.logo_url ? `<img class="brand-logo" src="${BRAND.logo_url}" alt="${escapeHtml(BRAND.company_name || BRAND.portal_name)}">` : ''}
          <div class="brand-name">${brandWordmark(BRAND.portal_name)}</div>
          <button class="collapse-btn" id="collapse-btn" title="${collapsed ? 'Expand menu' : 'Collapse menu'}" aria-label="Toggle menu">${icon('collapse')}</button>
        </div>
        <nav>${navHtml}</nav>
        <div class="user-box">
          <div class="avatar" title="${escapeHtml(CURRENT_USER.full_name)}">${escapeHtml(CURRENT_USER.full_name.split(' ').map(x => x[0]).slice(0, 2).join(''))}</div>
          <div class="who"><strong>${escapeHtml(CURRENT_USER.full_name)}</strong>${escapeHtml(CURRENT_USER.role)}
          <div><button id="logout-btn">Sign out</button></div>
          ${BRAND.show_powered_by ? '<div class="powered-by">Powered by Olans FIXZIT Concept</div>' : ''}</div>
        </div>
      </aside>
      <div class="mobile-bar"><button id="mobile-menu" aria-label="Menu">${icon('menu')}</button><span>${escapeHtml(BRAND.portal_name)}</span></div>
      <div class="main" id="main-content"></div>
    </div>`;
  document.getElementById('logout-btn').addEventListener('click', doLogout);
  document.getElementById('collapse-btn').addEventListener('click', () => {
    const shell = app.querySelector('.app-shell'); const c = !shell.classList.contains('collapsed');
    shell.classList.toggle('collapsed', c); store.set('mr.sidebar', c ? 'collapsed' : 'open');
  });
  document.getElementById('mobile-menu').addEventListener('click', () => app.querySelector('.app-shell').classList.toggle('mobile-open'));
  app.querySelectorAll('.nav-group-head').forEach(b => b.addEventListener('click', () => {
    const grp = b.closest('.nav-group'); const shut = !grp.classList.contains('shut'); grp.classList.toggle('shut', shut); b.setAttribute('aria-expanded', !shut);
    const list = JSON.parse(store.get('mr.groups') || '[]').filter(x => x !== b.dataset.group); if (shut) list.push(b.dataset.group); store.set('mr.groups', JSON.stringify(list));
  }));
  app.querySelectorAll('[data-route]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); go(a.getAttribute('data-route')); }));

  if (CURRENT_USER.must_change_password) return renderForcePasswordChange();

  const route = ROUTES.find(r => r.path === current);
  const main = document.getElementById('main-content');
  Promise.resolve().then(() => route.render(main, params || {})).catch((e) => {
    if (CURRENT_USER) main.innerHTML = `<div class="card"><h3>Something went wrong</h3><p class="error-msg" style="margin:0 0 12px">${escapeHtml(e.message)}</p><button class="btn small" id="retry-btn">Try again</button></div>`;
    const rb = document.getElementById('retry-btn'); if (rb) rb.addEventListener('click', () => renderShell());
  });
}

function renderForcePasswordChange() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="card" style="max-width:440px">
      <h3>Set a new password</h3>
      <p class="muted" style="margin-top:0">You must choose a new password before continuing.</p>
      <div class="field"><label>Current password</label><input type="password" id="cur-pw" autocomplete="current-password"></div>
      <div class="field"><label>New password</label><input type="password" id="new-pw" autocomplete="new-password">
        <div class="help">At least 10 characters with an upper-case letter, a lower-case letter and a number.</div></div>
      <div class="field"><label>Confirm new password</label><input type="password" id="new-pw2" autocomplete="new-password"></div>
      <button class="btn" id="set-pw-btn">Update password</button>
      <div class="error-msg" id="pw-error"></div>
    </div>`;
  document.getElementById('set-pw-btn').addEventListener('click', async () => {
    const err = document.getElementById('pw-error'); err.textContent = '';
    const np = document.getElementById('new-pw').value;
    if (np !== document.getElementById('new-pw2').value) return err.textContent = 'The two new passwords do not match.';
    try {
      await API.post('/api/auth/change-password', { current_password: document.getElementById('cur-pw').value, new_password: np });
      CURRENT_USER.must_change_password = false;
      toast('Password updated');
      renderShell();
    } catch (e) { err.textContent = e.message; }
  });
}

/* ===================== EQUIPMENT ===================== */
async function renderEquipment(main, params = {}) {
  const [cats, locs] = await Promise.all([API.get('/api/equipment/categories'), API.get('/api/locations')]);
  main.innerHTML = `
    <div class="page-header"><h2>Equipment</h2>
      <div class="btn-row">
        ${can('equipment.edit') ? '<button class="btn secondary" id="manage-cat-btn">Categories</button> <button class="btn" id="add-eq-btn">+ Add equipment</button>' : ''}
      </div></div>
    <div class="toolbar">
      <input type="text" id="eq-search" placeholder="Search name, code, serial, brand, model…" value="${escapeHtml(params.q || '')}">
      <select id="eq-status-filter"><option value="">All statuses</option>
        ${['available', 'reserved', 'on_rent', 'due_back', 'maintenance', 'lost', 'retired'].map(s => `<option value="${s}" ${params.status === s ? 'selected' : ''}>${s === 'due_back' ? 'Due back ≤ tomorrow' : s.replace('_', ' ')}</option>`).join('')}
      </select>
      <select id="eq-cat-filter"><option value="">All categories</option>${cats.map(c => `<option value="${c.id}" ${String(params.category_id) === String(c.id) ? 'selected' : ''}>${escapeHtml(c.name)} (${c.units})</option>`).join('')}</select>
      <select id="eq-loc-filter"><option value="">All locations</option>${locs.map(l => `<option value="${l.id}" ${String(params.location_id) === String(l.id) ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}</select>
      <span class="muted" id="eq-count"></span>
      <span style="margin-left:auto">${can('reports.view') ? exportLinks('/api/reports/run/fixed_asset_register') : ''}</span>
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>Code</th><th>Name</th><th>Category</th><th>Serial</th><th>Location</th><th>Status</th><th class="num">Daily rate</th><th class="num">Replacement value</th>
    </tr></thead><tbody id="eq-tbody"><tr><td colspan="8" class="empty-state">Loading…</td></tr></tbody></table></div>`;

  async function load() {
    const params2 = new URLSearchParams();
    const q = document.getElementById('eq-search').value, st = document.getElementById('eq-status-filter').value, c = document.getElementById('eq-cat-filter').value, l = document.getElementById('eq-loc-filter').value;
    if (q) params2.set('q', q); if (st) params2.set('status', st); if (c) params2.set('category_id', c); if (l) params2.set('location_id', l);
    const rows = await API.get('/api/equipment?' + params2.toString());
    document.getElementById('eq-count').textContent = `${rows.length} unit(s)`;
    const tbody = document.getElementById('eq-tbody');
    tbody.innerHTML = rows.length ? rows.map(r => `
      <tr class="drill" data-view-eq="${r.id}">
        <td>${escapeHtml(r.asset_code)}</td>
        <td>${escapeHtml(r.name)} ${r.includes_operator ? '<span class="badge reserved">with operator</span>' : ''}</td>
        <td class="muted">${escapeHtml(r.category_name || '—')}</td>
        <td class="muted">${escapeHtml(r.serial_number || '—')}</td>
        <td class="muted">${escapeHtml(r.location_name || '—')}</td>
        <td>${badge(r.status)}</td>
        <td class="num">${fmtMoney(r.daily_rate)}</td>
        <td class="num">${r.replacement_value ? fmtMoney(r.replacement_value) : '—'}</td>
      </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No equipment matches. ${can('equipment.edit') ? 'Add an asset or import your register under Accounting → Legacy data import.' : ''}</td></tr>`;
    tbody.querySelectorAll('[data-view-eq]').forEach(a => a.addEventListener('click', () => viewEquipment(a.dataset.viewEq, load)));
  }
  document.getElementById('eq-search').addEventListener('input', debounce(load, 300));
  ['eq-status-filter', 'eq-cat-filter', 'eq-loc-filter'].forEach(id => document.getElementById(id).addEventListener('change', load));
  if (can('equipment.edit')) {
    document.getElementById('add-eq-btn').addEventListener('click', () => equipmentForm(load));
    document.getElementById('manage-cat-btn').addEventListener('click', () => categoriesModal(load));
  }
  await load();
  if (params.open) viewEquipment(params.open, load);
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function categoriesModal(onSave) {
  const cats = await API.get('/api/equipment/categories');
  openModal('Equipment categories', `
    <div id="cat-list">${cats.map(c => `
      <div class="card" style="margin-bottom:10px">
        <strong>${escapeHtml(c.name)}</strong> <span class="muted">${c.units} unit(s)</span>
        <div class="field" style="margin-top:8px"><label>Prep/QC checklist (one item per line — run at checkout &amp; check-in)</label>
          <textarea rows="3" data-cat-checklist="${c.id}">${(JSON.parse(c.prep_checklist || '[]')).join('\n')}</textarea></div>
        <div class="grid-2">
          <div class="field"><label>Revenue GL (blank = 401000 equipment rental)</label><input data-cat-gl="${c.id}" value="${escapeHtml(c.income_gl_code || '')}" placeholder="e.g. 401100 for studio hire"></div>
          <div class="field"><label>NRS service / HSN code</label><input data-cat-nrs="${c.id}" value="${escapeHtml(c.nrs_service_code || '')}"></div>
        </div>
        <button class="btn small" data-save-cat="${c.id}">Save</button>
      </div>`).join('') || '<p class="muted">No categories yet.</p>'}
    </div>
    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Add category</h3>
    <div class="field"><label>Name</label><input id="new-cat-name"></div>
    <div class="field"><label>Prep/QC checklist (one item per line)</label><textarea id="new-cat-checklist" rows="3"></textarea></div>
    <button class="btn" id="add-cat-btn">Add category</button>
    <div class="error-msg" id="cat-error"></div>
  `, (overlay) => {
    overlay.querySelectorAll('[data-save-cat]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.saveCat;
      const lines = overlay.querySelector(`[data-cat-checklist="${id}"]`).value.split('\n').map(s => s.trim()).filter(Boolean);
      try { await API.put(`/api/equipment/categories/${id}`, { prep_checklist: lines, income_gl_code: overlay.querySelector(`[data-cat-gl="${id}"]`).value.trim(), nrs_service_code: overlay.querySelector(`[data-cat-nrs="${id}"]`).value.trim() }); toast('Category saved'); }
      catch (e) { toast(e.message, true); }
    }));
    overlay.querySelector('#add-cat-btn').addEventListener('click', async () => {
      const name = overlay.querySelector('#new-cat-name').value;
      const lines = overlay.querySelector('#new-cat-checklist').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!name) return overlay.querySelector('#cat-error').textContent = 'Name is required';
      try {
        await API.post('/api/equipment/categories', { name, prep_checklist: lines });
        overlay.remove(); toast('Category added'); categoriesModal(onSave);
      } catch (e) { overlay.querySelector('#cat-error').textContent = e.message; }
    });
  });
}

async function equipmentForm(onSave, existing) {
  const [cats, locs] = await Promise.all([API.get('/api/equipment/categories'), API.get('/api/locations')]);
  const e = existing || {};
  const v = (k, d = '') => escapeHtml(e[k] == null ? d : e[k]);
  const canCap = !existing && can('journals.edit');
  openModal(existing ? `Edit ${escapeHtml(e.asset_code)}` : 'Add equipment', `
    <div class="field"><label>Name</label><input id="f-name" value="${v('name')}"></div>
    <div class="grid-2">
      <div class="field"><label>Category</label><select id="f-cat"><option value="">—</option>${cats.map(c => `<option value="${c.id}" ${e.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Home location</label><select id="f-locid">${locs.map(l => `<option value="${l.id}" ${(e.location_id ? e.location_id === l.id : l.is_default) ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Brand</label><input id="f-brand" value="${v('brand')}"></div>
      <div class="field"><label>Model</label><input id="f-model" value="${v('model')}"></div>
    </div>
    <div class="field"><label>Serial number</label><input id="f-serial" value="${v('serial_number')}" placeholder="Manufacturer serial — for insurance & tracking"></div>
    <div class="grid-2">
      <div class="field"><label>Daily rate</label><input id="f-daily" type="number" min="0" value="${v('daily_rate')}"></div>
      <div class="field"><label>Weekly rate</label><input id="f-weekly" type="number" min="0" value="${v('weekly_rate')}"></div>
      <div class="field"><label>Monthly rate</label><input id="f-monthly" type="number" min="0" value="${v('monthly_rate')}"></div>
      <div class="field"><label>Late fee / day</label><input id="f-late" type="number" min="0" value="${v('late_fee_daily')}"></div>
      <div class="field"><label>Replacement value</label><input id="f-replace" type="number" min="0" value="${v('replacement_value')}" placeholder="Billed if lost / stolen"></div>
      <div class="field"><label>Default deposit / caution fee</label><input id="f-deposit" type="number" min="0" value="${v('default_deposit', 0)}"></div>
    </div>
    <div class="field"><label><input type="checkbox" id="f-op" style="width:auto;margin-right:6px" ${e.includes_operator ? 'checked' : ''}>Rate includes an operator / pilot</label></div>
    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin:0 0 8px">Fixed asset (IAS 16)</h3>
    <div class="grid-2">
      <div class="field"><label>Purchase date</label><input id="f-pdate" type="date" value="${v('purchase_date')}"></div>
      <div class="field"><label>Purchase cost (excl. VAT)</label><input id="f-cost" type="number" min="0" value="${v('purchase_cost')}"></div>
      <div class="field"><label>Useful life (years)</label><input id="f-life" type="number" min="1" value="${v('useful_life_years', 5)}"></div>
      <div class="field"><label>Residual (salvage) value</label><input id="f-salvage" type="number" min="0" value="${v('salvage_value', 0)}"></div>
    </div>
    <div class="field"><label><input type="checkbox" id="f-dep" style="width:auto;margin-right:6px" ${e.depreciable === 0 ? '' : 'checked'}>Depreciate this asset (untick for studio space / non-owned items)</label></div>
    ${canCap ? `<div class="field"><label>Put the cost on the books</label><select id="f-cap"><option value="">Not now (capitalise later from the asset)</option><option value="bill">Supplier bill — creates a payable (pay via voucher)</option><option value="cash">Already paid from bank</option><option value="opening">Existing asset — opening balance</option></select></div>
      <div id="f-billbox" style="display:none" class="grid-2"><div class="field"><label>Supplier</label><input id="f-vendor"></div><div class="field"><label>Supplier invoice no.</label><input id="f-vinv"></div>
      <div class="field"><label>Supplier TIN</label><input id="f-vtin"></div><div class="field"><label><input type="checkbox" id="f-vvat" style="width:auto;margin-right:6px">Supplier charged VAT (claimable)</label></div></div>` : ''}
    <button class="btn" id="save-eq-btn">${existing ? 'Save changes' : 'Save equipment'}</button>
    <div class="error-msg" id="eq-form-error"></div>
  `, (overlay) => {
    const $ = (s) => overlay.querySelector(s);
    if ($('#f-cap')) $('#f-cap').addEventListener('change', () => { $('#f-billbox').style.display = $('#f-cap').value === 'bill' ? 'grid' : 'none'; });
    $('#save-eq-btn').addEventListener('click', async () => {
      const n = (s) => Number($(s).value || 0);
      const body = { name: $('#f-name').value, category_id: $('#f-cat').value ? Number($('#f-cat').value) : null, location_id: Number($('#f-locid').value), brand: $('#f-brand').value, model: $('#f-model').value,
        serial_number: $('#f-serial').value, purchase_cost: n('#f-cost'), replacement_value: n('#f-replace'), daily_rate: n('#f-daily'), weekly_rate: n('#f-weekly'), monthly_rate: n('#f-monthly'), late_fee_daily: n('#f-late'),
        default_deposit: n('#f-deposit'), includes_operator: $('#f-op').checked, purchase_date: $('#f-pdate').value || null, useful_life_years: n('#f-life') || 5, salvage_value: n('#f-salvage'), depreciable: $('#f-dep').checked };
      if ($('#f-cap') && $('#f-cap').value) Object.assign(body, { capitalise: $('#f-cap').value, vendor_name: $('#f-vendor').value, vendor_invoice_no: $('#f-vinv').value, vendor_tin: $('#f-vtin').value, vat_applies: $('#f-vvat').checked });
      try {
        if (existing) { delete body.location_id; await API.put('/api/equipment/' + e.id, body); toast('Equipment updated'); }
        else { const r = await API.post('/api/equipment', body); toast(`Added ${r.asset_code}${r.bill ? ' · bill ' + r.bill.expense_number + ' raised' : ''}`); }
        overlay.remove(); if (onSave) onSave();
      } catch (x) { $('#eq-form-error').textContent = x.message; }
    });
  });
}

async function viewEquipment(id, reload) {
  const eq = await API.get('/api/equipment/' + id);
  const locs = can('locations.edit') ? await API.get('/api/locations') : [];
  openModal(`${escapeHtml(eq.asset_code)} — ${escapeHtml(eq.name)}`, `
    <p>${badge(eq.status)} <span class="muted">${escapeHtml(eq.category_name || '')} · ${escapeHtml(eq.brand || '')} ${escapeHtml(eq.model || '')} ${eq.serial_number ? '· SN ' + escapeHtml(eq.serial_number) : ''} · 📍 ${escapeHtml(eq.location_name || '—')}</span></p>
    <div class="tax-grid">
      <div class="tax-box"><div class="k">Daily / weekly</div><div class="v">${fmtShort(eq.daily_rate)}</div><div class="s">${fmtMoney(eq.weekly_rate)} weekly${eq.includes_operator ? ' · incl. operator' : ''}</div></div>
      <div class="tax-box"><div class="k">Revenue to date</div><div class="v">${fmtShort(eq.revenue_to_date)}</div><div class="s">${eq.rental_history.length} booking(s)</div></div>
      <div class="tax-box"><div class="k">Net book value</div><div class="v">${fmtShort(eq.net_book_value)}</div><div class="s">Cost ${fmtMoney(eq.purchase_cost)} · acc. dep. ${fmtMoney(eq.accumulated_depreciation)}${eq.capitalised_at ? '' : (eq.purchase_cost > 0 ? ' · <span style="color:var(--amber)">not capitalised</span>' : '')}</div></div>
      <div class="tax-box"><div class="k">Replacement value</div><div class="v">${fmtShort(eq.replacement_value)}</div><div class="s">${eq.default_deposit ? 'Caution fee ' + fmtMoney(eq.default_deposit) : 'Billed if lost'}</div></div>
    </div>
    ${eq.notes ? `<p class="muted">${escapeHtml(eq.notes)}</p>` : ''}
    <div class="btn-row">
      ${can('equipment.edit') ? '<button class="btn small secondary" id="eq-edit">Edit</button>' : ''}
      ${can('locations.edit') && !['on_rent', 'lost', 'retired'].includes(eq.status) ? '<button class="btn small secondary" id="eq-move">Transfer location</button>' : ''}
      ${can('journals.edit') && !eq.capitalised_at && eq.purchase_cost > 0 ? '<button class="btn small secondary" id="eq-cap">Capitalise cost</button>' : ''}
      ${can('journals.edit') && !eq.disposed_at && eq.status !== 'on_rent' ? '<button class="btn small danger" id="eq-wo">Write off / dispose</button>' : ''}
      ${can('claims.edit') && ['lost', 'maintenance'].includes(eq.status) ? '<button class="btn small secondary" id="eq-claim">Open insurance claim</button>' : ''}
      ${can('maintenance.edit') ? '<button class="btn small secondary" id="eq-wo-new">New work order</button>' : ''}
    </div>
    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Rental history</h3>
    ${eq.rental_history.length ? `<table><tbody>${eq.rental_history.map(h => `<tr class="drill" data-agr="${h.agreement_id}"><td>${escapeHtml(h.agreement_number)}</td><td>${escapeHtml(h.customer_name)}</td><td class="muted">${fmtDate(h.checkout_at || h.start_date)} → ${fmtDate(h.checkin_at)}</td><td>${badge(h.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No rental history yet.</p>'}
    ${eq.work_orders.length ? `<h3 style="border:none;padding:0;margin:14px 0 8px">Work orders</h3>${eq.work_orders.map(w => `<div>${escapeHtml(w.wo_number)} · ${escapeHtml(w.wo_type)} · ${badge(w.status)} <span class="muted">${fmtDate(w.opened_at)}</span></div>`).join('')}` : ''}
    ${eq.claims.length ? `<h3 style="border:none;padding:0;margin:14px 0 8px">Insurance claims</h3>${eq.claims.map(c => `<div><a href="#" data-claim="${c.id}">${escapeHtml(c.claim_number)}</a> ${badge(c.status)} ${fmtMoney(c.amount_claimed)}</div>`).join('')}` : ''}
    <h3 style="border:none;padding:0;margin:14px 0 8px">Photos</h3>
    <div id="eq-photos">${photoStrip(eq.photos)}</div>
    ${can('equipment.edit') ? `<div style="margin-top:8px">${photoUploadButton('equipment', eq.id, 'general', () => { document.querySelector('.overlay:last-child')?.remove(); viewEquipment(id, reload); })}</div>` : ''}
    <div class="error-msg" id="eq-err"></div>
  `, (ov) => {
    ov.querySelector('.modal').classList.add('wide');
    const re = () => { ov.remove(); viewEquipment(id, reload); if (reload) reload(); };
    const err = (e) => { ov.querySelector('#eq-err').textContent = e.message; };
    ov.querySelectorAll('[data-agr]').forEach(r => r.addEventListener('click', () => { ov.remove(); viewAgreement(r.dataset.agr); }));
    ov.querySelectorAll('[data-claim]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); ov.remove(); go('#/claims', { open: a.dataset.claim }); }));
    const b = (sel, fn) => { const el = ov.querySelector(sel); if (el) el.addEventListener('click', fn); };
    b('#eq-edit', () => { ov.remove(); equipmentForm(() => { viewEquipment(id, reload); if (reload) reload(); }, eq); });
    b('#eq-move', () => openModal('Transfer to another location', `<div class="field"><label>To</label><select id="t-to">${locs.filter(l => l.id !== eq.location_id && l.active).map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}</select></div><div class="field"><label>Notes</label><input id="t-notes"></div><button class="btn" id="t-go">Transfer</button><div class="error-msg" id="t-err"></div>`, (m) => {
      m.querySelector('#t-go').addEventListener('click', async () => { try { await API.post(`/api/equipment/${id}/transfer`, { to_location_id: Number(m.querySelector('#t-to').value), notes: m.querySelector('#t-notes').value }); m.remove(); toast('Transferred'); re(); } catch (x) { m.querySelector('#t-err').textContent = x.message; } });
    }));
    b('#eq-cap', () => openModal('Capitalise asset cost', `<p class="muted">Cost ${fmtMoney(eq.purchase_cost)} goes to GL 151000 (rental equipment). Depreciation starts from the purchase date.</p>
      <div class="field"><label>How was it acquired?</label><select id="c-m"><option value="bill">Supplier bill — payable</option><option value="cash">Paid from bank</option><option value="opening">Existing asset — opening balance</option></select></div>
      <div class="grid-2"><div class="field"><label>Supplier</label><input id="c-v"></div><div class="field"><label>Supplier invoice no.</label><input id="c-i"></div></div>
      <div class="field"><label><input type="checkbox" id="c-vat" style="width:auto;margin-right:6px">Supplier charged VAT</label></div><button class="btn" id="c-go">Capitalise</button><div class="error-msg" id="c-err"></div>`, (m) => {
      m.querySelector('#c-go').addEventListener('click', async () => { try { await API.post(`/api/equipment/${id}/capitalise`, { method: m.querySelector('#c-m').value, vendor_name: m.querySelector('#c-v').value, vendor_invoice_no: m.querySelector('#c-i').value, vat_applies: m.querySelector('#c-vat').checked }); m.remove(); toast('Capitalised'); re(); } catch (x) { m.querySelector('#c-err').textContent = x.message; } });
    }));
    b('#eq-wo', () => openModal('Write off / dispose of asset', `<p class="muted">Removes cost ${fmtMoney(eq.purchase_cost)} and accumulated depreciation ${fmtMoney(eq.accumulated_depreciation)}; the net book value ${fmtMoney(eq.net_book_value)} is expensed to 702000. Any replacement charge billed to a customer or insurance recovery stays as separate income (IAS 16.65).</p>
      <div class="field"><label>Reason</label><input id="w-r" placeholder="e.g. Lost on set — not recovered"></div><button class="btn danger" id="w-go">Write off</button><div class="error-msg" id="w-err"></div>`, (m) => {
      m.querySelector('#w-go').addEventListener('click', async () => { try { const r = await API.post(`/api/equipment/${id}/write-off`, { reason: m.querySelector('#w-r').value }); m.remove(); toast(`Written off — loss ${fmtMoney(r.loss)}`); re(); } catch (x) { m.querySelector('#w-err').textContent = x.message; } });
    }));
    b('#eq-claim', () => { ov.remove(); claimForm({ equipment_id: eq.id, incident_type: eq.status === 'lost' ? 'lost' : 'damaged', amount_claimed: eq.replacement_value }, () => go('#/claims')); });
    b('#eq-wo-new', () => { ov.remove(); workOrderForm(() => go('#/maintenance'), eq.id); });
    void err;
  });
}

/* ===================== CUSTOMERS ===================== */
async function renderCustomers(main, params = {}) {
  main.innerHTML = `
    <div class="page-header"><h2>Customers</h2>
      ${can('customers.edit') ? '<button class="btn" id="add-cust-btn">+ Add customer</button>' : ''}</div>
    <div class="toolbar"><input type="text" id="cust-search" placeholder="Search customers…"></div>
    <div class="table-wrap"><table><thead><tr>
      <th>Name</th><th>Type</th><th>TIN</th><th>Credit limit</th><th>Outstanding</th><th>Insurance</th><th></th>
    </tr></thead><tbody id="cust-tbody"><tr><td colspan="7" class="empty-state">Loading…</td></tr></tbody></table></div>`;

  async function load() {
    const q = document.getElementById('cust-search').value;
    const rows = await API.get('/api/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    document.getElementById('cust-tbody').innerHTML = rows.length ? rows.map(c => { const coi = coiStatus(c); return `
      <tr>
        <td>${escapeHtml(c.full_name)} ${c.is_blacklisted ? badge('rejected').replace('rejected', 'blacklisted') : ''}</td>
        <td>${escapeHtml(c.customer_type)}${c.wht_agent ? ' <span class="muted" title="Deducts WHT">· WHT</span>' : ''}</td><td>${c.tin ? escapeHtml(c.tin) : '<span class="muted">—</span>'}</td>
        <td>${fmtMoney(c.credit_limit)}</td><td>${fmtMoney(c.outstanding_balance)}</td>
        <td>${badge(coi.cls)} <span class="muted" style="font-size:11px">${coi.label}</span></td>
        <td><a href="#" data-view-cust="${c.id}">View</a></td>
      </tr>`; }).join('') : `<tr><td colspan="7" class="empty-state">No customers yet.</td></tr>`;
    document.querySelectorAll('[data-view-cust]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); viewCustomer(a.dataset.viewCust, load); }));
  }
  document.getElementById('cust-search').addEventListener('input', debounce(load, 300));
  if (can('customers.edit')) document.getElementById('add-cust-btn').addEventListener('click', () => customerForm(load));
  await load();
  if (params.open) viewCustomer(params.open, load);
}

function coiStatus(c) {
  if (!c.coi_on_file) return { label: 'No COI', cls: 'overdue' };
  if (!c.coi_expiry_date || c.coi_expiry_date < new Date().toISOString().slice(0, 10)) return { label: 'COI expired', cls: 'overdue' };
  return { label: 'COI valid to ' + fmtDate(c.coi_expiry_date), cls: 'available' };
}

function customerForm(onSave, existing) {
  const c = existing || {};
  const val = (k) => escapeHtml(c[k] == null ? '' : c[k]);
  openModal(existing ? 'Edit customer' : 'Add customer', `
    <div class="field"><label>Type</label><select id="f-ctype"><option value="individual" ${c.customer_type === 'individual' ? 'selected' : ''}>Individual</option><option value="company" ${c.customer_type === 'company' ? 'selected' : ''}>Company / organisation</option></select></div>
    <div class="field"><label>Full name / Company name</label><input id="f-cname" value="${val('full_name')}"></div>
    <div class="grid-2">
      <div class="field"><label>Phone</label><input id="f-cphone" value="${val('phone')}"></div>
      <div class="field"><label>Email</label><input id="f-cemail" type="email" value="${val('email')}"></div>
    </div>
    <div class="field"><label>Street address (printed on invoices; required for NRS B2B e-invoices)</label><input id="f-caddr" value="${val('address')}"></div>
    <div class="grid-2">
      <div class="field"><label>City</label><input id="f-ccity" value="${val('city')}"></div>
      <div class="field"><label>State</label><input id="f-cstate" value="${val('state')}" placeholder="e.g. Lagos"></div>
    </div>
    <div class="field"><label><input type="checkbox" id="f-cgov" style="width:auto;margin-right:6px" ${c.is_government ? 'checked' : ''}>Government / MDA (B2G e-invoice)</label></div>
    <div class="grid-2">
      <div class="field"><label>Tax ID (TIN)</label><input id="f-ctin" value="${val('tin')}" placeholder="e.g. 12345678-0001">
        <div class="help">Shown on invoices. Needed for the customer to claim input VAT and for WHT credit notes.</div></div>
      <div class="field"><label>RC / business reg. number</label><input id="f-crc" value="${val('rc_number')}"></div>
    </div>
    <div class="field"><label><input type="checkbox" id="f-cwht" style="width:auto;margin-right:6px" ${(existing ? c.wht_agent : true) ? 'checked' : ''}>Deducts withholding tax (WHT) at source when paying us</label>
      <div class="help">Companies and government bodies normally do; individuals normally do not. Invoices show the expected WHT.</div></div>
    <div class="field"><label>Credit limit (NGN)</label><input id="f-climit" type="number" min="0" value="${c.credit_limit || 0}"></div>
    <div class="grid-2">
      <div class="field"><label><input type="checkbox" id="f-coi" style="width:auto;margin-right:6px" ${c.coi_on_file ? 'checked' : ''}>Certificate of Insurance on file</label></div>
      <div class="field"><label>COI expiry date</label><input id="f-coi-exp" type="date" value="${val('coi_expiry_date')}"></div>
    </div>
    ${existing ? `<div class="field"><label><input type="checkbox" id="f-black" style="width:auto;margin-right:6px" ${c.is_blacklisted ? 'checked' : ''}>Blacklisted (cannot make new bookings)</label>
      <input id="f-black-reason" placeholder="Reason" value="${val('blacklist_reason')}" style="margin-top:6px"></div>` : ''}
    <button class="btn" id="save-cust-btn">Save customer</button>
    <div class="error-msg" id="cust-form-error"></div>
  `, (overlay) => {
    const typeSel = overlay.querySelector('#f-ctype');
    if (!existing) typeSel.addEventListener('change', () => { overlay.querySelector('#f-cwht').checked = typeSel.value === 'company'; });
    overlay.querySelector('#save-cust-btn').addEventListener('click', async () => {
      const body = {
        customer_type: typeSel.value,
        full_name: overlay.querySelector('#f-cname').value,
        phone: overlay.querySelector('#f-cphone').value,
        email: overlay.querySelector('#f-cemail').value,
        address: overlay.querySelector('#f-caddr').value, city: overlay.querySelector('#f-ccity').value, state: overlay.querySelector('#f-cstate').value, is_government: overlay.querySelector('#f-cgov').checked,
        tin: overlay.querySelector('#f-ctin').value,
        rc_number: overlay.querySelector('#f-crc').value,
        wht_agent: overlay.querySelector('#f-cwht').checked,
        credit_limit: Number(overlay.querySelector('#f-climit').value || 0),
        coi_on_file: overlay.querySelector('#f-coi').checked,
        coi_expiry_date: overlay.querySelector('#f-coi-exp').value || null,
      };
      if (existing) { body.is_blacklisted = overlay.querySelector('#f-black').checked; body.blacklist_reason = overlay.querySelector('#f-black-reason').value; }
      try {
        if (existing) await API.put('/api/customers/' + existing.id, body); else await API.post('/api/customers', body);
        overlay.remove(); toast(existing ? 'Customer updated' : 'Customer added'); onSave();
      } catch (e) { overlay.querySelector('#cust-form-error').textContent = e.message; }
    });
  });
}

async function viewCustomer(id, reload) {
  const c = await API.get('/api/customers/' + id);
  const coi = coiStatus(c);
  const overlay = openModal(escapeHtml(c.full_name), `
    <p>${escapeHtml(c.customer_type)} · ${escapeHtml(c.phone || '—')} · ${escapeHtml(c.email || '—')}</p>
    <p class="muted" style="margin-top:-8px">${escapeHtml([c.address, c.city, c.state].filter(Boolean).join(', ') || 'No address')}</p>
    <p>TIN: ${c.tin ? escapeHtml(c.tin) : '<span class="muted">not on file</span>'} ${c.rc_number ? '· RC ' + escapeHtml(c.rc_number) : ''} · ${c.wht_agent ? 'Deducts WHT at source' : 'Does not deduct WHT'}</p>
    <p>Credit limit: ${fmtMoney(c.credit_limit)} · Outstanding: ${fmtMoney(c.outstanding_balance)}</p>
    <p>${badge(coi.cls)} ${coi.label}</p>
    <div class="btn-row">${can('customers.edit') ? '<button class="btn small secondary" id="edit-cust-btn">Edit customer</button>' : ''}
      ${can('invoices.view') ? `<button class="btn small secondary" id="cust-inv">Open invoices</button>` : ''}${can('reports.view') ? `<a class="btn small secondary" href="/api/reports/run/revenue_by_customer?format=xlsx">Revenue report (Excel)</a>` : ''}</div>
    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Bookings</h3>
    ${c.agreements.length ? c.agreements.map(a => `<div><a href="#" data-open-agr="${a.id}">${escapeHtml(a.agreement_number)}</a> — ${badge(a.status)}</div>`).join('') : '<p class="muted">None yet.</p>'}
    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Invoices</h3>
    ${c.invoices.length ? c.invoices.map(i => `<div><a href="#" data-open-inv="${i.id}">${escapeHtml(i.invoice_number)}</a> — ${fmtMoney(i.grand_total)} ${badge(i.status)}</div>`).join('') : '<p class="muted">None yet.</p>'}
  `, (ov) => {
    ov.querySelectorAll('[data-open-inv]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); ov.remove(); viewInvoice(a.dataset.openInv); }));
    ov.querySelectorAll('[data-open-agr]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); ov.remove(); viewAgreement(a.dataset.openAgr); }));
    const ci = ov.querySelector('#cust-inv'); if (ci) ci.addEventListener('click', () => { ov.remove(); go('#/invoices', { customer_id: c.id, status: 'open' }); });
    const eb = ov.querySelector('#edit-cust-btn');
    if (eb) eb.addEventListener('click', () => { ov.remove(); customerForm(() => { if (reload) reload(); }, c); });
  });
}

/* ===================== AGREEMENTS / DISPATCH ===================== */
async function renderAgreements(main, params = {}) {
  const locs = await API.get('/api/locations');
  main.innerHTML = `
    <div class="page-header"><h2>Bookings</h2>
      <div class="btn-row">${can('rentals.edit') ? '<button class="btn" id="add-agr-btn">+ New booking</button>' : ''}</div></div>
    <div class="toolbar">
      <input type="text" id="agr-q" placeholder="Search booking, production, customer…" value="${escapeHtml(params.q || '')}">
      <select id="agr-status-filter"><option value="">All statuses</option>
        ${[['live', 'Live (reserved / out / overdue)'], ['reserved', 'Reserved'], ['active', 'On hire'], ['overdue', 'Overdue'], ['returned', 'Returned'], ['uninvoiced', 'Returned — not invoiced'], ['cancelled', 'Cancelled']].map(([v, l]) => `<option value="${v}" ${params.status === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <select id="agr-due"><option value="">Any date</option>${[['today', 'Due back today'], ['week', 'Due back within 7 days'], ['pickups', 'Pick-ups within 7 days']].map(([v, l]) => `<option value="${v}" ${params.due === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${locs.length > 1 ? `<select id="agr-loc"><option value="">All locations</option>${locs.map(l => `<option value="${l.id}" ${String(params.location_id) === String(l.id) ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}</select>` : ''}
      ${params.customer_id ? `<span class="filter-pill">Customer #${escapeHtml(params.customer_id)} <button id="clr-cust" title="Clear">×</button></span>` : ''}
      <span class="muted" id="agr-count"></span>
      <span style="margin-left:auto">${can('reports.view') ? exportLinks('/api/reports/run/bookings_register?from=2000-01-01') : ''}</span>
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>Booking #</th><th>Customer</th><th>Production</th><th>Location</th><th>Start</th><th>Due back</th><th class="num">Items</th><th>Invoice</th><th>Status</th>
    </tr></thead><tbody id="agr-tbody"><tr><td colspan="9" class="empty-state">Loading…</td></tr></tbody></table></div>`;

  async function load() {
    const qs = new URLSearchParams();
    const st = document.getElementById('agr-status-filter').value, due = document.getElementById('agr-due').value, q = document.getElementById('agr-q').value, loc = document.getElementById('agr-loc')?.value;
    if (st) qs.set('status', st); if (due) qs.set('due', due); if (q) qs.set('q', q); if (loc) qs.set('location_id', loc); if (params.customer_id) qs.set('customer_id', params.customer_id);
    const rows = await API.get('/api/agreements?' + qs.toString());
    document.getElementById('agr-count').textContent = `${rows.length} booking(s)`;
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('agr-tbody').innerHTML = rows.length ? rows.map(a => `
      <tr class="drill" data-view-agr="${a.id}">
        <td>${escapeHtml(a.agreement_number)}</td><td>${escapeHtml(a.customer_name)}</td>
        <td>${escapeHtml(a.project_name || '—')} ${a.production_type ? '<span class="muted">(' + escapeHtml(a.production_type) + ')</span>' : ''}</td>
        <td class="muted">${escapeHtml(a.location_name || '—')}</td>
        <td>${fmtDate(a.start_date)}</td><td>${['active', 'overdue'].includes(a.status) && a.expected_return_date < today ? `<span style="color:var(--red)">${fmtDate(a.expected_return_date)}</span>` : fmtDate(a.expected_return_date)}</td>
        <td class="num">${a.item_count}</td><td>${a.invoice_number ? escapeHtml(a.invoice_number) : '<span class="muted">—</span>'}</td>
        <td>${badge(a.status)}</td>
      </tr>`).join('') : `<tr><td colspan="9" class="empty-state">No bookings match.</td></tr>`;
    document.querySelectorAll('[data-view-agr]').forEach(a => a.addEventListener('click', () => viewAgreement(a.dataset.viewAgr)));
  }
  ['agr-status-filter', 'agr-due', 'agr-loc'].forEach(id => document.getElementById(id)?.addEventListener('change', load));
  document.getElementById('agr-q').addEventListener('input', debounce(load, 300));
  const cc = document.getElementById('clr-cust'); if (cc) cc.addEventListener('click', () => go('#/agreements'));
  if (can('rentals.edit')) document.getElementById('add-agr-btn').addEventListener('click', () => agreementForm(load));
  await load();
  if (params.open) viewAgreement(params.open);
}

const PRODUCTION_TYPES = ['Film', 'Commercial', 'Wedding', 'Corporate', 'Music Video', 'Photography', 'Broadcast', 'Other'];

async function agreementForm(onSave) {
  const [customers, kits, locs] = await Promise.all([API.get('/api/customers'), API.get('/api/kits'), API.get('/api/locations')]);
  const allEquip = await API.get('/api/equipment');
  const bookable = (e) => !['lost', 'retired'].includes(e.status);
  const overlay = openModal('New booking', `<div class="help" style="margin-top:-6px;margin-bottom:10px">${customers.length} customers · ${allEquip.length} units on the rate card</div>
    <div class="field"><label>Customer</label><select id="f-cust">${customers.filter(c => !c.is_blacklisted).map(c => `<option value="${c.id}">${escapeHtml(c.full_name)}</option>`).join('')}</select></div>
    <div class="grid-2">
      <div class="field"><label>Project / production name</label><input id="f-project" placeholder="e.g. Zenith Bank TVC"></div>
      <div class="field"><label>Production type</label><select id="f-ptype"><option value="">—</option>${PRODUCTION_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Shoot location</label><input id="f-location"></div>
      <div class="field"><label>Pick-up / return location</label><select id="f-locid">${locs.filter(l => l.active).map(l => `<option value="${l.id}" ${l.is_default ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}</select></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Start date</label><input id="f-start" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>Expected return</label><input id="f-end" type="date" value="${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}"></div>
    </div>
    <div class="field">
      <label>Book from a kit (optional — billed at the kit's package rate)</label>
      <select id="f-kit"><option value="">— Pick items individually instead —</option>${kits.filter(k => k.status === 'active').map(k => `<option value="${k.id}">${k.kit_code} — ${escapeHtml(k.name)} (${k.item_count} items, ${fmtMoney(k.daily_rate)}/day)</option>`).join('')}</select>
      <div id="kit-avail" class="help"></div>
    </div>
    <div class="field" id="f-equip-wrap">
      <label>Equipment <span class="muted" id="equip-note"></span></label>
      <input type="search" id="f-equip-q" placeholder="Filter the list…" style="margin-bottom:6px">
      <select id="f-equip" multiple size="9"></select>
      <div class="muted" style="margin-top:4px">Ctrl/Cmd-click to select more than one. Units already booked for those dates are greyed out.</div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Security deposit / caution fee (refundable)</label><input id="f-deposit" type="number" min="0" value="0"><div class="help">Leave 0 to use the items' default caution fee (e.g. studio space).</div></div>
      <div class="field"><label>Rush / same-day fee (NGN)</label><input id="f-rush" type="number" min="0" value="0"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label><input type="checkbox" id="f-waiver" style="width:auto;margin-right:6px">Damage waiver opted in</label></div>
      <div class="field"><label>Waiver fee (NGN)</label><input id="f-waiver-fee" type="number" min="0" value="0"></div>
    </div>
    <div class="muted" style="margin-bottom:12px">A damage waiver caps accidental-damage liability — it never covers a lost or stolen unit, which is always billed at full replacement value. The deposit is held as a liability and is not VAT-able until applied to an invoice.</div>
    <button class="btn" id="save-agr-btn">Create booking</button>
    <div class="error-msg" id="agr-form-error"></div>
  `);
  const $ = (s) => overlay.querySelector(s);
  async function refreshAvailability() {
    const start = $('#f-start').value, end = $('#f-end').value;
    let busy = new Set();
    if (start && end && end >= start) {
      try { const free = await API.get(`/api/equipment-availability?start_date=${start}&end_date=${end}`); const freeIds = new Set(free.map(e => e.id)); busy = new Set(allEquip.filter(e => !freeIds.has(e.id)).map(e => e.id)); } catch {}
    }
    const prev = new Set(Array.from($('#f-equip').selectedOptions).map(o => o.value));
    $('#f-equip').innerHTML = allEquip.filter(bookable).map(e => `<option value="${e.id}" data-rate="${e.daily_rate}" ${busy.has(e.id) ? 'disabled' : ''} ${prev.has(String(e.id)) && !busy.has(e.id) ? 'selected' : ''}>${escapeHtml(e.asset_code)} — ${escapeHtml(e.name)} (${fmtMoney(e.daily_rate)}/day)${busy.has(e.id) ? ' — booked' : ''}</option>`).join('');
    $('#equip-note').textContent = start && end && end < start ? '(return date is before start)' : '';
    await refreshKit();
  }
  async function refreshKit() {
    const kid = $('#f-kit').value, start = $('#f-start').value, end = $('#f-end').value;
    $('#f-equip-wrap').style.display = kid ? 'none' : 'block';
    if (!kid || !start || !end || end < start) { $('#kit-avail').textContent = ''; return; }
    try {
      const a = await API.get(`/api/kits/${kid}/availability?start_date=${start}&end_date=${end}`);
      $('#kit-avail').innerHTML = a.available ? '<span style="color:var(--green)">All components are free for these dates.</span>'
        : `<span style="color:var(--red)">Not available: ${a.conflicts.map(c => escapeHtml(c.name) + ' (' + escapeHtml(c.conflicting_agreement) + ')').join(', ')}</span>`;
    } catch (e) { $('#kit-avail').textContent = e.message; }
  }
  ['#f-start', '#f-end'].forEach(s => $(s).addEventListener('change', refreshAvailability));
  $('#f-equip-q').addEventListener('input', () => { const q = $('#f-equip-q').value.toLowerCase(); Array.from($('#f-equip').options).forEach(o => { o.hidden = q && !o.textContent.toLowerCase().includes(q) && !o.selected; }); });
  $('#f-kit').addEventListener('change', refreshKit);
  refreshAvailability();
  $('#save-agr-btn').addEventListener('click', async () => {
    const kitId = $('#f-kit').value;
    const items = Array.from($('#f-equip').selectedOptions).map(o => ({ equipment_id: Number(o.value), rate_type: 'daily', rate: Number(o.dataset.rate) }));
    const err = $('#agr-form-error'); err.textContent = '';
    if (!kitId && !items.length) return err.textContent = 'Pick a kit or select at least one item.';
    const btn = $('#save-agr-btn'); btn.disabled = true;
    try {
      const r = await API.post('/api/agreements', {
        customer_id: Number($('#f-cust').value), location_id: Number($('#f-locid').value), project_name: $('#f-project').value, production_type: $('#f-ptype').value, shoot_location: $('#f-location').value,
        start_date: $('#f-start').value, expected_return_date: $('#f-end').value,
        deposit_amount: Number($('#f-deposit').value || 0), rush_fee: Number($('#f-rush').value || 0),
        kit_id: kitId ? Number(kitId) : undefined, items: kitId ? undefined : items,
        damage_waiver_opted: $('#f-waiver').checked, damage_waiver_fee: Number($('#f-waiver-fee').value || 0),
      });
      overlay.remove(); toast('Booking created'); if (r.warnings && r.warnings.length) setTimeout(() => toast('Note: ' + r.warnings.join('; '), true), 600); onSave();
    } catch (e) { err.textContent = e.message; btn.disabled = false; }
  });
}

async function viewAgreement(id) {
  const a = await API.get('/api/agreements/' + id);
  const canDispatch = can('dispatch.edit'), canInvoice = can('invoices.edit'), canConsumables = can('consumables.edit');
  const canRentals = can('rentals.edit'), canPay = can('payments.edit');
  const coi = coiStatus(a);
  const liveInv = a.invoices.find(i => i.status !== 'void');
  const locked = !!liveInv;
  const itemsHtml = a.items.map(it => `
    <tr>
      <td>${escapeHtml(it.asset_code)} ${escapeHtml(it.equipment_name)}</td>
      <td>${it.checkout_at ? fmtDate(it.checkout_at) : '<span class="muted">Not out</span>'}</td>
      <td>${it.checkin_at ? fmtDate(it.checkin_at) : '<span class="muted">Not in</span>'}</td>
      <td>${it.is_lost ? badge('lost') + ' ' + fmtMoney(it.replacement_charge) : (it.damage_charge > 0 ? fmtMoney(it.damage_charge) : '—')}
        ${(it.is_lost || it.damage_charge > 0) && can('claims.edit') && !a.claims.some(c => c.agreement_item_id === it.id && c.status !== 'rejected') ? `<a href="#" data-claim-item="${it.id}" style="font-size:12px">claim</a>` : ''}</td>
      <td class="muted" style="font-size:12px">${(a.photos || []).filter(p => p.entity_id === it.id).length ? (a.photos || []).filter(p => p.entity_id === it.id).length + ' 📷' : ''}</td>
      <td class="row-actions">
        ${canDispatch && !it.checkout_at && ['reserved', 'dispatched', 'active'].includes(a.status) ? `<button class="btn small" data-checkout="${it.id}">Check out</button>` : ''}
        ${canDispatch && it.checkout_at && !it.checkin_at ? `<button class="btn small secondary" data-checkin="${it.id}">Check in</button>` : ''}
      </td>
    </tr>`).join('');
  const depHeld = a.deposit_available || 0;

  openModal(`${escapeHtml(a.agreement_number)} — ${escapeHtml(a.customer_name)}`, `
    <p>${badge(a.status)} <span class="muted">${fmtDate(a.start_date)} → ${fmtDate(a.expected_return_date)}${a.actual_return_date ? ' (returned ' + fmtDate(a.actual_return_date) + ')' : ''}${a.location_name ? ' · 📍 ' + escapeHtml(a.location_name) : ''} · est. value ${fmtMoney(a.estimated_value)}</span></p>
    <div class="btn-row" style="margin-bottom:10px"><button class="btn small secondary" id="agr-print">Print agreement</button><a class="btn small secondary" href="/api/agreements/${a.id}/agreement.pdf">Download PDF</a>
      ${a.status === 'cancelled' && a.cancellation_fee > 0 ? `<span class="muted">Cancelled ${fmtDate(a.cancelled_at)} · fee ${fmtMoney(a.cancellation_fee)}</span>` : ''}</div>
    ${a.project_name ? `<p><strong>${escapeHtml(a.project_name)}</strong> ${a.production_type ? '· ' + escapeHtml(a.production_type) : ''} ${a.shoot_location ? '· ' + escapeHtml(a.shoot_location) : ''}</p>` : ''}
    ${a.kit_name ? `<p class="muted">Booked from kit: ${escapeHtml(a.kit_name)}</p>` : ''}
    <p>${a.damage_waiver_opted ? 'Damage waiver: ' + fmtMoney(a.damage_waiver_fee) : 'No damage waiver'}${a.rush_fee > 0 ? ' · Rush fee: ' + fmtMoney(a.rush_fee) : ''}</p>
    <p>${badge(coi.cls)} <span class="muted">${coi.label}</span></p>
    <table><thead><tr><th>Item</th><th>Checked out</th><th>Checked in</th><th>Damage/Loss</th><th></th><th></th></tr></thead>
      <tbody id="agr-items-body">${itemsHtml}</tbody></table>

    ${a.deposit_amount > 0 ? `<div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Security deposit</h3>
    <p>Agreed ${fmtMoney(a.deposit_amount)} · received ${fmtMoney(a.deposit_received)} · applied ${fmtMoney(a.deposit_applied)} · refunded ${fmtMoney(a.deposit_refunded)} · <strong>held ${fmtMoney(depHeld)}</strong></p>
    <div class="btn-row">
      ${canPay && a.deposit_received < a.deposit_amount - 0.005 ? '<button class="btn small secondary" id="dep-receive">Record deposit received</button>' : ''}
      ${canPay && depHeld > 0 && liveInv && liveInv.status !== 'paid' ? '<button class="btn small secondary" id="dep-apply">Apply to invoice</button>' : ''}
      ${canPay && depHeld > 0 ? '<button class="btn small secondary" id="dep-refund">Refund deposit</button>' : ''}
    </div>` : ''}

    ${(a.photos || []).length ? `<h3 style="border:none;padding:0;margin:12px 0 4px">Condition photos</h3>${photoStrip(a.photos)}` : ''}
    ${a.claims.length ? `<p class="muted">Insurance claims: ${a.claims.map(c => `<a href="#" data-claim="${c.id}">${escapeHtml(c.claim_number)}</a> (${escapeHtml(c.status)})`).join(', ')}</p>` : ''}
    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Crew</h3>
    <div id="agr-crew">${a.crew.length ? a.crew.map(c => `<div>${escapeHtml(c.crew_name)} — ${escapeHtml(c.role || '')} · ${fmtMoney(c.day_rate)}/day × ${c.days} = ${fmtMoney(c.day_rate * c.days)}</div>`).join('') : '<p class="muted">No crew assigned.</p>'}</div>
    ${canRentals && !locked && a.status !== 'cancelled' ? '<button class="btn small secondary" id="add-crew-btn" style="margin-top:8px">+ Add crew</button>' : ''}

    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Consumables issued</h3>
    <div id="agr-consumables">${a.consumables.length ? a.consumables.map(c => `<div>${escapeHtml(c.name)} × ${c.qty} — ${fmtMoney(c.unit_price * c.qty)} ${c.invoiced ? badge('paid').replace('paid', 'billed') : badge('pending')}</div>`).join('') : '<p class="muted">None issued.</p>'}</div>
    ${canConsumables && !locked && a.status !== 'cancelled' ? '<button class="btn small secondary" id="add-consumable-btn" style="margin-top:8px">+ Issue consumable</button>' : ''}

    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Invoices</h3>
    <div id="agr-invoices">${a.invoices.length ? a.invoices.map(i => `<div><a href="#" data-open-inv="${i.id}">${escapeHtml(i.invoice_number)}</a> — ${fmtMoney(i.grand_total)} ${badge(i.status)}</div>`).join('') : '<p class="muted">None yet.</p>'}</div>
    <div class="btn-row" style="margin-top:12px">
      ${canInvoice && !liveInv && a.status !== 'cancelled' ? '<button class="btn" id="gen-invoice-btn">Generate invoice</button>' : ''}
      ${canRentals && a.status === 'reserved' && !liveInv && !a.items.some(i => i.checkout_at) ? '<button class="btn secondary" id="cancel-agr-btn">Cancel booking…</button>' : ''}
    </div>
    ${!liveInv && ['reserved', 'active', 'overdue'].includes(a.status) && canInvoice ? '<div class="help muted" style="margin-top:6px">Tip: check all items in first so the invoice includes the actual days, late fees and any damage or loss.</div>' : ''}
    <div class="error-msg" id="agr-detail-error"></div>
  `, (overlay) => {
    const reopen = () => { overlay.remove(); viewAgreement(a.id); };
    overlay.querySelectorAll('[data-checkout]').forEach(btn => btn.addEventListener('click', () => checkoutFlow(a.id, btn.dataset.checkout, a.items.find(i => String(i.id) === btn.dataset.checkout), overlay)));
    overlay.querySelectorAll('[data-checkin]').forEach(btn => btn.addEventListener('click', () => checkinFlow(a.id, btn.dataset.checkin, a.items.find(i => String(i.id) === btn.dataset.checkin), overlay)));
    overlay.querySelectorAll('[data-open-inv]').forEach(l => l.addEventListener('click', (e) => { e.preventDefault(); overlay.remove(); viewInvoice(l.dataset.openInv); }));
    const showErr = (e) => { overlay.querySelector('#agr-detail-error').textContent = e.message; };
    const genBtn = overlay.querySelector('#gen-invoice-btn');
    if (genBtn) genBtn.addEventListener('click', async () => {
      genBtn.disabled = true;
      try {
        const inv = await API.post(`/api/invoices/generate/${a.id}`);
        toast(`Invoice ${inv.invoice_number} — ${fmtMoney(inv.net_total)} + VAT ${fmtMoney(inv.vat_total)} = ${fmtMoney(inv.grand_total)}`);
        overlay.remove(); viewInvoice(inv.id);
      } catch (e) { showErr(e); genBtn.disabled = false; }
    });
    const cancelBtn = overlay.querySelector('#cancel-agr-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      const fee = Math.round(a.estimated_value * a.cancellation_fee_pct) / 100;
      openModal('Cancel booking', `<p>Rate-card policy: cancellations attract a <strong>${a.cancellation_fee_pct}%</strong> charge on the booking value (${fmtMoney(a.estimated_value)}).</p>
        <div class="grid-2"><div class="field"><label>Fee %</label><input id="cx-pct" type="number" min="0" max="100" value="${a.cancellation_fee_pct}"></div><div class="field"><label>Fee (excl. VAT)</label><input id="cx-fee" value="${fmtMoney(fee)}" disabled></div></div>
        <div class="field"><label><input type="checkbox" id="cx-waive" style="width:auto;margin-right:6px">Waive the cancellation fee</label></div>
        <div class="field"><label>Reason</label><input id="cx-reason" placeholder="e.g. Client postponed the shoot"></div>
        ${depHeld > 0 ? `<div class="notice">A deposit of ${fmtMoney(depHeld)} is held — after cancelling, apply it to the cancellation invoice and refund the balance.</div>` : ''}
        <button class="btn danger" id="cx-go">Cancel booking</button><div class="error-msg" id="cx-err"></div>`, (m) => {
        const upd = () => { const p = m.querySelector('#cx-waive').checked ? 0 : Number(m.querySelector('#cx-pct').value || 0); m.querySelector('#cx-fee').value = fmtMoney(Math.round(a.estimated_value * p) / 100); };
        m.querySelectorAll('input').forEach(i => i.addEventListener('input', upd));
        m.querySelector('#cx-go').addEventListener('click', async () => {
          try { const r = await API.put(`/api/agreements/${a.id}/cancel`, { fee_pct: Number(m.querySelector('#cx-pct').value), waive_fee: m.querySelector('#cx-waive').checked, reason: m.querySelector('#cx-reason').value });
            m.remove(); toast(r.invoice ? `Cancelled — fee invoice ${r.invoice.invoice_number} (${fmtMoney(r.invoice.grand_total)})` : 'Booking cancelled'); reopen(); }
          catch (e) { m.querySelector('#cx-err').textContent = e.message; }
        });
      });
    });
    overlay.querySelector('#agr-print').addEventListener('click', () => { const w = window.open(`/api/agreements/${a.id}/print?autoprint=1`, '_blank'); if (!w) toast('Allow pop-ups to print', true); });
    overlay.querySelectorAll('[data-claim]').forEach(l => l.addEventListener('click', (e) => { e.preventDefault(); overlay.remove(); go('#/claims', { open: l.dataset.claim }); }));
    overlay.querySelectorAll('[data-claim-item]').forEach(l => l.addEventListener('click', (e) => {
      e.preventDefault(); const it = a.items.find(i => String(i.id) === l.dataset.claimItem);
      claimForm({ equipment_id: it.equipment_id, agreement_item_id: it.id, incident_type: it.is_lost ? 'lost' : 'damaged', amount_claimed: it.is_lost ? it.replacement_value : it.damage_charge, description: it.damage_notes || '' }, reopen);
    }));
    const crewBtn = overlay.querySelector('#add-crew-btn');
    if (crewBtn) crewBtn.addEventListener('click', () => addCrewFlow(a.id, overlay));
    const consBtn = overlay.querySelector('#add-consumable-btn');
    if (consBtn) consBtn.addEventListener('click', () => addConsumableFlow(a.id, overlay));
    const depAct = (sel, path, title, def, method) => { const b = overlay.querySelector(sel); if (b) b.addEventListener('click', () => {
      const m = openModal(title, `<div class="field"><label>Amount (NGN)</label><input id="d-amt" type="number" min="0" step="0.01" value="${def}"></div>
        ${method ? '<div class="field"><label>Method</label><select id="d-method"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option></select></div>' : ''}
        <button class="btn" id="d-go">Confirm</button><div class="error-msg" id="d-err"></div>`, (mm) => {
        mm.querySelector('#d-go').addEventListener('click', async () => {
          try { await API.post(`/api/agreements/${a.id}/${path}`, { amount: Number(mm.querySelector('#d-amt').value), method: mm.querySelector('#d-method')?.value }); mm.remove(); toast('Done'); reopen(); }
          catch (e) { mm.querySelector('#d-err').textContent = e.message; }
        });
      }); }); };
    depAct('#dep-receive', 'deposit', 'Deposit received', (a.deposit_amount - a.deposit_received).toFixed(2), true);
    depAct('#dep-apply', 'deposit/apply', 'Apply deposit to invoice', Math.min(depHeld, liveInv ? liveInv.grand_total - liveInv.amount_paid : 0).toFixed(2), false);
    depAct('#dep-refund', 'deposit/refund', 'Refund deposit', depHeld.toFixed(2), false);
  });
}

async function addCrewFlow(agreementId, overlay) {
  const rates = (await API.get('/api/crew-rates')).filter(r => r.active);
  openModal('Add crew member', `
    <div class="field"><label>Role (crew rate card)</label><select id="cw-roleid"><option value="">— Other / custom role —</option>${rates.map(r => `<option value="${r.id}" data-rate="${r.day_rate}">${escapeHtml(r.role)} — ${r.rate_on_request ? 'rate on request' : fmtMoney(r.day_rate) + '/day'}</option>`).join('')}</select></div>
    <div class="field"><label>Name</label><input id="cw-name"></div>
    <div class="field" id="cw-role-wrap"><label>Role</label><input id="cw-role" placeholder="e.g. DIT, Colourist"></div>
    <div class="grid-2">
      <div class="field"><label>Day rate (NGN)</label><input id="cw-rate" type="number" min="0" value="0"></div>
      <div class="field"><label>Days</label><input id="cw-days" type="number" min="0.5" step="0.5" value="1"></div>
    </div>
    <div class="help muted" style="margin-bottom:10px">Crew is billed as a taxable service (VAT applies; WHT at the services rate where the customer withholds).</div>
    <button class="btn" id="cw-save">Add crew</button><div class="error-msg" id="cw-err"></div>
  `, (m) => {
    const sel = m.querySelector('#cw-roleid');
    sel.addEventListener('change', () => { const o = sel.selectedOptions[0]; m.querySelector('#cw-role-wrap').style.display = sel.value ? 'none' : 'block'; if (sel.value) m.querySelector('#cw-rate').value = o.dataset.rate || 0; });
    m.querySelector('#cw-save').addEventListener('click', async () => {
      try {
        await API.post(`/api/agreements/${agreementId}/crew`, { crew_role_id: sel.value ? Number(sel.value) : undefined, crew_name: m.querySelector('#cw-name').value, role: sel.value ? undefined : m.querySelector('#cw-role').value, day_rate: Number(m.querySelector('#cw-rate').value), days: Number(m.querySelector('#cw-days').value) });
        toast('Crew added'); m.remove(); overlay.remove(); viewAgreement(agreementId);
      } catch (e) { m.querySelector('#cw-err').textContent = e.message; }
    });
  });
}

async function addConsumableFlow(agreementId, overlay) {
  const consumables = await API.get('/api/consumables');
  if (!consumables.length) return toast('No consumables in the catalog yet — add one under Consumables first.', true);
  const overlay2 = openModal('Issue consumable', `
    <div class="field"><label>Item</label><select id="c-item">${consumables.map(c => `<option value="${c.id}">${escapeHtml(c.name)} (${c.quantity_on_hand} in stock, ${fmtMoney(c.sale_price)} ea)</option>`).join('')}</select></div>
    <div class="field"><label>Quantity</label><input id="c-qty" type="number" value="1"></div>
    <button class="btn" id="issue-btn">Issue</button>
    <div class="error-msg" id="c-error"></div>
  `, (m) => {
    m.querySelector('#issue-btn').addEventListener('click', async () => {
      try {
        await API.post(`/api/agreements/${agreementId}/consumables`, { consumable_id: Number(m.querySelector('#c-item').value), qty: Number(m.querySelector('#c-qty').value || 1) });
        m.remove(); overlay.remove(); toast('Consumable issued'); viewAgreement(agreementId);
      } catch (e) { m.querySelector('#c-error').textContent = e.message; }
    });
  });
}

function checkoutFlow(agreementId, itemId, item, overlay) {
  let checklist = [];
  try { checklist = JSON.parse(item?.prep_checklist || '[]'); } catch {}
  const checklistHtml = checklist.length ? `
    <div class="field"><label>Prep / QC checklist</label>
      ${checklist.map((c, i) => `<div><label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type="checkbox" class="chk-item" data-label="${escapeHtml(c)}" style="width:auto" checked>${escapeHtml(c)}</label></div>`).join('')}
    </div>` : '';
  const m = openModal(`Check out — ${escapeHtml(item?.equipment_name || '')}`, `
    ${checklistHtml}
    <div class="field"><label>Condition notes</label><textarea id="co-condition" rows="2">Good condition, tested and confirmed working.</textarea></div>
    <div class="field"><label>Condition photos (optional — resized automatically)</label><input type="file" id="co-photos" accept="image/*" capture="environment" multiple></div>
    <button class="btn" id="co-confirm-btn">Confirm checkout</button>
  `, (overlay2) => {
    overlay2.querySelector('#co-confirm-btn').addEventListener('click', async () => {
      const checked = Array.from(overlay2.querySelectorAll('.chk-item')).map(cb => ({ item: cb.dataset.label, done: cb.checked }));
      try {
        await API.post(`/api/agreements/${agreementId}/checkout/${itemId}`, { condition: overlay2.querySelector('#co-condition').value, checklist: checked });
        for (const f of Array.from(overlay2.querySelector('#co-photos').files || [])) { try { await API.post('/api/photos', { entity_type: 'agreement_item', entity_id: Number(itemId), stage: 'checkout', caption: f.name, data_url: await shrinkImage(f) }); } catch (x) { toast('Photo not saved: ' + x.message, true); } }
        overlay2.remove(); toast('Checked out'); overlay.remove(); viewAgreement(agreementId);
        document.querySelector('#agr-status-filter')?.dispatchEvent(new Event('change'));
      } catch (e) { toast(e.message, true); }
    });
  });
}

function checkinFlow(agreementId, itemId, item, overlay) {
  const m = openModal(`Check in — ${escapeHtml(item?.equipment_name || '')}`, `
    <div class="field"><label><input type="checkbox" id="ci-lost" style="width:auto;margin-right:6px">Item was lost / stolen / never returned</label></div>
    <div id="ci-normal-fields">
      <div class="field"><label>Condition notes</label><textarea id="ci-condition" rows="2">Good condition on return.</textarea></div>
      <div class="field"><label>Damage charge (NGN, 0 if none)</label><input id="ci-damage" type="number" value="0"></div>
    </div>
    <div class="field"><label>Condition / damage photos (optional)</label><input type="file" id="ci-photos" accept="image/*" capture="environment" multiple></div>
    <div id="ci-lost-note" style="display:none" class="muted">This unit's replacement value (${fmtMoney(item?.replacement_value || 0)}) will be billed to the customer in full on the next invoice — a damage waiver never covers loss or theft.</div>
    <button class="btn" id="ci-confirm-btn" style="margin-top:12px">Confirm check-in</button>
  `, (overlay2) => {
    const lostCb = overlay2.querySelector('#ci-lost');
    lostCb.addEventListener('change', () => {
      overlay2.querySelector('#ci-normal-fields').style.display = lostCb.checked ? 'none' : 'block';
      overlay2.querySelector('#ci-lost-note').style.display = lostCb.checked ? 'block' : 'none';
    });
    overlay2.querySelector('#ci-confirm-btn').addEventListener('click', async () => {
      const isLost = lostCb.checked;
      const body = isLost
        ? { is_lost: true, condition: 'Item not returned — marked lost.' }
        : { condition: overlay2.querySelector('#ci-condition').value, damage_notes: Number(overlay2.querySelector('#ci-damage').value || 0) > 0 ? overlay2.querySelector('#ci-condition').value : undefined, damage_charge: Number(overlay2.querySelector('#ci-damage').value || 0) };
      try {
        await API.post(`/api/agreements/${agreementId}/checkin/${itemId}`, body);
        for (const f of Array.from(overlay2.querySelector('#ci-photos').files || [])) { try { await API.post('/api/photos', { entity_type: 'agreement_item', entity_id: Number(itemId), stage: body.damage_charge > 0 ? 'damage' : 'checkin', caption: f.name, data_url: await shrinkImage(f) }); } catch (x) { toast('Photo not saved: ' + x.message, true); } }
        overlay2.remove(); toast(isLost ? 'Marked lost — will be billed at replacement value' : 'Checked in'); overlay.remove(); viewAgreement(agreementId);
      } catch (e) { toast(e.message, true); }
    });
  });
}

/* ===================== INVOICES ===================== */
async function renderInvoices(main, params = {}) {
  const tab = params.einvoice ? 'nrs' : (params.tab || 'invoices');
  main.innerHTML = `
    <div class="page-header"><h2>Billing &amp; Invoices</h2></div>
    <div class="tabs" id="bill-tabs">
      <button class="tab" data-tab="invoices">Invoices</button>
      ${can('einvoice.view') ? '<button class="tab" data-tab="nrs">NRS e-invoice queue</button>' : ''}
      ${can('payments.view') ? '<button class="tab" data-tab="receipts">Receipts</button>' : ''}
    </div><div id="bill-body"></div>`;
  const body = document.getElementById('bill-body');
  document.querySelectorAll('#bill-tabs .tab').forEach(t => { t.classList.toggle('active', t.dataset.tab === tab); t.addEventListener('click', () => go('#/invoices', { tab: t.dataset.tab })); });
  if (tab === 'nrs') return renderEinvoiceQueue(body);
  if (tab === 'receipts') return renderReceipts(body, params);
  body.innerHTML = `
    <div class="toolbar">
      <input type="text" id="inv-q" placeholder="Invoice no., customer or IRN…" value="${escapeHtml(params.q || '')}">
      <select id="inv-status-filter"><option value="">All statuses</option>
        ${[['open', 'Open (unpaid / part-paid)'], ['unpaid', 'Unpaid'], ['partial', 'Part-paid'], ['paid', 'Paid'], ['void', 'Void']].map(([v, l]) => `<option value="${v}" ${params.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="muted"><input type="checkbox" id="inv-overdue" ${params.overdue ? 'checked' : ''} style="width:auto"> overdue only</label>
      <label class="muted"><input type="checkbox" id="inv-legacy" ${params.legacy ? 'checked' : ''} style="width:auto"> legacy (migrated) only</label>
      <input type="date" id="inv-from" value="${escapeHtml(params.from || '')}" title="Issued from"><input type="date" id="inv-to" value="${escapeHtml(params.to || '')}" title="Issued to">
      ${params.customer_id ? `<span class="filter-pill">Customer #${escapeHtml(params.customer_id)} <button id="clr-cust">×</button></span>` : ''}
      <span class="muted" id="inv-sum"></span>
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>Invoice #</th><th>Customer</th><th>Issued</th><th>Due</th><th class="num">Excl. VAT</th><th class="num">VAT</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th><th>NRS</th><th></th>
    </tr></thead><tbody id="inv-tbody"><tr><td colspan="11" class="empty-state">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    const qs = new URLSearchParams();
    const v = (id) => document.getElementById(id).value;
    if (v('inv-status-filter')) qs.set('status', v('inv-status-filter')); if (v('inv-q')) qs.set('q', v('inv-q'));
    if (document.getElementById('inv-overdue').checked) qs.set('overdue', '1'); if (document.getElementById('inv-legacy').checked) qs.set('legacy', '1');
    if (v('inv-from')) qs.set('from', v('inv-from')); if (v('inv-to')) qs.set('to', v('inv-to')); if (params.customer_id) qs.set('customer_id', params.customer_id);
    const rows = await API.get('/api/invoices?' + qs.toString());
    const live = rows.filter(r => r.status !== 'void');
    document.getElementById('inv-sum').innerHTML = `${rows.length} invoice(s) · total ${fmtMoney(live.reduce((a, r) => a + r.grand_total, 0))} · balance <strong>${fmtMoney(live.reduce((a, r) => a + r.balance, 0))}</strong>`;
    document.getElementById('inv-tbody').innerHTML = rows.length ? rows.map(i => `
      <tr class="drill" data-view-inv="${i.id}"${i.status === 'void' ? ' style="opacity:.55"' : ''}><td>${escapeHtml(i.invoice_number)}${i.invoice_kind === 'cancellation' ? ' <span class="badge reserved">cancellation</span>' : ''}</td><td>${escapeHtml(i.company_name || i.customer_name)}</td><td>${fmtDate(i.issue_date)}</td>
        <td>${i.days_overdue > 0 && ['unpaid', 'partial'].includes(i.status) ? `<span style="color:var(--red)">${fmtDate(i.due_date)}</span>` : fmtDate(i.due_date)}</td>
        <td class="num">${fmtMoney(i.subtotal)}</td><td class="num">${fmtMoney(i.vat_total)}</td><td class="num">${fmtMoney(i.grand_total)}</td>
        <td class="num">${i.status === 'void' ? '—' : fmtMoney(i.balance)}</td><td>${badge(i.status)}</td><td>${i.is_legacy ? '<span class="muted">legacy</span>' : badge(i.einvoice_status || 'not_submitted')}</td>
        <td class="row-actions"><a href="#" data-print-inv="${i.id}">Print</a>${can('invoices.edit') && i.status !== 'void' ? ` · <a href="#" data-email-inv="${i.id}">Email</a>` : ''}</td></tr>`).join('')
      : `<tr><td colspan="11" class="empty-state">No invoices match. Generate one from a booking.</td></tr>`;
    document.querySelectorAll('[data-view-inv]').forEach(a => a.addEventListener('click', (e) => { if (e.target.closest('a')) return; viewInvoice(a.dataset.viewInv, load); }));
    document.querySelectorAll('[data-print-inv]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); printInvoice(a.dataset.printInv); }));
    document.querySelectorAll('[data-email-inv]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); emailInvoiceFlow(a.dataset.emailInv); }));
  }
  ['inv-status-filter', 'inv-overdue', 'inv-legacy', 'inv-from', 'inv-to'].forEach(id => document.getElementById(id).addEventListener('change', load));
  document.getElementById('inv-q').addEventListener('input', debounce(load, 300));
  const cc = document.getElementById('clr-cust'); if (cc) cc.addEventListener('click', () => go('#/invoices'));
  await load();
  if (params.open) viewInvoice(params.open, load);
}

async function renderEinvoiceQueue(body) {
  const st = await API.get('/api/einvoice/status');
  const rows = await API.get('/api/invoices?einvoice_status=pending');
  body.innerHTML = `
    <div class="tax-grid">
      <div class="tax-box"><div class="k">Mode</div><div class="v" style="text-transform:capitalize">${escapeHtml(st.mode)}</div><div class="s">${st.mode === 'live' ? 'via ' + escapeHtml(st.app_name || 'Access Point Provider') : st.mode === 'simulator' ? 'Training / testing — no data leaves the portal' : 'Switch on under Admin → NRS e-invoicing'}</div></div>
      <div class="tax-box"><div class="k">Cleared (IRN issued)</div><div class="v">${st.counts.cleared || 0}</div><div class="s">${st.auto_submit ? 'Auto-submit on invoice generation' : 'Manual submission'}</div></div>
      <div class="tax-box"><div class="k">Awaiting submission</div><div class="v">${(st.counts.not_submitted || 0) + (st.counts.submitted || 0)}</div><div class="s">${st.b2c_over_24h} B2C invoice(s) past the 24-hour reporting window</div></div>
      <div class="tax-box"><div class="k">Rejected</div><div class="v">${st.counts.rejected || 0}</div><div class="s">Fix the data and resubmit</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><h3>Integration readiness</h3><div class="check-list">${st.readiness.map(r => `<div class="${r.ok ? 'ok' : 'no'}">${r.ok ? '✔' : '✖'} ${escapeHtml(r.label)}</div>`).join('')}</div>
        ${can('admin.settings') ? '<button class="btn small secondary" id="nrs-settings" style="margin-top:10px">Open NRS settings</button>' : ''}</div>
      <div class="card"><h3>How clearance works</h3><p class="muted" style="margin:0;font-size:13px">B2B / B2G invoices must be validated on the NRS Merchant Buyer Solution before issue; B2C sales reported within 24 hours. The portal maps each invoice to the MBS JSON, pre-checks the mandatory fields, submits through your accredited Access Point Provider and stores the returned IRN, CSID and QR code (printed on the invoice). Every request/response is logged.</p></div>
    </div>
    <div class="toolbar">${can('einvoice.edit') && st.mode !== 'off' ? '<button class="btn small" id="nrs-all">Submit all pending</button>' : ''}<span class="muted">${rows.length} invoice(s) not yet cleared</span>
      <span style="margin-left:auto">${exportLinks('/api/reports/run/einvoice_register?from=2000-01-01')}</span></div>
    <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Date</th><th>Model</th><th>Customer</th><th class="num">Total</th><th>NRS status</th><th>Last error</th><th></th></tr></thead><tbody>
    ${rows.map(i => `<tr class="drill" data-inv="${i.id}"><td>${escapeHtml(i.invoice_number)}</td><td>${fmtDate(i.issue_date)}</td><td>${escapeHtml(i.transaction_model)}</td><td>${escapeHtml(i.company_name || i.customer_name)}</td><td class="num">${fmtMoney(i.grand_total)}</td><td>${badge(i.einvoice_status)}</td><td class="muted" style="font-size:12px;max-width:320px">${escapeHtml(i.einvoice_error || '')}</td>
      <td>${can('einvoice.edit') && st.mode !== 'off' ? `<button class="btn small" data-sub="${i.id}">Submit</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-state">Everything is cleared. 🎉</td></tr>'}</tbody></table></div>`;
  body.querySelectorAll('[data-inv]').forEach(r => r.addEventListener('click', (e) => { if (e.target.closest('button')) return; viewInvoice(r.dataset.inv); }));
  body.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; try { const r = await API.post(`/api/invoices/${b.dataset.sub}/einvoice/submit`); toast(`Cleared — IRN ${r.irn}`); } catch (e) { toast(e.message, true); } renderEinvoiceQueue(body);
  }));
  const all = body.querySelector('#nrs-all'); if (all) all.addEventListener('click', async () => {
    all.disabled = true; all.textContent = 'Submitting…';
    try { const r = await API.post('/api/einvoice/submit-pending'); toast(`${r.cleared} of ${r.attempted} cleared${r.failed.length ? ` · ${r.failed.length} need attention` : ''}`, r.failed.length > 0); } catch (e) { toast(e.message, true); }
    renderEinvoiceQueue(body);
  });
  const ns = body.querySelector('#nrs-settings'); if (ns) ns.addEventListener('click', () => go('#/admin', { tab: 'nrs' }));
}

async function renderReceipts(body, params) {
  const today = new Date().toISOString().slice(0, 10);
  body.innerHTML = `<div class="toolbar"><input type="date" id="rc-from" value="${params.from || today.slice(0, 8) + '01'}"><input type="date" id="rc-to" value="${params.to || today}">
    <select id="rc-m"><option value="">All methods</option>${['bank_transfer', 'cash', 'card', 'pos', 'cheque', 'deposit_applied'].map(m => `<option>${m}</option>`).join('')}</select><span class="muted" id="rc-sum"></span>
    <span style="margin-left:auto" id="rc-exp"></span></div><div id="rc-table"></div>`;
  const load = async () => {
    const f = body.querySelector('#rc-from').value, t = body.querySelector('#rc-to').value, m = body.querySelector('#rc-m').value;
    const rows = await API.get(`/api/payments?from=${f}&to=${t}${m ? '&method=' + m : ''}`);
    const live = rows.filter(r => !r.reversed_at);
    body.querySelector('#rc-sum').innerHTML = `${rows.length} receipt(s) · cash ${fmtMoney(live.reduce((a, r) => a + r.amount, 0))} · WHT ${fmtMoney(live.reduce((a, r) => a + r.wht_amount, 0))}`;
    const def = { source: 'payments', columns: ['payment_ref', 'date', 'invoice', 'customer', 'method', 'cash', 'wht', 'credit_note', 'reversed'], filters: [{ field: 'date', op: 'between', value: f, value2: t }], sort: [{ field: 'date', dir: 'asc' }] };
    body.querySelector('#rc-exp').innerHTML = exportLinks('/api/report-builder/export?d=' + btoa(JSON.stringify(def)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    body.querySelector('#rc-table').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Receipt</th><th>Date</th><th>Invoice</th><th>Customer</th><th>Method</th><th class="num">Cash / bank</th><th class="num">WHT</th><th>Credit note</th></tr></thead><tbody>
      ${rows.map(p => `<tr class="drill" data-inv="${p.invoice_id}" ${p.reversed_at ? 'style="opacity:.5;text-decoration:line-through"' : ''}><td>${escapeHtml(p.payment_ref)}</td><td>${fmtDate(p.received_at)}</td><td>${escapeHtml(p.invoice_number || '')}</td><td>${escapeHtml(p.customer_name || '')}</td><td>${escapeHtml(String(p.method).replace(/_/g, ' '))}</td><td class="num">${fmtMoney(p.amount)}</td><td class="num">${p.wht_amount ? fmtMoney(p.wht_amount) : ''}</td><td>${escapeHtml(p.wht_credit_note_no || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-state">No receipts in this period.</td></tr>'}</tbody></table></div>`;
    body.querySelectorAll('[data-inv]').forEach(r => r.addEventListener('click', () => viewInvoice(r.dataset.inv)));
  };
  body.querySelectorAll('input,select').forEach(i => i.addEventListener('change', load));
  load();
}

const PAY_METHODS = [['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['pos', 'POS'], ['cheque', 'Cheque']];

async function viewInvoice(id, reload) {
  const inv = await API.get('/api/invoices/' + id);
  const cashAccts = can('payments.edit') ? await API.get('/api/cash-accounts') : [];
  const canPay = can('payments.edit') && inv.status !== 'void';
  const canEdit = can('invoices.edit');
  const taxable = inv.vat_rate > 0;
  const emailLog = (inv.emails || []).map(e => `
    <div><span class="badge ${e.status === 'sent' ? 'approved' : 'rejected'}">${escapeHtml(e.status)}</span>
      ${escapeHtml(e.to_address)}${e.cc_address ? ' <span class="muted">cc ' + escapeHtml(e.cc_address) + '</span>' : ''}
      <span class="muted">· ${escapeHtml(e.sent_at)} · ${escapeHtml(e.sent_by_name || '')}</span>
      ${e.error ? `<div class="error-msg" style="margin:2px 0 0">${escapeHtml(e.error)}</div>` : ''}</div>`).join('');
  const lines = inv.items.map(li => `<tr><td>${escapeHtml(li.description)}</td>
      <td style="text-align:right;white-space:nowrap">${fmtMoney(li.amount)}</td>
      <td style="text-align:right;white-space:nowrap" class="muted">${li.vat_rate > 0 ? li.vat_rate + '%' : 'n/a'}</td>
      <td style="text-align:right;white-space:nowrap">${fmtMoney(li.vat_amount)}</td></tr>`).join('');
  const payRows = inv.payments.map(p => `<div${p.reversed_at ? ' style="opacity:.5;text-decoration:line-through"' : ''}>
      ${escapeHtml(p.payment_ref)} — ${fmtMoney(p.amount)} ${escapeHtml(String(p.method).replace(/_/g, ' '))}
      ${p.wht_amount > 0 ? `+ <strong>${fmtMoney(p.wht_amount)} WHT</strong> ${p.wht_credit_note_no ? '(CN ' + escapeHtml(p.wht_credit_note_no) + ')' : '<span style="color:var(--amber)">(credit note not yet received)</span>'}` : ''}
      <span class="muted">· ${fmtDate(p.received_at)}</span>
      ${p.reversed_at ? `<span class="muted">· reversed: ${escapeHtml(p.reversal_reason || '')}</span>` : (canPay ? ` <a href="#" data-reverse-pay="${p.id}">reverse</a>` : '')}</div>`).join('');

  openModal(escapeHtml(inv.invoice_number), `
    <p>${badge(inv.status)} <span class="muted">${escapeHtml(inv.customer_name || '')}${inv.customer_tin ? ' · TIN ' + escapeHtml(inv.customer_tin) : ' · <span style="color:var(--amber)">no customer TIN on file</span>'} · Issued ${fmtDate(inv.issue_date)} · Due ${fmtDate(inv.due_date)}</span></p>
    ${inv.status === 'void' ? `<div class="notice bad">Voided: ${escapeHtml(inv.void_reason || '')}. The number is retained so numbering stays sequential.</div>` : ''}
    <div class="btn-row" style="margin-bottom:14px">
      <button class="btn small" id="print-inv-btn">Print invoice</button>
      ${canEdit && inv.status !== 'void' ? '<button class="btn small secondary" id="email-inv-btn">Email to client</button>' : ''}
      ${canEdit && inv.status === 'unpaid' ? '<button class="btn small danger" id="void-inv-btn">Void invoice</button>' : ''}
    </div>
    <table class="inv-lines"><thead><tr><th>Description</th><th style="text-align:right">Excl. VAT</th><th style="text-align:right">Rate</th><th style="text-align:right">VAT</th></tr></thead><tbody>${lines}</tbody></table>
    <table class="tot-table" style="margin-left:auto;margin-top:8px">
      <tr><td>Total excl. VAT</td><td>${fmtMoney(inv.subtotal)}</td></tr>
      ${inv.exempt_total > 0 && taxable ? `<tr><td class="muted">of which outside VAT scope (damage/loss)</td><td class="muted">${fmtMoney(inv.exempt_total)}</td></tr>` : ''}
      <tr><td>VAT ${taxable ? '(' + inv.vat_rate + '%)' : '— not charged'}</td><td>${fmtMoney(inv.vat_total)}</td></tr>
      <tr class="strong"><td>Invoice total</td><td>${fmtMoney(inv.grand_total)}</td></tr>
      ${inv.amount_paid > 0 ? `<tr><td>Settled to date</td><td>– ${fmtMoney(inv.amount_paid)}</td></tr>` : ''}
      ${inv.wht_credited > 0 ? `<tr><td class="muted">&nbsp;&nbsp;of which WHT deducted by customer</td><td class="muted">${fmtMoney(inv.wht_credited)}</td></tr>` : ''}
      <tr class="strong"><td>Balance due</td><td>${fmtMoney(inv.balance)}</td></tr>
    </table>
    ${inv.wht_total > 0 ? `<div class="notice">Customer is a withholding agent. Expected WHT on this invoice: <strong>${fmtMoney(inv.wht_total)}</strong> (on the VAT-exclusive amount). They should pay us the net, remit the WHT to the tax authority and send us the WHT credit note.</div>` : ''}

    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Payments</h3>
    <div id="inv-payments">${payRows || '<p class="muted">No payments recorded.</p>'}</div>
    ${canPay && inv.balance > 0.005 ? `
    <div class="field" style="margin-top:12px"><label>Record a payment</label>
      <div class="grid-2">
        <div><input id="pay-amt" type="number" min="0" step="0.01" placeholder="Cash / bank received" value="${inv.wht_total > 0 ? Math.max(0, inv.balance - Math.max(0, inv.wht_total - inv.wht_credited)).toFixed(2) : inv.balance.toFixed(2)}"></div>
        <div><select id="pay-method">${PAY_METHODS.map(m => `<option value="${m[0]}">${m[1]}</option>`).join('')}</select></div>
        <div><input id="pay-date" type="date" value="${new Date().toISOString().slice(0, 10)}" title="Date received"></div>
        <div><select id="pay-into" title="Received into">${cashAccts.map(a => `<option value="${a.code}" ${a.code === '102000' ? 'selected' : ''}>${escapeHtml(a.code)} ${escapeHtml(a.name)}</option>`).join('')}</select></div>
      </div>
      ${inv.customer_wht_agent ? `<div class="grid-2" style="margin-top:6px">
        <div><input id="pay-wht" type="number" min="0" step="0.01" placeholder="WHT deducted by customer" value="${Math.max(0, inv.wht_total - inv.wht_credited).toFixed(2)}"></div>
        <div><input id="pay-cn" placeholder="WHT credit note no. (if received)"></div></div>
        <div class="help">Both amounts settle the invoice. The WHT part becomes a tax credit you can set against your income tax — keep the credit note.</div>` : ''}
      <button class="btn small" id="pay-btn" style="margin-top:8px">Record payment</button>
    </div>` : ''}

    ${!inv.is_legacy ? `<div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">E-invoice (NRS MBS) <span class="muted" style="font-weight:400;font-size:12px">· ${escapeHtml(inv.transaction_model)} · mode: ${escapeHtml(inv.nrs_mode)}</span></h3>
    <p class="muted" style="margin-top:0">Status: ${badge(inv.einvoice_status || 'not_submitted')} ${inv.einvoice_irn ? '· IRN <strong>' + escapeHtml(inv.einvoice_irn) + '</strong>' : ''}${inv.einvoice_cleared_at ? ' · cleared ' + escapeHtml(String(inv.einvoice_cleared_at).slice(0, 16).replace('T', ' ')) : ''}${inv.credit_note_number ? ' · credit note <strong>' + escapeHtml(inv.credit_note_number) + '</strong>' : ''}</p>
    ${inv.einvoice_error ? `<div class="notice bad">${escapeHtml(inv.einvoice_error)}</div>` : ''}
    <div class="btn-row">
      ${can('einvoice.view') ? '<button class="btn small secondary" id="einv-check">Pre-validate</button>' : ''}
      ${can('einvoice.edit') && inv.nrs_mode !== 'off' && inv.status !== 'void' && inv.einvoice_status !== 'cleared' ? '<button class="btn small" id="einv-submit">Submit to NRS</button>' : ''}
      ${can('einvoice.edit') && inv.einvoice_status === 'cleared' && inv.nrs_mode !== 'off' ? '<button class="btn small secondary" id="einv-confirm">Confirm status</button>' : ''}
      <a class="btn small secondary" href="/api/invoices/${inv.id}/einvoice.json">Download MBS payload (JSON)</a>
      ${canEdit && inv.status !== 'void' ? '<button class="btn small secondary" id="einv-btn">Record IRN manually</button>' : ''}
    </div>
    <div id="einv-out"></div>
    ${(inv.submissions || []).length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Submission log (${inv.submissions.length})</summary>${inv.submissions.map(x => `<div style="font-size:12px">${escapeHtml(String(x.created_at).slice(0, 16))} · ${escapeHtml(x.action)} · ${escapeHtml(x.mode)} · ${badge(x.status)} ${x.http_status ? 'HTTP ' + x.http_status : ''} ${escapeHtml(x.error || '')} <span class="muted">${escapeHtml(x.by_name || '')}</span></div>`).join('')}</details>` : ''}` : '<div class="notice">Legacy invoice brought forward from the previous system — not submitted to NRS.</div>'}
    ${(inv.journals || []).length ? `<div class="section-divider"></div><h3 style="border:none;padding:0;margin-bottom:8px">Ledger postings</h3>${inv.journals.map(j => `<a href="#" data-je="${j.id}" style="margin-right:12px">${escapeHtml(j.entry_number)}</a><span class="muted" style="font-size:12px">${escapeHtml(j.source_type)} ${j.entry_date}</span><br>`).join('')}` : ''}
    ${inv.agreement ? `<p style="margin-top:10px">Booking: <a href="#" data-agr="${inv.agreement.id}">${escapeHtml(inv.agreement.agreement_number)}</a> · Customer: <a href="#" data-cust="${inv.customer_id}">${escapeHtml(inv.customer_name)}</a></p>` : ''}

    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Email history</h3>
    <div>${emailLog || '<span class="muted">Not emailed yet.</span>'}</div>
    <div class="error-msg" id="inv-error"></div>
  `, (overlay) => {
    const refresh = () => { overlay.remove(); viewInvoice(id, reload); if (reload) reload(); };
    const err = (e) => { overlay.querySelector('#inv-error').textContent = e.message; };
    overlay.querySelector('#print-inv-btn').addEventListener('click', () => printInvoice(id));
    const em = overlay.querySelector('#email-inv-btn'); if (em) em.addEventListener('click', () => emailInvoiceFlow(id));
    const pb = overlay.querySelector('#pay-btn');
    if (pb) pb.addEventListener('click', async () => {
      pb.disabled = true;
      try {
        const method = overlay.querySelector('#pay-method').value;
        const r = await API.post('/api/payments', { invoice_id: inv.id, amount: Number(overlay.querySelector('#pay-amt').value || 0), method, received_on: overlay.querySelector('#pay-date').value,
          deposit_to: method === 'cash' && overlay.querySelector('#pay-into').value === '102000' ? '101000' : overlay.querySelector('#pay-into').value,
          wht_amount: overlay.querySelector('#pay-wht') ? Number(overlay.querySelector('#pay-wht').value || 0) : 0, wht_credit_note_no: overlay.querySelector('#pay-cn')?.value || '' });
        toast(`Payment ${r.payment_ref} recorded — balance ${fmtMoney(r.balance)}`); refresh();
      } catch (e) { err(e); pb.disabled = false; }
    });
    overlay.querySelectorAll('[data-reverse-pay]').forEach(a => a.addEventListener('click', async (e) => {
      e.preventDefault(); const reason = prompt('Reason for reversing this payment (e.g. bounced transfer):'); if (!reason) return;
      try { await API.post(`/api/payments/${a.dataset.reversePay}/reverse`, { reason }); toast('Payment reversed'); refresh(); } catch (x) { err(x); }
    }));
    const vb = overlay.querySelector('#void-inv-btn');
    if (vb) vb.addEventListener('click', async () => {
      const reason = prompt('Why is this invoice being voided? (recorded in the audit trail)'); if (!reason) return;
      try { const r = await API.post(`/api/invoices/${id}/void`, { reason }); toast(r.credit_note_number ? `Voided — credit note ${r.credit_note_number} issued to NRS` : 'Invoice voided — you can now re-issue from the booking'); refresh(); } catch (x) { err(x); }
    });
    overlay.querySelectorAll('[data-je]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); viewJournalEntry(a.dataset.je); }));
    overlay.querySelectorAll('[data-agr]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); overlay.remove(); viewAgreement(a.dataset.agr); }));
    overlay.querySelectorAll('[data-cust]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); overlay.remove(); viewCustomer(a.dataset.cust); }));
    const ec = overlay.querySelector('#einv-check'); if (ec) ec.addEventListener('click', async () => {
      try { const r = await API.post(`/api/invoices/${id}/einvoice/validate`);
        overlay.querySelector('#einv-out').innerHTML = `<div class="notice ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'All mandatory fields present — ready to submit.' : 'Fix before submitting:'}${r.errors.map(x => `<div>✖ ${escapeHtml(x)}</div>`).join('')}${r.warnings.map(x => `<div>⚠ ${escapeHtml(x)}</div>`).join('')}</div><details><summary class="muted" style="cursor:pointer">Payload preview</summary><pre class="payload">${escapeHtml(JSON.stringify(r.payload, null, 2))}</pre></details>`; }
      catch (x) { err(x); }
    });
    const es = overlay.querySelector('#einv-submit'); if (es) es.addEventListener('click', async () => {
      es.disabled = true; es.textContent = 'Submitting…';
      try { const r = await API.post(`/api/invoices/${id}/einvoice/submit`); toast(`Cleared on NRS — IRN ${r.irn}`); refresh(); } catch (x) { err(x); es.disabled = false; es.textContent = 'Submit to NRS'; }
    });
    const ecf = overlay.querySelector('#einv-confirm'); if (ecf) ecf.addEventListener('click', async () => { try { const r = await API.post(`/api/invoices/${id}/einvoice/confirm`); toast('NRS status: ' + r.status); refresh(); } catch (x) { err(x); } });
    const eb = overlay.querySelector('#einv-btn');
    if (eb) eb.addEventListener('click', () => openModal('Record e-invoice status', `
      <div class="field"><label>Status</label><select id="ei-status">${['not_submitted', 'submitted', 'cleared', 'rejected'].map(s => `<option value="${s}" ${s === inv.einvoice_status ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}</select></div>
      <div class="field"><label>IRN (Invoice Reference Number)</label><input id="ei-irn" value="${escapeHtml(inv.einvoice_irn || '')}"></div>
      <div class="field"><label>CSID (cryptographic stamp)</label><input id="ei-csid" value="${escapeHtml(inv.einvoice_csid || '')}"></div>
      <button class="btn" id="ei-save">Save</button><div class="error-msg" id="ei-err"></div>`, (m) => {
      m.querySelector('#ei-save').addEventListener('click', async () => {
        try { await API.put(`/api/invoices/${id}/einvoice`, { status: m.querySelector('#ei-status').value, irn: m.querySelector('#ei-irn').value, csid: m.querySelector('#ei-csid').value }); m.remove(); toast('Saved'); refresh(); }
        catch (x) { m.querySelector('#ei-err').textContent = x.message; }
      });
    }));
  });
}

function printInvoice(id) {
  const w = window.open(`/api/invoices/${id}/print?autoprint=1`, '_blank');
  if (!w) toast('Allow pop-ups for this site to print invoices', true);
}

async function emailInvoiceFlow(id) {
  let draft;
  try { draft = await API.get(`/api/invoices/${id}/email-draft`); } catch (e) { return toast(e.message, true); }
  const overlay = openModal('Email invoice to client', `
    ${draft.smtp_configured ? `<p class="muted" style="margin-top:0">Sends from ${escapeHtml(draft.from)}. The branded invoice is in the email body and attached as a printable file.</p>`
      : `<p class="error-msg" style="margin-top:0">Email isn't set up yet. ${can('admin.settings') ? 'Configure it under Admin → White-label &amp; settings → Email (SMTP).' : 'Ask an administrator to configure SMTP.'}</p>`}
    <div class="field"><label>To</label><input id="em-to" type="email" value="${escapeHtml(draft.to)}" placeholder="client@example.com"></div>
    ${draft.to ? '' : '<div class="help muted" style="margin:-10px 0 12px;font-size:12px">This customer has no email on file — enter one above.</div>'}
    <div class="field"><label>Cc (optional, comma-separated)</label><input id="em-cc" value="${escapeHtml(draft.cc)}"></div>
    <div class="field"><label>Subject</label><input id="em-subject" value="${escapeHtml(draft.subject)}"></div>
    <div class="field"><label>Message</label><textarea id="em-message" rows="7">${escapeHtml(draft.message)}</textarea></div>
    <div class="btn-row">
      <button class="btn" id="em-send" ${draft.smtp_configured ? '' : 'disabled'}>Send email</button>
      <button class="btn secondary" id="em-preview">Preview invoice</button>
    </div>
    <div class="error-msg" id="em-error"></div>
  `, (ov) => {
    ov.querySelector('.modal').classList.add('wide');
    ov.querySelector('#em-preview').addEventListener('click', () => window.open(`/api/invoices/${id}/print`, '_blank'));
    ov.querySelector('#em-send').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Sending…';
      ov.querySelector('#em-error').textContent = '';
      try {
        const r = await API.post(`/api/invoices/${id}/email`, {
          to: ov.querySelector('#em-to').value.trim(),
          cc: ov.querySelector('#em-cc').value.trim(),
          subject: ov.querySelector('#em-subject').value,
          message: ov.querySelector('#em-message').value,
        });
        ov.remove(); toast(`Invoice emailed to ${r.to}`); viewInvoice(id);
      } catch (err) {
        ov.querySelector('#em-error').textContent = err.message;
        btn.disabled = false; btn.textContent = 'Send email';
      }
    });
  });
  return overlay;
}


/* ===================== FINANCE (expenses + reports + tax) ===================== */
const EXPENSE_CATS = ['fuel', 'spare_parts', 'salary', 'rent', 'utilities', 'insurance', 'consumables', 'crew', 'other'];

async function renderFinance(main, params = {}) {
  const tab = params.tab || 'tax';
  main.innerHTML = `
    <div class="page-header"><h2>Finance &amp; tax</h2>${can('expenses.edit') ? '<button class="btn" id="add-exp-btn">+ Vendor bill / expense</button>' : ''}</div>
    <div class="tabs" id="fin-tabs">
      ${[['tax', 'VAT & WHT'], ['expenses', 'Vendor bills'], ['pl', 'Profit or loss'], ['bs', 'Financial position'], ['tb', 'Trial balance'], ['aging', 'Receivables ageing'], ['ap', 'Payables ageing'], ['ctax', 'Corporate tax']].map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}
    </div>
    <div id="fin-body"></div>`;
  const body = document.getElementById('fin-body');
  document.querySelectorAll('#fin-tabs .tab').forEach(t => t.addEventListener('click', () => go('#/finance', { tab: t.dataset.tab })));
  const addBtn = document.getElementById('add-exp-btn');
  if (addBtn) addBtn.addEventListener('click', () => expenseForm(() => go('#/finance', { tab: 'expenses' })));
  const rp = { pl: 'profit_and_loss', bs: 'balance_sheet', tb: 'trial_balance', aging: 'ar_aging', ap: 'ap_aging' };
  if (rp[tab]) return reportPanel(body, rp[tab], params);
  if (tab === 'expenses') return loadExpenses(body, params);
  if (tab === 'ctax') return loadCorporateTax(body);
  return loadTax(body, params);
}

async function loadTax(body, params) {
  const thisMonth = params.month || new Date().toISOString().slice(0, 7);
  body.innerHTML = `
    <div class="toolbar"><label class="muted">Month</label><input type="month" id="tax-month" value="${thisMonth}" style="max-width:180px">
      <span style="margin-left:auto" class="export-row" id="tax-exp"></span></div>
    <div id="tax-out"></div>`;
  const month = document.getElementById('tax-month');
  async function draw() {
    const t = await API.get('/api/reports/tax?month=' + month.value);
    document.getElementById('tax-exp').innerHTML = `<a href="/api/reports/run/vat_schedule?month=${month.value}&format=xlsx">VAT schedule (Excel)</a><a href="/api/reports/run/vat_schedule?month=${month.value}&format=pdf">VAT schedule (PDF)</a><a href="/api/reports/run/wht_schedule?month=${month.value}&format=xlsx">WHT schedule (Excel)</a><a href="/api/reports/tax.csv?month=${month.value}">Working paper (CSV)</a>`;
    const o = t.output_vat, i = t.input_vat, w1 = t.wht_deducted_by_customers, w2 = t.wht_withheld_from_vendors;
    document.getElementById('tax-out').innerHTML = `
      <div class="tax-grid">
        <div class="tax-box"><div class="k">Output VAT (charged on sales)</div><div class="v">${fmtMoney(o.vat_charged)}</div><div class="s">${o.invoice_count} invoice(s) · taxable ${fmtMoney(o.taxable_supplies)}</div></div>
        <div class="tax-box"><div class="k">Input VAT (claimable on purchases)</div><div class="v">${fmtMoney(i.claimed)}</div><div class="s">${i.items.length} vendor invoice(s)</div></div>
        <div class="tax-box"><div class="k">Net VAT ${t.net_vat.position}</div><div class="v">${fmtMoney(Math.abs(t.net_vat.payable))}</div><div class="s">File &amp; pay by ${fmtDate(t.period.vat_return_due)}</div></div>
        <div class="tax-box"><div class="k">WHT to remit (from vendors)</div><div class="v">${fmtMoney(w2.total)}</div><div class="s">Remit by ${fmtDate(t.period.wht_remittance_due)}</div></div>
        <div class="tax-box"><div class="k">WHT credits (deducted by customers)</div><div class="v">${fmtMoney(w1.total)}</div><div class="s">${w1.missing_credit_notes ? `<span style="color:var(--amber)">${w1.missing_credit_notes} credit note(s) outstanding</span>` : 'All credit notes received'}</div></div>
        <div class="tax-box"><div class="k">NRS e-invoice clearance</div><div class="v">${o.invoice_count - o.not_cleared_on_nrs}/${o.invoice_count}</div><div class="s">${o.not_cleared_on_nrs ? `<a href="#" id="tax-nrs">${o.not_cleared_on_nrs} not cleared →</a>` : 'All cleared'}</div></div>
      </div>
      <p class="muted" style="font-size:12px">Ledger: VAT payable ${fmtMoney(-t.ledger_balances.vat_payable)} · input VAT ${fmtMoney(t.ledger_balances.input_vat)} · WHT receivable ${fmtMoney(t.ledger_balances.wht_receivable)} · WHT payable ${fmtMoney(-t.ledger_balances.wht_payable)}</p>
      ${o.voided_invoice_count ? `<div class="notice">${o.voided_invoice_count} voided invoice(s) this month are excluded (numbers retained for the sequence).</div>` : ''}
      ${i.not_claimable.length ? `<div class="notice">Input VAT NOT claimed on ${i.not_claimable.length} bill(s) — a vendor tax-invoice number is required: ${i.not_claimable.map(x => escapeHtml(x.expense_number)).join(', ')}.</div>` : ''}
      <h3>Sales by type</h3>
      <div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Excl. VAT</th><th class="num">VAT</th></tr></thead><tbody>
        ${o.by_category.map(c => `<tr><td>${escapeHtml(c.category)}${c.category === 'recovery' ? ' <span class="muted">(outside VAT scope)</span>' : ''}</td><td class="num">${fmtMoney(c.net)}</td><td class="num">${fmtMoney(c.vat)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-state">No invoices this month.</td></tr>'}
      </tbody></table></div>
      <h3>Output VAT — invoices</h3>
      <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Customer TIN</th><th>IRN</th><th class="num">Net</th><th class="num">VAT</th></tr></thead><tbody>
        ${o.invoices.map(x => `<tr class="drill" data-inv="${x.id}"><td>${escapeHtml(x.invoice_number)}</td><td>${fmtDate(x.issue_date)}</td><td>${escapeHtml(x.customer)}</td><td>${x.customer_tin ? escapeHtml(x.customer_tin) : '—'}</td><td class="muted" style="font-size:12px">${escapeHtml(x.irn || badge(x.einvoice_status))}</td><td class="num">${fmtMoney(x.net)}</td><td class="num">${fmtMoney(x.vat)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-state">None.</td></tr>'}
      </tbody></table></div>
      <h3>WHT deducted by customers (tax credits)</h3>
      <div class="table-wrap"><table><thead><tr><th>Payment</th><th>Invoice</th><th>Customer</th><th class="num">WHT</th><th>Credit note</th></tr></thead><tbody>
        ${w1.items.map(x => `<tr><td>${escapeHtml(x.payment_ref)}</td><td>${escapeHtml(x.invoice_number)}</td><td>${escapeHtml(x.customer)}</td><td class="num">${fmtMoney(x.wht_amount)}</td><td>${x.wht_credit_note_no ? escapeHtml(x.wht_credit_note_no) : '<span style="color:var(--amber)">outstanding</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">None.</td></tr>'}
      </tbody></table></div>
      <h3>WHT withheld from vendors (remit to NRS)</h3>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Bill</th><th>Vendor</th><th>Vendor TIN</th><th class="num">Rate</th><th class="num">WHT</th></tr></thead><tbody>
        ${w2.items.map(x => `<tr><td>${fmtDate(x.entry_date)}</td><td>${escapeHtml(x.expense_number)}</td><td>${escapeHtml(x.vendor_name || '')}</td><td>${x.vendor_tin ? escapeHtml(x.vendor_tin) : '<span style="color:var(--amber)">none — rate doubled</span>'}</td><td class="num">${x.wht_rate}%</td><td class="num">${fmtMoney(x.wht)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-state">None.</td></tr>'}
      </tbody></table></div>
      <div class="help muted">Working paper for the monthly VAT return and WHT remittance on the NRS TaxPro-Max portal — not a filed return. Confirm treatment with your tax adviser.</div>`;
    document.querySelectorAll('#tax-out [data-inv]').forEach(r => r.addEventListener('click', () => viewInvoice(r.dataset.inv)));
    const tn = document.getElementById('tax-nrs'); if (tn) tn.addEventListener('click', (e) => { e.preventDefault(); go('#/invoices', { einvoice: 'pending' }); });
  }
  month.addEventListener('change', () => draw().catch(e => { document.getElementById('tax-out').innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; }));
  await draw();
}

async function loadExpenses(body, params) {
  body.innerHTML = `<div class="toolbar">
      <select id="ex-status"><option value="">All</option>${[['unpaid', 'Unpaid'], ['paid', 'Paid'], ['void', 'Void']].map(([v, l]) => `<option value="${v}" ${params.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="text" id="ex-vendor" placeholder="Vendor…"><input type="date" id="ex-from"><input type="date" id="ex-to"><span class="muted" id="ex-sum"></span>
      <span style="margin-left:auto">${exportLinks('/api/reports/run/ap_aging')}</span></div><div id="ex-table"></div>
      <div class="help muted">Bills post to the ledger when recorded (Dr expense / asset · Dr input VAT · Cr trade payables). WHT is deducted when the voucher pays the bill.</div>`;
  const load = async () => {
    const q = new URLSearchParams(); const v = (i) => body.querySelector(i).value;
    if (v('#ex-status')) q.set('status', v('#ex-status')); if (v('#ex-vendor')) q.set('vendor', v('#ex-vendor')); if (v('#ex-from')) q.set('from', v('#ex-from')); if (v('#ex-to')) q.set('to', v('#ex-to'));
    const rows = await API.get('/api/expenses?' + q.toString());
    body.querySelector('#ex-sum').textContent = `${rows.length} bill(s) · net ${fmtMoney(rows.filter(e => e.status !== 'void').reduce((a, e) => a + e.amount, 0))}`;
    body.querySelector('#ex-table').innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>Date</th><th>GL</th><th>Vendor</th><th class="num">Net</th><th class="num">VAT</th><th class="num">WHT</th><th class="num">Pay vendor</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map(e => `<tr data-exp="${e.id}" ${String(params.open) === String(e.id) ? 'style="outline:2px solid var(--orange)"' : ''}><td>${escapeHtml(e.expense_number)}${e.is_legacy ? ' <span class="badge reserved">legacy</span>' : ''}</td><td>${fmtDate(e.expense_date)}</td>
        <td>${e.gl_code ? `<a href="#" data-gl="${e.gl_code}">${escapeHtml(e.gl_code)}</a> <span class="muted" style="font-size:12px">${escapeHtml(e.gl_name || '')}</span>` : escapeHtml(String(e.category).replace(/_/g, ' '))}</td>
        <td>${escapeHtml(e.vendor_name || '—')}${e.vendor_tin ? '' : ' <span class="muted" title="No vendor TIN">·</span>'}</td>
        <td class="num">${fmtMoney(e.amount)}</td><td class="num">${fmtMoney(e.vat_amount)}</td><td class="num">${e.wht_amount > 0 ? fmtMoney(e.wht_amount) + ' <span class="muted">(' + e.wht_rate + '%)</span>' : '—'}</td><td class="num">${fmtMoney(e.payable)}</td>
        <td>${badge(e.status)}</td><td class="row-actions">${e.status === 'pending' && !e.voucher_number && can('vouchers.edit') ? `<a href="#" data-raise-pv="${e.id}">Raise voucher</a>` : (e.voucher_number ? escapeHtml(e.voucher_number) : '')}${e.status === 'pending' && !e.voucher_number && can('expenses.edit') ? ` · <a href="#" data-void-ex="${e.id}">void</a>` : ''}</td></tr>`).join('') : '<tr><td colspan="10" class="empty-state">No bills.</td></tr>'}
      </tbody></table></div>`;
    body.querySelectorAll('[data-gl]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); viewLedger(a.dataset.gl); }));
    body.querySelectorAll('[data-raise-pv]').forEach(a => a.addEventListener('click', async (e) => {
      e.preventDefault();
      try { const r = await API.post('/api/vouchers', { linked_expense_id: Number(a.dataset.raisePv) }); toast(`Voucher ${r.pv_number} raised for ${fmtMoney(r.amount)}`); load(); } catch (x) { toast(x.message, true); }
    }));
    body.querySelectorAll('[data-void-ex]').forEach(a => a.addEventListener('click', async (e) => {
      e.preventDefault(); const reason = prompt('Reason for voiding this bill:'); if (!reason) return;
      try { await API.post(`/api/expenses/${a.dataset.voidEx}/void`, { reason }); toast('Bill voided and reversed'); load(); } catch (x) { toast(x.message, true); }
    }));
  };
  body.querySelectorAll('input,select').forEach(i => i.addEventListener('change', load));
  body.querySelector('#ex-vendor').addEventListener('input', debounce(load, 300));
  load();
}

async function loadCorporateTax(body) {
  const y = new Date().getFullYear();
  body.innerHTML = `<div class="toolbar"><label class="muted">From</label><input type="date" id="ct-from" value="${y}-01-01"><label class="muted">To</label><input type="date" id="ct-to" value="${new Date().toISOString().slice(0, 10)}">
    <label class="muted">Capital allowances (₦)</label><input type="text" id="ct-ca" value="0" style="max-width:140px;padding:7px 9px;background:var(--surface);border:1px solid var(--line);color:var(--text)"></div><div id="ct-out"></div>`;
  const draw = async () => {
    const f = body.querySelector('#ct-from').value, t = body.querySelector('#ct-to').value, ca = Number(body.querySelector('#ct-ca').value || 0);
    const r = await API.get(`/api/accounting/tax-provision?from=${f}&to=${t}&capital_allowances=${ca}`);
    body.querySelector('#ct-out').innerHTML = `
      <div class="tax-grid">
        <div class="tax-box"><div class="k">Turnover (revenue)</div><div class="v">${fmtMoney(r.turnover)}</div><div class="s">Small-company threshold ${fmtShort(r.thresholds.turnover)}</div></div>
        <div class="tax-box"><div class="k">Profit before tax</div><div class="v">${fmtMoney(r.profit_before_tax)}</div><div class="s">Assessable profit ${fmtMoney(r.assessable_profit)}</div></div>
        <div class="tax-box"><div class="k">Companies income tax (${r.cit_rate}%)</div><div class="v">${fmtMoney(r.cit)}</div><div class="s">${r.small_company ? 'Small company — exempt' : 'Medium / large company'}</div></div>
        <div class="tax-box"><div class="k">Development levy (${r.dev_levy_rate}%)</div><div class="v">${fmtMoney(r.dev_levy)}</div><div class="s">Replaces TET, NITDA, NASENI &amp; Police levies</div></div>
        <div class="tax-box"><div class="k">WHT credits available</div><div class="v">${fmtMoney(r.wht_credits_available)}</div><div class="s">Net payable after credits ${fmtMoney(r.net_payable_after_wht_credits)}</div></div>
      </div>
      <div class="table-wrap"><table><tbody>
        <tr><td>Profit before tax</td><td class="num">${fmtMoney(r.profit_before_tax)}</td></tr>
        <tr><td>Add: depreciation (disallowed — replaced by capital allowances)</td><td class="num">${fmtMoney(r.add_backs.depreciation)}</td></tr>
        <tr><td>Add: penalties &amp; fines (non-deductible)</td><td class="num">${fmtMoney(r.add_backs.penalties_non_deductible)}</td></tr>
        <tr><td>Add: ECL impairment (general provision)</td><td class="num">${fmtMoney(r.add_backs.ecl_general_provision)}</td></tr>
        <tr><td>Less: capital allowances</td><td class="num">(${fmtMoney(r.capital_allowances)})</td></tr>
        <tr class="total"><td>Assessable profit</td><td class="num">${fmtMoney(r.assessable_profit)}</td></tr>
        <tr><td>CIT at ${r.cit_rate}%</td><td class="num">${fmtMoney(r.cit)}</td></tr><tr><td>Development levy at ${r.dev_levy_rate}%</td><td class="num">${fmtMoney(r.dev_levy)}</td></tr>
        <tr class="total"><td>Total tax charge</td><td class="num">${fmtMoney(r.total_tax)}</td></tr></tbody></table></div>
      ${r.notes.map(n => `<div class="help muted">• ${escapeHtml(n)}</div>`).join('')}
      ${can('journals.approve') && r.total_tax > 0 ? `<button class="btn" id="ct-post" style="margin-top:12px">Post tax provision (Dr 801000/802000 · Cr 215000/216000)</button>` : ''}`;
    const pb = body.querySelector('#ct-post'); if (pb) pb.addEventListener('click', async () => {
      if (!confirm('Post the income tax provision for this period?')) return;
      try { const x = await API.post('/api/accounting/tax-provision/post', { from: f, to: t, capital_allowances: ca }); toast(`Posted ${x.entry_number}`); draw(); } catch (e) { toast(e.message, true); }
    });
  };
  body.querySelectorAll('input').forEach(i => i.addEventListener('change', () => draw().catch(e => toast(e.message, true))));
  await draw();
}

async function expenseForm(onSave) {
  const [cfg, accts] = await Promise.all([API.get('/api/tax/config'), can('accounts.view') ? API.get('/api/accounts') : Promise.resolve([])]);
  const glOpts = accts.filter(a => !a.is_header && a.is_active && ['expense', 'asset'].includes(a.account_type) && !a.code.startsWith('10') && !a.code.startsWith('11'));
  openModal('Vendor bill / expense', `
    <div class="grid-2">
      <div class="field"><label>Category</label><select id="x-cat">${cfg.expense_categories.map(c => `<option value="${c}">${c.replace(/_/g, ' ')}</option>`).join('')}</select></div>
      <div class="field"><label>Bill date</label><input id="x-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
    </div>
    ${glOpts.length ? `<div class="field"><label>GL account <span class="muted">(defaults from the category)</span></label><select id="x-gl"><option value="">Default for category</option>${glOpts.map(a => `<option value="${a.code}">${a.code} ${escapeHtml(a.name)}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label>Amount excluding VAT (NGN)</label><input id="x-amt" type="number" min="0" step="0.01"></div>
    <div class="grid-2">
      <div class="field"><label>Vendor name</label><input id="x-vendor"></div>
      <div class="field"><label>Vendor TIN</label><input id="x-tin" placeholder="blank = no TIN"><div class="help">No TIN → WHT rate is doubled.</div></div>
      <div class="field"><label>Vendor invoice number</label><input id="x-inv"><div class="help">Required to claim input VAT.</div></div>
      <div class="field"><label>Due date</label><input id="x-due" type="date"></div>
    </div>
    <div class="field"><label>Description</label><input id="x-desc"></div>
    <div class="grid-2">
      <div class="field"><label><input type="checkbox" id="x-vat" style="width:auto;margin-right:6px">Vendor charged VAT</label></div>
      <div class="field"><label><input type="checkbox" id="x-wht" style="width:auto;margin-right:6px">Deduct WHT from vendor on payment</label></div>
    </div>
    <div id="x-preview" class="notice" style="display:none"></div>
    <button class="btn" id="x-save">Save bill</button><div class="error-msg" id="x-err"></div>
  `, async (m) => {
    const KEY = { rent: 'wht_rate_rental', hire: 'wht_rate_rental', goods: 'wht_rate_goods', services: 'wht_rate_services' };
    const preview = () => {
      const amt = Number(m.querySelector('#x-amt').value || 0), el = m.querySelector('#x-preview');
      if (!amt) { el.style.display = 'none'; return; }
      const vat = m.querySelector('#x-vat').checked ? amt * cfg.vat_rate / 100 : 0;
      const kind = cfg.expense_wht_kind[m.querySelector('#x-cat').value];
      let rate = kind && m.querySelector('#x-wht').checked ? cfg.wht[KEY[kind]] : 0;
      if (rate && !m.querySelector('#x-tin').value.trim()) rate = Math.min(20, rate * cfg.no_tin_multiplier);
      const wht = amt * rate / 100;
      el.style.display = 'block';
      el.innerHTML = `GL ${escapeHtml(m.querySelector('#x-gl')?.value || cfg.expense_gl[m.querySelector('#x-cat').value])} · VAT ${fmtMoney(vat)} · WHT ${rate}% = ${fmtMoney(wht)}${kind ? '' : ' <span class="muted">(WHT not applicable to this category)</span>'} · <strong>Cash to vendor ${fmtMoney(amt + vat - wht)}</strong>`;
    };
    m.querySelectorAll('input,select').forEach(i => i.addEventListener('input', preview));
    m.querySelector('#x-save').addEventListener('click', async () => {
      try {
        await API.post('/api/expenses', { category: m.querySelector('#x-cat').value, expense_date: m.querySelector('#x-date').value, amount: Number(m.querySelector('#x-amt').value), gl_code: m.querySelector('#x-gl')?.value || undefined,
          vendor_name: m.querySelector('#x-vendor').value, vendor_tin: m.querySelector('#x-tin').value, vendor_invoice_no: m.querySelector('#x-inv').value, description: m.querySelector('#x-desc').value, due_date: m.querySelector('#x-due').value || null,
          vat_applies: m.querySelector('#x-vat').checked, wht_apply: m.querySelector('#x-wht').checked });
        m.remove(); toast('Bill recorded and posted'); onSave();
      } catch (e) { m.querySelector('#x-err').textContent = e.message; }
    });
  });
}

/* ===================== VOUCHERS (maker-checker) ===================== */
async function renderVouchers(main, params = {}) {
  main.innerHTML = `<div class="page-header"><h2>Payment Vouchers</h2>${can('vouchers.edit') ? '<button class="btn" id="add-pv-btn">+ Raise voucher</button>' : ''}</div>
    <p class="muted" style="margin-top:-6px">Two-level approval (maker-checker). The person who raises a voucher cannot approve it, and nobody can approve both levels. Final approval pays the voucher and posts it to the ledger.</p>
    <div class="toolbar"><select id="pv-st"><option value="">All</option>${['pending', 'paid', 'rejected'].map(x => `<option ${params.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select><span class="muted" id="pv-sum"></span>
      <span style="margin-left:auto">${exportLinks('/api/report-builder/export?d=' + btoa(JSON.stringify({ source: 'vouchers', columns: ['pv', 'date', 'payee', 'purpose', 'amount', 'status', 'level', 'raised_by', 'bill'] })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'))}</span></div>
    <div class="table-wrap"><table><thead><tr><th>PV #</th><th>Payee</th><th>Purpose</th><th class="num">Amount</th><th>Raised by</th><th>Status</th><th>Approvals</th><th></th></tr></thead>
    <tbody id="pv-tbody"><tr><td colspan="8" class="empty-state">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    const st = document.getElementById('pv-st').value;
    const rows = await API.get('/api/vouchers' + (st ? '?status=' + st : ''));
    document.getElementById('pv-sum').textContent = `${rows.length} voucher(s) · ${fmtMoney(rows.reduce((a, v) => a + v.amount, 0))}`;
    document.getElementById('pv-tbody').innerHTML = rows.length ? rows.map(v => {
      const mine = CURRENT_USER && v.raised_by === CURRENT_USER.id;
      const levelOk = (v.level_roles || []).includes(CURRENT_USER.role);
      return `<tr><td>${escapeHtml(v.pv_number)}</td><td>${escapeHtml(v.payee_name)}</td><td>${escapeHtml(v.purpose)}${v.expense_number ? ` <a href="#" data-exp="${v.linked_expense_id}" class="muted">(${escapeHtml(v.expense_number)})</a>` : ''}</td><td class="num">${fmtMoney(v.amount)}</td>
      <td>${escapeHtml(v.raised_by_name || '')}</td><td>${badge(v.status)}${v.status === 'pending' ? ` <span class="muted">level ${v.current_level}/2 · ${escapeHtml((v.level_roles || []).join(' / '))}</span>` : ''}</td>
      <td class="muted" style="font-size:12px">${escapeHtml((v.approvals || '').replace(/:/g, ' · '))}</td>
      <td class="row-actions">${v.status === 'pending' && can('vouchers.approve') && !mine && levelOk ? `<a href="#" data-approve="${v.id}" data-level="${v.current_level}">Approve${v.current_level === 2 ? ' &amp; pay' : ''}</a> · <a href="#" data-reject="${v.id}">Reject</a>` : (v.status === 'pending' && mine ? '<span class="muted">awaiting others</span>' : '')}</td></tr>`; }).join('')
      : '<tr><td colspan="8" class="empty-state">No vouchers.</td></tr>';
    const act = async (id, decision, level) => {
      let comment = '', payment_date;
      if (decision === 'rejected') { comment = prompt('Reason for rejection:'); if (!comment) return; }
      if (decision === 'approved' && level === '2') { payment_date = prompt('Payment date (YYYY-MM-DD):', new Date().toISOString().slice(0, 10)); if (!payment_date) return; }
      try { await API.post(`/api/vouchers/${id}/decide`, { decision, comment, payment_date }); toast(decision === 'approved' && level === '2' ? 'Approved, paid and posted' : 'Recorded'); load(); } catch (e) { toast(e.message, true); }
    };
    document.querySelectorAll('[data-approve]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); act(a.dataset.approve, 'approved', a.dataset.level); }));
    document.querySelectorAll('[data-reject]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); act(a.dataset.reject, 'rejected'); }));
    document.querySelectorAll('[data-exp]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); go('#/finance', { tab: 'expenses', open: a.dataset.exp }); }));
  }
  document.getElementById('pv-st').addEventListener('change', load);
  if (can('vouchers.edit')) document.getElementById('add-pv-btn').addEventListener('click', () => voucherForm(load));
  load();
}

async function voucherForm(onSave) {
  const [exps, cash, accts] = await Promise.all([API.get('/api/expenses?status=unpaid'), API.get('/api/cash-accounts'), can('accounts.view') ? API.get('/api/accounts') : Promise.resolve([])]);
  const open = exps.filter(e => !e.voucher_number);
  openModal('Raise payment voucher', `
    <div class="field"><label>Pay a vendor bill (recommended — amount, VAT and WHT come from the bill)</label>
      <select id="pv-exp"><option value="">— Ad-hoc payment (no bill) —</option>${open.map(e => `<option value="${e.id}">${escapeHtml(e.expense_number)} · ${escapeHtml(e.vendor_name || e.category)} · pay ${fmtMoney(e.payable)}</option>`).join('')}</select></div>
    <div id="pv-adhoc">
      <div class="field"><label>Payee</label><input id="pv-payee"></div>
      <div class="field"><label>Purpose</label><input id="pv-purpose"></div>
      <div class="grid-2"><div class="field"><label>Amount (NGN)</label><input id="pv-amt" type="number" min="0" step="0.01"></div>
      <div class="field"><label>Charge to GL</label><select id="pv-gl">${accts.filter(a => !a.is_header && a.is_active && a.allow_manual && !a.code.startsWith('10')).map(a => `<option value="${a.code}" ${a.code === '699000' ? 'selected' : ''}>${a.code} ${escapeHtml(a.name)}</option>`).join('') || '<option value="">Other operating expenses</option>'}</select></div></div>
    </div>
    <div class="field"><label>Pay from</label><select id="pv-from">${cash.map(a => `<option value="${a.code}" ${a.code === '102000' ? 'selected' : ''}>${a.code} ${escapeHtml(a.name)}</option>`).join('')}</select></div>
    <button class="btn" id="pv-save">Raise voucher</button><div class="error-msg" id="pv-err"></div>
  `, (m) => {
    const sel = m.querySelector('#pv-exp'); sel.addEventListener('change', () => { m.querySelector('#pv-adhoc').style.display = sel.value ? 'none' : 'block'; });
    m.querySelector('#pv-save').addEventListener('click', async () => {
      try {
        const body = sel.value ? { linked_expense_id: Number(sel.value), pay_from: m.querySelector('#pv-from').value } : { payee_name: m.querySelector('#pv-payee').value, purpose: m.querySelector('#pv-purpose').value, amount: Number(m.querySelector('#pv-amt').value), gl_code: m.querySelector('#pv-gl').value || undefined, pay_from: m.querySelector('#pv-from').value };
        const r = await API.post('/api/vouchers', body); m.remove(); toast(`Voucher ${r.pv_number} raised`); onSave();
      } catch (e) { m.querySelector('#pv-err').textContent = e.message; }
    });
  });
}

/* ===================== MAINTENANCE ===================== */
async function renderMaintenance(main) {
  main.innerHTML = `
    <div class="page-header"><h2>Maintenance</h2>
      ${can('maintenance.edit') ? '<button class="btn" id="add-wo-btn">+ New work order</button>' : ''}</div>
    <div class="card"><h3>Work orders</h3><div class="table-wrap"><table><thead><tr>
      <th>WO #</th><th>Equipment</th><th>Type</th><th>Priority</th><th>Status</th><th></th>
    </tr></thead><tbody id="wo-tbody"><tr><td colspan="6" class="empty-state">Loading…</td></tr></tbody></table></div></div>
    <div class="card"><h3>Due for scheduled maintenance</h3><div id="due-body">Loading…</div></div>`;

  async function load() {
    const rows = await API.get('/api/maintenance/work-orders');
    document.getElementById('wo-tbody').innerHTML = rows.length ? rows.map(w => `
      <tr><td>${escapeHtml(w.wo_number)}</td><td>${escapeHtml(w.asset_code)} ${escapeHtml(w.equipment_name)}</td>
        <td>${escapeHtml(w.wo_type)}</td><td>${escapeHtml(w.priority)}</td><td>${badge(w.status)}</td>
        <td>${w.status !== 'completed' && can('maintenance.edit') ? `<button class="btn small" data-complete="${w.id}">Complete</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="6" class="empty-state">No work orders yet.</td></tr>';
    document.querySelectorAll('[data-complete]').forEach(b => b.addEventListener('click', () => completeWorkOrder(b.dataset.complete, load)));
  }
  const due = await API.get('/api/maintenance/due');
  document.getElementById('due-body').innerHTML = due.length
    ? due.map(d => `<div>${escapeHtml(d.asset_code)} ${escapeHtml(d.equipment_name)} — due ${fmtDate(d.next_due_date)}</div>`).join('')
    : '<p class="muted">Nothing due in the next 7 days.</p>';

  if (can('maintenance.edit')) document.getElementById('add-wo-btn').addEventListener('click', () => workOrderForm(load));
  load();
}

async function workOrderForm(onSave, preselect) {
  const equipment = await API.get('/api/equipment');
  openModal('New work order', `
    <div class="field"><label>Equipment</label><select id="f-woequip">${equipment.map(e => `<option value="${e.id}" ${String(preselect) === String(e.id) ? 'selected' : ''}>${e.asset_code} — ${escapeHtml(e.name)}</option>`).join('')}</select></div>
    <div class="grid-2">
      <div class="field"><label>Type</label><select id="f-wotype"><option value="corrective">Corrective</option><option value="preventive">Preventive</option><option value="inspection">Inspection</option></select></div>
      <div class="field"><label>Priority</label><select id="f-wopriority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
    </div>
    <div class="field"><label>Description</label><textarea id="f-wodesc" rows="2"></textarea></div>
    <button class="btn" id="save-wo-btn">Create work order</button>
    <div class="error-msg" id="wo-form-error"></div>
  `, (overlay) => {
    overlay.querySelector('#save-wo-btn').addEventListener('click', async () => {
      try {
        await API.post('/api/maintenance/work-orders', {
          equipment_id: Number(overlay.querySelector('#f-woequip').value),
          wo_type: overlay.querySelector('#f-wotype').value,
          priority: overlay.querySelector('#f-wopriority').value,
          description: overlay.querySelector('#f-wodesc').value,
        });
        overlay.remove(); toast('Work order created'); onSave();
      } catch (e) { overlay.querySelector('#wo-form-error').textContent = e.message; }
    });
  });
}

function completeWorkOrder(id, reload) {
  openModal('Complete work order', `
    <p class="muted">Parts already issued are expensed from stock (Dr 503000 / Cr 121000). Outside labour becomes a vendor bill to pay through a voucher.</p>
    <div class="grid-2"><div class="field"><label>Labour cost (excl. VAT)</label><input id="wc-l" type="number" min="0" value="0"></div><div class="field"><label>Technician / vendor</label><input id="wc-v" placeholder="e.g. Lekki Camera Clinic"></div>
    <div class="field"><label>Vendor invoice no.</label><input id="wc-i"></div><div class="field"><label>Vendor TIN</label><input id="wc-t"></div></div>
    <div class="grid-2"><div class="field"><label><input type="checkbox" id="wc-vat" style="width:auto;margin-right:6px">Vendor charged VAT</label></div><div class="field"><label><input type="checkbox" id="wc-wht" checked style="width:auto;margin-right:6px">Deduct WHT (services)</label></div></div>
    <button class="btn" id="wc-go">Complete</button><div class="error-msg" id="wc-err"></div>`, (m) => {
    m.querySelector('#wc-go').addEventListener('click', async () => {
      try { const r = await API.put(`/api/maintenance/work-orders/${id}/complete`, { labor_cost: Number(m.querySelector('#wc-l').value || 0), vendor_name: m.querySelector('#wc-v').value, vendor_invoice_no: m.querySelector('#wc-i').value, vendor_tin: m.querySelector('#wc-t').value, vat_applies: m.querySelector('#wc-vat').checked, wht_apply: m.querySelector('#wc-wht').checked });
        m.remove(); toast(`Work order completed${r.bill ? ' · bill ' + r.bill.expense_number + ' raised' : ''} — unit back to available`); reload(); }
      catch (e) { m.querySelector('#wc-err').textContent = e.message; }
    });
  });
}

/* ===================== KITS ===================== */
async function renderKits(main) {
  main.innerHTML = `
    <div class="page-header"><h2>Kits</h2>
      ${can('kits.edit') ? '<button class="btn" id="add-kit-btn">+ Create kit</button>' : ''}</div>
    <p class="muted" style="margin-bottom:16px">Bundle equipment into a package that books as one unit — a kit is only available when every item inside it is free for the dates requested.</p>
    <div class="table-wrap"><table><thead><tr>
      <th>Code</th><th>Name</th><th>Items</th><th>Daily rate</th><th>Status</th><th></th>
    </tr></thead><tbody id="kit-tbody"><tr><td colspan="6" class="empty-state">Loading…</td></tr></tbody></table></div>`;

  async function load() {
    const rows = await API.get('/api/kits');
    document.getElementById('kit-tbody').innerHTML = rows.length ? rows.map(k => `
      <tr>
        <td>${escapeHtml(k.kit_code)}</td><td>${escapeHtml(k.name)}</td><td>${k.item_count} item(s)</td>
        <td>${fmtMoney(k.daily_rate)}</td><td>${badge(k.status === 'active' ? 'available' : 'retired')}</td>
        <td><a href="#" data-view-kit="${k.id}">View</a></td>
      </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No kits yet. Bundle your most-requested equipment combinations to speed up booking.</td></tr>`;
    document.querySelectorAll('[data-view-kit]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); viewKit(a.dataset.viewKit); }));
  }
  if (can('kits.edit')) document.getElementById('add-kit-btn').addEventListener('click', () => kitForm(load));
  load();
}

async function kitForm(onSave) {
  const equipment = await API.get('/api/equipment');
  openModal('Create kit', `
    <div class="field"><label>Kit name</label><input id="k-name" placeholder="e.g. Documentary Kit"></div>
    <div class="field"><label>Description</label><textarea id="k-desc" rows="2"></textarea></div>
    <div class="grid-2">
      <div class="field"><label>Package daily rate (NGN)</label><input id="k-daily" type="number"></div>
      <div class="field"><label>Package weekly rate (NGN)</label><input id="k-weekly" type="number"></div>
    </div>
    <div class="field"><label>Equipment in this kit</label>
      <select id="k-items" multiple size="8">${equipment.map(e => `<option value="${e.id}">${e.asset_code} — ${escapeHtml(e.name)} (${fmtMoney(e.daily_rate)}/day)</option>`).join('')}</select>
      <div class="muted" style="margin-top:4px">Ctrl/Cmd-click to select multiple items.</div>
    </div>
    <button class="btn" id="save-kit-btn">Create kit</button>
    <div class="error-msg" id="kit-form-error"></div>
  `, (overlay) => {
    overlay.querySelector('#save-kit-btn').addEventListener('click', async () => {
      const ids = Array.from(overlay.querySelector('#k-items').selectedOptions).map(o => Number(o.value));
      if (!ids.length) return overlay.querySelector('#kit-form-error').textContent = 'Select at least one item.';
      try {
        await API.post('/api/kits', {
          name: overlay.querySelector('#k-name').value,
          description: overlay.querySelector('#k-desc').value,
          daily_rate: Number(overlay.querySelector('#k-daily').value || 0),
          weekly_rate: Number(overlay.querySelector('#k-weekly').value || 0),
          equipment_ids: ids,
        });
        overlay.remove(); toast('Kit created'); onSave();
      } catch (e) { overlay.querySelector('#kit-form-error').textContent = e.message; }
    });
  });
}

async function viewKit(id) {
  const kit = await API.get('/api/kits/' + id);
  openModal(`${kit.kit_code} — ${escapeHtml(kit.name)}`, `
    <p class="muted">${escapeHtml(kit.description || '')}</p>
    <p>Daily ${fmtMoney(kit.daily_rate)} · Weekly ${fmtMoney(kit.weekly_rate)} · ${badge(kit.status === 'active' ? 'available' : 'retired')}</p>
    <div class="section-divider"></div>
    <h3 style="border:none;padding:0;margin-bottom:8px">Items in this kit</h3>
    <table><tbody>${kit.items.map(i => `<tr><td>${escapeHtml(i.asset_code)}</td><td>${escapeHtml(i.name)}</td><td>${badge(i.status)}</td></tr>`).join('')}</tbody></table>
  `);
}

/* ===================== CONSUMABLES ===================== */
async function renderConsumables(main, params = {}) {
  main.innerHTML = `
    <div class="page-header"><h2>Consumables</h2>
      ${can('consumables.edit') ? '<button class="btn" id="add-cons-btn">+ Add consumable</button>' : ''}</div>
    <p class="muted" style="margin-bottom:16px">Media cards, batteries, cables, gaffer tape — items issued with a booking and billed as used rather than checked back in.</p>
    <div class="table-wrap"><table><thead><tr>
      <th>Code</th><th>Name</th><th>In stock</th><th class="num">Unit cost</th><th class="num">Sale price</th><th></th>
    </tr></thead><tbody id="cons-tbody"><tr><td colspan="5" class="empty-state">Loading…</td></tr></tbody></table></div>`;

  async function load() {
    let rows = await API.get('/api/consumables');
    if (params.low) rows = rows.filter(c => c.reorder_level > 0 && c.quantity_on_hand <= c.reorder_level);
    document.getElementById('cons-tbody').innerHTML = rows.length ? rows.map(c => `
      <tr>
        <td>${escapeHtml(c.item_code)}</td><td>${escapeHtml(c.name)}</td>
        <td>${c.quantity_on_hand <= c.reorder_level && c.reorder_level > 0 ? badge('overdue') : ''} ${c.quantity_on_hand}</td>
        <td class="num">${fmtMoney(c.unit_cost)}</td><td class="num">${fmtMoney(c.sale_price)}</td>
        <td>${can('consumables.edit') ? `<button class="btn small secondary" data-restock="${c.id}">Restock</button>` : ''}</td>
      </tr>`).join('') : `<tr><td colspan="6" class="empty-state">${params.low ? 'Nothing at or below its reorder level.' : 'No consumables in the catalog yet.'}</td></tr>`;
    document.querySelectorAll('[data-restock]').forEach(btn => btn.addEventListener('click', () => {
      const item = rows.find(r => String(r.id) === btn.dataset.restock);
      openModal(`Restock ${escapeHtml(item.name)}`, `<div class="grid-2"><div class="field"><label>Quantity</label><input id="rs-q" type="number" min="1" value="10"></div><div class="field"><label>Unit cost (excl. VAT)</label><input id="rs-c" type="number" min="0" value="${item.unit_cost}"></div>
        <div class="field"><label>Supplier</label><input id="rs-v"></div><div class="field"><label>Supplier invoice no.</label><input id="rs-i"></div></div>
        <div class="field"><label><input type="checkbox" id="rs-vat" style="width:auto;margin-right:6px">Supplier charged VAT</label></div>
        <p class="muted" style="font-size:12px">Records a supplier bill to inventory (Dr 122000 / Cr 201000); cost is re-averaged. Issues to bookings are then costed to 501000.</p>
        <button class="btn" id="rs-go">Restock</button><div class="error-msg" id="rs-err"></div>`, (m) => {
        m.querySelector('#rs-go').addEventListener('click', async () => {
          try { const r = await API.put(`/api/consumables/${item.id}/restock`, { qty: Number(m.querySelector('#rs-q').value), unit_cost: Number(m.querySelector('#rs-c').value), vendor_name: m.querySelector('#rs-v').value, vendor_invoice_no: m.querySelector('#rs-i').value, vat_applies: m.querySelector('#rs-vat').checked });
            m.remove(); toast(`Restocked${r.bill ? ' · bill ' + r.bill.expense_number : ''}`); load(); } catch (e) { m.querySelector('#rs-err').textContent = e.message; }
        });
      });
    }));
  }
  if (can('consumables.edit')) document.getElementById('add-cons-btn').addEventListener('click', () => consumableForm(load));
  load();
}

function consumableForm(onSave) {
  openModal('Add consumable', `
    <div class="field"><label>Item code</label><input id="c-code" placeholder="e.g. SD-128"></div>
    <div class="field"><label>Name</label><input id="c-name" placeholder="e.g. 128GB CFExpress Card"></div>
    <div class="grid-2">
      <div class="field"><label>Unit cost (NGN)</label><input id="c-cost" type="number" value="0"></div>
      <div class="field"><label>Sale price (NGN)</label><input id="c-price" type="number" value="0"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Starting stock</label><input id="c-stock" type="number" value="0"></div>
      <div class="field"><label>Reorder level</label><input id="c-reorder" type="number" value="0"></div>
    </div>
    <button class="btn" id="save-cons-btn">Save consumable</button>
    <div class="error-msg" id="cons-form-error"></div>
  `, (overlay) => {
    overlay.querySelector('#save-cons-btn').addEventListener('click', async () => {
      try {
        await API.post('/api/consumables', {
          item_code: overlay.querySelector('#c-code').value,
          name: overlay.querySelector('#c-name').value,
          unit_cost: Number(overlay.querySelector('#c-cost').value || 0),
          sale_price: Number(overlay.querySelector('#c-price').value || 0),
          quantity_on_hand: Number(overlay.querySelector('#c-stock').value || 0),
          reorder_level: Number(overlay.querySelector('#c-reorder').value || 0),
        });
        overlay.remove(); toast('Consumable added'); onSave();
      } catch (e) { overlay.querySelector('#cons-form-error').textContent = e.message; }
    });
  });
}

/* ===================== ADMIN ===================== */
async function renderAdmin(main, params = {}) {
  // Users with only audit rights (Managing Director, Auditor) see just the audit log.
  const TABS = (can('admin.users') ? [['users', 'Users'], ['roles', 'Roles & permissions'], ['locations', 'Locations'], ['crew', 'Crew rate card'], ['settings', 'Settings'], ['nrs', 'NRS e-invoicing'], ['system', 'System & backups']] : []).concat(can('admin.audit') ? [['audit', 'Audit log']] : []);
  const tab = TABS.some(t => t[0] === params.tab) ? params.tab : (TABS[0] || ['audit'])[0];
  main.innerHTML = `<div class="page-header"><h2>Administration</h2></div>
    <div class="tabs" id="adm-tabs">${TABS.map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="adm-body"></div>`;
  document.querySelectorAll('#adm-tabs .tab').forEach(t => t.addEventListener('click', () => go('#/admin', { tab: t.dataset.tab })));
  const body = document.getElementById('adm-body');
  if (tab === 'users') return adminUsers(body);
  if (tab === 'roles') return adminRoles(body);
  if (tab === 'locations') return adminLocations(body);
  if (tab === 'crew') return adminCrew(body);
  if (tab === 'audit') {
    const audit = await API.get('/api/admin/audit-log?limit=300');
    body.innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>${audit.map(a => `<tr><td>${escapeHtml(a.created_at)}</td><td>${escapeHtml(a.user_name || 'system')}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.entity_type || '—')}${a.entity_id ? ' #' + a.entity_id : ''}</td><td class="muted" style="font-size:11px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(a.details || '')}">${escapeHtml(a.details || '')}</td></tr>`).join('')}</tbody></table></div>`;
    return;
  }
  if (tab === 'system') {
    body.innerHTML = `<div class="card"><h3>System health</h3><div id="health-body">Loading…</div></div>
      <div class="card"><h3>Portal maintenance</h3><div id="maint-body">Loading…</div></div>
      <div class="card"><h3>Backups <button class="btn small" id="run-backup-btn" style="float:right">Back up now</button></h3><div id="backup-body">Loading…</div></div>`;
    loadHealthCard(); loadMaintenanceCard(); loadBackupCard();
    document.getElementById('run-backup-btn').addEventListener('click', async () => {
      const label = prompt('Optional label for this backup:', 'manual'); if (label === null) return;
      try { await API.post('/api/system/backups', { label }); toast('Backup created'); loadBackupCard(); loadHealthCard(); } catch (e) { toast(e.message, true); }
    });
    return;
  }
  body.innerHTML = `<div class="card"><div id="settings-body">Loading…</div></div>`;
  renderSettingsPanel(await API.get('/api/admin/settings'), tab === 'nrs' ? 'nrs' : null);
}

async function adminUsers(body) {
  const [users, roles] = await Promise.all([API.get('/api/admin/users'), API.get('/api/admin/roles')]);
  body.innerHTML = `<div class="toolbar"><button class="btn small" id="add-user-btn">+ Add user</button><span class="muted">${users.length} users · ${users.filter(u => u.status === 'active').length} active</span></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Title</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr><td>${escapeHtml(u.full_name)}</td><td class="muted">${escapeHtml(u.title || '')}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.role_name)}</td>
      <td>${badge(u.status)}${u.must_change_password ? ' <span class="muted" style="font-size:11px">must change pw</span>' : ''}</td><td>${u.last_login_at ? fmtDate(u.last_login_at) : 'Never'}</td>
      <td class="row-actions">${u.id !== CURRENT_USER.id ? `<a href="#" data-user-edit="${u.id}">Edit</a> · <a href="#" data-user-toggle="${u.id}" data-status="${u.status}">${u.status === 'active' ? 'Suspend' : 'Re-activate'}</a> · <a href="#" data-user-reset="${u.id}">Reset password</a>` : '<span class="muted">you</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  const reload = () => adminUsers(body);
  body.querySelector('#add-user-btn').addEventListener('click', () => userForm(roles, reload));
  body.querySelectorAll('[data-user-edit]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); userForm(roles, reload, users.find(u => String(u.id) === a.dataset.userEdit)); }));
  body.querySelectorAll('[data-user-toggle]').forEach(a => a.addEventListener('click', async (e) => {
    e.preventDefault(); const to = a.dataset.status === 'active' ? 'suspended' : 'active';
    if (!confirm(to === 'suspended' ? 'Suspend this user? They are signed out immediately.' : 'Re-activate this user?')) return;
    try { await API.put('/api/admin/users/' + a.dataset.userToggle, { status: to }); toast('User ' + to); reload(); } catch (x) { toast(x.message, true); }
  }));
  body.querySelectorAll('[data-user-reset]').forEach(a => a.addEventListener('click', async (e) => {
    e.preventDefault(); const pw = prompt('New temporary password (10+ chars, upper, lower, number). The user must change it at next login:'); if (!pw) return;
    try { await API.put('/api/admin/users/' + a.dataset.userReset, { reset_password: pw }); toast('Password reset; user signed out everywhere'); } catch (x) { toast(x.message, true); }
  }));
}

async function adminRoles(body) {
  const [roles, perms] = await Promise.all([API.get('/api/admin/roles'), API.get('/api/admin/permissions')]);
  body.innerHTML = `<div class="toolbar"><button class="btn small" id="add-role">+ Custom role</button><span class="muted">Built-in roles follow segregation of duties: makers (Accountant) cannot approve; Finance Manager approves level 1, Managing Director level 2.</span></div>
    <div class="table-wrap"><table><thead><tr><th>Role</th><th>Description</th><th class="num">Users</th><th>Permissions</th><th></th></tr></thead><tbody>
    ${roles.map(r => `<tr><td><strong>${escapeHtml(r.name)}</strong>${r.is_system ? ' <span class="muted" style="font-size:11px">built-in</span>' : ''}</td><td class="muted" style="font-size:12px">${escapeHtml(r.description || '')}</td><td class="num">${r.users}</td>
      <td style="font-size:11px;max-width:380px">${r.permissions.map(p => `<code>${escapeHtml(p)}</code>`).join(' ')}</td><td>${r.name !== 'Admin' ? `<a href="#" data-role="${r.id}">Edit</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  const editor = (role) => {
    const has = new Set(role ? role.permissions : []);
    openModal(role ? `Role — ${escapeHtml(role.name)}` : 'New role', `
      ${role ? '' : '<div class="field"><label>Name</label><input id="r-name"></div>'}
      <div class="field"><label>Description</label><input id="r-desc" value="${escapeHtml(role ? role.description || '' : '')}"></div>
      <div class="field"><label><input type="checkbox" id="r-allview" ${has.has('*.view') ? 'checked' : ''} style="width:auto;margin-right:6px">Read-only access to everything (*.view)</label></div>
      <div class="perm-grid">${Object.entries(perms).map(([mod, acts]) => `<strong>${mod}</strong>${['*', ...acts].slice(0, 4).map(a => `<label><input type="checkbox" data-p="${mod}.${a}" ${has.has(`${mod}.${a}`) ? 'checked' : ''}>${a === '*' ? 'all' : a}</label>`).join('')}${'<span></span>'.repeat(Math.max(0, 4 - Math.min(4, acts.length + 1)))}`).join('')}</div>
      <button class="btn" id="r-save" style="margin-top:12px">Save role</button><div class="error-msg" id="r-err"></div>`, (m) => {
      m.querySelector('.modal').classList.add('wide');
      m.querySelector('#r-save').addEventListener('click', async () => {
        const list = Array.from(m.querySelectorAll('[data-p]:checked')).map(c => c.dataset.p); if (m.querySelector('#r-allview').checked) list.push('*.view');
        try { if (role) await API.put('/api/admin/roles/' + role.id, { description: m.querySelector('#r-desc').value, permissions: list }); else await API.post('/api/admin/roles', { name: m.querySelector('#r-name').value, description: m.querySelector('#r-desc').value, permissions: list });
          m.remove(); toast('Role saved'); adminRoles(body); } catch (e) { m.querySelector('#r-err').textContent = e.message; }
      });
    });
  };
  body.querySelector('#add-role').addEventListener('click', () => editor(null));
  body.querySelectorAll('[data-role]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); editor(roles.find(r => String(r.id) === a.dataset.role)); }));
}

async function adminLocations(body) {
  const locs = await API.get('/api/locations');
  body.innerHTML = `<div class="toolbar"><button class="btn small" id="add-loc">+ Location</button></div>
    <div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Address</th><th class="num">Units</th><th class="num">Available</th><th></th></tr></thead><tbody>
    ${locs.map(l => `<tr><td>${escapeHtml(l.code)}${l.is_default ? ' <span class="badge available">default</span>' : ''}</td><td>${escapeHtml(l.name)}</td><td class="muted">${escapeHtml(l.address || '')}</td><td class="num"><a href="#" data-eq="${l.id}">${l.units}</a></td><td class="num">${l.available}</td>
      <td class="row-actions">${!l.is_default ? `<a href="#" data-def="${l.id}">Make default</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  body.querySelector('#add-loc').addEventListener('click', () => openModal('New location', `<div class="grid-2"><div class="field"><label>Code</label><input id="l-c" placeholder="LEK"></div><div class="field"><label>Name</label><input id="l-n" placeholder="Lekki store"></div></div><div class="field"><label>Address</label><input id="l-a"></div><button class="btn" id="l-go">Save</button><div class="error-msg" id="l-err"></div>`, (m) => {
    m.querySelector('#l-go').addEventListener('click', async () => { try { await API.post('/api/locations', { code: m.querySelector('#l-c').value, name: m.querySelector('#l-n').value, address: m.querySelector('#l-a').value }); m.remove(); adminLocations(body); } catch (e) { m.querySelector('#l-err').textContent = e.message; } });
  }));
  body.querySelectorAll('[data-def]').forEach(a => a.addEventListener('click', async (e) => { e.preventDefault(); await API.put('/api/locations/' + a.dataset.def, { is_default: true }); adminLocations(body); }));
  body.querySelectorAll('[data-eq]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); go('#/equipment', { location_id: a.dataset.eq }); }));
}

async function adminCrew(body) {
  const rates = await API.get('/api/crew-rates');
  body.innerHTML = `<div class="toolbar"><button class="btn small" id="add-crew">+ Role</button><span class="muted">Used when adding crew / operators to a booking. Blank rate = rate on request.</span></div>
    <div class="table-wrap"><table><thead><tr><th>Role</th><th class="num">Day rate</th><th>Notes</th><th></th></tr></thead><tbody>
    ${rates.map(r => `<tr${r.active ? '' : ' style="opacity:.5"'}><td>${escapeHtml(r.role)}</td><td class="num">${r.rate_on_request ? '<span class="muted">on request</span>' : fmtMoney(r.day_rate)}</td><td class="muted">${escapeHtml(r.notes || '')}</td><td><a href="#" data-rate="${r.id}">Edit rate</a></td></tr>`).join('')}</tbody></table></div>`;
  body.querySelector('#add-crew').addEventListener('click', async () => { const role = prompt('Role name:'); if (!role) return; const rate = prompt('Day rate (0 = on request):', '0'); try { await API.post('/api/crew-rates', { role, day_rate: Number(rate || 0) }); adminCrew(body); } catch (e) { toast(e.message, true); } });
  body.querySelectorAll('[data-rate]').forEach(a => a.addEventListener('click', async (e) => { e.preventDefault(); const r = rates.find(x => String(x.id) === a.dataset.rate); const v = prompt(`Day rate for ${r.role} (0 = on request):`, r.day_rate); if (v === null) return; try { await API.put('/api/crew-rates/' + r.id, { day_rate: Number(v) }); adminCrew(body); } catch (x) { toast(x.message, true); } }));
}

/* ===================== WHITE-LABEL SETTINGS PANEL ===================== */
function renderSettingsPanel(settings, initialTab) {
  const body = document.getElementById('settings-body');
  const editable = can('admin.settings');
  const v = (k) => escapeHtml(settings[k] == null ? '' : settings[k]);
  const f = (k, label, opts = {}) => `<div class="field"><label>${label}</label>${opts.textarea
    ? `<textarea data-key="${k}" rows="${opts.rows || 3}">${v(k)}</textarea>`
    : `<input data-key="${k}" type="${opts.type || 'text'}" value="${v(k)}" placeholder="${escapeHtml(opts.placeholder || '')}">`}${opts.help ? `<div class="help">${opts.help}</div>` : ''}</div>`;

  const tabs = {
    branding: `
      <div class="grid-2">
        <div>
          <div class="field"><label>Logo</label>
            <div class="logo-preview" id="logo-preview">${BRAND.logo_url ? `<img src="${BRAND.logo_url}" alt="Logo">` : '<span class="muted">No logo uploaded</span>'}</div>
            ${editable ? `<div class="btn-row">
              <label class="btn small" style="margin:0">Upload logo<input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden></label>
              ${BRAND.logo_url ? '<button class="btn small secondary" id="logo-remove">Remove</button>' : ''}
            </div>` : ''}
            <div class="help">PNG, JPG, WEBP or SVG, up to 2 MB. A transparent PNG around 400×120 px works best. Used on the login page, sidebar, browser tab, printed invoices and emails.</div>
          </div>
        </div>
        <div>
          ${f('portal_name', 'Portal name', { help: 'Shown on the login page, sidebar and browser tab.' })}
          ${f('portal_tagline', 'Tagline')}
          ${f('company_name', 'Company name (client business)')}
          <div class="field"><label>Brand colour</label>
            <div class="color-row"><input type="color" id="brand-color-pick" value="${v('brand_primary_color') || '#E8630A'}"><input data-key="brand_primary_color" id="brand-color-hex" value="${v('brand_primary_color')}" placeholder="#E8630A"></div>
            <div class="swatches" id="brand-swatches">${['#E8630A', '#0A7E8C', '#1565C0', '#2E7D32', '#6A1B9A', '#C62828', '#F9A825', '#37474F'].map(c => `<button type="button" data-sw="${c}" style="background:${c}" title="${c}" aria-label="Use ${c}"></button>`).join('')}</div>
            <div class="help">Buttons, highlights, invoice header and table accents. Text colour is chosen automatically so it stays readable.</div></div>
          <div class="field"><label>Sidebar / dark surface colour <span class="muted">(optional)</span></label>
            <div class="color-row"><input type="color" id="brand-sec-pick" value="${v('brand_secondary_color') || '#1B1E23'}"><input data-key="brand_secondary_color" id="brand-sec-hex" value="${v('brand_secondary_color')}" placeholder="blank = default charcoal"></div></div>
          <div class="brand-preview" id="brand-preview"></div>
          <div id="brand-contrast" class="help"></div>
          ${editable ? '<button type="button" class="btn small secondary" id="brand-reset" style="margin-top:8px">Reset colours to default</button>' : ''}
        </div>
      </div>
      <div class="grid-2">
        ${f('login_hint', 'Login page note', { help: 'Leave blank to hide. Clear this before going live so default credentials are not shown.' })}
        <div class="field"><label>"Powered by Olans FIXZIT Concept" footer</label>
          <select data-key="show_powered_by"><option value="1" ${settings.show_powered_by !== '0' ? 'selected' : ''}>Show</option><option value="0" ${settings.show_powered_by === '0' ? 'selected' : ''}>Hide</option></select></div>
      </div>`,
    tax: `
      <div class="notice">Rates reflect the Nigeria Tax Act 2025 (in force 1 Jan 2026) and the 2024 Withholding Tax Regulations. They are editable so a rate change needs no code change — confirm with your tax adviser.</div>
      <div class="grid-2">
        <div>
          <div class="field"><label>Charge VAT on invoices?</label><select data-key="vat_registered"><option value="1" ${settings.vat_registered !== '0' ? 'selected' : ''}>Yes — VAT-registered (issues TAX INVOICES)</option><option value="0" ${settings.vat_registered === '0' ? 'selected' : ''}>No — small-business exemption / not registered</option></select>
            <div class="help">Check the current small-business threshold with the tax authority before switching this off.</div></div>
          ${f('company_tin', 'Company TIN (Tax ID)', { placeholder: '12345678-0001', help: 'Printed on every invoice.' })}
          ${f('company_vat_number', 'VAT registration number', { help: 'Usually the same as the TIN.' })}
          ${f('company_rc_number', 'CAC / RC number')}
          ${f('vat_rate', 'VAT rate (%)', { type: 'number', help: 'Standard rate is 7.5%.' })}
        </div>
        <div>
          ${f('wht_rate_rental', 'WHT rate — equipment hire / rent (%)', { type: 'number', help: 'Statutory rate is 10%.' })}
          ${f('wht_rate_services', 'WHT rate — crew / technical services (%)', { type: 'number', help: 'Typically 5%.' })}
          ${f('wht_rate_goods', 'WHT rate — goods / consumables (%)', { type: 'number', help: 'Typically 2%.' })}
          ${f('wht_no_tin_multiplier', 'WHT multiplier for vendors with no TIN', { type: 'number', help: 'Rate is multiplied (capped at 20%).' })}
          ${f('invoice_due_days', 'Invoice payment terms (days)', { type: 'number' })}
          <div class="field"><label>Show NRS e-invoice section</label><select data-key="einvoice_enabled"><option value="0" ${settings.einvoice_enabled !== '1' ? 'selected' : ''}>No</option><option value="1" ${settings.einvoice_enabled === '1' ? 'selected' : ''}>Yes</option></select>
            <div class="help">E-invoicing is submitted through an NRS-accredited Access Point Provider; this portal records the IRN/CSID and exports the invoice data.</div></div>
        </div>
      </div>`,
    company: `
      <div class="grid-2">
        ${f('company_address', 'Business address', { textarea: true, rows: 2 })}
        <div>${f('company_phone', 'Phone')}${f('company_email', 'Email', { type: 'email' })}</div>
        ${f('company_website', 'Website')}
        <div class="grid-2" style="gap:10px">${f('company_rc_number', 'RC number')}${f('company_tin', 'TIN')}</div>
      </div>
      <div class="section-divider"></div>
      <div class="grid-2">
        ${f('invoice_bank_name', 'Bank name (on invoices)')}
        ${f('invoice_account_name', 'Account name')}
        ${f('invoice_account_number', 'Account number')}
        <div></div>
      </div>
      ${f('invoice_notes', 'Invoice footer note', { textarea: true, rows: 2 })}`,
    email: `
      <p class="muted" style="margin-top:0">Invoices are emailed through your own mailbox or mail provider (Gmail / Google Workspace, Microsoft 365, Zoho, cPanel hosting email, Brevo, Mailgun, SendGrid…).</p>
      <div class="grid-2">
        ${f('smtp_host', 'SMTP host', { placeholder: 'smtp.gmail.com' })}
        <div class="grid-2" style="gap:10px">
          ${f('smtp_port', 'Port', { type: 'number', placeholder: '587' })}
          <div class="field"><label>Security</label><select data-key="smtp_security">
            ${[['starttls', 'STARTTLS (587)'], ['tls', 'SSL/TLS (465)'], ['none', 'None (25)']].map(([k, l]) => `<option value="${k}" ${settings.smtp_security === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
        </div>
        ${f('smtp_user', 'Username', { placeholder: 'billing@yourcompany.com' })}
        <div class="field"><label>Password / app password</label><input data-key="smtp_pass" type="password" autocomplete="new-password" placeholder="${settings.smtp_pass_set ? '•••••••• saved — leave blank to keep' : 'Not set'}">
          <div class="help">Gmail and Microsoft 365 need an app password, not your normal login password.</div></div>
        ${f('mail_from_name', 'From name', { placeholder: settings.company_name || '' })}
        ${f('mail_from_address', 'From email address', { type: 'email', placeholder: 'billing@yourcompany.com' })}
        ${f('mail_reply_to', 'Reply-to address (optional)', { type: 'email' })}
        <div class="field"><label>Verify server certificate</label><select data-key="smtp_reject_unauthorized">
          <option value="1" ${settings.smtp_reject_unauthorized !== '0' ? 'selected' : ''}>Yes (recommended)</option>
          <option value="0" ${settings.smtp_reject_unauthorized === '0' ? 'selected' : ''}>No — self-signed server</option></select></div>
      </div>
      <div class="section-divider"></div>
      ${f('invoice_email_subject', 'Invoice email subject')}
      ${f('invoice_email_message', 'Invoice email message', { textarea: true, rows: 6, help: 'Placeholders: {customer_name} {invoice_number} {amount_due} {grand_total} {due_date} {company_name} {portal_name}' })}
      ${editable ? `<div class="btn-row"><input id="smtp-test-to" type="email" placeholder="${escapeHtml(CURRENT_USER.email)}" style="padding:8px 10px;background:var(--charcoal);border:1px solid var(--line);color:var(--text);min-width:240px">
        <button class="btn small secondary" id="smtp-test-btn">Send test email</button>
        ${settings.smtp_pass_set ? '<button class="btn small secondary" id="smtp-clear-pass">Clear saved password</button>' : ''}</div>
        <div class="help muted" style="margin-top:6px">Save settings first, then send a test.</div>` : ''}`,
    accounting: `
      <div class="notice">Corporate tax per the Nigeria Tax Act 2025: small companies (turnover ≤ ₦100m and fixed assets ≤ ₦250m) pay 0% CIT and no development levy; others pay CIT plus the 4% development levy. Confirm rates with your adviser.</div>
      <div class="grid-2">
        <div>${f('cit_rate', 'Companies income tax rate (%)', { type: 'number' })}${f('dev_levy_rate', 'Development levy (%)', { type: 'number' })}
          ${f('small_company_turnover', 'Small-company turnover threshold (₦)', { type: 'number' })}${f('small_company_assets', 'Small-company fixed-asset threshold (₦)', { type: 'number' })}
          ${f('financial_year_start_month', 'Financial year starts (month 1–12)', { type: 'number' })}</div>
        <div><h4 style="margin:0 0 8px">Expected credit loss matrix (IFRS 9) — % of balance</h4>
          ${f('ecl_rate_current', 'Not yet due', { type: 'number' })}${f('ecl_rate_1_30', '1–30 days overdue', { type: 'number' })}${f('ecl_rate_31_60', '31–60 days', { type: 'number' })}${f('ecl_rate_61_90', '61–90 days', { type: 'number' })}${f('ecl_rate_over_90', 'Over 90 days', { type: 'number' })}</div>
      </div>
      <div class="grid-2">
        ${f('cancellation_fee_pct', 'Booking cancellation / refund penalty (%)', { type: 'number', help: 'Rate card: 20%. Billed on a cancellation invoice.' })}
        <div>${f('pv_level1_roles', 'Voucher approval — level 1 roles', { help: 'Comma-separated role names' })}${f('pv_level2_roles', 'Voucher approval — level 2 roles (final, pays)', { help: 'Comma-separated role names' })}</div>
      </div>`,
    nrs: `
      <div class="notice">Nigeria's e-invoicing (fiscalisation): invoices are cleared on the NRS Merchant Buyer Solution (MBS) through an NRS-accredited <strong>Access Point Provider (APP)</strong>. Get your Business ID and 8-character Service ID from the NRS e-invoicing dashboard, and the API URL, key and secret from your APP. Use <strong>Simulator</strong> to train staff and test the flow without sending data.</div>
      <div class="grid-2">
        <div>
          <div class="field"><label>Mode</label><select data-key="nrs_mode">${[['off', 'Off'], ['simulator', 'Simulator (training / testing)'], ['live', 'Live — submit through my APP']].map(([k, l]) => `<option value="${k}" ${settings.nrs_mode === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Submit automatically when an invoice is generated</label><select data-key="nrs_auto_submit"><option value="0" ${settings.nrs_auto_submit !== '1' ? 'selected' : ''}>No — submit from Billing</option><option value="1" ${settings.nrs_auto_submit === '1' ? 'selected' : ''}>Yes</option></select></div>
          ${f('nrs_business_id', 'NRS Business ID')}
          ${f('nrs_service_id', 'NRS Service ID (8 characters — forms part of every IRN)', { placeholder: 'e.g. 94ND90NR' })}
          ${f('nrs_default_service_code', 'Default service / HSN code for rental lines', { help: 'Can be overridden per equipment category.' })}
          ${f('nrs_supplier_business_description', 'Business description')}
          <div class="grid-2" style="gap:10px">${f('nrs_supplier_city', 'City')}${f('nrs_supplier_state', 'State')}</div>
          ${f('nrs_supplier_postal_zone', 'Postal code')}
        </div>
        <div>
          ${f('nrs_app_name', 'Access Point Provider name')}
          ${f('nrs_base_url', 'APP API base URL', { placeholder: 'https://api.your-app.ng' })}
          <div class="field"><label>API key</label><input data-key="nrs_api_key" type="password" autocomplete="new-password" placeholder="${settings.nrs_api_key_set ? '•••••••• saved — leave blank to keep' : 'Not set'}"></div>
          <div class="field"><label>API secret</label><input data-key="nrs_api_secret" type="password" autocomplete="new-password" placeholder="${settings.nrs_api_secret_set ? '•••••••• saved — leave blank to keep' : 'Not set'}"></div>
          <details><summary class="muted" style="cursor:pointer">Endpoint paths (change only if your APP documents different ones)</summary>
            ${f('nrs_path_validate', 'Validate')}${f('nrs_path_sign', 'Sign')}${f('nrs_path_confirm', 'Confirm ({irn})')}${f('nrs_path_transmit', 'Transmit ({irn})')}${f('nrs_path_update', 'Update payment status ({irn})')}
            ${f('nrs_tax_category_standard', 'Tax category — standard-rated')}${f('nrs_tax_category_outside', 'Tax category — outside scope (damage / loss)')}</details>
          ${editable ? '<button class="btn small secondary" id="nrs-test" style="margin-top:10px">Test connection</button>' : ''}
        </div>
      </div>`,
    general: `
      <div class="grid-2">
        ${f('session_timeout_minutes', 'Session timeout (minutes)', { type: 'number' })}
        ${f('currency', 'Currency code')}
        ${f('login_attempt_limit', 'Failed logins before lock-out', { type: 'number' })}
        ${f('login_lockout_minutes', 'Lock-out minutes', { type: 'number' })}
      </div>`,
  };
  const labels = { branding: 'Branding', company: 'Company & invoice', tax: 'Tax (VAT / WHT)', accounting: 'Accounting & corporate tax', nrs: 'NRS e-invoicing', email: 'Email (SMTP)', general: 'General' };
  body.innerHTML = `
    <div class="settings-tabs">${Object.keys(labels).map((k) => `<button data-tab="${k}" class="${k === (initialTab || 'branding') ? 'active' : ''}">${labels[k]}</button>`).join('')}</div>
    ${Object.keys(labels).map((k) => `<div data-panel="${k}" style="${k === (initialTab || 'branding') ? '' : 'display:none'}">${tabs[k]}</div>`).join('')}
    ${editable ? '<div class="section-divider"></div><button class="btn" id="save-settings-btn">Save settings</button>' : ''}`;

  if (!editable) body.querySelectorAll('[data-key]').forEach(el => el.disabled = true);
  // The same setting can appear on two tabs (e.g. company TIN) — keep the copies in sync.
  body.querySelectorAll('[data-key]').forEach(el => el.addEventListener('input', () => body.querySelectorAll(`[data-key="${el.dataset.key}"]`).forEach(o => { if (o !== el) o.value = el.value; })));

  body.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    body.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b));
    body.querySelectorAll('[data-panel]').forEach(p => p.style.display = p.dataset.panel === b.dataset.tab ? '' : 'none');
  }));

  const pick = body.querySelector('#brand-color-pick'), hex = body.querySelector('#brand-color-hex');
  const spick = body.querySelector('#brand-sec-pick'), shex = body.querySelector('#brand-sec-hex');
  function drawPreview() {
    const c = isHex(hex.value) ? hex.value : '#E8630A', s = isHex(shex.value) ? shex.value : '#1B1E23';
    const name = body.querySelector('[data-key="portal_name"]').value || 'Portal';
    body.querySelector('#brand-preview').innerHTML = `
      <div class="bp-head" style="background:${s};color:${readableOn(s)}">${BRAND.logo_url ? `<img src="${BRAND.logo_url}" alt="" style="height:22px;background:#fff;padding:2px 4px;border-radius:3px">` : ''}<span>${escapeHtml(name)}</span></div>
      <div class="bp-body" style="background:${shade2(s)};color:${readableOn(shade2(s))}">Sample screen<br><span class="bp-btn" style="background:${c};color:${readableOn(c)}">Primary button</span> <span style="color:${contrastRatio(c, shade2(s)) >= 3 ? c : readableOn(shade2(s))};font-weight:600">Link text</span></div>`;
    const ratio = contrastRatio(c, readableOn(c));
    body.querySelector('#brand-contrast').innerHTML = ratio >= 4.5 ? '' : `<span style="color:var(--amber)">This colour gives low contrast for button text (${ratio.toFixed(1)}:1). Consider a darker or lighter shade.</span>`;
  }
  const shade2 = (s) => shadeHex(s, readableOn(s) === '#FFFFFF' ? 0.08 : -0.06);
  pick.addEventListener('input', () => { hex.value = pick.value; drawPreview(); });
  hex.addEventListener('input', () => { if (isHex(hex.value)) pick.value = hex.value; drawPreview(); });
  spick.addEventListener('input', () => { shex.value = spick.value; drawPreview(); });
  shex.addEventListener('input', () => { if (isHex(shex.value)) spick.value = shex.value; drawPreview(); });
  body.querySelectorAll('[data-sw]').forEach(b => b.addEventListener('click', () => { hex.value = b.dataset.sw; pick.value = b.dataset.sw; drawPreview(); }));
  body.querySelector('[data-key="portal_name"]').addEventListener('input', drawPreview);
  const rs = body.querySelector('#brand-reset'); if (rs) rs.addEventListener('click', () => { hex.value = ''; shex.value = ''; pick.value = '#E8630A'; spick.value = '#1B1E23'; drawPreview(); toast('Colours reset — click Save settings to apply'); });
  drawPreview();

  if (!editable) return;

  body.querySelector('#save-settings-btn').addEventListener('click', async () => {
    const payload = {};
    body.querySelectorAll('[data-key]').forEach(el => { payload[el.dataset.key] = el.value; });
    if (!payload.smtp_pass) delete payload.smtp_pass;
    for (const k of ['nrs_api_key', 'nrs_api_secret']) if (!payload[k]) delete payload[k];
    try {
      await API.put('/api/admin/settings', payload);
      toast('Settings saved');
      await loadBranding();
      const active = body.querySelector('.settings-tabs .active')?.dataset.tab;
      renderShell();
      setTimeout(() => document.querySelector(`#settings-body [data-tab="${active}"]`)?.click(), 400);
    } catch (e) { toast(e.message, true); }
  });

  const fileInput = body.querySelector('#logo-file');
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('Logo must be 2 MB or smaller', true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        BRAND = { ...BRAND, ...(await API.put('/api/admin/branding/logo', { data_url: reader.result })) };
        applyBranding(); toast('Logo updated'); renderShell();
      } catch (e) { toast(e.message, true); }
    };
    reader.readAsDataURL(file);
  });
  const rm = body.querySelector('#logo-remove');
  if (rm) rm.addEventListener('click', async () => {
    if (!confirm('Remove the logo?')) return;
    try { BRAND = { ...BRAND, ...(await API.del('/api/admin/branding/logo')) }; applyBranding(); toast('Logo removed'); renderShell(); }
    catch (e) { toast(e.message, true); }
  });

  const nt = body.querySelector('#nrs-test'); if (nt) nt.addEventListener('click', async () => { try { const r = await API.post('/api/einvoice/test-connection'); toast(r.message, !r.ok); } catch (e) { toast(e.message, true); } });
  body.querySelector('#smtp-test-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await API.post('/api/admin/email-test', { to: body.querySelector('#smtp-test-to').value.trim() || CURRENT_USER.email });
      toast(`Test email sent to ${r.to}`);
    } catch (err) { toast(err.message, true); }
    btn.disabled = false; btn.textContent = 'Send test email';
  });
  const clr = body.querySelector('#smtp-clear-pass');
  if (clr) clr.addEventListener('click', async () => {
    try { await API.put('/api/admin/settings', { clear_smtp_pass: true }); toast('Saved SMTP password cleared'); renderShell(); }
    catch (err) { toast(err.message, true); }
  });
}

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}
function severityBadgeClass(sev) { return sev === 'critical' ? 'overdue' : sev === 'warning' ? 'pending' : 'reserved'; }

async function loadHealthCard() {
  const el = document.getElementById('health-body');
  if (!el) return;
  el.innerHTML = 'Checking…';
  const h = await API.get('/api/system/health');
  const statusBadge = h.status === 'healthy' ? 'available' : h.status === 'warning' ? 'pending' : 'overdue';
  el.innerHTML = `
    <p>${badge(statusBadge)} <strong style="text-transform:capitalize">${h.status}</strong> · checked ${new Date(h.checked_at).toLocaleString()}</p>
    <div class="stat-row">
      <div class="stat-card"><div class="num">${h.process.uptime_seconds}s</div><div class="label">Process uptime</div></div>
      <div class="stat-card"><div class="num">${fmtBytes(h.database.file_size_bytes)}</div><div class="label">Database size</div></div>
      <div class="stat-card"><div class="num">${h.disk.used_pct != null ? h.disk.used_pct + '%' : '—'}</div><div class="label">Disk used (${fmtBytes(h.disk.free_bytes)} free)</div></div>
      <div class="stat-card"><div class="num">${h.backups.count}</div><div class="label">Backups on file</div></div>
    </div>
    <p class="muted">Node ${h.process.node_version} · ${escapeHtml(h.process.platform)} · DB integrity: ${h.database.integrity.ok ? 'ok' : 'FAILED — ' + escapeHtml(h.database.integrity.detail)}</p>
    <div class="section-divider"></div>
    <h4 style="margin:0 0 8px">Issues found</h4>
    ${h.issues.length ? h.issues.map(i => `<div style="margin-bottom:6px">${badge(severityBadgeClass(i.severity))} ${escapeHtml(i.message)}</div>`).join('')
      : '<p class="muted">No issues detected.</p>'}
    ${h.issues.some(i => i.check === 'stale_sessions') ? '<button class="btn small secondary" id="cleanup-sessions-btn">Clean up expired sessions</button>' : ''}
  `;
  const cleanupBtn = document.getElementById('cleanup-sessions-btn');
  if (cleanupBtn) cleanupBtn.addEventListener('click', async () => {
    const r = await API.post('/api/system/cleanup-sessions');
    toast(`Removed ${r.removed} expired session(s)`); loadHealthCard();
  });
}

async function loadMaintenanceCard() {
  const el = document.getElementById('maint-body');
  if (!el) return;
  const m = await API.get('/api/system/maintenance-mode');
  el.innerHTML = `
    <p class="muted">When enabled, only Admin users can sign in or use the portal — everyone else sees a maintenance message.</p>
    <div class="field"><label>Message shown to users</label><textarea id="maint-msg" rows="2">${escapeHtml(m.message)}</textarea></div>
    <button class="btn ${m.enabled ? 'danger' : ''}" id="toggle-maint-btn">${m.enabled ? 'Disable maintenance mode' : 'Enable maintenance mode'}</button>
    ${m.enabled ? '<span class="muted" style="margin-left:10px">Currently ON</span>' : ''}
  `;
  document.getElementById('toggle-maint-btn').addEventListener('click', async () => {
    await API.put('/api/system/maintenance-mode', { enabled: !m.enabled, message: document.getElementById('maint-msg').value });
    toast(m.enabled ? 'Maintenance mode disabled' : 'Maintenance mode enabled — non-admins are now locked out');
    loadMaintenanceCard();
  });
}

async function loadBackupCard() {
  const el = document.getElementById('backup-body');
  if (!el) return;
  const data = await API.get('/api/system/backups');
  el.innerHTML = `
    <p class="muted">Retention: ${data.retention_days} days. Restoring rewinds all data to that snapshot — a safety backup of the current state is taken automatically first.</p>
    <div class="table-wrap"><table><thead><tr><th>Backup</th><th>Size</th><th>Created</th><th></th></tr></thead><tbody>
      ${data.backups.length ? data.backups.map(b => `
        <tr><td>${escapeHtml(b.filename)}</td><td>${fmtBytes(b.size_bytes)}</td><td>${new Date(b.created_at).toLocaleString()}</td>
          <td class="row-actions">
            <a class="btn small secondary" href="/api/system/backups/${encodeURIComponent(b.filename)}/download">Download</a>
            <button class="btn small danger" data-restore="${escapeHtml(b.filename)}">Restore</button>
          </td></tr>`).join('') : '<tr><td colspan="4" class="empty-state">No backups yet.</td></tr>'}
    </tbody></table></div>`;
  el.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`Restore the portal to the snapshot "${btn.dataset.restore}"? All data changed since that backup will be lost (a safety copy of the current state is kept).`)) return;
    try {
      const r = await API.post(`/api/system/backups/${encodeURIComponent(btn.dataset.restore)}/restore`);
      toast(r.message || 'Restore complete');
      loadBackupCard(); loadHealthCard();
    } catch (e) { toast(e.message, true); }
  }));
}

function userForm(roles, onSave, existing) {
  const u = existing || {};
  openModal(existing ? `Edit ${escapeHtml(u.full_name)}` : 'Add user', `
    <div class="field"><label>Full name</label><input id="f-uname" value="${escapeHtml(u.full_name || '')}"></div>
    <div class="grid-2"><div class="field"><label>Job title</label><input id="f-utitle" value="${escapeHtml(u.title || '')}"></div><div class="field"><label>Phone</label><input id="f-uphone" value="${escapeHtml(u.phone || '')}"></div></div>
    ${existing ? '' : '<div class="field"><label>Email</label><input id="f-uemail" type="email"></div>'}
    <div class="field"><label>Role</label><select id="f-urole">${roles.map(r => `<option value="${r.id}" ${u.role_id === r.id ? 'selected' : ''}>${escapeHtml(r.name)} — ${escapeHtml(r.description || '')}</option>`).join('')}</select>
      ${existing ? '<div class="help">Changing the role signs the user out so the new permissions apply immediately.</div>' : ''}</div>
    ${existing ? '' : '<div class="field"><label>Temporary password <span class="muted">(10+ chars, upper, lower, number)</span></label><input id="f-upass" type="text" value="Welcome@2026"></div>'}
    <button class="btn" id="save-user-btn">${existing ? 'Save' : 'Create user'}</button>
    <div class="error-msg" id="user-form-error"></div>
  `, (overlay) => {
    overlay.querySelector('#save-user-btn').addEventListener('click', async () => {
      const body = { full_name: overlay.querySelector('#f-uname').value, title: overlay.querySelector('#f-utitle').value, phone: overlay.querySelector('#f-uphone').value, role_id: Number(overlay.querySelector('#f-urole').value) };
      try {
        if (existing) { if (body.role_id === u.role_id) delete body.role_id; await API.put('/api/admin/users/' + u.id, body); toast('User updated'); }
        else { await API.post('/api/admin/users', { ...body, email: overlay.querySelector('#f-uemail').value, password: overlay.querySelector('#f-upass').value }); toast('User created — they must change password on first login'); }
        overlay.remove(); onSave();
      } catch (e) { overlay.querySelector('#user-form-error').textContent = e.message; }
    });
  });
}

document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('[data-open-inv]');
  if (!a) return;
  e.preventDefault();
  if (!can('invoices.view')) return toast('You do not have access to invoices', true);
  a.closest('.overlay')?.remove();
  viewInvoice(a.dataset.openInv);
});

