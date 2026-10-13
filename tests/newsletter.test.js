const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeEmail, validatePublicInput, allowedOrigin, getClientKey, emptyState, validateState,
  applyPublicRequest, tokenHash, newManageToken, mergeImports, exportRecords,
  recordsToCsv, parseCsv, csvCell, takeRateSlot
} = require('../lib/newsletter.js');
const { ConflictError, createBlobStore, transact } = require('../lib/newsletter-store.js');
const { createHandler } = require('../api/newsletter.js');

const NOW = Date.parse('2026-10-13T16:00:00Z');
const ENV = { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'fixture-secret-that-is-not-an-actual-credential' };
const TOKEN = 'a'.repeat(43);
const INPUT = { action: 'subscribe', email: 'member@example.test', name: 'Example Person', interests: ['events'], consent: true };
const clientKey = digit => String(digit).repeat(64);

function memoryStore(initial) {
  let state = initial ? structuredClone(initial) : null;
  let revision = initial ? 1 : 0;
  const api = {
    writes: 0,
    async read() { return state ? { state: structuredClone(state), etag: String(revision) } : null; },
    async write(next, etag) {
      if ((state ? String(revision) : undefined) !== etag) throw new ConflictError();
      validateState(next);
      state = structuredClone(next);
      revision++;
      api.writes++;
    },
    snapshot() { return structuredClone(state); }
  };
  return api;
}

function request(body = INPUT, changes = {}) {
  return {
    method: 'POST', headers: {
      origin: 'https://cueconsociety.com', 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10'
    }, body, ...changes
  };
}

async function call(handler, req) {
  const response = {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
  await handler(req, response);
  return response;
}

test('Email normalization is stable and rejects malformed or oversized addresses', () => {
  assert.equal(normalizeEmail('  Person+CES@Example.TEST '), 'person+ces@example.test');
  for (const invalid of ['x', 'x@y', 'x@@example.test', 'x..x@example.test', '.x@example.test', 'x@-example.test', 'x@example..test', 'x@example.test\nBcc:bad', `${'a'.repeat(65)}@example.test`]) {
    assert.throws(() => normalizeEmail(invalid));
  }
});

test('Consent and field validation fail closed; optional interests and name work', () => {
  assert.deepEqual(validatePublicInput({ ...INPUT, name: undefined, interests: [] }, NOW).interests, []);
  assert.equal(validatePublicInput({ ...INPUT, name: undefined }, NOW).name, '');
  for (const change of [{ consent: false }, { consent: 'true' }, { name: 'x'.repeat(101) }, { interests: ['all'] }, { action: 'export' }, { startedAt: NOW + 60000 }, { email: ['x@example.test'] }]) {
    assert.throws(() => validatePublicInput({ ...INPUT, ...change }, NOW));
  }
});

test('Only exact production origins are allowed; localhost requires explicit development', () => {
  assert.equal(allowedOrigin('https://cueconsociety.com', ENV), true);
  for (const origin of [undefined, 'null', 'https://cueconsociety.com.evil.test', 'http://cueconsociety.com', 'https://preview.vercel.app', 'http://localhost:3000']) {
    assert.equal(allowedOrigin(origin, ENV), false);
  }
  assert.equal(allowedOrigin('http://localhost:3000', { NODE_ENV: 'development' }), true);
  assert.equal(allowedOrigin('http://localhost:3000', { NODE_ENV: 'development', VERCEL: '1' }), false);
});

test('Client IP keys are secret-dependent hashes, and missing or invalid Vercel IP fails closed', () => {
  const key = getClientKey(request(), ENV);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key.includes('192.0.2'), false);
  assert.notEqual(key, getClientKey(request(), { ...ENV, BLOB_READ_WRITE_TOKEN: 'different-fixture-secret-that-is-not-a-credential' }));
  assert.throws(() => getClientKey(request(INPUT, { headers: {} }), ENV));
  assert.throws(() => getClientKey(request(INPUT, { headers: { 'x-forwarded-for': '192.0.2.1, 1.2.3.4' } }), ENV));
  assert.throws(() => getClientKey(request(), {}));
});

