# Deploying MediaRent to Fly.io

MediaRent is a single Node.js process with an embedded SQLite database. Fly.io runs it as a container with a
**persistent volume** mounted at `/data`, so your data survives restarts and deploys. No external database, no Redis,
no npm install.

> **Why exactly one machine?** SQLite lives on one volume, and a volume attaches to one machine. Run **one** machine
> (scale *up*, not out). `fly.toml` and the commands below already assume this.

## What's included
| File | Purpose |
|---|---|
| `Dockerfile` | Node 22 image, no dependencies to install, runs as the unprivileged `node` user |
| `docker-entrypoint.sh` | Fixes volume permissions, optional first-boot demo data, drops privileges, graceful signals |
| `fly.toml` | App, `/data` volume, HTTPS-only, health check on `/api/health`, 1 × 512 MB machine |
| `.dockerignore` | Keeps `data/`, docs and secrets out of the image (**your database is never baked into the image**) |

## One-time setup

1. **Install and sign in** — <https://fly.io/docs/flyctl/install/>
   ```bash
   fly auth login
   ```
2. **Choose an app name and region.** Edit the top of `fly.toml`:
   ```toml
   app = "your-company-portal"     # must be globally unique -> your-company-portal.fly.dev
   primary_region = "jnb"          # run `fly platform regions` and pick the nearest to your users
   ```
3. **Create the app without deploying yet**
   ```bash
   fly launch --no-deploy --copy-config --name your-company-portal
   ```
   Answer **No** if it offers a Postgres/Redis database or to overwrite `fly.toml`.
4. **Create the data volume** (same region as `primary_region`):
   ```bash
   fly volumes create medirent_data --size 1 --region jnb
   ```
5. **Deploy a single machine**
   ```bash
   fly deploy --ha=false          # or: npm run deploy
   ```
6. **Open it**
   ```bash
   fly open
   ```
   Check `https://your-company-portal.fly.dev/api/health` → `{"ok":true,"storage":"local-disk"}`.

## First login
On an empty volume the portal creates one administrator: **admin@medirent.local / Admin@12345**. You are forced to
change the password on first login (10+ characters, upper, lower, number). Then:
1. **Admin → White-label & settings → Branding** — upload the client's logo, set colours and names.
2. **Company & invoice** and **Tax (VAT / WHT)** — company name/address, TIN, RC number, bank details, VAT status.
3. **Admin → Users** — create staff accounts and suspend/delete the starter admin email if you prefer.
4. **Email (SMTP)** — to email invoices. (SMTP settings are stored in the database, not in Fly secrets.)

### Demo / trial instance with sample data
To show the system with a fully populated fictional company, set this in `fly.toml` **before the first deploy** (or
`fly deploy` again after wiping the volume):
```toml
[env]
  SEED_DEMO_DATA = "1"
```
Demo data loads **once**, only when the volume has no database yet. **Never enable it for a real client**; remove the line
after the demo. Demo logins are listed in the README. Loading takes about a minute (three months of trading are posted
through the real API); the health check may report the app as starting during that minute.

## Custom domain
```bash
fly certs add portal.yourclient.com
fly certs show portal.yourclient.com     # shows the DNS records to create (A/AAAA or CNAME)
```
Fly issues and renews the HTTPS certificate automatically.

## Backups — set this up properly
Your data is only as safe as your backups. There are three layers:
1. **Built-in backups**: the app takes an integrity-checked snapshot **automatically every 24 hours** (and shortly after
   every restart/deploy if one is due) into `/data/backups`, pruning per the retention setting (Admin → System, default 30 days,
   never less than 7). Take extra ones on demand from the same screen. Change or disable the schedule with the
   `BACKUP_INTERVAL_HOURS` env var in `fly.toml` (`0` = off). **Download one regularly** (Admin → System → Download)
   and keep it off Fly (e.g. company Drive) — it is on the same volume, so it does not protect against losing the volume.
2. **Fly volume snapshots**: daily, kept for 14 days (`snapshot_retention` in `fly.toml`).
   ```bash
   fly volumes list
   fly volumes snapshots list <volume-id>
   fly volumes snapshots create <volume-id>     # take one right before risky changes
   ```
   Restore by creating a new volume from a snapshot: `fly volumes create medirent_data --snapshot-id <id> --region jnb`
   (then redeploy so the machine mounts it).
