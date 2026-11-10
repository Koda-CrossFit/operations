'use strict';

// How the backend reads the sheet: one batchGet per run, checked against the old SpreadsheetApp
// path, which is what a failed batch falls back to. README has the why. Run: node --test

const test = require('node:test');
const assert = require('node:assert');

const { createGas, fakeManagers, dateToSerial } = require('../dev/gas-mock.js');
const { resetWorld } = require('../dev/server.js');
const { hoursEach } = require('../dev/fixtures.js');

const CODE = '000000';
const DENVER = 'America/Denver';

// All of November 2026 is on standard time (the clocks went back on Nov 1), so -07:00 is right for the week below.
const at = (date, time) => `${date}T${time}:00-07:00`;
const THIS_THU = '2026-11-05';
const LAST_FRI = '2026-11-06';
const MON = '2026-11-09';
const TUE = '2026-11-10';
const WED = '2026-11-11';
const THU = '2026-11-12';
const FRI = '2026-11-13';
const SAT = '2026-11-14';
const SUN = '2026-11-15';
const NEXT_MON = '2026-11-16';

const DATA_TABS = ['Staff', 'Tasks', 'One-Offs', 'Availability', 'Time Off', 'Schedule', 'Hours', 'Settings', 'Closed Days'];
const EVERY_RANGE = ["'Staff'", "'Tasks'", "'One-Offs'", "'Availability'", "'Time Off'", "'Schedule'", "'Hours'", "'Log'!1:1", "'Settings'", "'Closed Days'", "'Extra Work'"];

/* ---------------------------------------------------------------------- helpers ---- */

function ok(reply) {
  assert.strictEqual(reply.ok, true, `Expected ok, got: ${reply.error}`);
  return reply;
}

