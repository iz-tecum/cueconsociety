import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore } from '../sqlite.mjs';
import { createWorker, derivePassword, sha256 } from '../worker.mjs';
import { clearGmailTokenCache, createGmailAdapter } from '../gmail-adapter.mjs';
import { encryptGoogleSecret, decryptGoogleSecret, sessionSendingEnvironment } from '../google-session.mjs';
import { importRecords } from '../import.mjs';

const ORIGIN = 'https://admin.example.org', NOW = Date.parse('2026-10-13T18:00:00Z');
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const salt = Buffer.from('session-oauth-test-salt').toString('base64url'), password = 'session-oauth-test-password';
const passwordHash = await derivePassword(password, salt);
const base = {
  ADMIN_EMAIL: 'board@example.org', ADMIN_PASSWORD_SALT: salt, ADMIN_PASSWORD_HASH: passwordHash,
  SESSION_SECRET: 'session-oauth-session-secret-long-enough', RATE_LIMIT_SECRET: 'session-oauth-rate-secret-long-enough', CLIENT_IP: '192.0.2.20',
  GOOGLE_SESSION_OAUTH_ENABLED: 'true', GOOGLE_CLIENT_ID: 'session-test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'session-client-secret',
  GOOGLE_REDIRECT_URI: `${ORIGIN}/api/admin/google/callback`, GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64url'),
  GMAIL_SEND_ENABLED: 'false', GMAIL_UNSUBSCRIBE_ORIGIN: ORIGIN, GMAIL_UNSUBSCRIBE_SECRET: 'session-oauth-global-unsubscribe-secret-long-enough',
  GMAIL_FROM: 'legacy@example.org', GMAIL_PRINCIPAL: 'legacy@example.org', GMAIL_CLIENT_ID: 'legacy-client', GMAIL_CLIENT_SECRET: 'legacy-secret', GMAIL_REFRESH_TOKEN: 'legacy-refresh'
};

