// Zero-dependency SMTP client (node:net / node:tls) — supports STARTTLS (587), implicit TLS (465)
// and plain (25/local relays), AUTH PLAIN / AUTH LOGIN, and MIME messages with an HTML body,
// inline images (cid:) and file attachments. Enough for Gmail, Outlook/Office 365, Zoho,
// cPanel/hosting mailboxes, Mailgun/SendGrid/Brevo SMTP relays, etc.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');

const TIMEOUT_MS = 30000;

function encodeHeader(str) {
  // RFC 2047 encoded-word for any non-ASCII header text
  return /^[\x20-\x7E]*$/.test(str) ? str : `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function formatAddress(name, address) {
  if (!name) return `<${address}>`;
  const safe = name.replace(/["\\\r\n]/g, '');
  return `${encodeHeader(`"${safe}"`)} <${address}>`;
}

function parseAddressList(input) {
  if (!input) return [];
  return String(input).split(/[,;]/).map(s => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/<([^>]+)>/);
    return (m ? m[1] : s).trim();
  });
}

function isValidEmail(e) {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(e);
}

function b64wrap(buf) {
  return buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

function stripCrlf(s) { return String(s || '').replace(/[\r\n]+/g, ' '); }

function buildMessage({ from, to, cc, replyTo, subject, html, text, attachments = [], inline = [] }) {
  const boundaryMixed = 'mix_' + crypto.randomBytes(12).toString('hex');
  const boundaryRelated = 'rel_' + crypto.randomBytes(12).toString('hex');
  const boundaryAlt = 'alt_' + crypto.randomBytes(12).toString('hex');
  const domain = (from.address.split('@')[1] || 'localhost');
  const headers = [
    `From: ${formatAddress(stripCrlf(from.name), from.address)}`,
    `To: ${to.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : null,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(stripCrlf(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
  ].filter(Boolean);

  const parts = [];
  parts.push(`--${boundaryMixed}`);
  parts.push(`Content-Type: multipart/related; boundary="${boundaryRelated}"`, '');
  parts.push(`--${boundaryRelated}`);
  parts.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`, '');
  parts.push(`--${boundaryAlt}`);
  parts.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64wrap(Buffer.from(text || '', 'utf8')));
  parts.push(`--${boundaryAlt}`);
  parts.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64wrap(Buffer.from(html || '', 'utf8')));
  parts.push(`--${boundaryAlt}--`, '');
  for (const img of inline) {
    parts.push(`--${boundaryRelated}`);
    parts.push(`Content-Type: ${img.contentType}`, 'Content-Transfer-Encoding: base64',
      `Content-ID: <${img.cid}>`, `Content-Disposition: inline; filename="${img.filename}"`, '', b64wrap(img.content));
  }
  parts.push(`--${boundaryRelated}--`, '');
  for (const a of attachments) {
    parts.push(`--${boundaryMixed}`);
    parts.push(`Content-Type: ${a.contentType}; name="${a.filename}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`, '', b64wrap(a.content));
  }
  parts.push(`--${boundaryMixed}--`, '');

  const body = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
  // SMTP dot-stuffing
  return body.replace(/\r\n\./g, '\r\n..');
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this.transcript = [];
    this._attach(socket);
  }
  _attach(socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { this.buffer += chunk; this._drain(); });
    socket.on('error', (err) => { const w = this.waiters.shift(); if (w) w.reject(err); });
    socket.on('close', () => { const w = this.waiters.shift(); if (w) w.reject(new Error('Connection closed by mail server')); });
  }
  _drain() {
    // A complete reply ends with a line "NNN text" (space, not dash, after the code)
    const lines = this.buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        this.buffer = lines.slice(i + 1).join('\r\n');
        const w = this.waiters.shift();
        const code = parseInt(reply[reply.length - 1].slice(0, 3), 10);
        this.transcript.push('S: ' + reply.join(' | '));
        if (w) w.resolve({ code, lines: reply, text: reply.map(l => l.slice(4)).join('\n') });
        return this._drain();
      }
    }
  }
  read() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this._drain();
    });
  }
  async cmd(line, expect, logAs) {
    this.transcript.push('C: ' + (logAs || line));
    this.socket.write(line + '\r\n');
    const r = await this.read();
    if (expect && !expect.includes(r.code)) {
      const err = new Error(`Mail server rejected "${(logAs || line).split(' ')[0]}": ${r.code} ${r.text}`);
      err.smtpCode = r.code;
      throw err;
    }
    return r;
  }
  upgrade(host, rejectUnauthorized) {
    return new Promise((resolve, reject) => {
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('close');
      const secure = tls.connect({ socket: this.socket, rejectUnauthorized, ...(net.isIP(host) ? {} : { servername: host }) }, () => {
        this.socket = secure;
        this.buffer = '';
        this._attach(secure);
        resolve();
      });
      secure.once('error', reject);
    });
  }
}

