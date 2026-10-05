# MediaRent — Media & Production Equipment Rental Portal

A vertical-specific fork of **EquipRent**, rebuilt for a camera/AV/production
equipment rental house rather than a heavy-equipment yard. Same zero-dependency
Node.js + `node:sqlite` foundation — nothing to `npm install`, no external
database to license or run.

**v1.3.0** adds a full IFRS accounting back-office (6-digit chart of accounts, period-end, report builder, Excel/PDF
exports), Nigeria Tax Act 2025 treatment, **NRS e-invoicing (MBS) integration**, legacy-balance import, multi-location,
condition photos, insurance claims, PDF agreements, a busier click-through dashboard and a collapsible menu — and ships
loaded with the **Nexthought Creative Hub** rate card (421 units, 24 categories, crew and studios). See
**What's new in v1.3.0** below and `docs/ACCOUNTING-AND-TAX.md` for the accounting and tax basis.

## Quick start

```bash
node server.js
```

Visit `http://localhost:3000`. Default admin login:

- **Email:** admin@medirent.local
- **Password:** Admin@12345 (you are forced to change it on first login)

(Existing installs are migrated automatically: `admin@equiprent.local` becomes
`admin@medirent.local`, and `data/equiprent.db` is renamed to `data/medirent.db`.)

## White-label, printing & email

Everything is configured in **Admin → White-label & settings**:

- **Branding** — upload a logo (PNG/JPG/WEBP/SVG, max 2 MB), set the portal
  name, tagline, client company name and brand colour. The logo and colour
  flow through the login page, sidebar, browser tab/favicon, printed invoices
  and invoice emails. The logo is stored in the database, so backups and
  restores carry it. The "Powered by Olans FIXZIT Concept" footer and the
  login-page credential hint can each be hidden (clear the hint before go-live).
- **Company & invoice** — address, phone, email, website, RC number, TIN,
  bank details and the footer note printed on every invoice.
- **Email (SMTP)** — works with Gmail/Google Workspace, Microsoft 365, Zoho,
  cPanel hosting mail, Brevo, Mailgun, SendGrid, etc. STARTTLS (587),
  SSL/TLS (465) or none (25). Gmail and Microsoft 365 need an *app password*.
  Includes a **Send test email** button and editable subject/message templates
  with `{customer_name}`, `{invoice_number}`, `{amount_due}`, `{grand_total}`,
  `{due_date}`, `{company_name}` placeholders. The saved password is never
  sent back to the browser or written to the audit log.
- **Tax (VAT / WHT)**, **Accounting & corporate tax**, **NRS e-invoicing**, **General** — see below.

**Font:** the whole portal, printed invoices and emails use **Calibri**. On
Windows/Office machines the installed Calibri is used; elsewhere the bundled
Carlito (a metric-compatible, OFL-licensed Calibri clone in `public/fonts/`)
stands in, so layouts look identical.

**Invoices** — from Billing (or any booking/customer), each invoice has:

- **Print** — opens a branded A4 invoice and the print dialog; choose
  *Save as PDF* to get a PDF.