/** JSON for JSON: the same values, and the same keys in the same order. */
function sameJson(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** What `work` gets with the batch failing, which is the old SpreadsheetApp path. */
function theOldWay(gas, work) {
  const before = gas.state.beforeBatch;
  gas.state.beforeBatch = () => {
    throw new Error('Off, to compare with the old way.');
  };
  try {
    return work();
  } finally {
    gas.state.beforeBatch = before;
  }
}

/** What `work` cost, in calls a running script made. */
function counted(gas, work) {
  const counters = gas.state.counters;
  const before = plain(counters);
  const result = work();
  const calls = {};
  Object.keys(counters.readCalls).forEach((key) => {
    const made = counters.readCalls[key] - (before.readCalls[key] || 0);
    if (made) calls[key] = made;
  });
  return { result, batchGet: counters.batchGet - before.batchGet, flush: counters.flush - before.flush, sheetReads: counters.sheetReads - before.sheetReads, openById: counters.openById - before.openById, calls };
}

function warnings(gas) {
  return gas.state.logs.filter((line) => line.level === 'warn');
}

/** A fake world whose new IDs are the same every time, so two worlds can be compared line for line. */
function sameIdsWorld(prepare) {
  const gas = createGas();
  let made = 0;
  gas.context.Utilities.getUuid = () => {
    made += 1;
    return `${String(made).padStart(10, '0')}-0000-0000-0000-000000000000`;
  };
  if (prepare) prepare(gas);
  return gas;
}

function adminSetup(gas) {
  return gas.post({ action: 'adminSetup', code: CODE, sourceSheetId: gas.addFakeSource(), sheetId: gas.createBook(), managers: fakeManagers(), testEmail: 'test@example.com', replyTo: 'reply@example.com' });
}

/** Set up on Thursday, with nothing else done yet. */
function setUpWorld(prepare) {
  const gas = sameIdsWorld(prepare);
  gas.setNow(at(THIS_THU, '10:00'));
  ok(adminSetup(gas));
  return gas;
}

function columnOf(sheet, header) {
  const column = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf(header) + 1;
  assert.ok(column, `No column named ${header}`);
  return column;
}

/** A person typing straight into a cell that isn't plain text, so Sheets guesses what it is. */
function typeCell(gas, tab, row, header, value) {
  const sheet = gas.sheet(tab);
  sheet.getRange(row, columnOf(sheet, header)).setNumberFormat('General').setValue(value);
}

/** The ways a sheet ends up after people have been in it, none of which the site writes itself. */
function typeIntoTheSheet(gas) {
  const schedule = gas.rows('Schedule');
  const friday = schedule.find((row) => row.Date === FRI && row.Name);
  typeCell(gas, 'Schedule', friday._row, 'Date', new Date(2026, 10, 13)); // a date Sheets made real
  typeCell(gas, 'Schedule', friday._row, 'Week Of', new Date(2026, 10, 9));
  const done = schedule.find((row) => row.Status === 'done');
  typeCell(gas, 'Schedule', done._row, 'Done At', new Date(2026, 10, 9, 9, 41, 17, 250)); // seconds and milliseconds
  gas.sheet('Schedule').getRange(5, 20).setValue('Scribble with no header');

  gas.sheet('Availability').insertRowsAfter(3, 1); // a blank row in the middle

  gas.sheet('Time Off').appendRow(['', 'Dev', '2026-11-20', '11/21/2026', 'Typed by hand', '', '']); // no ID yet
  gas.sheet('Closed Days').appendRow(['Dec 25', 'Christmas']);
  gas.sheet('Closed Days').appendRow(['Someday soon', 'Reads as nothing']);
  typeCell(gas, 'Closed Days', gas.sheet('Closed Days').getLastRow() + 1, 'Date', new Date(2027, 0, 1));

  gas.sheet('Hours').appendRow(['', new Date(2026, 10, 2), 'Ana', new Date(2026, 10, 2, 9, 0, 30), new Date(2026, 10, 2, 10, 30, 15, 999), '', '', '', 'Typed by hand', '', '']);

  gas.sheet('Staff').getRange(1, 9).setValue('Shirt Size'); // a new column to the right, with something in only one row
  gas.sheet('Staff').getRange(3, 9).setValue('M');
  gas.sheet('Tasks').getRange(4, 14).setValue(42); // past the last header
  gas.sheet('Settings').appendRow(['a_new_setting', 7.5, true]);
}

/**
 * A whole week through the real API and the real automation, on a sheet people have also been typing
 * in. Returns every reply in order. afterStep runs after each one.
 */
function playWeek(gas, afterStep) {
  const transcript = [];
  const record = (label, reply) => {
    transcript.push([label, reply]);
    if (afterStep) afterStep(label);
    return reply;
  };
  const post = (body) => record(body.action, gas.post(body));
  const get = (params) => record(params.action, gas.get(params));
  const tick = (moment) => {
    gas.setNow(moment);
    return record(`tick ${moment}`, gas.tick());
  };
  const save = (name, weekOf, hoursWanted, days, hours) => post({ action: 'saveAvailability', name, weekOf, hoursWanted, dayHours: hoursEach(days, hours), notes: '' });
  const lookAround = () => {
    get({ action: 'names' });
    ['Gus', 'Ana', 'Ben', 'Cora', 'Dev', 'Max'].forEach((name) => get({ action: 'boot', name }));
    get({ action: 'availability', name: 'Ana', weekOf: '2026-11-23' });
    get({ action: 'mgrOverview', code: CODE });
    get({ action: 'mgrBoard', code: CODE });
    get({ action: 'mgrHours', code: CODE });
  };

  // Thursday: setup, and everyone answers.
  gas.setNow(at(THIS_THU, '10:00'));
  const setup = adminSetup(gas);
  delete setup.sheetId; // different in every world
  delete setup.sheetUrl;
  record('adminSetup', setup);
  post({ action: 'hoursAdd', name: 'Ana', date: '2026-10-28', start: '09:00', end: '11:30', note: 'Before the site went live' });
  [MON, NEXT_MON].forEach((weekOf) => {
    save('Ana', weekOf, 8, ['Mon', 'Tue', 'Thu'], 3);
    save('Ben', weekOf, 5, ['Wed', 'Fri'], 3);
    save('Cora', weekOf, 6, ['Wed', 'Fri', 'Sat'], 8);
  });
  save('Dev', MON, 5, ['Tue', 'Thu'], 3);
  post({ action: 'saveAvailability', name: 'Dev', weekOf: NEXT_MON, none: true, notes: 'Out of state' });
  post({ action: 'mgrOneOffAdd', code: CODE, by: 'Max', title: 'Replace the lobby light bulbs', priority: 'A', minutes: 15, weekOf: MON, day: 'Tue', who: [] });
  post({ action: 'mgrOneOffAdd', code: CODE, by: 'Mia', title: 'Wipe down the rig', priority: 'B', minutes: 30, weekOf: MON, day: '', who: [] });
  post({ action: 'mgrOneOffAdd', code: CODE, by: 'Mia', title: 'Power wash the back patio', priority: 'B', minutes: 240, weekOf: MON, day: 'Tue', who: [] });
  post({ action: 'timeOffAdd', name: 'Gus', from: THU, to: THU, note: 'Visiting family' });

  // Friday: the build, with the nightly in the same tick, then someone late.
  tick(at(LAST_FRI, '07:00'));
  gas.setNow(at(LAST_FRI, '07:30'));
  save('Dev', MON, 6, ['Tue', 'Thu', 'Sat'], 3);
  lookAround();

  // Monday: Ana does her list, Cora forgets to clock out.
  tick(at(MON, '00:35'));
  gas.setNow(at(MON, '08:00'));
  post({ action: 'clockIn', name: 'Cora' });
  gas.setNow(at(MON, '09:02'));
  post({ action: 'clockIn', name: 'Ana', at: Date.parse(at(MON, '09:01')) + 12345 });
  const monday = get({ action: 'boot', name: 'Ana' }).today.tasks;
  monday.forEach((task, index) => {
    gas.setNow(Date.parse(at(MON, '09:15')) + index * 8 * 60000 + 321);
    post({ action: 'taskToggle', name: 'Ana', id: task.id, done: true });
  });
  post({ action: 'taskNote', name: 'Ana', id: monday[0].id, note: '=Two boxes at the back door' });
  gas.setNow(at(MON, '11:21'));
  post({ action: 'clockOut', name: 'Ana' });
  lookAround();

  // Tuesday: fixes, a claim, and the manager tools.
  tick(at(TUE, '00:35'));
  gas.setNow(at(TUE, '09:05'));
  const cora = get({ action: 'boot', name: 'Cora' });
  post({ action: 'clockFix', name: 'Cora', id: cora.clock.stale[0].id, out: '12:30' });
  const open = get({ action: 'boot', name: 'Ana' }).today.openTasks;
  if (open.length) post({ action: 'taskClaim', name: 'Ana', id: open[0].id });
  const added = post({ action: 'mgrOneOffAdd', code: CODE, by: 'Mia', title: 'Hose down the mats', priority: 'B', minutes: 30, weekOf: MON, day: '', who: [] });
  post({ action: 'mgrOneOffEdit', code: CODE, by: 'Mia', id: added.id, minutes: 45 });
  const doomed = post({ action: 'mgrOneOffAdd', code: CODE, by: 'Mia', title: 'Check the chalk bin', priority: 'C', minutes: 15, weekOf: MON, day: 'Wed', who: [] });
  post({ action: 'mgrOneOffDelete', code: CODE, by: 'Mia', id: doomed.id });
  const board = get({ action: 'mgrBoard', code: CODE });
  const wednesday = board.days.find((day) => day.date === WED);
  const coraDay = board.workDays.Cora.find((date) => date >= THU);
  post({ action: 'mgrAssign', code: CODE, by: 'Max', id: wednesday.groups[0].tasks[0].id, name: coraDay ? 'Cora' : 'Max', date: coraDay || THU });
  post({ action: 'hoursAdd', name: 'Dev', date: MON, start: '13:00', end: '15:15', note: 'Forgot to clock in' });
  const entry = post({ action: 'mgrHoursAdd', code: CODE, by: 'Max', name: 'Ben', date: MON, start: '10:00', end: '12:00', note: '' });
  post({ action: 'mgrHoursEdit', code: CODE, by: 'Max', id: entry.entry.id, end: '12:30' });
  const extra = post({ action: 'mgrHoursAdd', code: CODE, by: 'Max', name: 'Ben', date: MON, start: '13:00', end: '14:00', note: 'A mistake' });
  post({ action: 'mgrHoursDelete', code: CODE, by: 'Max', id: extra.entry.id });
  lookAround();

  // Wednesday: Ana takes a day away, a trip comes and goes, and people type into the sheet.
  tick(at(WED, '00:35'));
  gas.setNow(at(WED, '10:00'));
  save('Ana', MON, 6, ['Mon', 'Tue'], 3);
  const trip = post({ action: 'timeOffAdd', name: 'Ben', from: FRI, to: FRI, note: '' });
  post({ action: 'timeOffRemove', name: 'Ben', id: trip.id });
  typeIntoTheSheet(gas);
  record('typed into the sheet', { typed: true });
  lookAround();

  // Thursday: a re-run and a reminder.
  tick(at(THU, '00:35'));
  gas.setNow(at(THU, '10:00'));
  post({ action: 'mgrRebuild', code: CODE, by: 'Max', weekOf: MON });
  post({ action: 'mgrRemind', code: CODE, by: 'Max', weekOf: NEXT_MON });
  lookAround();

  // Friday: the next build.
  tick(at(FRI, '00:35'));
  tick(at(FRI, '07:00'));
  lookAround();

  // The weekend, and into the next week.
  tick(at(SAT, '00:35'));
  gas.setNow(at(SAT, '08:00'));
  post({ action: 'clockIn', name: 'Cora' });
  get({ action: 'boot', name: 'Cora' })
    .today.tasks.slice(0, 2)
    .forEach((task) => post({ action: 'taskToggle', name: 'Cora', id: task.id, done: true }));
  gas.setNow(at(SAT, '09:10'));
  post({ action: 'clockOut', name: 'Cora' });
  tick(at(SUN, '00:35'));
  gas.setNow(at(SUN, '09:00'));
  const gus = get({ action: 'boot', name: 'Gus' }).today.tasks;
  if (gus.length) {
    post({ action: 'taskToggle', name: 'Gus', id: gus[0].id, done: true });
    post({ action: 'taskToggle', name: 'Gus', id: gus[0].id, done: false });
    post({ action: 'taskNote', name: 'Gus', id: gus[0].id, note: 'Out of soap' });
  }
  lookAround();
  tick(at(NEXT_MON, '00:35'));
  lookAround();
  tick(at('2026-12-01', '07:00')); // the nightly and the monthly email in one tick
  lookAround();
  return transcript;
}

function sheetsOf(gas) {
  const out = {};
  gas.book().getSheets().forEach((sheet) => {
    const range = sheet.getDataRange();
    out[sheet.getName()] = { values: plain(range.getValues()), formulas: range.getFormulas() };
  });
  return out;
}

/** Everything a world did: every reply, every email and every cell. */
function wholeWeek(prepare) {
  const gas = sameIdsWorld(prepare);
  const transcript = playWeek(gas);
  return { gas, outcome: { transcript, mail: plain(gas.state.mail), sheets: sheetsOf(gas) } };
}

/** The week with nothing going wrong. It takes a moment, and comes out the same every time, so once is enough. */
const normalWeek = (() => {
  let week = null;
  return () => {
    if (!week) week = wholeWeek();
    return week;
  };
})();

/** Every data tab as readTab_ and headersOf_ see it, all in one run. Blanks at the end of the headers don't change what any row holds. */
function everyTab(gas) {
  return gas.run((script) =>
    plain(
      DATA_TABS.map((tab) => {
        const rows = script.readTab_(tab);
        const headers = Array.from(script.headersOf_(tab));
        while (headers.length && !headers[headers.length - 1]) headers.pop();
        return { tab, rows, headers };
      })
    )
  );
}

function assertSameAsOldWay(gas, label, headerless) {
  const fast = counted(gas, () => everyTab(gas));
  assert.strictEqual(fast.batchGet, 1, `${label}: one batch`);
  if (!headerless) assert.deepStrictEqual(fast.calls, {}, `${label}: and nothing else`); // with no header row in the batch, asking for the headers takes SpreadsheetApp
  const old = theOldWay(gas, () => everyTab(gas));
  fast.result.forEach((tab, index) => {
    sameJson(tab, old[index], `${label}: ${tab.tab}`);
  });
}

/* ------------------------------------------------------- the fake against the real ---- */

test('the fake batchGet answers the way the real one was measured to', () => {
  const gas = createGas();
  const id = gas.createBook();
  const book = gas.state.books.get(id);
  book.setSpreadsheetTimeZone(DENVER);
  const ask = (ranges) => gas.context.Sheets.Spreadsheets.Values.batchGet(id, { ranges, valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });

  const schedule = book.insertSheet('Schedule');
  schedule.appendRow(['ID', 'Week Of', 'Done', 'Minutes', 'Note']);
  schedule.appendRow(['a', new Date('2026-11-10T09:05:12.345-07:00'), true, 30, '']); // a blank at the end of the row
  schedule.getRange(4, 1, 1, 5).setValues([['b', '', false, 0, 'x']]); // row 3 stays blank, and there's a blank in the middle of row 4
  schedule.getRange(9, 3).setValue(''); // nothing down here counts
  book.insertSheet('Time Off').appendRow(['ID', 'Name']);
  book.insertSheet('Blank');
  const log = book.insertSheet('Log');
  log.appendRow(['Time', 'Who']);
  log.appendRow(['a', 'b']);

  const reply = ask(["'Schedule'", 'Schedule', "'Time Off'", "'Blank'", "'Log'!1:1", 'Log!A1:A2']);
  const serial = (Date.UTC(2026, 10, 10, 9, 5, 12, 345) - Date.UTC(1899, 11, 30)) / 86400000;
  const rows = [['ID', 'Week Of', 'Done', 'Minutes', 'Note'], ['a', serial, true, 30], [], ['b', '', false, 0, 'x']];
  assert.deepStrictEqual(reply.valueRanges, [
    { range: 'Schedule!A1:Z1000', majorDimension: 'ROWS', values: rows },
    { range: 'Schedule!A1:Z1000', majorDimension: 'ROWS', values: rows },
    { range: "'Time Off'!A1:Z1000", majorDimension: 'ROWS', values: [['ID', 'Name']] },
    { range: 'Blank!A1:Z1000', majorDimension: 'ROWS' },
    { range: 'Log!A1:Z1', majorDimension: 'ROWS', values: [['Time', 'Who']] },
    { range: 'Log!A1:A2', majorDimension: 'ROWS', values: [['Time'], ['a']] },
  ]);

  assert.throws(() => ask(["'Schedule'", "'No Such Tab'"]), /Unable to parse range/, 'one bad tab fails the whole call');
  assert.throws(() => ask(['Time Off']), /Unable to parse range/, 'a name with a space has to be quoted');
  assert.throws(() => gas.context.Sheets.Spreadsheets.Values.batchGet('nope', { ranges: ['Schedule'], valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' }), /not found/);
});

test('the fake makes dates of what Sheets would in a plain cell, using this year, and leaves a plain-text cell alone', () => {
  const gas = setUpWorld();
  const cell = gas.book().insertSheet('Lab').getRange(1, 1);
  const typed = (value, format) => cell.setNumberFormat(format).setValue(value).getValue();
  const day = (month, date) => new Date(2026, month - 1, date);
  assert.deepStrictEqual(typed('1-2', 'General'), day(1, 2));
  assert.deepStrictEqual(typed('3/4', 'General'), day(3, 4));
  assert.deepStrictEqual(typed('Dec 25', 'General'), day(12, 25));
  assert.deepStrictEqual(typed('December 25', 'General'), day(12, 25));
  assert.deepStrictEqual(typed('1:05 PM', 'General'), new Date(1899, 11, 30, 13, 5));
  assert.deepStrictEqual(typed('12:30 am', 'General'), new Date(1899, 11, 30, 0, 30));
  ['13-2', '2/30', 'Sat 5', '13:05 PM', 'Decide 25'].forEach((text) => assert.strictEqual(typed(text, 'General'), text, `${text} is no date`));
  ['1-2', '3/4', 'Dec 25', '1:05 PM'].forEach((text) => assert.strictEqual(typed(text, '@'), text, `${text} in plain text`));
  gas.setNow('2028-06-01T12:00:00-06:00');
  assert.deepStrictEqual(typed('1-2', 'General'), new Date(2028, 0, 2), 'this year goes by the fake clock');
});

test('the fake batchGet only sees writes that have been sent, and SpreadsheetApp sees them all along', () => {
  const gas = setUpWorld();
  const id = gas.state.properties.get('SHEET_ID');
  const raw = (script) => script.Sheets.Spreadsheets.Values.batchGet(id, { ranges: ["'Closed Days'"], valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' }).valueRanges[0].values;
  const sheet = gas.sheet('Closed Days');
  gas.run((script) => {
    assert.strictEqual(raw(script).length, 2);
    sheet.appendRow(['2026-12-25', 'Christmas']);
    assert.strictEqual(raw(script).length, 2, 'still waiting to be sent');
    assert.strictEqual(sheet.getLastRow(), 3, 'SpreadsheetApp sees it anyway');
    script.SpreadsheetApp.flush();
    assert.strictEqual(raw(script).length, 3, 'sent');
    sheet.appendRow(['2026-12-26', 'Boxing Day']);
  });
  assert.strictEqual(gas.run(raw).length, 4, 'and whatever is left goes out when the run ends');
  sheet.appendRow(['2026-12-27', 'Typed by a person, who waits for nothing']);
  assert.strictEqual(gas.run(raw).length, 5);
});

/* -------------------------------------------- (a) the same answers as the old read ---- */

test('reads: every tab reads the same both ways at every step of a realistic week', () => {
  const gas = sameIdsWorld();
  let steps = 0;
  playWeek(gas, (label) => {
    steps += 1;
    assertSameAsOldWay(gas, `after step ${steps}, ${label}`);
  });
  assert.ok(steps > 100, 'the whole week ran');
  const hoursTab = everyTab(gas).find((tab) => tab.tab === 'Hours');
  assert.ok(hoursTab.rows.some((row) => /\.\d*[1-9]\d*Z$/.test(row.In)), 'and some of those stamps have milliseconds to get right');
});

test('reads: the whole week comes out the same both ways: every reply, every email and every cell', () => {
  const fast = normalWeek();
  const old = wholeWeek((gas) => {
    gas.state.beforeBatch = () => {
      throw new Error('Off, to compare with the old way.');
    };
  });
  fast.outcome.transcript.forEach((step, index) => sameJson(step, old.outcome.transcript[index], `step ${index + 1}, ${step[0]}`));
  sameJson(fast.outcome, old.outcome, 'the whole week');

  fast.outcome.transcript.forEach(([label, reply]) => assert.notStrictEqual(reply.ok, false, `${label}: ${reply.error}`));
  const did = fast.outcome.transcript.map(([label]) => label);
  ['taskClaim', 'clockFix', 'mgrRebuild', 'mgrAssign', 'timeOffRemove', 'mgrHoursDelete'].forEach((action) => assert.ok(did.includes(action), `the week did a ${action}`));
  assert.ok(fast.outcome.mail.length > 10, 'and sent real email');
  assert.deepStrictEqual(warnings(fast.gas), [], 'and nothing in the week made the batch fail');
});

test('reads: the odd shapes a sheet can take read the same both ways', () => {
  const gas = setUpWorld();
  const check = (label, headerless) => assertSameAsOldWay(gas, label, headerless);
  check('just set up: Time Off, Schedule and others have only their headers');

  gas.sheet('Staff').getRange(30, 2).setValue('Far Below');
  check('a person typed far below the rest');
  gas.sheet('Staff').getRange(30, 2).setValue('');

  const staff = gas.sheet('Staff');
  const values = staff.getDataRange().getValues();
  staff.getRange(1, 1, values.length, values[0].length).setValues(values.map((line) => line.slice().reverse()));
  check('the columns in a different order');

  gas.sheet('One-Offs').getRange(2, 4).setValue('A row with almost nothing in it');
  gas.sheet('One-Offs').getRange(4, 8).setValue(new Date(2026, 10, 16));
  check('a date in a row by itself');

  gas.sheet('Settings').getRange(3, 2).setValue("'=SUM(1,1)");
  gas.sheet('Settings').getRange(4, 2).setValue("'@home");
  gas.sheet('Settings').appendRow(['a_checkbox', true, false]);
  gas.sheet('Settings').appendRow(['a_number', 0, 1.5]);
  gas.sheet('Settings').getRange(1, 3).setValue(' Notes ');
  check('apostrophes, booleans, numbers and a header with spaces around it');

  gas.sheet('Tasks').getRange(1, 1, 1, 9).clearContent();
  check('a header row someone wiped, with data still below it', true);

  gas.sheet('Closed Days').clear();
  gas.sheet('Time Off').clear();
  check('a fully blank tab', true);
  const blank = counted(gas, () => gas.run((script) => script.readTab_('Closed Days').length));
  assert.deepStrictEqual([blank.result, blank.batchGet], [0, 1]);
  assert.ok(blank.sheetReads > 0, 'setup always leaves headers, so a tab with nothing at all gets a second look through SpreadsheetApp');
});

test('reads: a write to a tab whose header row someone wiped goes the same way both ways', () => {
  const twins = [setUpWorld(), setUpWorld()];
  twins[1].state.beforeBatch = () => {
    throw new Error('Off, to compare with the old way.');
  };
  const replies = twins.map((gas) => {
    gas.sheet('Time Off').getRange(1, 1, 1, 7).clearContent();
    gas.sheet('Time Off').getRange(2, 2).setValue('Typed below where the headers were');
    return gas.post({ action: 'timeOffAdd', name: 'Ana', from: '2026-12-01', to: '2026-12-02', note: '' });
  });
  sameJson(replies[0], replies[1], 'the reply');
  ok(replies[0]);
  sameJson(sheetsOf(twins[0]), sheetsOf(twins[1]), 'the sheets');
});

test('reads: which numbers are dates comes from COLUMN_FORMATS_ and DATE_COLUMNS_, with no second list to keep up', () => {
  const gas = setUpWorld();
  const script = gas.context;
  const stamps = [['One-Offs', 'Added'], ['One-Offs', 'Done At'], ['Availability', 'Submitted At'], ['Time Off', 'Added At'], ['Schedule', 'Done At'], ['Hours', 'In'], ['Hours', 'Out'], ['Hours', 'Edited At'], ['Hours', 'Date']];
  const dates = [['One-Offs', 'Week Of'], ['Availability', 'Week Of'], ['Time Off', 'From'], ['Time Off', 'To'], ['Schedule', 'Week Of'], ['Schedule', 'Date'], ['Schedule', 'Rolled From'], ['Closed Days', 'Date']];
  stamps.concat(dates).forEach(([tab, header]) => assert.strictEqual(script.isDateLike_(tab, header), true, `${tab}: ${header}`));
  [['Schedule', 'Minutes'], ['Hours', 'Hours'], ['Settings', 'Value'], ['Staff', 'Rank'], ['Tasks', 'Flex Days'], ['Availability', 'Hours Wanted'], ['Staff', 'Not A Column']].forEach(([tab, header]) => {
    assert.strictEqual(script.isDateLike_(tab, header), false, `${tab}: ${header}`);
  });

  script.COLUMN_FORMATS_.Staff.Hired = script.DATE_FORMAT_; // a new column only needs its format
  script.COLUMN_FORMATS_.Staff.Seen = script.STAMP_FORMAT_;
  assert.strictEqual(script.isDateLike_('Staff', 'Hired'), true);
  assert.strictEqual(script.isDateLike_('Staff', 'Seen'), true);
});

test('reads: a plain number in a date column reads as a date, since the batch can\'t tell them apart', () => {
  const gas = setUpWorld();
  const row = gas.sheet('Closed Days').getLastRow() + 1;
  typeCell(gas, 'Closed Days', row, 'Date', 46336); // a date cell and a plain number both arrive as this
  assert.strictEqual(gas.call('readTab_', 'Closed Days').find((line) => line._row === row).Date, TUE);
});

test('reads: a number that can\'t be a date is left alone, so one bad cell can\'t break a read', () => {
  const gas = setUpWorld();
  const row = gas.sheet('Closed Days').getLastRow() + 1;
  [1e15, -5].forEach((number, index) => {
    typeCell(gas, 'Closed Days', row + index, 'Date', number);
    gas.sheet('Closed Days').getRange(row + index, 2).setValue(`Line ${index}`);
  });
  const lines = gas.call('readTab_', 'Closed Days').filter((line) => line._row >= row);
  sameJson(lines, theOldWay(gas, () => gas.call('readTab_', 'Closed Days')).filter((line) => line._row >= row), 'no date either way');
  assert.deepStrictEqual(lines.map((line) => line.Date), ['', '']);
  ok(gas.get({ action: 'names' }));
  assert.strictEqual(gas.call('batchCell_', 'Hours', 'In', 2958466), 2958466, 'one past the last possible day');
  assert.match(gas.call('batchCell_', 'Hours', 'In', 2958465), /^9999-12-31T/, 'the last possible day is still a date');
  assert.match(gas.call('batchCell_', 'Hours', 'In', 0), /^1899-12-30T/, 'and so is the first');
});

/** The same steps in two worlds, one with the batch failing, and what each came to. They have to match. */
function bothWays(steps) {
  const twins = [setUpWorld(), setUpWorld()];
  twins[1].state.beforeBatch = () => {
    throw new Error('Off, to compare with the old way.');
  };
  const [fast, old] = twins.map(steps);
  sameJson(fast, old, 'both ways');
  return fast;
}

function firstWeekRow(gas) {
  return gas.rows('Settings').find((line) => line.Key === 'first_week')._row;
}

test('reads: first_week in a date cell still stops the weeks before it', () => {
  const outcome = bothWays((gas) => {
    typeCell(gas, 'Settings', firstWeekRow(gas), 'Value', '11/16/2026'); // Sheets makes this a date in a plain cell
    ok(gas.post({ action: 'saveAvailability', name: 'Ana', weekOf: MON, hoursWanted: 6, dayHours: hoursEach(['Mon'], 3), notes: '' }));
    const firstWeek = gas.call('firstWeek_');
    const oneOff = gas.post({ action: 'mgrOneOffAdd', code: CODE, by: 'Max', title: 'Too early', priority: 'B', minutes: 15, weekOf: MON, day: 'Tue', who: [] });
    const weeks = ok(gas.get({ action: 'mgrBoard', code: CODE })).weeks.map((week) => week.weekOf);
    gas.setNow(at(LAST_FRI, '07:00'));
    const tick = gas.tick();
    return { firstWeek, oneOff, weeks, tick, marker: gas.state.properties.get('RUN_WEEK_2026-11-09_DONE'), schedule: gas.rows('Schedule').length, mail: gas.state.mail.length };
  });
  assert.strictEqual(outcome.firstWeek, NEXT_MON);
  assert.strictEqual(outcome.oneOff.error, 'The site starts the week of Nov 16. Please pick that week or a later one.');
  assert.ok(!outcome.weeks.includes(MON), 'the board offers nothing before it');
  assert.deepStrictEqual(outcome.tick.failed, []);
  assert.strictEqual(outcome.marker, 'skipped', 'the Friday run skips it');
  assert.deepStrictEqual([outcome.schedule, outcome.mail], [0, 0], 'and builds and sends nothing');
});

test('reads: first_week reads the same both ways however it got there, and a number that could be no date is no first week', () => {
  const inCell = (value, format) => (gas) => {
    typeCell(gas, 'Settings', firstWeekRow(gas), 'Value', value);
    if (format) gas.sheet('Settings').getRange(firstWeekRow(gas), columnOf(gas.sheet('Settings'), 'Value')).setNumberFormat(format).setValue(value);
    return gas.call('firstWeek_');
  };
  assert.strictEqual(bothWays(inCell(46342)), NEXT_MON, 'a plain number, which the batch can\'t tell from a date');
  assert.strictEqual(bothWays(inCell('Dec 7')), '2026-12-07', 'Sheets makes a date of this one too');
  ['2026-11-16', '11/16/2026', 'Nov 16'].forEach((text) => assert.strictEqual(bothWays(inCell(text, '@')), NEXT_MON, `${text} in a plain-text cell`));
  [1e15, -5].forEach((number) => assert.strictEqual(bothWays(inCell(number)), '', String(number)));
});

test('reads: a date in Flex Days counts as no flex, so it can\'t move a task or send the Friday run through tens of thousands of days', () => {
  const outcome = bothWays((gas) => {
    typeCell(gas, 'Tasks', gas.rows('Tasks').find((line) => line.ID === 'T02')._row, 'Flex Days', '1-2'); // Sheets makes this January 2
    ['Ana', 'Ben'].forEach((name) => ok(gas.post({ action: 'saveAvailability', name, weekOf: MON, hoursWanted: 8, dayHours: hoursEach(['Mon', 'Thu'], 3), notes: '' })));
    gas.setNow(at(LAST_FRI, '07:00'));
    gas.tick();
    return {
      flex: gas.call('tasks_').find((task) => task.id === 'T02').flexDays,
      rows: gas.rows('Schedule').filter((row) => row['Task ID'] === 'T02').map((row) => [row.Date, row.Name]),
    };
  });
  assert.strictEqual(outcome.flex, 0);
  assert.deepStrictEqual(outcome.rows, [[TUE, ''], [FRI, '']], 'it stays open on its own days, with nobody free then');
});

test('reads: Flex Days keeps any believable number of days', () => {
  const gas = setUpWorld();
  const row = gas.rows('Tasks').find((line) => line.ID === 'T02')._row;
  [[0, 0], [2, 2], ['3 days', 3], [366, 366], [367, 0], [-3, 0], ['', 0], ['soon', 0]].forEach(([typed, flex]) => {
    typeCell(gas, 'Tasks', row, 'Flex Days', typed);
    assert.strictEqual(gas.call('tasks_').find((task) => task.id === 'T02').flexDays, flex, `typed ${typed}`);
  });
});

test('reads: the Friday summary and the schedule agree about a plain number in Closed Days', () => {
  const friday = (gas) => {
    typeCell(gas, 'Closed Days', gas.sheet('Closed Days').getLastRow() + 1, 'Date', 46338); // the number for Thursday
    gas.sheet('Closed Days').appendRow(['Someday soon', 'Reads as nothing']);
    ['Ana', 'Ben', 'Cora', 'Dev'].forEach((name) => ok(gas.post({ action: 'saveAvailability', name, weekOf: MON, hoursWanted: 8, dayHours: hoursEach(['Mon', 'Thu'], 3), notes: '' })));
    gas.setNow(at(LAST_FRI, '07:00'));
    gas.tick();
    const summary = JSON.stringify(gas.state.mail.find((mail) => /schedule is out/.test(mail.subject)));
    return { thursday: gas.rows('Schedule').filter((row) => row.Date === THU).length, unreadable: /scheduled as usual: ([^.]*)\./.exec(summary)[1] };
  };
  const fast = friday(setUpWorld());
  assert.deepStrictEqual(fast, { thursday: 0, unreadable: 'Someday soon' }, 'the batch reads the number as a date, so that day is closed, and the summary doesn\'t say otherwise');
  const slowGas = setUpWorld();
  slowGas.state.beforeBatch = () => {
    throw new Error('Off, to compare with the old way.');
  };
  const slow = friday(slowGas);
  assert.strictEqual(slow.unreadable, '46338, Someday soon', 'SpreadsheetApp reads a plain number, so that day is open, and the summary says that');
  assert.ok(slow.thursday > 0);
});

test('reads: looking for unreadable closed days stays on the batch, and still sees a write in the same run', () => {
  const gas = setUpWorld();
  gas.sheet('Closed Days').appendRow(['Someday soon', '']);
  const run = counted(gas, () => gas.call('unreadableClosedDays_'));
  assert.deepStrictEqual(run.result, ['Someday soon']);
  assert.deepStrictEqual([run.batchGet, run.sheetReads, run.openById], [1, 0, 0]);
  gas.run((script) => {
    script.appendRows_('Closed Days', [{ Date: 'Next Tuesday', Note: '' }]);
    assert.deepStrictEqual(Array.from(script.unreadableClosedDays_()), ['Someday soon', 'Next Tuesday']);
  });
  gas.sheet('Closed Days').getRange(1, 1, 1, 2).clearContent();
  assert.deepStrictEqual(gas.call('unreadableClosedDays_'), [], 'with no Date column to look in, there is nothing to say');
});

/* ---------------------------------------------------- (b) numbers back into dates ---- */

/** The number a sheet holds for this Denver clock reading, worked out here and not by the code being tested. */
function serialOf(year, month, day, hour, minute, second, ms) {
  return (Date.UTC(year, month - 1, day, hour, minute, second || 0, ms || 0) - Date.UTC(1899, 11, 30)) / 86400000;
}

test('serial numbers: on and around both clock changes, to the millisecond', () => {
  const gas = setUpWorld();
  const cases = [
    // The clocks go back at 2:00 AM on Nov 1, 2026.
    [[2026, 10, 31, 23, 59, 59, 999], '2026-11-01T05:59:59.999Z'],
    [[2026, 11, 1, 0, 0, 0, 0], '2026-11-01T06:00:00.000Z'],
    [[2026, 11, 1, 0, 59, 59, 250], '2026-11-01T06:59:59.250Z'],
    [[2026, 11, 1, 1, 0, 0, 0], '2026-11-01T07:00:00.000Z'], // the repeated hour reads as its first pass
    [[2026, 11, 1, 1, 30, 15, 500], '2026-11-01T07:30:15.500Z'],
    [[2026, 11, 1, 1, 59, 59, 999], '2026-11-01T07:59:59.999Z'],
    [[2026, 11, 1, 2, 0, 0, 0], '2026-11-01T09:00:00.000Z'],
    [[2026, 11, 1, 2, 30, 0, 1], '2026-11-01T09:30:00.001Z'],
    [[2026, 11, 1, 23, 59, 59, 999], '2026-11-02T06:59:59.999Z'],
    [[2026, 11, 2, 0, 0, 0, 0], '2026-11-02T07:00:00.000Z'],
    // They go forward at 2:00 AM on Mar 14, 2027.
    [[2027, 3, 13, 23, 59, 59, 999], '2027-03-14T06:59:59.999Z'],
    [[2027, 3, 14, 0, 0, 0, 0], '2027-03-14T07:00:00.000Z'],
    [[2027, 3, 14, 1, 59, 59, 999], '2027-03-14T08:59:59.999Z'],
    [[2027, 3, 14, 3, 0, 0, 0], '2027-03-14T09:00:00.000Z'],
    [[2027, 3, 14, 3, 0, 0, 1], '2027-03-14T09:00:00.001Z'],
    [[2027, 3, 14, 23, 59, 59, 999], '2027-03-15T05:59:59.999Z'],
    [[2027, 3, 15, 0, 0, 0, 0], '2027-03-15T06:00:00.000Z'],
    // Back again on Nov 7, 2027.
    [[2027, 11, 7, 0, 30, 0, 0], '2027-11-07T06:30:00.000Z'],
    [[2027, 11, 7, 3, 30, 0, 0], '2027-11-07T10:30:00.000Z'],
    // The year boundary, a leap day, and ordinary days in each season.
    [[2026, 12, 31, 23, 59, 59, 999], '2027-01-01T06:59:59.999Z'],
    [[2027, 1, 1, 0, 0, 0, 0], '2027-01-01T07:00:00.000Z'],
    [[2028, 2, 29, 12, 0, 0, 0], '2028-02-29T19:00:00.000Z'],
    [[2026, 11, 10, 9, 5, 12, 345], '2026-11-10T16:05:12.345Z'],
    [[2027, 7, 4, 9, 5, 12, 345], '2027-07-04T15:05:12.345Z'],
  ];
  cases.forEach(([parts, expected]) => {
    assert.strictEqual(gas.call('serialToDate_', serialOf(...parts)), expected, parts.join(' '));
  });
  assert.strictEqual(gas.call('serialToDate_', serialOf(2026, 11, 10, 0, 0)), '2026-11-10T07:00:00.000Z', 'a plain date is midnight in Denver');
});

test('serial numbers: every hour of a year comes back as the same moment, except the repeated hour', () => {
  const gas = setUpWorld();
  const start = Date.parse('2026-10-25T00:00:00Z');
  const end = Date.parse('2027-11-14T00:00:00Z');
  const repeated = [
    [Date.parse('2026-11-01T08:00:00Z'), Date.parse('2026-11-01T09:00:00Z')],
    [Date.parse('2027-11-07T08:00:00Z'), Date.parse('2027-11-07T09:00:00Z')],
  ];
  gas.run((script) => {
    let checked = 0;
    for (let moment = start; moment < end; moment += 61 * 60000 + 7) {
      if (repeated.some(([from, to]) => moment >= from && moment < to)) continue;
      const back = script.serialToDate_(dateToSerial(new Date(moment), DENVER));
      assert.strictEqual(back.getTime(), moment, new Date(moment).toISOString());
      checked += 1;
    }
    assert.ok(checked > 8000);
  });
});

test('serial numbers: a sheet only keeps the clock reading, so the second pass of the repeated hour reads as the first', () => {
  const gas = setUpWorld();
  const firstPass = new Date('2026-11-01T01:30:00-06:00');
  const secondPass = new Date('2026-11-01T01:30:00-07:00');
  assert.strictEqual(dateToSerial(firstPass, DENVER), dateToSerial(secondPass, DENVER));
  assert.strictEqual(gas.call('serialToDate_', dateToSerial(secondPass, DENVER)), firstPass.toISOString());
});

test('serial numbers: a time the clocks skip reads as an hour on, the way a clock nobody changed would', () => {
  const gas = setUpWorld();
  // On Mar 14, 2027 the clocks go from 1:59 AM to 3:00 AM, so 2:30 AM never happens. A person can still type it into a sheet.
  assert.strictEqual(gas.call('serialToDate_', serialOf(2027, 3, 14, 2, 30)), '2027-03-14T09:30:00.000Z');
  assert.strictEqual(gas.call('serialToDate_', serialOf(2027, 3, 14, 2, 0)), '2027-03-14T09:00:00.000Z');
  assert.strictEqual(gas.call('serialToDate_', serialOf(2027, 3, 14, 2, 59, 59, 999)), '2027-03-14T09:59:59.999Z');
});

test('reads: stamps in the sheet read the same both ways around the clock changes', () => {
  const gas = setUpWorld();
  const sheet = gas.sheet('Hours');
  const add = (day, inAt, outAt) => sheet.appendRow(['', day, 'Ana', new Date(inAt), outAt ? new Date(outAt) : '', '', '', '', '', '', '']);
  add(new Date(2026, 9, 31), '2026-10-31T23:15:30.125-06:00', '2026-11-01T00:45:10.500-06:00');
  add(new Date(2026, 10, 1), '2026-11-01T02:15:00.000-07:00', '2026-11-01T03:00:59.999-07:00');
  add(new Date(2027, 2, 13), '2027-03-13T23:30:00.000-07:00', '2027-03-14T03:30:00.000-06:00'); // four hours on the clock, three worked
  add(new Date(2027, 2, 14), '2027-03-14T05:00:01.001-06:00', '');
  add(new Date(2026, 11, 31), '2026-12-31T23:59:59.999-07:00', '2027-01-01T00:00:00.001-07:00');
  sheet.getRange(3, columnOf(sheet, 'Edited At')).setValue(new Date('2027-03-14T01:59:59.999-07:00'));
  gas.sheet('Time Off').appendRow(['', 'Ben', new Date(2027, 2, 14), new Date(2026, 10, 1), '', new Date('2026-11-01T00:00:00-06:00'), '']);
  typeCell(gas, 'Availability', 2, 'Submitted At', new Date('2027-03-14T03:00:00-06:00'));
  assertSameAsOldWay(gas, 'around the clock changes');

  const springEntry = gas.call('readTab_', 'Hours').find((row) => row.Date === '2027-03-13');
  assert.strictEqual(Date.parse(springEntry.Out) - Date.parse(springEntry.In), 3 * 3600000, 'real time across the change');
  assert.strictEqual(springEntry.In, '2027-03-14T06:30:00.000Z');
});

/* --------------------------------------------------- (c) a run reads its own writes ---- */

test('reads: a run sees its own writes, from all three write helpers', () => {
  const gas = setUpWorld();
  const c = gas.state.counters;
  const id = gas.state.properties.get('SHEET_ID');
  gas.run((script) => {
    assert.strictEqual(script.staff_().length, 10);
    const batches = c.batchGet;

    const ana = script.personNamed_('Ana');
    script.updateRow_('Staff', ana._row, { Notes: 'Changed in this run', Rank: 99 });
    assert.strictEqual(script.personNamed_('Ana').notes, 'Changed in this run', 'updateRow_');
    assert.strictEqual(script.personNamed_('Ana').rank, 99);

    script.appendRows_('Closed Days', [{ Date: '2026-12-25', Note: 'Christmas' }]);
    assert.strictEqual(script.closedDays_()['2026-12-25'], 'Christmas', 'appendRows_');

    const rows = script.readTab_('Closed Days');
    const christmas = rows.filter((row) => row.Date === '2026-12-25')[0];
    script.deleteRows_('Closed Days', [christmas._row]);
    assert.strictEqual(script.closedDays_()['2026-12-25'], undefined, 'deleteRows_');

    assert.strictEqual(c.batchGet, batches, 'none of that took another batch');
    const raw = script.Sheets.Spreadsheets.Values.batchGet(id, { ranges: ["'Staff'"], valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
    assert.ok(!JSON.stringify(raw).includes('Changed in this run'), 'the batch itself has no way of seeing them yet');
  });
  gas.run((script) => {
    assert.strictEqual(script.personNamed_('Ana').notes, 'Changed in this run', 'and the next run gets them from its batch');
    assert.strictEqual(script.personNamed_('Ana').rank, 99);
    assert.strictEqual(script.closedDays_()['2026-12-25'], undefined);
  });
});

test('reads: after a write, only that tab goes back to SpreadsheetApp', () => {
  const gas = setUpWorld();
  const reads = (work) => counted(gas, work).sheetReads;
  gas.run((script) => {
    const reading = (tab) => reads(() => script.readTab_(tab));
    assert.strictEqual(reading('Staff'), 0);
    assert.strictEqual(reading('Tasks'), 0);
    script.updateRow_('Staff', script.readTab_('Staff')[0]._row, { Notes: 'Changed' });
    assert.ok(reading('Staff') > 0, 'the tab that changed reads through SpreadsheetApp');
    assert.strictEqual(reading('Staff'), 0, 'once');
    assert.strictEqual(reading('Tasks'), 0, 'the tab that did not change stays on the batch');
    assert.strictEqual(reading('Settings'), 0);
  });
});

test('reads: a task claim and a clock-in answer with what they just wrote', () => {
  const gas = resetWorld();
  const open = ok(gas.get({ action: 'boot', name: 'Ana' })).today.openTasks[0];
  assert.ok(open, 'the dev world has something open on Tuesday');
  assert.strictEqual(ok(gas.post({ action: 'taskClaim', name: 'Ana', id: open.id })).task.id, open.id);
  assert.ok(ok(gas.get({ action: 'boot', name: 'Ana' })).today.tasks.some((task) => task.id === open.id));

  const clock = ok(gas.post({ action: 'clockIn', name: 'Dev' })).clock;
  assert.strictEqual(clock.status, 'in', 'the Hours row it just added, within the same run');
  assert.strictEqual(clock.entry.in, '9:05 AM');
});

/* ---------------------------------------------------- (d) flushing before the batch ---- */

test('reads: a write made before the batch goes out first', () => {
  const gas = setUpWorld();
  const closedRow = gas.rows('Closed Days')[0]._row;
  const seen = gas.run((script) => {
    const c = gas.state.counters;
    const before = { flush: c.flush, batchGet: c.batchGet };
    script.deleteRows_('Closed Days', [closedRow]); // the one write helper that reads nothing first
    assert.strictEqual(c.batchGet, before.batchGet, 'no batch has been made yet');
    assert.strictEqual(c.flush, before.flush);
    const rows = plain(script.readTab_('Closed Days'));
    assert.strictEqual(c.flush, before.flush + 1, 'it flushed');
    assert.strictEqual(c.batchGet, before.batchGet + 1, 'and then made the batch');
    script.readTab_('Staff');
    assert.strictEqual(c.flush, before.flush + 1, 'once');
    return rows;
  });
  assert.deepStrictEqual(seen, []);
});

test('reads: with nothing written first, nothing gets flushed', () => {
  const gas = setUpWorld();
  const run = counted(gas, () => gas.run((script) => script.readTab_('Staff').length));
  assert.strictEqual(run.flush, 0);
  assert.strictEqual(run.batchGet, 1);
});

test('reads: writes before a cache reset still go out before the next batch', () => {
  const gas = setUpWorld();
  gas.run((script) => {
    const c = gas.state.counters;
    const row = script.readTab_('Settings')[0]._row;
    const flushes = c.flush;
    script.updateRow_('Settings', row, { Notes: 'Written before the reset' });
    script.resetRequestCache_();
    assert.strictEqual(c.flush, flushes, 'not until it is needed');
    const seen = script.readTab_('Settings').filter((line) => line._row === row)[0];
    assert.strictEqual(seen.Notes, 'Written before the reset');
    assert.strictEqual(c.flush, flushes + 1);
  });
});

test('reads: one job in a tick sees what the job before it wrote', () => {
  const gas = setUpWorld();
  const row = gas.rows('Settings').find((line) => line.Key === 'first_week')._row;
  gas.context.nightlyRoll_ = () => {
    gas.context.updateRow_('Settings', row, { Value: '2027-01-04' }); // pushes the first week back, so the Friday run has to skip this one
  };
  gas.setNow(at(LAST_FRI, '07:00'));
  const run = counted(gas, () => gas.tick());
  assert.deepStrictEqual(run.result, { ran: ['nightly', 'weekly', 'monthly'], failed: [] });
  assert.strictEqual(gas.state.properties.get('RUN_WEEK_2026-11-09_DONE'), 'skipped', 'the second job saw it');
  assert.deepStrictEqual(gas.rows('Schedule'), [], 'and built nothing');
});

test('reads: a failed flush on the way to the batch falls back, and still sees the write', () => {
  const gas = setUpWorld();
  gas.run((script) => {
    const row = script.readTab_('Settings')[0]._row;
    script.updateRow_('Settings', row, { Notes: 'Waiting to be sent' });
    script.resetRequestCache_();
    const flush = script.SpreadsheetApp.flush;
    script.SpreadsheetApp.flush = () => {
      throw new Error('Service error: Spreadsheets');
    };
    const seen = script.readTab_('Settings').filter((line) => line._row === row)[0];
    script.SpreadsheetApp.flush = flush;
    assert.strictEqual(seen.Notes, 'Waiting to be sent');
  });
  assert.strictEqual(warnings(gas).length, 1);
});

test('reads: adminSetup stays off the batch, the first time and every time after', () => {
  const gas = sameIdsWorld();
  gas.setNow(at(THIS_THU, '10:00'));
  const first = counted(gas, () => ok(adminSetup(gas)));
  assert.strictEqual(first.batchGet, 0, 'the first run');
  const again = counted(gas, () => ok(gas.post({ action: 'adminSetup', code: CODE })));
  assert.strictEqual(again.batchGet, 0, 'and a run on a sheet that already has everything');
  assert.deepStrictEqual(gas.state.batchRanges, []);
  assert.deepStrictEqual(warnings(gas), []);

  assert.strictEqual(counted(gas, () => ok(gas.get({ action: 'names' }))).batchGet, 1, 'the next request is back on it');
});

/* -------------------------------------------- (d, continued) when a write or a request fails ---- */

/** Makes the nth call of one of a sheet's methods throw a service error. Every other call works as usual. */
function failNthCall(sheet, method, n) {
  let calls = 0;
  sheet[method] = function (...args) {
    calls += 1;
    if (calls === n) throw new Error('Service Spreadsheets failed while accessing document');
    return Object.getPrototypeOf(sheet)[method].apply(this, args);
  };
}

test('reads: a run that starts with a write doesn\'t flush for nothing on the way to its batch', () => {
  const gas = setUpWorld();
  const c = gas.state.counters;
  gas.run((script) => {
    const before = { flush: c.flush, batchGet: c.batchGet };
    script.updateRow_('Settings', 2, { Notes: 'The first thing this run did' });
    assert.deepStrictEqual([c.flush, c.batchGet], [before.flush, before.batchGet + 1]);
    assert.strictEqual(script.readTab_('Settings').find((line) => line._row === 2).Notes, 'The first thing this run did');
  });
});

test('reads: a change to a row that fails partway still goes out before the next batch', () => {
  const gas = setUpWorld();
  const c = gas.state.counters;
  gas.run((script) => {
    script.readTab_('Settings');
    failNthCall(gas.sheet('Settings'), 'getRange', 2); // the first cell goes in, the second doesn't
    assert.throws(() => script.updateRow_('Settings', 2, { Notes: 'Went in', Value: 'Did not' }), /Service Spreadsheets/);
    script.resetRequestCache_(); // what tick does between jobs
    const flushes = c.flush;
    const row = script.readTab_('Settings').find((line) => line._row === 2);
    assert.strictEqual(row.Notes, 'Went in');
    assert.strictEqual(c.flush, flushes + 1, 'flushed first');
  });
});

test('reads: a delete that fails partway still goes out before the next batch', () => {
  const gas = setUpWorld();
  const c = gas.state.counters;
  const sheet = gas.sheet('Closed Days');
  ['Line 3', 'Line 4', 'Line 5'].forEach((note) => sheet.appendRow(['2027-01-01', note]));
  gas.run((script) => {
    script.readTab_('Closed Days');
    failNthCall(sheet, 'deleteRows', 2); // bottom up, so row 5 goes and row 3 doesn't
    assert.throws(() => script.deleteRows_('Closed Days', [3, 5]), /Service Spreadsheets/);
    script.resetRequestCache_();
    const flushes = c.flush;
    assert.deepStrictEqual(plain(script.readTab_('Closed Days')).map((line) => line._row), [2, 3, 4], 'row 5 is gone');
    assert.strictEqual(c.flush, flushes + 1, 'flushed first');
  });
});

test('reads: an add that fails partway still goes out before the next batch', () => {
  const gas = setUpWorld();
  const c = gas.state.counters;
  gas.run((script) => {
    script.readTab_('Closed Days');
    failNthCall(gas.sheet('Closed Days'), 'getRange', 3); // the formats go in on calls 1 and 2, and the values fail on call 3
    assert.throws(() => script.appendRows_('Closed Days', [{ Date: '2027-01-01', Note: 'New Year' }]), /Service Spreadsheets/);
    script.resetRequestCache_();
    const flushes = c.flush;
    script.readTab_('Closed Days');
    assert.strictEqual(c.flush, flushes + 1, 'flushed first');
  });
});

/** Puts a watch on the lock. `onRelease` runs each time it's let go, with the tabs that still have writes waiting to be sent. */
function watchLock(gas, onRelease) {
  gas.context.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      waitLock() {},
      hasLock: () => true,
      releaseLock() {
        onRelease(gas.book().getSheets().filter((sheet) => sheet.sent).map((sheet) => sheet.getName()));
      },
    }),
  };
}

test('reads: a request that fails after writing sends its writes before it lets go of the lock', () => {
  const gas = resetWorld();
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, by: 'Max', title: 'Doomed', priority: 'B', minutes: 15, weekOf: MON, day: 'Wed', who: [] }));
  const waiting = [];
  watchLock(gas, (tabs) => waiting.push(tabs));
  gas.context.managerName_ = () => {
    throw new Error('Service Spreadsheets failed while accessing document');
  };
  const flushes = gas.state.counters.flush;
  const reply = gas.post({ action: 'mgrOneOffDelete', code: CODE, by: 'Max', id: added.id });
  assert.strictEqual(reply.error, 'Something went wrong on our end. Please try again.', 'the page hears what it always did');
  assert.deepStrictEqual(waiting, [[]], 'nothing was left waiting');
  assert.strictEqual(gas.state.counters.flush, flushes + 1);
});

test('reads: the next request in line sees what a failed request wrote, so its tap lands on the right row', () => {
  const gas = resetWorld();
  const doomed = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, by: 'Max', title: 'Doomed', priority: 'B', minutes: 15, weekOf: MON, day: 'Wed', who: [] }));
  const rows = gas.rows('Schedule');
  const doomedRow = rows.find((row) => row['One-Off ID'] === doomed.id)._row;
  ['Second', 'Third', 'Fourth'].forEach((title, index) => ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, by: 'Max', title, priority: 'B', minutes: 15, weekOf: MON, day: 'Wed', who: [index % 2 ? 'Cora' : 'Ben'] })));
  const after = gas.rows('Schedule');
  const mine = after.find((row) => row._row > doomedRow && row.Name && row.Status === 'open' && after[row._row - 1] && after[row._row - 1].Name && after[row._row - 1].Name !== row.Name);
  assert.ok(mine, 'an open row below the doomed one, with someone else\'s row right under it');

  gas.context.managerName_ = () => {
    throw new Error('Service Spreadsheets failed while accessing document');
  };
  // The tap is a run of its own, waiting on the lock. It starts the moment the lock is let go.
  let tap = null;
  watchLock(gas, () => {
    if (tap) return;
    tap = {};
    const failedRun = gas.context.REQ_;
    gas.context.REQ_ = null;
    tap = gas.post({ action: 'taskToggle', name: mine.Name, id: mine.ID, done: true });
    gas.context.REQ_ = failedRun;
  });
  assert.strictEqual(gas.post({ action: 'mgrOneOffDelete', code: CODE, by: 'Max', id: doomed.id }).ok, false);
  ok(tap);
  const done = gas.rows('Schedule').filter((row) => row['Done By'] === mine.Name && row.Status === 'done' && row['One-Off ID']);
  assert.deepStrictEqual(done.map((row) => row.ID), [mine.ID], 'that row is done, and nobody else\'s');
});

