# Accounting & tax basis — MediaRent v1.3.0

How the portal accounts for an equipment-rental / studio-hire business under IFRS and Nigerian tax law, and where each
rule lives in the code. This is a working note for the client's accountant and tax adviser, not legal advice — §7 lists
what they should confirm.

## 1. Chart of accounts (6-digit)

| Class | Range | Examples |
|---|---|---|
| 1 Assets | 100000–199999 | 101000 Cash on hand · 102000 Bank · 102100 POS/card · 111000 Trade receivables · 111900 ECL allowance · 112000 Unbilled rental income · 113000 Input VAT · 114000 WHT receivable (credit notes) · 117000 Insurance claims receivable · 121000 Spare parts · 122000 Consumables · 151000 Rental equipment at cost · 151900 Accumulated depreciation |
| 2 Liabilities | 200000–299999 | 201000 Trade payables · 211000 Output VAT · 212000 WHT payable · 215000 CIT payable · 216000 Development levy payable · 221000 Customer deposits & caution fees |
| 3 Equity | 300000–399999 | 301000 Share capital · 302000 Retained earnings · 303000 Opening balance equity (migration only) |
| 4 Revenue | 400000–499999 | 401000 Equipment rental (IFRS 16) · 401100 Studio hire (IFRS 16) · 402000 Crew & technical services (IFRS 15) · 403000 Late-return fees · 404000 Consumables sales · 405000 Damage waiver · 406000 Delivery · 407000 Cancellation fees · 411000 Damage recovery · 412000 Lost-equipment compensation · 413000 Insurance recoveries |
| 5 Cost of sales | 500000–599999 | 501000 Cost of consumables sold · 502000 Depreciation of rental fleet · 503000 Repairs & parts · 505000 Crew cost · 506000 Sub-rental |
| 6 Operating expenses | 600000–699999 | rent, salaries, utilities, insurance, marketing, professional fees, sundry |
| 7 Other items | 700000–799999 | 701000 ECL impairment · 702000 Loss on write-off · 705000 Tax penalties |
| 8 Taxation | 800000–899999 | 801000 Company income tax · 802000 Development levy |

Rules (`lib/coa.js`, `routes/accounting.js`): six digits, first digit = class; class/group headers (`x00000`) do not
take postings; system accounts used by automatic postings cannot be deleted or re-typed; new GLs can be added by users
with `accounts.edit`. Old 4-digit databases are renumbered in place via `LEGACY_MAP`.

## 2. IFRS treatments

| Event | Standard | Posting |
|---|---|---|
| Equipment / studio hire invoiced | IFRS 16 (lessor, operating lease) | Dr 111000 / Cr 401000 or 401100 / Cr 211000 VAT |
| Crew, delivery, consumables | IFRS 15 | Cr 402000 / 406000 / 404000; consumables also Dr 501000 Cr 122000 at cost |
| Rental earned but not yet invoiced at month-end | IFRS 16 accrual | Dr 112000 / Cr 401000, auto-reversed next day |
| Deposit / caution fee received | Financial liability | Dr bank / Cr 221000 — never income until applied |
| Depreciation | IAS 16 straight-line, monthly; stops in the month of disposal | Dr 502000 / Cr 151900 |
| Lost unit billed to customer | IAS 16.65 — compensation recognised separately | Cr 412000 (outside VAT); derecognition Dr 151900 + 702000 / Cr 151000 |
| Insurance claim approved | IAS 16.65 / IAS 37 virtually certain | Dr 117000 / Cr 413000, settled to bank |
| Receivables impairment | IFRS 9 simplified approach, provision matrix by age band (rates in Settings) | Dr 701000 / Cr 111900 (true-up) |
| Vendor bills | Accrual basis | Dr expense or asset + 113000 input VAT / Cr 201000; WHT deducted on payment Dr 201000 / Cr 212000 |
| Stock | IAS 2 (weighted average) | 121000 spares, 122000 consumables |
| Corporate tax | IAS 12 current tax | Dr 801000/802000 / Cr 215000/216000 |
| Year-end | — | P&L closed to 302000; period lock prevents back-posting |

The profit or loss is presented by function (IAS 1.103) with revenue disaggregated by stream (IFRS 15.114).

## 3. VAT (Nigeria Tax Act 2025)

- Standard rate **7.5%** on rental, studio hire, crew, delivery, waiver, late fees and consumables.
- **Outside the scope of VAT**: compensation for lost equipment and damage recovery (not a supply), deposits.
- **Input VAT** is recoverable on services and on fixed assets (a change from the old VAT Act which allowed only goods);
  posted to 113000 when a bill is recorded, netted on the monthly working paper.
- Returns and payment due by the **21st** of the following month (Finance → VAT & WHT shows the due date).

## 4. Withholding tax (Deduction of Tax at Source Regulations 2024)

| Payment | Rate |
|---|---|
| Rent / hire of equipment & studios | 10% |
| Professional, technical, management & other services | 5% |
| Supply of goods (contract) | 2% |
| Payee without a TIN | rate doubled |

