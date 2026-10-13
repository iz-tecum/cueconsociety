const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');

const INTERESTS = Object.freeze(['events', 'careers', 'research', 'social']);
const STATUSES = Object.freeze(['subscribed', 'unsubscribed', 'cleaned', 'archived', 'pending']);
const SUPPRESSED = new Set(['unsubscribed', 'cleaned', 'archived']);
const MAX_CONTACTS = 25000;
const MAX_BODY_BYTES = 4096;
const GENERIC_MESSAGE = 'Your request has been received.';
const ALLOWED_ORIGINS = new Set([
  'https://cueconsociety.com',
  'https://www.cueconsociety.com',
  'https://cueconsociety.vercel.app',
  'https://iz-tecum.github.io'
]);

class NewsletterError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new NewsletterError('Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(email)) {
    throw new NewsletterError('Enter a valid email address.');
  }
  const [local, domain] = email.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      domain.split('.').some(part => !part.length || part.length > 63 || part.startsWith('-') || part.endsWith('-'))) {
    throw new NewsletterError('Enter a valid email address.');
  }
  return email;
}

function normalizeName(value = '') {
  if (typeof value !== 'string' || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new NewsletterError('Use a name of 100 characters or fewer.');
  }
  return value.trim().normalize('NFC');
}

function validatePublicInput(body, now = Date.now()) {
  if (!isObject(body)) throw new NewsletterError('Send a JSON object.');
  if (body.website !== undefined && (typeof body.website !== 'string' || body.website.length > 200)) {
    throw new NewsletterError('Invalid form fields.');
  }
  if (body.website?.trim()) return { honeypot: true };
  if (!['subscribe', 'unsubscribe'].includes(body.action)) throw new NewsletterError('Choose a valid action.');
  const email = normalizeEmail(body.email);
  if (body.action === 'unsubscribe') {
    if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
      throw new NewsletterError('Use the complete private unsubscribe link.');
    }
    return { action: 'unsubscribe', email, token: body.token };
  }
  if (body.consent !== true) throw new NewsletterError('Confirm that you want CES email updates.');
  const interests = body.interests ?? [];
  if (!Array.isArray(interests) || interests.length > 4 ||
      interests.some(interest => !INTERESTS.includes(interest))) {
    throw new NewsletterError('Choose valid newsletter topics.');
  }
  if (body.startedAt !== undefined && (!Number.isSafeInteger(body.startedAt) || body.startedAt > now + 30000 || body.startedAt < now - 7 * 86400000)) {
    throw new NewsletterError('Refresh the page and try again.');
  }
  return {
    action: 'subscribe', email, name: normalizeName(body.name),
    interests: [...new Set(interests)], consent: true
  };
}

function allowedOrigin(origin, env = process.env) {
  if (typeof origin !== 'string') return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return env.NODE_ENV === 'development' && !env.VERCEL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}

function getClientKey(req, env = process.env) {
  const secret = env.NEWSLETTER_RATE_SECRET || env.BLOB_READ_WRITE_TOKEN;
  if (!secret || secret.length < 24) throw new NewsletterError('Signup is temporarily unavailable. Please try again later.', 503, 'RATE_SECRET_MISSING');
  const ip = env.VERCEL === '1' ? req.headers['x-forwarded-for'] : req.socket?.remoteAddress;
  if (typeof ip !== 'string' || !isIP(ip.trim())) {
    throw new NewsletterError('Signup is temporarily unavailable. Please try again later.', 503, typeof ip === 'string' ? 'CLIENT_IP_INVALID' : 'CLIENT_IP_MISSING');
  }
  let canonicalIp;
  try { canonicalIp = new URL(`http://${ip.trim().includes(':') ? `[${ip.trim()}]` : ip.trim()}/`).hostname; }
  catch { throw new NewsletterError('Signup is temporarily unavailable. Please try again later.', 503, 'CLIENT_IP_INVALID'); }
  return createHmac('sha256', secret).update(`ces-newsletter-ip-v1:${canonicalIp}`).digest('hex');
}

function emptyState(now = Date.now()) {
  return {
    schemaVersion: 1, revision: 0, updatedAt: new Date(now).toISOString(),
    subscribers: {}, rateLimits: { day: '', total: 0, ips: {} }
  };
}

