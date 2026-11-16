'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Settings = require('../../src/shared/settings.js');

test('normalize fills defaults and cleans hosts', () => {
  assert.deepEqual(Settings.normalize(), Object.assign({}, Settings.DEFAULTS));
  const s = Settings.normalize({ enabled: false, disabledHosts: ['WWW.Example.com', '*.lrt.lt', 'example.com', ''] });
  assert.equal(s.enabled, false);
  assert.deepEqual(s.disabledHosts, ['example.com', 'lrt.lt']);
});

test('normalize validates translation settings', () => {
  const s = Settings.normalize({
    engine: 'magic',
    targetLang: 'russian',
    autoLanguages: 'lt, LV-lv;;  et bad_code',
    cloudApiKey: '  key  ',
    restoreOnSubmit: false,
  });
  assert.equal(s.engine, 'auto');
  assert.equal(s.targetLang, '');
  assert.deepEqual(s.autoLanguages, ['lt', 'lv', 'et']);
  assert.equal(s.cloudApiKey, 'key');
  assert.equal(s.restoreOnSubmit, false);
  assert.equal(Settings.normalize({ targetLang: 'zh-TW' }).targetLang, 'zh-TW');
});

test('publicSettings never contains the API key', () => {
  const pub = Settings.publicSettings(Settings.normalize({ cloudApiKey: 'secret', cloudEndpoint: 'http://x' }));
  assert.equal(pub.cloudApiKey, undefined);
  assert.equal(pub.cloudEndpoint, undefined);
  assert.equal(pub.hasCloudKey, true);
  assert.equal(JSON.stringify(pub).includes('secret'), false);
});

test('a disabled host also covers its subdomains', () => {
  const s = Settings.normalize({ disabledHosts: ['lrt.lt'] });
  assert.equal(Settings.isEnabledFor(s, 'lrt.lt'), false);
  assert.equal(Settings.isEnabledFor(s, 'www.lrt.lt'), false);
  assert.equal(Settings.isEnabledFor(s, 'news.lrt.lt'), false);
  assert.equal(Settings.isEnabledFor(s, 'notlrt.lt'), true);
  // "enabled" only switches the language fix; the site list switches everything.
  assert.equal(Settings.isEnabledFor(Settings.normalize({ enabled: false }), 'delfi.lt'), true);
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
