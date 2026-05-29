'use strict';

const fs     = require('fs');
const crypto = require('crypto');
const path   = require('path');
const os     = require('os');

const FORMS_URLS    = require('../forms/maFormUrls');
const TEMPLATES_DIR = path.join(__dirname, '..', 'ma-templates');
const MANIFEST_PATH = path.join(TEMPLATES_DIR, 'manifest.json');
const SOURCE_DIR    = path.join(os.homedir(), 'Downloads', 'MA MPC Forms');

// Each entry: first matching pattern wins. Patterns tested against the
// lowercase filename; lookbehind/lookahead prevent partial-number collisions
// (e.g. "550" must not match a file whose name contains "5501").
const PATTERN_MAP = [
  { formId: 'MPC-150', patterns: [/(?<!\d)150(?!\d)/] },
  { formId: 'MPC-160', patterns: [/(?<!\d)160(?!\d)/] },
  { formId: 'MPC-161', patterns: [/(?<!\d)161(?!\d)/] },
  { formId: 'MPC-162', patterns: [/(?<!\d)162(?!\d)/] },
  { formId: 'MPC-163', patterns: [/(?<!\d)163(?!\d)/] },
  { formId: 'MPC-170', patterns: [/(?<!\d)170(?!\d)/] },
  { formId: 'MPC-455', patterns: [/(?<!\d)455(?!\d)/] },
  { formId: 'MPC-470', patterns: [/military/i,         /(?<!\d)470(?!\d)/] },
  { formId: 'MPC-475', patterns: [/(?<!\d)475(?!\d)/] },
  { formId: 'MPC-480', patterns: [/(?<!\d)480(?!\d)/] },
  { formId: 'MPC-485', patterns: [/(?<!\d)485(?!\d)/] },
  { formId: 'MPC-550', patterns: [/(?<!\d)550(?!\d)/] },
  { formId: 'MPC-551', patterns: [/(?<!\d)551(?!\d)/] },
  { formId: 'MPC-560', patterns: [/(?<!\d)560(?!\d)/] },
  { formId: 'MPC-750', patterns: [/(?<!\d)750(?!\d)/] },
  { formId: 'MPC-755', patterns: [/(?<!\d)755(?!\d)/] },
  { formId: 'MPC-757', patterns: [/(?<!\d)757(?!\d)/] },
  { formId: 'MPC-801', patterns: [/(?<!\d)801(?!\d)/] },
  { formId: 'MPC-850', patterns: [/(?<!\d)850(?!\d)/] },
  { formId: 'MPC-851', patterns: [/(?<!\d)851(?!\d)/] },
  { formId: 'MPC-853', patterns: [/(?<!\d)853(?!\d)/] },
  { formId: 'MPC-854', patterns: [/(?<!\d)854(?!\d)/] },
  { formId: 'MPC-855', patterns: [/(?<!\d)855(?!\d)/] },
  { formId: 'MPC-857', patterns: [/(?<!\d)857(?!\d)/] },
];

function matchFormId(filename) {
  for (const { formId, patterns } of PATTERN_MAP) {
    if (patterns.some(p => p.test(filename))) return formId;
  }
  return null;
}

function sha256file(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`Source directory not found: ${SOURCE_DIR}`);
    console.error('Create the folder and place MA MPC PDF files inside it, then re-run.');
    process.exit(1);
  }

  // Load or initialise manifest
  let manifest;
  if (fs.existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } else {
    manifest = { lastChecked: null, forms: {} };
  }
  manifest.lastChecked = new Date().toISOString();

  // Scan source directory for PDFs
  const sourceFiles = fs.readdirSync(SOURCE_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'));

  // Build formId → source path (first match wins; warn on duplicate matches)
  const matched   = new Map();   // formId → full source path
  const unmatched = [];          // filenames that didn't match any form

  for (const filename of sourceFiles) {
    const formId = matchFormId(filename);
    if (!formId) {
      unmatched.push(filename);
      continue;
    }
    if (matched.has(formId)) {
      console.warn(`  WARN: "${filename}" also matches ${formId} — already claimed by "${path.basename(matched.get(formId))}", skipping`);
      continue;
    }
    matched.set(formId, path.join(SOURCE_DIR, filename));
  }

  // Copy matched files → ma-templates/, checksum, update manifest
  let copied = 0;
  for (const [formId, srcPath] of [...matched.entries()].sort()) {
    const destPath = path.join(TEMPLATES_DIR, `${formId}.pdf`);
    const relPath  = path.relative(path.join(__dirname, '..'), destPath);
    fs.copyFileSync(srcPath, destPath);
    const checksum = sha256file(destPath);
    const info     = FORMS_URLS[formId] || {};
    manifest.forms[formId] = {
      checksum,
      downloadedAt: new Date().toISOString(),
      sourceUrl:    info.downloadUrl || null,
      filePath:     relPath,
      status:       'ok',
      error:        null,
    };
    console.log(`  COPIED  ${formId}  ←  ${path.basename(srcPath)}`);
    copied++;
  }

  // Record missing forms in manifest (don't overwrite an existing ok entry)
  const allFormIds = PATTERN_MAP.map(e => e.formId);
  const missing    = allFormIds.filter(id => !matched.has(id));
  for (const id of missing) {
    if (manifest.forms[id]?.status === 'ok') continue; // already present from a prior run
    const info = FORMS_URLS[id] || {};
    manifest.forms[id] = {
      checksum:     null,
      downloadedAt: null,
      sourceUrl:    info.downloadUrl || null,
      filePath:     `ma-templates/${id}.pdf`,
      status:       'missing',
      error:        'Not found in source directory',
    };
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  // Summary
  console.log(`\n${copied} form${copied !== 1 ? 's' : ''} copied to ma-templates/`);

  if (missing.length > 0) {
    console.log(`\nStill missing (${missing.length}):`);
    for (const id of missing) {
      const label = FORMS_URLS[id]?.label || '';
      console.log(`  ${id}${label ? '  —  ' + label : ''}`);
    }
  }

  if (unmatched.length > 0) {
    console.log(`\nFiles with no form match (${unmatched.length}):`);
    for (const f of unmatched) console.log(`  ${f}`);
  }

  console.log('\nManifest saved to ma-templates/manifest.json');
}

main();
