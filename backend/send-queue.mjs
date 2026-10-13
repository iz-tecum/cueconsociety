import { createGmailAdapter, gmailConfiguration, gmailConfigurationFingerprint, GmailError } from './gmail-adapter.mjs';
import newsletterTemplate from '../admin/newsletter-template.js';

const encoder = new TextEncoder();
const DAY = 86400000;
const LEASE = 180000;
const VERIFICATION_AGE = 3600000;
const ID = /^[A-Za-z0-9_-]{8,80}$/;
const CONTACT_ID = /^[a-f0-9]{64}$/;
const STATES = ['prepared', 'queued', 'processing', 'sent', 'skipped', 'retry', 'needs_review', 'failed'];

export class SendingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function reject(message, status = 400) { throw new SendingError(message, status); }
function iso(now) { return new Date(now).toISOString(); }
function reply(data, status = 200) { return Response.json({ ok: true, ...data }, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } }); }
function base64(bytes) { let result = ''; for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.slice(i, i + 8192)); return btoa(result); }
function base64url(bytes) { return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
async function digest(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(v => v.toString(16).padStart(2, '0')).join(''); }
function equal(a, b) { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }
export const bodyHTML = newsletterTemplate.renderBodyHTML;
function publicCampaign(row, count) {
  const snapshot = JSON.parse(row.snapshot_json);
  return { id: row.id, status: row.status, subject: snapshot.subject, recipientCount: count, createdAt: row.created_at, updatedAt: row.updated_at, approvedAt: row.approved_at };
}
async function countJobs(env, id) {
  const rows = await env.DB.prepare('SELECT status,COUNT(*) AS count FROM send_jobs WHERE campaign_id=? GROUP BY status').bind(id).all();
  return { ...Object.fromEntries(STATES.map(status => [status, 0])), ...Object.fromEntries(rows.results.map(row => [row.status, row.count])) };
}
async function detail(env, id, includePreview = false) {
  await assertCampaignOwner(env, id);
  const row = await env.DB.prepare('SELECT * FROM send_campaigns WHERE id=?').bind(id).first();
  if (!row) reject('Campaign not found.', 404);
  const counts = await countJobs(env, id);
  const snapshot = includePreview ? JSON.parse(row.snapshot_json) : null;
  return { campaign: publicCampaign(row, Object.values(counts).reduce((sum, n) => sum + n, 0)), counts,
    ...(includePreview ? { preview: { subject: snapshot.subject, preheader: snapshot.preheader, body: snapshot.body, from: row.from_email } } : {}) };
}
async function assertCampaignOwner(env, id) {
  if (env.GMAIL_SESSION_OAUTH !== 'true') return;
  const owner = env.GMAIL_CONNECTION_ID && await env.DB.prepare('SELECT 1 AS owned FROM google_campaign_owners WHERE campaign_id=? AND google_sub=?').bind(id, env.GMAIL_CONNECTION_ID).first();
  if (!owner) reject('Campaign not found for the connected Google account.', 404);
}
async function verificationContext(env) {
  const scope = env.GMAIL_SESSION_OAUTH === 'true' ? env.GMAIL_CONNECTION_ID ? await digest(env.GMAIL_CONNECTION_ID) : 'disconnected' : 'global';
  const row = scope === 'global' ? 'gmail' : `gmail-owner:${scope}`;
  if (row !== 'gmail') await env.DB.prepare('INSERT OR IGNORE INTO send_control(id) VALUES(?)').bind(row).run();
  return { row, proof: `gmail-check:${scope}:`, attempt: `gmail-check-attempt:${scope}:` };
}
async function verifyConnection(env, adapter, now) {
  const fingerprint = await gmailConfigurationFingerprint(env);
  const scope = await verificationContext(env);
  const attempt = `${scope.attempt}${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare('UPDATE send_control SET verified_principal=NULL,verified_from=NULL,verified_at=NULL WHERE id=?').bind(scope.row),
    env.DB.prepare('DELETE FROM send_control WHERE (id>=? AND id<?) OR (id>=? AND id<?)')
      .bind(scope.proof, `${scope.proof}\uffff`, scope.attempt, `${scope.attempt}\uffff`),
    env.DB.prepare('INSERT INTO send_control(id) VALUES(?)').bind(attempt)
  ]);
  try {
    const identity = await adapter.verify();
    const config = gmailConfiguration(env);
    if (!config.configured || identity.principal !== config.principal || identity.from !== config.from || fingerprint !== await gmailConfigurationFingerprint(env)) throw new GmailError('GOOGLE_CONFIGURATION_CHANGED');
    const saved = await env.DB.batch([
      env.DB.prepare('UPDATE send_control SET verified_principal=?,verified_from=?,verified_at=? WHERE id=? AND EXISTS(SELECT 1 FROM send_control WHERE id=?)')
        .bind(identity.principal, identity.from, iso(now), scope.row, attempt),
      env.DB.prepare('INSERT INTO send_control(id,verified_principal,verified_from,verified_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM send_control WHERE id=?) RETURNING id')
        .bind(`${scope.proof}${fingerprint}`, identity.principal, identity.from, iso(now), attempt),
      env.DB.prepare('DELETE FROM send_control WHERE id=?').bind(attempt)
    ]);
    if (!saved[1].results.length) throw new GmailError('GOOGLE_CHECK_SUPERSEDED');
    return identity;
  } catch (error) {
    await env.DB.prepare('DELETE FROM send_control WHERE id=?').bind(attempt).run();
    throw error;
  }
}
async function ensureControl(env) { await env.DB.prepare("INSERT OR IGNORE INTO send_control(id) VALUES('gmail')").run(); }
export async function sendingStatus(env, now = Date.now()) {
  await ensureControl(env);
  const config = gmailConfiguration(env);
  const fingerprint = await gmailConfigurationFingerprint(env);
  const scope = await verificationContext(env);
  const saved = await env.DB.prepare(`SELECT c.verified_principal,c.verified_from,c.verified_at,
    EXISTS(SELECT 1 FROM send_control p WHERE p.id=? AND p.verified_at=c.verified_at AND p.verified_principal=c.verified_principal AND p.verified_from=c.verified_from) AS configuration_matches
    FROM send_control c WHERE c.id=?`).bind(`${scope.proof}${fingerprint}`, scope.row).first();
  const checkedAt = Date.parse(saved?.verified_at);
  const matches = Boolean(config.configured && saved?.configuration_matches && saved?.verified_principal === config.principal && saved?.verified_from === config.from && checkedAt <= now && checkedAt > now - VERIFICATION_AGE);
  const lastCheck = saved?.verified_at ? { at: saved.verified_at, principal: saved.verified_principal, from: saved.verified_from } : null;
  const reason = !config.configured ? config.reason : !matches ? 'Google connection needs a fresh check. Checking sends no email.' : !config.enabled ? 'Google connection verified. Sending is disabled; no delivery test has been run.' : 'Google connection verified. Delivery has not been tested; sending requires an explicit campaign start and manual dispatch.';
  return { enabled: config.enabled, configured: config.configured, available: Boolean(config.enabled && matches),
    connectionVerified: matches, verificationExpiresAt: matches ? iso(checkedAt + VERIFICATION_AGE) : null,
    connectionState: !config.configured ? 'not_configured' : matches ? 'verified' : 'check_required',
    configurationMissing: config.configurationMissing, deliveryTested: false, reason,
    from: config.from, principal: config.principal, limits: config.limits, lastCheck, sendingPolicy: 'Manual dispatch only' };
}

export async function stageCampaign(env, draftId, now = Date.now()) {
  await ensureControl(env);
  if (env.GMAIL_SESSION_OAUTH === 'true' && !env.GMAIL_CONNECTION_ID) reject('Connect your Columbia Google account before preparing a campaign.', 409);
  if (typeof draftId !== 'string' || !ID.test(draftId)) reject('Choose a saved draft.');
  const draft = await env.DB.prepare('SELECT * FROM drafts WHERE id=?').bind(draftId).first();
  if (!draft || !draft.subject.trim() || !draft.body.trim()) reject('Save a draft with a subject and message first.');
  const eligible = await env.DB.prepare("SELECT id,email FROM contacts WHERE status='subscribed' AND id IN (SELECT value FROM json_each(?)) ORDER BY id")
    .bind(draft.recipient_ids_json).all();
  if (!eligible.results.length) reject('Select current subscribers before staging.');
  const from = gmailConfiguration(env).from;
  const snapshot = { subject: draft.subject, preheader: draft.preheader, body: draft.body, draftId, draftUpdatedAt: draft.updated_at, from,
    ...(env.GMAIL_SESSION_OAUTH === 'true' ? { googleSubject: env.GMAIL_CONNECTION_ID } : {}), recipientIds: eligible.results.map(row => row.id) };
  const key = await digest(JSON.stringify(snapshot));
  let existing = await env.DB.prepare('SELECT * FROM send_campaigns WHERE snapshot_key=?').bind(key).first();
  if (existing) return { ...await detail(env, existing.id, true), reused: true };
  const id = crypto.randomUUID(), at = iso(now);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO send_campaigns(id,snapshot_key,draft_id,snapshot_json,from_email,status,created_at,updated_at) VALUES(?,?,?,?,?,'staged',?,?) ON CONFLICT(snapshot_key) DO NOTHING")
      .bind(id, key, draftId, JSON.stringify(snapshot), from, at, at),
    env.DB.prepare(`INSERT INTO send_jobs(id,campaign_id,contact_id,recipient_email,status,message_id,updated_at)
      SELECT lower(hex(randomblob(16))),c.id,p.id,p.email,'prepared','<ces.' || c.id || '.' || p.id || '@' || ? || '>',?
      FROM send_campaigns c JOIN contacts p ON p.id IN (SELECT value FROM json_each(?))
      WHERE c.snapshot_key=? AND c.status='staged' AND p.status='subscribed'
      ON CONFLICT(campaign_id,contact_id) DO NOTHING`)
      .bind('cueconsociety.com', at, JSON.stringify(snapshot.recipientIds), key),
    env.DB.prepare('INSERT INTO audit(id,action,detail_json,created_at) VALUES(?,?,?,?)').bind(crypto.randomUUID(), 'campaign-staged', JSON.stringify({ snapshotKey: key, recipients: snapshot.recipientIds.length }), at),
    ...(env.GMAIL_SESSION_OAUTH === 'true' ? [env.DB.prepare('INSERT INTO google_campaign_owners(campaign_id,google_sub) SELECT id,? FROM send_campaigns WHERE snapshot_key=? ON CONFLICT(campaign_id) DO NOTHING').bind(env.GMAIL_CONNECTION_ID, key)] : [])
  ]);
  existing = await env.DB.prepare('SELECT id FROM send_campaigns WHERE snapshot_key=?').bind(key).first();
  return { ...await detail(env, existing.id, true), reused: existing.id !== id };
}

export async function unsubscribeToken(env, contactId) {
  if (!CONTACT_ID.test(contactId) || typeof env.GMAIL_UNSUBSCRIBE_SECRET !== 'string' || env.GMAIL_UNSUBSCRIBE_SECRET.length < 32) reject('Unsubscribe is not configured.', 503);
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.GMAIL_UNSUBSCRIBE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`ces-unsubscribe-v1:${contactId}`))));
}
export async function unsubscribeLinks(env, contactId) {
  const origin = gmailConfiguration(env).origin;
  if (!origin) reject('Unsubscribe is not configured.', 503);
  const token = await unsubscribeToken(env, contactId), query = `contact=${contactId}&token=${token}`;
  return { page: `${origin}/unsubscribe?${query}`, oneClick: `${origin}/api/unsubscribe?${query}` };
}
function wrapBase64(value) { return base64(encoder.encode(value)).match(/.{1,76}/g)?.join('\r\n') || ''; }
function encodedSubject(value) {
  const chunks = []; let part = '';
  for (const character of value) {
    if (part && encoder.encode(part + character).length > 42) { chunks.push(part); part = ''; }
    part += character;
  }
  if (part) chunks.push(part);
  return chunks.map(chunk => `=?UTF-8?B?${base64(encoder.encode(chunk))}?=`).join('\r\n ');
}
export async function renderMessage(env, campaign, job, now = Date.now()) {
  const snapshot = JSON.parse(campaign.snapshot_json), links = await unsubscribeLinks(env, job.contact_id);
  const from = campaign.from_email;
  if (!from || /[\r\n]/.test(from) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) || /[\r\n]/.test(job.recipient_email) || !/^<ces\.[A-Za-z0-9.-]+@cueconsociety\.com>$/.test(job.message_id)) reject('Invalid message envelope.');
  const displayName = 'Columbia Economics Society';
  const plainBody = newsletterTemplate.renderBodyText(snapshot.body);
  const text = `${snapshot.subject}\n${snapshot.preheader ? snapshot.preheader + '\n' : ''}\n${plainBody}\n\nColumbia Economics Society · Columbia University\nUnsubscribe: ${links.page}\n`;
  const html = newsletterTemplate.renderEmailHTML(snapshot, { unsubscribeUrl: links.page, recipientEmail: job.recipient_email, fromEmail: from });
  const boundary = `ces_${job.id}`;
  const subject = encodedSubject(snapshot.subject);
  const lines = [
    `From: ${displayName} <${from}>`, `To: <${job.recipient_email}>`, `Subject: ${subject}`, `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: ${job.message_id}`, 'MIME-Version: 1.0', `List-Unsubscribe: <${links.oneClick}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrapBase64(text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrapBase64(html), `--${boundary}--`, ''
  ];
  return base64url(encoder.encode(lines.join('\r\n')));
}

async function finalizeCampaign(env, id, now) {
  const active = await env.DB.prepare("SELECT 1 AS found FROM send_jobs WHERE campaign_id=? AND status IN ('prepared','queued','retry','processing') LIMIT 1").bind(id).first();
  if (active) return;
  const uncertain = await env.DB.prepare("SELECT 1 AS found FROM send_jobs WHERE campaign_id=? AND status='needs_review' LIMIT 1").bind(id).first();
  await env.DB.prepare("UPDATE send_campaigns SET status=?,updated_at=? WHERE id=? AND status='running'")
    .bind(uncertain ? 'paused' : 'completed', iso(now), id).run();
}
async function startCampaign(env, id, adapter, now) {
  await assertCampaignOwner(env, id);
  const config = gmailConfiguration(env);
  if (!config.enabled || !config.configured) reject(config.reason, 409);
  const row = await env.DB.prepare('SELECT * FROM send_campaigns WHERE id=?').bind(id).first();
  if (!row) reject('Campaign not found.', 404);
  if (!row.from_email || row.from_email !== config.from) reject('The sender changed. Stage the saved draft again with the configured sender.', 409);
  if (row.status === 'completed') reject('This campaign is already completed.', 409);
  await verifyConnection(env, adapter, now);
  await env.DB.batch([
    env.DB.prepare("UPDATE send_campaigns SET status='running',approved_at=?,updated_at=? WHERE id=? AND status IN ('staged','paused')").bind(iso(now), iso(now), id),
    env.DB.prepare("UPDATE send_jobs SET status='queued',updated_at=? WHERE campaign_id=? AND status='prepared'").bind(iso(now), id),
    env.DB.prepare('INSERT INTO audit(id,action,detail_json,created_at) VALUES(?,?,?,?)').bind(crypto.randomUUID(), 'campaign-started', JSON.stringify({ campaignId: id, from: config.from }), iso(now))
  ]);
  return detail(env, id);
}

export async function dispatchOne(env, campaignId, { adapter = createGmailAdapter(env), now = Date.now(), clock } = {}) {
  const startedAt = Date.now();
  const currentTime = clock || (() => now + Date.now() - startedAt);
  await ensureControl(env);
  const config = gmailConfiguration(env);
  if (!config.enabled || !config.configured) reject(config.reason, 409);
  if (!ID.test(campaignId || '')) reject('Choose a campaign.');
  await assertCampaignOwner(env, campaignId);
  let campaign = await env.DB.prepare('SELECT * FROM send_campaigns WHERE id=?').bind(campaignId).first();
  if (!campaign || campaign.status !== 'running') reject('Start the campaign explicitly before dispatching.', 409);
  if (campaign.from_email !== config.from) reject('The configured sender changed. Pause and restage the campaign.', 409);
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE send_control SET lease_id=?,lease_until=?,next_send_at=? WHERE id='gmail' AND lease_until<=? AND next_send_at<=?
    AND (SELECT COUNT(*) FROM send_budget WHERE attempted_at>?) < ? RETURNING id`)
    .bind(lease, now + LEASE, now + Math.ceil(60000 / config.limits.perMinute), now, now, now - DAY, config.limits.rolling24Hours).all();
  if (!claimed.results.length) {
    const budget = await env.DB.prepare('SELECT COUNT(*) AS count,MIN(attempted_at) AS earliest FROM send_budget WHERE attempted_at>?').bind(now - DAY).first();
    const control = await env.DB.prepare("SELECT lease_until,next_send_at FROM send_control WHERE id='gmail'").first();
    return { result: budget.count >= config.limits.rolling24Hours ? 'budget' : 'paced', campaignId,
      nextAttemptAt: budget.count >= config.limits.rolling24Hours ? budget.earliest + DAY : Math.max(control.lease_until, control.next_send_at), ...await detail(env, campaignId) };
  }
  let job;
  try {
    await env.DB.prepare("UPDATE send_jobs SET status='needs_review',last_error='INTERRUPTED_DELIVERY',updated_at=? WHERE status='processing' AND lease_until<=?").bind(iso(now), now).run();
    const jobs = await env.DB.prepare(`UPDATE send_jobs SET status='processing',lease_id=?,lease_until=?,updated_at=?
      WHERE id=(SELECT id FROM send_jobs WHERE campaign_id=? AND status IN ('queued','retry') AND next_attempt_at<=? ORDER BY id LIMIT 1)
      AND status IN ('queued','retry') RETURNING *`).bind(lease, now + LEASE, iso(now), campaignId, now).all();
    job = jobs.results[0];
    if (!job) { await finalizeCampaign(env, campaignId, now); return { result: 'idle', campaignId, ...await detail(env, campaignId) }; }
    const identity = await verifyConnection(env, adapter, now);
    const contact = await env.DB.prepare('SELECT status,email FROM contacts WHERE id=?').bind(job.contact_id).first();
    campaign = await env.DB.prepare('SELECT * FROM send_campaigns WHERE id=?').bind(campaignId).first();
    if (campaign.status !== 'running') {
      await env.DB.prepare("UPDATE send_jobs SET status='queued',lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=?").bind(iso(now), job.id, lease).run();
      return { result: 'blocked', campaignId, jobId: job.id, ...await detail(env, campaignId) };
    }
    if (!contact || contact.status !== 'subscribed' || contact.email !== job.recipient_email) {
      await env.DB.prepare("UPDATE send_jobs SET status='skipped',last_error='CONTACT_SUPPRESSED',lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=?").bind(iso(now), job.id, lease).run();
      await finalizeCampaign(env, campaignId, now);
      return { result: 'skipped', campaignId, jobId: job.id, ...await detail(env, campaignId) };
    }
    const raw = await renderMessage(env, campaign, job, now);
    const attemptAt = currentTime(), attemptId = crypto.randomUUID();
    const reservation = await env.DB.batch([
      env.DB.prepare(`INSERT INTO send_budget(id,job_id,attempted_at) SELECT ?,?,?
        WHERE EXISTS(SELECT 1 FROM send_control WHERE id='gmail' AND lease_id=? AND lease_until>?)
        AND EXISTS(SELECT 1 FROM send_jobs j JOIN send_campaigns c ON c.id=j.campaign_id JOIN contacts p ON p.id=j.contact_id
          WHERE j.id=? AND j.status='processing' AND j.lease_id=? AND j.lease_until>? AND c.status='running' AND c.from_email=? AND p.status='subscribed' AND p.email=j.recipient_email)
        AND (SELECT COUNT(*) FROM send_budget WHERE attempted_at>?) < ?
        AND (?=0 OR EXISTS(SELECT 1 FROM google_session_connections l JOIN sessions s ON s.token_hash=l.session_hash
          WHERE l.session_hash=? AND l.google_sub=? AND s.expires_at>?)) RETURNING id`)
        .bind(attemptId, job.id, attemptAt, lease, attemptAt, job.id, lease, attemptAt, config.from, attemptAt - DAY, config.limits.rolling24Hours,
          env.GMAIL_SESSION_OAUTH === 'true' ? 1 : 0, env.GMAIL_SESSION_HASH || '', env.GMAIL_CONNECTION_ID || '', attemptAt),
      env.DB.prepare('UPDATE send_jobs SET attempts=attempts+1 WHERE id=? AND lease_id=? AND EXISTS(SELECT 1 FROM send_budget WHERE id=?)').bind(job.id, lease, attemptId),
      env.DB.prepare('DELETE FROM send_budget WHERE attempted_at<?').bind(attemptAt - 2 * DAY)
    ]);
    if (!reservation[0].results.length || currentTime() >= now + LEASE) {
      await env.DB.prepare(`UPDATE send_jobs SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM contacts WHERE id=send_jobs.contact_id AND status='subscribed') THEN 'skipped' ELSE 'queued' END,
        lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=? AND status='processing'
        AND EXISTS(SELECT 1 FROM send_control WHERE id='gmail' AND lease_id=? AND lease_until>?)`)
        .bind(iso(attemptAt), job.id, lease, lease, attemptAt).run();
      return { result: 'blocked', reason: 'CLAIM_NO_LONGER_VALID', campaignId, jobId: job.id, ...await detail(env, campaignId) };
    }
    const sent = await adapter.send(raw, identity);
    await env.DB.prepare("UPDATE send_jobs SET status='sent',provider_id=?,last_error=NULL,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=?")
      .bind(sent.providerId, iso(now), job.id, lease).run();
    await finalizeCampaign(env, campaignId, now);
    return { result: 'sent', campaignId, jobId: job.id, ...await detail(env, campaignId) };
  } catch (error) {
    if (!job) throw error;
    const stillOwned = await env.DB.prepare(`SELECT 1 AS owned FROM send_control c JOIN send_jobs j ON j.id=?
      WHERE c.id='gmail' AND c.lease_id=? AND c.lease_until>? AND j.lease_id=? AND j.status='processing'`).bind(job.id, lease, currentTime(), lease).first();
    if (!stillOwned) return { result: 'blocked', reason: 'CLAIM_NO_LONGER_VALID', campaignId, jobId: job.id, ...await detail(env, campaignId) };
    const disposition = error instanceof GmailError ? error.disposition : 'unknown';
    const code = error instanceof GmailError ? error.code : 'DELIVERY_RESULT_UNKNOWN';
    const status = disposition === 'unknown' ? 'needs_review' : disposition === 'permanent' ? 'failed' : 'retry';
    const delay = Math.max(error.retryAfter || 0, Math.min(DAY, 60000 * 2 ** Math.min(job.attempts, 6)));
    const exhausted = status === 'retry' && job.attempts >= 4;
    const finalStatus = exhausted ? 'failed' : status;
    await env.DB.batch([
      env.DB.prepare("UPDATE send_jobs SET status=?,last_error=?,next_attempt_at=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=? AND status='processing' AND EXISTS(SELECT 1 FROM send_control WHERE id='gmail' AND lease_id=?)")
        .bind(finalStatus, code, now + delay, iso(now), job.id, lease, lease),
      env.DB.prepare("UPDATE send_campaigns SET status='paused',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM send_control WHERE id='gmail' AND lease_id=?)").bind(iso(now), campaignId, lease),
      env.DB.prepare("UPDATE send_control SET next_send_at=MAX(next_send_at,?) WHERE id='gmail' AND lease_id=?").bind(now + (disposition === 'retry' ? delay : 0), lease)
    ]);
    return { result: finalStatus === 'needs_review' ? 'needs_review' : disposition === 'blocked' ? 'blocked' : finalStatus,
      reason: code, campaignId, jobId: job.id, nextAttemptAt: finalStatus === 'retry' ? now + delay : undefined, ...await detail(env, campaignId) };
  } finally {
    await env.DB.prepare("UPDATE send_control SET lease_id=NULL,lease_until=0 WHERE id='gmail' AND lease_id=?").bind(lease).run();
  }
}

export async function handleSending(request, env, { now = Date.now(), readJSON, fetchImpl, oauthStatus = {} } = {}) {
  await ensureControl(env);
  const path = new URL(request.url).pathname, adapter = createGmailAdapter(env, { fetchImpl, clock: () => now });
  if (path === '/api/admin/sending/status' && request.method === 'GET') return reply({ ...await sendingStatus(env, now), ...oauthStatus });
  if (path === '/api/admin/sending/check' && request.method === 'POST') {
    await readJSON(request, 4096);
    await verifyConnection(env, adapter, now);
    return reply({ ...await sendingStatus(env, now), ...oauthStatus });
  }
  if (path === '/api/admin/sending/campaigns' && request.method === 'POST') return reply(await stageCampaign(env, (await readJSON(request, 4096)).draftId, now));
  if (path === '/api/admin/sending/campaigns' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT c.*,COUNT(j.id) AS recipient_count FROM send_campaigns c LEFT JOIN send_jobs j ON c.id=j.campaign_id
      WHERE ?=0 OR EXISTS(SELECT 1 FROM google_campaign_owners o WHERE o.campaign_id=c.id AND o.google_sub=?) GROUP BY c.id ORDER BY c.created_at DESC LIMIT 100`)
      .bind(env.GMAIL_SESSION_OAUTH === 'true' ? 1 : 0, env.GMAIL_CONNECTION_ID || '').all();
    return reply({ campaigns: rows.results.map(row => publicCampaign(row, row.recipient_count)) });
  }
  if (path === '/api/admin/sending/dispatch' && request.method === 'POST') return reply(await dispatchOne(env, (await readJSON(request, 4096)).campaignId, { adapter, now }));
  const match = path.match(/^\/api\/admin\/sending\/campaigns\/([A-Za-z0-9_-]{8,80})(?:\/(start|pause))?$/);
  if (match && request.method === 'GET' && !match[2]) return reply(await detail(env, match[1], true));
  if (match && request.method === 'POST') {
    await readJSON(request, 4096);
    if (match[2] === 'start') return reply(await startCampaign(env, match[1], adapter, now));
    if (match[2] === 'pause') {
      await assertCampaignOwner(env, match[1]);
      await env.DB.prepare("UPDATE send_campaigns SET status='paused',updated_at=? WHERE id=? AND status='running'").bind(iso(now), match[1]).run();
      return reply(await detail(env, match[1]));
    }
  }
  reject('Not found.', 404);
}

