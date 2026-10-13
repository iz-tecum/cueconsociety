const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const ALIAS_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic';
const tokenCache = new Map();

export class GmailError extends Error {
  constructor(code, disposition = 'blocked', retryAfter = 0) {
    super(code); this.code = code; this.disposition = disposition; this.retryAfter = retryAfter;
  }
}
function address(value) {
  if (typeof value !== 'string') return '';
  const clean = value.trim().toLowerCase();
  return clean.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(clean) && !/[\r\n]/.test(clean) ? clean : '';
}
function bounded(value, fallback, maximum) {
  const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}
export function gmailConfiguration(env) {
  const from = address(env.GMAIL_FROM), principal = address(env.GMAIL_PRINCIPAL);
  let origin = '';
  try { const value = new URL(env.GMAIL_UNSUBSCRIBE_ORIGIN); if (value.protocol === 'https:' && value.origin === env.GMAIL_UNSUBSCRIBE_ORIGIN) origin = value.origin; } catch {}
  const fields = {
    GMAIL_CLIENT_ID: typeof env.GMAIL_CLIENT_ID === 'string' && env.GMAIL_CLIENT_ID.length >= 8,
    GMAIL_CLIENT_SECRET: typeof env.GMAIL_CLIENT_SECRET === 'string' && env.GMAIL_CLIENT_SECRET.length >= 8,
    GMAIL_REFRESH_TOKEN: typeof env.GMAIL_REFRESH_TOKEN === 'string' && env.GMAIL_REFRESH_TOKEN.length >= 8,
    GMAIL_PRINCIPAL: Boolean(principal), GMAIL_FROM: Boolean(from), GMAIL_UNSUBSCRIBE_ORIGIN: Boolean(origin),
    GMAIL_UNSUBSCRIBE_SECRET: typeof env.GMAIL_UNSUBSCRIBE_SECRET === 'string' && env.GMAIL_UNSUBSCRIBE_SECRET.length >= 32
  };
  const configurationMissing = Object.keys(fields).filter(name => !fields[name]);
  const configured = configurationMissing.length === 0;
  const enabled = env.GMAIL_SEND_ENABLED === 'true';
  const reason = !configured ? 'Google connection required; the sender must be the signed-in mailbox or a verified Gmail alias.' : !enabled ? 'Sending is disabled. Campaigns can be staged without sending.' : 'Verify the Google connection, then explicitly start and dispatch a campaign.';
  return { enabled, configured, from, principal, origin, reason, configurationMissing,
    limits: { rolling24Hours: bounded(env.GMAIL_DAILY_BUDGET, 1000, 2000), perMinute: bounded(env.GMAIL_RATE_PER_MINUTE, 20, 60) } };
}

