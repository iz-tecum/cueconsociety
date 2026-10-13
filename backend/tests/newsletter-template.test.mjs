import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const template = require('../../admin/newsletter-template.js');

test('browser and CommonJS share the exact same renderer without scripts or web-font dependencies', async () => {
  const context = { URL };
  runInNewContext(await readFile(new URL('../../admin/newsletter-template.js', import.meta.url), 'utf8'), context);
  const draft = { subject: 'This week at CES', preheader: 'Events and news', body: '## Events\n\n**Tuesday** at 7\n\n- First event\n- [Details](https://cueconsociety.com/events/)' };
  const html = template.renderEmailHTML(draft);
  assert.equal(context.CESNewsletter.renderEmailHTML(draft), html);
  assert.match(html, /<table role="presentation"/);
  assert.match(html, /background-color:#dbf2ff/);
  assert.match(html, /font-family:Arial, Helvetica, sans-serif/);
  assert.doesNotMatch(html, /<script|<link|@font-face|border-radius|display:flex|display:grid/i);
});

test('all draft and identity text is escaped; markup allows only safe HTTPS links', () => {
  const attack = '</title><img src=x onerror="alert(1)"><script>alert(1)</script>';
  const html = template.renderEmailHTML({ subject: attack, preheader: attack, body: attack + '\n\n[bad](javascript:alert(1)) [http](http://example.org/) [user](https://user:password@example.org/) [good](https://example.org/?a=1&b=2)' }, { recipientEmail: attack, fromEmail: attack, unsubscribeUrl: 'javascript:alert(1)' });
  assert.doesNotMatch(html, /<script|<img src=x|href="javascript:|href="http:|href="https:\/\/user:password/i);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /&lt;\/title&gt;&lt;img/);
  assert.match(html, /href="https:\/\/example\.org\/\?a=1&amp;b=2"/);
  assert.ok(html.includes('<span>Unsubscribe</span>'));
});

test('preview has no invented unsubscribe token; delivery renders its exact signed HTTPS URL', () => {
  const draft = { subject: 'CES update', body: 'A short update' };
  const preview = template.renderEmailHTML(draft);
  assert.doesNotMatch(preview, /token=|href="[^"]*unsubscribe/i);
  const link = 'https://admin.cueconsociety.com/unsubscribe?contact=abc&token=individual-token';
  const delivered = template.renderEmailHTML(draft, { unsubscribeUrl: link, recipientEmail: 'reader@example.org', fromEmail: 'student@columbia.edu' });
  assert.ok(delivered.includes('href="' + link.replaceAll('&', '&amp;') + '"'));
  assert.match(delivered, /Sent to reader@example\.org/);
  assert.match(delivered, /From student@columbia\.edu/);
});

test('body formatting preserves headings, lists, bold, line breaks and Unicode as text', () => {
  const html = template.renderBodyHTML('## Café & CES\r\n\r\n**Tonight**\nRoom 301\n\n- One\n- Two\n\n<img src=x>');
  assert.match(html, /<h2[^>]*>Café &amp; CES<\/h2>/);
  assert.match(html, /<strong>Tonight<\/strong><br>Room 301/);
  assert.equal((html.match(/<li /g) || []).length, 2);
  assert.match(html, /&lt;img src=x&gt;/);
});