test('reads: setup that fails partway sends what it wrote before it lets go of the lock', () => {
  const gas = sameIdsWorld();
  gas.setNow(at(THIS_THU, '10:00'));
  const waiting = [];
  watchLock(gas, (tabs) => waiting.push(tabs));
  gas.context.seedSettings_ = () => {
    throw new Error('Service Spreadsheets failed while accessing document'); // right after it made the tabs, which it writes straight to the sheet
  };
  assert.strictEqual(adminSetup(gas).ok, false);
  assert.deepStrictEqual(waiting, [[]]);
  assert.ok(gas.sheet('Staff'), 'and the tabs it made are there');
});

test('reads: a request turned away before it wrote anything has nothing to send', () => {
  const gas = resetWorld();
  const run = counted(gas, () => gas.post({ action: 'taskToggle', name: 'Ana', id: 'no-such-row', done: true }));
  assert.strictEqual(run.result.error, "We can't find that task. Please refresh and try again.");
  assert.strictEqual(run.flush, 0);
});

test('reads: a flush that fails on the way out can\'t hide what really went wrong, and the lock still gets let go', () => {
  const gas = resetWorld();
  const added = ok(gas.post({ action: 'mgrOneOffAdd', code: CODE, by: 'Max', title: 'Doomed', priority: 'B', minutes: 15, weekOf: MON, day: 'Wed', who: [] }));
  let released = 0;
  watchLock(gas, () => {
    released += 1;
  });
  gas.context.managerName_ = () => gas.context.fail_('A sentence for the page.');
  const flush = gas.context.SpreadsheetApp.flush;
  gas.context.SpreadsheetApp.flush = () => {
    throw new Error('Service Spreadsheets failed while accessing document');
  };
  const reply = gas.post({ action: 'mgrOneOffDelete', code: CODE, by: 'Max', id: added.id });
  gas.context.SpreadsheetApp.flush = flush;
  assert.deepStrictEqual(reply, { ok: false, error: 'A sentence for the page.' });
  assert.strictEqual(released, 1);
  assert.ok(gas.state.logs.some((line) => line.level === 'error' && /Could not send/.test(line.text)), 'and the log says so');
});

