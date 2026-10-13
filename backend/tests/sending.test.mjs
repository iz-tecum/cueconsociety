import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SQLiteStore } from '../sqlite.mjs';
import { createWorker, derivePassword, sha256 } from '../worker.mjs';
import { importRecords } from '../import.mjs';
import { createGmailAdapter, clearGmailTokenCache, GmailError } from '../gmail-adapter.mjs';
import { stageCampaign, dispatchOne, sendingStatus, unsubscribeLinks, handleUnsubscribe, renderMessage, bodyHTML } from '../send-queue.mjs';

const require = createRequire(import.meta.url), preview = require('../../admin/core.js');
const ORIGIN = 'https://ces.example', now = Date.parse('2026-10-13T12:00:00Z');
const salt = Buffer.from('queue-test-salt-with-enough-bytes').toString('base64url');
const hash = await derivePassword('test-password', salt);
const base = {
  ADMIN_EMAIL: 'board@example.org', ADMIN_PASSWORD_SALT: salt, ADMIN_PASSWORD_HASH: hash,
  SESSION_SECRET: 'test-session-secret-at-least-32-characters', RATE_LIMIT_SECRET: 'test-rate-secret-at-least-32-characters', CLIENT_IP: '192.0.2.4',
  GMAIL_FROM: 'board@example.org', GMAIL_PRINCIPAL: 'person@example.org', GMAIL_CLIENT_ID: 'test-client-id', GMAIL_CLIENT_SECRET: 'test-client-secret',
  GMAIL_REFRESH_TOKEN: 'test-refresh-token', GMAIL_UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret-at-least-32-characters', GMAIL_UNSUBSCRIBE_ORIGIN: ORIGIN,
  GMAIL_SEND_ENABLED: 'false'
};
function googleMock({ principal = base.GMAIL_PRINCIPAL, from = base.GMAIL_FROM, alias = 'accepted', send = 'success', includeAliasScope = true, verified = true } = {}) {
  const calls = [];
  const fetch = async (value, options = {}) => {
    const url = new URL(value); calls.push({ url: url.origin + url.pathname, method: options.method || 'GET', body: options.body });
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
    if (url.origin + url.pathname === 'https://oauth2.googleapis.com/tokeninfo') return Response.json({ aud: base.GMAIL_CLIENT_ID, scope: `openid email https://www.googleapis.com/auth/gmail.send${includeAliasScope ? ' https://www.googleapis.com/auth/gmail.settings.basic' : ''}` });
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ email: principal, email_verified: verified });
    if (url.href === 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs') return Response.json({ sendAs: alias === 'absent' ? [] : [{ sendAsEmail: from, verificationStatus: alias }] });
    if (url.href === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      if (send === 'timeout') throw new TypeError('Network interrupted');
      if (send === '500') return Response.json({ error: {} }, { status: 500 });
      if (send === '429') return Response.json({ error: {} }, { status: 429, headers: { 'Retry-After': '120' } });
      return Response.json({ id: 'provider-message-1' });
    }
    throw new Error('Unexpected external request in mock');
  };
  return { fetch, calls, sent: () => calls.filter(call => call.url.endsWith('/messages/send')) };
}
function setup(t, overrides = {}) {
  clearGmailTokenCache();
  const database = new SQLiteStore(':memory:'); t.after(() => database.close());
  const env = { ...base, DB: database, ...overrides };
  return { database, env };
}
async function draft(env, count = 2, body = '## Event\n\n**Come along**\n\n- first\n- [details](https://example.org)') {
  const records = await Promise.all(Array.from({ length: count }, async (_, i) => ({
    email: `member${i}@example.org`, name: 'Example', status: 'subscribed', interests: [], sources: [], unsubscribeTokenHash: 'c'.repeat(64),
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
  })));
  for (let offset = 0; offset < records.length; offset += 500) await importRecords(env.DB, records.slice(offset, offset + 500), { now });
  const ids = await Promise.all(records.map(record => sha256(record.email)));
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO drafts(id,title,subject,preheader,body,recipient_ids_json,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id, 'Example campaign', 'Example campaign', 'A short preview', body, JSON.stringify(ids), new Date(now).toISOString()).run();
  return { id, ids, records };
}
async function running(env, count = 2) {
  const saved = await draft(env, count), staged = await stageCampaign(env, saved.id, now);
  await env.DB.prepare("UPDATE send_campaigns SET status='running' WHERE id=?").bind(staged.campaign.id).run();
  await env.DB.prepare("UPDATE send_jobs SET status='queued' WHERE campaign_id=?").bind(staged.campaign.id).run();
  return { ...saved, campaignId: staged.campaign.id };
}
const stubAdapter = (send = async () => ({ providerId: 'mock-receipt' })) => ({ verify: async () => ({ principal: base.GMAIL_PRINCIPAL, from: base.GMAIL_FROM, token: 'test' }), send });

