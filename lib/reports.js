// Reporting engine: standard financial / operational / tax reports + the ad-hoc report builder.
// Every report returns a uniform table: { title, subtitle, columns: [{key, header, type}], rows: [{...}], totals?, notes? }
// so one exporter serves JSON, CSV, Excel (.xlsx) and PDF.
const { db, getSettings } = require('./db');
const { trialBalance, accountLedger, round2 } = require('./ledger');
const { ACC } = require('./coa');
const taxlib = require('./tax');
const r2 = round2;
const today = () => new Date().toISOString().slice(0, 10);
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const yearStart = () => { const s = getSettings(); const m = Math.min(12, Math.max(1, parseInt(s.financial_year_start_month || '1', 10))); const d = new Date(); let y = d.getUTCFullYear(); if (d.getUTCMonth() + 1 < m) y--; return `${y}-${String(m).padStart(2, '0')}-01`; };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

// ============================ TAX WORKING PAPER ============================
function taxReport(month) {
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const due = taxlib.dueDateFor(month);
  const invoices = db.prepare(`SELECT i.id, i.invoice_number, i.issue_date, i.subtotal, i.taxable_total, i.exempt_total, i.vat_total, i.grand_total,
      i.customer_tin, i.einvoice_irn, i.einvoice_status, c.full_name, c.company_name FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.status != 'void' AND i.is_legacy = 0 AND i.issue_date BETWEEN ? AND ? ORDER BY i.invoice_number`).all(from, to);
  const voided = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status = 'void' AND issue_date BETWEEN ? AND ?").get(from, to).c;
  const byCategory = db.prepare(`SELECT ii.category, ROUND(SUM(ii.amount),2) as net, ROUND(SUM(ii.vat_amount),2) as vat
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.status != 'void' AND i.is_legacy = 0 AND i.issue_date BETWEEN ? AND ? GROUP BY ii.category ORDER BY ii.category`).all(from, to);
  const outputVat = r2(invoices.reduce((a, i) => a + i.vat_total, 0));
  const taxable = r2(invoices.reduce((a, i) => a + i.taxable_total, 0));
  const outside = r2(invoices.reduce((a, i) => a + i.exempt_total, 0));
  // Input VAT — what the ledger shows on 113000 for vendor bills in the period (bills post at bill date; pre-1.3 bills at payment)
  const inputItems = db.prepare(`SELECT e.entry_date, ex.expense_number, ex.vendor_name, ex.vendor_tin, ex.vendor_invoice_no, ex.amount, ROUND(l.debit - l.credit, 2) as vat
      FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id AND a.code = ?
      JOIN journal_entries e ON e.id = l.entry_id AND e.entry_date BETWEEN ? AND ? AND e.source_type IN ('expense','expense_void','voucher')
      JOIN expenses ex ON ex.id = CASE WHEN e.source_type = 'voucher' THEN (SELECT linked_expense_id FROM payment_vouchers WHERE id = e.source_id) ELSE e.source_id END
      ORDER BY e.entry_date`).all(ACC.INPUT_VAT, from, to);
  const inputVat = r2(inputItems.reduce((a, i) => a + i.vat, 0));
  const unclaimable = db.prepare(`SELECT expense_number, vendor_name, vat_amount, vendor_invoice_no FROM expenses
      WHERE status != 'void' AND vat_amount > 0 AND input_vat_claimed = 0 AND expense_date BETWEEN ? AND ?`).all(from, to);
  const whtIn = db.prepare(`SELECT p.payment_ref, p.received_at, p.wht_amount, p.wht_credit_note_no, i.invoice_number, c.full_name, c.company_name, c.tin
      FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = p.customer_id
      WHERE p.wht_amount > 0 AND p.reversed_at IS NULL AND date(p.received_at) BETWEEN ? AND ? ORDER BY p.id`).all(from, to);
  const whtOut = db.prepare(`SELECT e.entry_date, ex.expense_number, ex.vendor_name, ex.vendor_tin, ex.amount, ex.wht_rate, l.credit as wht
      FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id AND a.code = ?
      JOIN journal_entries e ON e.id = l.entry_id AND e.source_type = 'voucher' AND e.entry_date BETWEEN ? AND ?
      JOIN payment_vouchers pv ON pv.id = e.source_id JOIN expenses ex ON ex.id = pv.linked_expense_id
      WHERE l.credit > 0 ORDER BY e.entry_date`).all(ACC.WHT_PAYABLE, from, to);
  const tb = trialBalance();
  const bal = (code) => { const row = tb.find(a => a.code === code); return row ? r2(row.balance) : 0; };
  const notCleared = invoices.filter(i => i.einvoice_status !== 'cleared').length;
  return {
    period: { month, from, to, vat_return_due: due, wht_remittance_due: due },
    output_vat: { taxable_supplies: taxable, outside_scope_supplies: outside, vat_charged: outputVat, invoice_count: invoices.length, voided_invoice_count: voided, not_cleared_on_nrs: notCleared, by_category: byCategory,
      invoices: invoices.map(i => ({ id: i.id, invoice_number: i.invoice_number, issue_date: i.issue_date, customer: i.company_name || i.full_name, customer_tin: i.customer_tin, net: i.subtotal, vat: i.vat_total, gross: i.grand_total, irn: i.einvoice_irn, einvoice_status: i.einvoice_status })) },
    input_vat: { claimed: inputVat, items: inputItems, not_claimable: unclaimable },
    net_vat: { payable: r2(outputVat - inputVat), position: outputVat - inputVat >= 0 ? 'payable' : 'refundable / carry forward' },
    wht_deducted_by_customers: { total: r2(whtIn.reduce((a, p) => a + p.wht_amount, 0)), missing_credit_notes: whtIn.filter(p => !p.wht_credit_note_no).length,
      items: whtIn.map(p => ({ ...p, customer: p.company_name || p.full_name })) },
    wht_withheld_from_vendors: { total: r2(whtOut.reduce((a, p) => a + p.wht, 0)), items: whtOut },
    ledger_balances: { vat_payable: bal(ACC.VAT_PAYABLE), input_vat: bal(ACC.INPUT_VAT), wht_receivable: bal(ACC.WHT_RECEIVABLE), wht_payable: bal(ACC.WHT_PAYABLE) },
  };
}

function taxReportCsv(month) {
  const { toCsv } = require('./csv');
  const t = taxReport(month);
  return toCsv([
    ['VAT & WHT working paper', month], ['VAT return / WHT remittance due', t.period.vat_return_due], [],
    ['OUTPUT VAT (sales)'], ['Invoice', 'Date', 'Customer', 'Customer TIN', 'IRN', 'Net', 'VAT', 'Gross'],
    ...t.output_vat.invoices.map(i => [i.invoice_number, i.issue_date, i.customer, i.customer_tin, i.irn, i.net, i.vat, i.gross]),
    ['Taxable supplies', t.output_vat.taxable_supplies], ['Outside-scope supplies', t.output_vat.outside_scope_supplies], ['Output VAT', t.output_vat.vat_charged], [],
    ['INPUT VAT (purchases)'], ['Date', 'Expense', 'Vendor', 'Vendor TIN', 'Vendor invoice', 'Net', 'VAT'],
    ...t.input_vat.items.map(i => [i.entry_date, i.expense_number, i.vendor_name, i.vendor_tin, i.vendor_invoice_no, i.amount, i.vat]),
    ['Input VAT claimed', t.input_vat.claimed], [], ['NET VAT ' + t.net_vat.position.toUpperCase(), t.net_vat.payable], [],
    ['WHT DEDUCTED BY CUSTOMERS (credits)'], ['Payment', 'Invoice', 'Customer', 'Customer TIN', 'WHT', 'Credit note no.'],
    ...t.wht_deducted_by_customers.items.map(p => [p.payment_ref, p.invoice_number, p.customer, p.tin, p.wht_amount, p.wht_credit_note_no]),
    ['Total WHT credits', t.wht_deducted_by_customers.total], [],
    ['WHT WITHHELD FROM VENDORS (remit to NRS)'], ['Date', 'Expense', 'Vendor', 'Vendor TIN', 'Net', 'Rate %', 'WHT'],
    ...t.wht_withheld_from_vendors.items.map(p => [p.entry_date, p.expense_number, p.vendor_name, p.vendor_tin, p.amount, p.wht_rate, p.wht]),
    ['Total WHT to remit', t.wht_withheld_from_vendors.total],
  ]);
}

// ============================ STANDARD REPORTS ============================
const C = (key, header, type = 'text') => ({ key, header, type });

function sumBy(rows, key) { return r2(rows.reduce((a, r) => a + (Number(r[key]) || 0), 0)); }

