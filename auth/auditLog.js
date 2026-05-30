'use strict';

const pool = require('../config/database');

async function logAuditEvent(req, action, matterId, matterName, detail, previousValue, newValue) {
  const id = 'audit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const { rows } = await pool.query(
    `INSERT INTO audit_events
       (id, user_id, user_name, user_role, action, matter_id, matter_name,
        detail, previous_value, new_value, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      id,
      req.session?.user?.id   || 'system',
      req.session?.user?.name || 'System',
      req.session?.user?.role || 'system',
      action,
      matterId      || null,
      matterName    || null,
      detail        || null,
      previousValue !== undefined && previousValue !== null ? String(previousValue) : null,
      newValue      !== undefined && newValue      !== null ? String(newValue)      : null,
      req.ip        || null,
      req.headers?.['user-agent'] || null,
    ]
  );
  return dbRowToEvent(rows[0]);
}

async function getAuditLog({ matterId, userId, action, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const vals = [];
  let i = 1;

  if (matterId) { conditions.push(`matter_id=$${i++}`); vals.push(matterId); }
  if (userId)   { conditions.push(`user_id=$${i++}`);   vals.push(userId); }
  if (action)   { conditions.push(`action=$${i++}`);    vals.push(action); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  vals.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM audit_events ${where} ORDER BY timestamp DESC LIMIT $${i++} OFFSET $${i}`,
    vals
  );
  return rows.map(dbRowToEvent);
}

async function getAuditLogTotal({ matterId, userId, action } = {}) {
  const conditions = [];
  const vals = [];
  let i = 1;

  if (matterId) { conditions.push(`matter_id=$${i++}`); vals.push(matterId); }
  if (userId)   { conditions.push(`user_id=$${i++}`);   vals.push(userId); }
  if (action)   { conditions.push(`action=$${i++}`);    vals.push(action); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await pool.query(`SELECT COUNT(*) FROM audit_events ${where}`, vals);
  return parseInt(rows[0].count);
}

function dbRowToEvent(row) {
  return {
    id:            row.id,
    timestamp:     row.timestamp,
    userId:        row.user_id,
    userName:      row.user_name,
    userRole:      row.user_role,
    action:        row.action,
    matterId:      row.matter_id,
    matterName:    row.matter_name,
    detail:        row.detail,
    previousValue: row.previous_value,
    newValue:      row.new_value,
    ipAddress:     row.ip_address,
    userAgent:     row.user_agent,
  };
}

module.exports = { logAuditEvent, getAuditLog, getAuditLogTotal };
