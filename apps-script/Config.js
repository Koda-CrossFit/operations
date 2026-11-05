/**
 * Config.js: tab names, column headers and constants (SPEC sections 4 and 8).
 *
 * Plain values only, so this file loads safely in any order. All Apps Script files
 * share one global scope: everything here ends in an underscore and is read inside
 * functions, never at the top level of another file.
 */

var TZ_ = 'America/Denver';
var APP_NAME_ = 'Koda Operations';
var DEFAULT_SITE_URL_ = 'https://koda-crossfit.github.io/operations/';

var TABS_ = {
  STAFF: 'Staff',
  TASKS: 'Tasks',
  ONE_OFFS: 'One-Offs',
  AVAILABILITY: 'Availability',
  TIME_OFF: 'Time Off',
  SCHEDULE: 'Schedule',
  SHIFTS: 'Shifts',
  HOURS: 'Hours',
  MONTHLY: 'Monthly Hours',
  LOG: 'Log',
  SETTINGS: 'Settings',
  CLOSED: 'Closed Days',
};

/** Every tab but Monthly Hours, which is laid out by hand in Seed.js. */
var HEADERS_ = {
  Staff: ['Rank', 'Name', 'Email', 'Type', 'Set Days', 'Set Tasks', 'Active', 'Notes'],
  Tasks: ['ID', 'Task', 'Details', 'How Frequent', 'Priority', 'Minutes', 'Days', 'Flex Days', 'Active'],
  'One-Offs': ['ID', 'Added', 'Added By', 'Task', 'Details', 'Priority', 'Minutes', 'Week Of', 'Day', 'Who', 'Status', 'Done By', 'Done At'],
  Availability: ['Week Of', 'Name', 'Submitted At', 'Late', 'None', 'Hours Wanted', 'Slots', 'Readable', 'Notes'],
  'Time Off': ['ID', 'Name', 'From', 'To', 'Note', 'Added At', 'Status'],
  Schedule: ['ID', 'Week Of', 'Date', 'Day', 'Name', 'Task ID', 'One-Off ID', 'Task', 'Details', 'Priority', 'Minutes', 'Source', 'Status', 'Done At', 'Done By', 'Note', 'Rolled From'],
  Shifts: ['Week Of', 'Date', 'Name', 'Start', 'End', 'Minutes'],
  Hours: ['ID', 'Date', 'Name', 'In', 'Out', 'Hours', 'Source', 'Flag', 'Note', 'Edited By', 'Edited At'],
  Log: ['Time', 'Who', 'Action', 'Details'],
  Settings: ['Key', 'Value', 'Notes'],
  'Closed Days': ['Date', 'Note'],
};

var TEXT_FORMAT_ = '@'; // plain text, so Sheets leaves '2026-11-09' and '09:00' alone
var DATE_FORMAT_ = 'yyyy-mm-dd';
var STAMP_FORMAT_ = 'yyyy-mm-dd h:mm am/pm';
var HOURS_FORMAT_ = '0.00';

/**
 * Number format per column, set on every write. Anything not listed stays automatic.
 * Free text is plain text as well as dates, since Sheets would otherwise turn a note like
 * "3/4" into a date and "10:30" into a time.
 */
var COLUMN_FORMATS_ = {
  Staff: { 'Set Days': TEXT_FORMAT_, 'Set Tasks': TEXT_FORMAT_, Notes: TEXT_FORMAT_ },
  Tasks: { ID: TEXT_FORMAT_, Task: TEXT_FORMAT_, Details: TEXT_FORMAT_, 'How Frequent': TEXT_FORMAT_, Priority: TEXT_FORMAT_, Days: TEXT_FORMAT_ },
  'One-Offs': { ID: TEXT_FORMAT_, Added: STAMP_FORMAT_, Task: TEXT_FORMAT_, Details: TEXT_FORMAT_, Priority: TEXT_FORMAT_, 'Week Of': TEXT_FORMAT_, Day: TEXT_FORMAT_, Who: TEXT_FORMAT_, 'Done At': STAMP_FORMAT_ },
  Availability: { 'Week Of': TEXT_FORMAT_, 'Submitted At': STAMP_FORMAT_, Slots: TEXT_FORMAT_, Readable: TEXT_FORMAT_, Notes: TEXT_FORMAT_ },
  'Time Off': { ID: TEXT_FORMAT_, From: TEXT_FORMAT_, To: TEXT_FORMAT_, Note: TEXT_FORMAT_, 'Added At': STAMP_FORMAT_ },
  Schedule: { ID: TEXT_FORMAT_, 'Week Of': TEXT_FORMAT_, Date: TEXT_FORMAT_, Day: TEXT_FORMAT_, 'Task ID': TEXT_FORMAT_, 'One-Off ID': TEXT_FORMAT_, Task: TEXT_FORMAT_, Details: TEXT_FORMAT_, Priority: TEXT_FORMAT_, 'Done At': STAMP_FORMAT_, Note: TEXT_FORMAT_, 'Rolled From': TEXT_FORMAT_ },
  Shifts: { 'Week Of': TEXT_FORMAT_, Date: TEXT_FORMAT_, Start: TEXT_FORMAT_, End: TEXT_FORMAT_ },
  Hours: { ID: TEXT_FORMAT_, Date: DATE_FORMAT_, In: STAMP_FORMAT_, Out: STAMP_FORMAT_, Hours: HOURS_FORMAT_, Note: TEXT_FORMAT_, 'Edited At': STAMP_FORMAT_ },
  Log: { Time: STAMP_FORMAT_, Action: TEXT_FORMAT_, Details: TEXT_FORMAT_ },
  Settings: { Value: TEXT_FORMAT_ },
  'Closed Days': { Date: TEXT_FORMAT_, Note: TEXT_FORMAT_ },
};