/* -------------------------------------------------------- (e) when the batch fails ---- */

/** The real reply, bent by `bend` before the script sees it. */
function bentReply(gas, bend) {
  const real = gas.context.Sheets.Spreadsheets.Values.batchGet;
  gas.context.Sheets.Spreadsheets.Values.batchGet = (id, options) => {
    const reply = plain(real(id, options));
    bend(reply);
    return reply;
  };
}

const FAILURES = {
  'no Sheets service at all': (gas) => {
    delete gas.context.Sheets;
  },
  'a Sheets service with no Values': (gas) => {
    gas.context.Sheets = { Spreadsheets: {} };
  },
  'a quota error': (gas) => {
    gas.state.beforeBatch = () => {
      throw new Error('API call to sheets.spreadsheets.values.batchGet failed with error: Quota exceeded for quota metric');
    };
  },
  'a 500': (gas) => {
    gas.state.beforeBatch = () => {
      throw new Error('API call to sheets.spreadsheets.values.batchGet failed with error: Internal error encountered.');
    };
  },
  'something thrown that is not an Error': (gas) => {
    gas.state.beforeBatch = () => {
      throw 'Service unavailable';
    };
  },
  'an empty reply': (gas) => {
    gas.state.beforeBatch = () => ({});
  },
  'no reply at all': (gas) => {
    gas.state.beforeBatch = () => null;
  },
  'too few ranges back': (gas) => {
    gas.state.beforeBatch = () => ({ valueRanges: [] });
  },
  'a broken range in the reply': (gas) => {
    gas.state.beforeBatch = (id, options) => ({ valueRanges: options.ranges.map(() => null) });
  },
  'a batch that fails every other time': (gas) => {
    let calls = 0;
    const realBatch = gas.context.Sheets.Spreadsheets.Values.batchGet;
    gas.context.Sheets.Spreadsheets.Values.batchGet = (id, options) => {
      calls += 1;
      if (calls % 2) throw new Error('Service error: Spreadsheets');
      return realBatch(id, options);
    };
  },
  'a long string where the ranges should be': (gas) => {
    gas.state.beforeBatch = () => ({ valueRanges: 'abcdefghijklmnopqrstuvwxyz' });
  },
  'an object where a tab\'s rows should be': (gas) => {
    bentReply(gas, (reply) => {
      reply.valueRanges[0].values = { rows: 3 };
    });
  },
  'a number where a tab\'s rows should be': (gas) => {
    bentReply(gas, (reply) => {
      reply.valueRanges[0].values = 5;
    });
  },
  'true where a tab\'s rows should be': (gas) => {
    bentReply(gas, (reply) => {
      reply.valueRanges[5].values = true;
    });
  },
  'a null where a row should be': (gas) => {
    bentReply(gas, (reply) => {
      reply.valueRanges[0].values[1] = null;
    });
  },
  'a string where a row should be': (gas) => {
    bentReply(gas, (reply) => {
      reply.valueRanges[0].values[1] = 'oops';
    });
  },
  'a number where a row should be': (gas) => {
    bentReply(gas, (reply) => {
      reply.valueRanges[0].values[1] = 7;
    });
  },
  'a script clock that isn\'t on Denver time': (gas) => {
    const real = gas.context.Utilities.formatDate;
    gas.context.Utilities.formatDate = (date, zone, pattern) => (pattern === 'HH' ? '06' : real(date, zone, pattern));
  },
};

