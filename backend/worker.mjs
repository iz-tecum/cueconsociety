import { importRecords } from './import.mjs';
import { handleSending, handleUnsubscribe, SendingError } from './send-queue.mjs';
import { GmailError } from './gmail-adapter.mjs';

const STATUSES = new Set(['subscribed', 'unsubscribed', 'cleaned', 'archived', 'pending']);
const SUPPRESSED = new Set(['unsubscribed', 'cleaned', 'archived']);
const INTERESTS = new Set(['events', 'careers', 'research', 'social']);
const GENERIC_MESSAGE = 'Your request has been received.';
const COOKIE = '__Host-ces_session';
const MAX_CONTACTS = 25000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const PASSWORD_ITERATIONS = 100000;
const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(message, status = 400) { throw new HttpError(message, status); }
function nowISO(now) { return new Date(now).toISOString(); }
function hex(bytes) { return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join(''); }
function base64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function unbase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22,86}$/.test(value)) fail('Service is not configured.', 503);
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function sha256(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function hmac(secret, value) {
  if (typeof secret !== 'string' || secret.length < 32) fail('Service is not configured.', 503);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = encoder.encode(left), b = encoder.encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') fail('Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(email)) fail('Enter a valid email address.');
  const [local, domain] = email.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      domain.split('.').some(part => !part.length || part.length > 63 || part.startsWith('-') || part.endsWith('-'))) fail('Enter a valid email address.');
  return email;
}
function textField(value, max, label, required = false, multiline = false) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail(`Enter a valid ${label}.`);
  const text = value.trim().normalize('NFC');
  if (required && !text) fail(`Enter a ${label}.`);
  return text;
}
export function validateNewsletter(body, now = Date.now()) {
  if (!object(body)) fail('Send a JSON object.');
  if (body.website !== undefined && (typeof body.website !== 'string' || body.website.length > 200)) fail('Invalid form fields.');
  if (body.website?.trim()) return { honeypot: true };
  if (!['subscribe', 'unsubscribe'].includes(body.action)) fail('Choose a valid action.');
  const email = normalizeEmail(body.email);
  if (body.action === 'unsubscribe') {
    if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) fail('Use the complete private unsubscribe link.');
    return { action: 'unsubscribe', email, token: body.token };
  }
  if (body.consent !== true) fail('Confirm that you want CES email updates.');
  const interests = body.interests ?? [];
  if (!Array.isArray(interests) || interests.length > 4 || interests.some(value => !INTERESTS.has(value))) fail('Choose valid newsletter topics.');
  if (body.startedAt !== undefined && (!Number.isSafeInteger(body.startedAt) || body.startedAt > now + 30000 || body.startedAt < now - 7 * 86400000)) fail('Refresh the page and try again.');
  return { action: 'subscribe', email, name: textField(body.name ?? '', 100, 'name'), interests: [...new Set(interests)] };
}
export function validateContact(body) {
  if (!object(body)) fail('Send a JSON object.');
  if (body.website !== undefined && (typeof body.website !== 'string' || body.website.length > 200)) fail('Invalid form fields.');
  if (body.website?.trim()) return { honeypot: true };
  return {
    email: normalizeEmail(body.email), name: textField(body.name ?? '', 100, 'name', true),
    subject: textField(body.subject ?? '', 200, 'subject'), message: textField(body.message ?? '', 5000, 'message', true, true)
  };
}
export function validateDraft(body, now = Date.now()) {
  if (!object(body)) fail('Send a JSON object.');
  const id = body.id || crypto.randomUUID();
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) fail('Invalid draft ID.');
  const recipientIds = body.recipientIds ?? [];
  if (!Array.isArray(recipientIds) || recipientIds.length > MAX_CONTACTS || recipientIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) fail('Invalid recipient selection.');
  return {
    id, title: textField(body.title ?? '', 200, 'draft title'), subject: textField(body.subject ?? '', 200, 'subject'),
    preheader: textField(body.preheader ?? '', 300, 'preview text'), body: textField(body.body ?? '', 50000, 'message', false, true),
    recipientIds: [...new Set(recipientIds)], updatedAt: nowISO(now)
  };
}

