const encoder = new TextEncoder();
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const CALLBACK = '/api/admin/google/callback';
const BINDING_COOKIE = '__Host-ces_google_oauth';
const TTL = 600000;

export class GoogleConnectionError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
function reject(message, status = 409) { throw new GoogleConnectionError(message, status); }
function base64(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function unbase64(value) { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0)); }
function random() { return base64(crypto.getRandomValues(new Uint8Array(32))); }
async function digest(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(value => value.toString(16).padStart(2, '0')).join(''); }
function cookie(value, age = TTL / 1000) { return `${BINDING_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`; }
function binding(request) {
  const matches = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${BINDING_COOKIE}=`));
  const value = matches.length === 1 ? matches[0].slice(BINDING_COOKIE.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}
function response(body, extra = {}) {
  return Response.json({ ok: true, ...body }, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } });
}
function columbiaEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[a-z0-9._+-]+@columbia\.edu$/.test(email) && !email.startsWith('.') && !email.includes('..') ? email : '';
}

export function googleSessionConfiguration(env) {
  let redirect = '';
  try {
    const url = new URL(env.GOOGLE_REDIRECT_URI);
    if (url.protocol === 'https:' && url.pathname === CALLBACK && !url.search && !url.hash && !url.username && !url.password) redirect = url.href;
  } catch {}
  const enabled = env.GOOGLE_SESSION_OAUTH_ENABLED === 'true';
  const available = Boolean(enabled && /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID || '') &&
    typeof env.GOOGLE_CLIENT_SECRET === 'string' && env.GOOGLE_CLIENT_SECRET.length >= 8 &&
    /^[A-Za-z0-9_-]{43}$/.test(env.GOOGLE_TOKEN_ENCRYPTION_KEY || '') && redirect);
  return { enabled, available, redirect };
}
async function key(env) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(env.GOOGLE_TOKEN_ENCRYPTION_KEY || '')) reject('Google connection is not configured.', 503);
  const bytes = unbase64(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  if (bytes.length !== 32) reject('Google connection is not configured.', 503);
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function encryptGoogleSecret(env, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await key(env), encoder.encode(value));
  return `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}
export async function decryptGoogleSecret(env, value, context) {
  try {
    const [version, iv, ciphertext, extra] = String(value).split('.');
    if (version !== 'v1' || extra || !/^[A-Za-z0-9_-]{16}$/.test(iv) || !/^[A-Za-z0-9_-]{22,32768}$/.test(ciphertext)) throw new Error();
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv), additionalData: encoder.encode(context) }, await key(env), unbase64(ciphertext));
    return new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
  } catch { reject('Reconnect the Google account. Its stored credentials could not be opened.'); }
}

async function activeSession(env, sessionHash, now) {
  return env.DB.prepare('SELECT 1 AS active FROM sessions WHERE token_hash=? AND expires_at>?').bind(sessionHash, now).first();
}
async function connection(env, sessionHash, now) {
  return env.DB.prepare(`SELECT c.* FROM google_session_connections l JOIN google_connections c ON c.google_sub=l.google_sub
    JOIN sessions s ON s.token_hash=l.session_hash WHERE l.session_hash=? AND s.expires_at>? AND c.client_id=?`)
    .bind(sessionHash, now, env.GOOGLE_CLIENT_ID || '').first();
}
export async function googleSessionStatus(env, sessionHash, now = Date.now()) {
  const config = googleSessionConfiguration(env);
  const linked = config.available ? await connection(env, sessionHash, now) : null;
  return { oauthRequired: config.enabled, oauthAvailable: config.available, oauthConnected: Boolean(linked), oauthEmail: linked?.email || null };
}
export async function sessionSendingEnvironment(env, sessionHash, now = Date.now()) {
  if (!googleSessionConfiguration(env).enabled) return { env, status: { oauthRequired: false, oauthAvailable: false, oauthConnected: false, oauthEmail: null } };
  const status = await googleSessionStatus(env, sessionHash, now);
  const isolated = { ...env, GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: '', GMAIL_PRINCIPAL: '', GMAIL_FROM: '',
    GMAIL_CONNECTION_ID: '', GMAIL_SESSION_OAUTH: 'true', GMAIL_SESSION_HASH: sessionHash };
  if (!status.oauthConnected) return { env: isolated, status };
  const linked = await connection(env, sessionHash, now);
  if (!linked || !columbiaEmail(linked.email)) reject('Reconnect the Columbia account.');
  const refreshToken = await decryptGoogleSecret(env, linked.refresh_ciphertext, `ces-google-refresh-v1:${linked.google_sub}:${linked.client_id}`);
  return { env: { ...isolated, GMAIL_CLIENT_ID: env.GOOGLE_CLIENT_ID, GMAIL_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN: refreshToken, GMAIL_PRINCIPAL: linked.email, GMAIL_FROM: linked.email, GMAIL_CONNECTION_ID: linked.google_sub }, status };
}

