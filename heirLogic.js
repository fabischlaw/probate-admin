'use strict';
// RI intestacy heir determination — RIGL Chapter 33-1
//
// Relationship type codes are from actual DecisionVault data surveyed across 43 matters.

// Surviving spouse — always an heir if present
const SPOUSE_TYPES = new Set(['1MARR', '1WIDW', '3LIFP', '1SPOU', '1PTNR']);

// Legal children (bio/adopted); stepchildren (2SDTR, 2SSON) are NOT heirs at law
const CHILD_TYPES = new Set(['2SON', '2DATR', '2ADOP', '2ADTD']);

// Grandchildren — represent a predeceased child (per stirpes)
const GRANDCHILD_TYPES = new Set(['3GSON', '3GDTR']);

// Parents — heirs only when no descendants survive
const PARENT_TYPES = new Set(['3FATH', '3MOTH']);

// Siblings — heirs only when no descendants and no parents survive
const SIBLING_TYPES = new Set(['3BROT', '3SIST', '3SIBL']);

// Extended relatives — heirs only when no closer relatives survive
const EXTENDED_HEIR_TYPES = new Set(['3AUNT', '3UCLE', '3NIEC', '3NEPW', '3COUS', '3OTHE']);

// Never intestate heirs (but some can appear on probate beneficiary checklist)
const NON_HEIR_TYPES = new Set([
  '0CLNT', '1MAIN', '1DIVO',
  '2SDTR', '2SSON',           // stepchildren
  '3SNLW',                    // son/daughter-in-law
  '4CONT', '4FRIE',
  '5ATTO', '5CFP', '5CPA', '5OTHE', '5PCP', '5REAL', '5WMAN',
]);

// Contacts eligible for the probate will-beneficiary checklist
// (broader than intestate heirs — anyone who might be named in a will)
const CHECKLIST_ELIGIBLE_TYPES = new Set([
  ...SPOUSE_TYPES, ...CHILD_TYPES, ...GRANDCHILD_TYPES,
  ...PARENT_TYPES, ...SIBLING_TYPES, ...EXTENDED_HEIR_TYPES,
  '2SDTR', '2SSON',   // stepchildren can be will beneficiaries
  '3SNLW',            // in-laws can be will beneficiaries
  '4FRIE',            // friends can be will beneficiaries
  '0CLNT',            // client (petitioner) might also appear in the will
]);

// Types always excluded from the checklist
const CHECKLIST_EXCLUDE_TYPES = new Set([
  '1MAIN', '1DIVO',
  '5ATTO', '5CFP', '5CPA', '5OTHE', '5PCP', '5REAL', '5WMAN',
  '4CONT',
]);

/**
 * Determines legal heirs per RI intestacy (RIGL Chapter 33-1).
 *
 * @param {Array}            contacts               All contacts for the matter
 * @param {string}           petitionType           'admin' | 'probate'
 * @param {Set<string>|null} selectedBeneficiaryIds Explicit beneficiary IDs chosen in the UI
 *                                                  (for probate only). When provided, this list
 *                                                  becomes the exact signatory set for PC-9.1.
 *
 * @returns {{ spouse, legalHeirs, signatories, warnings }}
 *   spouse       — single contact or null
 *   legalHeirs   — intestate heirs (no spouse); used for petition heir fields
 *   signatories  — everyone who must sign the waiver (PC-9.1)
 *   warnings     — string array (empty if data is sufficient)
 */
function determineHeirs(contacts, petitionType = 'admin', selectedBeneficiaryIds = null) {
  const warnings = [];

  const spouse = contacts.find(c => SPOUSE_TYPES.has(c.relationship?.type));

  const children = contacts.filter(c =>
    CHILD_TYPES.has(c.relationship?.type) || GRANDCHILD_TYPES.has(c.relationship?.type)
  );
  const parents  = contacts.filter(c => PARENT_TYPES.has(c.relationship?.type));
  const siblings = contacts.filter(c => SIBLING_TYPES.has(c.relationship?.type));
  const extended = contacts.filter(c => EXTENDED_HEIR_TYPES.has(c.relationship?.type));

  // Highest-priority tier that has members becomes the legalHeirs group
  let legalHeirs;
  if      (children.length > 0) legalHeirs = children;
  else if (parents.length  > 0) legalHeirs = parents;
  else if (siblings.length > 0) legalHeirs = siblings;
  else if (extended.length > 0) legalHeirs = extended;
  else                          legalHeirs = [];

  if (!spouse && legalHeirs.length === 0) {
    warnings.push(
      'Warning: Insufficient family/heir data found in DecisionVault. ' +
      'Heir fields have been left blank — please complete manually before filing.'
    );
  }

  const autoSignatories = [...(spouse ? [spouse] : []), ...legalHeirs];

  // When the user has made explicit selections (probate beneficiary checklist),
  // use exactly those contacts as signatories.
  let signatories;
  if (petitionType === 'probate' && selectedBeneficiaryIds !== null) {
    signatories = contacts.filter(c => selectedBeneficiaryIds.has(c.id));
    // Warn if the explicit selection is empty
    if (signatories.length === 0 && autoSignatories.length > 0) {
      warnings.push(
        'Warning: No beneficiaries were selected. Heir fields have been left blank.'
      );
    }
  } else {
    signatories = autoSignatories;
  }

  return { spouse, legalHeirs, signatories, warnings };
}

