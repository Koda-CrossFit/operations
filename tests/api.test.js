'use strict';

// The backend against dev/gas-mock.js: acceptance checks 2 through 9 in SPEC section 12, and
// the handlers in section 8. Run: node --test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createGas, fakeManagers } = require('../dev/gas-mock.js');
const { resetWorld, createHandler } = require('../dev/server.js');
const { MON_SAT, hoursEach, workedExampleAvailability } = require('../dev/fixtures.js');

const CODE = '000000';

// All of November 2026 is on standard time (the clocks went back on Nov 1), so -07:00 is right everywhere below.
const at = (date, time) => `${date}T${time}:00-07:00`;

const LAST_FRI = '2026-11-06';
const MON = '2026-11-09';
const TUE = '2026-11-10';
const WED = '2026-11-11';
const THU = '2026-11-12';
const FRI = '2026-11-13';
const SAT = '2026-11-14';
const SUN = '2026-11-15';
const NEXT_MON = '2026-11-16';

const BEFORE_DEADLINE = at('2026-11-05', '10:00');
const DEADLINE = at(LAST_FRI, '07:00');

/* ---------------------------------------------------------------------- helpers ---- */

function ok(reply) {
  assert.strictEqual(reply.ok, true, `Expected ok, got: ${reply.error}`);
  return reply;
}

function refused(reply, pattern) {
  assert.strictEqual(reply.ok, false, 'Expected a refusal');
  assert.match(reply.error, pattern);
  assert.ok(!/\bat\s+\S+\s*\(|\.js:\d+/.test(reply.error), `That looks like a stack trace: ${reply.error}`);
}

function world(extra) {
  const gas = createGas();
  gas.setNow(BEFORE_DEADLINE);
  ok(gas.post({ action: 'adminSetup', code: CODE, sourceSheetId: gas.addFakeSource(), sheetId: gas.createBook(), managers: fakeManagers(), testEmail: 'test@example.com', replyTo: 'reply@example.com', ...extra }));
  return gas;
}

function save(gas, name, weekOf, hoursWanted, dayHours, extra) {
  return gas.post({ action: 'saveAvailability', name, weekOf, hoursWanted, dayHours, ...extra });
}

/** The minutes on this person's list that day. */
function dayMinutes(gas, name, date) {
  return gas.rows('Schedule').filter((row) => row.Name === name && row.Date === date).reduce((sum, row) => sum + row.Minutes, 0);
}

/** Everyone in the worked example saves on time, or only the names given. */
function submit(gas, names, weekOf) {
  const all = workedExampleAvailability();
  (names || Object.keys(all)).forEach((name) => ok(save(gas, name, weekOf || MON, all[name].hoursWanted, all[name].dayHours)));
}

/** The real Friday 7 AM tick. */
function friday(gas) {
  gas.setNow(DEADLINE);
  return gas.tick();
}

function built(names) {
  const gas = world();
  submit(gas, names);
  const result = friday(gas);
  assert.deepStrictEqual(result.failed, []);
  gas.state.mail.length = 0;
  return gas;
}

function scheduleRows(gas) {
  return gas.rows('Schedule');
}

function rowById(gas, id) {
  const found = scheduleRows(gas).filter((row) => row.ID === id);
  assert.strictEqual(found.length, 1, `Expected exactly one row with ID ${id}, found ${found.length}`);
  return found[0];
}

/** {Ana:{Mon:125}} from the Schedule tab, without set rows. */
function minutesByPersonDay(gas) {
  const out = {};
  scheduleRows(gas).forEach((row) => {
    if (!row.Name || row.Source === 'set') return;
    out[row.Name] = out[row.Name] || {};
    out[row.Name][row.Day] = (out[row.Name][row.Day] || 0) + row.Minutes;
  });
  return out;
}

function snapshotRows(gas, keep) {
  return scheduleRows(gas)
    .filter(keep)
    .map((row) => [row.ID, row.Name, row.Date, row.Source, row.Status].join(' / '))
    .sort();
}

function subjects(gas) {
  return gas.state.mail.map((mail) => mail.subject);
}

function setSetting(gas, key, value) {
  const row = gas.rows('Settings').find((line) => line.Key === key);
  assert.ok(row, `No setting named ${key}`);
  gas.sheet('Settings').getRange(row._row, 2).setValue(value);
}

function deepKeys(value, expected, label) {
  assert.deepStrictEqual(Object.keys(value).sort(), expected.slice().sort(), `Wrong keys on ${label}`);
}

/* ------------------------------------------------------- worked example end to end ---- */

test('the worked example comes out right through the whole stack', () => {
  const gas = built();
  assert.deepStrictEqual(minutesByPersonDay(gas), { Ana: { Mon: 125, Wed: 85, Fri: 130 }, Ben: { Tue: 100, Thu: 85 }, Cora: { Sat: 55 } });
  assert.deepStrictEqual(scheduleRows(gas).filter((row) => !row.Name), [], 'nothing uncovered');
});

test('date-string columns stay plain text in the sheet, and Hours.In is a real date', () => {
  const gas = built();
  const row = scheduleRows(gas)[0];
  assert.strictEqual(typeof row.Date, 'string');
  assert.strictEqual(typeof row['Week Of'], 'string');
  assert.strictEqual(typeof gas.rows('Availability')[0]['Week Of'], 'string');
  assert.strictEqual(typeof gas.rows('Closed Days')[0].Date, 'string');

  gas.setNow(at(MON, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  const entry = gas.rows('Hours')[0];
  assert.strictEqual(Object.prototype.toString.call(entry.Date), '[object Date]');
  assert.strictEqual(Object.prototype.toString.call(entry.In), '[object Date]');
});

test('dates Sheets turned into real dates anyway still read correctly', () => {
  const gas = built();
  const headers = gas.rows('Schedule')[0];
  const sheet = gas.sheet('Schedule');
  const dateColumn = Object.keys(headers).indexOf('Date'); // _row comes first, so this is already the 1-based column
  const target = scheduleRows(gas).find((row) => row.ID === `task|T01|${TUE}`);
  sheet.getRange(target._row, dateColumn).setNumberFormat('General').setValue(new Date(2026, 10, 10));
  assert.strictEqual(Object.prototype.toString.call(sheet.getRange(target._row, dateColumn).getValue()), '[object Date]');
  gas.setNow(at(TUE, '09:00'));
  const tasks = gas.get({ action: 'boot', name: 'Ben' }).today.tasks;
  assert.ok(tasks.some((task) => task.id === `task|T01|${TUE}` && task.date === TUE));
});

test('the sheet reads by header name, so moving columns around breaks nothing', () => {
  const gas = built();
  const sheet = gas.sheet('Staff');
  const values = sheet.getDataRange().getValues();
  const reordered = values.map((line) => line.slice().reverse());
  sheet.getRange(1, 1, reordered.length, reordered[0].length).setValues(reordered);
  assert.deepStrictEqual(gas.get({ action: 'names' }).people[0], { name: 'Gus', type: 'Set' });
  gas.setNow(at(MON, '09:00'));
  assert.strictEqual(ok(gas.get({ action: 'boot', name: 'Ana' })).me.type, 'Flexible');
});

/* ----------------------------------------------------- check 2: on time and late ---- */

test('check 2: saved Thursday is on time, saved Friday 7:01 AM is late', () => {
  const gas = world();
  assert.strictEqual(ok(save(gas, 'Ana', MON, 6, hoursEach(['Mon'], 3))).late, false);
  assert.strictEqual(gas.rows('Availability')[0].Late, false);

  gas.setNow(at(LAST_FRI, '06:59'));
  assert.strictEqual(ok(save(gas, 'Ben', MON, 4, hoursEach(['Tue'], 3))).late, false, 'a minute before is still on time');

  gas.setNow(at(LAST_FRI, '07:01'));
  assert.strictEqual(ok(save(gas, 'Cora', MON, 6, hoursEach(['Sat'], 8))).late, true);
  assert.strictEqual(gas.rows('Availability').find((row) => row.Name === 'Cora').Late, true);
});

test('check 2: a late save after the build leaves all the work that went to on-time people alone', () => {
  const gas = built(['Ana', 'Cora']); // Cora took everything Ana couldn't, so Ben is too late to get any of it
  const namedBefore = snapshotRows(gas, (row) => row.Name);
  assert.deepStrictEqual(scheduleRows(gas).filter((row) => !row.Name), [], 'and nothing is left over');

  gas.setNow(at(LAST_FRI, '07:01'));
  const reply = ok(save(gas, 'Ben', MON, 4, hoursEach(['Tue', 'Thu'], 3))); // better ranked than Cora, and free those days
  assert.strictEqual(reply.late, true);
  assert.deepStrictEqual(reply.picked, [], 'he only gets leftovers, and there are none');
  assert.deepStrictEqual(snapshotRows(gas, (row) => row.Name), namedBefore, "nobody's rows changed");
  assert.strictEqual(subjects(gas).filter((subject) => /came in late/.test(subject)).length, 1, 'managers still hear about it');
});

test('check 2: a late saver really does pick up what nobody else could do', () => {
  const gas = built(['Ana']); // Tuesday, Thursday and Saturday work sits uncovered
  const before = scheduleRows(gas).filter((row) => row.Name === 'Ana');
  assert.ok(scheduleRows(gas).some((row) => !row.Name && row.Date === TUE));

  gas.setNow(at(LAST_FRI, '09:00'));
  const reply = ok(save(gas, 'Ben', MON, 4, hoursEach(['Tue', 'Thu'], 3)));
  assert.strictEqual(reply.late, true);
  assert.ok(reply.picked.includes('Unbox packages'));

  const bens = scheduleRows(gas).filter((row) => row.Name === 'Ben');
  assert.ok(bens.length > 0);
  bens.forEach((row) => assert.strictEqual(row.Source, 'late', `${row.ID} should be marked late`));
  assert.deepStrictEqual(
    scheduleRows(gas).filter((row) => row.Name === 'Ana').map((row) => [row.ID, row.Date]),
    before.map((row) => [row.ID, row.Date]),
    "Ana's list is untouched"
  );
  assert.ok(scheduleRows(gas).some((row) => row.Name === 'Ben' && row.Date === TUE), 'Ben has work now');
  assert.ok(subjects(gas).some((subject) => subject === "[TEST to Managers] Ben's availability came in late: week of Nov 9"));
  const alert = gas.state.mail.find((mail) => /came in late/.test(mail.subject));
  assert.match(alert.htmlBody, /Unbox packages/);
});

test('check 2: a late save before the tick has run still sits out the main pass', () => {
  const gas = world();
  ok(save(gas, 'Ben', MON, 4, hoursEach(['Mon'], 3))); // on time, rank 6
  gas.setNow(at(LAST_FRI, '07:01'));
  assert.strictEqual(ok(save(gas, 'Ana', MON, 8, hoursEach(['Mon', 'Tue'], 3))).late, true); // late, rank 5
  gas.setNow(at(LAST_FRI, '07:05'));
  assert.deepStrictEqual(gas.tick().failed, []);

  const mondayFlexRows = scheduleRows(gas).filter((row) => row.Date === MON && row.Source !== 'set');
  assert.ok(mondayFlexRows.length > 0);
  mondayFlexRows.forEach((row) => assert.strictEqual(row.Name, 'Ben', `${row.ID} belongs to the on-time person`));
  const anas = scheduleRows(gas).filter((row) => row.Name === 'Ana');
  assert.ok(anas.length > 0, 'she gets what was left');
  anas.forEach((row) => {
    assert.strictEqual(row.Source, 'late');
    assert.strictEqual(row.Date, TUE);
  });
  assert.ok(!subjects(gas).some((subject) => /Ana\].*availability for the week/.test(subject)), 'she has a row, so no missed-deadline email');
});

test('check 2: a late change releases only their future rows on days they took away', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const manualId = `task|T01|${WED}`;
  ok(gas.post({ action: 'mgrAssign', code: CODE, id: manualId, name: 'Ana', date: WED }));
  const others = (row) => row.Name && row.Name !== 'Ana';
  const othersBefore = snapshotRows(gas, others);
  const fridayBefore = snapshotRows(gas, (row) => row.Name === 'Ana' && row.Date === FRI);

  const reply = ok(save(gas, 'Ana', MON, 6, hoursEach(['Mon', 'Fri'], 3)));
  assert.strictEqual(reply.late, false, 'she was on time and only took hours away');

  assert.deepStrictEqual(snapshotRows(gas, others), othersBefore, "nobody else's work moved");
  assert.deepStrictEqual(snapshotRows(gas, (row) => row.Name === 'Ana' && row.Date === FRI), fridayBefore, 'days she kept are the same');
  const wednesday = scheduleRows(gas).filter((row) => row.Date === WED && row.Source !== 'set');
  wednesday.forEach((row) => {
    if (row.ID === manualId) assert.strictEqual(row.Name, 'Ana', 'manual rows stay');
    else assert.strictEqual(row.Name, '', `${row.ID} goes back to uncovered`);
  });
  const alert = gas.state.mail.find((mail) => /availability changed/.test(mail.subject));
  assert.match(alert.htmlBody, /now uncovered/);
  assert.ok(!subjects(gas).some((subject) => /came in late/.test(subject)));
});

test('check 2: "can\'t work" after the deadline releases everything still ahead', () => {
  const gas = built();
  gas.setNow(at(WED, '06:00'));
  const reply = ok(gas.post({ action: 'saveAvailability', name: 'Ana', weekOf: MON, none: true }));
  assert.strictEqual(reply.late, false, 'she was on time, and this offers nothing new');
  assert.deepStrictEqual(reply.picked, []);
  assert.ok(scheduleRows(gas).some((row) => row.Name === 'Ana' && row.Date === MON), 'Monday has gone by, so it stays');
  assert.ok(!scheduleRows(gas).some((row) => row.Name === 'Ana' && row.Date >= WED), 'nothing from today on');
  assert.ok(!scheduleRows(gas).some((row) => row.Name === 'Ana' && row.Date >= WED));
});

test('saveAvailability: only Flexible people, known days and hours, a real week', () => {
  const gas = world();
  refused(save(gas, 'Gus', MON, 4, hoursEach(['Mon'], 1)), /automatically/);
  refused(save(gas, 'Max', MON, 4, hoursEach(['Mon'], 1)), /automatically/);
  refused(save(gas, 'Ana', TUE, 4, hoursEach(['Mon'], 1)), /start on a Monday/);
  refused(save(gas, 'Ana', 'next week', 4, hoursEach(['Mon'], 1)), /pick a week/);
  refused(save(gas, 'Ana', '2026-10-26', 4, hoursEach(['Mon'], 1)), /already passed/);
  refused(save(gas, 'Ana', MON, 4, { Funday: 3 }), /days/);
  refused(save(gas, 'Ana', MON, 4, { Mon: -0.5 }), /between 0 and 16/);
  refused(save(gas, 'Ana', MON, 4, { Mon: 16.5 }), /between 0 and 16/);
  refused(save(gas, 'Ana', MON, 4, { Mon: 'nine' }), /between 0 and 16/);
  refused(save(gas, 'Ana', MON, 4, { Mon: 2.25 }), /half-hour/);
  refused(save(gas, 'Ana', MON, 4, { Mon: [3] }), /read those hours/);
  refused(save(gas, 'Ana', MON, 4, { Mon: null }), /read those hours/);
  refused(save(gas, 'Ana', MON, 4, { Mon: true }), /read those hours/);
  refused(save(gas, 'Ana', MON, 4, { Mon: ' ' }), /read those hours/);
  refused(save(gas, 'Ana', MON, 4, ['Mon']), /read those hours/);
  refused(save(gas, 'Ana', MON, 4, 'Mon:3'), /read those hours/);
  refused(save(gas, 'Ana', MON, 41, hoursEach(['Mon'], 1)), /between 0 and 40/);
  refused(save(gas, 'Ana', MON, -1, hoursEach(['Mon'], 1)), /between 0 and 40/);
  refused(save(gas, 'Ana', MON, 'lots', hoursEach(['Mon'], 1)), /between 0 and 40/);
  refused(save(gas, 'Ana', MON, 0, hoursEach(['Mon'], 1)), /how many hours/);
  refused(save(gas, 'Ana', MON, undefined, hoursEach(['Mon'], 1)), /how many hours/);
  refused(save(gas, 'Ana', MON, 4, {}), /at least one day/);
  refused(save(gas, 'Ana', MON, 4, undefined), /at least one day/);
  refused(save(gas, 'Ana', MON, 4, { Mon: 0, Tue: 0 }), /at least one day/);
  assert.deepStrictEqual(gas.rows('Availability'), [], 'nothing bad was saved');
});

test('saveAvailability: the top of the range, half hours, text numbers and zero days', () => {
  const gas = world();
  ok(save(gas, 'Ana', MON, 40, { Mon: 16, Tue: 0.5, Wed: '2.5', Thu: 0, Fri: '0' }));
  const row = gas.rows('Availability')[0];
  assert.strictEqual(row.Slots, 'Mon:16;Tue:0.5;Wed:2.5', 'zero days are dropped, and days stay in week order');
  assert.strictEqual(row.Readable, 'Mon 16 hrs; Tue 0.5 hrs; Wed 2.5 hrs');
  assert.deepStrictEqual(ok(gas.get({ action: 'availability', name: 'Ana', weekOf: MON })).dayHours, { Mon: 16, Tue: 0.5, Wed: 2.5 });
});

test('saveAvailability: a row in the old hour-by-hour shape reads as no hours, and nothing breaks', () => {
  const gas = world();
  gas.sheet('Availability').appendRow([MON, 'Ana', new Date(), false, false, 6, 'Mon:9,10,11;Wed:16,17', 'Mon 9 AM-12 PM', '']);
  assert.deepStrictEqual(ok(gas.get({ action: 'availability', name: 'Ana', weekOf: MON })).dayHours, {});
  ok(save(gas, 'Ana', MON, 6, { Mon: 3 }));
  assert.strictEqual(gas.rows('Availability')[0].Slots, 'Mon:3');
});

test('saveAvailability: one row per person per week, with Slots and Readable in the spec format', () => {
  const gas = world();
  ok(save(gas, 'Ana', MON, 6.5, { Wed: 2, Mon: 3 }, { notes: 'Back door please' }));
  const row = gas.rows('Availability')[0];
  assert.strictEqual(row.Slots, 'Mon:3;Wed:2');
  assert.strictEqual(row.Readable, 'Mon 3 hrs; Wed 2 hrs');
  assert.strictEqual(row['Hours Wanted'], 6.5);
  assert.strictEqual(row.Notes, 'Back door please');

  ok(save(gas, 'Ana', MON, 4, { Tue: 1 }));
  assert.strictEqual(gas.rows('Availability').length, 1, 'saving again updates the row');
  assert.strictEqual(gas.rows('Availability')[0].Readable, 'Tue 1 hr');

  ok(gas.post({ action: 'saveAvailability', name: 'Ana', weekOf: MON, none: true }));
  const none = gas.rows('Availability')[0];
  assert.strictEqual(none.None, true);
  assert.strictEqual(none.Slots, '');
  assert.strictEqual(none['Hours Wanted'], 0);
  ok(save(gas, 'Ana', NEXT_MON, 4, { Tue: 1 }));
  assert.strictEqual(gas.rows('Availability').length, 2, 'another week is another row');
});

test('availability: the response has the documented fields, and last is for Copy Last Week', () => {
  const gas = world();
  ok(save(gas, 'Ana', MON, 6, hoursEach(['Mon'], 2), { notes: 'Note' }));
  ok(gas.post({ action: 'timeOffAdd', name: 'Ana', from: NEXT_MON, to: NEXT_MON }));
  ok(gas.post({ action: 'saveAvailability', name: 'Ana', weekOf: '2026-11-23', none: true }));

  const first = ok(gas.get({ action: 'availability', name: 'Ana', weekOf: MON }));
  deepKeys(first, ['ok', 'weekOf', 'days', 'dayHours', 'hoursWanted', 'none', 'notes', 'submittedAt', 'late', 'deadline', 'past', 'last'], 'availability');
  assert.deepStrictEqual(first.days[0], { key: 'Mon', date: MON, label: '9', off: false, closed: '' });
  assert.strictEqual(first.days.length, 7);
  assert.deepStrictEqual(first.dayHours, { Mon: 2 });
  assert.strictEqual(first.hoursWanted, 6);
  assert.strictEqual(first.notes, 'Note');
  assert.strictEqual(first.submittedAt, 'Thu, Nov 5 at 10:00 AM');
  assert.strictEqual(first.deadline, 'Fri, Nov 6 at 7:00 AM');
  assert.strictEqual(first.past, false);
  assert.strictEqual(first.last, null);

  const blank = ok(gas.get({ action: 'availability', name: 'Ana', weekOf: NEXT_MON }));
  assert.deepStrictEqual(blank.dayHours, {});
  assert.strictEqual(blank.hoursWanted, null);
  assert.strictEqual(blank.submittedAt, '');
  assert.strictEqual(blank.days[0].off, true, 'out of town that Monday');
  assert.deepStrictEqual(blank.last, { weekOf: MON, dayHours: { Mon: 2 }, hoursWanted: 6 });

  const thanksgiving = ok(gas.get({ action: 'availability', name: 'Ana', weekOf: '2026-11-30' }));
  assert.strictEqual(thanksgiving.last.weekOf, MON, "skips the week she said she can't work, since there's nothing in it to copy");

  gas.setNow(at(LAST_FRI, '07:00'));
  assert.strictEqual(ok(gas.get({ action: 'availability', name: 'Ana', weekOf: MON })).past, true);
  refused(gas.get({ action: 'availability', name: 'Ana', weekOf: TUE }), /start on a Monday/);
});

/* ---------------------------------------------- check 3: a Set person out of town ---- */

test('check 3: a Set person out Thursday goes to the best-ranked person free, the rest stay, and removing it restores them', () => {
  const gas = built();
  const setRow = `set|T08|${THU}|Gus`;
  gas.setNow(at(MON, '10:00'));
  const otherDays = snapshotRows(gas, (row) => row.Name === 'Gus' && row.Date !== THU);
  assert.strictEqual(otherDays.length, 2);
  const elsewhere = snapshotRows(gas, (row) => row.Name && row.Name !== 'Gus' && row.ID !== setRow);

  const added = ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: THU, note: 'Visiting family' }));
  assert.deepStrictEqual(added.affected, [{ date: THU, title: 'Deep bathroom clean: Main and West Office', coveredBy: 'Ben' }]);
  const covered = rowById(gas, setRow);
  assert.strictEqual(covered.Name, 'Ben');
  assert.strictEqual(covered.Source, 'cover');
  assert.strictEqual(covered.Date, THU);
  assert.deepStrictEqual(snapshotRows(gas, (row) => row.Name === 'Gus'), otherDays, 'his other days stay');
  assert.deepStrictEqual(snapshotRows(gas, (row) => row.Name && row.ID !== setRow && row.Name !== 'Gus'), elsewhere, 'nobody else moves');
  assert.strictEqual(dayMinutes(gas, 'Ben', THU), 145, 'his day grew');

  const alert = gas.state.mail.find((mail) => /is out of town/.test(mail.subject));
  assert.strictEqual(alert.subject, '[TEST to Managers] Gus is out of town Nov 12');
  assert.match(alert.htmlBody, /covered by Ben/);

  const removed = ok(gas.post({ action: 'timeOffRemove', name: 'Gus', id: added.id }));
  assert.deepStrictEqual(removed.restored, [{ date: THU, title: 'Deep bathroom clean: Main and West Office' }]);
  const back = rowById(gas, setRow);
  assert.deepStrictEqual([back.Name, back.Source, back.Date, back.Day], ['Gus', 'set', THU, 'Thu']);
  assert.strictEqual(dayMinutes(gas, 'Ben', THU), 85, 'his day went back');
  assert.strictEqual(gas.rows('Time Off')[0].Status, 'cancelled');

  ok(gas.post({ action: 'timeOffRemove', name: 'Gus', id: added.id })); // a repeat tap changes nothing
  assert.strictEqual(rowById(gas, setRow).Name, 'Gus');
});

test('check 3: with nobody free the row shows as uncovered, for that day only', () => {
  const gas = built([]);
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: THU }));
  assert.deepStrictEqual(added.affected, [{ date: THU, title: 'Deep bathroom clean: Main and West Office', coveredBy: '' }]);
  const row = rowById(gas, `set|T08|${THU}|Gus`);
  assert.deepStrictEqual([row.Name, row.Source], ['', 'cover']);
  assert.strictEqual(rowById(gas, `set|T08|${FRI}|Gus`).Name, 'Gus');
  assert.match(gas.state.mail.find((mail) => /out of town/.test(mail.subject)).htmlBody, /not covered/);

  const board = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: MON }));
  assert.ok(board.days.find((day) => day.date === THU).uncovered.some((task) => task.id === row.ID));

  gas.setNow(at(THU, '08:00'));
  const open = ok(gas.get({ action: 'boot', name: 'Cora' })).today.openTasks;
  assert.ok(open.some((task) => task.id === row.ID), 'it is offered to whoever is around');

  ok(gas.post({ action: 'timeOffRemove', name: 'Gus', id: added.id }));
  assert.deepStrictEqual([rowById(gas, row.ID).Name, rowById(gas, row.ID).Source], ['Gus', 'set']);
});

test('check 3: time off saved before the build is matched from the start, and a done row is not taken back', () => {
  const gas = world();
  submit(gas);
  const added = ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: FRI }));
  assert.deepStrictEqual(added.affected, [], 'nothing is published yet');
  assert.strictEqual(gas.state.mail.length, 0, 'so no alert either');
  friday(gas);
  const thu = rowById(gas, `set|T08|${THU}|Gus`);
  assert.deepStrictEqual([thu.Name, thu.Source], ['Ben', 'cover']);
  assert.strictEqual(rowById(gas, `set|T08|${SUN}|Gus`).Name, 'Gus');

  gas.setNow(at(THU, '10:30'));
  ok(gas.post({ action: 'taskToggle', name: 'Ben', id: thu.ID, done: true }));
  const removed = ok(gas.post({ action: 'timeOffRemove', name: 'Gus', id: added.id }));
  assert.strictEqual(rowById(gas, thu.ID).Name, 'Ben', 'Ben already did Thursday');
  assert.ok(removed.restored.some((item) => item.date === FRI), 'Friday is still ahead, so it goes back');
  assert.strictEqual(rowById(gas, `set|T08|${FRI}|Gus`).Name, 'Gus');
});