- **Email** — pre-fills the customer's email address (editable, with Cc),
  subject and message, then sends the branded invoice in the email body with
  the logo embedded, plus a printable copy attached. Every send (or failure,
  with the server's reason) is logged under **Email history** on the invoice
  and in the audit log. Requires the `invoices.edit` permission (Admin,
  Finance Manager, Accountant).

Zero dependencies still holds — the SMTP client (`lib/mailer.js`) is built on
Node's own `net`/`tls` modules.

## Deploying online (Fly.io)

The portal ships ready for **Fly.io**: `Dockerfile`, `fly.toml`, a persistent `/data` volume for the database and
backups, an HTTPS-only service and a health check. Step-by-step instructions (including backups, custom domains and
running several clients) are in **DEPLOY.md**. In short:

```bash
fly launch --no-deploy --copy-config --name your-portal
fly volumes create medirent_data --size 1 --region jnb
fly deploy --ha=false
```

## What's different from EquipRent

This was built by researching what actually matters in camera/AV rental
software (kit-based booking, serialized asset tracking, prep/QC workflows,
crew scheduling, and damage/replacement handling all came up as the features
that separate real AV rental tools from a generic equipment tracker) and
adding each of them on top of the existing finance, maintenance, and admin
foundation:

- **Kits** — bundle equipment into a package (e.g. "Documentary Kit",
  "Wedding Kit") that books as one unit. A kit is only offered as available
  when *every* component unit is free for the requested dates — checked
  live against each item's own booking history, not a shared quantity count.
- **Production context on every booking** — project/production name,
  production type (Film, Commercial, Wedding, Corporate, Music Video,
  Photography, Broadcast), and shoot location, because media rental houses
  book against a job, not just a customer and a date range.
- **Prep/QC checklists per category** — each equipment category (Camera
  Bodies, Lenses, Lighting, Audio, Grip & Support, Drones, Monitors & Video)
  carries its own checklist (format cards, check battery health, clean
  sensor, calibrate compass, etc.), confirmed at checkout and check-in.
- **Serialized tracking** — a `serial_number` field per unit, separate from
  the internal asset code, for insurance and manufacturer-service purposes.
- **Damage waivers** — a booking can opt into a waiver fee that caps
  accidental-damage liability. Deliberately, a waiver **never** covers a
  lost or stolen unit — that's standard practice in AV/camera rental and is
  enforced in the invoicing logic, not just the paperwork.
- **Lost-item billing** — checking an item in as lost bills the customer at
  that unit's full **replacement value** instead of a damage charge, pulls
  the unit from the available pool, and flags it in System Health for
  write-off or insurance resolution until someone resolves it.
- **Consumables** — media cards, batteries, cables, gaffer tape: a separate
  catalog from spare-parts (which stays maintenance-only), issued against a
  booking, billed as used rather than checked back in, with its own
  reorder-level tracking.
- **Crew scheduling** — book crew (camera operator, gaffer, sound mixer,
  drone pilot, etc.) alongside the gear for a production, with day rate and
  day count captured against the same booking.
- **Certificate of Insurance (COI) tracking** — many rental houses require a
  valid COI before handing out expensive gear. Customers carry a COI-on-file
  flag and expiry date, shown on the booking screen, and System Health flags
  any customer with an active or upcoming booking whose COI is missing or
  expired.
- **Rush fees** — a same-day/rush-booking surcharge line, separate from the
  rate card.

Everything from EquipRent carries over unchanged: the double-entry GL,
maker-checker payment vouchers, RBAC, audit log, and portal maintenance
(system health, integrity-verified backup/restore, maintenance mode).

## What's new in v1.3.0

### Dashboard & navigation
- **Busier dashboard** — 18 live KPI tiles in four bands (money, tax, fleet, bookings): revenue month / YTD, profit,
  cash & bank, receivables, payables, VAT payable, WHT credits, deposits held, utilisation, available, in maintenance,
  lost, fleet replacement value, on hire, overdue, pick-ups, returned-not-invoiced. Plus a 12-month revenue vs cash chart
  (hover tooltips), receivables ageing with the IFRS 9 ECL check, a **Needs attention** task list, returns and pick-ups
  due, top customers / equipment, revenue mix, fleet by category, bookings by production type, units by location and the
  recent audit trail. Tiles shown depend on the user's role (Dispatch sees operations only).
- **Everything is clickable to its source** — a tile opens the filtered list or report behind it (overdue tile → overdue
  bookings, receivables → ageing report → customer, cash → bank GL ledger → journal entry → originating invoice/voucher,
  chart bar → that month's revenue breakdown, task → the approval queue).
- **Collapsible sidebar** — collapse to an icon rail with the arrow button (remembered per browser), fold menu groups
  (Operations / Finance / System), off-canvas menu on phones.

### Nexthought rate card loaded
`scripts/data/nexthought-rate-card.json` was extracted from the Nexthought rate card PDF: **329 priced lines /
421 units in 24 categories** (cameras, PL & E-mount lenses, LED/tungsten/HMI lighting, grip & cranes, power, wireless
video, textiles…), **crew day rates** (7 roles, operator-inclusive items flagged), **studios** (Broadway & Olympea with
₦200k caution fees, West Wing & Makeshift ₦50k), and the **20% cancellation fee**. The rate card has no replacement or
cost values, so these are estimated (replacement ≈ 26 × day rate, cost 82% of replacement) and flagged for the client
to correct — every assumption is listed inside the JSON file.

### Accounting (IFRS)
- **6-digit chart of accounts** (class 1 assets … 8 taxation; headers are non-posting; e.g. `101000` Cash on hand,
  `111000` Trade receivables, `151000` Rental equipment at cost, `401000` Equipment rental income). Existing 4-digit
  databases are renumbered automatically, history kept. **Add / edit / deactivate GLs** in Accounting → Chart of
  accounts (system accounts are protected; codes must be 6 digits in the right class).
- **IFRS treatments built in** — rental income under IFRS 16 (lessor), services & goods under IFRS 15, straight-line
  monthly depreciation (IAS 16) with disposal/write-off, compensation for lost items as separate income (IAS 16.65),
  IFRS 9 ECL provision matrix, accrual-basis vendor bills, month-end unbilled-rental accrual (auto-reversing), IAS 2
  stock (consumables and spares) with cost of sales, deposits/caution fees held as liabilities.
- **Accounting → Journals** (maker-checker manual journals, reversals), **Period-end** (depreciation run, accruals, ECL,
  corporate-tax provision, year-end close to retained earnings, **period lock**).
- Financial statements by IFRS line: profit or loss (by function, IAS 1), financial position, trial balance, GL.

### Nigerian tax & NRS e-invoicing
- **Nigeria Tax Act 2025**: VAT 7.5% with input VAT recovery on services and fixed assets; small-company test (turnover
  ≤ ₦100m and fixed assets ≤ ₦250m → 0% CIT and no development levy); CIT 30% and 4% development levy (configurable);
  2024 WHT Regulations (rent/hire 10%, services 5%, goods 2%, doubled for a payee without TIN); returns due the 21st.
- **NRS e-invoicing (Merchant Buyer Solution) ready** — Admin → Settings → *NRS e-invoicing*: mode **off / simulator /
  live**, Access-Point-Provider base URL and keys (never shown back), business ID, 8-character service ID, auto-submit.
  Each invoice gets an **IRN** (`INV-no–ServiceID–YYYYMMDD`), is validated, signed and transmitted (B2B/B2G clearance,
  B2C reporting), and prints with the **NRS QR code**, IRN and CSID. Voiding a cleared invoice issues a **credit note
  (type 381)**. Billing → *NRS e-invoice queue* shows readiness, rejected invoices with the reason, and "submit all
  pending". Start in *simulator* until your APP issues live credentials.

### Legacy data, exports, reports
- **Accounting → Legacy data import** (CSV or Excel, template download for each): opening trial balance, customer
  balances (open invoices), supplier balances (open bills), equipment register with accumulated depreciation,
  customers, consumable stock, crew rates. Every file is **validated first** (bad codes, 4-digit codes mapped, imbalance,
  duplicates) — nothing is saved until you import; each import is one batch that can be reversed.
- **Exports** — every report downloads as **Excel (.xlsx)**, **PDF** and **CSV**; booking agreements as PDF; invoices as
  NRS JSON.
- **Reports** — 17 standard reports (TB, P&L, financial position, GL, journal register, cash book, AR/AP ageing, VAT and
  WHT schedules, revenue disaggregation, revenue by customer, utilisation, fixed-asset register, bookings register,
  deposits held, e-invoice register) and a **report builder**: pick a data source (13), columns, filters, grouping and
  totals; save, share and export.

### Operations
Multi-location (stores/studios, transfers), condition **photo upload** at checkout/check-in, **insurance claims**
tracker (lost/damaged → claim → approved → settled, posted to the ledger), **PDF/printable rental agreements**,
cancellation with the rate-card fee (waivable with reason), caution-fee deposits defaulted from the item.

### Roles (segregation of duties)
13 roles: Admin, Managing Director (final approver), Finance Manager (level-1 approver), Accountant (maker), Tax &
Compliance Officer, Operations, Studio Manager, Dispatch, Store Keeper, Maintenance, Sales, Auditor (read-only
including ledger/audit), Viewer. Existing users were re-assigned (old *Finance* users split into Finance Manager or
Accountant) and new users were added where a role had no one in it. Roles and permissions are editable in Admin → Roles.

## Testing

```bash
npm test          # 190 back-end end-to-end checks (seeds a throw-away DB; ledger, tax, NRS, imports, roles, upgrade)
npm run test:ui   # 58 browser checks with screenshots in docs/qc-evidence/screens (needs Playwright + Chromium)
npm run test:all
```

## Test data

The bundled `data/medirent.db` is pre-loaded (`npm run seed`) for **Nexthought Creative Hub** (test company — TINs and
bank details are dummies): the full rate card as the equipment register, 3 locations, 10 customers (including a
government MDA for B2G), a **legacy migration as at 30 June** (opening TB, open customer/supplier items, asset register
with accumulated depreciation, stock), then three months of trading (~100 bookings, 88 invoices cleared on the NRS simulator plus one rejected for the queue demo,
receipts with WHT, vendor bills through two-level vouchers, monthly depreciation, accruals, ECL, a manual journal, an
insurance claim, a write-off, a cancellation with fee) and live bookings on hire today. The trial balance and balance
sheet balance; the books are locked up to the end of the month before last. Dates are relative to the day you seed.

Logins — `admin@medirent.local` / `Admin@12345`. Everyone else uses `Welcome@123`. All are forced to change password on
first login (10+ characters with upper, lower and a number).

| User | Role | Email |
|---|---|---|
| Adaeze Okonkwo | Managing Director *(new)* | adaeze.md@medirent.local |
| Kemi Adewale | Finance Manager (was Finance) | kemi.finance@medirent.local |
| Segun Alabi | Accountant (was Finance) | segun.finance@medirent.local |
| Emeka Obi | Tax & Compliance Officer *(new)* | emeka.tax@medirent.local |
| Tunde Bakare | Operations | tunde.ops@medirent.local |
| Yinka Balogun | Studio Manager *(new)* | yinka.studio@medirent.local |
| Ifeoma Nwosu | Dispatch | ifeoma.dispatch@medirent.local |
| Sade Lawal | Store Keeper *(new)* | sade.store@medirent.local |
| Musa Ibrahim | Maintenance | musa.maintenance@medirent.local |
| Chiamaka Eze | Sales | chiamaka.sales@medirent.local |
| Femi Ojo | Auditor *(new)* | femi.audit@medirent.local |
| Bola Adeniran | Viewer | bola.viewer@medirent.local |

To wipe and start clean: stop the server, delete `data/`, restart (empty system with just the admin). Re-seed with
`npm run seed` (set `MEDIRENT_DATA_DIR` to seed elsewhere). **Do not seed a client's production database.**

## Making it the client's own (white-label in 2 minutes)

Admin → Settings → **Branding**: upload the logo (`samples/nexthought-logo.png` is the client's; `samples/demo-logo.svg`
is generic), set portal/company name, **brand colour** and optional **sidebar colour**. Then fill **Company & invoice**,
**Tax**, **Accounting & corporate tax** and **NRS e-invoicing**.

## What's next

Everything on the previous list — photo upload, agreement PDF, insurance claims and multi-location — is now built.
Remaining items, none of which block go-live:

- **Go live on NRS**: obtain production credentials from your chosen Access Point Provider, enter them in
  *NRS e-invoicing*, run **Test connection**, then switch from *simulator* to *live*. Field paths are configurable in
  case your APP's endpoints differ.
- **Confirm the estimated values** in the rate-card import (replacement value and cost per item) and the
  opening balances with the client's accountant before the first real period-end.
- **Tax adviser sign-off** on the points listed in `docs/ACCOUNTING-AND-TAX.md` §7 (small-company status, VAT on studio
  hire, development-levy application).
- Optional later: bank-statement import & reconciliation, payroll/PAYE, a customer self-service portal and online card
  payments.
