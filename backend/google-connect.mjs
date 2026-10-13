import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const ALIAS_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic';
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALLBACK_PATH = '/oauth/callback';
const usage = 'Use --config /absolute/private/config.json --client /absolute/private/google-desktop-client.json [--principal mailbox@example.edu] [--from sender@example.edu].';
const fail = message => { throw new Error(message); };
const email = value => typeof value === 'string' && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(value.trim()) && value.trim().length <= 254 ? value.trim().toLowerCase() : '';

export function parseArguments(argv) {
  const result = {};
  if (argv.length % 2) fail(usage);
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--config', '--client', '--principal', '--from'].includes(argv[i]) || !argv[i + 1] || result[argv[i]]) fail(usage);
    result[argv[i]] = argv[i + 1];
  }
  if (!result['--config'] || !result['--client']) fail(usage);
  return result;
}

export async function readPrivateJson(filename) {
  if (!path.isAbsolute(filename)) fail('Use absolute paths for both private files.');
  const resolved = path.resolve(filename);
  if (resolved === SOURCE_ROOT || resolved.startsWith(`${SOURCE_ROOT}${path.sep}`)) fail('Keep credential files outside the website source folder.');
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail('Private paths must not contain symbolic links. Use their real absolute paths.');
  }
  const parent = await lstat(path.dirname(resolved));
  if (!parent.isDirectory() || (parent.mode & 0o077) || (process.getuid && parent.uid !== process.getuid())) fail('The private folder must be owned by you and have mode 700.');
  for (let directory = path.dirname(resolved); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    try { await lstat(path.join(directory, '.git')); fail('Keep credential files outside Git checkouts.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536 || info.nlink !== 1 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) fail('Private files must be single-link, owner-only files smaller than 64 KiB.');
    const source = await handle.readFile('utf8');
    let value;
    try { value = JSON.parse(source); } catch { fail('A private file is not valid JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Private JSON must contain an object.');
    return { filename: await realpath(resolved), source, value };
  } finally { await handle.close(); }
}

export function connectionOptions(config, clientJson, overrides = {}) {
  const principal = email(overrides.principal || config.GMAIL_PRINCIPAL);
  const from = email(overrides.from || config.GMAIL_FROM || principal);
  if (!principal || !from) fail('Set the actual Google mailbox in --principal and the desired sender in --from.');
  const client = clientJson.installed;
  if (!client || typeof client.client_id !== 'string' || !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(client.client_id) || typeof client.client_secret !== 'string' || client.client_secret.length < 8) fail('Use a Google Desktop OAuth client JSON file.');
  if (client.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' || client.token_uri !== 'https://oauth2.googleapis.com/token') fail('The OAuth client must use the standard Google endpoints.');
  if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.some(uri => uri === 'http://localhost' || uri === 'http://127.0.0.1')) fail('The Desktop client must allow a localhost loopback redirect.');
  const scopes = ['openid', 'email', SEND_SCOPE, ...(from !== principal ? [ALIAS_SCOPE] : [])];
  return { principal, from, clientId: client.client_id, clientSecret: client.client_secret, scopes };
}

export function createAuthorization(options, redirectUri) {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.pathname !== CALLBACK_PATH || redirect.username || redirect.password || redirect.search || redirect.hash) fail('Use only the local IPv4 callback.');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: options.clientId, redirect_uri: redirectUri, response_type: 'code', scope: options.scopes.join(' '), access_type: 'offline', prompt: 'consent', login_hint: options.principal, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return { state, verifier, redirectUri, url: url.href };
}

export async function receiveAuthorization(options, { onAuthorizationUrl = url => process.stdout.write(`Open this Google authorization link in your browser:\n${url}\n`), timeoutMs = 600000 } = {}) {
  let session, settle, timer, complete = false;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  result.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    const rejectRequest = () => { response.writeHead(400); response.end('Invalid authorization callback.'); };
    if (!session || complete || request.method !== 'GET' || request.headers.host !== new URL(session.redirectUri).host || request.url.length > 16384 || !request.url.startsWith(`${CALLBACK_PATH}?`)) return rejectRequest();
    let url;
    try { url = new URL(request.url, session.redirectUri); } catch { return rejectRequest(); }
    if (url.pathname !== CALLBACK_PATH || url.searchParams.getAll('state').length !== 1) return rejectRequest();
    const supplied = Buffer.from(url.searchParams.get('state'));
    const expected = Buffer.from(session.state);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return rejectRequest();
    if (url.searchParams.has('error')) {
      complete = true; response.end('Authorization was not completed. Return to the terminal.');
      return settle.reject(new Error('Google authorization was not granted.'));
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 8192) return rejectRequest();
    complete = true;
    response.end('Authorization received. Return to the terminal for verification. Sending remains disabled.');
    settle.resolve({ ...session, code });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    session = createAuthorization(options, `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`);
    timer = setTimeout(() => settle.reject(new Error('Google authorization timed out. No credentials were saved.')), timeoutMs);
    await onAuthorizationUrl(session.url);
    return await result;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function googleJson(fetchImpl, url, init) {
  let response;
  try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { fail('Google could not be reached. No credentials were saved.'); }
  if (!response.ok) fail('Google did not accept the connection. No credentials were saved.');
  try { return await response.json(); } catch { fail('Google returned an invalid connection response.'); }
}

export async function completeAuthorization(options, authorization, { fetchImpl = globalThis.fetch } = {}) {
  const tokens = await googleJson(fetchImpl, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, code: authorization.code, code_verifier: authorization.verifier, redirect_uri: authorization.redirectUri, grant_type: 'authorization_code' }).toString() });
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length < 8 || typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length < 8 || String(tokens.token_type).toLowerCase() !== 'bearer') fail('Google did not return offline access. No credentials were saved.');
  const scopes = new Set(String(tokens.scope || '').split(/\s+/));
  if (!scopes.has(SEND_SCOPE) || (options.from !== options.principal && !scopes.has(ALIAS_SCOPE))) fail('The required Gmail permissions were not granted.');
  const headers = { Authorization: `Bearer ${tokens.access_token}` };
  const user = await googleJson(fetchImpl, 'https://openidconnect.googleapis.com/v1/userinfo', { method: 'GET', headers });
  if (user.email_verified !== true || email(user.email) !== options.principal || typeof user.sub !== 'string' || !user.sub) fail('The authorized Google account does not match the expected verified mailbox.');
  if (options.from !== options.principal) {
    const aliases = await googleJson(fetchImpl, 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', { method: 'GET', headers });
    if (!Array.isArray(aliases.sendAs) || !aliases.sendAs.some(alias => email(alias.sendAsEmail) === options.from && alias.verificationStatus === 'accepted')) fail('The sender is not an accepted Gmail alias. No alias was created and no email was sent.');
  }
  return { GMAIL_CLIENT_ID: options.clientId, GMAIL_CLIENT_SECRET: options.clientSecret, GMAIL_REFRESH_TOKEN: tokens.refresh_token, GMAIL_PRINCIPAL: options.principal, GMAIL_FROM: options.from, GMAIL_SEND_ENABLED: 'false' };
}