test('check 3: a flexible person out of town: their not-done rows are covered, and removal puts nothing back', () => {
  const gas = built();
  gas.setNow(at(WED, '07:00'));
  const added = ok(gas.post({ action: 'timeOffAdd', name: 'Ana', from: WED, to: FRI }));
  assert.ok(added.affected.length > 0);
  assert.ok(!scheduleRows(gas).some((row) => row.Name === 'Ana' && row.Date >= WED));
  assert.ok(added.affected.every((item) => item.coveredBy !== 'Ana'));
  assert.ok(added.affected.some((item) => item.coveredBy === 'Cora'), 'Cora offered those days');
  scheduleRows(gas)
    .filter((row) => row.Source === 'cover')
    .forEach((row) => assert.notStrictEqual(row.Name, 'Ana'));
  const removed = ok(gas.post({ action: 'timeOffRemove', name: 'Ana', id: added.id }));
  assert.deepStrictEqual(removed.restored, []);
  assert.ok(!scheduleRows(gas).some((row) => row.Name === 'Ana' && row.Date >= WED));
});

test('check 3: going out of town never takes back work that is already done', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const doneId = `task|T01|${WED}`;
  const openId = `task|T05|${WED}`;
  ok(gas.post({ action: 'taskToggle', name: 'Ana', id: doneId, done: true })); // checked off early
  const added = ok(gas.post({ action: 'timeOffAdd', name: 'Ana', from: WED, to: WED }));
  assert.ok(!added.affected.some((item) => item.title === 'Unbox packages'), 'the done one is not in the list');
  const done = rowById(gas, doneId);
  assert.deepStrictEqual([done.Name, done.Status, done['Done By']], ['Ana', 'done', 'Ana']);
  assert.notStrictEqual(rowById(gas, openId).Name, 'Ana', 'the one still to do is released');
});

test('timeOffAdd: a range across two published weeks is covered in both, and bad input is refused', () => {
  const gas = built();
  gas.call('runWeekBuild_', NEXT_MON);
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: SUN, to: '2026-11-19' }));
  // Sunday's row has a flex day and Cora works Saturday, so it moves there. Nobody has offered anything next week yet.
  assert.deepStrictEqual(
    added.affected.map((item) => [item.date, item.coveredBy]),
    [
      [SAT, 'Cora'],
      ['2026-11-19', ''],
    ]
  );

  refused(gas.post({ action: 'timeOffAdd', name: 'Gus', from: 'soon', to: THU }), /first date/);
  refused(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: WED }), /on or after/);
  refused(gas.post({ action: 'timeOffAdd', name: 'Gus', from: '2026-10-01', to: '2026-10-02' }), /already passed/);
  refused(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: '2028-01-01' }), /more than a year/);
  refused(gas.post({ action: 'timeOffAdd', name: 'Nobody', from: THU, to: THU }), /staff list/);
  refused(gas.post({ action: 'timeOffRemove', name: 'Ben', id: added.id }), /can't find/);
});

test('boot: time off shows on the list and on the days it covers', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: FRI, note: 'Trip' }));
  const boot = ok(gas.get({ action: 'boot', name: 'Gus' }));
  assert.deepStrictEqual(boot.timeOff, [{ id: added.id, from: THU, to: FRI, label: 'Nov 12 - 13', note: 'Trip' }]);
  const days = boot.week.thisWeek.days;
  assert.deepStrictEqual(days.map((day) => day.off), [false, false, false, true, true, false, false]);
  ok(gas.post({ action: 'timeOffRemove', name: 'Gus', id: added.id }));
  assert.deepStrictEqual(ok(gas.get({ action: 'boot', name: 'Gus' })).timeOff, []);
});

/* ------------------------------------------------- check 4: the Friday 7 AM tick ---- */

const FRIDAY_SUBJECTS = [
  '[TEST to Cora] Koda Operations: availability for the week of Nov 9',
  '[TEST to Gus] Your Koda schedule: week of Nov 9',
  '[TEST to Hal] Your Koda schedule: week of Nov 9',
  '[TEST to Ivy] Your Koda schedule: week of Nov 9',
  '[TEST to Jo] Your Koda schedule: week of Nov 9',
  '[TEST to Ana] Your Koda schedule: week of Nov 9',
  '[TEST to Ben] Your Koda schedule: week of Nov 9',
  '[TEST to Dev] Your Koda schedule: week of Nov 9',
  '[TEST to Managers] Week of Nov 9 schedule is out',
];

/** Cora misses the deadline. Dev submits but gets nothing, since he's ranked last and everything else fits. */
function fridayWorld() {
  const gas = world();
  submit(gas, ['Ana', 'Ben', 'Dev']);
  return gas;
}

test('check 4: the Friday tick builds once, sends each email once, in order, and a second tick does nothing', () => {
  const gas = fridayWorld();
  gas.setNow(at(LAST_FRI, '06:59'));
  assert.deepStrictEqual(gas.tick().ran.includes('weekly'), false, 'not before the deadline');
  assert.deepStrictEqual(scheduleRows(gas), []);
  const before = ok(gas.get({ action: 'boot', name: 'Ana' }));
  assert.strictEqual(before.week.nextWeek.published, false);

  gas.setNow(DEADLINE);
  const first = gas.tick();
  assert.ok(first.ran.includes('weekly'));
  assert.deepStrictEqual(first.failed, []);
  const rowCount = scheduleRows(gas).length;
  assert.ok(rowCount > 0);
  assert.deepStrictEqual(subjects(gas), FRIDAY_SUBJECTS);
  assert.strictEqual(ok(gas.get({ action: 'boot', name: 'Ana' })).week.nextWeek.published, true);

  const opensBefore = gas.state.counters.openById;
  const second = gas.tick();
  assert.deepStrictEqual(second, { ran: [], failed: [] });
  assert.strictEqual(gas.state.counters.openById, opensBefore, 'it did not even open the sheet');
  assert.strictEqual(scheduleRows(gas).length, rowCount);
  assert.deepStrictEqual(subjects(gas), FRIDAY_SUBJECTS);

  gas.setNow(at(LAST_FRI, '16:00'));
  gas.tick();
  gas.setNow(at('2026-11-08', '12:00'));
  gas.tick();
  assert.deepStrictEqual(subjects(gas), FRIDAY_SUBJECTS, 'nothing more over the weekend');
  assert.strictEqual(scheduleRows(gas).length, rowCount);
});

test('check 4: the emails say what section 10 says', () => {
  const gas = fridayWorld();
  friday(gas);
  const byPrefix = (prefix) => gas.state.mail.find((mail) => mail.subject.startsWith(prefix));

  const missed = byPrefix('[TEST to Cora]');
  assert.match(missed.htmlBody, /Hi Cora, we don&#39;t have your availability for the week of Nov 9 yet\. It was due this morning at 7 AM and the schedule just went out\./);
  assert.match(missed.htmlBody, /Fill out availability/);
  assert.match(missed.htmlBody, /\?me=Cora&amp;tab=availability&amp;week=2026-11-09/);
  assert.match(missed.body, /Fill out availability: https:\/\/koda-crossfit\.github\.io\/operations\/\?me=Cora&tab=availability&week=2026-11-09/);
  assert.strictEqual(missed.name, 'Koda Operations');
  assert.strictEqual(missed.replyTo, 'reply@example.com');

  const week = byPrefix('[TEST to Ana]');
  assert.match(week.htmlBody, /Hi Ana/);
  assert.match(week.htmlBody, /Mon, Nov 9</, 'the day, with no time');
  assert.doesNotMatch(week.htmlBody, /\d:\d\d (AM|PM)/, 'no times anywhere');
  assert.match(week.htmlBody, /Unbox packages/);
  assert.match(week.htmlBody, /Remember to clock in and out\./);
  assert.match(week.htmlBody, /Open Koda Operations/);
  assert.match(week.htmlBody, /\?me=Ana&amp;tab=today/);

  const setWeek = byPrefix('[TEST to Gus]');
  assert.match(setWeek.htmlBody, /Thu, Nov 12</);
  assert.match(setWeek.htmlBody, /Deep bathroom clean/);

  const nothing = byPrefix('[TEST to Dev]');
  assert.match(nothing.htmlBody, /nothing on your list for the week of Nov 9/);

  const summary = byPrefix('[TEST to Managers]');
  assert.match(summary.htmlBody, /Uncovered tasks/);
  assert.match(summary.htmlBody, /Sat, Nov 14: Unbox packages/, "nobody offered Saturday, so it's uncovered");
  assert.match(summary.htmlBody, /Didn&#39;t submit availability/);
  assert.match(summary.htmlBody, /Cora/);
  assert.match(summary.htmlBody, /<td[^>]*>Ana<\/td><td[^>]*>6<\/td><td[^>]*>5\.7<\/td>/, 'wanted against assigned');
  assert.ok(!gas.state.mail.some((mail) => /\$/.test(mail.htmlBody)), 'no dollar amounts, ever');
});

test('check 4: someone who said they can\'t work gets no schedule email, and neither does someone with no answer', () => {
  const gas = world();
  submit(gas, ['Ana', 'Ben']);
  ok(gas.post({ action: 'saveAvailability', name: 'Dev', weekOf: MON, none: true }));
  friday(gas);
  assert.ok(!subjects(gas).some((subject) => subject.includes('[TEST to Dev]')));
  assert.strictEqual(subjects(gas).filter((subject) => subject.includes('[TEST to Cora]')).length, 1, 'only the missed-deadline email');
  assert.match(subjects(gas).find((subject) => subject.includes('[TEST to Cora]')), /availability for the week/);
});

test('check 4: a crash at any email resumes on the next tick, with every email sent exactly once', () => {
  for (let crashAt = 1; crashAt <= FRIDAY_SUBJECTS.length; crashAt++) {
    const gas = fridayWorld();
    gas.state.counters.mail = 0;
    gas.state.beforeMail = (mail, count) => {
      if (count === crashAt) throw new Error('Service error: Mail');
    };
    gas.setNow(DEADLINE);
    const crashed = gas.tick();
    assert.deepStrictEqual(crashed.failed, ['weekly'], `crash at email ${crashAt}`);
    gas.state.beforeMail = null;

    gas.setNow(at(LAST_FRI, '07:05'));
    const resumed = gas.tick();
    assert.deepStrictEqual(resumed.failed, [], `resume after email ${crashAt}`);
    assert.ok(resumed.ran.includes('weekly'));

    const sent = subjects(gas).filter((subject) => !/job failed/.test(subject));
    assert.deepStrictEqual(sent.slice().sort(), FRIDAY_SUBJECTS.slice().sort(), `after a crash at email ${crashAt}`);

    gas.setNow(at(LAST_FRI, '07:10'));
    assert.deepStrictEqual(gas.tick(), { ran: [], failed: [] }, 'and then it is finished');
    assert.deepStrictEqual(subjects(gas).filter((subject) => !/job failed/.test(subject)).length, FRIDAY_SUBJECTS.length);
  }
});

test('check 4: a step that finished stays finished when the run resumes after a crash', () => {
  const gas = fridayWorld();
  gas.state.counters.mail = 0;
  gas.state.beforeMail = (mail, count) => {
    if (count === 2) throw new Error('Service error: Mail'); // the first email of the next step, right after the missed-deadline ones
  };
  gas.setNow(DEADLINE);
  assert.deepStrictEqual(gas.tick().failed, ['weekly']);
  gas.state.beforeMail = null;
  assert.deepStrictEqual(subjects(gas).filter((subject) => !/job failed/.test(subject)), [FRIDAY_SUBJECTS[0]]);

  // Someone new shows up in the Staff tab before the next tick. The deadline email step already ran.
  gas.sheet('Staff').appendRow([9, 'Zed', 'zed@example.com', 'Flexible', '', '', true, '']);
  gas.setNow(at(LAST_FRI, '07:05'));
  assert.deepStrictEqual(gas.tick().failed, []);
  assert.ok(!subjects(gas).some((subject) => subject.includes('[TEST to Zed]')), 'that step is not run a second time');
  assert.strictEqual(subjects(gas).filter((subject) => subject.includes('[TEST to Cora]')).length, 1);
});

test('check 4: a crash in the build resumes without making a row twice', () => {
  const clean = fridayWorld();
  friday(clean);
  const expected = snapshotRows(clean, () => true);

  const gas = fridayWorld();
  const realMark = gas.context.markBuilt_;
  gas.context.markBuilt_ = () => {
    gas.context.markBuilt_ = realMark;
    throw new Error('Crash after the rows went in');
  };
  gas.setNow(DEADLINE);
  assert.deepStrictEqual(gas.tick().failed, ['weekly']);
  assert.ok(scheduleRows(gas).length > 0, 'the rows are in');
  assert.ok(!gas.state.mail.some((mail) => /Your Koda schedule/.test(mail.subject)), 'no schedule goes out before the build finishes');

  gas.setNow(at(LAST_FRI, '07:05'));
  assert.deepStrictEqual(gas.tick().failed, []);
  assert.deepStrictEqual(snapshotRows(gas, () => true), expected);
  assert.deepStrictEqual(subjects(gas).filter((subject) => !/job failed/.test(subject)), FRIDAY_SUBJECTS);
});

test('check 4: a failing job emails test_email once an hour, and does not block the other jobs', () => {
  const gas = fridayWorld();
  const realNightly = gas.context.nightlyRoll_;
  gas.context.nightlyRoll_ = () => {
    throw new Error('The nightly broke');
  };
  gas.setNow(DEADLINE);
  const result = gas.tick();
  assert.deepStrictEqual(result.failed, ['nightly']);
  assert.ok(result.ran.includes('weekly'), 'the Friday run still happened');
  const alerts = () => gas.state.mail.filter((mail) => /job failed/.test(mail.subject));
  assert.strictEqual(alerts().length, 1);
  assert.strictEqual(alerts()[0].to, 'test@example.com');
  assert.strictEqual(alerts()[0].subject, 'Koda Operations: the nightly job failed');

  gas.setNow(at(LAST_FRI, '07:05'));
  assert.deepStrictEqual(gas.tick().failed, ['nightly']);
  assert.strictEqual(alerts().length, 1, 'still just one, and no failure message in anyone else\'s inbox');

  gas.setNow(at(LAST_FRI, '08:30'));
  assert.deepStrictEqual(gas.tick().failed, ['nightly']);
  assert.strictEqual(alerts().length, 2, 'another an hour later');

  gas.context.nightlyRoll_ = realNightly;
  gas.setNow(at(LAST_FRI, '08:35'));
  assert.deepStrictEqual(gas.tick(), { ran: ['nightly'], failed: [] });
});

test('check 4: weeks before first_week are skipped, and a tick before setup does nothing', () => {
  const empty = createGas();
  empty.setNow(DEADLINE);
  assert.deepStrictEqual(empty.tick(), { ran: [], failed: [] });

  const gas = world();
  gas.setNow(at('2026-10-30', '07:00')); // the Friday before the week of Nov 2
  const result = gas.tick();
  assert.ok(result.ran.includes('weekly'));
  assert.deepStrictEqual(scheduleRows(gas), []);
  assert.deepStrictEqual(gas.state.mail, []);
  assert.strictEqual(ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: '2026-11-02' })).published, false);
});

test('check 4: the Thursday heads-up is off by default, and goes only to people missing when turned on', () => {
  const gas = fridayWorld();
  gas.setNow(at('2026-11-05', '13:45'));
  gas.tick();
  assert.deepStrictEqual(gas.state.mail, [], 'off by default');

  const other = fridayWorld();
  setSetting(other, 'thursday_heads_up', 'TRUE');
  other.state.properties.delete('RUN_THU_' + MON);
  other.setNow(at('2026-11-05', '13:44'));
  other.tick();
  assert.deepStrictEqual(other.state.mail, [], 'not before Thursday at 1:45 PM');
  other.setNow(at('2026-11-05', '13:45'));
  other.tick();
  assert.deepStrictEqual(subjects(other), ['[TEST to Cora] Koda Operations: availability for the week of Nov 9']);
  assert.match(other.state.mail[0].htmlBody, /due tomorrow at 7 AM/);
  other.setNow(at('2026-11-05', '13:50'));
  other.tick();
  assert.strictEqual(other.state.mail.length, 1, 'once');
});

/* ------------------------------------------------------------ check 5: test mode ---- */

test('check 5: while not live, every email goes only to test_email, marked with who it was for', () => {
  const gas = fridayWorld();
  friday(gas);
  gas.setNow(at(MON, '10:00'));
  ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: THU }));
  ok(gas.post({ action: 'mgrRemind', code: CODE, weekOf: NEXT_MON }));
  gas.setNow(at('2026-11-10', '09:00'));
  ok(save(gas, 'Cora', MON, 6, hoursEach(['Sat'], 8)));
  assert.ok(gas.state.mail.length > FRIDAY_SUBJECTS.length);
  gas.state.mail.forEach((mail) => {
    assert.strictEqual(mail.to, 'test@example.com');
    assert.match(mail.subject, /^\[TEST to [^\]]+\] /);
  });
});

test('check 5: with no test_email nothing goes out at all, and it never falls back to a real address', () => {
  const gas = fridayWorld();
  setSetting(gas, 'test_email', '');
  friday(gas);
  assert.deepStrictEqual(gas.state.mail, []);
  assert.ok(gas.rows('Log').some((line) => line.Action === 'email not sent'));
});

test('check 5: once live, email goes to the real addresses with a clean subject', () => {
  const gas = fridayWorld();
  setSetting(gas, 'live', 'TRUE');
  friday(gas);
  const toCora = gas.state.mail.find((mail) => /availability for the week/.test(mail.subject));
  assert.strictEqual(toCora.to, 'cora@example.com');
  assert.strictEqual(toCora.subject, 'Koda Operations: availability for the week of Nov 9');
  assert.strictEqual(gas.state.mail.find((mail) => mail.to === 'gus@example.com').subject, 'Your Koda schedule: week of Nov 9');
  const summary = gas.state.mail.find((mail) => /schedule is out/.test(mail.subject));
  assert.strictEqual(summary.to, 'max@example.com,mia@example.com');
  assert.strictEqual(summary.subject, 'Week of Nov 9 schedule is out');
  assert.ok(!gas.state.mail.some((mail) => mail.to === 'test@example.com'));
});

test('check 5: a bad address is noted and skipped, and everyone else still gets theirs', () => {
  const gas = fridayWorld();
  setSetting(gas, 'live', 'TRUE');
  gas.state.beforeMail = (mail) => {
    if (mail.to === 'hal@example.com') throw new Error('Invalid email: hal@example.com');
  };
  const result = friday(gas);
  assert.deepStrictEqual(result.failed, []);
  assert.ok(gas.state.mail.some((mail) => mail.to === 'ivy@example.com'));
  assert.ok(gas.rows('Log').some((line) => line.Details === 'Bad address for Hal'));
});

/* ------------------------------------------------------------- check 6: the hours ---- */

function hoursEntries(gas, name) {
  return ok(gas.get({ action: 'boot', name })).hours;
}

test('check 6: clock in, clock out and the totals', () => {
  const gas = built();
  gas.setNow(at(MON, '09:02'));
  const inReply = ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  assert.strictEqual(inReply.clock.status, 'in');
  assert.strictEqual(inReply.clock.entry.in, '9:02 AM');
  assert.strictEqual(inReply.clock.entry.out, '');
  assert.strictEqual(inReply.clock.entry.hours, null);
  assert.deepStrictEqual(inReply.clock.stale, []);

  gas.setNow(at(MON, '11:30'));
  const outReply = ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  assert.strictEqual(outReply.clock.status, 'out');
  assert.strictEqual(outReply.clock.entry, null);

  const summary = hoursEntries(gas, 'Ana');
  assert.strictEqual(summary.monthLabel, 'November');
  assert.strictEqual(summary.monthTotal, 2.47);
  assert.strictEqual(summary.lastMonthLabel, 'October');
  assert.strictEqual(summary.lastMonthTotal, 0);
  assert.deepStrictEqual(summary.entries, [{ id: summary.entries[0].id, date: MON, dayLabel: 'Mon, Nov 9', in: '9:02 AM', out: '11:30 AM', hours: 2.47, flag: '', note: '' }]);

  const row = gas.rows('Hours')[0];
  assert.strictEqual(row.Source, 'clock');
  assert.strictEqual(row.Flag, '');
  const hoursCell = gas.sheet('Hours').getRange(row._row, 6);
  assert.strictEqual(hoursCell.getFormula(), `=IF(E${row._row}="","",ROUND((E${row._row}-D${row._row})*24,2))`);
});

test('check 6: code works hours out from In and Out, and never reads the formula cell', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  gas.setNow(at(MON, '10:00'));
  ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  gas.sheet('Hours').getRange(2, 6).setValue(999);
  assert.strictEqual(hoursEntries(gas, 'Ana').monthTotal, 1);
});

test('check 6: clockIn twice gives the same entry, and a second shift the same day is a new one', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  const first = ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  gas.setNow(at(MON, '09:10'));
  const second = ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  assert.strictEqual(second.clock.entry.id, first.clock.entry.id);
  assert.strictEqual(second.clock.entry.in, '9:00 AM');
  assert.strictEqual(gas.rows('Hours').length, 1);

  gas.setNow(at(MON, '10:00'));
  ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  const repeat = ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  assert.strictEqual(repeat.clock.status, 'out', 'a repeated clock-out is harmless');
  assert.strictEqual(hoursEntries(gas, 'Ana').monthTotal, 1, 'and changes nothing');

  gas.setNow(at(MON, '15:00'));
  const again = ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  assert.notStrictEqual(again.clock.entry.id, first.clock.entry.id);
  assert.strictEqual(gas.rows('Hours').length, 2);
});

test('check 6: forgot to clock out: stale, flagged overnight, fixed by the person, then in the totals', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  const id = ok(gas.post({ action: 'clockIn', name: 'Ana' })).clock.entry.id;
  gas.setNow(at(TUE, '00:35'));
  gas.tick();
  assert.strictEqual(gas.rows('Hours')[0].Flag, 'missing');

  gas.setNow(at(TUE, '09:00'));
  const boot = ok(gas.get({ action: 'boot', name: 'Ana' }));
  assert.strictEqual(boot.clock.status, 'out');
  assert.strictEqual(boot.clock.entry, null);
  assert.deepStrictEqual(boot.clock.stale.map((entry) => [entry.id, entry.dayLabel, entry.flag]), [[id, 'Mon, Nov 9', 'missing']]);
  assert.strictEqual(boot.hours.monthTotal, 0, 'nothing counts until it has an end');

  // A new shift today doesn't touch it, and a stray clock-out can't close it with a day's worth of hours.
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  gas.setNow(at(TUE, '09:30'));
  ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  assert.strictEqual(gas.rows('Hours')[0].Out, '');

  refused(gas.post({ action: 'clockFix', name: 'Ana', id, out: '8:30' }), /before you clocked in/);
  refused(gas.post({ action: 'clockFix', name: 'Ana', id, out: 'noon' }), /finish time/);
  refused(gas.post({ action: 'clockFix', name: 'Ben', id, out: '11:30' }), /isn't yours/);
  refused(gas.post({ action: 'clockFix', name: 'Ana', id: 'nope', out: '11:30' }), /can't find/);

  const fixed = ok(gas.post({ action: 'clockFix', name: 'Ana', id, out: '11:30' }));
  assert.deepStrictEqual(fixed.clock.stale, []);
  assert.strictEqual(fixed.entry.flag, 'fixed');
  assert.strictEqual(fixed.entry.out, '11:30 AM');
  assert.strictEqual(fixed.entry.hours, 2.5);
  const row = gas.rows('Hours').find((line) => line.ID === id);
  assert.strictEqual(row.Flag, 'fixed');
  assert.strictEqual(hoursEntries(gas, 'Ana').monthTotal, 3);
  ok(gas.post({ action: 'clockFix', name: 'Ana', id, out: '11:30' })); // a retry is fine
  refused(gas.post({ action: 'clockFix', name: 'Ana', id, out: '11:45' }), /already has a clock-out/);
});

test('check 6: forgot to clock in: add hours, flagged manual, in the totals', () => {
  const gas = built();
  gas.setNow(at(TUE, '12:00'));
  const added = ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: MON, start: '09:00', end: '11:15', note: 'Forgot my phone' }));
  assert.strictEqual(added.entry.flag, 'manual');
  assert.strictEqual(added.entry.hours, 2.25);
  assert.strictEqual(added.entry.note, 'Forgot my phone');
  const row = gas.rows('Hours')[0];
  assert.strictEqual(row.Source, 'manual');
  assert.strictEqual(row.Flag, 'manual');
  assert.strictEqual(hoursEntries(gas, 'Ana').monthTotal, 2.25);
  assert.ok(gas.sheet('Hours').getRange(2, 6).getFormula().startsWith('=IF('));
});

test('hoursAdd: overlap rejected, and each of the other limits too', () => {
  const gas = built();
  gas.setNow(at(TUE, '12:00'));
  ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: MON, start: '09:00', end: '11:00' }));

  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: MON, start: '10:00', end: '12:00' }), /overlaps/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: MON, start: '08:00', end: '09:30' }), /overlaps/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: MON, start: '09:30', end: '10:00' }), /overlaps/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: MON, start: '08:00', end: '12:00' }), /overlaps/);
  ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: MON, start: '11:00', end: '12:00' })); // touching is fine
  ok(gas.post({ action: 'hoursAdd', name: 'Ben', date: MON, start: '09:00', end: '11:00' })); // someone else is fine

  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-11', start: '09:00', end: '10:00' }), /in the future/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: TUE, start: '12:30', end: '13:00' }), /hasn't happened/);
  ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-09-26', start: '09:00', end: '10:00' })); // exactly 45 days back
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-09-25', start: '09:00', end: '10:00' }), /too long ago/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-01', start: '05:00', end: '21:00' }), /16 hours/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-02', start: '11:00', end: '10:00' }), /after the start/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-02', start: '10:00', end: '10:00' }), /after the start/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: 'yesterday', start: '09:00', end: '10:00' }), /pick a date/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-02-31', start: '09:00', end: '10:00' }), /pick a date/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-02', start: '25:00', end: '26:00' }), /start time/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-02', start: '09:00' }), /end time/);
});