/**
 * Single source of truth for the heir list used by ALL forms.
 *
 * Ordering:
 *   [spouse (if any), petitioner (0CLNT / is_client), ...remaining legal heirs]
 *
 * The petitioner is always inserted at position 1 (right after the spouse, or at
 * position 0 if there is no spouse) unless they are already present at position 0
 * as the spouse.
 *
 * For probate with an explicit beneficiary selection the list is:
 *   1. Base list filtered to only the selected IDs (priority order preserved)
 *   2. Any extra selected IDs not in the base list, appended in contacts order
 *   3. Petitioner force-inserted at position 1 regardless of selection
 *
 * @param {Array}            contacts               All contacts for the matter
 * @param {string}           petitionType           'admin' | 'probate'
 * @param {Set<string>|null} selectedBeneficiaryIds Will-beneficiary selection from UI
 *
 * @returns {{ list, hasSpouse, warnings }}
 *   list      — ordered contact array for ALL forms
 *   hasSpouse — true when list[0] is a spouse; used by form fillers for the spouse row
 *   warnings  — string array
 */
function buildHeirList(contacts, petitionType = 'admin', selectedBeneficiaryIds = null) {
  const { spouse, legalHeirs, warnings } = determineHeirs(contacts, petitionType, selectedBeneficiaryIds);

  // Priority-ordered base: spouse first, then legal heirs
  const base    = [...(spouse ? [spouse] : []), ...legalHeirs];
  const baseIds = new Set(base.map(c => c.id));

  let list;
  if (petitionType === 'probate' && selectedBeneficiaryIds !== null) {
    // Keep base-list entries that were selected (preserves priority order)
    list = base.filter(c => selectedBeneficiaryIds.has(c.id));

    // Append extra selected contacts not in the base list
    for (const c of contacts) {
      if (selectedBeneficiaryIds.has(c.id) && !baseIds.has(c.id)) list.push(c);
    }

    if (list.length === 0 && base.length > 0) {
      warnings.push('Warning: No beneficiaries were selected. Heir fields have been left blank.');
    }
  } else {
    list = base;
  }

  // Ensure the petitioner (0CLNT contact) is always at position 1, right after the
  // spouse — unless they are already in the list (including as the spouse at pos 0).
  const petitioner = contacts.find(c => c.is_client || c.relationship?.type === '0CLNT');
  if (petitioner && !list.some(c => c.id === petitioner.id)) {
    const firstIsSpouse = list.length > 0 && SPOUSE_TYPES.has(list[0].relationship?.type);
    list.splice(firstIsSpouse ? 1 : 0, 0, petitioner);
  }

  const hasSpouse = list.length > 0 && SPOUSE_TYPES.has(list[0].relationship?.type);
  return { list, hasSpouse, warnings };
}

/**
 * Massachusetts heir determination — MUPC G.L. c. 190B § 2-102, 2-103
 * Applies to deaths on or after 3/31/2012.
 *
 * Uses the same DecisionVault relationship type codes as the RI logic.
 *
 * @param {Array}  contacts  All contacts for the matter
 * @param {Array}  assets    All assets for the matter
 * @param {Object} matter    Matter object (for contact_main / date_of_death fallback)
 *
 * @returns {Object} Full analysis: heirs, shares, voluntary eligibility, annotated contacts, warnings
 */
