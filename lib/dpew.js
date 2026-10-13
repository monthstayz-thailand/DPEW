// ================================================================
//  MONTHSTAYZ — CHECK-IN PROTOCOL AUTOMATION (Vercel port)
//  Faithful port of checkin_protocol_fixed.gs's business logic.
//  Tokens come from environment variables, never hardcoded.
//  The Google-Sheet dashboard/menu/trigger management from the Apps
//  Script version is intentionally NOT ported — nobody actually looks
//  at that sheet; the HTML dashboard + Telegram are the real UI.
// ================================================================

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE  = 'appND9kP55cvkDX7V';
const TG_TOKEN        = process.env.TG_TOKEN;
const DPEW_CHAT       = -1004415576097;
const HARI_CHAT       = 2043278046;
const TZ              = 'Asia/Bangkok';

// Other incomplete check-in items (passport, meters) and check-out tasks
// stay on the short window. An uncollected deposit does not: those guests
// stay on the board until it is collected or waived. 365 days is only a
// bound on the Airtable query, not a day the guest drops off.
const OVERDUE_DAYS = 10;
const CARRYOVER_LOOKBACK_DAYS = 365;

const MASTER_TBL = 'tblodAjjJy8FBQAY7';
const COMP_TBL   = 'tblK36oDEOD1SdKQj';

const MT = {
  tripId:      'fld1ziuDjSOUDfmdY',
  arrivalDate: 'fldu81bwcyq86aBKz',
  property:    'fldy6ALjM2cSz745M',
  channel:     'fldrmnsj1lsZO9UoJ',
  custName:    'fldB8I68PoBtSDWeS',
  groupName:   'fldAnwCUUCiV32DCE',
  checkoutDate:'fldiQISqiSkO45tvn',
};

const CT = {
  tripId:        'fldUNpm31vNyoNuGC',
  masterRecId:   'fld1RNQz0VasAfCtw',
  property:      'fldvrWs3pfSdNce0w',
  custName:      'fldAAib7G6qnkRJqM',
  channel:       'fldvfNM43HeNNRq81',
  arrivalDate:   'fldh8ATDYHKW9V3DQ',
  deposit:       'fldPSNu2SDgIW5SBD',
  passport:      'fldPh5ggFtwWIAd0k',
  electric:      'fldtMHMC0ylWZr0ae',
  water:         'fldXkjX7159cfKD0g',
  depositAt:     'fldX691UPBebXAhZ1',
  passportAt:    'fldMJaSSbWKVG9omE',
  electricAt:    'fldG5TthLcuYgXqEh',
  waterAt:       'fldcydcrIvDvYKgep',
  needsElectric: 'fld04aLyfyfscTcnX',
  needsWater:    'fldG7hnWqLBaDZHjp',
  depositWaived: 'fldtIg9hkHzaM06Sn',
  electricNA:    'fldkgDZ3a0EKDWoAp',
  waterNA:       'fldhijaiQ5NTUs4UU',
  completedBy:   'fldIzoPJxrHYpy8dP',
  groupName:     'fldOMNlOpUbTfoAwW',
  notes:         'fldoTudQrPX8Caz9d',
  custNoResp:    'fldKaWYKMc4y7MC1C',
  custNoRespReason: 'fld0C3vYNCf37sZUZ',
  depositRet:     'fldjoXaHMKY2nXV8X',
  elecChargeDone: 'fldKXTxKFVg8123iZ',
  waterChargeDone:'fld276er0j5Ibrpbp',
};

// ================================================================
//  DATE / TIME HELPERS
// ================================================================
function todayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // yyyy-MM-dd
}
function displayDate() {
  return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
}
function displayTime() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ, hour12: false });
}
// Short display date like "12 Jul" from yyyy-MM-dd
function fmtShortDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: TZ });
  } catch (e) { return iso; }
}

// ================================================================
//  AIRTABLE API HELPERS
// ================================================================
async function atGet(tableId, filterFormula, fieldIds) {
  let url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(tableId)}?`;
  const parts = ['returnFieldsByFieldId=true'];
  if (filterFormula) parts.push('filterByFormula=' + encodeURIComponent(filterFormula));
  if (fieldIds) fieldIds.forEach(f => parts.push('fields%5B%5D=' + encodeURIComponent(f)));
  url += parts.join('&');

  let records = [];
  let offset = null;
  do {
    const fetchUrl = offset ? url + '&offset=' + offset : url;
    const res = await fetch(fetchUrl, { headers: { Authorization: 'Bearer ' + AIRTABLE_TOKEN } });
    const data = await res.json();
    if (data.error) throw new Error('Airtable GET error: ' + JSON.stringify(data.error));
    records = records.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);
  return records;
}

async function atPost(tableId, fields) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(tableId)}?returnFieldsByFieldId=true`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields }] }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error('Airtable POST error: ' + JSON.stringify(data.error));
  return data.records && data.records[0];
}

