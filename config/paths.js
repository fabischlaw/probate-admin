'use strict';

const path = require('path');
const fs   = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');

const PATHS = {
  DATA_DIR,
  USERS_FILE:         path.join(DATA_DIR, 'users.json'),
  AUDIT_FILE:         path.join(DATA_DIR, 'auditLog.json'),
  ADMIN_FILE:         path.join(DATA_DIR, 'administration.json'),
  FLAGS_FILE:         path.join(DATA_DIR, 'flags.json'),
  SCAN_HISTORY_FILE:  path.join(DATA_DIR, 'scanHistory.json'),
  ALERT_HISTORY_FILE: path.join(DATA_DIR, 'alertHistory.json'),
  AI_SETTINGS_FILE:   path.join(DATA_DIR, 'aiSettings.json'),
  ALERT_EMAIL_FILE:   path.join(DATA_DIR, 'lastAlertEmail.txt'),
};

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('[Paths] Created data directory:', DATA_DIR);
  } catch (err) {
    // On Render, DATA_DIR is a mounted disk — it must exist already.
    // If mkdir fails (EACCES or EROFS), the disk is not mounted yet.
    console.error('[Paths] WARNING: cannot create DATA_DIR:', DATA_DIR, '-', err.message);
    console.error('[Paths] If on Render, ensure the disk is mounted at', DATA_DIR);
  }
}

module.exports = PATHS;
