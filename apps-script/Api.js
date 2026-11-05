/**
 * Api.js: the web app (SPEC section 8). doGet and doPost send every request to one
 * handler below and always answer {ok:true,...} or {ok:false, error:'a plain sentence'}.
 *
 * Writes run inside the script lock and leave a line in the Log tab. Staff handlers only
 * ever return what that person's own screens need: never an email address, never someone
 * else's hours. Every manager handler checks the code first, in route_.
 *
 * Words used throughout:
 * - a "row" is a line of the Schedule tab, and its ID is the Row.key from Scheduler.js.
 * - "published" means the week has been built (see isPublished_).
 */

/* ---------------------------------------------------------------- web app ---- */

function doGet(e) {
  return reply_(function () {
    return route_((e && e.parameter) || {}, false);
  });
}

function doPost(e) {
  return reply_(function () {
    return route_(parseBody_(e), true);
  });
}

function reply_(work) {
  var out;
  try {
    resetRequestCache_();
    out = Object.assign({ ok: true }, work());
  } catch (err) {
    out = errorReply_(err);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function parseBody_(e) {
  var body = (e && e.postData && e.postData.contents) || '';
  if (!body) return {};
  var parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    fail_("We couldn't read that request.");
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail_("We couldn't read that request.");
  return parsed;
}

function actionTable_() {
  return {
    names: { run: apiNames_ },
    boot: { run: apiBoot_ },
    availability: { run: apiAvailability_ },
    saveAvailability: { run: apiSaveAvailability_, write: true },
    timeOffAdd: { run: apiTimeOffAdd_, write: true },
    timeOffRemove: { run: apiTimeOffRemove_, write: true },
    taskToggle: { run: apiTaskToggle_, write: true },
    taskNote: { run: apiTaskNote_, write: true },
    taskClaim: { run: apiTaskClaim_, write: true },
    clockIn: { run: apiClockIn_, write: true },
    clockOut: { run: apiClockOut_, write: true },
    clockFix: { run: apiClockFix_, write: true },
    hoursAdd: { run: apiHoursAdd_, write: true },

    mgrCheck: { run: apiMgrCheck_, manager: true },
    mgrBoard: { run: apiMgrBoard_, manager: true },
    mgrHours: { run: apiMgrHours_, manager: true },
    mgrOneOffAdd: { run: apiMgrOneOffAdd_, manager: true, write: true },
    mgrOneOffEdit: { run: apiMgrOneOffEdit_, manager: true, write: true },
    mgrOneOffDelete: { run: apiMgrOneOffDelete_, manager: true, write: true },
    mgrAssign: { run: apiMgrAssign_, manager: true, write: true },
    mgrRebuild: { run: apiMgrRebuild_, manager: true, write: true },
    mgrRemind: { run: apiMgrRemind_, manager: true, write: true },
    mgrHoursAdd: { run: apiMgrHoursAdd_, manager: true, write: true },
    mgrHoursEdit: { run: apiMgrHoursEdit_, manager: true, write: true },
    mgrHoursDelete: { run: apiMgrHoursDelete_, manager: true, write: true },

    adminSetup: { run: adminSetup_, write: true }, // checks its own code, since the first run sets it
  };
}

function route_(req, isPost) {
  var action = text_(req.action);
  var table = actionTable_();
  if (!Object.prototype.hasOwnProperty.call(table, action)) fail_("We don't know how to do that.");
  var entry = table[action];
  if (entry.write && !isPost) fail_('That has to be sent as a POST.');
  if (entry.manager) checkManagerCode_(action, req.code);
  if (!entry.write) return entry.run(req);
  return withLock_(function () {
    return entry.run(req);
  });
}

function withLock_(work) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS_)) {
    var busy = new Error('The site is busy right now. Please try again in a moment.');
    busy.userFacing = true;
    busy.retry = true;
    throw busy;
  }
  try {
    resetRequestCache_(); // anything read while waiting for the lock could be out of date
    var result = work();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** The code, with the wrong-try limit: 8 wrong in 15 minutes locks that action for everyone for 15 minutes. */
function checkManagerCode_(action, code) {
  var cache = CacheService.getScriptCache();
  var lockKey = 'mgr_lock_' + action;
  var triesKey = 'mgr_tries_' + action;
  var lockedMessage = 'Too many wrong tries. Please wait 15 minutes and try again.';
  if (cache.get(lockKey)) fail_(lockedMessage);

  var real = PropertiesService.getScriptProperties().getProperty(PROP_MANAGER_CODE_);
  if (!real) fail_("The manager code hasn't been set up yet.");
  if (text_(code).slice(0, MAX_CODE_) === real) return;

  var now = Now_().getTime();
  var saved = JSON.parse(cache.get(triesKey) || 'null');
  var tries = saved && saved.until > now ? saved : { count: 0, until: now + MANAGER_LOCK_SECONDS_ * 1000 };
  tries.count += 1;
  if (tries.count >= MANAGER_MAX_TRIES_) {
    cache.put(lockKey, '1', MANAGER_LOCK_SECONDS_);
    cache.remove(triesKey);
    fail_(lockedMessage);
  }
  cache.put(triesKey, JSON.stringify(tries), Math.max(1, Math.ceil((tries.until - now) / 1000)));
  fail_("That manager code isn't right.");
}

/* ------------------------------------------------------------- input checks ---- */

/** The name must be an active person in the Staff tab. Returns that person. */
function requireStaff_(value) {
  var name = cleanText_(value, MAX_NAME_);
  if (!name) fail_('Please pick your name first.');
  var person = personNamed_(name);
  if (!person || !person.active) fail_("We can't find that name on the staff list. Please pick your name again.");
  return person;
}

function requireRow_(id) {
  var wanted = text_(id);
  var row = scheduleRows_().filter(function (candidate) {
    return candidate.id === wanted;
  })[0];
  if (!row) fail_("We can't find that task. Please refresh and try again.");
  return row;
}

/** A row belongs to whoever has it. Sign-in is by name alone, so a manager's name carries no extra power here. */
function requireOwnRow_(person, row) {
  if (row.name !== person.name) fail_("That task isn't on your list. Please refresh and try again.");
}

function requireDate_(value, label) {
  var date = text_(value);
  if (!isDateString_(date)) fail_('Please pick a ' + label + '.');
  return date;
}

function requireMonday_(value) {
  var date = text_(value);
  if (!isDateString_(date)) fail_('Please pick a week.');
  if (dayKey_(date) !== 'Mon') fail_('A week has to start on a Monday.');
  return date;
}

/** Settings.first_week: the first Monday the site schedules. */
function firstWeek_() {
  return dateString_(settings_().first_week);
}

/** Nothing ever runs for a week before first_week, so anything put in one would wait forever. */
function requireFromFirstWeek_(weekOf) {
  var first = firstWeek_();
  if (first && weekOf < first) fail_('The site starts the week of ' + monthDay_(first) + '. Please pick that week or a later one.');
}

function requireTime_(value, label) {
  var match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text_(value));
  if (!match) fail_('Please pick a ' + label + ' time.');
  return pad2_(Number(match[1])) + ':' + match[2];
}