test('Concurrent initial subscriptions preserve both contacts with conditional creation', async () => {
  const store = memoryStore();
  await Promise.all(Array.from({ length: 4 }, (_, index) => transact(store, state => applyPublicRequest(state,
    { ...INPUT, email: `person${index}@example.test` },
    { now: NOW, clientKey: clientKey(index + 1), token: newManageToken() }), { now: NOW, pause: async () => {} })));
  assert.equal(Object.keys(store.snapshot().subscribers).length, 4);
  assert.equal(store.writes, 4);
});

test('Concurrent duplicate subscriptions return uniform tokens while preserving only the original valid hash', async () => {
  const store = memoryStore();
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => transact(store, state => applyPublicRequest(state,
    { ...INPUT, name: `Person ${index}` },
    { now: NOW, clientKey: clientKey(index + 1), token: newManageToken() }), { now: NOW, pause: async () => {} })));
  assert.equal(Object.keys(store.snapshot().subscribers).length, 1);
  assert.equal(results.filter(result => result.body.manageToken).length, 4);
  assert.equal(results.filter(result => tokenHash(result.body.manageToken) === store.snapshot().subscribers[INPUT.email].unsubscribeTokenHash).length, 1);
  assert.equal(store.snapshot().subscribers[INPUT.email].name, 'Person 0');
  assert.equal(store.snapshot().rateLimits.total, 4);
});

test('Subscribed, pending, and all suppressed contacts are unchanged by public signup', () => {
  for (const status of ['subscribed', 'pending', 'unsubscribed', 'cleaned', 'archived']) {
    const state = emptyState(NOW);
    mergeImports(state, [{ email: INPUT.email, name: 'Original', status }], { source: 'fixture', at: new Date(NOW).toISOString() });
    const previous = structuredClone(state.subscribers[INPUT.email]);
    const result = applyPublicRequest(state, INPUT, { now: NOW, clientKey: clientKey(1), token: TOKEN });
    assert.deepEqual(state.subscribers[INPUT.email], previous);
    assert.deepEqual(result.result.body, { ok: true, message: 'Your request has been received.', manageToken: TOKEN });
  }
});

test('Unsubscribe requires the private token, stores only its hash, and is idempotent', () => {
  const state = emptyState(NOW);
  applyPublicRequest(state, INPUT, { now: NOW, clientKey: clientKey(1), token: TOKEN });
  assert.equal(state.subscribers[INPUT.email].unsubscribeTokenHash, tokenHash(TOKEN));
  assert.equal(JSON.stringify(state).includes(TOKEN), false);
  assert.throws(() => validatePublicInput({ action: 'unsubscribe', email: INPUT.email }));
  const bad = applyPublicRequest(state, { action: 'unsubscribe', email: INPUT.email, token: 'b'.repeat(43) }, { now: NOW, clientKey: clientKey(2) });
  assert.equal(state.subscribers[INPUT.email].status, 'subscribed');
  const good = applyPublicRequest(state, { action: 'unsubscribe', email: INPUT.email, token: TOKEN }, { now: NOW, clientKey: clientKey(3) });
  assert.equal(state.subscribers[INPUT.email].status, 'unsubscribed');
  assert.deepEqual(good.result.body, bad.result.body);
  const previous = structuredClone(state.subscribers[INPUT.email]);
  applyPublicRequest(state, { action: 'unsubscribe', email: INPUT.email, token: TOKEN }, { now: NOW, clientKey: clientKey(4) });
  assert.deepEqual(state.subscribers[INPUT.email], previous);
});

test('Unsubscribe does not downgrade a cleaned suppression', () => {
  const state = emptyState(NOW);
  applyPublicRequest(state, INPUT, { now: NOW, clientKey: clientKey(1), token: TOKEN });
  state.subscribers[INPUT.email].status = 'cleaned';
  applyPublicRequest(state, { action: 'unsubscribe', email: INPUT.email, token: TOKEN }, { now: NOW, clientKey: clientKey(2) });
  assert.equal(state.subscribers[INPUT.email].status, 'cleaned');
});

