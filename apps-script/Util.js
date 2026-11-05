/**
 * Util.js: the clock, dates, cell cleaning, and reading and writing the sheet.
 *
 * Time rules for the whole app:
 * - Now_() is the only source of the current time.
 * - A calendar day is a 'YYYY-MM-DD' string. All day and week math runs on those strings
 *   through UTC, so daylight saving can't move a day.
 * - A moment is a Date. The only way between the two is Denver wall-clock time, through
 *   denver_() and wallToDate_().
 */

/* ------------------------------------------------------------------ the clock ---- */

/** The current time. The dev server sets the global __NOW__ to pretend it's another moment. */
function Now_() {
  if (typeof __NOW__ !== 'undefined' && __NOW__) return new Date(__NOW__);
  return new Date();
}

function denver_(date, pattern) {
  return Utilities.formatDate(date, TZ_, pattern);
}

/** Everything anyone needs to know about "now", in Denver. `stamp` sorts as text, so deadlines compare directly. */
function nowInfo_() {
  var now = Now_();
  var stamp = denver_(now, 'yyyy-MM-dd HH:mm');
  var date = stamp.slice(0, 10);
  var hour = Number(stamp.slice(11, 13));
  var minute = Number(stamp.slice(14, 16));
  return {
    now: now,
    stamp: stamp,
    date: date,
    day: dayKey_(date),
    hour: hour,
    minute: minute,
    minutes: hour * 60 + minute,
    monday: mondayOf_(date),
    month: date.slice(0, 7),
  };
}

/** Denver's offset from UTC at this moment, in milliseconds. */
function offsetMs_(date) {
  var zone = denver_(date, 'Z'); // '-0700'
  var minutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5));
  return (zone.charAt(0) === '-' ? -minutes : minutes) * 60000;
}

/** The moment Denver's clocks read this date and 'HH:MM'. Works out the offset twice, since a guess can land across a clock change. */
function wallToDate_(date, time) {
  var parts = dateParts_(date);
  var clock = String(time).split(':');
  var asUtc = Date.UTC(parts[0], parts[1] - 1, parts[2], Number(clock[0]), Number(clock[1]));
  var first = asUtc - offsetMs_(new Date(asUtc));
  return new Date(asUtc - offsetMs_(new Date(first)));
}

/* ------------------------------------------------------------------ day math ---- */