function validateState(state) {
  if (!isObject(state) || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) ||
      !isObject(state.subscribers) || Object.keys(state.subscribers).length > MAX_CONTACTS ||
      !isObject(state.rateLimits) || !isObject(state.rateLimits.ips) ||
      !Number.isSafeInteger(state.rateLimits.total) || state.rateLimits.total < 0 ||
      typeof state.rateLimits.day !== 'string' || Object.keys(state.rateLimits.ips).length > 1000) {
    throw new Error('Newsletter storage is invalid.');
  }
  for (const [email, record] of Object.entries(state.subscribers)) {
    if (!isObject(record) || normalizeEmail(email) !== email || record.email !== email ||
        !STATUSES.includes(record.status) || !Array.isArray(record.sources) ||
        !Array.isArray(record.interests) || record.interests.some(value => !INTERESTS.includes(value))) {
      throw new Error('Newsletter contact data is invalid.');
    }
  }
  for (const [key, value] of Object.entries(state.rateLimits.ips)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !isObject(value) || !Number.isSafeInteger(value.hour) ||
        !Number.isSafeInteger(value.hourCount) || value.hourCount < 0 ||
        !Number.isSafeInteger(value.dayCount) || value.dayCount < 0) {
      throw new Error('Newsletter rate data is invalid.');
    }
  }
  return state;
}

function takeRateSlot(state, clientKey, now, limits = {}) {
  const caps = { hourly: 5, daily: 15, globalDaily: 200, maxIps: 1000, ...limits };
  const day = new Date(now).toISOString().slice(0, 10);
  const hour = Math.floor(now / 3600000);
  const rates = state.rateLimits.day === day ? state.rateLimits : { day, total: 0, ips: {} };
  const previous = rates.ips[clientKey] || { hour, hourCount: 0, dayCount: 0 };
  if (rates.total >= caps.globalDaily || previous.dayCount >= caps.daily ||
      (previous.hour === hour && previous.hourCount >= caps.hourly) ||
      (!rates.ips[clientKey] && Object.keys(rates.ips).length >= caps.maxIps)) {
    return false;
  }
  rates.ips[clientKey] = {
    hour, hourCount: previous.hour === hour ? previous.hourCount + 1 : 1,
    dayCount: previous.dayCount + 1
  };
  rates.total += 1;
  state.rateLimits = rates;
  return true;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function matchesToken(token, storedHash) {
  const expected = typeof storedHash === 'string' && /^[a-f0-9]{64}$/.test(storedHash) ? storedHash : '0'.repeat(64);
  return timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(expected, 'hex')) && Boolean(storedHash);
}

function applyPublicRequest(state, input, options) {
  const { now, clientKey, token, limits } = options;
  if (!takeRateSlot(state, clientKey, now, limits)) {
    return { changed: false, result: { status: 429, body: { ok: false, error: 'Too many requests. Please try again later.' } } };
  }
  const at = new Date(now).toISOString();
  const existing = state.subscribers[input.email];
  const body = { ok: true, message: GENERIC_MESSAGE };
  if (input.action === 'subscribe') body.manageToken = token;
  if (input.action === 'subscribe' && !existing) {
    if (Object.keys(state.subscribers).length >= MAX_CONTACTS) throw new NewsletterError('Signup is temporarily unavailable. Please try again later.', 503);
    state.subscribers[input.email] = {
      email: input.email, name: input.name, status: 'subscribed', interests: input.interests,
      createdAt: at, updatedAt: at,
      consent: { method: 'web-single-opt-in', at, policy: 'ces-newsletter-v1' },
      sources: [{ source: 'ces-website', status: 'subscribed', at }],
      unsubscribeTokenHash: tokenHash(token)
    };
  } else if (input.action === 'unsubscribe') {
    const authorized = matchesToken(input.token, existing?.unsubscribeTokenHash);
    if (existing && authorized && !SUPPRESSED.has(existing.status)) {
      existing.status = 'unsubscribed';
      existing.updatedAt = at;
      existing.sources.push({ source: 'ces-private-unsubscribe-link', status: 'unsubscribed', at });
    }
  }
  return { changed: true, result: { status: 200, body } };
}

function newManageToken() {
  return randomBytes(32).toString('base64url');
}

function normalizeStatus(value) {
  const status = typeof value === 'string' ? value.trim().toLowerCase().replaceAll('_', '-') : '';
  if (STATUSES.includes(status)) return status;
  if (status === 'active') return 'subscribed';
  return 'pending';
}

function sourceSafe(value, depth = 0) {
  if (depth > 8) throw new NewsletterError('Import metadata is too deeply nested.');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sourceSafe(item, depth + 1));
  if (isObject(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      if (!/token|secret|password|authorization|^__proto__$|^constructor$|^prototype$/i.test(key)) result[key] = sourceSafe(item, depth + 1);
    }
    return result;
  }
  return null;
}

