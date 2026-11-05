'use strict';

/**
 * server.js: runs the whole site on localhost with no Google involved. `node dev/server.js`
 *
 * /            the repo root, served as files (index.html, assets)
 * /api         the real doGet and doPost, running against dev/gas-mock.js
 * /dev/time    ?set=ISO moves the fake clock, ?clear=1 goes back to the real time, nothing just reports it
 * /dev/tick    runs tick() once
 * /dev/emails  what's been "sent", as JSON. ?clear=1 empties it afterward
 * /dev/reset   a fresh world: fake staff, manager code 000000, real-looking schedules, and the
 *              clock on Tuesday 2026-11-10 at 9:05 AM. ?nextWeek=0 leaves next week unpublished
 *
 * Everything lives in memory and is gone when the server stops.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createGas, fakeManagers } = require('./gas-mock.js');
const { hours } = require('./fixtures.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PORT = 8787;
const TUESDAY_MORNING = '2026-11-10T09:05:00-07:00';
const MANAGER_CODE = '000000';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------- the fake world ---- */

function slots(days, from, to) {
  const out = {};
  days.forEach((day) => {
    out[day] = hours(from, to);
  });
  return out;
}

/**
 * Builds the world through the real API and the real Friday run, so nothing in it is
 * staged: availability saved on time, a real weekly tick, a real Monday, a real nightly.
 */
function resetWorld(options) {
  const settings = Object.assign({ nextWeek: true }, options);
  const gas = createGas({ echoConsole: true });
  const post = (body) => {
    const reply = gas.post(body);
    if (!reply.ok) throw new Error(`Reset failed on ${body.action}: ${reply.error}`);
    return reply;
  };
  const save = (name, weekOf, hoursWanted, days, from, to, notes) => post({ action: 'saveAvailability', name, weekOf, hoursWanted, slots: slots(days, from, to), notes: notes || '' });

  // Thursday, the day before the first deadline.
  gas.setNow('2026-11-05T10:00:00-07:00');
  post({
    action: 'adminSetup',
    code: MANAGER_CODE,
    sourceSheetId: gas.addFakeSource(),
    sheetId: gas.createBook('Koda Operations (dev)'),
    managers: fakeManagers(),
    testEmail: 'test@example.com',
    replyTo: 'reply@example.com',
    siteUrl: 'http://localhost:8787/',
  });

  // Something to show under last month.
  post({ action: 'hoursAdd', name: 'Ana', date: '2026-10-28', start: '09:00', end: '11:30', note: 'Before the site went live' });
  post({ action: 'hoursAdd', name: 'Ben', date: '2026-10-29', start: '10:00', end: '12:15', note: '' });

  ['2026-11-09', '2026-11-16'].forEach((weekOf) => {
    save('Ana', weekOf, 8, ['Mon', 'Tue', 'Thu'], 9, 12);
    save('Ben', weekOf, 5, ['Wed', 'Fri'], 10, 13);
    save('Cora', weekOf, 6, ['Wed', 'Fri', 'Sat'], 8, 16);
  });
  save('Dev', '2026-11-09', 5, ['Tue', 'Thu'], 13, 16, 'Afternoons only');
  post({ action: 'saveAvailability', name: 'Dev', weekOf: '2026-11-16', none: true, notes: 'Out of state' });

  post({ action: 'mgrOneOffAdd', code: MANAGER_CODE, by: 'Max', title: 'Replace the lobby light bulbs', details: 'Spare bulbs are in the office closet', priority: 'A', minutes: 15, weekOf: '2026-11-09', day: 'Tue', who: [] });
  post({ action: 'mgrOneOffAdd', code: MANAGER_CODE, by: 'Mia', title: 'Wipe down the rig', details: '', priority: 'B', minutes: 30, weekOf: '2026-11-09', day: '', who: [] });
  post({ action: 'mgrOneOffAdd', code: MANAGER_CODE, by: 'Mia', title: 'Power wash the back patio', details: 'Nobody has a long enough block for this one, so it shows as open', priority: 'B', minutes: 240, weekOf: '2026-11-09', day: 'Tue', who: [] });

  post({ action: 'timeOffAdd', name: 'Gus', from: '2026-11-12', to: '2026-11-12', note: 'Visiting family' });

  // The real Friday 7 AM run.
  gas.setNow('2026-11-06T07:00:00-07:00');
  gas.tick();

  // Monday: Ana does her whole list. Cora clocks in and forgets to clock out.
  gas.setNow('2026-11-09T08:00:00-07:00');
  post({ action: 'clockIn', name: 'Cora' });
  gas.setNow('2026-11-09T09:02:00-07:00');
  post({ action: 'clockIn', name: 'Ana' });
  const monday = gas.get({ action: 'boot', name: 'Ana' }).today.tasks;
  monday.forEach((task, index) => {
    gas.setNow(new Date(Date.parse('2026-11-09T09:15:00-07:00') + index * 8 * 60000));
    post({ action: 'taskToggle', name: 'Ana', id: task.id, done: true });
  });
  post({ action: 'taskNote', name: 'Ana', id: monday[0].id, note: 'Two boxes were left at the back door' });
  gas.setNow('2026-11-09T11:21:00-07:00');
  post({ action: 'clockOut', name: 'Ana' });

  // The real nightly, then Tuesday morning.
  gas.setNow('2026-11-10T00:35:00-07:00');
  gas.tick();
  gas.setNow(TUESDAY_MORNING);
  if (settings.nextWeek) gas.call('runWeekBuild_', '2026-11-16');

  gas.state.mail.length = 0; // start clean, so /dev/emails only shows what happens from here
  return gas;
}

