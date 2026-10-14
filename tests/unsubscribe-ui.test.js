const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(new URL('../unsubscribe/unsubscribe.js', `file://${__filename}`), 'utf8');
const html = fs.readFileSync(new URL('../unsubscribe/index.html', `file://${__filename}`), 'utf8');
const newsletter = fs.readFileSync(new URL('../newsletter/index.html', `file://${__filename}`), 'utf8');
const TOKEN = 't'.repeat(43);
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ hash = `#campaign=campaign-123&token=${TOKEN}`, search = '', responses = [], historyFailure = false } = {}) {
  const elements = new Map(), calls = [], history = [];
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set(), events = new Map(), attrs = new Map();
    const el = {
      id, events, textContent: '', value: '', hidden: ['request-form','confirmation-panel','retry-button'].includes(id), disabled: false,
      validity: { valid: true }, style: {}, inert: false,
      classList: { contains: key => classes.has(key), toggle: (key, on) => on ? classes.add(key) : classes.delete(key) },
      setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key), getAttribute: key => attrs.get(key),
      addEventListener: (name, handler) => events.set(name, handler),
      focus() { document.activeElement = el; }, contains: other => other === el,
      getBoundingClientRect: () => ({ bottom: 250 }), querySelector: () => element('fake-link'),
    };
    elements.set(id, el); return el;
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) element(match[1]);
  const document = {
    hidden: false, activeElement: null, getElementById: element,
    querySelector: () => element('nav-toggle'), addEventListener() {},
  };
  const location = { hash, search, pathname: '/unsubscribe/' };
  const window = {
    location, innerWidth: 1024,
    history: { replaceState: (state, title, url) => { if (historyFailure) throw Error('History unavailable'); history.push(url); location.hash = ''; location.search = ''; } },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    addEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  let index = 0;
  const context = vm.createContext({
    window, document, URLSearchParams, AbortController, TypeError,
    fetch: async (url, options) => {
      calls.push({ url, options, payload: JSON.parse(options.body) });
      const next = responses[index++] || { ok: true, email: 'member@example.test', confirmed: false };
      if (next instanceof Error) throw next;
      return { ok: (next.status || 200) < 400, status: next.status || 200, json: async () => next };
    },
  });
  vm.runInContext(source, context);
  return { element, calls, history, location, async ready() { await tick(); await tick(); },
    async submit() { await element('request-form').events.get('submit')({ preventDefault() {} }); },
    async confirm() { await element('confirm-button').events.get('click')(); },
    async retry() { await element('retry-button').events.get('click')(); },
  };
}

test('page reuses the actual signup header, footer, stylesheet and action-button class', () => {
  const header = text => text.match(/<header[\s\S]*?<\/header>/)[0];
  const footer = text => text.match(/<footer[\s\S]*?<\/footer>/)[0].replace(' aria-current="page"', '');
  assert.equal(header(html), header(newsletter)); assert.equal(footer(html), footer(newsletter));
  assert.match(html, /href="\/newsletter\/newsletter.css"/);
  assert.match(html, /name="robots" content="noindex, nofollow, noarchive"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /id="confirm-button" type="button"/);
  assert.match(html, /class="action-button" id="request-button"/);
  assert.doesNotMatch(header(html) + footer(html), /href="[^\"]*unsubscribe/);
});

test('campaign link is stripped before interaction and never sends on load', async () => {
  const h = harness(); await h.ready();
  assert.deepEqual(h.history, ['/unsubscribe/']); assert.equal(h.location.hash, '');
  assert.equal(h.calls.length, 0); assert.equal(h.element('request-form').hidden, false);
  await h.confirm(); assert.equal(h.calls.length, 0);
});

test('request confirmation only follows valid email form submission and is generic', async () => {
  const h = harness({ responses: [{ ok: true, message: 'Generic response' }] });
  h.element('subscriber-email').value = ' member@example.test ';
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].payload, { action: 'request', campaign: 'campaign-123', token: TOKEN, email: 'member@example.test' });
  assert.equal(h.calls[0].url, 'https://admin.cueconsociety.com/api/public/unsubscribe');
  assert.equal(h.calls[0].options.credentials, 'omit'); assert.equal(h.calls[0].options.redirect, 'error');
  assert.equal(h.calls[0].options.referrerPolicy, 'no-referrer'); assert.equal(h.calls[0].options.cache, 'no-store');
  assert.match(h.element('result-message').textContent, /If this address received/);
  assert.doesNotMatch(h.element('result-message').textContent, /has been sent|are now unsubscribed/);
  assert.equal(h.element('request-form').hidden, true);
});

