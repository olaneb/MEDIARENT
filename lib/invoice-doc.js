// Renders a branded, self-contained invoice document. The same markup is used for the
// printable page and the email body/attachment, so what the client receives matches what
// staff print. Table layout + inline styles so it survives Gmail/Outlook rendering.
const { db, getSettings } = require('./db');
const { getLogo, isHexColor, readableOn } = require('./branding');
const { qrSvg } = require('./qr');

const FONT = "Calibri, Carlito, 'Segoe UI', Arial, sans-serif";

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n, currency) {
  return `${currency} ${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  return isNaN(d) ? s : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function loadInvoice(id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return null;
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(id);
  const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY received_at').all(id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customer_id) || {};
  const agreement = inv.agreement_id ? db.prepare('SELECT * FROM rental_agreements WHERE id = ?').get(inv.agreement_id) : null;
  return { inv, items, payments, customer, agreement };
}

function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function templateVars(data, settings) {
  const cur = settings.currency || 'NGN';
  const { inv, customer } = data;
  return {
    invoice_number: inv.invoice_number,
    customer_name: customer.company_name || customer.full_name || 'Customer',
    amount_due: money(Math.max(0, inv.grand_total - inv.amount_paid), cur),
    grand_total: money(inv.grand_total, cur),
    due_date: fmtDate(inv.due_date),
    company_name: settings.company_name || settings.portal_name || '',
    portal_name: settings.portal_name || '',
  };
}

/**
 * @param {object} data   result of loadInvoice()
 * @param {object} opts   { logoSrc: string|null }
 * @returns inner invoice markup (a single centered table)
 */
function renderInvoiceBody(data, opts = {}) {
  const s = getSettings();
  const cur = s.currency || 'NGN';
  const accent = isHexColor(s.brand_primary_color) ? s.brand_primary_color : '#E8630A';
  const { inv, items, payments, customer, agreement } = data;
  const itemsTotal = items.reduce((a, li) => a + Number(li.amount || 0), 0);
  const balance = Math.max(0, Math.round((inv.grand_total - inv.amount_paid) * 100) / 100);
  const isTaxInvoice = Number(inv.vat_rate) > 0 || Number(inv.vat_total) > 0;
  const supplierTin = inv.supplier_tin || s.company_vat_number || s.company_tin || '';
  const supplierRc = inv.supplier_rc || s.company_rc_number || '';
  const buyerTin = inv.customer_tin || customer.tin || '';
  const showVatCol = items.some(li => Number(li.vat_rate) > 0);
  const onAccent = readableOn(accent);
  const statusLabel = inv.status === 'paid' ? 'PAID' : inv.status === 'partial' ? 'PART-PAID' : inv.status === 'void' ? 'VOID' : 'UNPAID';
  const statusColor = inv.status === 'paid' ? '#2E7D32' : inv.status === 'partial' ? '#B7791F' : '#C62828';

  const companyLines = [
    s.company_address, [s.company_phone, s.company_email].filter(Boolean).join(' · '), s.company_website,
    [supplierRc ? `RC ${supplierRc}` : '', supplierTin ? `TIN ${supplierTin}` : ''].filter(Boolean).join(' · '),
  ].filter(Boolean);

  const billTo = [
    customer.company_name && customer.company_name !== customer.full_name ? customer.company_name : null,
    customer.full_name, customer.address, customer.phone, customer.email,
    [buyerTin ? `TIN ${buyerTin}` : '', customer.rc_number ? `RC ${customer.rc_number}` : ''].filter(Boolean).join(' · '),
  ].filter(Boolean);

  const logo = opts.logoSrc
    ? `<img src="${esc(opts.logoSrc)}" alt="${esc(s.company_name || s.portal_name)}" style="max-height:70px;max-width:220px;display:block;border:0">`
    : `<div style="font-size:26px;font-weight:bold;color:${accent}">${esc(s.company_name || s.portal_name)}</div>`;

  const td = 'padding:8px 10px;border-bottom:1px solid #E5E5E5;font-size:14px;vertical-align:top';
  const rows = items.map((li, i) => `
    <tr>
      <td style="${td};color:#777;width:36px">${i + 1}</td>
      <td style="${td}">${esc(li.description)}</td>
      <td style="${td};text-align:right;white-space:nowrap">${money(li.amount, cur)}</td>
      ${showVatCol ? `<td style="${td};text-align:right;white-space:nowrap;color:#555">${Number(li.vat_rate) > 0 ? `${Number(li.vat_rate)}%` : 'n/a*'}</td><td style="${td};text-align:right;white-space:nowrap">${money(li.vat_amount, cur)}</td>` : ''}
    </tr>`).join('');

  const totalRow = (label, value, strong) => `
    <tr>
      <td style="padding:5px 10px;font-size:${strong ? 16 : 14}px;${strong ? 'font-weight:bold;' : ''}text-align:right">${label}</td>
      <td style="padding:5px 10px;font-size:${strong ? 16 : 14}px;${strong ? 'font-weight:bold;' : ''}text-align:right;white-space:nowrap">${value}</td>
    </tr>`;

  const vatRate = s.vat_rate ? ` (${esc(s.vat_rate)}%)` : '';
  const bankBlock = (s.invoice_bank_name || s.invoice_account_number) ? `
    <div style="font-size:13px;line-height:1.6">
      <div style="font-weight:bold;color:${accent};text-transform:uppercase;font-size:12px;letter-spacing:.05em;margin-bottom:4px">Payment details</div>
      ${s.invoice_bank_name ? `Bank: <strong>${esc(s.invoice_bank_name)}</strong><br>` : ''}
      ${s.invoice_account_name ? `Account name: <strong>${esc(s.invoice_account_name)}</strong><br>` : ''}
      ${s.invoice_account_number ? `Account number: <strong>${esc(s.invoice_account_number)}</strong><br>` : ''}
      Reference: <strong>${esc(inv.invoice_number)}</strong>
    </div>` : '';

  const paymentsBlock = payments.length ? `
    <div style="font-size:13px;margin-top:16px">
      <div style="font-weight:bold;color:${accent};text-transform:uppercase;font-size:12px;letter-spacing:.05em;margin-bottom:4px">Payments received</div>
      ${payments.map(p => `${fmtDate(p.received_at)} — ${esc(p.payment_ref)} — ${money(p.amount, cur)} (${esc(String(p.method || '').replace(/_/g, ' '))})`).join('<br>')}
    </div>` : '';

  const bookingBlock = agreement ? `
      <div style="font-size:13px;color:#555;margin-top:10px;line-height:1.5">
        Booking: <strong>${esc(agreement.agreement_number)}</strong>
        ${agreement.project_name ? `<br>Production: ${esc(agreement.project_name)}${agreement.production_type ? ` (${esc(agreement.production_type)})` : ''}` : ''}
        <br>Rental period: ${fmtDate(agreement.start_date)} – ${fmtDate(agreement.actual_return_date || agreement.expected_return_date)}
      </div>` : '';

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:800px;margin:0 auto;background:#FFFFFF;font-family:${FONT};color:#222;border-top:6px solid ${accent}" class="invoice-sheet">
  <tr><td style="padding:32px 36px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="vertical-align:top">
        ${logo}
        <div style="font-size:13px;color:#555;margin-top:10px;line-height:1.5">
          ${opts.logoSrc && s.company_name ? `<strong style="color:#222">${esc(s.company_name)}</strong><br>` : ''}
          ${companyLines.map(esc).join('<br>')}
        </div>
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:32px;font-weight:bold;letter-spacing:.04em;color:${accent}">${isTaxInvoice ? 'TAX INVOICE' : 'INVOICE'}</div>
        <div style="font-size:15px;margin-top:4px"><strong>${esc(inv.invoice_number)}</strong></div>
        <div style="font-size:13px;color:#555;margin-top:6px;line-height:1.6">
          Issue date: ${fmtDate(inv.issue_date || inv.created_at)}<br>
          ${inv.supply_date ? `Date of supply: ${fmtDate(inv.supply_date)}<br>` : ''}
          Due date: <strong style="color:#222">${fmtDate(inv.due_date)}</strong>
          ${inv.einvoice_irn ? `<br>IRN: <strong style="color:#222">${esc(inv.einvoice_irn)}</strong>` : ''}${inv.einvoice_csid ? `<br>CSID: <strong style="color:#222">${esc(inv.einvoice_csid)}</strong>` : ''}
        </div>
        ${inv.status === 'void' ? `<div style="font-size:12px;color:#C62828;margin-top:6px">Voided: ${esc(inv.void_reason || '')}</div>` : ''}
        <div style="display:inline-block;margin-top:8px;padding:3px 10px;border:2px solid ${statusColor};color:${statusColor};font-weight:bold;font-size:12px;letter-spacing:.08em">${statusLabel}</div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:12px 36px">
    <div style="font-weight:bold;color:${accent};text-transform:uppercase;font-size:12px;letter-spacing:.05em;margin-bottom:4px">Bill to</div>
    <div style="font-size:14px;line-height:1.5">${billTo.map((l, i) => i === 0 ? `<strong>${esc(l)}</strong>` : esc(l)).join('<br>')}</div>
    ${bookingBlock}
  </td></tr>

  <tr><td style="padding:12px 36px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">
      <thead><tr>
        <th style="padding:9px 10px;background:${accent};color:${onAccent};font-size:13px;text-align:left;width:36px">#</th>
        <th style="padding:9px 10px;background:${accent};color:${onAccent};font-size:13px;text-align:left">Description</th>
        <th style="padding:9px 10px;background:${accent};color:${onAccent};font-size:13px;text-align:right">${showVatCol ? 'Amount (excl. VAT)' : 'Amount'}</th>
        ${showVatCol ? `<th style="padding:9px 10px;background:${accent};color:${onAccent};font-size:13px;text-align:right">VAT rate</th><th style="padding:9px 10px;background:${accent};color:${onAccent};font-size:13px;text-align:right">VAT</th>` : ''}
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="5" style="${td};color:#777">No line items</td></tr>`}</tbody>
    </table>
  </td></tr>

  <tr><td style="padding:4px 36px 12px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="min-width:320px">
      ${totalRow(isTaxInvoice ? 'Total (excl. VAT)' : 'Subtotal', money(itemsTotal, cur))}
      ${inv.exempt_total > 0 && isTaxInvoice ? totalRow('of which outside scope of VAT*', money(inv.exempt_total, cur)) : ''}
      ${isTaxInvoice ? totalRow(`VAT (${Number(inv.vat_rate || s.vat_rate)}%) on ${money(inv.taxable_total, cur)}`, money(inv.vat_total, cur)) : ''}
      <tr><td colspan="2" style="border-top:2px solid ${accent};padding:0;height:4px"></td></tr>
      ${totalRow('Total', money(inv.grand_total, cur), true)}
      ${inv.amount_paid > 0 ? totalRow('Amount paid', '– ' + money(inv.amount_paid, cur)) : ''}
      ${inv.wht_credited > 0 ? totalRow('  of which WHT deducted at source', money(inv.wht_credited, cur)) : ''}
      ${totalRow('Balance due', money(balance, cur), true)}
    </table>
  </td></tr>

  ${inv.einvoice_status === 'cleared' && inv.einvoice_irn ? `<tr><td style="padding:6px 36px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E5E5E5"><tr>
      <td style="padding:8px;vertical-align:middle">${qrSvg(inv.einvoice_qr || inv.einvoice_irn, { size: 112 })}</td>
      <td style="padding:8px 14px;font-size:12px;color:#555;vertical-align:middle;line-height:1.6">
        <strong style="color:#222">NRS e-invoice — validated</strong><br>IRN: <strong style="color:#222">${esc(inv.einvoice_irn)}</strong><br>
        ${inv.einvoice_csid ? `CSID: ${esc(String(inv.einvoice_csid).slice(0, 48))}<br>` : ''}Scan to verify on the NRS Merchant Buyer Solution.${inv.credit_note_number ? `<br>Credit note: <strong>${esc(inv.credit_note_number)}</strong>` : ''}
      </td></tr></table></td></tr>` : ''}
  <tr><td style="padding:12px 36px 8px">
    ${bankBlock}
    ${paymentsBlock}
    ${inv.exempt_total > 0 && isTaxInvoice ? `<div style="font-size:12px;color:#777;margin-top:12px">* Compensation for loss or damage is not consideration for a supply and is outside the scope of VAT.</div>` : ''}
    ${inv.wht_total > 0 && balance > 0 && inv.status !== 'void' ? `<div style="font-size:12px;color:#777;margin-top:8px">Withholding tax: if you are required to deduct WHT at source, the maximum on this invoice is ${money(inv.wht_total, cur)} (computed on the VAT-exclusive amount). Please pay the net amount to us, remit the WHT to the tax authority and send us the WHT credit note.</div>` : ''}
    ${!isTaxInvoice && s.vat_registered === '0' ? `<div style="font-size:12px;color:#777;margin-top:8px">The supplier is not registered to charge VAT (small-business exemption). No VAT is charged on this invoice.</div>` : ''}
    ${s.invoice_notes ? `<div style="font-size:13px;color:#555;margin-top:14px;line-height:1.5">${esc(s.invoice_notes).replace(/\n/g, '<br>')}</div>` : ''}
  </td></tr>

  <tr><td style="padding:14px 36px 26px;border-top:1px solid #E5E5E5;font-size:11px;color:#999;text-align:center">
    ${esc(s.company_name || s.portal_name)}${s.company_website ? ' · ' + esc(s.company_website) : ''}
    ${s.show_powered_by !== '0' ? `<br>Generated by ${esc(s.portal_name || 'MediaRent')} · Powered by Olans FIXZIT Concept` : ''}
  </td></tr>
