'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/content/markup.js');

// Helpers to describe a segment compactly: strings are text nodes,
// ['open', n] / ['close'] / ['void', n] are element tokens.
function segment(parts) {
  const texts = [];
  const tokens = parts.map((p) => {
    if (typeof p === 'string') {
      texts.push(p);
      return { t: 'text', id: texts.length - 1 };
    }
    if (p[0] === 'close') return { t: 'close' };
    return { t: p[0], el: p[1] };
  });
  return { tokens, texts };
}

function translate(parts, translated) {
  const seg = segment(parts);
  const built = M.buildMarkup(seg);
  const { values, exact } = M.mapTranslation(seg, built, translated);
  const result = seg.texts.map((t, i) => (values.has(i) ? values.get(i) : t));
  return { html: built.html, result, exact };
}

test('a plain paragraph keeps its surrounding whitespace', () => {
  const r = translate(['\n    Labas rytas, Vilniau!  '], 'Доброе утро, Вильнюс!');
  assert.equal(r.html, ' Labas rytas, Vilniau! ');
  assert.deepEqual(r.result, ['\n    Доброе утро, Вильнюс!  ']);
  assert.equal(r.exact, true);
});

test('text around a link goes back into the right nodes', () => {
  const parts = ['Paspauskite ', ['open', 0], 'čia', ['close'], ', kad tęstumėte.'];
  const r = translate(parts, 'Нажмите <a i=0>здесь</a>, чтобы продолжить.');
  assert.equal(r.html, 'Paspauskite <a i=0>čia</a>, kad tęstumėte.');
  assert.deepEqual(r.result, ['Нажмите ', 'здесь', ', чтобы продолжить.']);
});

test('a reordered link stays in place and words do not stick together', () => {
  const parts = ['Paspauskite ', ['open', 0], 'čia', ['close'], ', kad tęstumėte.'];
  const r = translate(parts, '<a i=0>Здесь</a> нажмите, чтобы продолжить.');
  assert.deepEqual(r.result, [' ', 'Здесь', ' нажмите, чтобы продолжить.']);
  assert.equal(r.exact, true);
});

test('nested inline elements map by placeholder id', () => {
  const parts = ['Tai ', ['open', 0], 'labai ', ['open', 1], 'svarbu', ['close'], ['close'], '.'];
  const r = translate(parts, 'Это <a i=0>очень <a i=1>важно</a></a>.');
  assert.deepEqual(r.result, ['Это ', 'очень ', 'важно', '.']);
});

test('untranslatable elements keep their position', () => {
  const parts = ['Paleiskite ', ['void', 0], ' komandą terminale.'];
  const r = translate(parts, 'Запустите <a i=0></a> команду в терминале.');
  assert.equal(r.html, 'Paleiskite <a i=0></a> komandą terminale.');
  assert.deepEqual(r.result, ['Запустите ', ' команду в терминале.']);
});

test('self-closing placeholders from the engine are accepted', () => {
  const parts = ['Paleiskite ', ['void', 0], ' komandą.'];
  const r = translate(parts, 'Запустите <a i=0/> команду.');
  assert.deepEqual(r.result, ['Запустите ', ' команду.']);
});

test('HTML special characters are escaped on the way out and decoded on the way back', () => {
  const r = translate(['Tom & Jerry <3'], 'Том &amp; Джерри &lt;3 &#39;ok&#39; &quot;x&quot;&nbsp;y');
  assert.equal(r.html, 'Tom &amp; Jerry &lt;3');
  assert.deepEqual(r.result, ['Том & Джерри <3 \'ok\' "x" y']);
});

test('several text nodes in one gap: the first takes the text, the rest are emptied', () => {
  const r = translate(['Labas ', 'rytas'], 'Доброе утро');
  assert.deepEqual(r.result, ['Доброе утро ', '']);
});

test('words the engine puts between two links go into the blank node there', () => {
  const parts = [['open', 0], 'A', ['close'], ' ', ['open', 1], 'B', ['close']];
  const r = translate(parts, '<a i=0>X</a> и <a i=1>Y</a>');
  assert.deepEqual(r.result, ['X', ' и ', 'Y']);
});

test('a dropped placeholder keeps that element untranslated and merges the rest', () => {
  const parts = ['Paspauskite ', ['open', 0], 'čia', ['close'], ', kad tęstumėte.'];
  const r = translate(parts, 'Нажмите здесь, чтобы продолжить.');
  assert.equal(r.exact, false);
  assert.deepEqual(r.result, ['Нажмите здесь, чтобы продолжить. ', 'čia', '']);
});

test('a duplicated placeholder and foreign tags are ignored', () => {
  const parts = ['Spauskite ', ['open', 0], 'čia', ['close'], ' dabar.'];
  const r = translate(parts, 'Нажмите <a i=0>здесь</a> <a href="#">сейчас</a> <a i=0>здесь</a>!');
  assert.deepEqual(r.result, ['Нажмите ', 'здесь', ' сейчас !']);
});

test('segmentText joins the text of a segment', () => {
  const seg = segment(['Paspauskite ', ['open', 0], 'čia', ['close'], ', kad\n tęstumėte.']);
  assert.equal(M.segmentText(seg), 'Paspauskite čia, kad tęstumėte.');
});
