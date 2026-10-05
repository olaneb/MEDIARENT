# MediaRent portal — QC report, Nigerian tax compliance & test results

## v1.3.0 (October 2026) — this release

**Build reviewed:** `medirent-portal-v1.2.1-flyio.zip` → **delivered as v1.3.0**.
**Tests:** `npm test` → **190 passed, 0 failed** · `npm run test:ui` → **58 passed, 0 failed** (Chromium, 43 screenshots in
`docs/qc-evidence/screens/`, no JavaScript errors or CSP violations). Both suites seed a throw-away database; the
back-end suite recomputes the ledger, VAT/WHT and report totals independently, and also upgrades a real v1.2.1
database (4-digit chart of accounts) to prove the migration.

### What was QC'd end to end
Login & forced password change · dashboard tiles and every drill-through · sidebar collapse · every page for every
role · bookings (availability, kits, crew, cancellation fee, photos, agreement PDF) · check-out/in incl. lost and
damaged · invoices (VAT/WHT arithmetic, NRS clearance, credit notes) · receipts and reversals · bills and two-level
vouchers · manual journals · depreciation, accruals, ECL, tax provision, year-end close and period lock · legacy import
(validation, commit, reversal, lock) · 17 reports × Excel/PDF/CSV · report builder (incl. SQL-injection attempts) ·
roles and segregation of duties · backup/restore · upgrade from v1.2.1.

### Gaps found and fixed in this round
| # | Gap | Fix |
|---|---|---|
| 1 | **Booking availability returned no units at all** when nothing was booked (`NOT IN (NULL)` in SQL) — pre-existing | Fixed; regression test added |
| 2 | Voucher approval buttons were checked against the wrong role field, so approvers sometimes saw no button | Uses the configured level roles + the user's role |
| 3 | One *Finance* role could raise **and** approve payments | Split into Accountant (maker) / Finance Manager (L1) / Managing Director (L2); approver roles configurable |
| 4 | Equipment edit could set status to *on rent / reserved / lost* by hand, bypassing the booking and ledger | Blocked; those states only come from bookings / check-in |
| 5 | Expenses recognised only when paid (cash basis); no input VAT on services/assets; no accruals or depreciation postings | Accrual bills, NTA 2025 input VAT, monthly depreciation and accrual runs |
| 6 | Postings could be made into closed months | Period lock enforced in the ledger for every posting path, incl. imports |
| 7 | Depreciation kept running in the month an asset was written off | Stops at disposal (IAS 16) |
| 8 | Unbalanced opening-balance file returned "already imported" instead of the real error | Validation errors are reported first |
| 9 | A saved report with only grouping/totals crashed the builder screen | Definitions are normalised on load and save |
| 10 | Settings saved from two tabs could overwrite each other | Settings tabs share one form state |
| 12 | Managing Director and Auditor had audit-log rights but no menu to reach the log | Admin menu now shows them an audit-only view |
| 11 | No exports beyond CSV; no photos, claims, agreements PDF, locations ("What's next" in README) | All built — see README |

### Still to confirm (not defects)
NRS *live* credentials from an Access Point Provider; rate-card replacement/cost estimates; the tax points in
`docs/ACCOUNTING-AND-TAX.md` §7.

---

## v1.2.1 — previous QC (kept for the record)

**Build reviewed:** `medirent-portal (2).zip` (v1.1.0) → **delivered as v1.2.1**
**Method:** full code read (all 11 route modules, ledger, auth, front-end), then *evidence first*: 22 suspected defects were
probed against the **unmodified original build** (`docs/qc-evidence/`) before anything was changed. Fixes were then verified by an
automated suite (123 back-end checks, 44 browser checks) that recomputes tax and ledger figures independently of the app.

> **Not tax or legal advice.** Tax treatment below is my reading of published summaries of the Nigeria Tax Act 2025 and the
> 2024 Withholding Tax Regulations, not the Gazette text. Several points need your tax adviser's confirmation — see §6.

---

## 1. Headline

