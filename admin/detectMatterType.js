'use strict';

const { getCountyFromAddress } = require('../forms/common');

function categorizeMatter(internalType) {
  const t = (internalType || '').toLowerCase().replace(/[\s-]/g, '');
  if (t.includes('guardianship') || t.includes('conservatorship')) return 'guardianship';
  if (t.includes('probate') || t === 'rhodeislandprobate' || t === 'massachusettsprobate') return 'probate';
  if (t.includes('trust') && !t.includes('planning')) return 'trust';
  if (t.includes('planning') || t === 'planning') return 'planning';
  if (t.includes('litigation')) return 'litigation';
  return 'other';
}

function detectMatterType(matter, contacts = [], assets = [], overrides = {}, documents = []) {
  // ── State ────────────────────────────────────────────────────────────────────
  const internalType = matter.questionnaire?.internal_type || matter.quest_internal_type || '';
  let dvState;
  if (internalType === 'RhodeIslandProbate') {
    dvState = 'RI';
  } else if (internalType === 'MassachusettsProbate' || internalType === 'Massachusetts Probate') {
    dvState = 'MA';
  } else {
    // Fallback: address-based detection from decedent contact
    const dec = contacts.find(c => /decedent/i.test(c.contact_type || c.type || ''));
    const decAddr = dec?.addresses?.[0] || {};
    const county = getCountyFromAddress(decAddr, null);
    if (county) {
      dvState = 'MA';
    } else {
      const addrState = (decAddr.state || '').toUpperCase();
      if (addrState === 'RI' || addrState === 'RHODE ISLAND') {
        dvState = 'RI';
      } else {
        dvState = 'OTHER';
      }
    }
  }
  const state = overrides.state || dvState;
  const stateSource = overrides.state ? 'override' : (internalType ? 'dv' : 'address');

  // ── Will detection from documents ─────────────────────────────────────────────
  const nonDupDocs = documents.filter(d => !d.isDuplicate);
  const willDoc = nonDupDocs.find(d =>
    d.type === 'WILL' ||
    (d.requestLabel || '').toLowerCase().includes('will') ||
    (d.filename || '').toLowerCase().includes('will')
  );
  const dvHasWill = willDoc ? true : null; // null = unknown (no will document found)
  const hasWill = overrides.hasWill !== undefined ? overrides.hasWill : dvHasWill;
  const willSource = overrides.hasWill !== undefined ? 'override' : (willDoc ? 'document' : 'unknown');

  // ── Proceeding type ───────────────────────────────────────────────────────────
  let proceedingType;
  if (overrides.proceedingType !== undefined) {
    proceedingType = overrides.proceedingType; // null means trust-only (no probate)
  } else if (hasWill === true) {
    proceedingType = 'testate';
  } else if (hasWill === false) {
    proceedingType = 'intestate';
  } else {
    proceedingType = null; // unknown — prompt user
  }
  const proceedingSource = overrides.proceedingType !== undefined ? 'override' : 'dv';

  // ── Trust ─────────────────────────────────────────────────────────────────────
  const dvHasTrust = !!(
    matter.trust_name ||
    assets.some(a => /trust/i.test([a.asset_type, a.description, a.name].filter(Boolean).join(' ')))
  );
  const hasTrust = overrides.hasTrust !== undefined ? overrides.hasTrust : dvHasTrust;

  // ── Pour-over ─────────────────────────────────────────────────────────────────
  const dvIsPourOver = assets.some(a =>
    /pour.?over/i.test([a.asset_type, a.description, a.name].filter(Boolean).join(' '))
  );
  const isPourOver = overrides.isPourOver !== undefined ? overrides.isPourOver : dvIsPourOver;

  // ── Ancillary ─────────────────────────────────────────────────────────────────
  const matterState = (matter.state || '').toUpperCase();
  const dvIsAncillary = assets.some(a => {
    const assetState = (a.address_state || a.state || '').toUpperCase();
    return assetState && assetState !== matterState;
  });
  const isAncillary = overrides.isAncillary !== undefined ? overrides.isAncillary : dvIsAncillary;
  const ancillaryPrimaryState = overrides.ancillaryPrimaryState || null;

  // ── Derived display type ──────────────────────────────────────────────────────
  // Valid proceedingType values: "testate" | "intestate" | null (trust-only or unknown)
  // matterTypeDisplay is for UI tab/warning purposes only, not stored as proceedingType
  const isProbate = proceedingType === 'testate' || proceedingType === 'intestate';
  const matterTypeDisplay = (isProbate && hasTrust) ? 'probate_and_trust'
    : (hasTrust && !isProbate) ? 'trust'
    : 'probate';

  return {
    state,
    stateSource,
    proceedingType,
    proceedingSource,
    hasWill,
    willSource,
    hasTrust,
    isPourOver,
    isAncillary,
    ancillaryPrimaryState,
    matterTypeDisplay,
    matterCategory: categorizeMatter(internalType),
    overrides,
  };
}

module.exports = { detectMatterType, categorizeMatter };
