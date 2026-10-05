// QR code → SVG (zero dependencies; encoder vendored from Kazuhiko Arase's MIT-licensed QRCode for JavaScript).
const QRCode = require('./vendor/qrcode');
const ECL = require('./vendor/qrcode/QRErrorCorrectLevel');

function qrSvg(text, { size = 132, margin = 2, dark = '#000', light = '#fff' } = {}) {
  const qr = new QRCode(-1, ECL.M);
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const total = n + margin * 2;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + margin},${r + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

module.exports = { qrSvg };
