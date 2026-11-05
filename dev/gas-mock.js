'use strict';

/**
 * gas-mock.js: in-memory fakes for the Google services the backend uses, and a loader that
 * runs apps-script/*.js in one vm context, the way Apps Script does: one shared global
 * scope, evaluated file by file. No Google, no network.
 *
 * The fakes copy the Sheets behavior that bites real scripts, so a bug shows up here first:
 * - Without plain-text format, a date-like or time-like string becomes a Date, and a
 *   number-like string becomes a number.
 * - A string starting with = becomes a formula. A leading apostrophe marks text and isn't
 *   stored, so a safeCell_ value reads back without it.
 * - A range outside the sheet throws, and deleting every unfrozen row throws.
 * - While a script runs, its writes wait to be sent until a flush or the end of the run.
 *   SpreadsheetApp sees them anyway. Sheets.Spreadsheets.Values.batchGet doesn't.
 * - batchGet sends cells the way the real one does: dates as serial numbers on the sheet's
 *   clock, blanks at the end of a row or a range left out, and a bad range fails the whole call.
 *
 * Where the fake is not a real sheet, so a clean run here proves nothing about these:
 * - A real cell holds one number and a format, and getValues picks a Date or a number from the
 *   format. Here a cell holds a Date or a number, whatever its format says.
 * - So the fake keeps both passes of the hour the clocks repeat, which a real cell can't tell
 *   apart, and can't hold a reading the clocks skip, which a real cell can.
 * - It doesn't compute formulas, and it runs one request at a time.
 *
 * Time: `__NOW__` in the context is the fake clock. Cached values expire by that clock too.
 *
 * Tests can make batchGet fail with `state.beforeBatch`, and can see what a script did in
 * `state.counters` (batchGet, flush, sheetReads, readCalls) and `state.batchRanges`. Only a
 * running script counts: a test looking at a sheet or typing in one, the way a person would,
 * doesn't count and is never held back.
 */

process.env.TZ = 'America/Denver'; // before any date use, so local Date matches a script running in Denver

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { STAFF } = require('./fixtures.js');

const SCRIPT_DIR = path.join(__dirname, '..', 'apps-script');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const AUTOMATIC = 'General';

function isDate(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

/* ------------------------------------------------------------ Utilities.formatDate ---- */

const zoneFormats = new Map(); // making one of these is slow, and a batch can turn hundreds of dates into serial numbers

function zoneFormat(timeZone) {
  if (!zoneFormats.has(timeZone)) {
    zoneFormats.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        weekday: 'long',
      })
    );
  }
  return zoneFormats.get(timeZone);
}

function zoned(date, timeZone) {
  const parts = {};
  zoneFormat(timeZone)
    .formatToParts(date)
    .forEach((part) => {
      parts[part.type] = part.value;
    });
  const out = {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
  const asUtc = Date.UTC(out.year, out.month - 1, out.day, out.hour, out.minute, out.second);
  out.offset = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  return out;
}

/** The SimpleDateFormat tokens the backend uses. An unknown one throws, rather than quietly printing nonsense. */
function formatDate(date, timeZone, pattern) {
  if (!isDate(date) || Number.isNaN(date.getTime())) throw new Error('formatDate needs a real Date, got: ' + date);
  const z = zoned(date, timeZone);
  const offset = (separator) => {
    const size = Math.abs(z.offset);
    return (z.offset < 0 ? '-' : '+') + pad(Math.floor(size / 60), 2) + separator + pad(size % 60, 2);
  };
  return String(pattern).replace(/'[^']*'|[A-Za-z]+/g, (token) => {
    if (token.startsWith("'")) return token.slice(1, -1);
    switch (token) {
      case 'yyyy':
        return String(z.year);
      case 'yy':
        return pad(z.year % 100, 2);
      case 'MMMM':
        return MONTHS[z.month - 1];
      case 'MMM':
        return MONTHS[z.month - 1].slice(0, 3);
      case 'MM':
        return pad(z.month, 2);
      case 'M':
        return String(z.month);
      case 'dd':
        return pad(z.day, 2);
      case 'd':
        return String(z.day);
      case 'EEEE':
        return z.weekday;
      case 'EEE':
        return z.weekday.slice(0, 3);
      case 'HH':
        return pad(z.hour, 2);
      case 'H':
        return String(z.hour);
      case 'hh':
        return pad((z.hour + 11) % 12 + 1, 2);
      case 'h':
        return String((z.hour + 11) % 12 + 1);
      case 'mm':
        return pad(z.minute, 2);
      case 'm':
        return String(z.minute);
      case 'ss':
        return pad(z.second, 2);
      case 'a':
        return z.hour < 12 ? 'AM' : 'PM';
      case 'Z':
        return offset('');
      case 'XXX':
        return offset(':');
      default:
        throw new Error('The mock formatDate does not know this pattern token: ' + token);
    }
  });
}

