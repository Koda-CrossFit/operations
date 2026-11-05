/**
 * Seed.js: adminSetup, which lays out the sheet, seeds it and installs the trigger.
 *
 * Safe to run again at any time. It adds what's missing and never wipes or duplicates
 * what's there: tabs and columns are added, tasks and closed days are seeded only into an
 * empty tab, new people are added by name, and existing people are never overwritten
 * beyond filling in a blank email. The seed tasks themselves live in SeedTasks.js.
 *
 * Only callable while no manager code is set, or with the code. Staff names and emails
 * come from the source sheet at run time, and the IDs arrive in the request. None of it
 * belongs in this repo.
 *
 * Once it has run, sheetId, managers and shareWithManagers are ignored, so the code alone
 * can't point the site at another sheet, add a manager, or share the sheet with someone.
 * Those changes take the Apps Script editor or the sheet itself.
 */

/** adminSetup {code, sourceSheetId, sheetId, managers:[{name, email}], testEmail?, replyTo?, siteUrl?, shareWithManagers?} */
function adminSetup_(req) {
  var props = PropertiesService.getScriptProperties();
  var existingCode = props.getProperty(PROP_MANAGER_CODE_);
  var code = text_(req.code).slice(0, MAX_CODE_);
  if (existingCode) checkManagerCode_('adminSetup', code);
  else if (code.length < 4) fail_('Please choose a manager code with at least 4 characters.');

  var warnings = [];
  var settled = !!existingCode && !!props.getProperty(PROP_SHEET_ID_);
  if (settled && (text_(req.sheetId) || req.managers || isTrue_(req.shareWithManagers))) {
    warnings.push('sheetId, managers and shareWithManagers only count the first time. To change them now, use the Apps Script editor or the sheet itself.');
  }
  var managers = settled ? [] : cleanManagers_(req.managers, warnings);
  [
    ['testEmail', req.testEmail],
    ['replyTo', req.replyTo],
  ].forEach(function (pair) {
    if (text_(pair[1]) && !isEmail_(pair[1])) fail_(pair[0] + " doesn't look like an email address.");
  });
  var sourceRows = text_(req.sourceSheetId) ? readSourceStaff_(text_(req.sourceSheetId), warnings) : null; // read first: a bad ID stops here with nothing changed

  var book = openOrCreateBook_((!settled && text_(req.sheetId)) || props.getProperty(PROP_SHEET_ID_));
  props.setProperty(PROP_SHEET_ID_, book.getId());
  if (!existingCode) props.setProperty(PROP_MANAGER_CODE_, code);
  resetRequestCache_();

  book.setSpreadsheetTimeZone(TZ_);
  Object.keys(HEADERS_).forEach(function (tab) {
    ensureTab_(book, tab);
  });
  removeBlankFirstTab_(book);

  seedSettings_(req, managers, warnings);
  var closedSeeded = seedClosedDays_();
  var tasksSeeded = seedTasks_();
  var people = importStaff_(sourceRows, managers, warnings);
  var monthlyMade = ensureMonthlyHours_(book);
  try {
    installTick_();
  } catch (err) {
    warnings.push("The 5-minute trigger didn't install, so nothing automatic will run. Please run installTick from the Apps Script editor. (" + ((err && err.message) || err) + ')');
  }

  if (!settled && isTrue_(req.shareWithManagers)) shareWithManagers_(book, managers, warnings);

  log_('setup', 'adminSetup', 'Added ' + people.added.length + ' people and ' + tasksSeeded + ' tasks');
  return {
    sheetId: book.getId(),
    sheetUrl: book.getUrl(),
    tasksSeeded: tasksSeeded,
    closedDaysSeeded: closedSeeded,
    monthlyHoursMade: monthlyMade,
    staffAdded: people.added,
    emailsFilled: people.filled,
    warnings: warnings,
  };
}

/** Run this once from the Apps Script editor, so Google asks for the permissions the deployed web app needs. */
function authorize() {
  console.log('Mail quota left today: ' + MailApp.getRemainingDailyQuota());
  console.log('Triggers installed: ' + ScriptApp.getProjectTriggers().length);
  console.log('Time zone: ' + Session.getScriptTimeZone() + ', sheet opened: ' + !!SpreadsheetApp.getActiveSpreadsheet());
}

function openOrCreateBook_(id) {
  if (!id) return SpreadsheetApp.create(APP_NAME_);
  try {
    return SpreadsheetApp.openById(id);
  } catch (err) {
    fail_("We couldn't open that sheet. Please check the ID and that this account can edit it.");
  }
}

function isEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text_(value));
}

