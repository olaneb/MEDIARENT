const { db, getSetting } = require('./db');

// Gap-free, strictly increasing numbers per prefix+year (NTA 2025 requires sequential VAT invoice numbering).
// Uses MAX(sequence)+1 rather than COUNT(*)+1 so a deleted/failed row can never cause a duplicate.
// Voided invoices keep their number — numbers are never reused.
function nextNumber(prefix, table, column) {
  const year = new Date().getFullYear();
  const start = prefix.length + 7; // PREFIX-YYYY-NNNN
  const row = db.prepare(`SELECT MAX(CAST(SUBSTR(${column}, ?) AS INTEGER)) as m FROM ${table} WHERE ${column} LIKE ?`)
    .get(start, `${prefix}-${year}-%`);
  const seq = String((row.m || 0) + 1).padStart(4, '0');
  return `${prefix}-${year}-${seq}`;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function getAccountByCode(code) {
  return db.prepare('SELECT * FROM chart_of_accounts WHERE code = ?').get(code);
}

// lines: [{ code, debit, credit, description }]
// Throws if debits != credits.
function postJournalEntry({ memo, sourceType, sourceId, createdBy, lines, entryDate }) {
  lines = lines.filter(l => (l.debit || 0) !== 0 || (l.credit || 0) !== 0)
    .map(l => ({ ...l, debit: round2(l.debit || 0), credit: round2(l.credit || 0) }));
  if (!lines.length) throw new Error('Journal entry has no lines');
  if (lines.some(l => l.debit < 0 || l.credit < 0)) throw new Error('Journal lines cannot be negative');
  const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    throw new Error(`Journal entry not balanced: debit ${totalDebit} != credit ${totalCredit}`);
  }
  const date = entryDate || new Date().toISOString().slice(0, 10);
  const lock = getSetting('books_locked_until', '');
  if (lock && date <= lock) { const e = new Error(`Period locked: the books are closed up to ${lock}. Post this with a later date or ask the Finance Manager to re-open the period.`); e.status = 400; throw e; }
  const entryNumber = nextNumber('JE', 'journal_entries', 'entry_number');
  for (const l of lines) {
    const acct = typeof l.code === 'string' ? getAccountByCode(l.code) : db.prepare('SELECT * FROM chart_of_accounts WHERE id = ?').get(l.account_id);
    if (!acct) throw new Error(`Unknown account code: ${l.code || l.account_id}`);
    if (acct.is_header) throw new Error(`Journal entry cannot post to header account ${acct.code} ${acct.name}`);
    l.account_id = acct.id;
  }
  const insEntry = db.prepare(`INSERT INTO journal_entries (entry_number, entry_date, memo, source_type, source_id, created_by)
                                VALUES (?, ?, ?, ?, ?, ?)`);
  const result = insEntry.run(entryNumber, date, memo || null, sourceType || null, sourceId || null, createdBy || null);
  const entryId = result.lastInsertRowid;
  const insLine = db.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit, credit, description)
                               VALUES (?, ?, ?, ?, ?)`);
  for (const l of lines) insLine.run(entryId, l.account_id, l.debit || 0, l.credit || 0, l.description || null);
  return { entryId, entryNumber };
}

// Trial balance as at a date (inclusive). Header accounts are excluded (they hold no postings).
function trialBalance(asOf) {
  return db.prepare(`
    SELECT a.id, a.code, a.name, a.account_type, a.ifrs_line,
           COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit END), 0) as total_debit,
           COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.credit END), 0) as total_credit,
           COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit - l.credit END), 0) as balance
    FROM chart_of_accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
    LEFT JOIN journal_entries e ON e.id = l.entry_id AND (? IS NULL OR e.entry_date <= ?)
    WHERE a.is_header = 0
    GROUP BY a.id ORDER BY a.code
  `).all(asOf || null, asOf || null).map(r => ({ ...r, total_debit: round2(r.total_debit), total_credit: round2(r.total_credit), balance: round2(r.balance) }));
}

// Account ledger (GL detail) with running balance. Balance is shown in the account's natural direction.
function accountLedger(code, from, to) {
  const acct = getAccountByCode(code);
  if (!acct) return null;
  const natural = ['asset', 'expense'].includes(acct.account_type) ? 1 : -1;
  const opening = from ? db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND e.entry_date < ?`).get(acct.id, from).b : 0;
  const rows = db.prepare(`SELECT e.id as entry_id, e.entry_number, e.entry_date, e.memo, e.source_type, e.source_id, l.description, l.debit, l.credit
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND (? IS NULL OR e.entry_date >= ?) AND (? IS NULL OR e.entry_date <= ?)
      ORDER BY e.entry_date, e.id, l.id`).all(acct.id, from || null, from || null, to || null, to || null);
  let run = opening;
  const lines = rows.map(r => { run = round2(run + r.debit - r.credit); return { ...r, balance: round2(run * natural) }; });
  const td = round2(rows.reduce((a, r) => a + r.debit, 0)), tc = round2(rows.reduce((a, r) => a + r.credit, 0));
  return { account: acct, from: from || null, to: to || null, opening_balance: round2(opening * natural), total_debit: td, total_credit: tc, closing_balance: round2(run * natural), lines };
}

