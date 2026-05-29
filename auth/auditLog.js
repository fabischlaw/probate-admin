'use strict';

const fs    = require('fs');
const PATHS = require('../config/paths');

const AUDIT_FILE = PATHS.AUDIT_FILE;

async function logAuditEvent(req, action, matterId, matterName, detail, previousValue, newValue) {
  let log = { events: [] };
  if (fs.existsSync(AUDIT_FILE)) {
    try { log = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); }
    catch { log = { events: [] }; }
  }

  const event = {
    id:            'audit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    timestamp:     new Date().toISOString(),
    userId:        req.session?.user?.id    || 'system',
    userName:      req.session?.user?.name  || 'System',
    userRole:      req.session?.user?.role  || 'system',
    action,
    matterId:      matterId      || null,
    matterName:    matterName    || null,
    detail:        detail        || null,
    previousValue: previousValue || null,
    newValue:      newValue      || null,
    ipAddress:     req.ip        || null,
    userAgent:     req.headers?.['user-agent'] || null,
  };

  log.events.unshift(event);
  if (log.events.length > 10000) log.events = log.events.slice(0, 10000);

  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(log, null, 2));
  return event;
}

function getAuditLog({ matterId, userId, action, limit = 100, offset = 0 } = {}) {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  let log;
  try { log = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); }
  catch { return []; }

  let events = log.events || [];
  if (matterId) events = events.filter(e => e.matterId === matterId);
  if (userId)   events = events.filter(e => e.userId   === userId);
  if (action)   events = events.filter(e => e.action   === action);
  return events.slice(offset, offset + limit);
}

function getAuditLogTotal({ matterId, userId, action } = {}) {
  if (!fs.existsSync(AUDIT_FILE)) return 0;
  let log;
  try { log = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); }
  catch { return 0; }
  let events = log.events || [];
  if (matterId) events = events.filter(e => e.matterId === matterId);
  if (userId)   events = events.filter(e => e.userId   === userId);
  if (action)   events = events.filter(e => e.action   === action);
  return events.length;
}

module.exports = { logAuditEvent, getAuditLog, getAuditLogTotal };
