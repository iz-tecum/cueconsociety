import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, chmod, stat, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { emailAddress, parseCSV, audienceRows, normalizeAudience, listservRoster, reconcile, run } from '../listserv-bridge.mjs';

const record = (email, status = 'subscribed') => ({ email, status });
const roster = emails => listservRoster(emails.join('\n'), { format: 'email-lines' });
async function privateFixture(t, records = [record('ok@example.org')]) {
  const folder = await mkdtemp(path.join(tmpdir(), 'ces-listserv-test-'));
  await chmod(folder, 0o700);
  t.after(() => rm(folder, { recursive: true, force: true }));
  const audience = path.join(folder, 'audience.json');
  await writeFile(audience, JSON.stringify({ records }), { mode: 0o600 });
  return { folder, audience, output: path.join(folder, 'packet') };
}
function options(fixture, mode = 'first-import', extra = []) {
  return ['--mode', mode, '--audience', fixture.audience, '--output', fixture.output, ...extra];
}

test('CSV parsing handles quoted commas, escaped quotes, newlines and BOM without guessing columns', () => {
  const parsed = parseCSV('\uFEFFEmail,Name,Status\r\n"a@example.org","A, \"\"quoted\"\"\nname",subscribed\r\n');
  assert.deepEqual(parsed.rows, [{ Email: 'a@example.org', Name: 'A, "quoted"\nname', Status: 'subscribed' }]);
  for (const input of ['Email,Email\na,b', 'Email,Status\na', 'Email,Status\n"a,b', 'Email,Status\n"a"oops,b']) assert.throws(() => parseCSV(input));
  assert.throws(() => listservRoster('Email Address,Name\na@example.org,A', { format: 'csv' }), /exact/);
  assert.throws(() => listservRoster('Email Address,Name\na@example.org,A', { format: 'csv', emailColumn: 'Email' }), /does not exist/);
  assert.deepEqual(listservRoster('Email Address,Name\na@example.org,A', { format: 'csv', emailColumn: 'Email Address' }).emails, ['a@example.org']);
});

test('audience exports require explicit and unambiguous status columns', () => {
  const rows = [record('a@example.org', 'unsubscribed')];
  assert.deepEqual(audienceRows(JSON.stringify(rows), 'json'), rows);
  assert.deepEqual(audienceRows(JSON.stringify({ records: rows }), 'json'), rows);
  assert.deepEqual(audienceRows(JSON.stringify({ subscribers: { a: rows[0] } }), 'json'), rows);
  assert.deepEqual(audienceRows('Email Address,Subscription_Status\na@example.org,unsubscribed', 'csv'), rows);
  for (const input of ['Email,Name\na@example.org,A', 'Email,Email Address,Status\na@example.org,b@example.org,subscribed', 'Email,Status,status\na@example.org,subscribed,cleaned']) assert.throws(() => audienceRows(input, 'csv'), /unambiguous/);
  assert.throws(() => audienceRows('{"contacts":[]}', 'json'));
});

test('LISTSERV wildcard, slash and command addresses never become add or delete actions', () => {
  for (const email of ['*@example.org', '/*@example.org', 'a?b@example.org', 'a/b@example.org', 'a\nb@example.org', 'a@example.org\nDELETE *', '..a@example.org', 'a@-example.org', 'a..b@example.org']) assert.equal(emailAddress(email), null);
  assert.equal(emailAddress(' NAME+tag@Example.org '), 'name+tag@example.org');
  const audience = normalizeAudience([record('*@example.org', 'unsubscribed'), record('/*@example.org'), record('safe@example.org')]);
  const initial = reconcile(audience, null, { mode: 'first-import' });
  assert.deepEqual(initial.initialImportCandidates, ['safe@example.org']);
  assert.equal(initial.invalidLocalRows.length, 2);
  const remote = roster(['*@example.org', 'safe@example.org']);
  const result = reconcile(audience, remote, { mode: 'reconcile' });
  assert.equal(result.reportOnly, true);
  assert.deepEqual(result.removeLocalSuppressedPresentOnListserv, []);
});

test('suppression wins across duplicates and repeated subscribed addresses are held', () => {
  const audience = normalizeAudience([
    record('A@example.org'), record('a@example.org', 'unsubscribed'), record('a@example.org', 'cleaned'),
    record('duplicate@example.org'), record('duplicate@example.org'),
    record('archived@example.org', 'archived'), record('pending@example.org', 'pending'),
    record('unknown@example.org', 'unexpected'), record('eligible@example.org'), record('invalid')
  ]);
  const result = reconcile(audience, null, { mode: 'first-import' });
  assert.deepEqual(result.initialImportCandidates, ['eligible@example.org']);
  assert.deepEqual(result.suppressionExclusions, [record('a@example.org', 'cleaned'), record('archived@example.org', 'archived')]);
  assert.equal(result.heldForReview.length, 3);
  assert.equal(result.counts.localDuplicateRows, 3);
  assert.equal(result.counts.localInvalid, 1);
  assert.ok(result.heldForReview.find(row => row.email === 'duplicate@example.org' && row.reason === 'duplicate-local-record-review'));
});