test('hoursAdd: an entry still on the clock counts as running until now', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  gas.setNow(at(MON, '10:00'));
  refused(gas.post({ action: 'hoursAdd', name: 'Ana', date: MON, start: '09:30', end: '09:45' }), /overlaps/);
  ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: MON, start: '08:00', end: '08:30' }));
});

test('check 6: manager edit, add and delete are all reflected in the totals, with who and when', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  const id = ok(gas.post({ action: 'clockIn', name: 'Ana' })).clock.entry.id;
  gas.setNow(at(MON, '11:00'));
  ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  assert.strictEqual(hoursEntries(gas, 'Ana').monthTotal, 2);

  gas.setNow(at(TUE, '08:00'));
  const edited = ok(gas.post({ action: 'mgrHoursEdit', code: CODE, id, end: '12:30', note: 'Stayed to finish', by: 'Max' }));
  assert.strictEqual(edited.entry.flag, 'edited');
  assert.strictEqual(edited.entry.hours, 3.5);
  assert.strictEqual(hoursEntries(gas, 'Ana').monthTotal, 3.5);
  const row = gas.rows('Hours')[0];
  assert.strictEqual(row['Edited By'], 'Max');
  assert.strictEqual(Object.prototype.toString.call(row['Edited At']), '[object Date]');
  assert.strictEqual(row.Note, 'Stayed to finish');

  const addedByManager = ok(gas.post({ action: 'mgrHoursAdd', code: CODE, name: 'Ana', date: '2026-10-20', start: '09:00', end: '10:30', by: 'Mia', note: 'From paper' }));
  assert.strictEqual(addedByManager.entry.flag, 'edited');
  assert.strictEqual(hoursEntries(gas, 'Ana').lastMonthTotal, 1.5);
  assert.strictEqual(gas.rows('Hours')[1]['Edited By'], 'Mia');

  refused(gas.post({ action: 'mgrHoursAdd', code: CODE, name: 'Ana', date: MON, start: '10:00', end: '11:00' }), /overlaps/);
  refused(gas.post({ action: 'mgrHoursEdit', code: CODE, id: 'nope', end: '12:00' }), /can't find/);
  refused(gas.post({ action: 'mgrHoursEdit', code: CODE, id, end: '08:00' }), /after the start/);

  ok(gas.post({ action: 'mgrHoursDelete', code: CODE, id: addedByManager.entry.id, by: 'Max' }));
  assert.strictEqual(hoursEntries(gas, 'Ana').lastMonthTotal, 0);
  assert.strictEqual(gas.rows('Hours').length, 1);

  // Moving the date or start keeps the rest of the times.
  const moved = ok(gas.post({ action: 'mgrHoursEdit', code: CODE, id, date: TUE, start: '07:00', end: '07:45', by: 'Max' }));
  assert.deepStrictEqual([moved.entry.date, moved.entry.in, moved.entry.out, moved.entry.hours], [TUE, '7:00 AM', '7:45 AM', 0.75]);
});

test('check 6: an entry across the March 14, 2027 clock change counts real elapsed hours', () => {
  const gas = world();
  gas.setNow('2027-03-14T01:30:00-07:00');
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  gas.setNow('2027-03-14T03:30:00-06:00'); // one hour later: 2 AM doesn't exist that night
  const closed = ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  assert.strictEqual(closed.clock.status, 'out');
  const boot = ok(gas.get({ action: 'boot', name: 'Ana' }));
  assert.strictEqual(boot.hours.entries[0].hours, 1);
  assert.strictEqual(boot.hours.entries[0].in, '1:30 AM');
  assert.strictEqual(boot.hours.entries[0].out, '3:30 AM');
  assert.strictEqual(boot.hours.monthTotal, 1);

  // The same night, typed in by hand.
  gas.setNow('2027-03-14T12:00:00-06:00');
  const typed = ok(gas.post({ action: 'hoursAdd', name: 'Ben', date: '2027-03-14', start: '01:30', end: '03:30' }));
  assert.strictEqual(typed.entry.hours, 1);
  assert.strictEqual(typed.entry.in, '1:30 AM');
  assert.strictEqual(typed.entry.out, '3:30 AM');
});

test('check 6: an entry across the fall clock change counts the extra hour too', () => {
  const gas = world();
  gas.setNow(at('2026-11-05', '12:00'));
  const typed = ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-01', start: '00:30', end: '03:30' }));
  assert.strictEqual(typed.entry.hours, 4, '00:30 MDT to 03:30 MST is four real hours');
});

test('check 6: week and day math never drifts across a clock change', () => {
  const gas = world();
  const day = 86400000;
  const keys = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let i = 0; i < 800; i++) {
    const utc = Date.UTC(2026, 9, 1) + i * day;
    const date = new Date(utc).toISOString().slice(0, 10);
    const index = (new Date(utc).getUTCDay() + 6) % 7;
    assert.strictEqual(gas.call('dayKey_', date), keys[index], date);
    assert.strictEqual(gas.call('mondayOf_', date), new Date(utc - index * day).toISOString().slice(0, 10), date);
    assert.strictEqual(gas.call('addDays_', date, 7), new Date(utc + 7 * day).toISOString().slice(0, 10), date);
    assert.strictEqual(gas.call('nextMonday_', date), new Date(utc + (7 - index) * day).toISOString().slice(0, 10), date);
  }
});

test('check 6: the deadline stays 7:00 AM on Denver clocks on both sides of a clock change', () => {
  const gas = world();
  const past = (weekOf) => ok(gas.get({ action: 'availability', name: 'Ana', weekOf })).past;
  // Standard time: the Friday before Mar 15, 2027 is Mar 12, 7 AM at -07:00.
  gas.setNow('2027-03-12T06:59:00-07:00');
  assert.strictEqual(past('2027-03-15'), false);
  gas.setNow('2027-03-12T07:00:00-07:00');
  assert.strictEqual(past('2027-03-15'), true);
  // Daylight time, a week later: 7 AM is an hour earlier in UTC.
  gas.setNow('2027-03-19T06:59:00-06:00');
  assert.strictEqual(past('2027-03-22'), false);
  gas.setNow('2027-03-19T07:00:00-06:00');
  assert.strictEqual(past('2027-03-22'), true);
  assert.strictEqual(ok(gas.get({ action: 'availability', name: 'Ana', weekOf: '2027-03-15' })).deadline, 'Fri, Mar 12 at 7:00 AM');
  assert.strictEqual(ok(gas.get({ action: 'availability', name: 'Ana', weekOf: '2026-11-02' })).deadline, 'Fri, Oct 30 at 7:00 AM');
});

test('check 6: the Friday run lands on the right week in the week the clocks change', () => {
  const gas = world();
  gas.setNow('2027-03-05T07:00:00-07:00'); // builds the week of Mar 8, which ends on the Sunday the clocks change
  assert.deepStrictEqual(gas.tick().failed, []);
  const dates = new Set(scheduleRows(gas).map((row) => row.Date));
  assert.ok(dates.has('2027-03-14'));
  assert.ok(!dates.has('2027-03-15'));
  scheduleRows(gas).forEach((row) => assert.strictEqual(row['Week Of'], '2027-03-08'));
  gas.setNow('2027-03-12T07:00:00-07:00');
  assert.deepStrictEqual(gas.tick().failed, []);
  const next = scheduleRows(gas).filter((row) => row.Date >= '2027-03-15');
  assert.ok(next.length > 0);
  next.forEach((row) => assert.strictEqual(row['Week Of'], '2027-03-15'));
  assert.strictEqual(new Set(next.map((row) => row.Date)).has('2027-03-21'), true);
});

test('wallToDate_: Denver clock time to a real moment, on ordinary days and the days the clocks change', () => {
  const gas = world();
  const moment = (date, time) => gas.call('wallToDate_', date, time);
  assert.strictEqual(moment('2026-11-10', '09:00'), '2026-11-10T16:00:00.000Z');
  assert.strictEqual(moment('2026-07-10', '09:00'), '2026-07-10T15:00:00.000Z');
  assert.strictEqual(moment('2027-03-14', '01:30'), '2027-03-14T08:30:00.000Z');
  assert.strictEqual(moment('2027-03-14', '03:30'), '2027-03-14T09:30:00.000Z');
  assert.strictEqual(moment('2026-11-01', '00:30'), '2026-11-01T06:30:00.000Z');
  assert.strictEqual(moment('2026-11-01', '03:30'), '2026-11-01T10:30:00.000Z');
});

test('at: a queued tap keeps its time if it is believable, and is ignored if not', () => {
  const gas = built();
  const now = Date.parse(at(MON, '12:00'));
  gas.setNow(now);

  const twoHoursAgo = now - 2 * 3600000;
  const queued = ok(gas.post({ action: 'clockIn', name: 'Ana', at: twoHoursAgo }));
  assert.strictEqual(queued.clock.entry.in, '10:00 AM', 'keeps its real time');

  const queuedOut = ok(gas.post({ action: 'clockOut', name: 'Ana', at: now - 3600000 }));
  assert.strictEqual(queuedOut.clock.status, 'out');
  assert.strictEqual(hoursEntries(gas, 'Ana').entries[0].out, '11:00 AM');

  const tooOld = now - 13 * 3600000;
  assert.strictEqual(ok(gas.post({ action: 'clockIn', name: 'Ben', at: tooOld })).clock.entry.in, '12:00 PM', 'over 12 hours old: the server time wins');
  ok(gas.post({ action: 'clockOut', name: 'Ben' }));

  gas.setNow(now + 3600000);
  const tooFarAhead = now + 3600000 + 6 * 60000;
  assert.strictEqual(ok(gas.post({ action: 'clockIn', name: 'Cora', at: tooFarAhead })).clock.entry.in, '1:00 PM', 'over 5 minutes ahead: the server time wins');
  const justAhead = now + 3600000 + 4 * 60000;
  assert.strictEqual(ok(gas.post({ action: 'clockIn', name: 'Dev', at: justAhead })).clock.entry.in, '1:04 PM', 'a little ahead is just a fast phone');
  assert.strictEqual(ok(gas.post({ action: 'clockIn', name: 'Gus', at: 'junk' })).clock.entry.in, '1:00 PM');
});

/* --------------------------------------------------------- check 7: Thanksgiving ---- */

test('check 7: Thanksgiving closed: no rows that day, no Thursday set row, movable tasks shift, daily tasks drop', () => {
  const gas = world();
  const THANKSGIVING = '2026-11-26';
  gas.setNow(at('2026-11-19', '10:00'));
  ok(save(gas, 'Cora', '2026-11-23', 20, hoursEach(MON_SAT, 8)));
  gas.setNow(at('2026-11-20', '07:00'));
  assert.deepStrictEqual(gas.tick().failed, []);

  const rows = scheduleRows(gas);
  assert.ok(rows.length > 0);
  assert.deepStrictEqual(rows.filter((row) => row.Date === THANKSGIVING), [], 'no rows that day');
  assert.ok(!rows.some((row) => row.ID === `set|T08|${THANKSGIVING}|Gus`), "the set person's Thursday row doesn't exist");
  assert.deepStrictEqual(rows.filter((row) => row.Name === 'Gus').map((row) => row.Date), ['2026-11-27', '2026-11-29']);
  assert.deepStrictEqual(rows.filter((row) => row['Task ID'] === 'T01').map((row) => row.Date), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-28'], 'daily tasks drop');
  const office = rows.find((row) => row.ID === `task|T10|${THANKSGIVING}`);
  assert.strictEqual(office.Date, '2026-11-27', 'movable tasks shift');
  assert.strictEqual(office.Name, 'Cora');
  assert.ok(!scheduleRows(gas).some((row) => row.Date === THANKSGIVING));

  gas.setNow(at(THANKSGIVING, '09:00'));
  const boot = ok(gas.get({ action: 'boot', name: 'Cora' }));
  assert.strictEqual(boot.today.closed, 'Thanksgiving');
  assert.deepStrictEqual(boot.today.tasks, []);
  assert.strictEqual(boot.today.next.date, '2026-11-27');
  assert.strictEqual(boot.week.thisWeek.days[3].closed, 'Thanksgiving');
  assert.strictEqual(ok(gas.get({ action: 'availability', name: 'Cora', weekOf: '2026-11-23' })).days[3].closed, 'Thanksgiving');
  const board = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: '2026-11-23' }));
  assert.strictEqual(board.days[3].closed, 'Thanksgiving');
  assert.deepStrictEqual(board.days[3].groups, []);
});

test('check 7: nothing can be put on a closed day by hand, and rolled work skips over it', () => {
  const gas = world();
  gas.setNow(at('2026-11-19', '10:00'));
  ok(save(gas, 'Cora', '2026-11-23', 20, hoursEach(MON_SAT, 8)));
  gas.setNow(at('2026-11-20', '07:00'));
  gas.tick();
  gas.setNow(at('2026-11-24', '09:00'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Rolled over the holiday', weekOf: '2026-11-23', day: 'Wed', who: ['Cora'], minutes: 15 }));
  assert.deepStrictEqual(added.placed, { name: 'Cora', date: '2026-11-25' });
  refused(gas.post({ action: 'mgrAssign', code: CODE, id: 'oneoff|' + added.id, name: 'Cora', date: '2026-11-26' }), /closed/);

  gas.setNow(at('2026-11-26', '00:35'));
  assert.deepStrictEqual(gas.tick().failed, []);
  const row = rowById(gas, 'oneoff|' + added.id);
  assert.strictEqual(row.Date, '2026-11-27', 'the gym is closed today, so it rolls to Friday');
  assert.strictEqual(row.Name, 'Cora');
  assert.strictEqual(row['Rolled From'], '2026-11-25');
});

/* ------------------------------------------------------- check 8: formulas as text ---- */

test('check 8: a note starting with = lands in the sheet as text', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  const id = `task|T01|${MON}`;
  const risky = '=IMPORTXML("http://evil.example","//a")';
  ok(gas.post({ action: 'taskNote', name: 'Ana', id, note: risky }));
  const row = rowById(gas, id);
  const noteCell = gas.sheet('Schedule').getRange(row._row, Object.keys(row).indexOf('Note'));
  assert.strictEqual(noteCell.getFormula(), '', 'not a formula');
  assert.strictEqual(noteCell.getValue(), risky, 'the words are all there');
  const task = ok(gas.get({ action: 'boot', name: 'Ana' })).today.tasks.find((candidate) => candidate.id === id);
  assert.strictEqual(task.note, risky, 'and the page shows exactly what was typed');
});

test('check 8: every other place a person can type is safe too', () => {
  const gas = built();
  const formulaCells = () => {
    const found = [];
    gas.book().getSheets().forEach((sheet) => {
      if (sheet.getName() === 'Monthly Hours') return;
      sheet.getDataRange().getFormulas().forEach((line, r) => {
        line.forEach((formula, c) => {
          const isHoursFormula = sheet.getName() === 'Hours' && c === 5;
          if (formula && !isHoursFormula) found.push(`${sheet.getName()}!R${r + 1}C${c + 1}: ${formula}`);
        });
      });
    });
    return found;
  };

  gas.setNow(at(MON, '09:00'));
  ok(save(gas, 'Ana', NEXT_MON, 4, { Mon: 1 }, { notes: '=1+1' }));
  ok(gas.post({ action: 'timeOffAdd', name: 'Ana', from: '2026-12-01', to: '2026-12-01', note: '+1 303 555 0100' }));
  ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-02', start: '09:00', end: '10:00', note: '@home' }));
  const clock = ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  ok(gas.post({ action: 'mgrHoursEdit', code: CODE, id: clock.clock.entry.id, note: '-minus', by: '=by' }));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: '=HYPERLINK("x")', details: '=details', priority: 'B', minutes: 15, weekOf: MON, day: 'Wed', who: [], by: 'Max' }));
  assert.deepStrictEqual(formulaCells(), []);

  // Rewriting a row that holds this text has to keep it safe as well.
  ok(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, details: '=details again' }));
  ok(gas.post({ action: 'mgrAssign', code: CODE, id: 'oneoff|' + added.id, name: 'Cora', date: THU }));
  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));
  assert.deepStrictEqual(formulaCells(), []);

  const row = rowById(gas, 'oneoff|' + added.id);
  assert.strictEqual(row.Task, '=HYPERLINK("x")');
  assert.strictEqual(row.Details, '=details again');
  assert.strictEqual(gas.rows('Availability').find((line) => line.Name === 'Ana' && line['Week Of'] === NEXT_MON).Notes, '=1+1');
  assert.strictEqual(gas.rows('Time Off')[0].Note, '+1 303 555 0100');
});

test('safeCell_: puts an apostrophe on = + - @ and nothing else, and reading takes it off again', () => {
  const gas = world();
  ['=1', '+1', '-1', '@x', ' =1'].forEach((text) => {
    assert.strictEqual(gas.call('safeCell_', text), `'${text}`);
    assert.strictEqual(gas.call('unsafeCell_', `'${text}`), text);
  });
  ['plain', 'a=b', "it's", ''].forEach((text) => {
    assert.strictEqual(gas.call('safeCell_', text), text);
    assert.strictEqual(gas.call('unsafeCell_', text), text);
  });
});

test('length limits: titles 120, details and notes 500', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  const long = 'x'.repeat(700);
  const id = `task|T01|${MON}`;
  ok(gas.post({ action: 'taskNote', name: 'Ana', id, note: long }));
  assert.strictEqual(rowById(gas, id).Note.length, 500);
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: long, details: long, weekOf: MON, minutes: 15 }));
  assert.strictEqual(added.oneOff.title.length, 120);
  assert.strictEqual(added.oneOff.details.length, 500);
  ok(save(gas, 'Ana', NEXT_MON, 4, { Mon: 1 }, { notes: long }));
  assert.strictEqual(gas.rows('Availability').find((row) => row['Week Of'] === NEXT_MON).Notes.length, 500);
});

/* --------------------------------------------- check 9: what staff can never see ---- */

test('check 9: staff responses have no email addresses and no one else\'s hours', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ben' }));
  gas.setNow(at(MON, '10:17'));
  const benEntry = ok(gas.post({ action: 'clockOut', name: 'Ben' }));
  assert.strictEqual(benEntry.ok, true);
  const benId = gas.rows('Hours')[0].ID;
  gas.setNow(at(MON, '10:30')); // so "10:17" below can only have come from his entry
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));

  const email = /[^\s"'<>]+@[^\s"'<>]+\.[a-z]{2,}/i;
  const responses = [
    gas.get({ action: 'names' }),
    gas.get({ action: 'boot', name: 'Ana' }),
    gas.get({ action: 'boot', name: 'Gus' }),
    gas.get({ action: 'boot', name: 'Max' }),
    gas.get({ action: 'availability', name: 'Ana', weekOf: MON }),
    gas.post({ action: 'saveAvailability', name: 'Ana', weekOf: NEXT_MON, hoursWanted: 4, dayHours: { Mon: 1 } }),
    gas.post({ action: 'timeOffAdd', name: 'Ana', from: WED, to: WED }),
    gas.post({ action: 'taskToggle', name: 'Ana', id: `task|T01|${MON}`, done: true }),
    gas.post({ action: 'taskNote', name: 'Ana', id: `task|T01|${MON}`, note: 'Fine' }),
    gas.post({ action: 'clockIn', name: 'Ana' }),
    gas.post({ action: 'clockOut', name: 'Ana' }),
    gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-02', start: '09:00', end: '10:00' }),
  ];
  responses.forEach((reply) => {
    assert.strictEqual(reply.ok, true, reply.error);
    assert.ok(!email.test(JSON.stringify(reply)), `An email address leaked: ${JSON.stringify(reply).slice(0, 300)}`);
  });

  const anaBoot = JSON.stringify(gas.get({ action: 'boot', name: 'Ana' }));
  assert.ok(!anaBoot.includes(benId), "Ben's hours entry isn't in Ana's boot");
  assert.ok(!anaBoot.includes('10:17'), "and neither is his time");
  assert.ok(!anaBoot.includes('"Ben"'), 'nor his name');
  const bens = gas.get({ action: 'boot', name: 'Ben' });
  assert.strictEqual(bens.hours.entries.length, 1, 'he sees only his own');
  assert.ok(!JSON.stringify(gas.get({ action: 'boot', name: 'Ana' }).hours).includes(benId));
});

