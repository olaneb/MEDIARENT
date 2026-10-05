// Nigerian tax engine — single source of truth for VAT and WHT arithmetic.
//
// Legal basis (as at Oct 2026; settings are editable so a rate change needs no code change):
//  * VAT — Nigeria Tax Act 2025 (in force 1 Jan 2026): standard rate 7.5% on taxable supplies, which
//    includes the hire of equipment, ancillary charges (late fees, waiver fees, rush fees), crew/technical
//    services and sale of consumables. Registered suppliers may recover input VAT on goods, services and
//    fixed assets used to make taxable supplies. Return + payment due by the 21st of the following month.
//  * Compensation for loss/damage (replacement-value recovery, damage charges) is NOT consideration for a
//    supply, so it is treated as outside the scope of VAT.
//  * WHT — Deduction of Tax at Source (Withholding) Regulations 2024: rent/hire/lease 10%, technical &
//    professional services 5%, supply of goods 2%. The CUSTOMER deducts it from payment and remits it to
//    the tax authority by the 21st of the following month, issuing a WHT credit note. For the supplier it is a
//    prepayment of income tax (an asset), NOT an extra amount on top of the invoice.
//    Vendors without a TIN suffer double WHT (capped at 20%).
//
// All amounts are rounded to kobo (2dp) per line, and invoice totals are the sum of rounded lines, so the
// printed invoice always foots exactly.

const { getSettings } = require('./db');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// category -> tax treatment. `vat: true` = standard-rated. `wht` = settings key for the WHT rate (or null).
const CATEGORIES = {
  rental:   { label: 'Equipment hire',          vat: true,  wht: 'wht_rate_rental' },
  fee:      { label: 'Ancillary hire charge',   vat: true,  wht: 'wht_rate_rental' },   // late / waiver / rush fees follow the hire
  service:  { label: 'Crew / technical service', vat: true, wht: 'wht_rate_services' },
  goods:    { label: 'Goods (consumables)',     vat: true,  wht: 'wht_rate_goods' },
  recovery: { label: 'Loss / damage recovery',  vat: false, wht: null },                 // outside scope of VAT
};

function taxConfig(settings) {
  const s = settings || getSettings();
  const num = (k, d) => { const v = parseFloat(s[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    vatRegistered: s.vat_registered !== '0',
    vatRate: num('vat_rate', 7.5),
    wht: {
      wht_rate_rental: num('wht_rate_rental', 10),
      wht_rate_services: num('wht_rate_services', 5),
      wht_rate_goods: num('wht_rate_goods', 2),
    },
    noTinMultiplier: num('wht_no_tin_multiplier', 2),
  };
}

/**
 * Price one invoice line. `net` is the VAT-exclusive amount.
 * @returns {{category, net, vat_rate, vat_amount, wht_rate, wht_amount}}
 */
function priceLine({ category, net }, cfg, { whtAgent = false } = {}) {
  const cat = CATEGORIES[category] || CATEGORIES.rental;
  const amount = r2(net);
  const vat_rate = cfg.vatRegistered && cat.vat ? cfg.vatRate : 0;
  const vat_amount = r2(amount * vat_rate / 100);
  // Expected WHT is computed on the VAT-exclusive amount and only when the customer is a withholding agent.
  const wht_rate = whtAgent && cat.wht ? cfg.wht[cat.wht] : 0;
  const wht_amount = r2(amount * wht_rate / 100);
  return { category: category in CATEGORIES ? category : 'rental', net: amount, vat_rate, vat_amount, wht_rate, wht_amount };
}

function totals(lines) {
  let net = 0, vat = 0, wht = 0, taxable = 0, outside = 0;
  for (const l of lines) {
    net += l.net; vat += l.vat_amount; wht += l.wht_amount;
    if (l.vat_rate > 0) taxable += l.net; else outside += l.net;
  }
  net = r2(net); vat = r2(vat); wht = r2(wht);
  return { net, vat, wht, taxable: r2(taxable), outside: r2(outside), gross: r2(net + vat) };
}

/** WHT rate we must apply when WE pay a vendor. No TIN => doubled, capped at 20%. */
function vendorWhtRate(category, hasTin, cfg) {
  const key = { rent: 'wht_rate_rental', hire: 'wht_rate_rental', services: 'wht_rate_services', goods: 'wht_rate_goods' }[category];
  const base = key ? cfg.wht[key] : 0;
  return hasTin ? base : Math.min(20, base * cfg.noTinMultiplier);
}

// Filing deadline for a calendar month: the 21st of the following month.
function dueDateFor(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 21)); // month index m == next month
  return d.toISOString().slice(0, 10);
}

function validTin(tin) {
  // Nigerian TINs are typically 8–14 digits (JTB 10-digit / NRS unified ID, sometimes with a "-0001" suffix).
  return /^[0-9]{8,14}(-[0-9]{4})?$/.test(String(tin || '').trim());
}

module.exports = { r2, CATEGORIES, taxConfig, priceLine, totals, vendorWhtRate, dueDateFor, validTin };
