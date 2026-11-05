'use strict';

/**
 * fixtures.js: fake people and fake availability for the tests and the local dev server.
 * Every name and email address here is made up. Real ones live only in the Google Sheet.
 */

const { SEED_TASKS_ } = require('../apps-script/SeedTasks.js');

const WEEK_OF = '2026-11-09'; // a Monday, the first live week (Settings.first_week)
const TODAY = '2026-11-06'; // the Friday before it
const NOW_MINUTES = 420; // 7:00 AM, when the weekly run happens

const MON_SAT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function person(name, rank, type, setDays, setTasks) {
  return {
    name,
    rank,
    type,
    active: true,
    email: `${name.toLowerCase()}@example.com`,
    setDays: setDays || [],
    setTasks: (setTasks || []).map((taskId) => ({ taskId, days: null })),
  };
}

/** The pattern from SPEC section 5: four set people, four flexible people, two managers. */
const STAFF = [
  person('Gus', 1, 'Set', ['Thu', 'Fri', 'Sun'], ['T08']),
  person('Hal', 2, 'Set', ['Tue'], ['T08', 'T14']),
  person('Ivy', 3, 'Set', ['Wed'], ['T15']),
  person('Jo', 4, 'Set', ['Sun'], ['T15']),
  person('Ana', 5, 'Flexible'),
  person('Ben', 6, 'Flexible'),
  person('Cora', 7, 'Flexible'),
  person('Dev', 8, 'Flexible'),
  person('Max', null, 'Manager'),
  person('Mia', null, 'Manager'),
];

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

/** [from, from+1, ... to-1]: the start hours of the one-hour blocks between two times. */
function hours(from, to) {
  const out = [];
  for (let hour = from; hour < to; hour++) out.push(hour);
  return out;
}

/** One availability entry: avail(6, ['Mon', 'Wed'], 9, 12) wants 6 hours, free 9 to 12 on those days. */
function avail(hoursWanted, days, from, to) {
  const slots = {};
  days.forEach((day) => {
    slots[day] = hours(from, to);
  });
  return { none: false, hoursWanted, slots };
}

/** The availability from the worked example in SPEC section 6. */
function workedExampleAvailability() {
  return {
    Ana: avail(6, ['Mon', 'Wed', 'Fri'], 9, 12),
    Ben: avail(4, ['Tue', 'Thu'], 10, 13),
    Cora: avail(20, MON_SAT, 8, 16),
    Dev: avail(5, ['Tue', 'Thu'], 13, 16),
  };
}

function task(overrides) {
  return {
    id: 'X1',
    title: 'Test task',
    details: '',
    cadence: '',
    priority: 'B',
    minutes: 30,
    days: ['Mon'],
    setOnly: false,
    flexDays: 0,
    active: true,
    order: 100,
    ...overrides,
  };
}

function oneOff(overrides) {
  return {
    id: 'O1',
    title: 'Test one-off',
    details: '',
    priority: 'B',
    minutes: 30,
    day: '',
    who: [],
    status: 'open',
    ...overrides,
  };
}

function row(overrides) {
  return {
    key: 'R1',
    taskId: 'X1',
    oneOffId: '',
    title: 'Test row',
    details: '',
    priority: 'B',
    minutes: 30,
    date: WEEK_OF,
    day: 'Mon',
    name: '',
    source: 'auto',
    partial: false,
    ...overrides,
  };
}

/** A complete schedBuildWeek / schedFillOpen input, with anything replaced through overrides. */
function buildInput(overrides) {
  return {
    weekOf: WEEK_OF,
    today: TODAY,
    nowMinutes: NOW_MINUTES,
    staff: copy(STAFF),
    tasks: copy(SEED_TASKS_),
    oneOffs: [],
    availability: {},
    timeOff: [],
    closedDays: [],
    locked: [],
    ...overrides,
  };
}

module.exports = {
  WEEK_OF,
  TODAY,
  NOW_MINUTES,
  MON_SAT,
  STAFF,
  hours,
  avail,
  workedExampleAvailability,
  task,
  oneOff,
  row,
  buildInput,
};