async function atPatchRecord(tableId, recordId, fields) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(tableId)}/${recordId}?returnFieldsByFieldId=true`,
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error('Airtable PATCH error: ' + JSON.stringify(data.error));
  return data;
}

// ================================================================
//  TELEGRAM HELPER
// ================================================================
async function tgSend(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  const recipient = chatId === DPEW_CHAT ? 'DPEW Group' : 'Hari Ananth';
  if (!data.ok) console.error('Telegram error to ' + recipient + ': ' + JSON.stringify(data));
  return !!data.ok;
}

// ================================================================
//  BUSINESS RULES
// ================================================================
function applyRules(property, channel) {
  const isBDC = (channel || '').toLowerCase().includes('booking');
  const isSNT = (property || '').toUpperCase().includes('SNT');
  return {
    needsDeposit: true,
    needsPassport: true,
    needsElectric: !isBDC,
    needsWater: !isBDC && !isSNT,
  };
}

function extractName(raw) {
  if (!raw) return '';
  if (Array.isArray(raw)) return raw.join(', ');
  if (typeof raw === 'string') return raw;
  return String(raw);
}

// ================================================================
//  FETCH TODAY'S TRIPS FROM MASTER TRIPS
// ================================================================
async function getTodayTrips() {
  const today = todayBangkok();
  const formula = `AND(IS_SAME({Arrival Date}, DATETIME_PARSE('${today}'), 'day'), FIND('Phuket', {City}), OR({Inquiry status} = 'Paid and confirmed', {Inquiry status} = 'Checked-In'))`;
  const fields = [MT.tripId, MT.arrivalDate, MT.property, MT.channel, MT.custName, MT.groupName];
  const records = await atGet(MASTER_TBL, formula, fields);

  return records.map(r => {
    const f = r.fields;
    const property = f[MT.property] || '';
    const channel = f[MT.channel] || '';
    const custName = extractName(f[MT.custName]);
    const rules = applyRules(property, channel);
    return {
      masterRecId: r.id,
      tripId: f[MT.tripId] || '',
      property,
      channel,
      custName,
      groupName: f[MT.groupName] || '',
      arrivalDate: today,
      ...rules,
    };
  });
}

// ================================================================
//  CHECK-OUT PROTOCOL — pending task detection
// ================================================================
function getIncompleteCheckout(cf, needsElectric, needsWater) {
  const list = [];
  if (!cf[CT.depositRet] && !cf[CT.depositWaived]) list.push('💵 Deposit Return');
  if (needsElectric && !cf[CT.elecChargeDone] && !cf[CT.electricNA]) list.push('⚡ Electricity Charges');
  if (needsWater && !cf[CT.waterChargeDone] && !cf[CT.waterNA]) list.push('💧 Water Charges');
  return list;
}

// Pending check-outs: trips whose Checkout Date is within [today-daysBack, today]
async function getPendingCheckouts(daysBack) {
  const today = todayBangkok();
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: TZ });
  const cutoff = new Date(Date.now() - (daysBack + 1) * 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: TZ });

  const tripFormula = `AND(IS_AFTER({Checkout Date}, DATETIME_PARSE('${cutoff}')), IS_BEFORE({Checkout Date}, DATETIME_PARSE('${tomorrow}')), FIND('Phuket', {City}), OR({Inquiry status} = 'Checked-In', {Inquiry status} = 'Trip completed'))`;
  const fields = [MT.tripId, MT.checkoutDate, MT.property, MT.channel, MT.custName, MT.groupName];
  const records = await atGet(MASTER_TBL, tripFormula, fields);
  if (!records.length) return [];

  const byMid = {};
  for (let i = 0; i < records.length; i += 40) {
    const chunk = records.slice(i, i + 40);
    const comps = await atGet(COMP_TBL, `OR(${chunk.map(r => `{Master Trip Record ID}='${r.id}'`).join(',')})`);
    comps.forEach(r => {
      const mid = r.fields[CT.masterRecId];
      if (!mid) return;
      const existing = byMid[mid];
      const hasData = r.fields[CT.property] || r.fields[CT.custName];
      if (!existing || (hasData && !(existing.fields[CT.property] || existing.fields[CT.custName]))) {
        byMid[mid] = { id: r.id, fields: r.fields };
      }
    });
  }

  const pending = [];
  records.forEach(r => {
    const comp = byMid[r.id];
    if (!comp) return;
    if (comp.fields[CT.custNoResp]) return;
    const f = r.fields;
    const rules = applyRules(f[MT.property], f[MT.channel]);
    const incomplete = getIncompleteCheckout(comp.fields, rules.needsElectric, rules.needsWater);
    if (!incomplete.length) return;
    pending.push({
      property: f[MT.property] || '',
      custName: extractName(f[MT.custName]),
      channel: f[MT.channel] || '',
      checkoutDate: f[MT.checkoutDate] || '',
      incomplete,
      note: comp.fields[CT.notes] || '',
    });
  });
  pending.sort((a, b) => (a.checkoutDate || '').localeCompare(b.checkoutDate || ''));
  return pending;
}

// Calendar date `daysBack` days before today in Bangkok, plus one day so an
// exclusive IS_AFTER / string compare still includes that boundary date.
// Same offset the old 10-day overdue query used.
function daysAgoIso(daysBack) {
  return new Date(Date.now() - (daysBack + 1) * 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: TZ });
}

function depositStillOpen(cf) {
  return !cf[CT.deposit] && !cf[CT.depositWaived];
}

// ================================================================
//  PAST ARRIVALS WITH INCOMPLETE CHECK-IN TASKS
//  Phuket, Inquiry status Checked-In or Paid and confirmed, arrival
//  before today and after the lookback. Customer-no-response stays excluded.
//  Completions are loaded by master record id (not a year-wide scan).
// ================================================================
async function getPastPendingCheckins(daysBack) {
  const today = todayBangkok();
  const cutoff = daysAgoIso(daysBack);

  const tripFormula = `AND(IS_AFTER({Arrival Date}, DATETIME_PARSE('${cutoff}')), IS_BEFORE({Arrival Date}, DATETIME_PARSE('${today}')), FIND('Phuket', {City}), OR({Inquiry status} = 'Paid and confirmed', {Inquiry status} = 'Checked-In'))`;
  const fields = [MT.tripId, MT.arrivalDate, MT.property, MT.channel, MT.custName, MT.groupName];
  const records = await atGet(MASTER_TBL, tripFormula, fields);
  if (!records.length) return [];

  const byMid = {};
  for (let i = 0; i < records.length; i += 40) {
    const chunk = records.slice(i, i + 40);
    const comps = await atGet(COMP_TBL, `OR(${chunk.map(r => `{Master Trip Record ID}='${r.id}'`).join(',')})`);
    comps.forEach(r => {
      const mid = r.fields[CT.masterRecId];
      if (!mid) return;
      const existing = byMid[mid];
      const hasData = r.fields[CT.property] || r.fields[CT.custName];
      if (!existing || (hasData && !(existing.fields[CT.property] || existing.fields[CT.custName]))) {
        byMid[mid] = { id: r.id, fields: r.fields };
      }
    });
  }

  const pending = [];
  records.forEach(r => {
    const comp = byMid[r.id];
    if (!comp) return;
    if (comp.fields[CT.custNoResp]) return;
    const f = r.fields;
    const rules = applyRules(f[MT.property], f[MT.channel]);
    const incomplete = getIncomplete(comp.fields, rules.needsElectric, rules.needsWater);
    if (!incomplete.length) return;
    pending.push({
      property: f[MT.property] || '',
      custName: extractName(f[MT.custName]),
      channel: f[MT.channel] || '',
      arrivalDate: f[MT.arrivalDate] || '',
      groupName: f[MT.groupName] || '',
      incomplete,
      note: comp.fields[CT.notes] || '',
      depositOpen: depositStillOpen(comp.fields),
    });
  });
  pending.sort((a, b) => (a.arrivalDate || '').localeCompare(b.arrivalDate || ''));
  return pending;
}

// Deposit still open → carried over, with no 10-day cap (the lookback
// already bounded the query). Deposit collected or waived → the old
// 10-day overdue list, and only for whatever else is still incomplete.
function partitionPastCheckins(past) {
  const overdueCutoff = daysAgoIso(OVERDUE_DAYS);
  const carried = [];
  const overdueOther = [];
  past.forEach(t => {
    if (t.depositOpen) carried.push({ ...t, carriedOver: true });
    else if ((t.arrivalDate || '') > overdueCutoff) overdueOther.push(t);
  });
  return { carried, overdueOther };
}

// ================================================================
//  FETCH TODAY'S COMPLETION RECORDS
// ================================================================
async function getTodayCompletions() {
  const today = todayBangkok();
  const formula = `IS_SAME({Arrival Date}, DATETIME_PARSE('${today}'), 'day')`;
  const records = await atGet(COMP_TBL, formula);
  const byMid = {};
  records.forEach(r => {
    const mid = r.fields[CT.masterRecId];
    if (mid) byMid[mid] = { id: r.id, fields: r.fields };
  });
  return byMid;
}

// Create a completion record if one doesn't exist yet
async function ensureCompletion(trip, existingByMid) {
  if (existingByMid[trip.masterRecId]) return existingByMid[trip.masterRecId];
  const rec = await atPost(COMP_TBL, {
    [CT.tripId]: trip.tripId,
    [CT.masterRecId]: trip.masterRecId,
    [CT.property]: trip.property,
    [CT.custName]: trip.custName,
    [CT.channel]: trip.channel,
    [CT.arrivalDate]: trip.arrivalDate,
    [CT.needsElectric]: trip.needsElectric,
    [CT.needsWater]: trip.needsWater,
    [CT.groupName]: trip.groupName,
    [CT.deposit]: false,
    [CT.passport]: false,
    [CT.electric]: false,
    [CT.water]: false,
    [CT.depositWaived]: false,
    [CT.electricNA]: false,
    [CT.waterNA]: false,
  });
  if (rec) existingByMid[trip.masterRecId] = { id: rec.id, fields: rec.fields };
  return existingByMid[trip.masterRecId] || null;
}

// ================================================================
//  GET INCOMPLETE TASKS FOR A TRIP — needsElectric/needsWater passed in
//  fresh (from applyRules on the trip's CURRENT property+channel), never
//  read off a possibly-stale snapshot on the completion record.
// ================================================================
function getIncomplete(cf, needsElectric, needsWater) {
  const list = [];
  if (!cf[CT.deposit] && !cf[CT.depositWaived]) list.push('💵 Deposit');
  if (!cf[CT.passport]) list.push('🛂 Passport');
  if (needsElectric && !cf[CT.electric] && !cf[CT.electricNA]) list.push('⚡ Electric Meter');
  if (needsWater && !cf[CT.water] && !cf[CT.waterNA]) list.push('💧 Water Meter');
  return list;
}

// ================================================================
//  MESSAGE COMPOSERS — pure, so a dry run can print them without
//  calling Telegram.
// ================================================================
function renderCarriedSection(carried) {
  if (!carried.length) return '';
  let msg = `🔁 <b>Carried over — arrived earlier, deposit still open:</b>\n\n`;
  carried.forEach(t => {
    msg += `🏠 <b>${t.property}</b>  |  👤 ${t.custName}  |  📅 Arrived: ${fmtShortDate(t.arrivalDate)}  |  🔁 <b>CARRIED OVER</b>\n`;
    msg += `Still pending: ${t.incomplete.join('  ·  ')}\n`;
    if (t.note) msg += `💬 Note: <i>${t.note}</i>\n`;
    msg += `\n`;
  });
  return msg;
}

function renderMorningBriefing({ date, trips, carried, pendingOuts }) {
  let msg = `🌅 <b>Good morning! Check-in Briefing — ${date}</b>\n\n`;

  if (!trips.length) {
    msg += carried.length
      ? '🌴 No new check-ins today.'
      : '🌴 No check-ins today. Have a great day!';
  } else {
    msg += `📋 <b>${trips.length} check-in(s) today:</b>\n`;
    trips.forEach(t => {
      const tasks = ['☐ 💵 Deposit', '☐ 🛂 Passport'];
      if (t.needsElectric) tasks.push('☐ ⚡ Electric Meter');
      if (t.needsWater) tasks.push('☐ 💧 Water Meter');
      msg += `\n🏠 <b>${t.property}</b>  |  👤 ${t.custName}\n`;
      msg += `📦 ${t.channel}  |  📌 Group: ${t.groupName}\n`;
      msg += tasks.join('\n') + '\n';
    });
    msg += `\n📊 Tick off each task in the dashboard as you complete it.`;
  }

  if (carried.length) {
    msg += `\n\n${renderCarriedSection(carried).trimEnd()}`;
    msg += `\n\nThese guests stay on the board until the deposit is collected or waived.`;
  }

  if (pendingOuts.length) {
    msg += `\n\n🧳 <b>Pending check-out tasks (last 10 days):</b>\n`;
    pendingOuts.forEach(t => {
      msg += `\n🏠 <b>${t.property}</b>  |  👤 ${t.custName}  |  🧳 Checked out: ${fmtShortDate(t.checkoutDate)}\n`;
      msg += `Pending: ${t.incomplete.join('  ·  ')}\n`;
      if (t.note) msg += `💬 Note: <i>${t.note}</i>\n`;
    });
    msg += `\n👆 Use the 🗂️ Previous Trips button in the dashboard to resolve these.`;
  }

  return msg;
}

function renderReminder({ time, date, pendingTrips, carried, overdueTrips, pendingOuts }) {
  let msg = `⏰ <b>Reminder (${time}) — Pending Check-in Tasks</b>\n${date}\n\n`;
  if (pendingTrips.length) {
    msg += `📅 <b>Today's check-ins:</b>\n\n`;
    pendingTrips.forEach(t => {
      msg += `🏠 <b>${t.property}</b>  |  👤 ${t.custName}\n`;
      msg += `Pending: ${t.incomplete.join('  ·  ')}\n`;
      if (t.note) msg += `💬 Note: <i>${t.note}</i>\n`;
      msg += `\n`;
    });
  }
  if (carried.length) msg += renderCarriedSection(carried);
  if (overdueTrips.length) {
    msg += `⏳ <b>Overdue — check-ins from the last 10 days:</b>\n\n`;
    overdueTrips.forEach(t => {
      msg += `🏠 <b>${t.property}</b>  |  👤 ${t.custName}  |  📅 Checked in: ${fmtShortDate(t.arrivalDate)}\n`;
      msg += `Still pending: ${t.incomplete.join('  ·  ')}\n`;
      if (t.note) msg += `💬 Note: <i>${t.note}</i>\n`;
      msg += `\n`;
    });
  }
  if (pendingOuts.length) {
    msg += `🧳 <b>Check-outs — pending tasks (last 10 days):</b>\n\n`;
    pendingOuts.forEach(t => {
      msg += `🏠 <b>${t.property}</b>  |  👤 ${t.custName}  |  🧳 Checked out: ${fmtShortDate(t.checkoutDate)}\n`;
      msg += `Still pending: ${t.incomplete.join('  ·  ')}\n`;
      if (t.note) msg += `💬 Note: <i>${t.note}</i>\n`;
      msg += `\n`;
    });
  }
  msg += `👆 Please complete these now and tick them off in the dashboard (use the 🗂️ Previous Trips button for carried-over and overdue items).`;
  return msg;
}

