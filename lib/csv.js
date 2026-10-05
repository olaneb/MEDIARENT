// RFC 4180 CSV read/write (zero dependencies).

function toCsv(rows) {
  const q = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Leading BOM so Excel opens UTF-8 (₦, accents) correctly.
  return '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
}

function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let i = 0; let inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// Turns a 2-D array whose first row is headers into objects with normalised keys (lower_snake_case).
function rowsToObjects(rows) {
  if (!rows.length) return [];
  const keys = rows[0].map(h => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return rows.slice(1).map((r, idx) => {
    const o = { _row: idx + 2 };
    keys.forEach((k, i) => { if (k) o[k] = r[i] == null ? '' : (typeof r[i] === 'string' ? r[i].trim() : r[i]); });
    return o;
  });
}

module.exports = { toCsv, parseCsv, rowsToObjects };