test('check 9: a person can\'t act on someone else\'s task', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  const id = `task|T01|${MON}`;
  refused(gas.post({ action: 'taskToggle', name: 'Ben', id, done: true }), /isn't on your list/);
  refused(gas.post({ action: 'taskNote', name: 'Ben', id, note: 'Hi' }), /isn't on your list/);
  refused(gas.post({ action: 'taskToggle', name: 'Max', id, done: true }), /isn't on your list/); // sign-in is by name alone, so a manager's name is no different
  assert.strictEqual(rowById(gas, id).Status, 'open');
  ok(gas.post({ action: 'taskToggle', name: 'Ana', id, done: true }));
  assert.strictEqual(rowById(gas, id)['Done By'], 'Ana');
});

/* ---------------------------------------------------------------- name validation ---- */

test('name validation: blank, unknown and inactive are refused, with a sentence', () => {
  const gas = world();
  refused(gas.get({ action: 'boot', name: '' }), /pick your name/);
  refused(gas.get({ action: 'boot' }), /pick your name/);
  refused(gas.get({ action: 'boot', name: 'Nobody' }), /staff list/);
  refused(gas.post({ action: 'clockIn', name: 'Nobody' }), /staff list/);
  refused(gas.post({ action: 'taskToggle', name: 'Nobody', id: 'x', done: true }), /staff list/);
  refused(gas.get({ action: 'availability', name: 'Nobody', weekOf: MON }), /staff list/);
  assert.strictEqual(ok(gas.get({ action: 'boot', name: '  ana ' })).me.name, 'Ana', 'spacing and case are forgiven');

  const staffRow = gas.rows('Staff').find((row) => row.Name === 'Dev');
  gas.sheet('Staff').getRange(staffRow._row, 7).setValue(false);
  refused(gas.get({ action: 'boot', name: 'Dev' }), /staff list/);
  assert.ok(!gas.get({ action: 'names' }).people.some((person) => person.name === 'Dev'));
});

test('names: by rank, managers last, and only name and type', () => {
  const gas = world();
  const reply = ok(gas.get({ action: 'names' }));
  assert.deepStrictEqual(reply.people.map((person) => person.name), ['Gus', 'Hal', 'Ivy', 'Jo', 'Ana', 'Ben', 'Cora', 'Dev', 'Max', 'Mia']);
  reply.people.forEach((person) => deepKeys(person, ['name', 'type'], person.name));
  assert.strictEqual(reply.people[0].type, 'Set');
  assert.strictEqual(reply.people[4].type, 'Flexible');
  assert.strictEqual(reply.people[8].type, 'Manager');
});

test('a bad request gets a sentence, never a stack trace', () => {
  const gas = world();
  refused(gas.get({ action: 'nope' }), /don't know/);
  refused(gas.get({ action: 'constructor' }), /don't know/);
  refused(gas.get({ action: '__proto__' }), /don't know/);
  refused(gas.get({}), /don't know/);
  refused(gas.post('this is not json'), /couldn't read/);
  refused(gas.post('[1,2]'), /couldn't read/);
  refused(gas.get({ action: 'clockIn', name: 'Ana' }), /POST/, 'writes never happen on a GET');
  assert.deepStrictEqual(gas.rows('Hours').length, 0);

  // An error we didn't plan for comes out as an apology.
  gas.context.apiNames_ = () => {
    throw new Error('Secret internal detail at Foo.bar (Api.js:12:3)');
  };
  gas.context.actionTable_ = ((real) => () => Object.assign(real(), { names: { run: gas.context.apiNames_ } }))(gas.context.actionTable_);
  const reply = gas.get({ action: 'names' });
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.error, 'Something went wrong on our end. Please try again.');
  assert.ok(gas.state.logs.some((line) => line.level === 'error' && /Secret internal detail/.test(line.text)), 'it still reaches the logs');
});

test('a reply says whether trying again could work, for the page\'s queue of saved taps', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  // A flat no: the queue can stop asking.
  assert.strictEqual('retry' in gas.post({ action: 'taskToggle', name: 'Ana', id: 'nope', done: true }), false);
  assert.strictEqual('retry' in gas.post({ action: 'clockIn', name: 'Nobody' }), false);
  // A busy moment or a Google hiccup: it keeps the tap.
  gas.state.lockBusy = true;
  assert.deepStrictEqual(gas.post({ action: 'clockIn', name: 'Ana' }), { ok: false, error: 'The site is busy right now. Please try again in a moment.', retry: true });
  gas.state.lockBusy = false;
  const realOpen = gas.state.books.get.bind(gas.state.books);
  gas.state.books.get = () => {
    throw new Error('Service Spreadsheets failed');
  };
  assert.deepStrictEqual(gas.post({ action: 'clockIn', name: 'Ana' }), { ok: false, error: 'Something went wrong on our end. Please try again.', retry: true });
  gas.state.books.get = realOpen;
  assert.strictEqual(ok(gas.post({ action: 'clockIn', name: 'Ana' })).clock.status, 'in', 'and the retry works');
});

test('a bad date from the scheduler comes out as a sentence too', () => {
  const gas = world();
  gas.context.apiNames_ = () => gas.context.addDays_('next week', 1);
  gas.context.actionTable_ = ((real) => () => Object.assign(real(), { names: { run: gas.context.apiNames_ } }))(gas.context.actionTable_);
  refused(gas.get({ action: 'names' }), /date doesn't look right/);
});

test('writes wait for the lock, and a busy site says so', () => {
  const gas = built();
  gas.state.lockBusy = true;
  refused(gas.post({ action: 'clockIn', name: 'Ana' }), /busy/);
  assert.strictEqual(ok(gas.get({ action: 'names' })).people.length, 10, 'reads still work');
  assert.deepStrictEqual(gas.rows('Hours').length, 0);
  gas.setNow(at(MON, '00:35'));
  assert.deepStrictEqual(gas.tick(), { ran: [], failed: [], busy: true }, 'and a tick just waits for the next one');
});

test('every write leaves a line in the Log tab', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  const id = `task|T01|${MON}`;
  const count = () => gas.rows('Log').length;
  const steps = [
    { action: 'saveAvailability', name: 'Ana', weekOf: NEXT_MON, hoursWanted: 4, dayHours: { Mon: 1 } },
    { action: 'timeOffAdd', name: 'Dev', from: '2026-12-01', to: '2026-12-01' },
    { action: 'taskToggle', name: 'Ana', id, done: true },
    { action: 'taskNote', name: 'Ana', id, note: 'Noted' },
    { action: 'clockIn', name: 'Ana' },
    { action: 'clockOut', name: 'Ana' },
    { action: 'hoursAdd', name: 'Ana', date: '2026-11-02', start: '09:00', end: '10:00' },
    { action: 'mgrOneOffAdd', code: CODE, title: 'Logged', weekOf: MON, minutes: 15 },
    { action: 'mgrAssign', code: CODE, id: `task|T01|${WED}`, name: 'Cora', date: WED },
    { action: 'mgrRebuild', code: CODE, weekOf: MON },
    { action: 'mgrRemind', code: CODE, weekOf: NEXT_MON },
    { action: 'mgrHoursAdd', code: CODE, name: 'Ana', date: '2026-11-03', start: '09:00', end: '10:00' },
  ];
  steps.forEach((step) => {
    const before = count();
    ok(gas.post(step));
    assert.ok(count() > before, `${step.action} left no log line`);
  });
  const line = gas.rows('Log').find((row) => row.Action === 'task done');
  assert.strictEqual(line.Who, 'Ana');
  assert.match(line.Details, /Unbox packages/);
  assert.strictEqual(Object.prototype.toString.call(line.Time), '[object Date]');
});

/* ------------------------------------------------------------------- tasks ---- */

test('taskToggle: check, uncheck, repeats change nothing, and a one-off stays in step', () => {
  const gas = built();
  gas.setNow(at(MON, '09:14'));
  const id = `task|T01|${MON}`;
  assert.deepStrictEqual(ok(gas.post({ action: 'taskToggle', name: 'Ana', id, done: true })), { ok: true, doneAt: '9:14 AM' });
  let row = rowById(gas, id);
  assert.deepStrictEqual([row.Status, row['Done By']], ['done', 'Ana']);
  assert.strictEqual(Object.prototype.toString.call(row['Done At']), '[object Date]');

  gas.setNow(at(MON, '09:30'));
  assert.strictEqual(ok(gas.post({ action: 'taskToggle', name: 'Ana', id, done: true })).doneAt, '9:14 AM', 'a retry keeps the first time');
  const boot = ok(gas.get({ action: 'boot', name: 'Ana' }));
  const task = boot.today.tasks.find((candidate) => candidate.id === id);
  assert.deepStrictEqual([task.done, task.doneAt], [true, '9:14 AM']);

  assert.strictEqual(ok(gas.post({ action: 'taskToggle', name: 'Ana', id, done: false })).doneAt, '');
  row = rowById(gas, id);
  assert.deepStrictEqual([row.Status, row['Done By'], row['Done At']], ['open', '', '']);
  refused(gas.post({ action: 'taskToggle', name: 'Ana', id: 'nope', done: true }), /can't find/);

  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Hang the sign', weekOf: MON, who: ['Ana'], day: 'Mon', minutes: 15 }));
  assert.deepStrictEqual(added.placed, { name: 'Ana', date: MON });
  ok(gas.post({ action: 'taskToggle', name: 'Ana', id: `oneoff|${added.id}`, done: true }));
  let oneOff = gas.rows('One-Offs').find((line) => line.ID === added.id);
  assert.deepStrictEqual([oneOff.Status, oneOff['Done By']], ['done', 'Ana']);
  ok(gas.post({ action: 'taskToggle', name: 'Ana', id: `oneoff|${added.id}`, done: false }));
  oneOff = gas.rows('One-Offs').find((line) => line.ID === added.id);
  assert.deepStrictEqual([oneOff.Status, oneOff['Done By'], oneOff['Done At']], ['open', '', '']);
});

test('taskClaim: only an uncovered row dated today, and nobody can take it twice', () => {
  const gas = built(['Ana']); // Tuesday has uncovered rows
  gas.setNow(at(MON, '09:00'));
  const id = `task|T01|${TUE}`;
  refused(gas.post({ action: 'taskClaim', name: 'Cora', id }), /on the day it is due/);
  gas.setNow(at(TUE, '09:00'));
  const boot = ok(gas.get({ action: 'boot', name: 'Cora' }));
  assert.ok(boot.today.openTasks.some((task) => task.id === id));
  assert.deepStrictEqual(boot.today.tasks, []);

  const claimed = ok(gas.post({ action: 'taskClaim', name: 'Cora', id }));
  deepKeys(claimed.task, ['id', 'title', 'details', 'priority', 'top', 'done', 'doneAt', 'note', 'date', 'kind', 'rolled'], 'task');
  assert.strictEqual(claimed.task.id, id);
  const row = rowById(gas, id);
  assert.deepStrictEqual([row.Name, row.Source], ['Cora', 'manual']);
  const after = ok(gas.get({ action: 'boot', name: 'Cora' }));
  assert.ok(after.today.tasks.some((task) => task.id === id));
  assert.ok(!after.today.openTasks.some((task) => task.id === id));

  ok(gas.post({ action: 'taskClaim', name: 'Cora', id })); // a retry by the same person is fine
  refused(gas.post({ action: 'taskClaim', name: 'Dev', id }), /already took/);
  refused(gas.post({ action: 'taskClaim', name: 'Dev', id: 'nope' }), /can't find/);
  assert.strictEqual(rowById(gas, id).Name, 'Cora');
});

test('tasks sort top priority first and then in task order, and a task knows its kind', () => {
  const gas = world();
  ok(save(gas, 'Cora', MON, 20, hoursEach(['Tue'], 8)));
  ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Urgent thing', priority: 'A', minutes: 15, weekOf: MON, day: 'Tue', who: ['Cora'] }));
  ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Not so urgent', priority: 'C', minutes: 15, weekOf: MON, day: 'Tue', who: ['Cora'] }));
  friday(gas);
  gas.setNow(at(TUE, '09:00'));
  const tasks = ok(gas.get({ action: 'boot', name: 'Cora' })).today.tasks;
  assert.strictEqual(tasks[0].title, 'Urgent thing');
  assert.strictEqual(tasks[0].top, true);
  assert.strictEqual(tasks[0].kind, 'oneoff');
  assert.strictEqual(tasks[1].title, 'Unbox packages');
  assert.strictEqual(tasks[1].top, false);
  assert.strictEqual(tasks[1].kind, 'recurring');
  assert.strictEqual(tasks[tasks.length - 1].priority, 'C');
  const titles = tasks.map((task) => task.title);
  assert.ok(titles.indexOf('Unbox packages') < titles.indexOf('Check what apparel needs printed'), 'task order from the sheet');

  const halTasks = ok(gas.get({ action: 'boot', name: 'Hal' })).today.tasks;
  assert.deepStrictEqual(halTasks.map((task) => [task.title.slice(0, 10), task.kind, task.top]), [['Deep bathr', 'set', true], ['Deep clean', 'set', false]]);
});

/* -------------------------------------------------------------------- one-offs ---- */

test('a one-off added to a published week is placed right away', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const minutesBefore = dayMinutes(gas, 'Ana', WED);
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Oil the rower chains', details: 'All six', priority: 'A', minutes: 30, weekOf: MON, day: 'Wed', who: [], by: 'Max' }));
  assert.deepStrictEqual(added.placed, { name: 'Ana', date: WED });
  const row = rowById(gas, `oneoff|${added.id}`);
  assert.deepStrictEqual([row.Name, row.Date, row.Day, row['One-Off ID'], row.Task, row.Details, row.Priority, row.Minutes, row.Status], ['Ana', WED, 'Wed', added.id, 'Oil the rower chains', 'All six', 'A', 30, 'open']);
  assert.strictEqual(dayMinutes(gas, 'Ana', WED), minutesBefore + 30, 'her day grew to fit it');

  const line = gas.rows('One-Offs').find((item) => item.ID === added.id);
  assert.deepStrictEqual([line['Added By'], line['Week Of'], line.Day, line.Status], ['Max', MON, 'Wed', 'open']);
  assert.deepStrictEqual([added.oneOff.assignedTo, added.oneOff.assignedDate, added.oneOff.status], ['Ana', WED, 'open']);

  gas.setNow(at(WED, '09:00'));
  assert.ok(ok(gas.get({ action: 'boot', name: 'Ana' })).today.tasks.some((task) => task.title === 'Oil the rower chains' && task.top));
});

test('a one-off too big for anyone in a published week waits uncovered and says so', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Repaint the lobby', minutes: 900, weekOf: MON, day: 'Wed' }));
  assert.deepStrictEqual(added.placed, { name: '', date: WED });
  assert.strictEqual(rowById(gas, `oneoff|${added.id}`).Name, '');
  const board = ok(gas.get({ action: 'mgrBoard', code: CODE }));
  assert.ok(board.days[2].uncovered.some((task) => task.title === 'Repaint the lobby'));
});

test('a one-off added to an unpublished week waits for the Friday build', () => {
  const gas = world();
  submit(gas);
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Wash the windows', priority: 'B', minutes: 30, weekOf: MON, day: 'Wed', who: ['Cora'], by: 'Mia' }));
  assert.strictEqual(added.placed, null);
  assert.deepStrictEqual(scheduleRows(gas), [], 'no row yet');
  assert.strictEqual(added.oneOff.assignedTo, '');
  assert.strictEqual(gas.rows('One-Offs')[0].Status, 'open');

  friday(gas);
  const row = rowById(gas, `oneoff|${added.id}`);
  assert.deepStrictEqual([row.Name, row.Date, row.Source], ['Cora', WED, 'auto']);
  assert.ok(gas.state.mail.find((mail) => mail.subject.includes('[TEST to Cora]')).htmlBody.includes('Wash the windows'));
});

test('one-offs: validation, and who can include several people or a manager', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  refused(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: '', weekOf: MON }), /what needs done/);
  refused(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'x', weekOf: 'someday' }), /pick a week/);
  refused(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'x', weekOf: '2026-11-02' }), /already over/);
  refused(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'x', weekOf: MON, priority: 'Z' }), /A, B or C/);
  refused(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'x', weekOf: MON, minutes: 0 }), /how long/);
  refused(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'x', weekOf: MON, minutes: 5000 }), /how long/);
  refused(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'x', weekOf: MON, day: 'Funday' }), /one day/);
  refused(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'x', weekOf: MON, who: ['Nobody'] }), /staff list/);
  assert.deepStrictEqual(gas.rows('One-Offs'), []);

  const defaults = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Plain', weekOf: MON }));
  assert.deepStrictEqual([defaults.oneOff.priority, defaults.oneOff.minutes, defaults.oneOff.day, defaults.oneOff.who], ['B', 30, '', []]);

  const several = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Pair job', weekOf: MON, day: 'Fri', who: ['Cora', 'Ana'], minutes: 5 }));
  assert.deepStrictEqual(several.placed, { name: 'Ana', date: FRI }, 'by rank, not by the order listed');
  assert.strictEqual(gas.rows('One-Offs').find((line) => line.ID === several.id).Who, 'Cora, Ana');

  const toManager = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Call the landlord', weekOf: MON, day: 'Tue', who: ['Max'], minutes: 15 }));
  assert.deepStrictEqual(toManager.placed, { name: 'Max', date: TUE });
  gas.setNow(at(TUE, '09:00'));
  assert.ok(ok(gas.get({ action: 'boot', name: 'Max' })).today.tasks.some((task) => task.title === 'Call the landlord'));

  const toSet = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'For a set person', weekOf: MON, who: ['Gus'], minutes: 15 }));
  assert.deepStrictEqual(toSet.placed, { name: 'Gus', date: THU });
});

test('mgrOneOffEdit: updates the one-off and its open row, and moves it when the day or person changes', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Clean the mirrors', priority: 'B', minutes: 15, weekOf: MON, day: 'Wed' }));
  const id = `oneoff|${added.id}`;
  assert.strictEqual(rowById(gas, id).Name, 'Ana');

  ok(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, title: 'Clean all the mirrors', details: 'Lobby too', priority: 'A', minutes: 30 }));
  let row = rowById(gas, id);
  assert.deepStrictEqual([row.Task, row.Details, row.Priority, row.Minutes, row.Name, row.Date], ['Clean all the mirrors', 'Lobby too', 'A', 30, 'Ana', WED]);
  const line = gas.rows('One-Offs').find((item) => item.ID === added.id);
  assert.deepStrictEqual([line.Task, line.Priority, line.Minutes], ['Clean all the mirrors', 'A', 30]);
  assert.strictEqual(dayMinutes(gas, 'Ana', WED), 115, 'her day follows the new length');

  const moved = ok(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, day: 'Sat', who: ['Cora'] }));
  assert.deepStrictEqual(moved.placed, { name: 'Cora', date: SAT });
  row = rowById(gas, id);
  assert.deepStrictEqual([row.Name, row.Date, row.Day], ['Cora', SAT, 'Sat']);
  assert.strictEqual(dayMinutes(gas, 'Ana', WED), 85, 'and she gets that time back');

  // Moved into an unpublished week: the row comes off and it waits for that Friday.
  const waiting = ok(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, weekOf: NEXT_MON }));
  assert.strictEqual(waiting.placed, null);
  assert.ok(!scheduleRows(gas).some((candidate) => candidate.ID === id));

  refused(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: 'nope', title: 'x' }), /can't find/);
  refused(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, title: '' }), /what needs done/);
  refused(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, weekOf: '2026-11-02' }), /already over/);
});

test('mgrOneOffDelete: status deleted, open rows removed, done rows kept', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const open = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Going away', weekOf: MON, day: 'Wed', minutes: 30 }));
  const done = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Already done', weekOf: MON, day: 'Mon', who: ['Cora'], minutes: 15 }));
  ok(gas.post({ action: 'taskToggle', name: 'Cora', id: `oneoff|${done.id}`, done: true }));
  const wedBefore = dayMinutes(gas, 'Ana', WED);

  ok(gas.post({ action: 'mgrOneOffDelete', code: CODE, id: open.id }));
  assert.strictEqual(gas.rows('One-Offs').find((line) => line.ID === open.id).Status, 'deleted');
  assert.ok(!scheduleRows(gas).some((row) => row.ID === `oneoff|${open.id}`));
  assert.ok(dayMinutes(gas, 'Ana', WED) < wedBefore);

  ok(gas.post({ action: 'mgrOneOffDelete', code: CODE, id: done.id }));
  assert.strictEqual(rowById(gas, `oneoff|${done.id}`).Status, 'done', 'what got done stays on the record');
  assert.ok(!ok(gas.get({ action: 'mgrBoard', code: CODE })).oneOffs.some((item) => item.id === open.id), 'and deleted ones leave the list');
  refused(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: open.id, title: 'Back again' }), /deleted/);
  ok(gas.post({ action: 'taskToggle', name: 'Cora', id: `oneoff|${done.id}`, done: false }));
  assert.strictEqual(gas.rows('One-Offs').find((line) => line.ID === done.id).Status, 'deleted', 'unchecking its row does not bring it back');
  refused(gas.post({ action: 'mgrOneOffDelete', code: CODE, id: 'nope' }), /can't find/);
});

/* -------------------------------------------------------- manager assign and rebuild ---- */

test('mgrAssign: moves a row, marks it manual, and the minutes follow on both sides', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const id = `task|T10|${MON}`; // 30 minutes on Ana's Monday
  const anaBefore = dayMinutes(gas, 'Ana', MON);
  const reply = ok(gas.post({ action: 'mgrAssign', code: CODE, id, name: 'Cora', date: TUE, by: 'Max' }));
  assert.strictEqual(reply.task.id, id);
  assert.strictEqual(reply.task.source, 'manual');
  const row = rowById(gas, id);
  assert.deepStrictEqual([row.Name, row.Date, row.Day, row.Source, row['Week Of']], ['Cora', TUE, 'Tue', 'manual', MON]);
  assert.ok(dayMinutes(gas, 'Ana', MON) < anaBefore);
  assert.strictEqual(dayMinutes(gas, 'Cora', TUE), row.Minutes);

  // Keeps its date when none is given, and an uncovered row gets a person.
  const same = ok(gas.post({ action: 'mgrAssign', code: CODE, id: `task|T01|${WED}`, name: 'Cora' }));
  assert.strictEqual(same.task.date, WED);

  // Across the week boundary, Week Of follows the date.
  gas.call('runWeekBuild_', NEXT_MON);
  ok(gas.post({ action: 'mgrAssign', code: CODE, id: `task|T01|${SAT}`, name: 'Cora', date: NEXT_MON }));
  assert.strictEqual(rowById(gas, `task|T01|${SAT}`)['Week Of'], NEXT_MON);

  refused(gas.post({ action: 'mgrAssign', code: CODE, id: 'nope', name: 'Cora', date: TUE }), /can't find/);
  refused(gas.post({ action: 'mgrAssign', code: CODE, id, name: 'Nobody', date: TUE }), /staff list/);
  refused(gas.post({ action: 'mgrAssign', code: CODE, id, name: '', date: TUE }), /pick your name/);
  refused(gas.post({ action: 'mgrAssign', code: CODE, id, name: 'Cora', date: '2026-11-01' }), /today or a later day/);
  refused(gas.post({ action: 'mgrAssign', code: CODE, id, name: 'Cora', date: 'soon' }), /pick a day/);
  ok(gas.post({ action: 'taskToggle', name: 'Cora', id, done: true }));
  refused(gas.post({ action: 'mgrAssign', code: CODE, id, name: 'Ben', date: TUE }), /already done/);
});

test('mgrRebuild: keeps manual and done rows, leaves today alone, and re-matches the rest', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const doneId = `task|T03|${WED}`; // Ana's, checked off early
  const manualId = `task|T01|${WED}`;
  const todayId = `task|T01|${MON}`;
  ok(gas.post({ action: 'taskToggle', name: 'Ana', id: doneId, done: true }));
  ok(gas.post({ action: 'mgrAssign', code: CODE, id: manualId, name: 'Dev', date: WED }));
  const doneBefore = rowById(gas, doneId);

  // She's taken off the staff list, so everything of hers still ahead has to go elsewhere.
  const staffRow = gas.rows('Staff').find((row) => row.Name === 'Ana');
  gas.sheet('Staff').getRange(staffRow._row, 7).setValue(false);

  const reply = ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON, by: 'Max' }));
  assert.ok(reply.rows > 0);
  assert.strictEqual(reply.weekOf, MON);

  const done = rowById(gas, doneId);
  assert.deepStrictEqual([done.Name, done.Status, done['Done By'], done.Date], ['Ana', 'done', 'Ana', doneBefore.Date], 'done rows stay');
  const manual = rowById(gas, manualId);
  assert.deepStrictEqual([manual.Name, manual.Source], ['Dev', 'manual'], 'manual rows stay');
  assert.strictEqual(rowById(gas, todayId).Name, 'Ana', "today's list stays with her");

  const stillAna = scheduleRows(gas).filter((row) => row.Name === 'Ana' && row.Date > MON);
  assert.deepStrictEqual(stillAna.map((row) => row.ID), [doneId], 'nothing else of hers is left ahead');
  assert.strictEqual(rowById(gas, `task|T01|${FRI}`).Name, 'Cora', 'her Friday went down the ranks');

  const ids = scheduleRows(gas).map((row) => row.ID);
  assert.strictEqual(new Set(ids).size, ids.length, 'nothing was made twice');
  assert.strictEqual(ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: MON })).published, true);
});

test('mgrRebuild: fills what is uncovered today, keeps done one-offs, and follows late submitters', () => {
  const gas = built([]); // nobody offered anything
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Rework this', weekOf: MON, minutes: 15 }));
  assert.strictEqual(added.placed.name, '');
  // Hand-edited into the sheet, so nothing has matched it yet.
  gas.sheet('Availability').appendRow([MON, 'Cora', new Date(), false, false, 20, 'Mon:8;Sat:8', 'Mon 8 hrs; Sat 8 hrs', '']);
  const reply = ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));
  assert.ok(reply.unfilled > 0);
  assert.strictEqual(rowById(gas, `task|T01|${MON}`).Name, 'Cora', 'uncovered today gets filled');
  assert.strictEqual(rowById(gas, `task|T01|${SAT}`).Name, 'Cora');
  assert.strictEqual(rowById(gas, `oneoff|${added.id}`).Name, 'Cora', 'and so does the one-off');
  assert.ok(scheduleRows(gas).some((row) => row.Name === 'Cora' && row.Date === SAT));
});

test('mgrRebuild: a row moved by hand into another week is not made again in its old week', () => {
  const gas = built();
  gas.call('runWeekBuild_', NEXT_MON);
  gas.setNow(at(MON, '10:00'));
  const moved = `task|T01|${SAT}`;
  ok(gas.post({ action: 'mgrAssign', code: CODE, id: moved, name: 'Cora', date: NEXT_MON }));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Moves too', weekOf: MON, minutes: 15, day: 'Wed' }));
  ok(gas.post({ action: 'mgrAssign', code: CODE, id: `oneoff|${added.id}`, name: 'Cora', date: NEXT_MON }));
  assert.strictEqual(gas.rows('One-Offs').find((line) => line.ID === added.id)['Week Of'], NEXT_MON, 'the one-off follows its row');

  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));
  const ids = scheduleRows(gas).map((row) => row.ID);
  assert.strictEqual(new Set(ids).size, ids.length, 'no ID is in the sheet twice');
  assert.deepStrictEqual([rowById(gas, moved).Name, rowById(gas, moved).Date], ['Cora', NEXT_MON]);

  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: NEXT_MON }));
  const again = scheduleRows(gas).map((row) => row.ID);
  assert.strictEqual(new Set(again).size, again.length);
  assert.deepStrictEqual([rowById(gas, moved).Name, rowById(gas, moved).Source], ['Cora', 'manual']);
});

test('mgrRebuild: an unpublished week before its deadline, or a finished week, is refused', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  refused(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: NEXT_MON }), /hasn't been built/);
  refused(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: '2026-11-02' }), /already over/);
  refused(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: TUE }), /start on a Monday/);
});

test('mgrRebuild: rolled rows keep their place and are not made again', () => {
  const gas = built();
  gas.setNow(at(TUE, '00:35')); // Monday's work was all missed, and some of it rolled
  gas.tick();
  const rolled = scheduleRows(gas).filter((row) => row.Source === 'carry');
  assert.ok(rolled.length > 0);
  gas.setNow(at(TUE, '06:00'));
  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));
  rolled.forEach((row) => {
    const after = rowById(gas, row.ID);
    assert.deepStrictEqual([after.Source, after['Rolled From']], ['carry', row['Rolled From']]);
  });
  const ids = scheduleRows(gas).map((row) => row.ID);
  assert.strictEqual(new Set(ids).size, ids.length, 'nothing was made twice');
});

test('mgrRemind: to everyone missing, right for before the deadline and after it', () => {
  const gas = world();
  submit(gas, ['Ana', 'Ben'], NEXT_MON);
  gas.setNow(at(MON, '10:00'));
  const reply = ok(gas.post({ action: 'mgrRemind', code: CODE, weekOf: NEXT_MON, by: 'Max' }));
  assert.deepStrictEqual(reply.sent, ['Cora', 'Dev']);
  assert.deepStrictEqual(subjects(gas), ['[TEST to Cora] Koda Operations: availability for the week of Nov 16', '[TEST to Dev] Koda Operations: availability for the week of Nov 16']);
  assert.match(gas.state.mail[0].htmlBody, /due Fri, Nov 13 at 7:00 AM/);

  gas.state.mail.length = 0;
  gas.setNow(at(FRI, '10:00'));
  ok(gas.post({ action: 'mgrRemind', code: CODE, weekOf: NEXT_MON }));
  assert.match(gas.state.mail[0].htmlBody, /deadline has passed/);
  refused(gas.post({ action: 'mgrRemind', code: CODE, weekOf: 'soon' }), /pick a week/);
});

/* ------------------------------------------------------------------- the nightly ---- */

