const { db, getSettings } = require('../lib/db');
const { logAudit } = require('../lib/auth');
const { validateLogo, getLogo, publicBranding } = require('../lib/branding');
const { loadInvoice, renderPrintPage, buildInvoiceEmail, fillTemplate, templateVars } = require('../lib/invoice-doc');
const mailer = require('../lib/mailer');

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function smtpFromSettings(s) {
  return {
    smtp: {
      host: (s.smtp_host || '').trim(), port: s.smtp_port, security: s.smtp_security,
      user: (s.smtp_user || '').trim(), pass: s.smtp_pass || '', rejectUnauthorized: s.smtp_reject_unauthorized !== '0',
    },
    from: { name: s.mail_from_name || s.company_name || s.portal_name, address: (s.mail_from_address || s.smtp_user || '').trim() },
    replyTo: (s.mail_reply_to || s.company_email || '').trim() || undefined,
  };
}

function smtpConfigured(s) {
  return !!((s.smtp_host || '').trim() && ((s.mail_from_address || s.smtp_user || '').trim()));
}

module.exports = function (router) {
  // ---------- PUBLIC BRANDING (login screen, favicon, theme) ----------
  router.get('/api/branding', async (ctx) => ctx.json(200, publicBranding()));

  router.get('/api/branding/logo', async (ctx) => {
    const logo = getLogo();
    if (!logo) { ctx.res.writeHead(404); return ctx.res.end(); }
    ctx.res.writeHead(200, {
      'Content-Type': logo.contentType,
      'Content-Length': logo.buffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable', // URL carries ?v=<version>
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      'X-Content-Type-Options': 'nosniff',
    });
    ctx.res.end(logo.buffer);
  });

  router.put('/api/admin/branding/logo', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    if (!ctx.requireCsrf()) return;
    const { error, parsed } = validateLogo(ctx.body.data_url);
    if (error) return ctx.json(400, { error });
    const dataUrl = `data:${parsed.contentType};base64,${parsed.buffer.toString('base64')}`;
    setSetting('brand_logo', dataUrl);
    setSetting('brand_logo_version', Date.now());
    logAudit(ctx.user.id, 'brand_logo_updated', 'settings', null, { type: parsed.contentType, bytes: parsed.buffer.length }, ctx.ip);
    ctx.json(200, publicBranding());
  });

  router.del('/api/admin/branding/logo', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    if (!ctx.requireCsrf()) return;
    setSetting('brand_logo', '');
    setSetting('brand_logo_version', Date.now());
    logAudit(ctx.user.id, 'brand_logo_removed', 'settings', null, null, ctx.ip);
    ctx.json(200, publicBranding());
  });

  // ---------- PRINTABLE INVOICE ----------
  router.get('/api/invoices/:id/print', async (ctx, { id }) => {
    if (!ctx.require('invoices.view')) return;
    const data = loadInvoice(id);
    if (!data) return ctx.json(404, { error: 'Invoice not found' });
    const html = renderPrintPage(data, { autoPrint: ctx.query.autoprint === '1' });
    logAudit(ctx.user.id, 'invoice_printed', 'invoice', Number(id), { invoice_number: data.inv.invoice_number }, ctx.ip);
    ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    ctx.res.end(html);
  });

  // ---------- EMAIL INVOICE ----------
  router.get('/api/invoices/:id/email-draft', async (ctx, { id }) => {
    if (!ctx.require('invoices.view')) return;
    const data = loadInvoice(id);
    if (!data) return ctx.json(404, { error: 'Invoice not found' });
    const s = getSettings();
    const vars = templateVars(data, s);
    ctx.json(200, {
      to: data.customer.email || '',
      cc: '',
      subject: fillTemplate(s.invoice_email_subject, vars),
      message: fillTemplate(s.invoice_email_message, vars),
      smtp_configured: smtpConfigured(s),
      from: smtpConfigured(s) ? `${s.mail_from_name || s.company_name || ''} <${s.mail_from_address || s.smtp_user}>` : null,
    });
  });

  router.post('/api/invoices/:id/email', async (ctx, { id }) => {
    if (!ctx.require('invoices.edit')) return;
    if (!ctx.requireCsrf()) return;
    const data = loadInvoice(id);
    if (!data) return ctx.json(404, { error: 'Invoice not found' });
    const s = getSettings();
    if (!smtpConfigured(s)) return ctx.json(400, { error: 'Email is not set up yet. An admin needs to configure SMTP under Admin → Email (SMTP).' });

    const vars = templateVars(data, s);
    const to = (ctx.body.to || data.customer.email || '').trim();
    const cc = (ctx.body.cc || '').trim();
    const subject = (ctx.body.subject || fillTemplate(s.invoice_email_subject, vars)).trim();
    const message = ctx.body.message !== undefined ? String(ctx.body.message) : fillTemplate(s.invoice_email_message, vars);
    if (!to) return ctx.json(400, { error: 'This customer has no email address. Enter one, or add it on the customer record.' });
    for (const a of [...mailer.parseAddressList(to), ...mailer.parseAddressList(cc)]) {
      if (!mailer.isValidEmail(a)) return ctx.json(400, { error: `Invalid email address: ${a}` });
    }

    const { smtp, from, replyTo } = smtpFromSettings(s);
    const content = buildInvoiceEmail(data, { message });
    const log = db.prepare(`INSERT INTO invoice_emails (invoice_id, to_address, cc_address, subject, status, error, sent_by)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    try {
      await mailer.send({ smtp, from, replyTo, to, cc, subject, ...content });
    } catch (err) {
      log.run(id, to, cc || null, subject, 'failed', err.message, ctx.user.id);
      logAudit(ctx.user.id, 'invoice_email_failed', 'invoice', Number(id), { to, error: err.message }, ctx.ip);
      return ctx.json(502, { error: `Email could not be sent: ${err.message}` });
    }
    log.run(id, to, cc || null, subject, 'sent', null, ctx.user.id);
    logAudit(ctx.user.id, 'invoice_emailed', 'invoice', Number(id), { invoice_number: data.inv.invoice_number, to, cc }, ctx.ip);
    ctx.json(200, { ok: true, to, cc });
  });

  // ---------- SMTP TEST ----------
  router.post('/api/admin/email-test', async (ctx) => {
    if (!ctx.require('admin.settings')) return;
    if (!ctx.requireCsrf()) return;
    const s = getSettings();
    if (!smtpConfigured(s)) return ctx.json(400, { error: 'Save the SMTP host and From address first.' });
    const to = (ctx.body.to || ctx.user.email || '').trim();
    const { smtp, from, replyTo } = smtpFromSettings(s);
    const name = s.portal_name || 'MediaRent';
    try {
      await mailer.send({
        smtp, from, replyTo, to, subject: `${name} — test email`,
        text: `This is a test email from ${name}. If you received it, invoice emailing is working.`,
        html: `<div style="font-family:Calibri,Carlito,Arial,sans-serif;font-size:15px">This is a test email from <strong>${name}</strong>. If you received it, invoice emailing is working.</div>`,
      });
    } catch (err) {
      return ctx.json(502, { error: err.message });
    }
    logAudit(ctx.user.id, 'smtp_test_sent', 'settings', null, { to }, ctx.ip);
    ctx.json(200, { ok: true, to });
  });
};
