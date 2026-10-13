import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, chmod, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, requestIP } from '../server.mjs';
import { SQLiteStore, privatePath } from '../sqlite.mjs';

test('trusted proxy parsing ignores spoofed addresses supplied by an untrusted peer', () => {
  const request = { socket: { remoteAddress: '192.0.2.7' }, headers: { 'x-forwarded-for': '1.2.3.4' } };
  assert.equal(requestIP(request, new Set(['127.0.0.1'])), '192.0.2.7');
  const proxied = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4, 192.0.2.7' } };
  assert.equal(requestIP(proxied, new Set(['127.0.0.1'])), '192.0.2.7');
});

test('private database paths do not chmod a broader existing directory', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ces-path-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  assert.throws(() => privatePath(path.join(directory, 'audience.sqlite')), /dedicated private/);
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  await chmod(directory, 0o700);
  const database = new SQLiteStore(path.join(directory, 'audience.sqlite')); database.close();
  assert.equal((await stat(path.join(directory, 'audience.sqlite'))).mode & 0o777, 0o600);
});

test('Node adapter enforces configured Host and strips spoofed client headers', async t => {
  const database = new SQLiteStore(':memory:'); t.after(() => database.close());
  const { server } = await createServer({
    PUBLIC_ORIGIN: 'https://ces.example', SESSION_SECRET: 'a'.repeat(32), RATE_LIMIT_SECRET: 'b'.repeat(32)
  }, { database, assets: {}, handler: { async fetch(request, env) { return Response.json({ ip: env.CLIENT_IP, header: request.headers.get('cf-connecting-ip') }); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const send = host => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/test', headers: { Host: host, 'CF-Connecting-IP': '8.8.8.8', 'X-Forwarded-For': '8.8.8.8' } }, result => {
      let body = ''; result.on('data', chunk => body += chunk); result.on('end', () => resolve({ status: result.statusCode, body }));
    }); request.on('error', reject); request.end();
  });
  assert.equal((await send('evil.example')).status, 400);
  const result = await send('ces.example'); assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { ip: '127.0.0.1', header: null });
});

test('production startup rejects an insecure public origin', async () => {
  await assert.rejects(createServer({ PUBLIC_ORIGIN: 'http://ces.example', SESSION_SECRET: 'a'.repeat(32), RATE_LIMIT_SECRET: 'b'.repeat(32) }), /requires HTTPS/);
});