test('nightly roll: daily missed, a task with a row today or tomorrow missed, others roll, one-offs roll', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const stays = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Same person', minutes: 15, weekOf: MON, day: 'Mon', who: ['Cora'] }));
  const moves = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Next person', minutes: 15, weekOf: MON, day: 'Mon' }));
  assert.strictEqual(rowById(gas, `oneoff|${moves.id}`).Name, 'Ana');
  const unfinishedRowCount = scheduleRows(gas).length;

  gas.setNow(at(TUE, '00:29'));
  assert.ok(!gas.tick().ran.includes('nightly'), 'not before 12:30');
  assert.strictEqual(scheduleRows(gas).filter((row) => row.Status === 'missed').length, 0);

  gas.setNow(at(TUE, '00:35'));
  assert.deepStrictEqual(gas.tick(), { ran: ['nightly'], failed: [] });
  assert.strictEqual(scheduleRows(gas).length, unfinishedRowCount, 'rolling moves rows, it never copies them');

  ['T01', 'T05', 'T07', 'T11', 'T12'].forEach((id) => {
    assert.strictEqual(rowById(gas, `task|${id}|${MON}`).Status, 'missed', `${id} is daily`);
  });
  ['T03', 'T09'].forEach((id) => {
    assert.strictEqual(rowById(gas, `task|${id}|${MON}`).Status, 'missed', `${id} has a row tomorrow`);
  });

  ['T10', 'T06'].forEach((id) => {
    const row = rowById(gas, `task|${id}|${MON}`);
    assert.deepStrictEqual([row.Status, row.Date, row.Day, row.Source, row['Rolled From']], ['open', TUE, 'Tue', 'carry', MON], id);
    assert.strictEqual(row.Name, 'Ben', "Ana isn't free Tuesday, and Ben is next");
  });

  const same = rowById(gas, `oneoff|${stays.id}`);
  assert.deepStrictEqual([same.Name, same.Date, same.Source, same['Rolled From']], ['Cora', TUE, 'carry', MON], 'she has availability today, so it stays with her');

  const next = rowById(gas, `oneoff|${moves.id}`);
  assert.deepStrictEqual([next.Status, next.Source, next['Rolled From']], ['open', 'carry', MON]);
  assert.notStrictEqual(next.Date, MON);

  assert.ok(dayMinutes(gas, 'Ben', TUE) > 100, 'his day holds what rolled');
  assert.ok(scheduleRows(gas).some((row) => row.Name === 'Cora' && row.Date === TUE));

  const again = ok(gas.get({ action: 'boot', name: 'Ben' }));
  assert.ok(again.today.tasks.find((task) => task.id === `task|T10|${MON}`).rolled);

  gas.setNow(at(TUE, '00:40'));
  assert.deepStrictEqual(gas.tick(), { ran: [], failed: [] }, 'once a night');
});

test('nightly roll: a daily task is missed even when no row of it is coming up', () => {
  const gas = built();
  gas.setNow(at(SUN, '00:35')); // Saturday's daily row, and next week isn't built yet, so nothing of that task is ahead
  assert.strictEqual(scheduleRows(gas).some((row) => row['Task ID'] === 'T01' && row.Date >= SUN), false);
  assert.deepStrictEqual(gas.tick().failed, []);
  const saturday = rowById(gas, `task|T01|${SAT}`);
  assert.deepStrictEqual([saturday.Status, saturday.Date, saturday.Source], ['missed', SAT, 'auto'], 'daily work does not pile up');
});

test('nightly roll: a done row is left alone, and a set task only rolls with nothing coming up', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  ok(gas.post({ action: 'taskToggle', name: 'Ana', id: `task|T01|${MON}`, done: true }));
  gas.setNow(at(TUE, '00:35'));
  gas.tick();
  assert.strictEqual(rowById(gas, `task|T01|${MON}`).Status, 'done');

  gas.setNow(at(WED, '00:35')); // Tuesday's set work wasn't done
  assert.deepStrictEqual(gas.tick().failed, []);
  assert.strictEqual(rowById(gas, `set|T08|${TUE}|Hal`).Status, 'missed', 'T08 has a row tomorrow, with Gus');
  const lobby = rowById(gas, `set|T14|${TUE}|Hal`);
  assert.deepStrictEqual([lobby.Status, lobby.Source, lobby['Rolled From']], ['open', 'carry', TUE], 'T14 is once a week, so it keeps rolling');
  assert.strictEqual(lobby.Date, WED);
});

test('nightly roll: a one-off pinned to a day that passed stays open and keeps going until it is done', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Keeps rolling', minutes: 15, weekOf: MON, day: 'Mon', who: ['Cora'] }));
  const id = `oneoff|${added.id}`;
  [
    [TUE, TUE],
    [WED, WED],
    [THU, THU],
  ].forEach(([night, expected]) => {
    gas.setNow(at(night, '00:35'));
    assert.deepStrictEqual(gas.tick().failed, []);
    const row = rowById(gas, id);
    assert.strictEqual(row.Date, expected);
    assert.strictEqual(row['Rolled From'], MON, 'Rolled From keeps the first date');
  });
  gas.setNow(at(THU, '10:00'));
  ok(gas.post({ action: 'taskToggle', name: 'Cora', id, done: true }));
  gas.setNow(at(FRI, '00:35'));
  gas.tick();
  assert.deepStrictEqual([rowById(gas, id).Date, rowById(gas, id).Status], [THU, 'done']);
});

test('staff replies never carry minutes, and managers still get them', () => {
  const gas = built();
  gas.setNow(at(MON, '09:05'));
  const hasMinutes = (value) => JSON.stringify(value).includes('"minutes"');
  ['Ana', 'Gus', 'Max'].forEach((name) => assert.ok(!hasMinutes(ok(gas.get({ action: 'boot', name }))), name + ' boot'));
  ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Up for grabs', minutes: 15, weekOf: MON, day: 'Mon', who: ['Dev'] }));
  const open = ok(gas.get({ action: 'boot', name: 'Dev' })).today.openTasks;
  open.forEach((task) => assert.ok(!('minutes' in task), 'an open task'));
  const board = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: MON }));
  const tasks = board.days.flatMap((day) => day.groups.flatMap((group) => group.tasks).concat(day.uncovered));
  assert.ok(tasks.length > 0);
  tasks.forEach((task) => assert.strictEqual(typeof task.minutes, 'number', task.title));
});

test('nightly: unfinished Floors stays where it is, nobody else gets it, and the managers hear once', () => {
  const gas = built();
  const id = `set|T15|${WED}|Ivy`;
  const before = rowById(gas, id);
  gas.setNow(at(THU, '00:35'));
  gas.state.mail.length = 0;
  assert.deepStrictEqual(gas.tick().failed, []);
  const after = rowById(gas, id);
  assert.deepStrictEqual([after.Status, after.Name, after.Date, after.Source, after['Rolled From']], ['missed', 'Ivy', WED, before.Source, '']);
  const alerts = gas.state.mail.filter((mail) => /Not done:/.test(mail.subject));
  assert.strictEqual(alerts.length, 1);
  assert.match(alerts[0].subject, /Floors/);
  assert.match(alerts[0].htmlBody, /Ivy/);
  assert.match(alerts[0].htmlBody, /given to anyone else/);
  const board = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: MON }));
  const shown = board.days.find((day) => day.date === WED).groups.find((group) => group.name === 'Ivy').tasks.find((task) => task.id === id);
  assert.strictEqual(shown.status, 'missed', 'Manage shows it as missed');

  gas.setNow(at(FRI, '00:35'));
  gas.state.mail.length = 0;
  gas.tick();
  assert.deepStrictEqual(rowById(gas, id).Status, 'missed');
  assert.ok(!gas.state.mail.some((mail) => /Not done/.test(mail.subject)), 'one email is enough');
  assert.strictEqual(scheduleRows(gas).filter((row) => row['Task ID'] === 'T15' && row.Date === FRI).length, 0, 'it did not move');
});

test('nightly: Floors that got checked off makes no alert, and other set work still rolls', () => {
  const gas = built();
  gas.setNow(at(WED, '10:00'));
  ok(gas.post({ action: 'taskToggle', name: 'Ivy', id: `set|T15|${WED}|Ivy`, done: true }));
  gas.setNow(at(THU, '00:35'));
  gas.state.mail.length = 0;
  gas.tick();
  assert.strictEqual(rowById(gas, `set|T15|${WED}|Ivy`).Status, 'done');
  assert.ok(!gas.state.mail.some((mail) => /Not done/.test(mail.subject)));
});

test('a week on hold: no run at the deadline, nobody late, and it builds when a manager runs it', () => {
  const gas = fridayWorld();
  ok(gas.post({ action: 'mgrHoldWeek', code: CODE, weekOf: MON }));
  gas.state.mail.length = 0;
  gas.setNow(at(LAST_FRI, '07:00'));
  assert.ok(!gas.tick().ran.includes('weekly'));
  gas.setNow(at(LAST_FRI, '09:00'));
  gas.tick();
  assert.deepStrictEqual(gas.state.mail, [], 'nothing went out');
  assert.deepStrictEqual(scheduleRows(gas), []);

  const board = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: MON }));
  assert.deepStrictEqual([board.held, board.published, board.nextWeek.deadline], [true, false, 'as soon as you can']);
  assert.deepStrictEqual(board.nextWeek.missing, ['Cora']);
  const week = ok(gas.get({ action: 'boot', name: 'Cora' })).availability.weeks.find((line) => line.weekOf === MON);
  assert.deepStrictEqual([week.held, week.past, week.deadline], [true, false, 'as soon as you can']);
  refused(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }), /on hold/);

  const saved = ok(save(gas, 'Cora', MON, 6, hoursEach(['Tue', 'Thu'], 4)));
  assert.strictEqual(saved.late, false, 'after 7 AM, and still on time');
  assert.strictEqual(gas.rows('Availability').find((row) => row.Name === 'Cora').Late, false);

  const run = ok(gas.post({ action: 'mgrRunHeldWeek', code: CODE, by: 'Max' }));
  assert.strictEqual(run.weekOf, MON);
  assert.ok(run.rows > 0);
  assert.ok(gas.state.mail.some((mail) => /schedule is out/.test(mail.subject)), 'the managers hear');
  assert.strictEqual(gas.state.properties.has('HOLD_WEEK'), false);
  const after = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: MON }));
  assert.deepStrictEqual([after.published, 'held' in after], [true, false]);
  const count = gas.state.mail.length;
  gas.setNow(at(LAST_FRI, '09:10'));
  gas.tick();
  assert.strictEqual(gas.state.mail.length, count, 'the automatic run does not repeat it');
  refused(gas.post({ action: 'mgrRunHeldWeek', code: CODE }), /No week is on hold/);
  refused(gas.post({ action: 'mgrHoldWeek', code: CODE, weekOf: MON }), /already been built/);
});

test('a week on hold: anyone still missing when it runs is not told it was due at 7 AM', () => {
  const gas = fridayWorld();
  ok(gas.post({ action: 'mgrHoldWeek', code: CODE, weekOf: MON }));
  gas.setNow(at(LAST_FRI, '12:00'));
  gas.state.mail.length = 0;
  ok(gas.post({ action: 'mgrRunHeldWeek', code: CODE }));
  const missed = gas.state.mail.find((mail) => /availability for the week/.test(mail.subject));
  assert.ok(missed);
  assert.doesNotMatch(missed.htmlBody, /7 AM/);
  assert.match(missed.htmlBody, /the schedule just went out/);
});

test('a week on hold: staff can still reach it once it starts, managers chase it, and limits hold', () => {
  const gas = fridayWorld();
  ok(gas.post({ action: 'mgrHoldWeek', code: CODE, weekOf: MON }));
  refused(gas.post({ action: 'mgrHoldWeek', code: CODE, weekOf: NEXT_MON }), /still on hold/);
  gas.setNow(at(MON, '10:00'));
  gas.tick();
  const weeks = ok(gas.get({ action: 'boot', name: 'Cora' })).availability.weeks;
  assert.strictEqual(weeks[0].weekOf, MON);
  assert.strictEqual(weeks[0].held, true);
  const board = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: MON }));
  assert.strictEqual(board.nextWeek.weekOf, MON);
  assert.deepStrictEqual(board.nextWeek.missing, ['Cora']);

  gas.setNow(at(NEXT_MON, '10:00'));
  gas.state.mail.length = 0;
  refused(gas.post({ action: 'mgrRunHeldWeek', code: CODE }), /already over/);
  assert.deepStrictEqual(gas.state.mail, [], 'nothing went out');
  assert.strictEqual(gas.state.properties.has('HOLD_WEEK'), false);
});

test('a week on hold: the Thursday reminder does not tell anyone the old deadline', () => {
  const gas = fridayWorld();
  setSetting(gas, 'thursday_heads_up', 'TRUE');
  gas.state.properties.delete('RUN_THU_' + MON);
  ok(gas.post({ action: 'mgrHoldWeek', code: CODE, weekOf: MON }));
  gas.state.mail.length = 0;
  gas.setNow(at('2026-11-05', '13:45'));
  gas.tick();
  assert.deepStrictEqual(gas.state.mail, []);
});

test('extra work written before the first week can still be found on Manage', () => {
  const gas = world();
  gas.setNow(at('2026-11-05', '11:30'));
  ok(gas.post({ action: 'extraAdd', name: 'Ana', text: 'Early bird' }));
  const board = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: '2026-11-02' }));
  assert.ok(board.weeks.some((week) => week.weekOf === '2026-11-02'));
  assert.ok(board.days.some((day) => day.extras.some((item) => item.text === 'Early bird')));
});

test('extra work: staff write it in for today, can take it back, and managers see it under that day', () => {
  const gas = built();
  gas.setNow(at(MON, '09:05'));
  refused(gas.post({ action: 'extraAdd', name: 'Ana', text: '   ' }), /what you did/);
  const nasty = '=SUM(1,2) fixed "the" door @front';
  const first = ok(gas.post({ action: 'extraAdd', name: 'Ana', text: nasty }));
  assert.deepStrictEqual(first.extras.map((item) => item.text), [nasty]);
  ok(gas.post({ action: 'extraAdd', name: 'Ana', text: nasty }));
  assert.strictEqual(gas.rows('Extra Work').length, 1, 'a retry does not double it');
  ok(gas.post({ action: 'extraAdd', name: 'Ben', text: 'Swept the lot' }));

  const boot = ok(gas.get({ action: 'boot', name: 'Ana' }));
  assert.deepStrictEqual(boot.today.extras.map((item) => item.text), [nasty], 'only their own');
  const monday = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: MON })).days.find((day) => day.date === MON);
  assert.deepStrictEqual(monday.extras.map((item) => [item.name, item.text]), [['Ana', nasty], ['Ben', 'Swept the lot']]);
  assert.strictEqual(typeof monday.extras[0].at, 'string');

  const id = first.extras[0].id;
  ok(gas.post({ action: 'extraRemove', name: 'Ben', id }));
  assert.strictEqual(gas.rows('Extra Work').length, 2, "someone else's stays");
  assert.deepStrictEqual(ok(gas.post({ action: 'extraRemove', name: 'Ana', id })).extras, []);
  assert.deepStrictEqual(gas.rows('Extra Work').map((row) => row.Name), ['Ben']);

  gas.setNow(at(TUE, '09:05'));
  assert.deepStrictEqual(ok(gas.get({ action: 'boot', name: 'Ben' })).today.extras, [], 'each day starts empty');
  assert.ok(gas.rows('Log').some((row) => row.Action === 'extra work'));
});

test('nightly roll: a one-off left over at the end of a week moves into the next one', () => {
  const gas = built();
  gas.setNow(at(SAT, '09:00'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Over the weekend', minutes: 15, weekOf: MON, day: 'Sat', who: ['Cora'] }));
  ok(save(gas, 'Cora', NEXT_MON, 20, hoursEach(['Mon'], 8)));
  gas.setNow(at('2026-11-13', '07:00')); // the next Friday run had already happened by Saturday
  gas.call('runWeekBuild_', NEXT_MON);
  gas.setNow(at(SUN, '00:35')); // nothing on Sunday for her, so it waits there uncovered
  gas.tick();
  const sunday = rowById(gas, `oneoff|${added.id}`);
  assert.deepStrictEqual([sunday.Date, sunday.Name], [SUN, ''], 'she offered nothing on Sunday');

  gas.setNow(at(NEXT_MON, '00:35'));
  assert.deepStrictEqual(gas.tick().failed, []);
  const monday = rowById(gas, `oneoff|${added.id}`);
  assert.deepStrictEqual([monday.Date, monday.Name, monday['Week Of']], [NEXT_MON, 'Cora', NEXT_MON]);
  assert.strictEqual(monday['Rolled From'], SAT);
  assert.strictEqual(gas.rows('One-Offs').find((line) => line.ID === added.id)['Week Of'], NEXT_MON);
  assert.ok(ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: NEXT_MON })).oneOffs.some((item) => item.id === added.id));
});

test('nightly: any entry from before today with no Out gets flagged, and only those', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  ok(gas.post({ action: 'clockIn', name: 'Ben' }));
  gas.setNow(at(MON, '10:00'));
  ok(gas.post({ action: 'clockOut', name: 'Ben' }));
  gas.setNow(at(TUE, '00:35'));
  ok(gas.post({ action: 'clockIn', name: 'Cora' })); // on the clock today, so not stale
  gas.tick();
  const flags = Object.fromEntries(gas.rows('Hours').map((row) => [row.Name, row.Flag]));
  assert.deepStrictEqual(flags, { Ana: 'missing', Ben: '', Cora: '' });
  const report = ok(gas.get({ action: 'mgrHours', code: CODE, month: '2026-11' }));
  assert.strictEqual(report.totalIssues, 1);
  assert.strictEqual(report.people.find((person) => person.name === 'Ana').issues, 1);
});

/* ------------------------------------------------------------------- the monthly ---- */

test('monthly: emails last month once, on the 1st at 7 AM, with totals and what needs a fix', () => {
  const gas = world();
  gas.setNow(at('2026-11-10', '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  gas.setNow(at('2026-11-10', '11:30'));
  ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  gas.setNow(at('2026-11-11', '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ben' })); // and never clocks out
  gas.state.mail.length = 0;

  gas.setNow(at('2026-12-01', '06:59'));
  gas.tick();
  assert.ok(!subjects(gas).some((subject) => /November hours/.test(subject)), 'not before 7 AM');

  gas.setNow(at('2026-12-01', '07:00'));
  const first = gas.tick();
  assert.ok(first.ran.includes('monthly'));
  const monthly = gas.state.mail.filter((mail) => /November hours/.test(mail.subject));
  assert.strictEqual(monthly.length, 1);
  assert.strictEqual(monthly[0].subject, '[TEST to Managers] November hours');
  assert.match(monthly[0].htmlBody, /<td[^>]*>Ana<\/td><td[^>]*>2\.5<\/td>/);
  assert.match(monthly[0].htmlBody, /Ben: Wed, Nov 11, clocked in 9:00 AM, no clock-out/);

  gas.setNow(at('2026-12-01', '07:05'));
  gas.tick();
  gas.setNow(at('2026-12-15', '07:05'));
  gas.tick();
  assert.strictEqual(gas.state.mail.filter((mail) => /November hours/.test(mail.subject)).length, 1, 'once');

  gas.setNow(at('2027-01-01', '07:00'));
  gas.tick();
  assert.strictEqual(gas.state.mail.filter((mail) => /December hours/.test(mail.subject)).length, 1, 'then the next month, also once');
});

test('monthly: says nothing about a month from before the first week', () => {
  const gas = world();
  gas.setNow(at('2026-11-05', '10:05'));
  gas.tick();
  assert.deepStrictEqual(gas.state.mail, []);
  assert.strictEqual(gas.state.properties.get('RUN_MONTH'), '2026-11');
});

/* ---------------------------------------------------------- the manager code ---- */

test('every manager action needs the code', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const reads = ['mgrCheck', 'mgrBoard', 'mgrHours'];
  const writes = ['mgrOneOffAdd', 'mgrOneOffEdit', 'mgrOneOffDelete', 'mgrAssign', 'mgrRebuild', 'mgrRemind', 'mgrHoursAdd', 'mgrHoursEdit', 'mgrHoursDelete'];
  const snapshot = JSON.stringify([gas.rows('Schedule'), gas.rows('One-Offs'), gas.rows('Hours')]);
  reads.forEach((action) => refused(gas.get({ action, code: 'wrong' }), /manager code/));
  reads.concat(writes).forEach((action) => {
    refused(gas.post({ action, code: 'wrong', title: 'x', weekOf: MON, id: `task|T01|${MON}`, name: 'Cora' }), /manager code/);
    refused(gas.post({ action, title: 'x', weekOf: MON, id: `task|T01|${MON}`, name: 'Cora' }), /manager code/);
  });
  assert.strictEqual(JSON.stringify([gas.rows('Schedule'), gas.rows('One-Offs'), gas.rows('Hours')]), snapshot);
  assert.deepStrictEqual(ok(gas.get({ action: 'mgrCheck', code: CODE })), { ok: true });
  assert.deepStrictEqual(ok(gas.post({ action: 'mgrCheck', code: CODE })), { ok: true }, 'reads work as POST too, which keeps the code out of the URL');
});

test('8 wrong tries in 15 minutes locks that action for everyone for 15 minutes', () => {
  const gas = built();
  const start = Date.parse(at(MON, '10:00'));
  gas.setNow(start);
  for (let i = 1; i <= 7; i++) refused(gas.get({ action: 'mgrCheck', code: 'wrong' }), /isn't right/);
  ok(gas.get({ action: 'mgrCheck', code: CODE })); // the right code still works, and doesn't wipe the count
  refused(gas.get({ action: 'mgrCheck', code: 'wrong' }), /Too many wrong tries/);
  refused(gas.get({ action: 'mgrCheck', code: CODE }), /Too many wrong tries/);
  ok(gas.get({ action: 'mgrBoard', code: CODE })); // that action only
  gas.setNow(start + 14 * 60000);
  refused(gas.get({ action: 'mgrCheck', code: CODE }), /Too many wrong tries/);
  gas.setNow(start + 16 * 60000);
  ok(gas.get({ action: 'mgrCheck', code: CODE }));
});

test('wrong tries spread beyond 15 minutes do not add up', () => {
  const gas = built();
  const start = Date.parse(at(MON, '10:00'));
  for (let i = 0; i < 20; i++) {
    gas.setNow(start + i * 5 * 60000);
    refused(gas.get({ action: 'mgrCheck', code: 'wrong' }), /isn't right/);
  }
  ok(gas.get({ action: 'mgrCheck', code: CODE }));
});

/* ------------------------------------------------------------------ manager views ---- */

test('mgrBoard: has the documented shape and the right numbers', () => {
  const gas = built(['Ana', 'Ben', 'Dev']); // Cora hasn't submitted, Saturday is uncovered
  gas.setNow(at(MON, '10:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  ok(gas.post({ action: 'taskToggle', name: 'Ana', id: `task|T01|${MON}`, done: true }));
  ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Listed here', weekOf: MON, minutes: 15, by: 'Max' }));
  ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: SUN, to: SUN }));
  ok(save(gas, 'Ana', NEXT_MON, 4, { Mon: 1 }));

  const board = ok(gas.get({ action: 'mgrBoard', code: CODE }));
  deepKeys(board, ['ok', 'weekOf', 'label', 'published', 'builtAt', 'weeks', 'onClock', 'days', 'people', 'nextWeek', 'oneOffs', 'staffNames'], 'mgrBoard');
  assert.strictEqual(board.weekOf, MON);
  assert.strictEqual(board.label, 'Nov 9 - 15');
  assert.strictEqual(board.published, true);
  assert.strictEqual(board.builtAt, 'Fri, Nov 6 at 7:00 AM');
  assert.ok(board.weeks.some((week) => week.weekOf === MON && week.label === 'Nov 9 - 15'));
  assert.ok(board.weeks.some((week) => week.weekOf === NEXT_MON));
  assert.deepStrictEqual(board.onClock, [{ name: 'Ana', since: '10:00 AM' }]);
  assert.strictEqual(board.days.length, 7);

  const monday = board.days[0];
  deepKeys(monday, ['date', 'label', 'closed', 'groups', 'uncovered', 'extras'], 'board day');
  assert.strictEqual(monday.label, 'Mon, Nov 9');
  assert.deepStrictEqual(monday.groups.map((group) => group.name), ['Ana']);
  deepKeys(monday.groups[0], ['name', 'tasks'], 'board group');
  const doneTask = monday.groups[0].tasks.find((task) => task.id === `task|T01|${MON}`);
  assert.strictEqual(doneTask.doneBy, 'Ana');
  assert.strictEqual(doneTask.done, true);
  assert.ok(board.days[5].uncovered.length > 0, 'nobody offered Saturday');
  assert.deepStrictEqual(board.days[3].groups.map((group) => group.name), ['Gus', 'Ben'], 'by rank');

  const person = (name) => board.people.find((line) => line.name === name);
  board.people.forEach((line) => deepKeys(line, ['name', 'rank', 'type', 'wanted', 'assignedMin', 'doneCount', 'taskCount', 'loggedHours', 'avail', 'submittedAt', 'late', 'notes', 'off'], line.name));
  assert.strictEqual(person('Ana').rank, 5);
  assert.strictEqual(person('Ana').wanted, 6);
  assert.ok(person('Ana').assignedMin > 300);
  assert.strictEqual(person('Ana').doneCount, 1);
  assert.ok(person('Ana').taskCount > 1);
  assert.strictEqual(person('Ana').avail, 'submitted');
  assert.strictEqual(person('Ana').submittedAt, 'Thu, Nov 5 at 10:00 AM');
  assert.strictEqual(person('Cora').avail, 'missing');
  assert.strictEqual(person('Cora').wanted, null);
  assert.strictEqual(person('Gus').avail, 'set');
  assert.deepStrictEqual(person('Gus').off, ['Sun, Nov 15']);
  assert.ok(!person('Max'), "a manager with nothing this week isn't in the list");

  assert.deepStrictEqual(board.nextWeek, { weekOf: NEXT_MON, deadline: 'Fri, Nov 13 at 7:00 AM', missing: ['Ben', 'Cora', 'Dev'] });
  assert.ok(board.oneOffs.some((item) => item.title === 'Listed here' && item.addedBy === 'Max'));
  assert.deepStrictEqual(board.staffNames, ['Gus', 'Hal', 'Ivy', 'Jo', 'Ana', 'Ben', 'Cora', 'Dev', 'Max', 'Mia']);

  const nextWeek = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: NEXT_MON }));
  assert.strictEqual(nextWeek.published, false);
  assert.strictEqual(nextWeek.builtAt, '');
  assert.deepStrictEqual(nextWeek.days[0].groups, []);
  refused(gas.get({ action: 'mgrBoard', code: CODE, weekOf: TUE }), /start on a Monday/);
  assert.ok(!/@/.test(JSON.stringify(board).replace(/"since"/g, '')), 'no email addresses here either');
});