test('configuration is disabled by default and status makes no external request', async t => {
  const { env } = setup(t); delete env.GMAIL_SEND_ENABLED; delete env.GMAIL_CLIENT_SECRET;
  const status = await sendingStatus(env, now);
  assert.equal(status.enabled, false); assert.equal(status.configured, false); assert.equal(status.available, false);
  await assert.rejects(dispatchOne(env, 'any-campaign', { adapter: stubAdapter(), now }), error => error.status === 409);
});

test('status lazily initializes a schema-only hosted control table', async t => {
  const { env, database } = setup(t); await database.prepare('DELETE FROM send_control').run();
  const status = await sendingStatus(env, now); assert.equal(status.enabled, false);
  assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM send_control').first()).n, 1);
});

test('staging 2265 recipients stays set-based and sends nothing', async t => {
  const { env, database } = setup(t); delete env.GMAIL_CLIENT_SECRET;
  const saved = await draft(env, 2265); let statements = 0;
  const original = database.prepare.bind(database); database.prepare = (...args) => { statements++; return original(...args); };
  const staged = await stageCampaign(env, saved.id, now);
  assert.equal(staged.campaign.status, 'staged'); assert.equal(staged.counts.prepared, 2265); assert.ok(statements < 20);
  assert.equal((await original('SELECT COUNT(*) AS n FROM send_budget').first()).n, 0);
  const contacts = await original('SELECT DISTINCT unsubscribe_token_hash FROM contacts').all(); assert.deepEqual(contacts.results.map(row => row.unsubscribe_token_hash), ['c'.repeat(64)]);
});

test('same snapshot is deduplicated and recipient jobs stay unique', async t => {
  const { env, database } = setup(t); const saved = await draft(env);
  const [first, second] = await Promise.all([stageCampaign(env, saved.id, now), stageCampaign(env, saved.id, now)]);
  assert.equal(first.campaign.id, second.campaign.id);
  assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM send_jobs').first()).n, 2);
});

test('adapter verifies actual principal and accepted alias using only mocked read calls', async t => {
  const { env } = setup(t); const mocked = googleMock();
  const identity = await createGmailAdapter(env, { fetchImpl: mocked.fetch, clock: () => now }).verify();
  assert.equal(identity.from, base.GMAIL_FROM); assert.equal(identity.principal, base.GMAIL_PRINCIPAL); assert.equal(mocked.sent().length, 0);
  for (const options of [{ principal: 'wrong@example.org' }, { verified: false }, { alias: 'pending' }, { alias: 'absent' }, { includeAliasScope: false }]) {
    clearGmailTokenCache(); const mock = googleMock(options);
    await assert.rejects(createGmailAdapter(env, { fetchImpl: mock.fetch, clock: () => now }).verify(), error => error instanceof GmailError);
    assert.equal(mock.sent().length, 0);
  }
});

test('direct mailbox verification does not request alias settings', async t => {
  const { env } = setup(t, { GMAIL_FROM: base.GMAIL_PRINCIPAL }); const mock = googleMock({ includeAliasScope: false });
  await createGmailAdapter(env, { fetchImpl: mock.fetch, clock: () => now }).verify();
  assert.equal(mock.calls.filter(call => call.url.endsWith('/settings/sendAs')).length, 0);
});

test('adapter cannot deliver when disabled even after successful identity check', async t => {
  const { env } = setup(t); const mock = googleMock(), adapter = createGmailAdapter(env, { fetchImpl: mock.fetch, clock: () => now });
  const identity = await adapter.verify(); await assert.rejects(adapter.send('raw', identity), error => error.code === 'SENDING_DISABLED'); assert.equal(mock.sent().length, 0);
});

test('transport timeouts and 5xx are uncertain while explicit quota rejection can retry', async t => {
  const { env } = setup(t, { GMAIL_SEND_ENABLED: 'true' });
  for (const [send, disposition] of [['timeout', 'unknown'], ['500', 'unknown'], ['429', 'retry']]) {
    clearGmailTokenCache(); const mock = googleMock({ send }), adapter = createGmailAdapter(env, { fetchImpl: mock.fetch, clock: () => now });
    const identity = await adapter.verify(); await assert.rejects(adapter.send('raw', identity), error => error.disposition === disposition); assert.equal(mock.sent().length, 1);
  }
});

