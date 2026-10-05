// Minimal Office Open XML spreadsheet writer + reader (zero dependencies — node:zlib only).
// Writer: one or more sheets, bold header row, number formats for money/integers, frozen header, column widths.
// Reader: first worksheet (or a named one) -> 2-D array of values; handles shared strings, inline strings,
// booleans and numbers. Dates stored as serial numbers are returned as numbers — use excelDate() to convert.
const zlib = require('zlib');

const crc32 = zlib.crc32 || ((buf) => { // fallback for runtimes without zlib.crc32
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xFFFFFFFF) >>> 0;
});

// ---------------- ZIP ----------------
function zip(files) { // files: [{ name, data: Buffer|string }]
  const locals = []; const centrals = []; let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

function unzip(buf) { // -> { name: Buffer }
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found)');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt .xlsx file');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const raw = buf.slice(start, start + csize);
    out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// ---------------- WRITER ----------------
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

/**
 * sheets: [{ name, title?, subtitle?, columns: [{ header, type: 'text'|'money'|'number'|'integer'|'date', width? }], rows: [[...]], totals?: [...] }]
 */
function buildXlsx(sheets) {
  const STYLE = { text: 0, header: 1, money: 2, integer: 3, number: 4, title: 5, total_money: 6, date: 0, sub: 7, total_text: 8 };
  const sheetXml = sheets.map((sh) => {
    const rowsXml = []; let r = 0;
    const cell = (ci, v, style, type) => {
      const ref = colName(ci) + (r + 1);
      if (v === null || v === undefined || v === '') return `<c r="${ref}" s="${style}"/>`;
      const numeric = ['money', 'integer', 'number'].includes(type) && v !== '' && Number.isFinite(Number(v));
      if (numeric) return `<c r="${ref}" s="${style}"><v>${Number(v)}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    };
    if (sh.title) { rowsXml.push(`<row r="${r + 1}">${cell(0, sh.title, STYLE.title, 'text')}</row>`); r++; }
    if (sh.subtitle) { rowsXml.push(`<row r="${r + 1}">${cell(0, sh.subtitle, STYLE.sub, 'text')}</row>`); r++; }
    if (sh.title || sh.subtitle) { r++; }
    const headerRow = r;
    rowsXml.push(`<row r="${r + 1}">${sh.columns.map((c, i) => cell(i, c.header, STYLE.header, 'text')).join('')}</row>`); r++;
    for (const row of sh.rows) {
      rowsXml.push(`<row r="${r + 1}">${sh.columns.map((c, i) => cell(i, row[i], STYLE[c.type] ?? 0, c.type)).join('')}</row>`); r++;
    }
    if (sh.totals) {
      rowsXml.push(`<row r="${r + 1}">${sh.columns.map((c, i) => cell(i, sh.totals[i], ['money', 'number', 'integer'].includes(c.type) ? STYLE.total_money : STYLE.total_text, c.type)).join('')}</row>`); r++;
    }
    const cols = sh.columns.map((c, i) => {
      const longest = Math.max(String(c.header).length, ...sh.rows.slice(0, 500).map(row => String(row[i] == null ? '' : row[i]).length));
      const w = c.width || Math.min(60, Math.max(8, longest + 2));
      return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow + 1}" topLeftCell="A${headerRow + 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols><sheetData>${rowsXml.join('')}</sheetData></worksheet>`;
  });
  const safeName = (n, i) => (String(n || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`);
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>MediaRent Portal</Application></Properties>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"/><bottom style="double"/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    ...sheetXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
  ];
  return zip(files);
}

// ---------------- READER ----------------
const unEsc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&');
function textOf(xml) { // concatenates every <t>…</t> run
  let out = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g; let m;
  while ((m = re.exec(xml))) out += m[1] ? unEsc(m[1]) : '';
  return out;
}
function colIndex(ref) { const letters = ref.replace(/[0-9]/g, ''); let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

function readXlsx(buf, sheetName) {
  const files = unzip(buf);
  const get = (n) => files[n] ? files[n].toString('utf8') : null;
  const wb = get('xl/workbook.xml'); if (!wb) throw new Error('Not a valid .xlsx file (no workbook)');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const sheets = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)].map(m => ({ name: unEsc(m[1]), rid: m[2] }));
  const pick = (sheetName && sheets.find(s => s.name.toLowerCase() === String(sheetName).toLowerCase())) || sheets[0];
  if (!pick) throw new Error('Workbook has no sheets');
  const relM = new RegExp(`<Relationship\\b[^>]*Id="${pick.rid}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${pick.rid}"`).exec(rels);
  let target = relM ? relM[1] : 'worksheets/sheet1.xml';
  target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  const sheet = get(target); if (!sheet) throw new Error('Worksheet not found in workbook');
  const ssXml = get('xl/sharedStrings.xml');
  const shared = ssXml ? [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1])) : [];
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    const body = rm[1] || '';
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]; const inner = cm[2] || '';
      const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const idx = ref ? colIndex(ref) : row.length;
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'str') val = v != null ? unEsc(v) : '';
      else if (t === 'b') val = v === '1';
      else if (v != null && v !== '') val = Number(v);
      row[idx] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    rows.push(row);
  }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// Excel serial date -> YYYY-MM-DD (1900 date system).
function excelDate(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  return v;
}

module.exports = { buildXlsx, readXlsx, excelDate, zip, unzip };