/* --------------------------------------------------------------------- the sheets ---- */

/** This year's date for a month and day typed with no year, or null if there's no such day, which Sheets leaves as text. */
function dayThisYear(year, month, day) {
  const date = new Date(year, month - 1, day);
  return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** What a cell holds after a write: {value, formula}. `year` is this year by the fake clock. */
function coerce(value, format, year) {
  if (value === undefined) throw new TypeError('A cell was written with undefined.');
  if (value === null) return { value: '', formula: '' };
  if (isDate(value)) return { value: new Date(value.getTime()), formula: '' };
  if (typeof value !== 'string') return { value: format === '@' ? String(value).toUpperCase() : value, formula: '' };
  if (value.startsWith("'")) return { value: value.slice(1), formula: '' };
  if (value.startsWith('=')) return { value: '', formula: value };
  if (format === '@') return { value, formula: '' };

  // Automatic format: Sheets guesses.
  if (/^-?\d+(\.\d+)?$/.test(value)) return { value: Number(value), formula: '' };
  if (/^(true|false)$/i.test(value)) return { value: value.toUpperCase() === 'TRUE', formula: '' };
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (match) return { value: new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])), formula: '' };
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (match) return { value: new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2])), formula: '' };
  match = /^(\d{1,2})[-/](\d{1,2})$/.exec(value); // 1-2 and 3/4
  let date = match && dayThisYear(year, Number(match[1]), Number(match[2]));
  if (date) return { value: date, formula: '' };
  match = /^([a-z]{3,})\.?\s+(\d{1,2})$/i.exec(value); // Dec 25
  date = match && dayThisYear(year, MONTHS.findIndex((name) => name.toLowerCase().startsWith(match[1].toLowerCase())) + 1, Number(match[2]));
  if (date) return { value: date, formula: '' };
  match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (match && Number(match[1]) < 24) return { value: new Date(1899, 11, 30, Number(match[1]), Number(match[2])), formula: '' };
  match = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(value); // 1:05 PM
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12) return { value: new Date(1899, 11, 30, Number(match[1]) % 12 + (/pm/i.test(match[3]) ? 12 : 0), Number(match[2])), formula: '' };
  return { value, formula: '' };
}