export async function gmailConfigurationFingerprint(env) {
  const names = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_PRINCIPAL', 'GMAIL_FROM', 'GMAIL_UNSUBSCRIBE_ORIGIN', 'GMAIL_UNSUBSCRIBE_SECRET'];
  const bytes = new TextEncoder().encode(JSON.stringify(['ces-gmail-configuration-v1', ...names.map(name => env[name] ?? null)]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function jsonResponse(response) { try { return await response.json(); } catch { return null; } }
function retryAfter(response) {
  const value = response.headers.get('retry-after');
  const seconds = Number(value);
  return value && Number.isFinite(seconds) ? Math.max(1, Math.min(86400, seconds)) * 1000 : 60000;
}
async function timedFetch(fetchImpl, url, options) {
  return fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
}

export function createGmailAdapter(env, { fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const config = gmailConfiguration(env);
  async function accessToken() {
    if (!config.configured) throw new GmailError('GOOGLE_CONNECTION_REQUIRED');
    const key = JSON.stringify([env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, env.GMAIL_REFRESH_TOKEN]);
    const cached = tokenCache.get(key);
    if (cached && cached.expires > clock() + 60000) return cached.token;
    let result;
    try {
      result = await timedFetch(fetchImpl, 'https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }).toString()
      });
    } catch { throw new GmailError('GOOGLE_CONNECTION_UNAVAILABLE', 'retry', 60000); }
    const data = await jsonResponse(result);
    if (!result.ok || typeof data?.access_token !== 'string' || data.access_token.length < 8) throw new GmailError('GOOGLE_REAUTHORIZATION_REQUIRED');
    const token = data.access_token;
    tokenCache.clear();
    tokenCache.set(key, { token, expires: clock() + Math.min(Number(data.expires_in) || 300, 3600) * 1000 });
    return token;
  }
  async function verify() {
    const token = await accessToken();
    let infoResponse, identityResponse;
    try {
      infoResponse = await timedFetch(fetchImpl, `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`, { method: 'GET' });
      identityResponse = await timedFetch(fetchImpl, 'https://openidconnect.googleapis.com/v1/userinfo', { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    } catch { throw new GmailError('GOOGLE_IDENTITY_UNAVAILABLE', 'retry', 60000); }
    const info = await jsonResponse(infoResponse), identity = await jsonResponse(identityResponse);
    const scopes = new Set(String(info?.scope || '').split(/\s+/));
    if (!infoResponse.ok || info?.aud !== env.GMAIL_CLIENT_ID || !scopes.has(SEND_SCOPE)) throw new GmailError('GOOGLE_SEND_PERMISSION_REQUIRED');
    if (!identityResponse.ok || identity?.email_verified !== true || address(identity.email) !== config.principal) throw new GmailError('GOOGLE_ACCOUNT_MISMATCH');
    if (config.from !== config.principal) {
      if (!scopes.has(ALIAS_SCOPE)) throw new GmailError('GMAIL_ALIAS_PERMISSION_REQUIRED');
      let aliasesResponse;
      try { aliasesResponse = await timedFetch(fetchImpl, 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }); }
      catch { throw new GmailError('GMAIL_ALIAS_CHECK_UNAVAILABLE', 'retry', 60000); }
      const aliases = await jsonResponse(aliasesResponse);
      if (!aliasesResponse.ok || !Array.isArray(aliases?.sendAs) || !aliases.sendAs.some(alias => address(alias.sendAsEmail) === config.from && alias.verificationStatus === 'accepted')) throw new GmailError('GMAIL_ALIAS_NOT_VERIFIED');
    }
    return { principal: config.principal, from: config.from, checkedAt: new Date(clock()).toISOString(), token };
  }
  async function send(raw, identity) {
    if (!config.enabled || !config.configured) throw new GmailError('SENDING_DISABLED');
    if (!identity?.token || identity.principal !== config.principal || identity.from !== config.from) throw new GmailError('GOOGLE_IDENTITY_REQUIRED');
    let result;
    try {
      result = await timedFetch(fetchImpl, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw })
      });
    } catch { throw new GmailError('DELIVERY_RESULT_UNKNOWN', 'unknown'); }
    const data = await jsonResponse(result);
    if (result.ok) {
      if (typeof data?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) throw new GmailError('DELIVERY_RESULT_UNKNOWN', 'unknown');
      return { providerId: data.id };
    }
    if (result.status >= 500) throw new GmailError('DELIVERY_RESULT_UNKNOWN', 'unknown');
    const reasons = Array.isArray(data?.error?.errors) ? data.error.errors.map(error => error.reason) : [];
    if (result.status === 429 || (result.status === 403 && reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(reason)))) throw new GmailError('GMAIL_QUOTA_REJECTED', 'retry', retryAfter(result));
    if (result.status === 401) { tokenCache.clear(); throw new GmailError('GOOGLE_REAUTHORIZATION_REQUIRED', 'blocked'); }
    throw new GmailError('GMAIL_MESSAGE_REJECTED', 'permanent');
  }
  return { config, verify, send };
}

export function clearGmailTokenCache() { tokenCache.clear(); }
