const test = require('node:test');
const assert = require('node:assert/strict');
const { todayKey, validDate, publicUrl, artworkUrl, monthFromQuery, eventMonths, normalizeEvents, splitMonth, monthLabel } = require('../events/events.js');

test('event day follows New York at the UTC date boundary and DST transitions', () => {
  assert.equal(todayKey(new Date('2026-10-15T03:59:59Z')), '2026-10-14');
  assert.equal(todayKey(new Date('2026-10-15T04:00:00Z')), '2026-10-15');
  assert.equal(todayKey(new Date('2026-11-01T04:30:00Z')), '2026-11-01');
  assert.equal(todayKey(new Date('2026-11-02T04:30:00Z')), '2026-11-01');
});

test('invalid calendar dates cannot enter the public monthly record', () => {
  assert.equal(validDate('2028-02-29'), true);
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-14T00:00:00Z', '2026-1-4', '', null]) assert.equal(validDate(date), false);
});

test('only published valid records appear, with chronological ordering', () => {
  const records = normalizeEvents([
    { id: 'draft', title: 'Private draft', date: '2026-10-10', status: 'draft' },
    { id: 'future', title: 'Speaker event', date: '2026-10-16', status: 'published' },
    { id: 'bad', title: 'Invalid day', date: '2026-10-32', status: 'published' },
    { id: 'opportunity', title: 'Shared talk', date: '2026-10-14', status: 'published', category: 'opportunity' },
    { id: 'unnamed', title: ' ', date: '2026-10-14', status: 'published' },
  ]);
  assert.deepEqual(records.map(event => event.id), ['opportunity', 'future']);
  assert.equal(records[0].category, 'opportunity');
  assert.equal(records[1].category, 'ces');
});

test('current day stays upcoming, past months remain an accurate record', () => {
  const events = ['2026-09-30', '2026-10-01', '2026-10-14', '2026-10-28', '2026-11-01'].map(date => ({ date }));
  const groups = splitMonth(events, '2026-10', '2026-10-14');
  assert.deepEqual(groups.upcoming.map(event => event.date), ['2026-10-14', '2026-10-28']);
  assert.deepEqual(groups.past.map(event => event.date), ['2026-10-01']);
  assert.deepEqual(splitMonth(events, '2026-09', '2026-10-14'), { upcoming: [], past: [{ date: '2026-09-30' }] });
  assert.deepEqual(splitMonth(events, '2026-08', '2026-10-14'), { upcoming: [], past: [] });
});

test('links reject executable URLs, private Drive links, credentials and local addresses', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'http://example.org/poster.jpg', 'https://user:pass@example.org/', 'https://drive.google.com/file/d/private/view', 'https://docs.google.com/document/d/private/', 'https://127.0.0.1/asset', 'https://localhost/asset', 'https://example.local/asset', 'https://[::1]/asset']) assert.equal(publicUrl(value), '');
  assert.equal(publicUrl('https://admin.cueconsociety.com/api/events/media/poster.jpg'), 'https://admin.cueconsociety.com/api/events/media/poster.jpg');
  assert.equal(publicUrl('https://www.instagram.com/p/abc/', true), 'https://www.instagram.com/p/abc/');
  assert.equal(publicUrl('https://www.instagram.com.evil.example/p/abc/', true), '');
});

test('month labels use the selected calendar month without browser timezone shifts', () => {
  assert.equal(monthLabel('2026-10'), 'October 2026');
  assert.equal(monthLabel('2027-01'), 'January 2027');
});

test('multi-day records span months and stay ongoing through their final day', () => {
  const [event] = normalizeEvents([{ id: 'range', title: 'Conference', date: '2026-10-30', endDate: '2026-11-02', status: 'published', imageAlt: ' Conference poster ' }]);
  assert.equal(event.endDate, '2026-11-02');
  assert.equal(event.imageAlt, 'Conference poster');
  assert.deepEqual(eventMonths(event), ['2026-10', '2026-11']);
  assert.equal(splitMonth([event], '2026-11', '2026-11-02').upcoming.length, 1);
  assert.equal(splitMonth([event], '2026-11', '2026-11-03').past.length, 1);
  assert.equal(splitMonth([event], '2026-10', '2026-10-31').upcoming.length, 1);
  assert.equal(splitMonth([event], '2026-12', '2026-10-31').upcoming.length, 0);
  for (const endDate of ['2026-10-01', '2026-11-31']) {
    const [normalized] = normalizeEvents([{ title: 'Event', date: '2026-10-30', endDate, status: 'published' }]);
    assert.equal(normalized.endDate, '');
  }
  assert.equal(eventMonths({ date: '2026-10-30', endDate: '2099-10-30' }).length, 13);
});

test('newsletter month links accept valid months and ignore malformed input', () => {
  assert.equal(monthFromQuery('?month=2026-10'), '2026-10');
  assert.equal(monthFromQuery('?source=newsletter&month=2026-11'), '2026-11');
  for (const query of ['', '?month=2026-13', '?month=2026-1', '?month=javascript%3Aalert(1)']) assert.equal(monthFromQuery(query), '');
});

test('artwork loads only from CES public event-media paths', () => {
  for (const href of ['https://admin.cueconsociety.com/api/events/media/a.jpg', 'https://cueconsociety.com/media/events/a.jpg', 'https://www.cueconsociety.com/media/events/a.jpg']) assert.equal(artworkUrl(href), href);
  for (const href of ['https://tracker.example/pixel.png', 'https://admin.cueconsociety.com/api/audience/export', 'https://www.cueconsociety.com/media/people/a.jpg', 'https://cueconsociety.com:8443/media/events/a.jpg', 'https://admin.cueconsociety.com/api/events/media/../other.jpg']) assert.equal(artworkUrl(href), '');
});