export async function handleUnsubscribe(request, env, now = Date.now()) {
  const url = new URL(request.url), contactId = url.searchParams.get('contact') || '', token = url.searchParams.get('token') || '';
  if (!CONTACT_ID.test(contactId) || !/^[A-Za-z0-9_-]{43}$/.test(token) || !equal(token, await unsubscribeToken(env, contactId))) reject('This unsubscribe link is invalid.', 400);
  if (request.method === 'GET' && url.pathname === '/unsubscribe') {
    const action = `/api/unsubscribe?contact=${contactId}&token=${token}`;
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CES email</title><body><h1>Columbia Economics Society</h1><p>Stop receiving CES newsletter emails.</p><form method="post" action="${action}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form></body></html>`, { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    } });
  }
  if (request.method !== 'POST' || url.pathname !== '/api/unsubscribe') reject('Use the unsubscribe button.', 405);
  if (Number(request.headers.get('content-length') || 0) > 1024) reject('Invalid request.', 413);
  const reader = request.body?.getReader(); let bytes = 0;
  if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 1024) { await reader.cancel(); reject('Invalid request.', 413); } }
  const at = iso(now), source = JSON.stringify({ source: 'ces-email-unsubscribe', status: 'unsubscribed', at });
  await env.DB.batch([
    env.DB.prepare("UPDATE contacts SET status='unsubscribed',updated_at=?,record_json=json_set(record_json,'$.status','unsubscribed','$.updatedAt',?,'$.sources',json_insert(COALESCE(json_extract(record_json,'$.sources'),'[]'),'$[#]',json(?))) WHERE id=? AND status IN ('subscribed','pending')").bind(at, at, source, contactId),
    env.DB.prepare("UPDATE send_jobs SET status='skipped',last_error='CONTACT_SUPPRESSED',updated_at=? WHERE contact_id=? AND status IN ('prepared','queued','retry')").bind(at, contactId)
  ]);
  return new Response('You have been unsubscribed from CES newsletter emails.', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}
