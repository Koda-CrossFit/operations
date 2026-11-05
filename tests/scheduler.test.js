'use strict';

// Matching rules, SPEC section 6. Run: node --test tests/scheduler.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { schedPriorityScore, schedBuildWeek, schedFillOpen } = require('../apps-script/Scheduler.js');
const { SEED_TASKS_ } = require('../apps-script/SeedTasks.js');
const { MON_SAT, STAFF, avail, buildInput, oneOff, row, task, workedExampleAvailability } = require('../dev/fixtures.js');

// The fixture week. Hard-coded so the tests never lean on the code's own date math.
const MON = '2026-11-09';
const TUE = '2026-11-10';
const WED = '2026-11-11';
const THU = '2026-11-12';
const FRI = '2026-11-13';
const SAT = '2026-11-14';
const SUN = '2026-11-15';

const ROW_FIELDS = ['key', 'taskId', 'oneOffId', 'title', 'details', 'priority', 'minutes', 'date', 'day', 'name', 'source', 'partial'];

function run(overrides) {
  return schedBuildWeek(buildInput(overrides));
}

/** One test task against some availability, returning its single row. */
function placeOne(taskOverrides, availability, extra) {
  const result = run({ tasks: [task(taskOverrides)], availability, ...extra });
  assert.strictEqual(result.rows.length, 1);
  return result.rows[0];
}

/** {Ana:{Mon:125}}: the minutes in rows that matching assigned. Set rows and uncovered rows don't count. */
function minutesByPersonDay(rows) {
  const out = {};
  rows.forEach((r) => {
    if (!r.name || r.source === 'set') return;
    out[r.name] = out[r.name] || {};
    out[r.name][r.day] = (out[r.name][r.day] || 0) + r.minutes;
  });
  return out;
}

function byTask(rows, taskId) {
  return rows.filter((r) => r.taskId === taskId);
}

function byKey(rows, key) {
  const found = rows.find((r) => r.key === key);
  assert.ok(found, `no row with key ${key}`);
  return found;
}

/* ------------------------------------------------------------ priority score ---- */

test('schedPriorityScore: letter first, then plus count, blank last', () => {
  const ladder = ['A+++++', 'A++', 'A', 'B+', 'B', 'C', ''].map((p) => schedPriorityScore(p));
  ladder.slice(1).forEach((score, i) => assert.ok(ladder[i] > score, `step ${i} of the ladder is out of order`));
  assert.ok(schedPriorityScore('B+++++') < schedPriorityScore('A'), 'plusses never beat a better letter');
  assert.strictEqual(schedPriorityScore('a++'), schedPriorityScore('A++'));
  assert.strictEqual(schedPriorityScore(' B '), schedPriorityScore('B'));
  assert.strictEqual(schedPriorityScore(null), schedPriorityScore(''));
  assert.strictEqual(schedPriorityScore(undefined), schedPriorityScore(''));
});

/* ---------------------------------------------------------------- seed tasks ---- */

test('seed tasks: the 15 tasks from section 5 add up to the pool minutes in section 6', () => {
  assert.strictEqual(SEED_TASKS_.length, 15);
  assert.deepStrictEqual(SEED_TASKS_.map((t) => t.id).sort(), [
    'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15',
  ]);
  assert.deepStrictEqual(SEED_TASKS_.map((t) => t.order), SEED_TASKS_.map((_, i) => i + 1));
  const perDay = {};
  SEED_TASKS_.forEach((t) => {
    assert.deepStrictEqual(Object.keys(t), ['id', 'title', 'details', 'cadence', 'priority', 'minutes', 'days', 'setOnly', 'flexDays', 'active', 'order']);
    t.days.forEach((day) => {
      perDay[day] = (perDay[day] || 0) + t.minutes;
    });
  });
  assert.deepStrictEqual(perDay, { Mon: 125, Tue: 100, Wed: 85, Thu: 85, Fri: 130, Sat: 55 });
});

test('seed tasks: priority, minutes, days and flex for every task, as in section 5', () => {
  const week = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const expected = [
    ['T08', 'A+++++', 60, [], 1],
    ['T15', 'A', 300, [], 1],
    ['T14', 'B', 90, [], 6],
    ['T01', 'B', 15, week, 0],
    ['T05', 'B', 10, week, 0],
    ['T07', 'B', 15, week, 0],
    ['T11', 'B', 5, week, 0],
    ['T12', 'B', 10, week, 0],
    ['T03', 'B', 15, ['Mon', 'Wed', 'Fri'], 1],
    ['T10', 'B', 30, ['Mon', 'Thu'], 1],
    ['T09', 'C', 15, ['Mon', 'Wed', 'Fri'], 1],
    ['T02', 'C', 15, ['Tue', 'Fri'], 1],
    ['T04', 'C', 10, ['Tue', 'Fri'], 1],
    ['T13', 'C', 20, ['Tue', 'Fri'], 1],
    ['T06', 'C', 10, ['Mon'], 6],
  ];
  assert.deepStrictEqual(SEED_TASKS_.map((t) => [t.id, t.priority, t.minutes, t.days, t.flexDays]), expected);
  SEED_TASKS_.forEach((t) => {
    assert.strictEqual(t.active, true, t.id);
    assert.ok(t.title.length > 0 && t.cadence.length > 0, t.id);
  });
});