test('Durable limits apply across handler instances and stop writes when exceeded', async () => {
  const store = memoryStore();
  for (let index = 0; index < 5; index++) {
    const result = await call(createHandler({ store, env: ENV, clock: () => NOW }), request({ ...INPUT, email: `person${index}@example.test` }));
    assert.equal(result.statusCode, 200);
  }
  const blocked = await call(createHandler({ store, env: ENV, clock: () => NOW }), request());
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['retry-after'], '3600');
  assert.equal(store.writes, 5);
  assert.equal(JSON.stringify(store.snapshot()).includes('192.0.2.10'), false);
});

test('Global daily cap and bounded IP state fail closed; rollover discards old hashed IPs', () => {
  const state = emptyState(NOW);
  assert.equal(takeRateSlot(state, clientKey(1), NOW, { globalDaily: 1 }), true);
  assert.equal(takeRateSlot(state, clientKey(2), NOW, { globalDaily: 1 }), false);
  assert.equal(takeRateSlot(state, clientKey(2), NOW + 86400000, { globalDaily: 1 }), true);
  assert.deepEqual(Object.keys(state.rateLimits.ips), [clientKey(2)]);
  assert.equal(takeRateSlot(state, clientKey(3), NOW + 86400000, { globalDaily: 10, maxIps: 1 }), false);
});

test('API rejects cross-origin, untrusted types, excessive payloads, GET, and malformed JSON without storage access', async () => {
  const store = { read() { throw new Error('storage must not be called'); } };
  const handler = createHandler({ store, env: ENV, clock: () => NOW });
  const cases = [
    [request(INPUT, { headers: { origin: 'https://evil.test' } }), 403],
    [request(INPUT, { headers: { origin: 'https://cueconsociety.com', 'content-type': 'text/plain' } }), 415],
    [request(INPUT, { headers: { origin: 'https://cueconsociety.com', 'content-type': 'application/json', 'content-length': '5000' } }), 413],
    [request({ ...INPUT, name: 'x'.repeat(5000) }), 413],
    [request('{'), 400],
    [request(INPUT, { method: 'GET' }), 405]
  ];
  for (const [req, expected] of cases) assert.equal((await call(handler, req)).statusCode, expected);
});

test('Honeypot returns generic success without reading or modifying storage', async () => {
  const handler = createHandler({ store: { read() { throw new Error('must not read'); } }, env: ENV });
  const response = await call(handler, request({ website: 'spam.test' }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, message: 'Your request has been received.' });
});

test('Preview deployments cannot mutate the production store even with a spoofed valid origin', async () => {
  const store = memoryStore();
  for (const environment of ['preview', 'development', undefined]) {
    const handler = createHandler({ store, env: { ...ENV, VERCEL_ENV: environment }, clock: () => NOW });
    const response = await call(handler, request());
    assert.equal(response.statusCode, 503);
  }
  assert.equal(store.writes, 0);
});

test('Storage failures reveal no contacts, credentials, or internal error and never fall back to ephemeral success', async () => {
  const reports = [];
  const handler = createHandler({ store: { read() { throw new Error('SECRET / users@example.test / storage-url'); } }, env: ENV, clock: () => NOW, report: entry => reports.push(entry) });
  const response = await call(handler, request());
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.stringify(response).includes('SECRET'), false);
  assert.equal(JSON.stringify(response).includes('users@example.test'), false);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(reports, [{ event: 'ces_newsletter_failure', phase: 'storage-read', reason: 'UNEXPECTED_FAILURE' }]);
});