test('mgrHours: per person totals, issues, months, and it matches the sheet\'s rounding', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  gas.setNow(at(MON, '11:30'));
  ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-10-20', start: '09:00', end: '09:20' }));
  ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-10-21', start: '09:00', end: '09:20' }));
  gas.setNow(at(TUE, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ben' }));
  gas.setNow(at(WED, '00:35'));
  gas.tick();

  const report = ok(gas.get({ action: 'mgrHours', code: CODE, month: '2026-11' }));
  deepKeys(report, ['ok', 'month', 'label', 'months', 'people', 'totalIssues'], 'mgrHours');
  assert.strictEqual(report.label, 'November 2026');
  assert.deepStrictEqual(report.months, [{ month: '2026-11', label: 'November 2026' }, { month: '2026-10', label: 'October 2026' }]);
  const ana = report.people.find((person) => person.name === 'Ana');
  deepKeys(ana, ['name', 'total', 'shifts', 'issues', 'entries'], 'mgrHours person');
  assert.deepStrictEqual([ana.total, ana.shifts, ana.issues, ana.entries.length], [2.5, 1, 0, 1]);
  const ben = report.people.find((person) => person.name === 'Ben');
  assert.deepStrictEqual([ben.total, ben.shifts, ben.issues], [0, 1, 1]);
  assert.strictEqual(report.totalIssues, 1);
  assert.ok(report.people.some((person) => person.name === 'Gus' && person.shifts === 0), 'staff with nothing still show up');
  assert.ok(!report.people.some((person) => person.name === 'Max'), 'managers only with entries');

  const october = ok(gas.get({ action: 'mgrHours', code: CODE, month: '2026-10' }));
  assert.strictEqual(october.people.find((person) => person.name === 'Ana').total, 0.66, '0.33 and 0.33: the same sum the sheet adds up');
  assert.strictEqual(ok(gas.get({ action: 'mgrHours', code: CODE })).month, '2026-11', 'this month by default');
  refused(gas.get({ action: 'mgrHours', code: CODE, month: 'November' }), /pick a month/);
});

/* ------------------------------------------------------------------- boot shape ---- */

const TASK_KEYS = ['id', 'title', 'details', 'priority', 'top', 'done', 'doneAt', 'note', 'date', 'kind', 'rolled'];
const ENTRY_KEYS = ['id', 'date', 'dayLabel', 'in', 'out', 'hours', 'flag', 'note'];

function checkWeek(week, label) {
  deepKeys(week, ['weekOf', 'label', 'published', 'days'], label);
  assert.strictEqual(typeof week.weekOf, 'string');
  assert.strictEqual(typeof week.published, 'boolean');
  assert.strictEqual(week.days.length, 7);
  week.days.forEach((day) => {
    deepKeys(day, ['date', 'label', 'tasks', 'off', 'closed'], `${label} day`);
    day.tasks.forEach((task) => deepKeys(task, TASK_KEYS, 'week task'));
    assert.strictEqual(typeof day.off, 'boolean');
    assert.strictEqual(typeof day.closed, 'string');
  });
}

function checkBootShape(boot) {
  deepKeys(boot, ['ok', 'now', 'me', 'today', 'clock', 'week', 'availability', 'timeOff', 'hours'], 'boot');
  deepKeys(boot.now, ['iso', 'date', 'day', 'label', 'hour', 'minute'], 'now');
  deepKeys(boot.me, ['name', 'type', 'setDays', 'manager'], 'me');
  deepKeys(boot.today, ['date', 'closed', 'tasks', 'openTasks', 'next', 'extras'], 'today');
  if (boot.today.next) deepKeys(boot.today.next, ['date', 'label', 'count'], 'next');
  boot.today.tasks.concat(boot.today.openTasks).forEach((task) => deepKeys(task, TASK_KEYS, 'task'));
  deepKeys(boot.clock, ['status', 'entry', 'stale'], 'clock');
  if (boot.clock.entry) deepKeys(boot.clock.entry, ENTRY_KEYS, 'clock entry');
  boot.clock.stale.forEach((entry) => deepKeys(entry, ENTRY_KEYS, 'stale entry'));
  deepKeys(boot.week, ['thisWeek', 'nextWeek'], 'week');
  checkWeek(boot.week.thisWeek, 'thisWeek');
  checkWeek(boot.week.nextWeek, 'nextWeek');
  deepKeys(boot.availability, ['weeks'], 'availability');
  assert.strictEqual(boot.availability.weeks.length, 6, 'the next 6 Mondays');
  boot.availability.weeks.forEach((week) => deepKeys(week, ['weekOf', 'label', 'deadline', 'past', 'status', 'late', 'hoursWanted'], 'availability week'));
  boot.timeOff.forEach((off) => deepKeys(off, ['id', 'from', 'to', 'label', 'note'], 'timeOff'));
  deepKeys(boot.hours, ['monthLabel', 'monthTotal', 'lastMonthLabel', 'lastMonthTotal', 'entries'], 'hours');
  boot.hours.entries.forEach((entry) => deepKeys(entry, ENTRY_KEYS, 'hours entry'));
}

test('boot shape matches section 8 exactly, with values in the documented forms', () => {
  const gas = built();
  ok(save(gas, 'Ana', NEXT_MON, 6, { Mon: 1 }));
  gas.setNow(at(MON, '09:02'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  ok(gas.post({ action: 'taskToggle', name: 'Ana', id: `task|T05|${MON}`, done: true }));
  const off = ok(gas.post({ action: 'timeOffAdd', name: 'Ana', from: THU, to: THU, note: 'Dentist' }));

  const boot = ok(gas.get({ action: 'boot', name: 'Ana' }));
  checkBootShape(boot);

  assert.deepStrictEqual(boot.now, { iso: '2026-11-09T09:02:00-07:00', date: MON, day: 'Mon', label: 'Monday, November 9', hour: 9, minute: 2 });
  assert.deepStrictEqual(boot.me, { name: 'Ana', type: 'Flexible', setDays: [], manager: false });
  assert.strictEqual(boot.today.date, MON);
  assert.strictEqual(boot.today.closed, '');
  assert.deepStrictEqual(boot.today.next, { date: WED, label: 'Wed, Nov 11', count: 7 });

  const task = boot.today.tasks.find((candidate) => candidate.id === `task|T05|${MON}`);
  assert.deepStrictEqual(task, {
    id: `task|T05|${MON}`,
    title: 'Unload dishwasher and load dirty dishes',
    details: 'Switch the sign to clean or dirty',
    priority: 'B',
    top: false,
    done: true,
    doneAt: '9:02 AM',
    note: '',
    date: MON,
    kind: 'recurring',
    rolled: false,
  });

  assert.strictEqual(boot.clock.status, 'in');
  assert.deepStrictEqual(boot.clock.entry, { id: boot.clock.entry.id, date: MON, dayLabel: 'Mon, Nov 9', in: '9:02 AM', out: '', hours: null, flag: '', note: '' });

  const thisWeek = boot.week.thisWeek;
  assert.deepStrictEqual([thisWeek.weekOf, thisWeek.label, thisWeek.published], [MON, 'Nov 9 - 15', true]);
  assert.strictEqual(thisWeek.days[0].label, 'Mon, Nov 9');
  assert.strictEqual(thisWeek.days[3].off, true);
  const nextWeek = boot.week.nextWeek;
  assert.deepStrictEqual([nextWeek.weekOf, nextWeek.label, nextWeek.published], [NEXT_MON, 'Nov 16 - 22', false]);
  assert.deepStrictEqual(nextWeek.days[0].tasks, []);

  assert.deepStrictEqual(boot.availability.weeks[0], { weekOf: NEXT_MON, label: 'Nov 16 - 22', deadline: 'Fri, Nov 13 at 7:00 AM', past: false, status: 'submitted', late: false, hoursWanted: 6 });
  assert.deepStrictEqual(boot.availability.weeks[1], { weekOf: '2026-11-23', label: 'Nov 23 - 29', deadline: 'Fri, Nov 20 at 7:00 AM', past: false, status: 'missing', late: false, hoursWanted: null });
  assert.deepStrictEqual(boot.availability.weeks.map((week) => week.weekOf), [NEXT_MON, '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21']);

  assert.deepStrictEqual(boot.timeOff, [{ id: off.id, from: THU, to: THU, label: 'Nov 12', note: 'Dentist' }]);
  assert.deepStrictEqual([boot.hours.monthLabel, boot.hours.monthTotal, boot.hours.lastMonthLabel, boot.hours.lastMonthTotal], ['November', 0, 'October', 0]);
  assert.deepStrictEqual(boot.hours.entries[0].in, '9:02 AM');
});

test('boot shape: the same for set staff, managers, and every other state', () => {
  const gas = resetWorld();
  ['Ana', 'Ben', 'Cora', 'Dev', 'Gus', 'Hal', 'Ivy', 'Jo', 'Max', 'Mia'].forEach((name) => checkBootShape(ok(gas.get({ action: 'boot', name }))));
  const gus = ok(gas.get({ action: 'boot', name: 'Gus' }));
  assert.deepStrictEqual(gus.me, { name: 'Gus', type: 'Set', setDays: ['Thu', 'Fri', 'Sun'], manager: false });
  assert.deepStrictEqual(gus.today.next, { date: FRI, label: 'Fri, Nov 13', count: 1 }, 'out Thursday, so Friday is next');
  assert.strictEqual(ok(gas.get({ action: 'boot', name: 'Max' })).me.manager, true);
  const cora = ok(gas.get({ action: 'boot', name: 'Cora' }));
  assert.deepStrictEqual(cora.clock.stale.map((entry) => entry.flag), ['missing']);
  const ana = ok(gas.get({ action: 'boot', name: 'Ana' }));
  assert.ok(ana.today.tasks.length > 0);
  assert.ok(ana.today.tasks[0].top, 'the top priority one-off is first');
  assert.ok(ana.today.openTasks.some((task) => task.title === 'Power wash the back patio'));
  assert.ok(ana.hours.lastMonthTotal > 0);
  assert.ok(ana.hours.monthTotal > 0);
  assert.ok(ana.week.nextWeek.published);
  assert.ok(!ok(gas.get({ action: 'boot', name: 'Dev' })).today.next, 'Dev has nothing coming up');
});

test('availability weeks: a Saturday sees the coming week as past due, and Monday moves on', () => {
  const gas = world();
  gas.setNow(at('2026-11-07', '10:00'));
  let weeks = ok(gas.get({ action: 'boot', name: 'Ana' })).availability.weeks;
  assert.strictEqual(weeks[0].weekOf, MON);
  assert.strictEqual(weeks[0].past, true);
  assert.strictEqual(weeks[1].past, false);
  gas.setNow(at(MON, '10:00'));
  weeks = ok(gas.get({ action: 'boot', name: 'Ana' })).availability.weeks;
  assert.strictEqual(weeks[0].weekOf, NEXT_MON, 'the next Monday, never today');
  ok(gas.post({ action: 'saveAvailability', name: 'Ana', weekOf: '2026-11-23', none: true }));
  weeks = ok(gas.get({ action: 'boot', name: 'Ana' })).availability.weeks;
  assert.deepStrictEqual([weeks[1].status, weeks[1].hoursWanted], ['none', 0]);
});

/* ---------------------------------------------------------------------- setup ---- */

test('setup: lays out every tab, with frozen bold headers and the seed data', () => {
  const gas = world();
  const book = gas.book();
  const expected = ['Staff', 'Tasks', 'One-Offs', 'Availability', 'Time Off', 'Schedule', 'Hours', 'Monthly Hours', 'Log', 'Settings', 'Closed Days', 'Extra Work'];
  assert.deepStrictEqual(book.getSheets().map((sheet) => sheet.getName()).sort(), expected.slice().sort());
  assert.strictEqual(book.getSheetByName('Sheet1'), null, 'the blank first tab is gone');
  assert.strictEqual(book.getSpreadsheetTimeZone(), 'America/Denver');
  expected.filter((tab) => tab !== 'Monthly Hours').forEach((tab) => assert.strictEqual(book.getSheetByName(tab).getFrozenRows(), 1, tab));

  assert.deepStrictEqual(book.getSheetByName('Schedule').getRange(1, 1, 1, 17).getValues()[0], ['ID', 'Week Of', 'Date', 'Day', 'Name', 'Task ID', 'One-Off ID', 'Task', 'Details', 'Priority', 'Minutes', 'Source', 'Status', 'Done At', 'Done By', 'Note', 'Rolled From']);

  const tasks = gas.rows('Tasks');
  assert.strictEqual(tasks.length, 15);
  assert.deepStrictEqual(tasks[0].ID, 'T08');
  assert.strictEqual(tasks[0].Days, 'Set');
  assert.strictEqual(tasks[3].Days, 'Mon, Tue, Wed, Thu, Fri, Sat', 'Mon-Sat is stored as the full list');
  assert.strictEqual(tasks[0].Priority, 'A+++++', 'the plusses survive');

  const closed = gas.rows('Closed Days');
  assert.deepStrictEqual([closed[0].Date, closed[0].Note], ['2026-11-26', 'Thanksgiving']);

  const settings = Object.fromEntries(gas.rows('Settings').map((row) => [row.Key, row.Value]));
  assert.deepStrictEqual(settings, {
    live: 'FALSE',
    manager_emails: 'max@example.com, mia@example.com',
    reply_to: 'reply@example.com',
    test_email: 'test@example.com',
    site_url: 'https://koda-crossfit.github.io/operations/',
    first_week: '2026-11-09',
    thursday_heads_up: 'FALSE',
  });

  assert.strictEqual(gas.state.properties.get('MANAGER_CODE'), CODE);
  assert.strictEqual(gas.state.properties.get('SHEET_ID'), book.getId());
  const triggers = gas.state.triggers;
  assert.strictEqual(triggers.length, 1);
  assert.deepStrictEqual([triggers[0].handler, triggers[0].kind, triggers[0].minutes], ['tick', 'time', 5]);
});

test('setup: staff come from the source tab with set tasks mapped, and managers from the request', () => {
  const gas = world();
  const staff = Object.fromEntries(gas.rows('Staff').map((row) => [row.Name, row]));
  assert.deepStrictEqual([staff.Gus.Rank, staff.Gus.Email, staff.Gus.Type, staff.Gus['Set Days'], staff.Gus['Set Tasks']], [1, 'gus@example.com', 'Set', 'Thu, Fri, Sun', 'T08']);
  assert.deepStrictEqual([staff.Hal.Type, staff.Hal['Set Days'], staff.Hal['Set Tasks']], ['Set', 'Tue', 'T08, T14']);
  assert.deepStrictEqual([staff.Ivy.Type, staff.Ivy['Set Days'], staff.Ivy['Set Tasks']], ['Set', 'Wed', 'T15']);
  assert.deepStrictEqual([staff.Jo.Type, staff.Jo['Set Days'], staff.Jo['Set Tasks']], ['Set', 'Sun', 'T15']);
  assert.deepStrictEqual([staff.Ana.Rank, staff.Ana.Type, staff.Ana['Set Days'], staff.Ana['Set Tasks']], [5, 'Flexible', '', '']);
  assert.deepStrictEqual([staff.Max.Rank, staff.Max.Email, staff.Max.Type, staff.Max.Active], ['', 'max@example.com', 'Manager', true]);
  assert.strictEqual(staff.Gus.Notes, 'deep cleaning lobby, kitchen, and bathrooms', "the original words stay nearby");
});

test('setup: reads messy source sheets sensibly, and warns about what it could not use', () => {
  const gas = createGas();
  gas.setNow(BEFORE_DEADLINE);
  const source = gas.addFakeSource([
    [1, 'Una', 'una@example.com', 'Thursday, Friday and Sunday', 'Deep cleaning'],
    [2, 'Vic', '', 'Tuesdays', 'deep cleaning lobby, kitchen, and bathrooms'],
    [3, 'Wes', 'not-an-email', 'Mon-Wed', 'something else entirely'],
    [4, 'Xia', 'xia@example.com', 'Tue, Thu', 'deep clean'],
    [5, 'Yan', 'yan@example.com', 'Wed', 'T15, T02@Wed'],
    ['', '', '', '', ''],
    [6, 'Zoe', 'zoe@example.com', '', ''],
  ]);
  const reply = ok(gas.post({ action: 'adminSetup', code: CODE, sourceSheetId: source, sheetId: gas.createBook(), managers: [{ name: 'Max', email: 'max@example.com' }, { name: 'Mia', email: 'bad' }], testEmail: 'test@example.com' }));
  const staff = Object.fromEntries(gas.rows('Staff').map((row) => [row.Name, row]));
  assert.deepStrictEqual([staff.Una['Set Days'], staff.Una['Set Tasks']], ['Thu, Fri, Sun', 'T08']);
  assert.deepStrictEqual([staff.Vic['Set Days'], staff.Vic['Set Tasks']], ['Tue', 'T08, T14']);
  assert.deepStrictEqual([staff.Wes['Set Days'], staff.Wes['Set Tasks'], staff.Wes.Email], ['Mon, Tue, Wed', '', '']);
  assert.deepStrictEqual([staff.Xia['Set Tasks']], ['T08, T14@Tue'], 'the once-a-week task stays on Tuesday');
  assert.strictEqual(staff.Yan['Set Tasks'], 'T15, T02@Wed', 'IDs typed directly are kept');
  assert.strictEqual(staff.Zoe.Type, 'Flexible');
  assert.strictEqual(staff.Mia.Email, '');
  assert.strictEqual(gas.rows('Staff').length, 8);
  const warnings = reply.warnings.join(' ');
  assert.match(warnings, /Vic has no email/);
  assert.ok(!/days weren't recognized/.test(warnings), 'all of these were readable');
  assert.match(warnings, /Wes's email doesn't look right/);
  assert.match(warnings, /Wes has set days but no set tasks/);
  assert.match(warnings, /Mia's email doesn't look right/);
  assert.ok(!/@/.test(reply.warnings.filter((line) => !/^Wes|^Mia/.test(line)).join('')), 'warnings name people, not addresses');
});

test('setup: days it can\'t read get a warning, and someone on both lists counts as a manager', () => {
  const gas = createGas();
  gas.setNow(BEFORE_DEADLINE);
  const source = gas.addFakeSource([
    [1, 'Una', 'una@example.com', 'M/W/F', 'Floors'],
    [2, 'Max', 'max.staff@example.com', '', ''],
  ]);
  const reply = ok(gas.post({ action: 'adminSetup', code: CODE, sourceSheetId: source, sheetId: gas.createBook(), managers: fakeManagers(), testEmail: 'test@example.com' }));
  assert.match(reply.warnings.join(' '), /Una's days weren't recognized/);
  const staff = Object.fromEntries(gas.rows('Staff').map((row) => [row.Name, row]));
  assert.strictEqual(staff.Una.Type, 'Flexible');
  assert.deepStrictEqual([staff.Max.Type, staff.Max.Email, staff.Max.Rank], ['Manager', 'max@example.com', '']);
  assert.strictEqual(gas.rows('Staff').length, 3, 'one row each');
});

test('setup: running it again wipes nothing and duplicates nothing', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  setSetting(gas, 'live', 'TRUE');
  setSetting(gas, 'test_email', 'changed@example.com');
  // A manager reworded a task and dropped another.
  const task = gas.rows('Tasks').find((row) => row.ID === 'T01');
  gas.sheet('Tasks').getRange(task._row, 2).setValue('Unbox the packages');
  gas.sheet('Monthly Hours').getRange(1, 2).setValue(new Date(2026, 0, 1));
  const counts = () => Object.fromEntries(['Staff', 'Tasks', 'Availability', 'Schedule', 'Hours', 'Settings', 'Closed Days'].map((tab) => [tab, gas.rows(tab).length]));
  const before = counts();
  const scheduleBefore = snapshotRows(gas, () => true);
  const triggersBefore = gas.state.triggers.length;

  const source = gas.addFakeSource();
  const reply = ok(gas.post({ action: 'adminSetup', code: CODE, sourceSheetId: source, managers: fakeManagers() }));
  assert.deepStrictEqual(reply.staffAdded, []);
  assert.strictEqual(reply.tasksSeeded, 0);
  assert.strictEqual(reply.closedDaysSeeded, 0);
  assert.strictEqual(reply.monthlyHoursMade, false);
  assert.deepStrictEqual(counts(), before);
  assert.deepStrictEqual(snapshotRows(gas, () => true), scheduleBefore);
  assert.strictEqual(gas.state.triggers.length, triggersBefore, 'the old trigger was replaced, not added to');

  const settings = Object.fromEntries(gas.rows('Settings').map((row) => [row.Key, row.Value]));
  assert.strictEqual(settings.live, 'TRUE', 'a setting a person changed stays changed');
  assert.strictEqual(settings.test_email, 'changed@example.com');
  assert.strictEqual(gas.rows('Tasks').find((row) => row.ID === 'T01').Task, 'Unbox the packages');
  assert.strictEqual(new Date(gas.sheet('Monthly Hours').getRange(1, 2).getValue()).getMonth(), 0, 'the month a person typed stays');
  assert.strictEqual(gas.rows('Hours').length, 1);
  assert.strictEqual(gas.state.properties.get('MANAGER_CODE'), CODE);
});

test('setup: a re-run adds new people, fills a blank email, adds a missing column, and overwrites nothing else', () => {
  const gas = world();
  const blankEmailRow = gas.rows('Staff').find((row) => row.Name === 'Cora');
  gas.sheet('Staff').getRange(blankEmailRow._row, 3).setValue('');
  const benRow = gas.rows('Staff').find((row) => row.Name === 'Ben');
  gas.sheet('Staff').getRange(benRow._row, 3).setValue('kept@example.com');
  // Someone deleted a column.
  const headers = gas.sheet('Log').getRange(1, 1, 1, 4).getValues()[0];
  gas.sheet('Log').getRange(1, headers.indexOf('Details') + 1).setValue('');

  const source = gas.addFakeSource([
    [5, 'Ana', 'ana@example.com', '', ''],
    [6, 'Ben', 'different@example.com', '', ''],
    [7, 'Cora', 'cora.new@example.com', '', ''],
    [9, 'Newt', 'newt@example.com', '', ''],
  ]);
  const reply = ok(gas.post({ action: 'adminSetup', code: CODE, sourceSheetId: source, managers: fakeManagers() }));
  assert.deepStrictEqual(reply.staffAdded, ['Newt']);
  assert.deepStrictEqual(reply.emailsFilled, ['Cora']);
  const staff = Object.fromEntries(gas.rows('Staff').map((row) => [row.Name, row]));
  assert.strictEqual(staff.Cora.Email, 'cora.new@example.com');
  assert.strictEqual(staff.Ben.Email, 'kept@example.com', "an email that's already there is left alone");
  assert.strictEqual(staff.Newt.Type, 'Flexible');
  assert.ok(gas.sheet('Log').getRange(1, 1, 1, 5).getValues()[0].includes('Details'), 'the column is back');
  assert.ok(gas.rows('Log').some((row) => /adminSetup/.test(row.Action) && /Added 1 people/.test(row.Details)));
});

test('setup: needs the code once it is set, with the same limit, and bad IDs get a sentence', () => {
  const gas = world();
  refused(gas.post({ action: 'adminSetup', code: 'wrong' }), /manager code/);
  refused(gas.post({ action: 'adminSetup' }), /manager code/);
  assert.strictEqual(gas.state.properties.get('MANAGER_CODE'), CODE, 'the code did not change');
  ok(gas.post({ action: 'adminSetup', code: CODE })); // staff stay as they are without a source

  const fresh = createGas();
  refused(fresh.post({ action: 'adminSetup', code: '12' }), /at least 4/);
  assert.strictEqual(fresh.state.properties.get('MANAGER_CODE'), undefined);
  refused(fresh.post({ action: 'adminSetup', code: '123456', sourceSheetId: 'missing', sheetId: fresh.createBook() }), /couldn't open the source sheet/);
  assert.strictEqual(fresh.state.properties.get('MANAGER_CODE'), undefined, 'a failed first run changes nothing');
  assert.strictEqual(fresh.state.properties.get('SHEET_ID'), undefined);
  const noTab = fresh.addFakeSource();
  fresh.state.books.get(noTab).getSheetByName('employees and rankings').setName('Other');
  refused(fresh.post({ action: 'adminSetup', code: '123456', sourceSheetId: noTab, sheetId: fresh.createBook() }), /no tab named "employees and rankings"/);
  refused(fresh.post({ action: 'adminSetup', code: '123456', sheetId: 'missing' }), /couldn't open that sheet/);
  refused(fresh.get({ action: 'names' }), /isn't set up yet/);
});

test('setup: makes its own spreadsheet if it is not given one, and only shares it when asked', () => {
  const gas = createGas();
  gas.setNow(BEFORE_DEADLINE);
  const reply = ok(gas.post({ action: 'adminSetup', code: CODE, sourceSheetId: gas.addFakeSource(), managers: fakeManagers(), testEmail: 'test@example.com' }));
  assert.ok(reply.sheetId.startsWith('created-'));
  assert.strictEqual(gas.state.properties.get('SHEET_ID'), reply.sheetId);
  assert.ok(reply.sheetUrl.includes(reply.sheetId));
  assert.deepStrictEqual(gas.book().editors, [], 'not shared by default, since Google emails the person');

  const shared = createGas();
  shared.setNow(BEFORE_DEADLINE);
  ok(shared.post({ action: 'adminSetup', code: CODE, sourceSheetId: shared.addFakeSource(), managers: fakeManagers(), testEmail: 'test@example.com', shareWithManagers: true }));
  assert.deepStrictEqual(shared.book().editors, ['max@example.com', 'mia@example.com']);
});

test('setup: once it has run, the code alone can\'t re-point the sheet, add a manager, or share it', () => {
  const gas = world();
  const before = gas.state.properties.get('SHEET_ID');
  const staffBefore = gas.rows('Staff').length;
  const reply = ok(gas.post({ action: 'adminSetup', code: CODE, sheetId: gas.createBook(), managers: [{ name: 'Mallory', email: 'mallory@example.com' }], shareWithManagers: true }));
  assert.strictEqual(gas.state.properties.get('SHEET_ID'), before, 'still the same sheet');
  assert.strictEqual(reply.sheetId, before);
  assert.deepStrictEqual(gas.book().editors, [], 'nobody new can edit it');
  assert.strictEqual(gas.rows('Staff').length, staffBefore, 'nobody new on the staff list');
  assert.deepStrictEqual(reply.staffAdded, []);
  assert.match(reply.warnings.join(' '), /only count the first time/);
  assert.strictEqual(ok(gas.get({ action: 'boot', name: 'Ana' })).me.name, 'Ana', 'and the site still works');
  ok(gas.post({ action: 'adminSetup', code: CODE })); // a plain re-run is still fine
});

test('setup: Monthly Hours is a formula tab: a month cell, then one row per person, with SUMIFS over Hours', () => {
  const gas = world();
  const sheet = gas.sheet('Monthly Hours');
  assert.strictEqual(Object.prototype.toString.call(sheet.getRange(1, 2).getValue()), '[object Date]');
  assert.strictEqual(sheet.getRange(1, 2).getNumberFormat(), 'mmmm yyyy');
  assert.deepStrictEqual(sheet.getRange(3, 1, 1, 4).getValues()[0], ['Name', 'Hours', 'Entries', 'Need a fix']);
  assert.strictEqual(sheet.getRange(4, 1).getFormula(), '=IF(Staff!$B2="","",Staff!$B2)');
  const hours = sheet.getRange(4, 2).getFormula();
  assert.match(hours, /SUMIFS\(Hours!\$F:\$F,Hours!\$C:\$C,\$A4,Hours!\$B:\$B,">="&DATE\(YEAR\(\$B\$1\),MONTH\(\$B\$1\),1\),Hours!\$B:\$B,"<"&EDATE\(DATE\(YEAR\(\$B\$1\),MONTH\(\$B\$1\),1\),1\)\)/);
  assert.match(sheet.getRange(4, 4).getFormula(), /Hours!\$H:\$H,"missing"/);
});

test('text that looks like a date, time, number or true/false stays exactly as typed', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  const id = `task|T01|${MON}`;
  ['3/4', '10:30', '007', 'TRUE', '2026-11-09', '1e5'].forEach((note) => {
    ok(gas.post({ action: 'taskNote', name: 'Ana', id, note }));
    assert.strictEqual(rowById(gas, id).Note, note);
    const task = ok(gas.get({ action: 'boot', name: 'Ana' })).today.tasks.find((candidate) => candidate.id === id);
    assert.strictEqual(task.note, note);
  });
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: '12/25', details: '10:30', weekOf: MON, day: 'Mon', minutes: 5, who: ['Cora'] }));
  assert.deepStrictEqual([added.oneOff.title, added.oneOff.details], ['12/25', '10:30']);
  assert.strictEqual(rowById(gas, `oneoff|${added.id}`).Task, '12/25');
  ok(save(gas, 'Ana', NEXT_MON, 4, { Mon: 1 }, { notes: '3/4' }));
  assert.strictEqual(ok(gas.get({ action: 'availability', name: 'Ana', weekOf: NEXT_MON })).notes, '3/4');
  ok(gas.post({ action: 'hoursAdd', name: 'Ana', date: '2026-11-02', start: '09:00', end: '10:00', note: '10:30' }));
  assert.strictEqual(gas.rows('Hours')[0].Note, '10:30');
  ok(gas.post({ action: 'timeOffAdd', name: 'Ana', from: '2026-12-01', note: '12/25' }));
  assert.strictEqual(gas.rows('Time Off')[0].Note, '12/25');
});

test('a full sheet grows when it has to, and emptying a tab of every row works', () => {
  const gas = built();
  // Shrink these tabs to exactly what's in them, as if someone tidied up the spare rows by hand.
  ['Schedule', 'Log', 'Hours'].forEach((tab) => {
    const sheet = gas.sheet(tab);
    sheet.maxRows = Math.max(sheet.getLastRow(), 2);
  });
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'One more row', weekOf: MON, day: 'Wed', minutes: 15 }));
  assert.strictEqual(rowById(gas, `oneoff|${added.id}`).Name, 'Ana');
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));

  const empty = world();
  ok(save(empty, 'Ana', MON, 6, hoursEach(['Mon'], 3)));
  friday(empty);
  const schedule = empty.sheet('Schedule');
  const everyRow = scheduleRows(empty).map((row) => row._row);
  assert.ok(everyRow.length > 1);
  schedule.maxRows = schedule.getLastRow(); // nothing spare, so deleting them all would delete every unfrozen row
  empty.call('deleteRows_', 'Schedule', everyRow);
  assert.strictEqual(schedule.getLastRow(), 1, 'all gone, and no error');
});

