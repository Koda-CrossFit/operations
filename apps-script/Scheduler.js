/**
 * Scheduler.js: who does which task on which day (SPEC section 6).
 *
 * Pure functions only: no Google services, no clock, no time zones. "Today" and the
 * time of day arrive as data. Dates are 'YYYY-MM-DD' strings and all date math goes
 * through Date.UTC, so daylight saving can never shift a day. Same input, same output.
 *
 * Public: schedPriorityScore, schedBuildWeek, schedFillOpen, schedShifts.
 *
 * How it works: everything that needs a person becomes a "job", which is the Row that
 * goes back to the caller plus what matching needs to know about it (preferred date,
 * flex, who may do it). Jobs are sorted by rule 4 and placed one at a time, while a
 * ledger tracks each person's minutes per day and per week. The "rule N" comments
 * below are the numbered rules in SPEC section 6.
 */

var SCHED_DAYS_ = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
var SCHED_HOURS_TOLERANCE_ = 15; // minutes past someone's requested hours that still fit
var SCHED_SHORT_TRIP_ = 30; // a person-day with less work than this is a short trip (rule 9)
var SCHED_MIN_PARTIAL_ = 30; // room needed to start a one-off that can't fit whole (rule 7)
var SCHED_SHIFT_STEP_ = 15; // shift end times round up to this (rule 11)
var SCHED_LATEST_END_ = 23 * 60 + 45; // a stacked-up day can't produce a time past midnight
var SCHED_NO_DAY_FLEX_ = 999; // a one-off with no day sorts after everything movable (rule 4)
var SCHED_NO_ORDER_ = 9999; // one-offs sort after listed tasks at the "task order" step
var SCHED_WHOLE_DAY_ = { start: 5, end: 22 }; // every hour on the availability grid: someone tapped the day header, meaning "any time"
var SCHED_ANY_TIME_START_ = 9 * 60; // an "any time" day shows this start, not 5 AM

/* ------------------------------------------------------------------ public ------ */

/** A+++++ > A++ > A > B+ > B > C > blank. Letter first, then plus count. */
function schedPriorityScore(priority) {
  var text = String(priority === null || priority === undefined ? '' : priority).trim().toUpperCase();
  var letter = { A: 3, B: 2, C: 1 }[text.charAt(0)];
  if (!letter) return 0;
  return letter * 100 + (text.split('+').length - 1);
}

/**
 * Matches a whole week. `rows` holds only the new rows; `locked` rows are never
 * repeated or changed, but they do count in `shifts` and `usage`.
 * -> {rows, shifts, unfilled, usage}
 */
function schedBuildWeek(input) {
  var ctx = schedContext_(input);
  var jobs = [];
  schedAddSetJobs_(ctx, jobs);
  schedAddTaskJobs_(ctx, jobs);
  schedAddOneOffJobs_(ctx, jobs);
  schedRunPool_(ctx, jobs);
  return schedResult_(ctx, jobs);
}

/**
 * Assigns only `input.open` rows, optionally only to `input.pool` people, with
 * `input.locked` counted against capacity. Nobody else's work moves, and every open
 * row comes back, either with a name or in `unfilled`. Unknown fields on an open row
 * (a sheet row number, say) are kept, so the caller can match results to its records.
 * -> {rows, shifts, unfilled, usage}
 */
function schedFillOpen(input) {
  var ctx = schedContext_(input);
  var jobs = (input.open || []).map(function (row) {
    return schedOpenJob_(ctx, row);
  });
  schedRunPool_(ctx, jobs);
  return schedResult_(ctx, jobs);
}

/**
 * Rule 11. One shift per person-day with rows, when that person has availability that
 * day: starts at the start of their largest block (or 9 AM if they marked the whole day),
 * ends at start + total minutes, rounded up to the next 15. `minutes` is the shift's
 * length, end minus start. Set staff and managers have no availability, so they never get one.
 * -> [{name, date, start:'09:00', end:'11:30', minutes}], by date then name.
 */
