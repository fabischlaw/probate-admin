'use strict';

/**
 * importToProduction.js
 *
 * Reads local JSON data files and imports them directly into the
 * production PostgreSQL database specified by DATABASE_URL.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/importToProduction.js
 *   — or —
 *   Set DATABASE_URL in .env then: node scripts/importToProduction.js
 *
 * Safe to re-run: all inserts use ON CONFLICT DO NOTHING (users,
 * matters, tasks, flags, audit_events) or DO UPDATE (settings).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Add it to .env or pass it as an env var.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

const DATA_DIR = path.join(__dirname, '../data');

function readJson(filename, fallback) {
  const p = path.join(DATA_DIR, filename);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn(`  WARNING: could not parse ${filename}:`, e.message); return fallback; }
}

const STAGE_NORMALIZE = {
  'INTAKE':            'PETITION_PREP',
  'PETITION PREP':     'PETITION_PREP',
  'IN ADMINISTRATION': 'IN_ADMINISTRATION',
  'CLOSING PREP':      'CLOSING_PREP',
};
const PLANNING_STAGES = new Set(['INTAKE','DRAFTING','REVIEW','SIGNING','COMPLETE','CLOSED_PLANNING']);

function normalizeStage(s) {
  if (!s) return 'PETITION_PREP';
  if (PLANNING_STAGES.has(s)) return s;
  return STAGE_NORMALIZE[s] || s;
}

async function run() {
  const client = await pool.connect();
  try {
    // ── verify schema exists ──────────────────────────────────────────────────
    const { rows: tables } = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    );
    const tableNames = tables.map(r => r.tablename);
    const required   = ['users','matter_admin','matter_tasks','flags','audit_events','settings'];
    const missing    = required.filter(t => !tableNames.includes(t));
    if (missing.length > 0) {
      console.error('ERROR: Missing tables:', missing.join(', '));
      console.error('Run the app once to initialize the schema (it calls initDatabase() on startup),');
      console.error('or manually run: psql "$DATABASE_URL" -f config/schema.sql');
      process.exit(1);
    }
    console.log('Schema verified — all tables present.\n');

    await client.query('BEGIN');

    // ── users ─────────────────────────────────────────────────────────────────
    const { users } = readJson('users.json', { users: [] });
    let uCount = 0;
    for (const u of users) {
      const { rowCount } = await client.query(
        `INSERT INTO users (id, name, email, role, password_hash, created_at, last_login, active, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [u.id, u.name, u.email, u.role, u.passwordHash,
         u.createdAt || new Date().toISOString(), u.lastLogin || null,
         u.active !== false, u.mustChangePassword !== false]
      );
      uCount += rowCount;
    }
    console.log(`  users         : ${uCount} inserted (${users.length} total, ${users.length - uCount} already existed)`);

    // ── matter_admin + matter_tasks ───────────────────────────────────────────
    const adminData = readJson('administration.json', {});
    let mCount = 0, tCount = 0;
    for (const [matterId, rec] of Object.entries(adminData)) {
      const { rowCount: mr } = await client.query(
        `INSERT INTO matter_admin
           (matter_id, stage, key_dates, notes, matter_type_overrides, task_assignments,
            staff, custom_notes, pending_matter_type_change, saved_matter_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (matter_id) DO NOTHING`,
        [
          matterId,
          normalizeStage(rec.stage),
          JSON.stringify(rec.keyDates || {}),
          rec.notes || null,
          JSON.stringify(rec.matterTypeOverrides || {}),
          JSON.stringify(rec.taskAssignments || {}),
          JSON.stringify(rec.staff || []),
          typeof rec.customNotes === 'string' ? rec.customNotes : '',
          rec.pendingMatterTypeChange ? JSON.stringify(rec.pendingMatterTypeChange) : null,
          rec.savedMatterType ? JSON.stringify(rec.savedMatterType) : null,
        ]
      );
      mCount += mr;

      for (const [taskId, val] of Object.entries(rec.tasks || {})) {
        const [status, prevStatus, setDate, setBy, notes] = typeof val === 'string'
          ? [val, null, null, null, null]
          : [val.status, val.previousStatus||null, val.setDate||null, val.setBy||null, val.notes||null];
        const { rowCount: tr } = await client.query(
          `INSERT INTO matter_tasks (matter_id, task_id, status, previous_status, set_date, set_by, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (matter_id, task_id) DO NOTHING`,
          [matterId, taskId, status, prevStatus, setDate, setBy, notes]
        );
        tCount += tr;
      }
    }
    const totalMatters = Object.keys(adminData).length;
    const totalTasks   = Object.values(adminData).reduce((s,r) => s + Object.keys(r.tasks||{}).length, 0);
    console.log(`  matter_admin  : ${mCount} inserted (${totalMatters} total, ${totalMatters - mCount} already existed)`);
    console.log(`  matter_tasks  : ${tCount} inserted (${totalTasks} total, ${totalTasks - tCount} already existed)`);

    // ── flags ─────────────────────────────────────────────────────────────────
    const flags = readJson('flags.json', []);
    let fCount = 0;
    for (const f of (Array.isArray(flags) ? flags : [])) {
      const { rowCount } = await client.query(
        `INSERT INTO flags (id, matter_id, matter_name, type, severity, message, raised_at, last_seen_at, acknowledged_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [f.id, f.matterId, f.matterName||null, f.type, f.severity, f.message,
         f.raisedAt || new Date().toISOString(), f.lastSeenAt||null, f.acknowledgedAt||null, f.resolvedAt||null]
      );
      fCount += rowCount;
    }
    const totalFlags = Array.isArray(flags) ? flags.length : 0;
    console.log(`  flags         : ${fCount} inserted (${totalFlags} total, ${totalFlags - fCount} already existed)`);

    // ── audit_events ──────────────────────────────────────────────────────────
    const { events = [] } = readJson('auditLog.json', { events: [] });
    const MAX_AUDIT = 500;
    let aCount = 0;
    for (const e of events.slice(0, MAX_AUDIT)) {
      const { rowCount } = await client.query(
        `INSERT INTO audit_events
           (id, timestamp, user_id, user_name, user_role, action, matter_id, matter_name,
            detail, previous_value, new_value, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
        [
          e.id, e.timestamp || new Date().toISOString(),
          e.userId||null, e.userName||null, e.userRole||null, e.action,
          e.matterId||null, e.matterName||null, e.detail||null,
          e.previousValue != null ? String(e.previousValue) : null,
          e.newValue      != null ? String(e.newValue)      : null,
          e.ipAddress||null, e.userAgent||null,
        ]
      );
      aCount += rowCount;
    }
    console.log(`  audit_events  : ${aCount} inserted (${Math.min(events.length, MAX_AUDIT)} exported of ${events.length} total)`);

    // ── settings ──────────────────────────────────────────────────────────────
    const settingsToLoad = [
      { key: 'aiSettings',   file: 'aiSettings.json',   default: { AI_DEADLINE_ALERTS: true, AI_DOCUMENT_SCANNER: true, AI_EXTRACTION: false } },
      { key: 'alertHistory', file: 'alertHistory.json',  default: {} },
      { key: 'scanHistory',  file: 'scanHistory.json',   default: null },
    ];
    let sCount = 0;
    for (const { key, file, default: def } of settingsToLoad) {
      const value = readJson(file, def);
      if (value === null) continue;
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
        [key, JSON.stringify(value)]
      );
      sCount++;
    }
    console.log(`  settings keys : ${sCount}`);

    await client.query('COMMIT');
    console.log('\nImport complete.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nERROR — transaction rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
