// Chart of accounts — 6-digit numbering (class · group · sub-group · detail), the structure most Nigerian
// accounting teams and auditors expect and the one IFRS-based reporting packs map cleanly onto:
//   1xxxxx Assets · 2xxxxx Liabilities · 3xxxxx Equity · 4xxxxx Revenue & other income
//   5xxxxx Direct costs of rentals · 6xxxxx Operating expenses · 7xxxxx Other gains/losses & finance costs · 8xxxxx Taxation
// Header accounts (ending 00000) are non-posting roll-ups. System accounts are referenced by code in the posting
// logic and cannot be deleted or re-typed; their names can be edited.

const CLASSES = {
  1: { type: 'asset', name: 'ASSETS' },
  2: { type: 'liability', name: 'LIABILITIES' },
  3: { type: 'equity', name: 'EQUITY' },
  4: { type: 'income', name: 'REVENUE & OTHER INCOME' },
  5: { type: 'expense', name: 'DIRECT COSTS OF RENTAL OPERATIONS' },
  6: { type: 'expense', name: 'OPERATING EXPENSES' },
  7: { type: 'expense', name: 'OTHER GAINS / LOSSES & FINANCE COSTS' },
  8: { type: 'expense', name: 'TAXATION' },
};

// Codes the posting engine relies on.
const ACC = {
  CASH: '101000', BANK: '102000', POS_SETTLEMENT: '102100',
  AR: '111000', ECL_ALLOWANCE: '111900', UNBILLED: '112000', INPUT_VAT: '113000', WHT_RECEIVABLE: '114000',
  PREPAYMENTS: '115000', INSURANCE_CLAIMS_RECEIVABLE: '117000', SPARES_INVENTORY: '121000', CONSUMABLES_INVENTORY: '122000',
  EQUIPMENT_COST: '151000', EQUIPMENT_ACC_DEP: '151900',
  AP: '201000', ACCRUALS: '202000', VAT_PAYABLE: '211000', WHT_PAYABLE: '212000', PAYE_PAYABLE: '213000', PENSION_PAYABLE: '214000',
  CIT_PAYABLE: '215000', DEV_LEVY_PAYABLE: '216000', DEPOSITS_HELD: '221000', CUSTOMER_CREDITS: '222000', ADVANCE_RECEIPTS: '223000',
  SHARE_CAPITAL: '301000', RETAINED_EARNINGS: '302000', OPENING_BALANCE_EQUITY: '303000',
  RENTAL_INCOME: '401000', STUDIO_INCOME: '401100', LATE_FEES: '402000', RUSH_FEES: '402100', WAIVER_INCOME: '403000',
  CREW_INCOME: '404000', CONSUMABLES_INCOME: '405000', DELIVERY_INCOME: '406000', CANCELLATION_INCOME: '407000',
  DAMAGE_RECOVERY: '411000', REPLACEMENT_RECOVERY: '412000', INSURANCE_RECOVERY: '413000', OTHER_INCOME: '419000',
  COST_OF_CONSUMABLES: '501000', FUEL: '502000', REPAIRS: '503000', EQUIPMENT_INSURANCE: '504000', DEPRECIATION: '505000',
  CREW_COST: '506000', SUB_RENTAL: '507000', TRANSPORT: '508000',
  SALARIES: '601000', RENT: '602000', UTILITIES: '603000', INSURANCE: '604000', DEPRECIATION_OTHER: '605000',
  PROFESSIONAL_FEES: '606000', MARKETING: '607000', OFFICE: '608000', BANK_CHARGES: '609000', TRAVEL: '610000', OTHER_EXPENSE: '699000',
  ECL_EXPENSE: '701000', LOSS_ON_WRITE_OFF: '702000', INTEREST: '703000', FX: '704000', PENALTIES: '705000',
  CIT_EXPENSE: '801000', DEV_LEVY_EXPENSE: '802000',
};