test('reconciliation removes only known local suppressions already present and never re-adds absences', () => {
  const audience = normalizeAudience([
    record('both@example.org'), record('absent@example.org'),
    record('unsub@example.org', 'unsubscribed'), record('cleaned@example.org', 'cleaned'),
    record('archived@example.org', 'archived'), record('suppressed-absent@example.org', 'unsubscribed'),
    record('pending@example.org', 'pending')
  ]);
  const before = JSON.stringify(audience);
  const result = reconcile(audience, roster(['both@example.org', 'unsub@example.org', 'cleaned@example.org', 'archived@example.org', 'pending@example.org', 'remote-only@example.org']), { mode: 'reconcile' });
  assert.deepEqual(result.initialImportCandidates, []);
  assert.deepEqual(result.removeLocalSuppressedPresentOnListserv.map(row => row.email), ['archived@example.org', 'cleaned@example.org', 'unsub@example.org']);
  assert.deepEqual(result.localSubscribedMissingFromListserv.map(row => row.email), ['absent@example.org']);
  assert.deepEqual(result.listservOnly, ['remote-only@example.org']);
  assert.deepEqual(result.subscribedOnBoth, ['both@example.org']);
  assert.deepEqual(result.reviewLocalNonSubscribedPresentOnListserv.map(row => row.email), ['pending@example.org']);
  assert.equal(JSON.stringify(audience), before);
  assert.equal(result.sourceDataChanged, false);
});

test('mode must be explicit and initial import refuses an existing nonempty roster', () => {
  const audience = normalizeAudience([record('a@example.org')]);
  assert.throws(() => reconcile(audience), /explicitly/);
  assert.throws(() => reconcile(audience, null, { mode: 'reconcile' }), /current/);
  assert.throws(() => reconcile(audience, roster(['old@example.org']), { mode: 'first-import' }), /existing roster/);
  assert.equal(reconcile(audience, roster([]), { mode: 'first-import' }).initialImportCandidates.length, 1);
});

test('invalid current roster forces report-only while exact duplicate rows are deduplicated', () => {
  const audience = normalizeAudience([record('a@example.org', 'unsubscribed')]);
  const current = roster(['a@example.org', 'A@example.org', 'not-an-address']);
  assert.equal(current.emails.length, 1);
  assert.equal(current.duplicates.length, 1);
  const result = reconcile(audience, current, { mode: 'reconcile' });
  assert.equal(result.reportOnly, true);
  assert.deepEqual(result.removeLocalSuppressedPresentOnListserv, []);
  assert.equal(result.counts.currentListservInvalid, 1);
  assert.throws(() => listservRoster('a@example.org', { format: 'email-lines', emailColumn: 'Email' }), /CSV/);
});

test('private initial packet has exact action format, owner-only files, fingerprints and count-only result', async t => {
  const fixture = await privateFixture(t, [record('z@example.org'), record('a@example.org'), record('stop@example.org', 'unsubscribed')]);
  const before = await readFile(fixture.audience);
  const result = await run(options(fixture));
  assert.equal(result.ok, true);
  assert.equal(result.counts.initialImportCandidates, 2);
  assert.equal(result.counts.localSuppressionExclusions, 1);
  assert.equal(JSON.stringify(result).includes('@'), false);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.emailsSent, 0);
  assert.equal(await readFile(path.join(fixture.output, '01_initial_subscribed_candidates.txt'), 'utf8'), 'a@example.org\nz@example.org\n');
  assert.match(await readFile(path.join(fixture.output, 'suppression_exclusions.csv'), 'utf8'), /stop@example\.org/);
  const report = JSON.parse(await readFile(path.join(fixture.output, 'reconciliation.json'), 'utf8'));
  assert.match(report.inputs.audience.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.inputs.listserv, null);
  assert.equal((await stat(fixture.output)).mode & 0o777, 0o700);
  for (const filename of result.files) assert.equal((await stat(path.join(fixture.output, filename))).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(fixture.audience), before);
});

test('reconciliation packet contains removals and review CSV but no addition file', async t => {
  const fixture = await privateFixture(t, [record('absent@example.org'), record('stop@example.org', 'cleaned'), record('both@example.org')]);
  const filename = path.join(fixture.folder, 'roster.csv');
  await writeFile(filename, 'Subscriber Address,Name\nstop@example.org,Stop\nboth@example.org,Both\n', { mode: 0o600 });
  const before = await readFile(filename);
  const result = await run(options(fixture, 'reconcile', ['--listserv', filename, '--listserv-format', 'csv', '--listserv-email-column', 'Subscriber Address']));
  assert.equal(result.counts.removals, 1);
  assert.equal(await readFile(path.join(fixture.output, '02_remove_local_suppressed_present_on_listserv.txt'), 'utf8'), 'stop@example.org\n');
  assert.equal(result.files.some(name => name.startsWith('01_')), false);
  assert.match(await readFile(path.join(fixture.output, 'review_missing_from_listserv.csv'), 'utf8'), /absent@example\.org/);
  assert.deepEqual(await readFile(filename), before);
});

