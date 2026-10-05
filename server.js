// Entry point:  node server.js   (local, VPS, Docker, Fly.io)
const http = require('http');
const { handle } = require('./lib/app');
const { close: closeDb } = require('./lib/db');
const backups = require('./lib/backup-scheduler');

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Internal server error' })); }
  });
});

const PORT = process.env.PORT || 3000;
// 0.0.0.0 so the container is reachable through Fly's proxy (localhost-only would not be).
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => console.log(`MediaRent portal running on http://${HOST}:${PORT}`));

backups.start();

// Fly sends SIGINT/SIGTERM on deploys, scale-downs and restarts: finish in-flight requests,
// close the database cleanly, then exit before Fly's kill timeout.
let stopping = false;
function shutdown(signal) {
  if (stopping) return; stopping = true;
  console.log(`${signal} received — shutting down`);
  server.close(() => { closeDb(); process.exit(0); });
  setTimeout(() => { closeDb(); process.exit(0); }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
