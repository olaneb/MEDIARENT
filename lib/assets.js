// Fixed-asset and inventory postings (IAS 16 / IAS 2).
const { db, getSettings } = require('./db');
const { nextNumber, postJournalEntry, round2: r2 } = require('./ledger');
const { ACC } = require('./coa');
const { logAudit } = require('./auth');
const taxlib = require('./tax');

const today = () => new Date().toISOString().slice(0, 10);

// Records a vendor bill (Dr asset/expense GL [+ input VAT] / Cr trade payables). Returns the expense row id + number.
function recordBill({ category, gl, amount, vatApplies, vendorName, vendorTin, vendorInvoiceNo, description, date, equipmentId, userId, whtKind }) {
  const cfg = taxlib.taxConfig();
  amount = r2(amount);
  const vat = vatApplies ? r2(amount * cfg.vatRate / 100) : 0;
  const whtRate = whtKind ? taxlib.vendorWhtRate(whtKind, !!vendorTin, cfg) : 0;
  const wht = r2(amount * whtRate / 100);
  const claimed = cfg.vatRegistered && vat > 0 && vendorInvoiceNo ? vat : 0;
  const no = nextNumber('EXP', 'expenses', 'expense_number');
  const r = db.prepare(`INSERT INTO expenses (expense_number, category, equipment_id, amount, vat_amount, wht_amount, wht_rate, expense_date, description, vendor_name, vendor_tin, vendor_invoice_no, created_by, gl_code, input_vat_claimed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(no, category, equipmentId || null, amount, vat, wht, whtRate, date || today(), description, vendorName || null, vendorTin || null, vendorInvoiceNo || null, userId, gl, claimed);
  const id = Number(r.lastInsertRowid);
  const lines = [{ code: gl, debit: r2(amount + vat - claimed), description }];
  if (claimed > 0) lines.push({ code: ACC.INPUT_VAT, debit: claimed, description: `Input VAT — ${vendorInvoiceNo}` });
  lines.push({ code: ACC.AP, credit: r2(amount + vat), description: `Bill ${no} — ${vendorName || 'vendor'}` });
  postJournalEntry({ memo: `Vendor bill ${no}${vendorName ? ' — ' + vendorName : ''}`, sourceType: 'expense', sourceId: id, createdBy: userId, lines, entryDate: date || today() });
  return { id, expense_number: no, payable: r2(amount + vat - wht) };
}

function isCapitalised(equipmentId) {
  const r = db.prepare('SELECT capitalised_at FROM equipment WHERE id = ?').get(equipmentId);
  return !!(r && r.capitalised_at);
}

/** Put a unit's cost on the balance sheet. method: 'bill' (supplier invoice -> AP), 'cash' (paid from bank), 'opening' (existing asset, against opening balance equity). */
function capitalise(eq, { method, vendorName, vendorTin, vendorInvoiceNo, vatApplies, date, userId, ip }) {
  if (!(eq.purchase_cost > 0)) throw Object.assign(new Error('Set a purchase cost on the equipment first'), { status: 400 });
  if (isCapitalised(eq.id)) throw Object.assign(new Error(`${eq.asset_code} is already capitalised`), { status: 409 });
  const d = date || eq.purchase_date || today();
  let bill = null;
  if (method === 'bill') {
    bill = recordBill({ category: 'equipment_purchase', gl: ACC.EQUIPMENT_COST, amount: eq.purchase_cost, vatApplies, vendorName, vendorTin, vendorInvoiceNo, description: `Purchase of ${eq.asset_code} ${eq.name}`, date: d, equipmentId: eq.id, userId });
    db.prepare("UPDATE expenses SET description = description || ' [capitalised]' WHERE id = ?").run(bill.id);
  } else {
    const credit = method === 'cash' ? ACC.BANK : ACC.OPENING_BALANCE_EQUITY;
    postJournalEntry({ memo: `Capitalise ${eq.asset_code} ${eq.name}`, sourceType: 'capitalisation', sourceId: eq.id, createdBy: userId, entryDate: d,
      lines: [{ code: ACC.EQUIPMENT_COST, debit: eq.purchase_cost, description: `${eq.asset_code} at cost` }, { code: credit, credit: eq.purchase_cost, description: method === 'cash' ? 'Paid from bank' : 'Existing asset brought onto the register' }] });
  }
  db.prepare("UPDATE equipment SET capitalised_at = datetime('now'), capitalisation_method = ?, depreciation_start_date = COALESCE(depreciation_start_date, ?) WHERE id = ?").run(method, d, eq.id);
  logAudit(userId, 'equipment_capitalised', 'equipment', eq.id, { method, cost: eq.purchase_cost, bill: bill && bill.expense_number }, ip);
  return { ok: true, bill };
}

/** Derecognise a lost / stolen / scrapped unit (IAS 16.67): remove cost and accumulated depreciation, loss = NBV. */
function writeOff(eq, { reason, date, userId, ip }) {
  if (eq.disposed_at) throw Object.assign(new Error('Unit is already written off'), { status: 400 });
  const { postedDepreciation } = require('./reports');
  const acc = r2((eq.opening_accumulated_depreciation || 0) + (postedDepreciation(date || today())[eq.id] || 0));
  const cost = r2(eq.purchase_cost || 0); const nbv = r2(Math.max(0, cost - acc));
  let je = null;
  if (cost > 0) {
    const lines = [{ code: ACC.EQUIPMENT_COST, credit: cost, description: `Derecognise ${eq.asset_code} cost` }];
    if (acc > 0) lines.push({ code: ACC.EQUIPMENT_ACC_DEP, debit: Math.min(acc, cost), description: 'Accumulated depreciation released' });
    if (nbv > 0) lines.push({ code: ACC.LOSS_ON_WRITE_OFF, debit: nbv, description: `Loss on write-off — ${reason}` });
    je = postJournalEntry({ memo: `Write-off ${eq.asset_code} ${eq.name}: ${reason}`, sourceType: 'write_off', sourceId: eq.id, createdBy: userId, entryDate: date || today(), lines });
  }
  db.prepare("UPDATE equipment SET status = 'retired', disposed_at = ?, disposal_reason = ? WHERE id = ?").run(date || today(), reason, eq.id);
  logAudit(userId, 'equipment_written_off', 'equipment', eq.id, { reason, cost, acc, nbv }, ip);
  return { cost, accumulated_depreciation: acc, loss: nbv, journal_entry: je ? je.entryNumber : null };
}

// Cost of consumables issued to a booking (IAS 2): Dr cost of sales / Cr inventory at unit cost.
function postConsumableIssue({ item, qty, agreementNumber, userId }) {
  const cost = r2((item.unit_cost || 0) * qty);
  if (cost <= 0) return null;
  return postJournalEntry({ memo: `Consumables issued — ${item.name} × ${qty} (${agreementNumber})`, sourceType: 'stock_issue', sourceId: item.id, createdBy: userId,
    lines: [{ code: ACC.COST_OF_CONSUMABLES, debit: cost, description: `${item.name} × ${qty}` }, { code: ACC.CONSUMABLES_INVENTORY, credit: cost, description: 'Stock issued' }] });
}

function postOpeningStock({ gl, value, memo, userId }) {
  value = r2(value); if (value <= 0) return null;
  return postJournalEntry({ memo, sourceType: 'opening_balance', createdBy: userId, lines: [{ code: gl, debit: value, description: memo }, { code: ACC.OPENING_BALANCE_EQUITY, credit: value, description: memo }] });
}

module.exports = { recordBill, capitalise, writeOff, isCapitalised, postConsumableIssue, postOpeningStock };