function cleanManagers_(list, warnings) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail_('Managers has to be a list of names and emails.');
  return list
    .map(function (manager) {
      var name = cleanText_(manager && manager.name, MAX_NAME_);
      var email = text_(manager && manager.email);
      if (name && email && !isEmail_(email)) {
        warnings.push(name + "'s email doesn't look right, so it was left blank.");
        email = '';
      }
      return { name: name, email: email };
    })
    .filter(function (manager) {
      return manager.name;
    });
}

/* ------------------------------------------------------------------- the tabs ---- */

/** Creates the tab, or adds any headers it's missing at the end, then applies the sheet-friendly touches. */
function ensureTab_(book, tab) {
  var sheet = book.getSheetByName(tab) || book.insertSheet(tab);
  var wanted = HEADERS_[tab];
  var width = sheet.getLastColumn();
  var existing = width ? sheet.getRange(1, 1, 1, width).getValues()[0].map(text_) : [];
  var missing = wanted.filter(function (header) {
    return existing.indexOf(header) < 0;
  });
  if (missing.length) {
    var needed = existing.length + missing.length;
    if (needed > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), needed - sheet.getMaxColumns());
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  var headers = existing.concat(missing);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  headers.forEach(function (header, index) {
    var widthPx = COLUMN_WIDTHS_[tab] && COLUMN_WIDTHS_[tab][header];
    if (widthPx) sheet.setColumnWidth(index + 1, widthPx);
    var format = COLUMN_FORMATS_[tab] && COLUMN_FORMATS_[tab][header];
    if (format && sheet.getMaxRows() > 1) sheet.getRange(2, index + 1, sheet.getMaxRows() - 1, 1).setNumberFormat(format);
  });
  return sheet;
}

/** A new spreadsheet starts with an empty Sheet1 that nothing uses. */
function removeBlankFirstTab_(book) {
  var blank = book.getSheetByName('Sheet1');
  if (blank && !blank.getLastRow() && book.getSheets().length > 1) book.deleteSheet(blank);
}

function seedSettings_(req, managers, warnings) {
  var emails = managers
    .map(function (manager) {
      return manager.email;
    })
    .filter(Boolean);
  var testEmail = text_(req.testEmail);
  var replyTo = text_(req.replyTo);
  var defaults = [
    ['live', 'FALSE', 'Leave FALSE until going live. While it is not TRUE, every email goes only to test_email.'],
    ['manager_emails', emails.join(', '), 'Who gets manager emails, separated by commas.'],
    ['reply_to', replyTo || emails[0] || '', 'Replies to any email from the site go here.'],
    ['test_email', testEmail || emails[0] || '', 'Gets every email while live is not TRUE, and any automation failure.'],
    ['site_url', text_(req.siteUrl) || DEFAULT_SITE_URL_, 'Used for the links in emails.'],
    ['first_week', '2026-11-09', 'The first Monday the site schedules. Weeks before it are skipped.'],
    ['thursday_heads_up', 'FALSE', 'TRUE sends a Thursday 7 AM reminder to anyone missing availability.'],
  ];
  var existing = Object.create(null);
  readTab_(TABS_.SETTINGS).forEach(function (row) {
    existing[text_(row['Key'])] = row;
  });
  var toAdd = [];
  defaults.forEach(function (item) {
    var row = existing[item[0]];
    if (!row) toAdd.push({ Key: item[0], Value: item[1], Notes: item[2] });
    else if (text_(row['Value']) === '' && item[1]) updateRow_(TABS_.SETTINGS, row._row, { Value: item[1] });
  });
  appendRows_(TABS_.SETTINGS, toAdd);
  if (!text_(settings_().test_email)) warnings.push('test_email is blank, so test mode sends no email at all.');
}

/** Only into an empty tab, so a day someone removed doesn't come back. */
function seedClosedDays_() {
  if (readTab_(TABS_.CLOSED).length) return 0;
  appendRows_(TABS_.CLOSED, [{ Date: '2026-11-26', Note: 'Thanksgiving' }]);
  return 1;
}

/** Only into an empty tab, so a task someone removed or reworded doesn't come back. */
function seedTasks_() {
  if (readTab_(TABS_.TASKS).length) return 0;
  appendRows_(
    TABS_.TASKS,
    SEED_TASKS_.map(function (task) {
      return {
        ID: task.id,
        Task: task.title,
        Details: task.details,
        'How Frequent': task.cadence,
        Priority: task.priority,
        Minutes: task.minutes,
        Days: task.setOnly ? 'Set' : task.days.join(', '),
        'Flex Days': task.flexDays,
        Active: task.active,
      };
    })
  );
  return SEED_TASKS_.length;
}

/* ------------------------------------------------------------------ the people ---- */