| | Original | Now |
|---|---|---|
| VAT charged | 7.5% on **hire only** — late fees, waiver, rush, crew, consumables untaxed | 7.5% on every taxable line; 0% on loss/damage recoveries; per-line, kobo-rounded, foots exactly |
| Crew | Could be booked but **never invoiced** | Invoiced as a taxable service |
| WHT | Computed, then ignored (not in totals, not in the ledger) | Customer-deducted WHT tracked per payment, posted to a tax-credit asset, evidenced by credit-note no.; vendor WHT posted to a payable |
| Input VAT | Not recorded | Claimed on paid vendor invoices; reported |
| Tax report | None | Monthly VAT/WHT working paper with due dates + CSV |
| Invoice | Plain "INVOICE", no TINs | **TAX INVOICE**: supplier TIN/RC, buyer TIN, date of supply, VAT rate & amount per line, e-invoice IRN/CSID |
| Balance sheet | Ignored date filter; never balanced | Correct and balanced |
| Maker-checker | Same admin could raise and approve both levels | Enforced server-side |

---

## 2. Defects found (original build) and how each was fixed

"Probe" = reproduced against the original build, output saved in `docs/qc-evidence/baseline-output-original-build.txt`.

### Critical — money / tax / integrity
| # | Defect | Evidence | Fix |
|---|---|---|---|
| C1 | VAT applied to hire subtotal only; late fee, damage waiver, rush fee, consumables untaxed | Probe: VAT under-charged | `lib/tax.js` prices every line by category |
| C2 | Crew assigned to bookings never appears on any invoice | Probe: "MISSING" | Crew lines added (taxable service, 5% WHT) |
| C3 | Invoice insert + journal post not atomic: a failed journal left an **orphan invoice with no ledger entry** | Probe: invoice in DB, no GL | All posting wrapped in `tx()` (all-or-nothing) |
| C4 | Duplicate invoices for one booking (double billing); consumables/waiver/rush re-billed | Probe: 2nd invoice allowed | One live invoice per booking; void-and-reissue flow |
| C5 | Overpayment, negative and zero payments, payments on void invoices accepted | Probe | Validated; cannot exceed balance |
| C6 | Cash receipts posted to **Bank** (1010), never Cash (1000) | Probe | Method-aware posting |
| C7 | Balance sheet ignored its date filter and never balanced (no current earnings) | Probe: assets ≠ L+E | Rewritten; cumulative profit shown in equity |
| C8 | WHT calculated but not in any total or ledger line | Code | Full WHT model (§3) |
| C9 | Negative consumable quantity **adds stock** and corrupts the invoice | Probe: stock 10 → 15 | Whole-number > 0 enforced |
| C10 | Voucher maker-checker bypass: one admin raised and approved both levels | Probe | Raiser ≠ approver; L2 ≠ L1 approver; role per level |
| C11 | Expense "paid" never reached the UI: vouchers weren't linked to expenses, so UI-entered expenses **never hit the ledger** | Code | "Raise voucher" from the expense; amount taken from expense |
| C12 | Double-booking: same unit bookable for overlapping dates; lost/retired units bookable | Probe | Overlap check (overdue units stay busy until checked in) |
| C13 | Deposits recorded as a number but never received, held, applied or refunded | Code | Deposit received/applied/refunded via liability account 2300 |
| C14 | Kit package rate ignored — customers billed sum of parts | Code | Package rate spread pro-rata over components |

### High — workflow & security
| # | Defect | Fix |
|---|---|---|
| H1 | Double checkout / double check-in; items from *other* bookings accepted (could rewrite damage charges) | State guards + ownership checks |
| H2 | Returned/active bookings could be cancelled | Only `reserved` with nothing out, no live invoice, no held deposit |
| H3 | Return date before start date accepted | Validated |
| H4 | Suspended users kept working with their old session | Status checked on every request; sessions purged |
| H5 | Password change did not need the current password; 8-char minimum | Current password required; 10+ chars with upper/lower/digit; other sessions revoked |
| H6 | No login throttling | Account lock after 5 failures (429, configurable) |
| H7 | No security headers | CSP, X-Frame-Options, nosniff, referrer & permissions policy |
| H8 | Raw SQL errors shown to users (`UNIQUE constraint failed…`) | Mapped to clean 409/400 messages |
| H9 | "Session timeout" setting ignored (hard-coded 8h) | Honoured |
| H10 | Admin could suspend themselves / the last admin; arbitrary settings keys writable | Guarded; settings validated (rates, hex colours, TIN, currency) |
| H11 | Quote → booking never linked | `POST /api/quotes/:id/convert` |
| H12 | Work order could be completed twice (duplicate expense); completion released units that were on rent/lost | Guarded |
| H13 | Asset/kit codes used `COUNT+1` (collisions) | `MAX+1` |
| H14 | Foreign keys silently disabled after a backup restore/cloud pull | Pragma re-applied on reopen |
| H15 | Customer outstanding balance never maintained → credit limit meaningless | Recomputed on every invoice/payment/void; limit enforced at booking |