export async function saveConnection(snapshot, connection) {
  const current = await readPrivateJson(snapshot.filename);
  if (current.source !== snapshot.source) fail('The config changed during authorization. No credentials were saved.');
  const updated = { ...current.value, ...connection, GMAIL_SEND_ENABLED: 'false' };
  if (!updated.GMAIL_UNSUBSCRIBE_SECRET) updated.GMAIL_UNSUBSCRIBE_SECRET = randomBytes(32).toString('base64url');
  const temporary = `${snapshot.filename}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    const beforeReplace = await readPrivateJson(snapshot.filename);
    if (beforeReplace.source !== snapshot.source) fail('The config changed during authorization. No credentials were saved.');
    await rename(temporary, snapshot.filename);
  } finally { if (handle) await handle.close(); await unlink(temporary).catch(() => {}); }
}

export async function run(argv, dependencies = {}) {
  const flags = parseArguments(argv);
  const config = await readPrivateJson(flags['--config']);
  const client = await readPrivateJson(flags['--client']);
  if (config.filename === client.filename) fail('Config and OAuth client must be different files.');
  const options = connectionOptions(config.value, client.value, { principal: flags['--principal'], from: flags['--from'] });
  const authorization = await (dependencies.receiveAuthorization || receiveAuthorization)(options, dependencies);
  const connection = await completeAuthorization(options, authorization, dependencies);
  await saveConnection(config, connection);
  return { connected: true, principal: options.principal, from: options.from, sendingEnabled: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  run(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\nCredentials saved privately. Sending remains disabled; no message was sent.\n`)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
