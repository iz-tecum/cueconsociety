import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, derivePassword, sha256, readJSON } from '../worker.mjs';
import { SQLiteStore } from '../sqlite.mjs';
import { importRecords, normalizeImportRecord } from '../import.mjs';

const ORIGIN = 'https://ces.example';
const password = 'test-only-password';
const salt = Buffer.from('test-only-salt-123456789').toString('base64url');
const passwordHash = await derivePassword(password, salt);
const now = Date.parse('2026-10-13T12:00:00Z');
const config = {
  ADMIN_EMAIL: 'board@example.org', ADMIN_PASSWORD_SALT: salt, ADMIN_PASSWORD_HASH: passwordHash,
  SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters', RATE_LIMIT_SECRET: 'test-rate-secret-that-is-at-least-32-characters', CLIENT_IP: '192.0.2.1'
};
function setup(t) {
  const database = new SQLiteStore(':memory:'); t.after(() => database.close());
  const env = { ...config, DB: database }, worker = createWorker({ clock: () => now });
  async function request(path, { method = 'GET', body, headers = {}, origin = ORIGIN, ...options } = {}) {
    return worker.fetch(new Request(ORIGIN + path, {
      method, headers: { ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...options
    }), env);
  }
  async function login() {
    const result = await request('/api/admin/login', { method: 'POST', body: { email: config.ADMIN_EMAIL, password } });
    assert.equal(result.status, 200);
    const data = await result.json();
    return { data, cookie: result.headers.get('set-cookie'), headers: { Cookie: result.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': data.csrfToken } };
  }
  return { database, env, worker, request, login };
}
function contact(email, status = 'subscribed', extra = {}) {
  return { email, name: 'Example', status, interests: [], sources: [{ source: 'test', status }], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', consent: null, ...extra };
}

test('all audience and campaign endpoints require authentication', async t => {
  const { request } = setup(t);
  for (const endpoint of ['audience', 'drafts', 'messages', 'export', 'session']) {
    const result = await request(`/api/admin/${endpoint}`); assert.equal(result.status, 401); assert.match(result.headers.get('cache-control'), /no-store/);
  }
});

test('login uses uniform errors for a wrong email or password', async t => {
  const { request } = setup(t);
  const results = [];
  for (const body of [{ email: 'missing@example.org', password }, { email: config.ADMIN_EMAIL, password: 'wrong' }]) {
    const result = await request('/api/admin/login', { method: 'POST', body }); assert.equal(result.status, 401); results.push(await result.text());
  }
  assert.equal(results[0], results[1]);
});

test('login creates an opaque secure session and only stores its hash', async t => {
  const { login, database, request } = setup(t);
  const session = await login();
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(session.cookie.includes(flag));
  assert.match(session.cookie, /^__Host-ces_session=[A-Za-z0-9_-]{43};/);
  const saved = await database.prepare('SELECT token_hash FROM sessions').first();
  assert.match(saved.token_hash, /^[a-f0-9]{64}$/); assert.ok(!session.cookie.includes(saved.token_hash));
  const result = await request('/api/admin/session', { headers: session.headers });
  assert.equal((await result.json()).csrfToken, session.data.csrfToken);
});

test('cross-origin and originless login are rejected', async t => {
  const { request } = setup(t);
  for (const origin of ['https://evil.example', null]) {
    const result = await request('/api/admin/login', { method: 'POST', body: { email: config.ADMIN_EMAIL, password }, origin }); assert.equal(result.status, 403);
  }
});

test('admin writes require CSRF and same-origin even with a valid cookie', async t => {
  const { request, login } = setup(t); const session = await login();
  const body = { title: 'Draft', subject: 'Hi', body: 'Hello', recipientIds: [] };
  assert.equal((await request('/api/admin/drafts', { method: 'POST', body, headers: { Cookie: session.headers.Cookie } })).status, 403);
  assert.equal((await request('/api/admin/drafts', { method: 'POST', body, headers: session.headers, origin: 'https://evil.example' })).status, 403);
});

test('logout revokes the server session', async t => {
  const { request, login } = setup(t); const session = await login();
  const result = await request('/api/admin/logout', { method: 'POST', body: {}, headers: session.headers });
  assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/admin/audience', { headers: session.headers })).status, 401);
});

test('public form requires an explicitly allowed origin', async t => {
  const { request } = setup(t);
  for (const origin of ['https://evil.example', null, 'null']) {
    assert.equal((await request('/api/newsletter', { method: 'POST', body: { action: 'subscribe', email: 'a@example.org', consent: true }, origin })).status, 403);
  }
});

test('signup, duplicate signup, and private unsubscribe preserve the first token', async t => {
  const { request, database } = setup(t);
  const body = { action: 'subscribe', email: 'person@example.org', name: 'First name', interests: ['events'], consent: true };
  const first = await (await request('/api/newsletter', { method: 'POST', body })).json();
  const second = await (await request('/api/newsletter', { method: 'POST', body: { ...body, name: 'Changed name' } })).json();
  assert.notEqual(first.manageToken, second.manageToken);
  let saved = await database.prepare('SELECT * FROM contacts WHERE email=?').bind(body.email).first();
  assert.equal(saved.unsubscribe_token_hash, await sha256(first.manageToken)); assert.equal(JSON.parse(saved.record_json).name, 'First name');
  await request('/api/newsletter', { method: 'POST', body: { action: 'unsubscribe', email: body.email, token: second.manageToken } });
  assert.equal((await database.prepare('SELECT status FROM contacts WHERE email=?').bind(body.email).first()).status, 'subscribed');
  await request('/api/newsletter', { method: 'POST', body: { action: 'unsubscribe', email: body.email, token: first.manageToken } });
  saved = await database.prepare('SELECT * FROM contacts WHERE email=?').bind(body.email).first();
  assert.equal(saved.status, 'unsubscribed'); assert.equal(JSON.parse(saved.record_json).sources.at(-1).source, 'ces-private-unsubscribe-link');
});

test('public signup never reactivates suppressed contacts or reveals membership', async t => {
  const { request, database } = setup(t);
  await importRecords(database, [contact('optout@example.org', 'unsubscribed')]);
  const outcomes = [];
  for (const email of ['optout@example.org', 'new@example.org']) outcomes.push(await (await request('/api/newsletter', { method: 'POST', body: { action: 'subscribe', email, consent: true } })).json());
  assert.equal(outcomes[0].message, outcomes[1].message); assert.equal(outcomes[0].manageToken.length, outcomes[1].manageToken.length);
  assert.equal((await database.prepare('SELECT status FROM contacts WHERE email=?').bind('optout@example.org').first()).status, 'unsubscribed');
});

test('parallel signup attempts cannot exceed the atomic per-IP hourly cap', async t => {
  const { request, database } = setup(t);
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, index) => request('/api/newsletter', { method: 'POST', body: { action: 'subscribe', email: `person${index}@example.org`, consent: true } })));
  assert.equal(outcomes.filter(result => result.status === 200).length, 5); assert.equal(outcomes.filter(result => result.status === 429).length, 15);
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM contacts').first()).count, 5);
});

test('repeated incorrect passwords hit the authentication rate limit', async t => {
  const { request } = setup(t);
  for (let index = 0; index < 10; index++) assert.equal((await request('/api/admin/login', { method: 'POST', body: { email: config.ADMIN_EMAIL, password: 'wrong' } })).status, 401);
  assert.equal((await request('/api/admin/login', { method: 'POST', body: { email: config.ADMIN_EMAIL, password } })).status, 429);
});

test('bounded JSON readers count bytes, reject malformed JSON, and reject arrays', async () => {
  await assert.rejects(readJSON(new Request(ORIGIN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'é'.repeat(100) }) }), 100), error => error.status === 413);
  for (const body of ['[1]', '{invalid']) await assert.rejects(readJSON(new Request(ORIGIN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })), error => error.status === 400);
});

