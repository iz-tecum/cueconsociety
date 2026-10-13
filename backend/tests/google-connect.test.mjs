import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, chmod, mkdir, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { parseArguments, readPrivateJson, connectionOptions, createAuthorization, receiveAuthorization, completeAuthorization, saveConnection, run } from '../google-connect.mjs';
import { createGmailAdapter, clearGmailTokenCache } from '../gmail-adapter.mjs';

const SEND = 'https://www.googleapis.com/auth/gmail.send';
const ALIAS = 'https://www.googleapis.com/auth/gmail.settings.basic';
const client = { installed: { client_id: 'test-client.apps.googleusercontent.com', client_secret: 'test-client-secret', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: ['http://localhost'] } };
const config = { GMAIL_PRINCIPAL: 'boardmember@example.edu', GMAIL_FROM: 'boardmember@example.edu', GMAIL_SEND_ENABLED: 'true', ADMIN_EMAIL: 'admin@example.edu' };
const options = connectionOptions(config, client);
const authorization = { code: 'fake-auth-code', verifier: 'fake-verifier', redirectUri: 'http://127.0.0.1:12345/oauth/callback' };

async function privateFiles(t, values = config) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ces-google-connect-')));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json'), clientFile = path.join(directory, 'client.json');
  await writeFile(configFile, JSON.stringify(values), { mode: 0o600 });
  await writeFile(clientFile, JSON.stringify(client), { mode: 0o600 });
  return { directory, configFile, clientFile };
}

function googleMock({ principal = options.principal, verified = true, from = options.from, aliasStatus = 'accepted', aliasResponse, scope = `openid email ${SEND} ${ALIAS}`, refresh = 'private-refresh-token', redirect = 'error' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, redirect);
    assert.ok(init.signal instanceof AbortSignal);
    const body = url === 'https://oauth2.googleapis.com/token' ? { access_token: 'private-access-token', refresh_token: refresh, token_type: 'Bearer', scope }
      : url.startsWith('https://oauth2.googleapis.com/tokeninfo?') ? { aud: client.installed.client_id, scope }
      : url === 'https://openidconnect.googleapis.com/v1/userinfo' ? { email: principal, email_verified: verified, sub: 'google-subject-123' }
        : url === 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs' ? aliasResponse === undefined ? { sendAs: [{ sendAsEmail: from, verificationStatus: aliasStatus }] } : aliasResponse
          : assert.fail(`Unexpected network endpoint: ${url}`);
    return new Response(JSON.stringify(body));
  };
  return { calls, fetchImpl };
}

test('CLI rejects missing, unknown and repeated arguments', () => {
  for (const args of [[], ['--config', '/x'], ['--config', '/x', '--config', '/y'], ['--config', '/x', '--client', '/z', '--send', 'true']]) assert.throws(() => parseArguments(args));
});

test('pending-alias preparation is explicit and does not widen requested scopes', () => {
  const args = ['--config', '/private/config.json', '--client', '/private/client.json'];
  assert.equal(parseArguments([...args, '--allow-pending-alias', 'true'])['--allow-pending-alias'], 'true');
  assert.equal(parseArguments([...args, '--allow-pending-alias', 'false'])['--allow-pending-alias'], 'false');
  for (const value of ['yes', '1', 'TRUE', '']) assert.throws(() => parseArguments([...args, '--allow-pending-alias', value]));
  const values = { ...config, GMAIL_FROM: 'econboard@example.edu', allowPendingAlias: true };
  const strict = connectionOptions(values, client), pending = connectionOptions(values, client, { allowPendingAlias: true });
  assert.equal(strict.allowPendingAlias, false);
  assert.equal(pending.allowPendingAlias, true);
  assert.equal(connectionOptions(values, client, { allowPendingAlias: 'true' }).allowPendingAlias, false);
  assert.deepEqual(pending.scopes, strict.scopes);
});

test('Desktop client, principal and fixed Google endpoints are validated', () => {
  assert.equal(options.principal, config.GMAIL_PRINCIPAL);
  assert.deepEqual(options.scopes, ['openid', 'email', SEND]);
  assert.throws(() => connectionOptions(config, { web: client.installed }), /Desktop/);
  assert.throws(() => connectionOptions(config, { installed: { ...client.installed, token_uri: 'https://evil.example/token' } }), /Google endpoints/);
  assert.throws(() => connectionOptions(config, client, { principal: 'board@example.edu\r\nInjected: yes' }));
  assert.ok(connectionOptions({ ...config, GMAIL_FROM: 'econboard@example.edu' }, client).scopes.includes(ALIAS));
});

