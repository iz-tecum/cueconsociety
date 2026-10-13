import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore } from '../sqlite.mjs';
import { createWorker, derivePassword } from '../worker.mjs';
import { clearGmailTokenCache, gmailConfigurationFingerprint } from '../gmail-adapter.mjs';
import { sendingStatus } from '../send-queue.mjs';

const ORIGIN = 'https://admin.example.org';
const NOW = Date.parse('2026-10-13T16:00:00Z');
const password = 'readiness-test-password';
const salt = Buffer.from('readiness-test-salt-long').toString('base64url');
const passwordHash = await derivePassword(password, salt);
const base = {
  ADMIN_EMAIL: 'admin@example.org', ADMIN_PASSWORD_SALT: salt, ADMIN_PASSWORD_HASH: passwordHash,
  SESSION_SECRET: 'readiness-session-secret-long-enough', RATE_LIMIT_SECRET: 'readiness-rate-secret-long-enough', CLIENT_IP: '192.0.2.8',
  GMAIL_CLIENT_ID: 'readiness-client-id', GMAIL_CLIENT_SECRET: 'readiness-client-secret', GMAIL_REFRESH_TOKEN: 'readiness-refresh-token',
  GMAIL_PRINCIPAL: 'person@example.org', GMAIL_FROM: 'club@example.org', GMAIL_UNSUBSCRIBE_ORIGIN: ORIGIN,
  GMAIL_UNSUBSCRIBE_SECRET: 'readiness-unsubscribe-secret-long-enough', GMAIL_SEND_ENABLED: 'false'
};

