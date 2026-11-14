'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Settings = require('../../src/shared/settings.js');

test('normalize fills defaults and cleans hosts', () => {
  assert.deepEqual(Settings.normalize(), { enabled: true, steering: true, debug: false, disabledHosts: [] });
  assert.deepEqual(
    Settings.normalize({ enabled: false, disabledHosts: ['WWW.Example.com', '*.lrt.lt', 'example.com', ''] }),
    { enabled: false, steering: true, debug: false, disabledHosts: ['example.com', 'lrt.lt'] },
  );
});

test('a disabled host also covers its subdomains', () => {
  const s = Settings.normalize({ disabledHosts: ['lrt.lt'] });
  assert.equal(Settings.isEnabledFor(s, 'lrt.lt'), false);
  assert.equal(Settings.isEnabledFor(s, 'www.lrt.lt'), false);
  assert.equal(Settings.isEnabledFor(s, 'news.lrt.lt'), false);
  assert.equal(Settings.isEnabledFor(s, 'notlrt.lt'), true);
  assert.equal(Settings.isEnabledFor(Settings.normalize({ enabled: false }), 'delfi.lt'), false);
});

test('normalizeHost accepts URLs, wildcards and IDN names', () => {
  assert.equal(Settings.normalizeHost('https://www.LRT.lt:8443/naujienos?x=1'), 'lrt.lt');
  assert.equal(Settings.normalizeHost('*.delfi.lt'), 'delfi.lt');
  assert.equal(Settings.normalizeHost('ąžuolas.lt'), new URL('http://ąžuolas.lt').hostname);
  assert.equal(Settings.normalizeHost('not a host'), '');
});

test('excludeMatchesFor builds match patterns that also cover subdomains', () => {
  assert.deepEqual(Settings.excludeMatchesFor(['lrt.lt', 'www.lrt.lt', '127.0.0.1', 'localhost', 'bad host']), [
    '*://*.lrt.lt/*',
    '*://127.0.0.1/*',
    '*://*.localhost/*',
  ]);
});
