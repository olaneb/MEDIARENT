#!/bin/sh
# Container entrypoint for Fly.io.
#  1. Fly mounts the volume at /data owned by root -> hand it to the unprivileged `node` user.
#  2. Optional demo data: if SEED_DEMO_DATA=1 and the database does not exist yet, load the demo company once.
#  3. Drop privileges and start the app (exec, so signals reach Node for a graceful shutdown).
set -e
DATA="${MEDIRENT_DATA_DIR:-/data}"
mkdir -p "$DATA"

run_as_node() {
  if [ "$(id -u)" = "0" ]; then setpriv --reuid=node --regid=node --init-groups "$@"; else "$@"; fi
}

if [ "$(id -u)" = "0" ]; then chown -R node:node "$DATA"; fi

if [ "${SEED_DEMO_DATA:-0}" = "1" ] && [ ! -f "$DATA/medirent.db" ]; then
  echo "SEED_DEMO_DATA=1 and no database found: loading demo data (one-off)..."
  run_as_node node scripts/seed-test-data.js || echo "Demo seeding failed - starting with an empty database instead."
fi

if [ "$(id -u)" = "0" ]; then exec setpriv --reuid=node --regid=node --init-groups "$@"; fi
exec "$@"