/** Reads the source tab: columns Ranking, Name, Email, Days, Set Tasks, wherever they are. Blank Days means Flexible. */
function readSourceStaff_(sourceId, warnings) {
  var book;
  try {
    book = SpreadsheetApp.openById(sourceId);
  } catch (err) {
    fail_("We couldn't open the source sheet. Please check the ID and that this account can read it.");
  }
  var tab = book.getSheets().filter(function (sheet) {
    return text_(sheet.getName()).toLowerCase() === SOURCE_TAB_;
  })[0];
  if (!tab) fail_('The source sheet has no tab named "' + SOURCE_TAB_ + '".');

  var values = tab.getDataRange().getValues();
  var headerAt = -1;
  for (var i = 0; i < values.length && i < 10 && headerAt < 0; i++) {
    var lower = values[i].map(function (cell) {
      return text_(cell).toLowerCase();
    });
    if (lower.indexOf('name') >= 0) headerAt = i;
  }
  if (headerAt < 0) fail_('The "' + SOURCE_TAB_ + '" tab needs a column named Name.');
  var headers = values[headerAt].map(function (cell) {
    return text_(cell).toLowerCase();
  });
  var column = function (names) {
    for (var n = 0; n < names.length; n++) {
      var at = headers.indexOf(names[n]);
      if (at >= 0) return at;
    }
    return -1;
  };
  var at = {
    rank: column(['ranking', 'rank']),
    name: column(['name']),
    email: column(['email', 'e-mail', 'email address']),
    days: column(['days', 'set days']),
    tasks: column(['set tasks', 'set task', 'tasks']),
  };
  var cell = function (cells, index) {
    return index < 0 ? '' : cells[index];
  };

  var people = values
    .slice(headerAt + 1)
    .map(function (cells, position) {
      var name = cleanText_(cell(cells, at.name), MAX_NAME_);
      var rank = parseFloat(cell(cells, at.rank));
      var email = text_(cell(cells, at.email));
      if (name && email && !isEmail_(email)) {
        warnings.push(name + "'s email doesn't look right, so it was left blank.");
        email = '';
      }
      var daysText = text_(cell(cells, at.days));
      var days = parseDays_(daysText);
      var taskText = cleanText_(cell(cells, at.tasks), MAX_TEXT_);
      return { rank: isFinite(rank) ? rank : position + 1, name: name, email: email, days: days, daysText: daysText, taskText: taskText };
    })
    .filter(function (person) {
      return person.name;
    })
    .sort(function (a, b) {
      return a.rank - b.rank;
    });

  people.forEach(function (person) {
    if (person.daysText && !person.days.length) warnings.push(person.name + "'s days weren't recognized, so they were added as Flexible. Please fix Set Days and Type on the Staff tab.");
    if (!person.email) warnings.push(person.name + ' has no email address, so they get no emails until one is added to the Staff tab.');
    if (person.days.length && !mapSetTasks_(person.taskText, person.days)) {
      warnings.push(person.name + ' has set days but no set tasks we recognize. Please fill in Set Tasks on the Staff tab.');
    }
  });
  return people;
}

/**
 * Turns the source sheet's words into task IDs (SPEC section 5): floors people T15, the Tuesday deep
 * cleaner T08 and T14, any other deep cleaner T08. Task IDs typed directly are kept as they are.
 */
function mapSetTasks_(text, days) {
  var value = text_(text);
  if (/^T\d+/i.test(value)) return value;
  var lower = value.toLowerCase();
  if (lower.indexOf('floor') >= 0) return 'T15';
  if (/deep|clean|bath/.test(lower)) {
    if (days.indexOf('Tue') < 0) return 'T08';
    return days.length > 1 ? 'T08, T14@Tue' : 'T08, T14';
  }
  return '';
}

