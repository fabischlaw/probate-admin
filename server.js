require('dotenv').config();
const express   = require('express');
const fs        = require('fs');
const axios     = require('axios');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const session   = require('express-session');
const { requireAuth, requireRole, ROLE_PERMISSIONS } = require('./auth/authMiddleware');
const { createUser, verifyUser, getUsers, isSetupComplete, generateTempPassword } = require('./auth/userManager');
const { logAuditEvent, getAuditLog, getAuditLogTotal } = require('./auth/auditLog');
const { getAuthHeaders }  = require('./auth');
const { saveForm, savePackage } = require('./fillPdf');
const { determineHeirs, computeMassachusettsHeirs, computePRPriority } = require('./heirLogic');
const { MA_FORM_SETS, MA_FORM_LABELS } = require('./forms/maFormSets');
const { mergePdfs } = require('./mergePdfs');

// MA filler modules
const { fillMPC150 } = require('./forms/mpc-150');
const { fillMPC160 } = require('./forms/mpc-160');
const { fillMPC161 } = require('./forms/mpc-161');
const { fillMPC162 } = require('./forms/mpc-162');
const { fillMPC163 } = require('./forms/mpc-163');
const { fillMPC170 } = require('./forms/mpc-170');
const { fillMPC455 } = require('./forms/mpc-455');
const { fillMPC470 } = require('./forms/mpc-470');
const { fillMPC475 } = require('./forms/mpc-475');
const { fillMPC480 } = require('./forms/mpc-480');
const { fillMPC485 } = require('./forms/mpc-485');
const { fillMPC550 } = require('./forms/mpc-550');
const { fillMPC551 } = require('./forms/mpc-551');
const { fillMPC750 } = require('./forms/mpc-750');
const { fillMPC755 } = require('./forms/mpc-755');
const { fillMPC757 } = require('./forms/mpc-757');
const { fillMPC801 } = require('./forms/mpc-801');

const MA_FILLERS = {
  'MPC-150': fillMPC150,
  'MPC-160': fillMPC160,
  'MPC-161': fillMPC161,
  'MPC-162': fillMPC162,
  'MPC-163': fillMPC163,
  'MPC-170': fillMPC170,
  'MPC-455': fillMPC455,
  'MPC-470': fillMPC470,
  'MPC-475': fillMPC475,
  'MPC-480': fillMPC480,
  'MPC-485': fillMPC485,
  'MPC-550': fillMPC550,
  'MPC-551': fillMPC551,
  'MPC-750': fillMPC750,
  'MPC-755': fillMPC755,
  'MPC-757': fillMPC757,
  'MPC-801': fillMPC801,
};
// MPC-560 is court-issued — no filler; excluded from packages
const COURT_ISSUED_FORMS = new Set(['MPC-560']);

// ── Data paths (supports Railway Volume via DATA_DIR env var) ─────────────────
const PATHS = require('./config/paths');
console.log('[Startup] Data directory:', PATHS.DATA_DIR);
console.log('[Startup] Users file exists:', fs.existsSync(PATHS.USERS_FILE));

const app  = express();
const PORT = process.env.PORT || 3000;
const DV_BASE = 'https://api.decisionvault.com/v1';
const AI_MODE    = process.env.AI_MODE || 'disabled';
const AI_ENABLED = AI_MODE === 'api'
  ? !!process.env.ANTHROPIC_API_KEY
  : AI_MODE === 'browser';

// ── Smoke-test route (no middleware, no auth) ─────────────────────────────────
app.get('/ping', (req, res) => res.send('pong'));

app.use(express.json());

// Trust Railway's (and other reverse proxies') SSL termination
app.set('trust proxy', 1);

// ── Session middleware (memory store — reliable on Railway) ───────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   24 * 60 * 60 * 1000,
  },
}));

// ── Root: redirect to setup or login if not authenticated ─────────────────────
app.get('/', (req, res, next) => {
  if (!isSetupComplete()) return res.redirect('/setup');
  if (!req.session?.userId) return res.redirect('/login');
  next();
});

// ── Auth pages (public) ───────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public/login.html'));
});
app.get('/setup', (req, res) => {
  if (isSetupComplete()) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public/setup.html'));
});

// ── Static files (needed for login/setup page assets too) ────────────────────
app.use(express.static('public'));

// ── Auth API routes (public — no requireAuth) ─────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    console.log('[LOGIN] attempt:', req.body?.email);
    console.log('[LOGIN] protocol:', req.protocol);
    console.log('[LOGIN] secure:', req.secure);
    console.log('[LOGIN] NODE_ENV:', process.env.NODE_ENV);
    const { email, password, rememberMe } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await verifyUser(email, password);
    console.log('[LOGIN] verifyUser result:', user ? 'found' : 'not found');
    console.log('[LOGIN] users.json exists:', fs.existsSync(PATHS.USERS_FILE));
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    req.session.user   = user;
    if (rememberMe) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
    console.log('[LOGIN] session id:', req.session.id);
    console.log('[LOGIN] user set:', !!req.session.userId);
    logAuditEvent(req, 'LOGIN', null, null, `User logged in from ${req.ip}`).catch(() => {});
    res.json({
      success: true,
      user: { id: user.id, name: user.name, role: user.role, permissions: ROLE_PERMISSIONS[user.role] },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  logAuditEvent(req, 'LOGOUT', null, null, 'User logged out').catch(() => {});
  req.session.destroy(() => res.json({ success: true }));
});

app.post('/api/auth/setup', async (req, res) => {
  try {
    if (isSetupComplete()) return res.status(403).json({ error: 'Setup already complete' });
    const { name, email, password, teamMembers } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
    await createUser({ name, email, role: 'attorney', password });
    console.log('[Setup] Attorney created:', email);
    console.log('[Setup] Users file exists:', fs.existsSync(PATHS.USERS_FILE));
    console.log('[Setup] Users file path:', PATHS.USERS_FILE);
    if (Array.isArray(teamMembers)) {
      for (const member of teamMembers) {
        if (member.name && member.email) {
          await createUser({ ...member, password: generateTempPassword() }).catch(() => {});
        }
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    user:        req.session.user,
    permissions: ROLE_PERMISSIONS[req.session.user.role] || {},
  });
});

// ── User management ───────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, requireRole('attorney', 'firm_admin'), (req, res) => {
  res.json(getUsers());
});
app.post('/api/users', requireAuth, requireRole('attorney', 'firm_admin'), async (req, res) => {
  try {
    const user = await createUser(req.body);
    logAuditEvent(req, 'USER_CREATED', null, null, `Created user: ${user.name} (${user.role})`).catch(() => {});
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Public utility endpoints (must be before auth middleware) ─────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    version:   process.env.npm_package_version || '1.0.0',
  });
});

app.get('/api/diag', (req, res) => {
  res.json({
    DATA_DIR:        PATHS.DATA_DIR,
    DATA_DIR_ENV:    process.env.DATA_DIR || '(not set)',
    NODE_ENV:        process.env.NODE_ENV || '(not set)',
    dataDirExists:   fs.existsSync(PATHS.DATA_DIR),
    usersFileExists: fs.existsSync(PATHS.USERS_FILE),
    usersFilePath:   PATHS.USERS_FILE,
  });
});

// ── Protect all subsequent routes ─────────────────────────────────────────────
app.use((req, res, next) => {
  const publicPaths = ['/login', '/setup', '/api/auth/', '/api/health', '/api/diag', '/ping'];
  if (publicPaths.some(p => req.path.startsWith(p))) return next();
  return requireAuth(req, res, next);
});

// ── Document extraction ──────────────────────────────────────────────────────

// In-memory cache: `${matterId}:${documentId}` → extraction result
const extractionCache = new Map();

function categorizeDocument(doc) {
  const label    = (doc.document_request?.label || '').toLowerCase();
  const filename = (doc.filename || '').toLowerCase();
  if ((label.includes('will') || label.includes('trust')) && filename.includes('will')) return 'WILL';
  if (label.includes('death') || filename.includes('death')) return 'DEATH_CERT';
  return 'OTHER';
}

