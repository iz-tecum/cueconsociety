import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = JSON.parse(await readFile(path.join(root, 'shared/public-content.json'), 'utf8'));
const pages = ['index.html', ...['about', 'events', 'leadership', 'alumni', 'faq', 'contact', 'recruitment', 'newsletter', 'unsubscribe'].map(name => `${name}/index.html`)];
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const email = escape(content.email), label = escape(content.mailingList.label), href = escape(content.mailingList.href);
function navigation(page) {
  const prefix = page === 'index.html' ? './' : '../';
  const link = (name, label, className = '') => `<a${className ? ` class="${className}"` : ''} href="${prefix}${name}/index.html"${page === `${name}/index.html` ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="topbar" id="topbar">
  <div class="topbar-inner">
    <a class="brand brand-float" href="${prefix}index.html" aria-label="Home"${page === 'index.html' ? ' aria-current="page"' : ''}>
      <img src="${prefix}media/ceslogo.png" alt="Columbia Economics Society logo">
    </a>
    <button class="nav-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="mobileNav">
      <span></span><span></span><span></span>
    </button>
    <nav class="nav" id="mobileNav" aria-label="Primary">
      <div class="nav-links">
        <div class="drop" id="aboutDrop">
          <button type="button" id="aboutBtn" aria-expanded="false" aria-controls="aboutMenu">
            ABOUT US <span class="caret" aria-hidden="true"></span>
          </button>
          <div class="menu" id="aboutMenu" aria-label="About menu">
            ${link('about', 'ABOUT')}
            ${link('leadership', 'LEADERSHIP')}
          </div>
        </div>
        ${link('events', 'EVENTS')}
        ${link('alumni', 'ALUMNI')}
        ${link('faq', 'FAQ')}
        ${link('contact', 'CONTACT')}
        ${link('recruitment', 'RECRUITMENT', 'recruit')}
      </div>
    </nav>
  </div>
</header>`;
}
function replaceOnce(html, expression, replacement, name) {
  const matches = [...html.matchAll(new RegExp(expression.source, 'g' + (expression.flags.includes('s') ? 's' : '')))];
  if (matches.length !== 1) throw Error(`${name}: expected one matching block, found ${matches.length}`);
  return html.replace(expression, replacement);
}
let changed = 0;
for (const page of pages) {
  const file = path.join(root, page), original = await readFile(file, 'utf8');
  let html = original.replace('placeholder="user@gmail.com"', 'placeholder="Your email"');
  html = replaceOnce(html, /<header class="topbar"[\s\S]*?<\/header>/, navigation(page), page + ' navigation');
  html = html.replace(/mailto:[^"\s<]+/g, `mailto:${email}`);
  html = html.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, email);
  html = replaceOnce(html, /(<div class="footer-links">)([\s\S]*?)(<\/div>)/, (whole, start, links, end) => {
    const clean = links.replace(/\s*<a\b[^>]*\bdata-site-mailing-list\b[^>]*>[\s\S]*?<\/a>/g, '').replace(/\s*<a\b[^>]*href="(?:\.\.\/|\/)?newsletter\/"[^>]*>[\s\S]*?<\/a>/g, '').trimEnd();
    const indent = /\n([ \t]+)<a/.exec(links)?.[1] || '        ';
    return `${start}${clean}\n${indent}<a href="${href}" data-site-mailing-list${page.startsWith('newsletter/') ? ' aria-current="page"' : ''}>${label}</a>\n${indent.slice(0, -2)}${end}`;
  }, page + ' footer');
  if (page === 'index.html') html = replaceOnce(html, /(<a class="band-btn" href="[^"]+">)[\s\S]*?(<\/a>)/, `<a class="band-btn" href="${href}">\n            ${label.toUpperCase()}\n          </a>`, 'homepage mailing-list button');
  if (page === 'recruitment/index.html') {
    const names = content.recruitmentContacts.map(name => `<a href="mailto:${email}">${escape(name)}</a>`);
    const list = names.slice(0, -1).join(', ') + ', and ' + names.at(-1);
    html = replaceOnce(html, /(<div class="recruit-section" aria-label="Getting involved">\s*)<p class="recruit-section-body">[\s\S]*?<\/p>/, `$1<p class="recruit-section-body">For inquiries pertaining to the recruitment process, contact our board members ${list} at <a href="mailto:${email}">${email}</a>.</p>`, 'recruitment contacts');
  }
  if (page === 'alumni/index.html') {
    html = replaceOnce(html, /(<section class="class-card" aria-labelledby=")class-\d+("\s*>)/, `$1class-${content.alumni.year}$2`, 'alumni section label');
    html = replaceOnce(html, /<h3 class="class-title" id="class-\d+">Class of \d+<\/h3>/, `<h3 class="class-title" id="class-${content.alumni.year}">Class of ${content.alumni.year}</h3>`, 'alumni year');
    const people = content.alumni.people.map(person => `                  <li><a href="${escape(person.url)}" target="_blank" rel="noopener noreferrer">${escape(person.name)}</a></li>`).join('\n');
    html = replaceOnce(html, /<ul class="alumni-list">[\s\S]*?<\/ul>/, `<ul class="alumni-list">\n${people}\n                </ul>`, 'alumni names');
  }
  if (html !== original) { await writeFile(file, html); changed++; }
}
console.log(`Synchronized public content on ${pages.length} pages; ${changed} changed.`);