test('Operational failure logs contain fixed classifications only, with no request or error values', async () => {
  const cases = [
    [{ ...ENV, BLOB_READ_WRITE_TOKEN: undefined }, request(), 'client-key', 'RATE_SECRET_MISSING'],
    [ENV, request(INPUT, { headers: { origin: 'https://cueconsociety.com', 'content-type': 'application/json' } }), 'client-key', 'CLIENT_IP_MISSING'],
    [ENV, request(INPUT, { headers: { origin: 'https://cueconsociety.com', 'content-type': 'application/json', 'x-forwarded-for': 'private-value' } }), 'client-key', 'CLIENT_IP_INVALID']
  ];
  for (const [env, req, phase, reason] of cases) {
    const reports = [];
    const response = await call(createHandler({ env, store: memoryStore(), clock: () => NOW, report: entry => reports.push(entry) }), req);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(reports, [{ event: 'ces_newsletter_failure', phase, reason }]);
    assert.equal(JSON.stringify(reports).includes(INPUT.email), false);
    assert.equal(JSON.stringify(reports).includes('private-value'), false);
    assert.equal(JSON.stringify(reports).includes(ENV.BLOB_READ_WRITE_TOKEN), false);
  }
});

test('API has no audience export or search action', async () => {
  const store = memoryStore();
  const handler = createHandler({ store, env: ENV, clock: () => NOW });
  for (const action of ['export', 'list', 'search', 'delete', 'import']) {
    const response = await call(handler, request({ action, email: INPUT.email }));
    assert.equal(response.statusCode, 400);
  }
  assert.equal(store.writes, 0);
});

test('Import suppression precedence is order-independent and retains provenance', () => {
  const rows = ['subscribed', 'archived', 'unsubscribed', 'cleaned'].map(status => ({ email: INPUT.email, status, name: 'Original', source: status, original: { status, note: 'source evidence' } }));
  for (const order of [rows, [...rows].reverse()]) {
    const state = emptyState(NOW);
    mergeImports(state, order, { at: new Date(NOW).toISOString() });
    assert.equal(state.subscribers[INPUT.email].status, 'cleaned');
    assert.equal(state.subscribers[INPUT.email].sources.length, 4);
    assert.equal(state.subscribers[INPUT.email].sources[0].sourceRecord.note, 'source evidence');
    mergeImports(state, [{ email: INPUT.email, status: 'subscribed', name: 'Replacement' }], { source: 'later list', at: new Date(NOW + 1000).toISOString() });
    assert.equal(state.subscribers[INPUT.email].status, 'cleaned');
    assert.equal(state.subscribers[INPUT.email].name, 'Original');
  }
});

test('Import never revives suppression recorded in historical provenance', () => {
  const state = emptyState(NOW);
  mergeImports(state, [{ email: INPUT.email, status: 'unsubscribed' }], { source: 'old list', at: new Date(NOW).toISOString() });
  state.subscribers[INPUT.email].status = 'subscribed';
  mergeImports(state, [{ email: INPUT.email, status: 'subscribed' }], { source: 'new list', at: new Date(NOW).toISOString() });
  assert.equal(state.subscribers[INPUT.email].status, 'unsubscribed');
});

test('Unknown source consent is pending; deduplication ignores email case and repeated imports are idempotent', () => {
  const state = emptyState(NOW);
  const rows = [{ email: ' Member@Example.Test ', name: 'Person', status: 'unknown' }];
  const settings = { source: 'event roster', at: new Date(NOW).toISOString() };
  assert.equal(mergeImports(state, rows, settings).result.added, 1);
  assert.equal(state.subscribers[INPUT.email].status, 'pending');
  assert.equal(mergeImports(state, rows, { ...settings, at: new Date(NOW + 1000).toISOString() }).changed, false);
  assert.equal(state.subscribers[INPUT.email].sources.length, 1);
});

test('Bulk import uses one conditional state write, not one blob operation per contact', async () => {
  const store = memoryStore();
  const rows = Array.from({ length: 1656 }, (_, index) => ({ email: `member${index}@example.test`, status: index % 10 ? 'subscribed' : 'unsubscribed' }));
  const result = await transact(store, state => mergeImports(state, rows, { source: 'fixture audience', at: new Date(NOW).toISOString() }), { now: NOW });
  assert.equal(store.writes, 1);
  assert.equal(result.total, 1656);
  assert.equal(result.statuses.unsubscribed, 166);
});

test('A bad import row aborts without a partial stored audience', async () => {
  const store = memoryStore();
  await assert.rejects(transact(store, state => mergeImports(state,
    [{ email: INPUT.email, status: 'subscribed' }, { email: 'bad' }],
    { source: 'fixture', at: new Date(NOW).toISOString() })));
  assert.equal(store.writes, 0);
});

