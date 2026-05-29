'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { getAuthHeaders }   = require('../auth');
const { categorizeMatter } = require('../admin/detectMatterType');

const DV_BASE      = 'https://api.decisionvault.com/v1';
const ADMIN_FILE   = path.join(__dirname, '../data/administration.json');
const FLAGS_FILE   = path.join(__dirname, '../data/flags.json');
const HISTORY_FILE = path.join(__dirname, '../data/scanHistory.json');

// ── Document classifiers ─────────────────────────────────────────────────────
// Each entry: array of keyword fragments matched against doc label + filename (lowercase)
const DOCUMENT_CLASSIFIERS = {
  LETTERS_OF_AUTHORITY: [
    'letters of authority', 'letters testamentary', 'letters administration',
    'letter of authority', 'letter testamentary',
  ],
  DEATH_CERTIFICATE: [
    'death certificate', 'death cert', 'certificate of death',
  ],
  INVENTORY: [
    'inventory', 'estate inventory', 'probate inventory',
  ],
  CLOSING_STATEMENT: [
    'closing statement', 'final account', 'final accounting', 'account of fiduciary',
  ],
  ESTATE_TAX_RETURN: [
    'estate tax return', 'form 706', 'm-706', 'estate tax',
  ],
  CREDITOR_CLAIM: [
    'creditor claim', 'claim against estate', 'proof of claim',
  ],
  COURT_ORDER: [
    'court order', 'decree', 'judge order',
  ],
  WILL: [
    'last will', 'will and testament', 'will document', 'will.pdf',
  ],
  TRUST: [
    'trust agreement', 'trust document', 'revocable trust', 'irrevocable trust',
  ],
  IRS_CORRESPONDENCE: [
    'irs letter', 'internal revenue', 'irs correspondence', 'form 1041', 'form 1099',
  ],
  MASSHEALTH: [
    'masshealth', 'mass health', 'medicaid', 'elder affairs',
  ],
};

function classifyDocument(doc) {
  const label    = (doc.document_request?.label || doc.label || '').toLowerCase();
  const filename = (doc.filename || '').toLowerCase();
  const combined = `${label} ${filename}`;
  for (const [type, keywords] of Object.entries(DOCUMENT_CLASSIFIERS)) {
    if (keywords.some(kw => combined.includes(kw))) return type;
  }
  return null;
}

