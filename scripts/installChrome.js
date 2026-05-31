'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const cacheDir = process.env.PUPPETEER_CACHE_DIR ||
  '/opt/render/project/.cache/puppeteer';

console.log('=== Chrome Install Script ===');
console.log('Cache dir:', cacheDir);

// 1. Run normal Puppeteer install
try {
  execSync('npx puppeteer browsers install chrome-headless-shell', {
    stdio: 'inherit',
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR:              cacheDir,
      PUPPETEER_SKIP_DOWNLOAD:          undefined,
      PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: undefined,
    },
    timeout: 300000,
  });
} catch (e) {
  console.log('Install command failed:', e.message);
}

// 2. Check whether the binary is present
const shellDir = path.join(cacheDir, 'chrome-headless-shell');
let binaryFound = false;

if (fs.existsSync(shellDir)) {
  try {
    const result = execSync(
      `find ${shellDir} -name "chrome-headless-shell" -type f 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim();
    if (result) {
      console.log('Binary found:', result);
      binaryFound = true;
    }
  } catch (_) {}

  // 3. If still missing, look for an unextracted zip and unzip manually
  if (!binaryFound) {
    console.log('Binary not found — looking for zip to extract...');
    try {
      const zipResult = execSync(
        `find ${shellDir} -name "*.zip" 2>/dev/null`,
        { encoding: 'utf8' }
      ).trim();

      if (zipResult) {
        const zipPath   = zipResult.split('\n')[0];
        const extractDir = path.dirname(zipPath);
        console.log('Found zip:', zipPath);
        console.log('Extracting to:', extractDir);

        execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });

        const binary = execSync(
          `find ${shellDir} -name "chrome-headless-shell" -type f 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();

        if (binary) {
          execSync(`chmod +x "${binary}"`);
          console.log('Binary extracted and made executable:', binary);
          binaryFound = true;
        }
      } else {
        console.log('No zip found either — listing cache for diagnosis:');
        const files = execSync(`find ${cacheDir} -type f | head -30`, { encoding: 'utf8' });
        console.log(files || '(empty)');
      }
    } catch (e) {
      console.log('Extraction failed:', e.message);
    }
  }
}

if (binaryFound) {
  console.log('chrome-headless-shell is ready');
} else {
  console.log('WARNING: Could not install Chrome — forms will not work');
}
