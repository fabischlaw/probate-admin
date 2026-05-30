'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');
const { getAuthHeaders }   = require('../auth');
const { categorizeMatter } = require('../admin/detectMatterType');
const pool = require('../config/database');

const DV_BASE = 'https://api.decisionvault.com/v1';

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

async function loadAdminDataDB() {
  const { rows } = await pool.query(
    'SELECT matter_id, stage, key_dates, matter_type_overrides, saved_matter_type FROM matter_admin'
  );
  const result = {};
  for (const row of rows) {
    result[row.matter_id] = {
      stage:               row.stage,
      keyDates:            row.key_dates            || {},
      matterTypeOverrides: row.matter_type_overrides || {},
      savedMatterType:     row.saved_matter_type,
    };
  }
  return result;
}

async function updateMatterKeyDates(matterId, keyDates) {
  await pool.query(
    `INSERT INTO matter_admin (matter_id, key_dates)
     VALUES ($1, $2)
     ON CONFLICT (matter_id) DO UPDATE SET key_dates=$2, updated_at=NOW()`,
    [matterId, JSON.stringify(keyDates)]
  );
}

async function saveScanHistory(data) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('scanHistory', $1)
     ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
    [JSON.stringify(data)]
  );
}

// Returns true if a new flag was inserted
async function raiseFlag({ matterId, matterName, type, severity, message }) {
  const { rows } = await pool.query(
    'SELECT id FROM flags WHERE matter_id=$1 AND type=$2 AND resolved_at IS NULL',
    [matterId, type]
  );
  if (rows.length > 0) {
    await pool.query('UPDATE flags SET last_seen_at=NOW() WHERE id=$1', [rows[0].id]);
    return false;
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO flags (id, matter_id, matter_name, type, severity, message, raised_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
    [id, matterId, matterName, type, severity, message]
  );
  return true;
}

async function resolveFlag(matterId, type) {
  await pool.query(
    'UPDATE flags SET resolved_at=NOW() WHERE matter_id=$1 AND type=$2 AND resolved_at IS NULL',
    [matterId, type]
  );
}

function extractDecedentName(matterName) {
  if (!matterName) return matterName;
  return matterName.split(' - ')[0].trim() || matterName;
}

const APPOINTED_STAGES = new Set(['APPOINTED', 'IN_ADMINISTRATION', 'CLOSING_PREP', 'CLOSED']);
const FILED_STAGES     = new Set(['FILED', 'APPOINTED', 'IN_ADMINISTRATION', 'CLOSING_PREP', 'CLOSED']);

function shouldRaiseFlag(flagType, matterAdmin) {
  const stage          = matterAdmin.stage || 'PETITION_PREP';
  const savedType      = matterAdmin.savedMatterType || matterAdmin.matterTypeOverrides || {};
  const proceedingType = savedType.proceedingType;
  const hasTrust       = !!savedType.hasTrust;

  switch (flagType) {
    case 'MISSING_WILL_OR_TRUST':      return proceedingType !== 'intestate';
    case 'MISSING_APPOINTMENT_DATE':   return APPOINTED_STAGES.has(stage);
    case 'MISSING_PUBLICATION_DATE':   return FILED_STAGES.has(stage);
    case 'UNEXPECTED_TRUST_DOCUMENT':  return !hasTrust;
    default:                           return true;
  }
}

async function searchGmailForMatter(/* matterName, decedentName */) {
  return [];
}

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

async function runDocumentScannerAgent(mattersArg, adminDataArg) {
  const adminData = adminDataArg || await loadAdminDataDB();
  const matters   = mattersArg   || await fetchMatters();

  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*) FROM flags WHERE resolved_at IS NULL"
  );
  const prevFlagCount = parseInt(countRows[0].count);

  const now         = new Date().toISOString();
  const scanResults = [];
  const errors      = [];
  let docsScanned   = 0;
  let autoPopulated = 0;
  let flagsRaised   = 0;

  for (const matter of matters) {
    const category = categorizeMatter(matter.quest_internal_type);
    if (category === 'planning') continue;

    const rec = adminData[matter.id];
    if (rec?.stage === 'CLOSED') {
      for (const ft of ['MISSING_APPOINTMENT_DATE','MISSING_DEATH_CERTIFICATE','MISSING_WILL_OR_TRUST','UNEXPECTED_TRUST_DOCUMENT','MISSING_PUBLICATION_DATE']) {
        await resolveFlag(matter.id, ft);
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

    const found          = new Set();
    const matterFindings = [];

    for (const doc of allDocs) {
      const docType = classifyDocument(doc);
      if (docType) {
        found.add(docType);
        matterFindings.push({ docType, filename: doc.filename || '(unnamed)', docId: doc.id });
      }

      if (docType === 'LETTERS_OF_AUTHORITY' && !keyDates.appointmentDate) {
        const issued = doc.created_at || doc.uploaded_at || null;
        if (issued) {
          const newDate = issued.slice(0, 10);
          keyDates.appointmentDate = newDate;
          await updateMatterKeyDates(matter.id, keyDates);
          autoPopulated++;
          matterFindings.push({ action: 'AUTO_POPULATED', field: 'appointmentDate', value: newDate });
          await resolveFlag(matter.id, 'MISSING_APPOINTMENT_DATE');
        }
      }

      if (docType === 'DEATH_CERTIFICATE' && !keyDates.dateOfDeath) {
        matterFindings.push({ action: 'NOTED', field: 'dateOfDeath', note: 'Death certificate present; verify DOD in key dates' });
      }
    }

    const matterAdmin = rec || { stage: 'PETITION_PREP' };

    async function checkFlag(flagType, condition, severity, message) {
      if (!condition) { await resolveFlag(matter.id, flagType); return; }
      if (shouldRaiseFlag(flagType, matterAdmin)) {
        const isNew = await raiseFlag({ matterId: matter.id, matterName: decedentName, type: flagType, severity, message });
        if (isNew) flagsRaised++;
      } else {
        await resolveFlag(matter.id, flagType);
      }
    }

    await checkFlag(
      'MISSING_APPOINTMENT_DATE',
      !keyDates.appointmentDate && !found.has('LETTERS_OF_AUTHORITY'),
      'high',
      `No Letters of Authority found and appointment date not set for ${decedentName}.`
    );

    await checkFlag(
      'MISSING_DEATH_CERTIFICATE',
      !found.has('DEATH_CERTIFICATE'),
      'medium',
      `No death certificate document found for ${decedentName}.`
    );

    const needsWillDoc = (category === 'probate' || category === 'trust') && !found.has('WILL') && !found.has('TRUST');
    await checkFlag(
      'MISSING_WILL_OR_TRUST',
      needsWillDoc,
      'medium',
      `No will or trust document found for ${decedentName}.`
    );

    if (found.has('TRUST')) {
      await checkFlag(
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

  const { rows: finalCountRows } = await pool.query(
    "SELECT COUNT(*) FROM flags WHERE resolved_at IS NULL"
  );
  const openFlags = parseInt(finalCountRows[0].count);

  const { rows: highRows } = await pool.query(
    "SELECT COUNT(*) FROM flags WHERE resolved_at IS NULL AND severity='high'"
  );
  const highFlags   = parseInt(highRows[0].count);
  const mediumFlags = openFlags - highFlags;

  const history = {
    lastRun:        now,
    mattersScanned: scanResults.length,
    docsScanned,
    autoPopulated,
    flagsRaised:    Math.max(0, openFlags - prevFlagCount),
    openFlags,
    highFlags,
    mediumFlags,
    results:        scanResults,
    errors,
  };
  await saveScanHistory(history);

  console.log(`[ScanAgent] Scan complete: ${scanResults.length} matters, ${docsScanned} docs, ${autoPopulated} auto-populated, ${openFlags} open flags (${highFlags} high)`);
  return history;
}

if (require.main === module) {
  runDocumentScannerAgent()
    .then(r => { console.log(JSON.stringify({ openFlags: r.openFlags, highFlags: r.highFlags, docsScanned: r.docsScanned }, null, 2)); process.exit(0); })
    .catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { runDocumentScannerAgent, classifyDocument, DOCUMENT_CLASSIFIERS };
