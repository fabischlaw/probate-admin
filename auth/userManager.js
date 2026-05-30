'use strict';

const bcrypt = require('bcryptjs');
const pool   = require('../config/database');

async function createUser({ name, email, role, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const id = 'user_' + Date.now();
  const { rows } = await pool.query(
    `INSERT INTO users (id, name, email, role, password_hash, must_change_password)
     VALUES ($1,$2,$3,$4,$5,TRUE)
     RETURNING id, name, email, role, created_at, last_login, active, must_change_password`,
    [id, name, email.toLowerCase(), role, passwordHash]
  );
  return rows[0] ? dbRowToUser(rows[0]) : null;
}

async function verifyUser(email, password) {
  console.log('[Auth] verifyUser called for:', email);
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE email=$1 AND active=TRUE',
    [email.toLowerCase()]
  );
  console.log('[Auth] DB user lookup result count:', rows.length);
  if (rows.length === 0) return null;

  const row = rows[0];
  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) return null;

  await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [row.id]);
  row.last_login = new Date().toISOString();
  return dbRowToUser(row);
}

async function changePassword(userId, newPassword) {
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const { rowCount } = await pool.query(
    'UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2',
    [passwordHash, userId]
  );
  if (rowCount === 0) throw new Error('User not found');
}

async function getUsers() {
  const { rows } = await pool.query(
    'SELECT id, name, email, role, created_at, last_login, active, must_change_password FROM users ORDER BY created_at'
  );
  return rows.map(dbRowToUser);
}

async function isSetupComplete() {
  const { rows } = await pool.query('SELECT 1 FROM users LIMIT 1');
  return rows.length > 0;
}

async function updateUser(userId, fields) {
  const allowed = ['name', 'email', 'role', 'active'];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    const col = k === 'email' ? 'email' : k;
    sets.push(`${col}=$${i++}`);
    vals.push(k === 'email' ? v.toLowerCase() : v);
  }
  if (sets.length === 0) return;
  vals.push(userId);
  await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${i}`, vals);
}

function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTWXYZabcdefghjkmnpqrstwxyz23456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function dbRowToUser(row) {
  return {
    id:                 row.id,
    name:               row.name,
    email:              row.email,
    role:               row.role,
    createdAt:          row.created_at,
    lastLogin:          row.last_login,
    active:             row.active,
    mustChangePassword: row.must_change_password,
  };
}

module.exports = {
  createUser,
  verifyUser,
  changePassword,
  getUsers,
  isSetupComplete,
  updateUser,
  generateTempPassword,
};
