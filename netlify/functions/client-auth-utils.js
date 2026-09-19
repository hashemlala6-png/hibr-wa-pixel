const { createSession, verifySession, cookie, clearCookie } = require('./session-core');
const COOKIE_NAME = 'hbpx_client';
const MAX_AGE = 60 * 60 * 24 * 30;
function createClientSession(accountId) { return createSession('client', accountId, MAX_AGE); }
function getClientSession(event) { return verifySession(event, 'client', COOKIE_NAME); }
function sessionCookie(value) { return cookie(COOKIE_NAME, value, MAX_AGE, 'Lax'); }
function clearClientCookie() { return clearCookie(COOKIE_NAME, 'Lax'); }
function requireClient(event) { return getClientSession(event); }
module.exports = { COOKIE_NAME, MAX_AGE, createClientSession, getClientSession, requireClient, sessionCookie, clearCookie: clearClientCookie };
