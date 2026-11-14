'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../src/content/core.js');
const { LT, EN, fakeDetect } = require('./fixtures.js');

test('language codes: base, aliases, validity, similarity', () => {
  assert.equal(core.baseLang('en-US'), 'en');
  assert.equal(core.baseLang('en_GB'), 'en');
  assert.equal(core.baseLang(' LT '), 'lt');
  assert.equal(core.baseLang('english'), '');
  assert.equal(core.baseLang(null), '');
  assert.equal(core.canonicalLang('iw'), 'he');
  assert.equal(core.canonicalLang('nb-NO'), 'no');

  assert.ok(core.isValidLangTag('lt'));
  assert.ok(core.isValidLangTag('zh-Hant-TW'));
  assert.ok(!core.isValidLangTag('en_US'));
  assert.ok(!core.isValidLangTag('english'));
  assert.ok(!core.isValidLangTag(''));
  assert.ok(!core.isValidLangTag(null));

  assert.ok(core.sameLanguage('lt-LT', 'lt'));
  assert.ok(core.sameLanguage('he', 'iw'));
  assert.ok(core.sameLanguage('hr', 'bs'), 'similar languages are never corrected into each other');
  assert.ok(!core.sameLanguage('en', 'lt'));
  assert.ok(!core.sameLanguage('', 'lt'));
});

test('prose detection separates sentences from menu items', () => {
  assert.ok(core.isProse(LT[0]));
  assert.ok(!core.isProse('Pradžia'));
  assert.ok(!core.isProse('Naujienos Sportas Verslas'));
  assert.ok(core.isProse('東京都は今日、新しい交通計画を発表しました。'));
});

test('makeChunks splits long texts, merges short ones and caps the count', () => {
  const long = LT.join(' ').repeat(3);
  const chunks = core.makeChunks([long]);
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.length <= core.DEFAULT_OPTIONS.chunkTarget * 1.5 + 1, `chunk too long: ${c.length}`);

  const merged = core.makeChunks(['Pradžia', 'Naujienos', 'Sportas', 'Verslas', 'Kultūra', 'Mokslas', 'Sveikata',
    'Kelionės', 'Orai', 'Kontaktai', 'Reklama', 'Apie mus', 'Darbo pasiūlymai', 'Prenumerata']);
  assert.ok(merged.length < 4, 'short items are merged');

  const many = Array.from({ length: 100 }, (_, i) => `${LT[i % LT.length]} ${i}`);
  const capped = core.makeChunks(many, { maxChunks: 10 });
  assert.equal(capped.length, 10);
  assert.ok(capped[9].endsWith(' 90'), 'picked evenly across the page, not only from the top');
});

test('detectPageLanguage picks the main content language over boilerplate', () => {
  const units = [
    ...LT.map((text) => ({ text, prose: true, boiler: false, meta: false })),
    { text: EN.cookie, prose: true, boiler: true, meta: false },
    { text: EN.footer, prose: true, boiler: true, meta: false },
  ];
  const d = core.detectPageLanguage(units, fakeDetect);
  assert.equal(d.confident, true);
  assert.equal(d.lang, 'lt');
  assert.equal(d.pass, 'main-prose');
  assert.ok(d.goodChunks.length > 0);
});

test('detectPageLanguage refuses to decide on a half-and-half page', () => {
  const units = [
    ...LT.slice(0, 3).map((text) => ({ text, prose: true, boiler: false, meta: false })),
    ...EN.article.slice(0, 3).map((text) => ({ text, prose: true, boiler: false, meta: false })),
  ];
  const d = core.detectPageLanguage(units, fakeDetect);
  assert.equal(d.confident, false);
  assert.equal(d.reason, 'mixed');
});

test('detectPageLanguage falls back to title and description on an empty page', () => {
  const units = [
    { text: 'Naujienos ir straipsniai apie Lietuvą', prose: false, boiler: false, meta: true },
    { text: LT[1], prose: true, boiler: false, meta: true },
  ];
  const d = core.detectPageLanguage(units, fakeDetect);
  assert.equal(d.lang, 'lt');
  assert.equal(d.pass, 'with-meta');
  assert.equal(d.confident, true);
});