function letterToColumn(letters) {
  let column = 0;
  for (const letter of letters.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return column;
}

function columnToLetter(column) {
  let letters = '';
  let number = column;
  while (number > 0) {
    const rest = (number - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    number = (number - rest - 1) / 26;
  }
  return letters;
}

class FakeRange {
  constructor(sheet, row, column, numRows, numColumns) {
    if (row < 1 || column < 1) throw new Error('The starting row or column of the range is too small.');
    if (numRows < 1) throw new Error('The number of rows in the range must be at least 1.');
    if (numColumns < 1) throw new Error('The number of columns in the range must be at least 1.');
    if (row + numRows - 1 > sheet.maxRows || column + numColumns - 1 > sheet.maxColumns) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }

  getRow() {
    return this.row;
  }
  getColumn() {
    return this.column;
  }
  getNumRows() {
    return this.numRows;
  }
  getNumColumns() {
    return this.numColumns;
  }
  getSheet() {
    return this.sheet;
  }
  getA1Notation() {
    const first = columnToLetter(this.column) + this.row;
    if (this.numRows === 1 && this.numColumns === 1) return first;
    return first + ':' + columnToLetter(this.column + this.numColumns - 1) + (this.row + this.numRows - 1);
  }

  eachCell(visit) {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numColumns; c++) line.push(visit(this.row + r, this.column + c, r, c));
      out.push(line);
    }
    return out;
  }

  getValues() {
    return this.eachCell((r, c) => {
      const value = this.sheet.cell(r, c).value;
      return isDate(value) ? new Date(value.getTime()) : value;
    });
  }
  getValue() {
    return this.getValues()[0][0];
  }
  getDisplayValues() {
    return this.eachCell((r, c) => this.sheet.display(r, c));
  }
  getDisplayValue() {
    return this.getDisplayValues()[0][0];
  }
  getFormulas() {
    return this.eachCell((r, c) => this.sheet.cell(r, c).formula);
  }
  getFormula() {
    return this.getFormulas()[0][0];
  }
  getNumberFormats() {
    return this.eachCell((r, c) => this.sheet.cell(r, c).format);
  }
  getNumberFormat() {
    return this.getNumberFormats()[0][0];
  }

  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows) {
      throw new Error(`The number of rows in the data does not match the range. The data has ${values && values.length} but the range has ${this.numRows}.`);
    }
    values.forEach((line) => {
      if (!Array.isArray(line) || line.length !== this.numColumns) {
        throw new Error(`The number of columns in the data does not match the range. The data has ${line && line.length} but the range has ${this.numColumns}.`);
      }
    });
    this.eachCell((r, c, i, j) => {
      const cell = this.sheet.cell(r, c);
      Object.assign(cell, coerce(values[i][j], cell.format, this.sheet.book.world.year()));
    });
    return this;
  }
  setValue(value) {
    this.eachCell((r, c) => {
      const cell = this.sheet.cell(r, c);
      Object.assign(cell, coerce(value, cell.format, this.sheet.book.world.year()));
    });
    return this;
  }
  setFormulas(formulas) {
    return this.setValues(formulas);
  }
  setFormula(formula) {
    return this.setValue(formula);
  }
  setNumberFormat(format) {
    this.eachCell((r, c) => {
      this.sheet.cell(r, c).format = format;
    });
    return this;
  }
  setNumberFormats(formats) {
    this.eachCell((r, c, i, j) => {
      this.sheet.cell(r, c).format = formats[i][j];
    });
    return this;
  }
  clearContent() {
    this.eachCell((r, c) => {
      Object.assign(this.sheet.cell(r, c), { value: '', formula: '' });
    });
    return this;
  }
  clear() {
    this.eachCell((r, c) => {
      Object.assign(this.sheet.cell(r, c), { value: '', formula: '', format: AUTOMATIC });
    });
    return this;
  }
}

// Formatting that only changes how a range looks. Each returns the range, so calls can chain.
['setFontWeight', 'setFontColor', 'setFontSize', 'setBackground', 'setHorizontalAlignment', 'setVerticalAlignment', 'setWrap', 'setWrapStrategy', 'setNote', 'setBorder', 'setDataValidation'].forEach((name) => {
  FakeRange.prototype[name] = function () {
    return this;
  };
});

class FakeSheet {
  constructor(book, name, rows, columns) {
    this.book = book;
    this.name = name;
    this.maxRows = rows === undefined ? 1000 : rows;
    this.maxColumns = columns === undefined ? 26 : columns;
    this.frozenRows = 0;
    this.grid = []; // grid[row-1][column-1] = cell, made on first touch
    this.sent = null; // while writes are waiting to be sent: the grid as it was before them
  }

  cell(row, column) {
    while (this.grid.length < row) this.grid.push([]);
    const line = this.grid[row - 1];
    if (!line[column - 1]) line[column - 1] = { value: '', formula: '', format: AUTOMATIC };
    return line[column - 1];
  }