// [code, name, type, system?, ifrs_line]
const ACCOUNTS = [
  ['100000', 'ASSETS', 'asset', 1, null, 1],
  ['101000', 'Cash on hand', 'asset', 1, 'Cash and cash equivalents'],
  ['102000', 'Bank — operating account', 'asset', 1, 'Cash and cash equivalents'],
  ['102100', 'Bank — POS / card settlement', 'asset', 0, 'Cash and cash equivalents'],
  ['111000', 'Trade receivables (control)', 'asset', 1, 'Trade and other receivables'],
  ['111900', 'Allowance for expected credit losses', 'asset', 1, 'Trade and other receivables'],
  ['112000', 'Unbilled rental income (accrued revenue)', 'asset', 1, 'Trade and other receivables'],
  ['113000', 'Input VAT recoverable', 'asset', 1, 'Trade and other receivables'],
  ['114000', 'WHT credit notes receivable (tax credits)', 'asset', 1, 'Current tax assets'],
  ['115000', 'Prepayments', 'asset', 0, 'Trade and other receivables'],
  ['116000', 'Staff advances & other receivables', 'asset', 0, 'Trade and other receivables'],
  ['117000', 'Insurance claims receivable', 'asset', 1, 'Trade and other receivables'],
  ['121000', 'Spare parts inventory', 'asset', 1, 'Inventories'],
  ['122000', 'Rental consumables inventory', 'asset', 0, 'Inventories'],
  ['151000', 'Rental equipment — cost', 'asset', 1, 'Property, plant and equipment'],
  ['151900', 'Rental equipment — accumulated depreciation', 'asset', 1, 'Property, plant and equipment'],
  ['152000', 'Motor vehicles — cost', 'asset', 0, 'Property, plant and equipment'],
  ['152900', 'Motor vehicles — accumulated depreciation', 'asset', 0, 'Property, plant and equipment'],
  ['153000', 'Office equipment & furniture — cost', 'asset', 0, 'Property, plant and equipment'],
  ['153900', 'Office equipment & furniture — accumulated depreciation', 'asset', 0, 'Property, plant and equipment'],
  ['154000', 'Studio fit-out & leasehold improvements — cost', 'asset', 0, 'Property, plant and equipment'],
  ['154900', 'Studio fit-out — accumulated depreciation', 'asset', 0, 'Property, plant and equipment'],
  ['200000', 'LIABILITIES', 'liability', 1, null, 1],
  ['201000', 'Trade payables (control)', 'liability', 1, 'Trade and other payables'],
  ['202000', 'Accrued expenses', 'liability', 1, 'Trade and other payables'],
  ['211000', 'Output VAT payable', 'liability', 1, 'Other taxes payable'],
  ['212000', 'WHT payable (deducted from vendors)', 'liability', 1, 'Other taxes payable'],
  ['213000', 'PAYE payable', 'liability', 0, 'Other taxes payable'],
  ['214000', 'Pension contributions payable', 'liability', 0, 'Trade and other payables'],
  ['215000', 'Companies income tax payable', 'liability', 1, 'Current tax liabilities'],
  ['216000', 'Development levy payable', 'liability', 1, 'Current tax liabilities'],
  ['221000', 'Customer security & caution deposits held', 'liability', 1, 'Customer deposits'],
  ['222000', 'Customer credit balances / unapplied receipts', 'liability', 1, 'Contract liabilities'],
  ['223000', 'Advance booking receipts (contract liability)', 'liability', 1, 'Contract liabilities'],
  ['231000', 'Loans & borrowings', 'liability', 0, 'Borrowings'],
  ['300000', 'EQUITY', 'equity', 1, null, 1],
  ['301000', 'Share capital', 'equity', 1, 'Share capital'],
  ['302000', 'Retained earnings', 'equity', 1, 'Retained earnings'],
  ['303000', 'Opening balance equity (migration clearing)', 'equity', 1, 'Retained earnings'],
  ['304000', "Dividends / owner's drawings", 'equity', 0, 'Retained earnings'],
  ['400000', 'REVENUE & OTHER INCOME', 'income', 1, null, 1],
  ['401000', 'Equipment rental income', 'income', 1, 'Revenue — rental income (IFRS 16)'],
  ['401100', 'Studio hire income', 'income', 1, 'Revenue — rental income (IFRS 16)'],
  ['402000', 'Late return fees', 'income', 1, 'Revenue — rental income (IFRS 16)'],
  ['402100', 'Rush / same-day booking fees', 'income', 1, 'Revenue — rental income (IFRS 16)'],
  ['403000', 'Damage waiver income', 'income', 1, 'Revenue — services (IFRS 15)'],
  ['404000', 'Crew & technical services income', 'income', 1, 'Revenue — services (IFRS 15)'],
  ['405000', 'Consumables sales', 'income', 1, 'Revenue — sale of goods (IFRS 15)'],
  ['406000', 'Delivery & logistics income', 'income', 1, 'Revenue — services (IFRS 15)'],
  ['407000', 'Cancellation fees', 'income', 1, 'Other operating income'],
  ['411000', 'Damage recovery income', 'income', 1, 'Other operating income'],
  ['412000', 'Lost-equipment replacement recovery', 'income', 1, 'Other operating income'],
  ['413000', 'Insurance claim recoveries', 'income', 1, 'Other operating income'],
  ['414000', 'Gain on disposal of equipment', 'income', 0, 'Other operating income'],
  ['419000', 'Other income', 'income', 1, 'Other operating income'],
  ['500000', 'DIRECT COSTS OF RENTAL OPERATIONS', 'expense', 1, null, 1],
  ['501000', 'Cost of consumables sold', 'expense', 1, 'Cost of sales'],
  ['502000', 'Generator fuel & diesel', 'expense', 1, 'Cost of sales'],
  ['503000', 'Equipment repairs & maintenance', 'expense', 1, 'Cost of sales'],
  ['504000', 'Equipment insurance', 'expense', 1, 'Cost of sales'],
  ['505000', 'Depreciation — rental equipment', 'expense', 1, 'Cost of sales'],
  ['506000', 'Freelance crew & operators', 'expense', 1, 'Cost of sales'],
  ['507000', 'Sub-rental (cross-hire) costs', 'expense', 1, 'Cost of sales'],
  ['508000', 'Transport & logistics', 'expense', 1, 'Cost of sales'],
  ['600000', 'OPERATING EXPENSES', 'expense', 1, null, 1],
  ['601000', 'Salaries & wages', 'expense', 1, 'Administrative expenses'],
  ['602000', 'Rent — office & studio premises', 'expense', 1, 'Administrative expenses'],
  ['603000', 'Utilities (power, water, internet)', 'expense', 1, 'Administrative expenses'],
  ['604000', 'General insurance', 'expense', 1, 'Administrative expenses'],
  ['605000', 'Depreciation — non-rental assets', 'expense', 1, 'Administrative expenses'],
  ['606000', 'Professional fees (audit, legal, tax)', 'expense', 1, 'Administrative expenses'],
  ['607000', 'Marketing & advertising', 'expense', 1, 'Selling & distribution expenses'],
  ['608000', 'Office & administrative expenses', 'expense', 1, 'Administrative expenses'],
  ['609000', 'Bank charges', 'expense', 1, 'Administrative expenses'],
  ['610000', 'Travel & accommodation', 'expense', 1, 'Administrative expenses'],
  ['699000', 'Other operating expenses', 'expense', 1, 'Administrative expenses'],
  ['700000', 'OTHER GAINS / LOSSES & FINANCE COSTS', 'expense', 1, null, 1],
  ['701000', 'Impairment loss on receivables (ECL)', 'expense', 1, 'Impairment of financial assets'],
  ['702000', 'Loss on write-off / disposal of equipment', 'expense', 1, 'Other operating expenses'],
  ['703000', 'Interest expense', 'expense', 1, 'Finance costs'],
  ['704000', 'Foreign exchange (gain) / loss', 'expense', 0, 'Other operating expenses'],
  ['705000', 'Tax penalties & fines (non-deductible)', 'expense', 1, 'Other operating expenses'],
  ['800000', 'TAXATION', 'expense', 1, null, 1],
  ['801000', 'Companies income tax expense', 'expense', 1, 'Income tax expense'],
  ['802000', 'Development levy expense', 'expense', 1, 'Income tax expense'],
];