Object.keys(FAILURES).forEach((kind) => {
  test(`failures: with ${kind}, the whole week comes out the same`, () => {
    const baseline = normalWeek();
    const failing = wholeWeek(FAILURES[kind]);
    failing.outcome.transcript.forEach((step, index) => sameJson(step, baseline.outcome.transcript[index], `step ${index + 1}, ${step[0]}`));
    sameJson(failing.outcome, baseline.outcome, 'the whole week');
    assert.ok(warnings(failing.gas).length > 0, 'and it said so in the log');
    warnings(failing.gas).forEach((line) => assert.match(line.text, /slower way/));
  });
});

const SEEMING_BLANK = {
  'one tab with no values in the reply': (reply) => {
    delete reply.valueRanges[0].values;
  },
  'the Schedule tab with no values in the reply': (reply) => {
    delete reply.valueRanges[5].values;
  },
  'null values in the reply': (reply) => {
    reply.valueRanges[5].values = null;
  },
  'every tab with no values in the reply': (reply) => {
    reply.valueRanges.forEach((range) => delete range.values);
  },
};

Object.keys(SEEMING_BLANK).forEach((kind) => {
  test(`failures: with ${kind}, the whole week comes out the same, since SpreadsheetApp gets a second look`, () => {
    const seeming = wholeWeek((gas) => bentReply(gas, SEEMING_BLANK[kind]));
    sameJson(seeming.outcome, normalWeek().outcome, 'the whole week');
  });
});