const WILL_SYSTEM_PROMPT = `You are a legal document analyst specializing in Massachusetts probate law. Extract the following information from this will and return ONLY a JSON object with no other text:
{
  "willDate": "MM/DD/YYYY or null",
  "testatorName": "full legal name",
  "prNominees": [{"name": "full name", "order": 1, "isPrimary": true, "address": "if stated or null"}],
  "suretiesWaived": true,
  "nominationPowerGranted": true,
  "supervisedAdminDirected": false,
  "devisees": [{"name": "full name or entity name", "description": "what they receive", "isResiduary": true, "isSpecific": true, "isEntity": false, "isPourOverTrust": false}],
  "hasAttestationClause": true,
  "witnesses": ["name1", "name2"],
  "notarized": true,
  "selfProving": true,
  "notes": ["any unusual provisions or flags"]
}`;

const DEATH_CERT_SYSTEM_PROMPT = `Extract the following from this death certificate and return ONLY a JSON object with no other text:
{
  "decedentName": "full legal name as printed",
  "dateOfDeath": "MM/DD/YYYY",
  "dateOfBirth": "MM/DD/YYYY or null",
  "ageAtDeath": null,
  "placeOfDeath": "city, state",
  "domicileAtDeath": "full address",
  "causeOfDeath": "as listed — use exact wording",
  "causeOfDeathPending": false,
  "mannerOfDeath": "natural/accident/homicide/suicide/pending/unknown",
  "isHomicideOrPending": false,
  "certifiedCopy": true,
  "notes": []
}`;

async function dvGet(endpoint) {
  const headers = await getAuthHeaders();
  const response = await axios.get(`${DV_BASE}${endpoint}`, { headers });
  return response.data;
}

function sendWarnings(res, warnings) {
  if (warnings.length) {
    const safe = JSON.stringify(warnings).replace(/[^\x20-\x7E]/g, '?');
    res.setHeader('X-Warnings', safe);
  }
}

async function fetchMatterData(id) {
  const [matter, contactsData, assetsData] = await Promise.all([
    dvGet(`/matters/${id}`),
    dvGet(`/matters/${id}/contacts`),
    dvGet(`/matters/${id}/assets`),
  ]);
  return {
    matter,
    contacts: contactsData.contacts || contactsData.results || [],
    assets:   assetsData.assets    || assetsData.results    || [],
  };
}

async function fetchDocuments(id) {
  const data = await dvGet(`/matters/${id}/documents`);
  const docs = data.documents || data.results || [];
  const seen = new Set();
  return docs.map(doc => {
    const key = `${doc.filename}|${doc.size}`;
    const isDuplicate = seen.has(key);
    if (!isDuplicate) seen.add(key);
    return {
      document_id:  doc.document_id,
      filename:     doc.filename,
      type:         categorizeDocument(doc),
      requestLabel: doc.document_request?.label || '',
      isDuplicate,
    };
  });
}

