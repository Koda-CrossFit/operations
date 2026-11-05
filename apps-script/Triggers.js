/**
 * Triggers.js: the one automation, tick(), every 5 minutes (SPEC section 7).
 *
 * tick() first looks only at the clock and Script Properties. If nothing is due, it stops
 * there without opening the sheet. Each job is wrapped so one failure can't block the others.
 * Everything is idempotent: a step leaves a marker when it's done, and a mail step records
 * each person as it goes, so a crash picks up where it stopped with no repeat emails.
 */

function tick() {
  var info = nowInfo_();
  var props = PropertiesService.getScriptProperties();
  var markers = props.getProperties();
  if (!markers[PROP_SHEET_ID_]) return { ran: [], failed: [] }; // not set up yet
  if (!dueJobs_(info, markers).length) return { ran: [], failed: [] };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS_)) return { ran: [], failed: [], busy: true }; // the next tick will get it
  var ran = [];
  var failed = [];
  try {
    // Read again now that this tick has the lock: another one may have finished the job while this one waited.
    dueJobs_(info, PropertiesService.getScriptProperties().getProperties()).forEach(function (job) {
      resetRequestCache_();
      try {
        job.run();
        ran.push(job.name);
      } catch (err) {
        failed.push(job.name);
        noteJobFailure_(job.name, err);
      }
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ran: ran, failed: failed };
}

/** What's due, from the clock and the markers alone. */
function dueJobs_(info, markers) {
  var jobs = [];
  if (markers[PROP_NIGHTLY_] !== info.date && info.stamp.slice(11) >= NIGHTLY_TIME_) {
    jobs.push({
      name: 'nightly',
      run: function () {
        nightlyRoll_();
        setProp_(PROP_NIGHTLY_, info.date);
      },
    });
  }
  var weekOf = nextMonday_(info.date);
  if (!markers[weekMarker_(weekOf, 'DONE')] && pastDeadline_(weekOf, info)) {
    jobs.push({
      name: 'weekly',
      run: function () {
        weeklyRun_(weekOf);
      },
    });
  }
  // Thursday afternoon, up until the deadline itself.
  var headsUpAt = addDays_(weekOf, -4) + ' ' + HEADS_UP_TIME_;
  if (!markers[PROP_THURSDAY_PREFIX_ + weekOf] && !isHeld_(weekOf) && info.stamp >= headsUpAt && !pastDeadline_(weekOf, info)) {
    jobs.push({
      name: 'heads-up',
      run: function () {
        headsUpRun_(weekOf);
      },
    });
  }
  if (markers[PROP_MONTHLY_] !== info.month && info.stamp >= info.month + '-01 ' + MONTHLY_TIME_) {
    jobs.push({
      name: 'monthly',
      run: function () {
        monthlyRun_(info);
      },
    });
  }
  return jobs;
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

function weekMarker_(weekOf, step) {
  return PROP_WEEK_PREFIX_ + weekOf + '_' + step;
}

/** One email per job per hour, however many ticks in a row it fails. */
function noteJobFailure_(job, err) {
  console.error('The ' + job + ' job failed: ' + ((err && err.stack) || err));
  try {
    log_('system', 'job failed', job + ': ' + ((err && err.message) || err));
    var cache = CacheService.getScriptCache();
    var key = 'job_alert_' + job;
    if (cache.get(key)) return;
    cache.put(key, '1', JOB_ALERT_SECONDS_);
    mailJobFailed_(job, err);
  } catch (alertErr) {
    console.error('Could not report the failure: ' + alertErr);
  }
}

/** Runs a step unless its marker is already set. */
function runStep_(weekOf, step, work) {
  var props = PropertiesService.getScriptProperties();
  var key = weekMarker_(weekOf, step);
  if (props.getProperty(key)) return;
  work();
  props.setProperty(key, '1');
}

/**
 * Sends to each person once, recording them as it goes, so a crash in the middle of a list
 * doesn't email the first half twice. A bad address is noted and skipped, so one bad cell
 * can't stop everyone else's email. Any other error stops the job, and the next tick resumes.
 */
function sendToEach_(sentKey, people, send) {
  var props = PropertiesService.getScriptProperties();
  var sent = JSON.parse(props.getProperty(sentKey) || '[]');
  people.forEach(function (person) {
    if (sent.indexOf(person.name) >= 0) return;
    try {
      send(person);
    } catch (err) {
      if (!/invalid email/i.test(String((err && err.message) || err))) throw err;
      log_('system', 'email not sent', 'Bad address for ' + person.name);
    }
    sent.push(person.name);
    props.setProperty(sentKey, JSON.stringify(sent));
  });
}

/* ---------------------------------------------------------- the Friday 7 AM run ---- */

function weeklyRun_(weekOf) {
  var props = PropertiesService.getScriptProperties();
  var firstWeek = dateString_(settings_().first_week);
  if (firstWeek && weekOf < firstWeek) {
    props.setProperty(weekMarker_(weekOf, 'DONE'), 'skipped');
    return;
  }

  runWeekBuild_(weekOf); // has its own check, so it won't build twice

  runStep_(weekOf, 'MISSED', function () {
    sendToEach_(weekMarker_(weekOf, 'MISSED_SENT'), missingAvailability_(weekOf), function (person) {
      mailMissedDeadline_(person, weekOf);
    });
  });

  runStep_(weekOf, 'PEOPLE', function () {
    sendToEach_(weekMarker_(weekOf, 'PEOPLE_SENT'), activeStaff_(), function (person) {
      sendWeekEmail_(person, weekOf);
    });
  });

  runStep_(weekOf, 'SUMMARY', function () {
    mailManagerSummary_(weekOf);
  });

  props.setProperty(weekMarker_(weekOf, 'DONE'), '1');
  ['MISSED', 'MISSED_SENT', 'PEOPLE', 'PEOPLE_SENT', 'SUMMARY'].forEach(function (step) {
    props.deleteProperty(weekMarker_(weekOf, step));
  });
  log_('system', 'weekly run done', 'Week of ' + weekOf);
}

/** Anyone with work gets their week. Someone who offered time and got nothing gets a short note. "Can't work" or no answer gets nothing. */
function sendWeekEmail_(person, weekOf) {
  var hasWork = scheduleForWeek_(weekOf).some(function (row) {
    return row.name === person.name;
  });
  if (hasWork) {
    mailYourWeek_(person, weekOf);
    return;
  }
  if (person.type !== 'Flexible') return;
  var availability = availabilityRow_(person.name, weekOf);
  if (availability && !availability.none) mailNothingThisWeek_(person, weekOf);
}

/** The Thursday heads-up: only when Settings.thursday_heads_up is TRUE. */
function headsUpRun_(weekOf) {
  var key = PROP_THURSDAY_PREFIX_ + weekOf;
  var firstWeek = dateString_(settings_().first_week);
  if (!isTrue_(settings_().thursday_heads_up) || (firstWeek && weekOf < firstWeek)) {
    setProp_(key, 'skipped');
    return;
  }
  sendToEach_(key + '_SENT', missingAvailability_(weekOf), function (person) {
    mailHeadsUp_(person, weekOf);
  });
  setProp_(key, '1');
  PropertiesService.getScriptProperties().deleteProperty(key + '_SENT');
}

/* ----------------------------------------------------------------- the nightly ---- */

/** The first day from this one that isn't closed. */
function nextOpenDate_(date) {
  var candidate = date;
  for (var i = 0; i < 14 && closedNote_(candidate); i++) candidate = addDays_(candidate, 1);
  return candidate;
}

/** Can this person keep a rolled row on this date? "Same person if they have availability today." */
function canWorkOn_(name, date) {
  if (isAway_(name, date) || closedNote_(date)) return false;
  var person = personNamed_(name);
  if (!person || !person.active) return false;
  if (person.type === 'Set') return person.setDays.indexOf(dayKey_(date)) >= 0;
  if (person.type !== 'Flexible') return true;
  var availability = availabilityRow_(name, mondayOf_(date));
  return !!availability && !availability.none && (availability.slots[dayKey_(date)] || []).length > 0;
}

/**
 * For each open row dated before today: a daily task is missed. A one-off rolls to today.
 * Any other task rolls too, unless the same task already has a row today or tomorrow,
 * which makes this one missed. Newest first, so only the latest of several carries forward.
 * A task in NO_ROLL_TASKS_ never rolls: it's missed where it is, and the managers get an email.
 */
function nightlyRoll_() {
  var info = nowInfo_();
  var rows = scheduleRows_();
  var before = rows
    .filter(function (row) {
      return row.status === 'open' && row.date < info.date;
    })
    .sort(function (a, b) {
      return compareText_(b.date, a.date);
    });

  if (before.length) {
    var tasks = taskIndex_();
    var rollTo = nextOpenDate_(info.date); // when today is closed, the next day the gym is open
    var dayAfter = addDays_(rollTo, 1);
    var hasRow = Object.create(null);
    rows.forEach(function (row) {
      if (row.taskId && (row.date === rollTo || row.date === dayAfter)) hasRow[row.taskId] = true;
    });

    var missed = [];
    var rolling = [];
    before.forEach(function (row) {
      if (row.oneOffId) {
        rolling.push(row);
        return;
      }
      var task = tasks[row.taskId];
      var isDaily = task && /^daily$/i.test(task.cadence);
      if (!task || !task.active || isDaily || staysPut_(row) || hasRow[row.taskId]) {
        missed.push(row);
        return;
      }
      hasRow[row.taskId] = true;
      rolling.push(row);
    });

    missed.forEach(function (row) {
      updateRow_(TABS_.SCHEDULE, row._row, { Status: 'missed' });
    });
    var notDone = missed.filter(staysPut_);
    if (notDone.length) {
      bestEffort_('not done alert', function () {
        return mailManagerNotDone_(notDone);
      });
    }
    rollRows_(rolling, rollTo, info);
    rewriteShiftsFor_(
      before
        .map(function (row) {
          return row.date;
        })
        .concat(rollTo)
    );
    log_('system', 'nightly roll', missed.length + ' missed, ' + rolling.length + ' rolled to ' + rollTo);
  }

  flagMissingClockOuts_(info);
}

function staysPut_(row) {
  return NO_ROLL_TASKS_.indexOf(row.taskId) >= 0;
}

/** Same person if they can work that day, else schedFillOpen. Every rolled row becomes source carry and keeps Rolled From. */
function rollRows_(rolling, rollTo, info) {
  if (!rolling.length) return;
  var stay = [];
  var open = [];
  rolling.forEach(function (row) {
    if (row.name && canWorkOn_(row.name, rollTo)) stay.push(row);
    else open.push(row);
  });

  stay.forEach(function (row) {
    updateRow_(TABS_.SCHEDULE, row._row, { Date: rollTo, Day: dayKey_(rollTo), 'Week Of': mondayOf_(rollTo), Source: 'carry', 'Rolled From': row.rolledFrom || row.date });
  });
  moveOneOffsToWeek_(stay, mondayOf_(rollTo));

  if (open.length) {
    var weekOf = mondayOf_(rollTo);
    moveOneOffsToWeek_(open, weekOf); // first, so the one-off is in the list matching reads
    var opening = Object.create(null);
    open.forEach(function (row) {
      opening[row.id] = true;
    });
    var input = matchInput_(weekOf);
    input.open = open.map(function (row) {
      return openRow_(row, { date: rollTo, day: dayKey_(rollTo), source: 'carry', rolledFrom: row.rolledFrom || row.date });
    });
    input.locked = scheduleForWeek_(weekOf)
      .filter(function (row) {
        return row.name && !opening[row.id];
      })
      .map(rowForScheduler_);
    saveFilledRows_(schedFillOpen(input).rows);
    if (info.date !== rollTo) log_('system', 'nightly roll', 'Today is closed, so rows rolled to ' + rollTo);
  }
}

/** A one-off belongs to the week it's in now, so the board and matching can find it there. */
function moveOneOffsToWeek_(rows, weekOf) {
  rows.forEach(function (row) {
    if (!row.oneOffId) return;
    var item = oneOffNamed_(row.oneOffId);
    if (item && item.weekOf !== weekOf) updateRow_(TABS_.ONE_OFFS, item._row, { 'Week Of': weekOf });
  });
}

/** Any entry from before today with no Out, unless it's a shift still running past midnight. */
function flagMissingClockOuts_(info) {
  var changed = 0;
  hoursRows_().forEach(function (entry) {
    if (!entry.outAt && entry.date < info.date && entry.flag !== 'missing' && !entryRunning_(entry, info.now)) {
      updateRow_(TABS_.HOURS, entry._row, { Flag: 'missing' });
      changed++;
    }
  });
  if (changed) log_('system', 'missing clock-outs flagged', String(changed));
}

/* ------------------------------------------------------------------ the monthly ---- */

/** Last month's totals, once. A month from before the site's first week has nothing to report. */
function monthlyRun_(info) {
  var month = prevMonth_(info.month);
  var firstWeek = dateString_(settings_().first_week);
  if (!firstWeek || month >= monthOf_(firstWeek)) mailMonthlyHours_(month);
  setProp_(PROP_MONTHLY_, info.month);
}