/* ---------------------------------------------------------------- the server ---- */

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(pathname, res) {
  const wanted = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.normalize(path.join(ROOT, wanted));
  const inside = file === ROOT || file.startsWith(ROOT + path.sep);
  const hidden = wanted.split('/').some((part) => part.startsWith('.'));
  if (!inside || hidden || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(pathname === '/' ? "index.html isn't built yet. /api and /dev/* still work.\n" : 'Not found\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/** Holds the current world, and answers requests against it. */
function createHandler(initialGas) {
  let gas = initialGas || resetWorld();

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    try {
      if (url.pathname === '/api') {
        const output =
          req.method === 'POST'
            ? gas.context.doPost({ parameter: query, postData: { contents: await readBody(req), type: req.headers['content-type'] || '' } })
            : gas.context.doGet({ parameter: query });
        sendJson(res, 200, output.getContent());
        return;
      }
      if (url.pathname === '/dev/time') {
        if (query.clear) gas.setNow(null);
        else if (query.set) {
          const moment = new Date(query.set);
          if (Number.isNaN(moment.getTime())) {
            sendJson(res, 400, { ok: false, error: `Not a time: ${query.set}` });
            return;
          }
          gas.setNow(moment);
        }
        sendJson(res, 200, { ok: true, now: gas.now().toISOString(), frozen: !!gas.context.__NOW__ });
        return;
      }
      if (url.pathname === '/dev/tick') {
        const before = gas.state.mail.length;
        const result = gas.tick();
        sendJson(res, 200, Object.assign({ ok: true, emailsSent: gas.state.mail.length - before }, result));
        return;
      }
      if (url.pathname === '/dev/emails') {
        const emails = gas.state.mail.slice();
        if (query.clear) gas.state.mail.length = 0;
        sendJson(res, 200, { ok: true, emails });
        return;
      }
      if (url.pathname === '/dev/reset') {
        gas = resetWorld({ nextWeek: query.nextWeek !== '0' });
        sendJson(res, 200, { ok: true, now: gas.now().toISOString(), managerCode: MANAGER_CODE });
        return;
      }
      serveFile(url.pathname, res);
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { ok: false, error: String(err && err.message) });
    }
  };
}

/** Listens on both forms of localhost, since which one the name resolves to depends on the machine. Calls back once ready. */
function start(port, ready) {
  const handler = createHandler();
  const servers = [http.createServer(handler)];
  servers[0].listen(port, '127.0.0.1', () => {
    const actualPort = servers[0].address().port;
    const second = http.createServer(handler);
    second.on('error', () => {}); // no IPv6 on this machine, or the port is taken there: the first one is enough
    second.listen(actualPort, '::1', () => servers.push(second));
    if (ready) ready(actualPort, servers);
  });
  return servers;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  start(port, (actualPort) => {
    console.log(`Koda Operations dev server: http://localhost:${actualPort}`);
    console.log(`The clock is on ${TUESDAY_MORNING}. Manager code: ${MANAGER_CODE}.`);
  });
}

module.exports = { resetWorld, createHandler, start };