async function googleJSON(fetchImpl, url, init) {
  let reply;
  try { reply = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { reject('Google could not be reached. Please start the connection again.'); }
  if (!reply.ok) reject('Google did not accept the connection. Please start again.');
  try { return await reply.json(); } catch { reject('Google returned an invalid connection response.'); }
}
async function readIdentity(env, authorization, verifier, fetchImpl) {
  const tokens = await googleJSON(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code: authorization,
      code_verifier: verifier, redirect_uri: env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' }).toString()
  });
  if (typeof tokens?.access_token !== 'string' || tokens.access_token.length < 8 || tokens.access_token.length > 16384 ||
      typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length < 8 || tokens.refresh_token.length > 16384 || String(tokens.token_type).toLowerCase() !== 'bearer') reject('Google did not provide offline access. Please connect again.');
  const info = await googleJSON(fetchImpl, `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(tokens.access_token)}`, { method: 'GET' });
  const scopes = new Set(String(info?.scope || '').split(/\s+/));
  if (info?.aud !== env.GOOGLE_CLIENT_ID || !scopes.has(SEND_SCOPE) || !scopes.has('openid') || !(scopes.has('email') || scopes.has(EMAIL_SCOPE))) reject('The required Google permissions were not granted.');
  const identity = await googleJSON(fetchImpl, 'https://openidconnect.googleapis.com/v1/userinfo', { method: 'GET', headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const email = columbiaEmail(identity?.email);
  if (identity?.email_verified !== true || !email || typeof identity.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(identity.sub) || (info.sub && info.sub !== identity.sub)) reject('Connect a verified Columbia Google account.');
  return { sub: identity.sub, email, refreshToken: tokens.refresh_token };
}

function exactCallback(request, env) {
  const config = googleSessionConfiguration(env);
  if (!config.available || new URL(request.url).origin !== new URL(config.redirect).origin) reject('Google connection is not configured for this site.', 503);
  return config;
}
export async function handleGoogleSession(request, env, { sessionHash, now = Date.now(), clock = Date.now, readJSON, fetchImpl = globalThis.fetch } = {}) {
  const route = new URL(request.url).pathname;
  if (route === '/api/admin/google/status' && request.method === 'GET') return response(await googleSessionStatus(env, sessionHash, now));
  exactCallback(request, env);
  if (route === '/api/admin/google/start' && request.method === 'POST') {
    await readJSON(request, 4096);
    if (!await activeSession(env, sessionHash, now)) reject('Sign in to CES again.', 401);
    const state = random(), bind = random(), verifier = random(), hash = await digest(state);
    const ciphertext = await encryptGoogleSecret(env, verifier, `ces-google-pkce-v1:${hash}:${sessionHash}`);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM google_oauth_states WHERE session_hash=? OR expires_at<=?').bind(sessionHash, now),
      env.DB.prepare('INSERT INTO google_oauth_states(state_hash,session_hash,binding_hash,pkce_ciphertext,client_id,expires_at) VALUES(?,?,?,?,?,?)')
        .bind(hash, sessionHash, await digest(bind), ciphertext, env.GOOGLE_CLIENT_ID, now + TTL)
    ]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.GOOGLE_REDIRECT_URI, response_type: 'code',
      scope: `openid email ${SEND_SCOPE}`, access_type: 'offline', prompt: 'consent select_account', hd: 'columbia.edu', state,
      code_challenge: base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))), code_challenge_method: 'S256' }).toString();
    return response({ url: url.href }, { 'Set-Cookie': cookie(bind) });
  }
  if (route === '/api/admin/google/complete' && request.method === 'POST') {
    const body = await readJSON(request, 16384), bind = binding(request);
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.state || '') || !bind ||
        (body.error === undefined && (typeof body.code !== 'string' || !body.code || body.code.length > 8192))) reject('This connection attempt is invalid. Start again.', 400);
    const hash = await digest(body.state);
    const claimed = await env.DB.prepare(`UPDATE google_oauth_states SET consumed_at=? WHERE state_hash=? AND session_hash=? AND binding_hash=? AND expires_at>? AND client_id=? AND consumed_at IS NULL
      AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?) RETURNING *`)
      .bind(now, hash, sessionHash, await digest(bind), now, env.GOOGLE_CLIENT_ID, sessionHash, now).all();
    if (!claimed.results.length) reject('This connection attempt expired or belongs to another CES session. Start again.');
    if (body.error !== undefined) reject('Google authorization was not completed.');
    const verifier = await decryptGoogleSecret(env, claimed.results[0].pkce_ciphertext, `ces-google-pkce-v1:${hash}:${sessionHash}`);
    const identity = await readIdentity(env, body.code, verifier, fetchImpl);
    const checkedAt = clock();
    const ciphertext = await encryptGoogleSecret(env, identity.refreshToken, `ces-google-refresh-v1:${identity.sub}:${env.GOOGLE_CLIENT_ID}`);
    const saved = await env.DB.batch([
      env.DB.prepare(`INSERT INTO google_connections(google_sub,email,client_id,refresh_ciphertext,updated_at) SELECT ?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM google_oauth_states o JOIN sessions s ON s.token_hash=o.session_hash
          WHERE o.state_hash=? AND o.session_hash=? AND o.consumed_at=? AND o.expires_at>? AND s.expires_at>?)
        ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,client_id=excluded.client_id,refresh_ciphertext=excluded.refresh_ciphertext,updated_at=excluded.updated_at`)
        .bind(identity.sub, identity.email, env.GOOGLE_CLIENT_ID, ciphertext, new Date(checkedAt).toISOString(), hash, sessionHash, now, checkedAt, checkedAt),
      env.DB.prepare(`INSERT INTO google_session_connections(session_hash,google_sub,connected_at) SELECT ?,?,?
        WHERE EXISTS(SELECT 1 FROM google_oauth_states o JOIN sessions s ON s.token_hash=o.session_hash
          WHERE o.state_hash=? AND o.session_hash=? AND o.consumed_at=? AND o.expires_at>? AND s.expires_at>?)
        ON CONFLICT(session_hash) DO UPDATE SET google_sub=excluded.google_sub,connected_at=excluded.connected_at RETURNING google_sub`)
        .bind(sessionHash, identity.sub, new Date(checkedAt).toISOString(), hash, sessionHash, now, checkedAt, checkedAt),
      env.DB.prepare('DELETE FROM google_oauth_states WHERE state_hash=? AND session_hash=?').bind(hash, sessionHash)
    ]);
    if (!saved[1].results.length) reject('This Google connection was superseded or the CES session expired. Connect again.');
    return response({ connected: true, email: identity.email, sendingEnabled: env.GMAIL_SEND_ENABLED === 'true' }, { 'Set-Cookie': cookie('', 0) });
  }
  if (route === '/api/admin/google/disconnect' && request.method === 'POST') {
    await readJSON(request, 4096);
    const linked = await connection(env, sessionHash, now);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM google_oauth_states WHERE session_hash=?').bind(sessionHash),
      env.DB.prepare('DELETE FROM google_session_connections WHERE session_hash=?').bind(sessionHash),
      env.DB.prepare('DELETE FROM google_connections WHERE google_sub=? AND NOT EXISTS(SELECT 1 FROM google_session_connections WHERE google_sub=?)')
        .bind(linked?.google_sub || '', linked?.google_sub || '')
    ]);
    return response({ connected: false }, { 'Set-Cookie': cookie('', 0) });
  }
  reject('Not found.', 404);
}

