'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

console.log('=== Finding Chrome ===');
console.log('Platform:', process.platform);
console.log('Node:', process.version);

const SYSTEM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

// 1. Check system paths first
let foundChrome = null;
for (const p of SYSTEM_PATHS) {
  if (fs.existsSync(p)) {
    foundChrome = p;
    console.log('Found system Chrome at:', p);
    break;
  }
}

// 2. Try `which` if no direct match
if (!foundChrome) {
  try {
    foundChrome = execSync(
      'which chromium || which chromium-browser || which google-chrome',
      { encoding: 'utf8' }
    ).trim().split('\n')[0];
    if (foundChrome) console.log('Found Chrome via which:', foundChrome);
  } catch (_) {}
}

if (foundChrome) {
  fs.writeFileSync('/tmp/chrome-path.txt', foundChrome);
  console.log('Chrome path saved to /tmp/chrome-path.txt');
  process.exit(0);
}

// 3. Fall back to Puppeteer download (chrome-headless-shell, then full chrome)
console.log('No system Chrome found — falling back to Puppeteer download...');

const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/project/.cache/puppeteer';
const spawnEnv = { ...process.env, PUPPETEER_CACHE_DIR: cacheDir, PUPPETEER_SKIP_DOWNLOAD: undefined };

let downloaded = false;
for (const browser of ['chrome-headless-shell', 'chrome']) {
  try {
    console.log(`Trying: npx puppeteer browsers install ${browser}`);
    execSync(`npx puppeteer browsers install ${browser}`, {
      stdio: 'inherit',
      env: spawnEnv,
      timeout: 300000,
    });
    downloaded = true;
    console.log(`${browser} installed successfully`);
    break;
  } catch (e) {
    console.error(`${browser} install failed:`, e.message);
    try {
      const files = execSync(`find ${cacheDir} -type f | head -20`, { encoding: 'utf8' });
      console.log('Cache contents:', files || '(empty)');
    } catch (_) {}
  }
}

if (!downloaded) {
  console.log('WARNING: No Chrome available — form generation will be unavailable at runtime');
}