Customers flagged "deducts WHT at source" pay net; the WHT is booked to 114000 as a tax credit against CIT when the
credit note number is recorded. WHT the client deducts from its suppliers is posted to 212000 at payment and listed on
the WHT schedule for remittance by the 21st.

## 5. Company income tax & development levy

- **Small company** (turnover ≤ ₦100m **and** fixed assets ≤ ₦250m): 0% CIT, exempt from the development levy.
- Otherwise CIT **30%** and development levy **4%** of assessable profit (both configurable in Settings → Accounting).
- Finance → Corporate tax computes the provision from the ledger (accounting profit, add-back of ECL/penalties,
  WHT credits available) and posts it with the period-end tools. Nexthought's fleet cost (~₦527m) exceeds the ₦250m
  asset test, so it is treated as **not** a small company in the test data.

## 6. NRS e-invoicing (MBS)

- The Nigeria Revenue Service (formerly FIRS) **Merchant Buyer Solution** requires B2B and B2G invoices to be
  **cleared before they are sent** (validated, signed, given an IRN and cryptographic stamp/QR), and B2C invoices to be
  **reported within 24 hours**. Integration is direct by API or through a licensed **Access Point Provider (APP)**.
- Phasing reported publicly: large taxpayers (> ₦5bn) from Nov 2025; medium (₦1–5bn) from 1 Jul 2026; small (< ₦1bn)
  from Jul 2027. A business Nexthought's size can adopt voluntarily now; the portal is ready either way.
- Implementation (`lib/nrs.js`, `routes/einvoice.js`): IRN `<invoice no.>-<8-char service ID>-<YYYYMMDD>`; payload with
  supplier/customer parties (TIN, address), lines with HS/service code, `STANDARD_VAT` tax totals and monetary totals;
  invoice type **380** (invoice) / **381** (credit note); steps validate → sign → transmit/confirm, then payment status
  updates. Modes: *off*, *simulator* (deterministic local clearance for testing/training) and *live* (HTTPS to the
  APP with `x-api-key` / `x-api-secret`; endpoint paths configurable). Every call is logged on the invoice.
- Bypass penalties reported: ₦200,000 plus 100% of the tax plus interest; buyers may be denied input VAT on
  uncleared invoices.

## 7. Points for the client's tax adviser to confirm

1. Small-company status for each year — the portal tests turnover and fixed-asset cost from the ledger automatically;
   the thresholds are editable in Settings → Accounting & corporate tax.
2. VAT treatment of studio hire (treated here as a taxable lease of space/equipment — standard-rated).
3. Whether lost-equipment compensation and damage recovery are outside VAT under the client's contracts (treated as outside scope).
4. The development-levy base and any transitional reliefs for the first NTA 2025 year.
5. Which APP to use and the exact endpoint paths/credentials before switching NRS to *live*.
6. Replacement values and cost estimates imported from the rate card (needed for depreciation and loss billing).

## Sources

- [All you need to know about Nigeria's newly signed tax reform acts — Mondaq](https://admin.mondaq.com/nigeria/tax-authorities/1695350/all-you-need-to-know-about-nigerias-newly-signed-tax-reform-acts)
- [Nigeria's 2025 Tax Reform Acts: key tax changes — SeamlessHR](https://seamlesshr.com/blog/nigerias-2025-tax-reform-acts-key-tax-changes/)
- [Govt highlights 50 tax reliefs and exemptions — allAfrica](https://allafrica.com/stories/202511040069.html)
- [Highlights of the Deduction at Source Regulations 2024 — PwC Nigeria (PDF)](https://pwc.com/ng/en/assets/pdf/highlights-of-the-deduction-at-source-regulations-2024.pdf)
- [Nigeria issues Deduction of Tax at Source (Withholding) Regulations 2024 — EY](https://globaltaxnews.ey.com/news/2024-1347)
- [An overview of the Nigerian Withholding Tax Regulations of 2024 — Mondaq](https://www.mondaq.com/nigeria/withholding-tax/1491814/an-overview-of-the-nigerian-withholding-tax-regulations-of-2024)
- [Nigeria e-invoicing for medium taxpayers: NRS MBS guide (Sep 2026)](https://beancount.io/blog/2026/09/26/nigeria-e-invoicing-medium-taxpayers-nrs-mbs-guide)
- [All you need to know about e-invoicing in Nigeria — TechCabal](https://techcabal.com/2026/04/16/all-you-need-to-know-about-e-invoicing-in-nigeria/)
- [Everything you need to know about e-invoicing in Nigeria — Zoho](https://www.zoho.com/books/academy/taxes-and-compliance/nigeria-einvoicing.html)
- IFRS 16 *Leases*, IFRS 15 *Revenue*, IFRS 9 *Financial Instruments*, IAS 16 *Property, Plant and Equipment*, IAS 2
  *Inventories*, IAS 1 *Presentation*, IAS 12 *Income Taxes* (IFRS Foundation).