function renderEscalationDpew({ time, date, pendingTrips, carried }) {
  let msg = `🚨 <b>ESCALATION (${time}) — Tasks Still Incomplete!</b>\n${date}\n\n`;
  pendingTrips.forEach(t => {
    msg += `🏠 <b>${t.property}</b>  |  👤 ${t.custName}\n`;
    msg += `Missing: ${t.incomplete.join('  ·  ')}\n`;
    if (t.note) msg += `💬 Note: <i>${t.note}</i>\n`;
    msg += `\n`;
  });
  if (carried.length) msg += renderCarriedSection(carried);
  msg += `⚠️ Hari Ananth has been notified. Please act immediately.`;
  return msg;
}

function renderEscalationHari({ time, date, pendingTrips, carried }) {
  let msg = `🚨 <b>Escalation Alert — Incomplete Check-in Tasks</b>\n`;
  msg += `${time}  ·  ${date}\n\n`;
  msg += `Hi Hari, the following check-in items are still not completed:\n\n`;
  pendingTrips.forEach(t => {
    msg += `🏠 <b>${t.property}</b>  |  👤 ${t.custName}  |  ${t.channel}\n`;
    msg += `Missing: ${t.incomplete.join('  ·  ')}\n`;
    msg += t.note ? `💬 Reason from team: <i>${t.note}</i>\n\n` : `💬 <i>No reason provided by team</i>\n\n`;
  });
  if (carried.length) msg += renderCarriedSection(carried);
  msg += `Please follow up with the reservations team immediately.`;
  return msg;
}

