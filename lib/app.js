// Request handler used by server.js (local, VPS, Fly.io).
const fs = require('fs');
const path = require('path');
const { init, db } = require('./db');
const { getSession, getUserWithRole, hasPermission } = require('./auth');
const Router = require('./router');

init();

const router = new Router();
// Static requires so every route file is explicit.
require('../routes/auth')(router);
require('../routes/equipment')(router);
require('../routes/kits')(router);
require('../routes/consumables')(router);
require('../routes/customers')(router);
require('../routes/rentals')(router);
require('../routes/finance')(router);
require('../routes/maintenance')(router);
require('../routes/admin')(router);
require('../routes/dashboard')(router);
require('../routes/system')(router);
require('../routes/branding')(router);
require('../routes/accounting')(router);
require('../routes/reports')(router);
require('../routes/imports')(router);
require('../routes/einvoice')(router);
require('../routes/ops')(router);

const MAINTENANCE_ALLOWLIST = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me',
  '/api/system/maintenance-mode', '/api/branding', '/api/branding/logo', '/api/health']);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

function isMaintenanceModeOn() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").get();
  return row && row.value === '1';
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    try { out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim()); } catch {}
  });
  return out;
}

function parseJson(text) {
  if (!text) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 25 * 1024 * 1024) { reject(new Error('Payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(parseJson(data)));
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel; try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  let filePath = path.join(PUBLIC_DIR, rel === '/' ? '/index.html' : rel);
  if (rel.includes('\0') || (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!path.extname(pathname)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
          res.end(d2);
        });
        return;
      }
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS };
    if (['.ttf', '.woff', '.woff2'].includes(ext)) headers['Cache-Control'] = 'public, max-age=2592000';
    res.writeHead(200, headers);
    res.end(data);
  });
}

// Collects a response in memory so it can be sent only after the data has been saved.

// Handles one /api request against the current database. `res` may be real or buffered.
async function dispatch(req, res, pathname, query) {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies.session);
  let user = null;
  if (session) user = getUserWithRole(session.user_id);
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();

  const ctx = {
    req, res, query, session, user,
    ip: req.headers['fly-client-ip'] || fwd || req.socket?.remoteAddress || null,
    secure: req.headers['x-forwarded-proto'] === 'https',
    require(permKey) {
      if (!user) { sendJson(res, 401, { error: 'Not authenticated' }); return false; }
      if (!hasPermission(user, permKey)) { sendJson(res, 403, { error: 'Forbidden: missing permission ' + permKey }); return false; }
      return true;
    },
    requireCsrf() {
      if (!session) return true;
      const token = req.headers['x-csrf-token'];
      if (token !== session.csrf_token) { sendJson(res, 403, { error: 'Invalid CSRF token' }); return false; }
      return true;
    },
    json: (status, obj) => sendJson(res, status, obj),
  };

  if (!MAINTENANCE_ALLOWLIST.has(pathname)) {
    const isAdmin = user && user.role_name === 'Admin';
    if (!isAdmin && isMaintenanceModeOn()) {
      const msg = db.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode_message'").get();
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '120' });
      return res.end(JSON.stringify({ error: msg ? msg.value : 'The portal is undergoing scheduled maintenance.', maintenance: true }));
    }
  }

  const match = router.match(req.method, pathname);
  if (!match) return sendJson(res, 404, { error: 'Not found' });
  try {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) ctx.body = await readBody(req);
    await match.handler(ctx, match.params);
  } catch (err) {
    const msg = String(err && err.message || '');
    let status = 500, out = 'Something went wrong on the server. Nothing was saved. Please try again.';
    if (err && err.status >= 400 && err.status < 500) { status = err.status; out = msg; }
    else if (/^Period locked/.test(msg)) { status = 400; out = msg; }
    else if (/UNIQUE constraint failed/i.test(msg)) { status = 409; out = 'That value already exists (duplicate). Please use a different one.'; }
    else if (/FOREIGN KEY constraint failed/i.test(msg)) { status = 400; out = 'That record refers to something that does not exist.'; }
    else if (/NOT NULL constraint failed/i.test(msg)) { status = 400; out = 'A required field is missing.'; }
    else if (/Journal entry/i.test(msg) || /Unknown account code/i.test(msg)) { out = 'The accounting entry could not be posted, so nothing was saved: ' + msg; }
    if (status === 500) console.error(err);
    if (!res.finished && !res.headersSent) sendJson(res, status, { error: out });
  }
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  const query = Object.fromEntries(u.searchParams);

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  // Liveness/readiness probe for Fly.io: proves the process is up AND the database answers.
  if (pathname === '/api/health') {
    try { db.prepare('SELECT 1').get(); return sendJson(res, 200, { ok: true, storage: 'local-disk' }); }
    catch (e) { return sendJson(res, 503, { ok: false, error: 'database unavailable' }); }
  }
  return dispatch(req, res, pathname, query);
}

module.exports = { handle };
