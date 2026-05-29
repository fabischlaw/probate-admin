'use strict';

// Returns ISO date string: April 15 of the year following dateOfDeath
function april15AfterDeath(dodIso) {
  return `${parseInt(dodIso.slice(0, 4)) + 1}-04-15`;
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoToDisplay(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return `${m}/${d}/${y}`;
}

function daysBetween(isoDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(isoDate + 'T00:00:00');
  return Math.round((due - today) / (1000 * 60 * 60 * 24));
}

function statusFor(daysUntil) {
  if (daysUntil < 0)   return 'overdue';
  if (daysUntil <= 30) return 'urgent';
  if (daysUntil <= 90) return 'upcoming';
  return 'future';
}

// Rule types:
//   { type:'offset', fromKey, offsetDays }  — fromKey + N days
//   { type:'april15' }                      — April 15 of year after DOD
//   { type:'fixed', label }                 — descriptive, no calculated date

const MA_RULES = [
  {
    key: 'dmaNotice',
    label: 'DMA Notice Must Be Sent By',
    type: 'offset', fromKey: 'filingDate', offsetDays: -7,
    statute: 'G.L. c. 190B § 3-306',
    condition: 'Informal: 7 days before filing; Formal: 14 days',
  },
  {
    key: 'informal_publication',
    label: 'Informal Notice Publication Deadline (MPC 551)',
    type: 'offset', fromKey: 'appointmentDate', offsetDays: 30,
    statute: 'G.L. c. 190B § 3-306',
    condition: 'Informal proceedings only',
  },
  {
    key: 'inventory',
    label: 'Inventory Due (MPC 854)',
    type: 'offset', fromKey: 'appointmentDate', offsetDays: 90,
    statute: 'G.L. c. 190B § 3-706',
  },
  {
    key: 'spousal_election',
    label: "Surviving Spouse's Election Against Will",
    type: 'offset', fromKey: 'appointmentDate', offsetDays: 180,
    statute: 'G.L. c. 190B § 2-212',
    condition: 'Only if surviving spouse exists',
  },
  {
    key: 'alternate_valuation_date',
    label: 'Alternate Valuation Date Election Deadline',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 180,
    statute: 'IRC § 2032',
    condition: 'Federal taxable estates only',
  },
  {
    key: 'disclaimer_deadline',
    label: 'Disclaimer Deadline (9 months)',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 270,
    statute: 'IRC § 2518; G.L. c. 191A',
  },
  {
    key: 'estate_tax_return',
    label: 'Estate Tax Return Due (9 months)',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 270,
    statute: 'IRC § 6075; M.G.L. c. 65C § 14',
  },
  {
    key: 'extension_deadline',
    label: 'Extension Request Deadline (Form 4768)',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 270,
    statute: 'IRC § 6081',
    condition: 'File before 9-month due date',
  },
  {
    key: 'creditor_claim_period',
    label: 'Creditor Claim Period Ends (1 year)',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 365,
    statute: 'G.L. c. 190B § 3-803',
    condition: 'No claim valid after 1 year from death',
  },
  {
    key: 'pecuniary_devise_interest',
    label: 'Pecuniary Devise — Interest Begins (1 year)',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 365,
    statute: 'G.L. c. 190B § 3-904',
    condition: 'Testate estates only',
  },
  {
    key: 'final_1040_due',
    label: "Decedent's Final Form 1040 Due (April 15)",
    type: 'april15',
    statute: 'IRC § 6072',
  },
  {
    key: 'fiduciary_income_tax',
    label: 'Fiduciary Income Tax Return Due (Form 1041)',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 425,
    statute: 'IRC § 6072(a)',
    condition: '~14 months — based on calendar year estate',
  },
  {
    key: 'irs_closing_letter_request',
    label: 'IRS Closing Letter — Estimated Available',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 540,
    statute: 'Rev. Proc. 2012-12',
    condition: 'Federal taxable estates only; IRS processing time varies',
  },
];

// Trust-specific rules — appended when options.hasTrust is true
const TRUST_RULES = [
  {
    key: 'trustee_beneficiary_notice',
    label: 'Trustee Notice to Beneficiaries Due (60 days)',
    type: 'offset', fromKey: 'appointmentDate', offsetDays: 60,
    statute: 'UTC § 813; M.G.L. c. 203E § 813',
    condition: 'Trust matters only — 60 days from appointment',
  },
  {
    key: 'trust_creditor_period',
    label: 'Trust Creditor Claim Period',
    type: 'fixed',
    note: 'Varies — consult trust terms and state law',
    statute: 'UTC § 1005',
    condition: 'Trust matters only',
  },
  {
    key: 'trust_accounting',
    label: 'Annual Trust Accounting Due to Beneficiaries',
    type: 'fixed',
    note: 'Annual — within 60 days of trust accounting year end',
    statute: 'UTC § 813(c); M.G.L. c. 203E § 813',
    condition: 'Trust matters only',
  },
];

const RI_RULES = [
  {
    key: 'inventory',
    label: 'Inventory Due',
    type: 'offset', fromKey: 'appointmentDate', offsetDays: 90,
    statute: 'R.I. Gen. Laws § 33-13-1',
  },
  {
    key: 'creditor_claim_period',
    label: 'Creditor Claim Period Ends (6 months)',
    type: 'offset', fromKey: 'publicationDate', offsetDays: 180,
    statute: 'R.I. Gen. Laws § 33-12-4',
    condition: '6 months from first publication',
  },
  {
    key: 'spousal_election',
    label: "Surviving Spouse's Election Against Will",
    type: 'offset', fromKey: 'appointmentDate', offsetDays: 180,
    statute: 'R.I. Gen. Laws § 33-25-2',
    condition: 'Only if surviving spouse exists',
  },
  {
    key: 'disclaimer_deadline',
    label: 'Disclaimer Deadline (9 months)',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 270,
    statute: 'IRC § 2518; R.I. Gen. Laws § 34-5-13',
  },
  {
    key: 'estate_tax_return',
    label: 'Estate Tax Return Due (9 months)',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 270,
    statute: 'R.I. Gen. Laws § 44-22-1.1',
  },
  {
    key: 'extension_deadline',
    label: 'Extension Request Deadline',
    type: 'offset', fromKey: 'dateOfDeath', offsetDays: 270,
    statute: 'IRC § 6081',
    condition: 'File before 9-month due date',
  },
  {
    key: 'affidavit_creditor_notice',
    label: 'Affidavit of Compliance with Creditor Notice',
    type: 'fixed',
    note: 'Required before filing final account — no fixed date',
    statute: 'R.I. Gen. Laws § 33-11-5.1',
  },
  {
    key: 'final_1040_due',
    label: "Decedent's Final Form 1040 Due (April 15)",
    type: 'april15',
    statute: 'IRC § 6072',
  },
];

function calculateDeadlines(keyDates = {}, state = 'MA', options = {}) {
  const baseRules = state === 'RI' ? RI_RULES : MA_RULES;
  const rules = options.hasTrust ? [...baseRules, ...TRUST_RULES] : baseRules;
  const dod   = keyDates.dateOfDeath;

  const results = [];

  for (const rule of rules) {
    let dueDate, dueDateDisplay, daysUntil, status;

    if (rule.type === 'offset') {
      const from = keyDates[rule.fromKey];
      if (!from) continue; // skip if anchor date not set
      dueDate        = addDays(from, rule.offsetDays);
      dueDateDisplay = isoToDisplay(dueDate);
      daysUntil      = daysBetween(dueDate);
      status         = statusFor(daysUntil);

    } else if (rule.type === 'april15') {
      if (!dod) continue;
      dueDate        = april15AfterDeath(dod);
      dueDateDisplay = isoToDisplay(dueDate);
      daysUntil      = daysBetween(dueDate);
      status         = statusFor(daysUntil);

    } else {
      // fixed / descriptive — no computed date
      dueDate        = null;
      dueDateDisplay = rule.note || 'See note';
      daysUntil      = null;
      status         = 'na';
    }

    results.push({
      key:            rule.key,
      label:          rule.label,
      dueDate,
      dueDateDisplay,
      daysUntil,
      status,
      statute:        rule.statute   || null,
      condition:      rule.condition || null,
      note:           rule.note      || null,
    });
  }

  // Sort computable deadlines by date; push 'na' entries to end
  return results.sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });
}

module.exports = { calculateDeadlines };