</table>`;
}

function logoDataUrl() {
  const logo = getLogo();
  return logo ? `data:${logo.contentType};base64,${logo.buffer.toString('base64')}` : null;
}

function fontFaceCss(baseUrl) {
  // Calibri is used where installed (Windows/Office); Carlito — a metric-compatible, openly
  // licensed Calibri clone bundled with the portal — covers Mac, Linux and mobile.
  return `
@font-face { font-family: 'Carlito'; src: local('Calibri'), url('${baseUrl}/fonts/Carlito-Regular.ttf') format('truetype'); font-weight: 400; }
@font-face { font-family: 'Carlito'; src: local('Calibri Bold'), local('Calibri-Bold'), url('${baseUrl}/fonts/Carlito-Bold.ttf') format('truetype'); font-weight: 700; }`;
}

// Full printable page (opened in a new tab from the portal).
function renderPrintPage(data, { autoPrint } = {}) {
  const s = getSettings();
  const body = renderInvoiceBody(data, { logoSrc: logoDataUrl() });
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.inv.invoice_number)} — ${esc(s.company_name || s.portal_name)}</title>
<style>
${fontFaceCss('')}
body { margin:0; background:#ECECEC; font-family:${FONT}; }
.toolbar { position:sticky; top:0; background:#222; color:#fff; padding:10px 16px; display:flex; gap:10px; justify-content:center; font-family:${FONT}; z-index:5 }
.toolbar button { font-family:${FONT}; font-size:15px; padding:8px 18px; border:0; cursor:pointer; background:#fff; color:#222; border-radius:2px }
.toolbar button.primary { background:${isHexColor(s.brand_primary_color) ? s.brand_primary_color : '#E8630A'}; color:${readableOn(isHexColor(s.brand_primary_color) ? s.brand_primary_color : '#E8630A')} }
.wrap { padding:24px 12px 48px }
.invoice-sheet { box-shadow:0 2px 14px rgba(0,0,0,.12) }
@page { size: A4; margin: 12mm; }
@media print {
  body { background:#fff }
  .toolbar { display:none }
  .wrap { padding:0 }
  .invoice-sheet { box-shadow:none; max-width:none !important }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style></head>
<body>
<div class="toolbar"><button class="primary" onclick="window.print()">Print / Save as PDF</button><button onclick="window.close()">Close</button></div>
<div class="wrap">${body}</div>
${autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},350)});</script>' : ''}
</body></html>`;
}

