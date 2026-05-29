'use strict';

const https  = require('https');
const fs     = require('fs');
const crypto = require('crypto');
const path   = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'ma-templates');
const MANIFEST_PATH = path.join(TEMPLATES_DIR, 'manifest.json');

function httpsGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ri-probate-app/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        res.resume();
        return resolve(httpsGet(res.headers.location, redirectsLeft - 1));
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

async function downloadPdf(url) {
  const res = await httpsGet(url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode}`);
  }
  const ct = res.headers['content-type'] || '';
  if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
    res.resume();
    throw new Error(`Unexpected content-type: ${ct}`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end',  () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`No manifest found at ${MANIFEST_PATH}. Run scripts/downloadMaForms.js first.`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  let unchanged = 0;
  let updated   = 0;
  let failed    = 0;

  for (const [formId, entry] of Object.entries(manifest.forms)) {
    if (entry.status !== 'ok') {
      console.log(`SKIP: ${formId} — previous status was "${entry.status}", skipping`);
      continue;
    }

    process.stdout.write(`  Checking ${formId}... `);
    try {
      const buf        = await downloadPdf(entry.sourceUrl);
      const newChecksum = sha256(buf);

      if (newChecksum === entry.checksum) {
        console.log('OK — unchanged');
        unchanged++;
      } else {
        const filePath = path.join(__dirname, '..', entry.filePath);
        fs.writeFileSync(filePath, buf);
        console.log('UPDATED — checksum changed, form may have been revised');
        console.log(`  UPDATED: ${formId} checksum changed — form may have been revised`);

        entry.previousChecksum = entry.checksum;
        entry.checksum         = newChecksum;
        entry.downloadedAt     = new Date().toISOString();
        updated++;
      }
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      console.log(`  FAILED: ${formId} — ${err.message}`);
      failed++;
    }
  }

  manifest.lastChecked = new Date().toISOString();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log(`\nSummary: ${unchanged} unchanged, ${updated} updated, ${failed} failed`);
  console.log(`Manifest updated: ${MANIFEST_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
