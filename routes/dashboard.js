const { db, getSettings } = require('../lib/db');
const { hasPermission } = require('../lib/auth');
const { ACC } = require('../lib/coa');
const reports = require('../lib/reports');

const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

// Revenue = income accounts presented as revenue (IFRS 16 rental + IFRS 15 services/goods), net of VAT.
function revenueBetween(from, to) {
  return r2(one(`SELECT COALESCE(SUM(l.credit - l.debit), 0) v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id
     WHERE a.account_type = 'income' AND a.ifrs_line LIKE 'Revenue%' AND e.entry_date BETWEEN ? AND ? AND e.source_type != 'year_end_close'`, from, to).v);
}
function profitBetween(from, to) {
  return r2(one(`SELECT COALESCE(SUM(l.credit - l.debit), 0) v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id
     WHERE a.account_type IN ('income','expense') AND e.entry_date BETWEEN ? AND ? AND e.source_type != 'year_end_close'`, from, to).v);
}
const glBal = (code) => r2(one('SELECT COALESCE(SUM(l.debit - l.credit), 0) v FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.code = ?', code).v);

module.exports = function (router) {
  router.get('/api/dashboard/summary', async (ctx) => {
    if (!ctx.user) return ctx.json(401, { error: 'Not authenticated' });
    const can = (p) => hasPermission(ctx.user, p);
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + '01';
    const lm = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 2, 1)).toISOString().slice(0, 10);
    const lmEnd = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);
    const ys = reports.yearStart();
    db.prepare(`UPDATE rental_agreements SET status = 'overdue' WHERE status IN ('active','dispatched') AND expected_return_date < date('now')`).run();

    const out = { generated_at: new Date().toISOString(), company: getSettings().company_name || '', sections: {} };

    // ---------- fleet ----------
    if (can('equipment.view')) {
      const by = {}; for (const r of all("SELECT status, COUNT(*) c FROM equipment WHERE disposed_at IS NULL GROUP BY status")) by[r.status] = r.c;
      const fleet = Object.values(by).reduce((a, b) => a + b, 0);
      const rentable = fleet - (by.lost || 0) - (by.retired || 0);
      out.sections.fleet = {
        by_status: by, total: fleet, utilisation_now: rentable ? r2((by.on_rent || 0) * 100 / rentable) : 0,
        fleet_value: r2(one('SELECT COALESCE(SUM(replacement_value),0) v FROM equipment WHERE disposed_at IS NULL').v),
        categories: all(`SELECT c.id, c.name, COUNT(e.id) units, SUM(CASE WHEN e.status = 'on_rent' THEN 1 ELSE 0 END) on_rent FROM equipment_categories c JOIN equipment e ON e.category_id = c.id AND e.disposed_at IS NULL
                         GROUP BY c.id ORDER BY on_rent DESC, units DESC LIMIT 10`),
        locations: all("SELECT l.id, l.name, COUNT(e.id) units FROM locations l LEFT JOIN equipment e ON e.location_id = l.id AND e.disposed_at IS NULL GROUP BY l.id ORDER BY units DESC"),
      };
    }
    // ---------- bookings ----------
    if (can('rentals.view')) {
      const c = (where) => one(`SELECT COUNT(*) c FROM rental_agreements WHERE ${where}`).c;
      out.sections.bookings = {
        active: c("status IN ('active','dispatched')"), overdue: c("status = 'overdue'"), reserved: c("status = 'reserved'"),
        due_today: c("status IN ('active','dispatched','overdue') AND expected_return_date = date('now')"),
        pickups_week: c("status = 'reserved' AND start_date BETWEEN date('now') AND date('now','+7 days')"),
        uninvoiced: c("status = 'returned' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.agreement_id = rental_agreements.id AND i.status != 'void')"),
        this_month: c(`start_date >= '${monthStart}'`),
        returns: all(`SELECT ra.id, ra.agreement_number, c.full_name customer, ra.project_name, ra.expected_return_date, ra.status FROM rental_agreements ra JOIN customers c ON c.id = ra.customer_id
                      WHERE ra.status IN ('active','dispatched','overdue') ORDER BY ra.expected_return_date LIMIT 7`),
        pickups: all(`SELECT ra.id, ra.agreement_number, c.full_name customer, ra.project_name, ra.start_date, ra.status FROM rental_agreements ra JOIN customers c ON c.id = ra.customer_id
                      WHERE ra.status = 'reserved' ORDER BY ra.start_date LIMIT 7`),
        by_production_type: all(`SELECT COALESCE(production_type, 'Unspecified') t, COUNT(*) c FROM rental_agreements WHERE start_date >= ? AND status != 'cancelled' GROUP BY t ORDER BY c DESC`, ys),
        coi_issues: all(`SELECT DISTINCT c.id, c.full_name FROM customers c JOIN rental_agreements ra ON ra.customer_id = c.id AND ra.status IN ('reserved','active','overdue')
                         WHERE c.coi_on_file = 0 OR c.coi_expiry_date IS NULL OR c.coi_expiry_date < ra.expected_return_date LIMIT 10`),
      };
    }
    // ---------- finance ----------
    if (can('reports.view') || can('invoices.view')) {
      const months = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - i, 1));
        const f = d.toISOString().slice(0, 10), t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
        const collected = r2(one(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE reversed_at IS NULL AND method != 'deposit_applied' AND date(received_at) BETWEEN ? AND ?`, f, t).v);
        months.push({ month: f.slice(0, 7), revenue: revenueBetween(f, t), collected });
      }
      const aging = reports.arAging(today);
      const cash = all(`SELECT a.code, a.name, ROUND(COALESCE(SUM(l.debit - l.credit),0),2) bal FROM chart_of_accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
                        WHERE substr(a.code,1,2) = '10' AND a.is_header = 0 GROUP BY a.id HAVING ABS(bal) > 0.004 OR a.is_system = 1 ORDER BY a.code`);
      const tax = reports.taxReport(today.slice(0, 7));
      out.sections.finance = {
        revenue_mtd: revenueBetween(monthStart, today), revenue_last_month: revenueBetween(lm, lmEnd), revenue_ytd: revenueBetween(ys, today),
        profit_mtd: profitBetween(monthStart, today), profit_ytd: profitBetween(ys, today), year_start: ys,
        receivables: aging.totals.total || 0, overdue_receivables: r2((aging.totals.b1 || 0) + (aging.totals.b2 || 0) + (aging.totals.b3 || 0) + (aging.totals.b4 || 0)),
        aging: { current: aging.totals.current || 0, b1: aging.totals.b1 || 0, b2: aging.totals.b2 || 0, b3: aging.totals.b3 || 0, b4: aging.totals.b4 || 0 },
        ecl_required: aging.totals.ecl || 0, ecl_held: -glBal(ACC.ECL_ALLOWANCE),
        cash_accounts: cash, cash_total: r2(cash.reduce((a, c) => a + c.bal, 0)),
        payables: -glBal(ACC.AP), deposits_held: -glBal(ACC.DEPOSITS_HELD),
        vat_payable: -glBal(ACC.VAT_PAYABLE), net_vat_this_month: tax.net_vat.payable, vat_due: tax.period.vat_return_due,
        wht_credits: glBal(ACC.WHT_RECEIVABLE), wht_payable: -glBal(ACC.WHT_PAYABLE),
        unbilled: glBal(ACC.UNBILLED),
        trend: months,
        top_customers: all(`SELECT c.id, COALESCE(c.company_name, c.full_name) name, ROUND(SUM(i.subtotal),2) net FROM invoices i JOIN customers c ON c.id = i.customer_id
                            WHERE i.status != 'void' AND i.issue_date >= ? GROUP BY c.id ORDER BY net DESC LIMIT 6`, ys),
        top_equipment: all(`SELECT e.id, e.name, ROUND(SUM(ii.amount),2) net FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id AND i.status != 'void' JOIN equipment e ON e.id = ii.equipment_id
                            WHERE ii.category IN ('rental','fee') AND i.issue_date >= ? GROUP BY e.id ORDER BY net DESC LIMIT 6`, ys),
        revenue_mix: all(`SELECT COALESCE(a.name, ii.category) name, ROUND(SUM(ii.amount),2) net FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id AND i.status != 'void' AND i.is_legacy = 0
                          LEFT JOIN chart_of_accounts a ON a.code = ii.gl_code WHERE i.issue_date >= ? GROUP BY name ORDER BY net DESC LIMIT 8`, ys),
        open_invoices: one("SELECT COUNT(*) c FROM invoices WHERE status IN ('unpaid','partial')").c,
      };
    }
    // ---------- approvals & compliance ----------
    const tasks = {};
    if (can('vouchers.view')) { const v = one("SELECT COUNT(*) c, COALESCE(SUM(amount),0) a FROM payment_vouchers WHERE status = 'pending'"); tasks.pending_vouchers = v.c; tasks.pending_voucher_amount = r2(v.a); }
    if (can('journals.view')) tasks.pending_journals = one("SELECT COUNT(*) c FROM manual_journals WHERE status = 'pending'").c;
    if (can('expenses.view')) { const b = one("SELECT COUNT(*) c, COALESCE(SUM(amount + vat_amount - wht_amount),0) a FROM expenses WHERE status = 'pending'"); tasks.unpaid_bills = b.c; tasks.unpaid_bill_amount = r2(b.a); }
    if (can('maintenance.view')) { tasks.open_work_orders = one("SELECT COUNT(*) c FROM work_orders WHERE status NOT IN ('completed','cancelled')").c; tasks.maintenance_due = one("SELECT COUNT(*) c FROM maintenance_schedules WHERE next_due_date <= date('now','+7 days')").c; }
    if (can('consumables.view')) tasks.low_stock = one('SELECT COUNT(*) c FROM rental_consumables WHERE reorder_level > 0 AND quantity_on_hand <= reorder_level').c;
    if (can('claims.view')) tasks.open_claims = one("SELECT COUNT(*) c FROM insurance_claims WHERE status IN ('draft','submitted','approved')").c;
    if (can('einvoice.view') || can('invoices.view')) {
      tasks.einvoice_pending = one("SELECT COUNT(*) c FROM invoices WHERE status != 'void' AND is_legacy = 0 AND einvoice_status IN ('not_submitted','rejected','submitted')").c;
      tasks.einvoice_rejected = one("SELECT COUNT(*) c FROM invoices WHERE status != 'void' AND is_legacy = 0 AND einvoice_status = 'rejected'").c;
      tasks.einvoice_cleared = one("SELECT COUNT(*) c FROM invoices WHERE einvoice_status = 'cleared'").c;
      tasks.nrs_mode = getSettings().nrs_mode || 'off';
    }
    if (can('equipment.view')) tasks.lost_units = one("SELECT COUNT(*) c FROM equipment WHERE status = 'lost' AND disposed_at IS NULL").c;
    out.sections.tasks = tasks;
    if (can('admin.audit')) out.sections.activity = all(`SELECT al.created_at, al.action, al.entity_type, al.entity_id, u.full_name FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
                                                      WHERE al.action NOT IN ('login_success','login_failed') ORDER BY al.id DESC LIMIT 8`);

    // Back-compatible flat fields (older clients / tests)
    const st = out.sections.fleet ? out.sections.fleet.by_status : {};
    Object.assign(out, {
      equipmentByStatus: Object.entries(st).map(([status, c]) => ({ status, c })),
      activeAgreements: out.sections.bookings ? out.sections.bookings.active : null,
      overdueAgreements: out.sections.bookings ? out.sections.bookings.overdue : null,
      unpaidInvoicesTotal: out.sections.finance ? out.sections.finance.receivables : null,
      openWorkOrders: tasks.open_work_orders ?? null, pendingVouchers: tasks.pending_vouchers ?? null,
      revenueThisMonth: out.sections.finance ? out.sections.finance.revenue_mtd : null,
    });
    ctx.json(200, out);
  });
};