function computeMassachusettsHeirs(contacts, assets, matter) {
  const warnings = [];
  assets = assets || [];

  // Date of death
  const decedent   = contacts.find(c => c.relationship?.type === '1MAIN') || matter?.contact_main || null;
  const dateOfDeath = decedent?.date_of_death || matter?.contact_main?.date_of_death || null;
  let daysSinceDeath = null;
  if (dateOfDeath) {
    daysSinceDeath = Math.floor((Date.now() - new Date(dateOfDeath).getTime()) / 86400000);
  }

  // Family identification
  const spouse      = contacts.find(c => SPOUSE_TYPES.has(c.relationship?.type)) || null;
  const exSpouse    = contacts.find(c => c.relationship?.type === '1DIVO') || null;
  const children    = contacts.filter(c => CHILD_TYPES.has(c.relationship?.type));
  const grandchildren = contacts.filter(c => GRANDCHILD_TYPES.has(c.relationship?.type));
  const parents     = contacts.filter(c => PARENT_TYPES.has(c.relationship?.type));
  const siblings    = contacts.filter(c => SIBLING_TYPES.has(c.relationship?.type));
  const extended    = contacts.filter(c => EXTENDED_HEIR_TYPES.has(c.relationship?.type));
  const descendants = [...children, ...grandchildren];

  if (exSpouse) {
    warnings.push(
      'A divorced spouse is listed. Verify the divorce was final before the date of death ' +
      '(the G.L. c. 208 § 21 nisi period must have expired).'
    );
  }

  // Minor detection: under 18 at date of death
  function isMinorAtDeath(contact) {
    if (!contact.date_of_birth || !dateOfDeath) return false;
    const ageMs = new Date(dateOfDeath).getTime() - new Date(contact.date_of_birth).getTime();
    return ageMs < 18 * 365.25 * 86400000;
  }

  // Annotate contacts with MA roles and flags
  const SKIP_TYPES = new Set(['1MAIN', '1DIVO', '5ATTO', '5CFP', '5CPA', '5OTHE', '5PCP', '5REAL', '5WMAN', '4CONT']);
  const annotatedContacts = contacts
    .filter(c => !SKIP_TYPES.has(c.relationship?.type))
    .map(c => {
      const maRoles = [];
      const maFlags = [];

      if (SPOUSE_TYPES.has(c.relationship?.type))   maRoles.push('SURVIVING_SPOUSE');
      if (c.is_client || c.relationship?.type === '0CLNT') maRoles.push('PETITIONER');
      if (['2SDTR', '2SSON'].includes(c.relationship?.type)) maRoles.push('CHILD_NOT_HEIR');

      // Legal heir tier
      if (CHILD_TYPES.has(c.relationship?.type) || GRANDCHILD_TYPES.has(c.relationship?.type)) {
        maRoles.push('LEGAL_HEIR');
      } else if (PARENT_TYPES.has(c.relationship?.type) && descendants.length === 0) {
        maRoles.push('LEGAL_HEIR');
      } else if (SIBLING_TYPES.has(c.relationship?.type) && descendants.length === 0 && parents.length === 0) {
        maRoles.push('LEGAL_HEIR');
      } else if (EXTENDED_HEIR_TYPES.has(c.relationship?.type) && descendants.length === 0 && parents.length === 0 && siblings.length === 0) {
        maRoles.push('LEGAL_HEIR');
      }

      if (isMinorAtDeath(c)) maFlags.push('MINOR');

      return { ...c, maRoles, maFlags };
    });

  const minors = annotatedContacts.filter(c => c.maFlags.includes('MINOR'));
  if (minors.length > 0) {
    warnings.push(
      `Minor(s) identified: ${minors.map(m => m.full_name).join(', ')}. ` +
      'Formal probate is required when a minor is an interested person (MUPC § 3-501).'
    );
  }

  // MUPC § 2-102 / 2-103 intestate shares
  let intestateHeirs = [];
  let spouseShare    = null;
  let othersShare    = null;

  if (spouse) {
    if (descendants.length === 0 && parents.length === 0) {
      spouseShare = 'Entire estate';
    } else if (descendants.length === 0 && parents.length > 0) {
      spouseShare  = '$200,000 + 3/4 of balance';
      othersShare  = '1/4 of balance to parent(s)';
      intestateHeirs = parents;
    } else {
      // Has descendants — exact share depends on parentage (cannot be determined from DV data)
      spouseShare  = '$100,000 + 1/2 of balance (see note)';
      othersShare  = '1/2 of balance to descendants';
      intestateHeirs = descendants;
      warnings.push(
        'Spousal intestate share depends on whether all surviving descendants are also ' +
        "descendants of the surviving spouse (MUPC § 2-102). If yes — and the spouse has no " +
        'other descendants — the spouse takes the entire estate. Verify before filing.'
      );
    }
  } else {
    if (descendants.length > 0)   intestateHeirs = descendants;
    else if (parents.length > 0)  intestateHeirs = parents;
    else if (siblings.length > 0) intestateHeirs = siblings;
    else if (extended.length > 0) intestateHeirs = extended;
    else warnings.push('No heirs identified. Please verify family information in DecisionVault.');
  }

  // Asset analysis for voluntary administration eligibility (G.L. c. 190B § 3-1201)
  const REAL_KW  = ['real estate','land','property','house','home','condo','condominium',
                    'mortgage','deed','lot','parcel','building'];
  const VEH_KW   = ['vehicle','car','auto','truck','motorcycle','boat','rv'];

  function assetText(a) {
    return [
      a.identifier_label,
      a.additional_fields?.find(f => ['Bank','Description','Type'].includes(f.prompt))?.answer,
    ].filter(Boolean).join(' ').toLowerCase();
  }

  const hasRealEstate = assets.some(a => REAL_KW.some(kw => assetText(a).includes(kw)));

  const totalPersonalPropertyValue = assets
    .filter(a => {
      const t = assetText(a);
      return !VEH_KW.some(kw => t.includes(kw)) && !REAL_KW.some(kw => t.includes(kw));
    })
    .reduce((sum, a) => sum + parseFloat(a.net_value || 0), 0);

  const voluntaryEligibilityIssues = [];
  if (hasRealEstate) {
    voluntaryEligibilityIssues.push('Estate appears to include real estate (only personal property permitted)');
  }
  if (totalPersonalPropertyValue > 25000) {
    voluntaryEligibilityIssues.push(
      `Personal property value (~$${totalPersonalPropertyValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}) ` +
      'may exceed the $25,000 limit'
    );
  }
  if (daysSinceDeath !== null && daysSinceDeath < 30) {
    voluntaryEligibilityIssues.push(
      `Only ${daysSinceDeath} day${daysSinceDeath === 1 ? '' : 's'} since death — ` +
      'must wait at least 30 days (G.L. c. 190B § 3-1201)'
    );
  }
  const voluntaryEligible = voluntaryEligibilityIssues.length === 0;

  // Suggest a starting proceeding type
  let suggestedProceedingType;
  if (voluntaryEligible && !spouse && descendants.length === 0) {
    suggestedProceedingType = 'voluntary';
  } else if (minors.length > 0) {
    suggestedProceedingType = 'formalIntestate';
  } else {
    suggestedProceedingType = 'informalIntestate';
  }

  return {
    decedent,
    dateOfDeath,
    daysSinceDeath,
    spouse,
    intestateHeirs,
    spouseShare,
    othersShare,
    descendants,
    parents,
    siblings,
    extended,
    hasRealEstate,
    totalPersonalPropertyValue,
    voluntaryEligible,
    voluntaryEligibilityIssues,
    suggestedProceedingType,
    annotatedContacts,
    warnings,
  };
}