// Earlier builds used 4-digit codes. Upgrading renumbers in place (ids — and therefore every journal line — are kept).
const LEGACY_MAP = {
  1000: '101000', 1010: '102000', 1100: '111000', 1150: '114000', 1200: '151000', 1210: '151900', 1300: '121000', 1400: '113000',
  2000: '201000', 2100: '211000', 2150: '222000', 2200: '212000', 2300: '221000',
  3000: '301000', 3900: '302000',
  4000: '401000', 4100: '402000', 4200: '411000', 4300: '403000', 4400: '405000', 4500: '402100', 4600: '412000', 4700: '404000', 4800: '406000',
  5000: '502000', 5010: '503000', 5020: '601000', 5030: '602000', 5040: '603000', 5050: '604000', 5060: '505000', 5070: '501000', 5080: '506000', 5900: '699000',
};

// Expense category -> default GL (can be overridden per expense with any posting expense/asset account).
const EXPENSE_GL = {
  fuel: ACC.FUEL, spare_parts: ACC.REPAIRS, repairs: ACC.REPAIRS, salary: ACC.SALARIES, rent: ACC.RENT, utilities: ACC.UTILITIES,
  insurance: ACC.INSURANCE, equipment_insurance: ACC.EQUIPMENT_INSURANCE, consumables: ACC.COST_OF_CONSUMABLES, crew: ACC.CREW_COST,
  sub_rental: ACC.SUB_RENTAL, transport: ACC.TRANSPORT, professional_fees: ACC.PROFESSIONAL_FEES, marketing: ACC.MARKETING,
  office: ACC.OFFICE, bank_charges: ACC.BANK_CHARGES, travel: ACC.TRAVEL, equipment_purchase: ACC.EQUIPMENT_COST, other: ACC.OTHER_EXPENSE,
};

function classOf(code) { return CLASSES[String(code)[0]]; }
function validCode(code) { return /^[1-8][0-9]{5}$/.test(String(code || '')); }
function isHeader(code) { return /^[1-8]00000$/.test(String(code)); }

module.exports = { CLASSES, ACC, ACCOUNTS, LEGACY_MAP, EXPENSE_GL, classOf, validCode, isHeader };
