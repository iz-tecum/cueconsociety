(function () {
  'use strict';

  const core = typeof module !== 'undefined' && module.exports
    ? require('../events/events.js')
    : window.CESEventsCore;
  if (!core) return;
  const { normalizeEvents, validDate, todayKey, monthLabel } = core;
  const fullDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const shortDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

  function monthDays(month) {
    if (!validDate(`${month}-01`)) throw new RangeError('Invalid calendar month');
    const first = new Date(`${month}-01T12:00:00Z`);
    const next = new Date(first);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(0);
    const leading = first.getUTCDay();
    const count = next.getUTCDate();
    const length = Math.ceil((leading + count) / 7) * 7;
    return Array.from({ length }, (_, index) => index >= leading && index < leading + count
      ? `${month}-${String(index - leading + 1).padStart(2, '0')}`
      : '');
  }

  function shiftMonth(month, amount) {
    if (!validDate(`${month}-01`) || !Number.isInteger(amount)) throw new RangeError('Invalid calendar month');
    const date = new Date(`${month}-01T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + amount);
    const result = date.toISOString().slice(0, 7);
    if (!validDate(`${result}-01`)) throw new RangeError('Calendar month out of range');
    return result;
  }

  function eventsOnDay(events, day) {
    if (!validDate(day)) return [];
    return events.filter(event => event.date <= day && (event.endDate || event.date) >= day);
  }

  function defaultDay(events, month, today = todayKey()) {
    if (!validDate(`${month}-01`)) throw new RangeError('Invalid calendar month');
    if (today.slice(0, 7) === month && validDate(today)) return today;
    const days = monthDays(month).filter(Boolean);
    return days.find(day => eventsOnDay(events, day).length) || `${month}-01`;
  }

  function eventDetailHref(event, month) {
    if (!validDate(`${month}-01`)) throw new RangeError('Invalid calendar month');
    return `/events/?month=${month}#event-${encodeURIComponent(event.id || '')}`;
  }

  const helpers = { monthDays, shiftMonth, eventsOnDay, defaultDay, eventDetailHref };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;

  const root = document.getElementById('ces-calendar');
  const body = document.getElementById('ces-calendar-body');
  const status = document.getElementById('ces-calendar-status');
  const retry = document.getElementById('ces-calendar-retry');
  if (!root || !body || !status || !retry) return;

  let records = [];
  let currentDay = todayKey();
  let month = currentDay.slice(0, 7);
  let selectedDay = currentDay;
  let loading = false;
  let loaded = false;
  let hasLoaded = false;
  let lastFetched = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, label, action, className = '') {
    const control = element('button', `ces-cal-control ${className}`.trim(), text);
    control.type = 'button';
    if (label) control.setAttribute('aria-label', label);
    control.addEventListener('click', action);
    return control;
  }

  const toolbar = element('div', 'ces-cal-toolbar');
  const heading = element('h3', 'ces-cal-month');
  heading.id = 'ces-cal-month';
  heading.setAttribute('aria-live', 'polite');
  const controls = element('div', 'ces-cal-controls');
  const previous = button('‹', 'Previous month', () => changeMonth(-1), 'ces-cal-arrow');
  const next = button('›', 'Next month', () => changeMonth(1), 'ces-cal-arrow');
  const today = button('Today', '', () => {
    currentDay = todayKey();
    month = currentDay.slice(0, 7);
    selectedDay = currentDay;
    render();
  });
  controls.append(previous, today, next);
  toolbar.append(heading, controls);
  const layout = element('div', 'ces-cal-layout');
  const calendar = element('div', 'ces-cal-month-view');
  calendar.setAttribute('aria-labelledby', heading.id);
  const weekdays = element('div', 'ces-cal-weekdays');
  weekdays.setAttribute('aria-hidden', 'true');
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => weekdays.append(element('span', '', day)));
  const grid = element('div', 'ces-cal-grid');
  calendar.append(weekdays, grid);
  const agenda = element('div', 'ces-cal-agenda');
  agenda.setAttribute('aria-live', 'polite');
  agenda.setAttribute('aria-atomic', 'true');
  layout.append(calendar, agenda);
  body.replaceChildren(toolbar, layout);

  function changeMonth(amount) {
    month = shiftMonth(month, amount);
    selectedDay = defaultDay(records, month, todayKey());
    render();
  }

  function renderAgenda() {
    agenda.replaceChildren();
    const date = new Date(`${selectedDay}T12:00:00Z`);
    const title = element('h3', 'ces-cal-day-heading', shortDay.format(date));
    agenda.append(title);
    if (!loaded) return;
    const entries = eventsOnDay(records, selectedDay);
    if (!entries.length) {
      agenda.append(element('p', 'ces-cal-empty', 'No events scheduled.'));
      return;
    }
    entries.forEach(event => {
      const article = element('article', 'ces-cal-event');
      const eventTitle = element('h4', 'ces-cal-event-title');
      const anchor = element('a', '', event.title);
      anchor.href = eventDetailHref(event, month);
      eventTitle.append(anchor);
      article.append(eventTitle);
      if (event.time) article.append(element('p', 'ces-cal-event-time', event.time));
      if (event.location) article.append(element('p', 'ces-cal-event-location', event.location));
      agenda.append(article);
    });
  }

  function render() {
    const focused = document.activeElement;
    const focusedDay = grid.contains(focused) ? focused.dataset.day : '';
    const focusedHref = agenda.contains(focused) && focused.tagName === 'A' ? focused.href : '';
    heading.textContent = monthLabel(month);
    grid.replaceChildren();
    const todayDate = todayKey();
    monthDays(month).forEach(day => {
      if (!day) {
        const blank = element('span', 'ces-cal-day ces-cal-blank');
        blank.setAttribute('aria-hidden', 'true');
        grid.append(blank);
        return;
      }
      const entries = eventsOnDay(records, day);
      const control = element('button', 'ces-cal-day');
      control.type = 'button';
      control.dataset.day = day;
      control.setAttribute('aria-pressed', String(day === selectedDay));
      control.setAttribute('aria-label', `${fullDay.format(new Date(`${day}T12:00:00Z`))}${loaded ? (entries.length ? `, ${entries.length} event${entries.length === 1 ? '' : 's'}` : ', no events') : ''}`);
      if (day === todayDate) control.setAttribute('aria-current', 'date');
      control.append(element('span', 'ces-cal-number', String(Number(day.slice(8)))));
      if (entries.length) {
        const markers = element('span', 'ces-cal-markers');
        markers.setAttribute('aria-hidden', 'true');
        for (let count = 0; count < Math.min(entries.length, 3); count += 1) markers.append(element('span', 'ces-cal-dot'));
        if (entries.length > 3) markers.append(element('span', 'ces-cal-more', '+'));
        control.append(markers);
        control.title = entries.map(event => event.title).join('\n');
      }
      control.addEventListener('click', () => {
        selectedDay = day;
        grid.querySelectorAll('[data-day]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.day === selectedDay)));
        renderAgenda();
      });
      grid.append(control);
    });
    renderAgenda();
    if (focusedDay) [...grid.querySelectorAll('[data-day]')].find(node => node.dataset.day === focusedDay)?.focus();
    if (focusedHref) {
      const target = [...agenda.querySelectorAll('a')].find(node => node.href === focusedHref)
        || [...grid.querySelectorAll('[data-day]')].find(node => node.dataset.day === selectedDay);
      target?.focus();
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    retry.hidden = true;
    if (!loaded) {
      status.hidden = false;
      status.textContent = 'Loading events…';
    }
    body.setAttribute('aria-busy', 'true');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(root.dataset.eventsEndpoint || 'https://admin.cueconsociety.com/api/events', {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Events unavailable');
      const result = await response.json();
      const updated = normalizeEvents(result.events);
      const changed = !loaded || JSON.stringify(updated) !== JSON.stringify(records);
      records = updated;
      if (!hasLoaded) selectedDay = defaultDay(records, month, todayKey());
      loaded = true;
      hasLoaded = true;
      lastFetched = Date.now();
      status.textContent = '';
      status.hidden = true;
      if (changed) render();
    } catch {
      records = [];
      loaded = false;
      render();
      status.textContent = 'Calendar could not load.';
      status.hidden = false;
      retry.hidden = false;
    } finally {
      clearTimeout(timeout);
      loading = false;
      body.setAttribute('aria-busy', 'false');
    }
  }

  retry.addEventListener('click', load);
  function refreshCurrentDay() {
    const day = todayKey();
    if (day !== currentDay) {
      if (selectedDay === currentDay) {
        selectedDay = day;
        month = day.slice(0, 7);
      }
      currentDay = day;
      render();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refreshCurrentDay();
    if (Date.now() - lastFetched >= 60000) load();
  });
  setInterval(() => {
    if (document.hidden) return;
    refreshCurrentDay();
    if (Date.now() - lastFetched >= 60000) load();
  }, 60000);
  render();
  load();
})();