async function loadBoardContext() {
  const trips = await getTodayTrips();
  const completions = await getTodayCompletions();
  const pendingTrips = [];
  trips.forEach(t => {
    const comp = completions[t.masterRecId];
    if (!comp) return;
    if (comp.fields[CT.custNoResp]) return;
    const incomplete = getIncomplete(comp.fields, t.needsElectric, t.needsWater);
    const note = comp.fields[CT.notes] || '';
    if (incomplete.length) pendingTrips.push({ ...t, incomplete, note });
  });

  const past = await getPastPendingCheckins(CARRYOVER_LOOKBACK_DAYS);
  const { carried, overdueOther } = partitionPastCheckins(past);
  const pendingOuts = await getPendingCheckouts(OVERDUE_DAYS);
  return { trips, completions, pendingTrips, carried, overdueOther, pendingOuts };
}

// Read-only. Does not create completion rows and does not send Telegram.
async function previewBoards() {
  const { trips, pendingTrips, carried, overdueOther, pendingOuts } = await loadBoardContext();
  const date = displayDate();
  const time = displayTime();
  return {
    morning: renderMorningBriefing({ date, trips, carried, pendingOuts }),
    reminder: renderReminder({ time, date, pendingTrips, carried, overdueTrips: overdueOther, pendingOuts }),
    escalationDpew: renderEscalationDpew({ time, date, pendingTrips, carried }),
    escalationHari: renderEscalationHari({ time, date, pendingTrips, carried }),
    counts: {
      today: trips.length,
      pendingToday: pendingTrips.length,
      carried: carried.length,
      overdueOther: overdueOther.length,
      checkouts: pendingOuts.length,
    },
    carried: carried.map(t => ({
      property: t.property,
      custName: t.custName,
      arrivalDate: t.arrivalDate,
      incomplete: t.incomplete,
    })),
  };
}