function connect({ host, port, security, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, rejectUnauthorized, ...(net.isIP(host) ? {} : { servername: host }) };
    const sock = security === 'tls' ? tls.connect(opts) : net.connect({ host, port });
    const readyEvent = security === 'tls' ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`Timed out connecting to ${host}:${port}`)); }, TIMEOUT_MS);
    sock.once(readyEvent, () => { clearTimeout(timer); resolve(sock); });
    sock.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * send({ smtp: {host, port, security, user, pass, rejectUnauthorized},
 *        from: {name, address}, to, cc, replyTo, subject, html, text, attachments, inline })
 */
async function send(opts) {
  const { smtp } = opts;
  if (!smtp || !smtp.host) throw new Error('SMTP is not configured. Set it up under Admin → Email (SMTP).');
  if (!opts.from || !isValidEmail(opts.from.address)) throw new Error('A valid "From" email address is required in the email settings.');
  const to = parseAddressList(opts.to);
  const cc = parseAddressList(opts.cc);
  if (!to.length) throw new Error('At least one recipient is required');
  for (const a of [...to, ...cc]) if (!isValidEmail(a)) throw new Error(`Invalid email address: ${a}`);

  const port = parseInt(smtp.port, 10) || (smtp.security === 'tls' ? 465 : 587);
  const security = smtp.security || 'starttls';
  const rejectUnauthorized = smtp.rejectUnauthorized !== false;
  const socket = await connect({ host: smtp.host, port, security, rejectUnauthorized });
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('Mail server timed out')));
  const s = new SmtpSession(socket);
  const heloName = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';

  try {
    const greet = await s.read();
    if (greet.code !== 220) throw new Error(`Unexpected greeting: ${greet.code} ${greet.text}`);
    let ehlo = await s.cmd(`EHLO ${heloName}`, [250]);

    if (security === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('Mail server does not offer STARTTLS. Try security "SSL/TLS" on port 465, or "None".');
      await s.cmd('STARTTLS', [220]);
      await s.upgrade(smtp.host, rejectUnauthorized);
      ehlo = await s.cmd(`EHLO ${heloName}`, [250]);
    }

    if (smtp.user) {
      const authLine = (ehlo.lines.find(l => /AUTH/i.test(l)) || '').toUpperCase();
      if (authLine.includes('PLAIN') || !authLine.includes('LOGIN')) {
        const token = Buffer.from(`\u0000${smtp.user}\u0000${smtp.pass || ''}`).toString('base64');
        await s.cmd(`AUTH PLAIN ${token}`, [235], 'AUTH PLAIN ****');
      } else {
        await s.cmd('AUTH LOGIN', [334]);
        await s.cmd(Buffer.from(smtp.user).toString('base64'), [334], '****');
        await s.cmd(Buffer.from(smtp.pass || '').toString('base64'), [235], '****');
      }
    }

    await s.cmd(`MAIL FROM:<${opts.from.address}>`, [250]);
    for (const rcpt of [...to, ...cc]) await s.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await s.cmd('DATA', [354]);
    const message = buildMessage({ ...opts, to, cc });
    s.transcript.push('C: <message body>');
    s.socket.write(message + '\r\n.\r\n');
    const accepted = await s.read();
    if (accepted.code !== 250) throw new Error(`Message rejected: ${accepted.code} ${accepted.text}`);
    try { await s.cmd('QUIT', [221]); } catch {}
    return { ok: true, accepted: [...to, ...cc], response: accepted.text };
  } finally {
    try { s.socket.end(); } catch {}
  }
}

module.exports = { send, parseAddressList, isValidEmail, buildMessage };
