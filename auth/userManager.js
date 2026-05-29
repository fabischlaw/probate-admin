'use strict';

const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');
const PATHS  = require('../config/paths');

const USERS_FILE = PATHS.USERS_FILE;

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return { users: [] };
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return { users: [] }; }
}

function saveUsers(data) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

async function createUser({ name, email, role, password }) {
  const data = loadUsers();
  if (data.users.find(u => u.email === email.toLowerCase())) {
    throw new Error('Email already exists');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = {
    id: 'user_' + Date.now(),
    name,
    email: email.toLowerCase(),
    role,
    passwordHash,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    active: true,
    mustChangePassword: true,
  };
  data.users.push(user);
  saveUsers(data);
  console.log('[Auth] createUser saved:', email.toLowerCase(), '| file exists:', fs.existsSync(USERS_FILE));
  const { passwordHash: _, ...safe } = user;
  return safe;
}

async function verifyUser(email, password) {
  console.log('[Auth] verifyUser called for:', email);
  console.log('[Auth] USERS_FILE:', USERS_FILE);
  console.log('[Auth] File exists:', fs.existsSync(USERS_FILE));
  const data = loadUsers();
  console.log('[Auth] Users count:', data.users.length);
  console.log('[Auth] User emails:', data.users.map(u => u.email));
  const user = data.users.find(u => u.email === email.toLowerCase() && u.active);
  if (!user) return null;
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;
  user.lastLogin = new Date().toISOString();
  saveUsers(data);
  const { passwordHash: _, ...safe } = user;
  return safe;
}

async function changePassword(userId, newPassword) {
  const data = loadUsers();
  const user = data.users.find(u => u.id === userId);
  if (!user) throw new Error('User not found');
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.mustChangePassword = false;
  saveUsers(data);
}

function getUsers() {
  const data = loadUsers();
  return data.users.map(({ passwordHash: _, ...u }) => u);
}

function isSetupComplete() {
  const data = loadUsers();
  return data.users.length > 0;
}

function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTWXYZabcdefghjkmnpqrstwxyz23456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

module.exports = {
  createUser,
  verifyUser,
  changePassword,
  getUsers,
  isSetupComplete,
  loadUsers,
  saveUsers,
  generateTempPassword,
};