  display(row, column) {
    const { value, format } = this.cell(row, column);
    if (isDate(value)) {
      const pattern = String(format === AUTOMATIC ? 'M/d/yyyy' : format)
        .replace(/mmmm/g, 'MMMM')
        .replace(/am\/pm/g, 'a')
        .replace(/yyyy-mm-dd/g, 'yyyy-MM-dd');
      return formatDate(value, 'America/Denver', pattern);
    }
    if (value === true) return 'TRUE';
    if (value === false) return 'FALSE';
    return String(value);
  }

  hasContent(cell) {
    return !!cell && (cell.value !== '' || cell.formula !== '');
  }

  getName() {
    return this.name;
  }
  setName(name) {
    this.name = name;
    return this;
  }
  getParent() {
    return this.book;
  }
  getMaxRows() {
    return this.maxRows;
  }
  getMaxColumns() {
    return this.maxColumns;
  }
  getLastRow() {
    for (let r = this.grid.length; r >= 1; r--) {
      if (this.grid[r - 1].some((cell) => this.hasContent(cell))) return r;
    }
    return 0;
  }
  getLastColumn() {
    let last = 0;
    this.grid.forEach((line) => {
      line.forEach((cell, index) => {
        if (this.hasContent(cell) && index + 1 > last) last = index + 1;
      });
    });
    return last;
  }

  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(a);
      if (!match) throw new Error('The mock getRange only reads simple A1 notation: ' + a);
      const firstColumn = letterToColumn(match[1]);
      const firstRow = Number(match[2]);
      const lastColumn = match[3] ? letterToColumn(match[3]) : firstColumn;
      const lastRow = match[4] ? Number(match[4]) : firstRow;
      return new FakeRange(this, firstRow, firstColumn, lastRow - firstRow + 1, lastColumn - firstColumn + 1);
    }
    return new FakeRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }

  appendRow(values) {
    const row = this.getLastRow() + 1;
    if (row > this.maxRows) this.maxRows = row;
    if (values.length > this.maxColumns) this.maxColumns = values.length;
    new FakeRange(this, row, 1, 1, values.length).setValues([values]);
    return this;
  }

  deleteRows(row, count) {
    if (row < 1 || row + count - 1 > this.maxRows) throw new Error('Those rows are out of bounds.');
    if (this.maxRows - count <= this.frozenRows) throw new Error('Sorry, it is not possible to delete all non-frozen rows.');
    while (this.grid.length < row + count - 1) this.grid.push([]);
    this.grid.splice(row - 1, count);
    this.maxRows -= count;
    return this;
  }
  deleteRow(row) {
    return this.deleteRows(row, 1);
  }
  insertRowsAfter(after, count) {
    while (this.grid.length < after) this.grid.push([]);
    const blanks = [];
    for (let i = 0; i < count; i++) blanks.push([]);
    this.grid.splice(after, 0, ...blanks);
    this.maxRows += count;
    return this;
  }
  insertColumnsAfter(after, count) {
    this.grid.forEach((line) => {
      if (line.length > after) line.splice(after, 0, ...new Array(count));
    });
    this.maxColumns += count;
    return this;
  }

  setFrozenRows(count) {
    this.frozenRows = count;
    return this;
  }
  getFrozenRows() {
    return this.frozenRows;
  }
  clear() {
    this.grid = [];
    return this;
  }
  clearContents() {
    this.grid.forEach((line) => {
      line.forEach((cell) => {
        if (cell) Object.assign(cell, { value: '', formula: '' });
      });
    });
    return this;
  }
}

['setFrozenColumns', 'setColumnWidth', 'setColumnWidths', 'setRowHeight', 'autoResizeColumn', 'autoResizeColumns', 'hideColumns', 'hideRows', 'setTabColor', 'activate'].forEach((name) => {
  FakeSheet.prototype[name] = function () {
    return this;
  };
});

