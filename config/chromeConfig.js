'use strict';

const fs   = require('fs');
const path = require('path');

const SYSTEM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/snap/bin/chromium',
];

function getChromePath() {
  // 1. Explicit env var
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log('[Chrome] Using PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Saved path from build script
  if (fs.existsSync('/tmp/chrome-path.txt')) {
    try {
      const saved = fs.readFileSync('/tmp/chrome-path.txt', 'utf8').trim();
      if (saved && fs.existsSync(saved)) {
        console.log('[Chrome] Using saved path:', saved);
        return saved;
      }
    } catch (_) {}
  }

  // 3. Search Puppeteer cache — headless-shell first, then full chrome
  const cacheDir = process.env.PUPPETEER_CACHE_DIR ||
    '/opt/render/project/.cache/puppeteer';

  if (fs.existsSync(cacheDir)) {
    for (const sub of ['chrome-headless-shell', 'chrome']) {
      const dir = path.join(cacheDir, sub);
      if (!fs.existsSync(dir)) continue;
      try {
        const { execSync } = require('child_process');
        const found = execSync(
          `find ${dir} -type f -executable | head -1`,
          { encoding: 'utf8' }
        ).trim();
        if (found) {
          console.log('[Chrome] Found in cache:', found);
          return found;
        }
      } catch (_) {}
    }
  }

  // 4. System paths
  for (const p of SYSTEM_PATHS) {
    if (fs.existsSync(p)) {
      console.log('[Chrome] Found system Chrome:', p);
      return p;
    }
  }

  console.log('[Chrome] No Chrome found - using Puppeteer default');
  return null;
}

module.exports = { getChromePath };