test('saved drafts retain only contacts currently subscribed', async t => {
  const { request, login, database } = setup(t); const session = await login();
  await importRecords(database, [contact('active@example.org'), contact('out@example.org', 'unsubscribed')]);
  const active = await sha256('active@example.org'), out = await sha256('out@example.org');
  const result = await request('/api/admin/drafts', { method: 'POST', headers: session.headers, body: { title: 'Friday', subject: 'Meet us', body: 'Event text', recipientIds: [active, out] } });
  assert.equal(result.status, 200); const saved = (await result.json()).draft; assert.deepEqual(saved.recipientIds, [active]);
  const drafts = await (await request('/api/admin/drafts', { headers: session.headers })).json(); assert.equal(drafts.drafts[0].body, 'Event text');
});

test('bulk suppression works and reactivation is rejected', async t => {
  const { request, login, database } = setup(t); const session = await login();
  await importRecords(database, [contact('first@example.org'), contact('second@example.org')]);
  const ids = await Promise.all(['first@example.org', 'second@example.org'].map(sha256));
  const result = await request('/api/admin/contacts/status', { method: 'POST', headers: session.headers, body: { ids, status: 'unsubscribed' } });
  assert.equal((await result.json()).updated, 2);
  assert.equal((await request('/api/admin/contacts/status', { method: 'POST', headers: session.headers, body: { ids, status: 'subscribed' } })).status, 400);
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM contacts WHERE status='unsubscribed'").first()).count, 2);
});