class FakeBook {
  constructor(id, name, world) {
    this.id = id;
    this.name = name;
    this.world = world;
    this.sheets = [new FakeSheet(this, 'Sheet1')];
    this.timeZone = 'Etc/GMT';
    this.editors = [];
  }
  getId() {
    return this.id;
  }
  getName() {
    return this.name;
  }
  getUrl() {
    return 'https://docs.example.test/spreadsheets/d/' + this.id;
  }
  getSheets() {
    return this.sheets.slice();
  }
  getSheetByName(name) {
    return this.sheets.find((sheet) => sheet.name === name) || null;
  }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const sheet = new FakeSheet(this, name);
    this.sheets.push(sheet);
    return sheet;
  }
  deleteSheet(sheet) {
    if (this.sheets.length === 1) throw new Error("You can't remove all the sheets in a document.");
    this.sheets = this.sheets.filter((other) => other !== sheet);
  }
  setSpreadsheetTimeZone(timeZone) {
    this.timeZone = timeZone;
  }
  getSpreadsheetTimeZone() {
    return this.timeZone;
  }
  addEditor(email) {
    this.editors.push(email);
    return this;
  }
}

/* --------------------------------------------- what a running script does to a sheet ---- */

const sheetOf = (target) => target.sheet || target;

function countAsReads(Class, names) {
  names.forEach((name) => {
    const real = Class.prototype[name];
    Class.prototype[name] = function (...args) {
      const sheet = sheetOf(this);
      const world = sheet.book.world;
      if (!world.runDepth || world.reading) return real.apply(this, args);
      const key = `${sheet.name}.${name}`;
      world.counters.sheetReads += 1;
      world.counters.readCalls[key] = (world.counters.readCalls[key] || 0) + 1;
      world.reading = true; // getDataRange asks getLastRow for itself, and that's still one call
      try {
        return real.apply(this, args);
      } finally {
        world.reading = false;
      }
    };
  });
}

function holdUntilFlush(Class, names) {
  names.forEach((name) => {
    const real = Class.prototype[name];
    Class.prototype[name] = function (...args) {
      const sheet = sheetOf(this);
      if (sheet.book.world.runDepth && !sheet.sent) sheet.sent = sheet.grid.map((line) => line.map((cell) => ({ ...cell })));
      return real.apply(this, args);
    };
  });
}

countAsReads(FakeRange, ['getValues', 'getValue', 'getDisplayValues', 'getDisplayValue', 'getFormulas', 'getFormula', 'getNumberFormats', 'getNumberFormat']);
countAsReads(FakeSheet, ['getLastRow', 'getLastColumn', 'getMaxRows', 'getMaxColumns', 'getFrozenRows', 'getDataRange']);
holdUntilFlush(FakeRange, ['setValues', 'setValue', 'setFormulas', 'setFormula', 'setNumberFormat', 'setNumberFormats', 'clearContent', 'clear']);
holdUntilFlush(FakeSheet, ['appendRow', 'deleteRows', 'deleteRow', 'insertRowsAfter', 'insertColumnsAfter', 'clear', 'clearContents']);

/* ------------------------------------------------ Sheets.Spreadsheets.Values.batchGet ---- */

const SERIAL_ZERO = Date.UTC(1899, 11, 30);

/** A Date the way the values API sends it: days since 1899-12-30, on the spreadsheet's clock. That clock reading is all a sheet keeps. */
function dateToSerial(date, timeZone) {
  const z = zoned(date, timeZone);
  const ms = date.getTime() - Math.floor(date.getTime() / 1000) * 1000;
  return (Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second, ms) - SERIAL_ZERO) / 86400000;
}

/**
 * "'Time Off'", "Schedule!A1:Z1000" or "'Log'!1:1" -> {tab, firstRow, lastRow, firstColumn, lastColumn}, with
 * Infinity for no end. Without quotes, a tab name can only have letters, numbers and underscores in it.
 */
function parseRange(text) {
  const match = /^(?:'((?:[^']|'')+)'|([A-Za-z0-9_]+))(?:!(.+))?$/.exec(text);
  if (!match) return null;
  const tab = match[1] === undefined ? match[2] : match[1].replace(/''/g, "'");
  if (!match[3]) return { tab, firstRow: 1, lastRow: Infinity, firstColumn: 1, lastColumn: Infinity };
  const rows = /^(\d+):(\d+)$/.exec(match[3]);
  if (rows) return { tab, firstRow: Number(rows[1]), lastRow: Number(rows[2]), firstColumn: 1, lastColumn: Infinity };
  const box = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(match[3]);
  if (!box) return null;
  return { tab, firstRow: Number(box[2]), lastRow: Number(box[4]), firstColumn: letterToColumn(box[1]), lastColumn: letterToColumn(box[3]) };
}