test('seed tasks: "Set" means setOnly with no days, and "Mon-Sat" is the full list', () => {
  const setOnly = SEED_TASKS_.filter((t) => t.setOnly);
  assert.deepStrictEqual(setOnly.map((t) => t.id), ['T08', 'T15', 'T14']);
  setOnly.forEach((t) => assert.deepStrictEqual(t.days, []));
  SEED_TASKS_.filter((t) => t.cadence === 'Daily').forEach((t) => {
    assert.deepStrictEqual(t.days, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    assert.strictEqual(t.flexDays, 0);
  });
});

/* ----------------------------------------------------------- worked example ---- */

test('worked example: the exact minutes per person per day', () => {
  const { rows, unfilled, usage } = run({ availability: workedExampleAvailability() });
  assert.deepStrictEqual(minutesByPersonDay(rows), {
    Ana: { Mon: 125, Wed: 85, Fri: 130 },
    Ben: { Tue: 100, Thu: 85 },
    Cora: { Sat: 55 },
  });
  assert.deepStrictEqual(unfilled, []);
  assert.strictEqual(usage.Dev.minutes, 0);
  assert.deepStrictEqual(usage.Dev.byDate, {});
});

test('worked example: nobody passes their hours for the day or the hours they asked for', () => {
  const { usage } = run({ availability: workedExampleAvailability() });
  assert.deepStrictEqual(usage.Ana, { minutes: 340, wantedMinutes: 360, byDate: { [MON]: 125, [WED]: 85, [FRI]: 130 } });
  assert.deepStrictEqual(usage.Ben, { minutes: 185, wantedMinutes: 240, byDate: { [TUE]: 100, [THU]: 85 } });
  assert.deepStrictEqual(usage.Cora, { minutes: 55, wantedMinutes: 1200, byDate: { [SAT]: 55 } });
  assert.ok(usage.Ana.minutes <= usage.Ana.wantedMinutes + 15);
  assert.ok(usage.Ben.minutes <= usage.Ben.wantedMinutes + 15);
  Object.values(usage.Ana.byDate).concat(Object.values(usage.Ben.byDate)).forEach((m) => assert.ok(m <= 180));
});

test('worked example with a set person out Thursday: Ben covers it, and the rest of the week holds', () => {
  const { rows, unfilled } = run({ availability: workedExampleAvailability(), timeOff: [{ name: 'Gus', from: THU, to: THU }] });
  assert.deepStrictEqual(minutesByPersonDay(rows), {
    Ana: { Mon: 125, Wed: 85, Fri: 130 },
    Ben: { Tue: 100, Thu: 145 },
    Cora: { Sat: 55 },
  });
  assert.deepStrictEqual(unfilled, []);
  assert.deepStrictEqual(rows.filter((r) => r.source === 'cover').map((r) => [r.taskId, r.date, r.name]), [['T08', THU, 'Ben']]);
});

test('rows have exactly the fields in the spec', () => {
  const { rows } = run({ availability: workedExampleAvailability(), oneOffs: [oneOff({ id: 'O1' })] });
  rows.forEach((r) => assert.deepStrictEqual(Object.keys(r), ROW_FIELDS));
  const job = byKey(rows, 'task|T01|' + MON);
  assert.strictEqual(job.taskId, 'T01');
  assert.strictEqual(job.oneOffId, '');
  assert.strictEqual(job.title, 'Unbox packages');
  assert.strictEqual(job.details, 'Check the front desk for packages');
  assert.strictEqual(job.priority, 'B');
  assert.strictEqual(job.minutes, 15);
  assert.strictEqual(job.day, 'Mon');
  assert.strictEqual(job.source, 'auto');
  assert.strictEqual(job.partial, false);
  const extra = byKey(rows, 'oneoff|O1');
  assert.strictEqual(extra.taskId, '');
  assert.strictEqual(extra.oneOffId, 'O1');
});

/* ------------------------------------------------------------------ rank order ---- */

test('rank order: the best-ranked person who fits gets it, whatever order the staff list is in', () => {
  const input = buildInput({
    tasks: [task({ id: 'X1', minutes: 60 })],
    availability: { Dev: avail(6, ['Mon'], 3), Ben: avail(6, ['Mon'], 3), Ana: avail(6, ['Mon'], 3) },
  });
  input.staff.reverse();
  assert.strictEqual(schedBuildWeek(input).rows[0].name, 'Ana');
});

test('rank order: work passes down the ranks only when someone better is full', () => {
  const tasks = ['X1', 'X2', 'X3', 'X4', 'X5'].map((id) => task({ id, minutes: 60 }));
  const { rows } = run({
    tasks,
    availability: { Ana: avail(1, ['Mon'], 8), Ben: avail(2, ['Mon'], 8), Cora: avail(10, ['Mon'], 8), Dev: avail(10, ['Mon'], 8) },
  });
  assert.deepStrictEqual(minutesByPersonDay(rows), { Ana: { Mon: 60 }, Ben: { Mon: 120 }, Cora: { Mon: 120 } });
});

test('rank order: ranks and types read from a sheet still work, and a tie goes by name', () => {
  const flexible = (name, rank, type) => ({ name, rank, type, active: true, setDays: [], setTasks: [] });
  const availability = { Bea: avail(6, ['Mon'], 3), Zed: avail(6, ['Mon'], 3) };
  const winner = (staff) => run({ tasks: [task()], staff, availability }).rows[0].name;
  assert.strictEqual(winner([flexible('Zed', '9', 'flexible'), flexible('Bea', '10', 'FLEXIBLE')]), 'Zed', '9 beats 10 as a number, not as text');
  assert.strictEqual(winner([flexible('Zed', 5, 'Flexible'), flexible('Bea', 5, 'Flexible')]), 'Bea');
  const setPerson = [{ name: 'Gus', rank: '1', type: 'set', active: true, setDays: ['Thu'], setTasks: [{ taskId: 'T08', days: null }] }];
  const got = run({ staff: setPerson }).rows.filter((r) => r.source === 'set');
  assert.deepStrictEqual(got.map((r) => [r.name, r.taskId, r.date]), [['Gus', 'T08', THU]]);
});

test('rank order: Set people and managers are never pulled in as flexible help', () => {
  const { rows } = run({
    tasks: [task({ id: 'X1' })],
    availability: { Gus: avail(10, ['Mon'], 8), Max: avail(10, ['Mon'], 8) },
  });
  assert.strictEqual(rows[0].name, '');
});

/* -------------------------------------------------------------- priority order ---- */

test('priority order: when people run short, C is what goes uncovered, not B', () => {
  // Ana alone, 7 hours: 420 + 15 = 435 minutes, which is exactly all the B work in the seed list.
  const { rows, unfilled, usage } = run({ availability: { Ana: avail(7, MON_SAT, 3) } });
  assert.strictEqual(usage.Ana.minutes, 435);
  assert.ok(unfilled.length > 0);
  unfilled.forEach((r) => assert.strictEqual(r.priority, 'C', `${r.key} should not be uncovered`));
  rows.filter((r) => r.priority === 'B' && r.source !== 'set').forEach((r) => assert.strictEqual(r.name, 'Ana'));
  assert.deepStrictEqual(unfilled.map((r) => r.taskId).sort(), ['T02', 'T02', 'T04', 'T04', 'T06', 'T09', 'T09', 'T09', 'T13', 'T13']);
});

test('priority order: higher priority wins the last of the room, whatever order the tasks are in', () => {
  const { rows } = run({
    tasks: [
      task({ id: 'LOW', priority: 'C', minutes: 60, order: 1 }),
      task({ id: 'MID', priority: 'B', minutes: 60, order: 2 }),
      task({ id: 'TOP', priority: 'A+++++', minutes: 60, order: 3 }),
      task({ id: 'BLANK', priority: '', minutes: 60, order: 0 }),
    ],
    availability: { Ana: avail(1, ['Mon'], 1) },
  });
  assert.strictEqual(byTask(rows, 'TOP')[0].name, 'Ana');
  ['LOW', 'MID', 'BLANK'].forEach((id) => assert.strictEqual(byTask(rows, id)[0].name, ''));
});

test('pool order: same priority, then flex low to high, then date, then minutes high to low, then task order', () => {
  // Room for one row at a time shows who was first: each round removes the winner.
  const candidates = [
    task({ id: 'FLEX0', days: ['Mon'], flexDays: 0, minutes: 30, order: 9 }),
    task({ id: 'FLEX1', days: ['Mon'], flexDays: 1, minutes: 60, order: 1 }),
  ];
  let got = run({ tasks: candidates, availability: { Ana: avail(1, ['Mon'], 1) } }).rows;
  assert.strictEqual(byTask(got, 'FLEX0')[0].name, 'Ana', 'lower flex goes first even though it is smaller');

  const byDate = [task({ id: 'LATE', days: ['Tue'], flexDays: 1, minutes: 60, order: 1 }), task({ id: 'EARLY', days: ['Mon'], flexDays: 1, minutes: 60, order: 2 })];
  got = run({ tasks: byDate, availability: { Ana: avail(0.75, ['Mon', 'Tue'], 1) } }).rows;
  assert.strictEqual(byTask(got, 'EARLY')[0].name, 'Ana', 'earlier date goes first');
  assert.strictEqual(byTask(got, 'LATE')[0].name, '');

  const bySize = [task({ id: 'SMALL', minutes: 30, order: 1 }), task({ id: 'BIG', minutes: 45, order: 2 })];
  got = run({ tasks: bySize, availability: { Ana: avail(1, ['Mon'], 1) } }).rows;
  assert.strictEqual(byTask(got, 'BIG')[0].name, 'Ana', 'more minutes go first');
  assert.strictEqual(byTask(got, 'SMALL')[0].name, '');

  // The IDs run the opposite way from the order, so only the order can explain the winner.
  const byOrder = [task({ id: 'AAA', minutes: 45, order: 2 }), task({ id: 'ZZZ', minutes: 45, order: 1 })];
  got = run({ tasks: byOrder, availability: { Ana: avail(1, ['Mon'], 1) } }).rows;
  assert.strictEqual(byTask(got, 'ZZZ')[0].name, 'Ana', 'task order breaks the last tie');
  assert.strictEqual(byTask(got, 'AAA')[0].name, '');
});

test('pool order: a one-off has no task order, so a listed task goes first when everything else ties', () => {
  const { rows } = run({
    tasks: [task({ id: 'ZZZ', minutes: 45, days: ['Mon'], order: 500 })],
    oneOffs: [oneOff({ id: 'AAA', day: 'Mon', minutes: 45 })],
    availability: { Ana: avail(1, ['Mon'], 1) },
  });
  assert.strictEqual(byKey(rows, 'task|ZZZ|' + MON).name, 'Ana');
  assert.strictEqual(byKey(rows, 'oneoff|AAA').name, '');
});

test('pool order: a one-off with no day goes after every movable task of the same priority', () => {
  const { rows } = run({
    tasks: [task({ id: 'R1', minutes: 60, days: ['Mon'], flexDays: 6 })],
    oneOffs: [oneOff({ minutes: 60 })],
    availability: { Ana: avail(1, ['Mon'], 1) },
  });
  assert.strictEqual(byKey(rows, 'task|R1|' + MON).name, 'Ana');
  assert.strictEqual(byKey(rows, 'oneoff|O1').name, '', 'only 15 minutes of her week are left, under the 30 a partial needs');
});

/* ----------------------------------------------------------- recurring tasks ---- */

test('recurring tasks: one row per listed day, and inactive or set-only tasks make none', () => {
  const availability = { Ana: avail(5, MON_SAT, 3) };
  const { rows } = run({ tasks: [task({ id: 'X1', days: ['Mon', 'Thu'] })], availability });
  assert.deepStrictEqual(rows.map((r) => [r.taskId, r.date, r.source]), [['X1', MON, 'auto'], ['X1', THU, 'auto']]);
  assert.deepStrictEqual(run({ tasks: [task({ active: false })], availability }).rows, []);
  assert.deepStrictEqual(run({ tasks: [task({ setOnly: true, days: ['Mon'] })], availability }).rows, []);
});

test('recurring tasks: numbers read from a sheet as text still work, and blank minutes count as none', () => {
  const placed = placeOne({ minutes: '45', days: ['Wed'], flexDays: '1' }, { Ana: avail('5', ['Thu'], 3) });
  assert.deepStrictEqual([placed.name, placed.date, placed.minutes], ['Ana', THU, 45]);
  const blank = placeOne({ minutes: '', flexDays: '' }, { Ana: avail(5, ['Mon'], 3) });
  assert.deepStrictEqual([blank.name, blank.date, blank.minutes], ['Ana', MON, 0]);
});

/* --------------------------------------------------------------- capacity caps ---- */

test('hours cap: requested hours plus 15 minutes of tolerance, and not a minute more', () => {
  const availability = { Ana: avail(1, ['Mon'], 8) };
  assert.strictEqual(placeOne({ minutes: 75 }, availability).name, 'Ana');
  assert.strictEqual(placeOne({ minutes: 76 }, availability).name, '');
});

test('hours cap: half hours count, and it adds up across the whole week', () => {
  assert.strictEqual(placeOne({ minutes: 105 }, { Ana: avail(1.5, ['Mon'], 8) }).name, 'Ana');
  assert.strictEqual(placeOne({ minutes: 106 }, { Ana: avail(1.5, ['Mon'], 8) }).name, '');

  const { rows, usage } = run({
    tasks: [task({ id: 'X1', minutes: 60, days: ['Mon'] }), task({ id: 'X2', minutes: 15, days: ['Tue'] }), task({ id: 'X3', minutes: 5, days: ['Wed'] })],
    availability: { Ana: avail(1, ['Mon', 'Tue', 'Wed'], 8) },
  });
  assert.strictEqual(byTask(rows, 'X1')[0].name, 'Ana');
  assert.strictEqual(byTask(rows, 'X2')[0].name, 'Ana');
  assert.strictEqual(byTask(rows, 'X3')[0].name, '', 'the week is full at 75 minutes');
  assert.strictEqual(usage.Ana.minutes, 75);
});

test('day cap: the hours offered that day, with what is already placed taken off', () => {
  const availability = { Ana: { none: false, hoursWanted: 20, dayHours: { Mon: 2.5 } } };
  assert.strictEqual(placeOne({ minutes: 150 }, availability).name, 'Ana');
  assert.strictEqual(placeOne({ minutes: 151 }, availability).name, '');

  const { rows } = run({
    tasks: [task({ id: 'X1', minutes: 130 }), task({ id: 'X2', minutes: 30 }), task({ id: 'X3', minutes: 20 })],
    availability,
  });
  assert.strictEqual(byTask(rows, 'X1')[0].name, 'Ana');
  assert.strictEqual(byTask(rows, 'X2')[0].name, '', '30 is more than the 20 left in the day');
  assert.strictEqual(byTask(rows, 'X3')[0].name, 'Ana', 'the 20 left in the day still gets used');
});

test('day cap: hours read as text still count, and a zero or a missing day means no work', () => {
  const availability = { Ana: { none: false, hoursWanted: '20', dayHours: { Mon: '3', Tue: 0 } } };
  assert.strictEqual(placeOne({ minutes: 180 }, availability).name, 'Ana');
  assert.strictEqual(placeOne({ minutes: 181 }, availability).name, '');
  assert.strictEqual(placeOne({ days: ['Tue'] }, availability).name, '', 'zero hours that day');
  assert.strictEqual(placeOne({ days: ['Wed'] }, availability).name, '', 'that day was not offered');
  assert.strictEqual(placeOne({}, { Ana: { none: false, hoursWanted: 20 } }).name, '', 'no hours at all');
});

test('none:true and no submission mean no work', () => {
  const lot = { none: true, hoursWanted: 20, dayHours: { Mon: 3 } };
  assert.strictEqual(placeOne({}, { Ana: lot }).name, '');
  assert.strictEqual(placeOne({}, {}).name, '');
  const { rows, usage } = run({ tasks: [task({ id: 'X1' })], availability: { Ana: lot, Cora: avail(5, ['Mon'], 3) } });
  assert.strictEqual(rows[0].name, 'Cora', 'Ana said no and Ben never submitted');
  assert.strictEqual(usage.Ana.minutes, 0);
  assert.strictEqual(usage.Ana.wantedMinutes, 0);
  assert.strictEqual(usage.Ben.wantedMinutes, 0);
});

test('a free day with no hours requested means no work, tolerance or not', () => {
  assert.strictEqual(placeOne({ minutes: 15 }, { Ana: avail(0, ['Mon'], 3) }).name, '');
  assert.strictEqual(placeOne({ minutes: 15 }, { Ana: { none: false, dayHours: { Mon: 1 } } }).name, '');
});

test('out of town beats availability for flexible people too', () => {
  const availability = { Ana: avail(6, ['Mon'], 3), Ben: avail(6, ['Mon'], 3) };
  const timeOff = [{ name: 'Ana', from: '2026-11-08', to: MON }];
  assert.strictEqual(placeOne({}, availability, { timeOff }).name, 'Ben');
  assert.strictEqual(placeOne({}, availability, { timeOff: [{ name: 'Ana', from: TUE, to: FRI }] }).name, 'Ana');
});

/* ----------------------------------------------------------------- set staff ---- */

test('set staff: one row per set day and set task, with source set', () => {
  const { rows } = run();
  const setRows = rows.filter((r) => r.source === 'set').map((r) => [r.name, r.taskId, r.date, r.day]);
  assert.deepStrictEqual(setRows, [
    ['Hal', 'T08', TUE, 'Tue'],
    ['Hal', 'T14', TUE, 'Tue'],
    ['Ivy', 'T15', WED, 'Wed'],
    ['Gus', 'T08', THU, 'Thu'],
    ['Gus', 'T08', FRI, 'Fri'],
    ['Gus', 'T08', SUN, 'Sun'],
    ['Jo', 'T15', SUN, 'Sun'],
  ]);
  assert.strictEqual(byTask(rows, 'T08').length, 4, 'section 1: deep bathroom clean lands exactly four times');
  assert.strictEqual(byTask(rows, 'T15').length, 2);
  assert.strictEqual(byTask(rows, 'T14').length, 1);
  rows.filter((r) => r.source === 'set').forEach((r) => assert.strictEqual(r.partial, false));
});

test('set staff: a set task limited to one day only appears that day', () => {
  const staff = [{ name: 'Gus', rank: 1, type: 'Set', active: true, setDays: ['Tue', 'Thu'], setTasks: [{ taskId: 'T08', days: null }, { taskId: 'T14', days: ['Tue'] }] }];
  const { rows } = run({ staff });
  assert.deepStrictEqual(rows.filter((r) => r.source === 'set').map((r) => [r.taskId, r.day]), [['T08', 'Tue'], ['T14', 'Tue'], ['T08', 'Thu']]);
});

test('set staff: inactive people, inactive tasks and unknown task IDs make no rows', () => {
  const staff = buildInput().staff;
  staff[0].active = false; // Gus
  staff[1].setTasks.push({ taskId: 'NOPE', days: null }); // Hal
  const tasks = buildInput().tasks.map((t) => (t.id === 'T15' ? { ...t, active: false } : t));
  const { rows } = run({ staff, tasks });
  assert.deepStrictEqual(rows.filter((r) => r.source === 'set').map((r) => [r.name, r.taskId]), [['Hal', 'T08'], ['Hal', 'T14']]);
});

test('set person out of town one day: only that day goes to cover, to the best-ranked person available', () => {
  const { rows, unfilled } = run({
    availability: { Ben: avail(6, ['Thu'], 3), Ana: avail(6, ['Thu'], 3) },
    timeOff: [{ name: 'Gus', from: THU, to: THU }],
  });
  const thu = byKey(rows, `set|T08|${THU}|Gus`);
  assert.strictEqual(thu.name, 'Ana');
  assert.strictEqual(thu.source, 'cover');
  assert.strictEqual(thu.date, THU);
  ['Fri', 'Sun'].forEach((day) => {
    const stays = rows.find((r) => r.taskId === 'T08' && r.day === day);
    assert.strictEqual(stays.name, 'Gus');
    assert.strictEqual(stays.source, 'set');
  });
  assert.ok(!unfilled.some((r) => r.taskId === 'T08'));
});

test('set person out of town one day: the next rank covers when the best is not free', () => {
  const { rows } = run({
    availability: { Ana: avail(6, ['Mon'], 3), Ben: avail(6, ['Thu'], 3) },
    timeOff: [{ name: 'Gus', from: THU, to: THU }],
  });
  assert.strictEqual(byKey(rows, `set|T08|${THU}|Gus`).name, 'Ben');
});

test('set person out of town one day: nobody free means uncovered, and only that day', () => {
  const { rows, unfilled } = run({ availability: {}, timeOff: [{ name: 'Gus', from: THU, to: THU }] });
  const thu = byKey(rows, `set|T08|${THU}|Gus`);
  assert.strictEqual(thu.name, '');
  assert.strictEqual(thu.source, 'cover');
  assert.strictEqual(thu.date, THU);
  assert.ok(unfilled.includes(thu));
  assert.strictEqual(byKey(rows, `set|T08|${FRI}|Gus`).name, 'Gus');
  assert.strictEqual(byKey(rows, `set|T08|${SUN}|Gus`).name, 'Gus');
});

test('set person out of town: cover uses the task flex window, and a whole range goes to cover', () => {
  // T08 has flex 1: Thu, then Fri, then Wed. Gus still does it himself on Fri, so that day doesn't count.
  let result = run({ availability: { Ana: avail(6, ['Wed'], 3) }, timeOff: [{ name: 'Gus', from: THU, to: THU }] });
  let cover = byKey(result.rows, `set|T08|${THU}|Gus`);
  assert.strictEqual(cover.name, 'Ana');
  assert.strictEqual(cover.date, WED);
  assert.strictEqual(cover.day, 'Wed');

  // T15 on a Sunday, flex 1: next Monday is outside the week, so it can only fall back to Saturday.
  result = run({ availability: { Ana: avail(6, ['Sat'], 6) }, timeOff: [{ name: 'Jo', from: SUN, to: SUN }] });
  cover = byKey(result.rows, `set|T15|${SUN}|Jo`);
  assert.strictEqual(cover.name, 'Ana');
  assert.strictEqual(cover.date, SAT);

  result = run({ availability: {}, timeOff: [{ name: 'Gus', from: THU, to: SUN }] });
  assert.deepStrictEqual(result.rows.filter((r) => r.key.endsWith('Gus')).map((r) => [r.source, r.name]), [['cover', ''], ['cover', ''], ['cover', '']]);
});

test('set person out of town: a covering person can pick up Sunday when they offered it', () => {
  const { rows } = run({ availability: { Ana: avail(8, ['Sun'], 6) }, timeOff: [{ name: 'Gus', from: SUN, to: SUN }] });
  const cover = byKey(rows, `set|T08|${SUN}|Gus`);
  assert.strictEqual(cover.name, 'Ana');
  assert.strictEqual(cover.date, SUN);
});

test('time off on a day they are not scheduled changes nothing', () => {
  const plain = run();
  const off = run({ timeOff: [{ name: 'Gus', from: MON, to: WED }, { name: 'Gus', from: SAT, to: SAT }] });
  assert.deepStrictEqual(off.rows, plain.rows);
});

test('cancelled time off is ignored', () => {
  const { rows } = run({ timeOff: [{ name: 'Gus', from: THU, to: THU, status: 'cancelled' }] });
  assert.strictEqual(byKey(rows, `set|T08|${THU}|Gus`).source, 'set');
});

/* ---------------------------------------------------------------- closed days ---- */

test('closed day (Thanksgiving week): flex 0 dropped, movable shifted, set rows absent', () => {
  const week = { weekOf: '2026-11-23', today: '2026-11-20', closedDays: ['2026-11-26'] };
  const { rows } = run({ ...week, availability: { Cora: avail(20, MON_SAT, 8) } });

  assert.deepStrictEqual(rows.filter((r) => r.date === '2026-11-26'), [], 'no rows that day at all');
  assert.deepStrictEqual(rows.filter((r) => r.name === 'Gus').map((r) => r.date), ['2026-11-27', '2026-11-29']);
  assert.deepStrictEqual(byTask(rows, 'T01').map((r) => r.date), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-28']);
  ['T05', 'T07', 'T11', 'T12'].forEach((id) => assert.strictEqual(byTask(rows, id).length, 5));

  const office = byKey(rows, 'task|T10|2026-11-26'); // flex 1: Thu is closed, so +1 comes first
  assert.strictEqual(office.date, '2026-11-27');
  assert.strictEqual(office.day, 'Fri');
  assert.strictEqual(office.name, 'Cora');
});

test('closed day: a movable row falls back to -1 when +1 is not possible, or waits uncovered off the closed day', () => {
  const week = { weekOf: '2026-11-23', today: '2026-11-20', closedDays: ['2026-11-26'] };
  const tasks = [task({ id: 'X1', days: ['Thu'], flexDays: 1 })];
  let rows = run({ ...week, tasks, availability: { Ana: avail(5, ['Wed'], 3) } }).rows;
  assert.strictEqual(rows[0].date, '2026-11-25');
  assert.strictEqual(rows[0].name, 'Ana');

  rows = run({ ...week, tasks, availability: {} }).rows;
  assert.strictEqual(rows[0].name, '');
  assert.strictEqual(rows[0].date, '2026-11-27', 'uncovered, but never on the closed date');
});

test('closed day: a flex 0 task is dropped even when someone offered that day, and so is one with every option closed', () => {
  const availability = { Ana: avail(5, MON_SAT, 3) };
  assert.deepStrictEqual(run({ tasks: [task({ days: ['Mon'] })], closedDays: [MON], availability }).rows, []);
  const allClosed = run({ tasks: [task({ days: ['Wed'], flexDays: 1 })], closedDays: [TUE, WED, THU], availability });
  assert.deepStrictEqual(allClosed.rows, []);
});

test('closed day: a flexible person who offered that day gets nothing on it', () => {
  const { rows } = run({ closedDays: [MON], availability: { Ana: avail(20, ['Mon', 'Tue'], 8) } });
  assert.ok(!rows.some((r) => r.date === MON));
});

/* ---------------------------------------------------------------- flex window ---- */

test('flex window: preferred date, then +1, then -1, then +2, then -2', () => {
  const place = (days) => placeOne({ days: ['Wed'], flexDays: 2 }, { Ana: avail(5, days, 3) });
  assert.strictEqual(place(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).date, WED);
  assert.strictEqual(place(['Mon', 'Tue', 'Thu', 'Fri']).date, THU, '+1 before -1');
  assert.strictEqual(place(['Mon', 'Tue', 'Fri']).date, TUE, '-1 before +2');
  assert.strictEqual(place(['Mon', 'Fri']).date, FRI, '+2 before -2');
  assert.strictEqual(place(['Mon']).date, MON, '-2 last');
  const out = place(['Sat']);
  assert.strictEqual(out.name, '', 'Saturday is +3, outside a flex of 2');
  assert.strictEqual(out.date, WED, 'uncovered rows keep their preferred date');
});

test('flex window: an earlier date in the window beats a better rank on a later date', () => {
  const placed = placeOne({ days: ['Wed'], flexDays: 1 }, { Ana: avail(5, ['Thu'], 3), Ben: avail(5, ['Wed'], 3) });
  assert.strictEqual(placed.name, 'Ben');
  assert.strictEqual(placed.date, WED);
});

test('flex window: rows stay inside the week', () => {
  const lateRow = placeOne({ days: ['Sat'], flexDays: 3 }, { Ana: avail(5, ['Thu'], 3) });
  assert.strictEqual(lateRow.date, THU, 'Sun and next Mon are out, so Thu is the first option left');
  const early = placeOne({ days: ['Mon'], flexDays: 1 }, { Ana: avail(5, ['Sun'], 3) });
  assert.strictEqual(early.name, '', 'the Sunday before is not this week');
});

test('flex window: never Sunday unless the task lists it', () => {
  const sundayOnly = { Ana: avail(5, ['Sun'], 3) };
  const notListed = placeOne({ days: ['Sat'], flexDays: 1 }, sundayOnly);
  assert.strictEqual(notListed.name, '');
  assert.strictEqual(notListed.date, SAT);
  assert.strictEqual(placeOne({ days: ['Mon'], flexDays: 6 }, sundayOnly).name, '', 'flex 6 reaches Sunday but it is still not allowed');

  const { rows } = run({ tasks: [task({ days: ['Sat', 'Sun'], flexDays: 1 })], availability: sundayOnly });
  assert.deepStrictEqual(rows.map((r) => [r.name, r.date]), [['', SAT], ['Ana', SUN]], 'Sunday is hers once listed, and Saturday\'s row waits rather than doubling up on it');
});

test('flex window: a task can be listed on Sunday and done there with flex 0', () => {
  const placed = placeOne({ days: ['Sun'] }, { Ana: avail(5, ['Sun'], 3) });
  assert.strictEqual(placed.date, SUN);
  assert.strictEqual(placed.day, 'Sun');
});

/* -------------------------------------------------------------------- one-offs ---- */

test('pinned one-off: stays on its date, by rank, and never slides to another day', () => {
  const availability = { Ana: avail(5, ['Wed'], 3), Ben: avail(5, ['Wed', 'Thu'], 3) };
  let got = run({ tasks: [], oneOffs: [oneOff({ day: 'Wed' })], availability }).rows[0];
  assert.deepStrictEqual([got.name, got.date, got.day, got.source], ['Ana', WED, 'Wed', 'auto']);

  got = run({ tasks: [], oneOffs: [oneOff({ day: WED })], availability }).rows[0];
  assert.deepStrictEqual([got.name, got.date], ['Ana', WED], 'a full date works as well as a day name');

  got = run({ tasks: [], oneOffs: [oneOff({ day: 'Wed' })], availability: { Ana: avail(5, ['Thu'], 3) } });
  assert.strictEqual(got.rows[0].name, '');
  assert.strictEqual(got.rows[0].date, WED);
  assert.deepStrictEqual(got.unfilled, got.rows);
});

test('pinned one-off: a day name or a full date both pin it, and a date outside the week does not', () => {
  const availability = { Ana: avail(5, ['Mon', 'Wed'], 3) };
  const dateFor = (day) => run({ tasks: [], oneOffs: [oneOff({ day })], availability }).rows[0].date;
  assert.strictEqual(dateFor(''), MON, 'with no day it goes to the earliest date with room');
  assert.strictEqual(dateFor('Wed'), WED);
  assert.strictEqual(dateFor('wed'), WED);
  assert.strictEqual(dateFor('Wednesday'), WED);
  assert.strictEqual(dateFor(WED), WED);
  assert.strictEqual(dateFor('2026-11-18'), MON, 'a date in another week pins nothing here');
  assert.strictEqual(dateFor('Someday'), MON);
});

test('pinned one-off: goes before a movable task of the same priority, and can use a Sunday', () => {
  const { rows } = run({
    tasks: [task({ id: 'R1', days: ['Wed'], flexDays: 1, minutes: 60 })],
    oneOffs: [oneOff({ id: 'P1', day: 'Wed', minutes: 60 })],
    availability: { Ana: avail(2, ['Wed'], 1) },
  });
  assert.strictEqual(byKey(rows, 'oneoff|P1').name, 'Ana');
  assert.strictEqual(byKey(rows, 'task|R1|' + WED).name, '');

  const sunday = run({ tasks: [], oneOffs: [oneOff({ day: 'Sun' })], availability: { Ana: avail(2, ['Sun'], 3) } }).rows[0];
  assert.deepStrictEqual([sunday.name, sunday.date], ['Ana', SUN]);
});

test('pinned one-off: too big for anyone stays whole and uncovered, it never goes partial', () => {
  const { rows, unfilled } = run({ tasks: [], oneOffs: [oneOff({ day: 'Mon', minutes: 300 })], availability: { Ana: avail(6, ['Mon'], 3) } });
  assert.strictEqual(rows[0].name, '');
  assert.strictEqual(rows[0].minutes, 300);
  assert.strictEqual(rows[0].partial, false);
  assert.strictEqual(unfilled.length, 1);
});

test('pinned one-off on a closed day: waits uncovered on the next open day for a manager to decide', () => {
  const { rows, unfilled } = run({
    tasks: [],
    closedDays: [THU],
    oneOffs: [oneOff({ day: 'Thu', who: ['Max'] }), oneOff({ id: 'O2', day: 'Thu' })],
    availability: { Ana: avail(5, MON_SAT, 3) },
  });
  assert.deepStrictEqual(rows.map((r) => [r.name, r.date]), [['', FRI], ['', FRI]]);
  assert.strictEqual(unfilled.length, 2);
});

test('pinned one-off whose day has passed stands for today, so it stays open and keeps rolling', () => {
  const { rows } = run({
    tasks: [],
    today: WED,
    oneOffs: [oneOff({ day: 'Mon' })],
    availability: { Ana: avail(5, ['Mon', 'Wed'], 3) },
  });
  assert.deepStrictEqual([rows[0].name, rows[0].date], ['Ana', WED]);
});

test('uncovered one-off with nowhere open to wait: it still lands on a date inside the week', () => {
  const everyDay = [MON, TUE, WED, THU, FRI, SAT, SUN];
  const place = (extra, overrides) => run({ tasks: [], availability: {}, oneOffs: [oneOff(overrides)], ...extra }).rows[0];
  const pastWeek = place({ today: '2026-11-20' }, { day: 'Mon' });
  assert.deepStrictEqual([pastWeek.name, pastWeek.date, pastWeek.day], ['', SUN, 'Sun'], 'the week is over, so its last day');
  assert.strictEqual(place({ closedDays: everyDay }).date, MON, 'all closed, week still ahead: its first day');
  assert.strictEqual(place({ closedDays: everyDay, today: WED }).date, WED, 'all closed, mid-week: today');
  const onlyEarlier = place({ closedDays: [SAT] }, { day: 'Sat' });
  assert.strictEqual(onlyEarlier.date, MON, 'Saturday closed and nothing open after it: the first open day');
  const onlySunday = place({ today: SAT, closedDays: [SAT], availability: { Ana: avail(5, ['Sun'], 3) } });
  assert.deepStrictEqual([onlySunday.name, onlySunday.date], ['', SUN], 'only Sunday is left: it waits there, and she is not put on it');
});

test('one-offs: only open ones get rows', () => {
  const { rows } = run({
    tasks: [],
    oneOffs: [oneOff({ id: 'A', status: 'open' }), oneOff({ id: 'B', status: 'done' }), oneOff({ id: 'C', status: 'deleted' })],
    availability: { Ana: avail(5, ['Mon'], 3) },
  });
  assert.deepStrictEqual(rows.map((r) => r.oneOffId), ['A']);
});

test('who filter: only those people, even when someone better ranked is free', () => {
  const availability = { Ana: avail(5, ['Mon'], 3), Cora: avail(5, ['Mon'], 3) };
  let got = run({ tasks: [], oneOffs: [oneOff({ who: ['Cora'] })], availability }).rows[0];
  assert.strictEqual(got.name, 'Cora');
  got = run({ tasks: [], oneOffs: [oneOff({ who: ['Cora'], day: 'Mon' })], availability }).rows[0];
  assert.strictEqual(got.name, 'Cora', 'pinned works the same way');
  got = run({ tasks: [], oneOffs: [oneOff({ who: ['Dev'] })], availability }).rows[0];
  assert.strictEqual(got.name, '', 'Dev has no availability, and nobody else may take it');
  got = run({ tasks: [], oneOffs: [oneOff({ who: ['Ghost'] })], availability }).rows[0];
  assert.strictEqual(got.name, '', 'an unknown name never widens to everyone');
});

test('who filter: names as comma-separated text work the same, and blank means anyone', () => {
  const availability = { Ana: avail(5, ['Mon'], 3), Ben: avail(5, ['Mon'], 3), Cora: avail(5, ['Mon'], 3) };
  const nameFor = (who) => run({ tasks: [], oneOffs: [oneOff({ who })], availability }).rows[0].name;
  assert.strictEqual(nameFor('Cora, Ben'), 'Ben');
  assert.strictEqual(nameFor(''), 'Ana');
  assert.strictEqual(nameFor(undefined), 'Ana');
  assert.strictEqual(nameFor([]), 'Ana');
});

test('several names in who: by rank, not by the order they are listed', () => {
  const availability = { Ana: avail(5, ['Mon'], 3), Ben: avail(5, ['Mon'], 3), Cora: avail(5, ['Mon'], 3) };
  const who = ['Cora', 'Ben'];
  assert.strictEqual(run({ tasks: [], oneOffs: [oneOff({ who })], availability }).rows[0].name, 'Ben');
  const benGone = { ...availability, Ben: avail(5, ['Tue'], 1) };
  const got = run({ tasks: [], oneOffs: [oneOff({ who, day: 'Mon' })], availability: benGone }).rows[0];
  assert.strictEqual(got.name, 'Cora', 'pinned Monday and Ben only has Tuesday');
});

test('no-day one-off: people first, on a date where they already have work', () => {
  const { rows } = run({
    tasks: [task({ id: 'R1', priority: 'A', days: ['Wed'], minutes: 60 })],
    oneOffs: [oneOff({ priority: 'B' })],
    availability: { Ana: avail(6, ['Mon', 'Wed'], 3) },
  });
  const got = byKey(rows, 'oneoff|O1');
  assert.deepStrictEqual([got.name, got.date, got.day], ['Ana', WED, 'Wed'], 'Wed because she is there anyway, not the earlier Mon');
});

test('no-day one-off: the best-ranked person gets it, even on a later day than someone else could do it', () => {
  const got = run({ tasks: [], oneOffs: [oneOff()], availability: { Ben: avail(6, ['Mon'], 3), Ana: avail(6, ['Fri'], 3) } }).rows[0];
  assert.deepStrictEqual([got.name, got.date], ['Ana', FRI]);
});

test('no-day one-off: with no work yet, the earliest date with room', () => {
  const availability = { Ana: { none: false, hoursWanted: 6, dayHours: { Tue: 1, Wed: 3, Thu: 3 } } };
  const got = run({ tasks: [], oneOffs: [oneOff({ minutes: 90 })], availability }).rows[0];
  assert.strictEqual(got.date, WED, 'Tuesday only has an hour, so Wednesday is the earliest with room');
});

test('no-day one-off: skips a worked day with no room, then the next person when they have none at all', () => {
  const availability = { Ana: avail(6, ['Mon', 'Wed'], 1), Ben: avail(6, ['Tue'], 3) };
  const tasks = [task({ id: 'R1', priority: 'A', days: ['Mon'], minutes: 45 })];
  let got = byKey(run({ tasks, oneOffs: [oneOff({ minutes: 30 })], availability }).rows, 'oneoff|O1');
  assert.deepStrictEqual([got.name, got.date], ['Ana', WED], 'only 15 left on Monday, so her empty Wednesday');

  got = byKey(run({ tasks, oneOffs: [oneOff({ minutes: 90 })], availability }).rows, 'oneoff|O1');
  assert.deepStrictEqual([got.name, got.date, got.partial], ['Ben', TUE, false], 'too big for her, and Ben fits it whole');
});

test('no-day one-off: never on Sunday, a closed day or before today, and it counts against capacity', () => {
  const noWork = run({ tasks: [], oneOffs: [oneOff()], availability: { Ana: avail(6, ['Sun'], 3) } }).rows[0];
  assert.strictEqual(noWork.name, '');
  assert.notStrictEqual(noWork.date, SUN);
  assert.strictEqual(noWork.date, MON, 'uncovered, it waits on the first allowed date');

  const closed = run({ tasks: [], closedDays: [MON], oneOffs: [oneOff()], availability: { Ana: avail(6, ['Mon', 'Tue'], 3) } }).rows[0];
  assert.strictEqual(closed.date, TUE);

  const late = run({ tasks: [], today: WED, oneOffs: [oneOff()], availability: { Ana: avail(6, ['Mon', 'Thu'], 3) } }).rows[0];
  assert.strictEqual(late.date, THU);

  const { rows } = run({
    tasks: [task({ id: 'R1', priority: 'C', minutes: 60 })],
    oneOffs: [oneOff({ priority: 'B', minutes: 60 })],
    availability: { Ana: avail(1, ['Mon'], 1) },
  });
  assert.strictEqual(byKey(rows, 'oneoff|O1').name, 'Ana');
  assert.strictEqual(byKey(rows, 'task|R1|' + MON).name, '', 'the one-off took the hour');
});

test('oversized one-off becomes partial: best-ranked person, using what is left of the day', () => {
  const { rows, unfilled } = run({ tasks: [], oneOffs: [oneOff({ minutes: 300 })], availability: { Ana: avail(6, ['Mon'], 3), Ben: avail(6, ['Mon'], 3) } });
  assert.deepStrictEqual([rows[0].name, rows[0].date, rows[0].minutes, rows[0].partial], ['Ana', MON, 180, true]);
  assert.deepStrictEqual(unfilled, []);
});

test('oversized one-off: uses what is left of the week when that is smaller than the day', () => {
  const got = run({ tasks: [], oneOffs: [oneOff({ minutes: 300 })], availability: { Ana: avail(1, ['Mon'], 6) } }).rows[0];
  assert.deepStrictEqual([got.name, got.minutes, got.partial], ['Ana', 75, true]);
});

test('oversized one-off: someone lower ranked who fits it whole beats a partial for someone better', () => {
  const got = run({ tasks: [], oneOffs: [oneOff({ minutes: 300 })], availability: { Ana: avail(6, ['Mon'], 3), Ben: avail(6, ['Tue'], 6) } }).rows[0];
  assert.deepStrictEqual([got.name, got.date, got.minutes, got.partial], ['Ben', TUE, 300, false]);
});

test('oversized one-off: needs 30 minutes left, and goes to the next rank when the best has less', () => {
  const tasks = [task({ id: 'R1', priority: 'A', days: ['Mon'], minutes: 40 }), task({ id: 'R2', priority: 'A', days: ['Tue'], minutes: 15 })];
  const availability = { Ana: avail(6, ['Mon'], 1), Ben: avail(6, ['Tue'], 1) };
  const { rows } = run({ tasks, oneOffs: [oneOff({ minutes: 300 })], availability });
  const got = byKey(rows, 'oneoff|O1');
  assert.deepStrictEqual([got.name, got.date, got.minutes, got.partial], ['Ben', TUE, 45, true], 'Ana has only 20 left, Ben has 45');
});

test('oversized one-off: exactly 30 left is enough, 29 is not, and nobody means uncovered at full size', () => {
  const availability = { Ana: avail(6, ['Mon'], 1) };
  const withRoom = (minutes) => run({ tasks: [task({ id: 'R1', priority: 'A', minutes })], oneOffs: [oneOff({ minutes: 300 })], availability });
  const thirty = byKey(withRoom(30).rows, 'oneoff|O1');
  assert.deepStrictEqual([thirty.name, thirty.minutes, thirty.partial], ['Ana', 30, true]);
  const short = byKey(withRoom(31).rows, 'oneoff|O1');
  assert.deepStrictEqual([short.name, short.minutes, short.partial], ['', 300, false]);
});

test('oversized one-off: starts on a day they already work before an empty earlier day', () => {
  const { rows } = run({
    tasks: [task({ id: 'R1', priority: 'A', minutes: 60, days: ['Wed'] })],
    oneOffs: [oneOff({ minutes: 300 })],
    availability: { Ana: avail(20, ['Mon', 'Wed'], 3) },
  });
  const got = byKey(rows, 'oneoff|O1');
  assert.deepStrictEqual([got.name, got.date, got.minutes, got.partial], ['Ana', WED, 120, true]);
});

test('oversized one-off: the who filter still applies', () => {
  const availability = { Ana: avail(6, ['Mon'], 3), Ben: avail(6, ['Mon'], 2) };
  const got = run({ tasks: [], oneOffs: [oneOff({ minutes: 300, who: ['Ben'] })], availability }).rows[0];
  assert.deepStrictEqual([got.name, got.minutes, got.partial], ['Ben', 120, true]);
});

test('who with a Set person: no capacity tracking, their next set day', () => {
  const place = (extra, overrides) => run({ tasks: [], oneOffs: [oneOff({ who: ['Gus'], minutes: 600, ...overrides })], ...extra }).rows[0];
  const got = place({});
  assert.deepStrictEqual([got.name, got.date, got.minutes, got.partial, got.source], ['Gus', THU, 600, false, 'auto']);
  assert.strictEqual(place({ today: FRI }).date, FRI, 'next set day counts from today');
  assert.strictEqual(place({ today: SAT }).date, SUN, 'their Sunday still counts as a set day');
  assert.strictEqual(place({ closedDays: [THU] }).date, FRI, 'skips a closed set day');
  assert.strictEqual(place({ timeOff: [{ name: 'Gus', from: THU, to: THU }] }).date, FRI, 'skips a day they are away');
  assert.strictEqual(place({}, { day: 'Mon' }).date, MON, 'pinned date wins');
});

test('who with a Set person: after their last set day, the first allowed date', () => {
  const got = run({ tasks: [], today: WED, oneOffs: [oneOff({ who: ['Hal'] })] }).rows[0];
  assert.deepStrictEqual([got.name, got.date], ['Hal', WED]);
  const away = run({ tasks: [], oneOffs: [oneOff({ who: ['Hal'], day: 'Tue' })], timeOff: [{ name: 'Hal', from: TUE, to: TUE }] }).rows[0];
  assert.deepStrictEqual([away.name, away.date], ['', TUE], 'pinned to a day they are away stays uncovered');
});

test('who with a Manager: no capacity tracking, the first allowed date', () => {
  const place = (extra, overrides) => run({ tasks: [], oneOffs: [oneOff({ who: ['Max'], minutes: 600, ...overrides })], ...extra });
  const result = place({});
  const got = result.rows[0];
  assert.deepStrictEqual([got.name, got.date, got.minutes, got.partial], ['Max', MON, 600, false]);
  assert.strictEqual(result.usage.Max.minutes, 600);
  assert.strictEqual(result.usage.Max.wantedMinutes, null);
  assert.strictEqual(place({ today: WED }).rows[0].date, WED);
  assert.strictEqual(place({ closedDays: [MON] }).rows[0].date, TUE);
  assert.strictEqual(place({}, { day: 'Thu' }).rows[0].date, THU, 'pinned date wins');
  assert.strictEqual(place({ timeOff: [{ name: 'Max', from: MON, to: WED }] }).rows[0].date, THU, 'managers can be away too');
});

test('who mixing people: a flexible person who fits comes before a manager, who has no rank', () => {
  const who = ['Max', 'Ana'];
  let got = run({ tasks: [], oneOffs: [oneOff({ who })], availability: { Ana: avail(5, ['Tue'], 3) } }).rows[0];
  assert.deepStrictEqual([got.name, got.date], ['Ana', TUE]);
  got = run({ tasks: [], oneOffs: [oneOff({ who })], availability: {} }).rows[0];
  assert.deepStrictEqual([got.name, got.date], ['Max', MON]);
  got = run({ tasks: [], oneOffs: [oneOff({ who: ['Gus', 'Ana'] })], availability: { Ana: avail(5, ['Tue'], 3) } }).rows[0];
  assert.deepStrictEqual([got.name, got.date], ['Gus', THU], 'set people have the better ranks');
  const inactive = buildInput().staff.map((p) => (p.name === 'Gus' ? { ...p, active: false } : p));
  got = run({ tasks: [], staff: inactive, oneOffs: [oneOff({ who: ['Gus'] })] }).rows[0];
  assert.strictEqual(got.name, '', 'an inactive person gets nothing');
});

test('who mixing people: having no rank puts a manager last, whatever their name is', () => {
  const staff = [...buildInput().staff, { name: 'Abe', rank: null, type: 'Manager', active: true, setDays: [], setTasks: [] }];
  const got = run({ tasks: [], staff, oneOffs: [oneOff({ who: ['Abe', 'Ana'] })], availability: { Ana: avail(5, ['Tue'], 3) } }).rows[0];
  assert.strictEqual(got.name, 'Ana');
});

test('Set and Manager one-offs do not eat into anyone else', () => {
  const { rows, usage } = run({
    tasks: [task({ id: 'R1', minutes: 60 })],
    oneOffs: [oneOff({ who: ['Max'], day: 'Mon', minutes: 600 })],
    availability: { Ana: avail(1, ['Mon'], 1) },
  });
  assert.strictEqual(byKey(rows, 'task|R1|' + MON).name, 'Ana');
  assert.strictEqual(usage.Ana.minutes, 60);
});

/* ---------------------------------------------------------- tidy short trips ---- */

test('tidy: a short trip moves to another day in the window where the same person already works', () => {
  const { rows, usage } = run({
    tasks: [task({ id: 'R1', minutes: 15, days: ['Mon'], flexDays: 1 }), task({ id: 'R2', priority: 'A', minutes: 60, days: ['Tue'] })],
    availability: { Ana: avail(6, ['Mon', 'Tue'], 3) },
  });
  const moved = byKey(rows, 'task|R1|' + MON);
  assert.deepStrictEqual([moved.name, moved.date, moved.day], ['Ana', TUE, 'Tue']);
  assert.deepStrictEqual(usage.Ana.byDate, { [TUE]: 75 });
});

test('tidy: a day outside the row window does not count, so it stays or goes to someone else', () => {
  const { rows } = run({
    tasks: [task({ id: 'R1', minutes: 15, days: ['Mon'], flexDays: 1 }), task({ id: 'R2', priority: 'A', minutes: 60, days: ['Wed'] })],
    availability: { Ana: avail(6, ['Mon', 'Wed'], 3) },
  });
  assert.deepStrictEqual([byKey(rows, 'task|R1|' + MON).name, byKey(rows, 'task|R1|' + MON).date], ['Ana', MON]);
});

test('tidy: otherwise it moves to another person already working that day, by rank', () => {
  // Ana takes the 15-minute A row first and then has no room for the hour, so Ben and Cora come in anyway.
  const { rows, usage } = run({
    tasks: [
      task({ id: 'R1', priority: 'A', minutes: 15, days: ['Mon'], flexDays: 1 }),
      task({ id: 'R2', priority: 'B', minutes: 60, days: ['Mon'] }),
      task({ id: 'R3', priority: 'B', minutes: 60, days: ['Mon'], order: 101 }),
    ],
    availability: { Ana: avail(6, ['Mon'], 1), Ben: avail(1, ['Mon'], 3), Cora: avail(6, ['Mon'], 3) },
  });
  const moved = byKey(rows, 'task|R1|' + MON);
  assert.deepStrictEqual([moved.name, moved.date], ['Ben', MON]);
  assert.strictEqual(usage.Ana.minutes, 0);
  assert.strictEqual(usage.Ben.minutes, 75, 'Ben first by rank, and it still fits his tolerance');
  assert.strictEqual(usage.Cora.minutes, 60);
});

test('tidy: same person on another day comes before another person', () => {
  const { rows } = run({
    tasks: [
      task({ id: 'R1', priority: 'A', minutes: 15, days: ['Mon'], flexDays: 1 }),
      task({ id: 'R2', priority: 'B', minutes: 60, days: ['Mon'] }),
      task({ id: 'R3', priority: 'B', minutes: 30, days: ['Tue'] }),
    ],
    availability: { Ana: avail(6, ['Mon', 'Tue'], 1), Ben: avail(6, ['Mon'], 3) },
  });
  assert.deepStrictEqual([byKey(rows, 'task|R1|' + MON).name, byKey(rows, 'task|R1|' + MON).date], ['Ana', TUE]);
});

test('tidy: with nowhere to go, the row stays', () => {
  const got = placeOne({ minutes: 15, days: ['Mon'], flexDays: 1 }, { Ana: avail(6, ['Mon', 'Tue'], 3) });
  assert.deepStrictEqual([got.name, got.date], ['Ana', MON], 'she has no other work to join');
});

test('tidy: never moves to a day the person does not already work', () => {
  // Saturday's window reaches back to Friday. She has the room there, but no reason to come in.
  const got = placeOne({ minutes: 15, days: ['Sat'], flexDays: 1 }, { Ana: avail(6, ['Fri', 'Sat'], 3) });
  assert.deepStrictEqual([got.name, got.date], ['Ana', SAT]);
});

test('tidy: never moves to a person who is not already working that day', () => {
  // Cora is allowed to do both and has the room, but neither row is a reason to bring her in.
  const { rows } = run({
    tasks: [],
    oneOffs: [oneOff({ id: 'O1', minutes: 15, who: ['Ana', 'Cora'] }), oneOff({ id: 'O2', minutes: 15, who: ['Ben', 'Cora'] })],
    availability: { Ana: avail(6, ['Mon'], 3), Ben: avail(6, ['Mon'], 3), Cora: avail(6, ['Mon'], 3) },
  });
  assert.strictEqual(byKey(rows, 'oneoff|O1').name, 'Ana');
  assert.strictEqual(byKey(rows, 'oneoff|O2').name, 'Ben');
});

test('tidy: a flex 0 row or pinned one-off stays with its person, even when someone else is working that day', () => {
  const availability = { Ben: avail(6, ['Mon'], 3), Cora: avail(6, ['Mon'], 3) };
  const coraWorks = oneOff({ id: 'C1', day: 'Mon', who: ['Cora'], minutes: 60 });
  const withTask = (flexDays) => run({ tasks: [task({ id: 'R1', minutes: 15, days: ['Mon'], flexDays })], oneOffs: [coraWorks], availability }).rows;

  assert.strictEqual(byKey(withTask(1), 'task|R1|' + MON).name, 'Cora', 'the same row with flex 1 does join Cora');
  assert.strictEqual(byKey(withTask(0), 'task|R1|' + MON).name, 'Ben');
  const pinned = run({ tasks: [], oneOffs: [coraWorks, oneOff({ id: 'P1', day: 'Mon', minutes: 15 })], availability }).rows;
  assert.strictEqual(byKey(pinned, 'oneoff|P1').name, 'Ben');
});

test('tidy: never hands work to a manager, even one with a stray availability entry', () => {
  const { rows } = run({
    tasks: [],
    oneOffs: [oneOff({ who: ['Ana', 'Max'], minutes: 15 })],
    availability: { Ana: avail(6, ['Mon'], 3), Max: avail(6, ['Mon'], 3) },
    locked: [row({ key: 'L1', taskId: 'L', minutes: 30, name: 'Max' })],
  });
  assert.strictEqual(rows[0].name, 'Ana');
});

test('tidy: only a whole day of movable auto rows under 30 minutes counts', () => {
  const availability = { Ana: avail(6, ['Mon', 'Tue'], 3) };
  const anchor = task({ id: 'ANCHOR', priority: 'A', minutes: 60, days: ['Tue'] });

  let rows = run({ tasks: [task({ id: 'R1', minutes: 15, days: ['Mon'], flexDays: 0 }), anchor], availability }).rows;
  assert.strictEqual(byKey(rows, 'task|R1|' + MON).date, MON, 'flex 0 is not movable');

  rows = run({ tasks: [task({ id: 'R1', minutes: 30, days: ['Mon'], flexDays: 1 }), anchor], availability }).rows;
  assert.strictEqual(byKey(rows, 'task|R1|' + MON).date, MON, 'exactly 30 is not under 30');

  rows = run({
    tasks: [task({ id: 'R1', minutes: 5, days: ['Mon'], flexDays: 1 }), task({ id: 'R2', minutes: 20, days: ['Mon'], flexDays: 0 }), anchor],
    availability,
  }).rows;
  assert.strictEqual(byKey(rows, 'task|R1|' + MON).date, MON, 'she is coming in for the flex 0 row anyway');

  rows = run({
    tasks: [task({ id: 'R1', minutes: 15, days: ['Mon'], flexDays: 1 }), task({ id: 'R2', minutes: 10, days: ['Mon'], flexDays: 1 }), anchor],
    availability,
  }).rows;
  assert.strictEqual(byKey(rows, 'task|R1|' + MON).date, TUE, 'two movable rows move together');
  assert.strictEqual(byKey(rows, 'task|R2|' + MON).date, TUE);
});

test('tidy: all or nothing, because moving part of a trip just leaves a shorter trip', () => {
  const { rows } = run({
    tasks: [
      task({ id: 'R1', minutes: 10, days: ['Mon'], flexDays: 1 }),
      task({ id: 'R2', minutes: 10, days: ['Mon'], flexDays: 1 }),
      task({ id: 'ANCHOR', priority: 'A', minutes: 50, days: ['Tue'] }),
    ],
    availability: { Ana: avail(6, ['Mon', 'Tue'], 1) },
  });
  assert.strictEqual(byKey(rows, 'task|R1|' + MON).date, MON, 'Tuesday has room for only one of them');
  assert.strictEqual(byKey(rows, 'task|R2|' + MON).date, MON);
});

test('tidy: a move that falls through gives back the room it was holding', () => {
  const { rows } = run({
    tasks: [
      task({ id: 'R1', minutes: 10, days: ['Mon'], flexDays: 1 }),
      task({ id: 'R2', minutes: 10, days: ['Mon'], flexDays: 1 }),
      task({ id: 'ANCHOR', priority: 'A', minutes: 50, days: ['Tue'] }),
      task({ id: 'R3', minutes: 10, days: ['Wed'], flexDays: 1 }),
    ],
    availability: { Ana: avail(6, ['Mon', 'Tue', 'Wed'], 1) },
  });
  assert.strictEqual(byKey(rows, 'task|R1|' + MON).date, MON, 'Tuesday only has room for one of the Monday rows');
  assert.strictEqual(byKey(rows, 'task|R2|' + MON).date, MON);
  assert.strictEqual(byKey(rows, 'task|R3|' + WED).date, TUE, 'so the last 10 minutes of Tuesday are still free for this one');
});

test('tidy: never moves cover rows', () => {
  const tasks = [task({ id: 'S1', minutes: 15, setOnly: true, days: [], flexDays: 1 }), task({ id: 'ANCHOR', minutes: 60, days: ['Fri'] })];
  const staff = [{ name: 'Gus', rank: 1, type: 'Set', active: true, setDays: ['Thu'], setTasks: [{ taskId: 'S1', days: null }] }, ...STAFF.filter((p) => p.type === 'Flexible')];
  const { rows } = run({ tasks, staff, availability: { Ana: avail(6, ['Thu', 'Fri'], 3) }, timeOff: [{ name: 'Gus', from: THU, to: THU }] });
  const cover = byKey(rows, `set|S1|${THU}|Gus`);
  assert.deepStrictEqual([cover.name, cover.date, cover.source], ['Ana', THU, 'cover']);
});

test('tidy: a no-day one-off can move, within its who list', () => {
  // The A one-off lands first, on Monday, before there is any other work to join.
  const tasks = [task({ id: 'R1', priority: 'B', minutes: 60, days: ['Wed'] })];
  let got = run({ tasks, oneOffs: [oneOff({ priority: 'A', minutes: 15 })], availability: { Ana: avail(6, ['Mon', 'Wed'], 3) } }).rows;
  assert.deepStrictEqual([byKey(got, 'oneoff|O1').name, byKey(got, 'oneoff|O1').date], ['Ana', WED]);

  const crowded = { Ana: avail(6, ['Mon'], 1), Ben: avail(6, ['Mon'], 3) };
  const monday = [task({ id: 'R1', priority: 'B', minutes: 60, days: ['Mon'] })];
  got = run({ tasks: monday, oneOffs: [oneOff({ priority: 'A', minutes: 15 })], availability: crowded }).rows;
  assert.strictEqual(byKey(got, 'oneoff|O1').name, 'Ben', 'anyone may do it, so it joins Ben');
  got = run({ tasks: monday, oneOffs: [oneOff({ priority: 'A', minutes: 15, who: ['Ana'] })], availability: crowded }).rows;
  assert.strictEqual(byKey(got, 'oneoff|O1').name, 'Ana', 'only Ana may do it, so it stays');
});

test('tidy: leaves set staff and pinned one-offs alone', () => {
  const { rows } = run({
    tasks: [task({ id: 'R1', minutes: 60, days: ['Tue'] })],
    oneOffs: [oneOff({ id: 'P1', day: 'Mon', minutes: 15 }), oneOff({ id: 'P2', day: 'Mon', minutes: 15, who: ['Max'] })],
    availability: { Ana: avail(6, ['Mon', 'Tue'], 3) },
  });
  assert.deepStrictEqual([byKey(rows, 'oneoff|P1').name, byKey(rows, 'oneoff|P1').date], ['Ana', MON]);
  assert.deepStrictEqual([byKey(rows, 'oneoff|P2').name, byKey(rows, 'oneoff|P2').date], ['Max', MON]);
});

/* -------------------------------------------------------------------- locked ---- */

test('locked rows: use up capacity and hours, and are never repeated or changed', () => {
  const done = row({ key: 'task|X1|' + MON, taskId: 'X1', minutes: 60, name: 'Ana', source: 'auto' });
  const input = buildInput({
    tasks: [task({ id: 'X1', minutes: 60 }), task({ id: 'X2', minutes: 30 })],
    availability: { Ana: avail(1, ['Mon'], 2), Ben: avail(5, ['Mon'], 3) },
    locked: [done],
  });
  const { rows, usage } = schedBuildWeek(input);
  assert.deepStrictEqual(rows.map((r) => r.taskId), ['X2'], 'X1 is locked, so it is not made again');
  assert.strictEqual(rows[0].name, 'Ben', 'Ana has 15 minutes left of her week');
  assert.strictEqual(usage.Ana.minutes, 60);
});

test('locked rows: a locked set row or one-off is not made again either', () => {
  const lockedSet = row({ key: `set|T08|${THU}|Gus`, taskId: 'T08', date: THU, day: 'Thu', name: 'Gus', source: 'set', minutes: 60 });
  const lockedOneOff = row({ key: 'oneoff|O1', taskId: '', oneOffId: 'O1', name: 'Ana', minutes: 30 });
  const { rows } = run({ locked: [lockedSet, lockedOneOff], oneOffs: [oneOff({ id: 'O1' })], availability: {} });
  assert.ok(!rows.some((r) => r.key === lockedSet.key));
  assert.ok(!rows.some((r) => r.oneOffId === 'O1'));
  assert.ok(rows.some((r) => r.key === `set|T08|${FRI}|Gus`));
});

test('locked rows: a row without a key still counts, by task and date', () => {
  const noKey = row({ key: undefined, taskId: 'X1', minutes: 30, name: 'Ana' });
  const { rows } = run({ tasks: [task({ id: 'X1' })], locked: [noKey], availability: { Ana: avail(5, ['Mon'], 3) } });
  assert.deepStrictEqual(rows, []);
});

test('locked rows: a sheet ID as the key counts by task and date too, so nothing is made twice', () => {
  const tasks = [task({ id: 'X1', minutes: 15, days: ['Mon', 'Tue'] })];
  const availability = { Ana: avail(5, ['Mon', 'Tue'], 3) };
  const { rows } = run({ tasks, availability, locked: [row({ key: 'S-123', taskId: 'X1', minutes: 15, name: 'Ana' })] });
  assert.deepStrictEqual(rows.map((r) => r.date), [TUE], 'Monday is not made again, and Tuesday still is');

  const setRow = row({ key: 'S-124', taskId: 'T08', date: THU, day: 'Thu', name: 'Gus', source: 'set', minutes: 60 });
  const setRows = run({ locked: [setRow] }).rows.filter((r) => r.taskId === 'T08').map((r) => r.date);
  assert.deepStrictEqual(setRows, [TUE, FRI, SUN]);
});

test('locked rows: a one-off is matched by its ID, whatever the row key is', () => {
  const locked = [row({ key: 'S-125', taskId: '', oneOffId: 'O1', name: 'Ana' })];
  const { rows } = run({ tasks: [], locked, oneOffs: [oneOff({ id: 'O1' }), oneOff({ id: 'O2' })], availability: { Ana: avail(5, ['Mon'], 3) } });
  assert.deepStrictEqual(rows.map((r) => r.oneOffId), ['O2']);
});

test('locked rows: a row moved to another listed day, with its own key, does not use up that day', () => {
  // A manager moved Monday's row to Thursday. Its key still says Monday, so Thursday's own row is still needed.
  const moved = row({ key: 'task|X1|' + MON, taskId: 'X1', minutes: 15, date: THU, day: 'Thu', name: 'Ana', source: 'manual' });
  const { rows } = run({ tasks: [task({ id: 'X1', minutes: 15, days: ['Mon', 'Thu'] })], locked: [moved], availability: { Ana: avail(5, ['Thu'], 3) } });
  assert.deepStrictEqual(rows.map((r) => [r.key, r.name, r.date]), [['task|X1|' + THU, 'Ana', THU]]);
});

test('usage: counts locked work too, even for someone no longer on the staff list', () => {
  const { usage } = run({
    tasks: [task({ id: 'X1', minutes: 30 }), task({ id: 'X2', minutes: 30, days: ['Tue'] })],
    availability: { Ana: avail(5, ['Mon'], 3) },
    locked: [row({ key: 'L1', taskId: 'L', minutes: 20, name: 'Ana' }), row({ key: 'L2', taskId: 'L', date: TUE, day: 'Tue', minutes: 40, name: 'Gone' })],
  });
  assert.deepStrictEqual(usage.Ana, { minutes: 50, wantedMinutes: 300, byDate: { [MON]: 50 } });
  assert.deepStrictEqual(usage.Gone, { minutes: 40, wantedMinutes: null, byDate: { [TUE]: 40 } });
  assert.ok(!('' in usage), 'X2 is uncovered, and uncovered work is nobody\'s usage');
});

test('locked rows: a row with blank minutes counts as none and does not break anyone\'s capacity', () => {
  const locked = [row({ key: 'L1', taskId: 'L', minutes: undefined, name: 'Ana' })];
  const { rows, usage } = run({ tasks: [task({ id: 'X1', minutes: 60 })], locked, availability: { Ana: avail(1, ['Mon'], 1) } });
  assert.strictEqual(rows[0].name, 'Ana');
  assert.strictEqual(usage.Ana.minutes, 60);
});

test('locked rows: rows from other weeks do not count against this one', () => {
  const lastWeek = row({ key: 'old', date: '2026-11-07', day: 'Sat', minutes: 600, name: 'Ana' });
  const got = run({ tasks: [task()], locked: [lastWeek], availability: { Ana: avail(1, ['Mon'], 1) } });
  assert.strictEqual(got.rows[0].name, 'Ana');
  assert.strictEqual(got.usage.Ana.minutes, 30);
});

/* -------------------------------------------------------------- schedFillOpen ---- */

/** Ana has 120 locked and Ben 60, both free 3 hours Monday and wanting 3 hours. */
function fillSetup(overrides) {
  return buildInput({
    tasks: [task({ id: 'X1' }), task({ id: 'X2' }), task({ id: 'X3' })],
    availability: { Ana: avail(3, ['Mon'], 3), Ben: avail(3, ['Mon'], 3) },
    locked: [row({ key: 'L1', taskId: 'L', title: 'Ana locked', minutes: 120, name: 'Ana' }), row({ key: 'L2', taskId: 'L', title: 'Ben locked', minutes: 60, name: 'Ben' })],
    open: [row({ key: 'O1', taskId: 'X1', minutes: 30 }), row({ key: 'O2', taskId: 'X2', minutes: 90 })],
    ...overrides,
  });
}

test('schedFillOpen: returns only the open rows, assigned with locked capacity counted', () => {
  const { rows, unfilled, usage } = schedFillOpen(fillSetup());
  assert.deepStrictEqual(rows.map((r) => r.key).sort(), ['O1', 'O2']);
  assert.strictEqual(byKey(rows, 'O2').name, 'Ben', '90 goes first, and Ana only has 60 left');
  assert.strictEqual(byKey(rows, 'O1').name, 'Ana', '30 fits in her 60');
  assert.deepStrictEqual(unfilled, []);
  assert.strictEqual(usage.Ana.minutes, 150);
  assert.strictEqual(usage.Ben.minutes, 150);
});

test('schedFillOpen: does not change its input or move anyone else', () => {
  const input = fillSetup();
  const before = JSON.stringify(input);
  const { rows } = schedFillOpen(input);
  assert.strictEqual(JSON.stringify(input), before, 'nothing in the input changed');
  assert.ok(!rows.some((r) => r.key === 'L1' || r.key === 'L2'), 'locked rows never come back');
  assert.ok(input.open.every((r) => r.name === ''), 'open rows are copied, not edited');
});

test('schedFillOpen: pool limits who can take the work', () => {
  let { rows, unfilled } = schedFillOpen(fillSetup({ pool: ['Ben'] }));
  assert.deepStrictEqual(rows.map((r) => r.name), ['Ben', 'Ben'], 'Ben takes 90 and 30, Ana is not in the pool');
  assert.deepStrictEqual(unfilled, []);

  ({ rows, unfilled } = schedFillOpen(fillSetup({ pool: [] })));
  assert.deepStrictEqual(rows.map((r) => r.name), ['', ''], 'an empty pool is nobody, not everybody');
  assert.strictEqual(unfilled.length, 2);

  ({ rows } = schedFillOpen(fillSetup({ pool: ['Cora'] })));
  assert.deepStrictEqual(rows.map((r) => r.name), ['', ''], 'Cora has no availability');
});

test('schedFillOpen: locked rows use up both the day and the week', () => {
  const dayFull = fillSetup({
    availability: { Ana: avail(10, ['Mon'], 3) },
    locked: [row({ key: 'L1', minutes: 180, name: 'Ana' })],
    open: [row({ key: 'O1', minutes: 5 })],
  });
  assert.strictEqual(schedFillOpen(dayFull).rows[0].name, '');

  const weekFull = (minutes) =>
    fillSetup({
      availability: { Ana: avail(1, ['Mon', 'Tue'], 3) },
      locked: [row({ key: 'L1', date: TUE, day: 'Tue', minutes: 60, name: 'Ana' })],
      open: [row({ key: 'O1', minutes })],
    });
  assert.strictEqual(schedFillOpen(weekFull(15)).rows[0].name, 'Ana', '60 + 15 is exactly the tolerance');
  assert.strictEqual(schedFillOpen(weekFull(16)).rows[0].name, '');
});

test('schedFillOpen: an open row also listed in locked does not count against itself', () => {
  const open = row({ key: 'O1', minutes: 180 });
  const input = fillSetup({ availability: { Ana: avail(3, ['Mon'], 3) }, locked: [{ ...open, name: 'Ana' }], open: [open] });
  const result = schedFillOpen(input);
  assert.strictEqual(result.rows[0].name, 'Ana');
  assert.strictEqual(result.usage.Ana.minutes, 180, 'counted once');
});

test('schedFillOpen: a late submitter picks up only what is left, and nobody else moves', () => {
  const availability = workedExampleAvailability();
  const firstPass = run({ availability: { Ana: availability.Ana, Ben: availability.Ben } });
  const assigned = firstPass.rows.filter((r) => r.name);
  assert.deepStrictEqual(firstPass.unfilled.map((r) => r.day), ['Sat', 'Sat', 'Sat', 'Sat', 'Sat'], 'nobody offered Saturday');

  const assignedBefore = JSON.stringify(assigned);
  const late = schedFillOpen(buildInput({ availability, locked: assigned, open: firstPass.unfilled, pool: ['Cora'] }));
  assert.deepStrictEqual(minutesByPersonDay(late.rows), { Cora: { Sat: 55 } });
  assert.deepStrictEqual(late.unfilled, []);
  assert.strictEqual(JSON.stringify(assigned), assignedBefore);
  assert.deepStrictEqual(late.rows.map((r) => r.key).sort(), firstPass.unfilled.map((r) => r.key).sort());
  assert.strictEqual(late.usage.Ana.minutes, 340);
  assert.strictEqual(late.usage.Ben.minutes, 185);
  assert.strictEqual(late.usage.Cora.minutes, 55);
});

test('schedFillOpen: follows the same rules for rank, priority, flex and Sunday', () => {
  const input = buildInput({
    tasks: [task({ id: 'X1', flexDays: 1 }), task({ id: 'X2', flexDays: 1 })],
    availability: { Ben: avail(2, ['Tue', 'Sun'], 3), Ana: avail(1, ['Tue'], 1) },
    open: [
      row({ key: 'LOW', taskId: 'X1', priority: 'C', minutes: 60 }),
      row({ key: 'HIGH', taskId: 'X2', priority: 'A', minutes: 60 }),
      row({ key: 'SAT', taskId: 'X1', priority: 'C', date: SAT, day: 'Sat', minutes: 30 }),
    ],
  });
  const { rows } = schedFillOpen(input);
  const high = byKey(rows, 'HIGH');
  assert.deepStrictEqual([high.name, high.date, high.day], ['Ana', TUE, 'Tue'], 'priority first, then the window, then rank');
  assert.deepStrictEqual([byKey(rows, 'LOW').name, byKey(rows, 'LOW').date], ['Ben', TUE]);
  assert.strictEqual(byKey(rows, 'SAT').name, '', 'flex 1 from Saturday reaches Sunday, which the task does not list');
});

test('schedFillOpen: the window still reaches a Sunday the task lists', () => {
  const input = buildInput({
    tasks: [task({ id: 'X1', days: ['Sat', 'Sun'], flexDays: 1 })],
    availability: { Ana: avail(6, ['Sun'], 3) },
    open: [row({ key: 'O1', taskId: 'X1', date: SAT, day: 'Sat' })],
  });
  const got = schedFillOpen(input).rows[0];
  assert.deepStrictEqual([got.name, got.date, got.day], ['Ana', SUN, 'Sun']);
});

test('schedFillOpen: task order breaks a tie, and a blank priority comes from the task', () => {
  const tasks = [task({ id: 'LATER', order: 2 }), task({ id: 'SOONER', order: 1 }), task({ id: 'TOP', priority: 'A', order: 3 })];
  const availability = { Ana: avail(1, ['Mon'], 1) };
  // The keys run the opposite way from the order, so only the order can explain the winner.
  const tie = schedFillOpen(buildInput({
    tasks,
    availability,
    open: [row({ key: 'AAA', taskId: 'LATER', minutes: 60 }), row({ key: 'ZZZ', taskId: 'SOONER', minutes: 60 })],
  }));
  assert.deepStrictEqual([byKey(tie.rows, 'ZZZ').name, byKey(tie.rows, 'AAA').name], ['Ana', '']);

  const blank = schedFillOpen(buildInput({
    tasks,
    availability,
    open: [row({ key: 'AAA', taskId: 'SOONER', minutes: 60 }), row({ key: 'ZZZ', taskId: 'TOP', priority: '', minutes: 60 })],
  }));
  assert.deepStrictEqual([byKey(blank.rows, 'ZZZ').name, byKey(blank.rows, 'AAA').name], ['Ana', '']);
});

test('schedFillOpen: a row with no key gets one, the same as a built row would have', () => {
  const input = buildInput({
    tasks: [task({ id: 'X1' })],
    oneOffs: [oneOff({ id: 'O1' })],
    availability: { Ana: avail(6, ['Mon'], 3) },
    open: [row({ key: '', taskId: 'X1' }), row({ key: undefined, taskId: '', oneOffId: 'O1' })],
  });
  assert.deepStrictEqual(schedFillOpen(input).rows.map((r) => r.key).sort(), ['oneoff|O1', 'task|X1|' + MON]);
});

test('schedFillOpen: a released set row becomes cover', () => {
  const input = buildInput({
    availability: { Ana: avail(6, ['Thu'], 3) },
    open: [row({ key: 'set-thu', taskId: 'T08', date: THU, day: 'Thu', minutes: 60, source: 'set', priority: 'A+++++' })],
  });
  const got = schedFillOpen(input).rows[0];
  assert.deepStrictEqual([got.name, got.source], ['Ana', 'cover']);
});

test('schedFillOpen: keeps the source the caller set, and any extra fields on the row', () => {
  const input = buildInput({
    availability: { Ana: avail(6, ['Mon'], 3) },
    open: [row({ key: 'O1', source: 'late', _row: 42, status: 'open' }), row({ key: 'O2', source: '', minutes: 5 })],
  });
  const { rows } = schedFillOpen(input);
  assert.deepStrictEqual([byKey(rows, 'O1').source, byKey(rows, 'O1')._row, byKey(rows, 'O1').status], ['late', 42, 'open']);
  assert.strictEqual(byKey(rows, 'O2').source, 'auto');
});

test('schedFillOpen: reassigns a row that came in with a stale name', () => {
  const input = buildInput({ availability: { Cora: avail(6, ['Mon'], 3) }, open: [row({ key: 'O1', name: 'Ana' })] });
  assert.strictEqual(schedFillOpen(input).rows[0].name, 'Cora');
  const nobody = schedFillOpen(buildInput({ open: [row({ key: 'O1', name: 'Ana' })] }));
  assert.strictEqual(nobody.rows[0].name, '');
  assert.strictEqual(nobody.unfilled.length, 1);
});

test('schedFillOpen: never loses a row it cannot place', () => {
  const closed = buildInput({
    tasks: [task({ id: 'X1' })],
    closedDays: [MON],
    availability: { Ana: avail(6, ['Mon'], 3) },
    open: [row({ key: 'O1', taskId: 'X1' })],
  });
  let result = schedFillOpen(closed);
  assert.deepStrictEqual([result.rows[0].name, result.rows[0].date], ['', MON]);
  assert.strictEqual(result.unfilled.length, 1);

  const past = buildInput({ tasks: [task({ id: 'X1' })], today: WED, availability: { Ana: avail(6, ['Mon'], 3) }, open: [row({ key: 'O1', taskId: 'X1' })] });
  result = schedFillOpen(past);
  assert.strictEqual(result.rows[0].name, '');
  assert.strictEqual(result.unfilled.length, 1);
});

test('schedFillOpen: a new one-off in a published week follows who and goes people-first', () => {
  const input = buildInput({
    oneOffs: [oneOff({ id: 'O1', who: ['Cora'], minutes: 60 })],
    availability: { Ana: avail(6, ['Mon'], 3), Cora: avail(6, ['Mon', 'Wed'], 3) },
    locked: [row({ key: 'L1', date: WED, day: 'Wed', minutes: 60, name: 'Cora' })],
    open: [row({ key: 'oneoff|O1', taskId: '', oneOffId: 'O1', date: '', day: '' })],
  });
  const got = schedFillOpen(input).rows[0];
  assert.deepStrictEqual([got.name, got.date, got.day], ['Cora', WED, 'Wed'], 'she is already in Wednesday');
});

test('schedFillOpen: a pinned one-off with no date yet is placed on its pinned day', () => {
  const input = buildInput({
    oneOffs: [oneOff({ id: 'O1', day: 'Wed' })],
    availability: { Ana: avail(6, ['Mon', 'Wed'], 3) },
    open: [row({ key: 'oneoff|O1', taskId: '', oneOffId: 'O1', date: '', day: '' })],
  });
  const got = schedFillOpen(input).rows[0];
  assert.deepStrictEqual([got.name, got.date], ['Ana', WED]);
});

test('schedFillOpen: a pinned one-off whose day has passed stands for today', () => {
  const input = buildInput({
    today: WED,
    oneOffs: [oneOff({ id: 'O1', day: 'Mon' })],
    availability: { Ana: avail(6, ['Wed'], 3) },
    open: [row({ key: 'oneoff|O1', taskId: '', oneOffId: 'O1', date: MON })],
  });
  const got = schedFillOpen(input).rows[0];
  assert.deepStrictEqual([got.name, got.date, got.day], ['Ana', WED, 'Wed']);
});

test('schedFillOpen: a no-day one-off nobody can take stays on its date, if that date still works', () => {
  const place = (date, extra) => {
    const input = buildInput({
      oneOffs: [oneOff({ id: 'O1' })],
      open: [row({ key: 'oneoff|O1', taskId: '', oneOffId: 'O1', date, day: '' })],
      ...extra,
    });
    return schedFillOpen(input).rows[0];
  };
  const stays = place(WED);
  assert.deepStrictEqual([stays.name, stays.date, stays.day], ['', WED, 'Wed']);
  assert.strictEqual(place(WED, { closedDays: [WED] }).date, MON, 'that day closed, so the first open day');
  assert.strictEqual(place(MON, { today: THU }).date, THU, 'that day has passed, so today');
});

test('schedFillOpen: a rolling partial one-off goes back to full size each time', () => {
  const input = buildInput({
    oneOffs: [oneOff({ id: 'O1', minutes: 300 })],
    availability: { Ana: avail(6, ['Tue'], 4) },
    open: [row({ key: 'oneoff|O1', taskId: '', oneOffId: 'O1', minutes: 55, partial: true, date: TUE, day: 'Tue' })],
  });
  const got = schedFillOpen(input).rows[0];
  assert.deepStrictEqual([got.name, got.minutes, got.partial], ['Ana', 240, true]);

  const fits = buildInput({ ...input, availability: { Ana: avail(6, ['Tue'], 6) } });
  const whole = schedFillOpen(fits).rows[0];
  assert.deepStrictEqual([whole.minutes, whole.partial], [300, false]);
});

test('schedFillOpen: a one-off for a manager still needs the manager in the pool', () => {
  const open = [row({ key: 'oneoff|O1', taskId: '', oneOffId: 'O1', date: MON })];
  const oneOffs = [oneOff({ id: 'O1', who: ['Max'] })];
  assert.strictEqual(schedFillOpen(buildInput({ oneOffs, open })).rows[0].name, 'Max');
  assert.strictEqual(schedFillOpen(buildInput({ oneOffs, open, pool: ['Ana'] })).rows[0].name, '');
});

test('schedFillOpen: an unknown task or one-off still works from the row itself', () => {
  const input = buildInput({
    availability: { Ana: avail(6, ['Mon', 'Tue'], 3) },
    open: [
      row({ key: 'O1', taskId: 'GONE', date: MON }),
      row({ key: 'O2', taskId: '', oneOffId: 'GONE', date: TUE, day: 'Tue', who: ['Ana'] }),
      row({ key: 'O3', taskId: '', oneOffId: 'GONE2', date: '', day: '', who: ['Ana'] }),
    ],
  });
  const { rows } = schedFillOpen(input);
  assert.deepStrictEqual([byKey(rows, 'O1').name, byKey(rows, 'O1').date], ['Ana', MON]);
  assert.deepStrictEqual([byKey(rows, 'O2').name, byKey(rows, 'O2').date], ['Ana', TUE]);
  assert.strictEqual(byKey(rows, 'O3').name, 'Ana');
});

test('schedFillOpen: tidies only open rows, and only into days they already work', () => {
  const lockedTue = row({ key: 'L1', taskId: 'Y1', date: TUE, day: 'Tue', minutes: 15, name: 'Ana' });
  const lockedMon = row({ key: 'L2', taskId: 'Y1', date: MON, day: 'Mon', minutes: 15, name: 'Ana' });
  const tasks = [task({ id: 'X1', flexDays: 1 })];
  const availability = { Ana: avail(6, ['Mon', 'Tue'], 3) };
  const open = [row({ key: 'O1', taskId: 'X1', minutes: 15 })];

  let result = schedFillOpen(buildInput({ tasks, availability, open, locked: [lockedTue] }));
  assert.deepStrictEqual([result.rows[0].name, result.rows[0].date, result.rows[0].day], ['Ana', TUE, 'Tue'], 'joins her locked Tuesday');
  assert.deepStrictEqual(result.rows.map((r) => r.key), ['O1'], 'the locked row itself never moves');

  result = schedFillOpen(buildInput({ tasks, availability, open, locked: [lockedMon, lockedTue] }));
  assert.strictEqual(result.rows[0].date, MON, 'she is already coming in Monday, so it stays');
});

test('schedFillOpen: tidy leaves a row on a day the person already has locked work', () => {
  // Saturday, so a move back to Friday can't quietly undo itself later in the same pass.
  const lockedFri = row({ key: 'L1', taskId: 'Y1', date: FRI, day: 'Fri', minutes: 15, name: 'Ana' });
  const lockedSat = row({ key: 'L2', taskId: 'Y1', date: SAT, day: 'Sat', minutes: 15, name: 'Ana' });
  const tasks = [task({ id: 'X1', days: ['Sat'], flexDays: 1 })];
  const availability = { Ana: avail(6, ['Fri', 'Sat'], 3) };
  const open = [row({ key: 'O1', taskId: 'X1', date: SAT, day: 'Sat', minutes: 15 })];
  assert.strictEqual(schedFillOpen(buildInput({ tasks, availability, open, locked: [lockedFri, lockedSat] })).rows[0].date, SAT, 'she is coming in Saturday anyway');
  assert.strictEqual(schedFillOpen(buildInput({ tasks, availability, open, locked: [lockedFri] })).rows[0].date, FRI, 'she is only coming in Friday');
});

/* --------------------------------------------------------- now and before today ---- */

test('no time of day: capacity today is the hours offered that day, whatever the clock says', () => {
  const availability = { Ana: avail(6, ['Mon'], 3), Cora: avail(6, ['Mon'], 8) };
  [undefined, 0, 600, 720, 1020, 1439].forEach((nowMinutes) => {
    const placed = placeOne({ days: ['Mon'] }, availability, { today: MON, nowMinutes });
    assert.deepStrictEqual([placed.name, placed.date], ['Ana', MON], `nowMinutes ${nowMinutes} changes nothing`);
  });
  const late = schedFillOpen(buildInput({ today: MON, nowMinutes: 1439, availability, open: [row({ key: 'O1', date: MON })] })).rows[0];
  assert.strictEqual(late.name, 'Ana', 'the same in schedFillOpen');
  const oneOffRow = run({ tasks: [], today: MON, nowMinutes: 1439, oneOffs: [oneOff()], availability }).rows[0];
  assert.deepStrictEqual([oneOffRow.name, oneOffRow.date], ['Ana', MON], 'and for a one-off with no day');
});

test('no time of day: what they already have that day still comes off, today or any other day', () => {
  const availability = { Ana: avail(6, ['Mon', 'Tue'], 2) };
  const locked = (date, day) => [row({ key: 'L1', taskId: 'L', minutes: 90, date, day, name: 'Ana' })];
  const open = (date, minutes) => [row({ key: 'O1', minutes, date })];
  const fill = (date, day, minutes) => schedFillOpen(buildInput({ today: MON, availability, locked: locked(date, day), open: open(date, minutes) })).rows[0].name;
  assert.strictEqual(fill(MON, 'Mon', 30), 'Ana', '30 is what is left today');
  assert.strictEqual(fill(MON, 'Mon', 31), '');
  assert.strictEqual(fill(TUE, 'Tue', 30), 'Ana', 'the same tomorrow');
  assert.strictEqual(fill(TUE, 'Tue', 31), '');
});

test('no work before today: set rows, recurring rows and windows all respect it', () => {
  const { rows } = run({ today: WED, availability: { Cora: avail(20, MON_SAT, 8) } });
  assert.deepStrictEqual(rows.filter((r) => r.date < WED), []);
  assert.ok(!rows.some((r) => r.name === 'Hal'), 'Hal only works Tuesday, which has passed');
  assert.ok(rows.some((r) => r.name === 'Ivy' && r.date === WED), 'Ivy works today');

  assert.strictEqual(byTask(rows, 'T01').length, 4, 'daily rows for Mon and Tue are gone');
  assert.strictEqual(rows.filter((r) => r.key === `task|T03|${MON}`).length, 0, 'flex 1 from Monday only reaches Tuesday, so it is gone');
  assert.strictEqual(byKey(rows, `task|T02|${TUE}`).date, WED, 'flex 1 from Tuesday reaches today');
  assert.strictEqual(byKey(rows, `task|T06|${MON}`).date, WED, 'flex 6 from Monday reaches today');
});

test('no work before today: a week that has fully passed makes no recurring or set rows', () => {
  const { rows } = run({ today: '2026-11-20', availability: { Cora: avail(20, MON_SAT, 8) } });
  assert.deepStrictEqual(rows, []);
});

test('no work before today: today itself is fine, and a week still ahead is untouched', () => {
  const placed = placeOne({ days: ['Wed'] }, { Ana: avail(5, ['Wed'], 3) }, { today: WED });
  assert.deepStrictEqual([placed.name, placed.date], ['Ana', WED]);
  const anytime = run({ today: undefined, availability: workedExampleAvailability() });
  assert.deepStrictEqual(minutesByPersonDay(anytime.rows).Ana, { Mon: 125, Wed: 85, Fri: 130 });
});

test('build results: no times come back from matching at all', () => {
  const result = run({ availability: workedExampleAvailability() });
  assert.deepStrictEqual(Object.keys(result).sort(), ['rows', 'unfilled', 'usage']);
  result.rows.forEach((r) => assert.deepStrictEqual(Object.keys(r).sort(), ROW_FIELDS.slice().sort()));
});

/* ------------------------------------------------------------ dates and DST ---- */

function realDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

test('week of 2027-03-08 (clocks go forward Sunday): the right dates, every day exactly once', () => {
  const { rows } = run({ weekOf: '2027-03-08', today: '2027-03-05', availability: { Cora: avail(20, MON_SAT, 8) } });
  assert.deepStrictEqual(byTask(rows, 'T01').map((r) => [r.date, r.day]), [
    ['2027-03-08', 'Mon'],
    ['2027-03-09', 'Tue'],
    ['2027-03-10', 'Wed'],
    ['2027-03-11', 'Thu'],
    ['2027-03-12', 'Fri'],
    ['2027-03-13', 'Sat'],
  ]);
  assert.deepStrictEqual(rows.filter((r) => r.name === 'Gus').map((r) => [r.date, r.day]), [['2027-03-11', 'Thu'], ['2027-03-12', 'Fri'], ['2027-03-14', 'Sun']]);
  rows.forEach((r) => assert.strictEqual(r.day, realDay(r.date)));
});

test('week of 2026-10-26 (clocks go back Sunday, month rolls over): the right dates, every day exactly once', () => {
  const { rows } = run({ weekOf: '2026-10-26', today: '2026-10-23', availability: { Cora: avail(20, MON_SAT, 8) } });
  assert.deepStrictEqual(byTask(rows, 'T01').map((r) => r.date), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
  assert.deepStrictEqual(rows.filter((r) => r.name === 'Jo').map((r) => [r.date, r.day]), [['2026-11-01', 'Sun']]);
  assert.deepStrictEqual(rows.filter((r) => r.name === 'Gus').map((r) => r.date), ['2026-10-29', '2026-10-30', '2026-11-01']);
  rows.forEach((r) => assert.strictEqual(r.day, realDay(r.date)));
});

test('DST weeks: time off, closed days and work land on the right dates', () => {
  const spring = run({
    weekOf: '2027-03-08',
    today: '2027-03-05',
    tasks: [task({ id: 'X1', days: ['Sun'], minutes: 90 }), task({ id: 'S1', setOnly: true, days: [], minutes: 60 })],
    staff: [{ name: 'Gus', rank: 1, type: 'Set', active: true, setDays: ['Sat', 'Sun'], setTasks: [{ taskId: 'S1', days: null }] }, ...STAFF.filter((p) => p.type === 'Flexible')],
    availability: { Ana: avail(6, ['Sun'], 3) },
    timeOff: [{ name: 'Gus', from: '2027-03-14', to: '2027-03-14' }],
  });
  assert.strictEqual(byKey(spring.rows, 'set|S1|2027-03-13|Gus').source, 'set');
  assert.strictEqual(byKey(spring.rows, 'set|S1|2027-03-14|Gus').source, 'cover');
  assert.deepStrictEqual(spring.usage.Ana.byDate, { '2027-03-14': 150 });

  const fall = run({ weekOf: '2026-10-26', today: '2026-10-23', closedDays: ['2026-11-01'], availability: {} });
  assert.deepStrictEqual(fall.rows.filter((r) => r.date === '2026-11-01'), []);
  assert.deepStrictEqual(fall.rows.filter((r) => r.name === 'Gus').map((r) => r.date), ['2026-10-29', '2026-10-30']);
});

test('a week across New Year has the right dates', () => {
  const { rows } = run({ weekOf: '2026-12-28', today: '2026-12-25', availability: {} });
  assert.deepStrictEqual(rows.filter((r) => r.name === 'Gus').map((r) => [r.date, r.day]), [['2026-12-31', 'Thu'], ['2027-01-01', 'Fri'], ['2027-01-03', 'Sun']]);
});

test('the time zone of the machine changes nothing', () => {
  const saved = process.env.TZ;
  const zones = ['America/Denver', 'Pacific/Auckland', 'Asia/Kolkata', 'Pacific/Honolulu', 'UTC'];
  try {
    const offsets = new Set();
    const results = zones.map((zone) => {
      process.env.TZ = zone;
      offsets.add(new Date(Date.UTC(2027, 2, 14, 12)).getTimezoneOffset());
      return ['2027-03-08', '2026-10-26'].map((weekOf) => JSON.stringify(run({ weekOf, today: weekOf, availability: workedExampleAvailability() })));
    });
    assert.ok(offsets.size > 1, 'the zone change needs to actually take effect for this test to mean anything');
    results.forEach((result) => assert.deepStrictEqual(result, results[0]));
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('a bad date gets a readable error, not a wrong schedule', () => {
  assert.throws(() => run({ weekOf: 'next week' }), /Not a YYYY-MM-DD date: next week/);
});

/* ------------------------------------------------------------- deterministic ---- */

function busyInput() {
  return buildInput({
    availability: workedExampleAvailability(),
    oneOffs: [
      oneOff({ id: 'A', priority: 'A', minutes: 45 }),
      oneOff({ id: 'B', day: 'Wed', minutes: 20 }),
      oneOff({ id: 'C', who: ['Cora', 'Ben'], minutes: 400 }),
      oneOff({ id: 'D', who: ['Max'], priority: 'C' }),
      oneOff({ id: 'E', priority: 'C', minutes: 15 }),
    ],
    timeOff: [{ name: 'Gus', from: FRI, to: SUN }, { name: 'Ben', from: THU, to: THU }],
    closedDays: [SAT],
  });
}

test('re-running gives identical output, with nothing in the input changed', () => {
  const input = busyInput();
  const before = JSON.stringify(input);
  const first = schedBuildWeek(input);
  assert.strictEqual(JSON.stringify(input), before);
  assert.deepStrictEqual(schedBuildWeek(input), first);
  assert.strictEqual(JSON.stringify(schedBuildWeek(busyInput())), JSON.stringify(first));
});

test('the order of the input lists does not change the output', () => {
  const shuffled = busyInput();
  ['staff', 'tasks', 'oneOffs', 'timeOff'].forEach((list) => shuffled[list].reverse());
  shuffled.availability = Object.fromEntries(Object.entries(shuffled.availability).reverse());
  const a = schedBuildWeek(busyInput());
  const b = schedBuildWeek(shuffled);
  assert.deepStrictEqual(b.rows, a.rows);
  assert.deepStrictEqual(b.unfilled, a.unfilled);
});

test('schedFillOpen is deterministic too, whatever order the open rows are in', () => {
  const full = schedBuildWeek(busyInput());
  const make = (reverse) => {
    const open = full.rows.filter((r) => !r.name || r.source === 'auto');
    const locked = full.rows.filter((r) => r.name && r.source !== 'auto');
    return schedFillOpen({ ...busyInput(), open: reverse ? open.slice().reverse() : open, locked });
  };
  assert.deepStrictEqual(make(true), make(false));
});

test('uncovered rows are the ones in unfilled, and nothing else', () => {
  const { rows, unfilled } = schedBuildWeek(busyInput());
  assert.deepStrictEqual(unfilled, rows.filter((r) => r.name === ''));
  assert.ok(unfilled.length > 0, 'this input is meant to leave some uncovered');
});

test('rows come back by date, then rank, with uncovered last in the day', () => {
  const { rows } = schedBuildWeek(busyInput());
  const rankOf = Object.fromEntries(STAFF.map((p, i) => [p.name, i]));
  rows.slice(1).forEach((r, i) => {
    const prev = rows[i];
    assert.ok(prev.date <= r.date, `${prev.key} is after ${r.key}`);
    if (prev.date !== r.date) return;
    const rank = (name) => (name ? rankOf[name] : 99);
    assert.ok(rank(prev.name) <= rank(r.name), `${prev.key} (${prev.name}) is before ${r.key} (${r.name})`);
  });
});

/* -------------------------------------------- invariants under random weeks ---- */

/** Small repeatable generator, so a failure here can always be re-run. */
function randomMaker(seed) {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return {
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

function randomWeek(seed) {
  const r = randomMaker(seed);
  const week = [MON, TUE, WED, THU, FRI, SAT, SUN];
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const flexible = ['Ana', 'Ben', 'Cora', 'Dev'];

  const availability = {};
  flexible.forEach((name) => {
    if (r.chance(0.15)) return; // never submitted
    const dayHours = {};
    days.forEach((day) => {
      if (r.chance(0.55)) dayHours[day] = r.int(1, 32) / 2;
    });
    availability[name] = { none: r.chance(0.1), hoursWanted: r.int(0, 24) / 2, dayHours };
  });

  const seedRows = SEED_TASKS_.filter(() => r.chance(0.7)).map((t) => ({ ...t }));
  const extra = [];
  for (let i = 0; i < r.int(0, 6); i++) {
    extra.push(task({
      id: `R${i}`,
      priority: r.pick(['A', 'B', 'C', '']),
      minutes: r.pick([5, 10, 15, 20, 45, 90]),
      days: days.filter(() => r.chance(0.25)),
      flexDays: r.int(0, 3),
      order: 50 + i,
    }));
  }

  const oneOffs = [];
  for (let i = 0; i < r.int(0, 6); i++) {
    const who = r.chance(0.4) ? flexible.concat(['Gus', 'Max']).filter(() => r.chance(0.4)) : [];
    oneOffs.push(oneOff({
      id: `O${i}`,
      priority: r.pick(['A', 'B', 'C']),
      minutes: r.pick([15, 30, 60, 120, 240, 600]),
      day: r.chance(0.4) ? r.pick(days) : '',
      who,
    }));
  }

  const timeOff = [];
  for (let i = 0; i < r.int(0, 3); i++) {
    const from = r.int(0, 6);
    timeOff.push({ name: r.pick(['Gus', 'Hal', 'Jo', 'Ana', 'Ben', 'Max']), from: week[from], to: week[Math.min(6, from + r.int(0, 2))] });
  }

  return buildInput({
    today: r.chance(0.5) ? '2026-11-06' : r.pick(week),
    tasks: seedRows.concat(extra),
    oneOffs,
    availability,
    timeOff,
    closedDays: r.chance(0.3) ? [r.pick(week)] : [],
  });
}

function assertWeekIsLegal(input, result, seed) {
  const label = (r) => `seed ${seed}: ${r.key} ${r.name} ${r.date}`;
  const flexible = new Set(input.staff.filter((p) => p.type === 'Flexible').map((p) => p.name));
  const usedDay = {};
  const usedWeek = {};
  const away = (name, date) => input.timeOff.some((t) => t.name === name && t.from <= date && date <= t.to);
  // An uncovered one-off has to sit somewhere, so a closed date is only excused when nothing else is left.
  const openDayLeft = [MON, TUE, WED, THU, FRI, SAT, SUN].some((date) => date >= input.today && !input.closedDays.includes(date));
  // Nobody works a Sunday unless the task lists it, it's a set day or its cover, a one-off is pinned there,
  // an earlier pin rolled forward to today, or the one-off went to a person whose set day it is.
  const sundayOk = (r) => {
    const listedTask = input.tasks.find((t) => t.id === r.taskId);
    if (listedTask) return listedTask.days.includes('Sun') || r.source === 'set' || r.source === 'cover';
    const job = input.oneOffs.find((o) => o.id === r.oneOffId);
    if (job.day === 'Sun' || (job.day && input.today === '2026-11-15')) return true;
    return input.staff.find((p) => p.name === r.name).setDays.includes('Sun');
  };

  result.rows.forEach((r) => {
    assert.deepStrictEqual(Object.keys(r).filter((k) => !ROW_FIELDS.includes(k)), [], label(r));
    assert.strictEqual(r.day, realDay(r.date), label(r));
    assert.ok(r.date >= input.weekOf && r.date <= '2026-11-15', `outside the week, ${label(r)}`);
    assert.ok(r.date >= input.today, `before today, ${label(r)}`);
    if (openDayLeft || r.name) assert.ok(!input.closedDays.includes(r.date), `on a closed day, ${label(r)}`);
    if (!r.name) return;
    if (r.day === 'Sun') assert.ok(sundayOk(r), `a Sunday the row has no claim to, ${label(r)}`);
    assert.ok(!away(r.name, r.date), `work while out of town, ${label(r)}`);
    if (!flexible.has(r.name)) return;
    usedDay[`${r.name}|${r.date}`] = (usedDay[`${r.name}|${r.date}`] || 0) + r.minutes;
    usedWeek[r.name] = (usedWeek[r.name] || 0) + r.minutes;
  });

  Object.entries(usedDay).forEach(([id, minutes]) => {
    const [name, date] = id.split('|');
    const entry = input.availability[name];
    assert.ok(entry && !entry.none, `seed ${seed}: ${name} has no availability but has work`);
    const offered = entry.dayHours[realDay(date)] || 0;
    assert.ok(minutes <= offered * 60, `seed ${seed}: ${id} has ${minutes} minutes on a day with ${offered} hours offered`);
  });

  Object.entries(usedWeek).forEach(([name, minutes]) => {
    const cap = input.availability[name].hoursWanted * 60 + 15;
    assert.ok(minutes <= cap, `seed ${seed}: ${name} has ${minutes} minutes against a cap of ${cap}`);
  });

  assert.deepStrictEqual(result.unfilled, result.rows.filter((r) => !r.name), `seed ${seed}: unfilled`);
  const keys = result.rows.map((r) => r.key);
  assert.strictEqual(new Set(keys).size, keys.length, `seed ${seed}: duplicate keys`);
}

test('500 random weeks: nobody passes their hours for the day or the week, and nothing lands where it should not', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const input = randomWeek(seed);
    const result = schedBuildWeek(input);
    assertWeekIsLegal(input, result, seed);
    assert.strictEqual(JSON.stringify(schedBuildWeek(input)), JSON.stringify(result), `seed ${seed}: not repeatable`);
  }
});

test('500 random weeks: filling the uncovered rows keeps every rule, and only changes those rows', () => {
  for (let seed = 1001; seed <= 1500; seed++) {
    const input = randomWeek(seed);
    const first = schedBuildWeek({ ...input, availability: { Ana: input.availability.Ana } });
    const locked = first.rows.filter((r) => r.name);
    const lockedBefore = JSON.stringify(locked);
    const pool = ['Ana', 'Ben', 'Cora', 'Dev', 'Gus', 'Max'].filter((_, i) => (seed >> i) & 1);
    const result = schedFillOpen({ ...input, locked, open: first.unfilled, pool });

    assert.strictEqual(JSON.stringify(locked), lockedBefore, `seed ${seed}: locked rows changed`);
    assert.deepStrictEqual(result.rows.map((r) => r.key).sort(), first.unfilled.map((r) => r.key).sort(), `seed ${seed}: wrong rows came back`);
    result.rows.forEach((r) => {
      if (r.name) assert.ok(pool.includes(r.name), `seed ${seed}: ${r.name} is not in the pool`);
    });
    assertWeekIsLegal(input, { rows: locked.concat(result.rows), unfilled: result.unfilled }, seed);
  }
});

/* --------------------------------------------------------- Apps Script ground rules ---- */

const SCHEDULER_PATH = path.join(__dirname, '..', 'apps-script', 'Scheduler.js');
const SEED_PATH = path.join(__dirname, '..', 'apps-script', 'SeedTasks.js');

test('Scheduler.js is pure: no Google services, no clock, no local time', () => {
  const code = fs.readFileSync(SCHEDULER_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  [
    /\bnew Date\(\s*\)/,
    /\bDate\.now\b/,
    /\bDate\.parse\b/,
    /\bMath\.random\b/,
    /\bgetTimezoneOffset\b/,
    /\btoLocale/,
    /\.get(FullYear|Month|Date|Day|Hours|Minutes)\(/,
    /\.set(FullYear|Month|Date|Hours|Minutes)\(/,
    /\b(SpreadsheetApp|PropertiesService|CacheService|LockService|MailApp|GmailApp|ScriptApp|Utilities|Session|ContentService|UrlFetchApp|Logger)\b/,
  ].forEach((banned) => assert.ok(!banned.test(code), `found ${banned} in Scheduler.js`));
});

test('both files load side by side in one global scope, the way Apps Script runs them', () => {
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(SEED_PATH, 'utf8'), scope);
  vm.runInContext(fs.readFileSync(SCHEDULER_PATH, 'utf8'), scope);
  ['schedPriorityScore', 'schedBuildWeek', 'schedFillOpen'].forEach((name) => assert.strictEqual(typeof scope[name], 'function', name));
  assert.strictEqual(scope.SEED_TASKS_.length, 15);

  // Same answer as under Node, with the real tasks from the global scope.
  const input = buildInput({ availability: workedExampleAvailability() });
  scope.input = JSON.parse(JSON.stringify({ ...input, tasks: undefined }));
  const inScript = vm.runInContext('input.tasks = SEED_TASKS_; JSON.stringify(schedBuildWeek(input))', scope);
  assert.strictEqual(inScript, JSON.stringify(schedBuildWeek(input)));
});

test('every top-level name in Scheduler.js is a public function or ends in an underscore', () => {
  const code = fs.readFileSync(SCHEDULER_PATH, 'utf8');
  const names = [...code.matchAll(/^(?:function|var|const|let)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  assert.ok(names.length > 20);
  const publicNames = ['schedPriorityScore', 'schedBuildWeek', 'schedFillOpen'];
  names.forEach((name) => {
    assert.ok(publicNames.includes(name) || name.endsWith('_'), `${name} should end in an underscore`);
    assert.ok(/^(sched|SCHED_)/.test(name), `${name} should start with sched so it can't clash with another file`);
  });
  assert.strictEqual(new Set(names).size, names.length, 'no name is defined twice');
});

/* -------------------------------------------- the same task twice, and any-time days ---- */

test('one task, one day: a moved row never lands on a day that task already has', () => {
  // Free only Tue and Thu: T03 and T09 from Mon, Wed and Fri all want Tue or Thu.
  const { rows } = run({ availability: { Ana: avail(20, ['Tue', 'Thu'], 8) } });
  ['T03', 'T09'].forEach((taskId) => {
    const placed = byTask(rows, taskId).filter((r) => r.name);
    assert.strictEqual(new Set(placed.map((r) => r.date)).size, placed.length, `${taskId} is on a day only once`);
    assert.ok(placed.length >= 2, `${taskId} still gets done where it can`);
  });
  byTask(rows, 'T03')
    .filter((r) => !r.name)
    .forEach((r) => assert.strictEqual(r.date, r.key.split('|')[2], 'what is left waits uncovered on its own date'));
});

test('one task, one day: cover doesn\'t land on a day the set person is doing that task', () => {
  const { rows } = run({ availability: { Ana: avail(6, ['Fri'], 3) }, timeOff: [{ name: 'Gus', from: THU, to: THU }] });
  const cover = byKey(rows, `set|T08|${THU}|Gus`);
  assert.deepStrictEqual([cover.name, cover.date], ['', THU], 'it waits on its own day for a manager');
  assert.strictEqual(byKey(rows, `set|T08|${FRI}|Gus`).name, 'Gus');
});

test('one task, one day: a row already locked on that day counts too', () => {
  const locked = [row({ key: 'task|T03|' + WED, taskId: 'T03', date: WED, day: 'Wed', minutes: 15, name: 'Ben' })];
  const open = [row({ key: 'task|T03|' + TUE, taskId: 'T03', date: TUE, day: 'Tue', minutes: 15 })];
  const tasks = [task({ id: 'T03', days: ['Tue', 'Wed'], flexDays: 1 })];
  const result = schedFillOpen(buildInput({ tasks, availability: { Ana: avail(6, ['Wed'], 3) }, open, locked }));
  assert.deepStrictEqual([result.rows[0].name, result.rows[0].date], ['', TUE]);
});

test('one task, one day: holds across lots of thin weeks', () => {
  // A small repeatable generator, so a failure here can be reproduced.
  let seed = 20261109;
  const next = (limit) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor(seed / 65536) % limit; // the low bits of this kind of generator barely change
  };
  const names = ['Ana', 'Ben', 'Cora', 'Dev'];
  for (let week = 0; week < 400; week++) {
    const availability = {};
    names.slice(0, 1 + next(4)).forEach((name) => {
      const days = MON_SAT.filter(() => next(3) === 0);
      const from = 6 + next(8);
      availability[name] = avail(1 + next(20), days.length ? days : ['Tue'], from, from + 1 + next(4));
    });
    const { rows } = run({ availability });
    const seen = new Set();
    rows.forEach((r) => {
      if (!r.taskId || !r.name) return;
      const id = `${r.taskId}|${r.date}`;
      assert.ok(!seen.has(id), `week ${week}: ${r.taskId} is on ${r.date} twice`);
      seen.add(id);
    });
  }
});

