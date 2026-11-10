'use strict';

/**
 * walkthrough.js: walks the real site in headless Edge and saves a screenshot of each screen
 * to dev/screenshots/. Clicks are real mouse events at the element's real position, and a
 * click fails if something else is covering the spot. `node dev/walkthrough.js`
 *
 * Start `node dev/server.js` first. `node dev/walkthrough.js today offline` runs just those scenes:
 * signin, today, schedule, availability, hours, manage, desktop, narrow, stress, late, idle, links,
 * slow, deadlines, pwa, offline, review.
 *
 * Talks to Edge over the DevTools protocol with Node's built-in WebSocket. No dependencies.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SITE = process.env.SITE || 'http://localhost:8787';
const PORT = 9333;
const SHOTS = path.join(__dirname, 'screenshots');
const PROFILE = path.join(SHOTS, '.edge-profile');
const CODE = '000000';

const results = { pass: 0, fail: [] };
function check(ok, message) {
  if (ok) {
    results.pass += 1;
  } else {
    results.fail.push(message);
    console.log(`  FAIL: ${message}`);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------- the browser ---- */

async function launch() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const child = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 60; i++) {
    try {
      const reply = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (reply.ok) return reply.json();
    } catch (err) {
      await sleep(250);
    }
  }
  throw new Error('Edge did not open its debugging port');
}

/* Taps the + on one day of the availability form, half an hour a tap. */
async function addDayHours(page, day, hours) {
  for (let i = 0; i < hours * 2; i++) await page.click(`[data-act=day-step][data-day=${day}][data-delta="0.5"]`);
}

class Page {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.waiting = new Map();
    this.listeners = new Map();
    this.errors = [];
    this.allowErrors = false;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.waiting.has(message.id)) {
        const { resolve, reject } = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      (this.listeners.get(message.method) || []).forEach((listener) => listener(message.params));
    });
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  async start() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
    this.on('Runtime.exceptionThrown', (params) => this.noteError('exception', params.exceptionDetails.exception ? params.exceptionDetails.exception.description : params.exceptionDetails.text));
    this.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') this.noteError('console.error', params.args.map((arg) => arg.value || arg.description).join(' '));
    });
    this.on('Log.entryAdded', (params) => {
      if (params.entry.level === 'error') this.noteError('log', params.entry.text + ' ' + (params.entry.url || ''));
    });
  }
  noteError(kind, text) {
    if (this.allowErrors) return;
    if (text.includes('/favicon.ico')) return; // only asked for while clearSite is on the manifest, never by the site itself
    this.errors.push(`${kind}: ${text}`);
    console.log(`  CONSOLE ERROR ${kind}: ${text}`);
  }
  async viewport(width, height, mobile) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile });
    this.size = { width, height };
  }
  async goto(url) {
    const loaded = new Promise((resolve) => {
      const once = () => {
        this.listeners.set('Page.loadEventFired', []);
        resolve();
      };
      this.on('Page.loadEventFired', once);
    });
    await this.send('Page.navigate', { url: url.startsWith('http') ? url : SITE + url });
    await loaded;
    await sleep(250);
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(`Page threw: ${JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails.text)} in ${expression}`);
    return result.result.value;
  }
  async waitFor(selector, timeoutMs) {
    const until = Date.now() + (timeoutMs || 5000);
    for (;;) {
      if (await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      if (Date.now() > until) throw new Error(`Never saw ${selector}`);
      await sleep(60);
    }
  }
  async waitText(text, timeoutMs) {
    const until = Date.now() + (timeoutMs || 5000);
    for (;;) {
      if (await this.eval(`document.body.innerText.includes(${JSON.stringify(text)})`)) return true;
      if (Date.now() > until) throw new Error(`Never saw the text "${text}"`);
      await sleep(60);
    }
  }
  async gone(text, timeoutMs) {
    const until = Date.now() + (timeoutMs || 5000);
    for (;;) {
      if (!(await this.eval(`document.body.innerText.includes(${JSON.stringify(text)})`))) return true;
      if (Date.now() > until) throw new Error(`The text "${text}" never went away`);
      await sleep(60);
    }
  }
  async hasText(text) {
    return this.eval(`document.body.innerText.includes(${JSON.stringify(text)})`);
  }
  /* A real click at the element's middle. It fails if something else is on top of that spot. */
  async click(selector, options) {
    const settings = options || {};
    const finder = settings.text
      ? `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((el) => el.offsetParent !== null && el.innerText.trim() === ${JSON.stringify(settings.text)})`
      : `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((el) => el.offsetParent !== null)`;
    await this.waitFor(selector);
    const spot = await this.eval(`(() => {
      const el = ${finder};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const top = document.elementFromPoint(x, y);
      return { x, y, width: box.width, height: box.height, clear: !!top && (el === top || el.contains(top) || top.contains(el)), on: top ? top.className || top.tagName : '' };
    })()`);
    if (!spot) throw new Error(`Nothing visible matches ${selector} ${settings.text || ''}`);
    if (!spot.clear) throw new Error(`Something covers ${selector} ${settings.text || ''}: ${spot.on}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
    await sleep(settings.settle === undefined ? 90 : settings.settle);
    return spot;
  }
  async type(selector, text) {
    await this.click(selector);
    await this.send('Input.insertText', { text });
    await sleep(40);
  }
  /* For date and time pickers, which can't be typed into over this protocol. */
  async setValue(selector, value) {
    await this.waitFor(selector);
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(40);
  }
  async shot(name, options) {
    const full = options && options.full;
    let clip;
    if (full) {
      const size = await this.eval('({ width: document.documentElement.clientWidth, height: Math.max(document.documentElement.scrollHeight, innerHeight) })');
      clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
    }
    await sleep(320);
    const result = await this.send('Page.captureScreenshot', Object.assign({ format: 'png', captureBeyondViewport: !!full }, clip ? { clip } : {}));
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(result.data, 'base64'));
  }
  async noSideScroll(where) {
    const size = await this.eval('({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })');
    check(size.scroll <= size.client, `${where}: sideways scroll, ${size.scroll} wide in ${size.client}`);
    // The same few rules on every screen that gets checked: readable text, big enough targets.
    const problems = await this.eval(`(() => {
      const shown = (el) => el.offsetParent !== null && !el.closest('.sr');
      const name = (el) => el.tagName + '.' + el.className + ' "' + (el.innerText || el.getAttribute('aria-label') || '').slice(0, 24) + '"';
      const small = Array.from(document.querySelectorAll('body *')).filter((el) => shown(el) && Array.from(el.childNodes).some((node) => node.nodeType === 3 && node.nodeValue.trim()) && parseFloat(getComputedStyle(el).fontSize) < 13).map(name);
      const inputs = Array.from(document.querySelectorAll('input,select,textarea')).filter((el) => shown(el) && parseFloat(getComputedStyle(el).fontSize) < 16).map(name);
      const tiny = Array.from(document.querySelectorAll('button')).filter(shown).filter((el) => {
        const box = el.getBoundingClientRect();
        return box.height < 38 || box.width < 34;
      }).map((el) => name(el) + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height));
      const plain = Array.from(document.querySelectorAll('[data-act]')).filter((el) => shown(el) && el.tagName !== 'BUTTON' && el.dataset.act !== 'sheet-dismiss').map(name);
      return { small, inputs, tiny, plain };
    })()`);
    check(!problems.small.length, `${where}: text under 13px: ${problems.small.join(', ')}`);
    check(!problems.inputs.length, `${where}: inputs under 16px: ${problems.inputs.join(', ')}`);
    check(!problems.tiny.length, `${where}: small tap targets: ${problems.tiny.join(', ')}`);
    check(!problems.plain.length, `${where}: actions that aren't real buttons: ${problems.plain.join(', ')}`);
  }
  async resetWorld(query) {
    const reply = await fetch(`${SITE}/dev/reset${query || ''}`);
    if (!reply.ok) throw new Error('Reset failed');
  }
  async clearSite() {
    await this.goto('/assets/manifest.webmanifest');
    await this.eval('localStorage.clear(); sessionStorage.clear();');
  }
  async fresh(url, query) {
    await this.resetWorld(query);
    await this.clearSite();
    await this.goto(url);
  }
}

async function open() {
  await launch();
  const reply = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await reply.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  const page = new Page(socket);
  await page.start();
  return page;
}

async function closeBrowser() {
  try {
    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve));
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(400);
  } catch (err) {
    /* already gone */
  }
}