test('invalid roster produces no action files at all', async t => {
  const fixture = await privateFixture(t, [record('stop@example.org', 'unsubscribed')]);
  const filename = path.join(fixture.folder, 'roster.txt');
  await writeFile(filename, 'stop@example.org\n*@example.org\n', { mode: 0o600 });
  const result = await run(options(fixture, 'reconcile', ['--listserv', filename, '--listserv-format', 'email-lines']));
  assert.equal(result.reportOnly, true);
  assert.equal(result.files.some(name => /^0[12]_/.test(name)), false);
  assert.match(await readFile(path.join(fixture.output, 'README.txt'), 'utf8'), /REPORT ONLY/);
});

test('read-only SQLite input yields an unchanged database and a logical-row fingerprint', async t => {
  const fixture = await privateFixture(t);
  const filename = path.join(fixture.folder, 'audience.sqlite');
  const database = new DatabaseSync(filename);
  database.exec("CREATE TABLE contacts (email TEXT, status TEXT); INSERT INTO contacts VALUES ('ok@example.org','subscribed'),('stop@example.org','unsubscribed');");
  database.close(); await chmod(filename, 0o600);
  const before = await readFile(filename), beforeFiles = await readdir(fixture.folder);
  const result = await run(['--mode', 'first-import', '--database', filename, '--output', fixture.output]);
  assert.equal(result.counts.initialImportCandidates, 1);
  assert.equal(result.counts.localSuppressionExclusions, 1);
  assert.deepEqual(await readFile(filename), before);
  assert.deepEqual((await readdir(fixture.folder)).filter(name => name !== 'packet').sort(), beforeFiles.sort());
  const report = JSON.parse(await readFile(path.join(fixture.output, 'reconciliation.json'), 'utf8'));
  assert.equal(report.inputs.audience.kind, 'sqlite-read-only');
  assert.match(report.inputs.audience.selectedRowsSha256, /^[a-f0-9]{64}$/);
});

test('private guard rejects public-mode input, symlinks, Git paths and reused output without modifying inputs', async t => {
  const fixture = await privateFixture(t);
  await chmod(fixture.audience, 0o644);
  await assert.rejects(run(options(fixture)), /owner-only/);
  await chmod(fixture.audience, 0o600);
  const linked = path.join(fixture.folder, 'symlink.json'); await symlink(fixture.audience, linked);
  await assert.rejects(run(options({ ...fixture, audience: linked })), /regular/);
  await mkdir(path.join(fixture.folder, '.git'), { mode: 0o700 });
  await assert.rejects(run(options(fixture)), /Git/);
  await rm(path.join(fixture.folder, '.git'), { recursive: true });
  await run(options(fixture));
  const existing = await readFile(path.join(fixture.output, 'reconciliation.json'));
  await assert.rejects(run(options(fixture)), /already exists/);
  assert.deepEqual(await readFile(path.join(fixture.output, 'reconciliation.json')), existing);
});

test('a broad output parent is rejected without changing its permissions', async t => {
  const fixture = await privateFixture(t);
  const broad = path.join(fixture.folder, 'broad'); await mkdir(broad, { mode: 0o755 }); await chmod(broad, 0o755);
  await assert.rejects(run(options({ ...fixture, output: path.join(broad, 'packet') })), /private directory/);
  assert.equal((await stat(broad)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(broad), []);
});

test('ambiguous CLI options stop before any packet is created', async t => {
  const fixture = await privateFixture(t);
  for (const args of [
    ['--audience', fixture.audience, '--output', fixture.output],
    [...options(fixture), '--mode', 'reconcile'],
    [...options(fixture), '--database', fixture.audience],
    options(fixture, 'reconcile'),
    [...options(fixture), '--listserv-format', 'csv'],
    [...options(fixture), '--unknown', 'x']
  ]) await assert.rejects(run(args));
  assert.deepEqual(await readdir(fixture.folder), ['audience.json']);
});

test('full audience-sized reconciliation is deterministic and never expands the delivery list', () => {
  const records = Array.from({ length: 2657 }, (_, i) => record(`person${i}@example.org`, i < 2265 ? 'subscribed' : i < 2560 ? 'cleaned' : 'unsubscribed'));
  const audience = normalizeAudience(records);
  const initial = reconcile(audience, null, { mode: 'first-import' });
  assert.equal(initial.counts.initialImportCandidates, 2265);
  assert.equal(initial.counts.localSuppressionExclusions, 392);
  const current = roster(records.filter((_, i) => i % 2 === 0).map(row => row.email));
  const result = reconcile(audience, current, { mode: 'reconcile' });
  assert.equal(result.initialImportCandidates.length, 0);
  assert.equal(result.counts.removals, 196);
  assert.equal(result.counts.localSubscribedMissingFromListserv, 1132);
  assert.deepEqual(result, reconcile(audience, current, { mode: 'reconcile' }));
});
