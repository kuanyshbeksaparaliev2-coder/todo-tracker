'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Қолданушы табылмаған кезде де бірдей уақыт жұмсау үшін (timing шабуылынан қорғау)
const DUMMY_HASH = `scrypt$${crypto.randomBytes(16).toString('hex')}$${crypto.randomBytes(64).toString('hex')}`;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function readToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'sid') {
      const token = rest.join('=');
      return /^[0-9a-f]{64}$/.test(token) ? token : null;
    }
  }
  return null;
}

function userFromRequest(db, req) {
  const token = readToken(req);
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(sha256(token), Date.now());
  return row ? { id: row.id, username: row.username } : null;
}

function destroySession(db, req) {
  const token = readToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function cookie(token, secure) {
  const maxAge = token ? SESSION_TTL_MS / 1000 : 0;
  return `sid=${token || ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, createSession, userFromRequest, destroySession, cookie };
