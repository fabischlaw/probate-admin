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

console.log('Installing Chrome...');
try {
  execSync('npx puppeteer browsers install chrome', {
    stdio: 'inherit',
    env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir, PUPPETEER_SKIP_DOWNLOAD: undefined },
    timeout: 300000,
  });
  console.log('Chrome install command completed');

  const { executablePath } = require('puppeteer');
  const chromePath = executablePath();
  console.log('Expected Chrome path:', chromePath);

  if (fs.existsSync(chromePath)) {
    console.log('✓ Chrome binary verified at expected path');
  } else {
    console.log('✗ Chrome binary NOT found at expected path');
    console.log('Contents of cache dir:');
    try {
      const ls = execSync(
        `find ${cacheDir} -name "chrome" -o -name "chrome-linux64" 2>/dev/null | head -20`,
        { encoding: 'utf8' }
      );
      console.log(ls || 'No chrome files found');
    } catch (e) {
      console.log('Could not list cache dir');
    }
  }
} catch (e) {
  console.error('Chrome install error:', e.message);
  console.log('WARNING: Chrome not installed - form generation will be unavailable');
}