// Statement of profit or loss (by function, IAS 1) built from the ifrs_line tagging on each account.
function incomeStatement(from, to, { excludeClose = false } = {}) {
  const rows = db.prepare(`SELECT a.code, a.name, a.account_type, COALESCE(a.ifrs_line, CASE a.account_type WHEN 'income' THEN 'Other operating income' ELSE 'Administrative expenses' END) as line,
      ROUND(COALESCE(SUM(l.credit - l.debit), 0), 2) as cr_net
      FROM chart_of_accounts a JOIN journal_lines l ON l.account_id = a.id JOIN journal_entries e ON e.id = l.entry_id
      WHERE a.account_type IN ('income','expense') AND a.is_header = 0 AND (? IS NULL OR e.entry_date >= ?) AND (? IS NULL OR e.entry_date <= ?)
        AND (? = 0 OR e.source_type IS NULL OR e.source_type != 'year_end_close')
      GROUP BY a.id HAVING ABS(cr_net) > 0.004 ORDER BY a.code`).all(from || null, from || null, to || null, to || null, excludeClose ? 1 : 0);
  const groups = [
    ['Revenue', r => r.line.startsWith('Revenue'), 1],
    ['Cost of sales', r => r.line === 'Cost of sales', -1],
    ['GROSS PROFIT', null],
    ['Other operating income', r => r.account_type === 'income' && !r.line.startsWith('Revenue'), 1],
    ['Selling & distribution expenses', r => r.line === 'Selling & distribution expenses', -1],
    ['Administrative expenses', r => r.line === 'Administrative expenses', -1],
    ['Impairment of financial assets', r => r.line === 'Impairment of financial assets', -1],
    ['Other operating expenses', r => r.line === 'Other operating expenses', -1],
    ['OPERATING PROFIT', null],
    ['Finance costs', r => r.line === 'Finance costs', -1],
    ['PROFIT BEFORE TAX', null],
    ['Income tax expense (CIT & development levy)', r => r.line === 'Income tax expense', -1],
    ['PROFIT FOR THE PERIOD', null],
  ];
  const used = new Set(); const out = []; let running = 0; const subtotals = {};
  for (const [label, pred] of groups) {
    if (!pred) { out.push({ _style: 'total', line: label, code: '', account: '', amount: r2(running) }); subtotals[label] = r2(running); continue; }
    const members = rows.filter(r => !used.has(r.code) && pred(r));
    members.forEach(r => used.add(r.code));
    const total = r2(members.reduce((a, r) => a + r.cr_net, 0));
    if (!members.length && !['Revenue', 'Cost of sales'].includes(label)) continue;
    const shown = (r) => r2(r.account_type === 'income' ? r.cr_net : -r.cr_net);
    out.push({ _style: 'section', line: label, code: '', account: '', amount: null });
    for (const r of members) out.push({ line: '', code: r.code, account: r.name, amount: shown(r), _drill: { account: r.code } });
    out.push({ _style: 'subtotal', line: `Total ${label.toLowerCase()}`, code: '', account: '', amount: r2(members.reduce((a, r) => a + shown(r), 0)) });
    running = r2(running + total);
  }
  // Anything left (should be none) goes into other operating expenses to keep the statement complete.
  const leftovers = rows.filter(r => !used.has(r.code));
  if (leftovers.length) { for (const r of leftovers) { out.push({ line: '', code: r.code, account: r.name + ' (unclassified)', amount: r2(r.cr_net) }); running = r2(running + r.cr_net); } out.push({ _style: 'total', line: 'PROFIT FOR THE PERIOD (incl. unclassified)', amount: running }); }
  return { rows: out, profit: subtotals['PROFIT FOR THE PERIOD'] ?? running, revenue: r2(rows.filter(r => r.line.startsWith('Revenue')).reduce((a, r) => a + r.cr_net, 0)), subtotals };
}

function financialPosition(asOf) {
  const tb = trialBalance(asOf);
  const pnl = incomeStatement(null, asOf);
  const nonCurrentLines = ['Property, plant and equipment', 'Borrowings'];
  const pick = (types) => tb.filter(a => types.includes(a.account_type) && Math.abs(a.balance) > 0.004);
  const out = [];
  const section = (label, accts, sign) => {
    out.push({ _style: 'section', line: label, code: '', account: '', amount: null });
    const byLine = {};
    for (const a of accts) { const l = a.ifrs_line || 'Other'; (byLine[l] = byLine[l] || []).push(a); }
    let tot = 0;
    for (const [l, list] of Object.entries(byLine)) {
      for (const a of list) { const v = r2(a.balance * sign); tot += v; out.push({ line: l, code: a.code, account: a.name, amount: v, _drill: { account: a.code } }); }
    }
    out.push({ _style: 'subtotal', line: `Total ${label.toLowerCase()}`, code: '', account: '', amount: r2(tot) });
    return r2(tot);
  };
  const assets = pick(['asset']);
  const nca = section('Non-current assets', assets.filter(a => nonCurrentLines.includes(a.ifrs_line)), 1);
  const ca = section('Current assets', assets.filter(a => !nonCurrentLines.includes(a.ifrs_line)), 1);
  out.push({ _style: 'total', line: 'TOTAL ASSETS', code: '', account: '', amount: r2(nca + ca) });
  const eqAccts = pick(['equity']);
  out.push({ _style: 'section', line: 'Equity', code: '', account: '', amount: null });
  let eq = 0;
  for (const a of eqAccts) { const v = r2(-a.balance); eq += v; out.push({ line: a.ifrs_line || 'Equity', code: a.code, account: a.name, amount: v, _drill: { account: a.code } }); }
  out.push({ line: 'Retained earnings', code: 'P&L', account: 'Current earnings (profit not yet closed to retained earnings)', amount: r2(pnl.profit) }); eq += pnl.profit;
  out.push({ _style: 'subtotal', line: 'Total equity', code: '', account: '', amount: r2(eq) });
  const liab = pick(['liability']);
  const ncl = section('Non-current liabilities', liab.filter(a => nonCurrentLines.includes(a.ifrs_line)), -1);
  const cl = section('Current liabilities', liab.filter(a => !nonCurrentLines.includes(a.ifrs_line)), -1);
  out.push({ _style: 'total', line: 'TOTAL EQUITY AND LIABILITIES', code: '', account: '', amount: r2(eq + ncl + cl) });
  return { rows: out, totals: { assets: r2(nca + ca), equity: r2(eq), liabilities: r2(ncl + cl), balanced: Math.abs(r2(nca + ca) - r2(eq + ncl + cl)) < 0.01 } };
}

function arAging(asOf) {
  asOf = asOf || today();
  const s = getSettings();
  const rate = { current: +s.ecl_rate_current || 0, b1: +s.ecl_rate_1_30 || 0, b2: +s.ecl_rate_31_60 || 0, b3: +s.ecl_rate_61_90 || 0, b4: +s.ecl_rate_over_90 || 0 };
  const inv = db.prepare(`SELECT i.id, i.invoice_number, i.issue_date, i.due_date, i.customer_id, c.full_name, c.company_name,
      ROUND(i.grand_total - COALESCE((SELECT SUM(p.amount + p.wht_amount) FROM payments p WHERE p.invoice_id = i.id AND p.reversed_at IS NULL AND date(p.received_at) <= ?), 0), 2) as bal
      FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.status != 'void' AND i.issue_date <= ? ORDER BY c.full_name, i.due_date`).all(asOf, asOf).filter(r => r.bal > 0.004);
  const buckets = (d) => d <= 0 ? 'current' : d <= 30 ? 'b1' : d <= 60 ? 'b2' : d <= 90 ? 'b3' : 'b4';
  const byCust = {};
  for (const r of inv) {
    const d = daysBetween(r.due_date || r.issue_date, asOf);
    const k = buckets(d);
    const c = byCust[r.customer_id] = byCust[r.customer_id] || { customer_id: r.customer_id, customer: r.company_name || r.full_name, current: 0, b1: 0, b2: 0, b3: 0, b4: 0, total: 0, ecl: 0, invoices: 0 };
    c[k] = r2(c[k] + r.bal); c.total = r2(c.total + r.bal); c.ecl = r2(c.ecl + r.bal * rate[k] / 100); c.invoices++;
  }
  const rows = Object.values(byCust).sort((a, b) => b.total - a.total).map(c => ({ ...c, _drill: { customer_id: c.customer_id } }));
  const totals = { customer: 'TOTAL', invoices: rows.reduce((a, r) => a + r.invoices, 0) };
  for (const k of ['current', 'b1', 'b2', 'b3', 'b4', 'total', 'ecl']) totals[k] = sumBy(rows, k);
  return { rows, totals, rate, detail: inv };
}

