'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

const cacheDir = process.env.PUPPETEER_CACHE_DIR ||
  '/opt/render/project/.cache/puppeteer';

console.log('=== Chrome Install Script ===');
console.log('Node version:', process.version);
console.log('Platform:', process.platform);
console.log('PUPPETEER_CACHE_DIR:', cacheDir);
console.log('PUPPETEER_SKIP_DOWNLOAD:', process.env.PUPPETEER_SKIP_DOWNLOAD);

try {
  const df = execSync('df -h /opt/render/project', { encoding: 'utf8' });
  console.log('Disk space:', df);
} catch (e) {
  console.log('Could not check disk space');
}

const spawnEnv = { ...process.env, PUPPETEER_CACHE_DIR: cacheDir, PUPPETEER_SKIP_DOWNLOAD: undefined };

function tryInstall(browser) {
  console.log(`\nInstalling ${browser}...`);
  execSync(`npx puppeteer browsers install ${browser}`, {
    stdio: 'inherit',
    env: spawnEnv,
    timeout: 300000,
  });
}

function findBinaries() {
  try {
    const result = execSync(
      `find ${cacheDir} -type f | head -20`,
      { encoding: 'utf8' }
    );
    console.log('All files in cache:\n', result || '(empty)');
  } catch (e) {
    console.log('Could not list cache dir');
  }
}

// Try chrome-headless-shell first (smaller, more reliable on cloud)
let installed = false;
try {
  tryInstall('chrome-headless-shell');
  installed = true;
  console.log('chrome-headless-shell install completed');
} catch (e) {
  console.error('chrome-headless-shell install error:', e.message);
  findBinaries();
}

// Fall back to full chrome if shell failed
if (!installed) {
  try {
    tryInstall('chrome');
    installed = true;
    console.log('chrome install completed');
  } catch (e) {
    console.error('chrome install error:', e.message);
    findBinaries();
  }
}

if (!installed) {
  console.log('WARNING: No Chrome variant installed - form generation will be unavailable');
} else {
  // Verify and report what was found
  const { executablePath } = require('puppeteer');
  const chromePath = executablePath();
  console.log('\nExpected Chrome path:', chromePath);
  if (fs.existsSync(chromePath)) {
    console.log('✓ Chrome binary verified at expected path');
  } else {
    console.log('✗ Chrome binary NOT found at expected path');
    findBinaries();
  }
}
