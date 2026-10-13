const { get, put, BlobNotFoundError, BlobPreconditionFailedError } = require('@vercel/blob');
const { emptyState, validateState } = require('./newsletter.js');

const BLOB_PATH = 'ces-newsletter/audience-v1.json';
const MAX_STATE_BYTES = 20 * 1024 * 1024;

class ConflictError extends Error {}

function createBlobStore({ token = process.env.BLOB_READ_WRITE_TOKEN, sdk = { get, put }, pathname = BLOB_PATH } = {}) {
  if (!token) throw new Error('Private newsletter storage is not configured.');
  const store = {
    async read() {
      let result;
      try {
        result = await sdk.get(pathname, {
          access: 'private', token, useCache: false, headers: { 'accept-encoding': 'identity' },
          abortSignal: AbortSignal.timeout(15000)
        });
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw error;
      }
      if (!result) return null;
      if (result.statusCode !== 200 || !result.blob.etag || result.blob.etag.startsWith('W/') ||
          !result.stream || result.blob.size > MAX_STATE_BYTES) throw new Error('Private newsletter data could not be read.');
      const chunks = [];
      let size = 0;
      const reader = result.stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_STATE_BYTES) {
            await reader.cancel();
            throw new Error('Private newsletter data exceeds the size limit.');
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const state = validateState(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return { state, etag: result.blob.etag };
    },
    async write(state, etag) {
      validateState(state);
      const payload = JSON.stringify(state);
      if (Buffer.byteLength(payload) > MAX_STATE_BYTES) throw new Error('Private newsletter data exceeds the size limit.');
      try {
        return await sdk.put(pathname, payload, {
          access: 'private', token, contentType: 'application/json', addRandomSuffix: false,
          allowOverwrite: Boolean(etag), ...(etag ? { ifMatch: etag } : {}),
          cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(15000)
        });
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) throw new ConflictError('Concurrent newsletter update.');
        if (!etag && await store.read()) throw new ConflictError('Newsletter storage was initialized concurrently.');
        throw error;
      }
    }
  };
  return store;
}

async function transact(store, mutate, { now = Date.now(), attempts = 8, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await store.read();
    const state = current ? current.state : emptyState(now);
    const { changed, result } = mutate(state);
    if (!changed) return result;
    state.revision += 1;
    state.updatedAt = new Date(now).toISOString();
    try {
      await store.write(state, current?.etag);
      return result;
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt === attempts - 1) throw error;
      await pause(Math.min(25 * (2 ** attempt), 400) + Math.floor(Math.random() * 30));
    }
  }
  throw new Error('Newsletter update retry limit exceeded.');
}

module.exports = { BLOB_PATH, MAX_STATE_BYTES, ConflictError, createBlobStore, transact };