async function setup(t, overrides = {}) {
  clearGmailTokenCache();
  const database = new SQLiteStore(':memory:'); t.after(() => database.close());
  const env = { ...base, ...overrides, DB: database }, calls = [];
  const google = { alias: 'accepted', principal: base.GMAIL_PRINCIPAL, clientSecret: env.GMAIL_CLIENT_SECRET, scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.settings.basic' };
  let clock = NOW;
  const fetchImpl = async (value, options = {}) => {
    const url = new URL(value); calls.push({ path: url.origin + url.pathname, method: options.method || 'GET' });
    if (url.href === 'https://oauth2.googleapis.com/token') return new URLSearchParams(options.body).get('client_secret') === google.clientSecret
      ? Response.json({ access_token: 'readiness-access-token', expires_in: 3600 }) : Response.json({ error: 'invalid_client' }, { status: 400 });
    if (url.origin + url.pathname === 'https://oauth2.googleapis.com/tokeninfo') return Response.json({ aud: env.GMAIL_CLIENT_ID, scope: google.scope });
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ email: google.principal, email_verified: true });
    if (url.href === 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs') {
      const result = Response.json({ sendAs: [{ sendAsEmail: env.GMAIL_FROM, verificationStatus: google.alias }] });
      return google.onAlias ? google.onAlias(result) : result;
    }
    throw new Error('No send or other Google endpoint is permitted in this preflight test');
  };
  const worker = createWorker({ clock: () => clock, gmailFetch: fetchImpl });
  async function request(route, { method = 'GET', body, headers = {}, origin = ORIGIN } = {}) {
    return worker.fetch(new Request(`${ORIGIN}${route}`, { method,
      headers: { ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
  }
  const login = await request('/api/admin/login', { method: 'POST', body: { email: base.ADMIN_EMAIL, password } });
  const session = await login.json();
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrfToken };
  const check = () => request('/api/admin/sending/check', { method: 'POST', body: {}, headers });
  const status = async () => (await request('/api/admin/sending/status', { headers })).json();
  return { env, database, google, calls, headers, request, check, status, setTime: value => { clock = value; } };
}

test('unconfigured readiness lists missing names without Google calls, hashes, or secrets', async t => {
  const fixture = await setup(t, { GMAIL_REFRESH_TOKEN: undefined });
  const result = await fixture.status();
  assert.equal(result.configured, false); assert.equal(result.connectionVerified, false); assert.equal(result.available, false);
  assert.equal(result.connectionState, 'not_configured'); assert.equal(result.deliveryTested, false);
  assert.deepEqual(result.configurationMissing, ['GMAIL_REFRESH_TOKEN']);
  assert.equal(result.verificationExpiresAt, null); assert.deepEqual(fixture.calls, []);
  const serialized = JSON.stringify(result);
  for (const name of ['GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_UNSUBSCRIBE_SECRET']) assert.equal(serialized.includes(base[name]), false);
  assert.equal(serialized.includes(await gmailConfigurationFingerprint(fixture.env)), false);
});

test('explicit preflight verifies the exact mailbox and accepted alias but sends nothing or enables delivery', async t => {
  const fixture = await setup(t);
  const before = await fixture.status(); assert.equal(before.connectionState, 'check_required');
  const result = await (await fixture.check()).json();
  assert.equal(result.connectionVerified, true); assert.equal(result.connectionState, 'verified');
  assert.equal(result.enabled, false); assert.equal(result.available, false); assert.equal(result.deliveryTested, false);
  assert.equal(result.verificationExpiresAt, new Date(NOW + 3600000).toISOString());
  assert.deepEqual(result.lastCheck, { at: new Date(NOW).toISOString(), principal: base.GMAIL_PRINCIPAL, from: base.GMAIL_FROM });
  assert.deepEqual(fixture.calls.map(call => call.path), ['https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/tokeninfo', 'https://openidconnect.googleapis.com/v1/userinfo', 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs']);
  assert.equal((await fixture.database.prepare('SELECT COUNT(*) AS n FROM send_jobs').first()).n, 0);
  assert.equal((await fixture.database.prepare('SELECT COUNT(*) AS n FROM send_campaigns').first()).n, 0);
  assert.equal((await fixture.database.prepare('SELECT COUNT(*) AS n FROM send_budget').first()).n, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('readiness-access-token'), false);
  assert.equal(serialized.includes(await gmailConfigurationFingerprint(fixture.env)), false);
});

test('a failed recheck immediately invalidates an earlier successful readiness proof', async t => {
  const fixture = await setup(t, { GMAIL_SEND_ENABLED: 'true' });
  assert.equal((await (await fixture.check()).json()).available, true);
  fixture.google.alias = 'pending';
  const failed = await fixture.check(); assert.equal(failed.status, 409);
  assert.equal((await failed.json()).error, 'GMAIL_ALIAS_NOT_VERIFIED');
  const result = await fixture.status();
  assert.equal(result.connectionVerified, false); assert.equal(result.available, false); assert.equal(result.lastCheck, null);
  assert.equal(result.connectionState, 'check_required'); assert.equal(result.deliveryTested, false);
  assert.equal((await fixture.database.prepare("SELECT COUNT(*) AS n FROM send_control WHERE id LIKE 'gmail-check:%'").first()).n, 0);
});

test('a changed client secret cannot reuse a token cached with the old credentials', async t => {
  const fixture = await setup(t, { GMAIL_SEND_ENABLED: 'true' });
  assert.equal((await (await fixture.check()).json()).available, true);
  const before = fixture.calls.length;
  fixture.env.GMAIL_CLIENT_SECRET = 'invalid-replacement-secret';
  const result = await fixture.check();
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error, 'GOOGLE_REAUTHORIZATION_REQUIRED');
  assert.deepEqual(fixture.calls.slice(before), [{ path: 'https://oauth2.googleapis.com/token', method: 'POST' }]);
  const status = await fixture.status();
  assert.equal(status.connectionVerified, false); assert.equal(status.available, false); assert.equal(status.lastCheck, null);
});

test('an older successful check cannot overwrite the outcome of a newer failed check', async t => {
  const fixture = await setup(t, { GMAIL_SEND_ENABLED: 'true' });
  let reached, resume, aliasCalls = 0;
  const waiting = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  fixture.google.onAlias = async response => {
    if (++aliasCalls === 1) { reached(); await gate; }
    return response;
  };
  const older = fixture.check();
  await waiting;
  fixture.google.alias = 'pending';
  const newer = await fixture.check();
  assert.equal(newer.status, 409);
  assert.equal((await newer.json()).error, 'GMAIL_ALIAS_NOT_VERIFIED');
  assert.equal((await fixture.status()).connectionVerified, false);
  resume();
  const late = await older;
  assert.equal(late.status, 409);
  assert.equal((await late.json()).error, 'GOOGLE_CHECK_SUPERSEDED');
  const result = await fixture.status();
  assert.equal(result.available, false); assert.equal(result.connectionVerified, false); assert.equal(result.lastCheck, null);
  assert.equal((await fixture.database.prepare('SELECT COUNT(*) AS n FROM send_control').first()).n, 1);
});

test('each credential or sender configuration change requires a fresh proof without making a Google request', async t => {
  const fixture = await setup(t, { GMAIL_SEND_ENABLED: 'true' });
  assert.equal((await (await fixture.check()).json()).available, true);
  const callCount = fixture.calls.length;
  const replacements = {
    GMAIL_CLIENT_ID: 'rotated-client-id', GMAIL_CLIENT_SECRET: 'rotated-client-secret', GMAIL_REFRESH_TOKEN: 'rotated-refresh-token',
    GMAIL_PRINCIPAL: 'other@example.org', GMAIL_FROM: 'otherclub@example.org', GMAIL_UNSUBSCRIBE_ORIGIN: 'https://another.example.org',
    GMAIL_UNSUBSCRIBE_SECRET: 'rotated-unsubscribe-secret-long-enough'
  };
  for (const [key, replacement] of Object.entries(replacements)) {
    const previous = fixture.env[key]; fixture.env[key] = replacement;
    const result = await fixture.status();
    assert.equal(result.configured, true); assert.equal(result.connectionVerified, false); assert.equal(result.available, false);
    fixture.env[key] = previous;
  }
  assert.equal((await fixture.status()).connectionVerified, true);
  assert.equal(fixture.calls.length, callCount);
});

test('enabled state and a fresh connection remain separate from an actual delivery test', async t => {
  const fixture = await setup(t);
  await fixture.check();
  fixture.env.GMAIL_SEND_ENABLED = 'true';
  const result = await fixture.status();
  assert.equal(result.enabled, true); assert.equal(result.connectionVerified, true); assert.equal(result.available, true);
  assert.equal(result.deliveryTested, false); assert.match(result.reason, /not been tested/);
  assert.equal(fixture.calls.some(call => call.path.endsWith('/messages/send')), false);
  fixture.env.GMAIL_SEND_ENABLED = 'false';
  assert.equal((await fixture.status()).available, false);
});

test('expired and future-dated verification cannot make status ready', async t => {
  const fixture = await setup(t, { GMAIL_SEND_ENABLED: 'true' }); await fixture.check();
  fixture.setTime(NOW + 3600000);
  const expired = await fixture.status();
  assert.equal(expired.connectionVerified, false); assert.equal(expired.available, false); assert.equal(expired.verificationExpiresAt, null);
  const future = await sendingStatus(fixture.env, NOW - 1000);
  assert.equal(future.connectionVerified, false); assert.equal(future.available, false);
});

test('legacy name-only check records are not proof of the current private credentials', async t => {
  const fixture = await setup(t, { GMAIL_SEND_ENABLED: 'true' });
  await fixture.database.prepare("UPDATE send_control SET verified_principal=?,verified_from=?,verified_at=? WHERE id='gmail'")
    .bind(base.GMAIL_PRINCIPAL, base.GMAIL_FROM, new Date(NOW).toISOString()).run();
  const result = await fixture.status();
  assert.equal(result.connectionVerified, false); assert.equal(result.available, false);
  assert.ok(result.lastCheck); assert.deepEqual(fixture.calls, []);
});

test('readiness API retains authentication, exact origin and CSRF protections', async t => {
  const fixture = await setup(t);
  assert.equal((await fixture.request('/api/admin/sending/status')).status, 401);
  const args = { method: 'POST', body: {} };
  assert.equal((await fixture.request('/api/admin/sending/check', args)).status, 401);
  assert.equal((await fixture.request('/api/admin/sending/check', { ...args, headers: { Cookie: fixture.headers.Cookie } })).status, 403);
  assert.equal((await fixture.request('/api/admin/sending/check', { ...args, headers: fixture.headers, origin: 'https://other.example.org' })).status, 403);
  assert.equal((await fixture.request('/api/admin/sending/check', { ...args, headers: fixture.headers, origin: null })).status, 403);
  assert.deepEqual(fixture.calls, []);
});

test('repeated successful checks keep bounded private proof storage', async t => {
  const fixture = await setup(t);
  for (let i = 0; i < 3; i++) {
    fixture.env.GMAIL_REFRESH_TOKEN = `rotated-token-${i}`;
    assert.equal((await fixture.check()).status, 200);
  }
  assert.equal((await fixture.database.prepare('SELECT COUNT(*) AS n FROM send_control').first()).n, 2);
  assert.equal((await fixture.database.prepare("SELECT COUNT(*) AS n FROM send_control WHERE id='gmail'").first()).n, 1);
});