test('rows typed into the sheet by hand still count', () => {
  const gas = world();
  submit(gas);

  // A manager writes out-of-town dates straight into the tab, with no ID.
  gas.sheet('Time Off').appendRow(['', 'Gus', THU, THU, 'Typed by hand', '', '']);
  friday(gas);
  assert.strictEqual(rowById(gas, `set|T08|${THU}|Gus`).Source, 'cover', 'the build honors it');
  gas.setNow(at(MON, '09:00'));
  const off = ok(gas.get({ action: 'boot', name: 'Gus' })).timeOff;
  assert.strictEqual(off.length, 1);
  assert.ok(off[0].id, 'it gets an ID the page can use');
  const removed = ok(gas.post({ action: 'timeOffRemove', name: 'Gus', id: off[0].id }));
  assert.strictEqual(removed.restored.length, 1, 'and it can be removed like any other');

  // Hours typed in, with real dates.
  gas.sheet('Hours').appendRow(['', new Date(2026, 10, 2), 'Ana', new Date(2026, 10, 2, 9, 0), new Date(2026, 10, 2, 10, 30), '', '', '', '', '', '']);
  const hoursNow = hoursEntries(gas, 'Ana');
  assert.strictEqual(hoursNow.monthTotal, 1.5);
  const entryId = hoursNow.entries[0].id;
  assert.strictEqual(ok(gas.post({ action: 'mgrHoursEdit', code: CODE, id: entryId, end: '11:00' })).entry.hours, 2, 'and a manager can edit it');

  // A task typed in for today, with the date as a person would type it.
  gas.sheet('Schedule').appendRow(['', '', '11/9/2026', '', 'Ana', '', '', 'Typed task', '', 'A', 15, '', '', '', '', '', '']);
  const tasks = ok(gas.get({ action: 'boot', name: 'Ana' })).today.tasks;
  const typed = tasks.find((task) => task.title === 'Typed task');
  assert.ok(typed, 'it shows on her list');
  assert.strictEqual(typed.top, true);
  ok(gas.post({ action: 'taskToggle', name: 'Ana', id: typed.id, done: true }));

  // Tasks and closed days typed in by hand work too.
  gas.sheet('Closed Days').appendRow(['12/25/2026', '']);
  assert.strictEqual(ok(gas.get({ action: 'availability', name: 'Ana', weekOf: '2026-12-21' })).days[4].closed, 'Closed');
  gas.sheet('Tasks').appendRow(['T99', 'New weekly job', '', 'Weekly', 'B', 15, 'Thursdays', 1, '']);
  gas.setNow(at(FRI, '07:00'));
  gas.tick();
  assert.ok(scheduleRows(gas).some((row) => row['Task ID'] === 'T99' && row['Week Of'] === NEXT_MON));
});

test('an oversized one-off goes partial on the row, stays whole on the one-off, and stays open', () => {
  const gas = built();
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Reorganize the storage room', minutes: 300, weekOf: MON, who: ['Cora'] }));
  const row = rowById(gas, `oneoff|${added.id}`);
  assert.strictEqual(row.Name, 'Cora');
  assert.strictEqual(row.Minutes, 300, 'she has 8 hours on any day, so this one fits whole');

  const tooBig = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Repaint everything', minutes: 900, weekOf: MON, who: ['Cora'] }));
  const partial = rowById(gas, `oneoff|${tooBig.id}`);
  assert.strictEqual(partial.Name, 'Cora');
  assert.ok(partial.Minutes < 900 && partial.Minutes >= 30, `she starts it with what she has left: ${partial.Minutes}`);
  assert.strictEqual(gas.rows('One-Offs').find((line) => line.ID === tooBig.id).Minutes, 900, 'the job itself is still the full size');
  gas.setNow(at(gas.call('addDays_', partial.Date, 1), '00:35'));
  assert.deepStrictEqual(gas.tick().failed, []);
  const rolled = rowById(gas, `oneoff|${tooBig.id}`);
  assert.strictEqual(rolled.Status, 'open', 'it keeps rolling until it is done');
  assert.strictEqual(rolled['Rolled From'], partial.Date);
});

test('out of town starting today: today\'s rows are released, and the time of day has no say in who covers', () => {
  const gas = built();
  gas.setNow(at(THU, '21:30'));
  const added = ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: THU }));
  assert.deepStrictEqual(added.affected, [{ date: THU, title: 'Deep bathroom clean: Main and West Office', coveredBy: 'Ben' }], 'Ben is best ranked with room, however late it is');
  assert.strictEqual(dayMinutes(gas, 'Ben', THU), 145);
  ok(gas.post({ action: 'timeOffRemove', name: 'Gus', id: added.id }));
  assert.strictEqual(dayMinutes(gas, 'Ben', THU), 85, 'and it goes back');
});

test('capacity is the hours for the day: already having work that day comes off, whatever the clock says', () => {
  const gas = world();
  ok(save(gas, 'Ana', MON, 40, { Thu: 2 }));
  ok(save(gas, 'Ben', MON, 40, { Thu: 8 }));
  friday(gas);
  gas.setNow(at(THU, '23:00'));
  const anaHas = dayMinutes(gas, 'Ana', THU);
  assert.ok(anaHas <= 120);
  const fits = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Just fits', weekOf: MON, day: 'Thu', minutes: 120 - anaHas }));
  assert.strictEqual(fits.placed.name, 'Ana', 'what is left of her two hours');
  const over = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Too big for her', weekOf: MON, day: 'Thu', minutes: 15 }));
  assert.strictEqual(over.placed.name, 'Ben', 'her day is full, so it goes to Ben');
});

test('out of town: a row that moved to another day to be covered goes back to its own day afterward', () => {
  const gas = world();
  ok(save(gas, 'Ana', MON, 8, hoursEach(['Wed'], 6))); // T08 Thursday has a flex day, and Wednesday is the only day anyone offered
  friday(gas);
  gas.setNow(at(MON, '10:00'));
  const added = ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: THU }));
  assert.deepStrictEqual(added.affected.map((item) => [item.date, item.coveredBy]), [[WED, 'Ana']]);
  const row = rowById(gas, `set|T08|${THU}|Gus`);
  assert.deepStrictEqual([row.Date, row.Day, row.Name, row.Source], [WED, 'Wed', 'Ana', 'cover']);
  const wednesdayWithCover = dayMinutes(gas, 'Ana', WED);
  ok(gas.post({ action: 'timeOffRemove', name: 'Gus', id: added.id }));
  const back = rowById(gas, row.ID);
  assert.deepStrictEqual([back.Date, back.Day, back.Name, back.Source], [THU, 'Thu', 'Gus', 'set'], 'it goes back to the date in its key');
  assert.ok(dayMinutes(gas, 'Ana', WED) < wednesdayWithCover, "and Ana's Wednesday shrinks again");
});

test('mgrRebuild: late people still only get what on-time people left', () => {
  const gas = world();
  ok(save(gas, 'Ben', MON, 8, hoursEach(['Wed', 'Thu'], 3))); // on time
  friday(gas);
  gas.setNow(at(LAST_FRI, '08:00'));
  ok(save(gas, 'Ana', MON, 8, hoursEach(['Wed', 'Thu'], 3))); // late, and better ranked
  gas.setNow(at(LAST_FRI, '09:00'));
  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));
  scheduleRows(gas)
    .filter((row) => row.Date === WED && row.Source !== 'set')
    .forEach((row) => assert.notStrictEqual(row.Name, 'Ana', `${row.ID}: the on-time person keeps first pick`));
  assert.ok(scheduleRows(gas).filter((row) => row.Name === 'Ana').every((row) => row.Source === 'late'));
});

test('mgrRebuild: a rolled row stuck uncovered gets another chance, and row numbers stay right through the deletes', () => {
  const gas = world();
  ok(save(gas, 'Ana', MON, 6, hoursEach(['Mon'], 3))); // Monday only, so a rolled row has nobody to go to
  friday(gas);
  gas.setNow(at(TUE, '00:35'));
  gas.tick();
  const stuckId = `task|T10|${MON}`;
  const stuck = rowById(gas, stuckId);
  assert.deepStrictEqual([stuck.Name, stuck.Date, stuck.Source], ['', TUE, 'carry']);
  const missedBefore = snapshotRows(gas, (row) => row.Status === 'missed');
  assert.ok(missedBefore.length > 0);
  const setBefore = snapshotRows(gas, (row) => row.Source === 'set');

  gas.sheet('Availability').appendRow([MON, 'Cora', new Date(), false, false, 20, 'Tue:8;Sat:3', 'Hand-edited', '']);
  gas.setNow(at(TUE, '08:00'));
  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));

  const filled = rowById(gas, stuckId);
  assert.deepStrictEqual([filled.Name, filled.Date, filled.Source, filled['Rolled From']], ['Cora', TUE, 'carry', MON]);
  assert.strictEqual(rowById(gas, `task|T01|${SAT}`).Name, 'Cora');
  assert.strictEqual(rowById(gas, `task|T01|${WED}`).Name, '', 'nobody offered Wednesday');
  assert.deepStrictEqual(snapshotRows(gas, (row) => row.Status === 'missed'), missedBefore, 'each row kept its own contents');
  assert.deepStrictEqual(snapshotRows(gas, (row) => row.Source === 'set'), setBefore);
  const ids = scheduleRows(gas).map((row) => row.ID);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('setup: an email that isn\'t one stops a first run before anything changes, and trigger trouble is a warning', () => {
  const gas = createGas();
  refused(gas.post({ action: 'adminSetup', code: '123456', sheetId: gas.createBook(), testEmail: 'not an email' }), /testEmail/);
  refused(gas.post({ action: 'adminSetup', code: '123456', sheetId: gas.createBook(), replyTo: 'nope' }), /replyTo/);
  assert.strictEqual(gas.state.properties.get('MANAGER_CODE'), undefined);
  assert.strictEqual(gas.state.properties.get('SHEET_ID'), undefined);

  gas.context.installTick_ = () => {
    throw new Error('Not allowed');
  };
  const reply = ok(gas.post({ action: 'adminSetup', code: '123456', sheetId: gas.createBook(), testEmail: 'test@example.com' }));
  assert.match(reply.warnings.join(' '), /trigger didn't install/);
  assert.strictEqual(gas.rows('Tasks').length, 15, 'everything else still went in');
});

test('a mail problem never turns someone\'s own save into an error', () => {
  const gas = built();
  gas.state.beforeMail = () => {
    throw new Error('Service invoked too many times for one day: email.');
  };
  gas.setNow(at(MON, '10:00'));
  const off = ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: THU }));
  assert.strictEqual(off.affected.length, 1, 'the cover still happened');
  assert.strictEqual(rowById(gas, `set|T08|${THU}|Gus`).Source, 'cover');
  assert.strictEqual(ok(save(gas, 'Cora', MON, 8, hoursEach(['Sat', 'Sun'], 8))).late, true, 'the late save still went in');
  assert.deepStrictEqual(ok(gas.post({ action: 'mgrRemind', code: CODE, weekOf: NEXT_MON })).sent, [], 'and a reminder that failed is not reported as sent');
  assert.strictEqual(gas.rows('Log').filter((line) => line.Action === 'email failed').length, 6, 'each one is on the record');
  assert.deepStrictEqual(gas.state.mail, []);
});

/* ----------------------------------------------------------------- the dev server ---- */

function fetchJson(port, pathAndQuery, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method: (options && options.method) || 'GET', headers: { 'Content-Type': 'text/plain' } }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, text, type: res.headers['content-type'] }));
    });
    req.on('error', reject);
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

test('dev server: /dev/reset, /api, /dev/time, /dev/tick and /dev/emails all work over real HTTP', async () => {
  const server = http.createServer(createHandler());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const reset = JSON.parse((await fetchJson(port, '/dev/reset')).text);
    assert.deepStrictEqual(reset, { ok: true, now: '2026-11-10T16:05:00.000Z', managerCode: CODE });

    const boot = await fetchJson(port, '/api?action=boot&name=Ana');
    assert.match(boot.type, /application\/json/);
    const parsed = JSON.parse(boot.text);
    checkBootShape(parsed);
    assert.strictEqual(parsed.now.label, 'Tuesday, November 10');

    const posted = JSON.parse((await fetchJson(port, '/api', { method: 'POST', body: JSON.stringify({ action: 'clockIn', name: 'Ana' }) })).text);
    assert.strictEqual(posted.clock.status, 'in');
    assert.strictEqual(JSON.parse((await fetchJson(port, '/api?action=clockIn&name=Ana')).text).ok, false, 'no writes over GET');

    assert.deepStrictEqual(JSON.parse((await fetchJson(port, '/dev/emails')).text), { ok: true, emails: [] }, 'a reset starts with an empty outbox');
    const moved = JSON.parse((await fetchJson(port, '/dev/time?set=' + encodeURIComponent('2026-11-13T07:00:00-07:00'))).text);
    assert.deepStrictEqual(moved, { ok: true, now: '2026-11-13T14:00:00.000Z', frozen: true });
    const ticked = JSON.parse((await fetchJson(port, '/dev/tick')).text);
    assert.ok(ticked.ran.includes('weekly'));
    assert.ok(ticked.emailsSent > 0);
    const emails = JSON.parse((await fetchJson(port, '/dev/emails?clear=1')).text).emails;
    assert.strictEqual(emails.length, ticked.emailsSent);
    assert.deepStrictEqual(JSON.parse((await fetchJson(port, '/dev/emails')).text).emails, []);

    const cleared = JSON.parse((await fetchJson(port, '/dev/time?clear=1', { method: 'POST' })).text);
    assert.strictEqual(cleared.frozen, false);
    assert.strictEqual(JSON.parse((await fetchJson(port, '/dev/time?set=garbage')).text).ok, false);

    const noNextWeek = JSON.parse((await fetchJson(port, '/dev/reset?nextWeek=0')).text);
    assert.strictEqual(noNextWeek.ok, true);
    assert.strictEqual(JSON.parse((await fetchJson(port, '/api?action=boot&name=Ana')).text).week.nextWeek.published, false);

    assert.strictEqual((await fetchJson(port, '/..%2F..%2Fkoda-operations%2FSPEC.md')).status, 404, 'nothing that climbs out of the repo root');
    assert.strictEqual((await fetchJson(port, '/%2e%2e/%2e%2e/secret.txt')).status, 404);
    assert.strictEqual((await fetchJson(port, '/.clasp.json')).status, 404);
    assert.strictEqual((await fetchJson(port, '/nope.html')).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the reset world looks real: work on the list, a covered day, an open task, a forgotten clock-out, no errors', () => {
  const gas = resetWorld();
  assert.deepStrictEqual(gas.state.logs.filter((line) => line.level === 'error'), []);
  assert.strictEqual(gas.now().toISOString(), '2026-11-10T16:05:00.000Z');
  assert.strictEqual(scheduleRows(gas).filter((row) => row.Status === 'done').length, 10);
  assert.strictEqual(rowById(gas, `set|T08|${THU}|Gus`).Source, 'cover');
  assert.strictEqual(gas.tick().ran.length, 0, 'nothing is due until time moves');
  assert.deepStrictEqual(gas.state.mail, []);

  gas.setNow(at(FRI, '07:00'));
  const friday13 = gas.tick();
  assert.ok(friday13.ran.includes('weekly'));
  assert.ok(gas.state.mail.some((mail) => /week of Nov 16/.test(mail.subject)), 'the emails for next week still go out on time');
  assert.ok(!gas.state.mail.some((mail) => /\[TEST to Dev\] Your/.test(mail.subject)), "Dev said he can't work");
});

/* ----------------------------------------------------- Apps Script ground rules ---- */

const SCRIPT_DIR = path.join(__dirname, '..', 'apps-script');
const scriptFiles = fs.readdirSync(SCRIPT_DIR).filter((file) => file.endsWith('.js'));

test('all the backend files are there, and the manifest has the right scopes', () => {
  ['Api.js', 'Config.js', 'Mail.js', 'Scheduler.js', 'Seed.js', 'SeedTasks.js', 'Triggers.js', 'Util.js'].forEach((file) => assert.ok(scriptFiles.includes(file), file));
  const manifest = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'appsscript.json'), 'utf8'));
  assert.strictEqual(manifest.timeZone, 'America/Denver');
  assert.strictEqual(manifest.runtimeVersion, 'V8');
  assert.deepStrictEqual(manifest.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  assert.deepStrictEqual(manifest.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/script.send_mail',
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
  assert.deepStrictEqual(manifest.dependencies.enabledAdvancedServices, [{ userSymbol: 'Sheets', version: 'v4', serviceId: 'sheets' }], 'without this every read quietly goes the slow way');
});

test('every top-level name across the backend is unique, and private ones end in an underscore', () => {
  const seen = new Map();
  const publicNames = new Set(['doGet', 'doPost', 'tick', 'authorize', 'installTick', 'schedPriorityScore', 'schedBuildWeek', 'schedFillOpen']);
  scriptFiles.forEach((file) => {
    const code = fs.readFileSync(path.join(SCRIPT_DIR, file), 'utf8');
    [...code.matchAll(/^(?:function|var|const|let|class)\s+([A-Za-z0-9_$]+)/gm)].forEach((match) => {
      const name = match[1];
      assert.ok(!seen.has(name), `${name} is defined in both ${seen.get(name)} and ${file}`);
      seen.set(name, file);
      assert.ok(publicNames.has(name) || name.endsWith('_'), `${name} in ${file} should end in an underscore`);
    });
    assert.ok(!/^\s*(import|export)\s/m.test(code), `${file} uses import or export`);
  });
  assert.ok(seen.size > 100);
});

test('Now_ is the only clock in the backend', () => {
  scriptFiles
    .filter((file) => file !== 'Util.js')
    .forEach((file) => {
      const code = fs.readFileSync(path.join(SCRIPT_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.ok(!/new Date\(\s*\)/.test(code), `${file} reads the clock with new Date()`);
      assert.ok(!/Date\.now\(/.test(code), `${file} reads the clock with Date.now()`);
    });
  const util = fs.readFileSync(path.join(SCRIPT_DIR, 'Util.js'), 'utf8');
  assert.strictEqual((util.match(/new Date\(\s*\)/g) || []).length, 1, 'once, inside Now_');
});

test('no email, no sheet ID and no secret is sitting in the repo', () => {
  const root = path.join(__dirname, '..');
  const collect = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'screenshots') return [];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collect(full);
      return /\.(js|json|md|html|webmanifest)$/.test(entry.name) ? [full] : [];
    });
  const files = collect(root).filter((file) => path.basename(file) !== 'SPEC.md');
  assert.ok(files.length >= 10);
  files.forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach((address) => {
      assert.ok(/@example\.(com|test)$/.test(address), `${address} is in ${path.relative(root, file)}`);
    });
    assert.ok(!/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/.test(text), `A sheet ID is in ${path.relative(root, file)}`);
    assert.ok(!/\/d\/1[A-Za-z0-9_-]{30,}/.test(text), `A Drive ID is in ${path.relative(root, file)}`);
  });
});

/* ------------------------------------------------- the review before going live ---- */

const WEEK_BEFORE_FIRST = '2026-11-02';

test('first week: nothing can be put in a week before first_week, since nothing ever runs for it', () => {
  const gas = world(); // Thursday, Nov 5, with this week still before first_week
  refused(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Too early', weekOf: WEEK_BEFORE_FIRST }), /starts the week of Nov 9/);
  assert.deepStrictEqual(gas.rows('One-Offs'), [], 'it was not saved with a promise it could not keep');
  refused(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: WEEK_BEFORE_FIRST }), /starts the week of Nov 9/);
  assert.deepStrictEqual(scheduleRows(gas), [], 'and no schedule was made for that week');
  assert.strictEqual(ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: WEEK_BEFORE_FIRST })).published, false);

  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'On time for Friday', weekOf: MON }));
  assert.strictEqual(added.placed, null);
  refused(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, weekOf: WEEK_BEFORE_FIRST }), /starts the week of Nov 9/);

  assert.deepStrictEqual(ok(gas.get({ action: 'mgrBoard', code: CODE })).weeks.map((week) => week.weekOf), [MON], 'the board only offers weeks that run');
  assert.strictEqual(ok(gas.get({ action: 'boot', name: 'Max' })).week.firstWeek, MON, 'and the page knows where to start');

  submit(gas, ['Ana']);
  friday(gas);
  assert.strictEqual(rowById(gas, `oneoff|${added.id}`).Name, 'Ana', 'what it said about Friday came true');
  gas.setNow(at(MON, '09:00'));
  assert.ok(!('firstWeek' in ok(gas.get({ action: 'boot', name: 'Max' })).week), 'once that week has come, the page has no need of it');
});

test('hours: already finished and still on the clock, the time can be fixed the same day', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  const id = ok(gas.post({ action: 'clockIn', name: 'Ana' })).clock.entry.id;
  gas.setNow(at(MON, '17:00'));
  refused(gas.post({ action: 'clockFix', name: 'Ana', id, out: '08:00' }), /before you clocked in/);
  refused(gas.post({ action: 'clockFix', name: 'Ana', id, out: '18:00' }), /hasn't happened/);
  const fixed = ok(gas.post({ action: 'clockFix', name: 'Ana', id, out: '12:00' }));
  assert.strictEqual(fixed.clock.status, 'out');
  assert.strictEqual(fixed.clock.entry, null);
  assert.deepStrictEqual([fixed.entry.out, fixed.entry.hours, fixed.entry.flag], ['12:00 PM', 3, 'fixed']);
});