async function api(body) {
  const reply = await fetch(`${SITE}/api`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  return reply.json();
}
async function boot(name) {
  return (await fetch(`${SITE}/api?action=boot&name=${encodeURIComponent(name)}`)).json();
}
async function setTime(iso) {
  await fetch(`${SITE}/dev/time?set=${encodeURIComponent(iso)}`);
}
/* Managers land on Overview. The Week board is one tap over. */
const OVERVIEW = 'Hours logged';
async function toWeek(page) {
  await page.click('.seg button', { text: 'Week' });
  await page.waitText('On the clock now');
}
/* Week view against the server's own board: a chip per person per day, one color per person, and a dropdown each. */
async function checkWeekView(page, where) {
  const board = await api({ action: 'mgrBoard', code: CODE, weekOf: await page.eval('S.mgr.weekOf || startWeek(S.view)') });
  const seen = await page.eval(`(() => ({
    pressed: document.querySelector('.wv-seg button[aria-pressed=true]').innerText,
    days: document.querySelectorAll('.wv-day').length,
    chips: Array.from(document.querySelectorAll('.wv-chip')).map((el) => el.dataset.name + '|' + el.closest('.wv-day').dataset.key),
    colors: Array.from(document.querySelectorAll('.wv-chip, .wp')).map((el) => [(el.dataset.name || el.dataset.key.slice(3)), getComputedStyle(el).getPropertyValue('--pc').trim()]),
    people: Array.from(document.querySelectorAll('.wp')).map((el) => el.dataset.key.slice(3)),
  }))()`);
  const chips = [];
  board.days.forEach((day) => day.groups.forEach((group) => chips.push(group.name + '|wv:' + day.date)));
  const names = board.people.map((person) => person.name);
  board.days.forEach((day) => day.groups.forEach((group) => { if (names.indexOf(group.name) < 0) names.push(group.name); }));
  board.days.forEach((day) => (day.extras || []).forEach((item) => { if (names.indexOf(item.name) < 0) names.push(item.name); }));
  const colorOf = {};
  const steady = seen.colors.every(([name, color]) => color && (colorOf[name] = colorOf[name] || color) === color);
  const distinct = new Set(Object.values(colorOf)).size === Object.keys(colorOf).length;
  check(seen.pressed === 'Week view', `${where}: Week view is the one showing (${seen.pressed})`);
  check(seen.days === 7, `${where}: seven days across`);
  check(JSON.stringify(seen.chips) === JSON.stringify(chips), `${where}: a chip for everyone working each day, matching the server (${seen.chips.length} of ${chips.length})`);
  check(JSON.stringify(seen.people) === JSON.stringify(names), `${where}: a dropdown for each person (${seen.people})`);
  check(steady, `${where}: each person keeps one color everywhere`);
  check(distinct, `${where}: no two people share a color`);
}
/* What the Overview should show, checked against the server's own answer. */
async function checkOverview(page, where) {
  const reply = await api({ action: 'mgrOverview', code: CODE });
  const seen = await page.eval(`(() => {
    const text = document.querySelector('.ov').innerText;
    return {
      pressed: document.querySelector('.mg-seg button[aria-pressed=true]').innerText,
      label: document.querySelector('.ov-head .h2').innerText,
      stats: Array.from(document.querySelectorAll('.ov-stat b')).map((el) => Number(el.innerText)),
      days: document.querySelectorAll('.ov-day').length,
      hourRows: document.querySelectorAll('.ov-table tbody tr').length,
      hourNames: Array.from(document.querySelectorAll('.ov-table tbody .ov-name')).map((el) => el.innerText.trim()),
      dayCounts: Array.from(document.querySelectorAll('.ov-day')).map((el) => (el.querySelector('.ov-day-count') || {}).innerText || ''),
      dots: document.querySelectorAll('.ov-table .ov-dot').length,
      tasks: document.querySelectorAll('.ov-item[data-key^="ovt:"]').length,
      oneOffs: document.querySelectorAll('.ov-item[data-key^="ovo:"]').length,
      totals: Array.from(document.querySelectorAll('.ov-table tfoot td')).map((el) => el.innerText),
      times: /\d:\d\d|\b(AM|PM)\b/.test(text),
    };
  })()`);
  check(seen.pressed === 'Overview', `${where}: Overview is the part showing (${seen.pressed})`);
  check(seen.label === reply.label, `${where}: this week's label (${seen.label})`);
  check(JSON.stringify(seen.stats) === JSON.stringify([reply.counts.done, reply.counts.open, reply.counts.missed, reply.counts.uncovered]), `${where}: the four counts match the server (${seen.stats})`);
  check(seen.days === 7, `${where}: one line per day`);
  check(reply.days.every((day, i) => !day.total || seen.dayCounts[i].includes(day.done + ' of ' + day.total)), `${where}: every day with tasks shows its count, closed or not (${seen.dayCounts})`);
  check(new Set(seen.hourNames).size === seen.hourNames.length, `${where}: no two hours rows read the same (${seen.hourNames})`);
  check(seen.hourRows === reply.hours.people.length, `${where}: one hours row per person (${seen.hourRows})`);
  check(seen.dots === reply.hours.people.filter((one) => one.onClock).length, `${where}: a dot for each person on the clock (${seen.dots})`);
  check(seen.totals[1] === String(reply.hours.thisWeek) && seen.totals[2] === String(reply.hours.lastWeek), `${where}: the totals match (${seen.totals})`);
  check(seen.tasks === reply.tasks.length, `${where}: every regular task is listed (${seen.tasks})`);
  check(seen.oneOffs === reply.oneOffs.length, `${where}: every one-off this week is listed (${seen.oneOffs})`);
  check(!seen.times, `${where}: no times of day`);
}

/* ------------------------------------------------------------------------ scenes ---- */

const SCENES = {
  async signin(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/');
    await page.waitText('Who are you?');
    await page.waitFor('.person');
    await page.shot('phone-signin');
    check((await page.eval(`document.querySelectorAll('.person').length`)) === 10, 'sign-in lists all 10 people');
    check((await page.eval(`document.querySelectorAll('.person')[0].innerText.trim()`)).endsWith('Ana'), 'sign-in is alphabetical, so it does not show the ranking');
    await page.click('.person', { text: 'A\nAna' }).catch(() => page.click('.person'));
    await page.waitText('Hi, Ana');
    check(await page.eval(`localStorage.getItem('koda-ops.v1.me') === '"Ana"'`), 'the name is remembered');
    await page.goto('/');
    await page.waitText('Hi, Ana');
    check(true, 'a reload stays signed in');

    await page.click('.top-me');
    await page.waitText('Not you? Switch person');
    await page.shot('phone-person-sheet');
    await page.click('.sheet .btn', { text: 'Not you? Switch person' });
    await page.waitText('Who are you?');

    // A manager gets the code step, once.
    await page.waitFor('.person');
    const buttons = await page.eval(`Array.from(document.querySelectorAll('.person')).map((el) => el.innerText.trim())`);
    await page.click(`.person[data-name="Max"]`);
    await page.waitText('Manager code');
    await page.shot('phone-manager-code');
    await page.type('.signin input', 'wrong');
    await page.click('.signin button[type=submit]');
    await page.waitText("That manager code isn't right.");
    await page.eval(`document.querySelector('.signin input').select()`);
    await page.send('Input.insertText', { text: CODE });
    await page.click('.signin button[type=submit]');
    await page.waitText(OVERVIEW);
    check(await page.eval(`document.querySelector('.tab[aria-current=page]').innerText.includes('Manage')`), 'managers land on Manage');
    check(buttons.length === 10, 'still 10 people');
    await page.goto('/');
    await page.waitText(OVERVIEW);
    check(!(await page.hasText('Manager code')), 'the code is only asked for once on a device');

    // Links.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Ben&tab=availability&week=2026-11-23');
    await page.waitText('Week of Nov 23');
    check((await page.eval('location.search')) === '', 'the link is cleaned out of the address bar');
    check(await page.eval(`document.querySelector('.wk-chip[aria-pressed=true]').innerText.includes('Nov 23')`), '?week= opens that week');
    await page.noSideScroll('link');

    // A name that is not on the list goes back to sign-in, with the reason.
    await page.clearSite();
    await page.goto('/?me=Nobody');
    await page.waitText('Who are you?');
    await page.waitText("We can't find that name");
  },

  async today(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/?me=Ana');
    await page.waitText('Hi, Ana');
    await page.waitFor('.task');
    await page.shot('phone-today');
    check(!(await page.hasText('Scheduled')), 'the clock card has no scheduled time');
    check(await page.eval(`document.querySelector('.check').getAttribute('role') === 'checkbox'`), 'checks are role=checkbox');
    const check0 = await page.eval(`(() => { const b = document.querySelector('.check').getBoundingClientRect(); const row = document.querySelector('.task').getBoundingClientRect(); return { w: b.width, h: b.height, rowH: row.height }; })()`);
    check(check0.w >= 56, `the check zone is at least 56 wide (${check0.w})`);
    check(Math.abs(check0.h - check0.rowH) <= 1, `the check zone is the full row height (${check0.h} of ${check0.rowH})`);
    check(await page.eval(`document.querySelector('.task').innerText.includes('Top priority')`), 'the top priority task is first, with its chip');
    check(await page.eval(`[...document.querySelectorAll('.task')].every((row) => !row.innerText.includes('About '))`), 'tasks do not show how long they should take');

    // The check is instant: right after the click, with no time for a round trip.
    await page.click('.check', { settle: 0 });
    const instant = await page.eval(`document.querySelector('.check').getAttribute('aria-checked')`);
    check(instant === 'true', 'the check shows immediately');
    await page.waitText('1 of 9 done');
    await page.waitText("You're not clocked in");
    await page.shot('phone-today-nudge');
    await page.click('.nudge .btn', { text: 'Clock in' });
    await page.waitText('On the clock since');
    await page.gone("You're not clocked in");
    await page.shot('phone-today-clocked-in');
    await sleep(300);
    check((await boot('Ana')).clock.status === 'in', 'the clock-in reached the server');
    check((await boot('Ana')).today.tasks[0].done, 'the check reached the server');

    // Undo.
    await page.click('.check');
    await page.waitText('0 of 9 done');
    await sleep(250);
    check(!(await boot('Ana')).today.tasks[0].done, 'tapping again undoes it');
    check(!(await page.hasText("You're not clocked in")), 'the banner stays gone');

    // Note.
    await page.click('.task-main');
    await page.waitText('Add a note');
    await page.shot('phone-today-note');
    await page.send('Input.insertText', { text: 'Rower 4 chain is <b>loose</b> & "stuck"' });
    await page.click('.note-edit .btn', { text: 'Save note' });
    await page.waitText('Rower 4 chain is <b>loose</b> & "stuck"');
    check(await page.eval(`!document.querySelector('.task-note b')`), 'notes are escaped, never markup');
    await sleep(250);
    check((await boot('Ana')).today.tasks[0].note.includes('Rower 4'), 'the note reached the server');
    await page.click('.task-main');
    await page.waitText('Save note');
    await page.click('.note-edit .btn', { text: 'Save note' });
    await sleep(250);
    check((await boot('Ana')).today.tasks[0].note.includes('Rower 4'), 'saving a note without touching it keeps it');

    // Extra work.
    check(await page.hasText('Anything else you did today?'), 'the extra work box shows');
    await page.eval(`document.querySelector('[data-form=extra]').scrollIntoView()`);
    await page.click('[data-form=extra]');
    await page.type('[data-form=extra]', 'Fixed the loose rower chain');
    await page.click('#extras button[type=submit]');
    await page.waitText('Added.');
    check((await boot('Ana')).today.extras.some((item) => item.text.includes('rower chain')), 'extra work reached the server');
    await page.shot('phone-today-extra-work');
    await page.click('[data-act=extra-remove]');
    await page.gone('Fixed the loose rower chain');
    check((await boot('Ana')).today.extras.length === 0, 'removing it reached the server');

    // Open tasks.
    check(await page.hasText('1 open task today'), 'open tasks row shows');
    await page.click('.open-toggle');
    await page.waitText('Take it');
    await page.shot('phone-today-open-tasks');
    check(await page.eval(`[...document.querySelectorAll('.open-row')].every((row) => !row.innerText.includes('About '))`), 'open tasks do not show how long they should take');
    check(await page.eval(`document.querySelector('.open-row .btn').getBoundingClientRect().bottom <= document.querySelector('.tabbar').getBoundingClientRect().top`), 'opening the open tasks brings them up from under the tab bar');
    await page.click('.open-row .btn', { text: 'Take it', settle: 0 });
    await page.waitText("It's on your list.");
    await page.waitText('0 of 10 done');
    await page.gone("It's on your list.");
    await page.gone('open task today');
    await sleep(300);
    check((await boot('Ana')).today.tasks.some((task) => task.title.includes('Power wash')), 'taking a task reached the server');

    // All done, then clock out.
    const count = await page.eval(`document.querySelectorAll('.check').length`);
    for (let i = 0; i < count; i++) {
      await page.click(`.task:nth-child(${i + 1}) .check`, { settle: 30 });
    }
    await page.waitText('All done for today');
    await page.shot('phone-today-all-done');
    await sleep(900);
    check((await boot('Ana')).today.tasks.every((task) => task.done), 'every check reached the server, in order');
    await page.click('.alldone .btn', { text: 'Clock out' });
    await page.waitText('Clocked out at');
    check(!(await page.eval(`!!document.querySelector('.alldone .btn')`)), 'the clock out button goes away after clocking out');
    await sleep(300);
    check((await boot('Ana')).clock.status === 'out', 'the clock-out reached the server');
    check((await page.eval(`document.querySelector('.alldone').innerText`)).includes('Clocked out at'), 'the all-done card says they are clocked out');
    check((await page.eval(`document.querySelector('[data-act=clock-in]').innerText`)) === 'Clock back in', 'after clocking out, going back on the clock is the quiet button');
    await page.noSideScroll('today');

    // Stale clock-out.
    await page.clearSite();
    await page.goto('/?me=Cora');
    await page.waitText("You didn't clock out on Mon, Nov 9.");
    await page.shot('phone-today-stale');
    await page.click('.stale button[type=submit]');
    await page.waitText('Please pick a time.');
    await page.setValue('.stale input[type=time]', '07:00');
    await page.click('.stale button[type=submit]');
    await page.waitText('That time is before you clocked in.');
    await page.setValue('.stale input[type=time]', '10:30');
    await page.click('.stale button[type=submit]');
    await page.gone("You didn't clock out");
    await sleep(300);
    check((await boot('Cora')).hours.entries[0].flag === 'fixed', 'the fix reached the server, flagged fixed');
    check((await boot('Cora')).clock.stale.length === 0, 'nothing is stale after the fix');

    // Nothing today, with the clock still there.
    await page.clearSite();
    await page.goto('/?me=Dev');
    await page.waitText('Nothing on your list today.');
    await page.shot('phone-today-nothing');
    check(await page.eval(`!!document.querySelector('.clock-small [data-act=clock-in]')`), 'the clock button is still there on an empty day');
    await page.click('.clock [data-act=add-hours]');
    await page.waitText('Add hours');
    await page.shot('phone-add-hours');
    await page.click('.sheet button[type=submit]');
    await page.waitText('Please pick when you started and finished.');
    await page.setValue('.sheet input[data-field=start]', '08:00');
    await page.setValue('.sheet input[data-field=end]', '07:00');
    await page.click('.sheet button[type=submit]');
    await page.waitText('The end time has to be after the start time.');
    await page.setValue('.sheet input[data-field=end]', '09:00');
    await page.click('.sheet button[type=submit]');
    await page.waitText('Hours added.');
    await sleep(200);
    check((await boot('Dev')).hours.monthTotal === 1, 'added hours land in the total');
    await page.click('.clock-small [data-act=clock-in]');
    await page.waitText('Since 9:05 AM');
    await page.shot('phone-today-nothing-clocked-in');
    await sleep(900); // a second clock tap right after the first is ignored, on purpose
    await page.click('.clock-small [data-act=clock-out]');
    await page.waitText('Clocked out at');
    await page.noSideScroll('today, nothing');

    // Clocking straight back out, before the refresh after the clock-in has come back.
    await page.clearSite();
    await page.goto('/?me=Ben');
    await page.waitFor('.clock-small [data-act=clock-in]');
    await page.click('.clock-small [data-act=clock-in]', { settle: 0 });
    await sleep(820);
    await page.click('.clock-small [data-act=clock-out]', { settle: 30 });
    check(await page.hasText('Clocked out at'), 'clocking out right after clocking in shows at once');
  },

  async schedule(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/?me=Ana&tab=schedule', '?nextWeek=0');
    await page.waitText('This week');
    await page.waitFor('.day');
    await page.shot('phone-schedule');
    check(!(await page.eval(`/\\d:\\d\\d/.test(Array.from(document.querySelectorAll('.day-sub')).map((el) => el.innerText).join())`)), 'the days on Schedule have no times');
    await page.shot('phone-schedule-full', { full: true });
    check(await page.eval(`document.querySelector('.day-head[aria-expanded=true]').innerText.includes('Today')`), "today's tasks start open");
    // Expand another day, and check a task there.
    await page.click('.day-head[aria-expanded=false]');
    await sleep(120);
    await page.click('.seg button', { text: 'Next week' });
    await page.waitText("Next week's schedule comes out Friday at 7 AM.");
    await page.shot('phone-schedule-next-unpublished');
    await page.noSideScroll('schedule next');

    await page.fresh('/?me=Ana&tab=schedule');
    await page.click('.seg button', { text: 'Next week' });
    await page.waitFor('.day');
    await page.shot('phone-schedule-next');
    await page.click('.seg button', { text: 'This week' });
    await page.waitFor('.check');
    await page.click('.check');
    await page.waitText('1 of 9 done');
    await sleep(250);
    check((await boot('Ana')).today.tasks[0].done, 'a check on Schedule reaches the server');

    // Out of town is marked; set staff see set days.
    await page.clearSite();
    await page.goto('/?me=Gus&tab=schedule');
    await page.waitText('Out of town');
    await page.shot('phone-schedule-set-staff');
    check(await page.hasText('Out of town'), 'the out of town day is marked');
    await page.noSideScroll('schedule set staff');
  },

  async availability(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/?me=Ben&tab=availability&week=2026-11-23');
    await page.waitText('Week of Nov 23');
    await page.waitFor('.dh-list');
    await page.shot('phone-availability');
    await page.shot('phone-availability-full', { full: true });
    check((await page.eval(`document.querySelectorAll('.dh-row').length`)) === 7, 'one row a day, Monday to Sunday');
    check((await page.eval(`Array.from(document.querySelectorAll('.dh-day b')).map((el) => el.innerText).join()`)) === 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday', 'the days are in order, by name');
    await page.waitText('0 hours available');
    check((await page.eval('document.body.innerText')).replace(/\u00A0/g, ' ').includes('Due Friday, Nov 20 at 7:00 AM.'), 'the deadline reads in full');
    await page.noSideScroll('availability');

    // Save with nothing picked.
    await page.click('[data-act=avail-save]');
    await page.waitText('Please tell us how many hours you want this week.');

    // Copy last week.
    await page.click('[data-act=avail-copy]');
    await page.waitText('Copied the week of Nov 16');
    await page.waitText('6 hours available');
    check((await page.eval(`document.querySelector('.step-input').value`)) === '5', 'copy brings the hours wanted too');
    const dayValue = (day) => `document.querySelector('[data-act=day-step][data-day=${day}]').parentElement.querySelector('.dh-val b').innerText`;
    check((await page.eval(dayValue('Wed'))) === '3' && (await page.eval(dayValue('Fri'))) === '3' && (await page.eval(dayValue('Mon'))) === '0', 'copy brings the hours for each day');
    await page.shot('phone-availability-copied');

    // The steppers.
    await page.click('[data-act=hours-step][data-delta="0.5"]');
    check((await page.eval(`document.querySelector('.step-input').value`)) === '5.5', 'plus adds a half hour');
    await page.click('[data-act=hours-step][data-delta="-0.5"]');
    check((await page.eval(`document.querySelector('.step-input').value`)) === '5', 'minus takes off a half hour');
    await page.click('[data-act=avail-clear]');
    await page.waitText('0 hours available');
    const minusOff = (day) => `document.querySelector('[data-act=day-step][data-day=${day}][data-delta="-0.5"]').disabled`;
    check(await page.eval(minusOff('Mon')), 'a day at zero has nothing to take away');
    await page.click('[data-act=day-step][data-day=Mon][data-delta="0.5"]');
    await page.waitText('0.5 hours available');
    check((await page.eval(dayValue('Mon'))) === '0.5', 'plus adds a half hour to that day');
    check(!(await page.eval(minusOff('Mon'))), 'and minus wakes up');
    await page.click('[data-act=day-step][data-day=Mon][data-delta="0.5"]');
    await page.waitText('1 hour available');
    await page.click('[data-act=day-step][data-day=Mon][data-delta="-0.5"]');
    await page.waitText('0.5 hours available');
    await page.click('[data-act=day-step][data-day=Mon][data-delta="-0.5"]');
    await page.waitText('0 hours available');

    // Holding keeps it going, up to the limit for a day, and the lift doesn't add one more.
    const held = await page.eval(`(() => { const el = document.querySelector('[data-act=day-step][data-day=Wed][data-delta="0.5"]'); el.scrollIntoView({ block: 'center' }); const box = el.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: held.x, y: held.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: held.x, y: held.y, button: 'left', clickCount: 1 });
    await sleep(4400);
    check((await page.eval(dayValue('Wed'))) === '16', 'holding the plus stops at 16 hours');
    check(await page.eval(`document.querySelector('[data-act=day-step][data-day=Wed][data-delta="0.5"]').disabled`), 'and the plus turns off there');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: held.x, y: held.y, button: 'left', clickCount: 1 });
    await sleep(90);
    check((await page.eval(dayValue('Wed'))) === '16', 'letting go changes nothing');
    await page.click('[data-act=avail-clear]');
    await page.waitText('0 hours available');

    // Too few for what they want, and nothing at all.
    await page.click('[data-act=hours-step][data-delta="0.5"]');
    await page.click('[data-act=avail-save]');
    await page.waitText("Please add hours for at least one day, or tap Can't work this week.");
    await page.click('[data-act=hours-step][data-delta="-0.5"]');
    await addDayHours(page, 'Tue', 2);
    await page.waitText('You want 5 hours but only have 2 available.');
    await page.shot('phone-availability-fewer');
    check(await page.hasText('No exact times'), 'there is a short hint');
    check(!(await page.eval(`/\\d (AM|PM)/.test(document.querySelector('.dh-list').innerText)`)), 'no times of day on the form');
    const count = await page.eval(`(() => { document.querySelector('.dh-row:nth-child(4)').scrollIntoView({ block: 'center' }); const f = document.querySelector('.hours-foot').getBoundingClientRect(); const t = document.querySelector('.tabbar').getBoundingClientRect(); return { fBottom: f.bottom, tTop: t.top }; })()`);
    check(count.fBottom <= count.tTop + 1, 'the live total stays above the tab bar while on the days');
    await page.shot('phone-availability-scrolled');

    // A draft survives a reload.
    await page.goto('/');
    await page.waitText('2 hours available');
    check(true, 'a half-filled form survives a reload');

    // Save.
    await page.type('textarea[data-avail-notes]', 'Mornings are <best>');
    await page.click('[data-act=avail-save]');
    await page.waitText("You're all set!");
    await page.shot('phone-availability-success');
    const saved = await (await fetch(`${SITE}/api?action=availability&name=Ben&weekOf=2026-11-23`)).json();
    check(saved.hoursWanted === 5 && saved.dayHours.Tue === 2 && saved.notes === 'Mornings are <best>', 'the availability reached the server');
    await page.click('[data-act=avail-another]');
    await page.waitText('Week of Nov 30');
    check(await page.eval(`document.querySelector('.wk-chip[data-week="2026-11-23"]').innerText.includes('Filled in')`), 'the chip shows it is filled in');

    // Can't work.
    await page.click('[data-act=avail-none]');
    await page.waitText("We won't schedule you that week.");
    await page.shot('phone-availability-cant-work-confirm');
    await page.click('.sheet .btn', { text: "Yes, I can't work" });
    await page.waitText("You're all set!");
    await page.click('[data-act=avail-another]');
    await page.waitFor('.wk-chip[data-week="2026-11-30"]');
    await page.click('.wk-chip[data-week="2026-11-30"]');
    await page.waitText("You said you can't work");
    await page.shot('phone-availability-cant-work');
    await page.click('[data-act=avail-reopen]');
    await page.waitFor('.dh-list');

    // Thanksgiving is blocked out.
    await page.click('.wk-chip[data-week="2026-11-23"]');
    await page.waitText('Closed: Thanksgiving');
    check(await page.eval(`!document.querySelector('[data-act=day-step][data-day=Thu]') && document.querySelectorAll('.dh-row.off').length === 1`), 'closed days have no stepper');
    await page.shot('phone-availability-closed-day');

    // Past the deadline.
    await setTime('2026-11-13T07:01:00-07:00');
    await page.clearSite();
    await page.goto('/?me=Cora&tab=availability&week=2026-11-16');
    await page.waitFor('.dh-list');
    check(await page.hasText('The deadline has passed. You can still change this and pick up any tasks that are left.'), 'past-due wording, for a week they already filled in');
    await page.shot('phone-availability-past-due');

    // A draft saved by the old hour-by-hour form, and a saved copy of the old reply: the page just starts clean.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Ben&tab=availability&week=2026-11-23');
    await page.waitFor('.dh-list');
    await page.eval(`localStorage.setItem('koda-ops.v1.draft.Ben.2026-11-23', JSON.stringify({ slots: { Mon: [9, 10] }, hoursWanted: 3, notes: 'Old draft', base: '' }))`);
    await page.eval(`(() => { const key = 'koda-ops.v1.avail.Ben.2026-11-23'; const saved = JSON.parse(localStorage.getItem(key)); delete saved.dayHours; saved.slots = { Mon: [9] }; saved.hours = [9]; saved.last = { weekOf: '2026-11-16', slots: { Mon: [9] }, hoursWanted: 3 }; localStorage.setItem(key, JSON.stringify(saved)); })()`);
    await page.goto('/');
    await page.waitFor('.dh-list');
    await page.waitText('0 hours available');
    check(!(await page.hasText('Not saved yet.')), 'an old draft does not come back as unsaved work');
    check(await page.eval(`localStorage.getItem('koda-ops.v1.draft.Ben.2026-11-23') === null`), 'and it is gone');

    // Set staff.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Gus&tab=availability');
    await page.waitText("You're automatically on the schedule every Thu, Fri, Sun. Nothing to fill out.");
    await page.shot('phone-availability-set-staff');
    check(!(await page.eval(`!!document.querySelector('.dh-list')`)), 'set staff get no days to fill in');
    await page.setValue('[data-form=off][data-field=from]', '2026-11-20');
    check((await page.eval(`document.querySelector('[data-form=off][data-field=to]').value`)) === '2026-11-20', 'picking a from date fills the to date');
    await page.setValue('[data-form=off][data-field=to]', '2026-11-22');
    await page.type('[data-form=off][data-field=note]', 'Wedding');
    await page.click('.off-card button[type=submit]');
    await page.waitText('Nov 20 - 22');
    await page.shot('phone-out-of-town');
    const lines = await page.eval(`document.querySelectorAll('.off-row').length`);
    check(lines === 2, `two upcoming trips are listed (${lines})`);
    await page.click('.off-row .btn', { text: 'Remove' });
    await page.gone('Nov 12');
    await sleep(300);
    check((await boot('Gus')).timeOff.length === 1, 'removing a trip reached the server');
    await page.noSideScroll('out of town');
  },

  async hours(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/?me=Ana&tab=hours');
    await page.waitText('hours in November');
    await page.shot('phone-hours');
    check(!(await page.hasText('$')), 'no dollars');
    await page.noSideScroll('hours');
    await page.click('.top ~ *, .link', { text: 'Forgot to clock in? Add hours.' });
    await page.waitFor('.sheet');
    await page.click('.sheet [data-act=sheet-close]');
    await page.gone('Save hours');
    check(await page.hasText('Added by you'), 'a manual entry shows a quiet label');

    // A missing clock-out has a Fix button.
    await page.clearSite();
    await page.goto('/?me=Cora&tab=hours');
    await page.waitText('no clock-out');
    check(await page.eval(`getComputedStyle(document.querySelector('.entry-time.danger')).color === 'rgb(180, 35, 24)'`), 'a missing clock-out is in the danger color');
    await page.shot('phone-hours-missing');
    await page.click('[data-act=fix-hours]');
    await page.waitText('What time did you finish?');
    await page.shot('phone-hours-fix');
    await page.setValue('.sheet input[type=time]', '10:00');
    await page.click('.sheet button[type=submit]');
    await page.gone('no clock-out');
    await page.waitText('Fixed');
    await sleep(400);
    check((await page.eval(`document.querySelector('.total-num').innerText`)) === '2', 'the fixed entry shows in the total');
    check((await boot('Cora')).hours.monthTotal === 2, 'the fixed entry counts');
  },

  async manage(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/');
    await page.waitFor('.person[data-name="Max"]');
    await page.click('.person[data-name="Max"]');
    await page.waitFor('.signin input');
    await page.type('.signin input', CODE);
    await api({ action: 'clockIn', name: 'Ben' });
    await page.click('.signin button[type=submit]');
    await page.waitText(OVERVIEW);
    await page.waitFor('.ov-dot');
    await page.shot('phone-manage-overview');
    await page.shot('phone-manage-overview-full', { full: true });
    await page.noSideScroll('manage overview');
    await checkOverview(page, 'phone overview');
    check(await page.hasText('Replace the lobby light bulbs'), "this week's one-offs show");
    check(await page.eval(`!!document.querySelector('.ov-stat.is-bad')`), 'uncovered work stands out');
    await toWeek(page);
    await page.shot('phone-manage-week');
    await page.shot('phone-manage-week-full', { full: true });
    await page.noSideScroll('manage week');
    check(await page.hasText('Uncovered'), 'uncovered tasks show first');
    check(await page.hasText('Rank') === false, 'no raw labels');

    // Assign the uncovered task.
    await page.click('[data-act=assign]');
    await page.waitText('Pick a person first.');
    await page.setValue('.unc-pick select[data-field=name]', 'Cora');
    await page.click('[data-act=assign]');
    await page.waitText('Cora has it now.');
    await page.gone('Uncovered');
    await sleep(200);

    // Week view: who works each day, color coded, and each person's week in a dropdown.
    await checkWeekView(page, 'phone week view');
    check(!(await page.eval(`!!document.querySelector('.wp-body')`)), 'every dropdown starts closed');
    const chipName = await page.eval(`document.querySelector('.wv-chip[data-name="Ana"]').dataset.name`);
    await page.click('.wv-chip[data-name="Ana"]');
    await page.waitFor('.wp-body');
    await sleep(700); // it scrolls the person into view
    check(await page.eval(`document.querySelector('.wp-body').closest('.wp').dataset.key === 'wp:${chipName}'`), 'tapping a name in the week opens that person');
    await sleep(600);
    check(await page.eval(`(() => { const box = document.querySelector('.wp-body').closest('.wp').getBoundingClientRect(); return box.top >= 56 && box.top < innerHeight / 2; })()`), 'and brings them into view');
    check(await page.eval(`document.querySelectorAll('.wp-body .wp-dayname').length === new Set(Array.from(document.querySelectorAll('.wv-chip[data-name="Ana"]')).map((el) => el.closest('.wv-day').dataset.key)).size`), 'their dropdown has a heading for each day they work');
    await page.shot('phone-manage-week-person');
    await page.noSideScroll('week view, a person open');
    await page.click('.wp-head[aria-expanded=true]');
    await sleep(150);
    check(!(await page.eval(`!!document.querySelector('.wp-body')`)), 'tapping the name again closes it');
    await page.click('.wv-chip[data-name="Ana"]');
    await page.waitFor('.wp-body');
    await sleep(700); // it scrolls the person into view

    // Move a row.
    await page.click('[data-act=move]');
    await page.waitText('Move task');
    await page.shot('phone-manage-move');
    await page.click('.sheet button[type=submit]');
    await page.waitText('Pick a person first.');
    await page.setValue('.sheet select[data-field=name]', 'Ben');
    await page.click('.sheet button[type=submit]');
    await page.waitText('Moved to Ben.');
    await sleep(200);
    await checkWeekView(page, 'phone week view after a move');

    // Daily view: one day at a time, starting on today, with everyone's tasks open.
    await page.click('.wv-seg button', { text: 'Daily view' });
    await page.waitFor('.dv-days');
    const daily = await page.eval(`(() => ({
      buttons: document.querySelectorAll('.dv-day').length,
      today: document.querySelector('.dv-day[aria-pressed=true]').classList.contains('is-today'),
      cards: document.querySelectorAll('[data-key^="d:"]').length,
      groups: document.querySelectorAll('.mgroup').length,
      open: document.querySelectorAll('.mgroup-head[aria-expanded=true]').length,
      grid: !!document.querySelector('.wv-grid'),
    }))()`);
    check(daily.buttons === 7 && daily.cards === 1, `Daily view shows one day, with a button for each (${daily.buttons}, ${daily.cards})`);
    check(daily.today, 'Daily view starts on today');
    check(daily.groups > 0 && daily.open === daily.groups, `everyone working that day starts open (${daily.open} of ${daily.groups})`);
    check(!daily.grid, 'and the week grid is gone');
    await page.shot('phone-manage-daily');
    await page.shot('phone-manage-daily-full', { full: true });
    await page.noSideScroll('daily view');
    await page.click('.dv-day[data-date="2026-11-13"]');
    await page.waitFor('[data-key="d:2026-11-13"]');
    check(await page.eval(`document.querySelector('.dv-day[aria-pressed=true]').dataset.date === '2026-11-13'`), 'picking Friday shows Friday');
    await page.goto('/');
    await page.waitFor('.dv-days');
    check(await page.eval(`document.querySelector('.wv-seg button[aria-pressed=true]').innerText === 'Daily view' && !document.querySelector('.wv-grid')`), 'Daily view stays picked after a reload');
    await page.click('.wv-seg button', { text: 'Week view' });
    await page.waitFor('.wv-grid');
    await page.click('.wv-dayhead[data-date="2026-11-12"]');
    await page.waitFor('[data-key="d:2026-11-12"]');
    await sleep(700); // it scrolls up to the day buttons
    check(await page.eval(`S.mgr.weekMode === 'day' && document.querySelector('.dv-day[aria-pressed=true]').dataset.date === '2026-11-12'`), 'tapping a day in the week opens it in Daily view');
    await page.click('.wv-seg button', { text: 'Week view' });
    await page.waitFor('.wv-grid');

    // Week switcher.
    await page.click('.wk-arrow:not(.back)');
    await page.waitText('Nov 16 - 22');
    await page.click('.wk-arrow.back');
    await page.waitText('Nov 9 - 15');

    // Reminder and re-run.
    await page.clearSite();
    await page.resetWorld('?nextWeek=0');
    await page.goto('/?me=Max');
    await page.waitFor('.signin input');
    await page.type('.signin input', CODE);
    await page.click('.signin button[type=submit]');
    await page.waitText(OVERVIEW);
    await api({ action: 'mgrBoard', code: CODE });
    await page.goto('/');
    await toWeek(page);
    await page.waitText('Next deadline');
    await page.click('[data-act=mgr-rebuild]');
    await page.waitText('Re-run matching?');
    await page.shot('phone-manage-rerun-confirm');
    await page.click('.sheet .btn', { text: 'Re-run matching' });
    await page.waitText('Done.');

    // One-offs: five in a row must be quick.
    await page.click('.seg button', { text: 'One-offs' });
    await page.waitText('Add a one-off');
    await page.waitFor('.oo-row');
    check(await page.eval(`(() => { const button = document.querySelector('.oo-form button[type=submit]').getBoundingClientRect(); return button.top >= 0 && button.bottom <= document.querySelector('.tabbar').getBoundingClientRect().top; })()`), 'Add task is on screen without scrolling the form');
    await page.shot('phone-manage-oneoffs');
    await page.shot('phone-manage-oneoffs-full', { full: true });
    await page.noSideScroll('one-offs');
    await page.click('.oo-form button[type=submit]');
    await page.waitText('Please say what needs done.');
    for (const title of ['Change the air filter', 'Wipe the mirrors']) {
      await page.type('#oneoff-title', title);
      await page.click('.oo-form button[type=submit]', { settle: 10 });
      const cleared = await page.eval(`document.querySelector('#oneoff-title').value`);
      check(cleared === '', `the title clears right after adding "${title}"`);
    }
    await page.waitText('Change the air filter');
    await page.waitText('Wipe the mirrors');
    await page.gone('Saving...');
    await page.waitText('Added.');
    check(await page.eval(`document.querySelector('.pick[data-field=weekOf][aria-pressed=true]').innerText.includes('This week')`), 'the week stays put between adds');
    // A pinned, assigned one-off.
    await page.type('#oneoff-title', 'Fix the <door> hinge');
    await page.click('.pick[data-field=priority][data-value=A]');
    await page.click('.pick[data-field=minutes][data-value="60"]');
    await page.click('.pick[data-field=day][data-value=Thu]');
    await page.click('.pick[data-field=who][data-value=Ana]');
    await page.click('.pick[data-field=who][data-value=Ben]');
    await page.shot('phone-manage-oneoff-filled', { full: true });
    await page.click('.oo-form button[type=submit]');
    await page.waitText('Fix the <door> hinge');
    await page.gone('Saving...');
    check(await page.eval(`document.querySelector('.pick[data-field=priority][aria-pressed=true]').innerText === 'B'`), 'priority goes back to B');
    check(await page.eval(`document.querySelector('.pick[data-field=minutes][aria-pressed=true]').innerText === '30 min'`), 'time goes back to 30 min');
    check(await page.eval(`document.querySelector('.pick[data-field=who][aria-pressed=true]').innerText === 'Anyone'`), 'who goes back to Anyone');
    // Next week waits for Friday.
    await page.click('.pick[data-field=weekOf]', { text: 'Next week\nNov 16 - 22' });
    await page.waitFor('.oo-form');
    await page.type('#oneoff-title', 'Order new chalk');
    await page.click('.oo-form button[type=submit]');
    await page.waitText('Added. It goes out Friday at 7 AM.');
    await page.waitText('Goes out Friday at 7 AM');
    await page.click('.pick[data-field=weekOf]', { text: 'This week\nNov 9 - 15' });
    await page.waitText('Fix the <door> hinge');
    // Edit and delete.
    await page.click('[data-act=oo-edit]');
    await page.waitText('Edit one-off');
    await page.shot('phone-manage-oneoff-edit');
    await page.eval(`document.querySelector('#oneoffEdit-title').select()`);
    await page.send('Input.insertText', { text: 'Fix the back door hinge' });
    await sleep(50);
    await page.click('.sheet button[type=submit]');
    await page.waitText('Fix the back door hinge');
    await page.click('[data-act=oo-delete]');
    await page.waitText('Delete this one-off?');
    await page.click('.sheet .btn', { text: 'Delete' });
    await page.gone('Fix the back door hinge');

    // Hours.
    await page.click('.seg button', { text: 'Hours' });
    await page.waitText('Copy for payroll');
    await page.waitFor('.hp');
    await page.waitText('1 entry still needs a fix');
    await page.shot('phone-manage-hours');
    await page.noSideScroll('manage hours');
    await page.click('.hp-head[data-key2="hours|Cora"]');
    await page.waitText('no clock-out');
    await page.shot('phone-manage-hours-open');
    await page.click('[data-act=entry-edit]');
    await page.waitText('Edit entry: Cora');
    await page.shot('phone-manage-hours-edit');
    await page.setValue('.sheet input[data-field=end]', '12:00');
    await page.click('.sheet button[type=submit]');
    await page.waitText('Saved.');
    await page.gone('needs a fix');
    await page.waitText('4 hrs');
    await page.click('[data-act=entry-add]');
    await page.waitText('Add an entry: Cora');
    await page.setValue('.sheet input[data-field=date]', '2026-11-10');
    await page.setValue('.sheet input[data-field=start]', '06:00');
    await page.setValue('.sheet input[data-field=end]', '07:30');
    await page.click('.sheet button[type=submit]');
    await page.waitText('5.5');
    // Delete that entry.
    await page.click('[data-act=entry-edit]');
    await page.click('.sheet [data-act=entry-delete]');
    await page.waitText('Delete this entry?');
    await page.click('.sheet .btn', { text: 'Delete' });
    await page.waitText('Entry deleted.');
    await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: SITE }).catch(() => {});
    await page.click('[data-act=copy-payroll]');
    await page.waitText('Paste it into the payroll sheet.');
    await page.setValue('.tools select', '2026-10');
    await page.waitText('October 2026');
    await page.waitFor('.hp');
    await sleep(200);
    check((await page.eval(`document.querySelector('.hp[data-key="hp:Ana"] .hp-total').innerText`)).startsWith('2.5'), 'the month picker shows that month');

    // A code that stopped working goes back to asking.
    await page.eval(`localStorage.setItem('koda-ops.v1.code', '"nope"')`);
    await page.goto('/');
    await page.waitText("That manager code isn't right.");
  },

  async desktop(page) {
    await page.viewport(1280, 800, false);
    await page.fresh('/');
    await page.waitFor('.person');
    await page.shot('desktop-signin');
    await page.noSideScroll('desktop sign-in');
    await page.goto('/?me=Ana');
    await page.waitFor('.task');
    await page.shot('desktop-today');
    check(await page.eval(`getComputedStyle(document.querySelector('.tabbar')).display === 'none' && document.querySelector('.side').getBoundingClientRect().width === 220`), 'desktop has a 220 sidebar and no tab bar');
    check(await page.eval(`document.querySelector('.main').getBoundingClientRect().width <= 704`), 'staff content is 640 wide plus padding');
    await page.click('.check');
    await page.waitText("You're not clocked in");
    await page.shot('desktop-today-nudge');
    await page.click('.side-link', { text: 'Schedule' });
    await page.waitFor('.day');
    await page.shot('desktop-schedule');
    await page.click('.side-link', { text: 'Availability' });
    await page.waitFor('.dh-list');
    await page.shot('desktop-availability');
    await page.shot('desktop-availability-full', { full: true });
    await page.noSideScroll('desktop availability');
    await page.click('.side-link', { text: 'Hours' });
    await page.waitText('hours in November');
    await page.shot('desktop-hours');
    await page.click('.side-me');
    await page.waitText('Not you? Switch person');
    await page.shot('desktop-person-sheet');
    await page.click('.sheet .btn', { text: 'Not you? Switch person' });
    await page.waitFor('.person[data-name="Max"]');
    await page.click('.person[data-name="Max"]');
    await page.waitFor('.signin input');
    await page.type('.signin input', CODE);
    await page.click('.signin button[type=submit]');
    await page.waitText(OVERVIEW);
    await page.shot('desktop-manage-overview');
    await page.shot('desktop-manage-overview-full', { full: true });
    await page.noSideScroll('desktop manage overview');
    await checkOverview(page, 'desktop overview');
    check(await page.eval(`(() => { const cols = document.querySelectorAll('.ov-col'); return cols.length === 2 && cols[1].getBoundingClientRect().left > cols[0].getBoundingClientRect().right; })()`), 'desktop overview sits in two columns');
    // A day closed after the build still shows its tasks, and an inactive person's first name doesn't clash.
    check(await page.eval(`(() => {
      const real = S.mgr.overview;
      const ov = JSON.parse(JSON.stringify(real));
      ov.days[3] = Object.assign(ov.days[3], { closed: 'Snow', total: 7, done: 2 });
      ov.staffNames = ['Ana Ruiz'];
      ov.hours.people = [{ name: 'Ana Ruiz', thisWeek: 1, lastWeek: 0 }, { name: 'Ana Lee', thisWeek: 0, lastWeek: 2 }];
      S.mgr.overview = ov;
      render();
      const day = document.querySelectorAll('.ov-day')[3].innerText;
      const names = Array.from(document.querySelectorAll('.ov-table tbody .ov-name')).map((el) => el.innerText.trim());
      S.mgr.overview = real;
      render();
      return day.includes('Closed') && day.includes('2 of 7') && names.join() === 'Ana Ruiz,Ana Lee';
    })()`), 'a closed day with tasks keeps its count, and hours names never read the same');
    await toWeek(page);
    await page.shot('desktop-manage-week');
    await page.shot('desktop-manage-week-full', { full: true });
    await page.noSideScroll('desktop manage week');
    await checkWeekView(page, 'desktop week view');
    // A note from someone with no tasks still shows, and someone who left keeps a name and color of their own.
    check(await page.eval(`(() => {
      const real = S.mgr.boards[S.mgr.weekOf || startWeek(S.view)];
      const board = JSON.parse(JSON.stringify(real));
      board.days[2].extras = (board.days[2].extras || []).concat([{ name: 'Mia Manager', text: 'Restocked towels' }]);
      const first = board.days[0].groups[0];
      board.days[0].groups.push({ name: first.name + ' Lee', tasks: [Object.assign({}, first.tasks[0], { id: 'gone|' + first.tasks[0].id })] });
      S.mgr.boards[real.weekOf] = board;
      S.mgr.people['Mia Manager'] = true;
      render();
      const note = !!document.querySelector('.wp[data-key="wp:Mia Manager"] .mextras') && document.querySelector('.wp[data-key="wp:Mia Manager"]').innerText.includes('Restocked towels');
      const chips = Array.from(document.querySelectorAll('.wv-day')[0].querySelectorAll('.wv-chip'));
      const left = chips.find((el) => el.dataset.name === first.name + ' Lee');
      const still = chips.find((el) => el.dataset.name === first.name);
      const named = left && still && left.innerText.includes(first.name + ' Lee') && still.querySelector('.wv-cname').innerText === first.name;
      const apart = left && still && getComputedStyle(left).getPropertyValue('--pc') !== getComputedStyle(still).getPropertyValue('--pc');
      S.mgr.boards[real.weekOf] = real;
      delete S.mgr.people['Mia Manager'];
      render();
      return note && named && apart;
    })()`), 'Week view: a note from someone with no tasks shows, and a past staffer gets their own name and color');
    check(await page.eval(`(() => { const tops = Array.from(document.querySelectorAll('.wv-day')).map((el) => Math.round(el.getBoundingClientRect().top)); return new Set(tops).size === 1; })()`), 'desktop: the seven days sit side by side');
    check(await page.eval(`Array.from(document.querySelectorAll('.wv-cname')).every((el) => el.scrollWidth <= el.clientWidth + 1)`), 'desktop: every name fits its chip');
    await page.click('.wv-seg button', { text: 'Daily view' });
    await page.waitFor('.dv-days');
    await page.shot('desktop-manage-daily');
    await page.noSideScroll('desktop daily view');
    await page.click('.wv-seg button', { text: 'Week view' });
    await page.waitFor('.wv-grid');
    await page.click('.seg button', { text: 'One-offs' });
    await page.waitFor('.oo-row');
    await page.shot('desktop-manage-oneoffs');
    await page.noSideScroll('desktop one-offs');
    await page.click('.seg button', { text: 'Hours' });
    await page.waitFor('.hp');
    await page.shot('desktop-manage-hours');
    await page.noSideScroll('desktop manage hours');

    // The flows that change something, at this size too.
    await page.click('.hp-head[data-key2="hours|Cora"]');
    await page.waitText('no clock-out');
    await page.shot('desktop-manage-hours-open');
    await page.click('[data-act=entry-edit]');
    await page.waitText('Edit entry: Cora');
    await page.shot('desktop-manage-hours-edit');
    await page.setValue('.sheet input[data-field=end]', '12:00');
    await page.click('.sheet button[type=submit]');
    await page.gone('needs a fix');
    await page.click('.seg button', { text: 'One-offs' });
    await page.waitFor('.oo-form');
    await page.type('#oneoff-title', 'Dust the trophy shelf');
    await page.click('.pick[data-field=day][data-value=Thu]');
    await page.click('.oo-form button[type=submit]');
    await page.waitText('Dust the trophy shelf');
    await page.gone('Saving...');
    await page.waitText('Added.');
    check(await page.hasText('A emails whoever gets it'), 'the form says what A does');
    await page.type('#oneoff-title', 'Fix the back door');
    await page.click('.pick[data-field=priority][data-value=A]');
    await page.click('.pick[data-field=day][data-value=Wed]');
    await page.click('.oo-form button[type=submit]');
    await page.waitText('and got an email.');
    const outbox = await (await fetch(SITE + '/dev/emails')).json();
    check(outbox.emails.some((one) => /New task for Wed, Nov 11: Fix the back door/.test(one.subject)), 'an A one-off this week emails whoever got it');
    await page.click('[data-act=oo-edit]');
    await page.waitText('Edit one-off');
    await page.shot('desktop-manage-oneoff-edit');
    await page.click('.sheet [data-act=sheet-close]');
    await page.gone('Edit one-off');
    await page.click('.seg button', { text: 'Week' });
    await page.waitText('On the clock now');
    await page.setValue('.unc-pick select[data-field=name]', 'Cora');
    await page.click('[data-act=assign]');
    await page.waitText('Cora has it now.');
    await page.click('.wv-chip[data-name="Ana"]');
    await page.waitFor('[data-act=move]');
    await sleep(700); // it scrolls the person into view
    await page.click('[data-act=move]');
    await page.waitText('Move task');
    await page.shot('desktop-manage-move');
    await page.setValue('.sheet select[data-field=name]', 'Ben');
    await page.click('.sheet button[type=submit]');
    await page.waitText('Moved to Ben.');
    await page.noSideScroll('desktop manage week, after changes');

    await page.clearSite();
    await page.goto('/?me=Ben&tab=availability&week=2026-11-23');
    await page.waitFor('.dh-list');
    await page.click('[data-act=hours-step][data-delta="0.5"]');
    await addDayHours(page, 'Mon', 2);
    await addDayHours(page, 'Fri', 1.5);
    await page.waitText('3.5 hours available');
    await page.shot('desktop-availability-filled');
    await page.click('[data-act=avail-save]');
    await page.waitText("You're all set!");
    await page.shot('desktop-availability-success');
    await page.noSideScroll('desktop availability saved');
    await page.setValue('[data-form=off][data-field=from]', '2026-11-27');
    await page.click('.off-card button[type=submit]');
    await page.waitText('Nov 27');
    await page.noSideScroll('desktop out of town');
    await page.click('.side-link', { text: 'Today' });
    await page.waitText('Hi, Ben');
    await page.click('.side-link', { text: 'Hours' });
    await page.click('.link', { text: 'Forgot to clock in? Add hours.' });
    await page.waitText('Save hours');
    await page.shot('desktop-add-hours');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.gone('Save hours');
    check(true, 'Escape closes a sheet');
  },

  async narrow(page) {
    await page.viewport(320, 640, true);
    await page.fresh('/');
    await page.waitFor('.person');
    await page.noSideScroll('320 sign-in');
    await page.goto('/?me=Ana');
    await page.waitFor('.task');
    await page.shot('narrow-today');
    await page.noSideScroll('320 today');
    await page.click('.tab[data-tab=schedule]');
    await page.waitFor('.day');
    await page.shot('narrow-schedule');
    await page.noSideScroll('320 schedule');
    await page.click('.tab[data-tab=availability]');
    await page.waitFor('.dh-list');
    await page.shot('narrow-availability');
    await page.shot('narrow-availability-full', { full: true });
    await page.noSideScroll('320 availability');
    const stepper = await page.eval(`(() => { const box = document.querySelector('.dh-step .step').getBoundingClientRect(); const row = document.querySelector('.dh-row').getBoundingClientRect(); const last = document.querySelector('.dh-step .step:last-child').getBoundingClientRect(); return { w: box.width, h: box.height, last: last.right, rowRight: row.right, page: document.documentElement.clientWidth }; })()`);
    check(stepper.w >= 44 && stepper.h >= 44, `320 wide: the day steppers are big enough to tap (${stepper.w} by ${stepper.h})`);
    check(stepper.last <= stepper.rowRight && stepper.rowRight <= stepper.page - 15, `320 wide: the days stay inside the gutter (${stepper.last}, ${stepper.rowRight})`);
    await page.click('.tab[data-tab=hours]');
    await page.waitText('hours in November');
    await page.shot('narrow-hours');
    await page.noSideScroll('320 hours');
    await page.clearSite();
    await page.goto('/?me=Max');
    await page.waitFor('.signin input');
    await page.shot('narrow-manager-code');
    await page.type('.signin input', CODE);
    await page.click('.signin button[type=submit]');
    await page.waitText(OVERVIEW);
    await page.shot('narrow-manage-overview');
    await page.noSideScroll('320 manage overview');
    check(await page.eval(`Array.from(document.querySelectorAll('.mg-seg button')).every((el) => el.scrollWidth <= el.clientWidth + 1)`), '320 wide: the four Manage labels fit');
    await toWeek(page);
    await page.shot('narrow-manage-week');
    await page.noSideScroll('320 manage week');
    check(await page.eval(`(() => { const tops = Array.from(document.querySelectorAll('.wv-day')).map((el) => Math.round(el.getBoundingClientRect().top)); return new Set(tops).size === 7; })()`), '320 wide: a row per day');
    await page.click('.wv-chip');
    await page.waitFor('.wp-body');
    await sleep(700); // it scrolls the person into view
    await page.noSideScroll('320 week view, a person open');
    await page.click('.wv-seg button', { text: 'Daily view' });
    await page.waitFor('.dv-days');
    await page.shot('narrow-manage-daily');
    await page.noSideScroll('320 daily view');
    await page.click('.wv-seg button', { text: 'Week view' });
    await page.waitFor('.wv-grid');
    check(await page.eval(`(() => { const labels = Array.from(document.querySelectorAll('.tab')); return labels.every((el) => el.scrollWidth <= el.clientWidth + 1); })()`), '320 wide: the five tab labels fit');
    await page.click('.seg button', { text: 'One-offs' });
    await page.waitFor('.oo-form');
    await page.noSideScroll('320 one-offs');
    await page.shot('narrow-manage-oneoffs');
    await page.click('.seg button', { text: 'Hours' });
    await page.waitFor('.hp');
    await page.noSideScroll('320 manage hours');
    await page.shot('narrow-manage-hours');

    await page.viewport(390, 844, true);
    await page.goto('/');
    await page.waitFor('.tabbar');
    await page.shot('phone-manager-tabs');
  },

  /* Long text, odd text, and text that tries to be markup. */
  async stress(page) {
    await page.viewport(320, 640, true);
    await page.fresh('/?me=Ana');
    await page.waitFor('.task');
    const long = 'X'.repeat(120);
    const trap = '<img src=x onerror="window.__trapped=1"><script>window.__trapped=2</script>"\'&';
    const added = await api({ action: 'mgrOneOffAdd', code: CODE, by: 'Max', title: long, details: 'Y'.repeat(500), priority: 'A', minutes: 15, weekOf: '2026-11-09', day: 'Tue', who: ['Ana'] });
    check(added.ok, 'a long one-off goes in');
    const trapped = await api({ action: 'mgrOneOffAdd', code: CODE, by: 'Max', title: trap, details: trap, priority: 'A', minutes: 15, weekOf: '2026-11-09', day: 'Tue', who: ['Ana'] });
    check(trapped.ok, 'a one-off that looks like markup goes in');
    const task = (await boot('Ana')).today.tasks.find((one) => one.title === trap);
    await api({ action: 'taskNote', name: 'Ana', id: task.id, note: trap });
    await page.goto('/');
    await page.waitText('XXXX');
    await page.shot('stress-today');
    await page.noSideScroll('320, long text, today');
    check((await page.eval('window.__trapped')) === undefined, 'markup in a task never runs');
    check(!(await page.eval(`!!document.querySelector('.task img, .task script')`)), 'markup in a task never becomes an element');
    await page.click('.tab[data-tab=schedule]');
    await page.waitFor('.day');
    await page.noSideScroll('320, long text, schedule');
    await page.clearSite();
    await page.goto('/?me=Max');
    await page.waitFor('.signin input');
    await page.type('.signin input', CODE);
    await page.click('.signin button[type=submit]');
    await page.waitText(OVERVIEW);
    await page.waitText('XXXX');
    await page.shot('stress-manage-overview');
    await page.noSideScroll('320, long text, manage overview');
    check(!(await page.eval(`!!document.querySelector('.ov img, .ov script')`)), 'markup in a one-off never becomes an element on the Overview');
    await toWeek(page);
    await page.click('.wv-chip[data-name="Ana"]');
    await page.waitText('XXXX');
    await sleep(700); // it scrolls the person into view
    await page.shot('stress-manage-week');
    await page.noSideScroll('320, long text, manage week');
    check(!(await page.eval(`!!document.querySelector('.wp img, .wp script')`)), 'markup in a task never becomes an element in Week view');
    await page.click('.wv-dayhead[data-date="2026-11-10"]');
    await page.waitText('XXXX');
    await sleep(700); // it scrolls up to the day buttons
    await page.shot('stress-manage-daily');
    await page.noSideScroll('320, long text, daily view');
    check(!(await page.eval(`!!document.querySelector('.mgroup img, .mgroup script')`)), 'markup in a task never becomes an element in Daily view');
    await page.click('.wv-seg button', { text: 'Week view' });
    await page.waitFor('.wv-grid');
    await page.click('.seg button', { text: 'One-offs' });
    await page.waitFor('.oo-row');
    await page.waitText('XXXX');
    await page.shot('stress-manage-oneoffs');
    await page.noSideScroll('320, long text, one-offs');
    check((await page.eval('window.__trapped')) === undefined, 'markup in a one-off never runs on Manage');
  },

  /* Late saves, and a flexible person going out of town. */
  async late(page) {
    await page.viewport(390, 844, true);
    await page.resetWorld();
    await setTime('2026-11-20T07:01:00-07:00');
    await fetch(`${SITE}/dev/tick`);
    await page.clearSite();
    await page.goto('/?me=Ben&tab=availability&week=2026-11-23');
    await page.waitFor('.dh-list');
    check(await page.hasText('The deadline has passed. You can still fill this out and pick up any tasks that are left.'), 'past the deadline, the page says so');
    check(await page.eval(`document.querySelector('.wk-chip[aria-pressed=true]').innerText.includes('Past due')`), 'the chip says past due');
    await page.click('[data-act=hours-step][data-delta="0.5"]');
    await page.click('[data-act=hours-step][data-delta="0.5"]');
    await page.click('[data-act=hours-step][data-delta="0.5"]');
    await page.click('[data-act=hours-step][data-delta="0.5"]');
    await addDayHours(page, 'Mon', 2);
    await addDayHours(page, 'Tue', 2);
    await page.waitText('4 hours available');
    await page.waitText('Not saved yet.');
    await page.click('[data-act=avail-save]');
    await page.waitText("You're all set!");
    await page.waitText('You picked up');
    await page.shot('phone-availability-late-picked');
    await page.noSideScroll('late success');

    // The current week, from an old email link.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Dev&tab=availability&week=2026-11-09');
    await page.waitFor('.dh-list');
    check(await page.eval(`document.querySelector('.wk-chip[aria-pressed=true]').innerText.includes('Nov 9 - 15')`), 'a link to the current week still opens it');
    check((await page.eval(`document.querySelectorAll('.wk-chip').length`)) === 7, 'it adds a chip for that week');
    await page.noSideScroll('current week link');

    // Out of town as a flexible person: the tasks get covered, the days get marked.
    await page.clearSite();
    await page.goto('/?me=Ana&tab=availability');
    await page.waitFor('.off-card');
    await page.setValue('[data-form=off][data-field=from]', '2026-11-12');
    await page.click('.off-card button[type=submit]');
    await page.waitText('Saved.');
    await page.shot('phone-out-of-town-flexible');
    await page.waitFor('.off-row');
    await page.click('.tab[data-tab=schedule]');
    await page.waitText('Out of town');
    await sleep(200);
    check(!(await boot('Ana')).week.thisWeek.days.find((day) => day.date === '2026-11-12').tasks.length, 'her tasks moved off that day');

    // A date range that is backwards.
    await page.click('.tab[data-tab=availability]');
    await page.waitFor('.off-card');
    await page.setValue('[data-form=off][data-field=from]', '2026-11-20');
    await page.setValue('[data-form=off][data-field=to]', '2026-11-18');
    await page.click('.off-card button[type=submit]');
    await page.waitText('The last date has to be on or after the first date.');

    // Forgetting the code.
    await page.clearSite();
    await page.goto('/?me=Max');
    await page.waitFor('.signin input');
    await page.type('.signin input', CODE);
    await page.click('.signin button[type=submit]');
    await page.waitText(OVERVIEW);
    await page.click('.top-me');
    await page.waitText('Forget the manager code on this device');
    await page.click('.sheet [data-act=forget-code]');
    await page.waitText('The manager code is gone from this device.');
    check(await page.eval(`localStorage.getItem('koda-ops.v1.code') === null`), 'forgetting removes the code');
    check(await page.hasText('Hi, Max'), 'and goes to Today');
    await page.click('.tab[data-tab=manage]');
    await page.waitText('Enter the manager code');
    await page.shot('phone-manage-needs-code');
  },

  /* Sitting on a screen must not keep asking the server for things. */
  async idle(page) {
    await page.viewport(390, 844, true);
    const calls = () => page.eval(`performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api')).map((entry) => entry.name.replace(location.origin, ''))`);
    const settle = async (where, expected) => {
      await sleep(3000);
      const seen = await calls();
      check(seen.length === expected, `${where}: ${expected} calls to the server, then quiet (saw ${seen.length}: ${seen.join(', ')})`);
    };

    await page.fresh('/?me=Ana');
    await page.waitFor('.task');
    await settle('opening Today', 1);
    await page.click('.check');
    await settle('after a check mark', 3); // the write, then one refresh
    await page.click('.tab[data-tab=schedule]');
    await settle('moving to Schedule', 3); // nothing new to ask for

    // Coming back to the tab refreshes, unless it just did. So does five minutes going by.
    await page.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
    await settle('coming back seconds later', 3);
    await page.eval(`lastRefresh = Date.now() - 20000; document.dispatchEvent(new Event('visibilitychange'))`);
    await settle('coming back after a while', 4);
    await page.eval(`lastRefresh = Date.now() - 301000`);
    await sleep(30500);
    await settle('five minutes on the same screen', 5);

    await page.clearSite();
    await page.goto('/?me=Ana&tab=availability');
    await page.waitFor('.dh-list');
    await settle('opening Availability', 2);
    await page.goto('/');
    await page.waitFor('.dh-list');
    await settle('reloading Availability', 2);

    await page.clearSite();
    await page.eval(`localStorage.setItem('koda-ops.v1.code', '"${CODE}"')`);
    await page.goto('/?me=Max');
    await page.waitText(OVERVIEW);
    await settle('opening Manage', 2);
    await page.goto('/');
    await page.waitText(OVERVIEW);
    await settle('reloading Manage', 2);
  },

  /* Links: a different person, and weeks that aren't weeks. */
  async links(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/?me=Ana&tab=hours');
    await page.waitText('hours in November');
    await page.eval(`localStorage.setItem('koda-ops.v1.code', '"${CODE}"')`);
    await page.goto('/?me=Max');
    await page.waitText(OVERVIEW);
    check(true, "a link for someone else lands on their first tab, not the last person's");

    // The email about an A one-off next week opens next week's schedule, and leaves availability alone.
    await page.clearSite();
    await page.goto('/?me=Ana&tab=schedule&week=2026-11-16');
    await page.waitFor('.day');
    check(await page.eval(`document.querySelector('.seg button[aria-pressed=true]').innerText === 'Next week' && document.querySelector('.tab[data-tab=schedule]').getAttribute('aria-current') === 'page'`), 'a schedule link with next week opens next week on Schedule');
    check(await page.eval(`sessionStorage.getItem('koda-ops.v1.week') === null`), 'and leaves the availability week alone');

    await page.clearSite();
    await page.goto('/?me=Ben&tab=availability&week=2026-11-24');
    await page.waitFor('.dh-list');
    check(!(await page.hasText('A week has to start on a Monday')), 'a link to a week that is not a Monday is ignored');
    check(await page.eval(`document.querySelector('.wk-chip[aria-pressed=true]').innerText.includes('Nov 16')`), 'and lands on the next week');

    await page.clearSite();
    await page.goto('/?me=Ben&tab=availability&week=2026-12-21');
    await page.waitText('Week of Dec 21');
    await sleep(700);
    const chip = await page.eval(`(() => { const box = document.querySelector('.wk-chip[aria-pressed=true]').getBoundingClientRect(); return { left: box.left, right: box.right, page: innerWidth }; })()`);
    check(chip.left >= 0 && chip.right <= chip.page, `the chosen week's chip is on screen (${chip.left} to ${chip.right})`);
    await page.shot('phone-availability-later-week');

    // Errors show up where the person is looking.
    await page.click('[data-act=avail-save]');
    await page.waitText('Please tell us how many hours you want this week.');
    await sleep(700);
    const message = await page.eval(`(() => { const box = document.querySelector('#hours-wanted .err').getBoundingClientRect(); return { top: box.top, bottom: box.bottom, floor: document.querySelector('.tabbar').getBoundingClientRect().top }; })()`);
    check(message.top >= 56 && message.bottom <= message.floor, `the hours message is on screen after tapping Save (${message.top} to ${message.bottom})`);
    await page.shot('phone-availability-needs-hours');
    await page.click('[data-act=hours-step][data-delta="0.5"]');
    check(!(await page.hasText('Please tell us how many hours')), 'and goes away once they use the stepper');
    check(await page.eval(`document.querySelector('.step-unit').innerText === 'hours'`), 'half an hour still says hours');
    await page.click('[data-act=hours-step][data-delta="0.5"]');
    check(await page.eval(`document.querySelector('.step-unit').innerText === 'hour'`), 'one hour says hour');

    // After saving and walking away, the form is back, not yesterday's You're all set!
    await addDayHours(page, 'Mon', 1);
    await page.click('[data-act=avail-save]');
    await page.waitText("You're all set!");
    await page.click('.tab[data-tab=today]');
    await page.waitText('Hi, Ben');
    await page.click('.tab[data-tab=availability]');
    await page.waitFor('.dh-list');
    check(!(await page.hasText("You're all set!")), 'coming back to Availability shows the form');
  },

  /* Apps Script takes a couple of seconds to answer. The screen can't wait for it. */
  async slow(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/');
    await page.waitFor('.person');
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 2000, downloadThroughput: -1, uploadThroughput: -1 });

    // Tapping a name answers right away, with a manager's code step or a place for the list.
    await page.click('.person[data-name="Max"]', { settle: 40 });
    check(await page.hasText('Manager code'), 'a manager sees the code step without waiting for the server');
    await page.click('.signin [data-act=switch]', { settle: 40 });
    await page.waitFor('.person');
    await page.click('.person[data-name="Ana"]', { settle: 40 });
    check(await page.eval(`!!document.querySelector('.tabbar') && !!document.querySelector('.skel')`), 'staff see the tabs and a loading shape right away');
    await page.waitFor('.task', 15000);

    // A burst of taps, all instant, then a reload while they're still on their way.
    const startedAt = Date.now();
    await page.click('.task:nth-child(1) .check', { settle: 0 });
    await page.click('.task:nth-child(2) .check', { settle: 0 });
    await page.click('[data-act=clock-in]', { settle: 0 });
    await page.click('.task:nth-child(3) .check', { settle: 0 });
    check(await page.eval(`document.querySelectorAll('.check[aria-checked=true]').length === 3`), `three check marks show at once (${Date.now() - startedAt} ms)`);
    check(await page.hasText('On the clock since'), 'the clock shows right away too');
    await page.goto('/');
    await page.waitText('3 of 9 done');
    await page.waitText('On the clock since');
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const until = Date.now() + 20000;
    while ((await page.eval(`JSON.parse(localStorage.getItem('koda-ops.v1.queue')).length`)) && Date.now() < until) await sleep(200);
    await sleep(400);
    const after = await boot('Ana');
    check(after.today.tasks.filter((task) => task.done).length === 3, 'the burst landed, once each, through the reload');
    check(after.clock.status === 'in' && after.hours.entries.filter((entry) => !entry.out && entry.date === after.now.date).length === 1, 'and exactly one clock-in');
    check(await page.hasText('3 of 9 done'), 'and the screen still agrees');

    // Google Fonts hanging must not hold up the page: the saved copy shows anyway.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*fonts.googleapis.com*' }] });
    const held = [];
    page.on('Fetch.requestPaused', (params) => held.push(params.requestId));
    await page.send('Page.navigate', { url: SITE + '/' });
    await page.waitFor('.task', 4000);
    check(await page.hasText('3 of 9 done'), 'the page opens while the font is still on its way');
    for (let i = 0; i < 30 && !held.length; i++) await sleep(100);
    check(held.length > 0, 'the font request was really being held');
    await page.shot('phone-today-no-font');
    await page.send('Fetch.disable');
    await sleep(500);
  },

  /* The manager's week before it's built, and the days after the deadline. */
  async deadlines(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/', '?nextWeek=0');
    await page.eval(`localStorage.setItem('koda-ops.v1.code', '"${CODE}"')`);
    await page.goto('/?me=Max');
    await page.waitText(OVERVIEW);
    await toWeek(page);
    await page.click('.wk-arrow:not(.back)');
    await page.waitText('Not out yet');
    await page.waitText('For the week of Nov 16 - 22.');
    check(!(await page.hasText('Nobody on.')), 'a week that is not built has no empty day cards');
    check(!(await page.hasText('logged')), 'and no hours or tasks that cannot exist yet');
    check(await page.hasText('Wants 8 hrs'), 'it shows what people asked for');
    await page.shot('phone-manage-week-unbuilt');
    await page.noSideScroll('week not built');
    await page.viewport(1280, 800, false);
    await page.shot('desktop-manage-week-unbuilt');
    await page.noSideScroll('desktop week not built');
    await page.viewport(390, 844, true);

    // Saturday: the deadline for the coming week was yesterday, and the one-off form looks ahead.
    await setTime('2026-11-13T07:00:00-07:00');
    await fetch(`${SITE}/dev/tick`);
    await setTime('2026-11-14T08:30:00-07:00');
    await fetch(`${SITE}/dev/tick`);
    await page.goto('/');
    await page.waitText('Deadline was Fri, Nov 13 at 7:00 AM');
    check(!(await page.hasText('Next deadline: Fri, Nov 13')), 'a deadline that has passed is not called next');
    await page.click('.seg button', { text: 'One-offs' });
    await page.waitFor('.oo-form');
    check(await page.eval(`document.querySelector('.pick[data-field=weekOf][aria-pressed=true]').innerText.includes('Next week')`), 'on a Saturday a new one-off defaults to next week');
    await page.click('.oo-form button[type=submit]');
    await page.waitText('Please say what needs done.');
    await sleep(500);
    const message = await page.eval(`(() => { const box = document.querySelector('.oo-form .err').getBoundingClientRect(); return { top: box.top, bottom: box.bottom, floor: document.querySelector('.tabbar').getBoundingClientRect().top }; })()`);
    check(message.top >= 56 && message.bottom <= message.floor, `the one-off message is on screen after tapping Add (${message.top} to ${message.bottom})`);
    await page.send('Input.insertText', { text: 'S' });
    await sleep(60);
    check(!(await page.hasText('Please say what needs done.')), 'and goes away once they start typing');

    // The first look on a Monday: the old copy on the phone must not leave the manager on last week.
    await page.resetWorld();
    await page.goto('/');
    await page.click('.seg button', { text: 'Week' });
    await page.waitText('Nov 9 - 15');
    await setTime('2026-11-16T07:30:00-07:00');
    await page.goto('/');
    await page.waitText('Nov 16 - 22');
    await sleep(300);
    check(await page.eval(`document.querySelector('.wk-switch .h2').innerText === 'Nov 16 - 22'`), 'Monday morning opens on the new week');

    // And after Friday morning, someone who didn't pick a week lands on the one still open.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Ana&tab=availability');
    await page.waitText('Week of Nov 16');
    await setTime('2026-11-13T07:30:00-07:00');
    await page.goto('/');
    await page.waitText('Week of Nov 23');
    check(await page.eval(`document.querySelector('.wk-chip[aria-pressed=true]').innerText.includes('Nov 23')`), 'an old copy of the page does not leave them on a week that has closed');

    // Someone away today gets a word about it, and isn't offered open tasks.
    await page.resetWorld();
    await setTime('2026-11-12T09:30:00-07:00');
    await fetch(`${SITE}/dev/tick`);
    await page.clearSite();
    await page.goto('/?me=Gus');
    await page.waitText("You're marked out of town.");
    check(!(await page.hasText('open task')), 'nobody away today is offered open tasks');
    await page.shot('phone-today-away');
    await page.noSideScroll('away today');

    // Thanksgiving: closed, with a message and nothing to do.
    await page.resetWorld();
    await setTime('2026-11-26T09:30:00-07:00');
    await page.clearSite();
    await page.goto('/?me=Gus');
    await page.waitText('The gym is closed today.');
    await page.waitText('Thanksgiving');
    await page.shot('phone-today-closed');
    await page.noSideScroll('closed today');

    // A week nobody filled in: the uncovered list stays short enough to get past.
    await page.resetWorld();
    await setTime('2026-11-20T07:00:00-07:00');
    await fetch(`${SITE}/dev/tick`);
    await setTime('2026-11-24T09:00:00-07:00');
    await fetch(`${SITE}/dev/tick`);
    await page.clearSite();
    await page.eval(`localStorage.setItem('koda-ops.v1.code', '"${CODE}"')`);
    await page.goto('/?me=Max');
    await page.waitText(OVERVIEW);
    await toWeek(page);
    await page.waitFor('[data-act=unc-all]');
    check((await page.eval(`document.querySelectorAll('.unc-row').length`)) === 5, 'a long uncovered list starts with five');
    check(await page.eval(`document.querySelector('[data-act=unc-all]').innerText.startsWith('Show ')`), 'and says how many more there are');
    await page.click('[data-act=unc-all]');
    check((await page.eval(`document.querySelectorAll('.unc-row').length`)) > 5, 'tapping it shows them all');
    await page.click('[data-act=unc-all]');
    check((await page.eval(`document.querySelectorAll('.unc-row').length`)) === 5, 'and tapping again goes back');
    await page.noSideScroll('long uncovered list');
  },

  /* Add to home screen: what the browser makes of the manifest. */
  async pwa(page) {
    await page.viewport(390, 844, true);
    await page.goto('/');
    const manifest = await page.send('Page.getAppManifest');
    check(!manifest.errors.length, 'the manifest has no errors: ' + JSON.stringify(manifest.errors));
    const data = JSON.parse(manifest.data);
    check(new URL(data.start_url, manifest.url).href === SITE + '/', 'the app opens the site, not the assets folder: ' + new URL(data.start_url, manifest.url).href);
    check(new URL(data.scope, manifest.url).href === SITE + '/', 'the scope is the whole site');
    for (const name of ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
      check((await fetch(`${SITE}/assets/${name}`)).ok, name + ' is served');
    }
    const meta = await page.eval(`({
      robots: document.querySelector('meta[name=robots]').content,
      theme: document.querySelector('meta[name=theme-color]').content,
      title: document.title,
      bg: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.body).fontFamily,
      body: getComputedStyle(document.body).fontSize,
    })`);
    check(meta.robots === 'noindex' && meta.title === 'Koda Operations' && meta.theme === '#ffffff', 'the head is right');
    check(meta.bg === 'rgb(255, 255, 255)' && meta.font.startsWith('Inter') && meta.body === '16px', 'white page, Inter, 16px');
    const small = await page.eval(`Array.from(document.querySelectorAll('body *')).filter((el) => el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim()) && parseFloat(getComputedStyle(el).fontSize) < 13 && !el.closest('.sr')).map((el) => el.className || el.tagName)`);
    check(!small.length, 'nothing under 13px: ' + small.join());
    const inputs = await page.eval(`Array.from(document.querySelectorAll('input,select,textarea')).filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.className)`);
    check(!inputs.length, 'inputs are at least 16px: ' + inputs.join());
  },

  async homescreen(page) {
    await page.viewport(390, 844, true);
    const desktop = await page.eval('navigator.userAgent');
    await page.fresh('/?me=Ana');
    await page.waitFor('.task');
    check(!(await page.hasText('Add this to your home screen')), 'a computer does not get the home screen card');

    await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
    await page.goto('/');
    await page.waitText('Add this to your home screen');
    check(await page.hasText('Add to Home Screen'), 'an iPhone gets the steps');
    check(!(await page.eval(`!!document.querySelector('[data-act=home-add]')`)), 'an iPhone has no prompt button');
    await page.shot('phone-today-home-card-iphone');
    await page.noSideScroll('home screen card');
    await page.click('[data-act=home-dismiss]');
    await page.gone('Add this to your home screen');
    await page.goto('/');
    await page.waitFor('.task');
    check(!(await page.hasText('Add this to your home screen')), 'dismissed stays dismissed after a reload');

    await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' });
    await page.eval(`localStorage.removeItem('koda-ops.v1.homeScreenDone')`);
    await page.goto('/');
    await page.waitText('Add this to your home screen');
    const offered = await page.eval(`!!document.querySelector('[data-act=home-add]')`);
    console.log('  Android: browser offered a real prompt: ' + offered);
    check(offered || (await page.hasText('three dots')), 'Android gets the prompt, or the steps if Chrome has not offered one');
    await page.eval(`(() => { const event = new Event('beforeinstallprompt'); window.__asked = 0; event.prompt = () => { window.__asked += 1; }; event.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(event); })()`);
    await page.waitFor('[data-act=home-add]');
    await page.shot('phone-today-home-card-android');
    await page.click('[data-act=home-add]');
    await page.gone('Add this to your home screen');
    check((await page.eval('window.__asked')) === 1, 'the button brings up the prompt');
    check((await page.eval(`localStorage.getItem('koda-ops.v1.homeScreenDone')`)) === 'true', 'once added, the card stays gone');
    await page.send('Emulation.setUserAgentOverride', { userAgent: desktop });
  },

  async offline(page) {
    await page.viewport(390, 844, true);
    await page.fresh('/?me=Ana');
    await page.waitFor('.task');

    // The API goes away. The page itself can still load.
    page.allowErrors = true;
    await page.send('Network.setBlockedURLs', { urls: ['*/api*'] });
    await page.click('.check', { settle: 0 });
    check(await page.eval(`document.querySelector('.check').getAttribute('aria-checked') === 'true'`), 'offline: the check still shows right away');
    await page.click('[data-act=clock-in]', { settle: 0 });
    await page.waitText('On the clock since');
    await page.click('.task:nth-child(2) .check');
    const queued = await page.eval(`JSON.parse(localStorage.getItem('koda-ops.v1.queue')).map((item) => item.action).join()`);
    check(queued === 'taskToggle,clockIn,taskToggle', `offline: the taps wait in order (${queued})`);

    await page.waitText('Saving...', 9000);
    await page.shot('phone-offline-saving');
    await page.goto('/');
    await page.waitText('Hi, Ana');
    check(await page.eval(`document.querySelector('.task:nth-child(1) .check').getAttribute('aria-checked') === 'true' && document.querySelector('.task:nth-child(2) .check').getAttribute('aria-checked') === 'true'`), 'offline: after a reload the checks are still there');
    check(await page.hasText('On the clock since'), 'offline: after a reload the clock is still in');
    check(await page.hasText('2 of 9 done'), 'offline: after a reload the count is right');
    await page.waitText("Couldn't save yet. We'll keep trying.", 36000);
    await page.shot('phone-offline-keep-trying');
    const before = await boot('Ana');
    check(!before.today.tasks[0].done && before.clock.status === 'out', 'offline: nothing has reached the server yet');

    // Back online: everything lands once, in order.
    await page.send('Network.setBlockedURLs', { urls: [] });
    await page.eval(`window.dispatchEvent(new Event('online'))`);
    await page.gone("Couldn't save yet. We'll keep trying.", 8000);
    await sleep(1500);
    const after = await boot('Ana');
    check(after.today.tasks[0].done && after.today.tasks[1].done && after.clock.status === 'in', 'back online: the taps reached the server');
    check(after.hours.entries.filter((entry) => !entry.out && entry.date === after.now.date).length === 1, 'back online: exactly one clock-in');
    check((await page.eval(`localStorage.getItem('koda-ops.v1.queue')`)) === '[]', 'back online: the queue is empty');
    check(await page.hasText('2 of 9 done'), 'back online: the screen still says 2 of 9');

    // A refused write is dropped, with the reason, and the screen goes back to the truth.
    await page.eval(`(() => {
      const items = JSON.parse(localStorage.getItem('koda-ops.v1.queue'));
      items.push({ qid: 'test', action: 'taskToggle', body: { name: 'Ana', id: 'nope', done: true }, t: Date.now() });
      localStorage.setItem('koda-ops.v1.queue', JSON.stringify(items));
      window.dispatchEvent(new Event('online'));
    })()`);
    await page.waitText("We can't find that task.");
    await sleep(300);
    check((await page.eval(`localStorage.getItem('koda-ops.v1.queue')`)) === '[]', 'a refused write is dropped, not retried forever');

    // Tap, undo, tap again while offline: they land in the order they were tapped.
    await page.send('Network.setBlockedURLs', { urls: ['*/api*'] });
    const row = '.task:nth-child(3) .check';
    await page.click(row, { settle: 320 });
    await page.click(row, { settle: 320 });
    await page.click(row, { settle: 320 });
    check(await page.eval(`document.querySelector('${row}').getAttribute('aria-checked') === 'true'`), 'three taps end up checked on screen');
    check((await page.eval(`JSON.parse(localStorage.getItem('koda-ops.v1.queue')).length`)) === 3, 'three taps are three writes');
    await page.send('Network.setBlockedURLs', { urls: [] });
    await page.eval(`window.dispatchEvent(new Event('online'))`);
    await sleep(1500);
    check((await boot('Ana')).today.tasks[2].done, 'and the server ends up the same way');

    // The server says busy, then answers with a broken page, then works: the tap waits it out.
    let hits = 0;
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api' }] });
    page.on('Fetch.requestPaused', (params) => {
      hits += 1;
      if (hits === 1) {
        page.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, body: Buffer.from(JSON.stringify({ ok: false, error: 'The site is busy right now.', retry: true })).toString('base64') });
      } else if (hits === 2) {
        page.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 500, body: Buffer.from('<html>Google had a moment</html>').toString('base64') });
      } else {
        page.send('Fetch.continueRequest', { requestId: params.requestId });
      }
    });
    await page.click('.task:nth-child(4) .check', { settle: 300 });
    check(await page.eval(`document.querySelector('.task:nth-child(4) .check').getAttribute('aria-checked') === 'true'`), 'still checked while the server is busy');
    check(!(await page.hasText('The site is busy')), 'a busy server is not a message for the person');
    await sleep(7500);
    await page.send('Fetch.disable');
    check(hits >= 3, `it kept retrying (${hits} tries)`);
    check((await boot('Ana')).today.tasks[3].done, 'and landed once the server was back');
    check((await page.eval(`localStorage.getItem('koda-ops.v1.queue')`)) === '[]', 'the queue is empty again');

    // A phone with no room left: the tap gets through from memory, and a full store isn't read over it.
    await page.eval(`(() => {
      window.__realSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function () { throw new DOMException('Full', 'QuotaExceededError'); };
    })()`);
    await page.send('Network.setBlockedURLs', { urls: ['*/api*'] });
    await page.click('.task:nth-child(5) .check', { settle: 300 });
    check(await page.eval(`document.querySelector('.task:nth-child(5) .check').getAttribute('aria-checked') === 'true'`), 'with storage full, the check still shows');
    await page.click('.task:nth-child(6) .check', { settle: 300 });
    check((await page.eval('Q.items.length')) === 2, 'with storage full, both taps wait in memory');
    await page.send('Network.setBlockedURLs', { urls: [] });
    await page.eval(`window.dispatchEvent(new Event('online'))`);
    await sleep(1200);
    await page.eval('Storage.prototype.setItem = window.__realSet');
    const full = await boot('Ana');
    check(full.today.tasks[4].done && full.today.tasks[5].done, 'and both landed');
    await page.goto('/');
    await page.waitFor('.task');
    await sleep(600);
    page.allowErrors = false;
    await page.noSideScroll('offline');
  },

  /* What the review before going live turned up, on the real page. */
  async review(page) {
    await page.viewport(390, 844, true);

    // Before the first week: Manage starts on it, and the week that never runs isn't offered.
    await page.resetWorld();
    await setTime('2026-11-05T10:00:00-07:00');
    await page.clearSite();
    await page.eval(`localStorage.setItem('koda-ops.v1.code', '"${CODE}"')`);
    await page.goto('/?me=Max&tab=manage');
    await page.waitText(OVERVIEW);
    check(await page.hasText('Starts Nov 9'), 'before the first week, the Overview says when the site starts');
    await toWeek(page);
    check(await page.eval(`document.querySelector('.wk-switch h2').innerText === 'Nov 9 - 15'`), 'before the first week, Manage opens on the first week');
    await page.click('.seg button', { text: 'One-offs' });
    await page.waitFor('.oo-form');
    const weekChips = await page.eval(`Array.from(document.querySelectorAll('.pick[data-field=weekOf]')).map((el) => el.innerText.replace(/\\s+/g, ' ')).join()`);
    check(weekChips === 'Next week Nov 9 - 15', `before the first week, the only week on offer is that one (${weekChips})`);
    check(await page.eval(`document.querySelector('.pick[data-field=weekOf]').getAttribute('aria-pressed') === 'true'`), 'and it starts selected');
    await page.shot('phone-review-first-week');
    await page.noSideScroll('review first week');

    // Already finished, still on the clock: fixed right there, with the real time.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Ana');
    await page.waitFor('[data-act=clock-in]');
    check(!(await page.hasText('Already finished?')), 'no fix link while not on the clock');
    await page.click('[data-act=clock-in]');
    await page.waitText('On the clock since 9:05 AM');
    await sleep(400);
    await setTime('2026-11-10T17:00:00-07:00');
    await page.goto('/');
    await page.waitText('Already finished? Enter the time');
    await page.shot('phone-review-already-finished');
    await page.noSideScroll('review already finished');
    await page.viewport(320, 640, true);
    await page.noSideScroll('review already finished, narrow');
    await page.viewport(390, 844, true);
    await page.click('[data-act=fix-hours]');
    await page.waitText('What time did you finish?');
    await page.setValue('.sheet input[type=time]', '11:00');
    await page.click('.sheet button[type=submit]');
    await page.waitText('Clocked out at 11:00 AM');
    await sleep(400);
    const ana = await boot('Ana');
    check(ana.clock.status === 'out', 'the fix took her off the clock');
    check(ana.hours.entries[0].flag === 'fixed' && ana.hours.entries[0].hours === 1.92, 'and the hours are the real ones, flagged fixed');

    // The phone's back button closes a sheet instead of leaving the site.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Ana&tab=hours');
    await page.waitText('hours in November');
    await page.click('.link', { text: 'Forgot to clock in? Add hours.' });
    await page.waitFor('.sheet');
    await page.eval('history.back()');
    await page.gone('Save hours');
    await sleep(200);
    check(await page.hasText('hours in November'), 'back closes the sheet and stays on the page');
    await page.click('.link', { text: 'Forgot to clock in? Add hours.' });
    await page.waitFor('.sheet');
    await page.click('.sheet [data-act=sheet-close]');
    await page.gone('Save hours');
    await sleep(200);
    check(await page.eval('!history.state || !history.state.sheet'), 'closing it by hand leaves nothing behind for back to trip on');
    check(await page.hasText('hours in November'), 'and it is still the same page');

    // A shift past midnight.
    await page.resetWorld();
    await setTime('2026-11-11T20:00:00-07:00');
    await api({ action: 'clockIn', name: 'Gus' });
    await setTime('2026-11-12T00:05:00-07:00');
    await page.clearSite();
    await page.goto('/?me=Gus');
    await page.waitText('Wed, Nov 11, 8:00 PM');
    check(await page.hasText('4 hrs 5 min'), 'past midnight, the clock still runs');
    check(!(await page.hasText("You didn't clock out")), 'and nobody is told they forgot');
    await page.shot('phone-review-past-midnight');
    await page.click('[data-act=tab][data-tab=hours]');
    await page.waitText('on the clock now');
    await setTime('2026-11-12T01:45:00-07:00');
    await page.click('[data-act=clock-out]');
    await page.waitText('8:00 PM - 1:45 AM');
    await sleep(500);
    check((await boot('Gus')).hours.entries[0].hours === 5.75, 'the clock-out landed with the real hours');

    // Back to morning with no connection: yesterday's list stays off the screen, and the clock still works.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Ana');
    await page.waitFor('.task');
    page.allowErrors = true;
    await page.send('Network.setBlockedURLs', { urls: ['*/api*'] });
    await page.eval(`(() => {
      S.bootAt -= 23 * 3600 * 1000;
      S.syncFailed = true;
      lastRefresh = Date.now();
      render();
    })()`);
    check(!(await page.eval(`!!document.querySelector('.task')`)), "a new day with no connection doesn't show yesterday's tasks");
    await page.waitText("Today's list will show up once it's back.");
    await page.shot('phone-review-new-day-offline');
    await page.click('[data-act=clock-in]');
    await page.waitText('On the clock');
    const waiting = await page.eval(`document.querySelector('.clock').innerText`);
    check(!waiting.includes('24 hrs') && waiting.includes('0 min'), `a waiting clock-in shows the time since the tap, not 24 hours (${waiting.replace(/\\s+/g, ' ')})`);
    await page.send('Network.setBlockedURLs', { urls: [] });
    page.allowErrors = false;
    await page.eval(`window.dispatchEvent(new Event('online'))`);
    await page.waitFor('.task', 8000);
    await sleep(600);
    check((await boot('Ana')).clock.status === 'in', 'back online, the clock-in landed');

    // Waking up: the old screen goes as soon as the phone wakes, before the server answers.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Ana');
    await page.waitFor('.task');
    const stillShown = await page.eval(`(() => {
      S.bootAt -= 23 * 3600 * 1000;
      lastRefresh = 0;
      document.dispatchEvent(new Event('visibilitychange'));
      return !!document.querySelector('.task');
    })()`);
    check(!stillShown, 'waking up redraws right away');
    await page.waitFor('.task', 8000);

    // A one-off too big for one person's day says so.
    await page.resetWorld();
    await page.clearSite();
    const big = await api({ action: 'mgrOneOffAdd', code: CODE, by: 'Max', title: 'Scrub the whole rig', minutes: 240, weekOf: '2026-11-09', who: ['Ana'] });
    check(big.ok && big.oneOff.assignedMinutes < 240, 'she only has room for part of it');
    await setTime(`${big.placed.date}T09:05:00-07:00`);
    await page.goto('/?me=Ana');
    await page.waitText('Part of a bigger job. Leave it unchecked until the whole job is done.');
    await page.shot('phone-review-partial');
    await page.noSideScroll('review partial');

    // On time, changed after the deadline: no late wording, and no talk of Friday.
    await page.resetWorld();
    await page.clearSite();
    await page.goto('/?me=Ana&tab=availability&week=2026-11-09');
    await page.waitFor('.dh-list');
    await page.click('[data-act=avail-save]');
    await page.waitText("You're all set!");
    await page.waitText('We saved your changes.');
    check(!(await page.hasText('past the deadline')), 'someone who was on time is not told they were late');

    // The week under way, for someone who never answered.
    await page.resetWorld();
    await setTime('2026-11-20T07:01:00-07:00');
    await fetch(`${SITE}/dev/tick`);
    await setTime('2026-11-24T10:00:00-07:00');
    await page.clearSite();
    await page.goto('/?me=Ben&tab=availability');
    await page.waitFor('.dh-list');
    check(await page.eval(`document.querySelector('.wk-chip').innerText.includes('Nov 23 - 29') && document.querySelector('.wk-chip').innerText.includes('Past due')`), 'the week under way is the first chip, past due');
    check(await page.eval(`document.querySelector('.wk-chip[aria-pressed=true]').innerText.includes('Nov 30')`), 'but the page still lands on the week coming up');
    await page.noSideScroll('review week under way');

    // Manage > Hours points out an entry far past that day's tasks.
    await page.resetWorld();
    await api({ action: 'hoursAdd', name: 'Ben', date: '2026-11-09', start: '08:00', end: '17:30', note: '' });
    await page.clearSite();
    await page.eval(`localStorage.setItem('koda-ops.v1.code', '"${CODE}"')`);
    await page.goto('/?me=Max&tab=manage');
    await page.waitText(OVERVIEW);
    await page.click('.seg button', { text: 'Hours' });
    await page.waitText("1 entry ran much longer than that day's tasks.");
    check(!(await page.hasText('shift')), 'Manage Hours has no shift wording');
    check(await page.hasText('1 long'), 'the person shows it too');
    await page.click('.hp-head[data-key2="hours|Ben"]');
    await page.waitText('9.5 hrs');
    await page.shot('phone-review-manage-long');
    await page.noSideScroll('review manage long');
    await page.resetWorld();
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(SCENES);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const page = await open();
  try {
    for (const name of names) {
      console.log(`scene: ${name}`);
      try {
        page.allowErrors = false;
        await SCENES[name](page);
      } catch (err) {
        results.fail.push(`${name} stopped: ${err.message}`);
        console.log(`  STOPPED: ${err.message}`);
        await page.shot(`failed-${name}`).catch(() => {});
      }
    }
  } finally {
    await closeBrowser();
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (err) {
      /* Edge can hold a file for a moment after it closes; the folder is ignored by git */
    }
  }
  console.log(`\n${results.pass} checks passed, ${results.fail.length} failed, ${page.errors.length} console errors`);
  results.fail.forEach((line) => console.log(`  - ${line}`));
  process.exit(results.fail.length || page.errors.length ? 1 : 0);
}

main();