function schedShifts(rows, availability, weekOf) {
  var weekEnd = schedAddDays_(weekOf, 6);
  var totals = Object.create(null);
  (rows || []).forEach(function (row) {
    if (!row.name || !row.date || row.date < weekOf || row.date > weekEnd) return;
    var id = row.date + '|' + row.name;
    if (!totals[id]) totals[id] = { name: row.name, date: row.date, minutes: 0 };
    totals[id].minutes += schedMinutes_(row.minutes);
  });
  var shifts = [];
  Object.keys(totals).sort().forEach(function (id) {
    var total = totals[id];
    var entry = (availability || {})[total.name];
    if (!entry || entry.none) return;
    var block = schedLargestBlock_(entry.slots, schedDayKey_(total.date), null);
    if (!block) return;
    var wholeDay = block.start === SCHED_WHOLE_DAY_.start && block.end === SCHED_WHOLE_DAY_.end;
    var start = wholeDay ? SCHED_ANY_TIME_START_ : block.start * 60;
    var end = Math.ceil((start + total.minutes) / SCHED_SHIFT_STEP_) * SCHED_SHIFT_STEP_;
    end = Math.min(end, SCHED_LATEST_END_);
    shifts.push({
      name: total.name,
      date: total.date,
      start: schedClock_(start),
      end: schedClock_(end),
      minutes: end - start,
    });
  });
  return shifts;
}

/* ------------------------------------------------------- setting up the week ------ */

function schedContext_(input) {
  var dates = [];
  for (var i = 0; i < 7; i++) dates.push(schedAddDays_(input.weekOf, i));
  var ctx = {
    weekOf: input.weekOf,
    weekEnd: dates[6],
    dates: dates,
    today: input.today || '',
    nowMinutes: schedNowMinutes_(input.nowMinutes),
    availability: input.availability || {},
    timeOff: input.timeOff || [],
    closed: schedSet_(input.closedDays),
    pool: input.pool ? schedSet_(input.pool) : null,
    tasks: input.tasks || [],
    tasksById: schedIndex_(input.tasks),
    oneOffs: input.oneOffs || [],
    oneOffsById: schedIndex_(input.oneOffs),
    active: schedActiveStaff_(input.staff),
    ledger: Object.create(null),
    lockedDays: Object.create(null),
    lockedKeys: Object.create(null),
    lockedOneOffs: Object.create(null),
  };
  ctx.flexible = ctx.active.filter(schedIsFlexible_);

  // An open row passed in `locked` as well must not use up its own capacity.
  var opening = schedSet_(
    (input.open || []).map(function (row) {
      return row.key;
    })
  );
  ctx.locked = (input.locked || []).filter(function (row) {
    return row.date >= ctx.weekOf && row.date <= ctx.weekEnd && !(row.key && opening[row.key]);
  });
  ctx.locked.forEach(function (row) {
    if (row.key) ctx.lockedKeys[row.key] = true;
    // A key this code didn't make (a sheet ID, say) can't be matched, so go by task and date.
    if (row.taskId && !schedIsOwnKey_(row.key)) ctx.lockedKeys[row.taskId + '@' + row.date] = true;
    if (row.oneOffId) ctx.lockedOneOffs[row.oneOffId] = true;
    if (row.name) {
      schedBook_(ctx, row.name, row.date, schedMinutes_(row.minutes));
      ctx.lockedDays[row.name + '|' + row.date] = true;
    }
  });
  return ctx;
}

function schedActiveStaff_(staff) {
  return (staff || [])
    .filter(function (person) {
      return person.active !== false;
    })
    .sort(function (a, b) {
      return schedCompare_(schedRank_(a), schedRank_(b)) || schedCompare_(a.name, b.name);
    });
}

/** Best rank first. Managers have no rank, so they always come last. */
function schedRank_(person) {
  var rank = parseFloat(person.rank);
  return isFinite(rank) ? rank : Infinity;
}

function schedIsFlexible_(person) {
  return String(person.type || '').toLowerCase() === 'flexible';
}

function schedIsSet_(person) {
  return String(person.type || '').toLowerCase() === 'set';
}

/* ------------------------------------------------------------ building jobs ------ */