function profitAndLoss(fromDate, toDate, excludeClose) {
  const rows = db.prepare(`
    SELECT a.account_type, a.code, a.name,
           COALESCE(SUM(l.debit), 0) as total_debit,
           COALESCE(SUM(l.credit), 0) as total_credit
    FROM chart_of_accounts a
    JOIN journal_lines l ON l.account_id = a.id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.account_type IN ('income','expense') AND a.is_header = 0
      AND (? IS NULL OR e.entry_date >= ?) AND (? IS NULL OR e.entry_date <= ?)
      AND (? = 0 OR e.source_type IS NULL OR e.source_type != 'year_end_close')
    GROUP BY a.id ORDER BY a.account_type, a.code
  `).all(fromDate || null, fromDate || null, toDate || null, toDate || null, excludeClose ? 1 : 0);
  let income = 0, expense = 0;
  const lines = rows.map(r => {
    const net = round2(r.account_type === 'income' ? (r.total_credit - r.total_debit) : (r.total_debit - r.total_credit));
    if (r.account_type === 'income') income += net; else expense += net;
    return { ...r, net, amount: net };
  });
  return { lines, totalIncome: round2(income), totalExpense: round2(expense), netProfit: round2(income - expense) };
}

function balanceSheet(asOfDate) {
  // Date filter belongs in the JOIN's entry condition AND must exclude the line itself — filter lines via the
  // entries table in a sub-select so out-of-range lines are not counted.
  const rows = db.prepare(`
    SELECT a.account_type, a.code, a.name,
           COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit END), 0) as total_debit,
           COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.credit END), 0) as total_credit
    FROM chart_of_accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
    LEFT JOIN journal_entries e ON e.id = l.entry_id AND (? IS NULL OR e.entry_date <= ?)
    WHERE a.account_type IN ('asset','liability','equity') AND a.is_header = 0
    GROUP BY a.id ORDER BY a.account_type, a.code
  `).all(asOfDate || null, asOfDate || null);
  const grouped = { asset: [], liability: [], equity: [] };
  for (const r of rows) {
    const balance = round2((r.account_type === 'asset') ? (r.total_debit - r.total_credit) : (r.total_credit - r.total_debit));
    grouped[r.account_type].push({ ...r, balance });
  }
  // No year-end close is run, so cumulative profit to date is shown as an equity line; without it A != L + E.
  const pl = profitAndLoss(null, asOfDate || null);
  grouped.equity.push({ account_type: 'equity', code: 'P&L', name: 'Current earnings (cumulative profit not yet closed to retained earnings)', total_debit: 0, total_credit: 0, balance: round2(pl.netProfit) });
  const sum = (arr) => round2(arr.reduce((s, r) => s + r.balance, 0));
  const totals = { asset: sum(grouped.asset), liability: sum(grouped.liability), equity: sum(grouped.equity) };
  totals.balanced = Math.abs(totals.asset - totals.liability - totals.equity) < 0.01;
  return { grouped, totals };
}

// Post a mirror-image entry cancelling an earlier one (used when voiding an invoice).
function reverseEntry(entryId, { memo, createdBy, sourceType, sourceId, entryDate } = {}) {
  const orig = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
  if (!orig) throw new Error('Journal entry to reverse not found');
  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(entryId)
    .map(l => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, description: `Reversal: ${l.description || ''}` }));
  const out = postJournalEntry({ memo: memo || `Reversal of ${orig.entry_number}`, sourceType: sourceType || 'reversal', sourceId: sourceId || orig.source_id, createdBy, lines, entryDate });
  db.prepare('UPDATE journal_entries SET reversed_by = ? WHERE id = ?').run(out.entryId, entryId);
  return out;
}

function entriesForSource(sourceType, sourceId) {
  return db.prepare('SELECT * FROM journal_entries WHERE source_type = ? AND source_id = ? ORDER BY id').all(sourceType, sourceId);
}

// Keep customers.outstanding_balance equal to the sum of their open (non-void) invoice balances.
function refreshCustomerBalance(customerId) {
  const t = db.prepare(`SELECT COALESCE(SUM(grand_total - amount_paid), 0) as t FROM invoices
                          WHERE customer_id = ? AND status != 'void'`).get(customerId).t;
  db.prepare('UPDATE customers SET outstanding_balance = ? WHERE id = ?').run(round2(t), customerId);
  return round2(t);
}

module.exports = { accountLedger, refreshCustomerBalance, nextNumber, postJournalEntry, reverseEntry, entriesForSource, trialBalance, profitAndLoss, balanceSheet, getAccountByCode, round2 };