test('failures: a script clock off Denver time never reaches the batch, and says why', () => {
  const gas = setUpWorld();
  FAILURES['a script clock that isn\'t on Denver time'](gas);
  const run = counted(gas, () => ok(gas.get({ action: 'names' })));
  assert.strictEqual(run.batchGet, 0);
  assert.ok(run.sheetReads > 0);
  assert.match(warnings(gas)[0].text, /Denver/);
});

test('failures: a bad sheet ID gets the same answer as before', () => {
  const gas = setUpWorld();
  gas.state.properties.set('SHEET_ID', 'no-such-sheet');
  const reply = gas.get({ action: 'names' });
  assert.strictEqual(warnings(gas).length, 1, 'the batch failed by itself');
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.error, 'Something went wrong on our end. Please try again.');
  sameJson(reply, theOldWay(gas, () => gas.get({ action: 'names' })), 'names');
});

test('failures: a site not set up yet still gets its sentence, without trying the batch', () => {
  const gas = createGas();
  const run = counted(gas, () => gas.get({ action: 'names' }));
  assert.strictEqual(run.result.error, "The site isn't set up yet.");
  assert.strictEqual(run.batchGet, 0);
  assert.deepStrictEqual(warnings(gas), []);
});

test('failures: a renamed tab fails the batch and gets its friendly sentence, only where that tab is needed', () => {
  const twins = [setUpWorld(), setUpWorld()];
  twins.forEach((gas) => gas.sheet('Tasks').setName('Tasks (old)'));
  const [fast, old] = twins;
  old.state.beforeBatch = () => {
    throw new Error('Off, to compare with the old way.');
  };
  const both = (send) => {
    const reply = send(fast);
    sameJson(reply, send(old), JSON.stringify(reply).slice(0, 80));
    return reply;
  };

  const boot = both((gas) => gas.get({ action: 'boot', name: 'Ana' }));
  assert.strictEqual(boot.ok, false);
  assert.strictEqual(boot.error, 'The "Tasks" tab is missing from the sheet. Please run setup again.');
  ok(both((gas) => gas.get({ action: 'names' })));
  ok(both((gas) => gas.post({ action: 'clockIn', name: 'Ana' })));
  ok(both((gas) => gas.post({ action: 'clockOut', name: 'Ana' })));
  assert.ok(warnings(fast).length >= 4, 'each of those runs tried, then fell back');
  warnings(fast).forEach((line) => assert.match(line.text, /Unable to parse range/));
});