/**
 * Compute per-person MPC 455 action defaults per G.L. c. 190B § 3-203 priority.
 *
 * Returns an array of personConfig objects (one per non-PR interested party),
 * each pre-populated with default action flags.
 *
 * Priority classes (lower number = higher priority):
 *   1 = will nominee (PR in testate)
 *   2 = surviving spouse + devisee (testate)
 *   3 = other devisees / heirs at law (testate)
 *   4 = surviving spouse (intestate)
 *   5 = other heirs at law (intestate)
 *   6 = creditors / others
 *
 * Default actions:
 *   person.priorityClass <= prPriority  →  renunciation + nomination (+ assent + waiverOfNotice)
 *   person.priorityClass  > prPriority  →  assent + waiverOfNotice only
 */
function computePRPriority(contacts, matter, toggleAnswers = {}) {
  const hasWill              = !!toggleAnswers.hasWill;
  const willAllowsNomination = !!toggleAnswers.willAllowsNomination;
  const bondWithSureties     = !!toggleAnswers.bondWithSureties;
  const suretyWaived         = !!toggleAnswers.suretyWaived;
  const defaultWaiverOfSureties = !bondWithSureties || suretyWaived;

  const SKIP_TYPES = new Set([
    '1MAIN', '1DIVO',
    '5ATTO', '5CFP', '5CPA', '5OTHE', '5PCP', '5REAL', '5WMAN',
    '4CONT',
  ]);

  const CAPACITY_MAP = {
    '1MARR': 'Surviving Spouse',  '1WIDW': 'Surviving Spouse', '3LIFP': 'Domestic Partner',
    '2SON':  'Heir/Child',        '2DATR': 'Heir/Child',
    '2ADOP': 'Heir/Child',        '2ADTD': 'Heir/Child',
    '3GSON': 'Heir/Grandchild',   '3GDTR': 'Heir/Grandchild',
    '3FATH': 'Heir/Parent',       '3MOTH': 'Heir/Parent',
    '3BROT': 'Heir/Sibling',      '3SIST': 'Heir/Sibling', '3SIBL': 'Heir/Sibling',
    '3AUNT': 'Heir/Aunt',         '3UCLE': 'Heir/Uncle',
    '3NIEC': 'Heir/Niece',        '3NEPW': 'Heir/Nephew',  '3COUS': 'Heir/Cousin',
    '3OTHE': 'Other Relative',    '4FRIE': 'Friend/Interested Party',
    '2SDTR': 'Stepchild',         '2SSON': 'Stepchild',
  };

  function priorityClassForType(type) {
    if (hasWill) {
      if (SPOUSE_TYPES.has(type))                                                    return 2;
      if (CHILD_TYPES.has(type) || GRANDCHILD_TYPES.has(type))                      return 3;
      if (PARENT_TYPES.has(type) || SIBLING_TYPES.has(type) || EXTENDED_HEIR_TYPES.has(type)) return 3;
      return 4;
    } else {
      if (SPOUSE_TYPES.has(type))                                                    return 4;
      if (CHILD_TYPES.has(type) || GRANDCHILD_TYPES.has(type))                      return 5;
      if (PARENT_TYPES.has(type) || SIBLING_TYPES.has(type) || EXTENDED_HEIR_TYPES.has(type)) return 5;
      return 6;
    }
  }

  // PR is the 0CLNT / is_client contact
  const pr = contacts.find(c => c.is_client || c.relationship?.type === '0CLNT');
  // If a surviving spouse exists and is NOT the PR, the PR must be a child/heir (P5).
  // If no non-PR spouse exists, the PR may be the spouse themselves (P4).
  const hasNonPRSpouse = contacts.some(c =>
    SPOUSE_TYPES.has(c.relationship?.type) && c.id !== pr?.id
  );
  const prPriority = hasWill ? 1 : (hasNonPRSpouse ? 5 : 4);

  // canNominate: for testate proceedings, the will governs who can nominate; default false
  // unless willAllowsNomination is explicitly set true.
  const canNominate = !hasWill || willAllowsNomination;

  const prName = pr ? {
    first: pr.first_name  || '',
    last:  pr.last_name   || '',
    mi:    pr.middle_name || '',
  } : null;

  const result = [];
  for (const contact of contacts) {
    const relType = contact.relationship?.type;
    if (SKIP_TYPES.has(relType)) continue;
    if (contact.id === pr?.id)   continue; // PR does not sign their own MPC 455

    const pClass       = priorityClassForType(relType);
    const renunciation = pClass <= prPriority; // same or better priority must renounce
    const nomination   = renunciation && canNominate && !!prName;

    result.push({
      id:                  contact.id,
      firstName:           contact.first_name  || '',
      lastName:            contact.last_name   || '',
      middleName:          contact.middle_name || '',
      capacityLabel:       CAPACITY_MAP[relType] || 'Interested Party',
      priorityClass:       pClass,
      // Action defaults
      assent:              true,
      waiverOfNotice:      true,
      renunciation,
      nomination,
      consentToNomination: false,
      waiverOfSureties:    defaultWaiverOfSureties,
      nomineeName:         prName ? { ...prName } : { first: '', last: '', mi: '' },
      canNominate,
    });
  }

  return result;
}

module.exports = {
  determineHeirs,
  buildHeirList,
  computeMassachusettsHeirs,
  computePRPriority,
  SPOUSE_TYPES,
  CHILD_TYPES,
  GRANDCHILD_TYPES,
  PARENT_TYPES,
  SIBLING_TYPES,
  EXTENDED_HEIR_TYPES,
  NON_HEIR_TYPES,
  CHECKLIST_ELIGIBLE_TYPES,
  CHECKLIST_EXCLUDE_TYPES,
};
