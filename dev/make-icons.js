'use strict';

/**
 * make-icons.js: draws assets/apple-touch-icon.png, icon-192.png and icon-512.png by
 * screenshotting a small page with headless Edge. `node dev/make-icons.js`
 *
 * The square is full bleed so phones can round or mask it themselves, and the mark stays
 * inside the middle 60% so an Android mask never clips it.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, 'screenshots', 'icon-work');
const MARK = 'M0 0h316l539 539-539 539H0l539-539zM566 0h316l381 381 382-381h316l-540 539 540 539h-316l-382-381-381 381H566l540-539z';

function page(size) {
  const width = Math.round(size * 0.58);
  return `<!doctype html><html><body style="margin:0;background:#16324F;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;overflow:hidden">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1862 1078" width="${width}" style="display:block"><path fill="#fff" d="${MARK}"/></svg>
</body></html>`;
}

fs.mkdirSync(WORK, { recursive: true });
[
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
].forEach(([name, size]) => {
  const source = path.join(WORK, `${size}.html`);
  fs.writeFileSync(source, page(size));
  const out = path.join(ROOT, 'assets', name);
  fs.rmSync(out, { force: true });
  spawnSync(
    EDGE,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--user-data-dir=${path.join(WORK, `profile-${size}`)}`,
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      pathToFileURL(source).href,
    ],
    { timeout: 60000 }
  );
  // On Windows the launcher can return before the page has been drawn, so wait for the file.
  const giveUp = Date.now() + 30000;
  while (!fs.existsSync(out) || fs.statSync(out).size < 100) {
    if (Date.now() > giveUp) throw new Error(`Edge never wrote ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  const header = fs.readFileSync(out).subarray(16, 24);
  console.log(`${name}: ${header.readUInt32BE(0)}x${header.readUInt32BE(4)}`);
});
try {
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch (err) {
  console.log(`Left ${WORK} behind: ${err.code}`);
}