/** Rule 1. An out-of-town day goes in the pool with no name and source 'cover'. */
function schedAddSetJobs_(ctx, jobs) {
  ctx.active.filter(schedIsSet_).forEach(function (person) {
    ctx.dates.forEach(function (date) {
      var day = schedDayKey_(date);
      if ((person.setDays || []).indexOf(day) < 0 || !schedDateOpen_(ctx, date)) return;
      (person.setTasks || []).forEach(function (setTask) {
        var task = ctx.tasksById[setTask.taskId];
        if (!task || task.active === false) return;
        if (setTask.days && setTask.days.indexOf(day) < 0) return;
        var key = 'set|' + task.id + '|' + date + '|' + person.name;
        if (schedIsLocked_(ctx, key, task.id, date)) return;
        var job = schedTaskJob_(task, date, key);
        if (schedIsAway_(ctx, person.name, date)) {
          job.row.source = 'cover';
        } else {
          job.row.source = 'set';
          job.inPool = false;
          schedSetPlace_(job, person.name, date); // not on the ledger: set staff have no capacity to track
        }
        jobs.push(job);
      });
    });
  });
}

/** Rule 2. A row whose whole window is closed or already past is dropped. */
function schedAddTaskJobs_(ctx, jobs) {
  ctx.tasks.forEach(function (task) {
    if (task.active === false || task.setOnly) return;
    ctx.dates.forEach(function (date) {
      if ((task.days || []).indexOf(schedDayKey_(date)) < 0) return;
      var key = 'task|' + task.id + '|' + date;
      if (schedIsLocked_(ctx, key, task.id, date)) return;
      var job = schedTaskJob_(task, date, key);
      job.row.source = 'auto';
      if (schedWindow_(ctx, job).length) jobs.push(job);
    });
  });
}

/** Rule 3. */
function schedAddOneOffJobs_(ctx, jobs) {
  ctx.oneOffs.forEach(function (oneOff) {
    if (oneOff.status && oneOff.status !== 'open') return;
    if (ctx.lockedOneOffs[oneOff.id]) return;
    jobs.push(schedOneOffJob_(ctx, oneOff));
  });
}

function schedIsLocked_(ctx, key, taskId, date) {
  return !!(ctx.lockedKeys[key] || ctx.lockedKeys[taskId + '@' + date]);
}

/** The keys this code makes for tasks: 'task|T01|date' and 'set|T08|date|Name'. They keep the preferred date. */
function schedIsOwnKey_(key) {
  return /^(task|set)\|/.test(String(key || ''));
}

function schedTaskJob_(task, date, key) {
  return {
    row: {
      key: key,
      taskId: task.id,
      oneOffId: '',
      title: task.title || '',
      details: task.details || '',
      priority: task.priority || '',
      minutes: schedMinutes_(task.minutes),
      date: date,
      day: schedDayKey_(date),
      name: '',
      source: 'auto',
      partial: false,
    },
    inPool: true,
    noDay: false,
    pref: date,
    flex: schedFlexDays_(task),
    listed: task.days || [],
    who: [],
    score: schedPriorityScore(task.priority),
    order: schedTaskOrder_(task),
  };
}

function schedOneOffJob_(ctx, oneOff) {
  var pin = schedOneOffPin_(ctx, oneOff);
  var pref = schedNotBeforeToday_(ctx, pin);
  return {
    row: {
      key: 'oneoff|' + oneOff.id,
      taskId: '',
      oneOffId: oneOff.id,
      title: oneOff.title || '',
      details: oneOff.details || '',
      priority: oneOff.priority || '',
      minutes: schedMinutes_(oneOff.minutes),
      date: pref,
      day: pref ? schedDayKey_(pref) : '',
      name: '',
      source: 'auto',
      partial: false,
    },
    inPool: true,
    noDay: !pin,
    pref: pref,
    flex: pin ? 0 : SCHED_NO_DAY_FLEX_,
    listed: [],
    who: schedWhoList_(oneOff.who),
    score: schedPriorityScore(oneOff.priority),
    order: SCHED_NO_ORDER_,
  };
}