test('concurrent dispatches claim and send only one job', async t => {
  const { env, database } = setup(t, { GMAIL_SEND_ENABLED: 'true' }); const campaign = await running(env);
  let sent = 0; const adapter = stubAdapter(async () => { sent++; return { providerId: 'receipt' }; });
  const results = await Promise.all([dispatchOne(env, campaign.campaignId, { adapter, now }), dispatchOne(env, campaign.campaignId, { adapter, now })]);
  assert.equal(sent, 1); assert.equal(results.filter(result => result.result === 'sent').length, 1); assert.equal(results.filter(result => result.result === 'paced').length, 1);
  assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM send_budget').first()).n, 1);
});

test('a stalled worker loses its lease and cannot exceed the fresh rolling budget', async t => {
  const { env } = setup(t, { GMAIL_SEND_ENABLED: 'true', GMAIL_DAILY_BUDGET: '1' }); const campaign = await running(env, 3);
  let current = now, resume, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  let sends = 0;
  const stalledAdapter = { verify: async () => { reached(); await gate; return { principal: base.GMAIL_PRINCIPAL, from: base.GMAIL_FROM, token: 'test' }; }, send: async () => { sends++; return { providerId: 'stalled' }; } };
  const first = dispatchOne(env, campaign.campaignId, { adapter: stalledAdapter, now, clock: () => current });
  await waiting; current += 180001;
  const second = await dispatchOne(env, campaign.campaignId, { adapter: stubAdapter(async () => { sends++; return { providerId: 'current' }; }), now: current, clock: () => current });
  assert.equal(second.result, 'sent'); resume();
  const old = await first; assert.equal(old.result, 'blocked'); assert.equal(sends, 1); assert.equal(old.counts.needs_review, 1);
});

test('suppression after staging is rechecked before sending', async t => {
  const { env, database } = setup(t, { GMAIL_SEND_ENABLED: 'true' }); const campaign = await running(env, 1);
  await database.prepare("UPDATE contacts SET status='unsubscribed' WHERE id=?").bind(campaign.ids[0]).run();
  let calls = 0; const result = await dispatchOne(env, campaign.campaignId, { adapter: stubAdapter(async () => { calls++; }), now });
  assert.equal(result.result, 'skipped'); assert.equal(calls, 0); assert.equal(result.campaign.status, 'completed');
});

test('unknown delivery is held and never automatically resent', async t => {
  const { env, database } = setup(t, { GMAIL_SEND_ENABLED: 'true' }); const campaign = await running(env, 1);
  let calls = 0; const adapter = stubAdapter(async () => { calls++; throw new GmailError('DELIVERY_RESULT_UNKNOWN', 'unknown'); });
  const result = await dispatchOne(env, campaign.campaignId, { adapter, now });
  assert.equal(result.result, 'needs_review'); assert.equal(result.campaign.status, 'paused');
  await database.prepare("UPDATE send_campaigns SET status='running' WHERE id=?").bind(campaign.campaignId).run();
  const next = await dispatchOne(env, campaign.campaignId, { adapter, now: now + 10000 });
  assert.equal(next.result, 'idle'); assert.equal(next.counts.needs_review, 1); assert.equal(calls, 1);
});

test('expired in-flight lease is held for review after a worker restart', async t => {
  const { env, database } = setup(t, { GMAIL_SEND_ENABLED: 'true' }); const campaign = await running(env, 1);
  await database.prepare("UPDATE send_jobs SET status='processing',lease_until=?,lease_id='expired' WHERE campaign_id=?").bind(now - 1000, campaign.campaignId).run();
  let calls = 0; const result = await dispatchOne(env, campaign.campaignId, { adapter: stubAdapter(async () => { calls++; }), now });
  assert.equal(result.counts.needs_review, 1); assert.equal(calls, 0);
});

test('rolling budget includes previous attempts and waits for expiration', async t => {
  const { env } = setup(t, { GMAIL_SEND_ENABLED: 'true', GMAIL_DAILY_BUDGET: '1' }); const campaign = await running(env, 2);
  let sent = 0; const adapter = stubAdapter(async () => ({ providerId: `receipt-${++sent}` }));
  assert.equal((await dispatchOne(env, campaign.campaignId, { adapter, now })).result, 'sent');
  assert.equal((await dispatchOne(env, campaign.campaignId, { adapter, now: now + 10000 })).result, 'budget'); assert.equal(sent, 1);
  assert.equal((await dispatchOne(env, campaign.campaignId, { adapter, now: now + 86400001 })).result, 'sent'); assert.equal(sent, 2);
});