test('CSV export quotes delimiters, neutralizes spreadsheet formulas, and omits management credentials', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('  @SUM(A1)'), '"\'  @SUM(A1)"');
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  const state = emptyState(NOW);
  applyPublicRequest(state, { ...INPUT, name: '=DANGEROUS()' }, { now: NOW, clientKey: clientKey(1), token: TOKEN });
  const records = exportRecords(state);
  const csv = recordsToCsv(records);
  assert.equal(csv.includes("'=DANGEROUS()"), true);
  assert.equal(JSON.stringify(records).includes('unsubscribeTokenHash'), false);
  assert.equal(csv.includes(tokenHash(TOKEN)), false);
  assert.equal(csv.includes(TOKEN), false);
});

test('Active-only export excludes every suppressed and pending address', () => {
  const state = emptyState(NOW);
  const statuses = ['subscribed', 'unsubscribed', 'cleaned', 'archived', 'pending'];
  mergeImports(state, statuses.map(status => ({ email: `${status}@example.test`, status })), { source: 'fixture', at: new Date(NOW).toISOString() });
  assert.equal(exportRecords(state).length, 5);
  assert.deepEqual(exportRecords(state, { activeOnly: true }).map(row => row.status), ['subscribed']);
});

test('CSV input parses escaped quotes and embedded newlines and rejects malformed files', () => {
  assert.deepEqual(parseCsv('email,name\r\n"a@example.test","A, ""B"""\r\n'), [{ email: 'a@example.test', name: 'A, "B"' }]);
  assert.deepEqual(parseCsv('email,note\n"a@example.test","line1\nline2"'), [{ email: 'a@example.test', note: 'line1\nline2' }]);
  for (const csv of ['a,a\n1,2', 'email,name\nx', 'email,name\nx,"bad', 'email,name\nx,"bad"more']) assert.throws(() => parseCsv(csv));
});

test('A CSV audience export can be reimported with interests and suppression intact', () => {
  const first = emptyState(NOW);
  mergeImports(first, [{ ...INPUT, status: 'unsubscribed' }], { source: 'fixture', at: new Date(NOW).toISOString() });
  const rows = parseCsv(recordsToCsv(exportRecords(first)));
  const second = emptyState(NOW);
  mergeImports(second, rows, { source: 'export copy', at: new Date(NOW).toISOString() });
  assert.equal(second.subscribers[INPUT.email].status, 'unsubscribed');
  assert.deepEqual(second.subscribers[INPUT.email].interests, ['events']);
});

test('Private Blob reads bypass caches and writes require matching ETags', async () => {
  const state = emptyState(NOW);
  const calls = [];
  const sdk = {
    async get(path, options) {
      calls.push(['get', path, options]);
      return { statusCode: 200, blob: { etag: 'etag1', size: 100 }, stream: new Response(JSON.stringify(state)).body };
    },
    async put(path, payload, options) { calls.push(['put', path, options]); }
  };
  const store = createBlobStore({ token: ENV.BLOB_READ_WRITE_TOKEN, sdk });
  const current = await store.read();
  await store.write(current.state, current.etag);
  assert.equal(calls[0][2].access, 'private');
  assert.equal(calls[0][2].useCache, false);
  assert.equal(calls[1][2].access, 'private');
  assert.equal(calls[1][2].ifMatch, 'etag1');
  assert.equal(calls[1][2].allowOverwrite, true);
  await store.write(state, undefined);
  assert.equal(calls[2][2].allowOverwrite, false);
  assert.equal('ifMatch' in calls[2][2], false);
});

test('Repeated CAS conflicts stop after a bounded retry count', async () => {
  let writes = 0;
  const store = { read: async () => null, write: async () => { writes++; throw new ConflictError(); } };
  await assert.rejects(transact(store, state => ({ changed: true, result: state.revision }), { attempts: 3, pause: async () => {} }), ConflictError);
  assert.equal(writes, 3);
});
