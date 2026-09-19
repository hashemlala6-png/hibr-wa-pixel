const { createSession, verifySession, cookie, clearCookie, json } = require('./session-core');
const COOKIE_NAME = 'hbpx_admin';
const MAX_AGE = 60 * 60 * 24;
function createAdminSession() { return createSession('admin', 'admin', MAX_AGE); }
function verifyAdmin(event) { return Boolean(verifySession(event, 'admin', COOKIE_NAME)); }
function sessionCookie(value) { return cookie(COOKIE_NAME, value, MAX_AGE, 'Lax'); }
function clearAdminCookie() { return clearCookie(COOKIE_NAME, 'Lax'); }
function requireAdmin(event) { return verifyAdmin(event) ? null : json(401, { error: 'غير مصرح. سجّل الدخول كمالك أولاً.' }); }
module.exports = { COOKIE_NAME, MAX_AGE, createSession: createAdminSession, sessionCookie, clearCookie: clearAdminCookie, verifySession: verifyAdmin, requireAdmin, json };