async function setup(t) {
  clearGmailTokenCache();
  const database = new SQLiteStore(':memory:'); t.after(() => database.close());
  const env = { ...base, DB: database }, calls = [], accounts = {
    alice: { email: 'alice@columbia.edu', sub: 'subject-alice' }, bob: { email: 'bob@columbia.edu', sub: 'subject-bob' },
    outsider: { email: 'person@example.org', sub: 'subject-outsider' }, unverified: { email: 'person@columbia.edu', sub: 'subject-unverified', email_verified: false }
  };
  let now = NOW;
  const hooks = {};
  const googleFetch = async (value, init = {}) => {
    const url = new URL(value), endpoint = url.origin + url.pathname;
    calls.push({ endpoint, method: init.method || 'GET', body: init.body });
    const override = hooks.reply?.(endpoint);
    if (override) return override;
    if (endpoint === 'https://oauth2.googleapis.com/token') {
      const params = new URLSearchParams(init.body);
      const name = params.get('grant_type') === 'authorization_code' ? params.get('code') : params.get('refresh_token')?.replace('refresh-', '');
      if (!accounts[name]) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: `access-${name}`, refresh_token: `refresh-${name}`, token_type: 'Bearer', expires_in: 3600, scope: `openid email ${SEND}` });
    }
    if (endpoint === 'https://oauth2.googleapis.com/tokeninfo') {
      const name = url.searchParams.get('access_token')?.replace('access-', '');
      return Response.json({ aud: env.GOOGLE_CLIENT_ID, scope: `openid email ${SEND}`, sub: accounts[name]?.sub, ...hooks.tokenInfo });
    }
    if (endpoint === 'https://openidconnect.googleapis.com/v1/userinfo') {
      const name = init.headers.Authorization.replace('Bearer access-', '');
      const result = Response.json({ email_verified: true, ...accounts[name], ...hooks.identity });
      return hooks.userinfo ? hooks.userinfo(name, result) : result;
    }
    if (endpoint === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') return Response.json({ id: 'mock-message' });
    assert.fail(`Forbidden or unexpected endpoint in mock: ${endpoint}`);
  };
  const worker = createWorker({ clock: () => now, googleFetch, gmailFetch: googleFetch });
  async function request(session, route, { method = 'GET', body, origin = ORIGIN, headers = {}, bindingCookie } = {}) {
    const cookies = [session?.cookie, bindingCookie ?? session?.bindingCookie].filter(Boolean).join('; ');
    return worker.fetch(new Request(`${ORIGIN}${route}`, { method, headers: {
      ...(origin ? { Origin: origin } : {}), ...(cookies ? { Cookie: cookies } : {}), ...(session?.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
  }
  async function login() {
    const reply = await request(null, '/api/admin/login', { method: 'POST', body: { email: base.ADMIN_EMAIL, password } });
    assert.equal(reply.status, 200); const data = await reply.json(), cookie = reply.headers.get('set-cookie').split(';')[0];
    return { cookie, csrf: data.csrfToken, hash: await sha256(cookie.split('=')[1]), bindingCookie: '' };
  }
  async function start(session, body = {}) {
    const reply = await request(session, '/api/admin/google/start', { method: 'POST', body });
    assert.equal(reply.status, 200); const data = await reply.json();
    session.bindingCookie = reply.headers.get('set-cookie').split(';')[0];
    const url = new URL(data.url);
    return { state: url.searchParams.get('state'), bindingCookie: session.bindingCookie, url, cookieHeader: reply.headers.get('set-cookie') };
  }
  async function complete(session, attempt, code) { return request(session, '/api/admin/google/complete', { method: 'POST', body: { state: attempt.state, code }, bindingCookie: attempt.bindingCookie }); }
  async function connect(session, name) { const attempt = await start(session), reply = await complete(session, attempt, name); assert.equal(reply.status, 200, await reply.clone().text()); return attempt; }
  async function status(session) { const reply = await request(session, '/api/admin/sending/status'); assert.equal(reply.status, 200); return reply.json(); }
  async function savedDraft() {
    await importRecords(database, [{ email: 'member@example.org', status: 'subscribed', name: '', interests: [], sources: [] }], { now });
    const id = crypto.randomUUID();
    await database.prepare('INSERT INTO drafts VALUES(?,?,?,?,?,?,?)').bind(id, 'Test', 'Test', '', 'Test body', JSON.stringify([await sha256('member@example.org')]), new Date(now).toISOString()).run();
    return id;
  }
  return { env, database, calls, accounts, hooks, googleFetch, request, login, start, complete, connect, status, savedDraft, setTime: value => { now = value; } };
}

test('Google-only requests cannot create CES admin sessions; start requires login, origin and CSRF', async t => {
  const f = await setup(t);
  assert.equal((await f.request(null, '/api/admin/google/start', { method: 'POST', body: {} })).status, 401);
  assert.equal((await f.request(null, '/api/admin/google/complete', { method: 'POST', body: { code: 'alice' } })).status, 401);
  const a = await f.login();
  assert.equal((await f.request(a, '/api/admin/google/start', { method: 'POST', body: {}, origin: 'https://other.example', headers: { 'X-CSRF-Token': a.csrf } })).status, 403);
  assert.equal((await f.request(a, '/api/admin/google/start', { method: 'POST', body: {}, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM google_oauth_states').first()).n, 0);
  assert.equal(f.calls.length, 0);
});

test('authorization uses exact callback, direct-mailbox scopes, PKCE and private Lax binding', async t => {
  const f = await setup(t), a = await f.login();
  const attempt = await f.start(a, { from: 'evil@example.org', returnUrl: 'https://evil.example' });
  assert.equal(attempt.url.origin, 'https://accounts.google.com');
  assert.equal(attempt.url.searchParams.get('redirect_uri'), base.GOOGLE_REDIRECT_URI);
  assert.equal(attempt.url.searchParams.get('scope'), `openid email ${SEND}`);
  assert.equal(attempt.url.searchParams.get('code_challenge_method'), 'S256');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600', 'Path=/']) assert.ok(attempt.cookieHeader.includes(flag));
  const stored = await f.database.prepare('SELECT * FROM google_oauth_states').first();
  assert.notEqual(stored.state_hash, attempt.state); assert.ok(stored.pkce_ciphertext.startsWith('v1.'));
  const before = await f.status(a);
  assert.equal(before.oauthRequired, true); assert.equal(before.oauthConnected, false); assert.equal(before.from, ''); assert.equal(before.configured, false);
  assert.equal(f.calls.length, 0);
});

test('status explicitly distinguishes legacy delivery from required session OAuth without provider calls', async t => {
  const f = await setup(t), a = await f.login();
  for (const route of ['/api/admin/google/status', '/api/admin/sending/status']) {
    let reply = await f.request(a, route);
    assert.equal(reply.status, 200); assert.equal((await reply.json()).oauthRequired, true);
    f.env.GOOGLE_SESSION_OAUTH_ENABLED = 'false';
    reply = await f.request(a, route);
    assert.equal(reply.status, 200);
    const status = await reply.json();
    assert.equal(status.oauthRequired, false); assert.equal(status.oauthAvailable, false); assert.equal(status.oauthConnected, false);
    f.env.GOOGLE_SESSION_OAUTH_ENABLED = 'true';
  }
  f.env.GOOGLE_CLIENT_SECRET = '';
  const unavailable = await f.status(a);
  assert.equal(unavailable.oauthRequired, true); assert.equal(unavailable.oauthAvailable, false);
  assert.equal(f.calls.length, 0);
});

test('cross-site callback contains no supplied code and finalization requires the original Strict CES session', async t => {
  const f = await setup(t), a = await f.login(), b = await f.login(), attempt = await f.start(a);
  const reply = await f.request(null, `/api/admin/google/callback?state=${attempt.state}&code=%3C%2Fscript%3Eprivate-code`, {
    origin: null, bindingCookie: attempt.bindingCookie, headers: { 'Sec-Fetch-Site': 'cross-site' }
  });
  assert.equal(reply.status, 200); const html = await reply.text();
  assert.ok(!html.includes('private-code')); assert.ok(!html.includes(attempt.state));
  assert.match(html, /history\.replaceState/); assert.match(html, /X-CSRF-Token/);
  assert.equal(reply.headers.get('referrer-policy'), 'no-referrer'); assert.match(reply.headers.get('content-security-policy'), /script-src 'nonce-/);
  assert.equal((await f.complete(b, attempt, 'alice')).status, 409);
  assert.equal((await f.request(null, '/api/admin/google/complete', { method: 'POST', body: { state: attempt.state, code: 'alice' }, bindingCookie: attempt.bindingCookie })).status, 401);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.complete(a, attempt, 'alice')).status, 200);
  assert.equal((await f.complete(a, attempt, 'alice')).status, 409);
  const status = await f.status(a);
  assert.equal(status.oauthConnected, true); assert.equal(status.from, 'alice@columbia.edu'); assert.equal(status.enabled, false); assert.equal(status.connectionVerified, false);
  assert.equal((await f.status(b)).oauthConnected, false);
});

test('wrong binding, expired state, unverified/non-Columbia identities and wrong scopes fail closed', async t => {
  const f = await setup(t), a = await f.login();
  let attempt = await f.start(a);
  assert.equal((await f.complete(a, { ...attempt, bindingCookie: '__Host-ces_google_oauth=' + 'x'.repeat(43) }, 'alice')).status, 409);
  f.setTime(NOW + 600001);
  assert.equal((await f.complete(a, attempt, 'alice')).status, 409); assert.equal(f.calls.length, 0);
  f.setTime(NOW);
  for (const code of ['outsider', 'unverified', 'unknown-code']) {
    attempt = await f.start(a); assert.equal((await f.complete(a, attempt, code)).status, 409);
  }
  f.hooks.tokenInfo = { scope: 'openid email' };
  attempt = await f.start(a); assert.equal((await f.complete(a, attempt, 'alice')).status, 409);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM google_connections').first()).n, 0);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM google_session_connections').first()).n, 0);
});

test('OAuth failure diagnostics expose fixed stages and allowlisted provider codes without private data', async t => {
  const f = await setup(t), a = await f.login();
  const token = 'https://oauth2.googleapis.com/token', info = 'https://oauth2.googleapis.com/tokeninfo', user = 'https://openidconnect.googleapis.com/v1/userinfo';
  const cases = [
    [token, { error: 'invalid_grant', error_description: 'private-code private-token private-secret' }, 400, 'GOOGLE_TOKEN_EXCHANGE_FAILED_INVALID_GRANT'],
    [token, { error: 'unrecognized-private-token' }, 400, 'GOOGLE_TOKEN_EXCHANGE_FAILED'],
    [token, { access_token: 'private-token', token_type: 'Bearer' }, 200, 'GOOGLE_OFFLINE_ACCESS_MISSING'],
    [info, { error: 'private-token' }, 400, 'GOOGLE_TOKENINFO_FAILED'],
    [info, { aud: 'different-client', scope: `openid email ${SEND}` }, 200, 'GOOGLE_CLIENT_MISMATCH'],
    [info, { aud: base.GOOGLE_CLIENT_ID, scope: 'openid email' }, 200, 'GOOGLE_PERMISSIONS_MISSING'],
    [user, { error: 'private-token' }, 500, 'GOOGLE_USERINFO_FAILED'],
    [user, { email: 'person@example.org', email_verified: true, sub: 'subject-alice' }, 200, 'GOOGLE_IDENTITY_INVALID']
  ];
  for (const [endpoint, data, status, expected] of cases) {
    f.hooks.reply = requested => requested === endpoint ? Response.json(data, { status }) : null;
    const attempt = await f.start(a), reply = await f.complete(a, attempt, 'alice');
    assert.equal(reply.status, 409);
    const body = await reply.json(); assert.equal(body.code, expected);
    assert.doesNotMatch(JSON.stringify(body), /private-code|private-token|private-secret|different-client/);
    assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM google_connections').first()).n, 0);
  }
  assert.ok(f.calls.every(call => !call.endpoint.includes('/messages/send')));
});

test('refresh tokens are encrypted with fresh nonces and authenticated identity context', async t => {
  const f = await setup(t), a = await f.login(); await f.connect(a, 'alice');
  const row = await f.database.prepare('SELECT * FROM google_connections').first();
  assert.ok(!JSON.stringify(row).includes('refresh-alice'));
  const context = `ces-google-refresh-v1:${row.google_sub}:${row.client_id}`;
  assert.equal(await decryptGoogleSecret(f.env, row.refresh_ciphertext, context), 'refresh-alice');
  const another = await encryptGoogleSecret(f.env, 'refresh-alice', context);
  assert.notEqual(row.refresh_ciphertext, another);
  await assert.rejects(decryptGoogleSecret(f.env, row.refresh_ciphertext, 'wrong-context'));
  const status = await f.status(a); const text = JSON.stringify(status);
  for (const value of ['refresh-alice', base.GOOGLE_CLIENT_SECRET, base.GOOGLE_TOKEN_ENCRYPTION_KEY, row.refresh_ciphertext, 'subject-alice']) assert.equal(text.includes(value), false);
});

test('two admins have isolated senders, proofs and campaign ownership', async t => {
  const f = await setup(t), a = await f.login(), b = await f.login();
  await f.connect(a, 'alice'); await f.connect(b, 'bob');
  assert.equal((await f.status(a)).from, 'alice@columbia.edu'); assert.equal((await f.status(b)).from, 'bob@columbia.edu');
  assert.equal((await f.request(a, '/api/admin/sending/check', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request(b, '/api/admin/sending/check', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.status(a)).connectionVerified, true); assert.equal((await f.status(b)).connectionVerified, true);
  const draftId = await f.savedDraft();
  const ca = await (await f.request(a, '/api/admin/sending/campaigns', { method: 'POST', body: { draftId, from: 'bob@columbia.edu', connectionId: 'subject-bob' } })).json();
  const cb = await (await f.request(b, '/api/admin/sending/campaigns', { method: 'POST', body: { draftId } })).json();
  assert.notEqual(ca.campaign.id, cb.campaign.id);
  const list = await (await f.request(a, '/api/admin/sending/campaigns')).json(); assert.deepEqual(list.campaigns.map(row => row.id), [ca.campaign.id]);
  f.env.GMAIL_SEND_ENABLED = 'true';
  for (const suffix of ['', '/start', '/pause']) {
    const reply = await f.request(b, `/api/admin/sending/campaigns/${ca.campaign.id}${suffix}`, suffix ? { method: 'POST', body: {} } : {});
    assert.equal(reply.status, 404);
  }
  assert.equal((await f.request(b, '/api/admin/sending/dispatch', { method: 'POST', body: { campaignId: ca.campaign.id } })).status, 404);
  const row = await f.database.prepare('SELECT from_email FROM send_campaigns WHERE id=?').bind(ca.campaign.id).first(); assert.equal(row.from_email, 'alice@columbia.edu');
  assert.equal(f.calls.filter(call => call.endpoint.endsWith('/messages/send')).length, 0);
});

test('disconnect and logout remove only the calling session access without revoking another connection', async t => {
  const f = await setup(t), a = await f.login(), b = await f.login(), c = await f.login();
  await f.connect(a, 'alice'); await f.connect(b, 'bob'); await f.connect(c, 'alice');
  assert.equal((await f.request(a, '/api/admin/google/disconnect', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.status(a)).oauthConnected, false); assert.equal((await f.status(b)).from, 'bob@columbia.edu'); assert.equal((await f.status(c)).from, 'alice@columbia.edu');
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM google_connections').first()).n, 2);
  assert.equal((await f.request(c, '/api/admin/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request(c, '/api/admin/sending/status')).status, 401);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM google_session_connections WHERE session_hash=?').bind(c.hash).first()).n, 0);
  assert.equal(f.calls.some(call => call.endpoint.includes('revoke') || call.endpoint.endsWith('/messages/send')), false);
});

test('newer OAuth completion supersedes an older in-flight completion in the same CES session', async t => {
  const f = await setup(t), a = await f.login();
  let reached, resume;
  const gate = new Promise(resolve => { resume = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.hooks.userinfo = async (name, reply) => { if (name === 'alice') { reached(); await gate; } return reply; };
  const older = await f.start(a), pending = f.complete(a, older, 'alice'); await waiting;
  await f.connect(a, 'bob'); resume();
  assert.equal((await pending).status, 409);
  assert.equal((await f.status(a)).from, 'bob@columbia.edu');
  assert.equal((await f.database.prepare("SELECT COUNT(*) AS n FROM google_connections WHERE google_sub='subject-alice'").first()).n, 0);
});

test('disconnect during OAuth completion prevents the pending credentials from being saved', async t => {
  const f = await setup(t), a = await f.login();
  let reached, resume;
  const gate = new Promise(resolve => { resume = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.hooks.userinfo = async (name, reply) => { reached(); await gate; return reply; };
  const attempt = await f.start(a), pending = f.complete(a, attempt, 'alice'); await waiting;
  assert.equal((await f.request(a, '/api/admin/google/disconnect', { method: 'POST', body: {} })).status, 200);
  resume(); assert.equal((await pending).status, 409);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM google_connections').first()).n, 0);
});

test('a changed Google subject cannot pass live verification with only the same email', async t => {
  const f = await setup(t), a = await f.login(); await f.connect(a, 'alice');
  const scoped = await sessionSendingEnvironment(f.env, a.hash, NOW);
  f.hooks.identity = { sub: 'different-subject' };
  await assert.rejects(createGmailAdapter(scoped.env, { fetchImpl: f.googleFetch }).verify(), error => error.code === 'GOOGLE_ACCOUNT_MISMATCH');
});

test('disconnect during a prepared dispatch prevents any provider send', async t => {
  const f = await setup(t), a = await f.login(); await f.connect(a, 'alice');
  const draftId = await f.savedDraft();
  const campaign = (await (await f.request(a, '/api/admin/sending/campaigns', { method: 'POST', body: { draftId } })).json()).campaign;
  f.env.GMAIL_SEND_ENABLED = 'true';
  assert.equal((await f.request(a, `/api/admin/sending/campaigns/${campaign.id}/start`, { method: 'POST', body: {} })).status, 200);
  let reached, resume;
  const gate = new Promise(resolve => { resume = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.hooks.userinfo = async (name, reply) => { reached(); await gate; return reply; };
  const pending = f.request(a, '/api/admin/sending/dispatch', { method: 'POST', body: { campaignId: campaign.id } });
  await waiting;
  await f.request(a, '/api/admin/google/disconnect', { method: 'POST', body: {} }); resume();
  const reply = await pending; assert.equal(reply.status, 200); assert.equal((await reply.json()).result, 'blocked');
  assert.equal(f.calls.filter(call => call.endpoint.endsWith('/messages/send')).length, 0);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM send_budget').first()).n, 0);
});

test('session expiry during authorization cannot create a persistent Google connection', async t => {
  const f = await setup(t), a = await f.login();
  f.hooks.userinfo = async (name, reply) => { f.setTime(NOW + 12 * 3600000 + 1); return reply; };
  const attempt = await f.start(a); assert.equal((await f.complete(a, attempt, 'alice')).status, 409);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM google_connections').first()).n, 0);
});