export async function readJSON(request, maximum = 16384) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) fail('Send JSON.', 415);
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) fail('This request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) fail('Send a JSON object.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); fail('This request is too large.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!object(body)) fail('Send a JSON object.'); return body; }
  catch (error) { if (error instanceof HttpError) throw error; fail('Send valid JSON.'); }
}

function response(body, status = 200, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...extra
  } });
}
export function publicOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return null;
  const own = new URL(request.url).origin;
  const origins = String(env.PUBLIC_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const secure = value => value.startsWith('https://') || (env.ENVIRONMENT === 'development' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value));
  return secure(origin) && (origin === own || origins.includes(origin)) ? origin : null;
}
function sameOrigin(request, requireOrigin = false) {
  const origin = request.headers.get('origin');
  if ((requireOrigin && !origin) || (origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') fail('This request is not allowed.', 403);
}
async function clientKey(request, env) {
  let ip = env.CLIENT_IP || request.headers.get('CF-Connecting-IP');
  if (!ip && env.ENVIRONMENT === 'development') ip = '127.0.0.1';
  if (!ip || ip.length > 64 || !/^[a-fA-F0-9:.]+$/.test(ip)) fail('Service is temporarily unavailable.', 503);
  return hmac(env.RATE_LIMIT_SECRET, `ces-ip-v1:${ip.toLowerCase()}`);
}
async function takeRate(env, request, scope, now, hourly = 5, daily = 15, globalDaily = 200) {
  const client = await clientKey(request, env), hour = Math.floor(now / 3600000), day = Math.floor(now / 86400000);
  const counters = [
    [`${scope}:h:${hour}:${client}`, hourly, (hour + 1) * 3600000],
    [`${scope}:d:${day}:${client}`, daily, (day + 1) * 86400000],
    [`${scope}:g:${day}`, globalDaily, (day + 1) * 86400000]
  ];
  const statements = counters.map(([key, cap, expiry]) => env.DB.prepare(
    'INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count'
  ).bind(key, expiry, cap));
  statements.push(env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now - 86400000));
  const results = await env.DB.batch(statements);
  if (results.slice(0, 3).some(result => result.results.length !== 1)) fail('Too many requests. Please try again later.', 429);
}

async function newsletter(request, env, now) {
  const input = validateNewsletter(await readJSON(request, 4096), now);
  if (input.honeypot) return response({ ok: true, message: GENERIC_MESSAGE, manageToken: randomToken() });
  await takeRate(env, request, 'newsletter', now);
  const at = nowISO(now), token = randomToken();
  if (input.action === 'subscribe') {
    const record = {
      email: input.email, name: input.name, status: 'subscribed', interests: input.interests,
      createdAt: at, updatedAt: at, consent: { method: 'web-single-opt-in', at, policy: 'ces-newsletter-v1' },
      sources: [{ source: 'ces-website', status: 'subscribed', at }]
    };
    const result = await env.DB.prepare(
      'INSERT INTO contacts(id,email,status,record_json,unsubscribe_token_hash,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM contacts) < ? ON CONFLICT(email) DO NOTHING'
    ).bind(await sha256(input.email), input.email, 'subscribed', JSON.stringify(record), await sha256(token), at, at, MAX_CONTACTS).run();
    if (!result.meta.changes) {
      const capacity = await env.DB.prepare('SELECT COUNT(*) AS total FROM contacts').first();
      if (capacity.total >= MAX_CONTACTS) fail('Signup is temporarily unavailable. Please try again later.', 503);
    }
    return response({ ok: true, message: GENERIC_MESSAGE, manageToken: token });
  }
  const source = JSON.stringify({ source: 'ces-private-unsubscribe-link', status: 'unsubscribed', at });
  await env.DB.prepare(
    "UPDATE contacts SET status='unsubscribed', updated_at=?, record_json=json_set(record_json,'$.status','unsubscribed','$.updatedAt',?,'$.sources',json_insert(COALESCE(json_extract(record_json,'$.sources'),'[]'),'$[#]',json(?))) WHERE email=? AND unsubscribe_token_hash=? AND status IN ('subscribed','pending')"
  ).bind(at, at, source, input.email, await sha256(input.token)).run();
  return response({ ok: true, message: GENERIC_MESSAGE });
}
async function contact(request, env, now) {
  const input = validateContact(await readJSON(request, 16384));
  if (input.honeypot) return response({ ok: true, message: GENERIC_MESSAGE });
  await takeRate(env, request, 'contact', now, 3, 10, 200);
  const result = await env.DB.prepare('INSERT INTO messages(id,name,email,subject,message,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM messages) < 10000')
    .bind(crypto.randomUUID(), input.name, input.email, input.subject, input.message, nowISO(now)).run();
  if (!result.meta.changes) fail('Messages are temporarily unavailable. Please email CES directly.', 503);
  return response({ ok: true, message: 'Your message was saved for the CES board.' });
}

export async function derivePassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unbase64url(salt), iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' }, key, 256));
}
function cookie(value, maxAge = SESSION_MS / 1000) { return `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`; }
function sessionToken(request) {
  const pairs = (request.headers.get('cookie') || '').split(';').map(value => value.trim().split('='));
  const values = pairs.filter(([key]) => key === COOKIE);
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0][1] || '')) return null;
  return values[0][1];
}
async function authenticate(request, env, now, write = false) {
  sameOrigin(request, write);
  const token = sessionToken(request);
  if (!token) fail('Please sign in.', 401);
  const found = await env.DB.prepare('SELECT email,expires_at FROM sessions WHERE token_hash=? AND expires_at>?').bind(await sha256(token), now).first();
  if (!found || found.email !== env.ADMIN_EMAIL?.trim().toLowerCase()) fail('Please sign in.', 401);
  const csrfToken = await hmac(env.SESSION_SECRET, `ces-csrf-v1:${token}`);
  if (write && !constantTimeEqual(request.headers.get('X-CSRF-Token') || '', csrfToken)) fail('Refresh the page and try again.', 403);
  return { email: found.email, csrfToken, token };
}
async function login(request, env, now) {
  sameOrigin(request, true);
  const body = await readJSON(request, 4096);
  await takeRate(env, request, 'login', now, 10, 30, 1000);
  if (!env.ADMIN_EMAIL || !/^[a-f0-9]{64}$/.test(env.ADMIN_PASSWORD_HASH || '') || !env.ADMIN_PASSWORD_SALT) fail('Sign-in is not configured.', 503);
  const email = typeof body.email === 'string' && body.email.length < 255 ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' && body.password.length <= 1024 ? body.password : '';
  const derived = await derivePassword(password, env.ADMIN_PASSWORD_SALT);
  if (!constantTimeEqual(email, env.ADMIN_EMAIL.trim().toLowerCase()) || !constantTimeEqual(derived, env.ADMIN_PASSWORD_HASH)) fail('Email or password is incorrect.', 401);
  const token = randomToken(), csrfToken = await hmac(env.SESSION_SECRET, `ces-csrf-v1:${token}`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('INSERT INTO sessions(token_hash,email,created_at,expires_at) VALUES(?,?,?,?)').bind(await sha256(token), email, now, now + SESSION_MS)
  ]);
  return response({ ok: true, email, csrfToken }, 200, { 'Set-Cookie': cookie(token) });
}