// Parse ?beneficiaries=id1,id2,... → Set or null
function parseBeneficiaries(query) {
  if (!query) return null;
  const ids = String(query).split(',').map(s => s.trim()).filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

// --- DecisionVault proxy endpoints ---

app.get('/api/matters', async (req, res) => {
  try {
    res.json(await dvGet('/matters'));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/matters/:id', async (req, res) => {
  try {
    res.json(await dvGet(`/matters/${req.params.id}`));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/matters/:id/clients', async (req, res) => {
  try {
    res.json(await dvGet(`/matters/${req.params.id}/clients`));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/matters/:id/assets', async (req, res) => {
  try {
    res.json(await dvGet(`/matters/${req.params.id}/assets`));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/api/matters/:id/contacts', async (req, res) => {
  try {
    res.json(await dvGet(`/matters/${req.params.id}/contacts`));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// --- Heir determination endpoint ---
// Returns the contact IDs that are intestate heirs (for checklist pre-checking).
app.get('/api/matters/:id/heirs', async (req, res) => {
  try {
    const { contacts } = await fetchMatterData(req.params.id);
    const { spouse, legalHeirs, warnings } = determineHeirs(contacts, 'admin', null);
    const legalHeirIds = [
      ...(spouse ? [spouse.id] : []),
      ...legalHeirs.map(c => c.id),
    ];
    res.json({ legalHeirIds, warnings });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// --- Document endpoints ---

// GET /api/matters/:id/documents
app.get('/api/matters/:id/documents', async (req, res) => {
  try {
    const data = await dvGet(`/matters/${req.params.id}/documents`);
    const docs = data.documents || data.results || [];

    const seen = new Set();
    let duplicatesFound = 0;

    const processed = docs.map(doc => {
      const key = `${doc.filename}|${doc.size}`;
      const isDuplicate = seen.has(key);
      if (!isDuplicate) seen.add(key);
      else duplicatesFound++;

      return {
        document_id:  doc.document_id,
        filename:     doc.filename,
        size:         doc.size,
        type:         categorizeDocument(doc),
        requestLabel: doc.document_request?.label || '',
        uploadedAt:   doc.uploaded_at,
        isDuplicate,
      };
    });

    const nonDup = processed.filter(d => !d.isDuplicate);
    res.json({
      documents: processed,
      summary: {
        hasWill:            nonDup.some(d => d.type === 'WILL'),
        hasDeathCertificate: nonDup.some(d => d.type === 'DEATH_CERT'),
        duplicatesFound,
      },
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// POST /api/matters/:id/documents/:documentId/extract
app.post('/api/matters/:id/documents/:documentId/extract', async (req, res) => {
  const { id: matterId, documentId } = req.params;
  const forceRefresh = req.body?.forceRefresh === true;
  const cacheKey = `${matterId}:${documentId}`;

  if (!forceRefresh && extractionCache.has(cacheKey)) {
    return res.json({ ...extractionCache.get(cacheKey), cached: true });
  }

  try {
    // Fetch fresh document list to get a non-expired download URL
    const docsData = await dvGet(`/matters/${matterId}/documents`);
    const docs = docsData.documents || [];
    const doc = docs.find(d => d.document_id === documentId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const docType = categorizeDocument(doc);
    if (docType === 'OTHER') {
      return res.status(400).json({ error: 'Extraction not available for this document type' });
    }

    if (!AI_ENABLED) {
      return res.json({ enabled: false, message: 'AI extraction is not enabled on this installation.' });
    }

    // Download the file (needed for both modes)
    const fileRes  = await axios.get(doc.download_url, { responseType: 'arraybuffer', timeout: 30000 });
    const fileBytes = Buffer.from(fileRes.data);
    const base64   = fileBytes.toString('base64');

    const filename  = (doc.filename || '').toLowerCase();
    const isPDF     = filename.endsWith('.pdf');
    const isJPG     = filename.endsWith('.jpg') || filename.endsWith('.jpeg');
    const isPNG     = filename.endsWith('.png');
    const mediaType = isPDF ? 'application/pdf'
                    : isJPG ? 'image/jpeg'
                    : isPNG ? 'image/png'
                    : 'image/jpeg';

    const extractionPrompt = docType === 'WILL' ? WILL_SYSTEM_PROMPT : DEATH_CERT_SYSTEM_PROMPT;

    // Browser mode: return raw content to the browser for client-side Claude call
    if (AI_MODE === 'browser') {
      return res.json({
        enabled:          true,
        mode:             'browser',
        documentBase64:   base64,
        mediaType,
        extractionPrompt,
        documentType:     docType,
        filename:         doc.filename,
      });
    }

    // API mode: call Claude server-side
    const contentBlock = isPDF ? {
      type:   'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64 },
    } : {
      type:   'image',
      source: { type: 'base64', media_type: mediaType, data: base64 },
    };

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     extractionPrompt,
      messages:   [{ role: 'user', content: [contentBlock, { type: 'text', text: 'Extract the required information and return only the JSON object.' }] }],
    });

    const text = message.content[0]?.text || '';
    let extracted;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      extracted = m ? JSON.parse(m[0]) : JSON.parse(text);
    } catch {
      return res.status(500).json({ error: 'Failed to parse extraction result', raw: text.slice(0, 500) });
    }

    const result = { type: docType, filename: doc.filename, extracted, cached: false };
    extractionCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// DELETE /api/matters/:id/documents/:documentId/extract  — clear cache for one doc
app.delete('/api/matters/:id/documents/:documentId/extract', (req, res) => {
  extractionCache.delete(`${req.params.id}:${req.params.documentId}`);
  res.json({ cleared: true });
});

// --- Form generation endpoints ---

const FORM_IDS = ['pc11', 'pc15', 'pc31a', 'pc31b', 'pc35', 'pc91', 'pc92'];

for (const formId of FORM_IDS) {
  app.get(`/api/matters/:id/generate-${formId}`, async (req, res) => {
    try {
      const petitionType         = req.query.type === 'probate' ? 'probate' : 'admin';
      const selectedBeneficiaryIds = parseBeneficiaries(req.query.beneficiaries);
      const { matter, contacts, assets } = await fetchMatterData(req.params.id);
      const { filename, outPath, warnings } = await saveForm(
        formId, matter, contacts, assets, { petitionType, selectedBeneficiaryIds }
      );
      sendWarnings(res, warnings);
      res.download(outPath, filename);
    } catch (err) {
      res.status(err.response?.status || 500).json({ error: err.message });
    }
  });
}

// --- Package generation endpoint ---
app.get('/api/matters/:id/generate-package', async (req, res) => {
  try {
    const petitionType         = req.query.type === 'probate' ? 'probate' : 'admin';
    const selectedBeneficiaryIds = parseBeneficiaries(req.query.beneficiaries);
    const { matter, contacts, assets } = await fetchMatterData(req.params.id);
    const { filename, outPath, warnings } = await savePackage(
      matter, contacts, assets, { petitionType, selectedBeneficiaryIds }
    );
    sendWarnings(res, warnings);
    res.download(outPath, filename);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// --- Massachusetts routes ---

// Compute the required/conditional form list from proceeding type + toggle answers.
// Mirrors the client-side computeMaFormSet() in app.js — both must stay in sync.
function computeMaFormSetServer(proceedingType, toggleAnswers = {}) {
  const set = MA_FORM_SETS[proceedingType];
  if (!set) return { required: [], mayBeNeeded: [] };

  const required    = new Set(set.always || []);
  const mayBeNeeded = new Set();

  for (const f of (set.requiredIfAppointingPR || [])) required.add(f);

  if (set.requiredUnlessAllAssent) {
    const allAssent  = toggleAnswers.allAssent  === true;
    const noMilitary = toggleAnswers.militaryService === false;
    if (!allAssent && !noMilitary) {
      for (const f of set.requiredUnlessAllAssent) required.add(f);
    }
  }

  for (const [form, condKey] of Object.entries(set.conditional || {})) {
    const result = evalMaConditionServer(condKey, toggleAnswers, proceedingType);
    if (result === true)  required.add(form);
    else if (result === null) mayBeNeeded.add(form);
  }

  return {
    required:    [...required],
    mayBeNeeded: [...mayBeNeeded].filter(f => !required.has(f)),
  };
}

function evalMaConditionServer(condKey, toggleAnswers, proceedingType) {
  switch (condKey) {
    case 'domicileMismatch':
      if (toggleAnswers.domicileMatches === false) return true;
      if (toggleAnswers.domicileMatches === true)  return false;
      return null;
    case 'causeOfDeathPending':
      if (toggleAnswers.causeOfDeathPending === true)  return true;
      if (toggleAnswers.causeOfDeathPending === false) return false;
      return null;
    case 'renunciationOrNominationOrWaiver':
      return true;
    case 'postAllowance':
      return null;
    case 'noAttestationClause':
      if (toggleAnswers.noAttestationClause === true)  return true;
      if (toggleAnswers.noAttestationClause === false) return false;
      return null;
    case 'attorneyAppearing':
      return true;
    case 'testate':
      if (proceedingType === 'lateAndLimited') {
        if (toggleAnswers.hasWill === true)  return true;
        if (toggleAnswers.hasWill === false) return false;
        return null;
      }
      return proceedingType.includes('Testate') ? true : false;
    default:
      return null;
  }
}

// GET /api/ma/matter/:matterId/analysis
app.get('/api/ma/matter/:matterId/analysis', async (req, res) => {
  try {
    const { matter, contacts, assets } = await fetchMatterData(req.params.matterId);
    const maHeirs = computeMassachusettsHeirs(contacts, assets, matter);

    const dec    = maHeirs.decedent;
    const addrs  = dec?.addresses?.[0] || dec?.address1 || {};
    const domicile = [addrs.city, addrs.state].filter(Boolean).join(', ') || null;

    const totalEstateValue = assets.reduce((s, a) => s + parseFloat(a.net_value || 0), 0);
    const estateDisplay    = totalEstateValue > 0
      ? totalEstateValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : null;

    const matterData = {
      name:                      matter.name,
      decedentName:              dec?.full_name || matter.name,
      dateOfDeath:               maHeirs.dateOfDeath,
      daysSinceDeath:            maHeirs.daysSinceDeath,
      domicile,
      totalEstateValue:          estateDisplay,
      hasRealEstate:             maHeirs.hasRealEstate,
      totalPersonalPropertyValue: maHeirs.totalPersonalPropertyValue,
      voluntaryEligible:         maHeirs.voluntaryEligible,
      voluntaryEligibilityIssues: maHeirs.voluntaryEligibilityIssues,
    };

    // Auto-answer toggles we can derive from data
    const autoAnsweredToggles = {};
    if (maHeirs.daysSinceDeath !== null) {
      autoAnsweredToggles.thirtyDaysSinceDeath = maHeirs.daysSinceDeath >= 30;
    }
    if (maHeirs.hasRealEstate === true) {
      autoAnsweredToggles.allPersonalProperty = false;
    } else if (maHeirs.hasRealEstate === false && assets.length > 0) {
      autoAnsweredToggles.allPersonalProperty = true;
    }
    if (assets.length > 0) {
      autoAnsweredToggles.under25k = maHeirs.totalPersonalPropertyValue <= 25000;
    }

    // Pre-compute MPC 455 defaults for the suggested proceeding type
    const mpc455Defaults = computePRPriority(
      contacts,
      matter,
      {
        hasWill: ['informalTestate', 'formalTestate', 'lateAndLimited'].includes(maHeirs.suggestedProceedingType),
        bondWithSureties: false,
        suretyWaived: false,
        willAllowsNomination: false,
      }
    );

    res.json({
      matterData,
      heirs: maHeirs,
      autoAnsweredToggles,
      suggestedProceedingType: maHeirs.suggestedProceedingType,
      mpc455Defaults,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// POST /api/ma/matter/:matterId/generate-form
app.post('/api/ma/matter/:matterId/generate-form', async (req, res) => {
  try {
    const { formId, toggleAnswers = {}, partyOverride = null, witnessOverride = null } = req.body || {};
    if (!formId) return res.status(400).json({ error: 'formId is required' });
    if (COURT_ISSUED_FORMS.has(formId)) {
      return res.status(400).json({ error: `${formId} is court-issued and cannot be generated here.` });
    }

    const filler = MA_FILLERS[formId];
    if (!filler) return res.status(404).json({ error: `No filler implemented for ${formId}` });

    const { matter, contacts, assets } = await fetchMatterData(req.params.matterId);

    // MPC-455 and MPC-480 accept extra context parameters
    const extra = formId === 'MPC-455' ? partyOverride
                : formId === 'MPC-480' ? witnessOverride
                : undefined;

    const { bytes, warnings } = extra !== undefined
      ? await filler(matter, contacts, assets, toggleAnswers, extra)
      : await filler(matter, contacts, assets, toggleAnswers);

    sendWarnings(res, warnings || []);
    const decName = (matter.name || 'estate').replace(/[^a-z0-9]/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${formId}-${decName}.pdf"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// POST /api/ma/matter/:matterId/generate-package
app.post('/api/ma/matter/:matterId/generate-package', async (req, res) => {
  try {
    const { proceedingType = 'informalIntestate', toggleAnswers = {}, excludeForms = [] } = req.body || {};

    const set = MA_FORM_SETS[proceedingType];
    if (!set) return res.status(400).json({ error: `Unknown proceeding type: ${proceedingType}` });

    const { required } = computeMaFormSetServer(proceedingType, toggleAnswers);
    const { matter, contacts, assets } = await fetchMatterData(req.params.matterId);

    // Derive hasWill from proceedingType so form fillers don't need to inspect it themselves.
    // Client-supplied hasWill takes precedence if explicitly set.
    const enrichedToggles = {
      hasWill:    proceedingType.toLowerCase().includes('testate'),
      willDate:   '',
      isAmended:  false,
      ...toggleAnswers,
    };

    const excluded = new Set([...COURT_ISSUED_FORMS, ...excludeForms]);
    const toGenerate = required.filter(f => !excluded.has(f) && MA_FILLERS[f]);

    const allWarnings = [];
    if (set.warning) allWarnings.push(set.warning);
    if (required.some(f => excluded.has(f) && !COURT_ISSUED_FORMS.has(f))) {
      allWarnings.push('Some required forms were excluded from the package at your request.');
    }

    const pdfBuffers = [];
    for (const formId of toGenerate) {
      try {
        if (formId === 'MPC-455' && Array.isArray(enrichedToggles.mpc455Config) && enrichedToggles.mpc455Config.length > 0) {
          // Generate one MPC 455 per person in mpc455Config
          for (const personCfg of enrichedToggles.mpc455Config) {
            const { bytes, warnings: w } = await fillMPC455(matter, contacts, assets, enrichedToggles, personCfg);
            if (w?.length) allWarnings.push(...w.map(x => `MPC-455 (${personCfg.lastName || personCfg.id}): ${x}`));
            pdfBuffers.push(bytes);
          }
        } else {
          const { bytes, warnings } = await MA_FILLERS[formId](matter, contacts, assets, enrichedToggles);
          if (warnings?.length) allWarnings.push(...warnings.map(w => `${formId}: ${w}`));
          pdfBuffers.push(bytes);
        }
      } catch (fillErr) {
        allWarnings.push(`${formId}: generation failed — ${fillErr.message}`);
      }
    }

    if (!pdfBuffers.length) {
      return res.status(500).json({ error: 'No forms could be generated', warnings: allWarnings });
    }

    const merged = await mergePdfs(pdfBuffers);
    sendWarnings(res, allWarnings);

    // Silently persist matter type from form proceedingType if not yet set
    const FORM_TYPE_MAP = {
      informalTestate:   { proceedingType: 'testate',   hasTrust: false },
      formalTestate:     { proceedingType: 'testate',   hasTrust: false },
      informalIntestate: { proceedingType: 'intestate', hasTrust: false },
      formalIntestate:   { proceedingType: 'intestate', hasTrust: false },
      lateAndLimited:    { proceedingType: 'testate',   hasTrust: false },
      voluntary:         { proceedingType: 'intestate', hasTrust: false },
    };
    const mappedType = FORM_TYPE_MAP[proceedingType];
    if (mappedType) {
      try {
        const aData = loadAdminData();
        const aRec  = getOrInit(aData, req.params.matterId);
        if (!aRec.savedMatterType) {
          Object.assign(aRec.matterTypeOverrides, mappedType);
          aRec.savedMatterType = { ...mappedType, state: 'MA', isAncillary: false,
            savedAt: new Date().toISOString(), savedBy: 'auto:form_generation' };
          saveAdminData(aData);
        }
      } catch {}
    }

    const decName = (matter.name || 'estate').replace(/[^a-z0-9]/gi, '-');
    logAuditEvent(req, 'FORMS_GENERATED', req.params.matterId, matter.name,
      `Generated MA ${proceedingType} package`).catch(() => {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="MA-package-${decName}.pdf"`);
    res.send(Buffer.from(merged));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── Estate Administration Module ─────────────────────────────────────────────

const fsSync = require('fs');
const { calculateDeadlines }     = require('./admin/deadlineCalculator');
const { TASK_PHASES, getAllTasks, STAGE_TASK_MAPPING, PLANNING_STAGE_IDS, ADMIN_STAGE_IDS } = require('./admin/taskDefinitions');
const { LETTER_TEMPLATES }       = require('./admin/letterTemplates');
const { deriveMatterConditions } = require('./admin/matterConditions');
const { detectMatterType, categorizeMatter } = require('./admin/detectMatterType');
const { runDeadlineAlertAgent, detectMatterState } = require('./agents/deadlineAlertAgent');
const { runDocumentScannerAgent } = require('./agents/documentScannerAgent');
const { identifyContacts }       = require('./forms/common');

const ADMIN_FILE       = PATHS.ADMIN_FILE;
const AI_SETTINGS_FILE = PATHS.AI_SETTINGS_FILE;
const FLAGS_FILE       = PATHS.FLAGS_FILE;
const SCAN_HISTORY_FILE = PATHS.SCAN_HISTORY_FILE;

const AI_SETTINGS_DEFAULTS = {
  AI_DEADLINE_ALERTS:  true,
  AI_DOCUMENT_SCANNER: true,
  AI_EXTRACTION:       false,
};

function loadAiSettings() {
  try { return { ...AI_SETTINGS_DEFAULTS, ...JSON.parse(fsSync.readFileSync(AI_SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...AI_SETTINGS_DEFAULTS }; }
}
function saveAiSettings(settings) {
  fsSync.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fsSync.writeFileSync(AI_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function loadFlags() {
  try { return JSON.parse(fsSync.readFileSync(FLAGS_FILE, 'utf8')); }
  catch { return []; }
}
function saveFlags(flags) {
  fsSync.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fsSync.writeFileSync(FLAGS_FILE, JSON.stringify(flags, null, 2));
}

function loadScanHistory() {
  try { return JSON.parse(fsSync.readFileSync(SCAN_HISTORY_FILE, 'utf8')); }
  catch { return null; }
}

function loadAdminData() {
  try { return JSON.parse(fsSync.readFileSync(ADMIN_FILE, 'utf8')); }
  catch { return {}; }
}
function saveAdminData(data) {
  fsSync.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fsSync.writeFileSync(ADMIN_FILE, JSON.stringify(data, null, 2));
}
const STAGE_NORMALIZE = {
  'INTAKE':          'PETITION_PREP',
  'PETITION PREP':   'PETITION_PREP',
  'IN ADMINISTRATION': 'IN_ADMINISTRATION',
  'CLOSING PREP':    'CLOSING_PREP',
};
function normalizeStage(s) {
  if (!s) return 'PETITION_PREP';
  if (PLANNING_STAGE_IDS.has(s)) return s; // preserve planning stage IDs
  return STAGE_NORMALIZE[s] || s;
}

function getOrInit(data, matterId) {
  if (!data[matterId]) {
    data[matterId] = {
      stage: 'PETITION_PREP',
      keyDates: {
        dateOfDeath: null, appointmentDate: null, publicationDate: null,
        firstPublicationDate: null, nextHearingDate: null, nextHearingDescription: null,
      },
      tasks: {}, taskAssignments: {}, staff: [], customNotes: '', matterTypeOverrides: {},
    };
  }
  // Migrate old records
  const rec = data[matterId];
  rec.stage = normalizeStage(rec.stage);
  if (!rec.keyDates) rec.keyDates = {};
  if (!rec.taskAssignments) rec.taskAssignments = {};
  if (!rec.staff) rec.staff = [];
  if (rec.customNotes === undefined) rec.customNotes = rec.notes || '';
  if (!rec.matterTypeOverrides) rec.matterTypeOverrides = {};
  // Migrate boolean task statuses → string ('completed') or absent (pending)
  for (const [k, v] of Object.entries(rec.tasks || {})) {
    if (v === true) rec.tasks[k] = 'completed';
    else if (v === false) delete rec.tasks[k];
  }
  return rec;
}

const ORDERED_ADMIN_STAGES = ['PETITION_PREP','FILED','APPOINTED','IN_ADMINISTRATION','CLOSING_PREP','CLOSED'];
const STAGE_LABELS = {
  PETITION_PREP: 'Petition Prep', FILED: 'Filed', APPOINTED: 'Appointed',
  IN_ADMINISTRATION: 'In Administration', CLOSING_PREP: 'Closing Prep', CLOSED: 'Closed',
};

// Handles string statuses AND audit-trail objects { status, ... }
function getTaskStatus(tasks, taskId) {
  const v = tasks[taskId];
  if (!v) return 'pending';
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && v.status) return v.status;
  return 'pending';
}

// Auto-resolve flags that contradict confirmed matter type or stage
function reEvalFlagsForMatter(matterId, rec, flags, detectedType) {
  const proceedingType = detectedType?.proceedingType;
  const stage = rec.stage;
  const earlyStages = ['PETITION_PREP', 'FILED'];
  const now = new Date().toISOString();
  for (const flag of flags) {
    if (flag.matterId !== matterId || flag.resolvedAt) continue;
    let note = null;
    if (flag.type === 'MISSING_WILL_OR_TRUST' && proceedingType === 'intestate')
      note = 'Auto-resolved: matter confirmed as intestate administration';
    if (flag.type === 'MISSING_APPOINTMENT_DATE' && earlyStages.includes(stage))
      note = 'Auto-resolved: appointment date not expected at current stage';
    if (note) { flag.resolvedAt = now; flag.resolveNote = note; }
  }
}

// ── DV matters cache (5-minute TTL) ─────────────────────────────────────────
let _dvMattersCache = null;
let _dvMattersCacheTime = 0;
const DV_CACHE_TTL_MS = 5 * 60 * 1000;

async function getCachedMatters(force = false) {
  if (!force && _dvMattersCache && Date.now() - _dvMattersCacheTime < DV_CACHE_TTL_MS) {
    return _dvMattersCache;
  }
  const data = await dvGet('/matters');
  _dvMattersCache = data.results || data || [];
  _dvMattersCacheTime = Date.now();
  return _dvMattersCache;
}

// ── Alerts cache (1-hour TTL) ────────────────────────────────────────────
let _alertsCache = null;
let _alertsCacheTime = 0;
const ALERTS_CACHE_TTL_MS = 60 * 60 * 1000;

async function getCachedAlerts(force = false) {
  if (!force && _alertsCache && Date.now() - _alertsCacheTime < ALERTS_CACHE_TTL_MS) {
    return _alertsCache;
  }
  const matters   = await getCachedMatters();
  const adminData = loadAdminData();
  _alertsCache     = await runDeadlineAlertAgent(matters, adminData);
  _alertsCacheTime = Date.now();
  return _alertsCache;
}

// ── Scanner cache (no in-memory cache; scan history read from disk) ──────────
async function runAndSaveScan() {
  const matters   = await getCachedMatters();
  const adminData = loadAdminData();
  return runDocumentScannerAgent(matters, adminData);
}

// GET /api/admin/matter/:matterId — load admin record
app.get('/api/admin/matter/:matterId', (req, res) => {
  const data = loadAdminData();
  res.json(getOrInit(data, req.params.matterId));
});

// POST /api/admin/matter/:matterId/stage — update stage
app.post('/api/admin/matter/:matterId/stage', (req, res) => {
  const data = loadAdminData();
  const rec  = getOrInit(data, req.params.matterId);
  const oldStage = rec.stage;
  const newStage = req.body.stage;
  rec.stage = newStage;
  saveAdminData(data);
  logAuditEvent(req, 'STAGE_CHANGED', req.params.matterId, null,
    `Stage changed from ${oldStage} to ${newStage}`, oldStage, newStage).catch(() => {});
  res.json({ ok: true });
});

// POST /api/admin/matter/:matterId/dates — set / merge key dates
app.post('/api/admin/matter/:matterId/dates', (req, res) => {
  const data = loadAdminData();
  const rec  = getOrInit(data, req.params.matterId);
  Object.assign(rec.keyDates, req.body);
  saveAdminData(data);
  res.json({ ok: true });
});

// POST /api/admin/matter/:matterId/task/:taskId — set task status
app.post('/api/admin/matter/:matterId/task/:taskId', (req, res) => {
  const { matterId, taskId } = req.params;
  const data = loadAdminData();
  const rec  = getOrInit(data, matterId);
  const prevStatus = rec.tasks[taskId] || 'pending';
  let status = req.body.status;
  if (!status) status = req.body.completed ? 'completed' : 'pending';
  if (status === 'pending') delete rec.tasks[taskId];
  else rec.tasks[taskId] = status;
  saveAdminData(data);
  logAuditEvent(req, 'TASK_UPDATED', matterId, null,
    `Task ${taskId}: ${prevStatus} → ${status}`, prevStatus, status).catch(() => {});
  res.json({ ok: true });
});

// GET /api/admin/matter/:matterId/deadlines — calculate deadlines from stored key dates
app.get('/api/admin/matter/:matterId/deadlines', (req, res) => {
  const data    = loadAdminData();
  const rec     = getOrInit(data, req.params.matterId);
  const state   = req.query.state || 'MA';
  const hasTrust = req.query.hasTrust === 'true';
  res.json(calculateDeadlines(rec.keyDates, state, { hasTrust }));
});

// GET /api/admin/matter/:matterId/type — detect matter type from DV + stored overrides
app.get('/api/admin/matter/:matterId/type', async (req, res) => {
  try {
    const [{ matter, contacts, assets }, documents] = await Promise.all([
      fetchMatterData(req.params.matterId),
      fetchDocuments(req.params.matterId),
    ]);
    const adminData = loadAdminData();
    const overrides = adminData[req.params.matterId]?.matterTypeOverrides || {};
    res.json(detectMatterType(matter, contacts, assets, overrides, documents));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// POST /api/admin/matter/:matterId/type — save overrides with confirmation when savedMatterType differs
app.post('/api/admin/matter/:matterId/type', async (req, res) => {
  try {
    const [{ matter, contacts, assets }, documents] = await Promise.all([
      fetchMatterData(req.params.matterId),
      fetchDocuments(req.params.matterId),
    ]);
    const adminData = loadAdminData();
    const rec = getOrInit(adminData, req.params.matterId);
    if (!rec.matterTypeOverrides) rec.matterTypeOverrides = {};

    const isTestingMode = req.body._testingMode;
    const source        = req.body._source || 'manual';
    const changes       = { ...req.body };
    delete changes._testingMode; delete changes._source;

    if (changes._clearOverrides) {
      rec.matterTypeOverrides = {};
      rec.pendingMatterTypeChange = null;
      saveAdminData(adminData);
      return res.json(detectMatterType(matter, contacts, assets, {}, documents));
    }
    delete changes._clearOverrides;

    const existing = rec.savedMatterType;
    if (existing && !isTestingMode) {
      const typeChanged = (
        (changes.proceedingType !== undefined && changes.proceedingType !== existing.proceedingType) ||
        (changes.hasTrust       !== undefined && changes.hasTrust       !== existing.hasTrust)
      );
      if (typeChanged) {
        rec.pendingMatterTypeChange = { overrides: changes, proposedAt: new Date().toISOString(), source };
        saveAdminData(adminData);
        function typeLabel(pt, ht) {
          if (ht && pt === null)          return 'Trust Administration';
          if (ht && pt === 'testate')     return 'Probate + Trust';
          if (pt === 'testate')           return 'Testate Probate';
          if (pt === 'intestate')         return 'Intestate Probate';
          return 'Unknown';
        }
        const propPT = changes.proceedingType !== undefined ? changes.proceedingType : existing.proceedingType;
        const propHT = changes.hasTrust       !== undefined ? changes.hasTrust       : existing.hasTrust;
        return res.json({
          requiresConfirmation: true,
          currentDisplay:  typeLabel(existing.proceedingType, existing.hasTrust),
          proposedDisplay: typeLabel(propPT, propHT),
          currentType:  existing,
          proposedType: { ...existing, ...changes },
          message: `Change matter type from "${typeLabel(existing.proceedingType, existing.hasTrust)}" to "${typeLabel(propPT, propHT)}"?`,
        });
      }
    }

    Object.assign(rec.matterTypeOverrides, changes);
    for (const [k, v] of Object.entries(rec.matterTypeOverrides)) {
      if (v === undefined) delete rec.matterTypeOverrides[k];
    }
    const detectedType = detectMatterType(matter, contacts, assets, rec.matterTypeOverrides, documents);
    rec.savedMatterType = {
      state: detectedType.state, proceedingType: detectedType.proceedingType,
      hasTrust: detectedType.hasTrust, isAncillary: detectedType.isAncillary,
      savedAt: new Date().toISOString(), savedBy: source,
    };
    rec.pendingMatterTypeChange = null;
    saveAdminData(adminData);
    res.json(detectedType);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// POST /api/admin/matter/:matterId/type/confirm — apply or reject a pending type change
app.post('/api/admin/matter/:matterId/type/confirm', async (req, res) => {
  try {
    const adminData = loadAdminData();
    const rec = getOrInit(adminData, req.params.matterId);
    const [{ matter, contacts, assets }, documents] = await Promise.all([
      fetchMatterData(req.params.matterId),
      fetchDocuments(req.params.matterId),
    ]);

    if (!req.body.confirmed) {
      rec.pendingMatterTypeChange = null;
      saveAdminData(adminData);
      return res.json(detectMatterType(matter, contacts, assets, rec.matterTypeOverrides || {}, documents));
    }

    const pending = rec.pendingMatterTypeChange;
    if (!pending) return res.status(400).json({ error: 'No pending matter type change' });

    if (!rec.matterTypeOverrides) rec.matterTypeOverrides = {};
    Object.assign(rec.matterTypeOverrides, pending.overrides);
    for (const [k, v] of Object.entries(rec.matterTypeOverrides)) {
      if (v === undefined) delete rec.matterTypeOverrides[k];
    }
    const detectedType = detectMatterType(matter, contacts, assets, rec.matterTypeOverrides, documents);
    rec.savedMatterType = {
      state: detectedType.state, proceedingType: detectedType.proceedingType,
      hasTrust: detectedType.hasTrust, isAncillary: detectedType.isAncillary,
      savedAt: new Date().toISOString(), savedBy: pending.source || 'manual',
    };
    rec.pendingMatterTypeChange = null;
    saveAdminData(adminData);

    logAuditEvent(req, 'MATTER_TYPE_CHANGED', req.params.matterId, null,
      `Matter type confirmed: ${JSON.stringify(detectedType.proceedingType)}`).catch(() => {});

    // Auto-resolve contradicted flags
    try {
      const flags = loadFlags();
      reEvalFlagsForMatter(req.params.matterId, rec, flags, detectedType);
      saveFlags(flags);
    } catch {}

    res.json(detectedType);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// GET /api/admin/matter/:matterId/conditions — derive matter conditions from DV data
app.get('/api/admin/matter/:matterId/conditions', async (req, res) => {
  try {
    const { matter, contacts, assets } = await fetchMatterData(req.params.matterId);
    res.json(deriveMatterConditions(matter, contacts, assets));
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// GET /api/admin/matter/:matterId/tasks?state=MA — filtered task phases for this matter
app.get('/api/admin/matter/:matterId/tasks', async (req, res) => {
  try {
    const state = (req.query.state || 'MA').toUpperCase();
    const [{ matter, contacts, assets }, documents] = await Promise.all([
      fetchMatterData(req.params.matterId),
      fetchDocuments(req.params.matterId),
    ]);
    const conditions = deriveMatterConditions(matter, contacts, assets);

    const adminData = loadAdminData();
    const overrides = adminData[req.params.matterId]?.matterTypeOverrides || {};
    const matterType = detectMatterType(matter, contacts, assets, overrides, documents);

    // Sync matterType overrides back into conditions so task condition filters are consistent
    if (overrides.hasTrust !== undefined) conditions.hasTrust = matterType.hasTrust;
    if (overrides.proceedingType !== undefined) conditions.isTestate = matterType.proceedingType === 'testate';

    function taskMatchesMatterType(task) {
      const pts = task.proceedingTypes;
      if (!pts || pts.length === 0) return true;
      const { proceedingType, hasTrust } = matterType;
      const isProbate = proceedingType === 'testate' || proceedingType === 'intestate';
      // trust and probate_and_trust tasks both appear whenever hasTrust is true,
      // regardless of proceedingType (trust-only = hasTrust && proceedingType === null)
      return pts.some(pt => {
        if (pt === 'trust')             return hasTrust;
        if (pt === 'probate')           return isProbate;
        if (pt === 'probate_and_trust') return hasTrust;
        if (pt === 'testate')           return proceedingType === 'testate';
        if (pt === 'intestate')         return proceedingType === 'intestate';
        return false;
      });
    }

    const filteredPhases = TASK_PHASES
      .map(phase => ({
        ...phase,
        tasks: phase.tasks.filter(task =>
          task.states.includes(state) &&
          task.conditions.every(cond => conditions[cond]) &&
          taskMatchesMatterType(task)
        ),
      }))
      .filter(phase => phase.tasks.length > 0);

    res.json({ phases: filteredPhases, conditions, matterType });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// GET /api/admin/matter/:matterId/tasks/staged — tasks grouped by Kanban stage
app.get('/api/admin/matter/:matterId/tasks/staged', async (req, res) => {
  try {
    const state = (req.query.state || 'MA').toUpperCase();
    const [{ matter, contacts, assets }, documents] = await Promise.all([
      fetchMatterData(req.params.matterId),
      fetchDocuments(req.params.matterId),
    ]);
    const conditions = deriveMatterConditions(matter, contacts, assets);
    const adminData  = loadAdminData();
    const rec        = getOrInit(adminData, req.params.matterId);
    const overrides  = rec.matterTypeOverrides || {};
    const matterType = detectMatterType(matter, contacts, assets, overrides, documents);
    if (overrides.hasTrust !== undefined)     conditions.hasTrust   = matterType.hasTrust;
    if (overrides.proceedingType !== undefined) conditions.isTestate = matterType.proceedingType === 'testate';

    function taskMatchesMatterType(task) {
      const pts = task.proceedingTypes;
      if (!pts || pts.length === 0) return true;
      const { proceedingType, hasTrust } = matterType;
      const isProbate = proceedingType === 'testate' || proceedingType === 'intestate';
      return pts.some(pt => {
        if (pt === 'trust')             return hasTrust;
        if (pt === 'probate')           return isProbate;
        if (pt === 'probate_and_trust') return hasTrust;
        if (pt === 'testate')           return proceedingType === 'testate';
        if (pt === 'intestate')         return proceedingType === 'intestate';
        return false;
      });
    }

    const allTasks = getAllTasks();
    const taskById = Object.fromEntries(allTasks.map(t => [t.id, t]));
    const validIds = new Set(
      allTasks.filter(t =>
        (t.states.length === 0 || t.states.includes(state)) &&
        t.conditions.every(cond => conditions[cond]) &&
        taskMatchesMatterType(t)
      ).map(t => t.id)
    );

    const currentIdx = ORDERED_ADMIN_STAGES.indexOf(rec.stage);
    const stages = ORDERED_ADMIN_STAGES.map((stageId, idx) => {
      const isPast    = idx < currentIdx;
      const isCurrent = idx === currentIdx;
      const isFuture  = idx > currentIdx;
      const stageTasks = (STAGE_TASK_MAPPING[stageId] || [])
        .filter(tid => validIds.has(tid))
        .map(tid => taskById[tid]).filter(Boolean)
        .map(t => {
          const v = rec.tasks[t.id];
          const stored = typeof v === 'string' ? v : (v && v.status) ? v.status : null;
          const status = stored || (isFuture ? 'open' : 'pending');
          return { ...t, status };
        });
      const counts = { completed: 0, warning: 0, na: 0, pending: 0, open: 0 };
      for (const t of stageTasks) counts[t.status] = (counts[t.status] || 0) + 1;
      return { id: stageId, label: STAGE_LABELS[stageId] || stageId, isPast, isCurrent, isFuture,
               tasks: stageTasks, ...counts, totalCount: stageTasks.length };
    });

    res.json({ currentStage: rec.stage, stages, conditions, matterType });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// POST /api/admin/matter/:matterId/flags/reeval — re-evaluate flags for matter
app.post('/api/admin/matter/:matterId/flags/reeval', async (req, res) => {
  try {
    const adminData = loadAdminData();
    const rec = getOrInit(adminData, req.params.matterId);
    const [{ matter, contacts, assets }, documents] = await Promise.all([
      fetchMatterData(req.params.matterId),
      fetchDocuments(req.params.matterId),
    ]);
    const detectedType = detectMatterType(matter, contacts, assets, rec.matterTypeOverrides || {}, documents);
    const flags = loadFlags();
    const openBefore = flags.filter(f => f.matterId === req.params.matterId && !f.resolvedAt).length;
    reEvalFlagsForMatter(req.params.matterId, rec, flags, detectedType);
    saveFlags(flags);
    const openAfter = flags.filter(f => f.matterId === req.params.matterId && !f.resolvedAt).length;
    res.json({ ok: true, resolved: openBefore - openAfter });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// GET /api/admin/matter/:matterId/letters — list available letter templates
app.get('/api/admin/matter/:matterId/letters', (req, res) => {
  res.json(LETTER_TEMPLATES.map(t => ({ id: t.id, label: t.label, description: t.description })));
});

// POST /api/admin/matter/:matterId/letters/:letterId/generate — generate letter text
app.post('/api/admin/matter/:matterId/letters/:letterId/generate', async (req, res) => {
  const { matterId, letterId } = req.params;
  const template = LETTER_TEMPLATES.find(t => t.id === letterId);
  if (!template) return res.status(404).json({ error: 'Letter template not found' });

  try {
    const { matter, contacts } = await fetchMatterData(matterId);
    const { decedent: dec, representative: rep } = identifyContacts(
      contacts, matter.contact_main, matter.contact_representative
    );

    const adminData = loadAdminData()[matterId] || { keyDates: {}, tasks: {} };
    // Attach deadlines so templates can reference them
    adminData.deadlines = calculateDeadlines(adminData.keyDates, req.body.state || 'MA');

    const matterData = {
      decedentName:      dec ? `${dec.first_name || ''} ${dec.last_name || ''}`.trim() : matter.name || '',
      representativeName: rep ? `${rep.first_name || ''} ${rep.last_name || ''}`.trim() : '',
      dateOfDeath:       dec?.date_of_death || '',
      docketNo:          matter.docket_no   || '',
      division:          req.body.division  || '',
      state:             req.body.state     || 'MA',
      toggleAnswers:     req.body.toggleAnswers || {},
    };

    const text = template.generate(adminData, matterData);
    logAuditEvent(req, 'LETTER_GENERATED', matterId, null,
      `Generated letter: ${template.label}`).catch(() => {});
    res.json({ text });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// POST /api/admin/matter/:matterId/advance — full status-rule stage advance
app.post('/api/admin/matter/:matterId/advance', (req, res) => {
  const { fromStage, toStage } = req.body;
  if (!toStage) return res.status(400).json({ error: 'toStage is required' });

  const data    = loadAdminData();
  const rec     = getOrInit(data, req.params.matterId);
  const now     = new Date().toISOString();
  const fromIdx = ORDERED_ADMIN_STAGES.indexOf(fromStage);
  const toIdx   = ORDERED_ADMIN_STAGES.indexOf(toStage);
  let openToNACount = 0;

  // OLD stage: pending → warning, open → na
  if (fromStage && fromIdx >= 0) {
    for (const tid of (STAGE_TASK_MAPPING[fromStage] || [])) {
      const s = getTaskStatus(rec.tasks, tid);
      if (s === 'pending') {
        rec.tasks[tid] = { status: 'warning', previousStatus: 'pending', setDate: now, setBy: 'system:stage_advance',
          notes: `Skipped on advance from ${fromStage} to ${toStage}` };
      } else if (s === 'open') {
        rec.tasks[tid] = { status: 'na', previousStatus: 'open', setDate: now, setBy: 'system:stage_advance',
          notes: `N/A on advance from ${fromStage} to ${toStage}` };
        openToNACount++;
      }
    }
  }

  // NEW stage: all tasks → pending (delete so absent = pending)
  if (toIdx >= 0) {
    for (const tid of (STAGE_TASK_MAPPING[toStage] || [])) delete rec.tasks[tid];
  }

  // Future stages (after toStage): absent/pending tasks → 'open'
  for (let i = toIdx + 1; i < ORDERED_ADMIN_STAGES.length; i++) {
    for (const tid of (STAGE_TASK_MAPPING[ORDERED_ADMIN_STAGES[i]] || [])) {
      if (getTaskStatus(rec.tasks, tid) === 'pending') rec.tasks[tid] = 'open';
    }
  }

  rec.stage = toStage;
  saveAdminData(data);
  res.json({ ok: true, openToNACount });
});

// POST /api/admin/matter/:matterId/hearing — save hearing date + description into keyDates
app.post('/api/admin/matter/:matterId/hearing', (req, res) => {
  const data = loadAdminData();
  const rec  = getOrInit(data, req.params.matterId);
  rec.keyDates.nextHearingDate        = req.body.nextHearingDate        || null;
  rec.keyDates.nextHearingDescription = req.body.nextHearingDescription || null;
  saveAdminData(data);
  res.json({ ok: true });
});

// GET /api/alerts — run deadline alert agent (cached 1 hour)
app.get('/api/alerts', async (req, res) => {
  try {
    res.json(await getCachedAlerts(req.query.refresh === '1'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alerts/history — raw alert history
app.get('/api/alerts/history', (req, res) => {
  const histFile = PATHS.ALERT_HISTORY_FILE;
  try { res.json(JSON.parse(fsSync.readFileSync(histFile, 'utf8'))); }
  catch { res.json({}); }
});

// POST /api/alerts/:alertId/dismiss — dismiss alert for this cycle
app.post('/api/alerts/:alertId/dismiss', (req, res) => {
  const histFile = PATHS.ALERT_HISTORY_FILE;
  try {
    let hist = {};
    try { hist = JSON.parse(fsSync.readFileSync(histFile, 'utf8')); } catch {}
    const alertId = decodeURIComponent(req.params.alertId);
    hist[alertId] = {
      ...(hist[alertId] || { firstAlertDate: new Date().toISOString(), alertCount: 0, severity: 'unknown' }),
      lastAlertDate: new Date().toISOString(),
      dismissed: true,
      dismissedAt: new Date().toISOString(),
    };
    fsSync.writeFileSync(histFile, JSON.stringify(hist, null, 2));
    _alertsCache = null; // bust cache so next load reflects dismissal
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai-settings — load AI feature toggles
app.get('/api/ai-settings', (req, res) => {
  const settings = loadAiSettings();
  res.json({
    ...settings,
    AI_EXTRACTION_AVAILABLE: !!process.env.ANTHROPIC_API_KEY,
  });
});

// POST /api/ai-settings — update a toggle
app.post('/api/ai-settings', (req, res) => {
  const current  = loadAiSettings();
  const updated  = { ...current, ...req.body };
  // Strip unknown keys
  const safe = {};
  for (const k of Object.keys(AI_SETTINGS_DEFAULTS)) safe[k] = !!updated[k];
  saveAiSettings(safe);
  res.json({ ok: true, settings: safe });
});

// GET /api/alerts/run — force-run deadline alert agent (honours AI setting)
app.get('/api/alerts/run', async (req, res) => {
  const settings = loadAiSettings();
  if (!settings.AI_DEADLINE_ALERTS) return res.json({ skipped: true, reason: 'AI_DEADLINE_ALERTS disabled' });
  try {
    res.json(await getCachedAlerts(true));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scan/run — force-run document scanner (honours AI setting)
app.get('/api/scan/run', async (req, res) => {
  const settings = loadAiSettings();
  if (!settings.AI_DOCUMENT_SCANNER) return res.json({ skipped: true, reason: 'AI_DOCUMENT_SCANNER disabled' });
  try {
    res.json(await runAndSaveScan());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scan/history — last scan summary
app.get('/api/scan/history', (req, res) => {
  res.json(loadScanHistory() || { lastRun: null, openFlags: 0, highFlags: 0, docsScanned: 0 });
});

// GET /api/flags — all flags
app.get('/api/flags', (req, res) => {
  const flags = loadFlags();
  res.json({ flags });
});

// POST /api/flags/:id/acknowledge
app.post('/api/flags/:id/acknowledge', (req, res) => {
  const flags = loadFlags();
  const flag  = flags.find(f => f.id === req.params.id);
  if (!flag) return res.status(404).json({ error: 'Flag not found' });
  flag.acknowledgedAt = new Date().toISOString();
  saveFlags(flags);
  res.json({ ok: true });
});

// POST /api/flags/:id/resolve
app.post('/api/flags/:id/resolve', (req, res) => {
  const flags = loadFlags();
  const flag  = flags.find(f => f.id === req.params.id);
  if (!flag) return res.status(404).json({ error: 'Flag not found' });
  flag.resolvedAt = new Date().toISOString();
  saveFlags(flags);
  logAuditEvent(req, 'FLAG_RESOLVED', flag.matterId, flag.matterName,
    `Flag resolved: ${flag.message || flag.type}`).catch(() => {});
  res.json({ ok: true });
});

// GET /api/admin/kanban — return kanban card data for all DV matters
app.get('/api/admin/kanban', async (req, res) => {
  try {
    const matters = await getCachedMatters(req.query.refresh === '1');
    const allTasks = getAllTasks();
    const taskById = Object.fromEntries(allTasks.map(t => [t.id, t]));
    const adminData = loadAdminData();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const cards = matters.map(matter => {
      const rec = adminData[matter.id] ? getOrInit(adminData, matter.id) : {
        stage: 'PETITION_PREP', keyDates: {}, tasks: {}, staff: [], customNotes: '',
      };
      const matterCategory = categorizeMatter(matter.quest_internal_type);
      const isPlanning = matterCategory === 'planning';

      // Resolve stage to a valid stage for this category
      const normalizedStage = normalizeStage(rec.stage);
      let stage;
      if (isPlanning) {
        stage = PLANNING_STAGE_IDS.has(normalizedStage) ? normalizedStage : 'INTAKE';
      } else {
        stage = ADMIN_STAGE_IDS.has(normalizedStage) ? normalizedStage : 'PETITION_PREP';
      }

      const tasks = rec.tasks || {};
      const stageTaskIds = isPlanning ? [] : (STAGE_TASK_MAPPING[stage] || []);
      const pendingTaskCount = stageTaskIds.filter(tid => getTaskStatus(tasks, tid) === 'pending').length;
      const warningTaskCount = stageTaskIds.filter(tid => getTaskStatus(tasks, tid) === 'warning').length;
      const previewTasks = stageTaskIds
        .filter(tid => getTaskStatus(tasks, tid) === 'pending')
        .slice(0, 5)
        .map(tid => taskById[tid]?.label)
        .filter(Boolean);

      const nextHearingDate        = rec.keyDates?.nextHearingDate || null;
      const nextHearingDescription = rec.keyDates?.nextHearingDescription || null;
      const isOverdue = !!(nextHearingDate && new Date(nextHearingDate) < today);

      // Alert counts per card (overdue <0d, urgent 0-14d, upcoming 15-30d)
      const cardAlerts = { overdue: 0, urgent: 0, upcoming: 0 };
      if (!isPlanning) {
        const hasKeyDate = Object.values(rec.keyDates || {}).some(v => v && v !== 'null');
        if (hasKeyDate) {
          const mState  = detectMatterState(matter, rec);
          const hasTrust = !!(rec.matterTypeOverrides?.hasTrust);
          try {
            for (const dl of calculateDeadlines(rec.keyDates, mState, { hasTrust })) {
              if (dl.daysUntil === null) continue;
              if (dl.daysUntil < 0)        cardAlerts.overdue++;
              else if (dl.daysUntil <= 14) cardAlerts.urgent++;
              else if (dl.daysUntil <= 30) cardAlerts.upcoming++;
            }
          } catch {}
          if (nextHearingDate) {
            const hDays = Math.round((new Date(nextHearingDate + 'T00:00:00') - today) / 86400000);
            if (hDays < 0)        cardAlerts.overdue++;
            else if (hDays <= 14) cardAlerts.urgent++;
            else if (hDays <= 30) cardAlerts.upcoming++;
          }
        }
      }

      return {
        matterId:               matter.id,
        name:                   matter.name,
        internalType:           matter.quest_internal_type || '',
        matterCategory,
        stage,
        nextHearingDate,
        nextHearingDescription,
        openTaskCount:          pendingTaskCount,
        pendingTaskCount,
        warningTaskCount,
        previewTasks,
        isOverdue,
        alerts:                 cardAlerts,
        staff:                  rec.staff || [],
        customNotes:            rec.customNotes || '',
      };
    });

    res.json({ cards });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────
app.get('/api/audit-log', requireAuth, requireRole('attorney', 'firm_admin'), (req, res) => {
  const { matterId, userId, action, limit, offset } = req.query;
  const events = getAuditLog({
    matterId, userId, action,
    limit:  parseInt(limit)  || 50,
    offset: parseInt(offset) || 0,
  });
  const total = getAuditLogTotal({ matterId, userId, action });
  res.json({ events, total });
});

app.listen(PORT, () => {
  console.log(`ri-probate-app listening on http://localhost:${PORT}`);
});

// ── Scheduled agents ─────────────────────────────────────────────────────────
const schedule = require('node-schedule');

// Initial alert scan — 5s after startup
setTimeout(async () => {
  const settings = loadAiSettings();
  if (!settings.AI_DEADLINE_ALERTS) return;
  console.log('[AlertAgent] Running initial deadline scan…');
  try { await getCachedAlerts(true); }
  catch (err) { console.error('[AlertAgent] Initial scan error:', err.message); }
}, 5000);

// Initial document scan — 10s after startup
setTimeout(async () => {
  const settings = loadAiSettings();
  if (!settings.AI_DOCUMENT_SCANNER) return;
  console.log('[ScanAgent] Running initial document scan…');
  try { await runAndSaveScan(); }
  catch (err) { console.error('[ScanAgent] Initial scan error:', err.message); }
}, 10000);

// Daily at 8:00 AM — deadline alerts
schedule.scheduleJob('0 8 * * *', async () => {
  const settings = loadAiSettings();
  if (!settings.AI_DEADLINE_ALERTS) return;
  console.log('[AlertAgent] Running scheduled daily deadline scan…');
  try { await getCachedAlerts(true); }
  catch (err) { console.error('[AlertAgent] Scheduled scan error:', err.message); }
});

// Daily at 8:15 AM — document scanner
schedule.scheduleJob('15 8 * * *', async () => {
  const settings = loadAiSettings();
  if (!settings.AI_DOCUMENT_SCANNER) return;
  console.log('[ScanAgent] Running scheduled daily document scan…');
  try { await runAndSaveScan(); }
  catch (err) { console.error('[ScanAgent] Scheduled scan error:', err.message); }
});
