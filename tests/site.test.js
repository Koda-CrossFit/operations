'use strict';

/**
 * site.test.js: what can be checked about index.html and assets/ without a browser.
 * dev/walkthrough.js drives the site itself in real Edge.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = page.slice(page.indexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));

test('site: the script parses, and PROD_API_URL sits on one line, the placeholder or the real web app URL', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  const line = /^const PROD_API_URL = '(PROD_API_URL_GOES_HERE|https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec)'; \/\/ .+$/m;
  assert.ok(line.test(page));
  assert.ok(line.test(page.replace('PROD_API_URL_GOES_HERE', 'https://script.google.com/macros/s/AKfycbFAKE_123-abc/exec')), 'and still once the real one is filled in');
  assert.ok(page.includes("location.hostname === 'localhost' ? '/api' : PROD_API_URL"));
});

test('site: the head says what the spec says', () => {
  assert.ok(page.includes('<meta name="robots" content="noindex">'));
  assert.ok(page.includes('<title>Koda Operations</title>'));
  assert.ok(page.includes('<meta name="theme-color" content="#ffffff">'));
  assert.ok(page.includes('viewport-fit=cover'));
  assert.ok(page.includes('family=Inter:wght@400;500;600;700'));
  assert.ok(page.includes('M0 0h316l539 539-539 539H0l539-539zM566 0h316l381 381 382-381h316l-540 539 540 539h-316l-382-381-381 381H566l540-539z'), 'the KX mark');
});

test('site: the design tokens match the spec, with no dark mode', () => {
  const tokens = { ink: '#0C1A2B', text: '#27323F', muted: '#5F6B7A', koda: '#16324F', 'koda-slate': '#536779', tint: '#EEF3F8', line: '#E5E9EF', soft: '#F7F9FB', danger: '#B42318', radius: '14px' };
  Object.keys(tokens).forEach((name) => assert.ok(page.includes(`--${name}:${tokens[name]}`), `--${name}`));
  assert.ok(page.includes('color-scheme: light'));
  assert.ok(!page.includes('prefers-color-scheme'));
  assert.ok(!/gradient\(/.test(page), 'no gradients');
  assert.ok(page.includes('prefers-reduced-motion'));
});

test('site: no emoji, no dollar amounts, no framework', () => {
  assert.ok(!/\p{Extended_Pictographic}/u.test(page), 'no emoji');
  assert.ok(!/\$\s?\d/.test(page), 'no dollar amounts');
  assert.ok(!/<script[^>]+src=/.test(page), 'no script files');
});

test('site: every button action and form has code behind it', () => {
  const acts = new Set([...page.matchAll(/data-act="([a-z-]+)"/g)].map((match) => match[1]));
  assert.ok(acts.size > 30);
  acts.forEach((act) => {
    const handler = new RegExp(`^\\s*(async )?['"]?${act}['"]?\\(`, 'm');
    assert.ok(handler.test(script), `nothing handles data-act="${act}"`);
  });
  const forms = new Set([...page.matchAll(/data-submit="([A-Za-z]+)"/g)].map((match) => match[1]));
  forms.forEach((name) => assert.ok(new RegExp(`^\\s*(async )?${name}\\(`, 'm').test(script), `nothing handles data-submit="${name}"`));
});

test('site: an empty queue never asks for a refresh, so an idle screen stays quiet', () => {
  // refreshAll nudges the queue, so a refresh after every empty run of the queue would loop forever.
  // dev/walkthrough.js counts the actual calls in its idle scene.
  assert.ok(/if \(landed\) syncSoon\(\)/.test(script));
  assert.ok(!/if \(finished\) \{\s*this\.dropLease\(\);\s*syncSoon\(\);/.test(script));
});

test('site: the manifest opens the site itself, wherever it is hosted', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'manifest.webmanifest'), 'utf8'));
  assert.strictEqual(manifest.name, 'Koda Operations');
  assert.strictEqual(manifest.short_name, 'Operations');
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.theme_color, '#ffffff');
  assert.strictEqual(manifest.background_color, '#ffffff');
  // These resolve against the manifest's own address, and it lives in assets/.
  const where = 'https://example.test/operations/assets/manifest.webmanifest';
  assert.strictEqual(new URL(manifest.start_url, where).href, 'https://example.test/operations/');
  assert.strictEqual(new URL(manifest.scope, where).href, 'https://example.test/operations/');
  manifest.icons.forEach((icon) => assert.ok(fs.existsSync(path.join(ROOT, 'assets', icon.src)), icon.src));
});

test('site: the icons are the right sizes, and the favicon is the white mark on Koda blue', () => {
  [
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
  ].forEach(([name, size]) => {
    const file = fs.readFileSync(path.join(ROOT, 'assets', name));
    assert.strictEqual(file.toString('latin1', 1, 4), 'PNG', name);
    assert.strictEqual(file.readUInt32BE(16), size, `${name} width`);
    assert.strictEqual(file.readUInt32BE(20), size, `${name} height`);
  });
  const favicon = fs.readFileSync(path.join(ROOT, 'assets', 'favicon.svg'), 'utf8');
  assert.ok(favicon.includes('#16324F') && favicon.includes('#fff') && favicon.includes('M0 0h316'));
  assert.ok(/<rect[^>]+rx=/.test(favicon), 'a rounded square');
});