function dateParts_(date) {
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!match) throw new Error('Not a YYYY-MM-DD date: ' + date);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function utcOf_(date) {
  var parts = dateParts_(date);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function isDateString_(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  return new Date(utcOf_(value)).toISOString().slice(0, 10) === value; // rejects 2026-02-31
}

function addDays_(date, days) {
  return new Date(utcOf_(date) + days * 86400000).toISOString().slice(0, 10);
}

function daysBetween_(from, to) {
  return Math.round((utcOf_(to) - utcOf_(from)) / 86400000);
}

function dayKey_(date) {
  return DAY_KEYS_[(new Date(utcOf_(date)).getUTCDay() + 6) % 7];
}

function mondayOf_(date) {
  return addDays_(date, -DAY_KEYS_.indexOf(dayKey_(date)));
}

/** The first Monday strictly after this date. */
function nextMonday_(date) {
  return addDays_(mondayOf_(date), 7);
}

function weekDates_(weekOf) {
  return DAY_KEYS_.map(function (_, index) {
    return addDays_(weekOf, index);
  });
}

function monthOf_(date) {
  return String(date).slice(0, 7);
}

function prevMonth_(month) {
  var year = Number(month.slice(0, 4));
  var index = Number(month.slice(5, 7));
  if (index === 1) return year - 1 + '-12';
  return year + '-' + pad2_(index - 1);
}

function pad2_(number) {
  return (number < 10 ? '0' : '') + number;
}

/** When week W closes: the Friday before it at 7:00 AM, as a stamp to compare with nowInfo_().stamp. */
function deadlineStamp_(weekOf) {
  return addDays_(weekOf, -3) + ' ' + DEADLINE_TIME_;
}

function pastDeadline_(weekOf, info) {
  return info.stamp >= deadlineStamp_(weekOf);
}

/* ------------------------------------------------------------------- labels ---- */

/** 'Tuesday, November 10' */
function longDayLabel_(date) {
  var parts = dateParts_(date);
  return DAY_NAMES_[dayKey_(date)] + ', ' + MONTH_NAMES_[parts[1] - 1] + ' ' + parts[2];
}

/** 'Nov 12' */
function monthDay_(date) {
  var parts = dateParts_(date);
  return MONTH_NAMES_[parts[1] - 1].slice(0, 3) + ' ' + parts[2];
}

/** 'Thu, Nov 12' */
function dayLabel_(date) {
  return dayKey_(date) + ', ' + monthDay_(date);
}

/** 'Nov 12', 'Nov 16 - 22' or 'Nov 30 - Dec 6' */
function rangeLabel_(from, to) {
  if (!to || to === from) return monthDay_(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return monthDay_(from) + ' - ' + dateParts_(to)[2];
  return monthDay_(from) + ' - ' + monthDay_(to);
}

function weekLabel_(weekOf) {
  return rangeLabel_(weekOf, addDays_(weekOf, 6));
}

/** 'Fri, Nov 13 at 7:00 AM' */
function deadlineLabel_(weekOf) {
  return dayLabel_(addDays_(weekOf, -3)) + ' at ' + clockLabel_(DEADLINE_TIME_);
}

/** '2026-11' -> 'November' */
function monthName_(month) {
  return MONTH_NAMES_[Number(month.slice(5, 7)) - 1];
}

/** '2026-11' -> 'November 2026' */
function monthYearLabel_(month) {
  return monthName_(month) + ' ' + month.slice(0, 4);
}

/** '09:00' -> '9:00 AM' */
function clockLabel_(time) {
  var clock = String(time).split(':');
  var hour = Number(clock[0]);
  return ((hour + 11) % 12) + 1 + ':' + clock[1] + ' ' + (hour < 12 ? 'AM' : 'PM');
}

/** A moment -> '9:02 AM' in Denver. */
function timeLabel_(date) {
  return date ? clockLabel_(denver_(date, 'HH:mm')) : '';
}

/** A moment -> 'Thu, Nov 12 at 3:14 PM' in Denver. */
function stampLabel_(date) {
  return date ? dayLabel_(denver_(date, 'yyyy-MM-dd')) + ' at ' + timeLabel_(date) : '';
}

/* -------------------------------------------------------------- cleaning text ---- */

/** A leading = + - @ gets an apostrophe, so nothing a person types can ever run as a formula. */
function safeCell_(value) {
  var text = String(value);
  return /^\s*[=+\-@]/.test(text) ? "'" + text : text;
}

/** The reverse, for a sheet that kept the apostrophe as part of the text. */
function unsafeCell_(value) {
  return typeof value === 'string' && /^'\s*[=+\-@]/.test(value) ? value.slice(1) : value;
}

function text_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** One clean line of text from a person, cut to the limit. */
function cleanText_(value, max) {
  return text_(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function esc_(value) {
  return text_(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isTrue_(value) {
  return value === true || /^(true|yes|1)$/i.test(text_(value));
}

/** Only a clear "no" turns someone or something off, so a blank cell stays active. */
function isActive_(value) {
  return value !== false && !/^(false|no|0|inactive)$/i.test(text_(value));
}

function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

/** Anything from a date column -> 'YYYY-MM-DD', or '' when it isn't a date. */
function dateString_(value) {
  if (isDate_(value)) return denver_(value, 'yyyy-MM-dd');
  var cleaned = text_(unsafeCell_(value));
  if (isDateString_(cleaned)) return cleaned;
  // Typed by hand: 12/25/2026, 12/25/26, 12/25, Dec 25 or December 25, 2026.
  var slashes = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(cleaned);
  var words = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(cleaned);
  var monthNumber = slashes ? Number(slashes[1]) : words ? monthFromName_(words[1]) : 0;
  if (!monthNumber) return '';
  var day = Number(slashes ? slashes[2] : words[2]);
  var year = slashes ? slashes[3] : words[3];
  return typedDate_(year, monthNumber, day);
}

/** 1 for 'Jan' or 'jan', 0 when it isn't a month. */
function monthFromName_(word) {
  var lower = word.toLowerCase();
  for (var i = 0; i < MONTH_NAMES_.length; i++) {
    if (MONTH_NAMES_[i].slice(0, 3).toLowerCase() === lower) return i + 1;
  }
  return 0;
}

/** With no year it means this year, or next year if that date is more than six months gone: 1/1 typed in December is next month. */
function typedDate_(year, month, day) {
  var today = nowInfo_().date;
  var fullYear = !year ? Number(today.slice(0, 4)) : year.length === 2 ? 2000 + Number(year) : Number(year);
  var built = fullYear + '-' + pad2_(month) + '-' + pad2_(day);
  if (!isDateString_(built)) return '';
  if (!year && daysBetween_(built, today) > 183) return typedDate_(String(fullYear + 1), month, day);
  return built;
}

/** Anything from a time column -> 'HH:MM', or ''. */
function timeString_(value) {
  if (isDate_(value)) return denver_(value, 'HH:mm');
  var match = /^(\d{1,2}):(\d{2})/.exec(text_(value));
  return match ? pad2_(Number(match[1])) + ':' + match[2] : '';
}

/** A moment from a cell, or null. */
function toDate_(value) {
  if (isDate_(value)) return value;
  if (value === '' || value === null || value === undefined) return null;
  var parsed = new Date(value);
  return isDate_(parsed) ? parsed : null;
}

function parseList_(value) {
  if (Array.isArray(value)) return value.map(text_).filter(Boolean);
  return text_(value)
    .split(',')
    .map(text_)
    .filter(Boolean);
}

/** 'Thu, Fri, Sun', 'Mon-Sat', 'Thursdays and Fridays' -> ['Thu', 'Fri', 'Sun'], in week order. */
function parseDays_(value) {
  var found = Object.create(null);
  var pattern = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s*(?:-|–|to|through)\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*)?/gi;
  var key = function (word) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  };
  var match;
  while ((match = pattern.exec(text_(value)))) {
    var from = DAY_KEYS_.indexOf(key(match[1]));
    var to = match[2] ? DAY_KEYS_.indexOf(key(match[2])) : from;
    for (var i = from; i !== to; i = (i + 1) % 7) found[DAY_KEYS_[i]] = true; // Sat-Mon wraps around the week
    found[DAY_KEYS_[to]] = true;
  }
  return DAY_KEYS_.filter(function (day) {
    return found[day];
  });
}

/** 'T08, T14@Tue' -> [{taskId:'T08', days:null}, {taskId:'T14', days:['Tue']}] */
function parseSetTasks_(value) {
  return parseList_(value).map(function (item) {
    var parts = item.split('@');
    var days = parts[1] ? parseDays_(parts[1]) : [];
    return { taskId: text_(parts[0]), days: days.length ? days : null };
  });
}

/** 'Mon:9,10,11;Wed:16,17' -> {Mon:[9,10,11], Wed:[16,17]} */
function parseSlots_(value) {
  var slots = {};
  text_(value)
    .split(';')
    .forEach(function (part) {
      var bits = part.split(':');
      var day = text_(bits[0]);
      if (DAY_KEYS_.indexOf(day) < 0 || !bits[1]) return;
      var hours = bits[1]
        .split(',')
        .map(function (hour) {
          return parseInt(hour, 10);
        })
        .filter(function (hour) {
          return isFinite(hour);
        });
      if (hours.length) slots[day] = hours;
    });
  return slots;
}

function slotsToText_(slots) {
  return DAY_KEYS_.filter(function (day) {
    return slots[day] && slots[day].length;
  })
    .map(function (day) {
      return day + ':' + slots[day].join(',');
    })
    .join(';');
}

/** {Mon:[9,10,11], Wed:[16,17]} -> 'Mon 9 AM-12 PM; Wed 4-6 PM' */
function slotsReadable_(slots) {
  return DAY_KEYS_.filter(function (day) {
    return slots[day] && slots[day].length;
  })
    .map(function (day) {
      return day + ' ' + hourBlocks_(slots[day]).map(hourRangeLabel_).join(', ');
    })
    .join('; ');
}

function hourBlocks_(hours) {
  var blocks = [];
  hours
    .slice()
    .sort(function (a, b) {
      return a - b;
    })
    .forEach(function (hour) {
      var last = blocks[blocks.length - 1];
      if (last && hour === last.end) last.end = hour + 1;
      else blocks.push({ start: hour, end: hour + 1 });
    });
  return blocks;
}

function hourRangeLabel_(block) {
  var noon = function (hour) {
    return hour < 12 ? 'AM' : 'PM';
  };
  var number = function (hour) {
    return ((hour + 11) % 12) + 1;
  };
  if (noon(block.start) === noon(block.end)) return number(block.start) + '-' + number(block.end) + ' ' + noon(block.end);
  return number(block.start) + ' ' + noon(block.start) + '-' + number(block.end) + ' ' + noon(block.end);
}

function firstName_(name) {
  return text_(name).split(/\s+/)[0];
}

function newId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

/* ----------------------------------------------------------------- errors ---- */

/** Stops a request with a sentence a person can read. */
function fail_(message) {
  var error = new Error(message);
  error.userFacing = true;
  throw error;
}

/**
 * What the page gets to see: our own sentences, or a plain apology. Never a stack trace.
 * retry:true means the request itself was fine and trying it again could work, so the
 * page's queue of saved taps keeps it. Without it, the answer is no, and it can stop asking.
 */
function errorReply_(err) {
  if (err && err.userFacing) return err.retry ? { ok: false, error: err.message, retry: true } : { ok: false, error: err.message };
  var message = String((err && err.message) || err);
  if (/^Not a YYYY-MM-DD date/.test(message)) return { ok: false, error: "That date doesn't look right. Please pick it again." };
  console.error((err && err.stack) || err);
  return { ok: false, error: 'Something went wrong on our end. Please try again.', retry: true };
}

/* ----------------------------------------------------------- reading the sheet ---- */

var REQ_ = null; // what this run has already read. Apps Script starts every run empty; dev doesn't, so entry points reset it.

function resetRequestCache_() {
  REQ_ = { book: null, sheets: {}, headers: {}, tabs: {}, typed: {} };
}

function req_() {
  if (!REQ_) resetRequestCache_();
  return REQ_;
}

function book_() {
  var cache = req_();
  if (!cache.book) {
    var id = PropertiesService.getScriptProperties().getProperty(PROP_SHEET_ID_);
    if (!id) fail_("The site isn't set up yet.");
    cache.book = SpreadsheetApp.openById(id);
  }
  return cache.book;
}

function sheet_(tab) {
  var cache = req_();
  if (!cache.sheets[tab]) {
    var sheet = book_().getSheetByName(tab);
    if (!sheet) fail_('The "' + tab + '" tab is missing from the sheet. Please run setup again.');
    cache.sheets[tab] = sheet;
  }
  return cache.sheets[tab];
}

/** The headers as they are in the sheet right now, so columns can be moved or added freely. */
function headersOf_(tab) {
  var cache = req_();
  if (!cache.headers[tab]) {
    var sheet = sheet_(tab);
    var width = Math.max(sheet.getLastColumn(), 1);
    cache.headers[tab] = sheet.getRange(1, 1, 1, width).getValues()[0].map(text_);
  }
  return cache.headers[tab];
}

function columnKind_(map, tab, header) {
  return !!(map[tab] && map[tab].indexOf(header) >= 0);
}

/** Rows as objects by header name, each with a `_row` number. Blank rows are skipped. */
function readTab_(tab) {
  var cache = req_();
  if (cache.tabs[tab]) return cache.tabs[tab];
  var sheet = sheet_(tab);
  var lastRow = sheet.getLastRow();
  var rows = [];
  if (lastRow >= 2) {
    var headers = headersOf_(tab);
    var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    values.forEach(function (cells, index) {
      var row = { _row: index + 2 };
      var blank = true;
      headers.forEach(function (header, column) {
        if (!header) return;
        var value = unsafeCell_(cells[column]);
        if (columnKind_(DATE_COLUMNS_, tab, header)) value = dateString_(value);
        else if (columnKind_(TIME_COLUMNS_, tab, header)) value = timeString_(value);
        if (value !== '') blank = false;
        row[header] = value;
      });
      if (!blank) rows.push(row);
    });
  }
  cache.tabs[tab] = rows;
  return rows;
}

/** A row typed into the sheet by hand has no ID yet, and still has to count. */
function rowId_(row) {
  return text_(row['ID']) || 'row-' + row._row;
}

/** Runs a tab through its mapper once per run. Any write to the tab forgets the result. */
function typed_(tab, build) {
  var cache = req_();
  if (!cache.typed[tab]) cache.typed[tab] = build(readTab_(tab));
  return cache.typed[tab];
}

/* ----------------------------------------------------------- writing the sheet ---- */

function invalidate_(tab) {
  var cache = req_();
  delete cache.tabs[tab];
  delete cache.typed[tab];
}

/** Every value headed for a cell comes through here, so nothing can be written unsafely by accident. */
function toCell_(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? safeCell_(value) : value;
}

function columnFormat_(tab, header) {
  return (COLUMN_FORMATS_[tab] && COLUMN_FORMATS_[tab][header]) || '';
}

/** Adds rows from objects by header name. Sets formats first, so Sheets can't reinterpret the values. Returns the first new row number. */
function appendRows_(tab, objects) {
  if (!objects.length) return 0;
  var sheet = sheet_(tab);
  var headers = headersOf_(tab);
  var start = sheet.getLastRow() + 1;
  var lastNeeded = start + objects.length - 1;
  if (lastNeeded > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), lastNeeded - sheet.getMaxRows());
  headers.forEach(function (header, column) {
    var format = columnFormat_(tab, header);
    if (format) sheet.getRange(start, column + 1, objects.length, 1).setNumberFormat(format);
  });
  sheet.getRange(start, 1, objects.length, headers.length).setValues(
    objects.map(function (object) {
      return headers.map(function (header) {
        return toCell_(object[header]);
      });
    })
  );
  invalidate_(tab);
  return start;
}

/** Changes the named cells of one row. */
function updateRow_(tab, row, fields) {
  var sheet = sheet_(tab);
  var headers = headersOf_(tab);
  Object.keys(fields).forEach(function (header) {
    var column = headers.indexOf(header) + 1;
    if (!column) return;
    var range = sheet.getRange(row, column);
    var format = columnFormat_(tab, header);
    if (format) range.setNumberFormat(format);
    range.setValue(toCell_(fields[header]));
  });
  invalidate_(tab);
}

/** Removes rows, bottom up so the numbers stay right. Sheets refuses to delete every unfrozen row, so a spare goes in first. */
function deleteRows_(tab, rowNumbers) {
  if (!rowNumbers.length) return;
  var sheet = sheet_(tab);
  var rows = rowNumbers.slice().sort(function (a, b) {
    return b - a;
  });
  if (rows.length >= sheet.getMaxRows() - sheet.getFrozenRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  var i = 0;
  while (i < rows.length) {
    var count = 1;
    while (i + count < rows.length && rows[i + count] === rows[i] - count) count++;
    sheet.deleteRows(rows[i] - count + 1, count);
    i += count;
  }
  invalidate_(tab);
}

function columnLetter_(column) {
  var letters = '';
  var number = column;
  while (number > 0) {
    var rest = (number - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    number = (number - rest - 1) / 26;
  }
  return letters;
}

/** Every write leaves a line here. A failure to log never undoes the write it describes. */
function log_(who, action, details) {
  try {
    appendRows_(TABS_.LOG, [{ Time: Now_(), Who: cleanText_(who, MAX_NAME_), Action: cleanText_(action, MAX_TITLE_), Details: cleanText_(details, MAX_TEXT_) }]);
  } catch (err) {
    console.error('Could not write to the Log tab: ' + err);
  }
}

/* -------------------------------------------------------------- the tabs, typed ---- */

function compareText_(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Best rank first, then by name. Managers have no rank, so they come last. */
function compareStaff_(a, b) {
  var rankA = a.rank === null ? Infinity : a.rank;
  var rankB = b.rank === null ? Infinity : b.rank;
  return rankA === rankB ? compareText_(a.name, b.name) : rankA - rankB;
}

function normalType_(value) {
  var type = text_(value).toLowerCase();
  if (type === 'set') return 'Set';
  if (type === 'manager') return 'Manager';
  return 'Flexible';
}

/** Everyone in the Staff tab, by rank: active a real boolean, set days and tasks parsed. */
function staff_() {
  return typed_(TABS_.STAFF, function (rows) {
    return rows
      .map(function (row) {
        var rank = parseFloat(row['Rank']);
        return {
          rank: isFinite(rank) ? rank : null,
          name: text_(row['Name']),
          email: text_(row['Email']),
          type: normalType_(row['Type']),
          setDays: parseDays_(row['Set Days']),
          setTasks: parseSetTasks_(row['Set Tasks']),
          active: isActive_(row['Active']),
          notes: text_(row['Notes']),
          _row: row._row,
        };
      })
      .filter(function (person) {
        return person.name;
      })
      .sort(compareStaff_);
  });
}

function activeStaff_() {
  return staff_().filter(function (person) {
    return person.active;
  });
}

function personNamed_(name) {
  var lower = text_(name).toLowerCase();
  return (
    staff_().filter(function (person) {
      return person.name.toLowerCase() === lower;
    })[0] || null
  );
}

/** 'Set' means only set staff unless covering. Mon-Sat and the word Daily both read as the full list. */
function tasks_() {
  return typed_(TABS_.TASKS, function (rows) {
    return rows
      .map(function (row, index) {
        var days = text_(row['Days']);
        var setOnly = /^set$/i.test(days);
        return {
          id: text_(row['ID']),
          title: text_(row['Task']),
          details: text_(row['Details']),
          cadence: text_(row['How Frequent']),
          priority: text_(row['Priority']),
          minutes: Number(row['Minutes']) || 0,
          days: setOnly ? [] : /^daily$/i.test(days) ? parseDays_('Mon-Sat') : parseDays_(days),
          setOnly: setOnly,
          flexDays: Math.max(0, parseInt(row['Flex Days'], 10) || 0),
          active: isActive_(row['Active']),
          order: index + 1,
        };
      })
      .filter(function (task) {
        return task.id;
      });
  });
}

function taskIndex_() {
  var index = Object.create(null);
  tasks_().forEach(function (task) {
    index[task.id] = task;
  });
  return index;
}

function oneOffs_() {
  return typed_(TABS_.ONE_OFFS, function (rows) {
    return rows
      .map(function (row) {
        return {
          id: rowId_(row),
          added: toDate_(row['Added']),
          addedBy: text_(row['Added By']),
          title: text_(row['Task']),
          details: text_(row['Details']),
          priority: text_(row['Priority']),
          minutes: Number(row['Minutes']) || 0,
          weekOf: row['Week Of'],
          day: text_(row['Day']),
          who: parseList_(row['Who']),
          status: text_(row['Status']).toLowerCase() || 'open',
          doneBy: text_(row['Done By']),
          doneAt: toDate_(row['Done At']),
          _row: row._row,
        };
      })
      .filter(function (item) {
        return item.title;
      });
  });
}

function availabilityRows_() {
  return typed_(TABS_.AVAILABILITY, function (rows) {
    return rows
      .map(function (row) {
        return {
          weekOf: row['Week Of'],
          name: text_(row['Name']),
          submittedAt: toDate_(row['Submitted At']),
          late: isTrue_(row['Late']),
          none: isTrue_(row['None']),
          hoursWanted: Number(row['Hours Wanted']) || 0,
          slots: parseSlots_(row['Slots']),
          readable: text_(row['Readable']),
          notes: text_(row['Notes']),
          _row: row._row,
        };
      })
      .filter(function (row) {
        return row.name && row.weekOf;
      });
  });
}

function availabilityRow_(name, weekOf) {
  return (
    availabilityRows_().filter(function (row) {
      return row.name === name && row.weekOf === weekOf;
    })[0] || null
  );
}

/** What matching needs: {Ana:{none, hoursWanted, slots}}. Only Flexible people, as SPEC section 2 says, so a stray row can't give a Set person a shift. */
function availabilityMap_(weekOf) {
  var flexible = Object.create(null);
  staff_().forEach(function (person) {
    if (person.type === 'Flexible') flexible[person.name] = true;
  });
  var map = {};
  availabilityRows_().forEach(function (row) {
    if (row.weekOf === weekOf && flexible[row.name]) map[row.name] = { none: row.none, hoursWanted: row.hoursWanted, slots: row.slots };
  });
  return map;
}

function timeOffRows_() {
  return typed_(TABS_.TIME_OFF, function (rows) {
    return rows
      .map(function (row) {
        return {
          id: rowId_(row),
          name: text_(row['Name']),
          from: row['From'],
          to: row['To'] || row['From'],
          note: text_(row['Note']),
          addedAt: toDate_(row['Added At']),
          status: text_(row['Status']).toLowerCase() || 'active',
          _row: row._row,
        };
      })
      .filter(function (row) {
        return row.name && row.from;
      });
  });
}

function isAway_(name, date) {
  return timeOffRows_().some(function (off) {
    return off.name === name && off.status !== 'cancelled' && off.from <= date && date <= off.to;
  });
}

function scheduleRows_() {
  return typed_(TABS_.SCHEDULE, function (rows) {
    return rows
      .map(function (row) {
        return {
          id: rowId_(row),
          weekOf: row['Week Of'],
          date: row['Date'],
          day: row['Date'] ? dayKey_(row['Date']) : '',
          name: text_(row['Name']),
          taskId: text_(row['Task ID']),
          oneOffId: text_(row['One-Off ID']),
          title: text_(row['Task']),
          details: text_(row['Details']),
          priority: text_(row['Priority']),
          minutes: Number(row['Minutes']) || 0,
          source: text_(row['Source']).toLowerCase() || 'auto',
          status: text_(row['Status']).toLowerCase() || 'open',
          doneAt: toDate_(row['Done At']),
          doneBy: text_(row['Done By']),
          note: text_(row['Note']),
          rolledFrom: row['Rolled From'],
          _row: row._row,
        };
      })
      .filter(function (row) {
        return row.date;
      });
  });
}

function scheduleForWeek_(weekOf) {
  var end = addDays_(weekOf, 6);
  return scheduleRows_().filter(function (row) {
    return row.date >= weekOf && row.date <= end;
  });
}

function shiftRows_() {
  return typed_(TABS_.SHIFTS, function (rows) {
    return rows.map(function (row) {
      return {
        weekOf: row['Week Of'],
        date: row['Date'],
        name: text_(row['Name']),
        start: row['Start'],
        end: row['End'],
        minutes: Number(row['Minutes']) || 0,
        _row: row._row,
      };
    });
  });
}

/** Code always works hours out from In and Out. The Hours column is a formula for people to trace, and is never read. */
function hoursRows_() {
  return typed_(TABS_.HOURS, function (rows) {
    return rows
      .map(function (row) {
        return {
          id: rowId_(row),
          date: row['Date'],
          name: text_(row['Name']),
          inAt: toDate_(row['In']),
          outAt: toDate_(row['Out']),
          source: text_(row['Source']),
          flag: text_(row['Flag']).toLowerCase(),
          note: text_(row['Note']),
          editedBy: text_(row['Edited By']),
          editedAt: toDate_(row['Edited At']),
          _row: row._row,
        };
      })
      .filter(function (row) {
        return row.name && row.date && row.inAt;
      });
  });
}

/** Real elapsed hours, so a shift across a clock change comes out right. Null until there's an Out. */
function entryHours_(entry) {
  if (!entry.inAt || !entry.outAt) return null;
  return Math.round(((entry.outAt.getTime() - entry.inAt.getTime()) / 3600000) * 100) / 100;
}

/** Adds up the rounded entries, so the site matches what the sheet's own formulas add up to. */
function totalHours_(entries) {
  var total = 0;
  entries.forEach(function (entry) {
    total += entryHours_(entry) || 0;
  });
  return Math.round(total * 100) / 100;
}

/** {date: note}. A closed date with no note still counts as closed. */
function closedDays_() {
  return typed_(TABS_.CLOSED, function (rows) {
    var map = Object.create(null);
    rows.forEach(function (row) {
      if (row['Date']) map[row['Date']] = text_(row['Note']) || 'Closed';
    });
    return map;
  });
}

function closedNote_(date) {
  return closedDays_()[date] || '';
}

/** Lines on the Closed Days tab that can't be read as a date. Those days get scheduled as usual, so the Friday summary says so. */
function unreadableClosedDays_() {
  var sheet = sheet_(TABS_.CLOSED);
  var lastRow = sheet.getLastRow();
  var column = headersOf_(TABS_.CLOSED).indexOf('Date') + 1;
  if (lastRow < 2 || !column) return [];
  return sheet
    .getRange(2, column, lastRow - 1, 1)
    .getValues()
    .map(function (line) {
      return line[0];
    })
    .filter(function (value) {
      return text_(value) && !dateString_(value);
    })
    .map(text_);
}

/** {key: value} from the Settings tab. */
function settings_() {
  return typed_(TABS_.SETTINGS, function (rows) {
    var settings = {};
    rows.forEach(function (row) {
      var key = text_(row['Key']);
      if (key) settings[key] = row['Value'];
    });
    return settings;
  });
}