export async function googleCallbackPage(request, env, now = Date.now()) {
  exactCallback(request, env);
  const url = new URL(request.url), state = url.searchParams.get('state'), bind = binding(request);
  if (request.method !== 'GET' || url.searchParams.getAll('state').length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(state || '') || !bind) reject('This connection attempt is invalid. Return to CES and connect again.', 400);
  const valid = await env.DB.prepare(`SELECT 1 AS valid FROM google_oauth_states o JOIN sessions s ON s.token_hash=o.session_hash
    WHERE o.state_hash=? AND o.binding_hash=? AND o.expires_at>? AND s.expires_at>? AND o.client_id=? AND o.consumed_at IS NULL`)
    .bind(await digest(state), await digest(bind), now, now, env.GOOGLE_CLIENT_ID).first();
  if (!valid) reject('This connection attempt expired. Return to CES and connect again.');
  const nonce = random();
  const script = `(async()=>{const query=new URLSearchParams(location.search);const state=query.get('state'),code=query.get('code'),error=query.get('error');history.replaceState(null,'','/api/admin/google/callback');try{if(query.getAll('code').length>1||query.getAll('error').length>1)throw Error();const session=await fetch('/api/admin/session',{credentials:'same-origin',cache:'no-store'});if(!session.ok)throw Error();const data=await session.json();const result=await fetch('/api/admin/google/complete',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':data.csrfToken},body:JSON.stringify({state,...(error!==null?{error}:{code})})});location.replace(result.ok?'/admin/?google=connected':'/admin/?google=error')}catch{location.replace('/admin/?google=error')}})();`;
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Google</title><p>Finishing your Google connection…</p><script nonce="${nonce}">${script}</script></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` }
  });
}