test('hours: an entry far past what was scheduled gets pointed out, until a manager has looked at it', () => {
  const gas = built();
  gas.setNow(at(MON, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  ok(gas.post({ action: 'clockIn', name: 'Ben' })); // nothing scheduled Monday
  ok(gas.post({ action: 'clockIn', name: 'Dev' }));
  gas.setNow(at(MON, '13:00'));
  ok(gas.post({ action: 'clockOut', name: 'Ben' }));
  gas.setNow(at(MON, '14:00'));
  ok(gas.post({ action: 'clockOut', name: 'Ana' })); // 5 hours, with 125 minutes scheduled
  gas.setNow(at(MON, '18:00'));
  ok(gas.post({ action: 'clockOut', name: 'Dev' })); // 9 hours on a day with nothing scheduled

  const report = ok(gas.get({ action: 'mgrHours', code: CODE, month: '2026-11' }));
  const person = (name) => report.people.find((one) => one.name === name);
  assert.strictEqual(person('Ana').entries[0].long, true);
  assert.ok(!('long' in person('Ben').entries[0]), '4 hours with nothing scheduled is not remarkable');
  assert.strictEqual(person('Dev').entries[0].long, true);
  assert.strictEqual(report.totalIssues, 0, "it's worth a look, not a mistake");
  deepKeys(person('Ben').entries[0], ['id', 'date', 'dayLabel', 'in', 'out', 'hours', 'flag', 'note'], 'an ordinary entry');

  gas.setNow(at('2026-12-01', '07:00'));
  gas.tick();
  const monthly = gas.state.mail.find((mail) => /November hours/.test(mail.subject));
  assert.match(monthly.htmlBody, /Much longer than that day/);
  assert.match(monthly.htmlBody, /Ana: Mon, Nov 9, 9:00 AM - 2:00 PM, 5 hours/);

  ok(gas.post({ action: 'mgrHoursEdit', code: CODE, id: person('Ana').entries[0].id, end: '11:30', by: 'Max' }));
  const after = ok(gas.get({ action: 'mgrHours', code: CODE, month: '2026-11' }));
  assert.ok(!('long' in after.people.find((one) => one.name === 'Ana').entries[0]));
});

test('going live late: deleting the marker sends the week again, live, without rebuilding it', () => {
  const gas = built();
  const rowsBefore = snapshotRows(gas, () => true);
  setSetting(gas, 'live', 'TRUE');
  gas.setNow(at(LAST_FRI, '07:30'));
  gas.tick();
  assert.deepStrictEqual(gas.state.mail, [], 'going live afterward sends nothing by itself');

  gas.state.properties.delete(`RUN_WEEK_${MON}_DONE`); // the recovery in the README
  gas.setNow(at(LAST_FRI, '07:35'));
  assert.deepStrictEqual(gas.tick().failed, []);
  assert.ok(gas.state.mail.length > 0);
  gas.state.mail.forEach((mail) => assert.ok(!/\[TEST to/.test(mail.subject), mail.subject));
  assert.ok(gas.state.mail.some((mail) => mail.to === 'ana@example.com'));
  assert.deepStrictEqual(snapshotRows(gas, () => true), rowsBefore, 'the schedule is the same');
  const sent = gas.state.mail.length;
  gas.setNow(at(LAST_FRI, '07:40'));
  gas.tick();
  assert.strictEqual(gas.state.mail.length, sent, 'and once is enough');
});

test('after the deadline: on time stays on time when nothing was added, with no false alert and no lost place', () => {
  const gas = built();
  const all = workedExampleAvailability();
  const anaBefore = scheduleRows(gas).filter((row) => row.Name === 'Ana').length;

  gas.setNow(at(LAST_FRI, '17:00'));
  const same = ok(save(gas, 'Ana', MON, all.Ana.hoursWanted, all.Ana.dayHours, { notes: 'Might be a little late Monday' }));
  assert.strictEqual(same.late, false);
  assert.deepStrictEqual(gas.state.mail, [], 'nothing changed, so nobody hears about it');
  const row = gas.rows('Availability').find((line) => line.Name === 'Ana');
  assert.strictEqual(row.Late, false);
  assert.strictEqual(row.Notes, 'Might be a little late Monday');

  // The Re-run that used to hand all her work down the ranks.
  gas.setNow(at(SAT.replace('14', '07'), '10:00')); // Saturday, Nov 7
  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));
  assert.strictEqual(scheduleRows(gas).filter((line) => line.Name === 'Ana').length, anaBefore, 'she keeps her work, and her rank still counts');

  // Offering more than before is a late answer, as the spec says.
  const more = ok(save(gas, 'Ana', MON, all.Ana.hoursWanted, hoursEach(['Mon', 'Wed', 'Fri', 'Sat'], 3)));
  assert.strictEqual(more.late, true);
  assert.ok(subjects(gas).some((subject) => /Ana's availability came in late/.test(subject)));

  gas.state.mail.length = 0;
  assert.strictEqual(ok(save(gas, 'Ana', MON, all.Ana.hoursWanted, hoursEach(['Mon', 'Wed', 'Fri', 'Sat'], 3))).late, true, 'late stays late');
  assert.deepStrictEqual(gas.state.mail, [], 'and saving the same thing again says nothing new');
});

test('after the deadline: asking for more hours counts as offering more, and "can\'t work" then real hours does too', () => {
  const gas = world();
  ok(save(gas, 'Ana', MON, 4, hoursEach(['Mon'], 3)));
  ok(gas.post({ action: 'saveAvailability', name: 'Ben', weekOf: MON, none: true }));
  friday(gas);
  gas.setNow(at(LAST_FRI, '08:00'));
  assert.strictEqual(ok(save(gas, 'Ana', MON, 6, hoursEach(['Mon'], 3))).late, true);
  assert.strictEqual(ok(save(gas, 'Ben', MON, 2, hoursEach(['Tue'], 1))).late, true);
});

test('after the deadline: more hours on a day she kept is late, and the same hours or fewer is not', () => {
  const same = built();
  same.setNow(at(LAST_FRI, '17:00'));
  assert.strictEqual(ok(save(same, 'Ana', MON, 6, { Mon: 3, Wed: 3, Fri: 2.5 })).late, false, 'fewer on one day');
  const more = built();
  more.setNow(at(LAST_FRI, '17:00'));
  assert.strictEqual(ok(save(more, 'Ana', MON, 6, { Mon: 3.5, Wed: 3, Fri: 3 })).late, true, 'half an hour more on Monday');
});

test('after the deadline: taking hours away tells the managers what no longer fits, and moves nothing', () => {
  const gas = built();
  const rowsBefore = snapshotRows(gas, (row) => row.Name === 'Ana');
  gas.setNow(at(LAST_FRI, '17:00'));
  const reply = ok(save(gas, 'Ana', MON, 2, { Mon: 1, Wed: 1, Fri: 1 }));
  assert.strictEqual(reply.late, false);
  assert.deepStrictEqual(snapshotRows(gas, (row) => row.Name === 'Ana'), rowsBefore, 'that is a rule for the owner to decide');
  const alert = gas.state.mail.find((mail) => /Ana's availability changed/.test(mail.subject));
  assert.match(alert.htmlBody, /No longer fits/);
  assert.match(alert.htmlBody, /Has 5\.7 hours this week and now wants 2/);
  assert.match(alert.htmlBody, /Mon, Nov 9: has 2\.1 hours of work and is free for 1/);

  gas.state.mail.length = 0;
  ok(save(gas, 'Ana', MON, 2, { Mon: 1, Wed: 1, Fri: 1 }));
  assert.deepStrictEqual(gas.state.mail, [], 'once is enough');
});

test('mail quota: a flood of saves or out-of-town cycles can\'t use up the day\'s email', () => {
  const gas = built(['Ana', 'Ben', 'Cora']);
  gas.setNow(at(LAST_FRI, '09:00'));
  for (let i = 0; i < 60; i++) ok(save(gas, 'Dev', MON, 5, hoursEach(['Tue', 'Thu'], 3)));
  assert.strictEqual(gas.state.mail.length, 1, 'sixty identical late saves are one alert');

  gas.state.mail.length = 0;
  gas.setNow(at(MON, '09:00'));
  for (let i = 0; i < 10; i++) {
    const off = ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: THU }));
    assert.ok(off.affected.length > 0, 'the cover still happens every time');
    ok(gas.post({ action: 'timeOffRemove', name: 'Gus', id: off.id }));
  }
  assert.strictEqual(gas.state.mail.length, 5, 'ten trips, and the alerts stop at the hourly limit');
  gas.setNow(at(MON, '10:01'));
  ok(gas.post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: THU }));
  assert.strictEqual(gas.state.mail.length, 6, 'and start again the next hour');
});

test('past midnight: a shift keeps running, clocks out normally, and nothing calls it forgotten', () => {
  const gas = built();
  gas.setNow(at(WED, '20:00'));
  const id = ok(gas.post({ action: 'clockIn', name: 'Gus' })).clock.entry.id;

  gas.setNow(at(THU, '00:05'));
  let boot = ok(gas.get({ action: 'boot', name: 'Gus' }));
  assert.strictEqual(boot.clock.status, 'in');
  assert.strictEqual(boot.clock.entry.id, id);
  assert.deepStrictEqual(boot.clock.stale, []);
  assert.deepStrictEqual(ok(gas.post({ action: 'clockIn', name: 'Gus' })).clock.entry.id, id, 'a stray clock-in is the same entry');
  assert.strictEqual(gas.rows('Hours').length, 1);

  gas.setNow(at(THU, '00:35'));
  gas.tick();
  assert.strictEqual(gas.rows('Hours')[0].Flag, '', 'the nightly leaves it alone');
  assert.deepStrictEqual(ok(gas.post({ action: 'mgrBoard', code: CODE })).onClock, [{ name: 'Gus', since: '8:00 PM' }]);
  assert.strictEqual(ok(gas.get({ action: 'mgrHours', code: CODE, month: '2026-11' })).totalIssues, 0);

  gas.setNow(at(THU, '01:45'));
  const out = ok(gas.post({ action: 'clockOut', name: 'Gus' }));
  assert.strictEqual(out.clock.status, 'out');
  boot = ok(gas.get({ action: 'boot', name: 'Gus' }));
  assert.deepStrictEqual([boot.hours.entries[0].date, boot.hours.entries[0].out, boot.hours.entries[0].hours], [WED, '1:45 AM', 5.75]);
  assert.strictEqual(boot.hours.monthTotal, 5.75);
});

test('past midnight: a forgotten evening clock-out is still a forgotten clock-out by morning', () => {
  const gas = built();
  gas.setNow(at(MON, '17:00'));
  const id = ok(gas.post({ action: 'clockIn', name: 'Ana' })).clock.entry.id;
  gas.setNow(at(TUE, '04:59'));
  assert.strictEqual(ok(gas.get({ action: 'boot', name: 'Ana' })).clock.status, 'in');
  gas.setNow(at(TUE, '08:00'));
  const boot = ok(gas.get({ action: 'boot', name: 'Ana' }));
  assert.strictEqual(boot.clock.status, 'out');
  assert.deepStrictEqual(boot.clock.stale.map((entry) => entry.id), [id]);
  assert.strictEqual(ok(gas.get({ action: 'mgrHours', code: CODE, month: '2026-11' })).totalIssues, 1);

  // A clock-out sent now leaves it for the person to fix, and their finish time reads as that night.
  ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  assert.strictEqual(gas.rows('Hours')[0].Out, '');
  const fixed = ok(gas.post({ action: 'clockFix', name: 'Ana', id, out: '00:30' }));
  assert.deepStrictEqual([fixed.entry.out, fixed.entry.hours, fixed.entry.flag], ['12:30 AM', 7.5, 'fixed']);
  ok(gas.post({ action: 'clockFix', name: 'Ana', id, out: '00:30' })); // a retry is fine
});

test('past midnight: typed hours and manager hours read an end before the start as the next morning', () => {
  const gas = built();
  gas.setNow(at(THU, '09:00'));
  const staff = ok(gas.post({ action: 'hoursAdd', name: 'Gus', date: WED, start: '20:00', end: '01:45' }));
  assert.strictEqual(staff.entry.hours, 5.75);
  const added = ok(gas.post({ action: 'mgrHoursAdd', code: CODE, name: 'Hal', date: WED, start: '22:00', end: '02:00', by: 'Max' }));
  assert.strictEqual(added.entry.hours, 4);
  const edited = ok(gas.post({ action: 'mgrHoursEdit', code: CODE, id: added.entry.id, end: '03:00', by: 'Max' }));
  assert.strictEqual(edited.entry.hours, 5);
  assert.strictEqual(ok(gas.post({ action: 'mgrHoursEdit', code: CODE, id: added.entry.id, note: 'Checked', by: 'Max' })).entry.hours, 5, 'saving it again keeps the same end');

  // Not believable as a next morning, so it's still a mistake with a sentence.
  refused(gas.post({ action: 'mgrHoursAdd', code: CODE, name: 'Ivy', date: WED, start: '09:00', end: '08:00' }), /after the start/);
  refused(gas.post({ action: 'hoursAdd', name: 'Ivy', date: THU, start: '22:00', end: '01:00' }), /hasn't happened|after the start/);
});

test('overlaps: hand-made clock times that stack up count as issues, instead of paying twice', () => {
  const gas = built();
  gas.setNow(at(MON, '18:00'));
  const start = new Date(at(MON, '09:06')).getTime();
  const end = new Date(at(MON, '17:00')).getTime();
  for (let i = 0; i < 3; i++) {
    ok(gas.post({ action: 'clockIn', name: 'Ben', at: start }));
    ok(gas.post({ action: 'clockOut', name: 'Ben', at: end }));
  }
  const report = ok(gas.get({ action: 'mgrHours', code: CODE, month: '2026-11' }));
  const ben = report.people.find((person) => person.name === 'Ben');
  assert.strictEqual(ben.shifts, 3);
  assert.strictEqual(ben.issues, 3);
  assert.strictEqual(report.totalIssues, 3);
  ben.entries.forEach((entry) => assert.strictEqual(entry.overlaps, true));

  ok(gas.post({ action: 'mgrHoursDelete', code: CODE, id: ben.entries[0].id }));
  ok(gas.post({ action: 'mgrHoursDelete', code: CODE, id: ben.entries[1].id }));
  assert.strictEqual(ok(gas.get({ action: 'mgrHours', code: CODE, month: '2026-11' })).totalIssues, 0);
});

test('mgrRebuild: cover for a set day that has passed stays put, and is not lost', () => {
  const gas = world();
  ok(save(gas, 'Ben', MON, 8, hoursEach(['Thu'], 6)));
  ok(gas.post({ action: 'timeOffAdd', name: 'Hal', from: TUE, to: TUE }));
  friday(gas);
  const id = `set|T14|${TUE}|Hal`;
  assert.deepStrictEqual([rowById(gas, id).Name, rowById(gas, id).Date], ['Ben', THU]);

  gas.setNow(at(WED, '10:00'));
  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));
  assert.deepStrictEqual([rowById(gas, id).Name, rowById(gas, id).Date, rowById(gas, id).Source], ['Ben', THU, 'cover']);

  // If Ben drops out too, it waits uncovered, and the next Re-run can still find someone.
  ok(gas.post({ action: 'timeOffAdd', name: 'Ben', from: THU, to: THU }));
  assert.strictEqual(rowById(gas, id).Name, '');
  gas.sheet('Availability').appendRow([MON, 'Cora', new Date(), false, false, 20, 'Thu:8', 'Thu 8 hrs', '']);
  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));
  assert.deepStrictEqual([rowById(gas, id).Name, rowById(gas, id).Date], ['Cora', THU]);
  const ids = scheduleRows(gas).map((row) => row.ID);
  assert.strictEqual(new Set(ids).size, ids.length, 'nothing was made twice');
});

test('partial one-offs: the worker is told, the list shows what is on the schedule, and a typo fix leaves the size alone', () => {
  const gas = built();
  gas.setNow(at(LAST_FRI, '10:00'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Scrub the rig', weekOf: MON, minutes: 240, who: ['Ana'] }));
  const id = `oneoff|${added.id}`;
  const row = rowById(gas, id);
  assert.ok(row.Minutes < 240, 'she only has room for part of it');
  assert.strictEqual(added.oneOff.assignedMinutes, row.Minutes);
  assert.strictEqual(added.oneOff.minutes, 240);

  gas.setNow(at(row.Date, '09:05'));
  const task = ok(gas.get({ action: 'boot', name: 'Ana' })).today.tasks.find((one) => one.id === id);
  assert.strictEqual(task.partial, true);
  assert.ok(!('minutes' in task), 'a partial task keeps its minutes off the staff screen too');
  const whole = ok(gas.get({ action: 'boot', name: 'Ana' })).today.tasks.find((one) => one.id !== id);
  assert.ok(!('partial' in whole), 'an ordinary task keeps its shape');

  ok(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, title: 'Scrub the whole rig' }));
  const after = rowById(gas, id);
  assert.deepStrictEqual([after.Task, after.Minutes], ['Scrub the whole rig', row.Minutes]);

  // A new size has to fit all over again, unless a manager placed it by hand.
  const resized = ok(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, minutes: 30 }));
  assert.strictEqual(resized.placed.name, 'Ana');
  assert.strictEqual(rowById(gas, id).Minutes, 30);
  ok(gas.post({ action: 'mgrAssign', code: CODE, id, name: 'Cora', date: row.Date }));
  const held = ok(gas.post({ action: 'mgrOneOffEdit', code: CODE, id: added.id, minutes: 15 }));
  assert.strictEqual(held.placed, null);
  assert.deepStrictEqual([rowById(gas, id).Name, rowById(gas, id).Minutes, rowById(gas, id).Source], ['Cora', 15, 'manual']);
});

test('one-offs: limited to someone, it stays theirs while it is uncovered', () => {
  const gas = built();
  gas.setNow(at(TUE, '09:05'));
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, title: 'Private errand', details: 'For Ana only', weekOf: MON, day: 'Tue', who: ['Ana'], minutes: 600 }));
  const id = `oneoff|${added.id}`;
  assert.strictEqual(added.placed.name, '', 'it does not fit');
  assert.ok(!ok(gas.get({ action: 'boot', name: 'Ben' })).today.openTasks.some((task) => task.id === id), "Ben can't see it");
  refused(gas.post({ action: 'taskClaim', name: 'Ben', id }), /set aside/);
  assert.ok(ok(gas.get({ action: 'boot', name: 'Ana' })).today.openTasks.some((task) => task.id === id), 'Ana can');
  assert.strictEqual(ok(gas.post({ action: 'taskClaim', name: 'Ana', id })).task.id, id);
});

test('out of town: a Flexible person who takes the dates back gets first go at their work again', () => {
  const gas = built(['Ana']); // nobody else offered, so her work has nowhere else to go
  gas.setNow(at(MON, '10:00'));
  const off = ok(gas.post({ action: 'timeOffAdd', name: 'Ana', from: WED, to: WED }));
  const wednesday = off.affected.filter((item) => item.date === WED);
  assert.ok(wednesday.length > 0);
  wednesday.forEach((item) => assert.strictEqual(item.coveredBy, ''));
  gas.state.mail.length = 0;

  const back = ok(gas.post({ action: 'timeOffRemove', name: 'Ana', id: off.id }));
  assert.ok(back.restored.length >= wednesday.length, 'she has them back');
  back.restored.forEach((item) => assert.ok(item.title));
  assert.ok(scheduleRows(gas).some((row) => row.Name === 'Ana' && row.Date === WED));
  assert.ok(scheduleRows(gas).some((row) => row.Name === 'Ana' && row.Date === WED));
  const alert = gas.state.mail.find((mail) => /Ana is back in town/.test(mail.subject));
  assert.ok(alert, 'and the managers hear about it');
  assert.ok(!scheduleRows(gas).some((row) => row.Name === 'Ana' && row.Date === WED && row.Source === 'cover'), 'it is her own work again, not cover');
  assert.deepStrictEqual(ok(gas.post({ action: 'timeOffRemove', name: 'Ana', id: off.id })).restored, [], 'a repeat changes nothing');
});

test('closed days: the ways people really type a date all count, and anything else is called out', () => {
  ['11/11/26', '11/11', 'Nov 11', 'Nov 11, 2026', 'November 11', '11/11/2026'].forEach((typed) => {
    const gas = world();
    submit(gas);
    const tab = gas.sheet('Closed Days');
    tab.getRange(tab.getLastRow() + 1, 1).setNumberFormat('@').setValue(typed);
    friday(gas);
    assert.deepStrictEqual(scheduleRows(gas).filter((row) => row.Date === WED), [], `${typed} closes the day`);
  });

  const gas = world();
  assert.strictEqual(gas.call('dateString_', '12/25/26'), '2026-12-25');
  assert.strictEqual(gas.call('dateString_', '12/25'), '2026-12-25');
  assert.strictEqual(gas.call('dateString_', 'dec. 25'), '2026-12-25');
  assert.strictEqual(gas.call('dateString_', '2/30'), '');
  assert.strictEqual(gas.call('dateString_', 'Christmas'), '');
  assert.strictEqual(gas.call('dateString_', 'Foo 25'), '');
  gas.setNow(at('2026-12-20', '10:00'));
  assert.strictEqual(gas.call('dateString_', '1/1'), '2027-01-01', 'with no year, the nearest one');
  gas.setNow(BEFORE_DEADLINE);

  submit(gas);
  const tab = gas.sheet('Closed Days');
  tab.getRange(tab.getLastRow() + 1, 1).setNumberFormat('@').setValue('Christmas');
  friday(gas);
  const summary = gas.state.mail.find((mail) => /schedule is out/.test(mail.subject));
  assert.match(summary.htmlBody, /not dates we can read/);
  assert.match(summary.htmlBody, /Christmas/);
});

test('availability: from Monday on, someone who never answered can still fill out the week under way', () => {
  const gas = built(['Ana', 'Ben', 'Cora']); // Dev never answered
  gas.setNow(at(MON, '10:00'));
  const weeks = ok(gas.get({ action: 'boot', name: 'Dev' })).availability.weeks;
  assert.strictEqual(weeks.length, 7);
  assert.deepStrictEqual([weeks[0].weekOf, weeks[0].past, weeks[0].status], [MON, true, 'missing']);
  assert.strictEqual(ok(gas.get({ action: 'boot', name: 'Ana' })).availability.weeks.length, 6, 'not for someone who answered');
  assert.strictEqual(ok(gas.get({ action: 'boot', name: 'Gus' })).availability.weeks.length, 6, 'or someone with set days');

  ok(save(gas, 'Dev', MON, 5, hoursEach(['Tue', 'Thu'], 3)));
  const after = ok(gas.get({ action: 'boot', name: 'Dev' })).availability.weeks;
  assert.deepStrictEqual([after.length, after[0].weekOf], [6, NEXT_MON]);
});

test('missed rows stay put, but use up nobody\'s hours', () => {
  const gas = world();
  ok(save(gas, 'Ana', MON, 4, hoursEach(['Mon', 'Wed', 'Fri'], 3)));
  ok(save(gas, 'Cora', MON, 20, hoursEach(MON_SAT, 8)));
  friday(gas);
  const missedBefore = (rows) => rows.filter((row) => row.Name === 'Ana' && row.Status === 'missed').reduce((sum, row) => sum + row.Minutes, 0);

  gas.setNow(at(TUE, '00:35')); // nobody did Monday, and the daily ones are now missed
  gas.tick();
  assert.ok(missedBefore(scheduleRows(gas)) > 0);
  gas.setNow(at(TUE, '06:00'));
  const missedIds = scheduleRows(gas).filter((row) => row.Name === 'Ana' && row.Status === 'missed').map((row) => row.ID);
  ok(gas.post({ action: 'mgrRebuild', code: CODE, weekOf: MON }));

  const rows = scheduleRows(gas);
  missedIds.forEach((id) => assert.deepStrictEqual([rowById(gas, id).Name, rowById(gas, id).Status], ['Ana', 'missed'], 'still on the record'));
  const real = rows.filter((row) => row.Name === 'Ana' && row.Status !== 'missed').reduce((sum, row) => sum + row.Minutes, 0);
  const board = ok(gas.get({ action: 'mgrBoard', code: CODE, weekOf: MON }));
  assert.strictEqual(board.people.find((person) => person.name === 'Ana').assignedMin, real, 'the board counts what she can still do');
  assert.ok(real > 240 - missedBefore(rows), 'and she got her hours back ahead of a lower rank');
  assert.ok(rows.filter((row) => row.Name === 'Ana' && row.Date === FRI).length > 0);
});

test('tick: a tick that waited for the lock checks again, so the Friday run can\'t go out twice', () => {
  const gas = built([]); // a real week, with the emails cleared
  gas.state.properties.forEach((value, key) => {
    if (/^RUN_WEEK_.*_DONE$/.test(key)) gas.state.properties.delete(key);
  });
  submit(gas, ['Ana', 'Ben']);
  gas.setNow(at(LAST_FRI, '07:05'));

  // The order that can happen on Google: this tick has read the markers, and another one finishes the whole job while it waits.
  const realLock = gas.context.LockService;
  let raced = false;
  const sentByOther = [];
  gas.context.LockService = {
    getScriptLock: () => ({
      tryLock() {
        if (!raced) {
          raced = true;
          gas.context.LockService = realLock;
          sentByOther.push(gas.tick());
          gas.context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
        }
        return true;
      },
      releaseLock() {},
    }),
  };
  const result = gas.tick();
  gas.context.LockService = realLock;
  assert.deepStrictEqual(sentByOther[0].ran, ['weekly'], 'the other tick did the work');
  assert.deepStrictEqual(result.ran, [], 'and this one saw that');
  const subjectsSent = subjects(gas);
  assert.strictEqual(new Set(subjectsSent).size, subjectsSent.length, 'every email went once');
  assert.ok(subjectsSent.length > 0);
});