function loadAdminData() {
  try { return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAdminData(data) {
  fs.mkdirSync(path.dirname(ADMIN_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(data, null, 2));
}

function loadFlags() {
  try { return JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8')); }
  catch { return []; }
}

function saveFlags(flags) {
  fs.mkdirSync(path.dirname(FLAGS_FILE), { recursive: true });
  fs.writeFileSync(FLAGS_FILE, JSON.stringify(flags, null, 2));
}

function saveHistory(data) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function extractDecedentName(matterName) {
  if (!matterName) return matterName;
  return matterName.split(' - ')[0].trim() || matterName;
}

const APPOINTED_STAGES = new Set(['APPOINTED', 'IN_ADMINISTRATION', 'CLOSING_PREP', 'CLOSED']);
const FILED_STAGES     = new Set(['FILED', 'APPOINTED', 'IN_ADMINISTRATION', 'CLOSING_PREP', 'CLOSED']);

function shouldRaiseFlag(flagType, matterAdmin, matterConditions = {}) {
  const stage         = matterAdmin.stage || 'PETITION_PREP';
  const savedType     = matterAdmin.savedMatterType || matterAdmin.matterTypeOverrides || {};
  const proceedingType = savedType.proceedingType;
  const hasTrust       = !!savedType.hasTrust;

  switch (flagType) {
    case 'MISSING_WILL_OR_TRUST':
      // Never flag for confirmed intestate
      if (proceedingType === 'intestate') return false;
      return true;

    case 'MISSING_APPOINTMENT_DATE':
      // Only flag in APPOINTED stage or later
      return APPOINTED_STAGES.has(stage);

    case 'MISSING_PUBLICATION_DATE':
      // Only flag in FILED stage or later
      return FILED_STAGES.has(stage);

    case 'MISSING_DEATH_CERTIFICATE':
      // Always relevant
      return true;

    case 'MASSHEALTH':
      return true;

    case 'MISSING_REAL_ESTATE_DOCS':
      return !!matterConditions.hasRealEstate;

    case 'UNEXPECTED_TRUST_DOCUMENT':
      // Flag only if trust was NOT expected
      return !hasTrust;

    case 'CREDITOR_CLAIM':
    case 'IRS_CORRESPONDENCE':
    case 'COURT_ORDER':
      return true;

    default:
      return true;
  }
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Gmail placeholder ────────────────────────────────────────────────────────
async function searchGmailForMatter(/* matterName, decedentName */) {
  // Gmail integration not yet wired — returns empty
  return [];
}

// ── DV helpers ───────────────────────────────────────────────────────────────
async function fetchMatters() {
  const headers = await getAuthHeaders();
  const res = await axios.get(`${DV_BASE}/matters`, { headers });
  return res.data.results || res.data || [];
}

async function fetchMatterDocuments(matterId) {
  try {
    const headers = await getAuthHeaders();
    const res = await axios.get(`${DV_BASE}/matters/${matterId}/documents`, { headers });
    const data = res.data;
    return data.documents || data.results || (Array.isArray(data) ? data : []);
  } catch {
    return [];
  }
}

// ── Flag helpers ──────────────────────────────────────────────────────────────
function raiseFlag(flags, { matterId, matterName, type, severity, message }) {
  // Don't duplicate open flags of the same type for the same matter
  const existing = flags.find(
    f => f.matterId === matterId && f.type === type && !f.resolvedAt
  );
  if (existing) {
    existing.lastSeenAt = new Date().toISOString();
    return;
  }
  flags.push({
    id:          generateId(),
    matterId,
    matterName,
    type,
    severity,
    message,
    raisedAt:    new Date().toISOString(),
    lastSeenAt:  new Date().toISOString(),
    acknowledgedAt: null,
    resolvedAt:  null,
  });
}

function resolveFlag(flags, matterId, type) {
  const flag = flags.find(f => f.matterId === matterId && f.type === type && !f.resolvedAt);
  if (flag) flag.resolvedAt = new Date().toISOString();
}

// ── Main agent ───────────────────────────────────────────────────────────────
async function runDocumentScannerAgent(mattersArg, adminDataArg) {
  const adminData = adminDataArg || loadAdminData();
  const matters   = mattersArg   || await fetchMatters();

  const flags = loadFlags();
  const now   = new Date().toISOString();

  const scanResults = [];
  const errors      = [];

  let docsScanned     = 0;
  let autoPopulated   = 0;
  let flagsRaised     = 0;
  const prevFlagCount = flags.filter(f => !f.resolvedAt).length;

  for (const matter of matters) {
    const category = categorizeMatter(matter.quest_internal_type);
    if (category === 'planning') continue;

    const rec = adminData[matter.id];
    if (rec?.stage === 'CLOSED') {
      // Resolve any lingering flags for closed matters
      for (const ft of ['MISSING_APPOINTMENT_DATE','MISSING_DEATH_CERTIFICATE','MISSING_WILL_OR_TRUST','UNEXPECTED_TRUST_DOCUMENT','MISSING_PUBLICATION_DATE']) {
        resolveFlag(flags, matter.id, ft);
      }
      continue;
    }

    const matterName   = matter.name || matter.id;
    const decedentName = extractDecedentName(matterName);
    const keyDates     = rec?.keyDates || {};

    let docs = [];
    try {
      docs = await fetchMatterDocuments(matter.id);
      docsScanned += docs.length;
    } catch (err) {
      errors.push({ matterId: matter.id, matterName, error: err.message });
      continue;
    }

    const gmailDocs = await searchGmailForMatter(matterName, decedentName);
    const allDocs   = [...docs, ...gmailDocs];

    const found = new Set();
    const matterFindings = [];

    for (const doc of allDocs) {
      const docType = classifyDocument(doc);
      if (docType) {
        found.add(docType);
        matterFindings.push({ docType, filename: doc.filename || '(unnamed)', docId: doc.id });
      }

      // Auto-populate: appointmentDate from LETTERS_OF_AUTHORITY
      if (docType === 'LETTERS_OF_AUTHORITY' && !keyDates.appointmentDate) {
        const issued = doc.created_at || doc.uploaded_at || null;
        if (issued) {
          if (!adminData[matter.id]) adminData[matter.id] = { keyDates: {}, tasks: {}, stage: 'PETITION_PREP' };
          adminData[matter.id].keyDates = adminData[matter.id].keyDates || {};
          adminData[matter.id].keyDates.appointmentDate = issued.slice(0, 10);
          autoPopulated++;
          matterFindings.push({ action: 'AUTO_POPULATED', field: 'appointmentDate', value: issued.slice(0, 10) });
          resolveFlag(flags, matter.id, 'MISSING_APPOINTMENT_DATE');
        }
      }

      // Auto-populate: DOD from DEATH_CERTIFICATE (contact date_of_death takes priority, this is fallback)
      if (docType === 'DEATH_CERTIFICATE' && !keyDates.dateOfDeath) {
        const issued = doc.created_at || null;
        if (issued) {
          if (!adminData[matter.id]) adminData[matter.id] = { keyDates: {}, tasks: {}, stage: 'PETITION_PREP' };
          adminData[matter.id].keyDates = adminData[matter.id].keyDates || {};
          // Only set if clearly missing — don't overwrite with upload date (too unreliable)
          // Mark as a finding but don't auto-populate DOD (DV contact field is authoritative)
          matterFindings.push({ action: 'NOTED', field: 'dateOfDeath', note: 'Death certificate present; verify DOD in key dates' });
        }
      }
    }

    // ── Raise/resolve flags (stage and matter-type aware) ────────────────────

    const matterAdmin  = rec || { stage: 'PETITION_PREP' };
    const matterConds  = {}; // DV-derived conditions not available in scanner; safe default

    // ── Helper: raise flag if appropriate, resolve if not ──────────────────
    function checkFlag(flagType, condition, severity, message) {
      if (!condition) { resolveFlag(flags, matter.id, flagType); return; }
      if (shouldRaiseFlag(flagType, matterAdmin, matterConds)) {
        raiseFlag(flags, { matterId: matter.id, matterName: decedentName, type: flagType, severity, message });
        flagsRaised++;
      } else {
        resolveFlag(flags, matter.id, flagType); // stale — no longer applicable
      }
    }

    // Appointment date: only flag in APPOINTED+ stages
    checkFlag(
      'MISSING_APPOINTMENT_DATE',
      !keyDates.appointmentDate && !found.has('LETTERS_OF_AUTHORITY'),
      'high',
      `No Letters of Authority found and appointment date not set for ${decedentName}.`
    );

    // Death certificate: always relevant
    checkFlag(
      'MISSING_DEATH_CERTIFICATE',
      !found.has('DEATH_CERTIFICATE'),
      'medium',
      `No death certificate document found for ${decedentName}.`
    );

    // Missing will/trust: skip if matter confirmed intestate
    const needsWillDoc = (category === 'probate' || category === 'trust') && !found.has('WILL') && !found.has('TRUST');
    checkFlag(
      'MISSING_WILL_OR_TRUST',
      needsWillDoc,
      'medium',
      `No will or trust document found for ${decedentName}.`
    );
    // Unexpected trust document
    if (found.has('TRUST')) {
      checkFlag(
        'UNEXPECTED_TRUST_DOCUMENT',
        true,
        'medium',
        `Trust document found for ${decedentName} but matter is not marked as trust type.`
      );
    }

    scanResults.push({
      matterId:   matter.id,
      matterName: decedentName,
      category,
      docsFound:  allDocs.length,
      classified: found.size,
      findings:   matterFindings,
      scannedAt:  now,
    });
  }

  // Save auto-populated dates back to adminData
  if (autoPopulated > 0) saveAdminData(adminData);

  // Persist flags
  saveFlags(flags);

  const openFlags    = flags.filter(f => !f.resolvedAt);
  const highFlags    = openFlags.filter(f => f.severity === 'high').length;
  const mediumFlags  = openFlags.filter(f => f.severity === 'medium').length;
  const newFlagCount = openFlags.length - prevFlagCount;

  const history = {
    lastRun:       now,
    mattersScanned: scanResults.length,
    docsScanned,
    autoPopulated,
    flagsRaised:   Math.max(0, newFlagCount),
    openFlags:     openFlags.length,
    highFlags,
    mediumFlags,
    results:       scanResults,
    errors,
  };
  saveHistory(history);

  console.log(`[ScanAgent] Scan complete: ${scanResults.length} matters, ${docsScanned} docs, ${autoPopulated} auto-populated, ${openFlags.length} open flags (${highFlags} high)`);
  return history;
}

// Allow standalone run: node agents/documentScannerAgent.js
if (require.main === module) {
  runDocumentScannerAgent()
    .then(r => { console.log(JSON.stringify({ openFlags: r.openFlags, highFlags: r.highFlags, docsScanned: r.docsScanned }, null, 2)); process.exit(0); })
    .catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { runDocumentScannerAgent, classifyDocument, DOCUMENT_CLASSIFIERS };