### Medium / usability
Dead invoice links on the customer screen · no way to edit a customer (so no way to add a TIN) · crew added via a browser `prompt()` ·
"Add crew" shown to roles that would get a 403 · equipment picker ignored dates · **modals had no close button or Escape key** ·
unhandled promise errors left blank pages · session expiry mid-use gave cryptic errors · static page title carried the vendor name ·
expense form had no VAT/WHT fields · P&L/balance sheet not shown in the UI · colour picker allowed unreadable text.

---

## 3. Nigerian tax model implemented

| Topic | Treatment | Where |
|---|---|---|
| **VAT** 7.5% | Standard-rated: equipment hire, late/waiver/rush fees, crew services, consumables. Rate and "VAT-registered" switch are settings. | `lib/tax.js` |
| **Loss/damage recoveries** | Outside scope of VAT (compensation, not consideration). Printed with a footnote. | invoice |
| **Deposits** | Refundable liability, not income, no VAT until applied. | acct 2300 |
| **Output VAT** | Credited to 2100 at invoice; reversed on void. | ledger |
| **Input VAT** | Debited to 1400 when a voucher is paid **and** the vendor invoice number is recorded and the business is VAT-registered. Otherwise it is expensed and listed as "not claimed". | vouchers |
| **WHT deducted by customers** (10% hire/fees, 5% services, 2% goods — editable) | Computed on the **VAT-exclusive** amount; only for customers flagged as withholding agents. Payment screen takes *cash received + WHT deducted + credit-note no.*; WHT cannot exceed the statutory maximum for that invoice. Posted Dr 1150 *WHT credits receivable*. Report flags credit notes still outstanding. | payments |
| **WHT we withhold from vendors** | Auto-rate by expense type; **doubled (cap 20%) when vendor has no TIN**. Posted Cr 2200 *WHT payable*. | expenses |
| **Invoice content** | Title TAX INVOICE; supplier name/address/TIN/RC; buyer name/address/TIN; unique sequential number (voids keep their number); issue date + date of supply; description; VAT-exclusive amount, rate and VAT per line; totals; payment terms. Falls back to a plain "INVOICE" + notice if not VAT-registered. | `lib/invoice-doc.js` |
| **Snapshot** | Supplier TIN/RC, customer TIN, VAT rate stored on the invoice, so changing settings never rewrites history (tested). | invoices |
| **Filing calendar** | Working paper per month with VAT-return and WHT-remittance due date (21st of following month), output vs input VAT, net payable/refundable, WHT schedules, CSV export. | Finance → VAT & WHT |
| **E-invoicing (NRS MBS)** | Fields for IRN, CSID and status; JSON export of the invoice data set; IRN/CSID print on the invoice. **Live transmission is not built** (see §6). | invoice |

Rounding: each line is rounded to kobo and invoice totals are the sum of the rounded lines, so an invoice always foots. Occasionally a
category subtotal differs from `rate × total` by 1 kobo (e.g. ₦59,249.99 vs ₦59,250.00 on kit lines).

---

## 4. Test results

### Back-end end-to-end — `npm test` → **123 passed, 0 failed**
Builds a full demo company through the real API, then verifies independently of the app's own totals:
every journal entry balances · trial balance and **balance sheet balance** · every invoice foots · VAT = 7.5% on each taxable line and 0 on
recoveries · expected-WHT matches category rates · AR control account = sum of open invoices · customer balances · output VAT 2100 = VAT on live
invoices · WHT 1150/2200 and input VAT 1400 agree with sub-ledgers · deposit liability clears · invoice numbering has no gaps · monthly tax report = ledger ·
every defect probed in the original build is blocked · maker-checker · RBAC · CSRF · session revocation · lockout · security headers · path traversal · VAT-exempt mode ·
settings-change snapshot · backup/restore · white-label logo/colour rules.

**Does the suite actually catch bugs?** A mutation test (re-introducing the "VAT on hire only" bug) turned the suite red (1 failure naming the exact lines).
A hand calculation of invoice INV-2026-0001 (net 1,125,000 → VAT 84,375 → gross 1,209,375; WHT 80,500) matched the system.