/**
 * A row handed to schedFillOpen. Its own date is the preferred date. A one-off goes
 * back to its full size each time, because a partial row keeps rolling until it's done.
 */
function schedOpenJob_(ctx, open) {
  var row = Object.assign({}, open, { name: '', partial: false });
  var task = ctx.tasksById[row.taskId] || null;
  var oneOff = ctx.oneOffsById[row.oneOffId] || null;
  var isOneOff = !!row.oneOffId;
  var pin = oneOff ? schedOneOffPin_(ctx, oneOff) : '';
  var noDay = oneOff ? !pin : !row.date;
  var pref = noDay ? '' : row.date || pin;
  if (isOneOff) pref = schedNotBeforeToday_(ctx, pref);

  row.minutes = schedMinutes_(oneOff ? oneOff.minutes : row.minutes);
  row.source = row.source === 'set' ? 'cover' : row.source || 'auto';
  row.key = row.key || (isOneOff ? 'oneoff|' + row.oneOffId : 'task|' + row.taskId + '|' + row.date);

  var flex = task ? schedFlexDays_(task) : 0;
  return {
    row: row,
    inPool: true,
    noDay: noDay,
    pref: pref,
    flex: noDay ? SCHED_NO_DAY_FLEX_ : flex,
    listed: task ? task.days || [] : [],
    who: schedWhoList_(oneOff ? oneOff.who : row.who),
    score: schedPriorityScore(row.priority || (task || oneOff || {}).priority),
    order: task ? schedTaskOrder_(task) : SCHED_NO_ORDER_,
  };
}

/** A one-off's pinned date, from 'Wed' or '2026-11-11'. '' when it has no day in this week. */
function schedOneOffPin_(ctx, oneOff) {
  var day = String(oneOff.day || '').trim();
  if (!day) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return ctx.dates.indexOf(day) >= 0 ? day : '';
  var key = day.charAt(0).toUpperCase() + day.slice(1, 3).toLowerCase();
  var matches = ctx.dates.filter(function (date) {
    return schedDayKey_(date) === key;
  });
  return matches.length ? matches[0] : '';
}

function schedWhoList_(who) {
  if (Array.isArray(who)) return who;
  if (!who) return [];
  return String(who)
    .split(',')
    .map(function (name) {
      return name.trim();
    })
    .filter(Boolean);
}

/** A pinned one-off whose day has passed is still open, so it stands for today. */
function schedNotBeforeToday_(ctx, date) {
  return date && ctx.today && date < ctx.today ? ctx.today : date;
}

/* ------------------------------------------------------------------ placing ------ */

/** Rules 4 to 9. */
function schedRunPool_(ctx, jobs) {
  jobs.sort(schedCompareJobs_);
  jobs.forEach(function (job) {
    if (!job.inPool) return;
    if (job.noDay) schedPlacePeopleFirst_(ctx, job);
    else schedPlaceInWindow_(ctx, jobs, job);
  });
  schedTidy_(ctx, jobs);
}

/** Rule 4. The key is the last tie-break, so the order never depends on input order. */
function schedCompareJobs_(a, b) {
  return (
    b.score - a.score ||
    a.flex - b.flex ||
    schedCompare_(a.pref, b.pref) ||
    b.row.minutes - a.row.minutes ||
    a.order - b.order ||
    schedCompare_(a.row.key, b.row.key)
  );
}

/**
 * Would moving this job to that date put the same task on one day twice? A row already
 * there counts, whoever has it, and so does a job that prefers that date and hasn't been placed yet.
 */
function schedTaskOnDate_(ctx, jobs, job, date) {
  var id = job.row.taskId;
  if (!id || date === job.pref) return false;
  var same = function (row) {
    return row.taskId === id && row.date === date;
  };
  return ctx.locked.some(same) || jobs.some(function (other) {
    return other !== job && same(other.row);
  });
}

