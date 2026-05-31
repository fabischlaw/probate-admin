'use strict';

const fs = require('fs');

const SYSTEM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

function getChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  if (fs.existsSync('/tmp/chrome-path.txt')) {
    try {
      const saved = fs.readFileSync('/tmp/chrome-path.txt', 'utf8').trim();
      if (saved && fs.existsSync(saved)) return saved;
    } catch (_) {}
  }

  for (const p of SYSTEM_PATHS) {
    if (fs.existsSync(p)) return p;
  }

  return null; // let Puppeteer auto-detect from its cache
}

module.exports = { getChromePath };