test('missing, malformed, duplicate, mixed and query-only credentials fail closed', async () => {
  for (const hash of ['', '#campaign=short&token=x', `#campaign=campaign-123&id=private-123&token=${TOKEN}`, `#campaign=campaign-123&token=${TOKEN}&token=${TOKEN}`, `#campaign=campaign-123&token=${TOKEN}&email=member@example.test`]) {
    const h = harness({ hash, search: `?campaign=campaign-123&token=${TOKEN}` }); await h.ready();
    h.element('subscriber-email').value = 'member@example.test'; await h.submit(); await h.confirm();
    assert.equal(h.calls.length, 0); assert.equal(h.element('result-heading').textContent, 'Link unavailable');
    assert.equal(h.location.search, '');
  }
  const h = harness({ historyFailure: true }); await h.ready(); await h.submit(); assert.equal(h.calls.length, 0);
});

test('invalid email never requests confirmation', async () => {
  const h = harness(); h.element('subscriber-email').value = 'invalid'; h.element('subscriber-email').validity.valid = false;
  await h.submit(); assert.equal(h.calls.length, 0); assert.equal(h.element('subscriber-email').getAttribute('aria-invalid'), 'true');
});

test('private link only inspects on load and needs an explicit confirmation click', async () => {
  const h = harness({ hash: `#id=private-123&token=${TOKEN}`, responses: [{ ok: true, email: 'member@example.test', confirmed: false }, { ok: true, confirmed: true }] });
  await h.ready();
  assert.deepEqual(h.calls.map(call => call.payload.action), ['inspect']);
  assert.equal(h.element('confirmation-email').textContent, 'member@example.test');
  assert.equal(h.element('confirmation-panel').hidden, false);
  await h.confirm();
  assert.deepEqual(h.calls[1].payload, { action: 'confirm', id: 'private-123', token: TOKEN });
  assert.equal(h.element('result-heading').textContent, 'Request complete');
  await h.confirm(); assert.equal(h.calls.length, 2);
});

test('completed private links never offer another confirm mutation', async () => {
  const h = harness({ hash: `#id=private-123&token=${TOKEN}`, responses: [{ ok: true, email: 'member@example.test', confirmed: true }] });
  await h.ready(); await h.confirm();
  assert.equal(h.calls.length, 1); assert.equal(h.element('confirmation-panel').hidden, true);
  assert.match(h.element('result-message').textContent, /already been completed/);
});

test('invalid or expired private tokens show fallback without a confirmation action', async () => {
  const h = harness({ hash: `#id=private-123&token=${TOKEN}`, responses: [{ status: 400, ok: false, error: 'Expired' }] });
  await h.ready(); await h.confirm();
  assert.equal(h.calls.length, 1); assert.match(h.element('result-message').textContent, /invalid or expired.*board/);
  assert.equal(h.element('retry-button').hidden, true);
});

test('failed inspect can retry read-only, and malformed success cannot enable confirm', async () => {
  const h = harness({ hash: `#id=private-123&token=${TOKEN}`, responses: [new TypeError('Offline'), { ok: true, email: 'member@example.test', confirmed: false }] });
  await h.ready(); await h.confirm(); assert.equal(h.calls.length, 1);
  assert.equal(h.element('retry-button').hidden, false); await h.retry();
  assert.deepEqual(h.calls.map(call => call.payload.action), ['inspect', 'inspect']);
  const bad = harness({ hash: `#id=private-123&token=${TOKEN}`, responses: [{ ok: true, email: 'member@example.test' }] });
  await bad.ready(); await bad.confirm(); assert.equal(bad.calls.length, 1);
});

test('failed or ambiguous confirm never reports success or retries automatically', async () => {
  for (const failure of [new TypeError('Offline'), { ok: true, confirmed: false }]) {
    const h = harness({ hash: `#id=private-123&token=${TOKEN}`, responses: [{ ok: true, email: 'member@example.test', confirmed: false }, failure] });
    await h.ready(); await h.confirm(); await h.ready();
    assert.equal(h.calls.length, 2); assert.equal(h.element('confirmation-panel').hidden, false);
    assert.match(h.element('confirmation-status').textContent, /could not/);
  }
});