3. **A volume is not replicated across machines or regions.** Treat layer 1 as your off-site copy.

## Moving existing data onto Fly (e.g. from a local PC)
The app restores from any `.db` file in `/data/backups`.
```bash
fly ssh sftp shell
> put ./data/medirent.db /data/backups/medirent-import.db
> quit
```
Then sign in as admin → **Admin → System → Backups → Restore** `medirent-import.db`. A safety backup of the current
state is taken automatically before the restore.

## Updating the app
```bash
git pull          # or copy the new version over
fly deploy --ha=false
```
Database upgrades run automatically at start-up and are idempotent. A short restart is normal (the old process finishes
requests, closes the database, then the new one starts).

### Upgrading from v1.2.x to v1.3.0
1. **Take a backup first** (Admin → System → Create backup, then download it) — v1.3.0 renumbers the chart of accounts.
2. Deploy. On first start the portal: converts 4-digit GL codes to 6-digit codes **in place** (journal history,
   balances and account ids are kept — e.g. `1000 Cash` → `101000`, `1100 Receivables` → `111000`), adds the new
   tables (locations, photos, claims, e-invoice log, import batches, saved reports, manual journals), installs the new
   roles, and moves users of the old *Finance* role to **Finance Manager** (if they ever approved a voucher) or
   **Accountant**. Check Admin → Users afterwards.
3. Fill in **Admin → Settings → NRS e-invoicing** (start in *simulator* mode) and **Accounting** (financial year, CIT,
   ECL rates), then load legacy balances under **Accounting → Legacy data import** if you are migrating.

## Running several clients (white-label resellers)
Give **each client their own Fly app and volume** — their data is then fully isolated and each gets its own logo,
colours, domain and backups. Copy `fly.toml` to `fly.<client>.toml`, change `app` (and the volume name/region if you
like), then:
```bash
fly launch --no-deploy --copy-config -c fly.<client>.toml
fly volumes create medirent_data --size 1 --region jnb -a <client-app>
fly deploy --ha=false -c fly.<client>.toml
```

## Operations cheat-sheet
```bash
fly status                       # machine state and health checks
fly logs                         # live logs
fly ssh console                  # shell inside the machine (data is in /data)
fly machine restart              # restart without redeploying
fly scale memory 1024            # more RAM if ever needed (scale UP; keep 1 machine)
fly volumes extend <volume-id> -s 3    # grow the volume to 3 GB
```
Cost control: `fly.toml` keeps the machine always on (`auto_stop_machines = "off"`) so sessions and background tasks stay
consistent. For a low-traffic internal tool you may set it to `"stop"` to save money, at the cost of a few seconds'
cold start on the first request after idle time.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `fly deploy` creates 2 machines | You omitted `--ha=false`. Run `fly machine list` and `fly machine destroy <id>` on the extra one (SQLite needs a single machine). |
| "unable to open database file" / permission errors | Volume not created or not mounted. `fly volumes list` must show `medirent_data` in the app's region; names in `fly.toml` and the volume must match. |
| Health check failing after deploy | `fly logs`. The check calls `/api/health`, which queries the database. Look for a start-up error. |
| Everyone signed out after a deploy | Sessions are stored in the database on the volume, so this only happens if the volume was replaced. |
| "MediaRent needs Node.js 22.13 or newer" | Only if you change the Docker base image — keep `node:22-slim` or newer. |
| Locked out of admin | Wait out the lockout (default 15 min). If the password is lost: `fly ssh console`, then `node -e "…"` to reset, or restore a backup. |
| Demo data didn't appear | `SEED_DEMO_DATA` only seeds when `/data/medirent.db` doesn't exist yet. |

## Security notes
- HTTPS is enforced by Fly (`force_https`); session cookies are `Secure`, `HttpOnly`, `SameSite=Strict`.
- The app sets CSP, X-Frame-Options and related headers; logins lock after repeated failures.
- No secrets are required in `fly.toml`. If you later add any, use `fly secrets set` — never commit them.
- Keep Fly access (`fly orgs`) limited to people who may see client financial data.

## Run it locally / in Docker
```bash
node server.js                                   # http://localhost:3000, data in ./data
docker build -t medirent .
docker run -p 8080:8080 -v medirent_data:/data medirent     # http://localhost:8080
```
