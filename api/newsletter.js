const {
  MAX_BODY_BYTES, GENERIC_MESSAGE, NewsletterError, allowedOrigin,
  getClientKey, validatePublicInput, applyPublicRequest, newManageToken
} = require('../lib/newsletter.js');
const { createBlobStore, transact } = require('../lib/newsletter-store.js');

async function readBody(req) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_BODY_BYTES)) {
    throw new NewsletterError('This request is too large.', 413);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new NewsletterError('Send the form as JSON.', 415);
  }
  let body = req.body;
  if (body === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) throw new NewsletterError('This request is too large.', 413);
      chunks.push(Buffer.from(chunk));
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  try {
    const serialized = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body);
    if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw new NewsletterError('This request is too large.', 413);
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof NewsletterError) throw error;
    throw new NewsletterError('Send valid JSON.');
  }
}

function failureReason(error, phase) {
  if (['RATE_SECRET_MISSING', 'CLIENT_IP_INVALID', 'CLIENT_IP_MISSING'].includes(error?.code)) return error.code;
  const known = {
    BlobAccessError: 'STORAGE_ACCESS_DENIED',
    BlobStoreNotFoundError: 'STORAGE_STORE_MISSING',
    BlobStoreSuspendedError: 'STORAGE_SUSPENDED',
    BlobServiceNotAvailable: 'STORAGE_UNAVAILABLE',
    BlobServiceRateLimited: 'STORAGE_RATE_LIMITED',
    BlobRequestAbortedError: 'STORAGE_TIMEOUT',
    BlobPreconditionFailedError: 'STORAGE_CONFLICT',
    ConflictError: 'STORAGE_CONFLICT',
    BlobUnknownError: 'STORAGE_UNKNOWN',
    BlobError: 'STORAGE_REJECTED'
  };
  const constructorName = error?.constructor?.name;
  if (Object.hasOwn(known, constructorName)) return known[constructorName];
  if (error instanceof SyntaxError) return 'INVALID_STORED_JSON';
  if (phase === 'storage-configuration') return 'STORAGE_CONFIGURATION';
  if (error instanceof TypeError) return 'RUNTIME_TYPE_ERROR';
  return 'UNEXPECTED_FAILURE';
}

function createHandler({ store, env = process.env, clock = Date.now, report = event => console.warn(JSON.stringify(event)) } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Allow', 'POST, OPTIONS');
    if (!allowedOrigin(req.headers.origin, env)) {
      return res.status(403).json({ ok: false, error: 'This origin is not allowed.' });
    }
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use the signup form.' });
    if (env.VERCEL === '1' && env.VERCEL_ENV !== 'production') {
      return res.status(503).json({ ok: false, error: 'Signup is unavailable on preview deployments.' });
    }
    let phase = 'input-validation';
    try {
      const now = clock();
      const input = validatePublicInput(await readBody(req), now);
      if (input.honeypot) return res.status(200).json({ ok: true, message: GENERIC_MESSAGE });
      phase = 'client-key';
      const clientKey = getClientKey(req, env);
      const token = newManageToken();
      phase = 'storage-configuration';
      const configuredStore = store || createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
      const observedStore = {
        async read() { phase = 'storage-read'; return configuredStore.read(); },
        async write(state, etag) { phase = 'storage-write'; return configuredStore.write(state, etag); }
      };
      const result = await transact(observedStore,
        state => { phase = 'state-update'; return applyPublicRequest(state, input, { now, clientKey, token }); }, { now });
      if (result.status === 429) res.setHeader('Retry-After', '3600');
      return res.status(result.status).json(result.body);
    } catch (error) {
      const status = error instanceof NewsletterError ? error.status : 503;
      if (status >= 500) {
        try { report({ event: 'ces_newsletter_failure', phase, reason: failureReason(error, phase) }); }
        catch {}
      }
      return res.status(status).json({
        ok: false,
        error: error instanceof NewsletterError ? error.message : 'Signup is temporarily unavailable. Please try again later.'
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.readBody = readBody;
module.exports.failureReason = failureReason;