/** Rule 5: date by date through the window, person by person within each date. */
function schedPlaceInWindow_(ctx, jobs, job) {
  var open = schedWindow_(ctx, job);
  var dates = open.filter(function (date) {
    return !schedTaskOnDate_(ctx, jobs, job, date);
  });
  var people = schedCandidates_(ctx, job.who);
  for (var d = 0; d < dates.length; d++) {
    for (var p = 0; p < people.length; p++) {
      if (schedCanTake_(ctx, people[p], dates[d], job.row.minutes)) {
        schedPut_(ctx, job, people[p].name, dates[d]);
        return;
      }
    }
  }
  // Rule 10. A one-off pinned to a closed day waits on the next open day for a manager
  // to decide, so no row ever sits on a closed date. Another open row keeps its date.
  var uncoveredDate = open[0] || (job.row.oneOffId ? schedFallbackDate_(ctx, job.pref) : job.row.date);
  schedSetPlace_(job, '', uncoveredDate);
}

/** Rules 7 and 8: a one-off with no day goes to a person first, then finds a date. */
function schedPlacePeopleFirst_(ctx, job) {
  var dates = schedAllowedDates_(ctx, job.listed);
  var people = schedCandidates_(ctx, job.who);
  var p, d, tries;

  for (p = 0; p < people.length; p++) {
    if (!schedIsFlexible_(people[p])) {
      var freeDate = schedUntrackedDate_(ctx, people[p], dates);
      if (freeDate) {
        schedPut_(ctx, job, people[p].name, freeDate);
        return;
      }
      continue;
    }
    tries = schedWorkedDaysFirst_(ctx, people[p].name, dates);
    for (d = 0; d < tries.length; d++) {
      if (schedFits_(ctx, people[p].name, tries[d], job.row.minutes)) {
        schedPut_(ctx, job, people[p].name, tries[d]);
        return;
      }
    }
  }

  // Nobody can fit the whole thing: best-ranked person with enough room starts it.
  for (p = 0; p < people.length; p++) {
    tries = schedWorkedDaysFirst_(ctx, people[p].name, dates);
    for (d = 0; d < tries.length; d++) {
      var room = schedRoom_(ctx, people[p].name, tries[d]);
      if (room >= SCHED_MIN_PARTIAL_) {
        job.row.minutes = room;
        job.row.partial = true;
        schedPut_(ctx, job, people[p].name, tries[d]);
        return;
      }
    }
  }

  var keepsDate = job.row.date && dates.indexOf(job.row.date) >= 0;
  schedSetPlace_(job, '', keepsDate ? job.row.date : schedFallbackDate_(ctx, ''));
}

/** Rule 8: next set day in the week, else the first allowed date. */
function schedUntrackedDate_(ctx, person, dates) {
  var setDates = ctx.dates.filter(function (date) {
    return (person.setDays || []).indexOf(schedDayKey_(date)) >= 0 && schedDateOpen_(ctx, date);
  });
  var tries = setDates.concat(dates);
  for (var i = 0; i < tries.length; i++) {
    if (!schedIsAway_(ctx, person.name, tries[i])) return tries[i];
  }
  return '';
}

/** Rule 7: dates where they already have work, then everything else, earliest first. */
function schedWorkedDaysFirst_(ctx, name, dates) {
  var worked = dates.filter(function (date) {
    return schedWorksOn_(ctx, name, date);
  });
  return worked.concat(
    dates.filter(function (date) {
      return worked.indexOf(date) < 0;
    })
  );
}

/** Flexible people by rank, or with `who` set only those people, Set and Manager included. */
function schedCandidates_(ctx, who) {
  var people = who.length
    ? ctx.active.filter(function (person) {
        return who.indexOf(person.name) >= 0;
      })
    : ctx.flexible;
  if (!ctx.pool) return people;
  return people.filter(function (person) {
    return ctx.pool[person.name];
  });
}

/** Rule 8: Set people and managers have no capacity tracking, only "are they around". */
function schedCanTake_(ctx, person, date, minutes) {
  if (schedIsFlexible_(person)) return schedFits_(ctx, person.name, date, minutes);
  return !schedIsAway_(ctx, person.name, date);
}