test('quota rejection pauses, respects Retry-After, and requires manual restart', async t => {
  const { env, database } = setup(t, { GMAIL_SEND_ENABLED: 'true' }); const campaign = await running(env, 1);
  const result = await dispatchOne(env, campaign.campaignId, { adapter: stubAdapter(async () => { throw new GmailError('GMAIL_QUOTA_REJECTED', 'retry', 120000); }), now });
  assert.equal(result.result, 'retry'); assert.equal(result.campaign.status, 'paused'); assert.ok(result.nextAttemptAt >= now + 120000);
  await assert.rejects(dispatchOne(env, campaign.campaignId, { adapter: stubAdapter(), now: now + 200000 }), error => error.status === 409);
  await database.prepare("UPDATE send_campaigns SET status='running' WHERE id=?").bind(campaign.campaignId).run();
  assert.equal((await dispatchOne(env, campaign.campaignId, { adapter: stubAdapter(), now: now + 200000 })).result, 'sent');
});

test('unsubscribe GET does not mutate; signed POST suppresses shared contact and queued jobs', async t => {
  const { env, database } = setup(t); const campaign = await running(env, 1), links = await unsubscribeLinks(env, campaign.ids[0]);
  const previewPage = await handleUnsubscribe(new Request(links.page), env, now); assert.equal(previewPage.status, 200);
  assert.equal((await database.prepare('SELECT status FROM contacts').first()).status, 'subscribed');
  await assert.rejects(handleUnsubscribe(new Request(links.page.replace('token=', 'token=x')), env, now));
  const result = await handleUnsubscribe(new Request(links.oneClick, { method: 'POST', body: 'List-Unsubscribe=One-Click' }), env, now); assert.equal(result.status, 200);
  assert.equal((await database.prepare('SELECT status FROM contacts').first()).status, 'unsubscribed'); assert.equal((await database.prepare('SELECT status FROM send_jobs').first()).status, 'skipped');
  assert.equal((await database.prepare('SELECT unsubscribe_token_hash FROM contacts').first()).unsubscribe_token_hash, 'c'.repeat(64));
});

test('actual MIME preserves safe preview formatting, individual recipients and folded Unicode subject', async t => {
  const { env, database } = setup(t); const saved = await draft(env, 1);
  await database.prepare('UPDATE drafts SET subject=? WHERE id=?').bind('😀'.repeat(100), saved.id).run();
  const staged = await stageCampaign(env, saved.id, now);
  const campaign = await database.prepare('SELECT * FROM send_campaigns').first(), job = await database.prepare('SELECT * FROM send_jobs').first();
  const raw = await renderMessage(env, campaign, job, now), message = Buffer.from(raw, 'base64url').toString();
  assert.equal((message.match(/^To:/gm) || []).length, 1); assert.ok(!message.includes('\nBcc:')); assert.ok(message.includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'));
  for (const word of message.match(/=\?UTF-8\?B\?[^?]+\?=/g)) assert.ok(word.length <= 75);
  assert.equal(staged.campaign.recipientCount, 1);
  const markdown = '## Heading\n\n**strong** and [safe](https://example.org/?a=1&b=2)\n\n- first\n- second\n\n<img src=x onerror=alert(1)> [bad](javascript:alert(1))';
  assert.equal(bodyHTML(markdown), preview.bodyHTML(markdown)); assert.ok(!bodyHTML(markdown).includes('<img'));
});

test('all sending actions inherit login, exact Origin and CSRF checks', async t => {
  const { env } = setup(t); const mock = googleMock(), worker = createWorker({ clock: () => now, gmailFetch: mock.fetch });
  const request = (path, method = 'GET', body, headers = {}) => worker.fetch(new Request(ORIGIN + path, { method, headers: { Origin: ORIGIN, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  assert.equal((await request('/api/admin/sending/status')).status, 401);
  const login = await request('/api/admin/login', 'POST', { email: base.ADMIN_EMAIL, password: 'test-password' }), data = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/admin/sending/check', 'POST', {}, { Cookie: cookie })).status, 403);
  const checked = await request('/api/admin/sending/check', 'POST', {}, { Cookie: cookie, 'X-CSRF-Token': data.csrfToken }); assert.equal(checked.status, 200); assert.equal((await checked.json()).available, false);
  const saved = await draft(env, 1);
  const staged = await request('/api/admin/sending/campaigns', 'POST', { draftId: saved.id }, { Cookie: cookie, 'X-CSRF-Token': data.csrfToken }); assert.equal(staged.status, 200);
  const campaign = (await staged.json()).campaign;
  assert.equal((await request(`/api/admin/sending/campaigns/${campaign.id}/start`, 'POST', {}, { Cookie: cookie, 'X-CSRF-Token': data.csrfToken })).status, 409);
  assert.equal(mock.sent().length, 0);
});
