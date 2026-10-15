'use strict';

// The admin's most sensitive actions (downloading a backup, restoring one)
// ask for the password again, and the two-factor code when it is on. A
// backup holds every account's password hash and a restore can rewrite any
// account, so a stolen admin session alone should not be enough for either.
//
// A download then goes through a one-time ticket that lasts two minutes,
// instead of the admin's session token in the URL, where it ended up in
// browser history and proxy logs.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');

const TICKET_MS = 2 * 60 * 1000;
const tickets = new Map(); // ticket -> { userId, purpose, data, expires }

// The same rule as auth.js: an SSO account has no bcrypt hash of its own.
function hasLocalPassword(user) {
  return !!user && typeof user.password_hash === 'string' && user.password_hash.startsWith('$2');
}

// Null when the admin passed, or the reason they did not.
async function checkAdminReauth(db, userId, { password, code } = {}) {
  const auth = require('./auth');
  const user = db.prepare('SELECT id, username, password_hash, totp_enabled, totp_secret FROM users WHERE id = ?').get(userId);
  if (!user) return 'Account not found';
  // An SSO account has no password here and cannot turn on two-factor, so
  // there would be nothing to ask for and a stolen session would be enough.
  if (!hasLocalPassword(user) && !(user.totp_enabled && user.totp_secret)) {
    return 'Backups and restores need an admin account with a password. Sign in with the local admin account to do this.';
  }
  if (hasLocalPassword(user)) {
    if (typeof password !== 'string' || !password) return 'Enter your password';
    if (!(await bcrypt.compare(password, user.password_hash))) return 'Incorrect password';
  }
  if (user.totp_enabled && user.totp_secret) {
    if (auth.totpLimited(user.id)) return 'Too many wrong codes. Wait a few minutes and try again.';
    const clean = typeof code === 'string' ? code.replace(/\s/g, '') : '';
    if (!clean) return 'Enter your two-factor code';
    const totp = new OTPAuth.TOTP({ issuer: 'Haven', label: user.username, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(user.totp_secret) });
    if (!auth.acceptTotpCode(user.id, totp, clean)) {
      auth.noteTotpFail(user.id);
      return 'Incorrect two-factor code';
    }
  }
  return null;
}

function issueTicket(userId, purpose, data = {}) {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, { userId, purpose, data, expires: now + TICKET_MS });
  return ticket;
}

// The ticket's entry, used up, or null.
function takeTicket(ticket, purpose) {
  if (typeof ticket !== 'string' || !/^[0-9a-f]{64}$/.test(ticket)) return null;
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (entry.expires < Date.now() || entry.purpose !== purpose) return null;
  return entry;
}

module.exports = { checkAdminReauth, issueTicket, takeTicket };
