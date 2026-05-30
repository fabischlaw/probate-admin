'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('./database');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

async function initDatabase() {
  console.log('[DB] Initializing schema...');
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  await pool.query(schema);
  console.log('[DB] Schema ready');

  await migrateFromJson();
}

async function migrateFromJson() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '../data');

  await migrateUsers(path.join(dataDir, 'users.json'));
  await migrateAdminData(path.join(dataDir, 'administration.json'));
  await migrateFlags(path.join(dataDir, 'flags.json'));
  await migrateAuditLog(path.join(dataDir, 'auditLog.json'));
  await migrateSettings(dataDir);
}

async function migrateUsers(filePath) {
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) > 0) return;
  if (!fs.existsSync(filePath)) return;

  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return; }

  const users = data.users || [];
  if (users.length === 0) return;

  for (const u of users) {
    await pool.query(
      `INSERT INTO users (id, name, email, role, password_hash, created_at, last_login, active, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        u.id,
        u.name,
        u.email,
        u.role,
        u.passwordHash,
        u.createdAt  || new Date().toISOString(),
        u.lastLogin  || null,
        u.active     !== undefined ? u.active : true,
        u.mustChangePassword !== undefined ? u.mustChangePassword : true,
      ]
    );
  }
  console.log(`[DB] Migrated ${users.length} user(s) from JSON`);
}

async function migrateAdminData(filePath) {
  const { rows } = await pool.query('SELECT COUNT(*) FROM matter_admin');
  if (parseInt(rows[0].count) > 0) return;
  if (!fs.existsSync(filePath)) return;

  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return; }

  let adminCount = 0;
  let taskCount  = 0;

  for (const [matterId, rec] of Object.entries(data)) {
    await pool.query(
      `INSERT INTO matter_admin
         (matter_id, stage, key_dates, notes, matter_type_overrides, task_assignments,
          staff, custom_notes, pending_matter_type_change, saved_matter_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (matter_id) DO NOTHING`,
      [
        matterId,
        rec.stage                   || 'PETITION_PREP',
        JSON.stringify(rec.keyDates || {}),
        rec.notes                   || null,
        JSON.stringify(rec.matterTypeOverrides || {}),
        JSON.stringify(rec.taskAssignments     || {}),
        JSON.stringify(rec.staff               || []),
        typeof rec.customNotes === 'string' ? rec.customNotes : '',
        rec.pendingMatterTypeChange ? JSON.stringify(rec.pendingMatterTypeChange) : null,
        rec.savedMatterType ? JSON.stringify(rec.savedMatterType) : null,
      ]
    );
    adminCount++;

    const tasks = rec.tasks || {};
    for (const [taskId, val] of Object.entries(tasks)) {
      let status, previousStatus, setDate, setBy, notes;

      if (typeof val === 'string') {
        status = val;
        previousStatus = null; setDate = null; setBy = null; notes = null;
      } else {
        status         = val.status;
        previousStatus = val.previousStatus || null;
        setDate        = val.setDate        || null;
        setBy          = val.setBy          || null;
        notes          = val.notes          || null;
      }

      await pool.query(
        `INSERT INTO matter_tasks (matter_id, task_id, status, previous_status, set_date, set_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (matter_id, task_id) DO NOTHING`,
        [matterId, taskId, status, previousStatus, setDate, setBy, notes]
      );
      taskCount++;
    }
  }
  console.log(`[DB] Migrated ${adminCount} matter(s) + ${taskCount} task(s) from JSON`);
}

async function migrateFlags(filePath) {
  const { rows } = await pool.query('SELECT COUNT(*) FROM flags');
  if (parseInt(rows[0].count) > 0) return;
  if (!fs.existsSync(filePath)) return;

  let flags;
  try { flags = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return; }

  if (!Array.isArray(flags) || flags.length === 0) return;

  for (const f of flags) {
    await pool.query(
      `INSERT INTO flags (id, matter_id, matter_name, type, severity, message, raised_at, last_seen_at, acknowledged_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        f.id,
        f.matterId,
        f.matterName    || null,
        f.type,
        f.severity,
        f.message,
        f.raisedAt      || new Date().toISOString(),
        f.lastSeenAt    || null,
        f.acknowledgedAt || null,
        f.resolvedAt    || null,
      ]
    );
  }
  console.log(`[DB] Migrated ${flags.length} flag(s) from JSON`);
}

async function migrateAuditLog(filePath) {
  const { rows } = await pool.query('SELECT COUNT(*) FROM audit_events');
  if (parseInt(rows[0].count) > 0) return;
  if (!fs.existsSync(filePath)) return;

  let log;
  try { log = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return; }

  const events = log.events || [];
  if (events.length === 0) return;

  for (const e of events) {
    await pool.query(
      `INSERT INTO audit_events
         (id, timestamp, user_id, user_name, user_role, action, matter_id, matter_name,
          detail, previous_value, new_value, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [
        e.id,
        e.timestamp     || new Date().toISOString(),
        e.userId        || null,
        e.userName      || null,
        e.userRole      || null,
        e.action,
        e.matterId      || null,
        e.matterName    || null,
        e.detail        || null,
        e.previousValue !== undefined ? String(e.previousValue) : null,
        e.newValue      !== undefined ? String(e.newValue)      : null,
        e.ipAddress     || null,
        e.userAgent     || null,
      ]
    );
  }
  console.log(`[DB] Migrated ${events.length} audit event(s) from JSON`);
}

async function migrateSettings(dataDir) {
  const files = {
    aiSettings:   { file: 'aiSettings.json',   default: { AI_DEADLINE_ALERTS: true, AI_DOCUMENT_SCANNER: true, AI_EXTRACTION: false } },
    scanHistory:  { file: 'scanHistory.json',  default: null },
    alertHistory: { file: 'alertHistory.json', default: {} },
  };

  for (const [key, { file, default: defaultVal }] of Object.entries(files)) {
    const { rows } = await pool.query('SELECT 1 FROM settings WHERE key=$1', [key]);
    if (rows.length > 0) continue;

    const filePath = path.join(dataDir, file);
    let value = defaultVal;
    if (fs.existsSync(filePath)) {
      try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { /* use default */ }
    }
    if (value === null) continue;

    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
    console.log(`[DB] Migrated settings: ${key}`);
  }
}

module.exports = { initDatabase };
