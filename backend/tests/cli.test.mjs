import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run } from '../audience-cli.mjs';

test('CLI migration retains private hashes while ordinary exports omit them', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ces-cli-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, 'audience.sqlite'), source = path.join(directory, 'input.json');
  await writeFile(source, JSON.stringify({ subscribers: { 'legacy@example.org': {
    email: 'legacy@example.org', name: 'Legacy', status: 'unsubscribed', interests: [], sources: [], consent: null, unsubscribeTokenHash: 'a'.repeat(64)
  } } }), { mode: 0o600 });
  const imported = await run(['import', '--database', database, '--source', source]); assert.equal(imported.total, 1); assert.equal(imported.statuses.unsubscribed, 1);
  const plain = path.join(directory, 'plain.json'), migration = path.join(directory, 'migration.json');
  await run(['export', '--database', database, '--output', plain]);
  await run(['export', '--database', database, '--output', migration, '--format', 'migration']);
  assert.ok(!(await readFile(plain, 'utf8')).includes('unsubscribeTokenHash'));
  assert.equal(JSON.parse(await readFile(migration, 'utf8'))[0].unsubscribeTokenHash, 'a'.repeat(64));
  assert.equal((await stat(migration)).mode & 0o777, 0o600);
});

test('CLI export refuses to replace its database or active journal files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ces-cli-guard-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, 'audience.sqlite');
  await run(['stats', '--database', database]);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await assert.rejects(run(['export', '--database', database, '--output', database + suffix]), /must not replace/);
  }
  assert.equal((await run(['stats', '--database', database])).total, 0);
});