test('contact messages are visible only through authenticated inbox', async t => {
  const { request, login } = setup(t);
  const result = await request('/api/contact', { method: 'POST', body: { name: 'Visitor', email: 'visitor@example.org', subject: 'Event', message: 'Can I attend?' } });
  assert.equal(result.status, 200); assert.equal((await request('/api/admin/messages')).status, 401);
  const session = await login(); const inbox = await (await request('/api/admin/messages', { headers: session.headers })).json(); assert.equal(inbox.messages[0].message, 'Can I attend?');
});

test('migration preserves suppression, token hashes, metadata, and original timestamps', async t => {
  const { database } = setup(t), tokenHash = 'a'.repeat(64);
  await importRecords(database, [contact('preserve@example.org', 'unsubscribed', { unsubscribeTokenHash: tokenHash, name: 'Original', interests: ['events'] })]);
  await importRecords(database, [contact('preserve@example.org', 'subscribed', { unsubscribeTokenHash: 'b'.repeat(64), name: 'New', interests: ['careers'], updatedAt: '2026-01-01T00:00:00.000Z', sources: [{ source: 'new-import', status: 'subscribed' }] })]);
  const saved = await database.prepare('SELECT * FROM contacts').first(), record = JSON.parse(saved.record_json);
  assert.equal(saved.status, 'unsubscribed'); assert.equal(saved.unsubscribe_token_hash, tokenHash); assert.equal(record.status, 'unsubscribed');
  assert.equal(record.name, 'Original'); assert.equal(record.sources.length, 2); assert.deepEqual(record.interests.sort(), ['careers', 'events']);
  assert.equal(record.createdAt, '2025-01-01T00:00:00.000Z'); assert.equal(record.updatedAt, '2026-01-01T00:00:00.000Z');
});

test('invalid import input cannot partly insert records or poison consent', async t => {
  const { database } = setup(t);
  await assert.rejects(importRecords(database, [contact('valid@example.org'), contact('bad@example.org', 'subscribed', { consent: 'yes' })]));
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM contacts').first()).count, 0);
  await assert.rejects(normalizeImportRecord(contact('bad@example.org', 'unknown')));
});

test('hosted import is authenticated and requires CSRF', async t => {
  const { request, login, database } = setup(t); const body = { records: [contact('import@example.org')] };
  assert.equal((await request('/api/admin/import', { method: 'POST', body })).status, 401);
  const session = await login();
  assert.equal((await request('/api/admin/import', { method: 'POST', body, headers: { Cookie: session.headers.Cookie } })).status, 403);
  assert.equal((await request('/api/admin/import', { method: 'POST', body, headers: session.headers })).status, 200);
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM contacts').first()).count, 1);
});

test('audience exports omit hashes and neutralize spreadsheet formulas', async t => {
  const { request, login, database } = setup(t); const session = await login();
  await importRecords(database, [contact('formula@example.org', 'subscribed', { name: '=HYPERLINK("https://example.org")', unsubscribeTokenHash: 'a'.repeat(64) })]);
  const json = await (await request('/api/admin/export', { headers: session.headers })).text(); assert.ok(!json.includes('unsubscribeTokenHash')); assert.ok(!json.includes('a'.repeat(64)));
  const csv = await (await request('/api/admin/export?format=csv', { headers: session.headers })).text(); assert.ok(csv.includes("'=HYPERLINK"));
});

test('SQL-looking values remain bound data', async t => {
  const { request, database } = setup(t);
  const result = await request('/api/newsletter', { method: 'POST', body: { action: 'subscribe', email: "o'reilly@example.org", name: "'); DROP TABLE contacts;--", consent: true } });
  assert.equal(result.status, 200); assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM contacts').first()).count, 1);
});

test('SQLite batches roll back on a later failed statement', async t => {
  const { database } = setup(t);
  await assert.rejects(database.batch([
    database.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,?,?)').bind('same', 1, now),
    database.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,?,?)').bind('same', 1, now)
  ]));
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM rate_limits').first()).count, 0);
});
