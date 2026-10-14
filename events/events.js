(function () {
  'use strict';

  const ENDPOINT = 'https://admin.cueconsociety.com/api/events';
  const ZONE = 'America/New_York';
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });

  function todayKey(now = new Date()) {
    const parts = Object.fromEntries(dateFormatter.formatToParts(now).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function publicUrl(value, instagramOnly = false) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      const hostname = url.hostname.toLowerCase();
      if (instagramOnly && hostname !== 'instagram.com' && hostname !== 'www.instagram.com') return '';
      if (hostname === 'drive.google.com' || hostname === 'docs.google.com' || hostname === 'localhost' || hostname.endsWith('.local') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) return '';
      return url.href;
    } catch { return ''; }
  }

  function artworkUrl(value) {
    const href = publicUrl(value);
    if (!href) return '';
    const url = new URL(href);
    if (url.port) return '';
    const approvedPath = url.hostname === 'admin.cueconsociety.com'
      ? /^\/api\/events\/media\/.+/.test(url.pathname)
      : ['cueconsociety.com', 'www.cueconsociety.com'].includes(url.hostname) && /^\/media\/events\/.+/.test(url.pathname);
    return approvedPath ? href : '';
  }

  function monthFromQuery(search) {
    const month = new URLSearchParams(search).get('month') || '';
    return /^\d{4}-\d{2}$/.test(month) && validDate(`${month}-01`) ? month : '';
  }

  function eventMonths(event) {
    const first = event.date.slice(0, 7);
    const last = (event.endDate || event.date).slice(0, 7);
    const result = [];
    let month = first;
    for (let index = 0; month <= last && index < 13; index += 1) {
      result.push(month);
      const [year, number] = month.split('-').map(Number);
      month = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
    }
    return result;
  }

  function normalizeEvents(input) {
    if (!Array.isArray(input)) throw new TypeError('Events unavailable');
    return input.filter(event => event && event.status === 'published' && validDate(event.date) && typeof event.title === 'string' && event.title.trim())
      .map(event => ({
        id: String(event.id || ''),
        title: event.title.trim(),
        date: event.date,
        endDate: validDate(event.endDate) && event.endDate >= event.date ? event.endDate : '',
        time: typeof event.time === 'string' ? event.time.trim() : '',
        location: typeof event.location === 'string' ? event.location.trim() : '',
        summary: typeof event.summary === 'string' ? event.summary.trim() : '',
        category: event.category === 'opportunity' ? 'opportunity' : 'ces',
        imageUrl: artworkUrl(event.imageUrl),
        imageAlt: typeof event.imageAlt === 'string' ? event.imageAlt.trim() : '',
        instagramUrl: publicUrl(event.instagramUrl, true),
        actionUrl: publicUrl(event.actionUrl),
        actionLabel: typeof event.actionLabel === 'string' && event.actionLabel.trim() ? event.actionLabel.trim() : 'Details',
      })).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }

  function splitMonth(events, month, today = todayKey()) {
    const inMonth = events.filter(event => event.date.slice(0, 7) <= month && (event.endDate || event.date).slice(0, 7) >= month);
    return { upcoming: inMonth.filter(event => (event.endDate || event.date) >= today), past: inMonth.filter(event => (event.endDate || event.date) < today) };
  }

  function monthLabel(month) {
    return monthFormatter.format(new Date(`${month}-01T12:00:00Z`));
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { todayKey, validDate, publicUrl, artworkUrl, monthFromQuery, eventMonths, normalizeEvents, splitMonth, monthLabel };
  if (typeof document === 'undefined') return;

  const picker = document.getElementById('events-month');
  const heading = document.getElementById('events-month-heading');
  const notice = document.getElementById('events-notice');
  const message = document.getElementById('events-message');
  const retry = document.getElementById('events-retry');
  const record = document.getElementById('events-record');
  if (!picker || !heading || !notice || !message || !retry || !record) return;

  let events = [];
  let loaded = false;
  let loading = false;
  let currentDay = todayKey();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function link(text, url, className = '') {
    const anchor = element('a', className, text);
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
  }

  function eventArticle(event, today) {
    const article = element('article', `event-entry${event.imageUrl ? ' has-artwork' : ''}`);
    article.id = `event-${event.id}`;
    const date = element('time', 'event-date');
    date.dateTime = event.date;
    date.setAttribute('aria-label', new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'full' }).format(new Date(`${event.date}T12:00:00Z`)));
    date.append(element('span', 'event-day', String(Number(event.date.slice(8)))), element('span', 'event-weekday', weekdayFormatter.format(new Date(`${event.date}T12:00:00Z`))));
    const copy = element('div', 'event-copy');
    const category = event.category === 'opportunity' ? 'Shared opportunity' : 'CES event';
    const ongoing = event.endDate && event.date < today && event.endDate >= today;
    copy.append(element('p', 'event-kind', category + (ongoing ? ' · Ongoing' : event.date === today ? ' · Today' : '')), element('h3', 'event-title', event.title));
    if (event.time || event.location || event.endDate && event.endDate !== event.date) {
      const details = element('p', 'event-details');
      if (event.endDate && event.endDate !== event.date) {
        const format = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(event.date.slice(0, 4) !== event.endDate.slice(0, 4) ? { year: 'numeric' } : {}) });
        const range = `${format.format(new Date(`${event.date}T12:00:00Z`))} – ${format.format(new Date(`${event.endDate}T12:00:00Z`))}`;
        details.append(element('span', 'event-detail', range));
      }
      if (event.time) details.append(element('span', 'event-detail', event.time));
      if (event.location) details.append(element('span', 'event-detail', event.location));
      copy.append(details);
    }
    if (event.summary) copy.append(element('p', 'event-summary', event.summary));
    if (event.actionUrl || event.instagramUrl) {
      const links = element('div', 'event-links');
      if (event.actionUrl) links.append(link(event.actionLabel, event.actionUrl));
      if (event.instagramUrl && event.instagramUrl !== event.actionUrl) links.append(link('Instagram ↗', event.instagramUrl));
      copy.append(links);
    }
    article.append(date, copy);
    if (event.imageUrl) {
      const media = link('', event.imageUrl, 'event-media');
      media.setAttribute('aria-label', `Open ${event.title} artwork`);
      const image = element('img', 'event-poster');
      image.src = event.imageUrl;
      image.alt = event.imageAlt || `${event.title} event artwork`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => { media.remove(); article.classList.remove('has-artwork'); });
      media.append(image);
      article.append(media);
    }
    return article;
  }

  function renderGroup(label, entries, today) {
    if (!entries.length) return;
    const section = element('section', 'events-group');
    const groupHeading = element('h3', 'events-group-heading', label);
    section.append(groupHeading);
    entries.forEach(event => section.append(eventArticle(event, today)));
    record.append(section);
  }

  function render() {
    const month = picker.value;
    heading.textContent = monthLabel(month);
    if (!loaded) return;
    const today = todayKey();
    const groups = splitMonth(events, month, today);
    record.replaceChildren();
    renderGroup(groups.upcoming.some(event => event.date < today) ? 'Upcoming and ongoing' : 'Upcoming', groups.upcoming, today);
    renderGroup(month === today.slice(0, 7) ? 'Earlier this month' : 'Past events', groups.past, today);
    const empty = !groups.upcoming.length && !groups.past.length;
    notice.hidden = !empty;
    retry.hidden = true;
    message.textContent = empty ? 'No events posted for this month.' : '';
    record.setAttribute('aria-busy', 'false');
  }

  function updateMonths(selected = picker.value || todayKey().slice(0, 7)) {
    const months = [...new Set([todayKey().slice(0, 7), ...(validDate(`${selected}-01`) ? [selected] : []), ...events.flatMap(eventMonths)])].sort().reverse();
    picker.replaceChildren();
    months.forEach(month => {
      const option = element('option', '', monthLabel(month));
      option.value = month;
      picker.append(option);
    });
    picker.value = months.includes(selected) ? selected : todayKey().slice(0, 7);
    heading.textContent = monthLabel(picker.value);
  }

  async function load() {
    if (loading) return;
    loading = true;
    retry.hidden = true;
    notice.hidden = false;
    message.textContent = 'Loading events…';
    record.setAttribute('aria-busy', 'true');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(ENDPOINT, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new Error('Events unavailable');
      const result = await response.json();
      events = normalizeEvents(result.events);
      loaded = true;
      updateMonths();
      picker.disabled = false;
      render();
    } catch {
      message.textContent = 'Events could not load. Try again, or visit CES on Instagram below.';
      retry.hidden = false;
      notice.hidden = false;
      record.setAttribute('aria-busy', 'false');
    } finally {
      clearTimeout(timeout);
      loading = false;
    }
  }

  picker.addEventListener('change', render);
  retry.addEventListener('click', load);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !loaded || todayKey() === currentDay) return;
    currentDay = todayKey();
    updateMonths();
    render();
  });
  updateMonths(monthFromQuery(window.location.search) || todayKey().slice(0, 7));
  load();
})();