/** Rule 6. */
function schedFits_(ctx, name, date, minutes) {
  return schedRoom_(ctx, name, date) >= minutes;
}

/**
 * Minutes this person can still take on this date: what's left of their largest block
 * that day and of their week, whichever is smaller. Negative means none at all.
 */
function schedRoom_(ctx, name, date) {
  var entry = ctx.availability[name];
  if (!entry || entry.none || schedIsAway_(ctx, name, date)) return -1;
  var wanted = Number(entry.hoursWanted);
  if (!(wanted > 0)) return -1;
  var now = date === ctx.today ? ctx.nowMinutes : null;
  var block = schedLargestBlock_(entry.slots, schedDayKey_(date), now);
  if (!block) return -1;
  var person = ctx.ledger[name];
  var day = person && person.days[date];
  var dayLeft = (block.end - block.start) * 60 - (day ? day.minutes : 0);
  var weekLeft = wanted * 60 + SCHED_HOURS_TOLERANCE_ - (person ? person.week : 0);
  return Math.min(dayLeft, weekLeft);
}

function schedIsAway_(ctx, name, date) {
  return ctx.timeOff.some(function (off) {
    return off.name === name && off.status !== 'cancelled' && off.from <= date && date <= (off.to || off.from);
  });
}

/* ---------------------------------------------------------------- the window ------ */

/** Rule 5: preferred date, then +1, -1, +2, -2... up to the job's flex days. */
function schedWindow_(ctx, job) {
  var dates = [];
  var consider = function (date) {
    var allowed = date === job.pref || schedDayAllowed_(date, job.listed);
    if (allowed && schedDateOpen_(ctx, date)) dates.push(date);
  };
  consider(job.pref);
  for (var i = 1; i <= job.flex; i++) {
    consider(schedAddDays_(job.pref, i));
    consider(schedAddDays_(job.pref, -i));
  }
  return dates;
}

function schedAllowedDates_(ctx, listed) {
  return ctx.dates.filter(function (date) {
    return schedDateOpen_(ctx, date) && schedDayAllowed_(date, listed);
  });
}

/** Mon-Sat, plus any day the task lists. */
function schedDayAllowed_(date, listed) {
  var day = schedDayKey_(date);
  return day !== 'Sun' || (listed || []).indexOf(day) >= 0;
}

/** Inside the week, not closed, not before today. */
function schedDateOpen_(ctx, date) {
  return date >= ctx.weekOf && date <= ctx.weekEnd && !ctx.closed[date] && !(ctx.today && date < ctx.today);
}

/** Where an uncovered one-off waits when it can't have the date it asked for. */
function schedFallbackDate_(ctx, from) {
  var later = schedAllowedDates_(ctx, []).filter(function (date) {
    return date >= from;
  });
  if (later.length) return later[0];
  // Nothing allowed from there on. Nobody is assigned here, so the first open day will do, even a Sunday.
  var open = ctx.dates.filter(function (date) {
    return schedDateOpen_(ctx, date);
  });
  if (open.length) return open[0];
  if (ctx.today > ctx.weekEnd) return ctx.weekEnd;
  return ctx.today > ctx.weekOf ? ctx.today : ctx.weekOf;
}

/* ----------------------------------------------------------------- rule 9: tidy -- */

function schedTidy_(ctx, jobs) {
  ctx.flexible.forEach(function (person) {
    ctx.dates.forEach(function (date) {
      var trip = jobs.filter(function (job) {
        return job.row.name === person.name && job.row.date === date;
      });
      if (schedIsShortTrip_(ctx, person, date, trip)) schedMoveTrip_(ctx, jobs, person, date, trip);
    });
  });
}

/** Their whole day is under 30 minutes and all of it can move. Locked work means they're coming anyway. */
function schedIsShortTrip_(ctx, person, date, trip) {
  if (!trip.length || ctx.lockedDays[person.name + '|' + date]) return false;
  var total = trip.reduce(function (sum, job) {
    return sum + job.row.minutes;
  }, 0);
  return total < SCHED_SHORT_TRIP_ && trip.every(schedIsMovable_);
}