### Browser UI — `npm run test:ui` → **44 passed, 0 failed** (Chromium; screenshots in `docs/qc-evidence/screens/`)
Forced password change · all 11 pages render · customer TIN/WHT form, validation and edit · booking picker greys out booked units ·
invoice VAT breakdown · payment from the UI · VAT & WHT report · expense form live preview · balance sheet balanced · **logo upload, brand colour, sidebar colour
applied app-wide** · light colour → dark button text · printed invoice shows TAX INVOICE/TINs/logo/colour · branded login · **zero JS errors / CSP violations**.

---

## 5. White-label (logo & colour)
Existing logo/colour support was verified and extended. Admin → *White-label & settings* → **Branding**:
upload logo (PNG/JPG/WEBP/GIF/SVG ≤2 MB, scripts in SVG rejected) · portal & company name · **brand colour** (picker, hex, 8 swatches) ·
**optional sidebar/dark-surface colour** · live preview · contrast warning · reset-to-default. Text on coloured areas flips black/white automatically
(WCAG), brand-coloured links lighten on dark surfaces, the favicon and browser theme-colour follow the logo/colour, and the choice flows to the login page,
printed invoices and invoice emails. A sample logo is in `samples/demo-logo.svg`.

---

## 6. Open items & limits — please read
1. **VAT small-business exemption threshold.** Published summaries disagree (₦25m / ₦50m / ₦100m turnover). I did **not** hard-code one — it is the
   *"Charge VAT?"* switch in Admin → Tax. Confirm your client's status.
2. **E-invoicing is data-ready, not connected.** NRS e-invoicing needs an accredited Access Point Provider, credentials and a Service ID; the IRN/CSID are issued by NRS.
   I could not (and should not) fake that. Next step: pick an APP and wire `GET /api/invoices/:id/einvoice.json` to it.
3. **No credit notes.** Unpaid invoices can be voided and re-issued; for a *paid* invoice, reverse the payments first. A proper VAT credit/debit note is the recommended next feature.
4. **WHT small-company exemption** (payments under ~₦2m/month to small companies) can't be detected automatically — you enter the WHT the customer actually deducted; the system only blocks amounts above the statutory maximum.
5. **My classification choices** to confirm with the adviser: damage/loss recoveries outside VAT · waiver, late and rush fees treated like the hire (VAT 7.5%, WHT 10%) · crew as a 5% service · consumables as 2% goods.
6. **Expenses are cash-basis** (hit the ledger when the voucher is paid); there is no accounts-payable accrual.
7. **Out of scope:** Companies Income Tax, Development Levy, PAYE/payroll, stamp duty, and filing to the portal itself.
8. Tests ran on Node 22 / Chromium on Linux. Run `npm run test:all` after any change.

## 7. Deployment (v1.2.1 — see DEPLOY.md for v1.3.0)
Netlify and Vercel support was removed (functions, config, and the Upstash/Redis sync layer) and replaced with a Fly.io setup:
`Dockerfile`, `docker-entrypoint.sh`, `fly.toml`, `.dockerignore` and a rewritten `DEPLOY.md`. The server now binds `0.0.0.0`, shuts down
gracefully on SIGTERM, honours `Fly-Client-IP`, and `/api/health` verifies the database. **Verified here:** entrypoint (volume ownership, privilege drop,
first-boot demo seeding, no re-seed on restart), data persistence across restart, graceful shutdown, `Secure` cookies behind the proxy header, and
`fly.toml` syntax; the full 123 + 44 test suites still pass. **Gap found and fixed during this work:** backups were manual-only; a daily automatic, integrity-checked backup (`lib/backup-scheduler.js`, 4 new tests) now runs in the app. **Not verified here:** `docker build` and `fly deploy` themselves — this sandbox has no Docker or `flyctl` — so
do the first deploy to a staging app and check `/api/health` before pointing a client at it.

## 8. Upgrade notes
Existing databases migrate automatically on start (idempotent `ALTER TABLE`; verified against the shipped v1.1 database, legacy invoices preserved). **Password policy is stricter
(10+ chars, upper/lower/digit)**, so existing short passwords will need to be reset when users next change them. Invoices issued before this release keep their old (single-rate) VAT and have no line-level tax data.
