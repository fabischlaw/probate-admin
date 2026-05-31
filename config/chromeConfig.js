'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SYSTEM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/snap/bin/chromium',
];

let _cached = null;

function getChromePath() {
  if (_cached) return _cached;

  // 1. Explicit env var
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    _cached = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log('[Chrome] Using env var:', _cached);
    return _cached;
  }

  // 2. Search Puppeteer cache at runtime
  const cacheDir = process.env.PUPPETEER_CACHE_DIR ||
    '/opt/render/project/.cache/puppeteer';

  if (fs.existsSync(cacheDir)) {
    try {
      const result = execSync(
        `find ${cacheDir} -type f \\( -name "chrome-headless-shell" -o -name "chrome" \\) 2>/dev/null | head -5`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      if (result) {
        const lines = result.split('\n').filter(Boolean);
        const shell  = lines.find(l => l.includes('chrome-headless-shell') && !l.endsWith('.json') && !l.endsWith('.zip'));
        const chrome = lines.find(l => l.endsWith('/chrome') && !l.includes('chrome-headless-shell'));
        _cached = shell || chrome || lines[0];
        console.log('[Chrome] Found in cache:', _cached);
        return _cached;
      }
    } catch (e) {
      console.log('[Chrome] Cache search failed:', e.message);
    }
  }

  // 3. System paths
  for (const p of SYSTEM_PATHS) {
    if (fs.existsSync(p)) {
      console.log('[Chrome] Found system Chrome:', p);
      _cached = p;
      return _cached;
    }
  }

  console.log('[Chrome] No Chrome found - Puppeteer will use default');
  return null;
}

module.exports = { getChromePath };
