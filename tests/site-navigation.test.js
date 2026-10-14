const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/site-navigation.js'), 'utf8');
const pages = ['index.html', ...['about', 'leadership', 'events', 'alumni', 'faq', 'contact', 'recruitment', 'newsletter', 'unsubscribe'].map(name => `${name}/index.html`)];

function harness({ isMobile = true, canHover = false } = {}) {
  const elements = new Map();
  const listeners = () => {
    const handlers = new Map();
    return {
      addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
      emit(type, extra = {}) {
        const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
        (handlers.get(type) || []).forEach(handler => handler(event));
        return event;
      },
    };
  };
  const document = { ...listeners(), activeElement: null, getElementById: id => elements.get(id) };
  function element(id, parent = null, tag = 'DIV') {
    const classes = new Set(), attrs = new Map();
    const el = {
      ...listeners(), id, parent, tagName: tag, inert: false,
      classList: { contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
      setAttribute: (name, value) => attrs.set(name, value), getAttribute: name => attrs.get(name), removeAttribute: name => attrs.delete(name),
      contains(other) { while (other) { if (other === el) return true; other = other.parent; } return false; },
      focus() {
        const old = document.activeElement;
        document.activeElement = el;
        let ancestor = old;
        while (ancestor) { ancestor.emit('focusout', { target: old, relatedTarget: el }); ancestor = ancestor.parent; }
        document.emit('focusin', { target: el });
      },
      closest(selector) { let item = el; while (item) { if (selector === 'a' && item.tagName === 'A') return item; item = item.parent; } return null; },
      getBoundingClientRect: () => ({ bottom: 300 }),
    };
    elements.set(id, el); return el;
  }
  const topbar = element('topbar');
  const toggle = element('toggle', topbar, 'BUTTON');
  const nav = element('mobileNav', topbar);
  const about = element('aboutDrop', nav);
  const aboutButton = element('aboutBtn', about, 'BUTTON');
  const menu = element('aboutMenu', about);
  const first = element('about-link', menu, 'A'), last = element('leadership-link', menu, 'A');
  const events = element('events-link', nav, 'A');
  const outside = element('outside', null, 'BUTTON');
  element('hero'); element('year');
  topbar.querySelector = () => toggle;
  menu.querySelectorAll = () => [first, last];
  const mobile = { ...listeners(), matches: isMobile };
  const hover = { matches: canHover };
  const window = { ...listeners(), matchMedia: query => query.startsWith('(max-width:') ? mobile : hover };
  vm.runInNewContext(source, { document, window, Date });
  return { topbar, toggle, nav, about, aboutButton, menu, first, last, events, outside, mobile, document };
}

test('all public pages load one shared navigation and keep the same working links', () => {
  let expected;
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.equal((html.match(/site-navigation\.css\?v=1/g) || []).length, 1, page);
    assert.equal((html.match(/site-navigation\.js\?v=1/g) || []).length, 1, page);
    assert.doesNotMatch(html, /function setNavState|function setOpen|\.nav-toggle\s*\{/, page);
    const header = html.match(/<header class="topbar"[\s\S]*?<\/header>/)[0];
    const normalized = header.replaceAll(' aria-current="page"', '').replace(/(?:\.\.\/|\.\/)/g, '/');
    expected ||= normalized;
    assert.equal(normalized, expected, page);
    for (const match of header.matchAll(/(?:href|src)="([^"]+)"/g)) assert.ok(fs.existsSync(path.resolve(root, path.dirname(page), match[1])), `${page}: ${match[1]}`);
    assert.match(header, /aria-controls="aboutMenu"/);
    if (!page.startsWith('newsletter/') && !page.startsWith('unsubscribe/')) assert.equal((header.match(/aria-current="page"/g) || []).length, 1, page);
    assert.match(html, /href="\/newsletter\/" data-site-mailing-list/);
  }
});

test('mobile closed navigation and submenu are not focusable, and touch toggles both ways', () => {
  const h = harness();
  assert.equal(h.nav.inert, true); assert.equal(h.menu.inert, true);
  h.toggle.emit('click');
  assert.equal(h.nav.inert, false); assert.equal(h.toggle.getAttribute('aria-expanded'), 'true');
  h.aboutButton.emit('click'); assert.equal(h.menu.inert, false);
  h.aboutButton.emit('click'); assert.equal(h.menu.inert, true);
  h.toggle.emit('click'); assert.equal(h.nav.inert, true);
  assert.equal(h.toggle.getAttribute('aria-label'), 'Open menu');
});

test('Escape closes the submenu first, then the mobile menu, returning focus to the right trigger', () => {
  const h = harness();
  h.toggle.emit('click'); h.aboutButton.emit('keydown', { key: 'ArrowDown' });
  assert.equal(h.document.activeElement, h.first);
  h.document.emit('keydown', { key: 'Escape' });
  assert.equal(h.menu.inert, true); assert.equal(h.nav.inert, false); assert.equal(h.document.activeElement, h.aboutButton);
  h.document.emit('keydown', { key: 'Escape' });
  assert.equal(h.nav.inert, true); assert.equal(h.document.activeElement, h.toggle);
});

test('ArrowDown opens the mobile menu and focuses its first control', () => {
  const h = harness();
  const event = h.toggle.emit('keydown', { key: 'ArrowDown' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.nav.inert, false);
  assert.equal(h.document.activeElement, h.aboutButton);
});

test('outside pointer dismissal returns focus when the focused item becomes hidden', () => {
  for (const isMobile of [true, false]) {
    const h = harness({ isMobile });
    if (isMobile) h.toggle.emit('click');
    h.aboutButton.emit('keydown', { key: 'ArrowDown' });
    h.document.emit('pointerdown', { target: h.outside });
    assert.equal(h.menu.inert, true);
    assert.equal(h.document.activeElement, isMobile ? h.toggle : h.aboutButton);
  }
});

test('outside pointer, outside keyboard focus and link selection close navigation', () => {
  for (const action of ['pointer', 'focus', 'link']) {
    const h = harness(); h.toggle.emit('click'); h.aboutButton.emit('click');
    if (action === 'pointer') h.document.emit('pointerdown', { target: h.outside });
    if (action === 'focus') h.outside.focus();
    if (action === 'link') h.nav.emit('click', { target: h.events });
    assert.equal(h.nav.inert, true, action); assert.equal(h.menu.inert, true, action);
    assert.equal(h.toggle.getAttribute('aria-expanded'), 'false', action);
  }
});

test('desktop supports mouse hover, click and keyboard without hiding primary links', () => {
  const h = harness({ isMobile: false, canHover: true });
  assert.equal(h.nav.inert, false); assert.equal(h.nav.getAttribute('aria-hidden'), undefined);
  h.about.emit('mouseenter'); assert.equal(h.menu.inert, false);
  h.about.emit('mouseleave'); assert.equal(h.menu.inert, true);
  h.aboutButton.emit('click'); assert.equal(h.menu.inert, false);
  h.aboutButton.emit('click'); assert.equal(h.menu.inert, true);
  h.aboutButton.emit('keydown', { key: 'ArrowUp' }); assert.equal(h.document.activeElement, h.last);
  h.menu.emit('keydown', { key: 'ArrowDown' }); assert.equal(h.document.activeElement, h.first);
  h.menu.emit('keydown', { key: 'End' }); assert.equal(h.document.activeElement, h.last);
  h.events.focus(); assert.equal(h.menu.inert, true);
  assert.equal(h.nav.inert, false);
});

test('crossing the mobile breakpoint resets menus without leaving focus hidden', () => {
  const h = harness({ isMobile: false });
  h.aboutButton.emit('keydown', { key: 'ArrowDown' });
  h.mobile.matches = true; h.mobile.emit('change');
  assert.equal(h.nav.inert, true); assert.equal(h.document.activeElement, h.toggle);
  h.mobile.matches = false; h.mobile.emit('change');
  assert.equal(h.nav.inert, false); assert.equal(h.menu.inert, true);
  assert.equal(h.document.activeElement, h.aboutButton);
});
