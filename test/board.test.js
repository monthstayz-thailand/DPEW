const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CT,
  CARRYOVER_LOOKBACK_DAYS,
  OVERDUE_DAYS,
  depositStillOpen,
  partitionPastCheckins,
  daysAgoIso,
  renderMorningBriefing,
  renderReminder,
  renderEscalationDpew,
  renderEscalationHari,
} = require('../lib/dpew');

function shiftIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const recent = shiftIso(today, -2);
const older = shiftIso(today, -40);

test('deposit stays open until collected or waived', () => {
  assert.equal(depositStillOpen({ [CT.deposit]: false, [CT.depositWaived]: false }), true);
  assert.equal(depositStillOpen({ [CT.deposit]: true, [CT.depositWaived]: false }), false);
  assert.equal(depositStillOpen({ [CT.deposit]: false, [CT.depositWaived]: true }), false);
});

test('open deposits are carried over with no 10-day drop', () => {
  assert.ok(CARRYOVER_LOOKBACK_DAYS > OVERDUE_DAYS);
  const { carried, overdueOther } = partitionPastCheckins([
    { property: 'SNT-C1', custName: 'Kirill Goltsman', arrivalDate: recent, incomplete: ['💵 Deposit', '🛂 Passport'], note: '', depositOpen: true },
    { property: 'AQA-303', custName: 'Evgeny', arrivalDate: older, incomplete: ['💵 Deposit'], note: '', depositOpen: true },
    { property: 'BBT-04', custName: 'Florian Brinkmann', arrivalDate: recent, incomplete: ['🛂 Passport'], note: '', depositOpen: false },
    { property: 'SNT-A3', custName: 'Denis Farafonov', arrivalDate: older, incomplete: ['🛂 Passport'], note: '', depositOpen: false },
  ]);

  assert.deepEqual(carried.map(t => t.custName), ['Kirill Goltsman', 'Evgeny']);
  assert.ok(carried.every(t => t.carriedOver));
  assert.deepEqual(overdueOther.map(t => t.custName), ['Florian Brinkmann']);
  assert.ok(older > daysAgoIso(CARRYOVER_LOOKBACK_DAYS));
  assert.ok(!(older > daysAgoIso(OVERDUE_DAYS)));
});

test('morning briefing tags carried-over guests and keeps today separate', () => {
  const msg = renderMorningBriefing({
    date: '13 October 2026',
    trips: [
      { property: 'SBG-2/24 (S23)', custName: 'Anton Kutsokin', channel: 'Airbnb', groupName: 'CNAN-Anton-SBG-2/24 (S23)-13Oct-23Oct-AB-PK', needsElectric: true, needsWater: true },
      { property: 'SNT-B5', custName: 'Frank Kabelitz', channel: 'Airbnb', groupName: 'CNF7173N-Frank-SNT-B5-13Oct-20Oct-AB-PK', needsElectric: true, needsWater: false },
    ],
    carried: [
      { property: 'SNT-C1', custName: 'Kirill Goltsman', arrivalDate: '2026-10-12', incomplete: ['💵 Deposit', '🛂 Passport', '⚡ Electric Meter'], note: '', carriedOver: true },
    ],
    pendingOuts: [],
  });

  assert.match(msg, /Anton Kutsokin/);
  assert.match(msg, /Frank Kabelitz/);
  assert.match(msg, /2 check-in\(s\) today/);
  assert.match(msg, /🔁 <b>CARRIED OVER<\/b>/);
  assert.match(msg, /Carried over — arrived earlier, deposit still open/);
  assert.match(msg, /Kirill Goltsman/);
  assert.match(msg, /SNT-C1/);
  assert.match(msg, /Arrived: 12 Oct/);
  assert.match(msg, /💵 Deposit/);
  assert.equal(msg.split('Kirill Goltsman').length - 1, 1);
  const carriedAt = msg.indexOf('CARRIED OVER');
  const todayAt = msg.indexOf('check-in(s) today');
  assert.ok(todayAt < carriedAt);
  assert.doesNotMatch(msg, /last 10 days/);
});

test('reminder and escalation include the carried-over tag once', () => {
  const carried = [
    { property: 'SNT-C1', custName: 'Kirill Goltsman', arrivalDate: '2026-10-12', incomplete: ['💵 Deposit'], note: 'Guest paid cash later', carriedOver: true },
  ];
  const reminder = renderReminder({
    time: '14:30',
    date: '13 October 2026',
    pendingTrips: [{ property: 'SNT-B5', custName: 'Frank Kabelitz', incomplete: ['💵 Deposit'], note: '' }],
    carried,
    overdueTrips: [{ property: 'BBT-04', custName: 'Florian Brinkmann', arrivalDate: '2026-10-11', incomplete: ['🛂 Passport'], note: '' }],
    pendingOuts: [],
  });
  assert.match(reminder, /Frank Kabelitz/);
  assert.match(reminder, /🔁 <b>CARRIED OVER<\/b>/);
  assert.match(reminder, /Florian Brinkmann/);
  assert.equal(reminder.split('Kirill Goltsman').length - 1, 1);
  assert.match(reminder, /Guest paid cash later/);

  const dpew = renderEscalationDpew({ time: '19:00', date: '13 October 2026', pendingTrips: [], carried });
  const hari = renderEscalationHari({ time: '19:00', date: '13 October 2026', pendingTrips: [], carried });
  assert.match(dpew, /🔁 <b>CARRIED OVER<\/b>/);
  assert.match(dpew, /Kirill Goltsman/);
  assert.match(hari, /🔁 <b>CARRIED OVER<\/b>/);
  assert.match(hari, /Kirill Goltsman/);
});