function normalizeImportRow(row, options = {}) {
  if (!isObject(row)) throw new NewsletterError('Each import row must be an object.');
  const email = normalizeEmail(row.email ?? row['Email Address'] ?? row['email_address']);
  const name = normalizeName(row.name ?? [row['First Name'], row['Last Name']].filter(Boolean).join(' '));
  const originalStatus = row.status ?? row['Email Marketing Status'] ?? row['Email marketing status'] ?? options.status ?? 'pending';
  const status = normalizeStatus(originalStatus);
  const source = row.source ?? options.source;
  if (typeof source !== 'string' || !source.trim() || source.length > 200) throw new NewsletterError('Each import needs a source label.');
  const at = row.importedAt ?? options.at;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new NewsletterError('Import timestamp is invalid.');
  let interests = row.interests ?? [];
  if (typeof interests === 'string') {
    if (interests.trim().startsWith('[')) {
      try { interests = JSON.parse(interests); }
      catch { throw new NewsletterError('Import contains invalid topic data.'); }
    } else interests = interests.split(/[;,|]/).map(item => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(interests) || interests.some(item => !INTERESTS.includes(item))) throw new NewsletterError('Import contains an unknown topic.');
  const sourceRecord = sourceSafe(row.original ?? row.sourceRecord ?? row);
  const provenance = { source: source.trim(), status, originalStatus, at: new Date(at).toISOString(), sourceRecord };
  provenance.id = createHash('sha256').update(JSON.stringify([source.trim(), status, sourceRecord])).digest('hex');
  return {
    email, name, status, interests: [...new Set(interests)],
    createdAt: typeof row.createdAt === 'string' && !Number.isNaN(Date.parse(row.createdAt)) ? new Date(row.createdAt).toISOString() : provenance.at,
    updatedAt: provenance.at, consent: status === 'subscribed' ? { method: 'imported-source-status', at: provenance.at } : null,
    sources: [provenance]
  };
}

function mergeImports(state, rows, options = {}) {
  const stats = { input: rows.length, added: 0, updated: 0, unchanged: 0, total: 0, statuses: {} };
  const rank = { pending: 0, subscribed: 1, archived: 2, unsubscribed: 3, cleaned: 4 };
  let changed = false;
  for (const row of rows) {
    const incoming = normalizeImportRow(row, options);
    const existing = state.subscribers[incoming.email];
    if (!existing) {
      if (Object.keys(state.subscribers).length >= MAX_CONTACTS) throw new NewsletterError('Import would exceed the contact limit.');
      state.subscribers[incoming.email] = incoming;
      stats.added++;
      changed = true;
      continue;
    }
    const previous = JSON.stringify(existing);
    const strongest = [...existing.sources.map(item => item.status), existing.status, incoming.status]
      .filter(status => STATUSES.includes(status)).sort((left, right) => rank[right] - rank[left])[0];
    existing.status = strongest;
    if (!existing.name) existing.name = incoming.name;
    existing.interests = [...new Set([...existing.interests, ...incoming.interests])];
    if (!existing.sources.some(source => source.id === incoming.sources[0].id)) existing.sources.push(incoming.sources[0]);
    if (JSON.stringify(existing) !== previous) {
      existing.updatedAt = incoming.updatedAt;
      changed = true;
      stats.updated++;
    } else stats.unchanged++;
  }
  stats.total = Object.keys(state.subscribers).length;
  for (const status of STATUSES) stats.statuses[status] = Object.values(state.subscribers).filter(record => record.status === status).length;
  return { changed, result: stats };
}

function exportRecords(state, { activeOnly = false } = {}) {
  return Object.values(state.subscribers)
    .filter(record => !activeOnly || record.status === 'subscribed')
    .sort((left, right) => left.email.localeCompare(right.email))
    .map(({ unsubscribeTokenHash, ...record }) => sourceSafe(record));
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function recordsToCsv(records) {
  const columns = ['email', 'name', 'status', 'interests', 'createdAt', 'updatedAt', 'consent', 'sources'];
  return [columns.map(csvCell).join(','), ...records.map(record => columns.map(column => csvCell(record[column])).join(','))].join('\r\n') + '\r\n';
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (char === ',' || char === '\r' || char === '\n') {
      row.push(field); field = ''; afterQuote = false;
      if (char !== ',') {
        if (row.some(value => value.length)) rows.push(row);
        row = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
      }
    } else if (char === '"' && field === '' && !afterQuote) quoted = true;
    else if (afterQuote || char === '"') throw new NewsletterError('Invalid CSV quoting.');
    else field += char;
  }
  if (quoted) throw new NewsletterError('Unclosed CSV field.');
  row.push(field);
  if (row.some(value => value.length)) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map(value => value.trim());
  if (new Set(headers).size !== headers.length || headers.some(value => !value || ['__proto__', 'constructor', 'prototype'].includes(value))) {
    throw new NewsletterError('CSV headers must be unique and nonempty.');
  }
  return rows.map(values => {
    if (values.length !== headers.length) throw new NewsletterError('CSV row length does not match its headers.');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

module.exports = {
  INTERESTS, STATUSES, MAX_BODY_BYTES, GENERIC_MESSAGE, NewsletterError,
  isObject, normalizeEmail, validatePublicInput, allowedOrigin, getClientKey,
  emptyState, validateState, takeRateSlot, tokenHash, matchesToken,
  applyPublicRequest, newManageToken, normalizeImportRow, mergeImports,
  exportRecords, recordsToCsv, csvCell, parseCsv
};