// ================================================================
//  1. MORNING BRIEFING — always sends
// ================================================================
async function sendMorningBriefing() {
  const trips = await getTodayTrips();
  const completions = await getTodayCompletions();
  await Promise.all(trips.map(t => ensureCompletion(t, completions)));

  const past = await getPastPendingCheckins(CARRYOVER_LOOKBACK_DAYS);
  const { carried } = partitionPastCheckins(past);
  const pendingOuts = await getPendingCheckouts(OVERDUE_DAYS);
  const msg = renderMorningBriefing({ date: displayDate(), trips, carried, pendingOuts });
  return tgSend(DPEW_CHAT, msg);
}

// ================================================================
//  2/3. REMINDER (plain) and ESCALATION (DPEW + Hari) — shared logic,
//  sends nothing if everything's already done.
// ================================================================
async function runCheck(isEscalation) {
  const { pendingTrips, carried, overdueOther, pendingOuts } = await loadBoardContext();
  const overdueTrips = isEscalation ? [] : overdueOther;
  const checkouts = isEscalation ? [] : pendingOuts;

  if (!pendingTrips.length && !carried.length && !overdueTrips.length && !checkouts.length) {
    return { sent: false, reason: 'all done' };
  }

  const time = displayTime();
  const date = displayDate();

  if (!isEscalation) {
    const msg = renderReminder({ time, date, pendingTrips, carried, overdueTrips, pendingOuts: checkouts });
    const sent = await tgSend(DPEW_CHAT, msg);
    return { sent };
  }

  const sentDpew = await tgSend(DPEW_CHAT, renderEscalationDpew({ time, date, pendingTrips, carried }));
  const sentHari = await tgSend(HARI_CHAT, renderEscalationHari({ time, date, pendingTrips, carried }));
  return { sent: sentDpew && sentHari };
}

module.exports = {
  DPEW_CHAT, HARI_CHAT, MASTER_TBL, COMP_TBL, MT, CT,
  OVERDUE_DAYS, CARRYOVER_LOOKBACK_DAYS,
  atGet, atPost, atPatchRecord, tgSend,
  depositStillOpen, partitionPastCheckins, daysAgoIso,
  renderMorningBriefing, renderReminder, renderEscalationDpew, renderEscalationHari,
  previewBoards,
  sendMorningBriefing, runCheck,
};