function serializeContact(row) {
  const record = JSON.parse(row.record_json);
  return {
    id: row.id, email: row.email, name: typeof record.name === 'string' ? record.name : '', status: row.status,
    interests: Array.isArray(record.interests) ? record.interests : [], sources: Array.isArray(record.sources) ? record.sources : [],
    consent: record.consent ?? null, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
async function audience(env) {
  const data = await env.DB.prepare('SELECT id,email,status,record_json,created_at,updated_at FROM contacts ORDER BY email').all();
  const records = data.results.map(serializeContact);
  return { records, updatedAt: records.reduce((latest, record) => record.updatedAt > latest ? record.updatedAt : latest, '') || null };
}
export function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function csv(records) {
  const columns = ['id', 'email', 'name', 'status', 'interests', 'createdAt', 'updatedAt', 'consent', 'sources'];
  return [columns.map(csvCell).join(','), ...records.map(record => columns.map(column => csvCell(record[column])).join(','))].join('\r\n') + '\r\n';
}
async function updateStatus(body, env, now) {
  if (!object(body) || !SUPPRESSED.has(body.status) || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 5000 || body.ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) fail('Choose contacts and an unsubscribe, cleaned, or archived status.');
  const ids = [...new Set(body.ids)], at = nowISO(now), source = JSON.stringify({ source: 'ces-maildesk-admin', status: body.status, at });
  const statements = [];
  for (let offset = 0; offset < ids.length; offset += 75) {
    const part = ids.slice(offset, offset + 75);
    statements.push(env.DB.prepare(`UPDATE contacts SET status=?,updated_at=?,record_json=json_set(record_json,'$.status',?,'$.updatedAt',?,'$.sources',json_insert(COALESCE(json_extract(record_json,'$.sources'),'[]'),'$[#]',json(?))) WHERE id IN (${part.map(() => '?').join(',')}) AND status <> ?`)
      .bind(body.status, at, body.status, at, source, ...part, body.status));
  }
  statements.push(env.DB.prepare('INSERT INTO audit(id,action,detail_json,created_at) VALUES(?,?,?,?)').bind(crypto.randomUUID(), 'contacts-suppressed', JSON.stringify({ ids, status: body.status }), at));
  const changes = await env.DB.batch(statements);
  return response({ ok: true, updated: changes.slice(0, -1).reduce((total, result) => total + result.meta.changes, 0), updatedAt: at });
}
async function admin(request, env, now, url, gmailFetch) {
  const path = url.pathname;
  if (path === '/api/admin/login' && request.method === 'POST') return login(request, env, now);
  const write = !['GET', 'HEAD'].includes(request.method);
  const session = await authenticate(request, env, now, write);
  if (path.startsWith('/api/admin/sending/')) return handleSending(request, env, { now, readJSON, fetchImpl: gmailFetch });
  if (path === '/api/admin/session' && request.method === 'GET') return response({ ok: true, email: session.email, csrfToken: session.csrfToken });
  if (path === '/api/admin/logout' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(session.token)).run();
    return response({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (path === '/api/admin/audience' && request.method === 'GET') return response({ ok: true, ...await audience(env) });
  if (path === '/api/admin/import' && request.method === 'POST') {
    const body = await readJSON(request, 524288);
    try { return response({ ok: true, ...await importRecords(env.DB, body.records, { now }) }); }
    catch (error) { if (error instanceof HttpError) throw error; fail('Import failed. Check the contact records and try again.', 400); }
  }
  if (path === '/api/admin/export' && request.method === 'GET') {
    const format = url.searchParams.get('format') || 'json';
    if (!['csv', 'json'].includes(format)) fail('Choose CSV or JSON.');
    let { records } = await audience(env);
    if (url.searchParams.get('status') === 'subscribed') records = records.filter(row => row.status === 'subscribed');
    const result = response(null);
    const headers = new Headers(result.headers);
    headers.set('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    headers.set('Content-Disposition', `attachment; filename="CES_Audience.${format}"`);
    return new Response(format === 'csv' ? csv(records) : JSON.stringify(records, null, 2), { headers });
  }
  if (path === '/api/admin/contacts/status' && request.method === 'POST') return updateStatus(await readJSON(request, 400000), env, now);
  if (/^\/api\/admin\/contacts\/[a-f0-9]{64}$/.test(path) && request.method === 'PATCH') {
    const body = await readJSON(request, 4096);
    return updateStatus({ ids: [path.split('/').pop()], status: body.status }, env, now);
  }
  if (path === '/api/admin/messages' && request.method === 'GET') {
    const data = await env.DB.prepare('SELECT id,name,email,subject,message,created_at AS createdAt FROM messages ORDER BY created_at DESC LIMIT 1000').all();
    return response({ ok: true, messages: data.results });
  }
  if (path === '/api/admin/drafts' && request.method === 'GET') {
    const data = await env.DB.prepare('SELECT id,title,subject,preheader,body,recipient_ids_json,updated_at AS updatedAt FROM drafts ORDER BY updated_at DESC LIMIT 200').all();
    return response({ ok: true, drafts: data.results.map(({ recipient_ids_json, ...draft }) => ({ ...draft, recipientIds: JSON.parse(recipient_ids_json) })) });
  }
  if (path === '/api/admin/drafts' && request.method === 'POST') {
    const draft = validateDraft(await readJSON(request, 2000000), now);
    const selected = draft.recipientIds.length ? await env.DB.prepare("SELECT id FROM contacts WHERE status='subscribed' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(draft.recipientIds)).all() : { results: [] };
    draft.recipientIds = selected.results.map(row => row.id);
    const result = await env.DB.prepare('INSERT INTO drafts(id,title,subject,preheader,body,recipient_ids_json,updated_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM drafts) < 200 OR EXISTS(SELECT 1 FROM drafts WHERE id=?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,subject=excluded.subject,preheader=excluded.preheader,body=excluded.body,recipient_ids_json=excluded.recipient_ids_json,updated_at=excluded.updated_at')
      .bind(draft.id, draft.title, draft.subject, draft.preheader, draft.body, JSON.stringify(draft.recipientIds), draft.updatedAt, draft.id).run();
    if (!result.meta.changes) fail('The draft limit has been reached.', 409);
    return response({ ok: true, draft });
  }
  fail('Not found.', 404);
}

export function createWorker({ clock = Date.now, gmailFetch } = {}) {
  return { async fetch(request, env) {
    const url = new URL(request.url), now = clock();
    const isPublic = ['/api/newsletter', '/api/contact'].includes(url.pathname);
    let cors = {};
    try {
      if (['/unsubscribe', '/api/unsubscribe'].includes(url.pathname)) return await handleUnsubscribe(request, env, now);
      if (isPublic) {
        const origin = publicOrigin(request, env);
        if (!origin) fail('This request is not allowed.', 403);
        cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
        if (request.method === 'OPTIONS') return response(null, 204, cors);
        if (request.method !== 'POST') fail('Use the form.', 405);
        const result = url.pathname === '/api/newsletter' ? await newsletter(request, env, now) : await contact(request, env, now);
        for (const [name, value] of Object.entries(cors)) result.headers.set(name, value);
        return result;
      }
      if (url.pathname.startsWith('/api/admin/')) return await admin(request, env, now, url, gmailFetch);
      if (url.pathname.startsWith('/api/')) fail('Not found.', 404);
      if (!['GET', 'HEAD'].includes(request.method)) fail('Not found.', 404);
      if (!env.ASSETS) fail('Not found.', 404);
      const result = await env.ASSETS.fetch(request);
      const headers = new Headers(result.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        headers.set('Cache-Control', 'private, no-store');
        headers.set('Referrer-Policy', 'no-referrer');
        headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      }
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
    } catch (error) {
      const known = error instanceof HttpError || error instanceof SendingError;
      const status = known ? error.status : error instanceof GmailError ? 409 : 503;
      return response({ ok: false, error: known ? error.message : error instanceof GmailError ? error.code : 'Service is temporarily unavailable. Please try again later.' }, status, { ...cors, ...(status === 429 ? { 'Retry-After': '3600' } : {}) });
    }
  } };
}
export default createWorker();