function schedIsMovable_(job) {
  return job.row.source === 'auto' && (job.noDay || job.flex > 0);
}

/** All or nothing: moving only part of a trip would leave them a shorter trip. */
function schedMoveTrip_(ctx, jobs, person, date, trip) {
  trip.forEach(function (job) {
    schedUnbook_(ctx, person.name, date, job.row.minutes);
  });
  var moves = [];
  var allMoved = trip.every(function (job) {
    var move = schedFindTidyMove_(ctx, jobs, person, date, job);
    if (!move) return false;
    schedBook_(ctx, move.name, move.date, job.row.minutes);
    moves.push({ job: job, name: move.name, date: move.date });
    return true;
  });
  if (allMoved) {
    moves.forEach(function (move) {
      schedSetPlace_(move.job, move.name, move.date);
    });
    return;
  }
  moves.forEach(function (move) {
    schedUnbook_(ctx, move.name, move.date, move.job.row.minutes);
  });
  trip.forEach(function (job) {
    schedBook_(ctx, person.name, date, job.row.minutes);
  });
}

/** Another day in the row's window where the same person works, else someone already working that day. */
function schedFindTidyMove_(ctx, jobs, person, date, job) {
  var minutes = job.row.minutes;
  var dates = job.noDay ? schedAllowedDates_(ctx, job.listed) : schedWindow_(ctx, job);
  var i;
  for (i = 0; i < dates.length; i++) {
    if (dates[i] === date || !schedWorksOn_(ctx, person.name, dates[i]) || schedTaskOnDate_(ctx, jobs, job, dates[i])) continue;
    if (schedFits_(ctx, person.name, dates[i], minutes)) return { name: person.name, date: dates[i] };
  }
  var others = schedCandidates_(ctx, job.who);
  for (i = 0; i < others.length; i++) {
    var other = others[i];
    if (other.name === person.name || !schedIsFlexible_(other)) continue;
    if (!schedWorksOn_(ctx, other.name, date)) continue;
    if (schedFits_(ctx, other.name, date, minutes)) return { name: other.name, date: date };
  }
  return null;
}

/* ------------------------------------------------------------------- ledger ------ */

function schedPut_(ctx, job, name, date) {
  schedSetPlace_(job, name, date);
  schedBook_(ctx, name, date, job.row.minutes);
}

function schedSetPlace_(job, name, date) {
  job.row.name = name;
  job.row.date = date;
  job.row.day = date ? schedDayKey_(date) : '';
}

function schedBook_(ctx, name, date, minutes) {
  var person = ctx.ledger[name] || (ctx.ledger[name] = { week: 0, days: Object.create(null) });
  var day = person.days[date] || (person.days[date] = { minutes: 0, rows: 0 });
  person.week += minutes;
  day.minutes += minutes;
  day.rows += 1;
}

function schedUnbook_(ctx, name, date, minutes) {
  var person = ctx.ledger[name];
  var day = person.days[date];
  person.week -= minutes;
  day.minutes -= minutes;
  day.rows -= 1;
}

function schedWorksOn_(ctx, name, date) {
  var person = ctx.ledger[name];
  return !!(person && person.days[date] && person.days[date].rows > 0);
}

/* ------------------------------------------------------------------- result ------ */

function schedResult_(ctx, jobs) {
  var place = Object.create(null);
  ctx.active.forEach(function (person, index) {
    place[person.name] = index;
  });
  var placeOf = function (name) {
    if (!name) return Infinity; // uncovered rows come last within their day
    return name in place ? place[name] : ctx.active.length;
  };
  var rows = jobs
    .slice()
    .sort(function (a, b) {
      return (
        schedCompare_(a.row.date, b.row.date) ||
        schedCompare_(placeOf(a.row.name), placeOf(b.row.name)) ||
        b.score - a.score ||
        a.order - b.order ||
        schedCompare_(a.row.key, b.row.key)
      );
    })
    .map(function (job) {
      return job.row;
    });
  var everyone = ctx.locked.concat(rows);

  // Rule 11: Set staff get no shift times, even if a stray availability entry exists.
  var noShift = schedSet_(
    ctx.active
      .filter(function (person) {
        return !schedIsFlexible_(person);
      })
      .map(function (person) {
        return person.name;
      })
  );
  var shiftRows = everyone.filter(function (row) {
    return !noShift[row.name];
  });

  return {
    rows: rows,
    shifts: schedShifts(shiftRows, ctx.availability, ctx.weekOf),
    unfilled: rows.filter(function (row) {
      return !row.name;
    }),
    usage: schedUsage_(ctx, everyone),
  };
}