function requireMonth_(value) {
  var month = text_(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail_('Please pick a month.');
  return month;
}

function requireHoursWanted_(value) {
  if (value === '' || value === null || value === undefined) fail_('Please tell us how many hours you want this week.');
  var hours = Number(value);
  if (!isFinite(hours) || hours < 0 || hours > HOURS_WANTED_MAX_) fail_('Hours wanted has to be between 0 and ' + HOURS_WANTED_MAX_ + '.');
  return Math.round(hours * 100) / 100;
}

/** Known days and whole hours from 5 through 21 only. Anything else is an error, not a guess. */
function cleanSlots_(raw) {
  var slots = {};
  if (raw === null || raw === undefined || raw === '') return slots;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail_("We couldn't read those hours. Please try again.");
  Object.keys(raw).forEach(function (day) {
    if (DAY_KEYS_.indexOf(day) < 0) fail_("We couldn't read those days. Please try again.");
    if (!Array.isArray(raw[day])) fail_("We couldn't read those hours. Please try again.");
    var seen = Object.create(null);
    var hours = [];
    raw[day].forEach(function (value) {
      var hour = Number(value);
      if (hour !== Math.floor(hour) || hour < SLOT_FIRST_HOUR_ || hour > SLOT_LAST_HOUR_) fail_('Hours have to be between 5 AM and 9 PM.');
      if (!seen[hour]) hours.push(hour);
      seen[hour] = true;
    });
    if (hours.length) {
      slots[day] = hours.sort(function (a, b) {
        return a - b;
      });
    }
  });
  return slots;
}

/* ------------------------------------------------------------------ views ---- */

/** Task in SPEC section 8. A one-off too big for one person's day also says partial:true. */
function taskView_(row) {
  var view = {
    id: row.id,
    title: row.title,
    details: row.details,
    minutes: row.minutes,
    priority: row.priority,
    top: row.priority.charAt(0).toUpperCase() === 'A',
    done: row.status === 'done',
    doneAt: row.status === 'done' ? timeLabel_(row.doneAt) : '',
    note: row.note,
    date: row.date,
    kind: row.oneOffId ? 'oneoff' : /^set\|/.test(row.id) ? 'set' : 'recurring',
    rolled: !!row.rolledFrom,
  };
  var item = row.oneOffId ? oneOffNamed_(row.oneOffId) : null;
  if (item && row.minutes < item.minutes) view.partial = true;
  return view;
}

/** Task+doneBy, plus the state a manager needs to read a row. */
function managerTaskView_(row) {
  return Object.assign(taskView_(row), { doneBy: row.doneBy, status: row.status, source: row.source });
}

/** Top priority first, then the rest in task order, so check marks never make a row jump. */
function sortRows_(rows) {
  var tasks = taskIndex_();
  var orderOf = function (row) {
    return tasks[row.taskId] ? tasks[row.taskId].order : Infinity;
  };
  return rows.slice().sort(function (a, b) {
    var byOrder = orderOf(a) === orderOf(b) ? 0 : orderOf(a) - orderOf(b);
    return schedPriorityScore(b.priority) - schedPriorityScore(a.priority) || byOrder || compareText_(a.title, b.title);
  });
}

function shiftFor_(name, date) {
  var shift = shiftRows_().filter(function (candidate) {
    return candidate.name === name && candidate.date === date;
  })[0];
  return shift ? { start: clockLabel_(shift.start), end: clockLabel_(shift.end), minutes: shift.minutes } : null;
}

/** HoursEntry in SPEC section 8. */
function entryView_(entry) {
  return {
    id: entry.id,
    date: entry.date,
    dayLabel: dayLabel_(entry.date),
    in: timeLabel_(entry.inAt),
    out: timeLabel_(entry.outAt),
    hours: entryHours_(entry),
    flag: entry.flag,
    note: entry.note,
  };
}

function newestFirst_(a, b) {
  return b.inAt.getTime() - a.inAt.getTime();
}

function hoursOf_(name) {
  return hoursRows_().filter(function (entry) {
    return entry.name === name;
  });
}

/**
 * Still on the clock at this moment: no Out, and clocked in that same day or under
 * OPEN_SHIFT_MAX_HOURS_ ago, so a shift can run past midnight. Anything older is a forgotten clock-out.
 */
function entryRunning_(entry, at) {
  if (entry.outAt) return false;
  if (entry.date === denver_(at, 'yyyy-MM-dd')) return true;
  var age = at.getTime() - entry.inAt.getTime();
  return age >= 0 && age < OPEN_SHIFT_MAX_HOURS_ * 3600000;
}

function currentEntry_(name, at) {
  return (
    hoursOf_(name)
      .filter(function (entry) {
        return entryRunning_(entry, at);
      })
      .sort(newestFirst_)[0] || null
  );
}

/** The current entry is the one on the clock. An older one with no Out is stale, and the page asks about it first. */
function clockView_(name, info) {
  var current = currentEntry_(name, info.now);
  return {
    status: current ? 'in' : 'out',
    entry: current ? entryView_(current) : null,
    stale: hoursOf_(name)
      .filter(function (entry) {
        return !entry.outAt && entry.date < info.date && !(current && entry.id === current.id);
      })
      .sort(newestFirst_)
      .map(entryView_),
  };
}

function weekView_(person, weekOf) {
  var rows = scheduleForWeek_(weekOf).filter(function (row) {
    return row.name === person.name;
  });
  return {
    weekOf: weekOf,
    label: weekLabel_(weekOf),
    published: isPublished_(weekOf),
    days: weekDates_(weekOf).map(function (date) {
      return {
        date: date,
        label: dayLabel_(date),
        shift: shiftFor_(person.name, date),
        tasks: sortRows_(
          rows.filter(function (row) {
            return row.date === date;
          })
        ).map(taskView_),
        off: isAway_(person.name, date),
        closed: closedNote_(date),
      };
    }),
  };
}

function todayView_(person, info) {
  var rows = scheduleRows_();
  var mine = function (row) {
    return row.name === person.name;
  };
  var today = rows.filter(function (row) {
    return row.date === info.date;
  });
  var later = rows.filter(function (row) {
    return mine(row) && row.date > info.date && row.status !== 'missed';
  });
  var next = null;
  if (later.length) {
    var date = later
      .map(function (row) {
        return row.date;
      })
      .sort()[0];
    var shift = shiftFor_(person.name, date);
    next = {
      date: date,
      label: dayLabel_(date),
      start: shift ? shift.start : '',
      count: later.filter(function (row) {
        return row.date === date;
      }).length,
    };
  }
  return {
    date: info.date,
    closed: closedNote_(info.date),
    shift: shiftFor_(person.name, info.date),
    tasks: sortRows_(today.filter(mine)).map(taskView_),
    openTasks: sortRows_(
      today.filter(function (row) {
        return !row.name && row.status === 'open' && mayTake_(person, row);
      })
    ).map(taskView_),
    next: next,
  };
}

function availabilityStatus_(row) {
  if (!row) return 'missing';
  return row.none ? 'none' : 'submitted';
}

function availabilityWeeks_(person, info) {
  var first = nextMonday_(info.date);
  var line = function (weekOf) {
    var row = availabilityRow_(person.name, weekOf);
    return {
      weekOf: weekOf,
      label: weekLabel_(weekOf),
      deadline: deadlineLabel_(weekOf),
      past: pastDeadline_(weekOf, info),
      status: availabilityStatus_(row),
      late: row ? row.late : false,
      hoursWanted: row ? row.hoursWanted : null,
    };
  };
  var weeks = [];
  // Someone who never answered can still pick up what's left of the week already under way.
  if (person.type === 'Flexible' && isPublished_(info.monday) && !availabilityRow_(person.name, info.monday)) weeks.push(line(info.monday));
  for (var i = 0; i < WEEKS_AHEAD_; i++) weeks.push(line(addDays_(first, i * 7)));
  return weeks;
}

function timeOffView_(person, info) {
  return timeOffRows_()
    .filter(function (off) {
      return off.name === person.name && off.status !== 'cancelled' && off.to >= info.date;
    })
    .sort(function (a, b) {
      return compareText_(a.from, b.from);
    })
    .map(function (off) {
      return { id: off.id, from: off.from, to: off.to, label: rangeLabel_(off.from, off.to), note: off.note };
    });
}

function hoursView_(person, info) {
  var lastMonth = prevMonth_(info.month);
  var inMonth = function (month) {
    return function (entry) {
      return monthOf_(entry.date) === month;
    };
  };
  var mine = hoursOf_(person.name);
  var thisOnes = mine.filter(inMonth(info.month));
  var lastOnes = mine.filter(inMonth(lastMonth));
  return {
    monthLabel: monthName_(info.month),
    monthTotal: totalHours_(thisOnes),
    lastMonthLabel: monthName_(lastMonth),
    lastMonthTotal: totalHours_(lastOnes),
    entries: thisOnes.concat(lastOnes).sort(newestFirst_).map(entryView_),
  };
}

/* ------------------------------------------------------------ staff: reading ---- */

function apiNames_() {
  return {
    people: activeStaff_().map(function (person) {
      return { name: person.name, type: person.type };
    }),
  };
}

function apiBoot_(req) {
  var person = requireStaff_(req.name);
  var info = nowInfo_();
  var offset = denver_(info.now, 'Z');
  return {
    now: {
      iso: denver_(info.now, "yyyy-MM-dd'T'HH:mm:ss") + offset.slice(0, 3) + ':' + offset.slice(3),
      date: info.date,
      day: info.day,
      label: longDayLabel_(info.date),
      hour: info.hour,
      minute: info.minute,
    },
    me: { name: person.name, type: person.type, setDays: person.setDays, manager: person.type === 'Manager' },
    today: todayView_(person, info),
    clock: clockView_(person.name, info),
    week: bootWeeks_(person, info),
    availability: { weeks: availabilityWeeks_(person, info) },
    timeOff: timeOffView_(person, info),
    hours: hoursView_(person, info),
  };
}

/** This week and next. Until the site's first week has come, firstWeek says when that is, so the page can start there. */
function bootWeeks_(person, info) {
  var weeks = { thisWeek: weekView_(person, info.monday), nextWeek: weekView_(person, addDays_(info.monday, 7)) };
  var first = firstWeek_();
  if (first && first > info.monday) weeks.firstWeek = first;
  return weeks;
}

function apiAvailability_(req) {
  var person = requireStaff_(req.name);
  var info = nowInfo_();
  var weekOf = requireMonday_(req.weekOf);
  var row = availabilityRow_(person.name, weekOf);
  var hours = [];
  for (var hour = SLOT_FIRST_HOUR_; hour <= SLOT_LAST_HOUR_; hour++) hours.push(hour);
  return {
    weekOf: weekOf,
    days: weekDates_(weekOf).map(function (date) {
      return {
        key: dayKey_(date),
        date: date,
        label: String(dateParts_(date)[2]),
        off: isAway_(person.name, date),
        closed: closedNote_(date),
      };
    }),
    hours: hours,
    slots: row ? row.slots : {},
    hoursWanted: row ? row.hoursWanted : null,
    none: row ? row.none : false,
    notes: row ? row.notes : '',
    submittedAt: row ? stampLabel_(row.submittedAt) : '',
    late: row ? row.late : false,
    deadline: deadlineLabel_(weekOf),
    past: pastDeadline_(weekOf, info),
    last: lastSubmission_(person.name, weekOf),
  };
}

/** The most recent earlier week with hours in it, for Copy Last Week. A "can't work" week has nothing to copy. */
function lastSubmission_(name, weekOf) {
  var earlier = availabilityRows_()
    .filter(function (row) {
      return row.name === name && row.weekOf < weekOf && !row.none;
    })
    .sort(function (a, b) {
      return compareText_(b.weekOf, a.weekOf);
    })[0];
  return earlier ? { weekOf: earlier.weekOf, slots: earlier.slots, hoursWanted: earlier.hoursWanted } : null;
}

/* ------------------------------------------------- matching against the sheet ---- */

/** A week counts as published once it has been built. */
function isPublished_(weekOf) {
  return !!PropertiesService.getScriptProperties().getProperty(PROP_BUILT_PREFIX_ + weekOf);
}

function builtAt_(weekOf) {
  return toDate_(PropertiesService.getScriptProperties().getProperty(PROP_BUILT_PREFIX_ + weekOf));
}

function markBuilt_(weekOf) {
  PropertiesService.getScriptProperties().setProperty(PROP_BUILT_PREFIX_ + weekOf, Now_().toISOString());
}

/**
 * A Schedule row in the shape Scheduler.js works with. A missed row keeps its place through its
 * key, but carries no name: nobody spent that time, so it mustn't use up anyone's hours.
 */
function rowForScheduler_(row) {
  return {
    key: row.id,
    taskId: row.taskId,
    oneOffId: row.oneOffId,
    title: row.title,
    details: row.details,
    priority: row.priority,
    minutes: row.minutes,
    date: row.date,
    day: row.day,
    name: row.status === 'missed' ? '' : row.name,
    source: row.source,
    partial: false,
  };
}

/** A row that schedFillOpen may place. `_row` and `rolledFrom` ride along, since it keeps extra fields. */
function openRow_(row, changes) {
  return Object.assign(rowForScheduler_(row), { name: '', _row: row._row, rolledFrom: row.rolledFrom }, changes || {});
}

/** The one place a Scheduler Row becomes cells. Week Of follows the date. */
function rowToCells_(row) {
  return {
    ID: row.key,
    'Week Of': mondayOf_(row.date),
    Date: row.date,
    Day: row.day,
    Name: row.name,
    'Task ID': row.taskId,
    'One-Off ID': row.oneOffId,
    Task: row.title,
    Details: row.details,
    Priority: row.priority,
    Minutes: row.minutes,
    Source: row.source,
    Status: 'open',
    'Done At': '',
    'Done By': '',
    Note: '',
    'Rolled From': row.rolledFrom || '',
  };
}

/** Writes back rows that came through schedFillOpen and still have their `_row`. */
function saveFilledRows_(rows) {
  rows.forEach(function (row) {
    var fields = { Name: row.name, Date: row.date, Day: row.day, 'Week Of': mondayOf_(row.date), Minutes: row.minutes, Source: row.source };
    if (row.rolledFrom) fields['Rolled From'] = row.rolledFrom;
    updateRow_(TABS_.SCHEDULE, row._row, fields);
  });
}

/** The scheduler's input for one week, from the sheet. Locked rows and open rows are added by the caller. */
function matchInput_(weekOf) {
  var info = nowInfo_();
  return {
    weekOf: weekOf,
    today: info.date,
    nowMinutes: info.minutes,
    staff: staff_().map(function (person) {
      return { name: person.name, rank: person.rank, type: person.type, active: person.active, setDays: person.setDays, setTasks: person.setTasks };
    }),
    tasks: tasks_(),
    oneOffs: oneOffs_()
      .filter(function (item) {
        return item.status === 'open' && item.weekOf === weekOf;
      })
      .map(function (item) {
        return { id: item.id, title: item.title, details: item.details, priority: item.priority, minutes: item.minutes, day: item.day, who: item.who, status: item.status };
      }),
    availability: availabilityMap_(weekOf),
    timeOff: timeOffRows_()
      .filter(function (off) {
        return off.status !== 'cancelled';
      })
      .map(function (off) {
        return { name: off.name, from: off.from, to: off.to };
      }),
    closedDays: Object.keys(closedDays_()),
    locked: [],
  };
}

/**
 * Matches a week around the rows being kept and returns the new rows. Anyone who
 * submitted late sits out the main pass, then takes what's left: "Anyone who submits late
 * only gets the tasks left over."
 *
 * The scheduler only sees rows inside the week. A row a manager moved into another week
 * keeps its key, so anything it hands back under a key that's already in use is dropped,
 * and an ID can never be in the sheet twice.
 */
function matchWeek_(weekOf, keepRows) {
  var input = matchInput_(weekOf);
  input.locked = keepRows.map(rowForScheduler_);

  var end = addDays_(weekOf, 6);
  var usedElsewhere = Object.create(null);
  scheduleRows_().forEach(function (row) {
    if (row.date < weekOf || row.date > end) usedElsewhere[row.id] = true;
  });
  var notUsedElsewhere = function (row) {
    return !usedElsewhere[row.key];
  };

  var late = availabilityRows_()
    .filter(function (row) {
      return row.weekOf === weekOf && row.late && !row.none && input.availability[row.name];
    })
    .map(function (row) {
      return row.name;
    });
  var onTime = {};
  Object.keys(input.availability).forEach(function (name) {
    if (late.indexOf(name) < 0) onTime[name] = input.availability[name];
  });

  var first = schedBuildWeek(Object.assign({}, input, { availability: onTime }));
  var rows = first.rows.filter(notUsedElsewhere);
  var unfilled = first.unfilled.filter(notUsedElsewhere);
  if (!late.length || !unfilled.length) return rows;

  var assigned = rows.filter(function (row) {
    return row.name;
  });
  var second = schedFillOpen(Object.assign({}, input, { locked: input.locked.concat(assigned), open: unfilled, pool: late }));
  second.rows.forEach(function (row) {
    if (row.name) row.source = 'late';
  });
  return assigned.concat(second.rows);
}

/** Builds a week that isn't published yet. Safe to repeat after a crash: what's already written is locked, so it isn't made twice. */
function runWeekBuild_(weekOf) {
  if (isPublished_(weekOf)) return;
  var rows = matchWeek_(weekOf, scheduleForWeek_(weekOf));
  appendRows_(TABS_.SCHEDULE, rows.map(rowToCells_));
  rewriteShifts_(weekOf);
  markBuilt_(weekOf);
  log_('system', 'schedule built', 'Week of ' + weekOf + ': ' + rows.length + ' rows');
}

/** Replaces a week's lines in the Shifts tab from what's in the Schedule tab right now. */
function rewriteShifts_(weekOf) {
  var rows = scheduleForWeek_(weekOf)
    .filter(function (row) {
      return row.name;
    })
    .map(function (row) {
      return { name: row.name, date: row.date, minutes: row.minutes };
    });
  var shifts = schedShifts(rows, availabilityMap_(weekOf), weekOf);
  deleteRows_(
    TABS_.SHIFTS,
    shiftRows_()
      .filter(function (shift) {
        return shift.weekOf === weekOf;
      })
      .map(function (shift) {
        return shift._row;
      })
  );
  appendRows_(
    TABS_.SHIFTS,
    shifts.map(function (shift) {
      return { 'Week Of': weekOf, Date: shift.date, Name: shift.name, Start: shift.start, End: shift.end, Minutes: shift.minutes };
    })
  );
}

function rewriteShiftsFor_(dates) {
  var weeks = Object.create(null);
  dates.forEach(function (date) {
    if (date) weeks[mondayOf_(date)] = true;
  });
  Object.keys(weeks).forEach(rewriteShifts_);
}

/* --------------------------------------------------------- staff: availability ---- */

function apiSaveAvailability_(req) {
  var person = requireStaff_(req.name);
  if (person.type !== 'Flexible') fail_("You're on the schedule automatically, so there's nothing to fill out.");
  var info = nowInfo_();
  var weekOf = requireMonday_(req.weekOf);
  if (weekOf < info.monday) fail_('That week has already passed.');
  if (daysBetween_(info.monday, weekOf) > WEEKS_MAX_AHEAD_ * 7) fail_('That week is too far ahead.');

  var none = isTrue_(req.none);
  var slots = none ? {} : cleanSlots_(req.slots);
  var hoursWanted = none ? 0 : requireHoursWanted_(req.hoursWanted);
  if (!none && !(hoursWanted > 0)) fail_('Please tell us how many hours you want this week.');
  if (!none && !Object.keys(slots).length) fail_("Please pick at least one hour, or tap Can't work this week.");

  var past = pastDeadline_(weekOf, info);
  var existing = availabilityRow_(person.name, weekOf);
  // An answer that came in on time stays on time after the deadline, unless it now offers more.
  var late = past && (!existing || existing.late || offersMore_(existing, slots, hoursWanted));
  var changed = !existing || existing.none !== none || existing.hoursWanted !== hoursWanted || slotsToText_(existing.slots) !== slotsToText_(slots);
  var cells = {
    'Week Of': weekOf,
    Name: person.name,
    'Submitted At': info.now,
    Late: late,
    None: none,
    'Hours Wanted': hoursWanted,
    Slots: slotsToText_(slots),
    Readable: none ? "Can't work this week" : slotsReadable_(slots),
    Notes: cleanText_(req.notes, MAX_TEXT_),
  };
  if (existing) updateRow_(TABS_.AVAILABILITY, existing._row, cells);
  else appendRows_(TABS_.AVAILABILITY, [cells]);
  log_(person.name, late ? 'availability (late)' : 'availability', weekOf + ': ' + cells.Readable + ', ' + hoursWanted + ' hours');

  var picked = [];
  if (past && isPublished_(weekOf)) {
    var outcome = lateFill_(person, weekOf, info);
    picked = outcome.picked;
    var overage = changed ? availabilityOverage_(person, weekOf, info) : [];
    // A first late answer always gets a line. After that, only when something actually happened.
    var newlyLate = late && !(existing && existing.late);
    if (newlyLate || picked.length || outcome.dropped.length || overage.length) {
      bestEffort_('late availability alert', function () {
        return alertAllowed_(person.name) && mailManagerLate_(person, weekOf, picked, outcome.dropped, late, overage);
      });
    }
  }
  return { late: late, picked: picked };
}

/** Does this save offer an hour the last one didn't, or ask for more hours? */
function offersMore_(existing, slots, hoursWanted) {
  if (hoursWanted > existing.hoursWanted) return true;
  return Object.keys(slots).some(function (day) {
    return slots[day].some(function (hour) {
      return (existing.slots[day] || []).indexOf(hour) < 0;
    });
  });
}

/** What this person has that no longer fits what they just offered. Nothing moves for this, the managers just get told. */
function availabilityOverage_(person, weekOf, info) {
  var entry = availabilityMap_(weekOf)[person.name];
  if (!entry || entry.none) return [];
  var rows = scheduleForWeek_(weekOf).filter(function (row) {
    return row.name === person.name && row.status !== 'missed';
  });
  var total = function (list) {
    return list.reduce(function (sum, row) {
      return sum + row.minutes;
    }, 0);
  };
  var lines = [];
  if (total(rows) > entry.hoursWanted * 60 + SCHED_HOURS_TOLERANCE_) lines.push('Has ' + hoursText_(total(rows)) + ' hours this week and now wants ' + entry.hoursWanted + '.');
  weekDates_(weekOf).forEach(function (date) {
    var block = schedLargestBlock_(entry.slots, dayKey_(date), null);
    var dayMinutes = total(
      rows.filter(function (row) {
        return row.date === date;
      })
    );
    if (date >= info.date && block && dayMinutes > (block.end - block.start) * 60) lines.push(dayLabel_(date) + ': has ' + hoursText_(dayMinutes) + ' hours of work and is free for ' + (block.end - block.start) + '.');
  });
  return lines;
}

/**
 * A late save in a published week: their future rows on days they took away are released,
 * then they alone can pick up those rows and anything else uncovered. Nobody else's work moves.
 */
function lateFill_(person, weekOf, info) {
  var rows = scheduleForWeek_(weekOf);
  var slots = availabilityMap_(weekOf)[person.name].slots;
  var released = rows.filter(function (row) {
    var dayGone = !(slots[row.day] && slots[row.day].length);
    return row.name === person.name && row.status === 'open' && row.source !== 'manual' && row.date >= info.date && dayGone;
  });
  var uncovered = rows.filter(function (row) {
    return !row.name && row.status === 'open' && row.date >= info.date;
  });
  var open = released.concat(uncovered);
  if (!open.length) {
    rewriteShifts_(weekOf); // their hours may have moved within a day they kept
    return { picked: [], dropped: [] };
  }

  var openIds = Object.create(null);
  open.forEach(function (row) {
    openIds[row.id] = true;
  });
  var input = matchInput_(weekOf);
  input.pool = [person.name];
  input.open = open.map(function (row) {
    return openRow_(row);
  });
  input.locked = rows
    .filter(function (row) {
      return row.name && !openIds[row.id];
    })
    .map(rowForScheduler_);

  var result = schedFillOpen(input);
  result.rows.forEach(function (row) {
    if (row.name) row.source = 'late';
  });
  saveFilledRows_(result.rows);
  rewriteShifts_(weekOf);

  var title = function (row) {
    return row.title;
  };
  return {
    picked: result.rows
      .filter(function (row) {
        return row.name === person.name;
      })
      .map(title),
    dropped: result.rows
      .filter(function (row) {
        return !row.name && released.some(function (gone) {
          return gone.id === row.key;
        });
      })
      .map(title),
  };
}

/* ------------------------------------------------------------ staff: time off ---- */

function apiTimeOffAdd_(req) {
  var person = requireStaff_(req.name);
  var info = nowInfo_();
  var from = requireDate_(req.from, 'first date');
  var to = text_(req.to) ? requireDate_(req.to, 'last date') : from;
  if (to < from) fail_('The last date has to be on or after the first date.');
  if (to < info.date) fail_('Those dates have already passed.');
  if (daysBetween_(from, to) > 366) fail_('That is more than a year. Please check the dates.');
  var note = cleanText_(req.note, MAX_TEXT_);

  var id = newId_('TO-');
  appendRows_(TABS_.TIME_OFF, [{ ID: id, Name: person.name, From: from, To: to, Note: note, 'Added At': info.now, Status: 'active' }]);
  log_(person.name, 'out of town', rangeLabel_(from, to) + (note ? ': ' + note : ''));

  var affected = [];
  var firstDay = from > info.date ? from : info.date;
  for (var week = mondayOf_(firstDay); week <= to; week = addDays_(week, 7)) {
    if (isPublished_(week)) affected = affected.concat(coverWeek_(person, week, firstDay, to));
  }
  if (affected.length) {
    bestEffort_('out of town alert', function () {
      return alertAllowed_(person.name) && mailManagerOutOfTown_(person, from, to, affected);
    });
  }
  return { id: id, affected: affected };
}

/** Releases this person's not-done rows in the range and covers them with whoever fits. */
function coverWeek_(person, weekOf, from, to) {
  var rows = scheduleForWeek_(weekOf);
  var released = rows.filter(function (row) {
    return row.name === person.name && row.status === 'open' && row.date >= from && row.date <= to;
  });
  if (!released.length) return [];
  var ids = Object.create(null);
  released.forEach(function (row) {
    ids[row.id] = true;
  });
  var input = matchInput_(weekOf);
  input.open = released.map(function (row) {
    return openRow_(row, { source: 'cover' });
  });
  input.locked = rows
    .filter(function (row) {
      return row.name && !ids[row.id];
    })
    .map(rowForScheduler_);
  var result = schedFillOpen(input);
  saveFilledRows_(result.rows);
  rewriteShifts_(weekOf);
  return result.rows.map(function (row) {
    return { date: row.date, title: row.title, coveredBy: row.name };
  });
}

function apiTimeOffRemove_(req) {
  var person = requireStaff_(req.name);
  var id = text_(req.id);
  var entry = timeOffRows_().filter(function (off) {
    return off.id === id && off.name === person.name;
  })[0];
  if (!entry) fail_("We can't find those dates. Please refresh and try again.");
  if (entry.status === 'cancelled') return { restored: [] };
  updateRow_(TABS_.TIME_OFF, entry._row, { Status: 'cancelled' });
  log_(person.name, 'out of town removed', rangeLabel_(entry.from, entry.to));
  if (person.type === 'Set') return { restored: restoreSetRows_(person, entry) };
  var restored = person.type === 'Flexible' ? refillAfterTimeOff_(person, entry) : [];
  if (restored.length) {
    bestEffort_('back in town alert', function () {
      return alertAllowed_(person.name) && mailManagerBackInTown_(person, entry, restored);
    });
  }
  return { restored: restored };
}

/** A Flexible person back from out of town gets first go at what's still uncovered on those days. Nobody else's work moves. */
function refillAfterTimeOff_(person, entry) {
  var info = nowInfo_();
  var first = entry.from > info.date ? entry.from : info.date;
  var restored = [];
  for (var week = mondayOf_(first); week <= entry.to; week = addDays_(week, 7)) {
    if (!isPublished_(week) || !availabilityMap_(week)[person.name]) continue;
    var rows = scheduleForWeek_(week);
    var open = rows.filter(function (row) {
      return !row.name && row.status === 'open' && row.date >= first && row.date <= entry.to;
    });
    if (!open.length) continue;
    var input = matchInput_(week);
    input.pool = [person.name];
    input.open = open.map(function (row) {
      return openRow_(row, /^set\|/.test(row.id) ? {} : { source: 'auto' }); // their own work again, not cover
    });
    input.locked = rows
      .filter(function (row) {
        return row.name;
      })
      .map(rowForScheduler_);
    var mine = schedFillOpen(input).rows.filter(function (row) {
      return row.name === person.name;
    });
    saveFilledRows_(mine);
    rewriteShifts_(week);
    restored = restored.concat(
      mine.map(function (row) {
        return { date: row.date, title: row.title };
      })
    );
  }
  return restored;
}

/** Set rows in the cancelled range go back to the set person, on the date in their key, unless they're done or another trip still covers that date. */
function restoreSetRows_(person, entry) {
  var info = nowInfo_();
  var restored = [];
  var dates = [];
  scheduleRows_().forEach(function (row) {
    var key = row.id.split('|');
    if (key[0] !== 'set' || key[3] !== person.name || row.status !== 'open') return;
    var date = key[2];
    if (date < entry.from || date > entry.to || date < info.date || isAway_(person.name, date)) return;
    updateRow_(TABS_.SCHEDULE, row._row, { Name: person.name, Date: date, Day: dayKey_(date), 'Week Of': mondayOf_(date), Source: 'set' });
    dates.push(date, row.date);
    restored.push({ date: date, title: row.title });
  });
  rewriteShiftsFor_(dates);
  return restored;
}

/* --------------------------------------------------------------- staff: tasks ---- */

function apiTaskToggle_(req) {
  var person = requireStaff_(req.name);
  var row = requireRow_(req.id);
  requireOwnRow_(person, row);
  var done = isTrue_(req.done);
  if (done === (row.status === 'done')) return { doneAt: done ? timeLabel_(row.doneAt) : '' }; // a repeat tap or a retry changes nothing
  var now = Now_();
  updateRow_(TABS_.SCHEDULE, row._row, done ? { Status: 'done', 'Done At': now, 'Done By': person.name } : { Status: 'open', 'Done At': '', 'Done By': '' });
  if (row.oneOffId) {
    var item = oneOffNamed_(row.oneOffId);
    if (item && item.status !== 'deleted') updateRow_(TABS_.ONE_OFFS, item._row, done ? { Status: 'done', 'Done By': person.name, 'Done At': now } : { Status: 'open', 'Done By': '', 'Done At': '' });
  }
  log_(person.name, done ? 'task done' : 'task undone', row.title + ' (' + row.date + ')');
  return { doneAt: done ? timeLabel_(now) : '' };
}

function apiTaskNote_(req) {
  var person = requireStaff_(req.name);
  var row = requireRow_(req.id);
  requireOwnRow_(person, row);
  var note = cleanText_(req.note, MAX_TEXT_);
  updateRow_(TABS_.SCHEDULE, row._row, { Note: note });
  log_(person.name, 'task note', row.title + ': ' + note);
  return {};
}

/** A one-off limited to certain people stays theirs, even while it's uncovered. */
function mayTake_(person, row) {
  var item = row.oneOffId ? oneOffNamed_(row.oneOffId) : null;
  return !item || !item.who.length || item.who.indexOf(person.name) >= 0;
}

function apiTaskClaim_(req) {
  var person = requireStaff_(req.name);
  var row = requireRow_(req.id);
  if (row.name === person.name) return { task: taskView_(row) };
  if (row.name) fail_('Someone else already took that one.');
  if (!mayTake_(person, row)) fail_('That one is set aside for someone else.');
  if (row.date !== nowInfo_().date) fail_('You can only take a task on the day it is due.');
  if (row.status !== 'open') fail_('That task is already finished.');
  updateRow_(TABS_.SCHEDULE, row._row, { Name: person.name, Source: 'manual' });
  rewriteShifts_(mondayOf_(row.date));
  log_(person.name, 'task taken', row.title + ' (' + row.date + ')');
  return { task: taskView_(requireRow_(row.id)) };
}

/* --------------------------------------------------------------- staff: hours ---- */

/** A queued tap keeps its real time, if that time is believable: within 12 hours, and at most 5 minutes ahead. */
function honoredTime_(at) {
  var now = Now_();
  if (at === null || at === undefined || at === '') return now;
  var ms = Number(at);
  if (!isFinite(ms)) return now;
  var ahead = ms - now.getTime();
  if (ahead > AT_MAX_AHEAD_MS_ || ahead < -AT_MAX_PAST_MS_) return now;
  return new Date(ms);
}

/** The Hours cell holds a formula so a person can trace it. Code works hours out from In and Out and never reads it. */
function appendHoursRow_(cells) {
  var row = appendRows_(TABS_.HOURS, [cells]);
  var headers = headersOf_(TABS_.HOURS);
  var inCell = columnLetter_(headers.indexOf('In') + 1) + row;
  var outCell = columnLetter_(headers.indexOf('Out') + 1) + row;
  sheet_(TABS_.HOURS)
    .getRange(row, headers.indexOf('Hours') + 1)
    .setFormula('=IF(' + outCell + '="","",ROUND((' + outCell + '-' + inCell + ')*24,2))');
}

function requireEntry_(id) {
  var wanted = text_(id);
  var entry = hoursRows_().filter(function (candidate) {
    return candidate.id === wanted;
  })[0];
  if (!entry) fail_("We can't find that entry. Please refresh and try again.");
  return entry;
}

function apiClockIn_(req) {
  var person = requireStaff_(req.name);
  var at = honoredTime_(req.at);
  if (!currentEntry_(person.name, at)) {
    appendHoursRow_({ ID: newId_('H-'), Date: wallToDate_(denver_(at, 'yyyy-MM-dd'), '00:00'), Name: person.name, In: at, Out: '', Source: 'clock', Flag: '', Note: '' });
    log_(person.name, 'clock in', stampLabel_(at));
  }
  return { clock: clockView_(person.name, nowInfo_()) };
}

/**
 * Closes the entry they're on the clock with, which can be from before midnight. An older
 * one is left for clockFix, so a repeated tap can't close yesterday's forgotten entry with
 * hours nobody worked. With nothing to close it answers as if it had, so a retry can't get stuck.
 */
function apiClockOut_(req) {
  var person = requireStaff_(req.name);
  var at = honoredTime_(req.at);
  var open = currentEntry_(person.name, at);
  if (open) {
    var fields = { Out: at.getTime() < open.inAt.getTime() ? open.inAt : at };
    if (open.flag === 'missing') fields.Flag = '';
    updateRow_(TABS_.HOURS, open._row, fields);
    log_(person.name, 'clock out', stampLabel_(at));
  }
  return { clock: clockView_(person.name, nowInfo_()) };
}

/**
 * When a shift ends, given its date and end time. An end at or before the start means the
 * next morning, if that makes a believable shift. If not, it stays on the date and checkShift_
 * turns it down, so a typo gets a sentence instead of 23 hours.
 */
function shiftEnd_(date, inAt, time, info) {
  var sameDay = wallToDate_(date, time);
  if (sameDay.getTime() > inAt.getTime()) return sameDay;
  var nextDay = wallToDate_(addDays_(date, 1), time);
  var believable = nextDay.getTime() - inAt.getTime() < SHIFT_MAX_HOURS_ * 3600000 && nextDay.getTime() <= info.now.getTime() + AT_MAX_AHEAD_MS_;
  return believable ? nextDay : sameDay;
}

/** Rejects a shift that can't be right: backwards, 16 hours or more, not happened yet, or on top of another entry. */
function checkShift_(name, inAt, outAt, exceptId, info) {
  if (outAt.getTime() <= inAt.getTime()) fail_('The end time has to be after the start time.');
  if (outAt.getTime() - inAt.getTime() >= SHIFT_MAX_HOURS_ * 3600000) fail_('That is 16 hours or more. Please check the times.');
  if (outAt.getTime() > info.now.getTime() + AT_MAX_AHEAD_MS_) fail_("That time hasn't happened yet.");
  hoursOf_(name).forEach(function (entry) {
    if (entry.id === exceptId) return;
    // An open entry runs until now if it's still on the clock. An older one has no known end, so it only blocks its start.
    var end = entry.outAt || (entryRunning_(entry, info.now) ? info.now : entry.inAt);
    if (inAt.getTime() < end.getTime() && entry.inAt.getTime() < outAt.getTime()) {
      fail_('That overlaps with another entry on ' + dayLabel_(entry.date) + ' (' + timeLabel_(entry.inAt) + (entry.outAt ? ' - ' + timeLabel_(entry.outAt) : '') + ').');
    }
  });
}

function apiClockFix_(req) {
  var person = requireStaff_(req.name);
  var entry = requireEntry_(req.id);
  if (entry.name !== person.name) fail_("That entry isn't yours. Please refresh and try again.");
  var info = nowInfo_();
  var time = requireTime_(req.out, 'finish');
  var outAt = shiftEnd_(entry.date, entry.inAt, time, info);
  if (entry.outAt) {
    if (entry.outAt.getTime() === outAt.getTime()) return { clock: clockView_(person.name, info), entry: entryView_(entry) }; // a retry
    fail_('That entry already has a clock-out. Please ask a manager to change it.');
  }
  if (outAt.getTime() <= entry.inAt.getTime()) fail_('That time is before you clocked in.');
  checkShift_(person.name, entry.inAt, outAt, entry.id, info);
  updateRow_(TABS_.HOURS, entry._row, { Out: outAt, Flag: 'fixed' });
  log_(person.name, 'clock fix', dayLabel_(entry.date) + ', finished ' + clockLabel_(time));
  return { clock: clockView_(person.name, info), entry: entryView_(requireEntry_(entry.id)) };
}

function apiHoursAdd_(req) {
  var person = requireStaff_(req.name);
  var info = nowInfo_();
  var date = requireDate_(req.date, 'date');
  if (date > info.date) fail_('That date is in the future.');
  if (daysBetween_(date, info.date) > HOURS_ADD_MAX_AGE_DAYS_) fail_('That date is too long ago. Please ask a manager to add it.');
  var inAt = wallToDate_(date, requireTime_(req.start, 'start'));
  var outAt = shiftEnd_(date, inAt, requireTime_(req.end, 'end'), info);
  checkShift_(person.name, inAt, outAt, null, info);
  var id = newId_('H-');
  appendHoursRow_({ ID: id, Date: wallToDate_(date, '00:00'), Name: person.name, In: inAt, Out: outAt, Source: 'manual', Flag: 'manual', Note: cleanText_(req.note, MAX_TEXT_) });
  log_(person.name, 'hours added', dayLabel_(date) + ', ' + timeLabel_(inAt) + ' - ' + timeLabel_(outAt));
  return { entry: entryView_(requireEntry_(id)) };
}

/* ---------------------------------------------------------------- managers ---- */

function apiMgrCheck_() {
  return {};
}

/** Who a manager action is credited to: their name if it's a real one, else just "Manager". */
function managerName_(by) {
  var person = personNamed_(cleanText_(by, MAX_NAME_));
  return person ? person.name : 'Manager';
}

/** The next Monday's deadline, and which Flexible people haven't answered. */
function missingAvailability_(weekOf) {
  return activeStaff_().filter(function (person) {
    return person.type === 'Flexible' && !availabilityRow_(person.name, weekOf);
  });
}

/** Weeks a manager can flip through. Nothing before first_week, since nothing runs for those. */
function boardWeeks_(info) {
  var first = firstWeek_();
  var weeks = Object.create(null);
  weeks[info.monday] = true;
  weeks[addDays_(info.monday, 7)] = true;
  if (first > info.monday) weeks[first] = true;
  scheduleRows_().forEach(function (row) {
    weeks[mondayOf_(row.date)] = true;
  });
  return Object.keys(weeks)
    .filter(function (weekOf) {
      return weekOf >= first;
    })
    .sort()
    .slice(-10)
    .map(function (weekOf) {
      return { weekOf: weekOf, label: weekLabel_(weekOf) };
    });
}

function boardDay_(date, weekRows) {
  var dayRows = sortRows_(
    weekRows.filter(function (row) {
      return row.date === date;
    })
  );
  var names = [];
  staff_().forEach(function (person) {
    if (dayRows.some(function (row) {
      return row.name === person.name;
    })) names.push(person.name);
  });
  // Someone taken off the Staff tab can still have rows, and those rows still need showing.
  dayRows.forEach(function (row) {
    if (row.name && names.indexOf(row.name) < 0) names.push(row.name);
  });
  return {
    date: date,
    label: dayLabel_(date),
    closed: closedNote_(date),
    groups: names.map(function (name) {
      return {
        name: name,
        shift: shiftFor_(name, date),
        tasks: dayRows
          .filter(function (row) {
            return row.name === name;
          })
          .map(managerTaskView_),
      };
    }),
    uncovered: dayRows
      .filter(function (row) {
        return !row.name;
      })
      .map(managerTaskView_),
  };
}

function boardPerson_(person, weekOf, weekRows) {
  var rows = weekRows.filter(function (row) {
    return row.name === person.name;
  });
  var availability = availabilityRow_(person.name, weekOf);
  var flexible = person.type === 'Flexible';
  var end = addDays_(weekOf, 6);
  return {
    name: person.name,
    rank: person.rank,
    type: person.type,
    wanted: flexible && availability ? availability.hoursWanted : null,
    assignedMin: rows.reduce(function (sum, row) {
      return row.status === 'missed' ? sum : sum + row.minutes;
    }, 0),
    doneCount: rows.filter(function (row) {
      return row.status === 'done';
    }).length,
    taskCount: rows.length,
    loggedHours: totalHours_(
      hoursOf_(person.name).filter(function (entry) {
        return entry.date >= weekOf && entry.date <= end;
      })
    ),
    avail: flexible ? availabilityStatus_(availability) : 'set',
    submittedAt: availability ? stampLabel_(availability.submittedAt) : '',
    late: availability ? availability.late : false,
    notes: availability ? availability.notes : '',
    off: weekDates_(weekOf)
      .filter(function (date) {
        return isAway_(person.name, date);
      })
      .map(dayLabel_),
  };
}

function oneOffNamed_(id) {
  return (
    oneOffs_().filter(function (item) {
      return item.id === id;
    })[0] || null
  );
}

function requireOneOff_(id) {
  var item = oneOffNamed_(text_(id));
  if (!item) fail_("We can't find that one-off. Please refresh and try again.");
  return item;
}

/** The row that carries a one-off. */
function rowOfOneOff_(id) {
  return (
    scheduleRows_().filter(function (row) {
      return row.oneOffId === id;
    })[0] || null
  );
}

function oneOffView_(item) {
  var row = rowOfOneOff_(item.id);
  return {
    id: item.id,
    title: item.title,
    details: item.details,
    priority: item.priority,
    minutes: item.minutes,
    weekOf: item.weekOf,
    weekLabel: item.weekOf ? weekLabel_(item.weekOf) : '',
    day: item.day,
    who: item.who,
    status: item.status,
    addedBy: item.addedBy,
    added: stampLabel_(item.added),
    assignedTo: row ? row.name : '',
    assignedDate: row ? row.date : '',
    assignedLabel: row ? dayLabel_(row.date) : '',
    assignedMinutes: row ? row.minutes : 0,
    doneBy: item.doneBy,
    doneAt: stampLabel_(item.doneAt),
  };
}

function apiMgrBoard_(req) {
  var info = nowInfo_();
  var weekOf = text_(req.weekOf) ? requireMonday_(req.weekOf) : info.monday;
  var weekRows = scheduleForWeek_(weekOf);
  var coming = nextMonday_(info.date);
  var people = staff_().filter(function (person) {
    if (person.type === 'Manager') {
      return weekRows.some(function (row) {
        return row.name === person.name;
      });
    }
    return person.active;
  });
  return {
    weekOf: weekOf,
    label: weekLabel_(weekOf),
    published: isPublished_(weekOf),
    builtAt: stampLabel_(builtAt_(weekOf)),
    weeks: boardWeeks_(info),
    onClock: hoursRows_()
      .filter(function (entry) {
        return entryRunning_(entry, info.now);
      })
      .map(function (entry) {
        return { name: entry.name, since: timeLabel_(entry.inAt) };
      }),
    days: weekDates_(weekOf).map(function (date) {
      return boardDay_(date, weekRows);
    }),
    people: people.map(function (person) {
      return boardPerson_(person, weekOf, weekRows);
    }),
    nextWeek: {
      weekOf: coming,
      deadline: deadlineLabel_(coming),
      missing: missingAvailability_(coming).map(function (person) {
        return person.name;
      }),
    },
    oneOffs: oneOffs_()
      .filter(function (item) {
        return item.weekOf === weekOf && item.status !== 'deleted';
      })
      .map(oneOffView_),
    staffNames: activeStaff_().map(function (person) {
      return person.name;
    }),
  };
}

/* ------------------------------------------------------------ managers: one-offs ---- */

/** Validates what a one-off can hold. For an edit, `source` is the old values with the new ones laid over them. */
function cleanOneOff_(source) {
  var title = cleanText_(source.title, MAX_TITLE_);
  if (!title) fail_('Please say what needs done.');
  var priority = text_(source.priority || 'B').toUpperCase();
  if (!/^[ABC]\+*$/.test(priority)) fail_('Priority has to be A, B or C.');
  var minutes = Number(source.minutes === undefined || source.minutes === '' ? 30 : source.minutes);
  if (!(minutes >= 1 && minutes <= ONE_OFF_MAX_MINUTES_)) fail_('About how long has to be between 1 minute and 16 hours.');
  var day = '';
  if (text_(source.day)) {
    var days = isDateString_(text_(source.day)) ? [dayKey_(text_(source.day))] : parseDays_(source.day);
    if (days.length !== 1) fail_('Please pick one day, or any day.');
    day = days[0];
  }
  return {
    title: title,
    details: cleanText_(source.details, MAX_TEXT_),
    priority: priority,
    minutes: Math.round(minutes),
    weekOf: requireMonday_(source.weekOf),
    day: day,
    who: parseList_(source.who).map(function (name) {
      return requireStaff_(name).name;
    }),
  };
}

/**
 * Puts a one-off on the schedule with schedFillOpen, moving its row if it already has one.
 * In an unpublished week it just waits for the build, so any row it had comes off.
 * Returns {name, date}, or null when it's waiting.
 */
function placeOneOff_(id) {
  var item = requireOneOff_(id);
  var row = rowOfOneOff_(id);
  var hadRow = row && row.status === 'open';
  var oldDate = hadRow ? row.date : '';
  if (!isPublished_(item.weekOf)) {
    if (hadRow) {
      deleteRows_(TABS_.SCHEDULE, [row._row]);
      rewriteShiftsFor_([oldDate]);
    }
    return null;
  }
  var input = matchInput_(item.weekOf);
  input.locked = scheduleForWeek_(item.weekOf)
    .filter(function (other) {
      return other.name && other.oneOffId !== id;
    })
    .map(rowForScheduler_);
  var fresh = { key: 'oneoff|' + id, taskId: '', oneOffId: id, title: item.title, details: item.details, priority: item.priority, minutes: item.minutes, date: '', day: '', name: '', source: 'auto', partial: false };
  input.open = [hadRow ? Object.assign(fresh, { _row: row._row, rolledFrom: row.rolledFrom }) : fresh];
  var placed = schedFillOpen(input).rows[0];
  if (hadRow) saveFilledRows_([placed]);
  else appendRows_(TABS_.SCHEDULE, [rowToCells_(placed)]);
  rewriteShiftsFor_([oldDate, placed.date]);
  return { name: placed.name, date: placed.date };
}

function apiMgrOneOffAdd_(req) {
  var fields = cleanOneOff_(req);
  var info = nowInfo_();
  if (fields.weekOf < info.monday) fail_('That week is already over.');
  requireFromFirstWeek_(fields.weekOf);
  var by = managerName_(req.by);
  var id = newId_('O-');
  appendRows_(TABS_.ONE_OFFS, [
    {
      ID: id,
      Added: info.now,
      'Added By': by,
      Task: fields.title,
      Details: fields.details,
      Priority: fields.priority,
      Minutes: fields.minutes,
      'Week Of': fields.weekOf,
      Day: fields.day,
      Who: fields.who.join(', '),
      Status: 'open',
      'Done By': '',
      'Done At': '',
    },
  ]);
  var placed = placeOneOff_(id);
  log_(by, 'one-off added', fields.title + ' (week of ' + fields.weekOf + ')');
  return { id: id, placed: placed, oneOff: oneOffView_(requireOneOff_(id)) };
}

function apiMgrOneOffEdit_(req) {
  var item = requireOneOff_(req.id);
  if (item.status === 'deleted') fail_('That one-off has been deleted.');
  var merged = { title: item.title, details: item.details, priority: item.priority, minutes: item.minutes, weekOf: item.weekOf, day: item.day, who: item.who };
  Object.keys(merged).forEach(function (field) {
    if (req[field] !== undefined) merged[field] = req[field];
  });
  var fields = cleanOneOff_(merged);
  if (fields.weekOf !== item.weekOf && fields.weekOf < nowInfo_().monday) fail_('That week is already over.');
  requireFromFirstWeek_(fields.weekOf);

  var moved = fields.weekOf !== item.weekOf || fields.day !== item.day || fields.who.join() !== item.who.join();
  var resized = fields.minutes !== item.minutes;
  updateRow_(TABS_.ONE_OFFS, item._row, {
    Task: fields.title,
    Details: fields.details,
    Priority: fields.priority,
    Minutes: fields.minutes,
    'Week Of': fields.weekOf,
    Day: fields.day,
    Who: fields.who.join(', '),
  });

  var row = rowOfOneOff_(item.id);
  var hasOpenRow = row && row.status === 'open';
  if (hasOpenRow) {
    var cells = { Task: fields.title, Details: fields.details, Priority: fields.priority };
    if (resized) cells.Minutes = fields.minutes; // a partial row only holds what fit, so a new title can't change its size
    updateRow_(TABS_.SCHEDULE, row._row, cells);
    rewriteShiftsFor_([row.date]);
  }
  // A new size has to fit all over again, unless a manager put it there by hand.
  var replace = moved || !row || (resized && hasOpenRow && row.source !== 'manual');
  var placed = item.status === 'open' && replace ? placeOneOff_(item.id) : null;
  log_(managerName_(req.by), 'one-off edited', fields.title);
  return { placed: placed, oneOff: oneOffView_(requireOneOff_(item.id)) };
}

function apiMgrOneOffDelete_(req) {
  var item = requireOneOff_(req.id);
  updateRow_(TABS_.ONE_OFFS, item._row, { Status: 'deleted' });
  var open = scheduleRows_().filter(function (row) {
    return row.oneOffId === item.id && row.status !== 'done';
  });
  var dates = open.map(function (row) {
    return row.date;
  });
  deleteRows_(
    TABS_.SCHEDULE,
    open.map(function (row) {
      return row._row;
    })
  );
  rewriteShiftsFor_(dates);
  log_(managerName_(req.by), 'one-off deleted', item.title);
  return {};
}

/* ---------------------------------------------------------- managers: the week ---- */

function apiMgrAssign_(req) {
  var row = requireRow_(req.id);
  if (row.status === 'done') fail_('That task is already done.');
  var person = requireStaff_(req.name);
  var info = nowInfo_();
  var date = text_(req.date) ? requireDate_(req.date, 'day') : row.date;
  if (date < info.date) fail_('Please pick today or a later day.');
  if (closedNote_(date)) fail_('The gym is closed that day.');
  updateRow_(TABS_.SCHEDULE, row._row, { Name: person.name, Date: date, Day: dayKey_(date), 'Week Of': mondayOf_(date), Source: 'manual', Status: 'open' });
  moveOneOffsToWeek_([row], mondayOf_(date));
  rewriteShiftsFor_([row.date, date]);
  log_(managerName_(req.by), 'task assigned', row.title + ' to ' + person.name + ' on ' + date);
  return { task: managerTaskView_(requireRow_(row.id)) };
}

/** The day a set row was first down for, from its key. '' for anything else. */
function setKeyDate_(row) {
  var parts = row.id.split('|');
  return parts[0] === 'set' ? parts[2] : '';
}

/**
 * Re-runs matching for rows still up for grabs: not done, not manual, and either on a
 * later day or uncovered today. Work already on someone's list today stays with them.
 * Rolled rows keep their place too, since their key points at an earlier day, and so does
 * cover for a set day that has passed, since matching only makes set rows for days to come.
 */
function apiMgrRebuild_(req) {
  var weekOf = requireMonday_(req.weekOf);
  var info = nowInfo_();
  if (addDays_(weekOf, 6) < info.date) fail_('That week is already over.');
  requireFromFirstWeek_(weekOf);
  if (!isPublished_(weekOf) && !pastDeadline_(weekOf, info)) fail_("That week's schedule hasn't been built yet. It builds Friday at 7 AM.");

  var rows = scheduleForWeek_(weekOf);
  var coversPastSetDay = function (row) {
    var keyDate = setKeyDate_(row);
    return !!keyDate && keyDate < info.date;
  };
  var isReleased = function (row) {
    if (row.status !== 'open' || row.source === 'manual' || row.source === 'carry' || coversPastSetDay(row)) return false;
    return row.date > info.date || (row.date === info.date && !row.name);
  };
  var released = rows.filter(isReleased);
  var kept = rows.filter(function (row) {
    return !isReleased(row);
  });
  var fresh = matchWeek_(weekOf, kept); // worked out first, so a failure here loses nothing

  var stuck = kept.filter(function (row) {
    return (row.source === 'carry' || coversPastSetDay(row)) && !row.name && row.status === 'open' && row.date >= info.date;
  });
  var stuckRows = [];
  if (stuck.length) {
    var input = matchInput_(weekOf);
    input.open = stuck.map(function (row) {
      return openRow_(row);
    });
    input.locked = kept
      .filter(function (row) {
        return row.name;
      })
      .map(rowForScheduler_)
      .concat(
        fresh.filter(function (row) {
          return row.name;
        })
      );
    stuckRows = schedFillOpen(input).rows;
  }

  saveFilledRows_(stuckRows); // these keep their row numbers only until the delete below
  deleteRows_(
    TABS_.SCHEDULE,
    released.map(function (row) {
      return row._row;
    })
  );
  appendRows_(TABS_.SCHEDULE, fresh.map(rowToCells_));
  rewriteShifts_(weekOf);
  markBuilt_(weekOf);
  log_(managerName_(req.by), 'matching re-run', 'Week of ' + weekOf + ': ' + fresh.length + ' rows');
  return {
    weekOf: weekOf,
    rows: fresh.length + stuckRows.length,
    unfilled: fresh.concat(stuckRows).filter(function (row) {
      return !row.name;
    }).length,
  };
}

function apiMgrRemind_(req) {
  var weekOf = requireMonday_(req.weekOf);
  var sent = [];
  missingAvailability_(weekOf).forEach(function (person) {
    var went = bestEffort_('reminder to ' + person.name, function () {
      return mailReminder_(person, weekOf);
    });
    if (went) sent.push(person.name);
  });
  log_(managerName_(req.by), 'reminder sent', 'Week of ' + weekOf + ': ' + sent.join(', '));
  return { sent: sent };
}

/* ------------------------------------------------------------ managers: hours ---- */

/** An entry that needs someone to fix it: flagged, open from before today and no longer on the clock, or on top of another entry. */
function entryHasIssue_(entry, info) {
  if (entry.flag === 'missing') return true;
  if (!entry.outAt) return entry.date < info.date && !entryRunning_(entry, info.now);
  return entryOverlaps_(entry);
}

/** Shares time with another of their entries. Typed hours can't, so this takes a hand-made request or a sheet edit, and payroll would count it twice. */
function entryOverlaps_(entry) {
  if (!entry.outAt) return false;
  return hoursOf_(entry.name).some(function (other) {
    return other.id !== entry.id && other.outAt && entry.inAt.getTime() < other.outAt.getTime() && other.inAt.getTime() < entry.outAt.getTime();
  });
}

/** Logged far past what was scheduled that day, which is what a forgotten clock-out looks like. Once a manager has edited it, it's settled. */
function entryRunsLong_(entry) {
  if (!entry.outAt || entry.flag === 'edited') return false;
  var scheduled = 0;
  scheduleRows_().forEach(function (row) {
    if (row.name === entry.name && row.date === entry.date) scheduled += row.minutes;
  });
  var allowed = scheduled ? scheduled + LONG_SHIFT_EXTRA_MIN_ : LONG_SHIFT_UNSCHEDULED_MIN_;
  return (entry.outAt.getTime() - entry.inAt.getTime()) / 60000 > allowed;
}

/** HoursEntry, plus what a manager should look at before payroll. */
function managerEntryView_(entry) {
  var view = entryView_(entry);
  if (entryRunsLong_(entry)) view.long = true;
  if (entryOverlaps_(entry)) view.overlaps = true;
  return view;
}

function apiMgrHours_(req) {
  var info = nowInfo_();
  var month = text_(req.month) ? requireMonth_(req.month) : info.month;
  var all = hoursRows_();
  var months = Object.create(null);
  months[info.month] = true;
  all.forEach(function (entry) {
    months[monthOf_(entry.date)] = true;
  });
  var inMonth = all.filter(function (entry) {
    return monthOf_(entry.date) === month;
  });

  // Everyone who isn't a manager shows up, even at zero. A manager shows up only with entries.
  var names = staff_()
    .filter(function (person) {
      return (person.active && person.type !== 'Manager') || inMonth.some(function (entry) {
        return entry.name === person.name;
      });
    })
    .map(function (person) {
      return person.name;
    });
  inMonth.forEach(function (entry) {
    if (names.indexOf(entry.name) < 0) names.push(entry.name);
  });

  var people = names.map(function (name) {
    var entries = inMonth
      .filter(function (entry) {
        return entry.name === name;
      })
      .sort(newestFirst_);
    return {
      name: name,
      total: totalHours_(entries),
      shifts: entries.length,
      issues: entries.filter(function (entry) {
        return entryHasIssue_(entry, info);
      }).length,
      entries: entries.map(managerEntryView_),
    };
  });
  return {
    month: month,
    label: monthYearLabel_(month),
    months: Object.keys(months)
      .sort()
      .reverse()
      .map(function (key) {
        return { month: key, label: monthYearLabel_(key) };
      }),
    people: people,
    totalIssues: people.reduce(function (sum, person) {
      return sum + person.issues;
    }, 0),
  };
}

function apiMgrHoursAdd_(req) {
  var person = requireStaff_(req.name);
  var info = nowInfo_();
  var date = requireDate_(req.date, 'date');
  var inAt = wallToDate_(date, requireTime_(req.start, 'start'));
  var outAt = shiftEnd_(date, inAt, requireTime_(req.end, 'end'), info);
  checkShift_(person.name, inAt, outAt, null, info);
  var by = managerName_(req.by);
  var id = newId_('H-');
  appendHoursRow_({
    ID: id,
    Date: wallToDate_(date, '00:00'),
    Name: person.name,
    In: inAt,
    Out: outAt,
    Source: 'manual',
    Flag: 'edited',
    Note: cleanText_(req.note, MAX_TEXT_),
    'Edited By': by,
    'Edited At': info.now,
  });
  log_(by, 'hours added', person.name + ', ' + dayLabel_(date) + ', ' + timeLabel_(inAt) + ' - ' + timeLabel_(outAt));
  return { entry: entryView_(requireEntry_(id)) };
}

/** Change any of date, start, end and note. A blank end reopens the entry. */
function apiMgrHoursEdit_(req) {
  var entry = requireEntry_(req.id);
  var info = nowInfo_();
  var date = req.date !== undefined ? requireDate_(req.date, 'date') : entry.date;
  var start = req.start !== undefined ? requireTime_(req.start, 'start') : denver_(entry.inAt, 'HH:mm');
  var endGiven = req.end !== undefined;
  var endBlank = endGiven && !text_(req.end);
  var end = endGiven ? (endBlank ? '' : requireTime_(req.end, 'end')) : entry.outAt ? denver_(entry.outAt, 'HH:mm') : '';
  var inAt = wallToDate_(date, start);
  var outAt = end ? shiftEnd_(date, inAt, end, info) : null;
  if (outAt) checkShift_(entry.name, inAt, outAt, entry.id, info);

  var by = managerName_(req.by);
  var fields = { Date: wallToDate_(date, '00:00'), In: inAt, Out: outAt || '', Flag: 'edited', 'Edited By': by, 'Edited At': info.now };
  if (req.note !== undefined) fields.Note = cleanText_(req.note, MAX_TEXT_);
  updateRow_(TABS_.HOURS, entry._row, fields);
  log_(by, 'hours edited', entry.name + ', ' + dayLabel_(date) + ', ' + timeLabel_(inAt) + (outAt ? ' - ' + timeLabel_(outAt) : ''));
  return { entry: entryView_(requireEntry_(entry.id)) };
}

function apiMgrHoursDelete_(req) {
  var entry = requireEntry_(req.id);
  deleteRows_(TABS_.HOURS, [entry._row]);
  log_(managerName_(req.by), 'hours deleted', entry.name + ', ' + dayLabel_(entry.date) + ', ' + timeLabel_(entry.inAt) + (entry.outAt ? ' - ' + timeLabel_(entry.outAt) : ''));
  return {};
}