/** One entry of the reply. Only what has been sent to the sheet, with blanks at the end of a row or the range left out, and no values at all if that's everything. */
function valueRange(book, text) {
  const wanted = parseRange(text);
  const sheet = wanted && book.getSheetByName(wanted.tab);
  if (!sheet) throw new Error(`API call to sheets.spreadsheets.values.batchGet failed with error: Unable to parse range: ${text}`);
  const grid = sheet.sent || sheet.grid;
  const lastRow = Math.min(wanted.lastRow, sheet.maxRows);
  const lastColumn = Math.min(wanted.lastColumn, sheet.maxColumns);
  const values = [];
  for (let r = wanted.firstRow; r <= Math.min(lastRow, grid.length); r++) {
    const line = grid[r - 1];
    const cells = [];
    for (let c = wanted.firstColumn; c <= Math.min(lastColumn, line.length); c++) {
      const cell = line[c - 1];
      if (!cell) cells.push('');
      else cells.push(isDate(cell.value) ? dateToSerial(cell.value, book.getSpreadsheetTimeZone()) : cell.value);
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    values.push(cells);
  }
  while (values.length && !values[values.length - 1].length) values.pop();
  const name = /^[A-Za-z0-9_]+$/.test(wanted.tab) ? wanted.tab : `'${wanted.tab}'`;
  const entry = { range: `${name}!${columnToLetter(wanted.firstColumn)}${wanted.firstRow}:${columnToLetter(lastColumn)}${lastRow}`, majorDimension: 'ROWS' };
  if (values.length) entry.values = values;
  return entry;
}

/* --------------------------------------------------------------------- the world ---- */

function plainFilesInOrder() {
  // Alphabetical, like clasp pushes them. Api.js runs first, so a file that needs another at load time fails here.
  return fs
    .readdirSync(SCRIPT_DIR)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => new vm.Script(fs.readFileSync(path.join(SCRIPT_DIR, file), 'utf8'), { filename: path.join(SCRIPT_DIR, file) }));
}

let compiled = null;

/**
 * A fresh fake world: empty properties, empty cache, no sheets, no mail. Each call is its
 * own Apps Script project.
 */