/** Columns read back as 'YYYY-MM-DD', whatever Sheets turned them into. */
var DATE_COLUMNS_ = {
  'One-Offs': ['Week Of'],
  Availability: ['Week Of'],
  'Time Off': ['From', 'To'],
  Schedule: ['Week Of', 'Date', 'Rolled From'],
  Shifts: ['Week Of', 'Date'],
  Hours: ['Date'],
  'Closed Days': ['Date'],
};

/** Columns read back as 'HH:MM'. */
var TIME_COLUMNS_ = {
  Shifts: ['Start', 'End'],
};

/** Starting widths in pixels, so a person can read each tab without resizing it. */
var COLUMN_WIDTHS_ = {
  Staff: { Rank: 50, Name: 130, Email: 220, Type: 80, 'Set Days': 120, 'Set Tasks': 120, Active: 60, Notes: 280 },
  Tasks: { ID: 50, Task: 300, Details: 420, 'How Frequent': 110, Priority: 70, Minutes: 70, Days: 200, 'Flex Days': 70, Active: 60 },
  'One-Offs': { ID: 110, Added: 150, 'Added By': 90, Task: 280, Details: 320, Priority: 70, Minutes: 70, 'Week Of': 90, Day: 60, Who: 140, Status: 70, 'Done By': 90, 'Done At': 150 },
  Availability: { 'Week Of': 90, Name: 110, 'Submitted At': 150, Late: 60, None: 60, 'Hours Wanted': 90, Slots: 240, Readable: 280, Notes: 280 },
  'Time Off': { ID: 110, Name: 110, From: 90, To: 90, Note: 260, 'Added At': 150, Status: 80 },
  Schedule: { ID: 220, 'Week Of': 90, Date: 90, Day: 50, Name: 110, 'Task ID': 60, 'One-Off ID': 110, Task: 280, Details: 320, Priority: 70, Minutes: 60, Source: 70, Status: 70, 'Done At': 150, 'Done By': 90, Note: 240, 'Rolled From': 90 },
  Shifts: { 'Week Of': 90, Date: 90, Name: 110, Start: 60, End: 60, Minutes: 60 },
  Hours: { ID: 110, Date: 90, Name: 110, In: 150, Out: 150, Hours: 60, Source: 70, Flag: 70, Note: 260, 'Edited By': 90, 'Edited At': 150 },
  Log: { Time: 150, Who: 110, Action: 130, Details: 520 },
  Settings: { Key: 160, Value: 300, Notes: 480 },
  'Closed Days': { Date: 90, Note: 240 },
};

var DAY_KEYS_ = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
var DAY_NAMES_ = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
var MONTH_NAMES_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

var SLOT_FIRST_HOUR_ = 5; // the availability grid runs from this start hour...
var SLOT_LAST_HOUR_ = 21; // ...to this one, so a 9 PM block ends at 10 PM
var WEEKS_AHEAD_ = 6; // Mondays offered on the Availability tab
var WEEKS_MAX_AHEAD_ = 52; // the furthest out anyone can save availability
var HOURS_WANTED_MAX_ = 40;
var ONE_OFF_MAX_MINUTES_ = 960;

var MAX_TITLE_ = 120;
var MAX_TEXT_ = 500; // details and notes
var MAX_NAME_ = 80;
var MAX_CODE_ = 64;

var DEADLINE_TIME_ = '07:00'; // Friday at this time closes next week's availability
var NIGHTLY_TIME_ = '00:30';
var MONTHLY_TIME_ = '07:00';

var AT_MAX_PAST_MS_ = 12 * 60 * 60 * 1000; // a queued clock tap can be this old...
var AT_MAX_AHEAD_MS_ = 5 * 60 * 1000; // ...and this far ahead of the server's clock
var HOURS_ADD_MAX_AGE_DAYS_ = 45;
var SHIFT_MAX_HOURS_ = 16;
var OPEN_SHIFT_MAX_HOURS_ = 12; // an open entry from an earlier day counts as on the clock for this long, so a shift can run past midnight
var LONG_SHIFT_EXTRA_MIN_ = 120; // logged this far past what was scheduled, Manage > Hours points it out...
var LONG_SHIFT_UNSCHEDULED_MIN_ = 480; // ...and this long on a day with nothing scheduled

var ALERTS_PER_HOUR_ = 5; // manager alerts about one person, so a script hammering the web app can't use up the mail quota
var MANAGER_MAX_TRIES_ = 8;
var MANAGER_LOCK_SECONDS_ = 15 * 60;
var LOCK_WAIT_MS_ = 20000;
var JOB_ALERT_SECONDS_ = 60 * 60; // at most one failure email per job per hour

/** Script Properties. Never the sheet, never the repo. */
var PROP_SHEET_ID_ = 'SHEET_ID';
var PROP_MANAGER_CODE_ = 'MANAGER_CODE';
var PROP_BUILT_PREFIX_ = 'BUILT_'; // BUILT_2026-11-09 holds when that week was built, which is what "published" means
var PROP_WEEK_PREFIX_ = 'RUN_WEEK_'; // RUN_WEEK_2026-11-09_DONE and its step markers
var PROP_THURSDAY_PREFIX_ = 'RUN_THU_';
var PROP_NIGHTLY_ = 'RUN_NIGHT'; // the date of the last nightly run
var PROP_MONTHLY_ = 'RUN_MONTH'; // the month, as 2026-11, whose first-of-the-month email has gone out

var SOURCE_TAB_ = 'employees and rankings';
var MONTHLY_ROWS_ = 40; // ready-made rows on the Monthly Hours tab, one per line of the Staff tab