// Email: HTML body (logo via cid:), plain text alternative, and the standalone invoice as an attachment.
function buildInvoiceEmail(data, { message }) {
  const s = getSettings();
  const logo = getLogo();
  const cid = logo ? 'brandlogo@medirent' : null;
  const vars = templateVars(data, s);
  const intro = esc(message || '').replace(/\n/g, '<br>');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F2F2F2;font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2F2F2"><tr><td style="padding:24px 10px">
  ${intro ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:800px;margin:0 auto 16px;background:#FFFFFF;font-family:${FONT}"><tr><td style="padding:22px 36px;font-size:15px;line-height:1.6;color:#222">${intro}</td></tr></table>` : ''}
  ${renderInvoiceBody(data, { logoSrc: cid ? `cid:${cid}` : null })}
</td></tr></table>
</body></html>`;

  const cur = s.currency || 'NGN';
  const text = [
    message || '',
    '',
    `INVOICE ${data.inv.invoice_number}`,
    `Issue date: ${fmtDate(data.inv.issue_date || data.inv.created_at)}   Due: ${fmtDate(data.inv.due_date)}`,
    '',
    ...data.items.map(li => `- ${li.description}: ${money(li.amount, cur)}`),
    '',
    `VAT (${Number(data.inv.vat_rate || 0)}%): ${money(data.inv.vat_total, cur)}`,
    `Total: ${money(data.inv.grand_total, cur)}`,
    `Balance due: ${money(data.inv.grand_total - data.inv.amount_paid, cur)}`,
    s.invoice_account_number ? `\nPay to: ${s.invoice_bank_name || ''} ${s.invoice_account_name || ''} ${s.invoice_account_number}` : '',
    '', vars.company_name,
  ].join('\n');

  const attachmentHtml = renderPrintPage(data, { autoPrint: false })
    .replace(/<div class="toolbar">[\s\S]*?<\/div>\n/, ''); // no buttons in the attached copy

  const inline = logo ? [{ cid, contentType: logo.contentType, filename: `logo.${logo.ext}`, content: logo.buffer }] : [];
  const attachments = [{
    filename: `Invoice-${data.inv.invoice_number}.html`, contentType: 'text/html; charset=UTF-8',
    content: Buffer.from(attachmentHtml, 'utf8'),
  }];
  return { html, text, inline, attachments };
}

module.exports = { loadInvoice, renderPrintPage, buildInvoiceEmail, fillTemplate, templateVars };