test('failures: a renamed Log tab fails the batch, and a write still goes through as it always has', () => {
  const gas = setUpWorld();
  gas.sheet('Log').setName('Old log');
  gas.setNow(at(MON, '09:00'));
  ok(gas.post({ action: 'clockIn', name: 'Ana' }));
  assert.strictEqual(gas.rows('Hours').length, 1);
  assert.ok(gas.state.logs.some((line) => line.level === 'error' && /Could not write to the Log tab/.test(line.text)));
});

test('failures: a run tries the batch once, even across the jobs of a tick', () => {
  const gas = setUpWorld();
  ok(gas.post({ action: 'saveAvailability', name: 'Ana', weekOf: MON, hoursWanted: 6, dayHours: hoursEach(['Mon'], 3) }));
  FAILURES['a 500'](gas);
  gas.setNow(at(LAST_FRI, '07:00'));
  const run = counted(gas, () => gas.tick());
  assert.deepStrictEqual(run.result, { ran: ['nightly', 'weekly', 'monthly'], failed: [] });
  assert.strictEqual(run.batchGet, 1);
  gas.state.beforeBatch = null;
  assert.strictEqual(counted(gas, () => ok(gas.get({ action: 'names' }))).batchGet, 1, 'and the next run tries again, and it works');
  assert.strictEqual(warnings(gas).length, 1);
});

