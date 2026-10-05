// White-label branding helpers: public brand payload, logo decoding/validation.
const { getSettings } = require('./db');

const LOGO_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif',
};
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

function parseDataUrl(dataUrl) {
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const contentType = m[1].toLowerCase();
  if (!LOGO_TYPES[contentType]) return null;
  return { contentType, ext: LOGO_TYPES[contentType], buffer: Buffer.from(m[2], 'base64') };
}

function validateLogo(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return { error: 'Logo must be a PNG, JPG, WEBP, GIF or SVG image' };
  if (parsed.buffer.length > MAX_LOGO_BYTES) return { error: 'Logo must be 2 MB or smaller' };
  if (parsed.contentType === 'image/svg+xml') {
    const svg = parsed.buffer.toString('utf8');
    if (/<script|on\w+\s*=|javascript:|data:text\/html|<foreignObject|<iframe|<embed|<object|<!ENTITY|@import|<link|<meta/i.test(svg)) return { error: 'SVG logo contains scripts or event handlers — please export a clean SVG or use PNG' };
  }
  return { parsed };
}

function getLogo() {
  const s = getSettings();
  return s.brand_logo ? parseDataUrl(s.brand_logo) : null;
}

function isHexColor(c) { return /^#[0-9a-f]{6}$/i.test(c || ''); }

// Black or white text, whichever has the better WCAG contrast against `hex`.
function readableOn(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#111111' : '#FFFFFF';
}

// Safe-to-expose branding (no auth required — the login screen needs it).
function publicBranding() {
  const s = getSettings();
  return {
    portal_name: s.portal_name || 'MediaRent',
    portal_tagline: s.portal_tagline || '',
    company_name: s.company_name || '',
    primary_color: isHexColor(s.brand_primary_color) ? s.brand_primary_color : '#E8630A',
    secondary_color: isHexColor(s.brand_secondary_color) ? s.brand_secondary_color : '',
    has_logo: !!s.brand_logo,
    vat_registered: s.vat_registered !== '0',
    logo_url: s.brand_logo ? `/api/branding/logo?v=${s.brand_logo_version || '0'}` : null,
    show_powered_by: s.show_powered_by !== '0',
    login_hint: s.login_hint || '',
    currency: s.currency || 'NGN',
  };
}

module.exports = { readableOn, parseDataUrl, validateLogo, getLogo, publicBranding, isHexColor, MAX_LOGO_BYTES };
