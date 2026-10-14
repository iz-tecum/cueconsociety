const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEvents, todayKey } = require('../events/events.js');
const { monthDays, shiftMonth, eventsOnDay, defaultDay, eventDetailHref } = require('../calendar/calendar.js');

function event(id, date, endDate = '') {
  return { id, date, endDate, title: id, status: 'published' };
}

test('calendar lays out Sunday-first weeks with correct month padding', () => {
  const october = monthDays('2026-10');
  assert.equal(october.length, 35);
  assert.deepEqual(october.slice(0, 5), ['', '', '', '', '2026-10-01']);
  assert.equal(october[34], '2026-10-31');
  const february = monthDays('2026-02');
  assert.equal(february.length, 28);
  assert.equal(february[0], '2026-02-01');
  assert.equal(february[27], '2026-02-28');
  const august = monthDays('2026-08');
  assert.equal(august.length, 42);
  assert.equal(august[6], '2026-08-01');
  assert.equal(august[36], '2026-08-31');
  assert.deepEqual(august.slice(37), ['', '', '', '', '']);
});

test('calendar correctly handles leap years and year navigation', () => {
  assert.equal(monthDays('2000-02').filter(Boolean).length, 29);
  assert.equal(monthDays('2100-02').filter(Boolean).length, 28);
  assert.equal(monthDays('2028-02').filter(Boolean).length, 29);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2027-01', -1), '2026-12');
  assert.equal(shiftMonth('2026-02', 12), '2027-02');
  for (const month of ['2026-13', '2026-2', '2026-02-30', 'invalid']) {
    assert.throws(() => monthDays(month), RangeError);
    assert.throws(() => shiftMonth(month, 1), RangeError);
  }
});

test('range markers include every date through the final day across month and year boundaries', () => {
  const records = normalizeEvents([
    event('fall', '2026-10-30', '2026-11-02'),
    event('winter', '2026-12-31', '2027-01-02'),
    event('one-day', '2026-11-01'),
  ]);
  for (const date of ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']) assert.equal(eventsOnDay(records, date).some(item => item.id === 'fall'), true);
  assert.deepEqual(eventsOnDay(records, '2026-11-01').map(item => item.id), ['fall', 'one-day']);
  assert.deepEqual(eventsOnDay(records, '2026-11-03'), []);
  assert.equal(eventsOnDay(records, '2027-01-02')[0].id, 'winter');
  assert.deepEqual(eventsOnDay(records, '2027-01-03'), []);
  assert.deepEqual(eventsOnDay(records, '2026-11-32'), []);
});

test('selection uses New York today, then the first event in another month, then its first day', () => {
  const records = normalizeEvents([event('event', '2026-10-18'), event('range', '2026-10-30', '2026-11-02'), event('future', '2026-12-17')]);
  assert.equal(defaultDay(records, '2026-10', '2026-10-14'), '2026-10-14');
  assert.equal(defaultDay(records, '2026-10', '2026-09-30'), '2026-10-18');
  assert.equal(defaultDay(records, '2026-11', '2026-10-14'), '2026-11-01');
  assert.equal(defaultDay(records, '2026-12', '2026-10-14'), '2026-12-17');
  assert.equal(defaultDay(records, '2027-01', '2026-10-14'), '2027-01-01');
  for (const [instant, day] of [['2026-10-15T03:59:59Z', '2026-10-14'], ['2026-10-15T04:00:00Z', '2026-10-15'], ['2026-11-02T04:59:59Z', '2026-11-01'], ['2026-11-02T05:00:00Z', '2026-11-02']]) {
    const today = todayKey(new Date(instant));
    assert.equal(defaultDay(records, today.slice(0, 7), today), day);
  }
});

test('calendar consumes only published records and preserves literal times', () => {
  const records = normalizeEvents([
    { ...event('public', '2026-10-14'), time: '6–7:30 PM' },
    { ...event('private', '2026-10-14'), status: 'draft' },
    { ...event('invalid', '2026-02-30') },
  ]);
  assert.equal(records.length, 1);
  assert.equal(eventsOnDay(records, '2026-10-14')[0].time, '6–7:30 PM');
});

test('calendar details link to public event records with safe encoded anchors', () => {
  assert.equal(eventDetailHref({ id: 'jane-street' }, '2026-10'), '/events/?month=2026-10#event-jane-street');
  assert.equal(eventDetailHref({ id: 'a/b <x>&?' }, '2026-10'), '/events/?month=2026-10#event-a%2Fb%20%3Cx%3E%26%3F');
  assert.throws(() => eventDetailHref({ id: 'x' }, '2026-99'), RangeError);
});
