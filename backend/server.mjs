import http from 'node:http';
import net from 'node:net';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import worker from './worker.mjs';
import { SQLiteStore, repositoryRoot } from './sqlite.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8'
};

export function normalizeIP(ip) { return ip?.startsWith('::ffff:') ? ip.slice(7) : ip; }
export function requestIP(request, trusted) {
  const direct = normalizeIP(request.socket.remoteAddress);
  if (!net.isIP(direct)) throw new Error('The client address is unavailable.');
  if (!trusted.has(direct)) return direct;
  const chain = String(request.headers['x-forwarded-for'] || '').split(',').map(value => normalizeIP(value.trim())).filter(Boolean);
  if (!chain.length) return direct;
  if (chain.length > 16 || chain.some(value => !net.isIP(value))) throw new Error('Invalid forwarded address.');
  let current = direct;
  while (chain.length && trusted.has(current)) current = chain.pop();
  return current;
}

export async function createAssets(directory) {
  const root = await realpath(directory);
  if (root !== path.join(repositoryRoot, '.site-build')) throw new Error('Serve only the prepared .site-build directory.');
  return { async fetch(request) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response('Not found', { status: 404 }); }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) return new Response('Not found', { status: 404 });
    let filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(`${root}${path.sep}`) && filename !== root) return new Response('Not found', { status: 404 });
    try {
      let info;
      try { info = await stat(filename); }
      catch { if (!path.extname(filename)) { filename += '.html'; info = await stat(filename); } else throw new Error(); }
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) return new Response(null, { status: 308, headers: { Location: `${pathname}/${new URL(request.url).search}` } });
        filename = path.join(filename, 'index.html'); info = await stat(filename);
      }
      const actual = await realpath(filename);
      if (!actual.startsWith(`${root}${path.sep}`) || !info.isFile()) return new Response('Not found', { status: 404 });
      const mime = MIME[path.extname(actual).toLowerCase()];
      if (!mime) return new Response('Not found', { status: 404 });
      const bytes = request.method === 'HEAD' ? null : await readFile(actual);
      return new Response(bytes, { headers: { 'Content-Type': mime, 'Content-Length': String(info.size), 'Cache-Control': mime.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600' } });
    } catch { return new Response('Not found', { status: 404 }); }
  } };
}

export async function createServer(config = {}, { database, assets, handler = worker } = {}) {
  if (typeof config.PUBLIC_ORIGIN !== 'string') throw new Error('Set PUBLIC_ORIGIN to the HTTPS address people will use.');
  const origin = new URL(config.PUBLIC_ORIGIN);
  if (origin.origin !== config.PUBLIC_ORIGIN || origin.username || origin.password) throw new Error('PUBLIC_ORIGIN must be an origin without a path.');
  const development = config.ENVIRONMENT === 'development';
  if (origin.protocol !== 'https:' && !(development && origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('Production requires HTTPS.');
  if (typeof config.SESSION_SECRET !== 'string' || config.SESSION_SECRET.length < 32 || typeof config.RATE_LIMIT_SECRET !== 'string' || config.RATE_LIMIT_SECRET.length < 32) throw new Error('Configure the private session and rate-limit secrets.');
  const trusted = new Set(String(config.TRUST_PROXY_IPS || '').split(',').map(value => normalizeIP(value.trim())).filter(Boolean));
  if ([...trusted].some(value => !net.isIP(value))) throw new Error('TRUST_PROXY_IPS must list exact proxy IP addresses.');
  const store = database || new SQLiteStore(config.DATABASE_PATH);
  const staticAssets = assets || await createAssets(config.STATIC_ROOT || path.join(repositoryRoot, '.site-build'));
  const env = { ...config, DB: store, ASSETS: staticAssets };
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, async (request, result) => {
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\') || request.headers.host !== origin.host) {
        result.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); result.end('Invalid request.'); return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (['cf-connecting-ip', 'x-ces-client-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].includes(name)) continue;
        if (Array.isArray(value)) headers.set(name, value.join(', ')); else if (value !== undefined) headers.set(name, value);
      }
      const bodyAllowed = !['GET', 'HEAD'].includes(request.method);
      const webRequest = new Request(new URL(request.url, origin).href, { method: request.method, headers, ...(bodyAllowed ? { body: Readable.toWeb(request), duplex: 'half' } : {}) });
      const response = await handler.fetch(webRequest, { ...env, CLIENT_IP: requestIP(request, trusted) });
      const responseHeaders = Object.fromEntries(response.headers);
      if (origin.protocol === 'https:') responseHeaders['strict-transport-security'] = 'max-age=31536000';
      result.writeHead(response.status, responseHeaders);
      if (!response.body || request.method === 'HEAD') { result.end(); return; }
      await pipeline(Readable.fromWeb(response.body), result);
    } catch {
      if (!result.headersSent) result.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      if (!result.writableEnded) result.end('{"ok":false,"error":"Service is temporarily unavailable."}');
    }
  });
  server.maxRequestsPerSocket = 100;
  server.on('close', () => { if (!database) store.close(); });
  return { server, database: store };
}

async function main() {
  const configFile = process.env.CES_CONFIG_FILE;
  if (!configFile || !path.isAbsolute(configFile)) throw new Error('Set CES_CONFIG_FILE to an absolute private configuration file.');
  const actual = await realpath(configFile), info = await stat(actual);
  if (actual.startsWith(`${repositoryRoot}${path.sep}`) || (info.mode & 0o077)) throw new Error('The configuration must be private (mode 600) and outside the website repository.');
  const config = JSON.parse(await readFile(actual, 'utf8'));
  const { server } = await createServer(config);
  const host = config.BIND_HOST || '127.0.0.1', port = Number(config.PORT || 8787);
  if (!net.isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bind address or port.');
  server.listen(port, host, () => console.log(`CES is running at ${config.PUBLIC_ORIGIN}.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('CES could not start. Check the private configuration, database, and prepared site files.'); process.exitCode = 1; });
