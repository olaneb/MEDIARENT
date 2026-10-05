// Minimal tabular PDF writer (zero dependencies). Produces a paginated A4 report with a branded header,
// column headings repeated on every page, right-aligned numeric columns, totals row and page numbers.
// Uses the PDF base-14 Helvetica fonts (WinAnsi), so no font embedding is needed.

const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

// Map text to printable WinAnsi-safe ASCII.
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/₦/g, 'NGN ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/×/g, 'x').replace(/…/g, '...')
    .replace(/•/g, '-').replace(/→/g, '->').replace(/≥/g, '>=').replace(/≤/g, '<=')
    .normalize('NFKD').replace(/[^\x20-\x7E]/g, '');
}
function width(s, size, bold) { let w = 0; for (const ch of s) { const c = ch.charCodeAt(0); w += (c >= 32 && c <= 126 ? HELV[c - 32] : 556); } return w * size / 1000 * (bold ? 1.06 : 1); }
function fit(s, maxW, size, bold) {
  s = clean(s); if (width(s, size, bold) <= maxW) return s;
  while (s.length > 1 && width(s + '...', size, bold) > maxW) s = s.slice(0, -1);
  return s + '...';
}
const pdfStr = (s) => '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
function hexToRgb(hex) { const n = parseInt(String(hex || '#E8630A').replace('#', ''), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(v => v.toFixed(3)).join(' '); }

/**
 * opts: { title, subtitle, company, columns: [{ header, type, align }], rows: [[...]], totals?: [...], accent?: '#hex', orientation?: 'landscape'|'portrait', notes?: [string] }
 */
function buildPdf(opts) {
  const land = (opts.orientation || (opts.columns.length > 6 ? 'landscape' : 'portrait')) === 'landscape';
  const W = land ? 842 : 595, H = land ? 595 : 842, M = 36;
  const fs = opts.columns.length > 9 ? 7 : 8.5, rowH = fs + 6;
  const usable = W - M * 2;
  const isNum = (c) => ['money', 'number', 'integer'].includes(c.type);
  const fmt = (v, c) => {
    if (v === null || v === undefined || v === '') return '';
    if (c.type === 'money' && Number.isFinite(Number(v))) return Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (c.type === 'integer' && Number.isFinite(Number(v))) return Number(v).toLocaleString('en-NG');
    if (c.type === 'number' && Number.isFinite(Number(v))) return Number(v).toLocaleString('en-NG', { maximumFractionDigits: 4 });
    return String(v);
  };
  // Column widths proportional to content length, numeric columns get a minimum.
  const sample = opts.rows.slice(0, 300);
  const est = opts.columns.map((c, i) => Math.max(width(clean(c.header), fs, true), ...sample.map(r => width(clean(fmt(r[i], c)), fs, false)), isNum(c) ? 50 : 30) + 10);
  const sum = est.reduce((a, b) => a + b, 0);
  const widths = est.map(w => w * usable / sum);
  const pages = []; let ops = []; let y = 0; let pageNo = 0;
  const accent = hexToRgb(opts.accent);
  const text = (x, yy, s, size, bold, rgb) => ops.push(`BT ${rgb || '0.1 0.1 0.1'} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td ${pdfStr(s)} Tj ET`);
  const rect = (x, yy, w, h, rgb) => ops.push(`${rgb} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  const line = (x1, y1, x2, y2, rgb, lw) => ops.push(`${rgb || '0.8 0.8 0.8'} RG ${lw || 0.5} w ${x1} ${y1} m ${x2} ${y2} l S`);
  const drawRow = (vals, bold, fill) => {
    if (fill) rect(M, y - 3, usable, rowH, fill);
    let x = M;
    opts.columns.forEach((c, i) => {
      const s = fit(fmt(vals[i], c), widths[i] - 8, fs, bold);
      const right = c.align === 'right' || (isNum(c) && c.align !== 'left');
      const tx = right ? x + widths[i] - 4 - width(s, fs, bold) : x + 4;
      text(tx, y, s, fs, bold);
      x += widths[i];
    });
    y -= rowH;
  };
  const header = () => {
    pageNo++; ops = [];
    rect(0, H - 6, W, 6, accent);
    text(M, H - M - 4, fit(opts.company || '', usable * 0.6, 9, true), 9, true, '0.35 0.35 0.35');
    text(M, H - M - 22, fit(opts.title || 'Report', usable, 15, true), 15, true);
    if (opts.subtitle) text(M, H - M - 36, fit(opts.subtitle, usable, 9, false), 9, false, '0.4 0.4 0.4');
    y = H - M - 56;
    drawRow(opts.columns.map(c => c.header), true, '0.92 0.92 0.92');
    line(M, y + rowH - 3, W - M, y + rowH - 3, accent, 1);
  };
  const footer = () => {
    line(M, M - 2, W - M, M - 2);
    text(M, M - 14, clean(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`), 7, false, '0.5 0.5 0.5');
    pages.push({ ops, pageNo });
  };
  header();
  if (!opts.rows.length) { text(M + 4, y, 'No data for the selected criteria.', fs, false, '0.4 0.4 0.4'); y -= rowH; }
  opts.rows.forEach((r, idx) => {
    if (y < M + 20) { footer(); header(); }
    drawRow(r, false, idx % 2 ? '0.975 0.975 0.975' : null);
  });
  if (opts.totals) {
    if (y < M + 30) { footer(); header(); }
    line(M, y + rowH - 2, W - M, y + rowH - 2, '0.2 0.2 0.2', 0.8);
    drawRow(opts.totals, true);
  }
  for (const n of (opts.notes || [])) {
    if (y < M + 20) { footer(); header(); }
    y -= 4; text(M, y, fit(n, usable, 7.5, false), 7.5, false, '0.35 0.35 0.35'); y -= 11;
  }
  footer();
  const total = pages.length;
  // ---- assemble objects ----
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalogId = add(null), pagesId = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const p of pages) {
    const num = `BT 0.5 0.5 0.5 rg /F1 7 Tf ${(W - M - width(`Page ${p.pageNo} of ${total}`, 7)).toFixed(2)} ${M - 14} Td (Page ${p.pageNo} of ${total}) Tj ET`;
    const stream = p.ops.join('\n') + '\n' + num;
    const cId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cId} 0 R >>`));
  }
  objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Producer (MediaRent Portal) /Title ${pdfStr(clean(opts.title || 'Report'))} >>`);
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

module.exports = { buildPdf, clean };