test('detectPageLanguage reports no text', () => {
  const d = core.detectPageLanguage([], fakeDetect);
  assert.equal(d.confident, false);
  assert.equal(d.reason, 'no-text');
});

test('Chrome sample windows match Chromium: first 256, last 256 and middle 256', () => {
  assert.deepEqual(core.chromeSampleWindows(100), [{ name: 'start', start: 0, end: 100 }]);
  assert.deepEqual(core.chromeSampleWindows(768).length, 1);
  assert.deepEqual(core.chromeSampleWindows(1001), [
    { name: 'start', start: 0, end: 256 },
    { name: 'end', start: 745, end: 1001 },
    { name: 'middle', start: 500, end: 756 },
  ]);
});

test('simulateChromeSamples flags windows in another language', () => {
  const contents = EN.skip + '\n' + LT.join('\n') + '\n' + EN.cookie;
  const samples = core.simulateChromeSamples(contents, 'lt', fakeDetect);
  const byName = Object.fromEntries(samples.map((s) => [s.name, s]));
  assert.equal(byName.start.bad, true, 'English skip links at the start');
  assert.equal(byName.end.bad, true, 'English cookie banner at the end');
  assert.equal(byName.middle.bad, false);
});

test('planHints covers the start and the end', () => {
  assert.deepEqual(core.planHints(5000, { start: true }, -1), { head: 320, tail: 0 });
  assert.deepEqual(core.planHints(5000, { end: true }, -1), { head: 0, tail: 320 });
  assert.deepEqual(core.planHints(5000, { start: true, end: true }, -1), { head: 320, tail: 320 });
});

test('planHints moves the middle window onto good text', () => {
  const N = 6000;
  for (const goodMiddle of [3800, 2100]) {
    const plan = core.planHints(N, { start: true, end: true, middle: true }, goodMiddle);
    assert.ok(plan.head >= 320 && plan.tail >= 320);
    const total = (plan.head + 1) + N + (plan.tail + 1);
    const middleInOriginal = Math.floor(total / 2) - (plan.head + 1);
    assert.ok(Math.abs(middleInOriginal - goodMiddle) <= 2, `middle at ${middleInOriginal}, wanted ${goodMiddle}`);
  }
});

test('planHints without a good middle puts the middle window inside the head hint', () => {
  const N = 4000;
  const plan = core.planHints(N, { middle: true }, -1);
  const total = plan.head + N + plan.tail + 2;
  const mid = Math.floor(total / 2);
  assert.ok(mid + 256 < plan.head, 'the whole middle window is inside the head hint');
});

test('simulateChromeSamples catches a foreign line inside a mixed window', () => {
  const sample = EN.skip + '\n' + LT[0];
  const w = core.checkWindow(sample.slice(0, 256), 'lt', fakeDetect);
  assert.equal(w.lang, 'lt', 'the window as a whole looks Lithuanian');
  assert.equal(w.bad, true, 'but its English line can still win in Chrome');
  assert.equal(w.foreign, 'en');
  assert.equal(core.checkWindow(LT[0].slice(0, 256), 'lt', fakeDetect).bad, false);
});

test('planHints never pushes hints past Chrome\'s capture limit', () => {
  const N = 65200;
  const plan = core.planHints(N, { start: true, end: true }, -1);
  assert.equal(plan.tail, 0, 'a tail past the 65535 character cut would be invisible to Chrome');
  assert.equal(plan.head, 320);
});

test('findGoodMiddle searches outward for two good overlapping windows', () => {
  const N = 6000;
  const goodFrom = 3400;
  const p = core.findGoodMiddle(N, (start) => start >= goodFrom);
  assert.ok(p >= goodFrom, `got ${p}`);
  assert.equal(core.findGoodMiddle(N, () => false), -1);
});

test('buildHintText repeats target-language text to the exact length', () => {
  const text = core.buildHintText([LT[0]], 1000);
  assert.equal(text.length, 1000);
  assert.ok(text.startsWith(LT[0].slice(0, 50)));
  assert.equal(core.buildHintText([LT[0]], 0), '');
  assert.equal(core.buildHintText([], 100), '');
});