function postedDepreciation(asOf) {
  const ym = (asOf || today()).slice(0, 7);
  const map = {};
  for (const r of db.prepare(`SELECT dl.equipment_id, SUM(dl.amount) a FROM depreciation_lines dl JOIN depreciation_runs dr ON dr.id = dl.run_id
                              WHERE dr.status = 'posted' AND dr.period <= ? GROUP BY dl.equipment_id`).all(ym)) map[r.equipment_id] = r.a;
  return map;
}

const REPORTS = {
  trial_balance: {
    title: 'Trial balance', group: 'Financial statements', params: [{ key: 'as_of', label: 'As at', type: 'date' }],
    run({ as_of }) {
      const tb = trialBalance(as_of).filter(r => Math.abs(r.total_debit) > 0.004 || Math.abs(r.total_credit) > 0.004);
      const rows = tb.map(r => ({ code: r.code, name: r.name, type: r.account_type, debit: r.balance > 0 ? r.balance : 0, credit: r.balance < 0 ? -r.balance : 0, _drill: { account: r.code } }));
      return { subtitle: `As at ${as_of || today()} · balances (net debit / credit)`, columns: [C('code', 'Code'), C('name', 'Account'), C('type', 'Type'), C('debit', 'Debit', 'money'), C('credit', 'Credit', 'money')],
        rows, totals: { code: '', name: 'TOTAL', debit: sumBy(rows, 'debit'), credit: sumBy(rows, 'credit') } };
    },
  },
  profit_and_loss: {
    title: 'Statement of profit or loss', group: 'Financial statements', params: [{ key: 'from', label: 'From', type: 'date', default: 'year_start' }, { key: 'to', label: 'To', type: 'date' }],
    run({ from, to }) {
      from = from || yearStart(); to = to || today();
      const s = incomeStatement(from, to, { excludeClose: true });
      return { subtitle: `For the period ${from} to ${to} · IAS 1 (analysis of expenses by function)`, columns: [C('line', 'Line'), C('code', 'Code'), C('account', 'Account'), C('amount', 'Amount', 'money')], rows: s.rows,
        notes: ['Revenue is shown net of VAT. Rental income is recognised under IFRS 16 (operating leases, lessor); crew, delivery and consumables under IFRS 15.', 'Loss/damage recoveries and insurance recoveries are compensation (IAS 16.65) shown in other operating income, not netted against the write-off.'] };
    },
  },
  balance_sheet: {
    title: 'Statement of financial position', group: 'Financial statements', params: [{ key: 'as_of', label: 'As at', type: 'date' }],
    run({ as_of }) {
      const f = financialPosition(as_of);
      return { subtitle: `As at ${as_of || today()} · ${f.totals.balanced ? 'balanced' : 'OUT OF BALANCE'}`, columns: [C('line', 'Line item'), C('code', 'Code'), C('account', 'Account'), C('amount', 'Amount', 'money')], rows: f.rows, meta: f.totals };
    },
  },
  general_ledger: {
    title: 'General ledger — account detail', group: 'Ledgers', params: [{ key: 'account', label: 'Account', type: 'account', required: true }, { key: 'from', label: 'From', type: 'date', default: 'year_start' }, { key: 'to', label: 'To', type: 'date' }],
    run({ account, from, to }) {
      const l = accountLedger(account || ACC.BANK, from || yearStart(), to || today());
      if (!l) return { subtitle: 'Unknown account', columns: [], rows: [] };
      const rows = [{ date: l.from, entry: '', memo: 'Opening balance', source: '', debit: null, credit: null, balance: l.opening_balance, _style: 'subtotal' },
        ...l.lines.map(x => ({ date: x.entry_date, entry: x.entry_number, memo: x.description || x.memo, source: x.source_type, debit: x.debit || null, credit: x.credit || null, balance: x.balance, _drill: { entry_id: x.entry_id } }))];
      return { title: `General ledger — ${l.account.code} ${l.account.name}`, subtitle: `${l.from} to ${l.to}`, columns: [C('date', 'Date'), C('entry', 'Entry'), C('memo', 'Description'), C('source', 'Source'), C('debit', 'Debit', 'money'), C('credit', 'Credit', 'money'), C('balance', 'Balance', 'money')],
        rows, totals: { memo: 'Period totals / closing balance', debit: l.total_debit, credit: l.total_credit, balance: l.closing_balance } };
    },
  },
  journal_register: {
    title: 'Journal register', group: 'Ledgers', params: [{ key: 'from', label: 'From', type: 'date', default: 'month_start' }, { key: 'to', label: 'To', type: 'date' }, { key: 'source', label: 'Source', type: 'select', options: ['', 'invoice', 'payment', 'expense', 'voucher', 'deposit', 'manual', 'opening_balance', 'depreciation', 'accrual', 'ecl', 'tax_provision', 'write_off', 'claim'] }],
    run({ from, to, source }) {
      from = from || today().slice(0, 8) + '01'; to = to || today();
      const rows = db.prepare(`SELECT e.id, e.entry_number, e.entry_date, e.memo, e.source_type, a.code, a.name, l.debit, l.credit, u.full_name as by_name
          FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN chart_of_accounts a ON a.id = l.account_id LEFT JOIN users u ON u.id = e.created_by
          WHERE e.entry_date BETWEEN ? AND ? ${source ? 'AND e.source_type = ?' : ''} ORDER BY e.entry_date, e.id, l.id`).all(from, to, ...(source ? [source] : []))
        .map(r => ({ date: r.entry_date, entry: r.entry_number, memo: r.memo, source: r.source_type, code: r.code, account: r.name, debit: r.debit || null, credit: r.credit || null, by: r.by_name, _drill: { entry_id: r.id } }));
      return { subtitle: `${from} to ${to}`, columns: [C('date', 'Date'), C('entry', 'Entry'), C('memo', 'Memo'), C('source', 'Source'), C('code', 'Code'), C('account', 'Account'), C('debit', 'Debit', 'money'), C('credit', 'Credit', 'money'), C('by', 'Posted by')],
        rows, totals: { memo: 'TOTAL', debit: sumBy(rows, 'debit'), credit: sumBy(rows, 'credit') } };
    },
  },
  cash_book: {
    title: 'Cash book (receipts & payments)', group: 'Ledgers', params: [{ key: 'from', label: 'From', type: 'date', default: 'month_start' }, { key: 'to', label: 'To', type: 'date' }],
    run({ from, to }) {
      from = from || today().slice(0, 8) + '01'; to = to || today();
      const rows = db.prepare(`SELECT e.id, e.entry_date, e.entry_number, e.memo, e.source_type, a.code, a.name, l.debit, l.credit FROM journal_lines l
          JOIN chart_of_accounts a ON a.id = l.account_id AND substr(a.code,1,2) = '10' JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.entry_date BETWEEN ? AND ? ORDER BY e.entry_date, e.id`).all(from, to)
        .map(r => ({ date: r.entry_date, entry: r.entry_number, account: `${r.code} ${r.name}`, memo: r.memo, source: r.source_type, receipts: r.debit || null, payments: r.credit || null, _drill: { entry_id: r.id } }));
      return { subtitle: `${from} to ${to}`, columns: [C('date', 'Date'), C('entry', 'Entry'), C('account', 'Cash / bank account'), C('memo', 'Memo'), C('source', 'Source'), C('receipts', 'Receipts', 'money'), C('payments', 'Payments', 'money')],
        rows, totals: { memo: 'TOTAL (net movement ' + r2(sumBy(rows, 'receipts') - sumBy(rows, 'payments')).toLocaleString('en-NG') + ')', receipts: sumBy(rows, 'receipts'), payments: sumBy(rows, 'payments') } };
    },
  },
  ar_aging: {
    title: 'Receivables ageing & expected credit loss', group: 'Receivables & payables', params: [{ key: 'as_of', label: 'As at', type: 'date' }],
    run({ as_of }) {
      const a = arAging(as_of);
      return { subtitle: `As at ${as_of || today()} · ECL provision matrix (IFRS 9 simplified approach): ${a.rate.current}% / ${a.rate.b1}% / ${a.rate.b2}% / ${a.rate.b3}% / ${a.rate.b4}%`,
        columns: [C('customer', 'Customer'), C('invoices', 'Open invoices', 'integer'), C('current', 'Not yet due', 'money'), C('b1', '1–30 days', 'money'), C('b2', '31–60 days', 'money'), C('b3', '61–90 days', 'money'), C('b4', 'Over 90 days', 'money'), C('total', 'Total', 'money'), C('ecl', 'ECL required', 'money')],
        rows: a.rows, totals: a.totals };
    },
  },
  ap_aging: {
    title: 'Payables ageing (unpaid vendor bills)', group: 'Receivables & payables', params: [{ key: 'as_of', label: 'As at', type: 'date' }],
    run({ as_of }) {
      as_of = as_of || today();
      const rows = db.prepare(`SELECT id, expense_number, vendor_name, expense_date, COALESCE(due_date, date(expense_date, '+30 days')) as due, ROUND(amount + vat_amount, 2) as gross, wht_amount, is_legacy
          FROM expenses WHERE status = 'pending' AND expense_date <= ? ORDER BY vendor_name, due`).all(as_of)
        .map(r => { const d = daysBetween(r.due, as_of); return { vendor: r.vendor_name || '—', bill: r.expense_number + (r.is_legacy ? ' (legacy)' : ''), date: r.expense_date, due: r.due, days_overdue: Math.max(0, d), bucket: d <= 0 ? 'Not yet due' : d <= 30 ? '1–30' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : 'Over 90', gross: r.gross, wht: r.wht_amount, net_payable: r2(r.gross - r.wht_amount), _drill: { expense_id: r.id } }; });
      return { subtitle: `As at ${as_of}`, columns: [C('vendor', 'Vendor'), C('bill', 'Bill'), C('date', 'Bill date'), C('due', 'Due'), C('days_overdue', 'Days overdue', 'integer'), C('bucket', 'Bucket'), C('gross', 'Gross', 'money'), C('wht', 'WHT to deduct', 'money'), C('net_payable', 'Cash to pay', 'money')],
        rows, totals: { vendor: 'TOTAL', gross: sumBy(rows, 'gross'), wht: sumBy(rows, 'wht'), net_payable: sumBy(rows, 'net_payable') } };
    },
  },
  vat_schedule: {
    title: 'VAT return schedule (output & input)', group: 'Tax (NRS)', params: [{ key: 'month', label: 'Month', type: 'month' }],
    run({ month }) {
      month = month || today().slice(0, 7);
      const t = taxReport(month);
      const rows = [
        { _style: 'section', section: 'OUTPUT VAT — sales invoices' },
        ...t.output_vat.invoices.map(i => ({ section: 'Output', date: i.issue_date, document: i.invoice_number, party: i.customer, tin: i.customer_tin, irn: i.irn, net: i.net, vat: i.vat, _drill: { invoice_id: i.id } })),
        { _style: 'subtotal', section: 'Output VAT', net: t.output_vat.taxable_supplies + t.output_vat.outside_scope_supplies, vat: t.output_vat.vat_charged },
        { _style: 'section', section: 'INPUT VAT — vendor tax invoices' },
        ...t.input_vat.items.map(i => ({ section: 'Input', date: i.entry_date, document: `${i.expense_number} / ${i.vendor_invoice_no || ''}`, party: i.vendor_name, tin: i.vendor_tin, irn: '', net: i.amount, vat: i.vat })),
        { _style: 'subtotal', section: 'Input VAT claimed', vat: t.input_vat.claimed },
        { _style: 'total', section: `NET VAT ${t.net_vat.position.toUpperCase()} — due ${t.period.vat_return_due}`, vat: t.net_vat.payable },
      ];
      return { subtitle: `${t.period.from} to ${t.period.to} · file & pay by ${t.period.vat_return_due}`, columns: [C('section', 'Section'), C('date', 'Date'), C('document', 'Document'), C('party', 'Customer / vendor'), C('tin', 'TIN'), C('irn', 'NRS IRN'), C('net', 'Net', 'money'), C('vat', 'VAT', 'money')], rows,
        notes: [`${t.output_vat.not_cleared_on_nrs} invoice(s) in the period are not yet cleared on the NRS MBS.`] };
    },
  },
  wht_schedule: {
    title: 'WHT schedule (credits & remittances)', group: 'Tax (NRS)', params: [{ key: 'month', label: 'Month', type: 'month' }],
    run({ month }) {
      month = month || today().slice(0, 7);
      const t = taxReport(month);
      const rows = [
        { _style: 'section', kind: 'WHT DEDUCTED BY CUSTOMERS — tax credits (114000)' },
        ...t.wht_deducted_by_customers.items.map(p => ({ kind: 'Credit', date: String(p.received_at).slice(0, 10), document: `${p.payment_ref} / ${p.invoice_number}`, party: p.customer, tin: p.tin, reference: p.wht_credit_note_no || 'CREDIT NOTE OUTSTANDING', amount: p.wht_amount })),
        { _style: 'subtotal', kind: 'Total WHT credits', amount: t.wht_deducted_by_customers.total },
        { _style: 'section', kind: 'WHT WITHHELD FROM VENDORS — remit to NRS (212000)' },
        ...t.wht_withheld_from_vendors.items.map(p => ({ kind: `Remit (${p.wht_rate}%)`, date: p.entry_date, document: p.expense_number, party: p.vendor_name, tin: p.vendor_tin || 'NO TIN — rate doubled', reference: '', amount: p.wht })),
        { _style: 'total', kind: `Total WHT to remit by ${t.period.wht_remittance_due}`, amount: t.wht_withheld_from_vendors.total },
      ];
      return { subtitle: `${t.period.from} to ${t.period.to}`, columns: [C('kind', 'Type'), C('date', 'Date'), C('document', 'Document'), C('party', 'Customer / vendor'), C('tin', 'TIN'), C('reference', 'Credit note / ref'), C('amount', 'WHT', 'money')], rows };
    },
  },
  revenue_disaggregation: {
    title: 'Revenue disaggregation (IFRS 15.114 / IFRS 16.90)', group: 'Revenue & operations', params: [{ key: 'from', label: 'From', type: 'date', default: 'year_start' }, { key: 'to', label: 'To', type: 'date' }],
    run({ from, to }) {
      from = from || yearStart(); to = to || today();
      const rows = db.prepare(`SELECT COALESCE(ii.gl_code, '') as gl, COALESCE(a.name, ii.category) as account, COALESCE(a.ifrs_line, '') as standard, COALESCE(cat.name, CASE ii.category WHEN 'service' THEN 'Crew & services' WHEN 'goods' THEN 'Consumables' ELSE 'Other / fees' END) as stream,
          COUNT(DISTINCT i.id) as invoices, ROUND(SUM(ii.amount), 2) as net, ROUND(SUM(ii.vat_amount), 2) as vat
          FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id AND i.status != 'void' AND i.is_legacy = 0
          LEFT JOIN chart_of_accounts a ON a.code = ii.gl_code LEFT JOIN equipment e ON e.id = ii.equipment_id LEFT JOIN equipment_categories cat ON cat.id = e.category_id
          WHERE i.issue_date BETWEEN ? AND ? GROUP BY gl, stream ORDER BY gl, net DESC`).all(from, to);
      return { subtitle: `${from} to ${to} · excl. VAT`, columns: [C('gl', 'GL'), C('account', 'Revenue account'), C('standard', 'Presentation'), C('stream', 'Equipment category / stream'), C('invoices', 'Invoices', 'integer'), C('net', 'Revenue', 'money'), C('vat', 'VAT charged', 'money')],
        rows, totals: { account: 'TOTAL', net: sumBy(rows, 'net'), vat: sumBy(rows, 'vat') } };
    },
  },
  revenue_by_customer: {
    title: 'Revenue by customer', group: 'Revenue & operations', params: [{ key: 'from', label: 'From', type: 'date', default: 'year_start' }, { key: 'to', label: 'To', type: 'date' }],
    run({ from, to }) {
      from = from || yearStart(); to = to || today();
      const rows = db.prepare(`SELECT c.id, COALESCE(c.company_name, c.full_name) as customer, c.tin, COUNT(i.id) as invoices, ROUND(SUM(i.subtotal),2) as net, ROUND(SUM(i.vat_total),2) as vat,
          ROUND(SUM(i.grand_total),2) as gross, ROUND(SUM(i.amount_paid),2) as settled, ROUND(SUM(i.grand_total - i.amount_paid),2) as outstanding
          FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status != 'void' AND i.issue_date BETWEEN ? AND ? GROUP BY c.id ORDER BY net DESC`).all(from, to)
        .map(r => ({ ...r, _drill: { customer_id: r.id } }));
      return { subtitle: `${from} to ${to}`, columns: [C('customer', 'Customer'), C('tin', 'TIN'), C('invoices', 'Invoices', 'integer'), C('net', 'Net revenue', 'money'), C('vat', 'VAT', 'money'), C('gross', 'Gross', 'money'), C('settled', 'Settled', 'money'), C('outstanding', 'Outstanding', 'money')],
        rows, totals: { customer: 'TOTAL', invoices: rows.reduce((a, r) => a + r.invoices, 0), net: sumBy(rows, 'net'), vat: sumBy(rows, 'vat'), gross: sumBy(rows, 'gross'), settled: sumBy(rows, 'settled'), outstanding: sumBy(rows, 'outstanding') } };
    },
  },
  equipment_utilisation: {
    title: 'Equipment utilisation & yield', group: 'Revenue & operations', params: [{ key: 'from', label: 'From', type: 'date', default: 'days_90' }, { key: 'to', label: 'To', type: 'date' }],
    run({ from, to }) {
      to = to || today(); from = from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      const span = Math.max(1, daysBetween(from, to) + 1);
      const eq = db.prepare(`SELECT e.id, e.asset_code, e.name, cat.name as category, e.status, e.daily_rate, e.purchase_cost FROM equipment e LEFT JOIN equipment_categories cat ON cat.id = e.category_id WHERE e.disposed_at IS NULL ORDER BY e.asset_code`).all();
      const usage = db.prepare(`SELECT ai.equipment_id, substr(ai.checkout_at,1,10) as o, COALESCE(substr(ai.checkin_at,1,10), date('now')) as i FROM agreement_items ai WHERE ai.checkout_at IS NOT NULL`).all();
      const rev = {}; for (const r of db.prepare(`SELECT ii.equipment_id, SUM(ii.amount) a FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id AND i.status != 'void' WHERE ii.category IN ('rental','fee') AND i.issue_date BETWEEN ? AND ? GROUP BY ii.equipment_id`).all(from, to)) rev[r.equipment_id] = r.a;
      const rows = eq.map(e => {
        let days = 0;
        for (const u of usage.filter(x => x.equipment_id === e.id)) { const s = u.o > from ? u.o : from, f = u.i < to ? u.i : to; if (f >= s) days += daysBetween(s, f) + 1; }
        const revenue = r2(rev[e.id] || 0);
        return { code: e.asset_code, name: e.name, category: e.category, status: e.status, days_on_rent: days, utilisation: r2(Math.min(100, days * 100 / span)), revenue, yield_pct: e.purchase_cost > 0 ? r2(revenue * 100 / e.purchase_cost) : null, _drill: { equipment_id: e.id } };
      }).sort((a, b) => b.revenue - a.revenue);
      return { subtitle: `${from} to ${to} (${span} days)`, columns: [C('code', 'Code'), C('name', 'Equipment'), C('category', 'Category'), C('status', 'Status'), C('days_on_rent', 'Days on rent', 'integer'), C('utilisation', 'Utilisation %', 'number'), C('revenue', 'Rental revenue', 'money'), C('yield_pct', 'Revenue / cost %', 'number')],
        rows, totals: { name: 'TOTAL / AVERAGE', days_on_rent: rows.reduce((a, r) => a + r.days_on_rent, 0), utilisation: rows.length ? r2(rows.reduce((a, r) => a + r.utilisation, 0) / rows.length) : 0, revenue: sumBy(rows, 'revenue') } };
    },
  },
  fixed_asset_register: {
    title: 'Fixed asset register (IAS 16)', group: 'Assets', params: [{ key: 'as_of', label: 'As at', type: 'date' }],
    run({ as_of }) {
      as_of = as_of || today();
      const dep = postedDepreciation(as_of);
      const rows = db.prepare(`SELECT e.id, e.asset_code, e.name, e.serial_number, cat.name as category, l.name as location, e.purchase_date, e.purchase_cost, e.salvage_value, e.useful_life_years, e.opening_accumulated_depreciation, e.status, e.disposed_at
          FROM equipment e LEFT JOIN equipment_categories cat ON cat.id = e.category_id LEFT JOIN locations l ON l.id = e.location_id
          WHERE e.depreciable = 1 AND e.purchase_cost > 0 AND (e.disposed_at IS NULL OR e.disposed_at > ?) ORDER BY cat.name, e.asset_code`).all(as_of)
        .map(e => { const acc = r2((e.opening_accumulated_depreciation || 0) + (dep[e.id] || 0)); return { code: e.asset_code, name: e.name, serial: e.serial_number, category: e.category, location: e.location, acquired: e.purchase_date, life: e.useful_life_years, cost: e.purchase_cost, acc_dep: acc, nbv: r2(e.purchase_cost - acc), status: e.status, _drill: { equipment_id: e.id } }; });
      return { subtitle: `As at ${as_of} · straight-line over useful life to residual value`, columns: [C('code', 'Code'), C('name', 'Asset'), C('serial', 'Serial'), C('category', 'Category'), C('location', 'Location'), C('acquired', 'Acquired'), C('life', 'Life (yrs)', 'integer'), C('cost', 'Cost', 'money'), C('acc_dep', 'Accum. depreciation', 'money'), C('nbv', 'Net book value', 'money'), C('status', 'Status')],
        rows, totals: { name: 'TOTAL', cost: sumBy(rows, 'cost'), acc_dep: sumBy(rows, 'acc_dep'), nbv: sumBy(rows, 'nbv') } };
    },
  },
  bookings_register: {
    title: 'Bookings register', group: 'Revenue & operations', params: [{ key: 'from', label: 'Start from', type: 'date', default: 'month_start' }, { key: 'to', label: 'Start to', type: 'date' }, { key: 'status', label: 'Status', type: 'select', options: ['', 'reserved', 'active', 'overdue', 'returned', 'cancelled'] }],
    run({ from, to, status }) {
      from = from || today().slice(0, 8) + '01'; to = to || '9999-12-31';
      const rows = db.prepare(`SELECT ra.id, ra.agreement_number, c.full_name as customer, ra.project_name, ra.production_type, l.name as location, ra.start_date, ra.expected_return_date, ra.actual_return_date, ra.status,
          (SELECT COUNT(*) FROM agreement_items ai WHERE ai.agreement_id = ra.id) as items, ra.deposit_received - ra.deposit_refunded - ra.deposit_applied as deposit_held,
          (SELECT ROUND(SUM(grand_total),2) FROM invoices i WHERE i.agreement_id = ra.id AND i.status != 'void') as invoiced
          FROM rental_agreements ra JOIN customers c ON c.id = ra.customer_id LEFT JOIN locations l ON l.id = ra.location_id
          WHERE ra.start_date BETWEEN ? AND ? ${status ? 'AND ra.status = ?' : ''} ORDER BY ra.start_date`).all(from, to, ...(status ? [status] : []))
        .map(r => ({ booking: r.agreement_number, customer: r.customer, project: r.project_name, type: r.production_type, location: r.location, start: r.start_date, due: r.expected_return_date, returned: r.actual_return_date, status: r.status, items: r.items, deposit_held: r2(r.deposit_held), invoiced: r.invoiced || 0, _drill: { agreement_id: r.id } }));
      return { subtitle: `Starting ${from}${to !== '9999-12-31' ? ' to ' + to : ' onward'}`, columns: [C('booking', 'Booking'), C('customer', 'Customer'), C('project', 'Production'), C('type', 'Type'), C('location', 'Location'), C('start', 'Start'), C('due', 'Due back'), C('returned', 'Returned'), C('status', 'Status'), C('items', 'Items', 'integer'), C('deposit_held', 'Deposit held', 'money'), C('invoiced', 'Invoiced', 'money')],
        rows, totals: { booking: 'TOTAL', items: rows.reduce((a, r) => a + r.items, 0), deposit_held: sumBy(rows, 'deposit_held'), invoiced: sumBy(rows, 'invoiced') } };
    },
  },
  deposits_held: {
    title: 'Customer deposits & caution fees held', group: 'Receivables & payables', params: [],
    run() {
      const rows = db.prepare(`SELECT ra.id, ra.agreement_number, c.full_name as customer, ra.status, ra.deposit_amount, ra.deposit_received, ra.deposit_applied, ra.deposit_refunded,
          ROUND(ra.deposit_received - ra.deposit_applied - ra.deposit_refunded, 2) as held FROM rental_agreements ra JOIN customers c ON c.id = ra.customer_id
          WHERE ra.deposit_received > 0 ORDER BY held DESC`).all().map(r => ({ booking: r.agreement_number, customer: r.customer, status: r.status, agreed: r.deposit_amount, received: r.deposit_received, applied: r.deposit_applied, refunded: r.deposit_refunded, held: r.held, _drill: { agreement_id: r.id } }));
      const gl = trialBalance().find(a => a.code === ACC.DEPOSITS_HELD);
      return { subtitle: `Reconciles to GL ${ACC.DEPOSITS_HELD}: ${(gl ? -gl.balance : 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, columns: [C('booking', 'Booking'), C('customer', 'Customer'), C('status', 'Status'), C('agreed', 'Agreed', 'money'), C('received', 'Received', 'money'), C('applied', 'Applied', 'money'), C('refunded', 'Refunded', 'money'), C('held', 'Held', 'money')],
        rows, totals: { booking: 'TOTAL', received: sumBy(rows, 'received'), applied: sumBy(rows, 'applied'), refunded: sumBy(rows, 'refunded'), held: sumBy(rows, 'held') } };
    },
  },
  einvoice_register: {
    title: 'NRS e-invoice register', group: 'Tax (NRS)', params: [{ key: 'from', label: 'From', type: 'date', default: 'month_start' }, { key: 'to', label: 'To', type: 'date' }],
    run({ from, to }) {
      from = from || today().slice(0, 8) + '01'; to = to || today();
      const rows = db.prepare(`SELECT i.id, i.invoice_number, i.issue_date, i.transaction_model, COALESCE(c.company_name, c.full_name) as customer, i.customer_tin, i.grand_total, i.vat_total, i.status, i.einvoice_status, i.einvoice_irn, i.einvoice_cleared_at, i.credit_note_number, i.einvoice_error
          FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.is_legacy = 0 AND i.issue_date BETWEEN ? AND ? ORDER BY i.invoice_number`).all(from, to)
        .map(r => ({ invoice: r.invoice_number, date: r.issue_date, model: r.transaction_model, customer: r.customer, tin: r.customer_tin, total: r.grand_total, vat: r.vat_total, status: r.status, nrs: r.einvoice_status, irn: r.einvoice_irn, cleared: r.einvoice_cleared_at ? String(r.einvoice_cleared_at).slice(0, 16).replace('T', ' ') : '', credit_note: r.credit_note_number, issue: r.einvoice_error, _drill: { invoice_id: r.id } }));
      return { subtitle: `${from} to ${to}`, columns: [C('invoice', 'Invoice'), C('date', 'Date'), C('model', 'Model'), C('customer', 'Customer'), C('tin', 'Buyer TIN'), C('total', 'Total', 'money'), C('vat', 'VAT', 'money'), C('status', 'Status'), C('nrs', 'NRS status'), C('irn', 'IRN'), C('cleared', 'Cleared at'), C('credit_note', 'Credit note'), C('issue', 'Last error')],
        rows, totals: { invoice: 'TOTAL', total: sumBy(rows, 'total'), vat: sumBy(rows, 'vat') } };
    },
  },
};

function defaultParam(d) {
  if (d === 'year_start') return yearStart();
  if (d === 'month_start') return today().slice(0, 8) + '01';
  if (d === 'days_90') return new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  return '';
}

function runReport(key, params = {}) {
  const def = REPORTS[key]; if (!def) return null;
  const p = { ...params };
  for (const prm of def.params) if (!p[prm.key] && prm.default) p[prm.key] = defaultParam(prm.default);
  for (const prm of def.params) {
    if (p[prm.key] && prm.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(p[prm.key])) throw Object.assign(new Error(`${prm.label} must be a date (YYYY-MM-DD)`), { status: 400 });
    if (p[prm.key] && prm.type === 'month' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(p[prm.key])) throw Object.assign(new Error(`${prm.label} must be YYYY-MM`), { status: 400 });
  }
  const out = def.run(p);
  return { key, title: out.title || def.title, subtitle: out.subtitle || '', columns: out.columns, rows: out.rows, totals: out.totals || null, notes: out.notes || [], meta: out.meta || null, params: p };
}

function catalog() {
  return Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, group: r.group, params: r.params }));
}

// ============================ REPORT BUILDER ============================
// Each source is a whitelisted SELECT with named fields; user choices only ever pick from these names,
// so no user text is concatenated into SQL (values are always bound parameters).
const F = (key, label, sql, type = 'text') => ({ key, label, sql, type });
const SOURCES = {
  invoices: {
    label: 'Invoices', from: `invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN rental_agreements ra ON ra.id = i.agreement_id`,
    fields: [F('invoice_number', 'Invoice no.', 'i.invoice_number'), F('issue_date', 'Issue date', 'i.issue_date', 'date'), F('issue_month', 'Issue month', "substr(i.issue_date,1,7)"), F('due_date', 'Due date', 'i.due_date', 'date'),
      F('customer', 'Customer', 'COALESCE(c.company_name, c.full_name)'), F('customer_tin', 'Customer TIN', 'i.customer_tin'), F('customer_type', 'Customer type', 'c.customer_type'), F('booking', 'Booking', 'ra.agreement_number'),
      F('production_type', 'Production type', 'ra.production_type'), F('kind', 'Invoice kind', 'i.invoice_kind'), F('status', 'Status', 'i.status'), F('model', 'B2B/B2C/B2G', 'i.transaction_model'),
      F('net', 'Net (excl. VAT)', 'i.subtotal', 'money'), F('vat', 'VAT', 'i.vat_total', 'money'), F('gross', 'Gross', 'i.grand_total', 'money'), F('paid', 'Settled', 'i.amount_paid', 'money'),
      F('balance', 'Balance', 'ROUND(i.grand_total - i.amount_paid, 2)', 'money'), F('wht_expected', 'WHT expected', 'i.wht_total', 'money'), F('wht_credited', 'WHT credited', 'i.wht_credited', 'money'),
      F('nrs_status', 'NRS status', 'i.einvoice_status'), F('irn', 'IRN', 'i.einvoice_irn'), F('legacy', 'Legacy?', "CASE WHEN i.is_legacy = 1 THEN 'Yes' ELSE 'No' END")],
    drill: { key: 'invoice_id', sql: 'i.id' },
  },
  invoice_lines: {
    label: 'Invoice lines', from: `invoice_items ii JOIN invoices i ON i.id = ii.invoice_id JOIN customers c ON c.id = i.customer_id LEFT JOIN equipment e ON e.id = ii.equipment_id LEFT JOIN equipment_categories cat ON cat.id = e.category_id LEFT JOIN chart_of_accounts a ON a.code = ii.gl_code`,
    fields: [F('invoice_number', 'Invoice no.', 'i.invoice_number'), F('issue_date', 'Issue date', 'i.issue_date', 'date'), F('issue_month', 'Issue month', "substr(i.issue_date,1,7)"), F('customer', 'Customer', 'COALESCE(c.company_name, c.full_name)'),
      F('description', 'Description', 'ii.description'), F('tax_category', 'Tax category', 'ii.category'), F('gl_code', 'GL code', 'ii.gl_code'), F('gl_name', 'GL account', 'a.name'),
      F('equipment', 'Equipment', 'e.name'), F('equipment_category', 'Equipment category', 'cat.name'), F('qty', 'Quantity', 'ii.quantity', 'number'), F('amount', 'Net amount', 'ii.amount', 'money'),
      F('vat', 'VAT', 'ii.vat_amount', 'money'), F('wht', 'WHT expected', 'ii.wht_amount', 'money'), F('invoice_status', 'Invoice status', 'i.status')],
    drill: { key: 'invoice_id', sql: 'i.id' }, baseWhere: "i.status != 'void'",
  },
  payments: {
    label: 'Receipts', from: `payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.received_by`,
    fields: [F('payment_ref', 'Receipt no.', 'p.payment_ref'), F('date', 'Date', 'date(p.received_at)', 'date'), F('month', 'Month', "substr(p.received_at,1,7)"), F('invoice', 'Invoice', 'i.invoice_number'),
      F('customer', 'Customer', 'COALESCE(c.company_name, c.full_name)'), F('method', 'Method', 'p.method'), F('cash', 'Cash / bank', 'p.amount', 'money'), F('wht', 'WHT deducted', 'p.wht_amount', 'money'),
      F('credit_note', 'WHT credit note', 'p.wht_credit_note_no'), F('received_by', 'Received by', 'u.full_name'), F('reversed', 'Reversed?', "CASE WHEN p.reversed_at IS NULL THEN 'No' ELSE 'Yes' END")],
    drill: { key: 'invoice_id', sql: 'i.id' },
  },
  bookings: {
    label: 'Bookings', from: `rental_agreements ra JOIN customers c ON c.id = ra.customer_id LEFT JOIN locations l ON l.id = ra.location_id LEFT JOIN kits k ON k.id = ra.kit_id`,
    fields: [F('booking', 'Booking', 'ra.agreement_number'), F('customer', 'Customer', 'COALESCE(c.company_name, c.full_name)'), F('project', 'Production', 'ra.project_name'), F('production_type', 'Production type', 'ra.production_type'),
      F('location', 'Location', 'l.name'), F('kit', 'Kit', 'k.name'), F('start_date', 'Start', 'ra.start_date', 'date'), F('start_month', 'Start month', "substr(ra.start_date,1,7)"), F('due_back', 'Due back', 'ra.expected_return_date', 'date'),
      F('returned', 'Returned', 'ra.actual_return_date', 'date'), F('status', 'Status', 'ra.status'), F('days', 'Days', "MAX(1, CAST(julianday(COALESCE(ra.actual_return_date, ra.expected_return_date)) - julianday(ra.start_date) AS INTEGER))", 'integer'),
      F('items', 'Items', '(SELECT COUNT(*) FROM agreement_items ai WHERE ai.agreement_id = ra.id)', 'integer'), F('deposit_held', 'Deposit held', 'ROUND(ra.deposit_received - ra.deposit_applied - ra.deposit_refunded, 2)', 'money'),
      F('invoiced', 'Invoiced', "(SELECT COALESCE(SUM(grand_total),0) FROM invoices i WHERE i.agreement_id = ra.id AND i.status != 'void')", 'money'), F('cancellation_fee', 'Cancellation fee', 'ra.cancellation_fee', 'money')],
    drill: { key: 'agreement_id', sql: 'ra.id' },
  },
  booking_items: {
    label: 'Booked equipment lines', from: `agreement_items ai JOIN rental_agreements ra ON ra.id = ai.agreement_id JOIN customers c ON c.id = ra.customer_id JOIN equipment e ON e.id = ai.equipment_id LEFT JOIN equipment_categories cat ON cat.id = e.category_id`,
    fields: [F('booking', 'Booking', 'ra.agreement_number'), F('customer', 'Customer', 'COALESCE(c.company_name, c.full_name)'), F('asset_code', 'Asset code', 'e.asset_code'), F('equipment', 'Equipment', 'e.name'),
      F('category', 'Category', 'cat.name'), F('rate_type', 'Rate type', 'ai.rate_type'), F('rate', 'Rate', 'ai.rate', 'money'), F('checked_out', 'Checked out', 'date(ai.checkout_at)', 'date'), F('checked_in', 'Checked in', 'date(ai.checkin_at)', 'date'),
      F('damage', 'Damage charge', 'ai.damage_charge', 'money'), F('lost', 'Lost?', "CASE WHEN ai.is_lost = 1 THEN 'Yes' ELSE 'No' END"), F('replacement', 'Replacement charge', 'ai.replacement_charge', 'money'), F('booking_status', 'Booking status', 'ra.status')],
    drill: { key: 'agreement_id', sql: 'ra.id' },
  },
  equipment: {
    label: 'Equipment', from: `equipment e LEFT JOIN equipment_categories cat ON cat.id = e.category_id LEFT JOIN locations l ON l.id = e.location_id`,
    fields: [F('asset_code', 'Asset code', 'e.asset_code'), F('name', 'Name', 'e.name'), F('category', 'Category', 'cat.name'), F('brand', 'Brand', 'e.brand'), F('model', 'Model', 'e.model'), F('serial', 'Serial', 'e.serial_number'),
      F('status', 'Status', 'e.status'), F('location', 'Location', 'l.name'), F('condition', 'Condition', 'e.condition_grade'), F('daily_rate', 'Daily rate', 'e.daily_rate', 'money'), F('weekly_rate', 'Weekly rate', 'e.weekly_rate', 'money'),
      F('replacement_value', 'Replacement value', 'e.replacement_value', 'money'), F('purchase_cost', 'Cost', 'e.purchase_cost', 'money'), F('purchase_date', 'Acquired', 'e.purchase_date', 'date'),
      F('times_rented', 'Times rented', '(SELECT COUNT(*) FROM agreement_items ai WHERE ai.equipment_id = e.id AND ai.checkout_at IS NOT NULL)', 'integer'),
      F('revenue', 'Revenue to date', "(SELECT COALESCE(SUM(ii.amount),0) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id AND i.status != 'void' WHERE ii.equipment_id = e.id AND ii.category IN ('rental','fee'))", 'money'),
      F('with_operator', 'Includes operator?', "CASE WHEN e.includes_operator = 1 THEN 'Yes' ELSE 'No' END")],
    drill: { key: 'equipment_id', sql: 'e.id' },
  },
  customers: {
    label: 'Customers', from: 'customers c',
    fields: [F('name', 'Name', 'c.full_name'), F('company', 'Company', 'c.company_name'), F('type', 'Type', 'c.customer_type'), F('email', 'Email', 'c.email'), F('phone', 'Phone', 'c.phone'), F('city', 'City', 'c.city'), F('state', 'State', 'c.state'),
      F('tin', 'TIN', 'c.tin'), F('wht_agent', 'Deducts WHT?', "CASE WHEN c.wht_agent = 1 THEN 'Yes' ELSE 'No' END"), F('credit_limit', 'Credit limit', 'c.credit_limit', 'money'), F('outstanding', 'Outstanding', 'c.outstanding_balance', 'money'),
      F('coi_expiry', 'COI expiry', 'c.coi_expiry_date', 'date'), F('blacklisted', 'Blacklisted?', "CASE WHEN c.is_blacklisted = 1 THEN 'Yes' ELSE 'No' END"),
      F('lifetime_revenue', 'Lifetime revenue (net)', "(SELECT COALESCE(SUM(subtotal),0) FROM invoices i WHERE i.customer_id = c.id AND i.status != 'void')", 'money')],
    drill: { key: 'customer_id', sql: 'c.id' },
  },
  expenses: {
    label: 'Vendor bills / expenses', from: `expenses x LEFT JOIN chart_of_accounts a ON a.code = x.gl_code LEFT JOIN equipment e ON e.id = x.equipment_id`,
    fields: [F('number', 'Bill no.', 'x.expense_number'), F('date', 'Date', 'x.expense_date', 'date'), F('month', 'Month', 'substr(x.expense_date,1,7)'), F('category', 'Category', 'x.category'), F('gl_code', 'GL code', 'x.gl_code'), F('gl_name', 'GL account', 'a.name'),
      F('vendor', 'Vendor', 'x.vendor_name'), F('vendor_tin', 'Vendor TIN', 'x.vendor_tin'), F('vendor_invoice', 'Vendor invoice', 'x.vendor_invoice_no'), F('equipment', 'Equipment', 'e.name'), F('net', 'Net', 'x.amount', 'money'), F('vat', 'VAT', 'x.vat_amount', 'money'),
      F('input_vat_claimed', 'Input VAT claimed', 'x.input_vat_claimed', 'money'), F('wht', 'WHT', 'x.wht_amount', 'money'), F('status', 'Status', 'x.status')],
    drill: { key: 'expense_id', sql: 'x.id' },
  },
  journal_lines: {
    label: 'General ledger lines', from: `journal_lines l JOIN journal_entries je ON je.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id`,
    fields: [F('entry', 'Entry', 'je.entry_number'), F('date', 'Date', 'je.entry_date', 'date'), F('month', 'Month', 'substr(je.entry_date,1,7)'), F('code', 'Account code', 'a.code'), F('account', 'Account', 'a.name'), F('type', 'Account type', 'a.account_type'),
      F('ifrs_line', 'IFRS line', 'a.ifrs_line'), F('memo', 'Memo', 'je.memo'), F('description', 'Line description', 'l.description'), F('source', 'Source', 'je.source_type'), F('debit', 'Debit', 'l.debit', 'money'), F('credit', 'Credit', 'l.credit', 'money'),
      F('net', 'Net (Dr − Cr)', 'ROUND(l.debit - l.credit, 2)', 'money')],
    drill: { key: 'entry_id', sql: 'je.id' },
  },
  vouchers: {
    label: 'Payment vouchers', from: `payment_vouchers pv LEFT JOIN users u ON u.id = pv.raised_by LEFT JOIN expenses x ON x.id = pv.linked_expense_id`,
    fields: [F('pv', 'PV no.', 'pv.pv_number'), F('date', 'Raised', 'date(pv.created_at)', 'date'), F('payee', 'Payee', 'pv.payee_name'), F('purpose', 'Purpose', 'pv.purpose'), F('amount', 'Amount', 'pv.amount', 'money'),
      F('status', 'Status', 'pv.status'), F('level', 'Level', 'pv.current_level', 'integer'), F('raised_by', 'Raised by', 'u.full_name'), F('bill', 'Bill', 'x.expense_number')],
  },
  work_orders: {
    label: 'Work orders', from: `work_orders w JOIN equipment e ON e.id = w.equipment_id LEFT JOIN users u ON u.id = w.assigned_to`,
    fields: [F('wo', 'WO no.', 'w.wo_number'), F('equipment', 'Equipment', 'e.name'), F('asset_code', 'Asset code', 'e.asset_code'), F('type', 'Type', 'w.wo_type'), F('priority', 'Priority', 'w.priority'), F('status', 'Status', 'w.status'),
      F('opened', 'Opened', 'date(w.opened_at)', 'date'), F('completed', 'Completed', 'date(w.completed_at)', 'date'), F('labour', 'Labour cost', 'w.labor_cost', 'money'), F('parts', 'Parts cost', 'w.parts_cost', 'money'), F('assigned_to', 'Assigned to', 'u.full_name')],
    drill: { key: 'equipment_id', sql: 'e.id' },
  },
  consumable_issues: {
    label: 'Consumables issued', from: `agreement_consumables ac JOIN rental_consumables rc ON rc.id = ac.consumable_id JOIN rental_agreements ra ON ra.id = ac.agreement_id JOIN customers c ON c.id = ra.customer_id`,
    fields: [F('booking', 'Booking', 'ra.agreement_number'), F('customer', 'Customer', 'COALESCE(c.company_name, c.full_name)'), F('item', 'Item', 'rc.name'), F('code', 'Item code', 'rc.item_code'), F('qty', 'Qty', 'ac.qty', 'integer'),
      F('unit_price', 'Unit price', 'ac.unit_price', 'money'), F('total', 'Total', 'ROUND(ac.qty * ac.unit_price, 2)', 'money'), F('unit_cost', 'Unit cost', 'rc.unit_cost', 'money'), F('margin', 'Margin', 'ROUND(ac.qty * (ac.unit_price - rc.unit_cost), 2)', 'money'),
      F('billed', 'Billed?', "CASE WHEN ac.invoiced = 1 THEN 'Yes' ELSE 'No' END")],
    drill: { key: 'agreement_id', sql: 'ra.id' },
  },
  claims: {
    label: 'Insurance claims', from: `insurance_claims ic JOIN equipment e ON e.id = ic.equipment_id LEFT JOIN rental_agreements ra ON ra.id = ic.agreement_id`,
    fields: [F('claim', 'Claim no.', 'ic.claim_number'), F('equipment', 'Equipment', 'e.name'), F('booking', 'Booking', 'ra.agreement_number'), F('type', 'Incident', 'ic.incident_type'), F('date', 'Incident date', 'ic.incident_date', 'date'),
      F('insurer', 'Insurer', 'ic.insurer'), F('status', 'Status', 'ic.status'), F('claimed', 'Claimed', 'ic.amount_claimed', 'money'), F('excess', 'Excess', 'ic.excess', 'money'), F('settled', 'Settled', 'ic.amount_settled', 'money')],
  },
};

const OPS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'LIKE', not_contains: 'NOT LIKE', starts: 'LIKE', is_empty: 'empty', not_empty: 'notempty', between: 'between', in: 'in' };
const AGGS = ['sum', 'count', 'avg', 'min', 'max', 'count_distinct'];

function builderSources() {
  return Object.entries(SOURCES).map(([key, s]) => ({ key, label: s.label, fields: s.fields.map(f => ({ key: f.key, label: f.label, type: f.type })) }));
}

/**
 * def: { source, columns: [fieldKey], filters: [{field, op, value, value2}], group_by: [fieldKey], aggregates: [{field, fn}], sort: [{field, dir}], limit }
 */
function runBuilder(def) {
  const src = SOURCES[def.source];
  if (!src) throw Object.assign(new Error('Unknown data source'), { status: 400 });
  const field = (k) => { const f = src.fields.find(x => x.key === k); if (!f) throw Object.assign(new Error(`Unknown field "${k}" for ${src.label}`), { status: 400 }); return f; };
  const where = [], params = [];
  if (src.baseWhere) where.push(src.baseWhere);
  for (const flt of (def.filters || [])) {
    if (!flt || !flt.field || !flt.op) continue;
    const f = field(flt.field); const op = OPS[flt.op];
    if (!op) throw Object.assign(new Error(`Unknown operator ${flt.op}`), { status: 400 });
    const numeric = ['money', 'number', 'integer'].includes(f.type);
    const v = (x) => numeric ? Number(x) : String(x ?? '');
    if (op === 'empty') where.push(`(${f.sql} IS NULL OR ${f.sql} = '')`);
    else if (op === 'notempty') where.push(`(${f.sql} IS NOT NULL AND ${f.sql} != '')`);
    else if (op === 'between') { where.push(`${f.sql} BETWEEN ? AND ?`); params.push(v(flt.value), v(flt.value2)); }
    else if (op === 'in') { const list = String(flt.value || '').split(',').map(s => s.trim()).filter(Boolean); if (list.length) { where.push(`${f.sql} IN (${list.map(() => '?').join(',')})`); params.push(...list.map(v)); } }
    else if (flt.op === 'contains' || flt.op === 'not_contains') { where.push(`${f.sql} ${op} ?`); params.push(`%${flt.value ?? ''}%`); }
    else if (flt.op === 'starts') { where.push(`${f.sql} LIKE ?`); params.push(`${flt.value ?? ''}%`); }
    else { where.push(`${f.sql} ${op} ?`); params.push(v(flt.value)); }
  }
  const groupBy = (def.group_by || []).filter(Boolean).map(field);
  const aggs = (def.aggregates || []).filter(a => a && a.field && AGGS.includes(a.fn)).map(a => ({ ...a, f: field(a.field) }));
  let selects, columns, groupSql = '', drill = null;
  if (groupBy.length) {
    selects = groupBy.map(f => `${f.sql} AS "${f.key}"`);
    columns = groupBy.map(f => ({ key: f.key, header: f.label, type: f.type }));
    const list = aggs.length ? aggs : [{ fn: 'count', field: groupBy[0].key, f: groupBy[0] }];
    for (const a of list) {
      const k = `${a.fn}_${a.f.key}`;
      const expr = a.fn === 'count' ? 'COUNT(*)' : a.fn === 'count_distinct' ? `COUNT(DISTINCT ${a.f.sql})` : `ROUND(${a.fn.toUpperCase()}(${a.f.sql}), 2)`;
      selects.push(`${expr} AS "${k}"`);
      columns.push({ key: k, header: `${{ sum: 'Sum', count: 'Count', avg: 'Average', min: 'Min', max: 'Max', count_distinct: 'Distinct' }[a.fn]} of ${a.f.label}`, type: ['count', 'count_distinct'].includes(a.fn) ? 'integer' : (a.f.type === 'integer' ? 'number' : a.f.type) });
    }
    groupSql = ' GROUP BY ' + groupBy.map(f => f.sql).join(', ');
  } else {
    const cols = (def.columns && def.columns.length ? def.columns : src.fields.slice(0, 8).map(f => f.key)).map(field);
    selects = cols.map(f => `${f.sql} AS "${f.key}"`);
    columns = cols.map(f => ({ key: f.key, header: f.label, type: f.type }));
    if (src.drill) { selects.push(`${src.drill.sql} AS "__drill"`); drill = src.drill.key; }
  }
  const validKeys = new Set(columns.map(c => c.key));
  const order = (def.sort || []).filter(s => s && validKeys.has(s.field)).map(s => `"${s.field}" ${s.dir === 'desc' ? 'DESC' : 'ASC'}`);
  const limit = Math.min(Math.max(parseInt(def.limit, 10) || 5000, 1), 50000);
  const sql = `SELECT ${selects.join(', ')} FROM ${src.from}${where.length ? ' WHERE ' + where.join(' AND ') : ''}${groupSql}${order.length ? ' ORDER BY ' + order.join(', ') : ''} LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params).map(r => { const o = { ...r }; if (drill) { o._drill = { [drill]: r.__drill }; delete o.__drill; } return o; });
  const totals = {};
  let any = false;
  for (const c of columns) if (['money'].includes(c.type) || (groupBy.length && ['integer', 'number'].includes(c.type) && !c.key.startsWith('avg_'))) { totals[c.key] = r2(rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0)); any = true; }
  if (any) totals[columns[0].key] = totals[columns[0].key] ?? 'TOTAL';
  return { title: def.name || `${src.label} report`, subtitle: `${rows.length} row(s)${rows.length === limit ? ' (limit reached)' : ''}`, columns, rows, totals: any ? totals : null, notes: [] };
}

module.exports = { taxReport, taxReportCsv, incomeStatement, financialPosition, arAging, postedDepreciation, runReport, catalog, builderSources, runBuilder, REPORTS, SOURCES, yearStart, monthEnd };
