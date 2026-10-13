import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { renderMessage, unsubscribeLinks } from '../send-queue.mjs';
const require = createRequire(import.meta.url);
const template = require('../../admin/newsletter-template.js');

test('browser and CommonJS share the exact same renderer without scripts or web-font dependencies', async () => {
  const context = { URL };
  runInNewContext(await readFile(new URL('../../admin/newsletter-template.js', import.meta.url), 'utf8'), context);
  const draft = { subject: 'This week at CES', preheader: 'Events and news', body: '## Events\n\n**Tuesday** at 7\n\n- First event\n- [Details](https://cueconsociety.com/events/)' };
  const html = template.renderEmailHTML(draft);
  assert.equal(context.CESNewsletter.renderEmailHTML(draft), html);
  assert.match(html, /<table role="presentation"/);
  assert.match(html, /background="https:\/\/admin\.cueconsociety\.com\/admin\/assets\/email-campus-overlay\.jpg" bgcolor="#294d70"/);
  assert.match(html, /<h1[^>]*color:#ffffff[^>]*>This week at CES<\/h1>/);
  assert.match(html, /font-family:Arial, Helvetica, sans-serif/);
  assert.doesNotMatch(html, /<script|<link|@font-face|border-radius|display:flex|display:grid/i);
});

test('all draft and identity text is escaped; markup allows only safe HTTPS links', () => {
  const attack = '</title><img src=x onerror="alert(1)"><script>alert(1)</script>';
  const html = template.renderEmailHTML({ subject: attack, preheader: attack, body: attack + '\n\n[bad](javascript:alert(1)) [http](http://example.org/) [user](https://user:password@example.org/) [good](https://example.org/?a=1&b=2)' }, { recipientEmail: attack, fromEmail: attack, unsubscribeUrl: 'javascript:alert(1)' });
  assert.doesNotMatch(html, /<script|<img src=x|href="javascript:|href="http:|href="https:\/\/user:password/i);
  const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(match => new URL(match[1]));
  assert.ok(images.length >= 1);
  for (const image of images) {
    assert.equal(image.origin, 'https://admin.cueconsociety.com');
    assert.ok(image.pathname.startsWith('/admin/assets/'));
    assert.equal(image.search, ''); assert.equal(image.hash, '');
  }
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
  assert.doesNotMatch(delivered, /From student@columbia\.edu|Columbia University/);
});

test('body formatting preserves headings, lists, bold, line breaks and Unicode as text', () => {
  const html = template.renderBodyHTML('## Café & CES\r\n\r\n**Tonight**\nRoom 301\n\n- One\n- Two\n\n<img src=x>');
  assert.match(html, /<h2[^>]*>Café &amp; CES<\/h2>/);
  assert.match(html, /<strong>Tonight<\/strong><br>Room 301/);
  assert.equal((html.match(/<li /g) || []).length, 2);
  assert.match(html, /&lt;img src=x&gt;/);
});

test('section rules, callouts and standalone action links create distinct email-safe blocks', () => {
  const body = '## Next event\n\n> **Thursday** · 7 PM\n> Room 301\n\n[View event](https://cueconsociety.com/events/)\n\n---\n\n- One opportunity\n- Another opportunity';
  const html = template.renderBodyHTML(body);
  assert.match(html, /<strong>Thursday<\/strong> · 7 PM<br>Room 301/);
  assert.match(html, /bgcolor="#0b1220"[^>]*><a href="https:\/\/cueconsociety\.com\/events\/"/);
  assert.match(html, /height="1" bgcolor="#b8ccd8"/);
  assert.match(html, /<ul style="margin:0 0 22px;padding-left:20px;/);
  assert.doesNotMatch(html, /border-left|bgcolor="#edf7fd"|bgcolor="#f3f8fb"/);
  assert.doesNotMatch(html, /<script|<style|<link|border-radius|display:flex|display:grid/i);
  const unsafe = template.renderBodyHTML('[bad](javascript:alert(1))\n\n[bad](https://user:password@example.org/)\n\n> <img src=x onerror=alert(1)>');
  assert.doesNotMatch(unsafe, /<a |<img /);
  assert.match(unsafe, /&lt;img/);
});

test('inbox preheader precedes the masthead, visible summary is separate, and plain text removes layout syntax', () => {
  const body = '## Next event\n\n> **Thursday**\n> Room 301\n\n[View event](https://cueconsociety.com/events/)\n\n---\n\n- One opportunity';
  const html = template.renderEmailHTML({ subject: 'This week', preheader: 'A unique short summary', body });
  assert.equal(html.split('A unique short summary').length - 1, 2);
  const hidden = html.match(/<div aria-hidden="true"[^>]*>A unique short summary<\/div>/)?.[0];
  assert.ok(hidden); assert.match(hidden, /display:none/); assert.match(hidden, /mso-hide:all/);
  assert.ok(html.indexOf(hidden) < html.indexOf('<table'));
  assert.match(html, /<p[^>]*>A unique short summary<\/p>/);
  assert.match(html, /max-width:600px/);
  assert.equal(template.renderBodyText(body), 'Next event\n\nThursday\nRoom 301\n\nView event (https://cueconsociety.com/events/)\n\n- One opportunity');
});

test('a section heading after an explicit divider adds no duplicate rule or top gap', () => {
  const divided = template.renderBodyHTML('---\n\n## Opportunities');
  assert.equal((divided.match(/bgcolor="#b8ccd8"/g) || []).length, 1);
  assert.doesNotMatch(divided, /border-top/);
  assert.match(divided, /<h2 style="margin:0 0 14px;/);
  assert.match(template.renderBodyHTML('## Opportunities'), /border-top:1px solid #c9dae5/);
});

test('consecutive allowlisted event fields render unboxed title-case labeled text lines', () => {
  const html = template.renderBodyHTML('> Who: Columbia students\n> What: A discussion\n> When: [Date] · [Time] ET\n> Where: [Location]\n> Deadline: [Date]\n> Cost: Free\n> format: In person');
  for (const label of ['Who', 'What', 'When', 'Where', 'Deadline', 'Cost', 'Format']) assert.match(html, new RegExp('<strong>' + label + ':</strong> '));
  assert.equal((html.match(/<br>/g) || []).length, 6);
  assert.match(html, /Columbia students/); assert.match(html, /\[Date\] · \[Time\] ET/);
  assert.match(html, /font-size:15px;line-height:1.7/); assert.match(html, /word-break:break-word/);
  assert.doesNotMatch(html, /<table|<tr|<td|background|bgcolor|border|display:grid|display:flex|<img/);
});

test('unstructured, incomplete or mixed callouts retain their ordinary rendering', () => {
  for (const body of ['> Who: Columbia students', '> Who: Columbia students\n> Notes: Bring questions', '> Who: Columbia students\n> When: ', '> A short reminder\n> Bring questions']) {
    const html = template.renderBodyHTML(body);
    assert.match(html, /^<p style="margin:0 0 22px;/);
    assert.doesNotMatch(html, /<strong>Who:<\/strong>|<strong>When:<\/strong>|<table|background|border/);
  }
  const split = template.renderBodyHTML('> Who: Columbia students\n\n> When: Thursday');
  assert.equal((split.match(/<p style="margin:0 0 22px;/g) || []).length, 2);
});

test('event values remain escaped with only the existing safe inline formatting', () => {
  const body = '> Who: <img src=x onerror=alert(1)>\n> Where: **Room 301** · [Details](https://example.org/?a=1&b=2)\n> Cost: [bad](javascript:alert(1))';
  const html = template.renderBodyHTML(body);
  assert.doesNotMatch(html, /<img|href="javascript:|<script/);
  assert.match(html, /&lt;img/); assert.match(html, /<strong>Room 301<\/strong>/);
  assert.match(html, /href="https:\/\/example\.org\/\?a=1&amp;b=2"/);
  assert.equal(template.renderBodyText('> Who: Columbia students\n> When: Thursday'), 'Who: Columbia students\nWhen: Thursday');
});

test('actual MIME matches the refined preview and readable plain text with individual unsubscribe links', async () => {
  const env = { GMAIL_UNSUBSCRIBE_ORIGIN: 'https://admin.cueconsociety.com', GMAIL_UNSUBSCRIBE_SECRET: 'template-test-unsubscribe-secret-at-least32' };
  const snapshot = { subject: 'Next at CES', preheader: 'One event and two opportunities', body: '## Next event\n\n> Who: Columbia students\n> When: Thursday · 7 PM\n> Where: Room 301\n\n[View event](https://cueconsociety.com/events/)\n\n---\n\n- One\n- Two' };
  const campaign = { snapshot_json: JSON.stringify(snapshot), from_email: 'sender@columbia.edu' };
  const job = { id: 'a'.repeat(32), contact_id: 'b'.repeat(64), recipient_email: 'reader@example.org', message_id: '<ces.test-message@cueconsociety.com>' };
  const message = Buffer.from(await renderMessage(env, campaign, job, 0), 'base64url').toString();
  assert.match(message, /^From: Columbia Economics Society <sender@columbia\.edu>\r?$/m);
  const part = type => Buffer.from(message.split('Content-Type: text/' + type + '; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString();
  const links = await unsubscribeLinks(env, job.contact_id);
  assert.equal(part('html'), template.renderEmailHTML(snapshot, { unsubscribeUrl: links.page, recipientEmail: job.recipient_email, fromEmail: campaign.from_email }));
  assert.ok(part('plain').includes(template.renderBodyText(snapshot.body)));
  assert.ok(part('plain').includes(links.page));
  assert.doesNotMatch(part('plain'), /Columbia University|From sender@columbia\.edu/);
  assert.doesNotMatch(part('plain'), /^>|^---|^## /m);
});
