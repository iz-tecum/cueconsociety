const STATUSES = new Set(['subscribed', 'unsubscribed', 'cleaned', 'archived', 'pending']);
const INTERESTS = new Set(['events', 'careers', 'research', 'social']);
const encoder = new TextEncoder();

function invalid() { throw new Error('The import contains an invalid contact.'); }
function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
async function idFor(email) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(email)))].map(value => value.toString(16).padStart(2, '0')).join(''); }

export async function normalizeImportRecord(row, at = new Date().toISOString()) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) invalid();
  const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(email)) invalid();
  const [local, domain] = email.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.split('.').some(part => !part.length || part.length > 63 || part.startsWith('-') || part.endsWith('-'))) invalid();
  if (!STATUSES.has(row.status) || (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 100 || /[\x00-\x1f\x7f]/.test(row.name)))) invalid();
  const interests = row.interests ?? [], sources = row.sources ?? [];
  if (!Array.isArray(interests) || interests.length > 4 || interests.some(value => !INTERESTS.has(value)) || !Array.isArray(sources) || sources.length > 200) invalid();
  if (sources.some(value => !value || typeof value !== 'object' || Array.isArray(value))) invalid();
  if (row.consent !== undefined && row.consent !== null && (typeof row.consent !== 'object' || Array.isArray(row.consent))) invalid();
  const tokenHash = row.unsubscribeTokenHash ?? row.unsubscribe_token_hash ?? null;
  if (tokenHash !== null && (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash))) invalid();
  if ((row.createdAt !== undefined && !validDate(row.createdAt)) || (row.updatedAt !== undefined && !validDate(row.updatedAt))) invalid();
  const createdAt = row.createdAt ? new Date(row.createdAt).toISOString() : at;
  const updatedAt = row.updatedAt ? new Date(row.updatedAt).toISOString() : createdAt;
  const record = {
    email, name: (row.name || '').trim().normalize('NFC'), status: row.status, interests: [...new Set(interests)],
    sources, consent: row.consent ?? null, createdAt, updatedAt
  };
  const json = JSON.stringify(record);
  if (encoder.encode(json).length > 65536) invalid();
  return { id: await idFor(email), email, status: row.status, json, tokenHash, createdAt, updatedAt };
}

const rank = expression => `(CASE ${expression} WHEN 'cleaned' THEN 4 WHEN 'unsubscribed' THEN 3 WHEN 'archived' THEN 2 WHEN 'subscribed' THEN 1 ELSE 0 END)`;
const status = `CASE WHEN ${rank('contacts.status')} >= ${rank('excluded.status')} THEN contacts.status ELSE excluded.status END`;
const UPSERT = `INSERT INTO contacts(id,email,status,record_json,unsubscribe_token_hash,created_at,updated_at)
SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM contacts) < 25000 OR EXISTS(SELECT 1 FROM contacts WHERE email=?)
ON CONFLICT(email) DO UPDATE SET
 status=${status},
 record_json=json_set(excluded.record_json,
  '$.status',${status},
  '$.name',COALESCE(NULLIF(json_extract(contacts.record_json,'$.name'),''),json_extract(excluded.record_json,'$.name')),
  '$.createdAt',contacts.created_at,
  '$.updatedAt',MAX(contacts.updated_at,excluded.updated_at),
  '$.consent',json(COALESCE(json_extract(contacts.record_json,'$.consent'),json_extract(excluded.record_json,'$.consent'),'null')),
  '$.interests',json((SELECT json_group_array(value) FROM (SELECT value FROM json_each(contacts.record_json,'$.interests') UNION SELECT value FROM json_each(excluded.record_json,'$.interests')))),
  '$.sources',json((SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(contacts.record_json,'$.sources') UNION SELECT value FROM json_each(excluded.record_json,'$.sources'))))
 ),
 unsubscribe_token_hash=COALESCE(contacts.unsubscribe_token_hash,excluded.unsubscribe_token_hash),
 updated_at=MAX(contacts.updated_at,excluded.updated_at)`;

export async function importRecords(database, records, { maxRows = 500, now = Date.now() } = {}) {
  if (!Array.isArray(records) || !records.length || records.length > maxRows) throw new Error(`Choose 1–${maxRows} contacts per import.`);
  const normalized = await Promise.all(records.map(record => normalizeImportRecord(record, new Date(now).toISOString())));
  if (new Set(normalized.map(row => row.email)).size !== normalized.length) throw new Error('The import contains duplicate email addresses.');
  const statements = normalized.map(row => database.prepare(UPSERT).bind(row.id, row.email, row.status, row.json, row.tokenHash, row.createdAt, row.updatedAt, row.email));
  statements.push(database.prepare('INSERT INTO audit(id,action,detail_json,created_at) VALUES(?,?,?,?)').bind(crypto.randomUUID(), 'audience-import', JSON.stringify({ count: normalized.length }), new Date(now).toISOString()));
  const results = await database.batch(statements);
  const accepted = results.slice(0, -1).reduce((sum, result) => sum + result.meta.changes, 0);
  return { imported: accepted, skippedAtCapacity: normalized.length - accepted, updatedAt: new Date(now).toISOString() };
}