function createGas(options) {
  const settings = options || {};
  const state = {
    books: new Map(),
    properties: new Map(),
    cache: new Map(),
    triggers: [],
    mail: [],
    logs: [],
    counters: { openById: 0, mail: 0, batchGet: 0, flush: 0, sheetReads: 0, readCalls: {} },
    batchRanges: [], // the ranges asked for by each batchGet
    runDepth: 0, // above zero while a script is running
    reading: false,
    lockBusy: false,
    beforeMail: null, // set to a function to make a send throw, for crash tests
    beforeBatch: null, // set to a function to make batchGet throw, or return something for it to answer with instead
    year: () => new Date(clock()).getFullYear(),
  };

  const clock = () => {
    const now = context.__NOW__;
    return now ? new Date(now).getTime() : Date.now();
  };

  const scriptProperties = {
    getProperty: (key) => (state.properties.has(key) ? state.properties.get(key) : null),
    setProperty(key, value) {
      state.properties.set(key, String(value));
      return this;
    },
    setProperties(values) {
      Object.keys(values).forEach((key) => state.properties.set(key, String(values[key])));
      return this;
    },
    getProperties: () => Object.fromEntries(state.properties),
    getKeys: () => Array.from(state.properties.keys()),
    deleteProperty(key) {
      state.properties.delete(key);
      return this;
    },
    deleteAllProperties() {
      state.properties.clear();
      return this;
    },
  };

  const scriptCache = {
    get(key) {
      const entry = state.cache.get(key);
      if (!entry) return null;
      if (entry.until <= clock()) {
        state.cache.delete(key);
        return null;
      }
      return entry.value;
    },
    put(key, value, seconds) {
      state.cache.set(key, { value: String(value), until: clock() + (seconds === undefined ? 600 : seconds) * 1000 });
    },
    remove(key) {
      state.cache.delete(key);
    },
  };

  const scriptLock = {
    tryLock: () => !state.lockBusy,
    waitLock() {
      if (state.lockBusy) throw new Error('Lock timeout');
    },
    hasLock: () => !state.lockBusy,
    releaseLock() {},
  };

  const addBook = (id, name) => {
    const book = new FakeBook(id, name, state);
    state.books.set(id, book);
    return book;
  };

  const sendWaitingWrites = () => {
    state.books.forEach((book) => {
      book.sheets.forEach((sheet) => {
        sheet.sent = null;
      });
    });
  };

  const SpreadsheetApp = {
    openById(id) {
      state.counters.openById += 1;
      if (!state.books.has(id)) throw new Error('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
      return state.books.get(id);
    },
    create: (name) => addBook('created-' + crypto.randomUUID(), name),
    flush() {
      if (state.runDepth) state.counters.flush += 1;
      sendWaitingWrites();
    },
    getActiveSpreadsheet: () => null,
  };

  const Sheets = {
    Spreadsheets: {
      Values: {
        batchGet(id, options) {
          state.counters.batchGet += 1;
          state.batchRanges.push(Array.from(options.ranges));
          if (state.beforeBatch) {
            const answer = state.beforeBatch(id, options);
            if (answer !== undefined) return answer;
          }
          if (!state.books.has(id)) throw new Error('API call to sheets.spreadsheets.values.batchGet failed with error: Requested entity was not found.');
          if (options.valueRenderOption !== 'UNFORMATTED_VALUE' || options.dateTimeRenderOption !== 'SERIAL_NUMBER') throw new Error('The mock batchGet only does UNFORMATTED_VALUE with SERIAL_NUMBER.');
          return { spreadsheetId: id, valueRanges: options.ranges.map((range) => valueRange(state.books.get(id), range)) };
        },
      },
    },
  };

  const triggerBuilder = (handler) => {
    const trigger = { handler, kind: '', minutes: 0, getHandlerFunction: () => handler };
    const builder = {
      timeBased() {
        trigger.kind = 'time';
        return builder;
      },
      everyMinutes(minutes) {
        trigger.minutes = minutes;
        return builder;
      },
      create() {
        state.triggers.push(trigger);
        return trigger;
      },
    };
    return builder;
  };

  const MailApp = {
    sendEmail(message, subject, body, extra) {
      const mail = typeof message === 'object' ? message : Object.assign({ to: message, subject, body }, extra || {});
      state.counters.mail += 1;
      if (state.beforeMail) state.beforeMail(mail, state.counters.mail);
      state.mail.push(Object.assign({ at: new Date(clock()).toISOString() }, JSON.parse(JSON.stringify(mail))));
    },
    getRemainingDailyQuota: () => 100,
  };

  const textOutput = (text) => {
    const output = {
      content: String(text),
      mime: 'TEXT',
      getContent: () => output.content,
      setContent(next) {
        output.content = String(next);
        return output;
      },
      getMimeType: () => output.mime,
      setMimeType(mime) {
        output.mime = mime;
        return output;
      },
    };
    return output;
  };

  const quietConsole = {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    quietConsole[level] = (...args) => {
      state.logs.push({ level, text: args.map(String).join(' ') });
      if (settings.echoConsole && level === 'error') console.error(...args);
    };
  });

  const context = vm.createContext({
    SpreadsheetApp,
    Sheets,
    PropertiesService: { getScriptProperties: () => scriptProperties },
    CacheService: { getScriptCache: () => scriptCache },
    LockService: { getScriptLock: () => scriptLock },
    MailApp,
    ScriptApp: {
      getProjectTriggers: () => state.triggers.slice(),
      deleteTrigger(trigger) {
        state.triggers = state.triggers.filter((other) => other !== trigger);
      },
      newTrigger: triggerBuilder,
    },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      sleep() {},
    },
    Session: { getScriptTimeZone: () => 'America/Denver' },
    ContentService: { createTextOutput: textOutput, MimeType: { JSON: 'JSON', TEXT: 'TEXT' } },
    console: quietConsole,
    __NOW__: null,
  });

  if (!compiled) compiled = plainFilesInOrder();
  compiled.forEach((script) => script.runInContext(context));

  /** One run of the script. At the end, Apps Script sends anything still waiting, and the next run starts empty. */
  const run = (work) => {
    state.runDepth += 1;
    try {
      return work();
    } finally {
      state.runDepth -= 1;
      if (!state.runDepth) {
        sendWaitingWrites();
        context.REQ_ = null;
      }
    }
  };
  ['doGet', 'doPost', 'tick'].forEach((name) => {
    const real = context[name];
    context[name] = (...args) => run(() => real(...args));
  });

  const reply = (output) => JSON.parse(output.getContent());

  const gas = {
    context,
    state,

    /** Set the fake clock from anything Date can read, or pass nothing for the real time. */
    setNow(value) {
      context.__NOW__ = value ? new Date(value).toISOString() : null;
    },
    now: () => new Date(clock()),

    /** A GET to the web app, as Apps Script would deliver it: every parameter a string. */
    get(params) {
      const parameter = {};
      Object.keys(params || {}).forEach((key) => {
        parameter[key] = String(params[key]);
      });
      return reply(context.doGet({ parameter }));
    },
    /** A POST to the web app, with the body as text. */
    post(body) {
      const contents = typeof body === 'string' ? body : JSON.stringify(body);
      return reply(context.doPost({ parameter: {}, postData: { contents, type: 'text/plain' } }));
    },
    tick: () => JSON.parse(JSON.stringify(context.tick())),

    /** Call any function in the script's global scope, as a run of its own. */
    call(name, ...args) {
      return run(() => {
        context.resetRequestCache_();
        const out = context[name](...args);
        return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
      });
    },

    /** One whole run: `work` gets the script's global scope, and everything it does shares one per-run cache. */
    run(work) {
      return run(() => {
        context.resetRequestCache_();
        return work(context);
      });
    },

    /** An empty spreadsheet, as if someone made one and passed its ID to setup. */
    createBook(name) {
      return addBook('book-' + crypto.randomUUID(), name || 'Koda Operations').getId();
    },
    book() {
      return state.books.get(state.properties.get('SHEET_ID'));
    },
    sheet(tab) {
      return gas.book().getSheetByName(tab);
    },
    /** A tab's stored values as objects by header, with `_row`: what a test would see looking at the sheet. */
    rows(tab) {
      const sheet = gas.sheet(tab);
      const values = sheet.getDataRange().getValues();
      const headers = values[0];
      return values.slice(1).map((cells, index) => {
        const row = { _row: index + 2 };
        headers.forEach((header, column) => {
          row[header] = cells[column];
        });
        return row;
      });
    },

    /**
     * A fake source sheet like the real one: an "employees and rankings" tab with the fake staff,
     * set tasks in words rather than IDs. Managers aren't on it. Returns its ID.
     */
    addFakeSource(rows) {
      const id = 'source-' + crypto.randomUUID();
      const book = addBook(id, 'Fake source');
      const tab = book.insertSheet('employees and rankings');
      tab.appendRow(['Ranking', 'Name', 'Email', 'Days', 'Set Tasks']);
      const wording = { T08: 'deep cleaning lobby, kitchen, and bathrooms', T15: 'Floors' };
      (rows || fakeSourceRows(wording)).forEach((line) => tab.appendRow(line));
      return id;
    },
  };
  return gas;
}

function fakeSourceRows(wording) {
  return STAFF.filter((person) => person.type !== 'Manager').map((person) => [
    person.rank,
    person.name,
    person.email,
    person.setDays.join(', '),
    person.setTasks.length ? wording[person.setTasks[0].taskId] : '',
  ]);
}

/** The two fake managers, in the shape adminSetup's request wants. */
function fakeManagers() {
  return STAFF.filter((person) => person.type === 'Manager').map((person) => ({ name: person.name, email: person.email }));
}

module.exports = { createGas, fakeManagers, formatDate, dateToSerial };