/** {Name: {minutes, wantedMinutes, byDate:{date:minutes}}}. wantedMinutes is null for Set staff and managers. */
function schedUsage_(ctx, rows) {
  var usage = {};
  ctx.active.forEach(function (person) {
    var wanted = null;
    if (schedIsFlexible_(person)) {
      var entry = ctx.availability[person.name];
      wanted = entry && !entry.none ? Number(entry.hoursWanted) * 60 || 0 : 0;
    }
    usage[person.name] = { minutes: 0, wantedMinutes: wanted, byDate: {} };
  });
  rows.forEach(function (row) {
    if (!row.name) return;
    var used = usage[row.name] || (usage[row.name] = { minutes: 0, wantedMinutes: null, byDate: {} });
    var minutes = schedMinutes_(row.minutes);
    used.minutes += minutes;
    used.byDate[row.date] = (used.byDate[row.date] || 0) + minutes;
  });
  return usage;
}

/* ------------------------------------------------------------- availability ------ */

/** {Mon:[9,10,11,14]} and 'Mon' -> [{start:9, end:12}, {start:14, end:15}]. */
function schedBlocks_(slots, dayKey) {
  var hours = ((slots && slots[dayKey]) || []).map(Number).sort(function (a, b) {
    return a - b;
  });
  var blocks = [];
  hours.forEach(function (hour) {
    var last = blocks[blocks.length - 1];
    if (last && hour <= last.end) last.end = Math.max(last.end, hour + 1);
    else blocks.push({ start: hour, end: hour + 1 });
  });
  return blocks;
}

/** The longest block that day, earliest on a tie. With nowMinutes, blocks already over don't count. */
function schedLargestBlock_(slots, dayKey, nowMinutes) {
  var best = null;
  schedBlocks_(slots, dayKey).forEach(function (block) {
    if (nowMinutes !== null && block.end * 60 <= nowMinutes) return;
    if (!best || block.end - block.start > best.end - best.start) best = block;
  });
  return best;
}

/* ------------------------------------------------------------------ helpers ------ */

function schedDateParts_(date) {
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!match) throw new Error('Not a YYYY-MM-DD date: ' + date);
  return [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
}

function schedAddDays_(date, days) {
  var parts = schedDateParts_(date);
  return new Date(Date.UTC(parts[0], parts[1], parts[2] + days)).toISOString().slice(0, 10);
}

function schedDayKey_(date) {
  var parts = schedDateParts_(date);
  var sundayFirst = new Date(Date.UTC(parts[0], parts[1], parts[2])).getUTCDay();
  return SCHED_DAYS_[(sundayFirst + 6) % 7];
}

function schedClock_(minutes) {
  var pad = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  return pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
}

function schedMinutes_(value) {
  return Math.max(0, Number(value) || 0);
}

function schedNowMinutes_(value) {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

function schedFlexDays_(task) {
  return Math.max(0, Math.floor(Number(task.flexDays) || 0));
}

function schedTaskOrder_(task) {
  var order = parseFloat(task.order);
  return isFinite(order) ? order : SCHED_NO_ORDER_;
}

function schedCompare_(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function schedSet_(list) {
  var set = Object.create(null);
  (list || []).forEach(function (item) {
    if (item) set[item] = true;
  });
  return set;
}

function schedIndex_(list) {
  var index = Object.create(null);
  (list || []).forEach(function (item) {
    index[item.id] = item;
  });
  return index;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { schedPriorityScore, schedBuildWeek, schedFillOpen, schedShifts };
}