function importStaff_(sourceRows, managers, warnings) {
  var known = Object.create(null);
  staff_().forEach(function (person) {
    known[person.name.toLowerCase()] = person;
  });
  var toAdd = [];
  var added = [];
  var filled = [];
  var fillBlankEmail = function (person, email) {
    if (!person.email && email && person._row) {
      updateRow_(TABS_.STAFF, person._row, { Email: email });
      filled.push(person.name);
    }
  };

  var isManager = Object.create(null);
  managers.forEach(function (manager) {
    isManager[manager.name.toLowerCase()] = true;
  });

  (sourceRows || []).forEach(function (person) {
    if (isManager[person.name.toLowerCase()]) return; // on both lists: the manager row below is the one that counts
    var existing = known[person.name.toLowerCase()];
    if (existing) {
      fillBlankEmail(existing, person.email);
      return;
    }
    var isSet = person.days.length > 0;
    toAdd.push({
      Rank: person.rank,
      Name: person.name,
      Email: person.email,
      Type: isSet ? 'Set' : 'Flexible',
      'Set Days': person.days.join(', '),
      'Set Tasks': isSet ? mapSetTasks_(person.taskText, person.days) : '',
      Active: true,
      Notes: person.taskText,
    });
    added.push(person.name);
    known[person.name.toLowerCase()] = { name: person.name, email: person.email };
  });

  managers.forEach(function (manager) {
    var existing = known[manager.name.toLowerCase()];
    if (existing) {
      fillBlankEmail(existing, manager.email);
      if (existing.type && existing.type !== 'Manager') warnings.push(manager.name + ' is already on the Staff tab as ' + existing.type + ', so they were left that way.');
      return;
    }
    toAdd.push({ Rank: '', Name: manager.name, Email: manager.email, Type: 'Manager', 'Set Days': '', 'Set Tasks': '', Active: true, Notes: '' });
    added.push(manager.name);
    known[manager.name.toLowerCase()] = { name: manager.name, email: manager.email };
  });

  appendRows_(TABS_.STAFF, toAdd);
  return { added: added, filled: filled };
}

function shareWithManagers_(book, managers, warnings) {
  managers.forEach(function (manager) {
    if (!manager.email) return;
    try {
      book.addEditor(manager.email);
    } catch (err) {
      warnings.push("Couldn't share the sheet with " + manager.name + '.');
    }
  });
}

/* --------------------------------------------------------------- Monthly Hours ---- */

/**
 * A tab for a person to read and trace: type a month at the top, and each line of the Staff
 * tab gets its totals through SUMIFS over the Hours tab. Those formulas add up the Hours
 * column, which is wall-clock time, so a shift across a clock change reads an hour off
 * here while the site itself stays right.
 */
function ensureMonthlyHours_(book) {
  if (book.getSheetByName(TABS_.MONTHLY)) return false;
  var sheet = book.insertSheet(TABS_.MONTHLY);
  var info = nowInfo_();
  var hoursHeaders = headersOf_(TABS_.HOURS);
  var hoursColumn = function (header) {
    var letter = columnLetter_(hoursHeaders.indexOf(header) + 1);
    return 'Hours!$' + letter + ':$' + letter;
  };
  var nameLetter = columnLetter_(headersOf_(TABS_.STAFF).indexOf('Name') + 1);
  var first = 'DATE(YEAR($B$1),MONTH($B$1),1)';
  var inMonth = hoursColumn('Date') + ',">="&' + first + ',' + hoursColumn('Date') + ',"<"&EDATE(' + first + ',1)';
  var byName = hoursColumn('Name') + ',$A';
  var startRow = 4;
  var lastRow = startRow + MONTHLY_ROWS_ - 1;

  sheet.getRange(1, 1).setValue('Month (type any date in it)').setFontWeight('bold');
  sheet.getRange(1, 2).setNumberFormat('mmmm yyyy').setValue(wallToDate_(info.month + '-01', '00:00')).setBackground('#EEF3F8').setFontWeight('bold');
  sheet.getRange(2, 1).setValue('Total hours').setFontWeight('bold');
  sheet.getRange(2, 2).setFormula('=SUM(B' + startRow + ':B' + lastRow + ')').setFontWeight('bold');
  sheet.getRange(3, 1, 1, 4).setValues([['Name', 'Hours', 'Entries', 'Need a fix']]).setFontWeight('bold');

  var formulas = [];
  for (var row = startRow; row <= lastRow; row++) {
    var staffRow = row - startRow + 2;
    formulas.push([
      '=IF(Staff!$' + nameLetter + staffRow + '="","",Staff!$' + nameLetter + staffRow + ')',
      '=IF($A' + row + '="","",SUMIFS(' + hoursColumn('Hours') + ',' + byName + row + ',' + inMonth + '))',
      '=IF($A' + row + '="","",COUNTIFS(' + byName + row + ',' + inMonth + '))',
      '=IF($A' + row + '="","",COUNTIFS(' + byName + row + ',' + inMonth + ',' + hoursColumn('Flag') + ',"missing"))',
    ]);
  }
  sheet.getRange(startRow, 1, formulas.length, 4).setFormulas(formulas);
  sheet.getRange(startRow, 2, formulas.length, 1).setNumberFormat(HOURS_FORMAT_);
  sheet.setFrozenRows(3);
  sheet.setColumnWidth(1, 200);
  return true;
}

/* -------------------------------------------------------------------- the tick ---- */

/** The same thing from the Apps Script editor, if setup reports it couldn't. */
function installTick() {
  installTick_();
}

/** Replaces any old tick trigger, so re-running setup can't leave two running. */
function installTick_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
}
