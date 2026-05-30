'use strict';

const { execSync } = require('child_process');
const path = require('path');

const cacheDir = process.env.PUPPETEER_CACHE_DIR ||
  '/opt/render/project/.cache/puppeteer';

console.log('[Chrome] Installing to:', cacheDir);
console.log('[Chrome] Puppeteer version:', require('puppeteer/package.json').version);

const puppeteer = require('puppeteer');
const expectedPath = puppeteer.executablePath();
console.log('[Chrome] Expected path after install:', expectedPath);

execSync('npx puppeteer browsers install chrome', {
  stdio: 'inherit',
  env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
});

const fs = require('fs');
if (!fs.existsSync(expectedPath)) {
  console.error('[Chrome] ERROR: Chrome not found at expected path after install:', expectedPath);
  process.exit(1);
}

console.log('[Chrome] Verified — Chrome found at:', expectedPath);