/* --------------------------------------------------------------- (f) speed guards ---- */

const READ_SCREENS = {
  names: { action: 'names' },
  boot: { action: 'boot', name: 'Ana' },
  'boot for a manager': { action: 'boot', name: 'Max' },
  availability: { action: 'availability', name: 'Ana', weekOf: '2026-11-23' },
  mgrOverview: { action: 'mgrOverview', code: CODE },
  mgrBoard: { action: 'mgrBoard', code: CODE },
  mgrHours: { action: 'mgrHours', code: CODE },
};

function assertOnlyOneBatch(gas, label) {
  Object.keys(READ_SCREENS).forEach((screen) => {
    const run = counted(gas, () => ok(gas.get(READ_SCREENS[screen])));
    assert.strictEqual(run.batchGet, 1, `${label}: ${screen} makes one batchGet`);
    assert.deepStrictEqual(run.calls, {}, `${label}: ${screen} makes no SpreadsheetApp reads`);
    assert.strictEqual(run.sheetReads, 0, `${label}: ${screen}`);
    assert.strictEqual(run.openById, 0, `${label}: ${screen} doesn't even open the sheet`);
    assert.strictEqual(run.flush, 0, `${label}: ${screen} has nothing to flush`);
  });
}

test('speed: the screens people wait on make one batchGet and no SpreadsheetApp reads', () => {
  assertOnlyOneBatch(setUpWorld(), 'just set up');
  assertOnlyOneBatch(resetWorld(), 'a sheet with a real week in it');
  assertOnlyOneBatch(normalWeek().gas, 'a sheet people have typed in');
});

test('speed: asking for headers first makes the same one batch, and the Log gets its headers from it', () => {
  const gas = setUpWorld();
  const run = counted(gas, () =>
    gas.run((script) => {
      assert.deepStrictEqual(Array.from(script.headersOf_('Log')), ['Time', 'Who', 'Action', 'Details']);
      assert.deepStrictEqual(Array.from(script.headersOf_('Time Off')), ['ID', 'Name', 'From', 'To', 'Note', 'Added At', 'Status']);
    })
  );
  assert.deepStrictEqual([run.batchGet, run.sheetReads, run.openById], [1, 0, 0]);
});

test('reads: the Log is the one data tab left out of the batch, so reading it takes SpreadsheetApp and gets all of it', () => {
  const gas = setUpWorld();
  const run = counted(gas, () => gas.call('readTab_', 'Log'));
  assert.strictEqual(run.result[0].Action, 'adminSetup');
  assert.ok(run.sheetReads > 0);
});

test('speed: a request that touches no sheet makes no reads at all', () => {
  const gas = resetWorld();
  const run = counted(gas, () => ok(gas.get({ action: 'mgrCheck', code: CODE })));
  assert.deepStrictEqual([run.batchGet, run.sheetReads, run.openById, run.flush], [0, 0, 0, 0]);
});

test('speed: a typical write stays on the batch, with only a few SpreadsheetApp reads', () => {
  // The reads left are the writes' own: where to add a row (getLastRow, getMaxRows), for the tab and for the
  // Log, and re-reading the Hours tab when a clock request answers with what it just wrote.
  const LIMITS = { taskToggle: 2, taskNote: 2, clockIn: 6, clockOut: 4 };
  const gas = resetWorld();
  const task = ok(gas.get({ action: 'boot', name: 'Ana' })).today.tasks[0];
  const writes = {
    taskToggle: { action: 'taskToggle', name: 'Ana', id: task.id, done: true },
    taskNote: { action: 'taskNote', name: 'Ana', id: task.id, note: 'Done before lunch' },
    clockIn: { action: 'clockIn', name: 'Ana' },
    clockOut: { action: 'clockOut', name: 'Ana' },
  };
  Object.keys(writes).forEach((action) => {
    const run = counted(gas, () => ok(gas.post(writes[action])));
    assert.strictEqual(run.batchGet, 1, `${action} makes one batchGet`);
    assert.ok(run.sheetReads <= LIMITS[action], `${action} made ${run.sheetReads} SpreadsheetApp reads: ${JSON.stringify(run.calls)}`);
    assert.strictEqual(run.openById, 1, `${action} opens the sheet once to write to it`);
    assert.strictEqual(run.flush, 1, `${action} flushes once, at the end`);
  });
});

test('speed: a tick with nothing due stops without touching the sheet', () => {
  const gas = resetWorld(); // Tuesday morning: the nightly has run, and Friday is days off
  const run = counted(gas, () => gas.tick());
  assert.deepStrictEqual(run.result, { ran: [], failed: [] });
  assert.deepStrictEqual([run.batchGet, run.sheetReads, run.openById, run.flush], [0, 0, 0, 0]);
});

test('speed: turning numbers into dates asks Utilities for nothing, however long the site has run', () => {
  const gas = resetWorld();
  const task = ok(gas.get({ action: 'boot', name: 'Ana' })).today.tasks[0];
  const schedule = [];
  const clocked = [];
  for (let back = 1; back <= 100; back++) {
    const date = new Date(Date.UTC(2026, 9, 31) - back * 86400000).toISOString().slice(0, 10); // a hundred days of history, each with work done and hours clocked
    schedule.push({ ID: `task|T01|${date}`, 'Week Of': date, Date: date, Day: 'Mon', Name: 'Ana', 'Task ID': 'T01', Task: 'A task', Priority: 'B', Minutes: 15, Source: 'auto', Status: 'done', 'Done At': new Date(`${date}T16:00:00Z`), 'Done By': 'Ana' });
    clocked.push({ ID: `H-${date}`, Date: new Date(`${date}T07:00:00Z`), Name: 'Ana', In: new Date(`${date}T16:00:00Z`), Out: new Date(`${date}T18:00:00Z`), Source: 'clock' });
  }
  gas.run((script) => {
    script.appendRows_('Schedule', schedule);
    script.appendRows_('Hours', clocked);
  });
  const realFormat = gas.context.Utilities.formatDate;
  let formats = 0;
  gas.context.Utilities.formatDate = (...args) => {
    formats += 1;
    return realFormat(...args);
  };
  const cost = (work) => {
    formats = 0;
    ok(work());
    return formats;
  };
  const requests = {
    names: () => gas.get(READ_SCREENS.names),
    boot: () => gas.get(READ_SCREENS.boot),
    mgrBoard: () => gas.get(READ_SCREENS.mgrBoard),
    mgrHours: () => gas.get(READ_SCREENS.mgrHours),
    taskNote: () => gas.post({ action: 'taskNote', name: 'Ana', id: task.id, note: 'Noted' }),
  };
  Object.keys(requests).forEach((name) => {
    const fast = cost(requests[name]);
    const old = theOldWay(gas, () => cost(requests[name]));
    assert.strictEqual(fast, old, `${name}: no more than with the batch failing`);
  });
  assert.strictEqual(cost(requests.names), 1, 'names asks for one thing, the check of the script\'s clock');
  assert.ok(cost(requests.taskNote) <= 2, 'and a tap costs next to nothing, with a hundred days behind it');
});

test('speed: every batch asks for the same ranges, and never the whole Log or Monthly Hours', () => {
  const { gas } = normalWeek();
  assert.ok(gas.state.batchRanges.length > 100);
  gas.state.batchRanges.forEach((ranges) => assert.deepStrictEqual(ranges, EVERY_RANGE));
});

test('speed: after setup, writing to the Log never reads what is in it', () => {
  const gas = setUpWorld();
  const run = counted(gas, () => {
    ok(gas.post({ action: 'saveAvailability', name: 'Ana', weekOf: MON, hoursWanted: 6, dayHours: hoursEach(['Mon'], 3) }));
    gas.setNow(at(LAST_FRI, '07:00'));
    assert.deepStrictEqual(gas.tick().failed, []);
    gas.setNow(at(MON, '09:00'));
    ok(gas.post({ action: 'clockIn', name: 'Ana' }));
    ok(gas.post({ action: 'clockOut', name: 'Ana' }));
  });
  assert.ok(Object.keys(run.calls).includes('Log.getLastRow'), 'it does ask where the next line goes');
  assert.deepStrictEqual(Object.keys(run.calls).filter((call) => /^Log\.get(Values|Value|DataRange|DisplayValues|DisplayValue)$/.test(call)), []);
});
