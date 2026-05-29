'use strict';

// Pattern sets keyed to DV asset_type / description text
const ASSET_TYPE_PATTERNS = {
  hasRealEstate:          [/real.?estate/i, /property/i, /land/i, /house/i, /condo/i, /building/i, /parcel/i],
  hasPersonalProperty:    [/personal.?property/i, /tangible/i, /household/i, /furniture/i, /jewelry/i, /art/i, /collectible/i, /antique/i],
  hasBankAccounts:        [/bank/i, /checking/i, /savings/i, /money.?market/i, /\bcd\b/i, /certificate.?of.?deposit/i],
  hasInvestmentAccounts:  [/investment/i, /brokerage/i, /securities/i, /stock/i, /\bbond\b/i, /mutual.?fund/i, /\betf\b/i],
  hasRetirementAccounts:  [/retirement/i, /\bira\b/i, /401[k]/i, /403[b]/i, /pension/i, /annuity/i, /roth/i, /\bsep\b/i],
  hasLifeInsurance:       [/life.?insurance/i, /insurance.?policy/i, /\bpolicy\b/i],
  hasBusinessInterests:   [/business/i, /partnership/i, /\bllc\b/i, /corporation/i, /closely.?held/i, /\bs.?corp\b/i, /\bk-1\b/i],
  hasVehicles:            [/vehicle/i, /\bcar\b/i, /truck/i, /boat/i, /motorcycle/i, /\brv\b/i, /automobile/i],
};

function assetMatchesPatterns(asset, patterns) {
  const text = [asset.asset_type, asset.description, asset.category, asset.name]
    .filter(Boolean).join(' ');
  return patterns.some(p => p.test(text));
}

function ageAtDate(dobIso, refIso) {
  const dob = new Date(dobIso + 'T00:00:00');
  const ref = new Date(refIso + 'T00:00:00');
  let age = ref.getFullYear() - dob.getFullYear();
  const m = ref.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age--;
  return age;
}

const CHILD_TYPES  = new Set(['2SON','2DATR','2SSON','2SDTR','2ADOP','2ADTD']);
const SPOUSE_TYPES = new Set(['1MARR','1WIDW','3LIFP']);
const CHARITY_PAT  = /foundation|charitable|charity|church|synagogue|mosque|nonprofit|university|college|hospital|society|trust fund/i;

function deriveMatterConditions(matter, contacts = [], assets = []) {
  // ── Asset conditions ──────────────────────────────────────────────────────
  const cond = {};
  for (const [key, patterns] of Object.entries(ASSET_TYPE_PATTERNS)) {
    cond[key] = assets.some(a => assetMatchesPatterns(a, patterns));
  }

  // Trust: matter-level field or trust-named asset
  cond.hasTrust = !!(
    matter.trust_name ||
    assets.some(a => /trust/i.test([a.asset_type, a.description, a.name].filter(Boolean).join(' ')))
  );

  // Out-of-state property: any asset with an address state that differs from the matter state
  const matterState = (matter.state || '').toUpperCase();
  cond.hasOutOfStateProperty = assets.some(a => {
    const assetState = (a.address_state || a.state || '').toUpperCase();
    return assetState && assetState !== matterState;
  });

  // ── Contact conditions ───────────────────────────────────────────────────
  cond.hasSpouse = contacts.some(c => SPOUSE_TYPES.has(c.relationship?.type));

  const dod = matter.date_of_death || null;
  cond.hasMinorChildren = contacts.some(c => {
    if (!CHILD_TYPES.has(c.relationship?.type)) return false;
    if (!c.date_of_birth || !dod) return false;
    return ageAtDate(c.date_of_birth, dod) < 18;
  });

  cond.hasCharitableBequests = contacts.some(c =>
    CHARITY_PAT.test(c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim())
  );

  // ── Estate value thresholds ──────────────────────────────────────────────
  const gross = assets.reduce((sum, a) =>
    sum + parseFloat(a.gross_value || a.net_value || a.value || 0), 0
  );
  cond.grossEstateOverMAThreshold      = gross > 2_000_000;
  cond.grossEstateOverRIThreshold      = gross > 1_733_264;
  cond.grossEstateOverFederalThreshold = gross > 13_610_000;

  // ── Proceeding type ───────────────────────────────────────────────────────
  cond.isTestate = !!(
    matter.has_will ||
    (matter.proceeding_type || '').toLowerCase().includes('testate')
  );

  // ── Derived ───────────────────────────────────────────────────────────────
  cond.requiresAncillaryAdmin = cond.hasOutOfStateProperty;

  return cond;
}

module.exports = { deriveMatterConditions };