test('authorization uses random state, S256 PKCE, offline consent and localhost only', () => {
  const first = createAuthorization(options, authorization.redirectUri), second = createAuthorization(options, authorization.redirectUri);
  const url = new URL(first.url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(first.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.verifier, second.verifier);
  for (const target of ['http://evil.example:123/oauth/callback', 'http://127.0.0.1:123/oauth/callback?evil=1', 'https://127.0.0.1:123/oauth/callback']) assert.throws(() => createAuthorization(options, target));
});

test('callback rejects forged Host and state, then accepts only genuine local callback', async () => {
  const reply = await receiveAuthorization(options, { timeoutMs: 3000, onAuthorizationUrl: async link => {
    const url = new URL(link), callback = new URL(url.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ code: 'fake-code', state: url.searchParams.get('state') }).toString();
    const spoofed = await new Promise((resolve, reject) => {
      const req = request(callback, { headers: { Host: 'evil.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(spoofed, 400);
    const badState = new URL(callback); badState.searchParams.set('state', 'wrong');
    assert.equal((await fetch(badState)).status, 400);
    const good = await fetch(callback);
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await good.text(), /fake-code/);
  } });
  assert.equal(reply.code, 'fake-code');
});

test('OAuth exchange verifies real principal and never sends mail', async () => {
  const mock = googleMock();
  const connection = await completeAuthorization(options, authorization, mock);
  assert.equal(connection.GMAIL_SEND_ENABLED, 'false');
  assert.equal(connection.GMAIL_REFRESH_TOKEN, 'private-refresh-token');
  assert.equal(mock.calls.length, 2);
  const form = new URLSearchParams(mock.calls[0].init.body);
  assert.equal(form.get('code_verifier'), authorization.verifier);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(mock.calls[1].init.headers.Authorization, 'Bearer private-access-token');
  assert.ok(mock.calls.every(call => !call.url.endsWith('/send') && !call.url.endsWith('/verify')));
});

test('callback denial and timeout terminate without saving or exposing provider errors', async () => {
  await assert.rejects(receiveAuthorization(options, { timeoutMs: 3000, onAuthorizationUrl: async link => {
    const url = new URL(link), callback = new URL(url.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ error: 'provider-error-with-private-detail', state: url.searchParams.get('state') }).toString();
    const response = await fetch(callback);
    assert.doesNotMatch(await response.text(), /private-detail/);
  } }), /not granted/);
  await assert.rejects(receiveAuthorization(options, { timeoutMs: 10, onAuthorizationUrl: async () => {} }), /timed out/);
});

test('wrong account, unverified account, missing scopes and absent refresh token fail closed', async () => {
  for (const fixture of [{ principal: 'other@example.edu' }, { verified: false }, { scope: 'openid email' }, { refresh: '' }]) await assert.rejects(completeAuthorization(options, authorization, googleMock(fixture)));
});

test('network and Google errors never expose response credentials', async () => {
  for (const fetchImpl of [async () => { throw new Error('private-token'); }, async () => new Response('private-token', { status: 400 })]) {
    await assert.rejects(completeAuthorization(options, authorization, { fetchImpl }), error => !error.message.includes('private-token'));
  }
});

test('alias requires settings scope and already accepted exact sender', async () => {
  const aliasOptions = connectionOptions({ ...config, GMAIL_FROM: 'econboard@example.edu' }, client);
  const good = googleMock({ from: aliasOptions.from });
  assert.equal((await completeAuthorization(aliasOptions, authorization, good)).GMAIL_FROM, aliasOptions.from);
  assert.equal(good.calls[2].init.method, 'GET');
  for (const fixture of [{ scope: `openid email ${SEND}` }, { from: aliasOptions.from, aliasStatus: 'pending' }, { from: 'different@example.edu' }]) await assert.rejects(completeAuthorization(aliasOptions, authorization, googleMock(fixture)));
});

test('opt-in accepts only a missing or pending alias after successful Google identity and alias reads', async () => {
  const aliasOptions = connectionOptions({ ...config, GMAIL_FROM: 'econboard@example.edu' }, client, { allowPendingAlias: true });
  for (const fixture of [
    { from: aliasOptions.from, aliasStatus: 'pending' },
    { aliasResponse: { sendAs: [] } },
    { aliasResponse: { sendAs: [{ sendAsEmail: config.GMAIL_PRINCIPAL }] } }
  ]) {
    const mock = googleMock(fixture), result = await completeAuthorization(aliasOptions, authorization, mock);
    assert.equal(result.aliasVerified, false); assert.equal(result.connectionPending, 'sender_verification');
    assert.equal(result.GMAIL_SEND_ENABLED, 'false');
    assert.deepEqual(mock.calls.map(call => [call.url, call.init.method]), [
      ['https://oauth2.googleapis.com/token', 'POST'], ['https://openidconnect.googleapis.com/v1/userinfo', 'GET'],
      ['https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', 'GET']
    ]);
  }
  const accepted = await completeAuthorization(aliasOptions, authorization, googleMock({ from: aliasOptions.from }));
  assert.equal(accepted.aliasVerified, true); assert.equal(accepted.connectionPending, null);
  const canonicalScope = `openid https://www.googleapis.com/auth/userinfo.email ${SEND} ${ALIAS}`;
  assert.equal((await completeAuthorization(aliasOptions, authorization, googleMock({ from: aliasOptions.from, scope: canonicalScope }))).aliasVerified, true);
});

test('opt-in never saves on invalid identity, offline tokens or any missing required scope', async t => {
  for (const fixture of [
    { principal: 'other@example.edu' }, { verified: false }, { refresh: '' },
    { scope: `openid email ${ALIAS}` }, { scope: `openid email ${SEND}` },
    { scope: `email ${SEND} ${ALIAS}` }, { scope: `openid ${SEND} ${ALIAS}` }
  ]) {
    const files = await privateFiles(t, { ...config, GMAIL_FROM: 'econboard@example.edu' });
    const before = await readFile(files.configFile);
    const mock = googleMock({ from: 'econboard@example.edu', aliasStatus: 'pending', ...fixture });
    await assert.rejects(run(['--config', files.configFile, '--client', files.clientFile, '--allow-pending-alias', 'true'], { ...mock, receiveAuthorization: async () => authorization }));
    assert.deepEqual(await readFile(files.configFile), before);
    assert.ok(mock.calls.every(call => !call.url.endsWith('/send') && !call.url.endsWith('/verify')));
  }
});

test('opt-in never treats API errors or malformed alias responses as pending verification', async t => {
  const variants = [
    { status: 403 }, { networkError: true }, { aliasResponse: null }, { aliasResponse: {} },
    { aliasResponse: { sendAs: [null] } },
    { aliasResponse: { sendAs: [{ sendAsEmail: 'econboard@example.edu', verificationStatus: 'unknown' }] } }
  ];
  for (const variant of variants) {
    const files = await privateFiles(t, { ...config, GMAIL_FROM: 'econboard@example.edu' });
    const before = await readFile(files.configFile), mock = googleMock(variant);
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/settings/sendAs') && variant.status) return new Response('private-error-detail', { status: variant.status });
      if (url.endsWith('/settings/sendAs') && variant.networkError) throw new Error('private-error-detail');
      return mock.fetchImpl(url, init);
    };
    await assert.rejects(run(['--config', files.configFile, '--client', files.clientFile, '--allow-pending-alias', 'true'], { fetchImpl, receiveAuthorization: async () => authorization }), error => !error.message.includes('private-error-detail'));
    assert.deepEqual(await readFile(files.configFile), before);
  }
});

test('strict default and explicit false leave pending-alias credentials unsaved', async t => {
  for (const flags of [[], ['--allow-pending-alias', 'false']]) {
    const files = await privateFiles(t, { ...config, GMAIL_FROM: 'econboard@example.edu' });
    const before = await readFile(files.configFile), mock = googleMock({ from: 'econboard@example.edu', aliasStatus: 'pending' });
    await assert.rejects(run(['--config', files.configFile, '--client', files.clientFile, ...flags], { ...mock, receiveAuthorization: async () => authorization }), /not an accepted Gmail alias/);
    assert.deepEqual(await readFile(files.configFile), before);
  }
});

test('prepared credentials stay private and disabled while the unchanged runtime blocks the pending alias', async t => {
  clearGmailTokenCache();
  const files = await privateFiles(t, { ...config, GMAIL_FROM: 'econboard@example.edu', GMAIL_UNSUBSCRIBE_ORIGIN: 'https://admin.example.edu' });
  const mock = googleMock({ from: 'econboard@example.edu', aliasStatus: 'pending' });
  const result = await run(['--config', files.configFile, '--client', files.clientFile, '--allow-pending-alias', 'true'], { ...mock, receiveAuthorization: async () => authorization });
  assert.deepEqual(result, { connected: false, oauthConnected: true, principal: config.GMAIL_PRINCIPAL, from: 'econboard@example.edu', sendingEnabled: false, aliasVerified: false, connectionPending: 'sender_verification' });
  assert.doesNotMatch(JSON.stringify(result), /private-access-token|private-refresh-token|test-client-secret/);
  const saved = JSON.parse(await readFile(files.configFile, 'utf8'));
  assert.equal(saved.GMAIL_SEND_ENABLED, 'false'); assert.equal(saved.GMAIL_REFRESH_TOKEN, 'private-refresh-token');
  assert.equal(saved.ADMIN_EMAIL, config.ADMIN_EMAIL); assert.equal(saved.aliasVerified, undefined); assert.equal(saved.connectionPending, undefined);
  assert.equal((await stat(files.configFile)).mode & 0o777, 0o600);
  const runtimeMock = googleMock({ from: 'econboard@example.edu', aliasStatus: 'pending', redirect: 'manual' });
  const runtime = createGmailAdapter(saved, { fetchImpl: runtimeMock.fetchImpl });
  await assert.rejects(runtime.verify(), error => error.code === 'GMAIL_ALIAS_NOT_VERIFIED');
  await assert.rejects(runtime.send('never-send', {}), error => error.code === 'SENDING_DISABLED');
  assert.ok([...mock.calls, ...runtimeMock.calls].every(call => !call.url.endsWith('/send') && !call.url.endsWith('/verify')));
});

test('private files reject broad permissions, broad parent permissions and symlinks', async t => {
  const files = await privateFiles(t);
  assert.equal((await readPrivateJson(files.configFile)).value.ADMIN_EMAIL, config.ADMIN_EMAIL);
  await chmod(files.configFile, 0o644);
  await assert.rejects(readPrivateJson(files.configFile), /owner-only/);
  await chmod(files.configFile, 0o600);
  await chmod(files.directory, 0o755);
  await assert.rejects(readPrivateJson(files.configFile), /mode 700/);
  await chmod(files.directory, 0o700);
  const linked = path.join(files.directory, 'linked.json'); await symlink(files.configFile, linked);
  await assert.rejects(readPrivateJson(linked), /symbolic links/);
  await assert.rejects(readPrivateJson('relative.json'), /absolute/);
});

test('private files cannot reside in a Git checkout', async t => {
  const files = await privateFiles(t);
  await mkdir(path.join(files.directory, '.git'));
  await assert.rejects(readPrivateJson(files.configFile), /Git checkouts/);
});

test('save preserves other settings, forces sending off and uses mode 600', async t => {
  const files = await privateFiles(t), snapshot = await readPrivateJson(files.configFile);
  await saveConnection(snapshot, await completeAuthorization(options, authorization, googleMock()));
  const saved = JSON.parse(await readFile(files.configFile, 'utf8'));
  assert.equal(saved.ADMIN_EMAIL, config.ADMIN_EMAIL);
  assert.equal(saved.GMAIL_SEND_ENABLED, 'false');
  assert.equal(saved.GMAIL_REFRESH_TOKEN, 'private-refresh-token');
  assert.ok(saved.GMAIL_UNSUBSCRIBE_SECRET.length >= 32);
  assert.equal((await stat(files.configFile)).mode & 0o777, 0o600);
});

test('save refuses to overwrite edits made while OAuth was pending', async t => {
  const files = await privateFiles(t), snapshot = await readPrivateJson(files.configFile);
  await writeFile(files.configFile, JSON.stringify({ newer: 'keep me' }));
  await assert.rejects(saveConnection(snapshot, { GMAIL_REFRESH_TOKEN: 'never-save-this' }), /changed/);
  assert.equal(await readFile(files.configFile, 'utf8'), JSON.stringify({ newer: 'keep me' }));
});

test('end-to-end mocked CLI connects without returning tokens or sending', async t => {
  const files = await privateFiles(t), mock = googleMock();
  const result = await run(['--config', files.configFile, '--client', files.clientFile], { ...mock, receiveAuthorization: async () => authorization });
  assert.deepEqual(result, { connected: true, oauthConnected: true, principal: config.GMAIL_PRINCIPAL, from: config.GMAIL_FROM, sendingEnabled: false, aliasVerified: true, connectionPending: null });
  assert.doesNotMatch(JSON.stringify(result), /private-access-token|private-refresh-token|test-client-secret/);
});
